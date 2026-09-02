"""SVG uploads -> strokes.

Uses svgpathtools' Document so group transforms are applied, then samples
every continuous subpath by arc length. Filled shapes become closed outline
strokes; the filled mask is also rasterised so the pipeline can measure how
thick the shapes are and build a centreline alternative.
"""
import os
import re
import tempfile

import numpy as np
from PIL import Image, ImageDraw

from .strokes import Stroke, rdp, normalize


class SVGError(ValueError):
    pass


def _paths_from_document(svg_text):
    from svgpathtools import Document
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False, encoding="utf-8") as f:
        f.write(svg_text)
        tmp = f.name
    try:
        doc = Document(tmp)
        out = []
        flat = getattr(doc, "flatten_all_paths", None)
        if flat is not None:
            for item in flat():
                path = item[0] if isinstance(item, tuple) else item.path
                el = item[1] if isinstance(item, tuple) else item.element
                attrs = dict(el.attrib) if el is not None else {}
                out.append((path, attrs))
        else:
            for path in doc.paths():
                out.append((path, {}))
        return out
    finally:
        os.unlink(tmp)


def _paths_regex(svg_text):
    from svgpathtools import parse_path
    ds = re.findall(r'\sd="([^"]+)"', svg_text)
    return [(parse_path(d), {}) for d in ds]


def _style_of(attrs):
    st = {}
    for k in ("fill", "stroke"):
        if k in attrs:
            st[k] = attrs[k].strip()
    style = attrs.get("style", "")
    for part in style.split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            if k.strip() in ("fill", "stroke"):
                st[k.strip()] = v.strip()
    return st


def _sample(sub, samples_per_unit, min_pts=12, max_pts=600):
    L = sub.length(error=1e-4)
    if L <= 0:
        return None
    n = int(np.clip(int(L * samples_per_unit), min_pts, max_pts))
    ts = np.linspace(0, 1, n)
    pts = []
    for t in ts:
        s = sub.ilength(t * L, s_tol=1e-6) if 0 < t < 1 else t
        z = sub.point(s)
        pts.append((z.real, z.imag))
    return np.array(pts, float)


def svg_to_polys(svg_text):
    """Return (polys, line_art) where polys are (N,2) arrays in SVG units (y
    down) and line_art says the drawing is stroked lines rather than fills."""
    try:
        paths = _paths_from_document(svg_text)
    except Exception:  # noqa: BLE001 - fall back to a plain parse
        paths = _paths_regex(svg_text)
    if not paths:
        raise SVGError("No paths found in the SVG.")
    allp = []
    for path, attrs in paths:
        try:
            for sub in path.continuous_subpaths():
                allp.append(sub)
        except Exception:  # noqa: BLE001
            continue
    if not allp:
        raise SVGError("No drawable paths found in the SVG.")
    # Estimate extent to choose a sampling density.
    xs, ys = [], []
    for sub in allp:
        try:
            bb = sub.bbox()
            xs += [bb[0], bb[1]]
            ys += [bb[2], bb[3]]
        except Exception:  # noqa: BLE001
            continue
    span = max(max(xs) - min(xs), max(ys) - min(ys)) if xs else 1.0
    spu = 400.0 / max(span, 1e-9)
    polys, closed = [], []
    styles = []
    for path, attrs in paths:
        st = _style_of(attrs)
        for sub in path.continuous_subpaths():
            p = _sample(sub, spu)
            if p is None or len(p) < 2:
                continue
            is_closed = sub.isclosed() or np.hypot(*(p[0] - p[-1])) < 0.01 * span
            polys.append(p)
            closed.append(bool(is_closed))
            styles.append(st)
    if not polys:
        raise SVGError("The SVG has no drawable geometry.")
    n_fill_none = sum(1 for st in styles if st.get("fill") == "none" and st.get("stroke") not in (None, "none"))
    line_art = n_fill_none >= max(1, len(styles) // 2)
    return polys, closed, line_art


def polys_to_mask(polys, size=512):
    """Even-odd rasterisation of closed polygons (y down in, y down out)."""
    allp = np.vstack(polys)
    lo, hi = allp.min(0), allp.max(0)
    span = float(max(hi[0] - lo[0], hi[1] - lo[1])) or 1.0
    pad = int(size * 0.06)
    scale = (size - 2 * pad) / span
    mask = np.zeros((size, size), bool)
    for p in polys:
        q = (p - lo) * scale + pad
        img = Image.new("1", (size, size), 0)
        ImageDraw.Draw(img).polygon([(float(x), float(y)) for x, y in q], fill=1)
        mask ^= np.array(img, bool)
    return mask


def svg_strokes(svg_text, simplify=0.004):
    """Outline strokes (normalised, y-up) plus the filled mask and a line-art flag."""
    polys, closed, line_art = svg_to_polys(svg_text)
    strokes = []
    for i, (p, c) in enumerate(zip(polys, closed)):
        strokes.append(Stroke(p * np.array([1.0, -1.0]), name=f"path{i}", closed=c and not line_art,
                              kind="line" if line_art else "outline"))
    strokes = normalize(strokes)
    out = []
    for s in strokes:
        pts = rdp(s.pts, simplify)
        if s.closed and not np.allclose(pts[0], pts[-1]):
            pts = np.vstack([pts, pts[:1]])
        out.append(Stroke(pts, s.name, s.closed, s.kind))
    closed_polys = [p for p, c in zip(polys, closed) if c]
    if not line_art and not closed_polys:
        # nothing to fill: treat the open paths as drawn lines
        line_art = True
        out = [Stroke(s.pts, s.name, False, "line") for s in out]
    mask = None if line_art else polys_to_mask(closed_polys)
    return out, mask, line_art
