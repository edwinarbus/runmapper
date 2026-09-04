"use client";

import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { Bucket, PlanOption, Units } from "@/lib/api";
import { BUCKETS, fmtDist } from "@/lib/api";
import { isDrawing } from "@/lib/drawing";
import { TILE, compass, verdictOf } from "@/lib/labels";
import Icon from "./Icon";

// The answers as race bibs pinned in a pile: the one on show in front, the
// others behind it, peeking out above by their sponsor band. The distance is
// the bib number, the word is the runner's name, the verdict is a rubber
// stamp, and the stub along the bottom carries the GPX and the GIF.
//
// The bib just behind the front is the next answer, drawn whole, so dragging
// the front bib aside is a peek at it (let go and the front springs back) or
// a throw (it flies off, the next bib comes forward, and the thrown one goes
// to the back of the pile). A tap on any band brings that bib to the front.

const PEEK = 30;                       // how much of a bib behind shows, in px
const BACK_SCALE = 0.94;               // the bibs behind are a little smaller, as if farther away
const REVEAL_AT = 0.4;                 // the drag, as a share of the bib's width, that brings the next bib fully forward
const TILT = [-1.4, 1.1, -0.7, 0.9];  // back bibs hang a little crooked
const IDLE = { dx: 0, w: 0, live: false, out: 0 as const, on: -1 };

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

/** The verdict, stamped on in ink that never quite takes evenly: a heavy
 *  outer ring, a hairline inside it, the word, a rule, the overlap. */
function Stamp({ verdict, pct }: { verdict: string; pct: number }) {
  const v = verdictOf(verdict);
  return (
    <svg className="stamp" viewBox="0 0 240 92" role="img" aria-label={`${v.label}, ${pct}% overlap`}>
      <g filter="url(#bib-ink)" fill="none" stroke={v.ink} strokeLinejoin="round" strokeLinecap="round">
        <rect x="5" y="5" width="230" height="82" rx="9" strokeWidth="5" />
        <rect x="14" y="14" width="212" height="64" rx="4" strokeWidth="1.7" />
        <text x="120" y="51" textAnchor="middle" fill={v.ink} stroke="none" className="stamp-t">
          {v.label.toUpperCase()}
        </text>
        <line x1="30" y1="60" x2="210" y2="60" strokeWidth="1.2" />
        <text x="120" y="73" textAnchor="middle" fill={v.ink} stroke="none" className="stamp-s">
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

/** The paper under the band: the number, the stamp, the name, the start
 *  line and the stub. Live on the front bib; on the bibs behind, a picture
 *  of itself, so a peek shows the whole answer. */
function Paper({ o, units, actions, live }: { o: PlanOption; units: Units; actions: BibActions; live: boolean }) {
  const distPrimary = (units === "mi" ? o.route.distance_mi : o.route.distance_km).toFixed(2);
  const distSecondary = units === "mi" ? `${o.route.distance_km.toFixed(2)} km` : `${o.route.distance_mi.toFixed(2)} mi`;
  const climb = o.route.gain_ft != null ? (units === "mi" ? `${Math.round(o.route.gain_ft)} ft climb` : `${Math.round(o.route.gain_ft * 0.3048)} m climb`) : null;
  const word = o.drawing.kind === "text" ? o.drawing.label : isDrawing(o.drawing.label) ? "Your drawing" : "Logo run";
  const tryLabel = o.suggest_bucket ? `Try ${BUCKETS.find((b) => b.key === o.suggest_bucket)?.label ?? o.suggest_bucket} instead` : null;
  return (
    <>
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
        {tryLabel &&
          (live ? (
            <button type="button" onClick={() => actions.onTry(o.suggest_bucket as Bucket)} className="pbtn pbtn-ink">
              {tryLabel}
            </button>
          ) : (
            <span className="pbtn pbtn-ink">{tryLabel}</span>
          ))}
      </div>
      <div className="bib-crease" aria-hidden="true" />
      <div className="bib-stub">
        {live ? (
          <>
            <button
              type="button"
              onClick={actions.onGpx}
              className="pbtn pbtn-orange"
              title={actions.canShare ? "The route as a GPX file: send it to Strava, Garmin or your watch app" : "Download the route as a GPX file"}
            >
              <Icon name="download" />
              GPX
            </button>
            <button
              type="button"
              onClick={actions.onGif}
              className="pbtn"
              disabled={actions.gif.busy}
              aria-busy={actions.gif.busy}
              title="Download the route drawing itself in, as a GIF to post"
            >
              <Icon name="download" />
              {actions.gif.busy ? `Generating ${Math.round(actions.gif.pct * 100)}%` : "GIF"}
            </button>
          </>
        ) : (
          <>
            <span className="pbtn pbtn-orange">
              <Icon name="download" />
              GPX
            </span>
            <span className="pbtn">
              <Icon name="download" />
              GIF
            </span>
          </>
        )}
        <span className="bib-sponsor font-display" aria-hidden="true">
          drawmy<span>.run</span>
        </span>
      </div>
    </>
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
  const count = options.length;

  // Dragging the front bib aside brings the next one forward underneath it;
  // a throw (far enough, or fast enough) sends the front bib off and makes
  // the next one the front. Vertical movement is left to the panel's
  // scroll; a tap on the stub's buttons is still a tap. The drag belongs to
  // the bib it started on: if another route arrives and the front bib
  // changes under the finger, the new one starts clean.
  const ptr = useRef<{ id: number; x0: number; y0: number; axis: "x" | null; lastX: number; lastT: number; vx: number } | null>(null);
  const swiped = useRef(false);
  const [drag, setDrag] = useState<{ dx: number; w: number; live: boolean; out: -1 | 0 | 1; on: number }>(IDLE);
  // A bib that came forward under a throw is already in place: no settling in.
  const [arrived, setArrived] = useState<"pick" | "throw">("pick");
  const active = drag.on === index;
  const live = active && drag.live;

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (ptr.current || (active && drag.out !== 0) || count < 2) return;   // one finger at a time
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // No text selection from a drag that starts on the paper: a selection
    // would turn the next drag into a drag of the selection, which cancels
    // the pointer. The stub's buttons keep their own behaviour.
    if (!(e.target as HTMLElement).closest("button, a, input, textarea, select, summary")) e.preventDefault();
    ptr.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, lastX: e.clientX, lastT: e.timeStamp, vx: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = ptr.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (!p.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        ptr.current = null;   // a scroll, not a swipe
        return;
      }
      p.axis = "x";
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that has already gone */
      }
    }
    const dt = e.timeStamp - p.lastT;
    if (dt > 0) p.vx = (e.clientX - p.lastX) / dt;
    p.lastX = e.clientX;
    p.lastT = e.timeStamp;
    setDrag({ dx, w: e.currentTarget.offsetWidth || 320, live: true, out: 0, on: index });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = ptr.current;
    if (!p || p.id !== e.pointerId) return;
    ptr.current = null;
    if (p.axis !== "x") return;
    swiped.current = true;   // the click that follows a drag is not a tap
    window.setTimeout(() => {
      swiped.current = false;
    }, 60);
    const dx = e.clientX - p.x0;
    const w = e.currentTarget.offsetWidth || 320;
    // A throw: dragged past the point where the next bib is fully forward
    // (two fifths of the width), or flicked. Anything shorter was a peek.
    const thrown = e.type !== "pointercancel" && (Math.abs(dx) > Math.max(90, w * REVEAL_AT) || Math.abs(p.vx) > 0.6);
    if (!thrown) {
      setDrag(IDLE);   // a peek: the front bib springs back
      return;
    }
    // Thrown either way, the bib underneath is the one that comes forward.
    const dir: -1 | 1 = (Math.abs(dx) > 8 ? dx : p.vx) < 0 ? -1 : 1;
    setDrag({ dx: dir * (w + 140), w, live: false, out: dir, on: index });
    const next = (index + 1) % count;
    window.setTimeout(() => {
      setArrived("throw");
      onPick(next);
      setDrag(IDLE);
    }, 230);
  };
  // The browser took the pointer away (a scroll, a second finger, a system
  // gesture): let go of a drag in progress; a throw on its way keeps going.
  // A touch is held by whatever it landed on until the bib takes it, and
  // that hand-off fires the same event from the inner element: not a loss.
  const onLostCapture = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (!ptr.current) return;
    ptr.current = null;
    setDrag((d) => (d.live ? IDLE : d));
  };

  const o = options[index];
  if (!o) return null;
  // The pile behind the front bib, farthest first: the next answer is nearest,
  // the one after it behind that, round to the one just thrown at the back.
  const behind = Array.from({ length: count - 1 }, (_, k) => (index + count - 1 - k) % count);
  const n = behind.length + (planning ? 1 : 0);
  const v = verdictOf(o.verdict);
  // How far the next bib has come forward under the drag: all the way once
  // the front bib is thrown, so the two hand over without a jump.
  const reveal = active ? (drag.out ? 1 : Math.min(1, Math.abs(drag.dx) / ((drag.w || 320) * REVEAL_AT))) : 0;

  return (
    <div className="bibs" style={{ paddingTop: n * PEEK }}>
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          <linearGradient id="bib-metal" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="17">
            <stop offset="0" stopColor="#f4f4f6" />
            <stop offset="0.5" stopColor="#b5b5bc" />
            <stop offset="1" stopColor="#65656d" />
          </linearGradient>
          {/* Rubber-stamp ink: fine grain where the rubber didn't quite touch,
              broad unevenness from the pressure of the hand, edges nudged. */}
          <filter id="bib-ink" x="-6%" y="-12%" width="112%" height="124%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" result="fine" />
            <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="3" result="coarse" />
            <feColorMatrix in="fine" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 4 -1.0" result="fineA" />
            <feColorMatrix in="coarse" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.2 0.35" result="coarseA" />
            <feComposite in="fineA" in2="coarseA" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="mask" />
            <feDisplacementMap in="SourceGraphic" in2="fine" scale="1.4" xChannelSelector="R" yChannelSelector="G" result="d" />
            <feComposite in="d" in2="mask" operator="in" />
          </filter>
        </defs>
      </svg>

      {/* Still searching: a ghost bib at the very back of the pile. */}
      {planning && (
        <div className="bib bib-back bib-ghost" style={{ top: 0, zIndex: 1, transform: `scale(${BACK_SCALE})` }} aria-hidden="true">
          <div className="bib-band font-display">
            <span className="bib-lane">
              <b>{options.length + 1}</b>
              Searching
            </span>
            <span className="bib-away">farther out…</span>
          </div>
        </div>
      )}
      {behind.map((i, r) => {
        const slot = r + (planning ? 1 : 0);
        const t = r === behind.length - 1 ? reveal : 0;   // only the nearest comes forward
        const tilt = TILT[i % TILT.length];
        return (
          <div
            key={i}
            className="bib bib-back"
            style={{
              top: slot * PEEK,
              zIndex: slot + 1,
              transform: `translateY(${PEEK * t}px) rotate(${tilt * (1 - t)}deg) scale(${BACK_SCALE + (1 - BACK_SCALE) * t})`,
              transition: live ? "none" : "transform 0.24s ease-out, top 0.24s ease-out",
            }}
          >
            <SafetyPin corner="tl" />
            <SafetyPin corner="tr" />
            <button
              type="button"
              className="bib-band-btn"
              onClick={() => {
                setArrived("pick");
                onPick(i);
              }}
              aria-label={`Show route ${i + 1}, ${options[i].label}: ${awayLabel(options[i], units)}, ${verdictOf(options[i].verdict).label}`}
            >
              <Band index={i} o={options[i]} units={units} />
            </button>
            <div aria-hidden="true" inert>
              <Paper o={options[i]} units={units} actions={actions} live={false} />
            </div>
          </div>
        );
      })}

      <article
        key={index}
        className={`bib bib-front${live || (active && drag.out) ? " bib-drag" : ""}${arrived === "throw" ? " bib-still" : ""}`}
        style={{
          zIndex: n + 1,
          transform: active && drag.dx ? `translateX(${drag.dx}px) rotate(${drag.dx / 24}deg)` : undefined,
          transition: live ? "none" : "transform 0.24s ease-out, opacity 0.24s ease-out",
          opacity: active && drag.out ? 0.35 : 1,
        }}
        tabIndex={0}
        aria-roledescription="carousel"
        aria-label={`Route ${index + 1} of ${count}, ${o.label}. Swipe for the next route, or use the arrow keys.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onLostCapture}
        onDragStart={(e) => e.preventDefault()}
        onClickCapture={(e) => {
          if (swiped.current) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        onKeyDown={(e) => {
          if (count < 2) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            setArrived("pick");
            onPick((index + 1) % count);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            setArrived("pick");
            onPick((index - 1 + count) % count);
          }
        }}
      >
        <SafetyPin corner="tl" />
        <SafetyPin corner="tr" />
        <SafetyPin corner="bl" />
        <SafetyPin corner="br" />
        <Band index={index} o={o} units={units} />
        <Paper o={o} units={units} actions={actions} live />
        <span className="sr-only">{v.label}</span>
      </article>
    </div>
  );
}
