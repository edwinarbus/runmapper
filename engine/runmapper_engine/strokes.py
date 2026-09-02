"""Stroke primitives shared by every input type.

A "stroke" is a polyline in normalised drawing space: the whole drawing is
centred on the origin with its larger dimension equal to 1.0, y-up. Routes
scale that by a width in feet.
"""
import numpy as np

from .geo import polyline_len


class Stroke:
    def __init__(self, pts, name="stroke", closed=False, kind="outline"):
        self.pts = np.asarray(pts, float)
        self.name = name
        self.closed = closed
        self.kind = kind

    def __repr__(self):
        return f"<Stroke {self.name} n={len(self.pts)} len={polyline_len(self.pts):.3f}>"

    @property
    def length(self):
        return polyline_len(self.pts)


def rdp(pts, eps):
    """Ramer-Douglas-Peucker simplification."""
    pts = np.asarray(pts, float)
    if len(pts) < 3:
        return pts
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        ab = b - a
        L = np.hypot(*ab)
        if L < 1e-12:
            d = np.hypot(*(pts[i + 1:j] - a).T)
        else:
            rel = pts[i + 1:j] - a
            d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            k += i + 1
            keep[k] = True
            stack += [(i, k), (k, j)]
    return pts[keep]


def normalize(strokes):
    """Centre the drawing on its bbox and scale its larger dimension to 1.0."""
    allp = np.vstack([s.pts for s in strokes])
    lo, hi = allp.min(0), allp.max(0)
    ctr = (lo + hi) / 2.0
    scale = float((hi - lo).max())
    if scale <= 0:
        scale = 1.0
    out = []
    for s in strokes:
        out.append(Stroke((s.pts - ctr) / scale, s.name, s.closed, s.kind))
    return out


def bbox(strokes):
    allp = np.vstack([s.pts for s in strokes])
    return allp.min(0), allp.max(0)


def ink_length(strokes):
    return float(sum(s.length for s in strokes))


def connector_estimate(strokes, loop=True):
    """Rough length of the joins between strokes if drawn in the given order:
    straight-line gaps between consecutive strokes, plus the closing gap."""
    if not strokes:
        return 0.0
    tot = 0.0
    for a, b in zip(strokes[:-1], strokes[1:]):
        tot += float(np.hypot(*(b.pts[0] - a.pts[-1])))
    if loop and len(strokes) >= 1:
        tot += float(np.hypot(*(strokes[0].pts[0] - strokes[-1].pts[-1])))
    return tot


def order_greedy(strokes):
    """Nearest-neighbour ordering of strokes (with direction flips for open
    ones) so the joins are short. Good enough as a starting order for the
    snapper, which optimises entries itself."""
    if len(strokes) <= 1:
        return list(strokes)
    remaining = list(range(len(strokes)))
    out = [strokes[remaining.pop(0)]]
    while remaining:
        end = out[-1].pts[-1]
        best, bi, flip = None, None, False
        for r in remaining:
            s = strokes[r]
            d0 = float(np.hypot(*(s.pts[0] - end)))
            d1 = float(np.hypot(*(s.pts[-1] - end))) if not s.closed else d0
            d = min(d0, d1)
            if best is None or d < best:
                best, bi, flip = d, r, (d1 < d0 and not s.closed)
        remaining.remove(bi)
        s = strokes[bi]
        if flip:
            s = Stroke(s.pts[::-1], s.name, s.closed, s.kind)
        out.append(s)
    return out
