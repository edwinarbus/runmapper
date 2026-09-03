"""Typed phrases as a single runnable line.

Letters live on a 2-wide by 3-tall grid of "units". The pipeline sizes a unit
to the local block spacing (two blocks wide, two blocks tall per letter, with
the middle bar on the street in between), which is what survives being snapped
to streets. Each glyph is a handful of strokes; the walk that draws it is a
single polyline that retraces its own strokes where needed, because Strava
draws a retraced street on top of itself and nobody sees the repeat.

Letters are chained by short connectors along the bottom or the top edge. A
small dynamic programme picks, letter by letter, which edge to use so the
connectors merge into bars the letters already have (E, L, Z on the bottom,
T, F, 7 on the top) instead of adding stray ticks.
"""
import itertools
import math
from functools import lru_cache

import numpy as np

from .strokes import Stroke

H = 3.0          # glyph height in units
GAP = 1.0        # space between letters, in units
MAX_CHARS = 12
VIRTUAL_PENALTY = 1.5   # legibility cost of drawing a line the letter does not have

# Glyph strokes on the {0,1,2} x {0,1.5,3} lattice wherever a legible form
# allows it, so every corner lands on a street when a unit is a block.
# fmt: off
GLYPHS = {
    "A": (2, [[(0,0),(0,1.5),(0,3)], [(0,3),(2,3)], [(2,3),(2,1.5),(2,0)], [(0,1.5),(2,1.5)]]),
    "B": (2, [[(0,0),(0,1.5),(0,3)], [(0,3),(1,3),(1,1.5),(0,1.5)], [(0,1.5),(2,1.5),(2,0),(0,0)]]),
    "C": (2, [[(2,3),(0,3),(0,0),(2,0)]]),
    "D": (2, [[(0,0),(0,3),(2,3),(2,0),(0,0)]]),
    "E": (2, [[(0,0),(0,1.5),(0,3)], [(0,3),(2,3)], [(0,1.5),(2,1.5)], [(0,0),(2,0)]]),
    "F": (2, [[(0,0),(0,1.5),(0,3)], [(0,3),(2,3)], [(0,1.5),(2,1.5)]]),
    "G": (2, [[(2,3),(0,3),(0,0),(2,0),(2,1.5),(1,1.5)]]),
    "H": (2, [[(0,0),(0,1.5),(0,3)], [(2,0),(2,1.5),(2,3)], [(0,1.5),(2,1.5)]]),
    "I": (2, [[(0,3),(1,3),(2,3)], [(1,3),(1,0)], [(0,0),(1,0),(2,0)]]),
    "J": (2, [[(0,3),(1,3),(2,3)], [(1,3),(1,0)], [(1,0),(0,0),(0,1.5)]]),
    "K": (2, [[(0,0),(0,1.5),(0,3)], [(0,1.5),(1,1.5)], [(1,1.5),(1,3),(2,3)], [(1,1.5),(1,0),(2,0)]]),
    "L": (2, [[(0,3),(0,0),(2,0)]]),
    "M": (2, [[(0,0),(0,3),(1,3),(1,1.5)], [(1,3),(2,3),(2,0)]]),
    "N": (2, [[(0,0),(0,3),(2,3),(2,0)]]),
    "O": (2, [[(0,0),(0,3),(2,3),(2,0),(0,0)]]),
    "P": (2, [[(0,0),(0,1.5),(0,3)], [(0,3),(2,3),(2,1.5),(0,1.5)]]),
    "Q": (2, [[(0,0),(0,3),(2,3),(2,0),(1,0),(0,0)], [(1,1.5),(1,0)]]),
    "R": (2, [[(0,0),(0,1.5),(0,3)], [(0,3),(2,3),(2,1.5),(1,1.5),(0,1.5)], [(1,1.5),(1,0)]]),
    "S": (2, [[(2,3),(0,3),(0,1.5),(2,1.5),(2,0),(0,0)]]),
    "T": (2, [[(0,3),(1,3),(2,3)], [(1,3),(1,0)]]),
    "U": (2, [[(0,3),(0,0),(2,0),(2,3)]]),
    "V": (2, [[(0,3),(0,0),(2,0),(2,3)]]),
    "W": (2, [[(0,3),(0,0),(1,0),(1,1.5)], [(1,0),(2,0),(2,3)]]),
    "X": (2, [[(0,0),(1,1.5),(2,3)], [(0,3),(1,1.5),(2,0)]]),
    "Y": (2, [[(0,3),(0,1.5)], [(2,3),(2,1.5)], [(0,1.5),(1,1.5),(2,1.5)], [(1,1.5),(1,0)]]),
    "Z": (2, [[(0,3),(2,3),(2,1.5),(0,1.5),(0,0),(2,0)]]),
    "0": (2, [[(0,0),(0,3),(2,3),(2,0),(0,0)]]),
    "1": (2, [[(1,3),(1,0)], [(0,0),(1,0),(2,0)]]),
    "2": (2, [[(0,3),(2,3),(2,1.5),(0,1.5),(0,0),(2,0)]]),
    "3": (2, [[(0,3),(2,3),(2,1.5),(1,1.5)], [(2,1.5),(2,0),(0,0)]]),
    "4": (2, [[(0,3),(0,1.5),(2,1.5)], [(2,3),(2,1.5),(2,0)]]),
    "5": (2, [[(2,3),(0,3),(0,1.5),(2,1.5),(2,0),(0,0)]]),
    "6": (2, [[(2,3),(0,3),(0,1.5),(0,0),(2,0),(2,1.5),(0,1.5)]]),
    "7": (2, [[(0,3),(2,3),(2,1.5),(1,1.5),(1,0)]]),
    "8": (2, [[(0,0),(0,1.5),(0,3),(2,3),(2,1.5),(2,0),(0,0)], [(0,1.5),(2,1.5)]]),
    "9": (2, [[(2,1.5),(0,1.5),(0,3),(2,3),(2,1.5),(2,0),(0,0)]]),
    " ": (1, []),
    "!": (2, [[(1,3),(1,1.5)], [(0,0),(2,0)]]),
    "?": (2, [[(0,3),(2,3),(2,1.5),(1,1.5)], [(1,0),(2,0)]]),
    "-": (2, [[(0,1.5),(2,1.5)]]),
    ".": (1, [[(0,0),(1,0)]]),
    "'": (1, [[(1,3),(1,1.5)]]),
    "+": (2, [[(0,1.5),(1,1.5),(2,1.5)], [(1,0),(1,1.5),(1,3)]]),
}
# fmt: on

ALLOWED = "".join(sorted(GLYPHS))


class FontError(ValueError):
    pass


def check_text(text):
    """Validate and normalise user text. Returns the uppercase string."""
    t = " ".join(text.strip().upper().split())
    if not t:
        raise FontError("Type a word or short phrase to draw.")
    if len(t) > MAX_CHARS:
        raise FontError(f"Keep it to {MAX_CHARS} characters; a route can only draw so much.")
    bad = sorted({c for c in t if c not in GLYPHS})
    if bad:
        raise FontError("Can't draw " + ", ".join(repr(c) for c in bad)
                        + ". Use letters, digits, space and ! ? - . ' +")
    return t


def _key(p):
    return (round(float(p[0]), 6), round(float(p[1]), 6))


class _GlyphGraph:
    """The strokes of one glyph as a tiny graph, with all-pairs shortest walks
    so the drawing pen can retrace to wherever it needs to go next."""

    def __init__(self, w, strokes):
        self.w = float(w)
        raw = [[_key(p) for p in s] for s in strokes]
        # Split strokes where other strokes join them, so the pen may draw a
        # bar in two halves (the T's top bar around its stem, say) and the
        # walk can avoid needless retracing.
        count = {}
        for s in raw:
            for p in set(s):
                count[p] = count.get(p, 0) + 1
        self.strokes = []
        for s in raw:
            cur = [s[0]]
            for p in s[1:]:
                cur.append(p)
                if count.get(p, 0) > 1 and p != s[-1]:
                    self.strokes.append(cur)
                    cur = [p]
            if len(cur) > 1:
                self.strokes.append(cur)
        nodes = {}
        for s in self.strokes:
            for p in s:
                nodes.setdefault(p, len(nodes))
        self.ports = {"bl": (0.0, 0.0), "br": (self.w, 0.0), "tl": (0.0, H), "tr": (self.w, H)}
        virtual = []
        for name, p in self.ports.items():
            p = _key(p)
            if p not in nodes:
                nodes[p] = len(nodes)
                virtual.append(p)
        self.nodes = nodes
        self.pts = list(nodes)
        n = len(self.pts)
        INF = float("inf")
        cost = np.full((n, n), INF)
        length = np.full((n, n), INF)
        nxt = -np.ones((n, n), int)
        for i in range(n):
            cost[i, i] = 0.0
            length[i, i] = 0.0
        for s in self.strokes:
            for a, b in zip(s[:-1], s[1:]):
                i, j = nodes[a], nodes[b]
                d = math.dist(a, b)
                if d < cost[i, j]:
                    cost[i, j] = cost[j, i] = d
                    length[i, j] = length[j, i] = d
                    nxt[i, j] = j
                    nxt[j, i] = i
        # Corners the glyph has no ink at get a straight "virtual" link to the
        # nearest real point, carrying a legibility penalty.
        real_pts = [q for q in self.pts if q not in virtual]
        for p in virtual:
            if not real_pts:
                continue
            i = nodes[p]
            q = min(real_pts, key=lambda q: math.dist(p, q))
            j = nodes[q]
            d = math.dist(p, q)
            cost[i, j] = cost[j, i] = d + VIRTUAL_PENALTY
            length[i, j] = length[j, i] = d
            nxt[i, j] = j
            nxt[j, i] = i
        # Glyphs made of separate pieces (the dot of an "!") get a straight
        # virtual jump between the closest points of the pieces.
        comp = list(range(n))

        def find(i):
            while comp[i] != i:
                comp[i] = comp[comp[i]]
                i = comp[i]
            return i

        for i in range(n):
            for j in range(n):
                if i != j and cost[i, j] < INF:
                    comp[find(i)] = find(j)
        roots = sorted({find(i) for i in range(n)})
        while len(roots) > 1:
            best = None
            for i in range(n):
                for j in range(n):
                    if find(i) == roots[0] and find(j) != roots[0]:
                        d = math.dist(self.pts[i], self.pts[j])
                        if best is None or d < best[0]:
                            best = (d, i, j)
            d, i, j = best
            cost[i, j] = cost[j, i] = d + VIRTUAL_PENALTY
            length[i, j] = length[j, i] = d
            nxt[i, j] = j
            nxt[j, i] = i
            comp[find(j)] = find(i)
            roots = sorted({find(i) for i in range(n)})
        for k in range(n):
            for i in range(n):
                if cost[i, k] == INF:
                    continue
                for j in range(n):
                    c = cost[i, k] + cost[k, j]
                    if c < cost[i, j]:
                        cost[i, j] = c
                        length[i, j] = length[i, k] + length[k, j]
                        nxt[i, j] = nxt[i, k]
        self.cost, self.length, self.nxt = cost, length, nxt

    def path(self, i, j):
        if i == j:
            return [self.pts[i]]
        out = [self.pts[i]]
        while i != j:
            i = self.nxt[i, j]
            if i < 0:
                return None
            out.append(self.pts[i])
        return out

    @lru_cache(maxsize=None)
    def walk(self, entry, exit_):
        """Cheapest pen walk that draws every stroke, from port `entry` to port
        `exit_`. Returns (cost, length, points)."""
        pi = self.nodes[_key(self.ports[entry])]
        po = self.nodes[_key(self.ports[exit_])]
        if not self.strokes:
            same_side = entry[0] == exit_[0]
            pts = [self.pts[pi], self.pts[po]]
            d = math.dist(*pts)
            return (d if same_side else d + 2.0 * VIRTUAL_PENALTY, d, pts)
        S = []
        for s in self.strokes:
            L = sum(math.dist(a, b) for a, b in zip(s[:-1], s[1:]))
            S.append((self.nodes[s[0]], self.nodes[s[-1]], L, s))
        best = None
        for order in itertools.permutations(range(len(S))):
            for dirs in itertools.product((0, 1), repeat=len(S)):
                c = 0.0
                ln = 0.0
                cur = pi
                for si, d in zip(order, dirs):
                    a, b, L, s = S[si]
                    if d:
                        a, b = b, a
                    c += self.cost[cur, a] + L
                    ln += self.length[cur, a] + L
                    cur = b
                    if best is not None and c >= best[0]:
                        break
                else:
                    c += self.cost[cur, po]
                    ln += self.length[cur, po]
                    if best is None or c < best[0]:
                        best = (c, ln, order, dirs)
        c, ln, order, dirs = best
        pts = [self.pts[pi]]
        cur = pi
        for si, d in zip(order, dirs):
            a, b, L, s = S[si]
            seq = list(s)
            if d:
                a, b = b, a
                seq = seq[::-1]
            bridge = self.path(cur, a)
            pts += bridge[1:]
            pts += seq[1:]
            cur = b
        pts += self.path(cur, po)[1:]
        return (c, ln, pts)


_GRAPHS = {}


def glyph_graph(ch):
    if ch not in _GRAPHS:
        w, strokes = GLYPHS[ch]
        _GRAPHS[ch] = _GlyphGraph(w, strokes)
    return _GRAPHS[ch]


def layout(text, loop=True):
    """Lay the phrase out as one polyline in font units.

    Returns dict(points=(N,2) array, units_wide, walk_units, walk_xy,
    return_units, return_xy, total_units, sides, text). The *_xy pairs split
    the pen travel into horizontal and vertical units, so a caller sizing the
    two axes differently can still estimate the distance.
    """
    text = check_text(text)
    graphs = [glyph_graph(c) for c in text]
    n = len(graphs)
    # Connectors run along the bottom only: the word gets one clean underline
    # instead of letters joined at the top, which made pairs read as one glyph.
    sides = ("b",)
    INF = float("inf")
    dp = [{s: (INF, None) for s in sides} for _ in range(n)]
    for s_in in sides:
        for s_out in sides:
            c, ln, pts = graphs[0].walk(s_in + "l", s_out + "r")
            if c < dp[0][s_out][0]:
                dp[0][s_out] = (c, s_in)
    for i in range(1, n):
        for s_out in sides:
            for s_in in sides:
                prevc = dp[i - 1][s_in][0]
                if prevc == INF:
                    continue
                c, ln, pts = graphs[i].walk(s_in + "l", s_out + "r")
                tot = prevc + c + GAP
                if tot < dp[i][s_out][0]:
                    dp[i][s_out] = (tot, s_in)
    s_last = min(sides, key=lambda s: dp[n - 1][s][0])
    chain = [s_last]
    for i in range(n - 1, 0, -1):
        chain.append(dp[i][chain[-1]][1])
    chain.append(dp[0][chain[-1]][1])
    chain.reverse()          # chain[i] = entry side of letter i; chain[n] = exit side
    pts = []
    x = 0.0
    for i, gph in enumerate(graphs):
        c, ln, wpts = gph.walk(chain[i] + "l", chain[i + 1] + "r")
        seg = [(px + x, py) for px, py in wpts]
        if pts and _key(pts[-1]) == _key(seg[0]):
            seg = seg[1:]
        pts += seg
        x += gph.w + GAP
    P = np.array(pts, float)
    d = np.abs(np.diff(P, axis=0))
    walk_x, walk_y = float(d[:, 0].sum()), float(d[:, 1].sum())
    units_wide = x - GAP
    switches = sum(1 for a, b in zip(chain[:-1], chain[1:]) if a != b)
    ret_x, ret_y = (units_wide, H * (1 + switches)) if loop else (0.0, 0.0)
    return dict(points=P, units_wide=units_wide, walk_units=walk_x + walk_y,
                walk_xy=(walk_x, walk_y), return_units=ret_x + ret_y, return_xy=(ret_x, ret_y),
                total_units=walk_x + walk_y + ret_x + ret_y, sides=chain, text=text)


def staircase(points, kx, ky):
    """Axis-aligned version of a font-unit polyline on a block lattice.

    `kx` is blocks per horizontal unit, `ky` blocks per 1.5 vertical units
    (the row spacing), so every lattice point of the font is a street corner.
    Diagonal segments become the Bresenham staircase that hugs the diagonal,
    stepping horizontally first on ties, which is what the streets will do to
    them anyway; deciding it here keeps the shape deterministic and lets the
    distance estimate be exact.
    """
    P = np.asarray(points, float)
    B = np.c_[P[:, 0] * kx, P[:, 1] * ky / 1.5]
    out = [B[0]]
    for a, b in zip(B[:-1], B[1:]):
        d = b - a
        if abs(d[0]) < 1e-6 or abs(d[1]) < 1e-6:
            out.append(b)
            continue
        mx, my = int(round(abs(d[0]))), int(round(abs(d[1])))
        if mx == 0 or my == 0:
            out.append(b)
            continue
        sx, sy = math.copysign(1.0, d[0]), math.copysign(1.0, d[1])
        ix = iy = 0
        while ix < mx or iy < my:
            cands = []
            if ix < mx:
                cands.append((ix + 1, iy))
            if iy < my:
                cands.append((ix, iy + 1))
            ix, iy = min(cands, key=lambda c: (abs(c[0] / mx - c[1] / my), -c[0]))
            out.append(a + np.array([sx * ix * abs(d[0]) / mx, sy * iy * abs(d[1]) / my]))
    out = np.array(out)
    keep = np.r_[True, np.any(np.abs(np.diff(out, axis=0)) > 1e-9, axis=1)]
    out = out[keep]
    return np.c_[out[:, 0] / kx, out[:, 1] * 1.5 / ky]


def text_strokes(text, loop=True):
    """The phrase as one open, normalised Stroke plus its layout stats."""
    lay = layout(text, loop=loop)
    pts = lay["points"]
    lo, hi = pts.min(0), pts.max(0)
    ctr = (lo + hi) / 2.0
    scale = float(max(hi[0] - lo[0], hi[1] - lo[1])) or 1.0
    s = Stroke((pts - ctr) / scale, name=f"text:{lay['text']}", closed=False, kind="text")
    lay["scale_units_per_norm"] = scale     # font units per normalised unit
    return [s], lay


# ------------------------------------------------------------------ block letters

def outline_cells(text, kx=1, ky=1):
    """The phrase as block letters one block thick, on a lattice with `kx`
    blocks per font unit across and `ky` blocks per row (1.5 units) up: each
    stroke of the line font covers the run of unit cells it passes through.
    Returns (letters, width_blocks, height_blocks) with one set of cells
    (x, y) per character, empty for a space."""
    text = check_text(text)
    gap = max(1, kx)
    letters, x0 = [], 0
    for ch in text:
        w, strokes = GLYPHS[ch]
        cells = set()
        for stroke in strokes:
            pts = staircase(np.asarray(stroke, float), kx, ky)
            B = np.rint(np.c_[pts[:, 0] * kx, pts[:, 1] * ky / 1.5]).astype(int)
            if len(B) == 1:
                cells.add((x0 + int(B[0, 0]), int(B[0, 1])))
            for a, b in zip(B[:-1], B[1:]):
                if a[1] == b[1]:
                    for x in range(min(a[0], b[0]), max(a[0], b[0]) + 1):
                        cells.add((x0 + x, int(a[1])))
                else:
                    for y in range(min(a[1], b[1]), max(a[1], b[1]) + 1):
                        cells.add((x0 + int(a[0]), y))
        letters.append(cells)
        x0 += w * kx + 1 + gap
    return letters, x0 - gap, int(round(H * ky / 1.5)) + 1


def cells_outline(cells):
    """Boundary of a set of unit cells as closed rectilinear polygons in block
    coordinates (corners only, first point repeated at the end), walked with
    the inside on the left. Cells that only touch at a corner stay on
    separate loops."""
    nxt = {}

    def add(a, b):
        nxt.setdefault(a, []).append(b)

    for (x, y) in cells:
        if (x, y - 1) not in cells:
            add((x, y), (x + 1, y))
        if (x + 1, y) not in cells:
            add((x + 1, y), (x + 1, y + 1))
        if (x, y + 1) not in cells:
            add((x + 1, y + 1), (x, y + 1))
        if (x - 1, y) not in cells:
            add((x, y + 1), (x, y))
    loops = []
    while nxt:
        start = next(iter(nxt))
        loop = [start]
        cur, d_in = start, None
        while True:
            cands = nxt.get(cur)
            if not cands:
                break
            if len(cands) > 1 and d_in is not None:
                # a touching corner: take the left turn, which keeps this loop
                # hugging its own inside
                cands.sort(key=lambda n: -(d_in[0] * (n[1] - cur[1]) - d_in[1] * (n[0] - cur[0])))
            n = cands.pop(0)
            if not cands:
                del nxt[cur]
            d_in = (n[0] - cur[0], n[1] - cur[1])
            cur = n
            if cur == start:
                break
            loop.append(cur)
        pts = []
        m = len(loop)
        for i in range(m):
            p, q, r = loop[i - 1], loop[i], loop[(i + 1) % m]
            if (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) != 0:
                pts.append(q)
        if len(pts) >= 4:
            loops.append(np.array(pts + [pts[0]], float))
    return loops


def outline_layout(text, kx=1, ky=1, loop=True):
    """Block letters laid out left to right on the block lattice: closed
    polygons per letter in block coordinates (x right, y up), the pen travel
    of their outlines split by axis, and a rough split of the joins between
    letters (and home again for a loop), so a caller can price each axis with
    its own block spacing."""
    letters, width, height = outline_cells(text, kx, ky)
    polys = []
    ink_x = ink_y = 0.0
    for cells in letters:
        for poly in cells_outline(cells):
            d = np.abs(np.diff(poly, axis=0))
            ink_x += float(d[:, 0].sum())
            ink_y += float(d[:, 1].sum())
            polys.append(poly)
    gap = max(1, kx)
    n_join = max(0, sum(1 for c in letters if c) - 1)
    conn_x = n_join * gap + (width if loop else 0.0)
    conn_y = n_join * 1.0 + (height if loop else 0.0)
    return dict(polys=polys, width=width, height=height, ink_xy=(ink_x, ink_y),
                conn_xy=(conn_x, conn_y), text=text)
