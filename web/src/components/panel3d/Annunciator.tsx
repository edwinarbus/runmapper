"use client";

import { Text, useCursor } from "@react-three/drei";
import { invalidate, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useRef, useState } from "react";
import { BoxGeometry, type Group } from "three";
import { getMaterials } from "./materials";
import { LABEL_FONT_BOLD } from "./Plate";
import { usePrefersReducedMotion } from "./motion";
import { buzz } from "./spring";

const TRAVEL = 0.15;   // how far the cap goes down when pressed: a millimetre and a half
const shapes = new Map<string, { bezel: BoxGeometry; cap: BoxGeometry; hit: BoxGeometry }>();
function shapeFor(w: number, h: number) {
  const key = `${w}x${h}`;
  let s = shapes.get(key);
  if (!s) {
    s = { bezel: new BoxGeometry(w, h, 0.3), cap: new BoxGeometry(w - 0.4, h - 0.4, 0.32), hit: new BoxGeometry(w + 0.6, h + 0.6, 0.9) };
    shapes.set(key, s);
  }
  return s;
}

export type LampColor = "amber" | "green" | "red" | "white";

/** A push-light: a black bezel on the plate, a cap that depresses under a
 *  tap and lights from within. Tap it to throw it; the phone buzzes. The
 *  target behind it is a good deal bigger than the cap. A disabled one is
 *  dark and does not press. */
export function Annunciator({
  position,
  label,
  lit,
  onPress,
  color = "amber",
  w = 2.6,
  h = 1.8,
  fontSize = 0.46,
  disabled = false,
}: {
  position: [number, number, number];
  label: string;
  lit: boolean;
  onPress?: () => void;
  color?: LampColor;
  w?: number;
  h?: number;
  fontSize?: number;
  disabled?: boolean;
}) {
  const m = getMaterials();
  const g = shapeFor(w, h);
  const cap = useRef<Group>(null);
  const travel = useRef(0);
  const [down, setDown] = useState(false);
  const [hover, setHover] = useState(false);
  const reduced = usePrefersReducedMotion();
  useCursor(hover && !disabled);

  useFrame((_, dt) => {
    const goal = down ? -TRAVEL : 0;
    if (reduced) travel.current = goal;
    else travel.current += (goal - travel.current) * Math.min(1, dt * 26);
    if (Math.abs(goal - travel.current) < 0.003) travel.current = goal;
    if (cap.current) cap.current.position.z = 0.3 + travel.current;
    if (travel.current !== goal) invalidate();
  });

  const press = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (disabled) return;
    setDown(true);
    invalidate();
  };
  const release = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!down) return;
    setDown(false);
    onPress?.();
    buzz();
    invalidate();
  };
  const cancel = () => {
    if (down) setDown(false);
    invalidate();
  };
  const litMat = color === "green" ? m.lensGreen : color === "red" ? m.lensRed : color === "white" ? m.lensWhite : m.lensOn;
  const ink = lit ? (color === "amber" ? "#3a2200" : color === "red" ? "#3a0505" : color === "green" ? "#04220c" : "#2a2622") : disabled ? "#3b352c" : "#6e5a38";

  return (
    <group position={position}>
      <mesh
        geometry={g.hit}
        material={m.hit}
        position={[0, 0, 0.3]}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onPointerOver={() => setHover(true)}
        onPointerOut={() => setHover(false)}
      />
      <mesh geometry={g.bezel} material={m.plastic} position={[0, 0, 0.15]} />
      <group ref={cap} position={[0, 0, 0.3]}>
        <mesh geometry={g.cap} material={lit ? litMat : m.lensOff} />
        <Text font={LABEL_FONT_BOLD} fontSize={fontSize} color={ink} anchorX="center" anchorY="middle" position={[0, 0, 0.165]} letterSpacing={0.06} maxWidth={w - 0.5} textAlign="center" lineHeight={1.05}>
          {label}
        </Text>
      </group>
    </group>
  );
}
