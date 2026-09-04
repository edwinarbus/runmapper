"use client";

import type { CSSProperties } from "react";

// A segmented control as a selector switch: a slot with one raised white
// key in it, which slides to whichever option is chosen.

export interface SegOption<K extends string> {
  key: K;
  label: string;
  title?: string;
}

export default function Seg<K extends string>({
  options,
  value,
  onChange,
  label,
  map = false,
  className = "",
}: {
  options: SegOption<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Accessible name for the group. */
  label: string;
  /** The map's version: keys on the glass. */
  map?: boolean;
  className?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.key === value),
  );
  return (
    <div
      className={`${map ? "map-seg" : "seg"}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={label}
      style={{ "--n": options.length, "--i": index } as CSSProperties}
    >
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.key} type="button" className={map ? "map-btn" : "seg-btn"} aria-pressed={value === o.key} title={o.title} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
