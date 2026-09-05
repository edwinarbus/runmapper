"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { PAD_ASPECT, type Pt, simplify, strokeLength } from "@/lib/drawing";
import Icon from "./Icon";

// A pad to draw the shape on, by finger or mouse. One pointer at a time,
// every point the browser coalesced, a light simplification when the
// stroke ends. Points are kept in units of the pad's width, so the drawing
// keeps its proportions whatever the pad's size.

const TOL = 0.004;          // simplification, about a pixel and a half on a phone
const MIN_LEN = 0.02;       // a stroke shorter than this is a slip, not a mark

/** Everything on the pad: the strokes, then the one under the finger. */
function paint(c: HTMLCanvasElement, w: number, h: number, strokes: Pt[][], live: Pt[] | null) {
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.lineCap = "round";
  g.lineJoin = "round";
  const all = live ? [...strokes, live] : strokes;
  for (const [color, width] of [
    ["#0b0b0d", 9],
    ["#fc5200", 5],
  ] as [string, number][]) {
    g.strokeStyle = color;
    g.lineWidth = width;
    for (const s of all) {
      if (!s.length) continue;
      // The line as drawn, point to point: what the engine will get.
      g.beginPath();
      g.moveTo(s[0][0] * w, s[0][1] * w);
      if (s.length === 1) g.lineTo(s[0][0] * w + 0.01, s[0][1] * w);
      for (let i = 1; i < s.length; i++) g.lineTo(s[i][0] * w, s[i][1] * w);
      g.stroke();
    }
  }
}

export default function DrawPad({ strokes, onChange }: { strokes: Pt[][]; onChange: (s: Pt[][]) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<Pt[] | null>(null);   // the stroke under the finger
  const pid = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drawing, setDrawing] = useState(false);

  // The canvas follows its box, at the device's resolution.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Repaint whenever the strokes or the size change.
  useEffect(() => {
    if (canvas.current && size.w) paint(canvas.current, size.w, size.h, strokes, live.current);
  }, [strokes, size]);

  const repaint = () => {
    if (canvas.current && size.w) paint(canvas.current, size.w, size.h, strokes, live.current);
  };
  const at = (clientX: number, clientY: number): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.width];
  };
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pid.current !== null) return;    // one finger draws; a second is ignored
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    pid.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    live.current = [at(e.clientX, e.clientY)];
    setDrawing(true);
    repaint();
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pid.current !== e.pointerId || !live.current) return;
    const ne = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const evs = ne.getCoalescedEvents?.() ?? [];
    if (evs.length) for (const ce of evs) live.current.push(at(ce.clientX, ce.clientY));
    else live.current.push(at(e.clientX, e.clientY));
    repaint();
  };
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pid.current !== e.pointerId) return;
    pid.current = null;
    const s = live.current;
    live.current = null;
    setDrawing(false);
    if (s && strokeLength(s) >= MIN_LEN) {
      let pts = simplify(s, TOL);
      // A line drawn back to where it began is a closed shape: shut it exactly.
      const [x0, y0] = pts[0];
      const [x1, y1] = pts[pts.length - 1];
      if (pts.length > 3 && Math.hypot(x1 - x0, y1 - y0) < 0.03) pts = [...pts.slice(0, -1), [x0, y0]];
      onChange([...strokes, pts]);
    } else repaint();
  };

  return (
    <div>
      <div ref={box} className="pad" style={{ aspectRatio: `1 / ${PAD_ASPECT}` }}>
        <canvas
          ref={canvas}
          aria-label="Drawing pad: draw the shape to run"
          role="img"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {strokes.length === 0 && !drawing && (
          <div className="pad-ghost" aria-hidden="true">
            {/* A pencil pressed into the surface: the point, a long plain body, and at the far
                end the ferrule's two rings with the eraser beyond them. */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
              <path d="M4.5 19.5 8.17 18.65 19.31 7.51 16.49 4.69 5.35 15.83Z" />
              <path d="M8.17 18.65 5.35 15.83" />
              <path d="M5.88 19.18 4.82 18.12" />
              <path d="M17.75 9.07 14.93 6.25M16.91 9.91 14.09 7.09" />
            </svg>
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn btn-sm" disabled={!strokes.length} onClick={() => onChange(strokes.slice(0, -1))}>
          <Icon name="undo" />
          Undo
        </button>
        <button type="button" className="btn btn-sm" disabled={!strokes.length} onClick={() => onChange([])}>
          <Icon name="eraser" />
          Clear
        </button>
      </div>
    </div>
  );
}
