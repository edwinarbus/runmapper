import io

import numpy as np
from PIL import Image, ImageDraw

from runmapper_engine import image as img, svgin


def _letter_a_png(size=300, thick=40):
    """A bold block 'A' on white, as PNG bytes."""
    im = Image.new("L", (size, size), 255)
    d = ImageDraw.Draw(im)
    d.line([(40, 280), (150, 30)], fill=0, width=thick)
    d.line([(150, 30), (260, 280)], fill=0, width=thick)
    d.line([(90, 180), (210, 180)], fill=0, width=thick)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_raster_mask_and_traces():
    mask = img.load_mask(_letter_a_png())
    assert mask.dtype == bool and mask.sum() > 1000
    th = img.thickness(mask)
    assert 0.05 < th < 0.25
    out = img.outline_strokes(mask)
    assert 1 <= len(out) <= 3
    assert all(s.closed for s in out)
    cen = img.centerline_strokes(mask)
    assert 1 <= len(cen) <= 8            # legs, bar and junction pieces; no spray of spurs
    assert min(s.length for s in cen) > 0.1
    assert all(not s.closed for s in cen)
    allp = np.vstack([s.pts for s in cen])
    assert abs((allp.max(0) - allp.min(0)).max() - 1.0) < 1e-6


def test_svg_outline_of_a_square_with_hole():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
           '<path d="M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z"/></svg>')
    strokes, mask, line_art = svgin.svg_strokes(svg)
    assert not line_art
    assert len(strokes) == 2
    assert all(s.closed for s in strokes)
    assert mask is not None and 0.2 < mask.mean() < 0.6      # hollow square
    assert img.thickness(mask) > 0.1


def test_svg_line_art_stays_open():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
           '<path d="M10 90 L50 10 L90 90" fill="none" stroke="black" stroke-width="4"/></svg>')
    strokes, mask, line_art = svgin.svg_strokes(svg)
    assert line_art
    assert len(strokes) == 1 and not strokes[0].closed
