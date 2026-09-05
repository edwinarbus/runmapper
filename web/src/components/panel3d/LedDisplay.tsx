"use client";

import { invalidate, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { getGeometries, getMaterials } from "./materials";

// A fourteen-segment readout built from segments, not a font: every cell has
// the same fourteen bars (a b c d e f g1 g2 h i j k l m), lit or dark, as on
// the alphanumeric LED modules of the era.
//
//    a
//  f h i j b
//   g1  g2
//  e k l m c
//    d

const SEG = ["a", "b", "c", "d", "e", "f", "g1", "g2", "h", "i", "j", "k", "l", "m"] as const;
const GLYPHS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abdeg1g2", "3": "abcdg2", "4": "bcfg1g2", "5": "acdfg1g2", "6": "acdefg1g2", "7": "abc", "8": "abcdefg1g2", "9": "abcdfg1g2",
  A: "abcefg1g2", B: "abcdilg2", C: "adef", D: "abcdil", E: "adefg1g2", F: "aefg1", G: "acdefg2", H: "bcefg1g2", I: "adil", J: "bcde",
  K: "efg1jm", L: "def", M: "bcefhj", N: "bcefhm", O: "abcdef", P: "abefg1g2", Q: "abcdefm", R: "abefg1g2m", S: "acdfg1g2", T: "ail",
  U: "bcdef", V: "efjk", W: "bcefkm", X: "hjkm", Y: "hjl", Z: "adjk", "-": "g1g2", "_": "d", "'": "i", "/": "jk", "\\": "hm", "+": "g1g2il", "*": "g1g2hijklm", "=": "g1g2d", "?": "abg2l", "!": "il", ".": "", " ": "",
  "&": "adefg1hm", "(": "jm", ")": "hk", "[": "adef", "]": "abcd", "<": "jm", ">": "hk",
};

function segmentsOf(ch: string): Set<string> {
  const s = GLYPHS[ch.toUpperCase()] ?? "";
  const out = new Set<string>();
  // tokens are one letter, or g1 / g2
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "g") {
      out.add(s.slice(i, i + 2));
      i++;
    } else out.add(s[i]);
  }
  return out;
}

/** Where each bar sits in a cell of width `cw` and height `ch`, with bars `t` thick. */
function layout(cw: number, ch: number, t: number) {
  const hx = cw / 2, hy = ch / 2;
  const gap = t * 0.55;
  const diagLen = Math.hypot(hx, hy) - t * 1.4;
  const dAngle = Math.atan2(hy, hx);   // the diagonal's slope from horizontal
  const bar = (x: number, y: number, len: number, rot: number) => ({ x, y, len, rot });
  return {
    a: bar(0, hy, cw - t - gap, 0),
    d: bar(0, -hy, cw - t - gap, 0),
    g1: bar(-hx / 2, 0, hx - t - gap, 0),
    g2: bar(hx / 2, 0, hx - t - gap, 0),
    f: bar(-hx, hy / 2, hy - t - gap, Math.PI / 2),
    b: bar(hx, hy / 2, hy - t - gap, Math.PI / 2),
    e: bar(-hx, -hy / 2, hy - t - gap, Math.PI / 2),
    c: bar(hx, -hy / 2, hy - t - gap, Math.PI / 2),
    i: bar(0, hy / 2, hy - t - gap, Math.PI / 2),
    l: bar(0, -hy / 2, hy - t - gap, Math.PI / 2),
    h: bar(-hx / 2, hy / 2, diagLen, -dAngle),
    j: bar(hx / 2, hy / 2, diagLen, dAngle),
    k: bar(-hx / 2, -hy / 2, diagLen, dAngle),
    m: bar(hx / 2, -hy / 2, diagLen, -dAngle),
  } as Record<(typeof SEG)[number], { x: number; y: number; len: number; rot: number }>;
}

/** A readout of `cells` characters in a black window under dark glass.
 *  `text` is shown from the left; `cursor` (a cell index) blinks a bar in
 *  that cell, for when the readout is being typed into. */
export function LedDisplay({
  position,
  text,
  cells,
  cursor = null,
  cellW = 0.62,
  cellH = 1.0,
  color = "#3dff6a",
  dim = "#0c2413",
  pad = 0.32,
}: {
  position: [number, number, number];
  text: string;
  cells: number;
  cursor?: number | null;
  cellW?: number;
  cellH?: number;
  color?: string;
  dim?: string;
  pad?: number;
}) {
  const m = getMaterials();
  const g = getGeometries();
  const mesh = useRef<InstancedMesh>(null);
  const t = cellW * 0.13;
  const pitch = cellW + t * 1.3;
  const width = cells * pitch - t * 1.3 + pad * 2;
  const height = cellH + pad * 2;
  const bars = useMemo(() => layout(cellW, cellH, t), [cellW, cellH, t]);
  const shapes = useMemo(() => ({ window: new BoxGeometry(width, height, 0.14), glass: new BoxGeometry(width - 0.06, height - 0.06, 0.04), depth: new BoxGeometry(width + 0.3, height + 0.3, 0.12) }), [width, height]);
  const lit = useMemo(() => new Color(color), [color]);
  const dark = useMemo(() => new Color(dim), [dim]);
  const blink = useRef(true);

  // Each bar's place, once.
  useEffect(() => {
    const im = mesh.current;
    if (!im) return;
    const mat = new Matrix4(), q = new Quaternion(), p = new Vector3(), s = new Vector3();
    const x0 = -width / 2 + pad + cellW / 2;
    for (let c = 0; c < cells; c++) {
      SEG.forEach((name, k) => {
        const b = bars[name];
        p.set(x0 + c * pitch + b.x, b.y, 0.02);
        q.setFromAxisAngle(new Vector3(0, 0, 1), b.rot);
        s.set(b.len, t, 0.04);
        mat.compose(p, q, s);
        im.setMatrixAt(c * 14 + k, mat);
      });
    }
    im.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [bars, cells, cellW, pad, pitch, t, width]);

  const paint = () => {
    const im = mesh.current;
    if (!im) return;
    for (let c = 0; c < cells; c++) {
      const on = segmentsOf(text[c] ?? " ");
      const cursorHere = cursor === c && blink.current && !text[c];
      SEG.forEach((name, k) => {
        const isLit = on.has(name) || (cursorHere && name === "d");
        im.setColorAt(c * 14 + k, isLit ? lit : dark);
      });
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  };

  // The lit bars follow the text, and the cursor blinks twice a second while there is one.
  useEffect(() => {
    paint();
    invalidate();
    if (cursor == null) return;
    const id = setInterval(() => {
      blink.current = !blink.current;
      paint();
      invalidate();
    }, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, cursor, cells, lit, dark]);
  useFrame(() => {
    /* nothing per frame; colours are set when they change */
  });

  return (
    <group position={position}>
      {/* the frame, the black window sunk in it, the bars just above the window's floor, and the glass over all */}
      <mesh geometry={shapes.depth} material={m.plastic} position={[0, 0, 0.06]} />
      <mesh geometry={shapes.window} material={m.cut} position={[0, 0, 0.13]} />
      <group position={[0, 0, 0.23]}>
        <instancedMesh ref={mesh} args={[g.unit, m.led, cells * 14]} frustumCulled={false} />
      </group>
      <mesh geometry={shapes.glass} material={m.glass} position={[0, 0, 0.3]} />
    </group>
  );
}
