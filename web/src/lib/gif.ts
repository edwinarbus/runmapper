// A GIF of the route drawing itself in, rendered offscreen on a map of its
// own (16:9, 1280 x 720, always the light day map) with a caption band, so
// nothing on screen has to move and the result is the same on any device.
//
// X takes GIFs up to 15 MB from a browser but only 5 MB from its apps, at
// most 1280 x 1080 and 350 frames. Every frame after the first carries only
// the pixels that changed (the map underneath never moves), which keeps a
// file to a fraction of that; and if one ever runs over the app limit it is
// rendered again smaller and shorter until it fits.

import maplibregl from "maplibre-gl";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { metres } from "./geo";
import { EMPTY, type LngLat, addRouteLayers, easeInOut, lineFeature, lineFromLngLat, pointFeature, routeBounds, scaleRoute, setDecor, setRouteOpacity } from "./maplayers";

export interface GifJob {
  style: string | maplibregl.StyleSpecification;
  night: boolean;
  route: [number, number][];
  start: [number, number] | null;
  finish: [number, number] | null;
  /** The word, the distance ("6.15 mi") and the town the run is in ("" when unknown). */
  caption: { word: string; distance: string; city: string };
  width?: number;
  height?: number;
  onProgress?: (pct: number) => void;
}

const FRAME_MS = 50;     // 20 frames a second
const MAX_FRAMES = 150;
const FADE_FRAMES = 8;   // the line melting away after the hold, so the loop comes round smoothly
const BAND = 132;        // caption band height at 1280 x 720, along the top: X lays its GIF badge over the bottom left
const THICK = 2;         // the route and its markers, this many times as thick as on screen
const SIZE_LIMIT = 4.8 * 1024 * 1024;   // under the 5 MB X allows from a phone
const TRANSPARENT = 255;                // the palette slot that means "as before"
const SITE = { left: "DRAWMY", right: "RUN" };   // with the start dot as the period between
/** Renders to try, in order: full size, then smaller and shorter if the file runs over the limit. */
const PASSES: { scale: number; frames: number }[] = [
  { scale: 1, frames: MAX_FRAMES },
  { scale: 0.75, frames: 100 },
  { scale: 0.5, frames: 60 },
];

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

/** The site's address with its right edge at `right`: DRAWMY, the green
 *  period of a route that is ready, RUN in orange. */
function drawSite(ctx: CanvasRenderingContext2D, right: number, baseline: number, size: number, font: string) {
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = "left";
  // The face's own period is 0.106em; set as the face sets "Y.", it tucks
  // 0.04em under the Y's arm and clears the R by their two bearings, 0.08em,
  // and stands on the baseline like a full stop.
  const dot = size * 0.11;
  const gapL = -size * 0.04;         // from the Y's advance to the dot
  const gapR = size * 0.08;          // from the dot to the R's advance
  const wl = ctx.measureText(SITE.left).width;
  const wr = ctx.measureText(SITE.right).width;
  let x = right - (wl + gapL + dot + gapR + wr);
  ctx.fillStyle = "#6f6e68";
  ctx.fillText(SITE.left, x, baseline);
  x += wl + gapL;
  ctx.beginPath();
  ctx.arc(x + dot / 2, baseline - dot / 2, dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = "#12b886";
  ctx.fill();
  x += dot + gapR;
  ctx.fillStyle = "#fc5200";
  ctx.fillText(SITE.right, x, baseline);
}

/** How wide drawSite draws at `size`. */
function siteWidth(ctx: CanvasRenderingContext2D, size: number, font: string) {
  ctx.font = `${size}px ${font}`;
  return ctx.measureText(SITE.left).width - size * 0.04 + size * 0.11 + size * 0.08 + ctx.measureText(SITE.right).width;
}

/** A wash of paper down from the top with the distance, large, and the
 *  town beside it; the site top right. The bottom corners stay clear: X
 *  lays its GIF badge over the bottom left. Sized for 1280 wide and scaled
 *  with the frame. */
function drawBand(ctx: CanvasRenderingContext2D, w: number, h: number, caption: GifJob["caption"], font: string) {
  const s = w / 1280;
  const g = ctx.createLinearGradient(0, 0, 0, (BAND + 60) * s);
  g.addColorStop(0, "rgba(247, 245, 240, 0.98)");
  g.addColorStop(0.7, "rgba(247, 245, 240, 0.86)");
  g.addColorStop(1, "rgba(247, 245, 240, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, (BAND + 60) * s);
  const x = 56 * s;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  // the distance, large, and the town to its right
  ctx.fillStyle = "#fc5200";
  ctx.font = `${96 * s}px ${font}`;
  const distance = caption.distance.toUpperCase();
  const dw = ctx.measureText(distance).width;
  ctx.fillText(distance, x, 108 * s);
  if (caption.city) {
    ctx.fillStyle = "#6f6e68";
    ctx.font = `${44 * s}px ${font}`;
    ctx.fillText(caption.city.toUpperCase(), x + dw + 26 * s, 108 * s);
  }
  // the site, top right, in the band's wash
  void h;
  drawSite(ctx, w - 56 * s, 78 * s, 36 * s, font);
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
    scaleRoute(m, THICK, job.night);
    const src = (id: string) => m.getSource(id) as maplibregl.GeoJSONSource;
    src("start").setData(job.start ? pointFeature([job.start[1], job.start[0]]) : EMPTY);
    src("finish").setData(job.finish ? pointFeature([job.finish[1], job.finish[0]]) : EMPTY);
    src("route").setData(lineFeature(job.route));
    setDecor(m, false);   // no chevrons on the GIF: the line reads cleaner small
    m.fitBounds(routeBounds(job.route), { padding: { top: BAND + 16, right: 36, bottom: 44, left: 36 }, duration: 0, maxZoom: 17 });
    await idle(m, 20000);   // tiles for the whole frame
    if (typeof document.fonts?.ready?.then === "function") await document.fonts.ready;
    const font = displayFont();

    const pts: LngLat[] = job.route.map(([lat, lon]) => [lon, lat]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(job.route[i - 1], job.route[i]));
    const total = cum[cum.length - 1];
    const duration = Math.min(7000, 2600 + 550 * (total / 1609.344));

    /** One full render and encode at `scale` of the frame, with up to `frames` frames. */
    const encode = async (scale: number, frames: number, share: number, done: number): Promise<Uint8Array> => {
      const w = Math.round(W * scale);
      const h = Math.round(H * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d canvas");
      const snap = () => {
        ctx.drawImage(m.getCanvas(), 0, 0, w, h);
        drawBand(ctx, w, h, job.caption, font);
        return ctx.getImageData(0, 0, w, h).data;
      };
      // The finished frame's colours make the palette for every frame, with
      // one slot kept for "unchanged"; two part-faded renders are sampled in
      // as well so the line has colours to fade through.
      src("route").setData(lineFeature(job.route));
      src("head").setData(EMPTY);
      setDecor(m, false);
      const sample: number[] = [];
      for (const a of [0.55, 0.25]) {
        setRouteOpacity(m, a, job.night);
        await idle(m, 1500);
        const px = snap();
        for (let p = 0; p < px.length; p += 4 * 3) sample.push(px[p], px[p + 1], px[p + 2], px[p + 3]);
      }
      setRouteOpacity(m, 1, job.night);
      await idle(m, 1500);
      const full = snap();
      const both = new Uint8ClampedArray(full.length + sample.length);
      both.set(full);
      both.set(sample, full.length);
      const palette = quantize(both, 255, { format: "rgb565" });
      const table = [...palette, [0, 0, 0]];
      const gif = GIFEncoder();
      let prev: Uint8Array | null = null;
      const frame = (rgba: Uint8ClampedArray, delay: number) => {
        const index = applyPalette(rgba, palette, "rgb565");
        if (prev) {
          // Only what changed since the last frame; the rest shows through.
          const diff = new Uint8Array(index.length);
          for (let p = 0; p < index.length; p++) diff[p] = index[p] === prev[p] ? TRANSPARENT : index[p];
          gif.writeFrame(diff, w, h, { delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
        } else {
          gif.writeFrame(index, w, h, { palette: table, delay, repeat: 0, dispose: 1 });
        }
        prev = index;
      };
      const n = Math.min(frames, Math.max(16, Math.round(duration / FRAME_MS)));
      const step = (duration / n) | 0;
      const count = 1 + FADE_FRAMES + (n + 1) + 1;
      let made = 0;
      const tick = () => job.onProgress?.(done + (share * ++made) / count);
      // The finished drawing is the first frame (what shows before it plays),
      // and the hold at the end runs straight into it as the GIF loops.
      frame(snap(), 400);
      tick();
      // Then the line melts away, leaving the start dot, and the map rests a
      // beat before the drawing begins.
      for (let i = 1; i <= FADE_FRAMES; i++) {
        const t = i / FADE_FRAMES;
        setRouteOpacity(m, 1 - t * t * (3 - 2 * t), job.night);
        await idle(m, 1500);
        frame(snap(), i === FADE_FRAMES ? 300 : 60);
        tick();
      }
      setRouteOpacity(m, 1, job.night);
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
        frame(snap(), step);
        tick();
      }
      // Hold on the finished drawing with its chevrons.
      src("route").setData(lineFeature(job.route));
      src("head").setData(EMPTY);
      setDecor(m, false);
      await idle(m, 1500);
      frame(snap(), 2200);
      tick();
      gif.finish();
      return gif.bytes();
    };

    let bytes: Uint8Array | null = null;
    for (let p = 0; p < PASSES.length; p++) {
      const { scale, frames } = PASSES[p];
      bytes = await encode(scale, frames, p === 0 ? 0.9 : 0.1, p === 0 ? 0 : 0.9);
      if (bytes.length <= SIZE_LIMIT) break;
    }
    job.onProgress?.(1);
    return new Blob([bytes as BlobPart], { type: "image/gif" });
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
