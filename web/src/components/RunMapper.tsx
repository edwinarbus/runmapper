"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_URL,
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
  fileStem,
  fmtDist,
  gpxFileName,
  planRun,
} from "@/lib/api";
import { type Place, searchPlaces } from "@/lib/geocode";
import { distanceMarkers } from "@/lib/geo";
import { prepareUpload } from "@/lib/image";
import Icon from "./Icon";
import type { LatLon } from "./MapView";
import WordPreview from "./WordPreview";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#141417]" />,
});

const MAX_CHARS = 12;
type Mode = "text" | "image";
type Status = "idle" | "planning" | "done" | "error";

// How a verdict reads: the tag on the card, the word on a lane, its colour.
const VERDICT: Record<string, { label: string; word: string; cls: string }> = {
  great: { label: "Great match", word: "great", cls: "v-great" },
  good: { label: "Good match", word: "good", cls: "v-good" },
  rough: { label: "Rough fit", word: "rough", cls: "v-rough" },
  bad: { label: "No fit", word: "no fit", cls: "v-bad" },
  over: { label: "Too long", word: "too long", cls: "v-bad" },
};
const verdictOf = (v: string) => VERDICT[v] ?? VERDICT.rough;

// Big labels for the distance tiles.
const TILE: Record<Bucket, string> = { "5k": "5K", "10k": "10K", long: "Longer" };

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** The setup behind an answer as a link: the words, where it starts, how far,
 *  loop or not, and the style. Opening it fills the form in; nothing runs. */
function shareUrl(o: PlanOption | PlanResult): string {
  const q = new URLSearchParams();
  q.set("t", o.drawing.label);
  q.set("lat", o.route.start[0].toFixed(5));
  q.set("lon", o.route.start[1].toFixed(5));
  q.set("d", o.bucket.key);
  q.set("loop", o.route.loop ? "1" : "0");
  if (o.drawing.style && o.drawing.style !== "auto") q.set("s", o.drawing.style);
  return `${window.location.origin}${window.location.pathname}?${q}`;
}

export default function RunMapper() {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [image, setImage] = useState<File | null>(null);
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
  const [showIdeal, setShowIdeal] = useState(false);
  const [est, setEst] = useState<EstimateResult | null>(null);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [units, setUnits] = useState<Units>("km");
  const [engine, setEngine] = useState<"checking" | "online" | "offline">("checking");
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const focusKey = useRef(0);
  const touched = useRef(false);           // the pin was chosen on purpose; don't let geolocation move it
  const aside = useRef<HTMLElement>(null);

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
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Try the browser's location once, quietly, so the map opens near the user.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (touched.current) return;
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setPin(p);
        setPinLabel("Your location");
        setFocus({ ...p, zoom: 13, key: ++focusKey.current });
      },
      () => undefined,
      { maximumAge: 600000, timeout: 8000 },
    );
  }, []);

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

  const onPick = useCallback((p: LatLon) => {
    touched.current = true;
    setPin(p);
    setPinLabel(`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
  }, []);

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

  const textOk = mode === "text" && text.trim().length > 0 && text.trim().length <= MAX_CHARS && (est ? est.ok : true);
  const canGo = pin !== null && status !== "planning" && ((mode === "text" && textOk) || (mode === "image" && image !== null));

  const go = async (useBucket: Bucket = bucket) => {
    if (!pin) return;
    if (useBucket !== bucket) setBucket(useBucket);
    setStatus("planning");
    setResult(null);
    setEditing(false);
    setRunKey((k) => k + 1);
    setError(null);
    setSuggest(null);
    setShowIdeal(false);
    setProgress({ type: "progress", stage: "start", pct: 1, msg: "Starting" });
    const ctl = new AbortController();
    abort.current = ctl;
    userPicked.current = false;
    const arrived: PlanOption[] = [];
    try {
      const r = await planRun(
        { text: mode === "text" ? text : undefined, image: mode === "image" ? image : null, lat: pin.lat, lon: pin.lon, bucket: useBucket, loop, style },
        setProgress,
        ctl.signal,
        (o) => {
          // Show each route the moment it is found: the card and the map
          // follow the newest one unless the user has picked a lane.
          const { type: _t, index, ...opt } = o;
          void _t;
          arrived[index] = opt;
          const first = arrived.find(Boolean);
          if (!first) return;
          setResult({ ...first, type: "result", options: arrived.filter(Boolean) });
          if (!userPicked.current) setOptIdx(arrived.filter(Boolean).length - 1);
        },
      );
      // The final answer repeats the streamed options; keep those objects so
      // the route on show is not redrawn.
      setResult(arrived.length && r.options && r.options.length === arrived.filter(Boolean).length ? { ...r, options: arrived.filter(Boolean) } : r);
      if (!arrived.length) setOptIdx(0);
      setStatus("done");
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setStatus("idle");
      } else {
        setError(e instanceof PlanError ? e.message : `Something went wrong: ${(e as Error).message}`);
        setSuggest(e instanceof PlanError ? e.suggest : null);
        setStatus("error");
      }
    } finally {
      abort.current = null;
    }
  };

  const cancel = () => abort.current?.abort();

  // The option on show: one of the answers, or the result itself when there is only one.
  const shown: PlanOption | PlanResult | null = result ? (result.options?.[optIdx] ?? result) : null;
  const routeCoords = useMemo(() => shown?.route.coords ?? null, [shown]);
  const finish = useMemo<[number, number] | null>(
    () => (shown && !shown.route.loop && shown.route.coords.length > 1 ? shown.route.coords[shown.route.coords.length - 1] : null),
    [shown],
  );
  const markers = useMemo(() => (shown ? distanceMarkers(shown.route.coords, units === "mi" ? 1609.344 : 1000) : []), [shown, units]);

  const v = shown ? verdictOf(shown.verdict) : null;
  const distPrimary = shown ? (units === "mi" ? shown.route.distance_mi : shown.route.distance_km).toFixed(2) : "";
  const distSecondary = shown ? (units === "mi" ? `${shown.route.distance_km.toFixed(2)} km` : `${shown.route.distance_mi.toFixed(2)} mi`) : "";
  const climbPrimary =
    shown && shown.route.gain_ft != null ? (units === "mi" ? `${Math.round(shown.route.gain_ft)} ft` : `${Math.round(shown.route.gain_ft * 0.3048)} m`) : null;
  const lanes = result?.options ?? [];
  const showLanes = lanes.length > 1 || (status === "planning" && lanes.length > 0);
  const showResult = Boolean(result && shown && !editing);
  const drawingLabel = shown ? (shown.drawing.kind === "text" ? `“${shown.drawing.label}”` : "your image") : "";
  const summary = shown ? [drawingLabel, TILE[shown.bucket.key] ?? shown.bucket.label, shown.route.loop ? "Loop" : "One way"].join(" · ") : "";
  const caption = shown ? `${shown.drawing.kind === "text" ? `“${shown.drawing.label}”` : "Logo run"} · ${fmtDist(shown.route.distance_mi, units)} · runmapper.run` : "";
  const styleHint = STYLES.find((s) => s.key === style);

  // When the answer takes over the screen, show it from the top.
  useEffect(() => {
    if (showResult) aside.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [showResult]);

  // Why the start button is off, in one line under it.
  const reason = (() => {
    if (status === "planning" || canGo) return "";
    if (engine === "offline") return "The route engine is offline.";
    const needDraw = mode === "text" ? !text.trim() : !image;
    if (needDraw && !pin) return mode === "text" ? "Type a word and pick a start." : "Add an image and pick a start.";
    if (needDraw) return mode === "text" ? "Type a word to draw." : "Add an image to draw.";
    if (mode === "text" && est && !est.ok) return "";
    if (!pin) return "Pick a start: search a place or tap the map.";
    return "";
  })();

  const copyLink = async () => {
    if (!shown) return;
    const url = shareUrl(shown);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link", url);
    }
  };

  const shareGpx = async () => {
    if (!shown) return;
    const file = new File([shown.gpx], gpxFileName(shown.name), { type: "application/gpx+xml" });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: shown.name });
      else downloadGpx(shown);
    } catch (e) {
      if ((e as Error).name !== "AbortError") downloadGpx(shown);
    }
  };

  const dotCls = engine === "offline" ? "dot-red" : status === "planning" ? "dot-busy" : engine === "online" ? "" : "dot-off";
  const statusWord = engine === "offline" ? "Offline" : status === "planning" ? "Computing" : engine === "online" ? "Ready" : "Connecting";

  const progressLane = (
    <div className="space-y-2.5">
      <div className="bar" role="progressbar" aria-valuenow={progress?.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className="bar-fill" style={{ width: `${Math.max(4, progress?.pct ?? 0)}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[13px] text-[var(--ink-2)]">
        <span className="min-w-0 truncate" aria-live="polite">
          {progress?.msg ?? "Working"}…
        </span>
        <button type="button" onClick={cancel} className="btn btn-sm shrink-0">
          <Icon name="stop" className="text-[#ff6b61]" />
          Stop
        </button>
      </div>
    </div>
  );

  const notices =
    (engine === "offline" && status !== "error") || (status === "error" && error) ? (
      <div className="space-y-2">
        {engine === "offline" && status !== "error" && (
          <div className="note">
            The route engine at <span className="font-mono text-xs">{API_URL || "/api"}</span> isn&apos;t answering, so runs can&apos;t be mapped right
            now. Reload in a minute.
          </div>
        )}
        {status === "error" && error && (
          <div className="note note-red space-y-2">
            <p>{error}</p>
            {suggest && (
              <button type="button" onClick={() => go(suggest)} className="btn btn-fill btn-sm">
                Try {BUCKETS.find((b) => b.key === suggest)?.label ?? suggest} instead
              </button>
            )}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] md:grid-cols-[440px_1fr] md:grid-rows-1">
      <aside
        ref={aside}
        className={`tower panel-scroll overflow-y-auto border-b border-[var(--line)] md:max-h-none md:border-r md:border-b-0 ${showResult ? "max-h-[56dvh]" : "max-h-[64dvh]"}`}
      >
        <div className="checker" aria-hidden="true" />
        <header className="flex items-start justify-between gap-3 px-6 pt-4 pb-3">
          <div className="min-w-0">
            <h1 className="font-display text-[2.2rem] leading-none text-[var(--orange)] sm:text-[2.7rem]">RUNMAPPER</h1>
            <p className="eyebrow mt-2 truncate">
              <span className={`dot ${dotCls}`} aria-hidden="true" />
              {statusWord}
              <span className="hidden sm:inline"> · GPS art for runners</span>
            </p>
          </div>
          <div className="seg mt-1 shrink-0 grid-cols-2" role="group" aria-label="Units">
            <button type="button" className="seg-btn" aria-pressed={units === "mi"} onClick={() => setUnits("mi")}>
              mi
            </button>
            <button type="button" className="seg-btn" aria-pressed={units === "km"} onClick={() => setUnits("km")}>
              km
            </button>
          </div>
        </header>
        <div className="rule" />

        {showResult && result && shown && v ? (
          <div className="rise">
            <div className="flex items-center justify-between gap-3 px-6 py-4">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                <Icon name="back" />
                Edit
              </button>
              <span className="eyebrow min-w-0 flex-1 truncate text-right">{summary}</span>
            </div>
            {status === "planning" && <div className="px-6 pb-4">{progressLane}</div>}
            {notices && <div className="px-6 pb-4">{notices}</div>}

            <section className="space-y-4 px-6 pb-6" key={runKey}>
              {showLanes && (
                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${lanes.length + (status === "planning" ? 1 : 0)}, minmax(0, 1fr))` }}>
                  {lanes.map((o, i) => {
                    const ov = verdictOf(o.verdict);
                    return (
                      <button
                        key={i}
                        type="button"
                        className="lane"
                        aria-pressed={i === optIdx}
                        onClick={() => {
                          userPicked.current = true;
                          setOptIdx(i);
                        }}
                      >
                        <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                          <span className="lane-no font-display">{i + 1}</span>
                          <span className="font-display text-[1.1rem] capitalize leading-none tracking-[0.06em]">{o.label}</span>
                        </div>
                        <div className="mt-2 text-[11px] leading-tight text-[var(--ink-2)]">
                          {o.route.starts_at_pin || o.route.from_pin_mi <= 0.04 ? "at your pin" : `${fmtDist(o.route.from_pin_mi, units)} away`}
                        </div>
                        <div className={`mt-0.5 text-[11px] font-bold leading-tight ${ov.cls}`}>
                          {ov.word} · {Math.round(o.score.iou * 100)}%
                        </div>
                      </button>
                    );
                  })}
                  {status === "planning" && (
                    <div className="lane lane-ghost" aria-hidden="true">
                      <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                        <span className="lane-no font-display opacity-40">{lanes.length + 1}</span>
                        <span className="font-display text-[1.1rem] leading-none tracking-[0.06em] text-[var(--ink-3)]">Searching</span>
                      </div>
                      <div className="mt-2 text-[11px] leading-tight text-[var(--ink-3)]">farther out…</div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className={`verdict font-display ${v.cls}`}>
                  {v.label} · {Math.round(shown.score.iou * 100)}%
                </span>
                <span className="min-w-0 truncate text-right text-xs text-[var(--ink-2)]">
                  {drawingLabel}
                  {shown.drawing.lines && shown.drawing.lines > 1 ? ` · ${shown.drawing.lines} lines` : ""}
                </span>
              </div>
              {shown.message && <p className="text-[13px] text-[var(--ink-2)]">{shown.message}</p>}
              {shown.suggest_bucket && (
                <button type="button" onClick={() => go(shown.suggest_bucket ?? undefined)} className="btn btn-fill btn-sm">
                  Try {BUCKETS.find((b) => b.key === shown.suggest_bucket)?.label ?? shown.suggest_bucket} instead
                </button>
              )}

              <div className="flex items-end justify-between gap-3 border-y border-[var(--line)] py-4">
                <div>
                  <div className="font-display big tabular-nums">
                    {distPrimary}
                    <span className="big-unit">{units}</span>
                  </div>
                  <div className="eyebrow mt-2 normal-case tracking-[0.04em] text-[var(--ink-2)]">
                    {distSecondary} · {shown.route.loop ? "loop" : "one way"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display flex items-center justify-end gap-1 text-[1.9rem] leading-none tabular-nums">
                    {climbPrimary ? (
                      <>
                        <Icon name="climb" className="h-5 w-5 text-[var(--ink-3)]" />
                        {climbPrimary}
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="eyebrow mt-2 normal-case tracking-[0.04em] text-[var(--ink-2)]">{climbPrimary ? "climb" : "climb · no data"}</div>
                </div>
              </div>

              <div className="text-[13px] leading-snug">
                <div className="flex items-baseline gap-2">
                  <span className="eyebrow shrink-0 text-[var(--orange)]">Start</span>
                  <span className="font-semibold">
                    {shown.route.starts_at_pin ? "Your pin" : shown.route.start_desc}
                    {shown.route.starts_at_pin && <span className="font-normal text-[var(--ink-2)]"> ({shown.route.start_desc})</span>}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--ink-2)]">
                  Head {compass(shown.route.start_bearing)} ({shown.route.start_bearing}°)
                  {shown.route.approach_mi > 0.04 &&
                    ` · includes ${fmtDist(shown.route.approach_mi, units)} getting to the drawing${shown.route.loop ? " and back" : ""}`}
                  {!shown.route.starts_at_pin && shown.route.from_pin_mi > 0.04 && ` · ${fmtDist(shown.route.from_pin_mi, units)} from your pin, where the streets fit better`}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => downloadGpx(shown)} className="btn btn-orange">
                  <Icon name="download" />
                  Download GPX
                </button>
                {canShare && (
                  <button type="button" onClick={() => void shareGpx()} className="btn">
                    <Icon name="share" />
                    Send to app
                  </button>
                )}
                {shown.drawing.kind === "text" && (
                  <button type="button" onClick={() => void copyLink()} className="btn">
                    <Icon name={copied ? "check" : "link"} />
                    {copied ? "Copied" : "Copy link"}
                  </button>
                )}
                <button type="button" onClick={() => setShowIdeal((s) => !s)} className="btn" aria-pressed={showIdeal}>
                  <Icon name="eye" />
                  {showIdeal ? "Hide target" : "Target shape"}
                </button>
              </div>

              <details className="text-[13px]">
                <summary className="cursor-pointer text-[var(--ink-2)]">Turn-by-turn ({shown.cues.length} cues)</summary>
                <ol className="cues mt-2 max-h-64 overflow-auto pr-1 text-xs">
                  {shown.cues.map((c) => (
                    <li key={c.n} className="flex gap-2 py-1.5">
                      <span className="w-16 shrink-0 tabular-nums text-[var(--ink-3)]">{fmtDist(c.cum_mi, units)}</span>
                      <span>
                        {c.word} <span className="font-medium text-[var(--ink)]">{c.street}</span> for {fmtDist(c.mi, units)}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
              <p className="text-[11px] leading-relaxed text-[var(--ink-3)]">
                Load the GPX into Strava, Garmin or your watch app and follow the line. Retraced streets are normal: they draw on top of each other.
              </p>
            </section>
          </div>
        ) : (
          <div>
            {/* 01 Draw */}
            <section className="px-6 py-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="step font-display">
                  <span className="num">01</span>
                  <span>Draw</span>
                </div>
                <div className="seg grid-cols-2" role="group" aria-label="Words or image">
                  {(["text", "image"] as Mode[]).map((m) => (
                    <button key={m} type="button" className="seg-btn" aria-pressed={mode === m} onClick={() => setMode(m)}>
                      {m === "text" ? "Words" : "Image"}
                    </button>
                  ))}
                </div>
              </div>
              {mode === "text" ? (
                <div>
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canGo) void go();
                    }}
                    placeholder="RUN"
                    maxLength={MAX_CHARS}
                    autoCapitalize="characters"
                    aria-label="Words to draw"
                    className="field field-word font-display"
                  />
                  <div className="mt-3 h-[96px]">
                    {est?.strokes && est.strokes.length > 0 ? (
                      <WordPreview strokes={est.strokes} />
                    ) : (
                      <div className="wp-empty">
                        <span className="eyebrow">{text.trim() ? "Tracing…" : "Your word, run as a route"}</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-3 flex justify-between gap-3 text-xs text-[var(--ink-2)]">
                    <span>
                      {est?.message ? (
                        <span className={est.ok ? "" : "text-[#ffb545]"}>{est.message}</span>
                      ) : est?.fits ? (
                        <span>
                          Fits{" "}
                          {BUCKETS.filter((b) => est.fits?.[b.key])
                            .map((b) => TILE[b.key])
                            .join(" · ") || "nothing yet"}
                        </span>
                      ) : (
                        "Up to 12 letters, digits, space and ! ? - . ' +"
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--ink-3)]">
                      {text.length}/{MAX_CHARS}
                    </span>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-[var(--line-2)] p-3 transition hover:border-[rgba(255,255,255,0.4)]">
                    {imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imageUrl} alt="" className="h-14 w-14 rounded bg-white object-contain" />
                    ) : (
                      <div className="flex h-14 w-14 items-center justify-center rounded bg-[var(--panel-3)] text-[var(--ink-3)]">
                        <Icon name="image" className="h-6 w-6" />
                      </div>
                    )}
                    <div className="text-sm">
                      <div className="font-semibold">{image ? image.name : "Drop a logo or simple drawing here"}</div>
                      <div className="text-xs text-[var(--ink-2)]">PNG, JPG or SVG. Bold, simple shapes work best.</div>
                    </div>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg"
                      className="hidden"
                      onChange={(e) => void onImage(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {image && (
                    <button type="button" onClick={() => void onImage(null)} className="mt-2 text-xs text-[var(--ink-2)] underline underline-offset-2">
                      Remove image
                    </button>
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
                  placeholder="Address or place, then Enter"
                  aria-label="Start address or place"
                  className="field"
                />
                {(places.length > 0 || searching) && query.trim().length >= 3 && (
                  <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] text-sm shadow-2xl">
                    {searching && places.length === 0 && <li className="px-3 py-2 text-[var(--ink-2)]">Searching…</li>}
                    {places.map((p, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => pickPlace(p)} className="block w-full px-3 py-2 text-left hover:bg-[var(--panel-3)]">
                          <div className="font-medium">{p.label}</div>
                          {p.detail && <div className="text-xs text-[var(--ink-2)]">{p.detail}</div>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="mt-2 text-xs text-[var(--ink-2)]">
                {pin ? (
                  <>
                    <span className="font-semibold text-[var(--ink)]">Pinned:</span> {pinLabel}. Drag the pin or tap the map to move it. The run starts here,
                    or as near as a good drawing allows.
                  </>
                ) : (
                  "Type your address, or tap the map to drop a pin."
                )}
              </p>
            </section>
            <div className="rule" />

            {/* 03 Distance */}
            <section className="px-6 py-4">
              <div className="step font-display mb-3">
                <span className="num">03</span>
                <span>How far</span>
              </div>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Distance">
                {BUCKETS.map((b) => (
                  <button key={b.key} type="button" className="tile" aria-pressed={bucket === b.key} onClick={() => setBucket(b.key)}>
                    <span className="big-label font-display">{TILE[b.key]}</span>
                    <span className="sub">up to {fmtDist(b.cap_mi, units)}</span>
                  </button>
                ))}
              </div>
            </section>
            <div className="rule" />

            {/* Style and loop */}
            <section className="flex items-start justify-between gap-5 px-6 py-4">
              <div className="min-w-0 flex-1">
                <span className="eyebrow mb-2.5 block">Style</span>
                <div className="seg grid-cols-3" role="group" aria-label="Drawing style">
                  {STYLES.map((st) => (
                    <button
                      key={st.key}
                      type="button"
                      className="seg-btn"
                      aria-pressed={style === st.key}
                      title={mode === "text" ? st.textHint : st.imageHint}
                      onClick={() => setStyle(st.key)}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
                {styleHint && <div className="mt-2 text-[11px] text-[var(--ink-3)]">{mode === "text" ? styleHint.textHint : styleHint.imageHint}</div>}
              </div>
              <div className="shrink-0 text-center">
                <span className="eyebrow mb-2.5 block">Loop</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={loop}
                  aria-label="Perfect loop: finish where you start"
                  title="Perfect loop: finish where you start"
                  className="switch mx-auto mt-[5px] block"
                  onClick={() => setLoop((x) => !x)}
                />
                <div className="mt-2.5 text-[11px] text-[var(--ink-3)]">{loop ? "back to start" : "one way"}</div>
              </div>
            </section>
            <div className="rule" />

            {/* Go: pinned to the bottom of the column on wide screens */}
            <section className="space-y-3 px-6 py-4 md:sticky md:bottom-0 md:z-10 md:bg-[var(--panel)] md:shadow-[0_-16px_24px_rgba(18,18,21,0.9)]">
              {status === "planning" ? (
                progressLane
              ) : (
                <div className="space-y-3">
                  <button type="button" disabled={!canGo} onClick={() => go()} className="go font-display">
                    Map my run
                    <Icon name="chevrons" />
                  </button>
                  {reason && <p className="text-center text-xs text-[var(--ink-2)]">{reason}</p>}
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

        <div className="rule" />
        <footer className="flex items-center justify-between px-6 py-3 text-[11px] text-[var(--ink-3)]">
          <span>© OpenStreetMap contributors</span>
          <span>runmapper.run</span>
        </footer>
      </aside>

      <main className="relative min-h-[36dvh] bg-[var(--bg)]">
        <MapView
          pin={pin}
          onPick={onPick}
          focus={focus}
          route={routeCoords}
          ideal={shown?.drawing.ideal ?? null}
          showIdeal={showIdeal}
          start={shown?.route.start ?? null}
          finish={finish}
          markers={markers}
          caption={caption}
          fileStem={shown ? fileStem(shown.name) : "route"}
        />
      </main>
    </div>
  );
}
