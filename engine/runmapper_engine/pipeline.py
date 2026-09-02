"""End to end: a phrase or picture + a spot on the map -> a runnable route.

    request -> strokes -> sizes from the distance bucket -> streets around the
    pin -> placement scan -> snap the best few -> pick -> finish (elevation,
    GPX, cues) -> verdict
"""
import math
import os
import time
from dataclasses import dataclass, field

import numpy as np

from . import font, image as img, svgin
from .build import assemble, path_len_ft, route_latlon, route_xy, snap_strokes
from .cues import best_start, cue_sheet, describe_point
from .elevation import grade_stats, profile, query as elev_query
from .geo import FT_PER_MI, Projection, haversine_segments_ft
from .gpx import dedupe, gpx_string
from .graph import GRID_CLASSES, StreetGraph
from .osm import fetch_bbox
from .place import dedupe as dedupe_places, refine, scan
from .snap import Snapper
from .strokes import connector_estimate, ink_length, order_greedy
from .vismatch import vis_match

BUCKETS = {
    "5k": dict(cap_mi=3.6, label="~5K", target_mi=3.1),
    "10k": dict(cap_mi=6.8, label="~10K", target_mi=6.2),
    "long": dict(cap_mi=13.5, label="Longer", target_mi=10.0),
}
INFLATION = 1.22          # snapped length / ideal length, free placement
INFLATION_ALIGNED = 1.12  # same, when letters sit on the block grid
UNIT_MIN_FT = 230.0       # smallest font unit that still reads after GPS wobble
LOGO_MIN_WIDTH_FT = 1900.0
THICK_MIN_FT = 300.0      # two edges closer than this land on the same street
VERDICTS = [(0.66, "great"), (0.50, "good"), (0.36, "rough")]
IRREGULAR_STREETS = 0.60        # grid regularity below this caps the verdict at "good"
VERY_IRREGULAR_STREETS = 0.50   # ...and below this at "rough"
MAX_SNAPS = 5
TIME_BUDGET_S = 90.0
PLACE_CLASSES = GRID_CLASSES | {"cycleway"}   # streets that count when judging a placement
DIAGONAL_GLYPHS = set("KNQRVXYZ07")           # glyphs with slanted strokes


@dataclass
class PlanRequest:
    lat: float
    lon: float
    bucket: str = "10k"
    loop: bool = True
    text: str | None = None
    image_bytes: bytes | None = None
    image_name: str = ""
    name: str = ""
    extra: dict = field(default_factory=dict)


class PlanError(ValueError):
    """A request that cannot work, with a message meant for the user."""


def _progress(cb, stage, pct, msg):
    if cb:
        cb(dict(stage=stage, pct=int(pct), msg=msg))


# ------------------------------------------------------------------ strokes

def prepare_text(text, loop):
    strokes, lay = font.text_strokes(text, loop=loop)
    unit_norm = 1.0 / lay["scale_units_per_norm"]          # normalised size of one font unit
    return dict(kind="text", strokes=strokes, label=lay["text"],
                ink_norm=lay["walk_units"] * unit_norm,
                conn_norm=lay["return_units"] * unit_norm,
                min_width_ft=UNIT_MIN_FT * lay["scale_units_per_norm"],
                units_per_width=lay["scale_units_per_norm"], layout=lay)


def prepare_image(data, name, loop):
    head = data[:2000].lower()
    is_svg = name.lower().endswith(".svg") or b"<svg" in head
    reps = []
    if is_svg:
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception as ex:  # noqa: BLE001
            raise PlanError("Couldn't read that SVG.") from ex
        try:
            strokes, mask, line_art = svgin.svg_strokes(text)
        except svgin.SVGError as ex:
            raise PlanError(str(ex)) from ex
        if line_art:
            reps.append(dict(kind="center", strokes=order_greedy(strokes), thick=0.0))
        else:
            reps.append(dict(kind="outline", strokes=order_greedy(strokes), thick=img.thickness(mask)))
            try:
                reps.append(dict(kind="center", strokes=order_greedy(img.centerline_strokes(mask)),
                                 thick=reps[0]["thick"]))
            except Exception:  # noqa: BLE001 - the outline alone is fine
                pass
    else:
        try:
            mask = img.load_mask(data)
            th = img.thickness(mask)
            reps.append(dict(kind="outline", strokes=order_greedy(img.outline_strokes(mask)), thick=th))
        except img.ImageError as ex:
            raise PlanError(str(ex)) from ex
        try:
            reps.append(dict(kind="center", strokes=order_greedy(img.centerline_strokes(mask)), thick=th))
        except Exception:  # noqa: BLE001
            pass
    out = []
    for r in reps:
        strokes = r["strokes"]
        if len(strokes) > 14:
            strokes = sorted(strokes, key=lambda s: -s.length)[:14]
            strokes = order_greedy(strokes)
        ink = ink_length(strokes)
        conn = connector_estimate(strokes, loop=loop) * 1.3
        feat = img.feature_size(strokes)
        if r["kind"] == "outline":
            min_w = max(LOGO_MIN_WIDTH_FT, THICK_MIN_FT / max(r["thick"], 1e-3))
        else:
            min_w = max(LOGO_MIN_WIDTH_FT, 250.0 / max(feat, 1e-3))
        out.append(dict(kind=r["kind"], strokes=strokes, ink_norm=ink, conn_norm=conn,
                        min_width_ft=min_w, thick=r["thick"], feature=feat, label=name or "image"))
    return out


def size_for(rep, cap_ft):
    """Largest drawing width the distance cap allows for this stroke set."""
    per_width = (rep["ink_norm"] + rep["conn_norm"]) * INFLATION
    return cap_ft / max(per_width, 1e-9)


def text_size_candidates(rep, cap_ft, g, r0, regularity, log=None):
    """Sizes to try for text: letters stretched onto the block grid (two
    blocks wide, two tall, with the middle bar on the street between) at a few
    multiples, plus a free-floating fallback."""
    lay = rep["layout"]
    upn = rep["units_per_width"]
    wx, wy = lay["walk_xy"]
    rx, ry = lay["return_xy"]
    out = []
    bs = g.block_spacing(90.0 - r0)
    dx, dy = bs["spacing_along"], bs["spacing_across"]
    if log:
        log(f"  grid rot={r0:+.1f} regularity={regularity:.2f} block along={dx} across={dy} "
            f"conf={bs['conf_along']:.2f}/{bs['conf_across']:.2f}")
    # Diagonal strokes staircase on a grid; at two blocks per letter a single
    # step is all they get and an N turns into a hump. Those letters need
    # three blocks each way.
    k_min = 2 if any(ch in DIAGONAL_GLYPHS for ch in lay["text"]) else 1
    rep["k_min"] = k_min
    if regularity >= 0.45 and dx and dy and bs["conf_along"] >= 0.15 and bs["conf_across"] >= 0.15:
        aligned = []
        # Whole blocks only: a letter's middle column (x = 1 unit) and middle
        # bar (y = 1.5 units) must land on streets, so the horizontal unit is
        # kx blocks and the vertical unit two thirds of ky blocks.
        for kx in (4, 3, 2, 1):
            ux = kx * dx
            if ux < UNIT_MIN_FT * 0.9 or kx < k_min:
                continue
            for ky in (1, 2, 3, 4, 5, 6):
                uy = (2.0 / 3.0) * ky * dy
                aspect = uy / ux
                if uy < UNIT_MIN_FT * 0.55 or ky < k_min or not (0.6 <= aspect <= 1.5):
                    continue
                est = ((wx + rx) * ux + (wy + ry) * uy) * INFLATION_ALIGNED
                if est <= cap_ft:
                    aligned.append(dict(width_ft=ux * upn, aspect=aspect, rots=[round(r0, 1)],
                                        kind="aligned", kx=kx, ky=ky, unit_ft=min(ux, uy),
                                        ux=ux, uy=uy, est_ft=est, area=ux * uy,
                                        shape=abs(math.log(aspect / 0.9))))
        aligned.sort(key=lambda s: (-s["area"], s["shape"]))
        seen = set()
        for s in aligned:
            key = (s["kx"], s["ky"])
            if key in seen:
                continue
            seen.add(key)
            out.append(s)
            if len(out) >= 2:
                break
    wmax = min(rep["width_max_ft"], 2.4 * FT_PER_MI)
    rots = {round(r0, 1), 0.0}
    if abs(r0) > 6.0:
        rots.add(round(r0 / 2.0, 1))
    rots = sorted(rots, key=abs)
    for f in (1.0, 0.82):
        if wmax * f >= rep["min_width_ft"]:
            unit = wmax * f / upn
            sz = dict(width_ft=wmax * f, aspect=1.0, rots=rots, kind="free", unit_ft=unit, est_ft=None)
            # Small letters that float free on a regular grid get squared off
            # by it; never call that better than rough.
            if regularity >= 0.45 and dx and dy and unit < 0.9 * k_min * min(dx, dy):
                sz["max_verdict"] = "rough"
            out.append(sz)
        if len([o for o in out if o["kind"] == "free"]) >= (1 if len(out) > 1 else 2):
            break
    return out


def image_size_candidates(rep, cap_ft, r0):
    wmax = min(rep["width_max_ft"], 2.4 * FT_PER_MI)
    rots = {round(r0, 1), 0.0}
    if abs(r0) > 6.0:
        rots.add(round(r0 / 2.0, 1))
    rots = sorted(rots, key=abs)
    out = []
    for f in (1.0, 0.86, 0.74):
        if wmax * f >= rep["min_width_ft"] or not out:
            out.append(dict(width_ft=wmax * f, aspect=1.0, rots=rots, kind="free", est_ft=None))
    return out


# ------------------------------------------------------------------ verdict

def verdict_for(iou):
    for thr, name in VERDICTS:
        if iou >= thr:
            return name
    return "bad"


def _message(v):
    if v == "great":
        return "Nice. Run this and the line will read clearly."
    if v == "good":
        return "Good match. A few corners get squared off by the streets, but it reads."
    if v == "rough":
        return ("It's recognisable but rough here. A denser street grid nearby, or a "
                "longer distance so it can be drawn bigger, would sharpen it.")
    return ("Hm, the streets here don't line up with that shape. Try a different "
            "location, a shorter phrase, or a simpler image.")


def match_tolerance(width_ft):
    """How far off the line still counts as 'on it': GPS wobble plus a share
    of the drawing size, since a bigger drawing forgives a bigger detour."""
    return float(np.clip(0.04 * width_ft, 65.0, 110.0))


# ------------------------------------------------------------------ main

def plan_run(req: PlanRequest, progress=None, cache_dir=None, log=None):
    t_start = time.time()
    bucket = BUCKETS.get(req.bucket)
    if bucket is None:
        raise PlanError("Pick a distance: 5k, 10k or long.")
    cap_ft = bucket["cap_mi"] * FT_PER_MI

    _progress(progress, "strokes", 3, "Reading the shape")
    if req.text:
        try:
            reps = [prepare_text(req.text, req.loop)]
        except font.FontError as ex:
            raise PlanError(str(ex)) from ex
    elif req.image_bytes:
        reps = prepare_image(req.image_bytes, req.image_name, req.loop)
    else:
        raise PlanError("Type a phrase or upload an image.")

    # Which representation, and does it fit the distance at a readable size?
    for rep in reps:
        rep["width_max_ft"] = size_for(rep, cap_ft)
        rep["fits"] = rep["width_max_ft"] >= rep["min_width_ft"]
    fitting = [r for r in reps if r["fits"]]
    if not fitting:
        rep = max(reps, key=lambda r: r["width_max_ft"] / r["min_width_ft"])
        need_mi = rep["min_width_ft"] * (rep["ink_norm"] + rep["conn_norm"]) * INFLATION / FT_PER_MI
        if req.text:
            raise PlanError(
                f"“{rep['label']}” needs about {need_mi:.1f} mi to stay readable, more than the "
                f"{bucket['label']} option allows. Pick a longer distance or a shorter phrase.")
        raise PlanError(
            f"That image needs about {need_mi:.1f} mi to keep its detail, more than the "
            f"{bucket['label']} option allows. Pick a longer distance or a simpler image.")
    choice = fitting[0]
    if len(fitting) > 1 and choice["kind"] == "outline":
        # a thin mark reads better as a single line even when the outline "fits"
        if choice["thick"] * choice["width_max_ft"] < THICK_MIN_FT * 1.15:
            choice = fitting[1]
    strokes = choice["strokes"]
    width_max = min(choice["width_max_ft"], 2.4 * FT_PER_MI)
    allp = np.vstack([s.pts for s in strokes])
    aspect0 = float((allp[:, 1].max() - allp[:, 1].min()) / max(allp[:, 0].max() - allp[:, 0].min(), 1e-9))

    # Streets around the pin.
    _progress(progress, "streets", 10, "Fetching the streets around your spot")
    proj = Projection(req.lat, req.lon)
    half_x = 0.62 * width_max + 1300.0
    half_y = 0.62 * width_max * max(aspect0, 0.35) + 1300.0
    bbox = proj.bbox_around(half_x, half_y)
    els = fetch_bbox(bbox, cache_dir=cache_dir, log=log)
    g = StreetGraph.from_elements(els, proj)
    if len(g.ids) < 150 or g.keep.sum() < 100:
        raise PlanError("There aren't enough runnable streets here to draw on. "
                        "Try a spot in a town or city.")
    _progress(progress, "streets", 22, f"{int(g.keep.sum()):,} street corners loaded")
    P, tree = g.densify(step=45.0, classes=PLACE_CLASSES)
    if tree is None or len(P) < 200:
        P, tree = g.densify(step=45.0)
    if tree is None:
        raise PlanError("There aren't enough streets here to draw on.")
    gb = g.grid_bearing()
    r0 = (90.0 - gb["bearing"]) % 90.0
    if r0 > 45.0:
        r0 -= 90.0

    # Sizes to try.
    if choice["kind"] == "text":
        sizes = text_size_candidates(choice, cap_ft, g, r0, gb["regularity"], log=log)
    else:
        sizes = image_size_candidates(choice, cap_ft, r0)
    if gb["regularity"] < IRREGULAR_STREETS:
        # Wandering streets never trace a shape crisply; don't promise more.
        cap_v = "rough" if gb["regularity"] < VERY_IRREGULAR_STREETS else "good"
        for sz in sizes:
            if sz.get("max_verdict") != "rough":
                sz["max_verdict"] = cap_v

    # Placement scan.
    _progress(progress, "place", 28, "Trying placements")
    picks = []
    for sz in sizes:
        w = sz["width_ft"]
        if sz["kind"] == "aligned":
            radius = 1.3 * max(sz["ux"], sz["uy"]) + 200.0
            grid = max(50.0, sz["unit_ft"] / 6.0)
        else:
            # look up to a third of a mile around the pin for better streets
            radius = max(0.30 * w, 1600.0)
            grid = max(120.0, w / 14.0)
        cands = scan(strokes, tree, (0.0, 0.0), [w], sz["rots"], radius, grid_ft=grid, aspect=sz["aspect"])
        for c in cands:
            c["score"] *= 1.0 + 0.12 * abs(c["rot"]) / 45.0
            c["size"] = sz
        cands.sort(key=lambda c: c["score"])
        cands = dedupe_places(cands, min_sep_ft=0.15 * w)
        take = 2 if sz["kind"] == "aligned" else 1
        for c in cands[:take]:
            picks.append(c)
    if not picks:
        raise PlanError("The streets here don't line up with that shape at all. "
                        "Try a different location or a simpler drawing.")
    refined = []
    for c in picks[:MAX_SNAPS + 1]:
        sz = c["size"]
        wb = (c["width_ft"] * (0.99 if sz["kind"] == "aligned" else 0.94),
              c["width_ft"] * (1.01 if sz["kind"] == "aligned" else 1.04))
        rb = (min(sz["rots"]) - 2.0, max(sz["rots"]) + 2.0)
        r = refine(strokes, tree, c, wb, rb, rounds=2, dxy=(-60.0, 0.0, 60.0) if sz["kind"] == "aligned" else (-90.0, 0.0, 90.0))
        r["size"] = sz
        refined.append(r)
    picks = dedupe_places(refined, min_sep_ft=120.0)

    # Snap.
    sn = Snapper(g)
    results = []
    n_done = 0
    debug_dir = os.environ.get("RUNMAPPER_DEBUG_DIR")
    for i, c in enumerate(picks[:MAX_SNAPS]):
        if time.time() - t_start > TIME_BUDGET_S and results:
            break
        _progress(progress, "snap", 40 + int(45 * i / max(len(picks), 1)),
                  f"Snapping to streets ({i + 1} of {min(len(picks), MAX_SNAPS)})")
        t0 = time.time()
        r = _snap_one(sn, g, strokes, c, choice, req.loop, cap_ft)
        n_done += 1
        if r is None:
            continue
        r["snap_s"] = time.time() - t0
        if log:
            log(f"  {c['size']['kind']:7s} w={c['width_ft'] / FT_PER_MI:.2f}mi rot={c['rot']:+.1f} "
                f"aspect={c.get('aspect', 1.0):.2f} dist={r['dist_mi']:.2f}mi iou={r['iou']:.2f} "
                f"({r['snap_s']:.1f}s)")
        if debug_dir:
            from .preview import preview_png
            os.makedirs(debug_dir, exist_ok=True)
            preview_png(os.path.join(debug_dir, f"cand{i}_{c['size']['kind']}_w{c['width_ft'] / FT_PER_MI:.2f}.png"),
                        g, r["nodes"], r["ideal"],
                        title=f"{choice['label']} {c['size']['kind']} w={c['width_ft'] / FT_PER_MI:.2f} "
                              f"aspect={c.get('aspect', 1.0):.2f} dist={r['dist_mi']:.2f} iou={r['iou']:.2f}")
        results.append(r)
        if r["fits"] and r["iou"] >= 0.60 and c["size"]["kind"] == "aligned":
            break
    if not results:
        raise PlanError("Couldn't route that shape onto these streets. Try a different spot.")
    fits = [r for r in results if r["fits"]]
    if not fits:
        best = max(results, key=lambda r: r["iou"])
        f = cap_ft / (best["dist_ft"] * 1.04)
        c = dict(best["cand"])
        c["width_ft"] = max(c["width_ft"] * f, choice["min_width_ft"] * 0.9)
        _progress(progress, "snap", 86, "Shrinking to fit the distance")
        r = _snap_one(sn, g, strokes, c, choice, req.loop, cap_ft)
        if r is not None:
            results.append(r)
            if r["fits"]:
                fits = [r]
    pool = fits if fits else results

    def rank(r):
        v = verdict_for(r["iou"])
        cap_v = r["cand"].get("size", {}).get("max_verdict")
        order = ["bad", "rough", "good", "great"]
        if cap_v and order.index(v) > order.index(cap_v):
            v = cap_v
        return (order.index(v), round(r["iou"], 2), r["cand"]["width_ft"])

    best = max(pool, key=rank)

    _progress(progress, "finish", 90, "Measuring distance and climb")
    out = _finish(g, proj, best, choice, req, bucket, strokes)
    out["timing"] = dict(total_s=round(time.time() - t_start, 1), snaps=n_done,
                         dijkstra=sn.n_dijkstra, nodes=int(len(g.ids)))
    out["grid"] = dict(bearing=round(gb["bearing"], 1), regularity=round(gb["regularity"], 2),
                       rot=best["cand"]["rot"], aspect=round(best["cand"].get("aspect", 1.0), 3),
                       size_kind=best["cand"]["size"]["kind"])
    _progress(progress, "done", 100, "Done")
    return out


def _snap_params(choice, cand):
    w = cand["width_ft"]
    if choice["kind"] == "text":
        unit = cand["size"].get("unit_ft") or (w / choice["units_per_width"])
        return dict(corridor=float(np.clip(2.2 * unit, 450, 1000)),
                    dev_ref=float(np.clip(0.55 * unit, 120, 300)), w_dev=9.0,
                    radius=float(np.clip(1.3 * unit, 300, 600)))
    return dict(corridor=float(np.clip(0.20 * w, 500, 1000)),
                dev_ref=float(np.clip(0.06 * w, 130, 300)), w_dev=9.0, radius=450.0)


def _snap_one(sn, g, strokes, cand, choice, loop, cap_ft):
    center = np.array([cand["cx"], cand["cy"]])
    kw = _snap_params(choice, cand)
    snapped = snap_strokes(sn, strokes, center, cand["width_ft"], cand["rot"],
                           aspect=cand.get("aspect", 1.0), k=3, **kw)
    if snapped is None:
        return None
    a = assemble(sn, snapped, close_loop=loop, try_orders=(len(snapped) <= 4))
    if a is None:
        return None
    full, connlen = a
    dist_ft = path_len_ft(g, full) * 1.003
    ideal = [s["ideal"] for s in snapped]
    v = vis_match(route_xy(g, full), ideal, tol_ft=match_tolerance(cand["width_ft"]))
    return dict(cand=cand, nodes=full, snapped=snapped, ideal=ideal, dist_ft=dist_ft,
                dist_mi=dist_ft / FT_PER_MI, fits=dist_ft <= cap_ft * 1.02,
                iou=v["iou"], cover=v["cover"], prec=v["prec"], connlen=connlen)


def _finish(g, proj, best, choice, req, bucket, strokes):
    nodes = best["nodes"]
    if req.loop and nodes[0] == nodes[-1]:
        px, py = proj.to_xy(req.lat, req.lon)
        nodes = best_start(g, nodes, prefer_xy=(float(px), float(py)))
    latlon = route_latlon(g, nodes)
    xy = route_xy(g, nodes)
    keep = dedupe(latlon, (xy[:, 0], xy[:, 1]), min_ft=6.0)
    ll = latlon[keep]
    X, Y = xy[keep, 0], xy[keep, 1]
    seg = haversine_segments_ft(ll)
    cum = np.r_[0.0, np.cumsum(seg)]
    dist_mi = float(cum[-1] / FT_PER_MI)

    spacing = max(100.0, cum[-1] / 280.0)
    want = np.arange(0, cum[-1], spacing)
    idx = np.unique(np.searchsorted(cum, want).clip(0, len(ll) - 1))
    z_s = elev_query(ll[idx], max_calls=3)
    if np.isnan(z_s).all():
        ele = np.full(len(ll), np.nan)
    else:
        okz = ~np.isnan(z_s)
        ele = np.interp(cum, cum[idx][okz], z_s[okz])
    prof = profile(ele, (X, Y))
    gr = grade_stats(X, Y, prof["ele"]) if prof["gain"] is not None else dict(max_up=None, max_down=None)

    cues = cue_sheet(g, nodes)
    start = describe_point(g, nodes[0])
    iou = best["iou"]
    v = verdict_for(iou)
    order = ["bad", "rough", "good", "great"]
    cap_v = best["cand"].get("size", {}).get("max_verdict")
    if cap_v and order.index(v) > order.index(cap_v):
        v = cap_v
    if not best["fits"]:
        v = "over"
    label = choice["label"]
    name = req.name or (f"runmapper: {label}" if choice["kind"] == "text" else "runmapper route")
    desc = f"{dist_mi:.2f} mi"
    if prof["gain"] is not None:
        desc += f", {prof['gain']:.0f} ft gain"
    desc += ". Made with runmapper.run"
    ideal_ll = []
    for poly in best["ideal"]:
        la, lo = proj.to_ll(poly[:, 0], poly[:, 1])
        ideal_ll.append(np.c_[la, lo].round(6).tolist())
    b0 = math.degrees(math.atan2(X[1] - X[0], Y[1] - Y[0])) % 360.0 if len(X) > 1 else 0.0
    msg = _message(v) if v != "over" else (
        f"Best attempt is {dist_mi:.1f} mi, over the {bucket['label']} limit. Pick a longer distance.")
    return dict(
        ok=v in ("great", "good", "rough"),
        verdict=v, message=msg,
        score=dict(iou=round(iou, 3), cover=round(best["cover"], 3), prec=round(best["prec"], 3)),
        route=dict(coords=ll.round(6).tolist(), distance_mi=round(dist_mi, 2),
                   distance_km=round(dist_mi * 1.609344, 2),
                   gain_ft=None if prof["gain"] is None else round(prof["gain"]),
                   gain_m=None if prof["gain"] is None else round(prof["gain"] / 3.280839895),
                   loss_ft=None if prof["loss"] is None else round(prof["loss"]),
                   max_grade_pct=None if gr["max_up"] is None else round(gr["max_up"], 1),
                   loop=bool(req.loop and nodes[0] == nodes[-1]),
                   start=[round(float(ll[0, 0]), 6), round(float(ll[0, 1]), 6)],
                   start_desc=start, start_bearing=round(b0),
                   width_mi=round(best["cand"]["width_ft"] / FT_PER_MI, 2),
                   n_points=int(len(ll))),
        drawing=dict(kind=choice["kind"], label=label, strokes=len(strokes), ideal=ideal_ll),
        bucket=dict(key=req.bucket, label=bucket["label"], cap_mi=bucket["cap_mi"]),
        cues=cues,
        gpx=gpx_string(ll, prof["ele"] if prof["gain"] is not None else None, name=name, desc=desc),
        name=name,
        # private handles for the CLI preview; the API strips keys starting with "_"
        _graph=g, _nodes=nodes, _ideal=best["ideal"],
    )
