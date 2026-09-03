"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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
}

type LngLat = [number, number];
const EMPTY = { type: "FeatureCollection" as const, features: [] };

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

export default function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  const anim = useRef<{ raf: number; token: number } | null>(null);
  const pendingDraw = useRef(false);   // a draw is about to start: keep the full line hidden until then
  const [basemap, setBasemap] = useState<Basemap>("streets");
  const [drawing, setDrawing] = useState(false);
  const startDrawRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    latest.current = props;
  });

  // Push the current props into the map's sources and layers. While the
  // route is being drawn in, the route source is left to the animation.
  const apply = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const p = latest.current;
    const route = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
    const ideal = m.getSource("ideal") as maplibregl.GeoJSONSource | undefined;
    const start = m.getSource("start") as maplibregl.GeoJSONSource | undefined;
    if (!anim.current && !pendingDraw.current) route?.setData(p.route && p.route.length > 1 ? lineFeature(p.route) : EMPTY);
    ideal?.setData(
      p.ideal ? { type: "FeatureCollection", features: p.ideal.filter((s) => s.length > 1).map(lineFeature) } : EMPTY,
    );
    start?.setData(p.start ? pointFeature([p.start[1], p.start[0]]) : EMPTY);
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

  const stopDraw = () => {
    cancelAnim();
    setDrawing(false);
  };

  // Draw the route in from start to finish, the way Strava plays an activity
  // back: the line grows at a steady pace along the course with a dot at its
  // tip. About three seconds plus a bit per mile.
  const startDraw = () => {
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
    if (total <= 0) {
      routeSrc.setData(lineFromLngLat(pts));
      return;
    }
    const duration = Math.min(7000, 2600 + 550 * (total / 1609.344));
    const token = Math.random();
    const t0 = performance.now();
    setDrawing(true);
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
        setDrawing(false);
      }
    };
    anim.current = { raf: requestAnimationFrame(frame), token };
  };
  useEffect(() => {
    startDrawRef.current = startDraw;
  });

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: MAP_STYLE,
      // A world view until the user searches, clicks, or shares their location.
      center: [10, 25],
      zoom: 1.4,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
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
      m.addSource("route", { type: "geojson", data: EMPTY });
      m.addSource("ideal", { type: "geojson", data: EMPTY });
      m.addSource("start", { type: "geojson", data: EMPTY });
      m.addSource("head", { type: "geojson", data: EMPTY });
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
      m.addLayer({
        id: "start",
        type: "circle",
        source: "start",
        paint: { "circle-radius": 7, "circle-color": "#12b886", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
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
    const t = setTimeout(() => setDrawing(false), 0);
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

  // A new route: frame it, then draw it in once the camera has settled.
  useEffect(() => {
    cancelAnim();
    const m = map.current;
    pendingDraw.current = Boolean(m && props.route && props.route.length > 1);
    apply();
    if (!m || !props.route || props.route.length < 2) {
      const t = setTimeout(() => setDrawing(false), 0);
      return () => clearTimeout(t);
    }
    (m.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    const b = new maplibregl.LngLatBounds();
    for (const [lat, lon] of props.route) b.extend([lon, lat]);
    m.fitBounds(b, { padding: 60, duration: 900, maxZoom: 16 });
    const timer = setTimeout(() => startDrawRef.current(), 950);
    return () => clearTimeout(timer);
  }, [props.route]);

  useEffect(() => {
    apply();
  }, [props.ideal, props.start, props.showIdeal]);

  const btn =
    "rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-zinc-800 shadow-sm hover:bg-white";
  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" aria-label="Map" />
      <div className="absolute top-2.5 left-2.5 z-10 flex gap-2">
        <button
          type="button"
          className={btn}
          onClick={() => setBasemap((b) => (b === "streets" ? "satellite" : "streets"))}
          aria-pressed={basemap === "satellite"}
        >
          {basemap === "streets" ? "Satellite" : "Map"}
        </button>
        {props.route && props.route.length > 1 && (
          <button type="button" className={btn} onClick={startDraw} disabled={drawing} aria-label="Replay the route drawing">
            {drawing ? "Drawing…" : "▶ Replay"}
          </button>
        )}
      </div>
    </div>
  );
}
