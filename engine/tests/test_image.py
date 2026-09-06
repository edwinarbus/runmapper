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


def _ring_with_chevron_png(size=400):
    """A thick ring with a gap at the top and two thick legs from the centre
    down to the ring, like a badge: a shape whose skeleton has junctions
    where the legs meet the ring, and whose ring must survive them whole."""
    im = Image.new("L", (size, size), 255)
    d = ImageDraw.Draw(im)
    c = size / 2
    d.ellipse((c - 170, c - 170, c + 170, c + 170), fill=0)
    d.ellipse((c - 120, c - 120, c + 120, c + 120), fill=255)
    d.pieslice((c - 180, c - 180, c + 180, c + 180), start=250, end=290, fill=255)   # the gap at the top
    for ang in (120, 60):                                                              # the legs, down to the ring
        x = c + 150 * np.cos(np.radians(ang))
        y = c + 150 * np.sin(np.radians(ang))
        d.line([(c, c), (x, y)], fill=0, width=44)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_centreline_keeps_a_ring_whole_through_its_junctions():
    """The ring's skeleton is cut where the legs join it; the arcs must be
    walked whole and joined back through the junctions, not left as scraps."""
    mask = img.load_mask(_ring_with_chevron_png())
    cen = img.centerline_strokes(mask)
    assert 2 <= len(cen) <= 5, [round(s.length, 2) for s in cen]
    longest = max(s.length for s in cen)
    # the ring's arc, all but the gap: most of a circle of diameter a little under 1
    assert longest > 1.8, [round(s.length, 2) for s in cen]
    # and nothing left in pieces
    assert min(s.length for s in cen) > 0.12 * longest

