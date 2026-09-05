"use client";

import { Html } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bucket, Style, Units } from "@/lib/api";
import { PAD_ASPECT } from "@/lib/drawing";
import { Annunciator } from "./Annunciator";
import { Gauge } from "./Gauge";
import { GuardedSwitch } from "./GuardedSwitch";
import { LedDisplay } from "./LedDisplay";
import { PanelScene } from "./PanelScene";
import { Plate, PlateLabel } from "./Plate";
import { RotaryKnob } from "./RotaryKnob";
import { Screw } from "./Screw";
import { ToggleSwitch } from "./ToggleSwitch";

export type DrawMode = "text" | "draw" | "image";

export interface DeckProps {
  mode: DrawMode;
  onMode: (m: DrawMode) => void;
  text: string;
  onText: (v: string) => void;
  maxChars: number;
  onEnter: () => void;
  /** Why the word cannot be run at any distance, when it cannot. */
  textNote: string | null;
  buckets: { key: Bucket; label: string; hint: string }[];
  fits: Record<Bucket, boolean> | null;
  bucket: Bucket;
  onBucket: (b: Bucket) => void;
  loop: boolean;
  onLoop: (v: boolean) => void;
  units: Units;
  onUnits: (u: Units) => void;
  styles: { key: Style; label: string; hint: string }[];
  style: Style;
  onStyle: (s: Style) => void;
  hasPin: boolean;
  canGo: boolean;
  planning: boolean;
  onGo: () => void;
  onStop: () => void;
  progress: { pct: number; msg: string } | null;
  hasRoute: boolean;
  onBackToRoute: () => void;
  /** Real HTML, laid over the scene: the address field with its menu, the draw pad, the image picker. */
  address: ReactNode;
  pad: ReactNode;
  picker: ReactNode;
  onSlow: () => void;
}

// The panel, in centimetres. One column of plates, each the panel's width.
const W = 10.4;
const MARGIN = 0.35;
const GAP = 0.35;
const INSET = 0.6;           // from a plate's edge to its content
const TITLE_X = -W / 2 + 1.3; // titles start clear of the corner screw
const LED_CELLS = 12;
const STATUS_CELLS = 14;

/** A readout wide enough for `cells` characters, as LedDisplay lays it out. */
function ledWidth(cells: number, cellW: number, pad: number) {
  const t = cellW * 0.13;
  return cells * (cellW + t * 1.3) - t * 1.3 + pad * 2;
}

/** `text` seen through `cells` characters, sliding left one character a
 *  tick when it is longer than the window. */
function marquee(text: string, cells: number, tick: number) {
  const t = text.toUpperCase();
  if (t.length <= cells) return t;
  const loop = `${t}   `;
  const start = tick % loop.length;
  return (loop + loop).slice(start, start + cells);
}

export function PanelDeck(p: DeckProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [typing, setTyping] = useState(false);
  const [tick, setTick] = useState(0);

  // The canvas is as wide as the column; the panel's scale follows from that.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The status readout slides its message along while the engine works.
  useEffect(() => {
    if (!p.planning) return;
    const id = setInterval(() => setTick((t) => t + 1), 320);
    return () => clearInterval(id);
  }, [p.planning]);

  const pxPerCm = width / (W + 2 * MARGIN);
  const px = (cm: number) => Math.round(cm * pxPerCm);

  // Plate heights, by what the first plate holds.
  const padH = (W - 2 * INSET) * PAD_ASPECT + 1.5;   // the pad and its two keys
  const h1 = p.mode === "draw" ? 4.7 + padH + 0.7 : p.mode === "image" ? 8.8 : 7.9;
  const heights = [h1, 3.4, 7.8, 5.2, 8.0];
  const H = heights.reduce((a, b) => a + b, 0) + GAP * (heights.length - 1) + 2 * MARGIN;
  const tops: number[] = [];
  let y = H / 2 - MARGIN;
  for (const h of heights) {
    tops.push(y);
    y -= h + GAP;
  }
  const centre = (i: number) => tops[i] - heights[i] / 2;

  const ledW = ledWidth(LED_CELLS, 0.62, 0.32);
  const statusW = ledWidth(STATUS_CELLS, 0.44, 0.26);
  const word = p.text.toUpperCase();
  const status = p.planning
    ? marquee(p.progress?.msg ?? "SEARCHING", STATUS_CELLS, tick)
    : !p.hasPin
      ? "SET A START"
      : p.mode === "text" && !p.text.trim()
        ? "TYPE A WORD"
        : p.mode === "draw" && !p.canGo
          ? "DRAW A SHAPE"
          : p.mode === "image" && !p.canGo
            ? "PICK AN IMAGE"
            : p.canGo
              ? "READY"
              : "NOT YET";
  const styleHint = p.styles.find((s) => s.key === p.style)?.hint ?? "";
  const modeOptions = useMemo(
    () => [
      { key: "text" as const, label: "WORDS" },
      { key: "draw" as const, label: "DRAW" },
      { key: "image" as const, label: "IMAGE" },
    ],
    [],
  );

  const screws = (i: number) => {
    const h = heights[i];
    return (
      <>
        <Screw position={[-W / 2 + 0.5, h / 2 - 0.5, 0]} turn={0.4 + i} />
        <Screw position={[W / 2 - 0.5, h / 2 - 0.5, 0]} turn={-0.7 + i} />
        <Screw position={[-W / 2 + 0.5, -h / 2 + 0.5, 0]} turn={1.2 - i} />
        <Screw position={[W / 2 - 0.5, -h / 2 + 0.5, 0]} turn={-0.2 + i} />
      </>
    );
  };

  return (
    <div ref={box} className="deck3d" style={{ height: width ? px(H) : undefined }}>
      {width > 0 && (
        <PanelScene widthCm={W + 2 * MARGIN} heightCm={H} onSlow={p.onSlow}>
          {/* 01 DRAW: what to draw, and the word on the readout */}
          <Plate w={W} h={h1} position={[0, centre(0), 0]}>
            {screws(0)}
            <PlateLabel position={[TITLE_X, h1 / 2 - 0.75, 0.01]} anchorX="left" size={0.42} bold>
              01  DRAW
            </PlateLabel>
            <RotaryKnob position={[-W / 2 + 2.45, h1 / 2 - 3.3, 0]} options={modeOptions} value={p.mode} onChange={p.onMode} spread={110} />
            {p.mode === "text" ? (
              <>
                <LedDisplay position={[0, h1 / 2 - 5.6, 0]} text={word} cells={LED_CELLS} cursor={typing && word.length < LED_CELLS ? word.length : null} />
                <Html position={[0, h1 / 2 - 5.6, 0.5]} center zIndexRange={[20, 0]} style={{ width: px(ledW), height: px(1.64) }}>
                  <input
                    value={p.text}
                    onChange={(e) => p.onText(e.target.value.slice(0, p.maxChars))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") p.onEnter();
                    }}
                    onFocus={() => setTyping(true)}
                    onBlur={() => setTyping(false)}
                    maxLength={p.maxChars}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Words to draw"
                    className="led-input"
                  />
                </Html>
                <PlateLabel position={[W / 2 - INSET, h1 / 2 - 6.95, 0.01]} anchorX="right" size={0.28} color="#3f4347">
                  {`${p.text.length} / ${p.maxChars}`}
                </PlateLabel>
                {p.textNote && (
                  <PlateLabel position={[-W / 2 + INSET, h1 / 2 - 6.95, 0.01]} anchorX="left" size={0.28} color="#8a3d00" maxWidth={W - 3.5}>
                    {p.textNote}
                  </PlateLabel>
                )}
              </>
            ) : p.mode === "draw" ? (
              <Html position={[0, h1 / 2 - 4.7 - padH / 2, 0.3]} center zIndexRange={[20, 0]} style={{ width: px(W - 2 * INSET) }}>
                <div className="deck-html">{p.pad}</div>
              </Html>
            ) : (
              <Html position={[0, h1 / 2 - 4.7 - 1.7, 0.3]} center zIndexRange={[20, 0]} style={{ width: px(W - 2 * INSET) }}>
                <div className="deck-html">{p.picker}</div>
              </Html>
            )}
          </Plate>

          {/* 02 START: the address, as real HTML in a slot */}
          <Plate w={W} h={heights[1]} position={[0, centre(1), 0]}>
            {screws(1)}
            <PlateLabel position={[TITLE_X, heights[1] / 2 - 0.75, 0.01]} anchorX="left" size={0.42} bold>
              02  START
            </PlateLabel>
            <Html position={[0, heights[1] / 2 - 2.15, 0.3]} center zIndexRange={[30, 0]} style={{ width: px(W - 2 * INSET) }}>
              <div className="deck-html">{p.address}</div>
            </Html>
          </Plate>

          {/* 03 HOW FAR: three push-lights, and the units and loop toggles */}
          <Plate w={W} h={heights[2]} position={[0, centre(2), 0]}>
            {screws(2)}
            <PlateLabel position={[TITLE_X, heights[2] / 2 - 0.75, 0.01]} anchorX="left" size={0.42} bold>
              03  HOW FAR
            </PlateLabel>
            {p.buckets.map((b, i) => {
              const short = Boolean(p.fits && !p.fits[b.key]);
              return (
                <Annunciator
                  key={b.key}
                  position={[(i - 1) * 3.05, heights[2] / 2 - 2.3, 0]}
                  w={2.75}
                  h={1.9}
                  label={b.label}
                  lit={p.bucket === b.key && !short}
                  disabled={short}
                  color="white"
                  onPress={() => p.onBucket(b.key)}
                />
              );
            })}
            <ToggleSwitch position={[-2.7, heights[2] / 2 - 5.6, 0]} on={p.units === "mi"} onThrow={(on) => p.onUnits(on ? "mi" : "km")} up="MILES" down="KM" />
            <ToggleSwitch position={[2.7, heights[2] / 2 - 5.6, 0]} on={p.loop} onThrow={p.onLoop} up="LOOP" down="ONE WAY" />
          </Plate>

          {/* STYLE: one line or block letters; the middle or the edge of an image */}
          <Plate w={W} h={heights[3]} position={[0, centre(3), 0]}>
            {screws(3)}
            <PlateLabel position={[TITLE_X, heights[3] / 2 - 0.75, 0.01]} anchorX="left" size={0.42} bold>
              STYLE
            </PlateLabel>
            <RotaryKnob
              position={[-W / 2 + 2.45, heights[3] / 2 - 3.2, 0]}
              options={p.styles.map((s) => ({ key: s.key, label: s.label.toUpperCase() }))}
              value={p.style}
              onChange={p.onStyle}
              spread={110}
              disabled={p.mode === "draw"}
            />
            <PlateLabel position={[1.1, heights[3] / 2 - 3.1, 0.01]} anchorX="left" size={0.3} color="#3f4347" maxWidth={W / 2 - 0.4}>
              {p.mode === "draw" ? "A drawing is always one line." : styleHint}
            </PlateLabel>
          </Plate>

          {/* GO: the guarded switch that starts the search, the gauge that follows it, the readout that says what it is doing */}
          <Plate w={W} h={heights[4]} position={[0, centre(4), 0]}>
            {screws(4)}
            <GuardedSwitch position={[-2.7, heights[4] / 2 - 2.9, 0]} engaged={p.planning} onThrow={p.onGo} onStop={p.onStop} disabled={!p.canGo && !p.planning} />
            <Gauge position={[2.7, heights[4] / 2 - 2.75, 0]} value={p.planning ? (p.progress?.pct ?? 0) / 100 : 0} />
            <LedDisplay position={[-W / 2 + INSET + statusW / 2, heights[4] / 2 - 6.9, 0]} text={status} cells={STATUS_CELLS} cellW={0.44} cellH={0.7} pad={0.26} color={p.planning ? "#ffb52b" : "#3dff6a"} dim={p.planning ? "#2a1d06" : "#0c2413"} />
            {p.hasRoute && !p.planning && (
              <Annunciator position={[W / 2 - INSET - 1.15, heights[4] / 2 - 6.9, 0]} w={2.3} h={1.2} fontSize={0.3} label="ROUTE" lit color="green" onPress={p.onBackToRoute} />
            )}
          </Plate>
        </PanelScene>
      )}
    </div>
  );
}

export default PanelDeck;
