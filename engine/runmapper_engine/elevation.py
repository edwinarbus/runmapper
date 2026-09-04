"""Elevation along a finished route, worldwide, best effort.

Uses the public opentopodata API with a dataset fallback chain (USGS 10 m in
the US, EU-DEM 25 m in Europe, SRTM 30 m elsewhere). The public instance
allows 100 points per call at one call per second, so a route is sampled at a
spacing that keeps it to a handful of calls. Any failure returns NaNs and the
route simply ships without elevation.
"""
import json
import os
import time
import urllib.parse
import urllib.request

import numpy as np

from .geo import FT_PER_M

URL = os.environ.get("RUNMAPPER_ELEVATION_URL",
                     "https://api.opentopodata.org/v1/ned10m,eudem25m,srtm30m")
USER_AGENT = "runmapper/0.1 (https://runmapper.run)"


def enabled():
    return os.environ.get("RUNMAPPER_ELEVATION", "1") not in ("0", "false", "no")


def query(latlon, batch=100, pause=1.05, max_calls=4, timeout=8):
    """Elevation in feet for each (lat, lon); NaN where unavailable. Bounded:
    a slow or failing service costs a plan a few seconds, never a minute."""
    z = np.full(len(latlon), np.nan)
    if not enabled() or len(latlon) == 0:
        return z
    calls = 0
    for i in range(0, len(latlon), batch):
        if calls >= max_calls:
            break
        ch = latlon[i:i + batch]
        body = urllib.parse.urlencode(
            {"locations": "|".join(f"{a:.6f},{b:.6f}" for a, b in ch)}).encode()
        for attempt in range(2):
            try:
                req = urllib.request.Request(URL, data=body, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    d = json.loads(r.read())
                if d.get("status") == "OK":
                    for k, res in enumerate(d["results"]):
                        e = res.get("elevation")
                        if e is not None:
                            z[i + k] = e
                    break
                time.sleep(1.5 + attempt)
            except Exception:  # noqa: BLE001 - elevation is optional
                time.sleep(1.5 + attempt)
        calls += 1
        if i + batch < len(latlon):
            time.sleep(pause)
    return z * FT_PER_M


def profile(ele_ft, xy, resample_ft=80.0, smooth_ft=400.0):
    """Gain/loss the way a GPS watch reports it: resample the profile at a fixed
    spacing, smooth over a few hundred feet, then sum the rises.

    Summing raw sample-to-sample deltas on densely spaced points mostly adds up
    DEM noise; smoothing first is what keeps the number honest.
    """
    e = np.asarray(ele_ft, float)
    ok = ~np.isnan(e)
    if ok.sum() < 2:
        return dict(gain=None, loss=None, lo=None, hi=None, ele=e)
    e = np.interp(np.arange(len(e)), np.flatnonzero(ok), e[ok])
    X, Y = xy
    d = np.r_[0.0, np.cumsum(np.hypot(np.diff(X), np.diff(Y)))]
    if d[-1] <= 0:
        return dict(gain=0.0, loss=0.0, lo=float(e.min()), hi=float(e.max()), ele=e)
    grid = np.arange(0.0, d[-1], resample_ft)
    eg = np.interp(grid, d, e)
    w = max(3, int(round(smooth_ft / resample_ft)) | 1)
    if len(eg) > w:
        k = np.ones(w) / w
        pad = np.r_[np.full(w, eg[0]), eg, np.full(w, eg[-1])]
        eg = np.convolve(pad, k, mode="same")[w:-w]
    dz = np.diff(eg)
    return dict(gain=float(np.sum(np.clip(dz, 0, None))),
                loss=float(-np.sum(np.clip(dz, None, 0))),
                lo=float(e.min()), hi=float(e.max()), ele=e)


def grade_stats(x_ft, y_ft, ele_ft, win_ft=300.0):
    """Steepest sustained grade over ~300 ft windows, in percent."""
    e = np.asarray(ele_ft, float)
    if np.isnan(e).all():
        return dict(max_up=None, max_down=None)
    ok = ~np.isnan(e)
    e = np.interp(np.arange(len(e)), np.flatnonzero(ok), e[ok])
    d = np.r_[0.0, np.cumsum(np.hypot(np.diff(x_ft), np.diff(y_ft)))]
    g = []
    j = 0
    for i in range(len(d)):
        while j < len(d) - 1 and d[j] - d[i] < win_ft:
            j += 1
        if d[j] - d[i] >= win_ft * 0.8:
            g.append((e[j] - e[i]) / (d[j] - d[i]) * 100.0)
    g = np.array(g) if g else np.array([0.0])
    return dict(max_up=float(g.max()), max_down=float(g.min()))
