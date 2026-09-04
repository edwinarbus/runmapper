// Small planar geometry on [lat, lon] pairs; plenty for a run-sized route.

export type LatLonPair = [number, number];

/** Metres between two points. */
export function metres(a: LatLonPair, b: LatLonPair): number {
  const k = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  const dx = (b[1] - a[1]) * 111320 * k;
  const dy = (b[0] - a[0]) * 110540;
  return Math.hypot(dx, dy);
}
