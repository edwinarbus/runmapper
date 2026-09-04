"use client";

import { type CSSProperties, useLayoutEffect, useRef } from "react";

// A segmented control as a selector switch: a slot with one raised white
// key in it, which slides to whichever option is chosen. The key is placed
// over the chosen button by measurement, so labels of different widths
// (Night, Day, Sat) each get a key that fits them.

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
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const index = Math.max(
    0,
    options.findIndex((o) => o.key === value),
  );

  // Put the key exactly over the chosen button, now and whenever the
  // control's size changes; the stylesheet's equal-column guess only
  // covers the first paint.
  useLayoutEffect(() => {
    const el = box.current;
    const th = thumb.current;
    if (!el || !th) return;
    const place = () => {
      const btn = el.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (!btn) return;
      th.style.left = `${btn.offsetLeft}px`;
      th.style.width = `${btn.offsetWidth}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, options]);

  return (
    <div
      ref={box}
      className={`${map ? "map-seg" : "seg"}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={label}
      style={{ "--n": options.length, "--i": index } as CSSProperties}
    >
      <span ref={thumb} className="seg-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.key} type="button" className={map ? "map-btn" : "seg-btn"} aria-pressed={value === o.key} title={o.title} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
