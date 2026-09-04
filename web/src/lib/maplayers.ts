// The route's sources, layers and images on a MapLibre map, shared by the
// live map and the offscreen GIF renderer.

import maplibregl from "maplibre-gl";

export const STRAVA_ORANGE = "#FC5200";
export const ARROW = "route-arrow";
export type LngLat = [number, number];
export const EMPTY = { type: "FeatureCollection" as const, features: [] };

export function lineFeature(coords: [number, number][]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords.map(([lat, lon]) => [lon, lat]) },
  };
}

export function lineFromLngLat(coords: LngLat[]) {
  return { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } };
}

export function pointFeature(p: LngLat, properties: Record<string, number | string> = {}) {
  return { type: "Feature" as const, properties, geometry: { type: "Point" as const, coordinates: p } };
}

export function routeBounds(r: [number, number][]) {
  const b = new maplibregl.LngLatBounds();
  for (const [lat, lon] of r) b.extend([lon, lat]);
  return b;
}

export const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

/** A small white chevron placed along the route so the direction of travel
 *  is obvious. It points +x, which MapLibre turns along the line. */
export function arrowImage(): ImageData | null {
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

/** A mile (or km) marker: a white disc with an orange ring and the number. */
export function markerImage(n: number): ImageData | null {
  if (typeof document === "undefined") return null;
  const s = 52;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d");
  if (!g) return null;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 4, 0, Math.PI * 2);
  g.fillStyle = "#ffffff";
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = STRAVA_ORANGE;
  g.stroke();
  g.fillStyle = "#151517";
  g.font = `700 ${n >= 10 ? 21 : 24}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(n), s / 2, s / 2 + 1);
  return g.getImageData(0, 0, s, s);
}

export function ensureMarkerImages(m: maplibregl.Map, ns: number[]) {
  for (const n of ns) {
    const id = `mk-${n}`;
    if (m.hasImage(id)) continue;
    const img = markerImage(n);
    if (img) m.addImage(id, img, { pixelRatio: 2 });
  }
}

/** Chevrons and distance marks: hidden while the line is still growing. */
export function setDecor(m: maplibregl.Map, visible: boolean) {
  for (const id of ["route-arrows", "miles"]) {
    if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

/** Sources and layers for one route: glow or shadow, casing, line, the
 *  target shape, chevrons, start, finish, distance marks and the draw head. */
export function addRouteLayers(m: maplibregl.Map, night: boolean) {
  if (m.getSource("route")) return;
  if (!m.hasImage(ARROW)) {
    const img = arrowImage();
    if (img) m.addImage(ARROW, img, { pixelRatio: 2 });
  }
  for (const id of ["route", "ideal", "start", "finish", "miles", "head"]) m.addSource(id, { type: "geojson", data: EMPTY });
  // Under the line: an orange glow at night, a soft shadow by day.
  m.addLayer({
    id: "route-shadow",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: night
      ? { "line-color": STRAVA_ORANGE, "line-width": 18, "line-opacity": 0.45, "line-blur": 12 }
      : { "line-color": "#000000", "line-width": 14, "line-opacity": 0.16, "line-blur": 6, "line-translate": [0, 2] },
  });
  m.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": night ? "#141417" : "#ffffff", "line-width": 9, "line-opacity": 0.9 },
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
    paint: { "line-color": night ? "#7cc4ff" : "#2563eb", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.85 },
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
    id: "miles",
    type: "symbol",
    source: "miles",
    layout: {
      "icon-image": ["concat", "mk-", ["to-string", ["get", "n"]]],
      "icon-size": 1,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      visibility: "none",
    },
  });
  m.addLayer({
    id: "head",
    type: "circle",
    source: "head",
    paint: { "circle-radius": 6, "circle-color": STRAVA_ORANGE, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
  });
}
