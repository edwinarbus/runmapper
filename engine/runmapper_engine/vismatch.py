"""Visual similarity between the run and the drawing, judged the way an eye
would: rasterise both as thick strokes and compare the pictures."""
import numpy as np
from scipy.ndimage import binary_dilation


def _raster(polys, lo, span, N, thick_px):
    img = np.zeros((N, N), bool)
    for p in polys:
        p = np.asarray(p, float)
        if len(p) < 2:
            continue
        for a, b in zip(p[:-1], p[1:]):
            L = float(np.hypot(*(b - a)))
            n = max(2, int(L / (span / N) * 2) + 1)
            t = np.linspace(0, 1, n)[:, None]
            q = a + t * (b - a)
            ix = ((q[:, 0] - lo[0]) / span * (N - 1)).astype(int)
            iy = ((q[:, 1] - lo[1]) / span * (N - 1)).astype(int)
            ok = (ix >= 0) & (ix < N) & (iy >= 0) & (iy < N)
            img[iy[ok], ix[ok]] = True
    if thick_px > 0:
        r = int(round(thick_px))
        if r > 0:
            yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
            img = binary_dilation(img, yy ** 2 + xx ** 2 <= r * r)
    return img


def vis_match(route_xy, ideal_polys, N=260, tol_ft=95.0, pad=0.10):
    """IoU of the drawn line against the ideal drawing, both thickened by
    `tol_ft` (roughly GPS wobble plus a half-block of street-snapping slack).

    Returns IoU plus the two one-sided scores: `cover` = how much of the
    drawing got drawn, `prec` = how much of what was drawn belongs to it.
    """
    I = np.vstack([np.asarray(p) for p in ideal_polys])
    lo = I.min(0)
    hi = I.max(0)
    span = max(hi[0] - lo[0], hi[1] - lo[1])
    lo = lo - pad * span
    hi = hi + pad * span
    span = float(max(hi[0] - lo[0], hi[1] - lo[1]))
    thick = tol_ft / span * N
    a = _raster(ideal_polys, lo, span, N, thick)
    b = _raster([route_xy], lo, span, N, thick)
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return dict(iou=float(inter / max(union, 1)),
                cover=float(inter / max(a.sum(), 1)),
                prec=float(inter / max(b.sum(), 1)))
