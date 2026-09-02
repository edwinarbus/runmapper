"""HTTP API for the web app.

POST /api/plan streams newline-delimited JSON: progress events while the
route is being built, then one `result` (or `error`) line. One request is one
job, so the service needs no queue or database; a host that allows a request
to run for a couple of minutes is all it takes.
"""
import json
import os
import queue
import threading

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import __version__, font
from .pipeline import BUCKETS, INFLATION, UNIT_MIN_FT, PlanError, PlanRequest, plan_run, prepare_text
from .geo import FT_PER_MI

MAX_IMAGE_BYTES = 6 * 1024 * 1024


def create_app(cache_dir=None):
    cache_dir = cache_dir or os.environ.get("RUNMAPPER_CACHE", ".cache")
    origins = [o.strip() for o in os.environ.get("RUNMAPPER_CORS_ORIGINS", "*").split(",")]
    max_jobs = int(os.environ.get("RUNMAPPER_MAX_JOBS", "2"))
    gate = threading.Semaphore(max_jobs)

    app = FastAPI(title="runmapper", version=__version__)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"],
                       allow_headers=["*"])

    @app.get("/api/health")
    def health():
        return dict(ok=True, version=__version__, buckets=BUCKETS, max_chars=font.MAX_CHARS)

    class Estimate(BaseModel):
        text: str
        bucket: str = "10k"
        loop: bool = True

    @app.post("/api/estimate")
    def estimate(e: Estimate):
        """Cheap feasibility check for typed text, no street data needed."""
        b = BUCKETS.get(e.bucket)
        if b is None:
            raise HTTPException(400, "unknown bucket")
        try:
            rep = prepare_text(e.text, e.loop)
        except font.FontError as ex:
            return dict(ok=False, message=str(ex))
        need_mi = rep["min_width_ft"] * (rep["ink_norm"] + rep["conn_norm"]) * INFLATION / FT_PER_MI
        fits = {k: need_mi <= v["cap_mi"] for k, v in BUCKETS.items()}
        return dict(ok=fits[e.bucket], text=rep["label"], need_mi=round(need_mi, 1),
                    fits=fits, message=None if fits[e.bucket] else
                    f"“{rep['label']}” needs about {need_mi:.1f} mi to stay readable.")

    @app.post("/api/plan")
    async def plan(text: str = Form(""), lat: float = Form(...), lon: float = Form(...),
                   bucket: str = Form("10k"), loop: bool = Form(True), name: str = Form(""),
                   image: UploadFile | None = File(None)):
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(400, "bad coordinates")
        data, fname = None, ""
        if image is not None and image.filename:
            data = await image.read()
            if len(data) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "image too large (6 MB max)")
            fname = image.filename
        req = PlanRequest(lat=lat, lon=lon, bucket=bucket, loop=loop, name=name,
                          text=text.strip() or None, image_bytes=data, image_name=fname)
        q: "queue.Queue[dict | None]" = queue.Queue()

        def work():
            acquired = gate.acquire(timeout=0.01)
            if not acquired:
                q.put(dict(type="progress", stage="queue", pct=1, msg="Waiting for a free worker"))
                gate.acquire()
            try:
                res = plan_run(req, progress=lambda ev: q.put(dict(type="progress", **ev)),
                               cache_dir=cache_dir)
                q.put(dict(type="result", **{k: v for k, v in res.items() if not k.startswith("_")}))
            except PlanError as ex:
                q.put(dict(type="error", message=str(ex), suggest_bucket=ex.suggest))
            except Exception as ex:  # noqa: BLE001 - report, don't hang the stream
                q.put(dict(type="error", message=f"Something broke while planning: {type(ex).__name__}: {ex}"))
            finally:
                gate.release()
                q.put(None)

        threading.Thread(target=work, daemon=True).start()

        async def gen():
            import asyncio
            loop_ = asyncio.get_event_loop()
            while True:
                item = await loop_.run_in_executor(None, q.get)
                if item is None:
                    break
                yield json.dumps(item) + "\n"

        return StreamingResponse(gen(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


app = create_app()
