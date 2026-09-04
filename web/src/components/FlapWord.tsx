"use client";

import { type CSSProperties, useRef } from "react";

// The word on a split-flap board, the kind that posts race results: one
// tile per letter, each in two leaves on a hinge, the lower leaf falling
// into place as the letter is typed. A real input sits over the board,
// invisible, so typing, focus and the phone keyboard work as they always do.

const GHOST = "RUN";

function Tile({ ch }: { ch: string }) {
  const glyph = ch === " " ? "" : ch;
  return (
    <span className={`flap${ch === " " ? " flap-space" : ""}`} aria-hidden="true">
      <span className="flap-half flap-top">
        <i>{glyph}</i>
      </span>
      <span className="flap-half flap-bot">
        <i>{glyph}</i>
      </span>
    </span>
  );
}

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
  const chars = value.toUpperCase().split("");
  const ghost = chars.length === 0;
  const shown = ghost ? GHOST.split("") : chars;
  const cursor = !ghost && chars.length < maxLength;
  // Words stay together: a phrase too long for one row breaks between words.
  const words: { start: number; chars: string[] }[] = [];
  shown.forEach((ch, i) => {
    if (ch === " " || !words.length || shown[i - 1] === " ") words.push({ start: i, chars: [] });
    if (ch !== " ") words[words.length - 1].chars.push(ch);
  });
  // Tiles are sized so the longest word (with the cursor, on the last word)
  // fits on one row; shorter words share rows or take their own.
  const n = Math.max(...words.map((w, i) => w.chars.length + (cursor && i === words.length - 1 ? 1 : 0)), 1);
  return (
    <div className={`flap-board${ghost ? " flap-ghost" : ""}`} style={{ "--n": n } as CSSProperties} onClick={() => input.current?.focus()}>
      {words.map((w, wi) => (
        <span key={w.start} className="flap-word">
          {w.chars.map((ch, i) => (
            <Tile key={`${w.start + i}-${ch}`} ch={ch} />
          ))}
          {cursor && wi === words.length - 1 && <span className="flap flap-cursor" aria-hidden="true" />}
        </span>
      ))}
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
