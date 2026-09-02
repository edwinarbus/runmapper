"""Snap idealised strokes onto the real street graph.

Each stroke is split at its corner vertices into "legs". Every leg is routed
with a corridor-restricted Dijkstra whose edge cost penalises straying from the
ideal segment, so the resulting path hugs the intended line instead of merely
taking the shortest way between the endpoints.
"""
import heapq

import numpy as np


def seg_dist(P, a, b):
    """Perpendicular distance from points P (N,2) to segment a-b, plus the
    projection parameter t in [0,1]."""
    ab = b - a
    L2 = float(ab @ ab)
    if L2 < 1e-9:
        return np.hypot(*(P - a).T), np.zeros(len(P))
    t = np.clip((P - a) @ ab / L2, 0, 1)
    proj = a + t[:, None] * ab
    return np.hypot(*(P - proj).T), t


class Snapper:
    def __init__(self, g, ok=None):
        self.g = g
        self.ok = g.keep if ok is None else ok
        self.n_dijkstra = 0

    def candidates(self, xy, k=3, radius=450.0):
        """Graph nodes near an ideal corner point."""
        g = self.g
        d, i = g.tree.query(xy, k=min(max(k * 4, 8), len(g.ids)))
        d = np.atleast_1d(d)
        i = np.atleast_1d(i)
        out = [(int(j), float(dd)) for dd, j in zip(d, i) if self.ok[j] and dd <= radius]
        if out:
            return out[:k]
        for dd, j in zip(d, i):
            if self.ok[j]:
                return [(int(j), float(dd))]
        return [(int(i[0]), float(d[0]))]

    def route_leg(self, src, dst, a, b, corridor=850.0, w_dev=9.0, dev_ref=260.0,
                  w_back=1.1, max_expand=200000, _widen=(1.0, 2.0, 4.0, 8.0)):
        """Dijkstra from node src to node dst, hugging segment a->b.

        The corridor is a hard cutoff, so a tight one can leave a leg with no
        feasible path at all. Rather than fail the whole placement, widen it and
        retry; the deviation penalty still keeps the result close to the line.
        """
        if src == dst:
            return [src], []
        for f in _widen:
            r = self._route_leg_once(src, dst, a, b, corridor * f, w_dev, dev_ref,
                                     w_back, max_expand)
            if r is not None:
                return r
        return None

    def _route_leg_once(self, src, dst, a, b, corridor, w_dev, dev_ref, w_back, max_expand):
        g = self.g
        X, Y = g.X, g.Y
        ab = b - a
        L = float(np.hypot(*ab))
        if L < 1e-6:
            L = 1.0
        lo = np.minimum(a, b) - corridor
        hi = np.maximum(a, b) + corridor
        box = (X >= lo[0]) & (X <= hi[0]) & (Y >= lo[1]) & (Y <= hi[1]) & self.ok
        idxs = np.flatnonzero(box)
        if len(idxs) == 0:
            return None
        P = np.c_[X[idxs], Y[idxs]]
        dist_perp, t = seg_dist(P, a, b)
        inside = dist_perp <= corridor
        idxs, dist_perp, t = idxs[inside], dist_perp[inside], t[inside]
        if len(idxs) == 0:
            return None
        allow = np.zeros(len(X), bool)
        allow[idxs] = True
        dv = np.zeros(len(X))
        dv[idxs] = dist_perp
        sv = np.zeros(len(X))
        sv[idxs] = t * L
        allow[src] = allow[dst] = True
        self.n_dijkstra += 1

        INF = float("inf")
        best = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        seen = set()
        n_exp = 0
        nbrs = g.nbrs
        while pq:
            c, v = heapq.heappop(pq)
            if v in seen:
                continue
            seen.add(v)
            n_exp += 1
            if v == dst:
                break
            if n_exp > max_expand:
                break
            dvv = dv[v]
            svv = sv[v]
            for (w, ln, mult, wid) in nbrs[v]:
                if not allow[w] or w in seen:
                    continue
                dev = 0.5 * (dvv + dv[w])
                step = ln * mult * (1.0 + w_dev * (dev / dev_ref) ** 2)
                ds = sv[w] - svv
                if ds < 0:
                    step += w_back * (-ds)
                nc = c + step
                if nc < best.get(w, INF):
                    best[w] = nc
                    prev[w] = (v, wid)
                    heapq.heappush(pq, (nc, w))
        if dst not in best:
            return None
        path, wids = [dst], []
        cur = dst
        while cur != src:
            p, wid = prev[cur]
            path.append(p)
            wids.append(wid)
            cur = p
        path.reverse()
        wids.reverse()
        return path, wids

    def shortest_hug(self, src, dst, hug=None, used_edges=None, reuse_discount=0.12,
                     allow=None, max_expand=400000):
        """Connector routing that prefers to retrace ink the drawing already
        lays down, and otherwise stays close to it, so joins stay invisible.

        `hug` is a per-node multiplier (1 on the ink, growing with distance from
        it) precomputed by the caller, so the inner loop stays free of geometry.
        """
        if src == dst:
            return [src], []
        g = self.g
        ok = self.ok if allow is None else allow
        INF = float("inf")
        best = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        seen = set()
        n = 0
        nbrs = g.nbrs
        self.n_dijkstra += 1
        while pq:
            c, v = heapq.heappop(pq)
            if v in seen:
                continue
            seen.add(v)
            n += 1
            if v == dst:
                break
            if n > max_expand:
                break
            hv = hug[v] if hug is not None else 1.0
            for (w, ln, mult, wid) in nbrs[v]:
                if not ok[w] or w in seen:
                    continue
                step = ln * mult
                if used_edges is not None and (v, w) in used_edges:
                    step *= reuse_discount
                elif hug is not None:
                    step *= 0.5 * (hv + hug[w])
                nc = c + step
                if nc < best.get(w, INF):
                    best[w] = nc
                    prev[w] = (v, wid)
                    heapq.heappush(pq, (nc, w))
        if dst not in best:
            return None
        path, wids = [dst], []
        cur = dst
        while cur != src:
            p, wid = prev[cur]
            path.append(p)
            wids.append(wid)
            cur = p
        path.reverse()
        wids.reverse()
        return path, wids

    def _plen(self, path):
        X, Y = self.g.X, self.g.Y
        p = np.asarray(path)
        return float(np.sum(np.hypot(np.diff(X[p]), np.diff(Y[p]))))

    def _dev(self, path, a, b):
        X, Y = self.g.X, self.g.Y
        p = np.asarray(path)
        d, _ = seg_dist(np.c_[X[p], Y[p]], a, b)
        return float(d.mean())

    def _dp(self, corners, cand, **kw):
        """Dynamic programme over candidate nodes per corner; `cand[i]` lists
        (node, snap_offset) options for corner i."""
        n = len(corners)
        table = [{j: (dd * 1.4, None, None, None) for j, dd in cand[0]}]
        for i in range(1, n):
            nxt = {}
            ideal = float(np.hypot(*(corners[i] - corners[i - 1])))
            for j, dd in cand[i]:
                bestc, bestp, bestpath, bestw = float("inf"), None, None, None
                for p, (pc, _, _, _) in table[-1].items():
                    r = self.route_leg(p, j, corners[i - 1], corners[i], **kw)
                    if r is None:
                        continue
                    path, wids = r
                    seglen = self._plen(path) if len(path) > 1 else 0.0
                    dev = self._dev(path, corners[i - 1], corners[i])
                    c = pc + seglen + 2.5 * dev + 0.8 * abs(seglen - ideal) + dd * 1.4
                    if c < bestc:
                        bestc, bestp, bestpath, bestw = c, p, path, wids
                if bestp is not None:
                    nxt[j] = (bestc, bestp, bestpath, bestw)
            if not nxt:
                return None
            table.append(nxt)
        end = min(table[-1], key=lambda j: table[-1][j][0])
        legs = []
        j = end
        for i in range(len(table) - 1, 0, -1):
            c, p, path, wids = table[i][j]
            legs.append((path, wids))
            j = p
        legs.reverse()
        return legs

    def snap_stroke(self, corners, k=3, radius=450.0, **kw):
        """Snap an open polyline: free choice of node at every corner."""
        cand = [self.candidates(c, k=k, radius=radius) for c in corners]
        return self._dp(corners, cand, **kw)

    def snap_stroke_fixed(self, corners, first_node, k=3, radius=450.0, **kw):
        """Like snap_stroke but pinned to `first_node` at both ends (closed loops)."""
        cand = [self.candidates(c, k=k, radius=radius) for c in corners]
        cand[0] = [(first_node, 0.0)]
        cand[-1] = [(first_node, 0.0)]
        return self._dp(corners, cand, **kw)
