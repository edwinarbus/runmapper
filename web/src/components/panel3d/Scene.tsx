"use client";

import { useState } from "react";
import { Annunciator } from "./Annunciator";
import { PanelScene } from "./PanelScene";
import { Plate, PlateLabel } from "./Plate";
import { Screw } from "./Screw";

const PLATE = { w: 9, h: 6.4 };   // centimetres

/** Stage one, kept as the check page: one push-light on a plate. */
export default function Scene({ onSlow }: { onSlow: () => void }) {
  const [lit, setLit] = useState(false);
  return (
    <PanelScene widthCm={PLATE.w + 1.2} heightCm={PLATE.h} onSlow={onSlow}>
      <Plate w={PLATE.w} h={PLATE.h}>
        <Screw position={[-PLATE.w / 2 + 0.55, PLATE.h / 2 - 0.55, 0]} turn={0.4} />
        <Screw position={[PLATE.w / 2 - 0.55, PLATE.h / 2 - 0.55, 0]} turn={-0.7} />
        <Screw position={[-PLATE.w / 2 + 0.55, -PLATE.h / 2 + 0.55, 0]} turn={1.2} />
        <Screw position={[PLATE.w / 2 - 0.55, -PLATE.h / 2 + 0.55, 0]} turn={-0.2} />
        <PlateLabel position={[0, 1.75, 0.01]} size={0.4}>
          PANEL LIGHT
        </PlateLabel>
        <Annunciator position={[0, 0.15, 0]} label={lit ? "ON" : "OFF"} lit={lit} onPress={() => setLit((v) => !v)} />
        <PlateLabel position={[0, -1.55, 0.01]} size={0.3}>
          PUSH
        </PlateLabel>
      </Plate>
    </PanelScene>
  );
}
