import numpy as np
import pytest

from runmapper_engine import font


def test_every_glyph_walks_from_every_port():
    for ch in font.GLYPHS:
        g = font.glyph_graph(ch)
        for a in "bt":
            for b in "bt":
                cost, length, pts = g.walk(a + "l", b + "r")
                assert np.isfinite(cost) and length >= 0
                assert pts[0] == font._key(g.ports[a + "l"])
                assert pts[-1] == font._key(g.ports[b + "r"])
                # every stroke segment appears somewhere in the walk
                walked = {(font._key(p), font._key(q)) for p, q in zip(pts[:-1], pts[1:])}
                walked |= {(q, p) for p, q in walked}
                for s in g.strokes:
                    for p, q in zip(s[:-1], s[1:]):
                        assert (p, q) in walked, f"{ch}: stroke {p}->{q} not drawn"


def test_layout_is_one_polyline_left_to_right():
    lay = font.layout("HELLO")
    P = lay["points"]
    assert P.ndim == 2 and len(P) > 10
    assert lay["units_wide"] == 5 * 2 + 4 * font.GAP
    assert lay["walk_units"] > 0 and lay["return_units"] > 0
    assert len(lay["sides"]) == 6


def test_text_strokes_are_normalised():
    strokes, lay = font.text_strokes("RUN")
    pts = strokes[0].pts
    lo, hi = pts.min(0), pts.max(0)
    assert abs((hi - lo).max() - 1.0) < 1e-9
    assert abs(((lo + hi) / 2).max()) < 1e-9


def test_limits_and_charset():
    with pytest.raises(font.FontError):
        font.check_text("HELLO WORLD!!!")
    with pytest.raises(font.FontError):
        font.check_text("héllo")
    with pytest.raises(font.FontError):
        font.check_text("   ")
    assert font.check_text("  hello   world ") == "HELLO WORLD"


def test_connectors_run_along_the_bottom():
    # One underline for the whole word: every connector sits on the bottom edge.
    lay = font.layout("TL")
    assert all(s == "b" for s in lay["sides"])
    P = lay["points"]
    assert P[0].tolist() == [0.0, 0.0] and P[-1][1] == 0.0


def test_staircase_keeps_lattice_points_and_removes_diagonals():
    pts = [(0, 0), (2, 3), (2, 0)]
    out = font.staircase(pts, 1, 1)
    d = np.abs(np.diff(out, axis=0))
    assert np.all((d[:, 0] < 1e-9) | (d[:, 1] < 1e-9))     # every step is axis-aligned
    assert out[0].tolist() == [0.0, 0.0] and out[-1].tolist() == [2.0, 0.0]
    assert any(np.allclose(p, (2, 3)) for p in out)
