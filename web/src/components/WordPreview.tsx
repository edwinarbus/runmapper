"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EstimateStroke } from "@/lib/api";

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** The typed word as the engine will run it: a faint full path, an orange
 *  line that draws itself in, and a dot running along the tip. Stroke
 *  widths are given in user units from the measured scale, so the dash
 *  animation (pathLength = 1) stays exact at any size. */
export default function WordPreview({ strokes }: { strokes: EstimateStroke[] }) {
  const svg = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(220); // screen px per user unit
  const { d, vb, vbW, vbH } = useMemo(() => {
    const all = strokes.flatMap((s) => s.pts);
    if (all.length < 2) return { d: "", vb: "0 0 1 1", vbW: 1, vbH: 1 };
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
    const pad = Math.max(w, h) * 0.08;
    const path = strokes
      .filter((s) => s.pts.length > 1)
      .map((s) => `M${s.pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}${s.closed ? "Z" : ""}`)
      .join("");
    return { d: path, vb: `${fmt(x0 - pad)} ${fmt(y0 - pad)} ${fmt(w + 2 * pad)} ${fmt(h + 2 * pad)}`, vbW: w + 2 * pad, vbH: h + 2 * pad };
  }, [strokes]);

  // How many screen pixels one user unit gets (xMidYMid meet: the smaller ratio).
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setScale(Math.min(r.width / vbW, r.height / vbH));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [vbW, vbH]);

  if (!d) return null;
  const px = (n: number) => n / scale;
  return (
    <svg ref={svg} className="wp" viewBox={vb} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path d={d} className="wp-ghost" style={{ strokeWidth: px(5) }} />
      <path d={d} className="wp-line" pathLength={1} style={{ strokeWidth: px(5) }} />
      <circle r={px(4.5)} className="wp-dot" style={{ offsetPath: `path("${d}")`, strokeWidth: px(2.5) }} />
    </svg>
  );
}
