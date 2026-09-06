"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { play } from "@/lib/sound";

// The word on a split-flap board, the kind that posts race results: one
// tile per letter, each in two leaves on a hinge. A typed letter arrives the
// way the real thing does: the tile runs through the few letters before it,
// each leaf falling over the last, and lands on it. A real input sits over
// the board, invisible, so typing, focus and the phone keyboard work as they
// always do.

const GHOST = "RUN";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SPIN = 2;            // letters a typed tile runs through on its way to the one typed
const SPIN_MAX = 4;        // a tile arriving with a row runs through one to this many
const TILE_MAX = 64;       // px
const TILE_MIN = 32;       // narrower than this and the word takes another row instead
const GAP = 5;             // between the tiles of a word
const WORD_GAP = 16;       // between words
const STAGGER = 50;        // ms between neighbouring tiles when a whole word arrives at once
const DRIFT = 6;           // ms per tile squared: the tiles down the row fall further and further behind
const WOBBLE = 34;         // ms of random wobble either way on each tile's wait
const DRIFT_MAX = 10;      // tiles beyond this fall behind at the steady rate

/** What a tile shows on its way to `ch`: blank, the `spin` letters before it, then `ch`. */
function sequence(ch: string, spin: number): string[] {
  const k = ALPHABET.indexOf(ch);
  if (k < 0) return ["", ch];
  const out = [""];
  for (let j = spin; j >= 1; j--) out.push(ALPHABET[(k - j + ALPHABET.length) % ALPHABET.length]);
  out.push(ch);
  return out;
}

// Tiles that arrive together (a pasted or shared word, the board coming
// back with a word on it) start one after another, left to right, the way
// a real board's row goes: never in step. Each tile down the row waits a
// little longer than the one before it (the gap grows, so the last letters
// trail well behind), with a small random wobble, and each tile turns at
// its own pace and runs through its own number of letters before landing,
// so the row drifts further out of step as it runs and lands in no
// particular order. `order` is the tile's rank among the `batch` tiles
// arriving with it; a letter typed on its own is a batch of one, starts at
// once and runs through the usual few letters.
function stagger(order: number, batch: number): { delay: number; rate: number; spin: number } {
  if (batch <= 1) return { delay: 0, rate: 1, spin: SPIN };
  const d = Math.min(order, DRIFT_MAX);
  const delay = Math.max(0, Math.round(order * STAGGER + d * d * DRIFT + (Math.random() * 2 - 1) * WOBBLE));
  return { delay, rate: 0.85 + Math.random() * 0.5, spin: 1 + Math.floor(Math.random() * SPIN_MAX) };
}

/** One tile: the top and bottom halves of the letter it shows, and while
 *  it is still turning, a leaf on the hinge with the current top on its
 *  face and the next bottom on its back. */
function Tile({ ch, still, order, batch }: { ch: string; still?: boolean; order: number; batch: number }) {
  const [{ delay, rate, spin }] = useState(() => (still ? { delay: 0, rate: 1, spin: SPIN } : stagger(order, batch)));
  const seq = sequence(ch, spin);
  const last = seq.length - 1;
  const [step, setStep] = useState(() => (still ? last : 0));
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
          style={{ "--flap-rate": rate, ...(step === 0 && delay ? { "--flap-delay": `${delay}ms` } : {}) } as CSSProperties}
          onAnimationEnd={() => {
            play("flap");
            setStep((s) => s + 1);
          }}
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
  // On a desktop the board is ready to type into as the page opens. A phone
  // is left alone: focus there would raise the keyboard over the deck.
  useEffect(() => {
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chars = value.toUpperCase().split("");
  const ghost = chars.length === 0;
  // Which tiles were on the board last time: the ones that are new this
  // time arrived together, and take their turn in order.
  const seen = useRef<Set<string>>(new Set());
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

  const keys = items.flatMap((it) => (it.kind === "tile" ? [ghost ? `ghost-${it.index}` : `${it.index}-${it.ch}`] : []));
  const fresh = keys.filter((k) => !seen.current.has(k));
  const order = new Map(fresh.map((k, i) => [k, i]));
  useEffect(() => {
    seen.current = new Set(keys);
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
          <Tile
            key={ghost ? `ghost-${it.index}` : `${it.index}-${it.ch}`}
            ch={it.ch}
            still={ghost}
            order={order.get(ghost ? `ghost-${it.index}` : `${it.index}-${it.ch}`) ?? 0}
            batch={fresh.length}
          />
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
