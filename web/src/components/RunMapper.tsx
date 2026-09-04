"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUCKETS,
  type Bucket,
  type EstimateResult,
  type PlanOption,
  type PlanResult,
  type ProgressEvent,
  STYLES,
  type Style,
  type Units,
  PlanError,
  checkHealth,
  detectUnits,
  downloadGpx,
  estimate,
  fmtDist,
  planRun,
  runFileStem,
} from "@/lib/api";
import { DAY_STYLE } from "@/lib/basemaps";
import { DRAW_FILE, type Pt, drawingSvg, isDrawing } from "@/lib/drawing";
import { type Place, reverseCity, reversePlace, searchPlaces } from "@/lib/geocode";
import { prepareUpload } from "@/lib/image";
import { TILE } from "@/lib/labels";
import DrawPad from "./DrawPad";
import FlapWord from "./FlapWord";
import PaceBand from "./PaceBand";
import Icon from "./Icon";
import Seg from "./Seg";
import type { LatLon } from "./MapView";
import { BibStack } from "./RaceBib";
import Stopwatch from "./Stopwatch";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#141417]" />,
});

const MAX_CHARS = 12;
type Mode = "text" | "draw" | "image";
const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "text", label: "Words", hint: "Type a word or two" },
  { key: "draw", label: "Draw", hint: "Draw a shape with your finger or mouse" },
  { key: "image", label: "Image", hint: "Upload a logo or a simple drawing" },
];
type Status = "idle" | "planning" | "done" | "error";

export default function RunMapper() {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [draw, setDraw] = useState<Pt[][]>([]);   // the shape drawn on the pad
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [pin, setPin] = useState<LatLon | null>(null);
  const [pinLabel, setPinLabel] = useState<string>("");
  const [focus, setFocus] = useState<(LatLon & { zoom?: number; key: number }) | null>(null);
  const [bucket, setBucket] = useState<Bucket>("5k");
  const [loop, setLoop] = useState(true);
  const [style, setStyle] = useState<Style>("auto");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [optIdx, setOptIdx] = useState(0);
  const userPicked = useRef(false);        // the user chose a lane while options were still arriving
  const [editing, setEditing] = useState(false); // back on the form while an answer exists
  const [runKey, setRunKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Bucket | null>(null);
  const [est, setEst] = useState<EstimateResult | null>(null);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [units, setUnits] = useState<Units>("km");
  const [engine, setEngine] = useState<"checking" | "online" | "offline">("checking");
  const [canShare, setCanShare] = useState(false);
  const [gif, setGif] = useState({ busy: false, pct: 0 });
  const [note, setNote] = useState<string | null>(null);   // something worth knowing about the answer
  const [city, setCity] = useState("");                   // where the run is, for file names
  const cityFor = useRef("");                             // the start the city was looked up for
  const [laps, setLaps] = useState(0);          // spots tried so far, on the stopwatch
  const [startedAt, setStartedAt] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const focusKey = useRef(0);
  const touched = useRef(false);           // the pin was chosen on purpose; don't let geolocation move it
  const aside = useRef<HTMLElement>(null);
  const pinName = useRef("");              // the pin a place name was looked up for

  // A pin set by a tap or a link starts out as coordinates; give it a name.
  const namePin = useCallback(async (p: LatLon) => {
    const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    pinName.current = key;
    const name = await reversePlace(p.lat, p.lon);
    if (name && pinName.current === key) setPinLabel(`Near ${name}`);
  }, []);

  // A shared link fills the form in: words, start, distance, loop, style.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.toString()) return;
    const lat = Number(q.get("lat"));
    const lon = Number(q.get("lon"));
    const hasPin = q.has("lat") && q.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (hasPin) touched.current = true;
    const t = setTimeout(() => {
      const words = q.get("t");
      if (words) {
        setMode("text");
        setText(words.slice(0, MAX_CHARS));
      }
      const d = q.get("d");
      if (BUCKETS.some((b) => b.key === d)) setBucket(d as Bucket);
      const s = q.get("s");
      if (STYLES.some((x) => x.key === s)) setStyle(s as Style);
      const lp = q.get("loop");
      if (lp === "0" || lp === "1") setLoop(lp === "1");
      if (hasPin) {
        setPin({ lat, lon });
        setPinLabel(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
        setFocus({ lat, lon, zoom: 13.5, key: ++focusKey.current });
        void namePin({ lat, lon });
      }
    }, 0);
    return () => clearTimeout(t);
  }, [namePin]);

  // The browser's location is only asked for when the My location key is
  // pressed; the map opens on the world until a place is chosen.

  // Is there an engine to talk to? Say so up front instead of after a failed run.
  useEffect(() => {
    let live = true;
    checkHealth().then((ok) => {
      if (live) setEngine(ok ? "online" : "offline");
    });
    return () => {
      live = false;
    };
  }, []);

  // Miles only where people actually use them; everyone else gets kilometres.
  useEffect(() => {
    const t = setTimeout(() => setUnits(detectUnits()), 0);
    return () => clearTimeout(t);
  }, []);

  // Every key goes down when pressed and springs back when let go, and a
  // tap shows the press for at least a tenth of a second, however quick.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.button > 0) return;
      const key = (e.target as HTMLElement | null)?.closest?.("button:not(:disabled)") as HTMLElement | null;
      if (!key) return;
      key.dataset.pressed = "";
      const t0 = performance.now();
      const up = () => {
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.setTimeout(() => delete key.dataset.pressed, Math.max(0, 110 - (performance.now() - t0)));
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, []);

  // Phones can hand the GPX straight to Strava, Garmin or Komoot.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const f = new File(["<gpx/>"], "run.gpx", { type: "application/gpx+xml" });
        setCanShare(typeof navigator.share === "function" && navigator.canShare?.({ files: [f] }) === true);
      } catch {
        setCanShare(false);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Live feasibility check for typed text, with the strokes for the preview.
  useEffect(() => {
    const t = setTimeout(() => {
      if (mode !== "text" || !text.trim()) {
        setEst(null);
        return;
      }
      estimate(text, bucket, loop, style).then(setEst).catch(() => setEst(null));
    }, 250);
    return () => clearTimeout(t);
  }, [text, bucket, loop, mode, style]);

  // Place search.
  useEffect(() => {
    searchAbort.current?.abort();
    const ctl = new AbortController();
    searchAbort.current = ctl;
    const t = setTimeout(() => {
      if (query.trim().length < 3) {
        setPlaces([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      searchPlaces(query, pin ?? undefined, ctl.signal)
        .then((p) => {
          if (!ctl.signal.aborted) setPlaces(p);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!ctl.signal.aborted) setSearching(false);
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, pin]);

  const pickPlace = (p: Place) => {
    touched.current = true;
    setPin({ lat: p.lat, lon: p.lon });
    setPinLabel([p.label, p.detail].filter(Boolean).join(", "));
    setFocus({ lat: p.lat, lon: p.lon, zoom: 13.5, key: ++focusKey.current });
    setQuery("");
    setPlaces([]);
  };

  const onPick = useCallback(
    (p: LatLon) => {
      touched.current = true;
      setPin(p);
      setPinLabel(`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
      void namePin(p);
    },
    [namePin],
  );

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        touched.current = true;
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setPin(p);
        setPinLabel("Your location");
        setFocus({ ...p, zoom: 13.5, key: ++focusKey.current });
      },
      () => setError("Couldn't get your location. Search for a place or click the map instead."),
    );
  };

  const onImage = async (f: File | null) => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const g = f ? await prepareUpload(f) : null;
    setImage(g);
    setImageUrl(g ? URL.createObjectURL(g) : null);
  };

  // The town the run is in, once per plan, from the first route's start.
  const lookupCity = async (start: [number, number]) => {
    if (cityFor.current) return;
    const key = `${start[0].toFixed(3)},${start[1].toFixed(3)}`;
    cityFor.current = key;
    const c = await reverseCity(start[0], start[1]);
    if (cityFor.current === key && c) setCity(c);
  };

  // Which distances the word fits. A key it does not fit is disabled, and if
  // the chosen key is one of those the shortest that fits stands in for it;
  // the choice itself is kept, and comes back when the word gets shorter.
  const fits = mode === "text" && est?.fits ? est.fits : null;
  const fitting = fits ? BUCKETS.filter((b) => fits[b.key]).map((b) => b.key) : BUCKETS.map((b) => b.key);
  const effective: Bucket = fits && !fits[bucket] ? (fitting[0] ?? bucket) : bucket;
  const textOk = mode === "text" && text.trim().length > 0 && text.trim().length <= MAX_CHARS && (est ? (fits ? fitting.length > 0 : est.ok) : true);
  const canGo =
    pin !== null && status !== "planning" && ((mode === "text" && textOk) || (mode === "draw" && draw.length > 0) || (mode === "image" && image !== null));

  const go = async (useBucket: Bucket = effective) => {
    if (!pin) return;
    if (useBucket !== bucket) setBucket(useBucket);
    setStatus("planning");
    setResult(null);
    setEditing(false);
    setRunKey((k) => k + 1);
    setError(null);
    setSuggest(null);
    setNote(null);
    setCity("");
    cityFor.current = "";
    setProgress({ type: "progress", stage: "start", pct: 1, msg: "Starting" });
    setLaps(0);
    setStartedAt(Date.now());
    const ctl = new AbortController();
    abort.current = ctl;
    userPicked.current = false;
    const arrived: PlanOption[] = [];
    const found = () => arrived.filter(Boolean);
    // A phone that puts the page to sleep drops the stream. Note it, so a
    // failure while hidden is retried instead of reported.
    let wentHidden = false;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") wentHidden = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    // A drawing travels as a stroked SVG, which the engine reads as line art.
    const upload = mode === "image" ? image : mode === "draw" ? new File([drawingSvg(draw)], DRAW_FILE, { type: "image/svg+xml" }) : null;
    const input = { text: mode === "text" ? text : undefined, image: upload, lat: pin.lat, lon: pin.lon, bucket: useBucket, loop, style: mode === "draw" ? ("auto" as Style) : style };
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await planRun(
            input,
            (p) => {
              setProgress(p);
              if (p.stage === "place") setLaps((n) => n + 1);   // one placement scan per spot: a lap
            },
            ctl.signal,
            (o) => {
              // Show each route the moment it is found: the bibs and the map
              // follow the newest one unless the user has picked one. The
              // first look near the pin arrives early and may be replaced.
              const { type: _t, index, ...opt } = o;
              void _t;
              arrived[index] = opt;
              const first = arrived.find(Boolean);
              if (!first) return;
              setResult({ ...first, type: "result", options: found() });
              if (!userPicked.current) setOptIdx(found().length - 1);
              void lookupCity(opt.route.start);
            },
          );
          // The final answer repeats the streamed options; keep those objects so
          // the route on show is not redrawn.
          setResult(arrived.length && r.options && r.options.length === found().length ? { ...r, options: found() } : r);
          if (!arrived.length) setOptIdx(0);
          void lookupCity(r.route.start);
          setStatus("done");
          return;
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            setStatus("idle");
            return;
          }
          const dropped = !(e instanceof PlanError) || /stopped without an answer|reach the route engine/i.test(e.message);
          if (dropped && found().length) {
            // The connection went, but routes had arrived: keep them.
            setResult({ ...found()[0], type: "result", options: found() });
            setNote("The connection dropped before the search finished, so these are the routes found by then.");
            setStatus("done");
            return;
          }
          if (dropped && wentHidden && attempt < 2) {
            // Put to sleep in the background: go again, once.
            wentHidden = false;
            arrived.length = 0;
            setProgress({ type: "progress", stage: "start", pct: 2, msg: "The page was asleep; starting the search again" });
            setLaps(0);
            continue;
          }
          setError(e instanceof PlanError ? e.message : `Something went wrong: ${(e as Error).message}`);
          setSuggest(e instanceof PlanError ? e.suggest : null);
          setStatus("error");
          return;
        }
      }
    } finally {
      document.removeEventListener("visibilitychange", onVisibility);
      abort.current = null;
    }
  };

  const cancel = () => abort.current?.abort();

  // The answers, as bibs: the streamed options, or the result itself when it came alone.
  const lanes = useMemo<PlanOption[]>(() => {
    if (!result) return [];
    if (result.options?.length) return result.options;
    const { options: _o, type: _t, timing: _tm, ...rest } = result;
    void _o;
    void _t;
    void _tm;
    return [{ ...rest, label: "closest" }];
  }, [result]);
  const shownIdx = Math.min(optIdx, Math.max(0, lanes.length - 1));
  const shown: PlanOption | null = lanes[shownIdx] ?? null;
  const routeCoords = useMemo(() => shown?.route.coords ?? null, [shown]);
  const finish = useMemo<[number, number] | null>(
    () => (shown && !shown.route.loop && shown.route.coords.length > 1 ? shown.route.coords[shown.route.coords.length - 1] : null),
    [shown],
  );
  // File names say which run this is: RUN-3.40mi-San-Francisco.
  const stem = shown
    ? runFileStem(shown.drawing.kind === "text" ? shown.drawing.label : isDrawing(shown.drawing.label) ? "drawing" : "logo", shown.route.distance_mi, units, city)
    : "route";
  const showResult = Boolean(result && shown && !editing);
  const drawingLabel = shown ? (shown.drawing.kind === "text" ? `“${shown.drawing.label}”` : isDrawing(shown.drawing.label) ? "your drawing" : "your image") : "";
  const summary = shown ? [drawingLabel, TILE[shown.bucket.key] ?? shown.bucket.label, shown.route.loop ? "Loop" : "One way"].join(" · ") : "";
  const caption = useMemo(
    () => ({
      word: shown ? (shown.drawing.kind === "text" ? shown.drawing.label : isDrawing(shown.drawing.label) ? "Drawing" : "Logo run") : "",
      stats: shown ? fmtDist(shown.route.distance_mi, units) : "",
    }),
    [shown, units],
  );

  // When the answer takes over the screen, show it from the top.
  useEffect(() => {
    if (showResult) aside.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [showResult]);

  // The drawing as a GIF, rendered on a hidden map of its own (always the
  // light day map: it reads best when posted) and downloaded. The map code
  // is loaded on demand, since it can't run on the server.
  const makeGif = async () => {
    if (!shown || gif.busy) return;
    setGif({ busy: true, pct: 0 });
    try {
      const { renderGif, saveBlob } = await import("@/lib/gif");
      const blob = await renderGif({
        style: DAY_STYLE,
        night: false,
        route: shown.route.coords,
        start: shown.route.start,
        finish,
        caption,
        onProgress: (pct) => setGif({ busy: true, pct }),
      });
      saveBlob(blob, `${stem}.gif`);
    } catch (e) {
      console.error("GIF export failed", e);
    } finally {
      setGif({ busy: false, pct: 0 });
    }
  };

  const shareGpx = async () => {
    if (!shown) return;
    const file = new File([shown.gpx], `${stem}.gpx`, { type: "application/gpx+xml" });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: stem });
      else downloadGpx(shown, `${stem}.gpx`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") downloadGpx(shown, `${stem}.gpx`);
    }
  };

  const statusWord = engine === "offline" ? "Offline" : status === "planning" ? "Computing" : engine === "online" ? "Ready" : "Connecting";

  const progressLane = <Stopwatch pct={progress?.pct ?? 0} msg={progress?.msg ?? "Working"} laps={laps} startedAt={startedAt} onStop={cancel} />;

  const notices =
    (engine === "offline" && status !== "error") || (status === "error" && error) ? (
      <div className="space-y-2">
        {engine === "offline" && status !== "error" && (
          <div className="note">The route engine isn&apos;t answering, so runs can&apos;t be mapped right now. Reload in a minute.</div>
        )}
        {status === "error" && error && (
          <div className="note note-red space-y-2">
            <p>{error}</p>
            <div className="flex flex-wrap gap-2">
              {suggest && (
                <button type="button" onClick={() => go(suggest)} className="btn btn-fill btn-sm">
                  Try {BUCKETS.find((b) => b.key === suggest)?.label ?? suggest} instead
                </button>
              )}
              <button type="button" onClick={() => go()} className="btn btn-sm">
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] md:grid-cols-[440px_1fr] md:grid-rows-1">
      <aside
        ref={aside}
        className={`tower panel-scroll overflow-x-hidden overflow-y-auto border-b border-[var(--line)] md:max-h-none md:border-r md:border-b-0 ${showResult ? "max-h-[56dvh]" : "max-h-[64dvh]"}`}
      >
        <div className="checker" aria-hidden="true" />
        <header className="flex items-start justify-between gap-3 px-6 pt-4 pb-3">
          <div className="min-w-0">
            {/* The wordmark: drawmy.run in enamel letters, the .run in orange. */}
            <h1 className="logo font-display" aria-label="drawmy.run">
              <span className="logo-word" aria-hidden="true">
                <span className="logo-draw">DRAWMY</span>
                <span className="logo-run">
                  <span className="logo-period">.</span>RUN
                </span>
              </span>
            </h1>
            <p className="eyebrow mt-1.5 truncate">{engine === "online" && status !== "planning" ? "GPS art for runners" : statusWord}</p>
          </div>
          <Seg
            className="mt-1 shrink-0"
            options={[
              { key: "mi", label: "mi" },
              { key: "km", label: "km" },
            ]}
            value={units}
            onChange={setUnits}
            label="Units"
          />
        </header>
        <div className="rule" />

        {showResult && result && shown ? (
          <div key="result" className="rise">
            <div className="flex items-center justify-between gap-3 px-6 py-4">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                <Icon name="back" />
                Edit
              </button>
              <span className="eyebrow min-w-0 flex-1 truncate text-right">{summary}</span>
            </div>
            {status === "planning" && <div className="px-6 pb-5">{progressLane}</div>}
            {notices && <div className="px-6 pb-4">{notices}</div>}
            {note && (
              <div className="px-6 pb-4">
                <div className="note">{note}</div>
              </div>
            )}

            <section className="space-y-5 px-6 pb-6" key={runKey}>
              {/* The answers as race bibs: the one on show in front, the others peeking out above it. */}
              <BibStack
                options={lanes}
                index={shownIdx}
                onPick={(i) => {
                  userPicked.current = true;
                  setOptIdx(i);
                }}
                planning={status === "planning"}
                actions={{
                  units,
                  canShare,
                  gif,
                  // One GPX button: the share sheet on phones (straight into Strava, Garmin or Komoot), a download elsewhere.
                  onGpx: () => (canShare ? void shareGpx() : downloadGpx(shown, `${stem}.gpx`)),
                  onGif: () => void makeGif(),
                  onTry: (b) => void go(b),
                }}
              />

              <details>
                <summary className="disclose">
                  <Icon name="chevron" />
                  Turn-by-turn · {shown.cues.length} cues
                </summary>
                <PaceBand cues={shown.cues} units={units} total={shown.route.distance_mi} />
              </details>
              <p className="text-[11px] leading-relaxed text-[var(--ink-3)]">
                Load the GPX into{" "}
                <a href="https://support.strava.com/en-us/articles/15402061-uploading-route-files" target="_blank" rel="noopener noreferrer" className="text-[var(--ink-2)] underline underline-offset-2">
                  Strava
                </a>
                , Garmin, or a smartwatch app like{" "}
                <a href="http://www.workoutdoors.net/Routes.html" target="_blank" rel="noopener noreferrer" className="text-[var(--ink-2)] underline underline-offset-2">
                  WorkOutDoors
                </a>{" "}
                and follow the line.
              </p>
            </section>
          </div>
        ) : (
          <div key="setup" className="rise">
            {/* 01 Draw */}
            <section className="px-6 py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div className="step font-display">
                  <span className="num">01</span>
                  <span>Draw</span>
                </div>
                <Seg
                  options={MODES.map((m) => ({ key: m.key, label: m.label, title: m.hint }))}
                  value={mode}
                  onChange={setMode}
                  label="Words, a drawing or an image"
                />
              </div>
              {mode === "text" ? (
                <div key="text" className="rise">
                  <FlapWord
                    value={text}
                    onChange={setText}
                    onEnter={() => {
                      if (canGo) void go();
                    }}
                    maxLength={MAX_CHARS}
                  />
                  <div className="mt-3 flex justify-between gap-3 text-xs text-[var(--ink-2)]">
                    {/* The distance keys say what fits; a word is only spoken of here when nothing does. */}
                    <span>
                      {est?.message && (fits ? fitting.length === 0 : !est.ok) ? <span className="text-[#ffb545]">{est.message}</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--ink-3)]">
                      {text.length}/{MAX_CHARS}
                    </span>
                  </div>
                </div>
              ) : mode === "draw" ? (
                <div key="draw" className="rise">
                  <DrawPad strokes={draw} onChange={setDraw} />
                </div>
              ) : (
                <div key="image" className="rise">
                  <label className="well flex cursor-pointer items-center gap-3 p-3">
                    {imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imageUrl} alt="" className="h-14 w-14 rounded bg-white object-contain" />
                    ) : (
                      <div className="flex h-14 w-14 items-center justify-center rounded bg-[var(--panel-3)] text-[var(--ink-3)]">
                        <Icon name="image" className="h-6 w-6" />
                      </div>
                    )}
                    <div className="min-w-0 text-sm">
                      <div className="truncate font-semibold">{image ? image.name : "Choose a logo or a simple drawing"}</div>
                      <div className="text-xs text-[var(--ink-2)]">Bold, simple shapes work best.</div>
                    </div>
                    <input
                      type="file"
                      accept="image/*,.svg,.heic,.heif"
                      className="hidden"
                      onChange={(e) => void onImage(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {image && (
                    <div className="mt-2 flex justify-end">
                      <button type="button" onClick={() => void onImage(null)} className="btn btn-sm">
                        <Icon name="eraser" />
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
            <div className="rule" />

            {/* 02 Start */}
            <section className="px-6 py-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="step font-display">
                  <span className="num">02</span>
                  <span>Start</span>
                </div>
                <button type="button" onClick={useMyLocation} className="btn btn-sm">
                  <Icon name="locate" />
                  My location
                </button>
              </div>
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const list = places.length ? places : await searchPlaces(query, pin ?? undefined).catch(() => []);
                    if (list[0]) pickPlace(list[0]);
                  }}
                  placeholder={pin ? pinLabel : "Address or place"}
                  aria-label="Start address or place"
                  title={pin ? `Pinned at ${pinLabel}. Drag the pin or tap the map to move it.` : undefined}
                  className="field"
                />
                {(places.length > 0 || searching) && query.trim().length >= 3 && (
                  <ul className="menu" aria-label="Places">
                    {searching && places.length === 0 && <li className="menu-note">Searching…</li>}
                    {places.map((p, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => pickPlace(p)} className="menu-item">
                          {p.label}
                          {p.detail && <small>{p.detail}</small>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
            <div className="rule" />

            {/* 03 Distance, with the loop switch in its corner */}
            <section className="px-6 py-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="step font-display">
                  <span className="num">03</span>
                  <span>How far</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="eyebrow">Loop</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={loop}
                    aria-label="Perfect loop: finish where you start"
                    title="Perfect loop: finish where you start"
                    className="switch"
                    onClick={() => setLoop((x) => !x)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Distance">
                {BUCKETS.map((b) => {
                  const short = Boolean(fits && !fits[b.key]);
                  return (
                    <button
                      key={b.key}
                      type="button"
                      className="tile"
                      aria-pressed={effective === b.key && !short}
                      disabled={short}
                      title={
                        short
                          ? `Too short for this word${est?.need_mi ? `: it needs about ${fmtDist(est.need_mi, units)}` : ""}`
                          : `Up to ${fmtDist(b.cap_mi, units)}`
                      }
                      onClick={() => setBucket(b.key)}
                    >
                      <span className="big-label font-display">{TILE[b.key]}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            <div className="rule" />

            {/* Style: one line or block letters; the middle or the edge of an image. A drawing is always a line. */}
            {mode !== "draw" && (
              <>
                <section className="flex items-center justify-between gap-4 px-6 py-4">
                  <span className="eyebrow">Style</span>
                  <Seg
                    options={STYLES.map((st) => ({ key: st.key, label: st.label, title: mode === "text" ? st.textHint : st.imageHint }))}
                    value={style}
                    onChange={setStyle}
                    label="Drawing style"
                  />
                </section>
                <div className="rule" />
              </>
            )}

            {/* Go: pinned to the bottom of the column on wide screens */}
            <section className="space-y-3 px-6 py-4 md:sticky md:bottom-0 md:z-10 md:bg-[var(--panel)] md:shadow-[0_-16px_24px_rgba(18,18,21,0.9)]">
              {status === "planning" ? (
                progressLane
              ) : (
                <div className="space-y-3">
                  <button type="button" disabled={!canGo} onClick={() => go()} className="go font-display">
                    Draw my run
                    <Icon name="chevrons" />
                  </button>
                  {result && shown && (
                    <button type="button" onClick={() => setEditing(false)} className="btn btn-block">
                      Back to the route
                      <Icon name="forward" />
                    </button>
                  )}
                </div>
              )}
              {notices}
            </section>
          </div>
        )}

      </aside>

      <main className="map-bezel relative min-h-[36dvh] bg-[var(--bg)]">
        <MapView
          pin={pin}
          picking={!showResult}
          onPick={onPick}
          focus={focus}
          route={routeCoords}
          ideal={shown?.drawing.ideal ?? null}
          start={shown?.route.start ?? null}
          finish={finish}
        />
      </main>
    </div>
  );
}
