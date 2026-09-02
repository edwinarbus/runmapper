"""Runnable ways from OpenStreetMap via the Overpass API.

One query per request box, rounded outward to a coarse grid so nearby requests
share a cache entry. Several public mirrors are tried in turn; the list can be
overridden with RUNMAPPER_OVERPASS_MIRRORS (comma separated) because some
networks can only reach some of them.
"""
import gzip
import json
import os
import queue
import threading
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


# A mirror that has not answered within this many seconds gets company: the
# next mirror is asked too, and the first answer wins. Public Overpass servers
# queue requests under load, so this turns a one-minute wait into the fastest
# mirror's time without hitting every mirror for every request.
STAGGER_S = float(os.environ.get("RUNMAPPER_OVERPASS_STAGGER", "12"))


def _race(mirror_list, q, timeout, log, stagger):
    """Ask the mirrors in order, starting the next one when the previous has
    not answered within `stagger` seconds. Returns (data, errors); data is
    None when every mirror failed."""
    results = queue.Queue()

    def worker(m):
        t0 = time.time()
        try:
            results.put((m, _post(m, q, timeout=timeout + 15), time.time() - t0, None))
        except Exception as ex:  # noqa: BLE001 - reported to the caller
            results.put((m, None, time.time() - t0, ex))

    errors = []
    started = pending = 0
    next_start = 0.0
    while True:
        if started < len(mirror_list) and (pending == 0 or time.time() >= next_start):
            threading.Thread(target=worker, args=(mirror_list[started],), daemon=True).start()
            started += 1
            pending += 1
            next_start = time.time() + stagger
        if pending == 0:
            return None, errors
        wait = max(0.05, next_start - time.time()) if started < len(mirror_list) else None
        try:
            m, d, dt, ex = results.get(timeout=wait)
        except queue.Empty:
            continue
        pending -= 1
        host = urllib.parse.urlsplit(m).netloc
        if ex is None:
            if log:
                log(f"overpass {host}: {len(d.get('elements', []))} elements in {dt:.1f}s")
            return d, errors
        errors.append(f"{host}: {type(ex).__name__}: {ex}")
        if log:
            log(f"overpass {host} failed: {type(ex).__name__} ({dt:.0f}s)")


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
        d, errs = _race(mirrors(), q, timeout, log, STAGGER_S)
        errors += errs
        if d is not None:
            els = d.get("elements", [])
            if cache_dir:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                tmp = p + ".tmp"
                with gzip.open(tmp, "wt", encoding="utf-8") as f:
                    json.dump({"elements": els}, f)
                os.replace(tmp, p)
            return els
        time.sleep(2.0)
    raise OverpassError("Could not fetch street data from any Overpass mirror: "
                        + "; ".join(errors[-3:]))
