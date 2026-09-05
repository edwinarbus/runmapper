"use client";

import { invalidate, useFrame } from "@react-three/fiber";
import { useEffect, useRef, type ReactNode } from "react";
import { Group, MathUtils } from "three";

const MAX = MathUtils.degToRad(4);   // the panel leans at most this far
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** Leans the panel a few degrees with the phone (device orientation, from
 *  wherever the phone was held when the page opened) or, on a desktop, with
 *  the mouse. Nothing moves until something happens, and each movement is
 *  eased in over a few frames, then the scene goes quiet again. */
export function Tilt({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const rig = useRef<Group>(null);
  const target = useRef({ x: 0, y: 0 });
  const now = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!enabled) {
      target.current = { x: 0, y: 0 };
      invalidate();
      return;
    }
    let neutral: { beta: number; gamma: number } | null = null;
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      neutral ??= { beta: e.beta, gamma: e.gamma };
      target.current = { x: clamp((e.beta - neutral.beta) / 25) * MAX, y: clamp((e.gamma - neutral.gamma) / 25) * MAX };
      invalidate();
    };
    const onMouse = (e: MouseEvent) => {
      target.current = { x: (e.clientY / window.innerHeight - 0.5) * 2 * MAX, y: (e.clientX / window.innerWidth - 0.5) * 2 * MAX };
      invalidate();
    };
    const listen = () => window.addEventListener("deviceorientation", onOrient);
    // iOS gives orientation only once asked, and only from a tap.
    const ask = () => {
      const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> };
      if (typeof D.requestPermission === "function") D.requestPermission().then((r) => r === "granted" && listen()).catch(() => {});
      else listen();
    };
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (coarse) {
      const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
      if (typeof D.requestPermission === "function") window.addEventListener("pointerdown", ask, { once: true });
      else listen();
    } else {
      window.addEventListener("mousemove", onMouse);
    }
    return () => {
      window.removeEventListener("deviceorientation", onOrient);
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("pointerdown", ask);
    };
  }, [enabled]);

  useFrame((_, dt) => {
    const k = Math.min(1, dt * 6);
    now.current.x += (target.current.x - now.current.x) * k;
    now.current.y += (target.current.y - now.current.y) * k;
    if (rig.current) rig.current.rotation.set(now.current.x, now.current.y, 0);
    if (Math.abs(target.current.x - now.current.x) > 0.0005 || Math.abs(target.current.y - now.current.y) > 0.0005) invalidate();
  });

  return <group ref={rig}>{children}</group>;
}
