// Client for the runmapper engine API (see engine/runmapper_engine/api.py).
// One POST /api/plan request streams newline-delimited JSON: progress events,
// then a single result or error line.

// Empty means same-origin: /api/* is the Python function on Vercel, or the
// dev-server proxy to uvicorn (next.config.ts). NEXT_PUBLIC_API_URL overrides.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

/** True when GET /api/health answers within a few seconds. */
export async function checkHealth(timeoutMs = 6000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}/api/health`, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) return false;
    const j = await res.json();
    return j?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type Bucket = "5k" | "10k" | "long";

// Distance caps mirror BUCKETS in engine/runmapper_engine/pipeline.py.
export const BUCKETS: { key: Bucket; label: string; cap_mi: number }[] = [
  { key: "5k", label: "~5K", cap_mi: 3.6 },
  { key: "10k", label: "~10K", cap_mi: 6.8 },
  { key: "long", label: "Longer", cap_mi: 13.5 },
];

export type Units = "mi" | "km";

/** How the drawing is traced: auto (one line for words, closest match for
 *  images), line (one line), or outline (block letters / the image's edge). */
export type Style = "auto" | "line" | "outline";
export const STYLES: { key: Style; label: string; textHint: string; imageHint: string }[] = [
  { key: "auto", label: "Auto", textHint: "one line per letter", imageHint: "closest match" },
  { key: "line", label: "Line", textHint: "one line per letter", imageHint: "a single line" },
  { key: "outline", label: "Outline", textHint: "block letters", imageHint: "trace the edge" },
];
const MI_KM = 1.609344;
const FT_M = 0.3048;

/** Miles or kilometres, primary unit first. */
export function fmtDist(mi: number, units: Units, both = false): string {
  const a = units === "mi" ? `${mi.toFixed(2)} mi` : `${(mi * MI_KM).toFixed(2)} km`;
  if (!both) return a;
  const b = units === "mi" ? `${(mi * MI_KM).toFixed(2)} km` : `${mi.toFixed(2)} mi`;
  return `${a} (${b})`;
}

export function fmtClimb(ft: number, units: Units): string {
  return units === "mi" ? `${Math.round(ft)} ft (${Math.round(ft * FT_M)} m)` : `${Math.round(ft * FT_M)} m (${Math.round(ft)} ft)`;
}

/** Only the US, Liberia and Myanmar run in miles. */
export function detectUnits(): Units {
  const lang = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return /-(US|LR|MM)$/i.test(lang) ? "mi" : "km";
}

export interface ProgressEvent {
  type: "progress";
  stage: string;
  pct: number;
  msg: string;
}

export interface Cue {
  n: number;
  word: string;
  street: string;
  mi: number;
  cum_mi: number;
  lat: number;
  lon: number;
}

export interface PlanResult {
  type: "result";
  ok: boolean;
  verdict: "great" | "good" | "rough" | "bad" | "over";
  message: string;
  suggest_bucket?: Bucket | null;
  score: { iou: number; cover: number; prec: number };
  route: {
    coords: [number, number][];
    distance_mi: number;
    distance_km: number;
    gain_ft: number | null;
    gain_m: number | null;
    loss_ft: number | null;
    max_grade_pct: number | null;
    loop: boolean;
    start: [number, number];
    start_desc: string;
    start_bearing: number;
    starts_at_pin: boolean;
    approach_mi: number;
    from_pin_mi: number;
    width_mi: number;
    n_points: number;
  };
  drawing: { kind: string; style?: string; label: string; lines?: number; strokes: number; ideal: [number, number][][] };
  bucket: { key: Bucket; label: string; cap_mi: number };
  cues: Cue[];
  gpx: string;
  name: string;
  timing?: { total_s: number; snaps: number; dijkstra: number; nodes: number; spots?: number };
  grid?: { bearing: number; regularity: number; rot: number; aspect: number; size_kind: string };
  /** Up to three answers, nearest first: the best fit close to the pin, a
   *  better one a bit farther, and the best fit farther still. The top-level
   *  fields repeat the first option. */
  options?: PlanOption[];
}

export type PlanOption = Omit<PlanResult, "options" | "type" | "timing"> & { label: string };
/** Streamed while planning: one answer, the moment it is ready. */
export type PlanOptionEvent = PlanOption & { type: "option"; index: number };

export interface PlanInput {
  text?: string;
  image?: File | null;
  lat: number;
  lon: number;
  bucket: Bucket;
  loop: boolean;
  style?: Style;
}

export class PlanError extends Error {
  suggest: Bucket | null;
  constructor(message: string, suggest: Bucket | null = null) {
    super(message);
    this.suggest = suggest;
  }
}

/** The engine has no record of the search: another worker answered, or it
 *  was too long ago. */
export class GoneError extends Error {}

/** A search in flight: its id on the engine and how many of its lines the
 *  page has read, so a page that lost the stream can ask for the rest. */
export interface PlanJob {
  id: string;
  seen: number;
}

export function newJob(): PlanJob {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  return { id, seen: 0 };
}

const UNREACHABLE = "Couldn't reach the route engine. Check your connection and try again.";
const NO_ANSWER = "The route engine stopped without an answer. Try again.";
const POLL_WAIT_S = 20;        // how long one GET may wait on the engine for a new line
const POLL_PATIENCE_MS = 45_000; // how long the engine may go unreachable before giving up

type Line = { type: string; message?: string; suggest_bucket?: Bucket | null };

/** One line of the search, handed to whoever listens; the result is kept. */
function take(ev: Line, onProgress: (p: ProgressEvent) => void, onOption: ((o: PlanOptionEvent) => void) | undefined, box: { result: PlanResult | null }) {
  if (ev.type === "progress") onProgress(ev as unknown as ProgressEvent);
  else if (ev.type === "option") onOption?.(ev as unknown as PlanOptionEvent);
  else if (ev.type === "result") box.result = ev as unknown as PlanResult;
  else if (ev.type === "error") throw new PlanError(ev.message || "Something went wrong.", ev.suggest_bucket ?? null);
}

/** Waits `ms`, or, while the browser says it is offline, until it is back
 *  online (or `ms` has passed, whichever is later). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", online);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", online);
      reject(new DOMException("aborted", "AbortError"));
    };
    const online = () => {
      timer = setTimeout(done, ms);
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false) window.addEventListener("online", online, { once: true });
    else timer = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function planRun(
  input: PlanInput,
  onProgress: (p: ProgressEvent) => void,
  signal?: AbortSignal,
  onOption?: (o: PlanOptionEvent) => void,
  job?: PlanJob,
): Promise<PlanResult> {
  const fd = new FormData();
  fd.set("text", input.text ?? "");
  fd.set("lat", String(input.lat));
  fd.set("lon", String(input.lon));
  fd.set("bucket", input.bucket);
  fd.set("loop", input.loop ? "true" : "false");
  fd.set("style", input.style ?? "auto");
  if (job) fd.set("job", job.id);
  if (input.image) fd.set("image", input.image, input.image.name);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/plan`, { method: "POST", body: fd, signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new PlanError(UNREACHABLE);
  }
  if (!res.ok || !res.body) {
    let msg = `The route engine answered ${res.status}. Try again in a moment.`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not JSON */
    }
    throw new PlanError(msg);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const box = { result: null as PlanResult | null };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as Line;
      if (job) job.seen++;
      take(ev, onProgress, onOption, box);
    }
  }
  if (!box.result) throw new PlanError(NO_ANSWER);
  return box.result;
}

/** Picks a search back up from its record on the engine after the stream
 *  was lost: the lines the page has not seen, waiting on the engine for new
 *  ones, until the result. Throws GoneError when the engine has no record
 *  of it, and stops asking at `until` (a time). */
export async function resumeRun(
  job: PlanJob,
  onProgress: (p: ProgressEvent) => void,
  signal: AbortSignal | undefined,
  onOption: ((o: PlanOptionEvent) => void) | undefined,
  until: number,
): Promise<PlanResult> {
  let missing = 0;   // when the engine first went unreachable, in this run of misses
  const miss = async (why: string) => {
    missing ||= Date.now();
    if (Date.now() - missing > POLL_PATIENCE_MS) throw new PlanError(why);
    await pause(1500, signal);
  };
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/plan/${encodeURIComponent(job.id)}?after=${job.seen}&wait=${POLL_WAIT_S}`, { signal, cache: "no-store" });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      await miss(UNREACHABLE);
      continue;
    }
    if (res.status === 404) throw new GoneError("no record of the search");
    if (!res.ok) {
      await miss(`The route engine answered ${res.status}. Try again in a moment.`);
      continue;
    }
    missing = 0;
    const j = (await res.json()) as { events: Line[]; done: boolean };
    const box = { result: null as PlanResult | null };
    for (const ev of j.events) {
      job.seen++;
      take(ev, onProgress, onOption, box);
    }
    if (box.result) return box.result;
    if (j.done) throw new PlanError(NO_ANSWER);
    if (Date.now() > until) throw new PlanError("The search took too long. Try again.");
  }
}

/** One stroke of the word as it will be run: normalised points, y down. */
export interface EstimateStroke {
  pts: [number, number][];
  closed: boolean;
}

export interface EstimateResult {
  ok: boolean;
  text?: string;
  need_mi?: number;
  fits?: Record<Bucket, boolean>;
  message?: string | null;
  strokes?: EstimateStroke[];
}

export async function estimate(text: string, bucket: Bucket, loop: boolean, style: Style = "auto"): Promise<EstimateResult> {
  const res = await fetch(`${API_URL}/api/estimate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, bucket, loop, style }),
  });
  if (!res.ok) throw new Error(`estimate failed: ${res.status}`);
  return res.json();
}

/** A file name stem that says which run this is: the word, the distance
 *  and the city, e.g. RUN-3.40mi-San-Francisco. */
export function runFileStem(word: string, distanceMi: number, units: Units, city = ""): string {
  const clean = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const dist = units === "mi" ? `${distanceMi.toFixed(2)}mi` : `${(distanceMi * 1.609344).toFixed(2)}km`;
  return [clean(word).toUpperCase() || "ROUTE", dist, clean(city)].filter(Boolean).join("-");
}

export function downloadGpx(result: { gpx: string }, fileName: string) {
  const blob = new Blob([result.gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
