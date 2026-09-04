// A GIF of the route drawing itself in, rendered offscreen on a map of its
// own (16:9, 1280 x 720) with a caption band, so nothing on screen has to
// move and the result is the same on any device.

import maplibregl from "maplibre-gl";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { type DistanceMarker, metres } from "./geo";
import { EMPTY, type LngLat, addRouteLayers, easeInOut, ensureMarkerImages, lineFeature, lineFromLngLat, pointFeature, routeBounds, setDecor } from "./maplayers";

export interface GifJob {
  style: string | maplibregl.StyleSpecification;
  night: boolean;
  route: [number, number][];
  start: [number, number] | null;
  finish: [number, number] | null;
  markers: DistanceMarker[];
  /** The word, and a stats line such as "3.28 MI · LOOP". */
  caption: { word: string; stats: string };
  width?: number;
  height?: number;
  onProgress?: (pct: number) => void;
}

const FRAME_MS = 80;
const BAND = 150;   // caption band height in px
const SITE = "runmapper.run";

/** Resolves when the map has drawn everything it was asked to, or after `ms`. */
function idle(m: maplibregl.Map, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      m.off("idle", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    m.once("idle", finish);
  });
}

/** The page's display face (Bebas Neue via next/font), if it is available to the canvas. */
function displayFont(): string {
  const fam = typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim() : "";
  return fam ? `${fam}, "Arial Narrow", Impact, sans-serif` : `"Arial Narrow", Impact, sans-serif`;
}

/** A dark band across the bottom with the word, the stats and the site. */
function drawBand(ctx: CanvasRenderingContext2D, w: number, h: number, caption: { word: string; stats: string }, font: string) {
  const g = ctx.createLinearGradient(0, h - BAND - 60, 0, h);
  g.addColorStop(0, "rgba(11, 11, 13, 0)");
  g.addColorStop(0.35, "rgba(11, 11, 13, 0.82)");
  g.addColorStop(1, "rgba(11, 11, 13, 0.96)");
  ctx.fillStyle = g;
  ctx.fillRect(0, h - BAND - 60, w, BAND + 60);
  const x = 56;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#f4f2ec";
  ctx.font = `76px ${font}`;
  ctx.fillText(caption.word, x, h - 66);
  ctx.fillStyle = "#fc5200";
  ctx.font = `30px ${font}`;
  ctx.fillText(caption.stats, x + 2, h - 28);
  ctx.textAlign = "right";
  ctx.fillStyle = "#aaa9a2";
  ctx.font = `28px ${font}`;
  ctx.fillText(SITE, w - 56, h - 28);
  // a short orange rule under the word, like the field on the page
  ctx.fillStyle = "#fc5200";
  ctx.fillRect(x, h - 54, Math.min(w * 0.3, 220), 3);
}

export async function renderGif(job: GifJob): Promise<Blob> {
  const W = job.width ?? 1280;
  const H = job.height ?? 720;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-${W + 200}px;top:0;width:${W}px;height:${H}px;pointer-events:none;`;
  document.body.appendChild(host);
  const m = new maplibregl.Map({
    container: host,
    style: job.style,
    interactive: false,
    attributionControl: false,
    pixelRatio: 1,
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    center: [0, 0],
    zoom: 1,
  });
  try {
    // Wait for the style; if it can't be fetched, draw on a plain ground.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let fellBack = false;
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      m.once("load", ok);
      m.on("error", (e) => {
        if (settled || fellBack) return;
        const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
        if (!/style|fetch|AJAXError/i.test(msg)) return;
        fellBack = true;
        m.once("style.load", ok);
        m.setStyle({
          version: 8,
          sources: {},
          layers: [{ id: "bg", type: "background", paint: { "background-color": job.night ? "#141417" : "#f4f4f5" } }],
        });
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("map took too long to load"));
      }, 30000);
    });
    addRouteLayers(m, job.night);
    ensureMarkerImages(m, job.markers.map((k) => k.n));
    const src = (id: string) => m.getSource(id) as maplibregl.GeoJSONSource;
    src("start").setData(job.start ? pointFeature([job.start[1], job.start[0]]) : EMPTY);
    src("finish").setData(job.finish ? pointFeature([job.finish[1], job.finish[0]]) : EMPTY);
    src("miles").setData({ type: "FeatureCollection", features: job.markers.map((k) => pointFeature([k.lon, k.lat], { n: k.n })) });
    src("route").setData(lineFeature(job.route));
    setDecor(m, true);
    m.fitBounds(routeBounds(job.route), { padding: { top: 64, right: 64, bottom: 64 + BAND, left: 64 }, duration: 0, maxZoom: 16.5 });
    await idle(m, 20000);   // tiles for the whole frame
    if (typeof document.fonts?.ready?.then === "function") await document.fonts.ready;
    const font = displayFont();
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas");
    const caption = { word: job.caption.word.toUpperCase(), stats: job.caption.stats.toUpperCase() };
    const snap = () => {
      ctx.drawImage(m.getCanvas(), 0, 0, W, H);
      drawBand(ctx, W, H, caption, font);
      return ctx.getImageData(0, 0, W, H).data;
    };
    // The finished frame first: its colours make the palette for every frame.
    const last = snap();
    const palette = quantize(last, 256, { format: "rgb565" });
    const gif = GIFEncoder();

    const pts: LngLat[] = job.route.map(([lat, lon]) => [lon, lat]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(job.route[i - 1], job.route[i]));
    const total = cum[cum.length - 1];
    const duration = Math.min(7000, 2600 + 550 * (total / 1609.344));
    const n = Math.max(12, Math.round(duration / FRAME_MS));
    setDecor(m, false);
    let k = 1;
    for (let i = 0; i <= n; i++) {
      const target = easeInOut(i / n) * total;
      while (k < cum.length - 1 && cum[k] < target) k++;
      const a = pts[k - 1];
      const b = pts[k];
      const seg = cum[k] - cum[k - 1];
      const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[k - 1]) / seg)) : 1;
      const tip: LngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      src("route").setData(lineFromLngLat([...pts.slice(0, k), tip]));
      src("head").setData(pointFeature(tip));
      await idle(m, 1500);
      const index = applyPalette(snap(), palette, "rgb565");
      gif.writeFrame(index, W, H, { palette, delay: i === 0 ? 600 : FRAME_MS, repeat: 0 });
      job.onProgress?.((i + 1) / (n + 2));
    }
    // Hold on the finished drawing with its chevrons and marks.
    src("route").setData(lineFeature(job.route));
    src("head").setData(EMPTY);
    setDecor(m, true);
    await idle(m, 1500);
    gif.writeFrame(applyPalette(snap(), palette, "rgb565"), W, H, { palette, delay: 2200 });
    job.onProgress?.(1);
    gif.finish();
    return new Blob([gif.bytes() as BlobPart], { type: "image/gif" });
  } finally {
    m.remove();
    host.remove();
  }
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
