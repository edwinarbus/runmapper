"""End to end: a phrase or picture + a spot on the map -> a runnable route.

    request -> strokes -> sizes from the distance bucket -> streets around the
    pin -> placement scan -> snap the best few -> pick -> finish (elevation,
    GPX, cues) -> verdict

Text gets special treatment. Once the local block spacing is known, every
letter is laid on the block lattice (two blocks wide, two tall, middle bar on
the street between), diagonals are pre-staircased on that lattice, and the
snap runs on street centrelines only. That is what makes a word read as a
word on a map; free-floating letters smaller than the blocks never do.
"""
import math
import os
import time
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from . import font, image as img, svgin
from .build import assemble, path_len_ft, route_latlon, route_xy, snap_polys, snap_strokes
from .cues import best_start, cue_sheet, describe_point
from .elevation import grade_stats, profile, query as elev_query
from .geo import FT_PER_MI, Projection, haversine_segments_ft
from .gpx import dedupe, gpx_string
from .graph import GRID_CLASSES, StreetGraph
from .osm import fetch_bbox
from .place import dedupe as dedupe_places, refine, scan, transform
from .snap import Snapper
from .strokes import Stroke, connector_estimate, ink_length, order_greedy
from .vismatch import vis_match

BUCKETS = {
    "5k": dict(cap_mi=3.6, label="~5K", target_mi=3.1),
    "10k": dict(cap_mi=6.8, label="~10K", target_mi=6.2),
    "long": dict(cap_mi=13.5, label="Longer", target_mi=10.0),
}
BUCKET_ORDER = ["5k", "10k", "long"]
INFLATION = 1.22          # snapped length / ideal length, free placement
INFLATION_ALIGNED = 1.08  # same, letters on the block lattice (paths are near exact)
ALIGNED_OVER_CAP = 1.08   # lattice text may run this much over the bucket cap
UNIT_MIN_FT = 230.0       # smallest font unit that still reads after GPS wobble
LOGO_MIN_WIDTH_FT = 1900.0
THICK_MIN_FT = 300.0      # two edges closer than this land on the same street
VERDICTS = [(0.66, "great"), (0.50, "good"), (0.36, "rough")]
IRREGULAR_STREETS = 0.60        # grid regularity below this caps the verdict at "good"
VERY_IRREGULAR_STREETS = 0.50   # ...and below this at "rough"
LATTICE_MIN_REGULARITY = 0.45   # below this there is no grid to lay letters on
FREE_TEXT_MIN_BLOCKS = 1.6      # free-floating letters narrower than this many blocks are mush
MAX_SNAPS = 5
TIME_BUDGET_S = 90.0
PLACE_CLASSES = GRID_CLASSES | {"cycleway"}     # streets that count when judging a placement
STREET_CLASSES = GRID_CLASSES | {"cycleway"}    # what lattice text is routed on


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
    """A request that cannot work, with a message meant for the user and,
    when a bigger distance would fix it, which bucket to suggest."""

    def __init__(self, message, suggest=None):
        super().__init__(message)
        self.suggest = suggest


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


# ------------------------------------------------------------------ text sizes

def _lattice_layout(rep, kx, ky, dx, dy, loop):
    """The phrase on a block lattice: staircased points, a normalised stroke,
    and the exact Manhattan length of the run in feet."""
    lay = rep["layout"]
    ux, uy = kx * dx, (2.0 / 3.0) * ky * dy         # feet per font unit, x and y
    P = font.staircase(lay["points"], kx, ky)
    d = np.abs(np.diff(P, axis=0))
    walk_ft = float(d[:, 0].sum() * ux + d[:, 1].sum() * uy)
    switches = sum(1 for a, b in zip(lay["sides"][:-1], lay["sides"][1:]) if a != b)
    ret_ft = (lay["units_wide"] * ux + font.H * uy * (1 + switches)) if loop else 0.0
    lo, hi = P.min(0), P.max(0)
    ctr = (lo + hi) / 2.0
    scale = float(max(hi[0] - lo[0], hi[1] - lo[1])) or 1.0
    stroke = Stroke((P - ctr) / scale, name=f"text:{lay['text']}", closed=False, kind="text")
    return dict(strokes=[stroke], width_ft=ux * scale, aspect=uy / ux, ux=ux, uy=uy, kx=kx, ky=ky,
                unit_ft=min(ux, uy), est_ft=(walk_ft + ret_ft) * INFLATION_ALIGNED,
                units_per_width=scale, area=ux * uy, shape=abs(math.log((uy / ux) / 0.9)))


def text_size_candidates(rep, cap_ft, g, r0, regularity, loop, log=None):
    """Sizes to try for text: letters on the block lattice at whole-block
    multiples (biggest first), plus a free-floating fallback only where the
    letters would still span well over a block. Returns (sizes, need_ft) where
    need_ft is the smallest lattice layout's length, for the suggestion when
    nothing fits."""
    out = []
    bs = g.block_spacing(90.0 - r0)
    dx, dy = bs["spacing_along"], bs["spacing_across"]
    has_grid = (regularity >= LATTICE_MIN_REGULARITY and dx and dy
                and bs["conf_along"] >= 0.15 and bs["conf_across"] >= 0.15)
    if log:
        log(f"  grid rot={r0:+.1f} regularity={regularity:.2f} block along={dx} across={dy} "
            f"conf={bs['conf_along']:.2f}/{bs['conf_across']:.2f} lattice={has_grid}")
    need_ft = None
    if has_grid:
        aligned = []
        # Two ways to lay the word on the grid: along the axis nearest east-west
        # (reads level) or along the other one (reads tilted, but on long
        # rectangular blocks like Manhattan's it is the only way the letters'
        # stems land on streets). The tilted one carries a ranking penalty.
        r90 = r0 + 90.0 if r0 <= 0 else r0 - 90.0
        for rot, ddx, ddy, orient_pen in ((r0, dx, dy, 1.0), (r90, dy, dx, 0.6)):
            # Whole blocks only: a letter's middle column (x = 1 unit) and middle
            # bar (y = 1.5 units) must land on streets, so the horizontal unit is
            # kx blocks and the vertical unit two thirds of ky blocks.
            for kx in (3, 2, 1):
                for ky in (1, 2, 3, 4, 5):
                    sz = _lattice_layout(rep, kx, ky, ddx, ddy, loop)
                    if sz["ux"] < UNIT_MIN_FT * 0.9 or sz["uy"] < UNIT_MIN_FT * 0.5:
                        continue
                    if not (0.4 <= sz["aspect"] <= 1.6):
                        continue
                    if need_ft is None or sz["est_ft"] < need_ft:
                        need_ft = sz["est_ft"]
                    if sz["est_ft"] <= cap_ft * ALIGNED_OVER_CAP:
                        sz.update(rots=[round(rot, 1)], kind="aligned", dx=ddx, dy=ddy,
                                  orient=orient_pen)
                        if sz["aspect"] < 0.6 or orient_pen < 1.0:
                            # squat letters, or a word you read with your head
                            # tilted, are compromises: never call them "great"
                            sz["max_verdict"] = "good"
                        aligned.append(sz)
        # Biggest letters first, but squat or spindly proportions cost a lot:
        # a letter twice as wide as tall reads worse than a smaller square one.
        aligned.sort(key=lambda s: -s["area"] * math.exp(-2.0 * s["shape"]) * s["orient"])
        out.extend(aligned[:3])
    # Free-floating fallback: only when there is no grid to align to, or when
    # the letters would still be comfortably bigger than a block.
    wmax = min(rep["width_max_ft"], 2.4 * FT_PER_MI)
    rots = {round(r0, 1), 0.0}
    if abs(r0) > 6.0:
        rots.add(round(r0 / 2.0, 1))
    rots = sorted(rots, key=abs)
    unit = wmax / rep["units_per_width"]
    if wmax >= rep["min_width_ft"]:
        free = dict(strokes=rep["strokes"], width_ft=wmax, aspect=1.0, rots=rots, kind="free",
                    unit_ft=unit, est_ft=None, units_per_width=rep["units_per_width"])
        if has_grid and unit < FREE_TEXT_MIN_BLOCKS * min(dx, dy):
            # Letters smaller than the blocks only get used if no lattice
            # fits at all, and then never called better than rough.
            free.update(fallback_only=True, max_verdict="rough")
        out.append(free)
        if not out[:-1]:
            out.append(dict(free, width_ft=wmax * 0.82, unit_ft=unit * 0.82))
    return out, need_ft


def image_size_candidates(rep, cap_ft, r0):
    wmax = min(rep["width_max_ft"], 2.4 * FT_PER_MI)
    rots = {round(r0, 1), 0.0}
    if abs(r0) > 6.0:
        rots.add(round(r0 / 2.0, 1))
    rots = sorted(rots, key=abs)
    out = []
    for f in (1.0, 0.86, 0.74):
        if wmax * f >= rep["min_width_ft"] or not out:
            out.append(dict(strokes=rep["strokes"], width_ft=wmax * f, aspect=1.0, rots=rots,
                            kind="free", est_ft=None))
    return out


def suggest_bucket(need_ft, current):
    """The smallest bucket whose cap covers `need_ft`, if any bigger one does."""
    for key in BUCKET_ORDER[BUCKET_ORDER.index(current) + 1:]:
        if need_ft <= BUCKETS[key]["cap_mi"] * FT_PER_MI * ALIGNED_OVER_CAP:
            return key
    return None


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


def _capped_verdict(r):
    """The IoU verdict, held down by whatever the size or placement knows
    about itself (squat letters, a tilted word, a bent lattice, wandering
    streets)."""
    order = ["bad", "rough", "good", "great"]
    v = verdict_for(r["iou"])
    for cap_v in (r["cand"].get("size", {}).get("max_verdict"), r["cand"].get("max_verdict")):
        if cap_v and order.index(v) > order.index(cap_v):
            v = cap_v
    return v


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
        need_ft = rep["min_width_ft"] * (rep["ink_norm"] + rep["conn_norm"]) * INFLATION
        sug = suggest_bucket(need_ft, req.bucket)
        if req.text:
            raise PlanError(
                f"“{rep['label']}” needs about {need_ft / FT_PER_MI:.1f} mi to stay readable, more than the "
                f"{bucket['label']} option allows. Pick a longer distance or a shorter phrase.", suggest=sug)
        raise PlanError(
            f"That image needs about {need_ft / FT_PER_MI:.1f} mi to keep its detail, more than the "
            f"{bucket['label']} option allows. Pick a longer distance or a simpler image.", suggest=sug)
    choice = fitting[0]
    if len(fitting) > 1 and choice["kind"] == "outline":
        # a thin mark reads better as a single line even when the outline "fits"
        if choice["thick"] * choice["width_max_ft"] < THICK_MIN_FT * 1.15:
            choice = fitting[1]
    width_max = min(choice["width_max_ft"], 2.4 * FT_PER_MI)
    allp = np.vstack([s.pts for s in choice["strokes"]])
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

    # Wandering streets inflate a snapped route well beyond the ideal length;
    # shrink the free-floating size budget accordingly before choosing sizes.
    if gb["regularity"] < IRREGULAR_STREETS:
        choice["width_max_ft"] /= 1.0 + (IRREGULAR_STREETS - gb["regularity"])

    # Sizes to try.
    if choice["kind"] == "text":
        sizes, need_ft = text_size_candidates(choice, cap_ft, g, r0, gb["regularity"], req.loop, log=log)
        if not sizes:
            need_mi = (need_ft or choice["min_width_ft"] * (choice["ink_norm"] + choice["conn_norm"]) * INFLATION) / FT_PER_MI
            sug = suggest_bucket(need_mi * FT_PER_MI, req.bucket)
            hint = (f"Pick {BUCKETS[sug]['label']}" if sug else "Try a shorter phrase") + \
                ", or a spot with smaller blocks."
            raise PlanError(
                f"The blocks here are big: “{choice['label']}” needs about {need_mi:.1f} mi to sit on the "
                f"streets and read, more than the {bucket['label']} option allows. {hint}", suggest=sug)
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

    def scan_size(sz):
        w = sz["width_ft"]
        if sz["kind"] == "aligned":
            radius = 1.3 * max(sz["ux"], sz["uy"]) + 200.0
            grid = max(40.0, sz["unit_ft"] / 8.0)
        else:
            # look up to a third of a mile around the pin for better streets
            radius = max(0.30 * w, 1600.0)
            grid = max(120.0, w / 14.0)
        cands = scan(sz["strokes"], tree, (0.0, 0.0), [w], sz["rots"], radius, grid_ft=grid,
                     aspect=sz["aspect"])
        for c in cands:
            c["score"] *= 1.0 + 0.12 * abs(c["rot"]) / 45.0
            c["size"] = sz
        cands.sort(key=lambda c: c["score"])
        cands = dedupe_places(cands, min_sep_ft=0.15 * w)
        take = 2 if sz["kind"] == "aligned" else 1
        sz["scanned"] = True
        for c in cands[:take]:
            picks.append(c)

    for rank_i, sz in enumerate(sizes):
        sz["rank"] = rank_i
        if not sz.get("fallback_only"):
            scan_size(sz)
    if not picks:
        for sz in sizes:
            if sz.get("fallback_only"):
                scan_size(sz)
    if not picks:
        raise PlanError("The streets here don't line up with that shape at all. "
                        "Try a different location or a simpler drawing.")
    refined = []
    for c in picks[:MAX_SNAPS + 2]:
        sz = c["size"]
        aligned = sz["kind"] == "aligned"
        wb = (c["width_ft"] * (0.995 if aligned else 0.94), c["width_ft"] * (1.005 if aligned else 1.04))
        rb = (min(sz["rots"]) - (1.0 if aligned else 2.0), max(sz["rots"]) + (1.0 if aligned else 2.0))
        r = refine(sz["strokes"], tree, c, wb, rb, rounds=2,
                   dxy=(-40.0, 0.0, 40.0) if aligned else (-90.0, 0.0, 90.0),
                   dr=(-1.0, 0.0, 1.0) if aligned else (-2.0, 0.0, 2.0))
        r["size"] = sz
        refined.append(r)
    picks = dedupe_places(refined, min_sep_ft=120.0)

    # Lattice text lives or dies by its corners: every letter corner has to be
    # a real intersection. Real grids drift, so bend the lattice to the
    # streets that are actually there: each letter column and row slides to
    # the nearest street line, then every corner is checked against a real
    # intersection. Placements that still miss are dropped; big bends cost
    # the verdict.
    sn_full = Snapper(g)
    sn_streets = None
    if any(c["size"]["kind"] == "aligned" for c in picks):
        gs = g.filtered(STREET_CLASSES)
        if len(gs.ids) >= 50:
            sn_streets = Snapper(gs)
            deg = np.array([len(n) for n in gs.nbrs])
            xs = np.flatnonzero((deg >= 3) & gs.keep)
            xtree = cKDTree(np.c_[gs.X[xs], gs.Y[xs]]) if len(xs) else None
            lines = {}
            for c in picks:
                if c["size"]["kind"] != "aligned" or xtree is None:
                    continue
                key = round(c["rot"], 1)
                if key not in lines:
                    lines[key] = _street_lines(gs.X[xs], gs.Y[xs], c["rot"])
                _warp_to_streets(c, lines[key], xtree)
            if log:
                for c in picks:
                    if "corner_cover" in c:
                        log(f"  lattice {c['size']['kx']}x{c['size']['ky']} rot={c['rot']:+.1f} "
                            f"corners on intersections: {c['corner_cover']:.0%} "
                            f"(bend {c['warp']:.2f} blocks)")
            good = [c for c in picks if c["size"]["kind"] != "aligned" or c.get("corner_cover", 0) >= 0.85]
            if not any(c["size"]["kind"] == "aligned" for c in good):
                # No lattice fits these streets: let the free-floating sizes
                # in (they are capped at "rough") and keep the least-bad
                # lattice attempt as a last resort.
                for sz in sizes:
                    if sz.get("fallback_only") and not sz.get("scanned"):
                        scan_size(sz)
                free_picks = [c for c in picks if c["size"]["kind"] != "aligned"]
                if free_picks:
                    good = free_picks
                else:
                    good = [max(picks, key=lambda c: c.get("corner_cover", 0))]
            picks = good
    picks.sort(key=lambda c: (0 if c["size"]["kind"] == "aligned" else 1, c["size"]["rank"],
                              -c.get("corner_cover", 0.0), c.get("warp", 0.0), c["score"]))
    results = []
    n_done = 0
    debug_dir = os.environ.get("RUNMAPPER_DEBUG_DIR")
    for i, c in enumerate(picks[:MAX_SNAPS]):
        if time.time() - t_start > TIME_BUDGET_S and results:
            break
        _progress(progress, "snap", 40 + int(45 * i / max(len(picks), 1)),
                  f"Snapping to streets ({i + 1} of {min(len(picks), MAX_SNAPS)})")
        t0 = time.time()
        r = None
        if c["size"]["kind"] == "aligned" and sn_streets is not None:
            r = _snap_one(sn_streets, c, choice, req.loop, cap_ft)
        if r is None:
            r = _snap_one(sn_full, c, choice, req.loop, cap_ft)
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
                        r["graph"], r["nodes"], r["ideal"],
                        title=f"{choice['label']} {c['size']['kind']} w={c['width_ft'] / FT_PER_MI:.2f} "
                              f"aspect={c.get('aspect', 1.0):.2f} dist={r['dist_mi']:.2f} iou={r['iou']:.2f}")
        results.append(r)
        if r["fits"] and c["size"]["kind"] == "aligned" and _capped_verdict(r) in ("good", "great"):
            break
    if not results:
        raise PlanError("Couldn't route that shape onto these streets. Try a different spot.")
    fits = [r for r in results if r["fits"]]
    if not fits:
        # Shrink the best-looking attempt until it fits the cap (two tries).
        best = max(results, key=lambda r: r["iou"])
        c = dict(best["cand"])
        for attempt in range(2):
            f = cap_ft / (best["dist_ft"] * 1.05)
            c = dict(c)
            c["width_ft"] = max(c["width_ft"] * f, choice["min_width_ft"] * 0.85)
            _progress(progress, "snap", 86, "Shrinking to fit the distance")
            r = _snap_one(sn_full, c, choice, req.loop, cap_ft)
            if r is None:
                break
            results.append(r)
            if r["fits"]:
                fits = [r]
                break
            best = r
    pool = fits if fits else results

    def rank(r):
        v = _capped_verdict(r)
        order = ["bad", "rough", "good", "great"]
        aligned = 1 if r["cand"]["size"]["kind"] == "aligned" else 0
        return (order.index(v), aligned, round(r["iou"], 2), r["cand"]["width_ft"])

    best = max(pool, key=rank)

    _progress(progress, "finish", 90, "Measuring distance and climb")
    out = _finish(best["graph"], proj, best, choice, req, bucket)
    out["timing"] = dict(total_s=round(time.time() - t_start, 1), snaps=n_done,
                         dijkstra=sn_full.n_dijkstra + (sn_streets.n_dijkstra if sn_streets and sn_streets is not sn_full else 0),
                         nodes=int(len(g.ids)))
    out["grid"] = dict(bearing=round(gb["bearing"], 1), regularity=round(gb["regularity"], 2),
                       rot=best["cand"]["rot"], aspect=round(best["cand"].get("aspect", 1.0), 3),
                       size_kind=best["cand"]["size"]["kind"],
                       blocks=[round(best["cand"]["size"].get("dx") or 0), round(best["cand"]["size"].get("dy") or 0)])
    _progress(progress, "done", 100, "Done")
    return out


def _street_lines(X, Y, rot_deg, tol_ft=40.0, min_count=3):
    """Positions of street lines along and across a grid at `rot_deg`, from
    the intersections: project them onto the two axes and cluster."""
    th = math.radians(rot_deg)
    u = X * math.cos(th) + Y * math.sin(th)
    v = -X * math.sin(th) + Y * math.cos(th)

    def cluster(vals):
        vals = np.sort(vals)
        out, cur = [], [vals[0]]
        for a in vals[1:]:
            if a - cur[-1] <= tol_ft:
                cur.append(a)
            else:
                if len(cur) >= min_count:
                    out.append(float(np.mean(cur)))
                cur = [a]
        if len(cur) >= min_count:
            out.append(float(np.mean(cur)))
        return np.array(out)

    return cluster(u), cluster(v)


def _warp_to_streets(c, lines, xtree):
    """Slide each lattice column and row of a placed text to the nearest real
    street line, store the warped polylines on the candidate, and measure how
    many corners now sit on intersections and how far the lattice bent."""
    sz = c["size"]
    th = math.radians(c["rot"])
    ca, sa = math.cos(th), math.sin(th)
    polys = transform(sz["strokes"], (c["cx"], c["cy"]), c["width_ft"], c["rot"], c["aspect"])
    ulines, vlines = lines
    tol_u = 0.45 * sz["dx"]
    tol_v = 0.45 * sz["dy"]
    allp = np.vstack(polys)
    U = allp[:, 0] * ca + allp[:, 1] * sa
    V = -allp[:, 0] * sa + allp[:, 1] * ca
    cols = np.unique(np.round(U, 0))
    rows = np.unique(np.round(V, 0))

    def remap(vals, lines_, tol):
        """Walk the real street lines, taking one per lattice position so
        the spacing stays as close as possible to the lattice's; the start
        is searched within a block. Returns the new positions and, per
        position, how far its gap strays from the expected one (2*tol marks
        a position with no usable street at all)."""
        n = len(vals)
        if n == 0 or len(lines_) == 0:
            return np.array(vals, float), np.full(n, tol * 2)
        best = None
        starts = np.flatnonzero(np.abs(lines_ - vals[0]) <= max(tol, 1.0) * 1.4)
        for s in starts:
            new, dev, cost, j = [float(lines_[s])], [abs(lines_[s] - vals[0])], abs(lines_[s] - vals[0]), s
            for i in range(1, n):
                exp = vals[i] - vals[i - 1]
                # candidate next lines: further along, gap between 0.45x and 1.7x the expected
                cand = [k for k in range(j + 1, len(lines_)) if 0.45 * exp <= lines_[k] - lines_[j] <= 1.7 * exp]
                if not cand:
                    new.append(new[-1] + exp)
                    dev.append(tol * 2)
                    cost += tol * 2
                    continue
                k = min(cand, key=lambda k: abs((lines_[k] - lines_[j]) - exp))
                dev.append(abs((lines_[k] - lines_[j]) - exp))
                cost += dev[-1]
                new.append(float(lines_[k]))
                j = k
            if best is None or cost < best[0]:
                best = (cost, new, dev)
        if best is None:
            return np.array(vals, float), np.full(n, tol * 2)
        return np.array(best[1]), np.array(best[2])

    cols_new, su = remap(cols, ulines, tol_u)
    rows_new, sv = remap(rows, vlines, tol_v)
    warped = []
    for p in polys:
        u = p[:, 0] * ca + p[:, 1] * sa
        v = -p[:, 0] * sa + p[:, 1] * ca
        u2 = np.interp(u, cols, cols_new) if len(cols) > 1 else u
        v2 = np.interp(v, rows, rows_new) if len(rows) > 1 else v
        warped.append(np.c_[u2 * ca - v2 * sa, u2 * sa + v2 * ca])
    c["polys"] = warped
    corners = np.unique(np.vstack(warped).round(1), axis=0)
    d, _ = xtree.query(corners)
    c["corner_cover"] = float((d <= 0.25 * min(sz["dx"], sz["dy"])).mean())
    c["warp"] = float(max(su.max() / sz["dx"] if len(su) else 0.0, sv.max() / sz["dy"] if len(sv) else 0.0))
    if c["warp"] > 0.5:
        c["max_verdict"] = "rough"
    elif c["warp"] > 0.3:
        c["max_verdict"] = "good"


def _snap_params(choice, cand):
    w = cand["width_ft"]
    sz = cand["size"]
    if sz["kind"] == "aligned":
        # corners are street corners; keep the search tight so each stroke
        # takes the street it was laid on
        blk = min(sz["dx"], sz["dy"])
        return dict(corridor=float(np.clip(0.6 * blk, 150, 600)),
                    dev_ref=float(np.clip(0.25 * blk, 60, 200)), w_dev=12.0,
                    radius=float(np.clip(0.35 * blk, 80, 200)), k=2)
    if choice["kind"] == "text":
        unit = sz.get("unit_ft") or (w / choice["units_per_width"])
        return dict(corridor=float(np.clip(2.2 * unit, 450, 1000)),
                    dev_ref=float(np.clip(0.55 * unit, 120, 300)), w_dev=9.0,
                    radius=float(np.clip(1.3 * unit, 300, 600)), k=3)
    return dict(corridor=float(np.clip(0.20 * w, 500, 1000)),
                dev_ref=float(np.clip(0.06 * w, 130, 300)), w_dev=9.0, radius=450.0, k=3)


def _snap_one(sn, cand, choice, loop, cap_ft):
    g = sn.g
    strokes = cand["size"]["strokes"]
    center = np.array([cand["cx"], cand["cy"]])
    kw = _snap_params(choice, cand)
    k = kw.pop("k")
    if cand.get("polys") is not None:
        snapped = snap_polys(sn, strokes, cand["polys"], k=k, **kw)
    else:
        snapped = snap_strokes(sn, strokes, center, cand["width_ft"], cand["rot"],
                               aspect=cand.get("aspect", 1.0), k=k, **kw)
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
                dist_mi=dist_ft / FT_PER_MI, fits=dist_ft <= cap_ft * (ALIGNED_OVER_CAP if cand["size"]["kind"] == "aligned" else 1.02),
                iou=v["iou"], cover=v["cover"], prec=v["prec"], connlen=connlen, graph=g)


def _finish(g, proj, best, choice, req, bucket):
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
    v = _capped_verdict(best)
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
        drawing=dict(kind=choice["kind"], label=label, strokes=len(best["ideal"]), ideal=ideal_ll),
        bucket=dict(key=req.bucket, label=bucket["label"], cap_mi=bucket["cap_mi"]),
        cues=cues,
        gpx=gpx_string(ll, prof["ele"] if prof["gain"] is not None else None, name=name, desc=desc),
        name=name,
        # private handles for the CLI preview; the API strips keys starting with "_"
        _graph=g, _nodes=nodes, _ideal=best["ideal"],
    )
