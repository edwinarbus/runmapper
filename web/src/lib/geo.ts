// Small planar geometry on [lat, lon] pairs; plenty for a run-sized route.

export type LatLonPair = [number, number];

/** Metres between two points. */
export function metres(a: LatLonPair, b: LatLonPair): number {
  const k = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  const dx = (b[1] - a[1]) * 111320 * k;
  const dy = (b[0] - a[0]) * 110540;
  return Math.hypot(dx, dy);
}

export interface DistanceMarker {
  n: number;
  lat: number;
  lon: number;
}

/** Where each whole unit (a mile or a kilometre, `step` metres) falls along the route. */
export function distanceMarkers(coords: LatLonPair[], step: number): DistanceMarker[] {
  const out: DistanceMarker[] = [];
  let acc = 0;
  let next = step;
  let n = 1;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = metres(a, b);
    while (d > 0 && acc + d >= next) {
      const f = (next - acc) / d;
      out.push({ n, lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f });
      n++;
      next += step;
    }
    acc += d;
  }
  return out;
}
