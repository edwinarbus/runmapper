// Client for the runmapper engine API (see engine/runmapper_engine/api.py).
// One POST /api/plan request streams newline-delimited JSON: progress events,
// then a single result or error line.

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export type Bucket = "5k" | "10k" | "long";

export const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: "5k", label: "~5K", hint: "up to 3.6 mi" },
  { key: "10k", label: "~10K", hint: "up to 6.8 mi" },
  { key: "long", label: "Longer", hint: "up to 13.5 mi" },
];

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
    width_mi: number;
    n_points: number;
  };
  drawing: { kind: string; label: string; strokes: number; ideal: [number, number][][] };
  bucket: { key: Bucket; label: string; cap_mi: number };
  cues: Cue[];
  gpx: string;
  name: string;
  timing?: { total_s: number; snaps: number; dijkstra: number; nodes: number };
  grid?: { bearing: number; regularity: number; rot: number; aspect: number; size_kind: string };
}

export interface PlanInput {
  text?: string;
  image?: File | null;
  lat: number;
  lon: number;
  bucket: Bucket;
  loop: boolean;
}

export class PlanError extends Error {}

export async function planRun(
  input: PlanInput,
  onProgress: (p: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const fd = new FormData();
  fd.set("text", input.text ?? "");
  fd.set("lat", String(input.lat));
  fd.set("lon", String(input.lon));
  fd.set("bucket", input.bucket);
  fd.set("loop", input.loop ? "true" : "false");
  if (input.image) fd.set("image", input.image, input.image.name);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/plan`, { method: "POST", body: fd, signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new PlanError("Couldn't reach the route engine. Is the API running?");
  }
  if (!res.ok || !res.body) {
    let msg = `The route engine answered ${res.status}.`;
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
  let result: PlanResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "progress") onProgress(ev as ProgressEvent);
      else if (ev.type === "result") result = ev as PlanResult;
      else if (ev.type === "error") throw new PlanError(ev.message || "Something went wrong.");
    }
  }
  if (!result) throw new PlanError("The route engine stopped without an answer. Try again.");
  return result;
}

export interface EstimateResult {
  ok: boolean;
  text?: string;
  need_mi?: number;
  fits?: Record<Bucket, boolean>;
  message?: string | null;
}

export async function estimate(text: string, bucket: Bucket, loop: boolean): Promise<EstimateResult> {
  const res = await fetch(`${API_URL}/api/estimate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, bucket, loop }),
  });
  if (!res.ok) throw new Error(`estimate failed: ${res.status}`);
  return res.json();
}

export function downloadGpx(result: PlanResult) {
  const blob = new Blob([result.gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = result.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "route";
  a.href = url;
  a.download = `${slug}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
