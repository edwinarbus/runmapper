"use client";

import { useMemo } from "react";
import type { EstimateStroke } from "@/lib/api";

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** The typed word as the engine will run it: one orange line, still. */
export default function WordPreview({ strokes }: { strokes: EstimateStroke[] }) {
  const { d, vb } = useMemo(() => {
    const all = strokes.flatMap((s) => s.pts);
    if (all.length < 2) return { d: "", vb: "0 0 1 1" };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of all) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const w = Math.max(x1 - x0, 1e-6);
    const h = Math.max(y1 - y0, 1e-6);
    const pad = Math.max(w, h) * 0.06;
    const path = strokes
      .filter((s) => s.pts.length > 1)
      .map((s) => `M${s.pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}${s.closed ? "Z" : ""}`)
      .join("");
    return { d: path, vb: `${fmt(x0 - pad)} ${fmt(y0 - pad)} ${fmt(w + 2 * pad)} ${fmt(h + 2 * pad)}` };
  }, [strokes]);
  if (!d) return null;
  return (
    <svg className="wp" viewBox={vb} preserveAspectRatio="xMinYMid meet" aria-hidden="true">
      <path d={d} className="wp-line" />
    </svg>
  );
}
