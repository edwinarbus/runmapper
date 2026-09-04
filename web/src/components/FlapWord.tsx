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
  const n = shown.length + (cursor ? 1 : 0);
  return (
    <div className={`flap-board${ghost ? " flap-ghost" : ""}`} style={{ "--n": n } as CSSProperties} onClick={() => input.current?.focus()}>
      {shown.map((ch, i) => (
        <Tile key={`${i}-${ch}`} ch={ch} />
      ))}
      {cursor && <span className="flap flap-cursor" aria-hidden="true" />}
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
