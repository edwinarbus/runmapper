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
  fmtClimb,
  fmtDist,
  planRun,
} from "@/lib/api";
import { type Place, searchPlaces } from "@/lib/geocode";
import { prepareUpload } from "@/lib/image";
import type { LatLon } from "./MapView";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-zinc-100" />,
});

const MAX_CHARS = 12;
type Mode = "text" | "image";
type Status = "idle" | "planning" | "done" | "error";

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  great: { label: "Looks great", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  good: { label: "Good match", cls: "bg-sky-100 text-sky-800 border-sky-200" },
  rough: { label: "Rough", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  bad: { label: "Not this time", cls: "bg-rose-100 text-rose-800 border-rose-200" },
  over: { label: "Too long", cls: "bg-rose-100 text-rose-800 border-rose-200" },
};

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
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Bucket | null>(null);
  const [showIdeal, setShowIdeal] = useState(false);
  const [est, setEst] = useState<EstimateResult | null>(null);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [units, setUnits] = useState<Units>("km");
  const [engine, setEngine] = useState<"checking" | "online" | "offline">("checking");
  const abort = useRef<AbortController | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const focusKey = useRef(0);

  // Try the browser's location once, quietly, so the map opens near the user.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPin((cur) => cur ?? { lat: pos.coords.latitude, lon: pos.coords.longitude });
        setPinLabel((cur) => cur || "Your location");
        setFocus({ lat: pos.coords.latitude, lon: pos.coords.longitude, zoom: 13, key: ++focusKey.current });
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
    setPin({ lat: p.lat, lon: p.lon });
    setPinLabel([p.label, p.detail].filter(Boolean).join(", "));
    setFocus({ lat: p.lat, lon: p.lon, zoom: 13.5, key: ++focusKey.current });
    setQuery("");
    setPlaces([]);
  };

  const onPick = useCallback((p: LatLon) => {
    setPin(p);
    setPinLabel(`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
  }, []);

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
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
  const verdict = shown ? VERDICT_STYLE[shown.verdict] ?? VERDICT_STYLE.rough : null;

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] md:grid-cols-[420px_1fr] md:grid-rows-1">
      <aside className="flex max-h-[62dvh] flex-col overflow-y-auto border-b border-zinc-200 bg-white md:max-h-none md:border-r md:border-b-0">
        <header className="px-5 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-[#FC5200]">run</span>mapper
            </h1>
            <button
              type="button"
              onClick={() => setUnits((u) => (u === "mi" ? "km" : "mi"))}
              className="rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-zinc-400"
              title="Switch between miles and kilometres"
              aria-label={`Units: ${units}. Switch`}
            >
              {units === "mi" ? "mi · ft" : "km · m"}
            </button>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">Draw words and logos with your run</p>
        </header>

        <div className="space-y-5 px-5 pb-6">
          {/* What to draw */}
          <section>
            <div className="mb-2 flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm">
              {(["text", "image"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                    mode === m ? "bg-white shadow-sm text-zinc-900" : "text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  {m === "text" ? "Words" : "Image"}
                </button>
              ))}
            </div>
            {mode === "text" ? (
              <div>
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
                  placeholder="RUN, HELLO, SF 2026…"
                  maxLength={MAX_CHARS}
                  autoCapitalize="characters"
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 font-mono text-lg uppercase tracking-widest outline-none focus:border-[#FC5200] focus:ring-2 focus:ring-orange-100"
                />
                <div className="mt-1 flex justify-between text-xs text-zinc-500">
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
                      "Letters, digits, space and ! ? - . ' +"
                    )}
                  </span>
                  <span>
                    {text.length}/{MAX_CHARS}
                  </span>
                </div>
              </div>
            ) : (
              <div>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-zinc-300 p-3 hover:border-zinc-400">
                  {imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl} alt="" className="h-14 w-14 rounded bg-zinc-50 object-contain" />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded bg-zinc-100 text-2xl">🖼️</div>
                  )}
                  <div className="text-sm">
                    <div className="font-medium">{image ? image.name : "Upload a logo or simple drawing"}</div>
                    <div className="text-xs text-zinc-500">PNG, JPG or SVG. Bold, simple shapes work best.</div>
                  </div>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg"
                    className="hidden"
                    onChange={(e) => void onImage(e.target.files?.[0] ?? null)}
                  />
                </label>
                {image && (
                  <button type="button" onClick={() => void onImage(null)} className="mt-1 text-xs text-zinc-500 underline">
                    Remove image
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Where */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className="text-sm font-medium">Start address or place</label>
              <button type="button" onClick={useMyLocation} className="text-xs text-[#FC5200] hover:underline">
                Use my location
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
                placeholder="Type an address, then press Enter"
                className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-[#FC5200] focus:ring-2 focus:ring-orange-100"
              />
              {(places.length > 0 || searching) && query.trim().length >= 3 && (
                <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-zinc-200 bg-white text-sm shadow-lg">
                  {searching && places.length === 0 && <li className="px-3 py-2 text-zinc-500">Searching…</li>}
                  {places.map((p, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => pickPlace(p)}
                        className="block w-full px-3 py-2 text-left hover:bg-orange-50"
                      >
                        <div className="font-medium">{p.label}</div>
                        {p.detail && <div className="text-xs text-zinc-500">{p.detail}</div>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              {pin ? (
                <>
                  <span className="font-medium text-zinc-700">Starts at:</span> {pinLabel}. The drawing goes on the streets nearby. Drag the pin or click the map to move it.
                </>
              ) : (
                "Type your address, or click the map to drop a pin where the run should start."
              )}
            </p>
          </section>

          {/* Distance */}
          {/* Style */}
          <section>
            <label className="mb-1.5 block text-sm font-medium">Drawing style</label>
            <div className="grid grid-cols-3 gap-2">
              {STYLES.map((st) => (
                <button
                  key={st.key}
                  type="button"
                  onClick={() => setStyle(st.key)}
                  className={`rounded-lg border px-2 py-2 text-sm transition ${
                    style === st.key
                      ? "border-[#FC5200] bg-orange-50 text-zinc-900"
                      : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                  }`}
                >
                  <div className="font-semibold">{st.label}</div>
                  <div className="text-[11px] text-zinc-500">{mode === "text" ? st.textHint : st.imageHint}</div>
                </button>
              ))}
            </div>
          </section>

          <section>
            <label className="mb-1.5 block text-sm font-medium">Distance</label>
            <div className="grid grid-cols-3 gap-2">
              {BUCKETS.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setBucket(b.key)}
                  className={`rounded-lg border px-2 py-2 text-sm transition ${
                    bucket === b.key
                      ? "border-[#FC5200] bg-orange-50 text-zinc-900"
                      : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                  }`}
                >
                  <div className="font-semibold">{b.label}</div>
                  <div className="text-[11px] text-zinc-500">up to {fmtDist(b.cap_mi, units)}</div>
                </button>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} className="h-4 w-4 accent-[#FC5200]" />
              Perfect loop (finish where you start)
            </label>
          </section>

          {/* Go */}
          {status === "planning" ? (
            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                <div className="h-full bg-[#FC5200] transition-all duration-500" style={{ width: `${progress?.pct ?? 0}%` }} />
              </div>
              <div className="flex items-center justify-between text-sm text-zinc-600">
                <span>{progress?.msg ?? "Working"}…</span>
                <button type="button" onClick={cancel} className="text-xs text-zinc-500 underline">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canGo}
              onClick={() => go()}
              className="w-full rounded-lg bg-[#FC5200] px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-[#e04900] disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              Map my run
            </button>
          )}

          {engine === "offline" && status !== "error" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                The route engine at <span className="font-mono text-xs">{API_URL || "/api"}</span> isn&apos;t answering, so runs
                can&apos;t be mapped right now. Reload in a minute; if it keeps happening, check the engine logs.
              </p>
            </div>
          )}

          {status === "error" && error && (
            <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <p>{error}</p>
              {suggest && (
                <button
                  type="button"
                  onClick={() => go(suggest)}
                  className="rounded-md bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
                >
                  Try {BUCKETS.find((b) => b.key === suggest)?.label ?? suggest} instead
                </button>
              )}
            </div>
          )}

          {/* Result */}
          {result && shown && verdict && (
            <section className="space-y-3 rounded-xl border border-zinc-200 p-4">
              {result.options && result.options.length > 1 && (
                <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${result.options.length}, minmax(0, 1fr))` }}>
                  {result.options.map((o, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        userPicked.current = true;
                        setOptIdx(i);
                      }}
                      aria-pressed={i === optIdx}
                      className={`rounded-lg border px-2 py-1.5 text-left text-xs transition ${
                        i === optIdx ? "border-[#FC5200] bg-orange-50 text-zinc-900" : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                      }`}
                    >
                      <div className="font-semibold capitalize">{o.label}</div>
                      <div className="text-[11px] text-zinc-500">
                        {o.route.starts_at_pin || o.route.from_pin_mi <= 0.04 ? "at your pin" : `${fmtDist(o.route.from_pin_mi, units)} away`}
                        {" · "}
                        {(VERDICT_STYLE[o.verdict] ?? VERDICT_STYLE.rough).label.toLowerCase()} {Math.round(o.score.iou * 100)}%
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${verdict.cls}`}>{verdict.label}</span>
                <span className="text-xs text-zinc-500">
                  {shown.drawing.kind === "text" ? `“${shown.drawing.label}”` : "your image"} · match {Math.round(shown.score.iou * 100)}%
                </span>
              </div>
              {shown.message && <p className="text-sm text-zinc-700">{shown.message}</p>}
              {shown.suggest_bucket && (
                <button
                  type="button"
                  onClick={() => go(shown.suggest_bucket ?? undefined)}
                  className="rounded-md bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
                >
                  Try {BUCKETS.find((b) => b.key === shown.suggest_bucket)?.label ?? shown.suggest_bucket} instead
                </button>
              )}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-zinc-500">Distance</dt>
                  <dd className="font-semibold">{fmtDist(shown.route.distance_mi, units, true)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Climb</dt>
                  <dd className="font-semibold">
                    {shown.route.gain_ft != null ? (
                      fmtClimb(shown.route.gain_ft, units)
                    ) : (
                      <span className="font-normal text-zinc-500">not available</span>
                    )}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-zinc-500">Start</dt>
                  <dd className="font-semibold">
                    {shown.route.starts_at_pin ? "Your pin" : shown.route.start_desc}
                    {shown.route.starts_at_pin && (
                      <span className="font-normal text-zinc-500"> ({shown.route.start_desc})</span>
                    )}{" "}
                    <span className="font-normal text-zinc-500">
                      · {shown.route.loop ? "loop" : "one way"} · head {shown.route.start_bearing}°
                    </span>
                    {shown.route.approach_mi > 0.04 && (
                      <div className="text-xs font-normal text-zinc-500">
                        includes {fmtDist(shown.route.approach_mi, units)} getting to the drawing{shown.route.loop ? " and back" : ""}
                      </div>
                    )}
                    {!shown.route.starts_at_pin && shown.route.from_pin_mi > 0.04 && (
                      <div className="text-xs font-normal text-zinc-500">
                        {fmtDist(shown.route.from_pin_mi, units)} from your pin, where the streets fit better
                      </div>
                    )}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => downloadGpx(shown)}
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
                >
                  Download GPX
                </button>
                <button
                  type="button"
                  onClick={() => setShowIdeal((v) => !v)}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:border-zinc-400"
                >
                  {showIdeal ? "Hide" : "Show"} target shape
                </button>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-zinc-600">Turn-by-turn ({shown.cues.length} cues)</summary>
                <ol className="mt-2 max-h-64 space-y-1 overflow-auto pr-1 text-xs">
                  {shown.cues.map((c) => (
                    <li key={c.n} className="flex gap-2">
                      <span className="w-16 shrink-0 tabular-nums text-zinc-400">{fmtDist(c.cum_mi, units)}</span>
                      <span>
                        {c.word} <span className="font-medium">{c.street}</span> for {fmtDist(c.mi, units)}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
              <p className="text-xs text-zinc-500">
                Load the GPX into Strava, Garmin, Apple Watch (WorkOutDoors) or your phone, then follow the line. Retraced streets are normal: Strava draws them on top of each other.
              </p>
            </section>
          )}

          <footer className="pt-2 text-[11px] leading-relaxed text-zinc-400">
            Streets from OpenStreetMap. Placement and snapping are plain geometry: the drawing is scaled to the local blocks, laid onto real streets, and scored by how closely the run overlaps the shape.
          </footer>
        </div>
      </aside>

      <main className="relative min-h-[38dvh]">
        <MapView pin={pin} onPick={onPick} focus={focus} route={routeCoords} ideal={shown?.drawing.ideal ?? null} showIdeal={showIdeal} start={shown?.route.start ?? null} />
      </main>
    </div>
  );
}
