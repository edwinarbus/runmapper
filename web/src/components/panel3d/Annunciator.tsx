"use client";

import { Text, useCursor } from "@react-three/drei";
import { invalidate, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useRef, useState } from "react";
import type { Group } from "three";
import { getGeometries, getMaterials } from "./materials";
import { LABEL_FONT_BOLD } from "./Plate";
import { usePrefersReducedMotion } from "./motion";

const TRAVEL = 0.15;   // how far the cap goes down when pressed: a millimetre and a half

/** A push-light: a black bezel on the plate, a cap that depresses under a
 *  tap and lights amber. Tap it to throw it; the phone buzzes. The target
 *  behind it is a good deal bigger than the cap. */
export function Annunciator({
  position,
  label,
  lit,
  onToggle,
}: {
  position: [number, number, number];
  label: string;
  lit: boolean;
  onToggle: () => void;
}) {
  const m = getMaterials();
  const g = getGeometries();
  const cap = useRef<Group>(null);
  const travel = useRef(0);
  const [down, setDown] = useState(false);
  const [hover, setHover] = useState(false);
  const reduced = usePrefersReducedMotion();
  useCursor(hover);

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
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    setDown(true);
    invalidate();
  };
  const release = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!down) return;
    setDown(false);
    onToggle();
    navigator.vibrate?.(10);
    invalidate();
  };
  const cancel = () => {
    if (down) setDown(false);
    invalidate();
  };

  return (
    <group position={position}>
      <mesh
        geometry={g.annHit}
        material={m.hit}
        position={[0, 0, 0.3]}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onPointerOver={() => setHover(true)}
        onPointerOut={() => setHover(false)}
      />
      <mesh geometry={g.annBezel} material={m.plastic} position={[0, 0, 0.15]} />
      <group ref={cap} position={[0, 0, 0.3]}>
        <mesh geometry={g.annCap} material={lit ? m.lensOn : m.lensOff} />
        <Text font={LABEL_FONT_BOLD} fontSize={0.46} color={lit ? "#3a2200" : "#6e5a38"} anchorX="center" anchorY="middle" position={[0, 0, 0.165]} letterSpacing={0.06}>
          {label}
        </Text>
      </group>
    </group>
  );
}
