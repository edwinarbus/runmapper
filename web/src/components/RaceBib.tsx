"use client";

import type { Bucket, PlanOption, Units } from "@/lib/api";
import { BUCKETS, fmtDist } from "@/lib/api";
import { TILE, compass, verdictOf } from "@/lib/labels";
import Icon from "./Icon";

// The answers as race bibs pinned in a stack: the one on show in front, the
// others peeking out above it by their sponsor band. The distance is the bib
// number, the word is the runner's name, the verdict is a rubber stamp, and
// the stub along the bottom carries the GPX, the link and the target shape.

const PEEK = 30;                       // how much of a bib behind shows, in px
const TILT = [-1.4, 1.1, -0.7, 0.9];  // back bibs hang a little crooked

export interface BibActions {
  units: Units;
  canShare: boolean;
  /** The GIF being rendered, with its progress (0 to 1). */
  gif: { busy: boolean; pct: number };
  onGpx: () => void;
  onGif: () => void;
  onTry: (b: Bucket) => void;
}

/** Where the run starts relative to the pin, short. */
function awayLabel(o: PlanOption, units: Units) {
  return o.route.starts_at_pin || o.route.from_pin_mi <= 0.04 ? "at your pin" : `${fmtDist(o.route.from_pin_mi, units)} away`;
}

function SafetyPin({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  return (
    <svg className={`pin pin-${corner}`} viewBox="0 0 48 20" aria-hidden="true">
      <g fill="none" stroke="url(#bib-metal)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 6.5c-6 0-6 7.5 0 7.5" />
        <path d="M11 6.5h29" />
        <path d="M11 14h24" />
        <path d="M35 11.5h5.5a2.6 2.6 0 0 0 0-5.2H37" />
      </g>
    </svg>
  );
}

/** The verdict, stamped on in ink that never quite takes evenly. */
function Stamp({ verdict, pct }: { verdict: string; pct: number }) {
  const v = verdictOf(verdict);
  return (
    <svg className="stamp" viewBox="0 0 224 78" role="img" aria-label={`${v.label}, ${pct}% overlap`}>
      <g filter="url(#bib-ink)" fill="none" stroke={v.ink}>
        <rect x="4" y="4" width="216" height="70" rx="7" strokeWidth="4.5" />
        <rect x="12" y="12" width="200" height="54" rx="3" strokeWidth="1.6" />
        <text x="112" y="46" textAnchor="middle" fill={v.ink} stroke="none" className="stamp-t">
          {v.label.toUpperCase()}
        </text>
        <text x="112" y="61.5" textAnchor="middle" fill={v.ink} stroke="none" className="stamp-s">
          {pct}% OVERLAP
        </text>
      </g>
    </svg>
  );
}

/** The sponsor band across the top: lane number, group, where it starts. */
function Band({ index, o, units }: { index: number; o: PlanOption; units: Units }) {
  return (
    <div className="bib-band font-display">
      <span className="bib-lane">
        <b>{index + 1}</b>
        {o.label}
      </span>
      <span className="bib-away">
        {awayLabel(o, units)}
        <i className="bib-word" style={{ color: verdictOf(o.verdict).ink }}>
          {verdictOf(o.verdict).word}
        </i>
      </span>
    </div>
  );
}

export function BibStack({
  options,
  index,
  onPick,
  planning,
  actions,
}: {
  options: PlanOption[];
  index: number;
  onPick: (i: number) => void;
  planning: boolean;
  actions: BibActions;
}) {
  const { units } = actions;
  const o = options[index];
  if (!o) return null;
  const behind = options.map((_, i) => i).filter((i) => i !== index);
  const n = behind.length + (planning ? 1 : 0);
  const v = verdictOf(o.verdict);
  const distPrimary = (units === "mi" ? o.route.distance_mi : o.route.distance_km).toFixed(2);
  const distSecondary = units === "mi" ? `${o.route.distance_km.toFixed(2)} km` : `${o.route.distance_mi.toFixed(2)} mi`;
  const climb = o.route.gain_ft != null ? (units === "mi" ? `${Math.round(o.route.gain_ft)} ft climb` : `${Math.round(o.route.gain_ft * 0.3048)} m climb`) : null;
  const word = o.drawing.kind === "text" ? o.drawing.label : "Logo run";

  return (
    <div className="bibs" style={{ paddingTop: n * PEEK }}>
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          <linearGradient id="bib-metal" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="17">
            <stop offset="0" stopColor="#f4f4f6" />
            <stop offset="0.5" stopColor="#b5b5bc" />
            <stop offset="1" stopColor="#65656d" />
          </linearGradient>
          <filter id="bib-ink" x="-4%" y="-10%" width="108%" height="120%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="4" result="g" />
            <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 5.5 -2.0" result="m" />
            <feDisplacementMap in="SourceGraphic" in2="g" scale="1.8" xChannelSelector="R" yChannelSelector="G" result="d" />
            <feComposite in="d" in2="m" operator="in" />
          </filter>
        </defs>
      </svg>

      {behind.map((i, r) => (
        <button
          key={i}
          type="button"
          className="bib bib-back"
          style={{ top: r * PEEK, zIndex: r + 1, transform: `rotate(${TILT[r % TILT.length]}deg)` }}
          onClick={() => onPick(i)}
          aria-label={`Show route ${i + 1}, ${options[i].label}: ${awayLabel(options[i], units)}, ${verdictOf(options[i].verdict).label}`}
        >
          <SafetyPin corner="tl" />
          <SafetyPin corner="tr" />
          <Band index={i} o={options[i]} units={units} />
        </button>
      ))}
      {planning && (
        <div className="bib bib-back bib-ghost" style={{ top: behind.length * PEEK, zIndex: behind.length + 1 }} aria-hidden="true">
          <div className="bib-band font-display">
            <span className="bib-lane">
              <b>{options.length + 1}</b>
              Searching
            </span>
            <span className="bib-away">farther out…</span>
          </div>
        </div>
      )}

      <article className="bib bib-front" key={index} style={{ zIndex: n + 1 }}>
        <SafetyPin corner="tl" />
        <SafetyPin corner="tr" />
        <SafetyPin corner="bl" />
        <SafetyPin corner="br" />
        <Band index={index} o={o} units={units} />
        <div className="bib-body">
          <div className="bib-stamp">
            <Stamp verdict={o.verdict} pct={Math.round(o.score.iou * 100)} />
          </div>
          <div className="bib-num font-display">
            {distPrimary}
            <span className="bib-unit">{units}</span>
          </div>
          <div className="bib-sub font-display">
            {distSecondary} · {o.route.loop ? "loop" : "one way"} · {TILE[o.bucket.key] ?? o.bucket.label}
            {climb ? ` · ${climb}` : ""}
          </div>
          <div className="bib-name font-display">
            {word}
            {o.drawing.lines && o.drawing.lines > 1 ? <span className="bib-name-sub">{o.drawing.lines} lines</span> : null}
          </div>
          <div className="bib-start">
            <span className="bib-k font-display">Start</span>
            <span>
              <b>{o.route.starts_at_pin ? "Your pin" : o.route.start_desc}</b>
              {o.route.starts_at_pin && <span className="bib-dim"> ({o.route.start_desc})</span>}
              {" · "}head {compass(o.route.start_bearing)} ({o.route.start_bearing}°)
              {o.route.approach_mi > 0.04 && ` · ${fmtDist(o.route.approach_mi, units)} to the drawing${o.route.loop ? " and back" : ""}`}
              {!o.route.starts_at_pin && o.route.from_pin_mi > 0.04 && ` · ${fmtDist(o.route.from_pin_mi, units)} from your pin, where the streets fit better`}
            </span>
          </div>
          {o.message && <p className="bib-msg">{o.message}</p>}
          {o.suggest_bucket && (
            <button type="button" onClick={() => actions.onTry(o.suggest_bucket as Bucket)} className="pbtn pbtn-ink">
              Try {BUCKETS.find((b) => b.key === o.suggest_bucket)?.label ?? o.suggest_bucket} instead
            </button>
          )}
        </div>
        <div className="bib-crease" aria-hidden="true" />
        <div className="bib-stub">
          <button type="button" onClick={actions.onGpx} className="pbtn pbtn-orange" title="The route as a GPX file for your watch or app">
            <Icon name={actions.canShare ? "share" : "download"} />
            {actions.canShare ? "Send GPX" : "GPX"}
          </button>
          <button
            type="button"
            onClick={actions.onGif}
            className="pbtn"
            disabled={actions.gif.busy}
            aria-busy={actions.gif.busy}
            title="The route drawing itself in, as a GIF to post"
          >
            <Icon name="film" />
            {actions.gif.busy ? `Generating ${Math.round(actions.gif.pct * 100)}%` : "GIF"}
          </button>
          <span className="bib-sponsor font-display" aria-hidden="true">
            drawmy<span>.run</span>
          </span>
        </div>
        <span className="sr-only">{v.label}</span>
      </article>
    </div>
  );
}
