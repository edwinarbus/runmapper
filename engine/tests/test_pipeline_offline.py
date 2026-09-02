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
        return grid_elements(Projection(37.77, -122.44), nx=48, ny=48, bx=400.0, by=300.0)

    monkeypatch.setattr(pipeline, "fetch_bbox", fake_fetch)
    monkeypatch.setenv("RUNMAPPER_ELEVATION", "0")


def test_hello_10k_is_a_clean_loop():
    req = pipeline.PlanRequest(lat=37.77, lon=-122.44, bucket="10k", loop=True, text="hello")
    res = pipeline.plan_run(req)
    r = res["route"]
    assert res["verdict"] == "great"
    assert res["score"]["iou"] > 0.8
    assert r["loop"] and r["coords"][0] == r["coords"][-1]
    assert r["distance_mi"] <= pipeline.BUCKETS["10k"]["cap_mi"] * 1.02
    assert res["grid"]["size_kind"] == "aligned"
    assert res["gpx"].startswith("<?xml") and "<trkpt" in res["gpx"]
    assert len(res["cues"]) > 5
    assert res["drawing"]["label"] == "HELLO"


def test_open_route_when_loop_off():
    req = pipeline.PlanRequest(lat=37.77, lon=-122.44, bucket="10k", loop=False, text="HELLO")
    res = pipeline.plan_run(req)
    assert not res["route"]["loop"]
    assert res["route"]["distance_mi"] < 6.0


def test_too_long_for_bucket_says_so():
    req = pipeline.PlanRequest(lat=37.77, lon=-122.44, bucket="5k", loop=True, text="HELLO WORLD")
    with pytest.raises(pipeline.PlanError) as ex:
        pipeline.plan_run(req)
    assert "longer distance" in str(ex.value)


def test_progress_events_reach_done():
    seen = []
    req = pipeline.PlanRequest(lat=37.77, lon=-122.44, bucket="5k", loop=True, text="HI")
    pipeline.plan_run(req, progress=seen.append)
    assert seen[0]["pct"] < seen[-1]["pct"] == 100
    assert any(e["stage"] == "snap" for e in seen)
