"""The HTTP layer, served by uvicorn on a local port with a stand-in for the
search: the stream, the record a page that lost the stream reads from, and a
client that goes away in the middle of a search."""
import asyncio
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

from runmapper_engine import api

uvicorn = pytest.importorskip("uvicorn")


def scripted(gap=0.0, hold=None):
    """A plan_run that says a few things, `gap` seconds apart, and waits on
    `hold` (an Event) before its first word when given one."""

    def plan_run(req, progress=None, cache_dir=None, log=None, on_option=None, **kw):
        if hold is not None:
            hold.wait(5)
        progress(dict(stage="streets", pct=10, msg="Fetching the streets"))
        time.sleep(gap)
        on_option(dict(index=0, label="closest", verdict="good", word=req.text))
        time.sleep(gap)
        progress(dict(stage="place", pct=60, msg="Trying placements"))
        time.sleep(gap)
        on_option(dict(index=1, label="farther", verdict="great", word=req.text))
        time.sleep(gap)
        return dict(ok=True, verdict="great", route=dict(distance_mi=3.1), score=dict(iou=0.9),
                    options=[dict(label="closest"), dict(label="farther")], _scratch="not sent")

    return plan_run


FORM = dict(text="RUN", lat="40.7410", lon="-73.9897", bucket="5k", loop="true")


@pytest.fixture
def serve(monkeypatch):
    """Starts the app under uvicorn with the given plan_run; returns the base URL."""
    servers = []

    def start(plan_run):
        monkeypatch.setattr(api, "plan_run", plan_run)
        app = api.create_app(cache_dir="/tmp/runmapper-test-cache")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
        threading.Thread(target=server.run, daemon=True).start()
        for _ in range(200):
            if server.started:
                break
            time.sleep(0.025)
        servers.append(server)
        return f"http://127.0.0.1:{port}"

    yield start
    for server in servers:
        server.should_exit = True
    time.sleep(0.3)


def post(base, form):
    """POST /api/plan; the response, streaming."""
    req = urllib.request.Request(f"{base}/api/plan", data=urllib.parse.urlencode(form).encode(), method="POST")
    return urllib.request.urlopen(req, timeout=10)


def lines(response):
    return [json.loads(line) for line in response if line.strip()]


def record(base, job, after=0, wait=0):
    with urllib.request.urlopen(f"{base}/api/plan/{job}?after={after}&wait={wait}", timeout=30) as r:
        return json.loads(r.read())


def status(url, data=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method="POST" if data else "GET"), timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def test_stream_and_record_say_the_same(serve):
    base = serve(scripted())
    with post(base, dict(FORM, job="job-one-1234")) as r:
        assert r.status == 200
        streamed = lines(r)
    assert [e["type"] for e in streamed] == ["progress", "option", "progress", "option", "result"]
    assert "_scratch" not in streamed[-1]

    rec = record(base, "job-one-1234")
    assert rec["done"] is True
    assert rec["events"] == streamed

    rest = record(base, "job-one-1234", after=3)
    assert [e["type"] for e in rest["events"]] == ["option", "result"]
    assert rest["done"] is True


def test_record_waits_for_the_next_line(serve):
    hold = threading.Event()
    base = serve(scripted(hold=hold))
    with post(base, dict(FORM, job="job-two-1234")):
        threading.Timer(0.4, hold.set).start()
        t0 = time.time()
        rec = record(base, "job-two-1234", after=0, wait=5)
        waited = time.time() - t0
    assert 0.3 <= waited < 4, waited
    assert rec["events"] and rec["events"][0]["type"] == "progress"


def test_a_client_that_goes_away_does_not_stop_the_search(serve):
    base = serve(scripted(gap=0.15))
    host, port = urllib.parse.urlparse(base).hostname, urllib.parse.urlparse(base).port
    body = urllib.parse.urlencode(dict(FORM, job="job-three-12")).encode()
    with socket.create_connection((host, port)) as s:
        s.sendall(b"POST /api/plan HTTP/1.1\r\nHost: engine\r\nContent-Type: application/x-www-form-urlencoded\r\n"
                  + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        got = b""
        while b'"type": "progress"' not in got:
            got += s.recv(4096)
    # The socket is closed: the page is gone. The search finishes anyway and
    # its record is whole.
    types = []
    while True:
        rec = record(base, "job-three-12", after=1 + len(types), wait=5)
        types += [e["type"] for e in rec["events"]]
        if rec["done"]:
            break
    assert types == ["option", "progress", "option", "result"]


def test_draining_stream_reads_to_the_end_when_send_fails():
    seen = []

    async def body():
        for i in range(4):
            seen.append(i)
            yield f"{i}\n"

    sent = []

    async def send(message):
        sent.append(message["type"])
        if len(sent) == 2:  # the first body chunk: the client is gone
            raise ConnectionResetError("client went away")

    async def receive():
        await asyncio.sleep(3600)

    asyncio.run(api.DrainingStream(body(), media_type="text/plain")({}, receive, send))
    assert seen == [0, 1, 2, 3]
    assert sent == ["http.response.start", "http.response.body"]


def test_bad_or_unknown_jobs(serve):
    base = serve(scripted())
    assert status(f"{base}/api/plan", urllib.parse.urlencode(dict(FORM, job="no spaces here")).encode()) == 400
    assert status(f"{base}/api/plan", urllib.parse.urlencode(dict(FORM, job="short")).encode()) == 400
    assert status(f"{base}/api/plan/never-started-1") == 404
    with post(base, dict(FORM, job="job-four-1234")) as r:
        lines(r)
    assert status(f"{base}/api/plan", urllib.parse.urlencode(dict(FORM, job="job-four-1234")).encode()) == 409
    # Without a job id nothing is recorded, and the stream still works.
    with post(base, FORM) as r:
        assert [e["type"] for e in lines(r)][-1] == "result"
