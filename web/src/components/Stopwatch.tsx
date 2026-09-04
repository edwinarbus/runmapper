"use client";

import { useEffect, useState } from "react";
import Icon from "./Icon";

// A mechanical stopwatch while the engine searches: the hand sweeps a real
// minute, the lap counter clicks up as each spot is tried, the orange arc
// around the bezel is the engine's own progress, and the crown stops it.

const CX = 60;
const CY = 72;

const TICKS = Array.from({ length: 60 }, (_, i) => {
  const a = (i / 60) * Math.PI * 2;
  const major = i % 5 === 0;
  const r0 = major ? 36 : 39.5;
  const r1 = 43;
  return {
    key: i,
    major,
    x1: CX + Math.sin(a) * r0,
    y1: CY - Math.cos(a) * r0,
    x2: CX + Math.sin(a) * r1,
    y2: CY - Math.cos(a) * r1,
  };
});

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
  const angle = (secs % 60) * 6;
  const mm = Math.floor(secs / 60);
  const ss = Math.floor(secs % 60);
  const tenths = Math.floor((secs * 10) % 10);
  const clock = `${mm}:${String(ss).padStart(2, "0")}.${tenths}`;
  const arc = 2 * Math.PI * 47;
  const p = Math.min(1, Math.max(0, pct / 100));
  // The starter's call over the first seconds, while the streets load.
  const call = secs < 1.0 ? "On your marks" : secs < 1.9 ? "Set" : secs < 2.8 ? "Go!" : null;

  return (
    <div className="flex items-center gap-4">
      <svg className="watch" viewBox="0 0 120 128" role="img" aria-label={`Stopwatch: ${clock} elapsed, ${laps} spots tried`}>
        <defs>
          <linearGradient id="sw-steel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f0f0f2" />
            <stop offset="0.45" stopColor="#a8a8ae" />
            <stop offset="1" stopColor="#55555c" />
          </linearGradient>
          <linearGradient id="sw-steel-2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d6d6da" />
            <stop offset="1" stopColor="#7d7d85" />
          </linearGradient>
          <radialGradient id="sw-face" cx="0.5" cy="0.42" r="0.7">
            <stop offset="0" stopColor="#fbfaf6" />
            <stop offset="0.8" stopColor="#efece4" />
            <stop offset="1" stopColor="#d9d5ca" />
          </radialGradient>
        </defs>
        {/* crown and side pusher */}
        <rect x="56.5" y="12" width="7" height="8" fill="url(#sw-steel-2)" />
        <rect x="52" y="2" width="16" height="11" rx="2.5" fill="url(#sw-steel)" stroke="#2a2a2e" strokeWidth="0.8" />
        <g transform={`rotate(45 ${CX} ${CY})`}>
          <rect x="56.5" y="15" width="7" height="7" fill="url(#sw-steel-2)" />
          <rect x="54" y="8" width="12" height="9" rx="2" fill="url(#sw-steel)" stroke="#2a2a2e" strokeWidth="0.8" />
        </g>
        {/* bezel */}
        <circle cx={CX} cy={CY} r="53" fill="url(#sw-steel)" stroke="#1b1b1f" strokeWidth="1" />
        <circle cx={CX} cy={CY} r="49.5" fill="#26262c" />
        {/* progress arc in the bezel groove */}
        <circle
          cx={CX}
          cy={CY}
          r="47"
          fill="none"
          stroke="#fc5200"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${arc * p} ${arc}`}
          transform={`rotate(-90 ${CX} ${CY})`}
          style={{ transition: "stroke-dasharray 0.5s ease" }}
        />
        {/* face */}
        <circle cx={CX} cy={CY} r="44.5" fill="url(#sw-face)" />
        <g stroke="#2a2a2e">
          {TICKS.map((t) => (
            <line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeWidth={t.major ? 1.8 : 0.8} />
          ))}
        </g>
        <text x={CX} y="42" textAnchor="middle" className="watch-num">60</text>
        <text x="94" y="75.5" textAnchor="middle" className="watch-num">15</text>
        <text x={CX} y="108" textAnchor="middle" className="watch-num">30</text>
        <text x="26" y="75.5" textAnchor="middle" className="watch-num">45</text>
        {/* lap counter and the time */}
        <text x={CX} y="58" textAnchor="middle" className="watch-lap">
          LAP {String(laps).padStart(2, "0")}
        </text>
        <rect x="41" y="82" width="38" height="13" rx="1.5" fill="#1b1b1f" />
        <text x={CX} y="92" textAnchor="middle" className="watch-time">
          {clock}
        </text>
        {/* hand */}
        <g transform={`rotate(${angle} ${CX} ${CY})`}>
          <line x1={CX} y1={CY + 9} x2={CX} y2={CY - 41} stroke="#fc5200" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx={CX} cy={CY} r="3" fill="#1b1b1f" />
          <circle cx={CX} cy={CY} r="1.2" fill="#fc5200" />
        </g>
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
