"""Whole pipeline on a synthetic grid, no network."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from synthetic import grid_elements  # noqa: E402

from runmapper_engine import pipeline  # noqa: E402
from runmapper_engine.geo import Projection  # noqa: E402


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def fake_fetch(bbox, cache_dir=None, log=None, **kw):
        return grid_elements(Projection(40.7410, -73.9897), nx=48, ny=48, bx=400.0, by=300.0)

    monkeypatch.setattr(pipeline, "fetch_bbox", fake_fetch)
    monkeypatch.setenv("RUNMAPPER_ELEVATION", "0")


def test_hello_10k_is_a_clean_loop():
    req = pipeline.PlanRequest(lat=40.7410, lon=-73.9897, bucket="10k", loop=True, text="hello")
    res = pipeline.plan_run(req)
    r = res["route"]
    assert res["verdict"] == "great"
    assert res["score"]["iou"] > 0.8
    assert r["loop"] and r["coords"][0] == r["coords"][-1]
    assert r["distance_mi"] <= pipeline.BUCKETS["10k"]["cap_mi"] * pipeline.FREE_OVER_CAP
    assert res["grid"]["size_kind"] == "aligned"
    assert res["gpx"].startswith("<?xml") and "<trkpt" in res["gpx"]
    assert len(res["cues"]) > 5
    assert res["drawing"]["label"] == "HELLO"


def test_open_route_when_loop_off():
    req = pipeline.PlanRequest(lat=40.7410, lon=-73.9897, bucket="10k", loop=False, text="HELLO")
    res = pipeline.plan_run(req)
    assert not res["route"]["loop"]
    assert res["route"]["distance_mi"] <= pipeline.BUCKETS["10k"]["cap_mi"] * pipeline.ALIGNED_OVER_CAP


def test_too_long_for_bucket_says_so():
    req = pipeline.PlanRequest(lat=40.7410, lon=-73.9897, bucket="5k", loop=True, text="HELLO WORLD")
    with pytest.raises(pipeline.PlanError) as ex:
        pipeline.plan_run(req)
    assert "longer distance" in str(ex.value)


def test_progress_events_reach_done():
    seen = []
    req = pipeline.PlanRequest(lat=40.7410, lon=-73.9897, bucket="5k", loop=True, text="HI")
    pipeline.plan_run(req, progress=seen.append)
    assert seen[0]["pct"] < seen[-1]["pct"] == 100
    assert any(e["stage"] == "snap" for e in seen)


def test_best_fit_comes_from_the_far_scan(monkeypatch):
    """Around the pin the streets are a crooked grid; three and a half miles
    east the far scan finds a true one. The best-fit answer should come from
    there, fetched in full through the scan's own path."""
    from synthetic import grid_elements
    pin = Projection(40.7410, -73.9897)
    far_xy = (3.5 * pipeline.FT_PER_MI, 0.0)
    far_lat, far_lon = pin.to_ll(*far_xy)
    calls = []

    def fake_fetch(bbox, cache_dir=None, log=None, highways=None, **kw):
        s, w, n, e = bbox
        cy, cx = pin.to_xy((s + n) / 2.0, (w + e) / 2.0)[::-1]
        calls.append((highways, round(float(cx) / pipeline.FT_PER_MI, 1), round(float(cy) / pipeline.FT_PER_MI, 1)))
        if highways == pipeline.SCAN_CLASSES:
            # main roads everywhere, but only the far patch is a true grid
            # main roads have a node at every crossing street, so their segments are short
            els = grid_elements(pin, nx=90, ny=90, bx=800.0, by=800.0, rot_deg=23.0)
            far = grid_elements(Projection(far_lat, far_lon), nx=18, ny=18, bx=800.0, by=800.0)
            for el in far:
                el["id"] += 10_000_000
                if el["type"] == "way":
                    el["nodes"] = [i + 10_000_000 for i in el["nodes"]]
            for el in els + far:
                if el["type"] == "way":
                    el["tags"]["highway"] = "secondary"
            return els + far
        if abs(float(cx)) < 0.5 * pipeline.FT_PER_MI:
            # the first fetch: a bent grid at the pin, good enough to draw on, not great
            return grid_elements(pin, nx=48, ny=48, bx=400.0, by=300.0, rot_deg=23.0)
        # a focused fetch: a fine, true grid centred where it was asked for
        return grid_elements(Projection(*pin.to_ll(float(cx), float(cy))), nx=40, ny=40, bx=400.0, by=300.0)

    monkeypatch.setattr(pipeline, "fetch_bbox", fake_fetch)
    monkeypatch.setenv("RUNMAPPER_ELEVATION", "0")
    seen = []
    req = pipeline.PlanRequest(lat=40.7410, lon=-73.9897, bucket="5k", loop=True, text="HI")
    lines = []
    res = pipeline.plan_run(req, on_option=seen.append, log=lines.append)
    labels = [o["label"] for o in res["options"]]
    assert "best fit" in labels, (labels, calls, [ln for ln in lines if "far" in ln])
    best = next(o for o in res["options"] if o["label"] == "best fit")
    # the drawing sits in a window three miles out; its start can be on the near side of it
    assert best["route"]["from_pin_mi"] > 2.0, best["route"]["from_pin_mi"]
    assert any(h == pipeline.SCAN_CLASSES for h, _, _ in calls), calls
    assert any(h is None and (x * x + y * y) ** 0.5 >= 2.9 for h, x, y in calls), calls    # a focused fetch far out
    assert best["verdict"] in ("good", "great")
