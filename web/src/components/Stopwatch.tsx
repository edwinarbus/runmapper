"use client";

import { useEffect, useState } from "react";
import Icon from "./Icon";

// A mechanical stopwatch while the engine searches: the hand sweeps a real
// minute in fifths of a second, a small dial at the bottom counts the spots
// tried as laps, the window shows the time, the orange arc round the bezel
// is the engine's own progress, and the crown stops it.

const CX = 60;
const CY = 74;
const R_FACE = 46;

const TICKS = Array.from({ length: 60 }, (_, i) => {
  const a = (i / 60) * Math.PI * 2;
  const major = i % 5 === 0;
  const r0 = major ? 39.5 : 42;
  const r1 = 45;
  return { key: i, major, x1: CX + Math.sin(a) * r0, y1: CY - Math.cos(a) * r0, x2: CX + Math.sin(a) * r1, y2: CY - Math.cos(a) * r1 };
});
const NUMERALS = Array.from({ length: 12 }, (_, i) => {
  const n = (i + 1) * 5;
  const a = (n / 60) * Math.PI * 2;
  return { key: n, label: String(n), x: CX + Math.sin(a) * 34, y: CY - Math.cos(a) * 34 + 2.8 };
});
const LAP_Y = 93;
const LAP_TICKS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return { key: i, x1: CX + Math.sin(a) * 6.5, y1: LAP_Y - Math.cos(a) * 6.5, x2: CX + Math.sin(a) * 8.5, y2: LAP_Y - Math.cos(a) * 8.5 };
});
const KNURLS = [-5, -3, -1, 1, 3, 5];

export default function Stopwatch({
  pct,
  msg,
  laps,
  startedAt,
  onStop,
}: {
  pct: number;
  msg: string;
  laps: number;
  startedAt: number;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const secs = Math.max(0, now - startedAt) / 1000;
  const angle = (Math.floor(secs * 5) / 5 % 60) * 6;   // fifths of a second, like the real thing
  const mm = Math.floor(secs / 60);
  const ss = Math.floor(secs % 60);
  const tenths = Math.floor((secs * 10) % 10);
  const clock = `${mm}:${String(ss).padStart(2, "0")}.${tenths}`;
  const arc = 2 * Math.PI * 50;
  const p = Math.min(1, Math.max(0, pct / 100));
  const lapAngle = (laps % 12) * 30;
  // The starter's call over the first seconds, while the streets load.
  const call = secs < 1.0 ? "On your marks" : secs < 1.9 ? "Set" : secs < 2.8 ? "Go!" : null;

  return (
    <div className="flex items-center gap-4">
      <svg className="watch" viewBox="0 0 120 134" role="img" aria-label={`Stopwatch: ${clock} elapsed, ${laps} spots tried`}>
        <defs>
          <linearGradient id="sw-steel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4f4f6" />
            <stop offset="0.35" stopColor="#b9b9c0" />
            <stop offset="0.7" stopColor="#6d6d75" />
            <stop offset="1" stopColor="#3a3a40" />
          </linearGradient>
          <linearGradient id="sw-steel-2" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8d8d95" />
            <stop offset="0.5" stopColor="#e6e6ea" />
            <stop offset="1" stopColor="#77777f" />
          </linearGradient>
          <radialGradient id="sw-face" cx="0.5" cy="0.4" r="0.7">
            <stop offset="0" stopColor="#fcfbf7" />
            <stop offset="0.75" stopColor="#eeebe3" />
            <stop offset="1" stopColor="#d3cfc3" />
          </radialGradient>
          <linearGradient id="sw-glass" x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0.05" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* crown, knurled, and the side pusher */}
        <rect x="56" y="13" width="8" height="8" fill="url(#sw-steel-2)" />
        <rect x="51" y="2" width="18" height="12" rx="2.5" fill="url(#sw-steel)" stroke="#26262b" strokeWidth="0.8" />
        {KNURLS.map((k) => (
          <line key={k} x1={60 + k} y1="4" x2={60 + k} y2="12" stroke="#4b4b52" strokeWidth="0.7" />
        ))}
        <g transform={`rotate(42 ${CX} ${CY})`}>
          <rect x="56.5" y="15" width="7" height="8" fill="url(#sw-steel-2)" />
          <rect x="53.5" y="8" width="13" height="9" rx="2" fill="url(#sw-steel)" stroke="#26262b" strokeWidth="0.8" />
        </g>
        {/* bezel */}
        <circle cx={CX} cy={CY} r="56" fill="url(#sw-steel)" stroke="#1b1b1f" strokeWidth="1" />
        <circle cx={CX} cy={CY} r="52.5" fill="#24242a" />
        {/* progress arc in the groove */}
        <circle cx={CX} cy={CY} r="50" fill="none" stroke="#3a3a42" strokeWidth="3" />
        <circle
          cx={CX}
          cy={CY}
          r="50"
          fill="none"
          stroke="#fc5200"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${arc * p} ${arc}`}
          transform={`rotate(-90 ${CX} ${CY})`}
          style={{ transition: "stroke-dasharray 0.5s ease" }}
        />
        <circle cx={CX} cy={CY} r={R_FACE + 1.5} fill="#c9c6bb" />
        {/* face */}
        <circle cx={CX} cy={CY} r={R_FACE} fill="url(#sw-face)" />
        <g stroke="#2a2a2e">
          {TICKS.map((t) => (
            <line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeWidth={t.major ? 1.6 : 0.7} />
          ))}
        </g>
        {NUMERALS.map((t) => (
          <text key={t.key} x={t.x} y={t.y} textAnchor="middle" className="watch-num">
            {t.label}
          </text>
        ))}
        {/* the time, in a window above the pivot */}
        <rect x="40" y="48" width="40" height="13" rx="1.5" fill="#1b1b1f" />
        <text x={CX} y="58" textAnchor="middle" className="watch-time">
          {clock}
        </text>
        {/* lap dial below the pivot */}
        <circle cx={CX} cy={LAP_Y} r="10" fill="#e6e2d8" stroke="#b9b5a9" strokeWidth="0.8" />
        <g stroke="#3a3a3f" strokeWidth="0.7">
          {LAP_TICKS.map((t) => (
            <line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
          ))}
        </g>
        <g transform={`rotate(${lapAngle} ${CX} ${LAP_Y})`}>
          <line x1={CX} y1={LAP_Y + 1.5} x2={CX} y2={LAP_Y - 6.5} stroke="#1b1b1f" strokeWidth="1.1" strokeLinecap="round" />
        </g>
        <circle cx={CX} cy={LAP_Y} r="1.1" fill="#1b1b1f" />
        <text x={CX} y={LAP_Y + 7} textAnchor="middle" className="watch-lap">
          LAP {String(laps).padStart(2, "0")}
        </text>
        {/* the sweep hand */}
        <g transform={`rotate(${angle} ${CX} ${CY})`}>
          <line x1={CX} y1={CY + 10} x2={CX} y2={CY - 42} stroke="#fc5200" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx={CX} cy={CY - 42} r="1.6" fill="#fc5200" />
          <circle cx={CX} cy={CY} r="3.2" fill="#1b1b1f" />
          <circle cx={CX} cy={CY} r="1.3" fill="#fc5200" />
        </g>
        {/* glass */}
        <ellipse cx="46" cy="50" rx="30" ry="18" fill="url(#sw-glass)" transform={`rotate(-22 46 50)`} />
        <circle cx={CX} cy={CY} r={R_FACE} fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="1" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="eyebrow">{call ? "Start" : "Searching"}</div>
        {call ? (
          <div key={call} className="call font-display">
            {call}
          </div>
        ) : (
          <div className="mt-1 text-[13px] leading-snug text-[var(--ink-2)]" aria-live="polite">
            {msg}…
          </div>
        )}
        <button type="button" onClick={onStop} className="btn btn-sm mt-3">
          <Icon name="stop" className="text-[#ff6b61]" />
          Stop
        </button>
      </div>
    </div>
  );
}
