import { CUSTOM_OVER } from "@/lib/api";
import type { Bucket, Units } from "@/lib/api";
// Words for the answers: how a verdict reads, the distance tiles, compass points.


/** How a verdict reads: the stamp on the bib, the word on a peeking bib, its ink. */
export const VERDICT: Record<string, { label: string; word: string; ink: string }> = {
  great: { label: "Great match", word: "great", ink: "#1f9d55" },
  good: { label: "OK match", word: "ok", ink: "#2563eb" },
  rough: { label: "Rough fit", word: "rough", ink: "#d97706" },
  bad: { label: "No fit", word: "no fit", ink: "#dc2626" },
  over: { label: "Too long", word: "too long", ink: "#dc2626" },
};
export const verdictOf = (v: string) => VERDICT[v] ?? VERDICT.rough;

/** Labels for the distance tiles: the Longer bucket tops out around a half marathon. */
export const TILE: Partial<Record<Bucket, string>> = { "5k": "5K", "10k": "10K", long: "Half" };

/** The distance a run was asked for, as its key reads: 5K, 10K, Half, or a
 *  custom distance in the runner's own units ("7.5 mi", "12 km"). */
export function bucketTile(b: { key: Bucket; label: string; cap_mi: number; target_mi?: number | null }, units: Units): string {
  const fixed = TILE[b.key];
  if (fixed) return fixed;
  const mi = b.target_mi ?? b.cap_mi / CUSTOM_OVER;
  const n = units === "mi" ? mi : mi * 1.609344;
  return `${n.toFixed(1).replace(/\.0$/, "")} ${units}`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
