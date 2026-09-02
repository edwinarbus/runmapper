"""Runnable ways from OpenStreetMap via the Overpass API.

One query per request box, rounded outward to a coarse grid so nearby requests
share a cache entry. Several public mirrors are tried in turn; the list can be
overridden with RUNMAPPER_OVERPASS_MIRRORS (comma separated) because some
networks can only reach some of them.
"""
import gzip
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

HIGHWAYS = ("primary|secondary|tertiary|unclassified|residential|living_street|service|"
            "pedestrian|footway|path|track|cycleway|steps|primary_link|secondary_link|"
            "tertiary_link")

DEFAULT_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

USER_AGENT = "runmapper/0.1 (https://runmapper.run; GPS-art route planning)"


class OverpassError(RuntimeError):
    pass


def mirrors():
    env = os.environ.get("RUNMAPPER_OVERPASS_MIRRORS", "").strip()
    if env:
        return [m.strip() for m in env.split(",") if m.strip()]
    return list(DEFAULT_MIRRORS)


def round_bbox(bbox, step=0.005):
    """Round a (s, w, n, e) box outward to a grid, so the cache is reusable."""
    s, w, n, e = bbox
    import math
    return (math.floor(s / step) * step, math.floor(w / step) * step,
            math.ceil(n / step) * step, math.ceil(e / step) * step)


def query_text(bbox, timeout=60):
    s, w, n, e = bbox
    return (f'[out:json][timeout:{int(timeout)}];'
            f'(way["highway"~"^({HIGHWAYS})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f}););'
            f'out body;>;out skel qt;')


def _cache_path(cache_dir, bbox):
    s, w, n, e = bbox
    return os.path.join(cache_dir, "osm", f"{s:.3f}_{w:.3f}_{n:.3f}_{e:.3f}.json.gz")


def _post(url, query, timeout):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    d = json.loads(raw)
    remark = d.get("remark", "")
    if "runtime error" in remark.lower() or "timed out" in remark.lower():
        raise OverpassError(remark)
    return d


def fetch_bbox(bbox, cache_dir=None, timeout=60, log=None, max_age_days=30):
    """Return the Overpass `elements` list (nodes + ways) for a (s, w, n, e) box."""
    bbox = round_bbox(bbox)
    if cache_dir:
        p = _cache_path(cache_dir, bbox)
        if os.path.exists(p) and (time.time() - os.path.getmtime(p)) < max_age_days * 86400:
            with gzip.open(p, "rt", encoding="utf-8") as f:
                return json.load(f)["elements"]
    q = query_text(bbox, timeout=timeout)
    errors = []
    for attempt in range(2):
        for m in mirrors():
            t0 = time.time()
            try:
                d = _post(m, q, timeout=timeout + 15)
                els = d.get("elements", [])
                if log:
                    log(f"overpass {urllib.parse.urlsplit(m).netloc}: "
                        f"{len(els)} elements in {time.time() - t0:.1f}s")
                if cache_dir:
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    tmp = p + ".tmp"
                    with gzip.open(tmp, "wt", encoding="utf-8") as f:
                        json.dump({"elements": els}, f)
                    os.replace(tmp, p)
                return els
            except Exception as ex:  # noqa: BLE001 - any mirror failure means try the next
                errors.append(f"{urllib.parse.urlsplit(m).netloc}: {type(ex).__name__}: {ex}")
                if log:
                    log(f"overpass {urllib.parse.urlsplit(m).netloc} failed: "
                        f"{type(ex).__name__} ({time.time() - t0:.0f}s)")
        time.sleep(2.0)
    raise OverpassError("Could not fetch street data from any Overpass mirror: "
                        + "; ".join(errors[-3:]))
