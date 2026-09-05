"use client";

import { Text, useCursor } from "@react-three/drei";
import { invalidate, type ThreeEvent } from "@react-three/fiber";
import { useRef, useState } from "react";
import { BoxGeometry, type Group } from "three";
import { getGeometries, getMaterials } from "./materials";
import { LABEL_FONT } from "./Plate";
import { buzz, useSpring } from "./spring";

const SWING = 0.68;  // radians either side of straight out
const hit = new BoxGeometry(2.2, 3.4, 2.2);

/** A bat-handle toggle: a chrome lever on a threaded bushing under a hex
 *  nut, that swings up for `on` and down for off, with a snap. Labels above
 *  and below say what each way means. */
export function ToggleSwitch({
  position,
  on,
  onThrow,
  up = "ON",
  down = "OFF",
  disabled = false,
}: {
  position: [number, number, number];
  on: boolean;
  onThrow: (on: boolean) => void;
  up?: string;
  down?: string;
  disabled?: boolean;
}) {
  const m = getMaterials();
  const g = getGeometries();
  const bat = useRef<Group>(null);
  const [hover, setHover] = useState(false);
  useCursor(hover && !disabled);
  // Up is on: the bat tilts back (towards +y) when on, forward when off.
  useSpring(on ? -SWING : SWING, (x) => {
    if (bat.current) bat.current.rotation.x = x;
  }, { k: 420, c: 16 });

  const throwIt = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (disabled) return;
    onThrow(!on);
    buzz();
    invalidate();
  };
  const ink = disabled ? "#4a4d50" : "#15171a";
  return (
    <group position={position}>
      <mesh geometry={hit} material={m.hit} position={[0, 0, 0.8]} onPointerDown={throwIt} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)} />
      <mesh geometry={g.nut} material={m.chrome} position={[0, 0, 0.08]} />
      <mesh geometry={g.bushing} material={m.chrome} position={[0, 0, 0.26]} />
      <group ref={bat} position={[0, 0, 0.36]}>
        <mesh geometry={g.lever} material={m.chrome} position={[0, 0, 0.6]} rotation={[Math.PI / 2, 0, 0]} />
        <mesh geometry={g.ball} material={m.chrome} position={[0, 0, 1.25]} />
      </group>
      <Text font={LABEL_FONT} fontSize={0.3} color={ink} anchorX="center" anchorY="middle" position={[0, 1.55, 0.01]} letterSpacing={0.06}>
        {up}
      </Text>
      <Text font={LABEL_FONT} fontSize={0.3} color={ink} anchorX="center" anchorY="middle" position={[0, -1.55, 0.01]} letterSpacing={0.06}>
        {down}
      </Text>
    </group>
  );
}
