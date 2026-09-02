"""Small binary-image tools (thinning and contour tracing) on numpy alone.

These replace the two scikit-image calls the engine used to make, so the
function bundle stays small enough for a serverless host.
"""
import numpy as np


def skeletonize(mask):
    """Zhang–Suen thinning: a 1-pixel-wide, 8-connected skeleton of a boolean
    mask, same idea as skimage.morphology.skeletonize(method="zhang")."""
    img = np.asarray(mask, bool).astype(np.uint8)
    if img.size == 0 or not img.any():
        return img.astype(bool)
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2 = P[:-2, 1:-1]
            p3 = P[:-2, 2:]
            p4 = P[1:-1, 2:]
            p5 = P[2:, 2:]
            p6 = P[2:, 1:-1]
            p7 = P[2:, :-2]
            p8 = P[1:-1, :-2]
            p9 = P[:-2, :-2]
            ring = (p2, p3, p4, p5, p6, p7, p8, p9, p2)
            B = sum(int(0) + r.astype(np.int16) for r in ring[:8])
            A = np.zeros(img.shape, np.int16)
            for a, b in zip(ring[:-1], ring[1:]):
                A += ((a == 0) & (b == 1))
            if step == 0:
                c1 = (p2 * p4 * p6) == 0
                c2 = (p4 * p6 * p8) == 0
            else:
                c1 = (p2 * p4 * p8) == 0
                c2 = (p2 * p6 * p8) == 0
            rem = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & c1 & c2
            if rem.any():
                img[rem] = 0
                changed = True
        if not changed:
            break
    return img.astype(bool)


# Marching squares on a binary image at level 0.5. Cell corners (row, col):
# a=(r,c) b=(r,c+1) c=(r+1,c+1) d=(r+1,c); index = 8a+4b+2c+d. Edge midpoints
# T=(r,c+.5) R=(r+.5,c+1) B=(r+1,c+.5) L=(r+.5,c), in doubled integer coords.
_T, _R, _B, _L = (0, 1), (1, 2), (2, 1), (1, 0)
_CASES = {
    1: [(_L, _B)], 2: [(_B, _R)], 3: [(_L, _R)], 4: [(_T, _R)],
    5: [(_T, _R), (_L, _B)],            # saddle: foreground corners kept apart
    6: [(_T, _B)], 7: [(_T, _L)], 8: [(_L, _T)], 9: [(_T, _B)],
    10: [(_L, _T), (_B, _R)],           # saddle
    11: [(_T, _R)], 12: [(_L, _R)], 13: [(_B, _R)], 14: [(_L, _B)],
}


def find_contours(mask):
    """Closed iso-contours of a boolean mask at level 0.5, as (N,2) arrays of
    (row, col) in pixel-centre coordinates, like skimage.measure.find_contours
    with fully_connected="low". Diagonally touching foreground pixels are kept
    on separate contours."""
    m = np.pad(np.asarray(mask, bool).astype(np.uint8), 1)
    a = m[:-1, :-1]
    b = m[:-1, 1:]
    c = m[1:, 1:]
    d = m[1:, :-1]
    idx = a * 8 + b * 4 + c * 2 + d
    adj = {}

    def link(p, q):
        adj.setdefault(p, []).append(q)
        adj.setdefault(q, []).append(p)

    for case, segs in _CASES.items():
        rr, cc = np.nonzero(idx == case)
        if len(rr) == 0:
            continue
        for (e1, e2) in segs:
            for r, col in zip(rr.tolist(), cc.tolist()):
                p = (2 * r + e1[0], 2 * col + e1[1])
                q = (2 * r + e2[0], 2 * col + e2[1])
                link(p, q)
    contours = []
    seen = set()
    for start in adj:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            nxt = None
            for n in adj[cur]:
                if n != prev and n not in seen:
                    nxt = n
                    break
            if nxt is None:
                break
            loop.append(nxt)
            seen.add(nxt)
            prev, cur = cur, nxt
        pts = np.array(loop, float) / 2.0 - 1.0     # doubled coords, padding
        if len(pts) >= 3:
            contours.append(np.vstack([pts, pts[:1]]))
    return contours
