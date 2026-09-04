"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import Icon from "./Icon";

export const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE || "https://tiles.openfreemap.org/styles/positron";
export const STRAVA_ORANGE = "#FC5200";

// Satellite view: Esri's World Imagery with its road and place-name
// reference tiles on top. No key needed; attribution is required and shown.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
export const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    imagery: {
      type: "raster",
      tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
    roads: { type: "raster", tiles: [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
    places: { type: "raster", tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
  },
  layers: [
    { id: "imagery", type: "raster", source: "imagery" },
    { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.85 } },
    { id: "places", type: "raster", source: "places" },
  ],
};

// Used when the basemap style can't be fetched, so the route still shows.
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#f4f4f5" } }],
};

export type Basemap = "streets" | "satellite";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface MapViewProps {
  pin: LatLon | null;
  onPick: (p: LatLon) => void;
  focus: (LatLon & { zoom?: number; key: number }) | null;
  route: [number, number][] | null;
  ideal: [number, number][][] | null;
  showIdeal: boolean;
  start: [number, number] | null;
  /** The last point of a one-way route; null for loops. */
  finish: [number, number] | null;
  /** Stamped on an exported GIF, e.g. “RUN” · 3.28 mi · runmapper.run */
  caption: string;
  /** File name stem for the exported GIF. */
  fileStem: string;
}

type LngLat = [number, number];
const EMPTY = { type: "FeatureCollection" as const, features: [] };
const ARROW = "route-arrow";
const GIF_FRAME_MS = 80;
const GIF_MAX_WIDTH = 640;

type GifState = { phase: "idle" } | { phase: "recording" } | { phase: "encoding"; pct: number };
const GIF_IDLE: GifState = { phase: "idle" };

function lineFeature(coords: [number, number][]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords.map(([lat, lon]) => [lon, lat]) },
  };
}

function lineFromLngLat(coords: LngLat[]) {
  return { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } };
}

function pointFeature(p: LngLat) {
  return { type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: p } };
}

/** Planar metres between two lon/lat points; plenty for a run-sized route. */
function metres(a: LngLat, b: LngLat) {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * 111320 * k;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** A small white chevron placed along the route so the direction of travel
 *  is obvious. It points +x, which MapLibre turns along the line. */
function arrowImage(): ImageData | null {
  if (typeof document === "undefined") return null;
  const s = 28;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d");
  if (!g) return null;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(10, 7);
  g.lineTo(18, 14);
  g.lineTo(10, 21);
  g.strokeStyle = "rgba(140, 40, 0, 0.9)";
  g.lineWidth = 6;
  g.stroke();
  g.strokeStyle = "#ffffff";
  g.lineWidth = 3;
  g.stroke();
  return g.getImageData(0, 0, s, s);
}

/** Padding around a framed route: generous on a big map, tighter on a phone. */
function framePadding(m: maplibregl.Map) {
  const el = m.getContainer();
  return Math.max(28, Math.min(64, Math.round(Math.min(el.clientWidth, el.clientHeight) * 0.12)));
}

function routeBounds(r: [number, number][]) {
  const b = new maplibregl.LngLatBounds();
  for (const [lat, lon] of r) b.extend([lon, lat]);
  return b;
}

/** Whole route inside the current view? */
function inView(m: maplibregl.Map, r: [number, number][]) {
  const v = m.getBounds();
  return r.every(([lat, lon]) => v.contains([lon, lat]));
}

/** A caption pill in the corner of a GIF frame. */
function drawCaption(ctx: CanvasRenderingContext2D, w: number, h: number, text: string) {
  if (!text) return;
  const size = Math.round(Math.max(12, Math.min(18, w / 40)));
  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = "middle";
  const padX = Math.round(size * 0.85);
  const bw = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const bh = Math.round(size * 2);
  const x = Math.round(size * 0.9);
  const y = h - bh - Math.round(size * 0.9);
  ctx.fillStyle = "rgba(21, 21, 23, 0.84)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, bw, bh, bh / 2);
  else ctx.rect(x, y, bw, bh);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x + padX, y + bh / 2 + 1);
}

interface Frame {
  img: ImageData;
  /** performance.now() at capture, so playback keeps real timing however fast frames were grabbed. */
  t: number;
}

/** Encode captured frames as a looping GIF. One palette, taken from the
 *  finished drawing, serves every frame; the first and last frames hold. */
async function encodeGif(frames: Frame[], w: number, h: number, onProgress: (pct: number) => void): Promise<Uint8Array> {
  const gif = GIFEncoder();
  const palette = quantize(frames[frames.length - 1].img.data, 256, { format: "rgb565" });
  for (let i = 0; i < frames.length; i++) {
    const index = applyPalette(frames[i].img.data, palette, "rgb565");
    const last = i === frames.length - 1;
    const gap = last ? 0 : Math.max(20, Math.round(frames[i + 1].t - frames[i].t));
    const delay = last ? 1800 : i === 0 ? gap + 500 : gap;
    gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
    onProgress((i + 1) / frames.length);
    if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return gif.bytes();
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  const anim = useRef<{ raf: number; token: number } | null>(null);
  const pendingDraw = useRef(false);   // a draw is about to start: keep the full line hidden until then
  const rec = useRef<{ frames: Frame[]; timer: number } | null>(null);
  const seen = useRef(new WeakSet<object>());   // routes already drawn in once
  const [basemap, setBasemap] = useState<Basemap>("streets");
  const [drawing, setDrawing] = useState(false);
  const [gif, setGif] = useState<GifState>(GIF_IDLE);
  const startDrawRef = useRef<(onDone?: () => void) => void>(() => undefined);
  useEffect(() => {
    latest.current = props;
  });

  // Direction chevrons are hidden while the line is still growing.
  const setArrows = (visible: boolean) => {
    const m = map.current;
    if (m?.getLayer("route-arrows")) m.setLayoutProperty("route-arrows", "visibility", visible ? "visible" : "none");
  };

  // Push the current props into the map's sources and layers. While the
  // route is being drawn in, the route source is left to the animation.
  const apply = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const p = latest.current;
    const route = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
    const ideal = m.getSource("ideal") as maplibregl.GeoJSONSource | undefined;
    const start = m.getSource("start") as maplibregl.GeoJSONSource | undefined;
    const finish = m.getSource("finish") as maplibregl.GeoJSONSource | undefined;
    if (!anim.current && !pendingDraw.current) {
      route?.setData(p.route && p.route.length > 1 ? lineFeature(p.route) : EMPTY);
      setArrows(true);
    }
    ideal?.setData(
      p.ideal ? { type: "FeatureCollection", features: p.ideal.filter((s) => s.length > 1).map(lineFeature) } : EMPTY,
    );
    start?.setData(p.start ? pointFeature([p.start[1], p.start[0]]) : EMPTY);
    finish?.setData(p.finish ? pointFeature([p.finish[1], p.finish[0]]) : EMPTY);
    m.setLayoutProperty("ideal", "visibility", p.showIdeal ? "visible" : "none");
  };

  // Cancel a running draw (no React state touched, so effects may call it).
  const cancelAnim = () => {
    if (anim.current) {
      cancelAnimationFrame(anim.current.raf);
      anim.current = null;
    }
    (map.current?.getSource("head") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
  };

  // Drop a recording in progress (state-free, for effects).
  const abortGif = () => {
    if (rec.current) {
      clearInterval(rec.current.timer);
      rec.current = null;
    }
  };

  const stopDraw = () => {
    cancelAnim();
    setDrawing(false);
  };

  // Frame the whole route.
  const fit = (duration = 700) => {
    const m = map.current;
    const r = latest.current.route;
    if (!m || !r || r.length < 2) return;
    m.fitBounds(routeBounds(r), { padding: framePadding(m), duration, maxZoom: 16 });
  };

  // Draw the route in from start to finish, the way Strava plays an activity
  // back: the line grows at a steady pace along the course with a dot at its
  // tip. About three seconds plus a bit per mile. `onDone` fires only when
  // the draw runs to the end.
  const startDraw = (onDone?: () => void) => {
    pendingDraw.current = false;
    const m = map.current;
    const r = latest.current.route;
    if (!m || !ready.current || !r || r.length < 2) {
      apply();
      return;
    }
    stopDraw();
    const routeSrc = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
    const headSrc = m.getSource("head") as maplibregl.GeoJSONSource | undefined;
    if (!routeSrc || !headSrc) {
      apply();
      return;
    }
    const pts: LngLat[] = r.map(([lat, lon]) => [lon, lat]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total <= 0 || (reducedMotion() && !onDone)) {
      routeSrc.setData(lineFromLngLat(pts));
      setArrows(true);
      return;
    }
    const duration = Math.min(7000, 2600 + 550 * (total / 1609.344));
    const token = Math.random();
    const t0 = performance.now();
    setDrawing(true);
    setArrows(false);
    routeSrc.setData(lineFromLngLat([pts[0], pts[0]]));
    headSrc.setData(pointFeature(pts[0]));
    let k = 1;
    const frame = (now: number) => {
      if (!anim.current || anim.current.token !== token) return;
      const u = Math.min(1, (now - t0) / duration);
      const target = easeInOut(u) * total;
      while (k < cum.length - 1 && cum[k] < target) k++;
      const a = pts[k - 1];
      const b = pts[k];
      const seg = cum[k] - cum[k - 1];
      const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[k - 1]) / seg)) : 1;
      const tip: LngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
      const head = m.getSource("head") as maplibregl.GeoJSONSource | undefined;
      if (!src || !head) {
        anim.current = null;
        setDrawing(false);
        return;
      }
      src.setData(lineFromLngLat([...pts.slice(0, k), tip]));
      head.setData(pointFeature(tip));
      if (u < 1) {
        anim.current = { raf: requestAnimationFrame(frame), token };
      } else {
        src.setData(lineFromLngLat(pts));
        head.setData(EMPTY);
        anim.current = null;
        setArrows(true);
        setDrawing(false);
        onDone?.();
      }
    };
    anim.current = { raf: requestAnimationFrame(frame), token };
  };
  useEffect(() => {
    startDrawRef.current = startDraw;
  });

  // Record the draw-in as a GIF: frame the route, play it, grab the canvas
  // every 80 ms, then encode and download.
  const recordGif = () => {
    const m = map.current;
    const r = latest.current.route;
    if (!m || !r || r.length < 2 || rec.current || anim.current) return;
    const src = m.getCanvas();
    const scale = Math.min(1, GIF_MAX_WIDTH / src.clientWidth);
    const w = Math.max(64, Math.round(src.clientWidth * scale));
    const h = Math.max(64, Math.round(src.clientHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const caption = latest.current.caption;
    const stem = latest.current.fileStem || "route";
    const snap = (): Frame => {
      ctx.drawImage(src, 0, 0, w, h);
      drawCaption(ctx, w, h, caption);
      return { img: ctx.getImageData(0, 0, w, h), t: performance.now() };
    };
    const state = { frames: [] as Frame[], timer: 0 };
    rec.current = state;
    setGif({ phase: "recording" });
    fit(0);
    window.setTimeout(() => {
      if (rec.current !== state) return;
      state.timer = window.setInterval(() => {
        if (rec.current === state) state.frames.push(snap());
      }, GIF_FRAME_MS);
      startDraw(() => {
        // Let the finished line and its chevrons render before the last frame.
        window.setTimeout(async () => {
          if (rec.current !== state) return;
          clearInterval(state.timer);
          state.frames.push(snap());
          rec.current = null;
          setGif({ phase: "encoding", pct: 0 });
          try {
            const bytes = await encodeGif(state.frames, w, h, (pct) => setGif({ phase: "encoding", pct }));
            saveBlob(new Blob([bytes as BlobPart], { type: "image/gif" }), `${stem}.gif`);
          } finally {
            setGif(GIF_IDLE);
          }
        }, 300);
      });
    }, 400);
  };

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: MAP_STYLE,
      // A world view until the user searches, clicks, or shares their location.
      center: [10, 25],
      zoom: 1.4,
      attributionControl: false,
      // Keeps the frame readable after each render, for the GIF export.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    // If a basemap style can't be fetched (offline, blocked tiles), fall
    // back to a blank canvas so the route still draws. Only while a style is
    // loading (ready is false), so tile errors later on are ignored.
    let fallingBack = false;
    m.on("error", (e) => {
      if (ready.current || fallingBack) return;
      const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
      if (/style|fetch|AJAXError/i.test(msg)) {
        fallingBack = true;
        m.setStyle(FALLBACK_STYLE);
        m.once("style.load", () => {
          fallingBack = false;
        });
      }
    });
    const setup = () => {
      if (ready.current || m.getSource("route")) return;
      if (!m.hasImage(ARROW)) {
        const img = arrowImage();
        if (img) m.addImage(ARROW, img, { pixelRatio: 2 });
      }
      m.addSource("route", { type: "geojson", data: EMPTY });
      m.addSource("ideal", { type: "geojson", data: EMPTY });
      m.addSource("start", { type: "geojson", data: EMPTY });
      m.addSource("finish", { type: "geojson", data: EMPTY });
      m.addSource("head", { type: "geojson", data: EMPTY });
      // A soft shadow under the line lifts it off the map a little.
      m.addLayer({
        id: "route-shadow",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#000000", "line-width": 14, "line-opacity": 0.16, "line-blur": 6, "line-translate": [0, 2] },
      });
      m.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
      });
      m.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": STRAVA_ORANGE, "line-width": 5 },
      });
      m.addLayer({
        id: "ideal",
        type: "line",
        source: "ideal",
        layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
        paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.8 },
      });
      if (m.hasImage(ARROW)) {
        m.addLayer({
          id: "route-arrows",
          type: "symbol",
          source: "route",
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 70,
            "icon-image": ARROW,
            "icon-size": 0.85,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-rotation-alignment": "map",
            "icon-pitch-alignment": "map",
            visibility: "none",
          },
        });
      }
      m.addLayer({
        id: "start",
        type: "circle",
        source: "start",
        paint: { "circle-radius": 7, "circle-color": "#12b886", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
      });
      m.addLayer({
        id: "finish",
        type: "circle",
        source: "finish",
        paint: { "circle-radius": 6, "circle-color": "#17171b", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
      });
      m.addLayer({
        id: "head",
        type: "circle",
        source: "head",
        paint: { "circle-radius": 6, "circle-color": STRAVA_ORANGE, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
      });
      ready.current = true;
      apply();
    };
    m.on("load", setup);
    m.on("style.load", setup);
    m.on("click", (e) => latest.current.onPick({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.current = m;
    (window as unknown as { __runmapperMap?: maplibregl.Map }).__runmapperMap = m;
    return () => {
      cancelAnim();
      abortGif();
      // The marker belongs to this map; a remount must make a fresh one.
      marker.current?.remove();
      marker.current = null;
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // Streets or satellite. Switching styles drops every source and layer, so
  // `setup` runs again on style.load and puts the route back.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const want = basemap === "satellite" ? SATELLITE_STYLE : MAP_STYLE;
    const current = m.getStyle();
    const isSat = Boolean(current?.sources && "imagery" in current.sources);
    if ((basemap === "satellite") === isSat) return;
    cancelAnim();
    abortGif();
    const t = setTimeout(() => {
      setDrawing(false);
      setGif(GIF_IDLE);
    }, 0);
    ready.current = false;
    m.setStyle(want);
    return () => clearTimeout(t);
  }, [basemap]);

  // Pin marker.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!props.pin) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      marker.current = new maplibregl.Marker({ draggable: true, color: "#18181b" })
        .setLngLat([props.pin.lon, props.pin.lat])
        .addTo(m);
      marker.current.on("dragend", () => {
        const ll = marker.current!.getLngLat();
        latest.current.onPick({ lat: ll.lat, lon: ll.lng });
      });
    } else {
      marker.current.setLngLat([props.pin.lon, props.pin.lat]);
    }
  }, [props.pin]);

  // Fly to a searched place.
  useEffect(() => {
    const m = map.current;
    if (!m || !props.focus) return;
    m.easeTo({ center: [props.focus.lon, props.focus.lat], zoom: props.focus.zoom ?? 13.5, duration: 900 });
  }, [props.focus]);

  // A new route. Its first showing: frame it, then draw it in once the
  // camera has settled. Shown before (switching between answers): put it
  // up whole, and only move the camera if part of it is off screen.
  useEffect(() => {
    cancelAnim();
    abortGif();
    const m = map.current;
    const r = props.route;
    const settle = setTimeout(() => {
      setDrawing(false);
      setGif(GIF_IDLE);
    }, 0);
    if (!m || !r || r.length < 2) {
      pendingDraw.current = false;
      apply();
      return () => clearTimeout(settle);
    }
    if (seen.current.has(r)) {
      pendingDraw.current = false;
      apply();
      if (!inView(m, r)) fit(450);
      return () => clearTimeout(settle);
    }
    pendingDraw.current = true;
    apply();
    (m.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    fit(900);
    const timer = setTimeout(() => {
      seen.current.add(r);
      startDrawRef.current();
    }, 950);
    return () => {
      clearTimeout(settle);
      clearTimeout(timer);
    };
  }, [props.route]);

  useEffect(() => {
    apply();
  }, [props.ideal, props.start, props.finish, props.showIdeal]);

  const hasRoute = Boolean(props.route && props.route.length > 1);
  const busy = gif.phase !== "idle";
  const gifLabel = gif.phase === "recording" ? "Recording…" : gif.phase === "encoding" ? `Encoding ${Math.round(gif.pct * 100)}%` : "Save GIF";
  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" aria-label="Map" />
      <div className="absolute top-3 left-3 z-10 flex flex-wrap gap-2">
        <button
          type="button"
          className="map-btn"
          onClick={() => setBasemap((b) => (b === "streets" ? "satellite" : "streets"))}
          aria-pressed={basemap === "satellite"}
          disabled={busy}
        >
          <Icon name="layers" />
          {basemap === "streets" ? "Satellite" : "Map"}
        </button>
        {hasRoute && (
          <button type="button" className="map-btn" onClick={() => fit()} aria-label="Fit the whole route on screen" disabled={busy}>
            <Icon name="frame" />
            Fit
          </button>
        )}
      </div>
      {hasRoute && (
        <div className="absolute right-3 bottom-3 z-10 flex flex-col items-end gap-2">
          <button type="button" className="map-btn map-btn-dark" onClick={recordGif} disabled={busy || drawing} aria-label="Save the route drawing as a GIF">
            <Icon name="film" />
            {gifLabel}
          </button>
          <button type="button" className="map-round" onClick={() => startDraw()} disabled={drawing || busy} aria-label="Replay the route drawing" title="Replay">
            <Icon name="play" />
          </button>
        </div>
      )}
      {!props.pin && (
        <div className="hint pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2" role="status">
          Search a place, or tap the map to set your start
        </div>
      )}
    </div>
  );
}
