// Words for the answers: how a verdict reads, the distance tiles, compass points.

import type { Bucket } from "./api";

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
export const TILE: Record<Bucket, string> = { "5k": "5K", "10k": "10K", long: "Half" };

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
