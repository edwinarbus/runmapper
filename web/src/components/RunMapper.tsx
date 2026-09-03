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
  fmtDist,
  gpxFileName,
  planRun,
} from "@/lib/api";
import { type Place, searchPlaces } from "@/lib/geocode";
import { prepareUpload } from "@/lib/image";
import type { LatLon } from "./MapView";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#e9e9ec]" />,
});

const MAX_CHARS = 12;
type Mode = "text" | "image";
type Status = "idle" | "planning" | "done" | "error";

// How a verdict reads on the bib: the stamp, the word on a lane tab, its colour.
const VERDICT: Record<string, { stamp: string; word: string; stampCls: string; textCls: string }> = {
  great: { stamp: "Great", word: "great", stampCls: "stamp-great", textCls: "text-emerald-700" },
  good: { stamp: "Good match", word: "good", stampCls: "stamp-good", textCls: "text-sky-700" },
  rough: { stamp: "Rough", word: "rough", stampCls: "stamp-rough", textCls: "text-amber-700" },
  bad: { stamp: "No fit", word: "no fit", stampCls: "stamp-bad", textCls: "text-rose-700" },
  over: { stamp: "Too long", word: "too long", stampCls: "stamp-bad", textCls: "text-rose-700" },
};
const verdictOf = (v: string) => VERDICT[v] ?? VERDICT.rough;

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
  const userPicked = useRef(false);        // the user chose a tab while options were still arriving
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

  // Live feasibility check for typed text.
  useEffect(() => {
    const t = setTimeout(() => {
      if (mode !== "text" || !text.trim()) {
        setEst(null);
        return;
      }
      estimate(text, bucket, loop, style).then(setEst).catch(() => setEst(null));
    }, 300);
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
          // follow the newest one unless the user has picked a tab.
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
  const v = shown ? verdictOf(shown.verdict) : null;
  const distPrimary = shown ? (units === "mi" ? shown.route.distance_mi : shown.route.distance_km).toFixed(2) : "";
  const distSecondary = shown ? (units === "mi" ? `${shown.route.distance_km.toFixed(2)} km` : `${shown.route.distance_mi.toFixed(2)} mi`) : "";
  const climbPrimary =
    shown && shown.route.gain_ft != null ? (units === "mi" ? `${Math.round(shown.route.gain_ft)} ft` : `${Math.round(shown.route.gain_ft * 0.3048)} m`) : null;
  const lanes = result?.options ?? [];
  const showLanes = lanes.length > 1 || (status === "planning" && lanes.length > 0);
  const showResult = Boolean(result && shown && !editing);
  const summary = shown
    ? [shown.drawing.kind === "text" ? `“${shown.drawing.label}”` : "Image", shown.bucket.label, shown.route.loop ? "Loop" : "One way"].join(" · ")
    : "";
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

  const progressLane = (
    <div className="space-y-2">
      <div className="track" role="progressbar" aria-valuenow={progress?.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className="track-fill" style={{ width: `${Math.max(5, progress?.pct ?? 0)}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-[#4b4b47]">
        <span className="min-w-0 truncate" aria-live="polite">
          {progress?.msg ?? "Working"}…
        </span>
        <button type="button" onClick={cancel} className="btn-3d btn-stop btn-sm font-display shrink-0 text-base">
          Stop
        </button>
      </div>
    </div>
  );

  const notices = (
    <>
      {engine === "offline" && status !== "error" && (
        <div className="tape text-sm text-[#3d3d39]">
          The route engine at <span className="font-mono text-xs">{API_URL || "/api"}</span> isn&apos;t answering, so runs can&apos;t be mapped
          right now. Reload in a minute.
        </div>
      )}
      {status === "error" && error && (
        <div className="tape tape-red space-y-2 text-sm text-[#3d3d39]">
          <p>{error}</p>
          {suggest && (
            <button type="button" onClick={() => go(suggest)} className="btn-3d btn-dark btn-sm">
              Try {BUCKETS.find((b) => b.key === suggest)?.label ?? suggest} instead
            </button>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="asphalt grid h-dvh grid-rows-[auto_1fr] md:grid-cols-[470px_1fr] md:grid-rows-1">
      <aside ref={aside} className={`panel-scroll overflow-y-auto p-3 md:max-h-none md:p-4 md:pr-0 ${showResult ? "max-h-[56dvh]" : "max-h-[64dvh]"}`}>
        <div className="deck">
          <span className="screw screw-tl" aria-hidden="true" />
          <span className="screw screw-tr" aria-hidden="true" />
          <span className="screw screw-bl" aria-hidden="true" />
          <span className="screw screw-br" aria-hidden="true" />

          {/* Bezel */}
          <header className="px-5 pt-5 pb-3">
            <div className="flex items-center justify-between gap-3">
              <h1 className="font-display text-[2.3rem] leading-none text-white sm:text-[2.6rem]">
                RUN<span className="text-[#FC5200]">MAPPER</span>
              </h1>
              <div className="rocker rocker-sm grid-cols-2" role="group" aria-label="Units">
                <button type="button" className="rocker-key" aria-pressed={units === "mi"} onClick={() => setUnits("mi")}>
                  MI
                </button>
                <button type="button" className="rocker-key" aria-pressed={units === "km"} onClick={() => setUnits("km")}>
                  KM
                </button>
              </div>
            </div>
            <p className="engraved mt-2">
              <span
                className={`led ${engine === "offline" ? "led-red" : status === "planning" ? "led-busy" : engine === "online" ? "" : "led-off"}`}
                aria-hidden="true"
              />
              {engine === "offline" ? "Offline" : status === "planning" ? "Computing" : engine === "online" ? "Ready" : "Connecting"}
              {" · GPS art routes"}
            </p>
          </header>

          {/* Screen */}
          <div className="screen mx-4 mb-3 p-4">
            {showResult && result && shown && v ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <button type="button" className="btn-3d btn-dark btn-sm" onClick={() => setEditing(true)}>
                    ← Edit
                  </button>
                  <span className="screen-label min-w-0 flex-1 truncate text-right">{summary}</span>
                </div>

                {status === "planning" && progressLane}
                {notices}

                {/* The race bib */}
                <section className="bib space-y-3" key={runKey}>
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
                            <div className="lane-no">LANE {i + 1}</div>
                            <div className="text-sm font-bold capitalize leading-tight">{o.label}</div>
                            <div className="text-[11px] leading-tight text-[#6a6a66]">
                              {o.route.starts_at_pin || o.route.from_pin_mi <= 0.04 ? "at your pin" : `${fmtDist(o.route.from_pin_mi, units)} away`}
                            </div>
                            <div className={`text-[11px] font-semibold leading-tight ${ov.textCls}`}>
                              {ov.word} · {Math.round(o.score.iou * 100)}%
                            </div>
                          </button>
                        );
                      })}
                      {status === "planning" && (
                        <div className="lane lane-ghost" aria-hidden="true">
                          <div className="lane-no">LANE {lanes.length + 1}</div>
                          <div className="text-sm font-bold leading-tight">Searching…</div>
                          <div className="text-[11px] leading-tight">farther out</div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className={`stamp font-display ${v.stampCls}`}>{v.stamp}</span>
                    <span className="text-right text-xs text-[#6a6a66]">
                      {shown.drawing.kind === "text" ? `“${shown.drawing.label}”` : "your image"}
                      {shown.drawing.lines && shown.drawing.lines > 1 ? ` · ${shown.drawing.lines} lines` : ""} · match {Math.round(shown.score.iou * 100)}%
                    </span>
                  </div>
                  {shown.message && <p className="text-sm text-[#3d3d39]">{shown.message}</p>}
                  {shown.suggest_bucket && (
                    <button type="button" onClick={() => go(shown.suggest_bucket ?? undefined)} className="btn-3d btn-dark btn-sm">
                      Try {BUCKETS.find((b) => b.key === shown.suggest_bucket)?.label ?? shown.suggest_bucket} instead
                    </button>
                  )}
                  <div className="flex items-end justify-between gap-3 border-y border-dashed border-[#d6d1c4] py-3">
                    <div>
                      <div className="font-display bib-number tabular-nums">
                        {distPrimary}
                        <span className="bib-unit">{units}</span>
                      </div>
                      <div className="mt-1 text-xs text-[#6a6a66]">
                        {distSecondary} · {shown.route.loop ? "perfect loop" : "one way"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-display text-3xl leading-none tabular-nums">{climbPrimary ? `↗ ${climbPrimary}` : "—"}</div>
                      <div className="mt-1 text-xs text-[#6a6a66]">{climbPrimary ? "climb" : "climb · no data"}</div>
                    </div>
                  </div>
                  <div className="text-sm">
                    <span className="lane-no">START</span>{" "}
                    <span className="font-semibold">{shown.route.starts_at_pin ? "Your pin" : shown.route.start_desc}</span>
                    {shown.route.starts_at_pin && <span className="text-[#6a6a66]"> ({shown.route.start_desc})</span>}
                    <span className="text-[#6a6a66]">
                      {" "}
                      · head {compass(shown.route.start_bearing)} ({shown.route.start_bearing}°)
                    </span>
                    {shown.route.approach_mi > 0.04 && (
                      <div className="text-xs text-[#6a6a66]">
                        includes {fmtDist(shown.route.approach_mi, units)} getting to the drawing{shown.route.loop ? " and back" : ""}
                      </div>
                    )}
                    {!shown.route.starts_at_pin && shown.route.from_pin_mi > 0.04 && (
                      <div className="text-xs text-[#6a6a66]">{fmtDist(shown.route.from_pin_mi, units)} from your pin, where the streets fit better</div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => downloadGpx(shown)} className="btn-3d btn-dark">
                      ⤓ Download GPX
                    </button>
                    {canShare && (
                      <button type="button" onClick={() => void shareGpx()} className="btn-3d btn-dark">
                        Send to app…
                      </button>
                    )}
                    <button type="button" onClick={() => setShowIdeal((s) => !s)} className="btn-3d btn-light">
                      {showIdeal ? "Hide" : "Show"} target shape
                    </button>
                    {shown.drawing.kind === "text" && (
                      <button type="button" onClick={() => void copyLink()} className="btn-3d btn-light">
                        {copied ? "Copied ✓" : "Copy link"}
                      </button>
                    )}
                  </div>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-[#6a6a66]">Turn-by-turn ({shown.cues.length} cues)</summary>
                    <ol className="cues mt-2 max-h-64 overflow-auto pr-1 text-xs">
                      {shown.cues.map((c) => (
                        <li key={c.n} className="flex gap-2 py-1">
                          <span className="w-16 shrink-0 tabular-nums text-[#a09d93]">{fmtDist(c.cum_mi, units)}</span>
                          <span>
                            {c.word} <span className="font-medium">{c.street}</span> for {fmtDist(c.mi, units)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </details>
                  <p className="text-[11px] leading-relaxed text-[#8a8880]">
                    Load the GPX into Strava, Garmin, Apple Watch (WorkOutDoors) or your phone and follow the line. Retraced streets are normal: Strava
                    draws them on top of each other.
                  </p>
                </section>
              </div>
            ) : (
              <div className="space-y-5">
                {/* 1. Draw */}
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="screen-label">
                      <b>1</b>Draw
                    </span>
                    <div className="rocker rocker-sm grid-cols-2" role="group" aria-label="Words or image">
                      {(["text", "image"] as Mode[]).map((m) => (
                        <button key={m} type="button" className="rocker-key" aria-pressed={mode === m} onClick={() => setMode(m)}>
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
                        className="field field-big font-display"
                      />
                      <div className="mt-1.5 flex justify-between gap-3 text-xs text-[#6a6a66]">
                        <span>
                          {est?.message ? (
                            <span className={est.ok ? "" : "text-amber-700"}>{est.message}</span>
                          ) : est?.fits ? (
                            <span>
                              Fits{" "}
                              {BUCKETS.filter((b) => est.fits?.[b.key])
                                .map((b) => b.label)
                                .join(", ") || "nothing yet"}
                            </span>
                          ) : (
                            "Up to 12 letters, digits, space and ! ? - . ' +"
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {text.length}/{MAX_CHARS}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="field flex cursor-pointer items-center gap-3 border-dashed">
                        {imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={imageUrl} alt="" className="h-14 w-14 rounded bg-white object-contain" />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-[#ecebe4] text-2xl">🖼️</div>
                        )}
                        <div className="text-sm">
                          <div className="font-semibold">{image ? image.name : "Drop a logo or simple drawing here"}</div>
                          <div className="text-xs text-[#6a6a66]">PNG, JPG or SVG. Bold, simple shapes work best.</div>
                        </div>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg"
                          className="hidden"
                          onChange={(e) => void onImage(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      {image && (
                        <button type="button" onClick={() => void onImage(null)} className="mt-1.5 text-xs text-[#6a6a66] underline">
                          Remove image
                        </button>
                      )}
                    </div>
                  )}
                </section>

                {/* 2. Start */}
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="screen-label">
                      <b>2</b>Start
                    </span>
                    <button type="button" onClick={useMyLocation} className="btn-3d btn-light btn-sm">
                      <span aria-hidden="true">◎</span> My location
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
                      className="field text-sm"
                    />
                    {(places.length > 0 || searching) && query.trim().length >= 3 && (
                      <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-[#d6d1c4] bg-white text-sm shadow-xl">
                        {searching && places.length === 0 && <li className="px-3 py-2 text-[#6a6a66]">Searching…</li>}
                        {places.map((p, i) => (
                          <li key={i}>
                            <button type="button" onClick={() => pickPlace(p)} className="block w-full px-3 py-2 text-left hover:bg-orange-50">
                              <div className="font-medium">{p.label}</div>
                              {p.detail && <div className="text-xs text-[#6a6a66]">{p.detail}</div>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs text-[#6a6a66]">
                    {pin ? (
                      <>
                        <span className="font-semibold text-[#3d3d39]">Pinned:</span> {pinLabel}. Drag the pin or tap the map to move it. The run starts
                        here, or as near as a good drawing allows.
                      </>
                    ) : (
                      "Type your address, or tap the map to drop a pin."
                    )}
                  </p>
                </section>

                {/* 3. Distance */}
                <section>
                  <span className="screen-label mb-2 block">
                    <b>3</b>How far
                  </span>
                  <div className="rocker grid-cols-3" role="group" aria-label="Distance">
                    {BUCKETS.map((b) => (
                      <button key={b.key} type="button" className="rocker-key" aria-pressed={bucket === b.key} onClick={() => setBucket(b.key)}>
                        {b.label}
                        <span className="sub">up to {fmtDist(b.cap_mi, units)}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {/* Options */}
                <section className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <span className="screen-label mb-2 block">Style</span>
                    <div className="rocker rocker-sm grid-cols-3" role="group" aria-label="Drawing style">
                      {STYLES.map((st) => (
                        <button
                          key={st.key}
                          type="button"
                          className="rocker-key"
                          aria-pressed={style === st.key}
                          title={mode === "text" ? st.textHint : st.imageHint}
                          onClick={() => setStyle(st.key)}
                        >
                          {st.label}
                        </button>
                      ))}
                    </div>
                    {styleHint && <div className="mt-1.5 text-[11px] text-[#6a6a66]">{mode === "text" ? styleHint.textHint : styleHint.imageHint}</div>}
                  </div>
                  <div className="shrink-0 text-center">
                    <span className="screen-label mb-2 block">Loop</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={loop}
                      aria-label="Perfect loop: finish where you start"
                      title="Perfect loop: finish where you start"
                      className="toggle"
                      onClick={() => setLoop((x) => !x)}
                    />
                    <div className="mt-1.5 text-[11px] text-[#6a6a66]">{loop ? "back to start" : "one way"}</div>
                  </div>
                </section>

                {/* Go */}
                {status === "planning" ? (
                  progressLane
                ) : (
                  <div className="space-y-2">
                    <button type="button" disabled={!canGo} onClick={() => go()} className="btn-start font-display">
                      Map my run
                    </button>
                    {reason && <p className="text-center text-xs text-[#6a6a66]">{reason}</p>}
                    {result && shown && (
                      <button type="button" onClick={() => setEditing(false)} className="btn-3d btn-light w-full">
                        Back to the route →
                      </button>
                    )}
                  </div>
                )}

                {notices}
              </div>
            )}
          </div>

          <footer className="flex flex-wrap justify-between gap-x-4 px-5 pb-4">
            <p className="engraved text-[10px] tracking-[0.12em]">© OpenStreetMap</p>
            <p className="engraved text-[10px] tracking-[0.12em]">No AI · runmapper.run</p>
          </footer>
        </div>
      </aside>

      <main className="map-frame relative min-h-[36dvh]">
        <MapView
          pin={pin}
          onPick={onPick}
          focus={focus}
          route={routeCoords}
          ideal={shown?.drawing.ideal ?? null}
          showIdeal={showIdeal}
          start={shown?.route.start ?? null}
          finish={finish}
        />
      </main>
    </div>
  );
}
