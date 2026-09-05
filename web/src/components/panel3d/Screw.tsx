"use client";

import { getGeometries, getMaterials } from "./materials";

/** A cross-head screw seated in the plate: a dark recess, a chrome head
 *  standing a little proud, and the cross cut into it. */
export function Screw({ position, turn = 0 }: { position: [number, number, number]; turn?: number }) {
  const m = getMaterials();
  const g = getGeometries();
  return (
    <group position={position}>
      <mesh geometry={g.screwSeat} material={m.cut} position={[0, 0, 0.01]} />
      <mesh geometry={g.screwHead} material={m.chrome} position={[0, 0, 0.07]} />
      <group position={[0, 0, 0.13]} rotation={[0, 0, turn]}>
        <mesh geometry={g.screwCross} material={m.cut} />
        <mesh geometry={g.screwCross} material={m.cut} rotation={[0, 0, Math.PI / 2]} />
      </group>
    </group>
  );
}
