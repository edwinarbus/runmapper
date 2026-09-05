"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

// The word on a split-flap board, the kind that posts race results: one
// tile per letter, each in two leaves on a hinge. A typed letter arrives the
// way the real thing does: the tile runs through the few letters before it,
// each leaf falling over the last, and lands on it. A real input sits over
// the board, invisible, so typing, focus and the phone keyboard work as they
// always do.

const GHOST = "RUN";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SPIN = 2;            // letters a tile runs through on its way to the one typed
const TILE_MAX = 64;       // px
const TILE_MIN = 32;       // narrower than this and the word takes another row instead
const GAP = 5;             // between the tiles of a word
const WORD_GAP = 16;       // between words
const STAGGER = 24;        // ms between tiles when a whole word arrives at once

/** What a tile shows on its way to `ch`: blank, the letters before it, then `ch`. */
function sequence(ch: string): string[] {
  const k = ALPHABET.indexOf(ch);
  if (k < 0) return ["", ch];
  const out = [""];
  for (let j = SPIN; j >= 1; j--) out.push(ALPHABET[(k - j + ALPHABET.length) % ALPHABET.length]);
  out.push(ch);
  return out;
}

// Tiles that mount together (a pasted or shared word) start one after
// another, left to right; a letter typed on its own starts at once.
let batchAt = 0;
let batchN = 0;
function stagger(): number {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - batchAt > 80) {
    batchAt = now;
    batchN = 0;
  } else batchN++;
  return batchN * STAGGER;
}

/** One tile: the top and bottom halves of the letter it shows, and while
 *  it is still turning, a leaf on the hinge with the current top on its
 *  face and the next bottom on its back. */
function Tile({ ch, still }: { ch: string; still?: boolean }) {
  const seq = sequence(ch);
  const last = seq.length - 1;
  const [step, setStep] = useState(() => (still ? last : 0));
  const [delay] = useState(() => (still ? 0 : stagger()));
  const done = step >= last;
  const cur = seq[Math.min(step, last)];
  const next = seq[Math.min(step + 1, last)];
  return (
    <span className="flap" aria-hidden="true">
      <span className="flap-half flap-top">
        <i>{done ? cur : next}</i>
      </span>
      <span className={`flap-half flap-bot${done && !still ? " flap-landed" : ""}`}>
        <i>{cur}</i>
      </span>
      {!done && (
        <span
          key={step}
          className={`flap-leaf${step === last - 1 ? " flap-leaf-last" : ""}`}
          style={step === 0 && delay ? { animationDelay: `${delay}ms` } : undefined}
          onAnimationEnd={() => setStep((s) => s + 1)}
        >
          <span className="flap-face flap-face-front">
            <i>{cur}</i>
          </span>
          <span className="flap-face flap-face-back">
            <i>{next}</i>
          </span>
        </span>
      )}
    </span>
  );
}

type Item =
  | { kind: "tile"; index: number; ch: string }
  | { kind: "cursor" }
  | { kind: "gap"; key: string }
  | { kind: "break"; key: string };

export default function FlapWord({
  value,
  onChange,
  onEnter,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  maxLength: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chars = value.toUpperCase().split("");
  const ghost = chars.length === 0;
  const shown = ghost ? GHOST.split("") : chars;
  const cursor = !ghost && chars.length < maxLength;
  // Words stay together: a phrase breaks between words onto more rows.
  const words: { start: number; chars: string[] }[] = [];
  shown.forEach((ch, i) => {
    if (ch === " " || !words.length || shown[i - 1] === " ") words.push({ start: i, chars: [] });
    if (ch !== " ") words[words.length - 1].chars.push(ch);
  });
  const tilesOf = (w: { chars: string[] }, wi: number) => w.chars.length + (cursor && wi === words.length - 1 ? 1 : 0);
  const longest = Math.max(1, ...words.map(tilesOf));

  // Tiles as wide as the longest word allows on one row, down to a readable
  // minimum; narrower than that and the word takes more rows, split evenly.
  const W = width || 342;
  let rows = 1;
  let per = longest;
  let tile = TILE_MAX;
  for (;;) {
    per = Math.ceil(longest / rows);
    tile = Math.min(TILE_MAX, (W - (per - 1) * GAP) / per);
    if (tile >= TILE_MIN || per === 1) break;
    rows++;
  }

  // Lay the tiles out in rows: a word's continuation always starts a row,
  // a short word joins the row before it when there is room. Tiles keep
  // their identity across a reflow, so a typed letter never turns twice.
  const items: Item[] = [];
  let rowLeft = W;
  let rowStart = true;
  words.forEach((w, wi) => {
    const isLast = wi === words.length - 1;
    const total = tilesOf(w, wi);
    for (let off = 0; off < total; off += per) {
      const k = Math.min(per, total - off);
      const need = k * tile + (k - 1) * GAP;
      if (!rowStart) {
        if (off > 0 || need + WORD_GAP > rowLeft + 0.5) {
          items.push({ kind: "break", key: `br-${w.start}-${off}` });
          rowLeft = W;
        } else {
          items.push({ kind: "gap", key: `gap-${w.start}` });
          rowLeft -= WORD_GAP;
        }
      }
      for (let j = off; j < Math.min(off + per, w.chars.length); j++) items.push({ kind: "tile", index: w.start + j, ch: w.chars[j] });
      if (cursor && isLast && off + per >= total) items.push({ kind: "cursor" });
      rowLeft -= need;
      rowStart = false;
    }
  });

  return (
    <div
      ref={board}
      className={`flap-board${ghost ? " flap-ghost" : ""}`}
      style={{ "--w": `${tile}px` } as CSSProperties}
      onClick={() => input.current?.focus()}
    >
      {items.map((it) =>
        it.kind === "tile" ? (
          <Tile key={ghost ? `ghost-${it.index}` : `${it.index}-${it.ch}`} ch={it.ch} still={ghost} />
        ) : it.kind === "cursor" ? (
          <span key="cursor" className="flap flap-cursor" aria-hidden="true" />
        ) : it.kind === "gap" ? (
          <span key={it.key} className="flap-gap" aria-hidden="true" />
        ) : (
          <span key={it.key} className="flap-break" aria-hidden="true" />
        ),
      )}
      <input
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
        }}
        maxLength={maxLength}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        aria-label="Words to draw"
        placeholder={GHOST}
        className="flap-input"
      />
    </div>
  );
}
