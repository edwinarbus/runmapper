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
from .graph import GRID_CLASSES, StreetGraph, grid_stats
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
OUTLINE_BLOCK_MIN_FT = 190.0   # block letters are one block thick; thinner than this they don't read
OUTLINE_TYPICAL_BLOCK_FT = 300.0   # what the pre-flight estimate assumes a city block is
LOGO_MIN_WIDTH_FT = 1900.0
THICK_MIN_FT = 300.0      # two edges closer than this land on the same street
VERDICTS = [(0.66, "great"), (0.50, "good"), (0.36, "rough")]
IRREGULAR_STREETS = 0.60        # grid regularity below this caps the verdict at "good"
VERY_IRREGULAR_STREETS = 0.50   # ...and below this at "rough"
LATTICE_MIN_REGULARITY = 0.45   # below this there is no grid to lay letters on
FREE_TEXT_MIN_BLOCKS = 1.6      # free-floating letters narrower than this many blocks are mush
MAX_SNAPS = 5
TIME_BUDGET_S = 190.0
SEARCH_RADIUS_FT = 2.0 * FT_PER_MI   # how far the search goes for the "best fit" option
WINDOW_STEP_FT = 1500.0              # spacing of the spots tried around the pin
MAX_BOX_HALF_FT = 2.4 * FT_PER_MI    # never fetch more than a 4.8 x 4.8 mile box of streets
MAX_SNAPPED_SPOTS = 16               # spots that get the full snap treatment
BAND_FT = 2400.0                     # width of the distance bands the options are drawn from
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
    style: str = "auto"       # auto | line | outline
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


def _monotone(cb):
    """Wrap a progress callback so the percentage never goes backwards, even
    though the spot search repeats the place-and-snap stages."""
    if cb is None:
        return None
    last = [0]

    def wrapped(ev):
        last[0] = max(last[0], int(ev.get("pct", 0)))
        cb(dict(ev, pct=last[0]))

    return wrapped


# ------------------------------------------------------------------ strokes

def prepare_text(text, loop, style="line", lines=1):
    """The phrase as strokes plus what it costs. lines=2 stacks it on two
    lines (None when it does not split)."""
    if style == "outline":
        # Block letters: closed outlines one block thick. The reference shape
        # is the kx=ky=1 layout; "units" are blocks of that drawing.
        lay = font.outline_layout(text, "3x5", loop, lines)      # the smallest legible block letters
        if lay is None:
            return None
        allp = np.vstack(lay["polys"])
        lo, hi = allp.min(0), allp.max(0)
        ctr = (lo + hi) / 2.0
        scale = float(max(hi[0] - lo[0], hi[1] - lo[1])) or 1.0
        strokes = [Stroke((poly - ctr) / scale, name=f"block{i}", closed=True, kind="outline")
                   for i, poly in enumerate(lay["polys"])]
        return dict(kind="text", style="outline", lines=lines, strokes=strokes, label=lay["text"],
                    ink_norm=sum(lay["ink_xy"]) / scale, conn_norm=sum(lay["conn_xy"]) / scale,
                    min_width_ft=OUTLINE_BLOCK_MIN_FT * scale, units_per_width=scale, layout=lay)
    got = font.text_strokes(text, loop=loop, lines=lines)
    if got is None:
        return None
    strokes, lay = got
    unit_norm = 1.0 / lay["scale_units_per_norm"]          # normalised size of one font unit
    return dict(kind="text", style="line", lines=lines, strokes=strokes, label=lay["text"],
                ink_norm=lay["walk_units"] * unit_norm,
                conn_norm=lay["return_units"] * unit_norm,
                min_width_ft=UNIT_MIN_FT * lay["scale_units_per_norm"],
                units_per_width=lay["scale_units_per_norm"], layout=lay)


def prepare_image(data, name, loop, style="auto"):
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
        out.append(dict(kind=r["kind"], style=r["kind"], strokes=strokes, ink_norm=ink, conn_norm=conn,
                        min_width_ft=min_w, thick=r["thick"], feature=feat, label=name or "image"))
    if style == "line":
        out = [r for r in out if r["kind"] == "center"]
        if not out:
            raise PlanError("Couldn't trace a single line through that image. Try the Outline style.")
    elif style == "outline":
        out = [r for r in out if r["kind"] == "outline"]
        if not out:
            raise PlanError("Couldn't trace an outline from that image (it is line art). Try the Line style.")
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
    if lay.get("lines", 1) > 1:
        # Two lines: one staircased stroke per line, the second a lattice row
        # below the first; the hop between lines and the way home are priced
        # roughly (the assembler picks the cheapest joins).
        Ps = [font.staircase(P, kx, ky) for P in lay["points_list"]]
        walk_ft = 0.0
        for P in Ps:
            d = np.abs(np.diff(P, axis=0))
            walk_ft += float(d[:, 0].sum() * ux + d[:, 1].sum() * uy)
        widths = [l["units_wide"] for l in lay["layouts"]]
        walk_ft += sum((font.H + font.LINE_GAP) * uy + 0.5 * abs(a - b) * ux for a, b in zip(widths[:-1], widths[1:]))
        ret_ft = (lay["units_wide"] * ux + lay["height_units"] * uy) if loop else 0.0
        allp = np.vstack(Ps)
        lo, hi = allp.min(0), allp.max(0)
        ctr = (lo + hi) / 2.0
        scale = float(max(hi[0] - lo[0], hi[1] - lo[1])) or 1.0
        strokes = [Stroke((P - ctr) / scale, name=f"text:{lay['parts'][i]}", closed=False, kind="text")
                   for i, P in enumerate(Ps)]
        return dict(strokes=strokes, width_ft=ux * scale, aspect=uy / ux, ux=ux, uy=uy, kx=kx, ky=ky,
                    unit_ft=min(ux, uy), est_ft=(walk_ft + ret_ft) * INFLATION_ALIGNED,
                    units_per_width=scale, area=ux * uy, shape=abs(math.log((uy / ux) / 0.9)))
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


def _outline_lattice_layout(rep, fontname, kx, ky, dx, dy, loop):
    """The phrase as block letters from a dot-matrix font on the block
    lattice: each cell of the letter grid is kx blocks wide and ky blocks
    tall, so strokes are that thick and every corner is a street corner.
    Closed strokes per letter, the exact length of their outlines plus a
    rough length of the joins."""
    cache = rep.setdefault("_outline_layouts", {})
    if fontname not in cache:
        cache[fontname] = font.outline_layout(rep["label"], fontname, loop, rep.get("lines", 1))
    lay = cache[fontname]
    ux, uy = kx * dx, ky * dy
    allp = np.vstack(lay["polys"])
    lo, hi = allp.min(0), allp.max(0)
    ctr = (lo + hi) / 2.0
    scale = float(max(hi[0] - lo[0], hi[1] - lo[1])) or 1.0
    strokes = [Stroke((poly - ctr) / scale, name=f"block{i}", closed=True, kind="outline")
               for i, poly in enumerate(lay["polys"])]
    ink_ft = lay["ink_xy"][0] * ux + lay["ink_xy"][1] * uy
    conn_ft = lay["conn_xy"][0] * ux + lay["conn_xy"][1] * uy
    fw, fh = (5, 7) if fontname == "5x7" else (3, 5)
    lw, lh = fw * ux, fh * uy                          # one letter's footprint
    return dict(strokes=strokes, width_ft=ux * scale, aspect=uy / ux, ux=ux, uy=uy, kx=kx, ky=ky,
                font=fontname, unit_ft=min(ux, uy), est_ft=(ink_ft + conn_ft) * INFLATION_ALIGNED,
                units_per_width=scale, area=lw * lh, letter_aspect=lh / lw,
                shape=abs(math.log((lh / lw) / (fh / fw))))


def _outline_size_candidates(rep, cap_ft, g, r0, regularity, loop, log=None, window=None):
    """Sizes for block letters: on the lattice with cells of kx x ky blocks
    (strokes that thick), the 5x7 font before the cruder 3x5, biggest first.
    Where there is a grid, nothing else: free-floating block letters come out
    as squiggles, so when none fits the caller gets the distance they would
    need. Without a grid, a free-floating size is the only option and is
    capped at rough."""
    out = []
    bs = g.block_spacing(90.0 - r0, window=window)
    dx, dy = bs["spacing_along"], bs["spacing_across"]
    has_grid = (regularity >= LATTICE_MIN_REGULARITY and dx and dy
                and bs["conf_along"] >= 0.15 and bs["conf_across"] >= 0.15)
    if log:
        log(f"  grid rot={r0:+.1f} regularity={regularity:.2f} block along={dx} across={dy} "
            f"conf={bs['conf_along']:.2f}/{bs['conf_across']:.2f} lattice={has_grid} (block letters)")
    need_ft = None
    if has_grid:
        aligned = []
        r90 = r0 + 90.0 if r0 <= 0 else r0 - 90.0
        for rot, ddx, ddy, orient_pen in ((r0, dx, dy, 1.0), (r90, dy, dx, 0.6)):
            for fontname, rank in (("5x7", 1), ("3x5", 0)):
                for kx, ky in ((1, 1), (2, 1), (1, 2), (2, 2)):
                    sz = _outline_lattice_layout(rep, fontname, kx, ky, ddx, ddy, loop)
                    if sz["unit_ft"] < OUTLINE_BLOCK_MIN_FT * 0.75:
                        continue        # strokes too thin to read
                    if not (0.6 <= sz["letter_aspect"] <= 2.8):
                        continue
                    if need_ft is None or sz["est_ft"] < need_ft:
                        need_ft = sz["est_ft"]
                    if sz["est_ft"] <= cap_ft * ALIGNED_OVER_CAP:
                        sz.update(rots=[round(rot, 1)], kind="aligned", dx=ddx, dy=ddy, orient=orient_pen,
                                  font_rank=rank)
                        if orient_pen < 1.0:
                            sz["max_verdict"] = "good"
                            sz["cap_reason"] = "the word reads sideways on this grid"
                        aligned.append(sz)
        # Level before tilted, the better font before the cruder one, then the
        # biggest letters closest to the font's own proportions.
        aligned.sort(key=lambda s: (-s["orient"], -s["font_rank"], -s["area"] * math.exp(-2.0 * s["shape"])))
        out.extend(aligned[:3])
        return out, need_ft
    wmax = min(rep["width_max_ft"], 2.4 * FT_PER_MI)
    rots = {round(r0, 1), 0.0}
    if abs(r0) > 6.0:
        rots.add(round(r0 / 2.0, 1))
    rots = sorted(rots, key=abs)
    unit = wmax / rep["units_per_width"]
    if wmax >= rep["min_width_ft"]:
        out.append(dict(strokes=rep["strokes"], width_ft=wmax, aspect=1.0, rots=rots, kind="free",
                        unit_ft=unit, est_ft=None, units_per_width=rep["units_per_width"], max_verdict="rough",
                        cap_reason="there is no street grid here for block letters to sit on"))
    return out, need_ft


def text_size_candidates(rep, cap_ft, g, r0, regularity, loop, log=None, window=None):
    """Sizes to try for text: letters on the block lattice at whole-block
    multiples (biggest first), plus a free-floating fallback only where the
    letters would still span well over a block. Returns (sizes, need_ft) where
    need_ft is the smallest lattice layout's length, for the suggestion when
    nothing fits."""
    if rep.get("style") == "outline":
        return _outline_size_candidates(rep, cap_ft, g, r0, regularity, loop, log=log, window=window)
    out = []
    bs = g.block_spacing(90.0 - r0, window=window)
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
                        # Squat letters, or a word you read with your head
                        # tilted, are compromises: never call them "great",
                        # and say why.
                        if sz["aspect"] < 0.45:     # letters more than about 1.5x wider than tall
                            sz["max_verdict"] = "good"
                            sz["cap_reason"] = "the letters are squashed to fit the blocks"
                        elif orient_pen < 1.0:
                            sz["max_verdict"] = "good"
                            sz["cap_reason"] = "the word reads sideways on this grid"
                        aligned.append(sz)
        # Biggest letters first, but squat or spindly proportions cost a lot:
        # a letter twice as wide as tall reads worse than a smaller square one.
        # Level text first (a tilted word only wins when level fails the
        # corner check), then biggest letters, with squat or spindly
        # proportions costing a lot.
        aligned.sort(key=lambda s: (-s["orient"], -s["area"] * math.exp(-2.0 * s["shape"])))
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
            free.update(fallback_only=True, max_verdict="rough", cap_reason="the letters are smaller than the blocks here")
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
    """What the user should know beyond the verdict badge: nothing for a good
    or great fit, a hint when the drawing is rough or impossible here."""
    if v in ("great", "good"):
        return ""
    if v == "rough":
        return "The streets here only roughly follow the shape. A denser street grid or a longer distance would sharpen it."
    return "The streets here don't line up with that shape. Try another location, a shorter phrase, or a simpler image."


def _capped_verdict(r):
    """The IoU verdict, held down by whatever the size or placement knows
    about itself (squat letters, a tilted word, a bent lattice, wandering
    streets)."""
    return _verdict_and_reason(r)[0]


def _verdict_and_reason(r):
    """The capped verdict and, when it is lower than the overlap alone would
    give, the reason (the compromise the size or placement made)."""
    order = ["bad", "rough", "good", "great"]
    v = verdict_for(r["iou"])
    reason = None
    sz = r["cand"].get("size", {})
    for cap_v, why in ((sz.get("max_verdict"), sz.get("cap_reason")),
                       (r["cand"].get("max_verdict"), r["cand"].get("cap_reason"))):
        if cap_v and order.index(v) > order.index(cap_v):
            v = cap_v
            reason = why
    return v, reason


def match_tolerance(width_ft):
    """How far off the line still counts as 'on it': GPS wobble plus a share
    of the drawing size, since a bigger drawing forgives a bigger detour."""
    return float(np.clip(0.04 * width_ft, 65.0, 110.0))


# ------------------------------------------------------------------ main

def plan_run(req: PlanRequest, progress=None, cache_dir=None, log=None, on_option=None):
    """Plan the run. `progress` gets stage events; `on_option` gets each
    finished answer (closest, farther, best fit) the moment it is ready, so a
    caller can show routes one by one; the return value carries them all."""
    t_start = time.time()
    progress = _monotone(progress)
    bucket = BUCKETS.get(req.bucket)
    if bucket is None:
        raise PlanError("Pick a distance: 5k, 10k or long.")
    cap_ft = bucket["cap_mi"] * FT_PER_MI

    _progress(progress, "strokes", 3, "Reading the shape")
    style = req.style if req.style in ("auto", "line", "outline") else "auto"
    if req.text:
        try:
            text_style = "outline" if style == "outline" else "line"
            reps = [prepare_text(req.text, req.loop, text_style)]
            two = prepare_text(req.text, req.loop, text_style, lines=2)
            if two is not None:
                reps.append(two)          # the same phrase on two lines: shorter, bigger letters
        except font.FontError as ex:
            raise PlanError(str(ex)) from ex
    elif req.image_bytes:
        reps = prepare_image(req.image_bytes, req.image_name, req.loop, style)
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

    # Streets around the pin, wide enough that the drawing can move up to
    # SEARCH_RADIUS_FT away from it when the streets there fit better.
    _progress(progress, "streets", 10, "Fetching the streets around your spot")
    proj = Projection(req.lat, req.lon)
    half_w = 0.62 * width_max
    half_h = 0.62 * width_max * max(aspect0, 0.35)
    half_x = min(half_w + SEARCH_RADIUS_FT + 800.0, MAX_BOX_HALF_FT)
    half_y = min(half_h + SEARCH_RADIUS_FT + 800.0, MAX_BOX_HALF_FT)
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

    ctx = dict(choice=choice, cap_ft=cap_ft, g=g, tree=tree, req=req, bucket=bucket,
               t_start=t_start, sn_full=Snapper(g), streets=None, spots_snapped=0)
    ctx["text_reps"] = [r for r in fitting if r["kind"] == "text"] if choice["kind"] == "text" else [choice]

    # Spots to try: the pin first, then nearby spots whose streets form a
    # clearly more regular grid, nearest first. The first spot that gives a
    # good fit wins, so the run starts as close to the pin as a good drawing
    # allows.
    # The grid statistics of a spot come from a window about a mile across
    # around it (the drawing plus a margin), the same neighbourhood a single
    # fetch used to cover.
    stat_half = max(0.62 * width_max + 1300.0, 2500.0)
    pin_w = _window_stats(g, 0.0, 0.0, stat_half)
    others = [w for w in _windows(g, stat_half, SEARCH_RADIUS_FT, WINDOW_STEP_FT,
                                  half_x - half_w - 300.0, half_y - half_h - 300.0)
              if w["dist_ft"] > 1.0]
    need_reg = max(0.6, min(0.85, pin_w["regularity"] + 0.08))
    eligible = [w for w in others
                if w["regularity"] >= need_reg and w["length_ft"] >= 0.35 * max(pin_w["length_ft"], 1.0)]
    for w in eligible:
        w["band"] = int(w["dist_ft"] // BAND_FT)
    eligible.sort(key=lambda w: (w["band"], -w["regularity"]))
    if log:
        log(f"  pin grid regularity={pin_w['regularity']:.2f} bearing={pin_w['bearing']:.1f}; "
            f"{len(eligible)} more regular spots within {SEARCH_RADIUS_FT / FT_PER_MI:.1f} mi")

    # Three answers: the best fit close to the pin (the first band, 0.45 mi),
    # the best a bit farther out (the second band), and the best fit anywhere
    # in the search area (the most regular grids farther out). Spots are
    # tried nearest group first, as long as time allows.
    pin_w["band"] = 0
    near = [pin_w] + [w for w in eligible if w["band"] == 0]
    mid = [w for w in eligible if w["band"] == 1][:5]
    far = sorted([w for w in eligible if w["band"] >= 2 and w["regularity"] >= max(need_reg, 0.8)],
                 key=lambda w: (-w["regularity"], w["dist_ft"]))[:6]
    attempts, errors, finished = [], [], []
    k = 0
    stop = False

    def quality(r):
        return (_attempt_tier(r), r["iou"])

    def finish_attempt(r, label, number):
        """The finished answer for a snapped attempt (distance, climb, cues,
        GPX), made once and kept on the attempt."""
        if "_finished" not in r:
            _progress(progress, "finish", ctx["pct_hi"], f"Measuring distance and climb (option {number})")
            o = _finish(r["graph"], proj, r, choice, req, bucket)
            o["label"] = label
            gb = r["gb"]
            o["grid"] = dict(bearing=round(gb["bearing"], 1), regularity=round(gb["regularity"], 2),
                             rot=r["cand"]["rot"], aspect=round(r["cand"].get("aspect", 1.0), 3),
                             size_kind=r["cand"]["size"]["kind"],
                             blocks=[round(r["cand"]["size"].get("dx") or 0),
                                     round(r["cand"]["size"].get("dy") or 0)])
            o["_tier"] = _attempt_tier(r)
            r["_finished"] = o
        return r["_finished"]

    def public(o, index, **extra):
        return dict({k_: v for k_, v in o.items() if not k_.startswith("_")}, index=index, **extra)

    for label, group, (pct_lo, pct_hi) in (("closest", near, (28, 48)), ("farther", mid, (50, 68)),
                                            ("best fit", far, (70, 88))):
        ctx["pct_lo"], ctx["pct_hi"] = pct_lo, pct_hi
        group_attempts = []
        first_look = None          # the pin's own fit, shown before the rest of the band is tried
        for w in group:
            if k > 0 and (ctx["spots_snapped"] >= MAX_SNAPPED_SPOTS or time.time() - t_start > 0.7 * TIME_BUDGET_S):
                stop = True
                break
            if k == 0:
                _progress(progress, "place", pct_lo, "Trying placements near your pin")
            else:
                _progress(progress, "place", pct_lo,
                          f"Looking {w['dist_ft'] / FT_PER_MI:.1f} mi {_compass(w['cx'], w['cy'])} for better streets")
            try:
                r = _attempt(ctx, w, progress, log, k)
            except PlanError as ex:
                errors.append(ex)
                if log:
                    log(f"  spot {k} ({w['dist_ft'] / FT_PER_MI:.1f} mi): {ex}")
                k += 1
                continue
            r["spot"] = w
            attempts.append(r)
            group_attempts.append(r)
            if log:
                log(f"  spot {k} ({w['dist_ft'] / FT_PER_MI:.1f} mi {_compass(w['cx'], w['cy'])}): "
                    f"{_capped_verdict(r)} iou={r['iou']:.2f} {r['dist_mi']:.2f} mi"
                    f"{'' if r['fits'] else ' (over the cap)'}")
            k += 1
            if label == "closest" and len(group_attempts) == 1:
                # A drawing that fits well right here can't be beaten for
                # closeness: skip the rest of the band. Otherwise show this
                # first fit now and keep looking; a better one nearby replaces it.
                if r["fits"] and _capped_verdict(r) == "great":
                    if log:
                        log("  a great fit at the first spot; the rest of the band is skipped")
                    break
                if len(group) > 1 and on_option:
                    first_look = r
                    o = finish_attempt(r, label, 1)
                    if log:
                        log(f"  first look: {o['verdict']} iou={o['score']['iou']} {o['route']['distance_mi']} mi")
                    on_option(public(o, 0, provisional=True))
        # This group's answer, finished and handed out right away. A farther
        # answer is only offered when it is at least as good, by tier, as a
        # nearer one, so a worse drawing never hides behind a bigger distance.
        if group_attempts:
            best = max(group_attempts, key=quality)
            if not finished or _attempt_tier(best) >= max(o["_tier"] for o in finished):
                o = finish_attempt(best, label, len(finished) + 1)
                finished.append(o)
                if log:
                    log(f"  option '{label}': {o['verdict']} iou={o['score']['iou']} {o['route']['distance_mi']} mi, "
                        f"{o['route']['from_pin_mi']} mi from the pin")
                if on_option and best is not first_look:
                    on_option(public(o, len(finished) - 1))
        if stop:
            break
    if not finished:
        if errors:
            raise errors[0]
        raise PlanError("Couldn't route that shape onto these streets. Try a different spot.")
    out = {k_: v for k_, v in finished[0].items() if k_ != "_tier"}
    out["options"] = [{k_: v for k_, v in o.items() if not k_.startswith("_")} for o in finished]
    sn_streets = ctx["streets"][1] if ctx["streets"] else None
    out["timing"] = dict(total_s=round(time.time() - t_start, 1), snaps=ctx.get("snaps_done", 0),
                         dijkstra=ctx["sn_full"].n_dijkstra + (sn_streets.n_dijkstra if sn_streets else 0),
                         nodes=int(len(g.ids)), spots=len(attempts) + len(errors))
    _progress(progress, "done", 100, "Done")
    return out


def _compass(dx, dy):
    """Eight-point compass name of the direction (dx east, dy north)."""
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    ang = math.degrees(math.atan2(dx, dy)) % 360.0
    return names[int((ang + 22.5) // 45.0) % 8]


def _window_stats(g, cx, cy, half_ft):
    """Grid statistics of the streets in a square window: dominant bearing,
    regularity, and how much street there is."""
    mx, my, bear, ln = g.grid_edges()
    m = (np.abs(mx - cx) <= half_ft) & (np.abs(my - cy) <= half_ft)
    st = grid_stats(bear[m] % 90.0, ln[m])
    return dict(cx=float(cx), cy=float(cy), dist_ft=float(math.hypot(cx, cy)), half_ft=float(half_ft),
                bearing=st["bearing"], regularity=st["regularity"],
                length_ft=float(ln[m].sum()), n_edges=int(m.sum()))


def _windows(g, half_ft, radius_ft, step_ft, limit_x, limit_y):
    """Candidate spots on a lattice around the pin (the origin), each with the
    grid statistics of a drawing-sized window centred there. Only spots whose
    window still lies inside the fetched streets are returned."""
    out = []
    n = int(radius_ft // step_ft)
    for ix in range(-n, n + 1):
        for iy in range(-n, n + 1):
            cx, cy = ix * step_ft, iy * step_ft
            if math.hypot(cx, cy) > radius_ft or abs(cx) > limit_x or abs(cy) > limit_y:
                continue
            w = _window_stats(g, cx, cy, half_ft)
            if w["n_edges"] >= 40:
                out.append(w)
    out.sort(key=lambda w: w["dist_ft"])
    return out


def _attempt_tier(r):
    """How much a snapped attempt is worth: a good fit inside the distance
    first, then a good drawing that runs a little over the distance when a
    longer bucket exists to offer, then a rough fit, then the rest."""
    v = _capped_verdict(r)
    if v in ("good", "great"):
        return 3 if r["fits"] else (2 if r.get("next_bucket") else 0)
    if v == "rough" and r["fits"]:
        return 1
    return 0


def _streets_graph(ctx):
    """Street-centreline subgraph (no paths or sidewalks) with its snapper and
    intersection indices, built once per plan."""
    if ctx["streets"] is None:
        gs = ctx["g"].filtered(STREET_CLASSES)
        if len(gs.ids) >= 50:
            deg = np.array([len(n) for n in gs.nbrs])
            xs = np.flatnonzero((deg >= 3) & gs.keep)
            ctx["streets"] = (gs, Snapper(gs), xs)
        else:
            ctx["streets"] = (None, None, None)
    return ctx["streets"]


def _attempt(ctx, w, progress, log, k):
    """Size, place, lattice-check and snap the drawing around one spot, using
    the grid statistics of that spot's window. Returns the best snapped
    result, or raises PlanError with the reason nothing worked there."""
    choice, cap_ft, g, tree, req = ctx["choice"], ctx["cap_ft"], ctx["g"], ctx["tree"], ctx["req"]
    bucket, t_start = ctx["bucket"], ctx["t_start"]
    center = (w["cx"], w["cy"])
    window = (w["cx"], w["cy"], w["half_ft"])
    regularity = w["regularity"]
    r0 = (90.0 - w["bearing"]) % 90.0
    if r0 > 45.0:
        r0 -= 90.0

    # Wandering streets inflate a snapped route well beyond the ideal length;
    # shrink the free-floating size budget accordingly before choosing sizes.
    def budgeted(r):
        r = dict(r)
        if regularity < IRREGULAR_STREETS:
            r["width_max_ft"] = r["width_max_ft"] / (1.0 + (IRREGULAR_STREETS - regularity))
        return r

    rep = budgeted(choice)

    # Sizes to try.
    if choice["kind"] == "text":
        # Every layout of the phrase (one line, two lines) contributes sizes;
        # lattice sizes are ranked together, biggest letters first, one line
        # preferred at equal size.
        sizes, need_ft = [], None
        for rep0 in ctx.get("text_reps", [choice]):
            s_, n_ = text_size_candidates(budgeted(rep0), cap_ft, g, r0, regularity, req.loop,
                                          log=log, window=window)
            for sz in s_:
                sz["lines"] = rep0.get("lines", 1)
                sz["rep"] = rep0
            sizes += s_
            if n_ is not None and (need_ft is None or n_ < need_ft):
                need_ft = n_
        aligned = [sz for sz in sizes if sz["kind"] == "aligned"]
        aligned.sort(key=lambda sz: (-sz.get("orient", 1.0), -sz.get("font_rank", 0),
                                     -sz["area"] * math.exp(-2.0 * sz["shape"]) * (0.85 if sz["lines"] > 1 else 1.0)))
        free = [sz for sz in sizes if sz["kind"] != "aligned"]
        free.sort(key=lambda sz: sz["lines"])
        sizes = aligned[:4] + free
        if not sizes:
            need_mi = (need_ft or choice["min_width_ft"] * (choice["ink_norm"] + choice["conn_norm"]) * INFLATION) / FT_PER_MI
            sug = suggest_bucket(need_mi * FT_PER_MI, req.bucket)
            hint = (f"Pick {BUCKETS[sug]['label']}" if sug else "Try a shorter phrase") + \
                ", or a spot with smaller blocks."
            raise PlanError(
                f"The blocks here are big: “{choice['label']}” needs about {need_mi:.1f} mi to sit on the "
                f"streets and read, more than the {bucket['label']} option allows. {hint}", suggest=sug)
    else:
        sizes = image_size_candidates(rep, cap_ft, r0)
    if regularity < IRREGULAR_STREETS:
        # Wandering streets never trace a shape crisply; don't promise more.
        cap_v = "rough" if regularity < VERY_IRREGULAR_STREETS else "good"
        for sz in sizes:
            if sz.get("max_verdict") != "rough":
                sz["max_verdict"] = cap_v
                sz["cap_reason"] = "the streets here wander rather than run in a grid"

    # Placement scan around the spot.
    picks = []

    def scan_size(sz):
        wd = sz["width_ft"]
        if sz["kind"] == "aligned":
            radius = 1.3 * max(sz["ux"], sz["uy"]) + 200.0
            grid = max(40.0, sz["unit_ft"] / 8.0)
        else:
            # look up to a third of a mile around the spot for better streets
            radius = max(0.30 * wd, 1600.0)
            grid = max(120.0, wd / 14.0)
        cands = scan(sz["strokes"], tree, center, [wd], sz["rots"], radius, grid_ft=grid,
                     aspect=sz["aspect"])
        for c in cands:
            c["score"] *= 1.0 + 0.12 * abs(c["rot"]) / 45.0
            c["size"] = sz
        cands.sort(key=lambda c: c["score"])
        cands = dedupe_places(cands, min_sep_ft=0.15 * wd)
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
    sn_full = ctx["sn_full"]
    sn_streets = None
    if any(c["size"]["kind"] == "aligned" for c in picks):
        gs, sn_s, xs = _streets_graph(ctx)
        if gs is not None:
            sn_streets = sn_s
            reach = w["half_ft"] + 0.8 * max(c["width_ft"] for c in picks) + 500.0
            loc = xs[(np.abs(gs.X[xs] - w["cx"]) <= reach) & (np.abs(gs.Y[xs] - w["cy"]) <= reach)]
            xtree = cKDTree(np.c_[gs.X[loc], gs.Y[loc]]) if len(loc) else None
            lines = {}
            for c in picks:
                if c["size"]["kind"] != "aligned" or xtree is None:
                    continue
                key = round(c["rot"], 1)
                if key not in lines:
                    lines[key] = _street_lines(gs.X[loc], gs.Y[loc], c["rot"])
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
    ctx["spots_snapped"] += 1
    debug_dir = os.environ.get("RUNMAPPER_DEBUG_DIR")
    for i, c in enumerate(picks[:MAX_SNAPS]):
        if time.time() - t_start > TIME_BUDGET_S and results:
            break
        _progress(progress, "snap", int(ctx.get("pct_lo", 40) + (ctx.get("pct_hi", 85) - ctx.get("pct_lo", 40)) * (0.3 + 0.6 * i / max(len(picks), 1))),
                  f"Snapping to streets ({i + 1} of {min(len(picks), MAX_SNAPS)})")
        t0 = time.time()
        r = None
        if c["size"]["kind"] == "aligned" and sn_streets is not None:
            r = _snap_one(sn_streets, c, choice, req.loop, cap_ft, req.bucket)
        if r is None:
            r = _snap_one(sn_full, c, choice, req.loop, cap_ft, req.bucket)
        ctx["snaps_done"] = ctx.get("snaps_done", 0) + 1
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
            preview_png(os.path.join(debug_dir, f"spot{k}_cand{i}_{c['size']['kind']}_w{c['width_ft'] / FT_PER_MI:.2f}.png"),
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
            r = _snap_one(sn_full, c, choice, req.loop, cap_ft, req.bucket)
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
        level = r["cand"]["size"].get("orient", 1.0)      # a word you can read without tilting your head
        return (order.index(v), aligned, level, round(r["iou"], 2), r["cand"]["width_ft"])

    best = max(pool, key=rank)
    best["gb"] = dict(bearing=w["bearing"], regularity=regularity)
    return best


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
        """Walk the real street lines, taking one per lattice position: each
        position looks for a line within `tol` of where the lattice expects
        it (one lattice gap on from the previous position as placed), so a
        missing street costs only its own position and the walk recovers on
        the next one. The start is searched within a block. Returns the new
        positions and, per position, how far it slipped (2*tol marks a
        position with no usable street at all)."""
        n = len(vals)
        if n == 0 or len(lines_) == 0:
            return np.array(vals, float), np.full(n, tol * 2)
        best = None
        starts = np.flatnonzero(np.abs(lines_ - vals[0]) <= max(tol, 1.0) * 1.4)
        for s0 in starts:
            new, dev, cost, j = [float(lines_[s0])], [abs(lines_[s0] - vals[0])], abs(lines_[s0] - vals[0]), s0
            for i in range(1, n):
                target = new[-1] + (vals[i] - vals[i - 1])
                cand = [k for k in range(j + 1, len(lines_)) if abs(lines_[k] - target) <= tol]
                if not cand:
                    new.append(target)
                    dev.append(tol * 2)
                    cost += tol * 2
                    continue
                k = min(cand, key=lambda k: abs(lines_[k] - target))
                dev.append(abs(lines_[k] - target))
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
    # How far the lattice had to bend: the median per-line slip, in blocks.
    # A few streets missing along a long word do not by themselves make the
    # whole drawing "rough"; the corner check above catches real misses.
    c["warp"] = float(max(np.median(su) / sz["dx"] if len(su) else 0.0,
                          np.median(sv) / sz["dy"] if len(sv) else 0.0))
    if c["warp"] > 0.6:
        c["max_verdict"] = "rough"
        c["cap_reason"] = "the street grid bends a lot here"
    elif c["warp"] > 0.38:
        c["max_verdict"] = "good"
        c["cap_reason"] = "the street grid bends here"


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


def _snap_one(sn, cand, choice, loop, cap_ft, bucket_key="long"):
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
    fits = dist_ft <= cap_ft * (ALIGNED_OVER_CAP if cand["size"]["kind"] == "aligned" else 1.02)
    return dict(cand=cand, nodes=full, snapped=snapped, ideal=ideal, dist_ft=dist_ft,
                dist_mi=dist_ft / FT_PER_MI, fits=fits,
                next_bucket=None if fits else suggest_bucket(dist_ft, bucket_key),
                iou=v["iou"], cover=v["cover"], prec=v["prec"], connlen=connlen, graph=g)


MAX_APPROACH_FT = 0.25 * FT_PER_MI   # a walk-on this short is built into the route; farther, the run starts at the drawing


def _start_at_pin(g, nodes, px, py, loop, room_ft=float("inf")):
    """Begin the run where the user asked when that is close. The drawing is
    entered at its node nearest the pin; if the pin itself is off the drawing
    but within MAX_APPROACH_FT by street, and the walk-on fits in the distance
    left under the bucket cap (`room_ft`), the path from the pin's corner
    leads onto it (and, for a loop, back off it at the end, retraced so it
    adds no ink). Otherwise the run starts at the drawing and the distance
    from the pin is reported instead.
    Returns (nodes, approach_ft, on_pin, from_pin_ft)."""
    body = nodes[:-1] if loop else list(nodes)
    R = route_xy(g, body)
    k = int(np.argmin(np.hypot(R[:, 0] - px, R[:, 1] - py)))
    if loop:
        nodes = body[k:] + body[:k] + [body[k]]
    pin_node, pin_d = g.nearest_node(px, py)
    entry = nodes[0]
    straight = float(np.hypot(g.X[entry] - px, g.Y[entry] - py))
    if pin_node == entry:
        return nodes, 0.0, True, 0.0
    r = Snapper(g).shortest_hug(pin_node, entry)
    if r is None:
        return nodes, 0.0, False, straight
    path = list(r[0])
    L = path_len_ft(g, path)
    if L > MAX_APPROACH_FT or L * (2 if loop else 1) > room_ft:
        return nodes, 0.0, False, (L if L <= 2.5 * max(straight, 200.0) else straight)
    out = path + list(nodes[1:])
    if loop:
        out = out + path[::-1][1:]
    return out, L * (2 if loop else 1), True, 0.0


def _finish(g, proj, best, choice, req, bucket):
    nodes = best["nodes"]
    px, py = proj.to_xy(req.lat, req.lon)
    loop_in = bool(req.loop and nodes[0] == nodes[-1])
    room_ft = bucket["cap_mi"] * FT_PER_MI * ALIGNED_OVER_CAP - path_len_ft(g, nodes)
    nodes, approach_ft, on_pin, from_pin_ft = _start_at_pin(g, nodes, float(px), float(py), loop_in, room_ft)
    latlon = route_latlon(g, nodes)
    xy = route_xy(g, nodes)
    keep = dedupe(latlon, (xy[:, 0], xy[:, 1]), min_ft=6.0)
    ll = latlon[keep]
    X, Y = xy[keep, 0], xy[keep, 1]
    seg = haversine_segments_ft(ll)
    cum = np.r_[0.0, np.cumsum(seg)]
    dist_mi = float(cum[-1] / FT_PER_MI)

    # One call's worth of samples (the public service takes 100 a second):
    # every 110 ft on a short route, wider on a long one; the profile is
    # smoothed over 400 ft anyway.
    spacing = max(110.0, cum[-1] / 96.0)
    want = np.arange(0, cum[-1], spacing)
    idx = np.unique(np.searchsorted(cum, want).clip(0, len(ll) - 1))
    z_s = elev_query(ll[idx], max_calls=1)
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
    v, held_by = _verdict_and_reason(best)
    if not best["fits"]:
        v = "over"
    label = choice["label"]
    name = req.name or (f"drawmy.run: {label}" if choice["kind"] == "text" else "drawmy.run route")
    desc = f"{dist_mi:.2f} mi"
    if prof["gain"] is not None:
        desc += f", {prof['gain']:.0f} ft gain"
    desc += ". Made with drawmy.run"
    ideal_ll = []
    for poly in best["ideal"]:
        la, lo = proj.to_ll(poly[:, 0], poly[:, 1])
        ideal_ll.append(np.c_[la, lo].round(6).tolist())
    b0 = math.degrees(math.atan2(X[1] - X[0], Y[1] - Y[0])) % 360.0 if len(X) > 1 else 0.0
    # Where the run starts relative to the pin is in the route fields
    # (from_pin_mi, starts_at_pin); the message carries only what needs doing.
    sug = suggest_bucket(dist_mi * FT_PER_MI, req.bucket) if v == "over" else None
    if v == "over":
        msg = (f"{dist_mi:.1f} mi is over the {bucket['label']} limit. "
               + ("Pick a longer distance." if sug else "Try a shorter phrase, a simpler image, or a spot with smaller blocks."))
    elif held_by:
        # The overlap alone would say more; say what held it back.
        words = dict(great="great", good="OK", rough="rough", bad="no fit")
        msg = (f"By overlap alone this would be {words[verdict_for(iou)]}; it is held at {words[v]} "
               f"because {held_by}.")
    else:
        msg = _message(v)
    return dict(
        ok=v in ("great", "good", "rough"),
        verdict=v, message=msg,
        suggest_bucket=sug,
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
                   starts_at_pin=bool(on_pin), approach_mi=round(approach_ft / FT_PER_MI, 2),
                   from_pin_mi=round(from_pin_ft / FT_PER_MI, 2),
                   width_mi=round(best["cand"]["width_ft"] / FT_PER_MI, 2),
                   n_points=int(len(ll))),
        drawing=dict(kind=choice["kind"], style=choice.get("style") or choice["kind"], label=label,
                     lines=int(best["cand"]["size"].get("lines", 1)), strokes=len(best["ideal"]), ideal=ideal_ll),
        bucket=dict(key=req.bucket, label=bucket["label"], cap_mi=bucket["cap_mi"]),
        cues=cues,
        gpx=gpx_string(ll, prof["ele"] if prof["gain"] is not None else None, name=name, desc=desc),
        name=name,
        # private handles for the CLI preview; the API strips keys starting with "_"
        _graph=g, _nodes=nodes, _ideal=best["ideal"],
    )
