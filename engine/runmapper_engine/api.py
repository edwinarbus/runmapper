"""HTTP API for the web app.

POST /api/plan streams newline-delimited JSON: progress events while the
route is being built, then one `result` (or `error`) line. One request is one
job, so the service needs no queue or database; a host that allows a request
to run for a couple of minutes is all it takes.

A page may send a `job` id of its own with the request. Everything the search
says is then also kept on record here, in memory, and the stream is read to
its end whether or not the page is still listening, so a phone that sleeps
the page (and the connection with it) does not stop the work. When the page
comes back it asks GET /api/plan/{job}?after=N for the lines it missed and
waits there for the rest. A record is kept for a quarter of an hour after
the search ends. On Vercel, where the page's next request may land on a
different worker, each record is also put on a shelf every worker can reach,
the Runtime Cache, so any of them can hand out its lines.
"""
import asyncio
import contextvars
import json
import os
import queue
import re
import threading
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import __version__, font
from .pipeline import (BUCKETS, INFLATION, OUTLINE_TYPICAL_BLOCK_FT, UNIT_MIN_FT, PlanError, PlanRequest,
                       plan_run, prepare_text)
from .geo import FT_PER_MI

MAX_IMAGE_BYTES = 6 * 1024 * 1024
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
RECORD_KEEP_S = 15 * 60     # a finished search stays on record this long
RECORD_STALE_S = 30 * 60    # an unfinished one is given up after this
RECORD_LIMIT = 40           # searches on record at once, per worker
POLL_WAIT_MAX_S = 25.0      # the longest one GET waits for a new line
POLL_SETTLE_S = 0.8         # once a line has come, how long to let the next ones join it
SHELF_TTL_S = RECORD_KEEP_S + 5 * 60   # a record on the shelf outlives the worker's own a little
SHELF_EVERY_S = 1.0         # how often, at most, a running search is put on the shelf


def make_shelf():
    """Where records are shared between workers: the Vercel Runtime Cache
    when this runs on Vercel (VERCEL=1 and vercel-cache installed), else
    nothing, and a worker's records stay its own. The client finds the
    cache through the request's context, which Vercel's runtime sets for
    each request, so it is used from request handlers or from threads
    that carry a copy of that context."""
    if os.environ.get("VERCEL") != "1" and not os.environ.get("RUNTIME_CACHE_ENDPOINT"):
        return None
    try:
        from vercel.cache import RuntimeCache
    except ImportError:
        print("vercel-cache is not installed: search records stay on the worker that made them", flush=True)
        return None
    return RuntimeCache(namespace="runmapper")


def shelf_key(job):
    return f"plan:{job}"


class Record:
    """What one search has said so far. The page that started it reads the
    stream live; a page that comes back after a sleep reads the same lines
    from here and waits for the rest. Given a shelf, a copy is kept there
    too, for the other workers."""

    def __init__(self, job=None, shelf=None):
        self.events: list[dict] = []
        self.done = False
        self.touched = time.time()
        self.cond = threading.Condition()
        self.job = job
        self.shelf = shelf
        self.shelving = threading.Lock()   # one write to the shelf at a time, in order
        self.dirty = shelf is not None     # the shelf wants the empty record at once
        if shelf is not None:
            # The thread carries a copy of the request's context, where the
            # shelf's client finds its connection.
            threading.Thread(target=contextvars.copy_context().run, args=(self._keep_shelved,), daemon=True).start()

    def put(self, ev):
        """Append an event; None marks the end of the search."""
        if ev is None:
            self.close()
            return
        with self.cond:
            self.events.append(ev)
            self.touched = time.time()
            self.dirty = True
            self.cond.notify_all()

    def close(self):
        """The search has ended. Its last word goes on the shelf here and
        now, before the stream ends, because a worker with no request in
        flight may be put to sleep at once, thread and all."""
        with self.cond:
            self.done = True
            self.dirty = False
            self.touched = time.time()
            snap = dict(events=list(self.events), done=True)
            self.cond.notify_all()
        if self.shelf is not None:
            self._shelve(snap)

    def _shelve(self, snap):
        with self.shelving:
            if self.done and not snap["done"]:
                return   # the last word is on the shelf already; an older one must not follow it
            try:
                self.shelf.set(shelf_key(self.job), snap, {"ttl": SHELF_TTL_S})
            except Exception as ex:  # noqa: BLE001 - the shelf is a convenience, never the search
                print(f"[plan] the shelf did not take the record: {type(ex).__name__}: {ex}", flush=True)

    def _keep_shelved(self):
        """Puts the record on the shelf whenever it has changed, at most
        about once a second while the search runs, so a worker that did not
        run the search can still hand out its lines. The search itself never
        waits on this; the last word is close()'s to write."""
        while True:
            with self.cond:
                while not self.dirty and not self.done:
                    self.cond.wait()
                if self.done:
                    return
                self.dirty = False
                snap = dict(events=list(self.events), done=False)
            self._shelve(snap)
            time.sleep(SHELF_EVERY_S)

    def after(self, n, wait, settle=POLL_SETTLE_S):
        """The events from the n-th on, waiting up to `wait` seconds for one
        to arrive, and whether the search has ended. Once one has arrived the
        lines that follow closely get `settle` seconds to join it, so a page
        catching up is not asking once per line."""
        with self.cond:
            end = time.time() + wait
            while len(self.events) <= n and not self.done:
                left = end - time.time()
                if left <= 0:
                    break
                self.cond.wait(left)
            stop = time.time() + settle
            while len(self.events) > n and not self.done and time.time() < stop:
                self.cond.wait(stop - time.time())
            return list(self.events[n:]), self.done


class DrainingStream(StreamingResponse):
    """A streaming response the client cannot cut short. Starlette stops the
    stream, and so the search feeding it, the moment the client goes away,
    and a phone that sleeps the page does exactly that. Here the stream is
    read to its end whatever happens to the connection, so the search runs
    to completion and its record is whole when the page comes back."""

    async def __call__(self, scope, receive, send):
        gone = False

        async def tell(message):
            nonlocal gone
            if gone:
                return
            try:
                await send(message)
            except Exception:  # noqa: BLE001 - the client went; drain on silently
                gone = True

        await tell({"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers})
        async for chunk in self.body_iterator:
            if not isinstance(chunk, (bytes, memoryview)):
                chunk = chunk.encode(self.charset)
            await tell({"type": "http.response.body", "body": chunk, "more_body": True})
        await tell({"type": "http.response.body", "body": b"", "more_body": False})


def create_app(cache_dir=None):
    cache_dir = cache_dir or os.environ.get("RUNMAPPER_CACHE", ".cache")
    origins = [o.strip() for o in os.environ.get("RUNMAPPER_CORS_ORIGINS", "*").split(",")]
    max_jobs = int(os.environ.get("RUNMAPPER_MAX_JOBS", "2"))
    gate = threading.Semaphore(max_jobs)
    records: dict[str, Record] = {}
    records_lock = threading.Lock()
    shelf = make_shelf()

    def open_record(job):
        """A fresh record for this job id, making room by dropping the
        records nobody will ask for again."""
        now = time.time()
        with records_lock:
            for k, r in list(records.items()):
                if (r.done and now - r.touched > RECORD_KEEP_S) or now - r.touched > RECORD_STALE_S:
                    del records[k]
            if job in records:
                raise HTTPException(409, "a search with that id is already on record")
            while len(records) >= RECORD_LIMIT:
                oldest = min(records, key=lambda k: (not records[k].done, records[k].touched))
                del records[oldest]
            rec = records[job] = Record(job, shelf)
        return rec

    def from_shelf(job, after, wait):
        """The record another worker put on the shelf: its lines from the
        `after`-th on and whether the search has ended, looking again about
        once a second for up to `wait` seconds while there is nothing new.
        None when the shelf has no such record."""
        end = time.time() + wait
        misses = 0
        while True:
            snap = shelf.get(shelf_key(job))
            if isinstance(snap, dict) and isinstance(snap.get("events"), list):
                events, done = snap["events"], bool(snap.get("done"))
                if len(events) > after or done or time.time() >= end:
                    return events[after:], done
            else:
                misses += 1
                if misses >= 3 or time.time() >= end:   # not there, or the shelf is unwell
                    return None, False
            time.sleep(min(1.0, max(0.05, end - time.time())))

    app = FastAPI(title="runmapper", version=__version__)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"],
                       allow_headers=["*"])

    @app.get("/api/health")
    def health(check: str = ""):
        """Alive, and what it serves. With ?check=shelf it also puts a line on
        the shelf and reads it back, to show whether records are shared."""
        out = dict(ok=True, version=__version__, buckets=BUCKETS, max_chars=font.MAX_CHARS,
                   shelf="runtime-cache" if shelf is not None else "none")
        if check == "shelf" and shelf is not None:
            stamp = dict(at=time.time())
            try:
                shelf.set(shelf_key("health"), stamp, {"ttl": 60})
                back = shelf.get(shelf_key("health"))
                out["shelf_ok"] = back == stamp
                if not out["shelf_ok"]:
                    out["shelf_back"] = back
                # which client answered: the cache itself, or the SDK's in-memory stand-in
                from vercel.cache.runtime_cache import resolve_cache
                out["shelf_client"] = type(resolve_cache(sync=True)).__name__
            except Exception as ex:  # noqa: BLE001 - report it
                out["shelf_ok"] = False
                out["shelf_error"] = f"{type(ex).__name__}: {ex}"
        return out

    class Estimate(BaseModel):
        text: str
        bucket: str = "10k"
        loop: bool = True
        style: str = "auto"

    @app.post("/api/estimate")
    def estimate(e: Estimate):
        """Cheap feasibility check for typed text, no street data needed."""
        b = BUCKETS.get(e.bucket)
        if b is None:
            raise HTTPException(400, "unknown bucket")
        try:
            rep = prepare_text(e.text, e.loop, "outline" if e.style == "outline" else "line")
        except font.FontError as ex:
            return dict(ok=False, message=str(ex))
        width = rep["min_width_ft"]
        if rep.get("style") == "outline":
            # block letters are sized by the real blocks; assume a typical one
            width = max(width, OUTLINE_TYPICAL_BLOCK_FT * rep["units_per_width"])
        need_mi = width * (rep["ink_norm"] + rep["conn_norm"]) * INFLATION / FT_PER_MI
        fits = {k: need_mi <= v["cap_mi"] for k, v in BUCKETS.items()}
        # The strokes themselves (normalised, y down) so the page can show
        # the word the way it will be run.
        strokes = [dict(pts=[[round(float(x), 3), round(float(-y), 3)] for x, y in s.pts],
                        closed=bool(s.closed)) for s in rep["strokes"]]
        return dict(ok=fits[e.bucket], text=rep["label"], need_mi=round(need_mi, 1),
                    fits=fits, strokes=strokes, message=None if fits[e.bucket] else
                    f"“{rep['label']}” needs about {need_mi:.1f} mi to stay readable.")

    @app.post("/api/plan")
    async def plan(text: str = Form(""), lat: float = Form(...), lon: float = Form(...),
                   bucket: str = Form("10k"), loop: bool = Form(True), name: str = Form(""),
                   style: str = Form("auto"), job: str = Form(""),
                   image: UploadFile | None = File(None)):
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(400, "bad coordinates")
        if job and not JOB_ID.match(job):
            raise HTTPException(400, "bad job id")
        data, fname = None, ""
        if image is not None and image.filename:
            data = await image.read()
            if len(data) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "image too large (6 MB max)")
            fname = image.filename
        req = PlanRequest(lat=lat, lon=lon, bucket=bucket, loop=loop, name=name,
                          text=text.strip() or None, image_bytes=data, image_name=fname,
                          style=style if style in ("auto", "line", "outline") else "auto")
        rec = open_record(job) if job else None
        q: "queue.Queue[dict | None]" = queue.Queue()

        def emit(ev):
            # On record first, so a page that comes back finds every line
            # even when the stream itself is long gone.
            if rec is not None:
                rec.put(ev)
            q.put(ev)

        # Server log lines (Vercel/Railway/Modal capture stdout). Coordinates
        # are rounded to about a kilometre so visitors' start addresses are
        # not written down.
        rid = f"{int(time.time()) % 100000:05d}"
        what = f"image {fname}" if data is not None else f"text {text.strip()!r}"

        def slog(msg):
            print(f"[plan {rid}] {msg}", flush=True)

        def work():
            t0 = time.time()
            slog(f"start {what} near {lat:.2f},{lon:.2f} bucket={bucket} loop={loop}")
            acquired = gate.acquire(timeout=0.01)
            if not acquired:
                emit(dict(type="progress", stage="queue", pct=1, msg="Waiting for a free worker"))
                gate.acquire()
            try:
                res = plan_run(req, progress=lambda ev: emit(dict(type="progress", **ev)),
                               cache_dir=cache_dir, log=slog,
                               on_option=lambda o: emit(dict(type="option", **o)))
                emit(dict(type="result", **{k: v for k, v in res.items() if not k.startswith("_")}))
                slog(f"done {res.get('verdict')} {res['route']['distance_mi']:.2f} mi "
                     f"iou={res['score']['iou']:.2f} in {time.time() - t0:.1f}s")
            except PlanError as ex:
                slog(f"no route: {ex} ({time.time() - t0:.1f}s)")
                emit(dict(type="error", message=str(ex), suggest_bucket=ex.suggest))
            except Exception as ex:  # noqa: BLE001 - report, don't hang the stream
                slog(f"crashed: {type(ex).__name__}: {ex} ({time.time() - t0:.1f}s)")
                emit(dict(type="error", message=f"Something broke while planning: {type(ex).__name__}: {ex}"))
            finally:
                gate.release()
                emit(None)

        threading.Thread(target=work, daemon=True).start()

        async def gen():
            loop_ = asyncio.get_running_loop()
            while True:
                item = await loop_.run_in_executor(None, q.get)
                if item is None:
                    break
                yield json.dumps(item) + "\n"

        return DrainingStream(gen(), media_type="application/x-ndjson",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/plan/{job}")
    async def plan_record(job: str, after: int = 0, wait: float = 20.0):
        """The lines of a search from the `after`-th on, for a page that lost
        the stream. Rather than answer empty, it waits up to `wait` seconds
        for a new line, so a page need not ask over and over. A search this
        worker did not run is looked up on the shelf."""
        after = max(after, 0)
        wait = max(0.0, min(wait, POLL_WAIT_MAX_S))
        with records_lock:
            rec = records.get(job)
        if rec is not None:
            events, done = await asyncio.get_running_loop().run_in_executor(None, rec.after, after, wait)
        elif shelf is not None and JOB_ID.match(job):
            # to_thread carries the request's context along, for the shelf's client
            events, done = await asyncio.to_thread(from_shelf, job, after, wait)
            if events is None:
                raise HTTPException(404, "no search on record with that id")
        else:
            raise HTTPException(404, "no search on record with that id")
        return JSONResponse(dict(events=events, done=done), headers={"Cache-Control": "no-store"})

    return app


app = create_app()
