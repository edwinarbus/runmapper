"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE || "https://tiles.openfreemap.org/styles/positron";
export const STRAVA_ORANGE = "#FC5200";

// Used when the basemap style can't be fetched, so the route still shows.
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#f4f4f5" } }],
};

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

function lineFeature(coords: [number, number][]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords.map(([lat, lon]) => [lon, lat]) },
  };
}

export default function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  // Push the current props into the map's sources and layers.
  const apply = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const p = latest.current;
    const route = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
    const ideal = m.getSource("ideal") as maplibregl.GeoJSONSource | undefined;
    const start = m.getSource("start") as maplibregl.GeoJSONSource | undefined;
    route?.setData(p.route && p.route.length > 1 ? lineFeature(p.route) : { type: "FeatureCollection", features: [] });
    ideal?.setData(
      p.ideal
        ? { type: "FeatureCollection", features: p.ideal.filter((s) => s.length > 1).map(lineFeature) }
        : { type: "FeatureCollection", features: [] },
    );
    start?.setData(
      p.start
        ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p.start[1], p.start[0]] } }
        : { type: "FeatureCollection", features: [] },
    );
    m.setLayoutProperty("ideal", "visibility", p.showIdeal ? "visible" : "none");
  };

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
    // If the basemap style can't be fetched (offline, blocked tiles), fall
    // back to a blank canvas so the route still draws.
    let fellBack = false;
    m.on("error", (e) => {
      if (ready.current || fellBack) return;
      const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
      if (/style|fetch|AJAXError/i.test(msg)) {
        fellBack = true;
        m.setStyle(FALLBACK_STYLE);
      }
    });
    const setup = () => {
      if (ready.current || m.getSource("route")) return;
      const empty = { type: "FeatureCollection" as const, features: [] };
      m.addSource("route", { type: "geojson", data: empty });
      m.addSource("ideal", { type: "geojson", data: empty });
      m.addSource("start", { type: "geojson", data: empty });
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
      ready.current = true;
      apply();
    };
    m.on("load", setup);
    m.on("style.load", setup);
    m.on("click", (e) => latest.current.onPick({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

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

  // Route / ideal / start data.
  useEffect(() => {
    apply();
    const m = map.current;
    if (!m || !props.route || props.route.length < 2) return;
    const b = new maplibregl.LngLatBounds();
    for (const [lat, lon] of props.route) b.extend([lon, lat]);
    m.fitBounds(b, { padding: 60, duration: 900, maxZoom: 16 });
  }, [props.route, props.ideal, props.start]);

  useEffect(() => {
    apply();
  }, [props.showIdeal]);

  return <div ref={el} className="h-full w-full" aria-label="Map" />;
}
