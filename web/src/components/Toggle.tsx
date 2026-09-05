"use client";

import { useEffect, useRef } from "react";

// A panel toggle switch, the metal kind: a chrome bat lever on a ball, a
// collar, a threaded bushing, a hex nut and a lock washer, seated on the
// deck. It is a real render (three.js, a studio environment for the chrome,
// one key light for the shadow it throws), baked into a strip of fifteen
// frames of the lever's lean, 35 degrees left to 35 degrees right in steps
// of five (public/toggle.webp, toggle.png). The lever rests at 30 degrees
// either way; a flip runs the frames through to a little past the far rest
// and settles back, the way a spring-loaded toggle snaps over.
const FRAMES = 15;
const LEFT = 1;                 // -30 degrees
const RIGHT = 13;               // +30 degrees
const pos = (k: number) => `${(k / (FRAMES - 1)) * 100}% 0`;

export default function Toggle({ on }: { on: boolean }) {
  const el = useRef<HTMLSpanElement>(null);
  const frame = useRef(on ? RIGHT : LEFT);
  const settled = useRef(false);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const to = on ? RIGHT : LEFT;
    const from = frame.current;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!settled.current || from === to || still) {
      settled.current = true;
      frame.current = to;
      node.style.backgroundPosition = pos(to);
      return;
    }
    // over to a frame past the rest, then back onto it
    const over = on ? RIGHT + 1 : LEFT - 1;
    const OUT = 140;
    const BACK = 120;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = now - t0;
      let f: number;
      if (t < OUT) {
        const u = t / OUT;
        f = from + (over - from) * (1 - (1 - u) * (1 - u));
      } else if (t < OUT + BACK) {
        const u = (t - OUT) / BACK;
        f = over + (to - over) * u * u * (3 - 2 * u);
      } else {
        f = to;
      }
      const k = Math.round(f);
      if (k !== frame.current) {
        frame.current = k;
        node.style.backgroundPosition = pos(k);
      }
      if (t < OUT + BACK) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return <span ref={el} className="toggle" style={{ backgroundPosition: pos(on ? RIGHT : LEFT) }} aria-hidden="true" />;
}
