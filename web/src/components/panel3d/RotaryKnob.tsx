"use client";

import { Text, useCursor } from "@react-three/drei";
import { invalidate, type ThreeEvent } from "@react-three/fiber";
import { useRef, useState } from "react";
import { BoxGeometry, type Group } from "three";
import { getGeometries, getMaterials } from "./materials";
import { LABEL_FONT } from "./Plate";
import { buzz, useSpring } from "./spring";

const knobHit = new BoxGeometry(2.6, 2.6, 1.4);
const labelHit = new BoxGeometry(2.2, 0.7, 0.6);
const pointer = new BoxGeometry(0.1, 0.62, 0.05);
const tick = new BoxGeometry(0.05, 0.28, 0.04);

/** A black selector knob with a white pointer line, turned to one of a few
 *  positions marked round it. Tapping the knob turns it to the next
 *  position; tapping a mark turns it straight there. */
export function RotaryKnob<K extends string>({
  position,
  options,
  value,
  onChange,
  spread = 100,
  radius = 1.75,
  disabled = false,
}: {
  position: [number, number, number];
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  /** Degrees between the first and the last position. */
  spread?: number;
  /** How far out the marks stand. */
  radius?: number;
  disabled?: boolean;
}) {
  const m = getMaterials();
  const g = getGeometries();
  const knob = useRef<Group>(null);
  const [hover, setHover] = useState(false);
  useCursor(hover && !disabled);
  const n = options.length;
  const index = Math.max(0, options.findIndex((o) => o.key === value));
  // Angles run clockwise from the top: the first position leans left, the last right.
  const angleOf = (i: number) => ((i / Math.max(1, n - 1) - 0.5) * spread * Math.PI) / 180;
  useSpring(-angleOf(index), (x) => {
    if (knob.current) knob.current.rotation.z = x;
  }, { k: 220, c: 15 });

  const pick = (key: K) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (disabled || key === value) return;
    onChange(key);
    buzz();
    invalidate();
  };
  const next = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (disabled) return;
    onChange(options[(index + 1) % n].key);
    buzz();
    invalidate();
  };
  return (
    <group position={position}>
      <mesh geometry={g.knobSkirt} material={m.cut} position={[0, 0, 0.02]} />
      <group ref={knob} position={[0, 0, 0.02]}>
        <mesh geometry={g.knob} material={m.plastic} position={[0, 0, 0.3]} />
        <mesh geometry={g.knobTop} material={m.plastic} position={[0, 0, 0.62]} />
        <mesh geometry={pointer} material={m.mark} position={[0, 0.5, 0.72]} />
      </group>
      <mesh geometry={knobHit} material={m.hit} position={[0, 0, 0.6]} onPointerDown={next} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)} />
      {options.map((o, i) => {
        const a = angleOf(i);
        const x = Math.sin(a) * radius;
        const y = Math.cos(a) * radius;
        const chosen = o.key === value;
        return (
          <group key={o.key}>
            <mesh geometry={tick} material={m.cut} position={[Math.sin(a) * 1.28, Math.cos(a) * 1.28, 0.03]} rotation={[0, 0, -a]} />
            <Text font={LABEL_FONT} fontSize={0.3} color={disabled ? "#4a4d50" : chosen ? "#15171a" : "#3f4347"} anchorX="center" anchorY="middle" position={[x, y + 0.1, 0.01]} letterSpacing={0.06}>
              {o.label}
            </Text>
            <mesh geometry={labelHit} material={m.hit} position={[x, y + 0.1, 0.3]} onPointerDown={pick(o.key)} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)} />
          </group>
        );
      })}
    </group>
  );
}
