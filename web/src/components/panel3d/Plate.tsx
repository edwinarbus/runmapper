"use client";

import { RoundedBox, Text } from "@react-three/drei";
import type { ReactNode } from "react";
import { getMaterials } from "./materials";

export const LABEL_FONT = "/fonts/B612-Regular.ttf";
export const LABEL_FONT_BOLD = "/fonts/B612-Bold.ttf";

/** A painted grey plate, its face at z = 0, with whatever stands on it as
 *  children. Sizes are in centimetres. */
export function Plate({ w, h, d = 0.5, children }: { w: number; h: number; d?: number; children?: ReactNode }) {
  const m = getMaterials();
  return (
    <group>
      <RoundedBox args={[w, h, d]} radius={0.16} smoothness={4} material={m.paint} position={[0, 0, -d / 2]} />
      {children}
    </group>
  );
}

/** A label printed on the plate. */
export function PlateLabel({ children, position, size = 0.34, bold = false }: { children: string; position: [number, number, number]; size?: number; bold?: boolean }) {
  return (
    <Text font={bold ? LABEL_FONT_BOLD : LABEL_FONT} fontSize={size} color="#15171a" anchorX="center" anchorY="middle" position={position} letterSpacing={0.04}>
      {children}
    </Text>
  );
}
