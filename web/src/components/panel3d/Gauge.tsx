"use client";

import { Text } from "@react-three/drei";
import { useRef } from "react";
import { BoxGeometry, type Group } from "three";
import { getGeometries, getMaterials } from "./materials";
import { LABEL_FONT, LABEL_FONT_BOLD } from "./Plate";
import { useSpring } from "./spring";

const SWEEP = 240;   // degrees from empty to full
const needle = new BoxGeometry(0.06, 1.25, 0.03);
const tail = new BoxGeometry(0.1, 0.3, 0.03);
const major = new BoxGeometry(0.05, 0.22, 0.02);
const minor = new BoxGeometry(0.03, 0.12, 0.02);

/** A round dial with a red needle that swings from empty to full, for the
 *  engine's progress. */
export function Gauge({ position, value, label = "SEARCH", ticks = 10 }: { position: [number, number, number]; value: number; label?: string; ticks?: number }) {
  const m = getMaterials();
  const g = getGeometries();
  const hand = useRef<Group>(null);
  const v = Math.max(0, Math.min(1, value));
  const angleOf = (f: number) => ((0.5 - f) * SWEEP * Math.PI) / 180;   // left is empty, right is full
  useSpring(angleOf(v), (x) => {
    if (hand.current) hand.current.rotation.z = x;
  }, { k: 60, c: 9 });
  const marks = Array.from({ length: ticks * 2 + 1 }, (_, i) => ({ f: i / (ticks * 2), big: i % 2 === 0 }));
  return (
    <group position={position}>
      <mesh geometry={g.gaugeBezel} material={m.plastic} position={[0, 0, 0.17]} />
      <mesh geometry={g.gaugeFace} material={m.face} position={[0, 0, 0.36]} />
      {marks.map(({ f, big }, i) => {
        const a = angleOf(f);
        const r = big ? 1.3 : 1.35;
        return <mesh key={i} geometry={big ? major : minor} material={m.cut} position={[-Math.sin(a) * r, Math.cos(a) * r, 0.39]} rotation={[0, 0, a]} />;
      })}
      <Text font={LABEL_FONT} fontSize={0.22} color="#2a2d30" anchorX="center" anchorY="middle" position={[-0.95, -0.72, 0.39]}>
        0
      </Text>
      <Text font={LABEL_FONT} fontSize={0.22} color="#2a2d30" anchorX="center" anchorY="middle" position={[0.95, -0.72, 0.39]}>
        100
      </Text>
      <Text font={LABEL_FONT_BOLD} fontSize={0.24} color="#2a2d30" anchorX="center" anchorY="middle" position={[0, -0.42, 0.39]} letterSpacing={0.1}>
        {label}
      </Text>
      <group ref={hand} position={[0, 0, 0.42]}>
        <mesh geometry={needle} material={m.needle} position={[0, 0.5, 0]} />
        <mesh geometry={tail} material={m.needle} position={[0, -0.18, 0]} />
      </group>
      <mesh geometry={g.gaugeCap} material={m.plastic} position={[0, 0, 0.46]} />
      <mesh geometry={g.gaugeFace} material={m.glass} position={[0, 0, 0.54]} />
    </group>
  );
}
