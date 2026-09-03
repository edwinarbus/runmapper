"""Routable street graph for one request area, built from Overpass elements.

Nodes are OSM nodes, edges are way segments; lengths are in projected feet.
`cost_mult` scales an edge's length by how pleasant it is to run (steps and
busy roads cost more), which is what the router minimises.
"""
import math
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

# Ways we refuse to route on at all.
BAD_HIGHWAY = {"motorway", "motorway_link", "trunk", "trunk_link", "construction",
               "proposed", "raceway", "bus_guideway", "busway"}

# Multiplier on length: >1 means "avoid unless helpful". Runnable but less pleasant.
SURFACE_COST = {
    "footway": 1.00, "path": 1.05, "pedestrian": 1.00, "living_street": 1.00,
    "residential": 1.00, "unclassified": 1.05, "tertiary": 1.10, "tertiary_link": 1.15,
    "secondary": 1.35, "secondary_link": 1.4, "primary": 1.9, "primary_link": 1.95,
    "cycleway": 1.10, "service": 1.25, "track": 1.3, "steps": 6.0,
}

# Street classes that define the grid a neighbourhood is laid out on.
GRID_CLASSES = {"residential", "tertiary", "secondary", "primary", "unclassified",
                "living_street", "pedestrian"}


def grid_stats(angs, wts, bin_deg=2.0):
    """Dominant bearing (mod 90) and regularity of a set of street segments
    given their bearings mod 90 and lengths. See StreetGraph.grid_bearing."""
    angs = np.asarray(angs, float)
    wts = np.asarray(wts, float)
    if len(angs) == 0 or wts.sum() <= 0:
        return dict(bearing=0.0, regularity=0.0)
    nb = int(round(90.0 / bin_deg))
    h, _ = np.histogram(angs, bins=nb, range=(0.0, 90.0), weights=wts)
    # circular smoothing over +-1 bin
    hs = h + np.roll(h, 1) + np.roll(h, -1)
    k = int(np.argmax(hs))
    # refine with a weighted mean around the peak (circular over 90)
    lo, hi = (k - 1) * bin_deg, (k + 2) * bin_deg
    sel = ((angs - lo) % 90.0) < (hi - lo)
    theta = (lo + float(np.average((angs[sel] - lo) % 90.0, weights=wts[sel]))) % 90.0 if sel.any() else k * bin_deg
    dev = np.abs(((angs - theta) + 45.0) % 90.0 - 45.0)
    regularity = float(wts[dev <= 8.0].sum() / wts.sum())
    return dict(bearing=float(theta), regularity=regularity)


def _period(pos, wts, lag_range, bin_ft):
    """Dominant repeat distance of a set of parallel-street positions, via the
    autocorrelation of their length-weighted histogram. Returns (spacing, conf)."""
    if len(pos) < 6:
        return None, 0.0
    pos = np.asarray(pos)
    wts = np.asarray(wts)
    lo, hi = pos.min(), pos.max()
    nb = int((hi - lo) / bin_ft) + 1
    if nb < 30:
        return None, 0.0
    h, _ = np.histogram(pos, bins=nb, range=(lo, lo + nb * bin_ft), weights=wts)
    h = h - h.mean()
    ac = np.correlate(h, h, mode="full")[len(h) - 1:]
    if ac[0] <= 0:
        return None, 0.0
    ac = ac / ac[0]
    l0, l1 = int(lag_range[0] / bin_ft), min(int(lag_range[1] / bin_ft), len(ac) - 2)
    if l1 <= l0 + 2:
        return None, 0.0
    seg = ac[l0:l1]
    peaks = [k for k in range(1, len(seg) - 1) if seg[k] >= seg[k - 1] and seg[k] >= seg[k + 1] and seg[k] > 0.12]
    if not peaks:
        return None, 0.0
    strongest = max(seg[k] for k in peaks)
    # The fundamental is the shortest repeat that is nearly as strong as the
    # strongest one (harmonics of a regular grid are all strong).
    lag = min(k for k in peaks if seg[k] >= 0.55 * strongest) + l0
    conf = float(ac[lag])
    # refine the lag with a parabolic fit
    if 1 <= lag < len(ac) - 1:
        y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
        den = (y0 - 2 * y1 + y2)
        if den < 0:
            lag = lag + 0.5 * (y0 - y2) / den
    return float(lag * bin_ft), conf


class StreetGraph:
    def __init__(self, proj):
        self.proj = proj
        self.node_ll = {}              # nid -> (lat, lon)
        self.adj = defaultdict(list)   # nid -> [(nbr, length_ft, cost_mult, way_id)]
        self.way_name = {}             # way_id -> street name
        self.way_tags = {}
        self._named = None

    @classmethod
    def from_elements(cls, elements, proj):
        g = cls(proj)
        nodes, ways = {}, []
        for el in elements:
            if el["type"] == "node":
                nodes[el["id"]] = (el["lat"], el["lon"])
            elif el["type"] == "way":
                ways.append(el)
        used = set()
        for w in ways:
            t = w.get("tags", {}) or {}
            hw = t.get("highway")
            if not hw or hw in BAD_HIGHWAY:
                continue
            if t.get("foot") in ("no", "private") or t.get("access") in ("private", "no"):
                continue
            if t.get("area") == "yes":
                continue
            if t.get("indoor") == "yes":
                continue
            mult = SURFACE_COST.get(hw, 1.2)
            # Sidewalks run along streets and draw fine; other footways and
            # paths wander through parks and plazas, which smears the line.
            if hw == "footway" and t.get("footway") not in ("sidewalk", "crossing"):
                mult = 1.25
            elif hw == "path":
                mult = 1.3
            nd = [n for n in w.get("nodes", []) if n in nodes]
            if len(nd) < 2:
                continue
            wid = w["id"]
            g.way_name[wid] = t.get("name", "")
            g.way_tags[wid] = t
            for a, b in zip(nd[:-1], nd[1:]):
                la, lo = nodes[a]
                lb, lob = nodes[b]
                xa, ya = proj.to_xy(la, lo)
                xb, yb = proj.to_xy(lb, lob)
                d = float(math.hypot(xb - xa, yb - ya))
                if d <= 0:
                    continue
                g.adj[a].append((b, d, mult, wid))
                g.adj[b].append((a, d, mult, wid))
                used.add(a)
                used.add(b)
        g.node_ll = {n: nodes[n] for n in used}
        return g.finalize()

    def finalize(self):
        """Freeze to arrays + a KD-tree for nearest-node queries."""
        self.ids = np.array(sorted(self.node_ll), dtype=np.int64)
        self.idx = {int(n): i for i, n in enumerate(self.ids)}
        lat = np.array([self.node_ll[int(n)][0] for n in self.ids], float)
        lon = np.array([self.node_ll[int(n)][1] for n in self.ids], float)
        self.lat, self.lon = lat, lon
        self.X, self.Y = self.proj.to_xy(lat, lon)
        self.X = np.asarray(self.X, float)
        self.Y = np.asarray(self.Y, float)
        self.tree = cKDTree(np.c_[self.X, self.Y]) if len(self.ids) else None
        self._grid_edges = None
        head = [[] for _ in range(len(self.ids))]
        for n, lst in self.adj.items():
            i = self.idx[int(n)]
            for (m, d, mult, wid) in lst:
                j = self.idx.get(int(m))
                if j is not None:
                    head[i].append((j, d, mult, wid))
        self.nbrs = head
        self.n_edges = sum(len(x) for x in head) // 2
        self.keep = self.largest_component() if len(self.ids) else np.zeros(0, bool)
        return self

    def largest_component(self):
        """Mask of the biggest connected component (drops islands and parse debris)."""
        n = len(self.ids)
        seen = np.zeros(n, bool)
        best = []
        for s in range(n):
            if seen[s]:
                continue
            stack, comp = [s], []
            seen[s] = True
            while stack:
                u = stack.pop()
                comp.append(u)
                for (v, *_) in self.nbrs[u]:
                    if not seen[v]:
                        seen[v] = True
                        stack.append(v)
            if len(comp) > len(best):
                best = comp
        keep = np.zeros(n, bool)
        keep[best] = True
        return keep

    def edges(self, ok=None):
        """Yield (i, j, length, mult, wid) once per undirected edge."""
        for i, lst in enumerate(self.nbrs):
            if ok is not None and not ok[i]:
                continue
            for (j, ln, mult, wid) in lst:
                if j > i and (ok is None or ok[j]):
                    yield i, j, ln, mult, wid

    def densify(self, step=45.0, ok=None, classes=None):
        """Point cloud along runnable edges, for fast 'how far is the nearest
        street' queries. `classes` restricts it to some highway types (placement
        is judged on real streets, so park path mazes don't look attractive)."""
        ok = self.keep if ok is None else ok
        X, Y = self.X, self.Y
        pts = []
        for i, j, ln, mult, wid in self.edges(ok):
            if classes is not None and self.way_tags.get(wid, {}).get("highway") not in classes:
                continue
            n = max(2, int(ln / step) + 1)
            t = np.linspace(0, 1, n)
            pts.append(np.c_[X[i] + t * (X[j] - X[i]), Y[i] + t * (Y[j] - Y[i])])
        if not pts:
            return np.zeros((0, 2)), None
        P = np.vstack(pts)
        return P, cKDTree(P)

    def grid_edges(self):
        """Arrays over the runnable street edges (GRID_CLASSES only): midpoint
        x, y, compass bearing mod 180 and length. Cached; the grid statistics
        below are computed from them, optionally inside a window."""
        cached = getattr(self, "_grid_edges", None)
        if cached is None:
            mx, my, bear, lns = [], [], [], []
            for i, j, ln, mult, wid in self.edges(self.keep):
                if self.way_tags.get(wid, {}).get("highway") not in GRID_CLASSES:
                    continue
                dx = self.X[j] - self.X[i]
                dy = self.Y[j] - self.Y[i]
                mx.append((self.X[i] + self.X[j]) / 2.0)
                my.append((self.Y[i] + self.Y[j]) / 2.0)
                bear.append(math.degrees(math.atan2(dx, dy)) % 180.0)
                lns.append(ln)
            cached = tuple(np.asarray(a, float) for a in (mx, my, bear, lns))
            self._grid_edges = cached
        return cached

    def _windowed(self, window):
        mx, my, bear, ln = self.grid_edges()
        if window is None:
            return mx, my, bear, ln
        cx, cy, half = window
        m = (np.abs(mx - cx) <= half) & (np.abs(my - cy) <= half)
        return mx[m], my[m], bear[m], ln[m]

    def grid_bearing(self, bin_deg=2.0, window=None):
        """Dominant street bearing of the area (or of a (cx, cy, half_ft)
        window of it), modulo 90 degrees.

        Returns dict(bearing=theta in [0, 90), regularity=fraction of street
        length within 8 degrees of the two grid axes). A regularity near 1 is a
        Manhattan-style grid; near 0.4 the streets wander.
        """
        mx, my, bear, ln = self._windowed(window)
        return grid_stats(bear % 90.0, ln, bin_deg)

    def block_spacing(self, bearing_deg, tol_deg=12.0, lag_range=(150.0, 1500.0), bin_ft=10.0,
                      window=None):
        """Typical distance between parallel streets, for a grid at `bearing_deg`,
        in the whole area or in a (cx, cy, half_ft) window of it.

        Returns dict(spacing_along, spacing_across, conf_along, conf_across):
        `spacing_along` is the gap between consecutive streets that cross the
        bearing (measured along it), `spacing_across` the gap between streets
        that run along it. Either is None when no repeating pattern shows up.
        """
        mx, my, bear, ln = self._windowed(window)
        b = math.radians(bearing_deg)
        ua = np.array([math.sin(b), math.cos(b)])
        ub = np.array([math.cos(b), -math.sin(b)])
        diff = np.abs(((bear - bearing_deg) + 90.0) % 180.0 - 90.0)
        along = diff <= tol_deg
        across = diff >= 90.0 - tol_deg
        pc = mx[along] * ub[0] + my[along] * ub[1]
        pa = mx[across] * ua[0] + my[across] * ua[1]
        sa, ca = _period(pa, ln[across], lag_range, bin_ft)
        sc, cc = _period(pc, ln[along], lag_range, bin_ft)
        return dict(spacing_along=sa, conf_along=ca, spacing_across=sc, conf_across=cc)

    def filtered(self, classes):
        """A copy of the graph keeping only ways of the given highway classes,
        e.g. street centrelines without sidewalks and park paths. Node indices
        differ from the parent graph's."""
        g = StreetGraph(self.proj)
        used = set()
        for n, lst in self.adj.items():
            for (m, d, mult, wid) in lst:
                if self.way_tags.get(wid, {}).get("highway") in classes:
                    g.adj[n].append((m, d, mult, wid))
                    used.add(n)
                    used.add(m)
        g.node_ll = {n: self.node_ll[n] for n in used}
        g.way_name = self.way_name
        g.way_tags = self.way_tags
        return g.finalize()

    def nearest_node(self, x, y, ok_only=True):
        d, i = self.tree.query([x, y], k=min(16, len(self.ids)))
        for dd, ii in zip(np.atleast_1d(d), np.atleast_1d(i)):
            if not ok_only or self.keep[ii]:
                return int(ii), float(dd)
        return int(np.atleast_1d(i)[0]), float(np.atleast_1d(d)[0])
