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
  scaleRoute,
  setDecor,
} from "@/lib/maplayers";
import Icon from "./Icon";
import Seg from "./Seg";

// Used when the basemap style can't be fetched, so the route still shows.
// The play mark's triangle, with its mass towards the flat side; see .map-round svg.
const PLAY = "M8 5.5v13l11-6.5z";
const PAUSE = "M6.5 5.5h4v13h-4zM13.5 5.5h4v13h-4z";

const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#141417" } }],
};

export type Basemap = "night" | "day" | "satellite";
const BASEMAPS: { key: Basemap; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "night", label: "Night" },
  { key: "satellite", label: "Sat" },
];
const styleFor = (b: Basemap) => (b === "satellite" ? SATELLITE_STYLE : b === "day" ? DAY_STYLE : NIGHT_STYLE);
const DARK = "(prefers-color-scheme: dark)";
const PHONE = "(max-width: 767px)";
// The flyover: how far down the camera looks, how close it flies, and where
// the tip sits on screen: in the lower part, so the screen above it shows
// the way ahead (padding the top pushes the map's centre down).
const FLY_PITCH = 64;
const FLY_ZOOM = 16.4;
// From the flyover's low camera the line looked thin: the route is drawn this
// many times as thick for the flight, and put back on landing.
const FLY_THICK = 2;
// The speed key cycles through these, a press at a time.
const SPEEDS = [1, 2, 2.5, 3];
const CAP = 22;   // the fader's cap's width, in px: see .scrub-cap
// The flyover's camera looks towards a point this far ahead of the tip
// along the course, so a corner is turned as it comes rather than at it.
const LOOK_AHEAD = 45;   // metres
const flyPadding = (m: maplibregl.Map) => ({ top: Math.round(m.getContainer().clientHeight * 0.44), bottom: 0, left: 0, right: 0 });

/** The compass bearing from one point to the next, in degrees. */
function bearingBetween(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = b[1] - a[1];
  return dx === 0 && dy === 0 ? 0 : (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** The shortest turn from one bearing to another, in degrees, signed. */
function turnTowards(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** The day map, except on a phone set to dark, which gets the night map. */
const deviceBasemap = (): Basemap =>
  typeof window !== "undefined" && window.matchMedia?.(DARK).matches && window.matchMedia?.(PHONE).matches ? "night" : "day";

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

/** The camera that frames the whole route, level, on a map with no padding.
 *  fitBounds frames inside whatever padding the map has at the time, which
 *  during a flight is the top half, so the flight's own way back up works
 *  the framing out here and eases the padding away as it goes. */
function overview(m: maplibregl.Map, r: [number, number][]) {
  const el = m.getContainer();
  const pad = framePadding(m);
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const [lat, lon] of r) {
    const c = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x);
    y1 = Math.max(y1, c.y);
  }
  const w = Math.max(1, el.clientWidth - 2 * pad);
  const h = Math.max(1, el.clientHeight - 2 * pad);
  const zoom = Math.min(16, Math.log2(Math.min(w / Math.max(1e-9, (x1 - x0) * 512), h / Math.max(1e-9, (y1 - y0) * 512))));
  const center = new maplibregl.MercatorCoordinate((x0 + x1) / 2, (y0 + y1) / 2).toLngLat();
  return { center, zoom };
}
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

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
  const [paused, setPaused] = useState(false);   // the play key let up mid-run
  const [showIdeal, setShowIdeal] = useState(false);
  const startDrawRef = useRef<() => void>(() => undefined);
  const fitRef = useRef<(duration?: number) => void>(() => undefined);
  // The transport: the speed the run plays at, and handles into the running
  // draw for the fader (hold it, move it). The cap and the lit groove are
  // moved by hand each frame rather than through React, which need not
  // render sixty times a second for them.
  const speed = useRef(1);
  const [speedShown, setSpeedShown] = useState(1);
  const control = useRef<{ seek: (u: number) => void; hold: (on: boolean) => void; pause: (on: boolean) => void } | null>(null);
  const scrubEl = useRef<HTMLDivElement>(null);
  const capEl = useRef<HTMLDivElement>(null);
  const fillEl = useRef<HTMLDivElement>(null);
  const paintScrub = (u: number) => {
    if (capEl.current) capEl.current.style.left = `calc(${(u * 100).toFixed(2)}% - ${(u * CAP).toFixed(2)}px)`;
    if (fillEl.current) fillEl.current.style.width = `${(u * 100).toFixed(2)}%`;
    scrubEl.current?.setAttribute("aria-valuenow", String(Math.round(u * 100)));
  };
  const scrubAt = (e: { clientX: number }) => {
    const el = scrubEl.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left - CAP / 2) / Math.max(1, r.width - CAP)));
  };
  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed.current) + 1) % SPEEDS.length];
    speed.current = next;
    setSpeedShown(next);
  };
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

  // Terrain and the pitched camera belong to the flyover only: a landing puts
  // the map level and the terrain away.
  const flying = useRef(false);
  const landFlight = (m: maplibregl.Map) => {
    if (!flying.current) return;
    flying.current = false;
    scaleRoute(m, 1);
    if (m.getTerrain()) m.setTerrain(null);
    m.setCenterClampedToGround(true);
    // Level, and the flight's padding gone: left on the map, it would sit
    // under every framing after, and Recenter would put the route low.
    const p = m.getPadding();
    if (m.getPitch() !== 0 || m.getBearing() !== 0 || p.top || p.bottom || p.left || p.right) m.jumpTo({ pitch: 0, bearing: 0, padding: NO_PADDING });
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
    control.current = null;
    setDrawing(false);
    setPaused(false);
  };

  // Frame the whole route. A replay or flight under way ends here, the
  // route put up whole.
  const fit = (duration = 700) => {
    const m = map.current;
    const r = latest.current.route;
    if (m && anim.current) {
      stopDraw();
      landFlight(m);
      apply();
    }
    if (!m || !r || r.length < 2) return;
    m.fitBounds(routeBounds(r), { padding: framePadding(m), duration, maxZoom: 16 });
  };

  // Draw the route in from start to finish, the way Strava plays an activity
  // back: the line grows at a steady pace along the course with a dot at its
  // tip. About three seconds plus a bit per mile. As a flyover (the Replay
  // key on the satellite map) the camera flies the course too: pitched over
  // real terrain, looking along the way the run goes, following the tip,
  // slower; then it eases back to the overview.
  const startDraw = (fly = false) => {
    pendingDraw.current = false;
    const m = map.current;
    const r = latest.current.route;
    if (!m || !ready.current || !r || r.length < 2) {
      apply();
      return;
    }
    stopDraw();
    landFlight(m);
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
    const miles = total / 1609.344;
    const duration = fly ? Math.min(28000, 6000 + 2800 * miles) : Math.min(7000, 2600 + 550 * miles);
    const token = Math.random();
    setDrawing(true);
    setPaused(false);
    setDecor(m, false);
    routeSrc.setData(lineFromLngLat([pts[0], pts[0]]));
    headSrc.setData(pointFeature(pts[0]));
    // The course's heading at the tip; and the way the camera looks, which
    // is towards a point a little way ahead along the course, so the view
    // begins to turn into a corner as the tip comes up to it and is round
    // by the time it is through, rather than swinging at the corner itself.
    const headingAt = (i: number) => bearingBetween(pts[Math.max(0, i - 1)], pts[Math.min(pts.length - 1, i)]);
    const pointAlong = (target: number): LngLat => {
      let j = 1;
      while (j < cum.length - 1 && cum[j] < target) j++;
      const seg = cum[j] - cum[j - 1];
      const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[j - 1]) / seg)) : 1;
      return [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * f, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * f];
    };
    const lookFrom = (d: number, tip: LngLat) => {
      if (d + 5 >= total) return headingAt(pts.length - 1);
      return bearingBetween(tip, pointAlong(Math.min(total, d + LOOK_AHEAD)));
    };
    let bearing = lookFrom(0, pts[0]);
    // The camera's turn is sprung: it has a rate of turn that builds and
    // dies away (critically damped), so the heading never jumps, and its
    // change of heading never jumps either. That is what makes a turn
    // smooth rather than merely gradual.
    let turnRate = 0;   // degrees per second
    // The camera's height above the ground is set here, not left to the map:
    // with terrain, the map would otherwise lift or drop the camera the
    // moment a new elevation tile arrived under it, a jump mid-flight. The
    // ground under the tip is asked for each frame and followed gradually.
    let elev = 0;
    const groundAt = (p: LngLat) => (m.getTerrain() ? m.queryTerrainElevation(p) ?? elev : 0);
    // Time along the run, in ms of the run's own clock: it advances at the
    // speed key's rate, stands still while the fader is held, and is set
    // outright by a seek.
    let elapsed = 0;
    let held = false;      // the fader's cap under a finger
    let parked = false;    // the play key let up
    let last = 0;
    let k = 1;
    // Where along the course a distance falls: the segment, and the point.
    const indexAt = (target: number) => {
      if (target < cum[k - 1]) k = 1;
      while (k < cum.length - 1 && cum[k] < target) k++;
      const a = pts[k - 1];
      const b = pts[k];
      const seg = cum[k] - cum[k - 1];
      const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[k - 1]) / seg)) : 1;
      const tip: LngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return tip;
    };
    const distanceAt = (u: number) => (fly ? u : easeInOut(u)) * total;
    control.current = {
      hold: (on) => {
        held = on;
      },
      pause: (on) => {
        parked = on;
      },
      seek: (u) => {
        elapsed = u * duration;
        if (fly) {
          // The camera goes straight to the new spot, looking the way the run goes there.
          const d = distanceAt(u);
          const tip = indexAt(d);
          bearing = lookFrom(d, tip);
          turnRate = 0;
          elev = groundAt(tip);
        }
      },
    };
    paintScrub(0);
    const frame = (now: number) => {
      if (!anim.current || anim.current.token !== token) return;
      const dt = Math.min(0.1, (now - last) / 1000);   // for the camera's smoothing: a stalled frame is not a lurch
      if (!held && !parked) elapsed = Math.min(duration, elapsed + (now - last) * speed.current);   // the run keeps real time
      last = now;
      const u = Math.min(1, elapsed / duration);
      const d = distanceAt(u);
      const tip = indexAt(d);
      const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
      const head = m.getSource("head") as maplibregl.GeoJSONSource | undefined;
      if (!src || !head) {
        anim.current = null;
        control.current = null;
        setDrawing(false);
        return;
      }
      src.setData(lineFromLngLat([...pts.slice(0, k), tip]));
      head.setData(pointFeature(tip));
      paintScrub(u);
      if (fly) {
        // the sprung turn towards the way ahead, quicker at speed; the spring
        // is stepped in small pieces so a slow frame cannot make it overshoot
        const w = 3.2 * Math.sqrt(speed.current);   // the spring's natural frequency, per second
        for (let left = dt; left > 0; left -= 1 / 120) {
          const step = Math.min(left, 1 / 120);
          turnRate += (turnTowards(bearing, lookFrom(d, tip)) * w * w - 2 * w * turnRate) * step;
          bearing += turnRate * step;
        }
        elev += (groundAt(tip) - elev) * Math.min(1, dt * 3 * speed.current);
        m.jumpTo({ center: tip, elevation: elev, bearing, pitch: FLY_PITCH, zoom: FLY_ZOOM, padding: flyPadding(m) });
      }
      if (u < 1 || held || parked) {
        anim.current = { raf: requestAnimationFrame(frame), token };
      } else {
        src.setData(lineFromLngLat(pts));
        head.setData(EMPTY);
        anim.current = null;
        control.current = null;
        setDecor(m, true);
        setDrawing(false);
        setPaused(false);
        if (fly) {
          // A moment at the finish, then back up to the whole course; terrain
          // goes off once the map is level again, so panning stays quick.
          window.setTimeout(() => {
            if (!map.current) return;
            m.once("moveend", () => landFlight(m));
            const { center, zoom } = overview(m, r);
            m.easeTo({ center, zoom, pitch: 0, bearing: 0, padding: NO_PADDING, duration: 1600, essential: true });
          }, 900);
        }
      }
    };
    const begin = () => {
      if (!anim.current || anim.current.token !== token) return;
      last = performance.now();
      anim.current = { raf: requestAnimationFrame(frame), token };
    };
    // The draw is on record from here, so a stop cancels whatever stage it is at.
    anim.current = { raf: 0, token };
    if (!fly) {
      begin();
      return;
    }
    // The flight: terrain on, and once the map has the ground in (or has had
    // a fair moment to get it), the camera swings down onto the start; the
    // run sets off the moment it lands, and not before.
    flying.current = true;
    scaleRoute(m, FLY_THICK);
    m.setCenterClampedToGround(false);
    if (m.getSource("terrain") && !m.getTerrain()) m.setTerrain({ source: "terrain", exaggeration: 1.2 });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      m.off("idle", settle);
      if (!anim.current || anim.current.token !== token) return;
      elev = groundAt(pts[0]);
      m.once("moveend", begin);
      m.easeTo({ center: pts[0], elevation: elev, zoom: FLY_ZOOM, pitch: FLY_PITCH, bearing, duration: 1400, padding: flyPadding(m), essential: true });
    };
    m.once("idle", settle);
    window.setTimeout(settle, 2500);
  };
  useEffect(() => {
    startDrawRef.current = startDraw;
    fitRef.current = fit;
  });

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: styleFor(applied.current),
      // A world view until the user searches, clicks, or shares their location.
      center: [10, 25],
      zoom: 1.4,
      maxPitch: 72,   // the flyover looks along the course, well past the default 60
      attributionControl: false,
    });
    // Zoom keys are drawn by this component, in the same style as the others.
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    // MapLibre opens the attribution by itself whenever a source with one
    // loads on a narrow map. Keep it folded to its button unless it was
    // tapped open; a tap sets the flag, and a second tap folds it again.
    const attrib = m.getContainer().querySelector<HTMLElement>(".maplibregl-ctrl-attrib");
    let tapped = false;
    attrib?.querySelector(".maplibregl-ctrl-attrib-button")?.addEventListener("click", () => {
      tapped = true;
    });
    const folder = new MutationObserver(() => {
      if (attrib && !tapped && attrib.classList.contains("maplibregl-compact-show")) attrib.classList.remove("maplibregl-compact-show");
    });
    if (attrib) {
      attrib.classList.remove("maplibregl-compact-show");
      folder.observe(attrib, { attributes: true, attributeFilter: ["class"] });
    }
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
      // The dark casing serves the satellite map too: white is lost against the imagery.
      addRouteLayers(m, applied.current !== "day");
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
      folder.disconnect();
      // The marker belongs to this map; a remount must make a fresh one.
      marker.current?.remove();
      marker.current = null;
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // A phone's day and night follow its setting until a basemap is picked by hand.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(DARK);
    const follow = () => {
      if (!chosen.current) setBasemap(deviceBasemap());
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
      if (!inView(m, r)) fitRef.current(450);
      return () => clearTimeout(settle);
    }
    pendingDraw.current = true;
    apply();
    (m.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    fitRef.current(900);
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
  const zoom = (by: number) => map.current?.zoomTo(map.current.getZoom() + by, { duration: 300 });
  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" aria-label="Map" />
      {/* Keys on the glass, all one height: the basemap in a slot, then the route keys; zoom at the right. */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2" style={{ right: "calc(0.75rem + 36px + 0.5rem)" }}>
        <Seg
          map
          options={BASEMAPS}
          value={basemap}
          label="Basemap"
          onChange={(k) => {
            chosen.current = true;
            setBasemap(k);
          }}
        />
        {hasRoute && (
          <button type="button" className="map-btn map-icon" onClick={() => fit()} title="Bring the whole route back on screen" aria-label="Recenter">
            <Icon name="frame" />
            <span className="map-label">Recenter</span>
          </button>
        )}
        {hasRoute && hasIdeal && (
          <button
            type="button"
            className="map-btn map-icon"
            onClick={toggleIdeal}
            aria-pressed={showIdeal}
            title="Show or hide the shape the route is trying to draw"
            aria-label="Target shape"
          >
            <Icon name="eye" />
            <span className="map-label">Target</span>
          </button>
        )}
      </div>
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-2">
        <button type="button" className="map-btn map-sq" onClick={() => zoom(1)} aria-label="Zoom in" title="Zoom in">
          <Icon name="plus" />
        </button>
        <button type="button" className="map-btn map-sq" onClick={() => zoom(-1)} aria-label="Zoom out" title="Zoom out">
          <Icon name="minus" />
        </button>
      </div>
      {/* The transport, while a replay runs: a speed key, and a fader whose cap
          follows the run and can be dragged to any point of it. Holding the cap
          holds the run; letting go sets it off again from there. */}
      {hasRoute && drawing && (
        <div className="transport left-3" style={{ right: "calc(0.75rem + 44px + 0.5rem)", bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <button type="button" className="map-btn map-speed" onClick={nextSpeed} aria-label={`Speed: ${speedShown} times. Press for the next.`} title="Speed">
            {speedShown}×
          </button>
          <div
            ref={scrubEl}
            className="scrub"
            role="slider"
            aria-label="Where along the run"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              control.current?.hold(true);
              control.current?.seek(scrubAt(e));
            }}
            onPointerMove={(e) => {
              if (e.buttons) control.current?.seek(scrubAt(e));
            }}
            onPointerUp={() => control.current?.hold(false)}
            onPointerCancel={() => control.current?.hold(false)}
            onKeyDown={(e) => {
              const now = Number(scrubEl.current?.getAttribute("aria-valuenow") ?? 0) / 100;
              if (e.key === "ArrowRight" || e.key === "ArrowUp") control.current?.seek(Math.min(1, now + 0.02));
              else if (e.key === "ArrowLeft" || e.key === "ArrowDown") control.current?.seek(Math.max(0, now - 0.02));
              else return;
              e.preventDefault();
            }}
          >
            <div className="scrub-groove" aria-hidden="true">
              <div ref={fillEl} className="scrub-fill" />
            </div>
            <div ref={capEl} className="scrub-cap" aria-hidden="true" />
          </div>
        </div>
      )}
      {hasRoute && (
        <div className="absolute right-3 z-10" style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <button
            type="button"
            className="map-round"
            data-down={drawing && !paused ? "" : undefined}
            onClick={() => {
              if (!drawing) {
                startDraw(basemap === "satellite");
                return;
              }
              // mid-run the key is a pause key: up holds the run where it is, down sets it off again
              const on = !paused;
              setPaused(on);
              control.current?.pause(on);
            }}
            aria-label={drawing ? (paused ? "Carry on" : "Pause") : basemap === "satellite" ? "Fly the route" : "Replay the route drawing"}
            title={drawing ? (paused ? "Carry on" : "Pause") : basemap === "satellite" ? "Fly the route: first person, over the terrain" : "Replay"}
          >
            {/* The mark, pressed into the face: the floor of the cut in shade, a
                band of deeper shade along its upper edges where the cut's wall shadows
                it, and a thread of light along its lower edges where the lip catches
                the light. Three copies of one shape (a play triangle, or two bars for
                pause while the run plays): the lit lip a touch below, the shade, and
                the floor shifted down and clipped to the cut. */}
            <svg className="play-mark" viewBox="0 0 24 24" aria-hidden="true">
              <defs>
                <clipPath id="play-cut">
                  <path d={drawing && !paused ? PAUSE : PLAY} />
                </clipPath>
              </defs>
              <path className="play-lip" d={drawing && !paused ? PAUSE : PLAY} transform="translate(0 1.1)" />
              <path className="play-shade" d={drawing && !paused ? PAUSE : PLAY} />
              <path className="play-floor" d={drawing && !paused ? PAUSE : PLAY} transform="translate(0 1.25)" clipPath="url(#play-cut)" />
            </svg>
          </button>
        </div>
      )}
      {props.picking && !props.pin && (
        <div
          className="hint pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
          role="status"
        >
          Search a place, or tap the map to set your start
        </div>
      )}
    </div>
  );
}
