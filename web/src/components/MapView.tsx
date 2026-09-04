"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DAY_STYLE, NIGHT_STYLE, SATELLITE_STYLE } from "@/lib/basemaps";
import { metres } from "@/lib/geo";
import {
  EMPTY,
  type LngLat,
  STRAVA_ORANGE,
  addRouteLayers,
  easeInOut,
  lineFeature,
  lineFromLngLat,
  pointFeature,
  routeBounds,
  setDecor,
} from "@/lib/maplayers";
import Icon from "./Icon";

// Used when the basemap style can't be fetched, so the route still shows.
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#141417" } }],
};

export type Basemap = "night" | "day" | "satellite";
const BASEMAPS: { key: Basemap; label: string }[] = [
  { key: "night", label: "Night" },
  { key: "day", label: "Day" },
  { key: "satellite", label: "Sat" },
];
const styleFor = (b: Basemap) => (b === "satellite" ? SATELLITE_STYLE : b === "day" ? DAY_STYLE : NIGHT_STYLE);
const LIGHT = "(prefers-color-scheme: light)";
/** Day or night to match the device's setting; night when there is none. */
const deviceBasemap = (): Basemap => (typeof window !== "undefined" && window.matchMedia?.(LIGHT).matches ? "day" : "night");

export interface LatLon {
  lat: number;
  lon: number;
}

export interface MapViewProps {
  pin: LatLon | null;
  /** Setting up a run: the pin shows and can be dragged, and a tap on the map moves it. */
  picking: boolean;
  onPick: (p: LatLon) => void;
  focus: (LatLon & { zoom?: number; key: number }) | null;
  route: [number, number][] | null;
  ideal: [number, number][][] | null;
  start: [number, number] | null;
  /** The last point of a one-way route; null for loops. */
  finish: [number, number] | null;
}

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** Padding around a framed route: generous on a big map, tighter on a phone. */
function framePadding(m: maplibregl.Map) {
  const el = m.getContainer();
  return Math.max(28, Math.min(64, Math.round(Math.min(el.clientWidth, el.clientHeight) * 0.12)));
}

/** Whole route inside the current view? */
function inView(m: maplibregl.Map, r: [number, number][]) {
  const v = m.getBounds();
  return r.every(([lat, lon]) => v.contains([lon, lat]));
}

export default function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  const anim = useRef<{ raf: number; token: number } | null>(null);
  const pendingDraw = useRef(false);   // a draw is about to start: keep the full line hidden until then
  const seen = useRef(new WeakSet<object>());   // routes already drawn in once
  const applied = useRef<Basemap>(deviceBasemap());   // the style the map currently shows
  const chosen = useRef(false);                       // the user picked a basemap; the device no longer decides
  const idealOn = useRef(false);                // the target shape, shown or not
  const [basemap, setBasemap] = useState<Basemap>(deviceBasemap);
  const [drawing, setDrawing] = useState(false);
  const [showIdeal, setShowIdeal] = useState(false);
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
    const src = (id: string) => m.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (!anim.current && !pendingDraw.current) {
      src("route")?.setData(p.route && p.route.length > 1 ? lineFeature(p.route) : EMPTY);
      setDecor(m, true);
    }
    src("ideal")?.setData(
      p.ideal ? { type: "FeatureCollection", features: p.ideal.filter((s) => s.length > 1).map(lineFeature) } : EMPTY,
    );
    src("start")?.setData(p.start ? pointFeature([p.start[1], p.start[0]]) : EMPTY);
    src("finish")?.setData(p.finish ? pointFeature([p.finish[1], p.finish[0]]) : EMPTY);
    m.setLayoutProperty("ideal", "visibility", idealOn.current ? "visible" : "none");
  };

  const toggleIdeal = () => {
    idealOn.current = !idealOn.current;
    setShowIdeal(idealOn.current);
    apply();
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

  // Frame the whole route.
  const fit = (duration = 700) => {
    const m = map.current;
    const r = latest.current.route;
    if (!m || !r || r.length < 2) return;
    m.fitBounds(routeBounds(r), { padding: framePadding(m), duration, maxZoom: 16 });
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
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(r[i - 1], r[i]));
    const total = cum[cum.length - 1];
    if (total <= 0 || reducedMotion()) {
      routeSrc.setData(lineFromLngLat(pts));
      setDecor(m, true);
      return;
    }
    const duration = Math.min(7000, 2600 + 550 * (total / 1609.344));
    const token = Math.random();
    const t0 = performance.now();
    setDrawing(true);
    setDecor(m, false);
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
        setDecor(m, true);
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
      style: styleFor(applied.current),
      // A world view until the user searches, clicks, or shares their location.
      center: [10, 25],
      zoom: 1.4,
      attributionControl: false,
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
      addRouteLayers(m, applied.current === "night");
      ready.current = true;
      apply();
    };
    m.on("load", setup);
    m.on("style.load", setup);
    // A tap sets the start, but only while a run is being set up.
    m.on("click", (e) => {
      if (latest.current.picking) latest.current.onPick({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
    map.current = m;
    (window as unknown as { __runmapperMap?: maplibregl.Map }).__runmapperMap = m;
    return () => {
      cancelAnim();
      // The marker belongs to this map; a remount must make a fresh one.
      marker.current?.remove();
      marker.current = null;
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // Day and night follow the device's setting until a basemap is picked by hand.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(LIGHT);
    const follow = () => {
      if (!chosen.current) setBasemap(mq.matches ? "day" : "night");
    };
    mq.addEventListener("change", follow);
    return () => mq.removeEventListener("change", follow);
  }, []);

  // Night, day or satellite. Switching styles drops every source and layer,
  // so `setup` runs again on style.load and puts the route back.
  useEffect(() => {
    const m = map.current;
    if (!m || applied.current === basemap) return;
    applied.current = basemap;
    cancelAnim();
    const t = setTimeout(() => setDrawing(false), 0);
    ready.current = false;
    m.setStyle(styleFor(basemap));
    return () => clearTimeout(t);
  }, [basemap]);

  // The pin: only while a run is being set up. Once the routes are on the
  // map the flag and the start dot say where to go.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!props.pin || !props.picking) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      marker.current = new maplibregl.Marker({ draggable: true, color: STRAVA_ORANGE })
        .setLngLat([props.pin.lon, props.pin.lat])
        .addTo(m);
      marker.current.on("dragend", () => {
        const ll = marker.current!.getLngLat();
        latest.current.onPick({ lat: ll.lat, lon: ll.lng });
      });
    } else {
      marker.current.setLngLat([props.pin.lon, props.pin.lat]);
    }
  }, [props.pin, props.picking]);

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
    const m = map.current;
    const r = props.route;
    const settle = setTimeout(() => setDrawing(false), 0);
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
  }, [props.ideal, props.start, props.finish]);

  const hasRoute = Boolean(props.route && props.route.length > 1);
  const hasIdeal = Boolean(props.ideal && props.ideal.length > 0);
  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" aria-label="Map" />
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
        <div className="map-seg" role="group" aria-label="Basemap">
          {BASEMAPS.map((b) => (
            <button key={b.key} type="button" className="map-btn" aria-pressed={basemap === b.key} onClick={() => {
                chosen.current = true;
                setBasemap(b.key);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
        {hasRoute && (
          <button type="button" className="map-btn" onClick={() => fit()} title="Bring the whole route back on screen" aria-label="Recenter">
            <Icon name="frame" />
            <span className="map-label">Recenter</span>
          </button>
        )}
        {hasRoute && hasIdeal && (
          <button
            type="button"
            className="map-btn"
            onClick={toggleIdeal}
            aria-pressed={showIdeal}
            title="The shape the route is trying to draw, as a blue line"
            aria-label={showIdeal ? "Hide the target shape" : "Show the target shape"}
          >
            <Icon name="eye" />
            <span className="map-label">{showIdeal ? "Hide target" : "Target"}</span>
          </button>
        )}
      </div>
      {hasRoute && (
        <div className="absolute right-3 z-10" style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <button type="button" className="map-round" onClick={() => startDraw()} disabled={drawing} aria-label="Replay the route drawing" title="Replay">
            <Icon name="play" />
          </button>
        </div>
      )}
      {props.picking && !props.pin && (
        <div
          className="hint pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
          role="status"
        >
          Search a place, or tap the map to set your start
        </div>
      )}
    </div>
  );
}
