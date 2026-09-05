"use client";

import { invalidate, useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./motion";

/** A value that follows `target` like a weight on a spring, applied on every
 *  frame it moves; the scene is asked for frames only while it moves. With
 *  less motion asked for, it simply is the target. */
export function useSpring(target: number, apply: (x: number) => void, { k = 260, c = 18, snap = 0.002 } = {}) {
  const s = useRef({ x: target, v: 0 });
  const reduced = usePrefersReducedMotion();
  useFrame((_, dt) => {
    const st = s.current;
    if (reduced) {
      st.x = target;
      st.v = 0;
      apply(st.x);
      return;
    }
    const h = Math.min(dt || 0.016, 1 / 30);
    st.v += (-k * (st.x - target) - c * st.v) * h;
    st.x += st.v * h;
    if (Math.abs(st.x - target) < snap && Math.abs(st.v) < snap * 20) {
      st.x = target;
      st.v = 0;
    } else invalidate();
    apply(st.x);
  });
  useEffect(() => {
    invalidate();
  }, [target]);
}

export function buzz() {
  navigator.vibrate?.(10);
}
