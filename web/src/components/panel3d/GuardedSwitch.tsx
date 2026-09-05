"use client";

import { Text, useCursor } from "@react-three/drei";
import { invalidate, type ThreeEvent } from "@react-three/fiber";
import { useRef, useState } from "react";
import { BoxGeometry, type Group } from "three";
import { getGeometries, getMaterials } from "./materials";
import { LABEL_FONT, LABEL_FONT_BOLD } from "./Plate";
import { buzz, useSpring } from "./spring";

const SWING = 0.68;
const OPEN = 2.1;    // radians the guard swings, out and down, when lifted
const hit = new BoxGeometry(3.2, 4.2, 3.2);
const hoodTop = new BoxGeometry(1.7, 0.16, 1.9);   // the hood: a red box open at the back and the bottom, hinged along its bottom edge
const hoodSide = new BoxGeometry(0.16, 2.0, 1.9);
const hoodFace = new BoxGeometry(1.7, 2.0, 0.16);
const base = new BoxGeometry(2.1, 2.5, 0.14);

/** A toggle under a red guard, for the one action that matters. The first
 *  tap lifts the guard; the next throws the switch and fires `onThrow`.
 *  While `engaged`, the switch stays thrown; when it clears, the switch
 *  returns and the guard closes again. */
export function GuardedSwitch({
  position,
  engaged,
  onThrow,
  onStop,
  label = "DRAW MY RUN",
  disabled = false,
}: {
  position: [number, number, number];
  engaged: boolean;
  onThrow: () => void;
  /** A tap on the thrown switch throws it back. */
  onStop?: () => void;
  label?: string;
  disabled?: boolean;
}) {
  const m = getMaterials();
  const g = getGeometries();
  const bat = useRef<Group>(null);
  const guard = useRef<Group>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  useCursor(hover && !disabled);
  const lifted = (open && !disabled) || engaged;
  useSpring(lifted ? OPEN : 0, (x) => {
    if (guard.current) guard.current.rotation.x = x;
  }, { k: 180, c: 14 });
  useSpring(engaged ? -SWING : SWING, (x) => {
    if (bat.current) bat.current.rotation.x = x;
  }, { k: 420, c: 16 });

  const tap = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (engaged) {
      onStop?.();
      buzz();
      invalidate();
      return;
    }
    if (disabled) return;
    if (!open) {
      setOpen(true);
      buzz();
    } else {
      setOpen(false);
      onThrow();
      buzz();
    }
    invalidate();
  };
  const ink = disabled ? "#4a4d50" : "#15171a";
  return (
    <group position={position}>
      <mesh geometry={hit} material={m.hit} position={[0, 0, 1.2]} onPointerDown={tap} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)} />
      <mesh geometry={base} material={m.cut} position={[0, 0, 0.07]} />
      <mesh geometry={g.nut} material={m.chrome} position={[0, 0, 0.22]} />
      <mesh geometry={g.bushing} material={m.chrome} position={[0, 0, 0.4]} />
      <group ref={bat} position={[0, 0, 0.5]}>
        <mesh geometry={g.lever} material={m.chrome} position={[0, 0, 0.6]} rotation={[Math.PI / 2, 0, 0]} />
        <mesh geometry={g.ball} material={m.chrome} position={[0, 0, 1.25]} />
      </group>
      {/* the guard: a red hood hinged along its bottom edge */}
      <group ref={guard} position={[0, -1.25, 0.14]}>
        <mesh geometry={hoodFace} material={m.guard} position={[0, 1.2, 1.9]} />
        <mesh geometry={hoodTop} material={m.guard} position={[0, 2.2, 0.95]} />
        <mesh geometry={hoodSide} material={m.guard} position={[-0.85, 1.2, 0.95]} />
        <mesh geometry={hoodSide} material={m.guard} position={[0.85, 1.2, 0.95]} />
        <Text font={LABEL_FONT_BOLD} fontSize={0.26} color="#fff2f2" anchorX="center" anchorY="middle" position={[0, 1.2, 1.99]} letterSpacing={0.08} maxWidth={1.5} textAlign="center" lineHeight={1.1}>
          {disabled ? "SET UP" : engaged ? "STOP" : "LIFT"}
        </Text>
      </group>
      <Text font={LABEL_FONT} fontSize={0.3} color={ink} anchorX="center" anchorY="middle" position={[0, 1.9, 0.01]} letterSpacing={0.08}>
        {label}
      </Text>
    </group>
  );
}
