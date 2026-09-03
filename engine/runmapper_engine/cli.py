"""Command line: draw a phrase or an image on the streets around a point.

    runmapper "RUN" --lat 40.7410 --lon -73.9897 --bucket 5k --out out/
    runmapper logo.png --lat 51.5220 --lon -0.1250 --bucket 10k --out out/
"""
import argparse
import json
import os
import sys
import time

from .pipeline import BUCKETS, PlanError, PlanRequest, plan_run


def main(argv=None):
    ap = argparse.ArgumentParser(prog="runmapper", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", help="a phrase (up to 12 characters) or a path to an image/SVG")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--bucket", choices=sorted(BUCKETS), default="10k")
    ap.add_argument("--no-loop", action="store_true", help="allow an open route (default: perfect loop)")
    ap.add_argument("--out", default="out", help="directory for the GPX, JSON and preview")
    ap.add_argument("--cache", default=os.environ.get("RUNMAPPER_CACHE", ".cache"),
                    help="directory for cached street data")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--name", default="", help="name for the output files")
    ap.add_argument("--style", choices=("auto", "line", "outline"), default="auto",
                    help="line: one line per letter / a single line through an image; outline: block letters / the image's outline")
    a = ap.parse_args(argv)

    if os.path.exists(a.what):
        with open(a.what, "rb") as f:
            req = PlanRequest(lat=a.lat, lon=a.lon, bucket=a.bucket, loop=not a.no_loop, style=a.style,
                              image_bytes=f.read(), image_name=os.path.basename(a.what))
        slug = a.name or os.path.splitext(os.path.basename(a.what))[0]
    else:
        req = PlanRequest(lat=a.lat, lon=a.lon, bucket=a.bucket, loop=not a.no_loop, text=a.what, style=a.style)
        slug = a.name or "".join(c if c.isalnum() else "-" for c in a.what.strip().lower()).strip("-") or "text"

    def log(m):
        print(m, file=sys.stderr, flush=True)

    def prog(ev):
        print(f"[{ev['pct']:3d}%] {ev['msg']}", file=sys.stderr, flush=True)

    t0 = time.time()
    try:
        res = plan_run(req, progress=prog, cache_dir=a.cache, log=log)
    except PlanError as ex:
        print(f"Sorry: {ex}", file=sys.stderr)
        return 2
    os.makedirs(a.out, exist_ok=True)
    slug = f"{slug}-{a.bucket}"
    with open(os.path.join(a.out, slug + ".gpx"), "w") as f:
        f.write(res["gpx"])
    js = {k: v for k, v in res.items() if k != "gpx" and not k.startswith("_")}
    with open(os.path.join(a.out, slug + ".json"), "w") as f:
        json.dump(js, f, indent=1)
    r = res["route"]
    print(f"{res['verdict'].upper():6s} {r['distance_mi']:.2f} mi  gain {r['gain_ft']} ft  "
          f"iou {res['score']['iou']:.2f}  width {r['width_mi']:.2f} mi  rot {res['grid']['rot']:+.1f}  "
          f"start {r['start_desc']}  ({time.time() - t0:.0f}s)")
    if res["message"]:
        print(res["message"])
    if not a.no_preview:
        try:
            from .preview import preview_png
            png = os.path.join(a.out, slug + ".png")
            preview_png(png, res["_graph"], res["_nodes"], res["_ideal"],
                        title=f"{res['name']}  {r['distance_mi']:.2f} mi  IoU {res['score']['iou']:.2f}")
            print("preview:", png)
        except KeyError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
