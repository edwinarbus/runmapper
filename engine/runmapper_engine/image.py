"""Raster uploads (PNG/JPG) and filled masks -> strokes.

Two representations are built from a binary mask of the shape:

* outline: the contour of the filled shape, as closed strokes. Right for bold
  marks whose two edges are far enough apart to land on different streets.
* centreline: the skeleton of the shape, as open strokes. Right for thin marks
  and line drawings, whose two edges would otherwise collapse onto one street.

The pipeline decides between them from the shape's measured thickness.
"""
import io
import math

import numpy as np
from PIL import Image
from scipy import ndimage

from .strokes import Stroke, rdp, normalize

MASK_SIZE = 512


class ImageError(ValueError):
    pass


def load_mask(data, size=MASK_SIZE):
    """Decode an image and return a boolean foreground mask (y down)."""
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as ex:  # noqa: BLE001
        raise ImageError("Couldn't read that image. Use a PNG, JPG, GIF or WebP.") from ex
    im = im.convert("RGBA")
    w, h = im.size
    if max(w, h) > size:
        s = size / max(w, h)
        im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    a = np.asarray(im, float)
    rgb, alpha = a[..., :3], a[..., 3]
    if alpha.min() < 128:
        fg = alpha > 128
    else:
        # background = the colour that dominates the border of the picture
        border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
        bg = np.median(border, axis=0)
        dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
        thr = _otsu(dist)
        thr = max(thr, 40.0)
        fg = dist > thr
    fg = _clean(fg)
    if fg.sum() < 50:
        raise ImageError("Couldn't find a shape in that image; it looks empty.")
    return _pad(fg)


def _otsu(vals, bins=256):
    hist, edges = np.histogram(vals, bins=bins)
    mids = 0.5 * (edges[:-1] + edges[1:])
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * mids) / np.maximum(w0, 1)
    m1 = (np.cumsum((hist * mids)[::-1])[::-1] - hist * mids) / np.maximum(w1, 1)
    var = w0 * w1 * (m0 - m1) ** 2
    return float(mids[int(np.argmax(var))])


def _clean(fg, min_frac=0.01, hole_frac=0.002):
    """Drop specks and fill pinholes, keep real holes (counters of letters)."""
    lab, n = ndimage.label(fg)
    if n == 0:
        return fg
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    big = sizes.max()
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= max(20, min_frac * big)
    fg = keep[lab]
    inv = ~fg
    lab, n = ndimage.label(inv)
    if n:
        sizes = ndimage.sum(inv, lab, range(1, n + 1))
        # the component touching the border is the outside; small others are pinholes
        border_labels = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
        fill = np.zeros(n + 1, bool)
        for i in range(1, n + 1):
            if i not in border_labels and sizes[i - 1] < hole_frac * fg.sum():
                fill[i] = True
        fg = fg | fill[lab]
    return fg


def _pad(mask, frac=0.06):
    h, w = mask.shape
    p = int(max(h, w) * frac) + 2
    out = np.zeros((h + 2 * p, w + 2 * p), bool)
    out[p:p + h, p:p + w] = mask
    return out


def thickness(mask):
    """Median stroke thickness of the shape as a fraction of its larger
    dimension, measured on the skeleton with a distance transform."""
    from skimage.morphology import skeletonize
    sk = skeletonize(mask)
    if sk.sum() == 0:
        return 0.0
    edt = ndimage.distance_transform_edt(mask)
    ys, xs = np.nonzero(mask)
    span = float(max(ys.max() - ys.min(), xs.max() - xs.min())) or 1.0
    return float(np.median(2.0 * edt[sk]) / span)


def outline_strokes(mask, simplify=0.004, min_len_frac=0.06):
    """Closed contour strokes of the mask, normalised (y-up)."""
    from skimage.measure import find_contours
    cs = find_contours(mask.astype(float), 0.5)
    if not cs:
        raise ImageError("Couldn't trace an outline from that image.")
    polys = [np.c_[c[:, 1], -c[:, 0]] for c in cs]      # (x, y-up)
    strokes = [Stroke(p, name=f"outline{i}", closed=True) for i, p in enumerate(polys)]
    strokes = normalize(strokes)
    lens = [s.length for s in strokes]
    biggest = max(lens)
    out = []
    for s, L in zip(strokes, lens):
        if L < min_len_frac * biggest:
            continue
        pts = rdp(s.pts, simplify)
        if not np.allclose(pts[0], pts[-1]):
            pts = np.vstack([pts, pts[:1]])
        out.append(Stroke(pts, s.name, True, "outline"))
    return normalize(out)


def _neighbors(sk):
    k = np.ones((3, 3), int)
    k[1, 1] = 0
    return ndimage.convolve(sk.astype(int), k, mode="constant")


def _branches(sk):
    """Split a skeleton into pixel chains between junctions/endpoints."""
    nb = _neighbors(sk) * sk
    junction = sk & (nb >= 3)
    body = sk & ~junction
    lab, n = ndimage.label(body, structure=np.ones((3, 3)))
    branches = []
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        px = set(zip(ys.tolist(), xs.tolist()))
        # order the chain by walking from an end
        deg = {p: sum(((p[0] + dy, p[1] + dx) in px) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                      if (dy or dx)) for p in px}
        ends = [p for p, d in deg.items() if d <= 1]
        start = ends[0] if ends else next(iter(px))
        chain = [start]
        seen = {start}
        cur = start
        while True:
            nxt = None
            for dy, dx in ((0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                q = (cur[0] + dy, cur[1] + dx)
                if q in px and q not in seen:
                    nxt = q
                    break
            if nxt is None:
                break
            chain.append(nxt)
            seen.add(nxt)
            cur = nxt
        # attach the junction pixels this branch touches, so chains meet
        def touching(p):
            return [(p[0] + dy, p[1] + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                    if (dy or dx) and 0 <= p[0] + dy < sk.shape[0] and 0 <= p[1] + dx < sk.shape[1]
                    and junction[p[0] + dy, p[1] + dx]]
        j0 = touching(chain[0])
        j1 = touching(chain[-1])
        if j0:
            chain = [j0[0]] + chain
        if j1:
            chain = chain + [j1[0]]
        branches.append(chain)
    return branches, junction


def centerline_strokes(mask, simplify=0.006, spur_frac=0.10, rounds=3, min_frac=0.12):
    """Open skeleton strokes of the mask, normalised (y-up).

    Short spurs (the forks a skeleton grows at rounded ends) are pruned, and
    what remains is kept only if it is at least `min_frac` of the longest line.
    """
    from skimage.morphology import skeletonize
    sk = skeletonize(mask)
    span = float(max(mask.shape))
    for _ in range(rounds):
        branches, junction = _branches(sk)
        if len(branches) <= 1:
            break
        nb = _neighbors(sk) * sk
        removed = False
        for ch in branches:
            L = _chain_len(ch)
            is_spur = any(nb[p] <= 1 for p in (ch[0], ch[-1])) and not all(nb[p] <= 1 for p in (ch[0], ch[-1]))
            if is_spur and L < spur_frac * span:
                for p in ch:
                    if not junction[p]:
                        sk[p] = False
                removed = True
        if not removed:
            break
    branches, junction = _branches(sk)
    if not branches:
        raise ImageError("Couldn't trace a line through that image.")
    chains = [np.array(ch, float) for ch in branches if len(ch) >= 2]
    chains = _merge_collinear(chains)
    polys = [np.c_[c[:, 1], -c[:, 0]] for c in chains]
    strokes = normalize([Stroke(p, name=f"line{i}", closed=False, kind="center") for i, p in enumerate(polys)])
    out = []
    longest = max(s.length for s in strokes)
    for s in strokes:
        if s.length < min_frac * longest:
            continue
        pts = rdp(s.pts, simplify)
        if len(pts) >= 2 and np.hypot(*(pts[-1] - pts[0])) > 1e-6 or len(pts) > 2:
            out.append(Stroke(pts, s.name, False, "center"))
    if not out:
        raise ImageError("Couldn't trace a line through that image.")
    return normalize(out)


def _chain_len(ch):
    return sum(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(ch[:-1], ch[1:]))


def _merge_collinear(chains, max_angle=40.0):
    """Join branches that meet end to end at a junction and continue straight,
    so a crossing becomes two lines instead of four stubs."""
    chains = [c for c in chains if len(c) >= 2]
    merged = True
    while merged and len(chains) > 1:
        merged = False
        best = None
        for i in range(len(chains)):
            for j in range(i + 1, len(chains)):
                for ei in (0, -1):
                    for ej in (0, -1):
                        a, b = chains[i], chains[j]
                        if np.hypot(*(a[ei] - b[ej])) > 1.5:
                            continue
                        da = a[ei] - a[-2 if ei == -1 else 1]
                        db = b[-2 if ej == -1 else 1] - b[ej]
                        ang = _angle(da, db)
                        if ang < max_angle and (best is None or ang < best[0]):
                            best = (ang, i, j, ei, ej)
        if best is not None:
            ang, i, j, ei, ej = best
            a, b = chains[i], chains[j]
            if ei == 0:
                a = a[::-1]
            if ej == -1:
                b = b[::-1]
            chains = [c for k, c in enumerate(chains) if k not in (i, j)] + [np.vstack([a, b[1:]])]
            merged = True
    return chains


def _angle(u, v):
    nu, nv = np.hypot(*u), np.hypot(*v)
    if nu < 1e-9 or nv < 1e-9:
        return 180.0
    c = float(np.clip(np.dot(u, v) / (nu * nv), -1, 1))
    return math.degrees(math.acos(c))


def feature_size(strokes):
    """Median stroke length of a normalised stroke set, a proxy for the size of
    the smallest detail that has to survive."""
    lens = sorted(s.length for s in strokes)
    return float(lens[len(lens) // 2]) if lens else 0.0
