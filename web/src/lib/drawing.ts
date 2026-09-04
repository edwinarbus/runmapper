// A shape drawn on the pad: strokes in pad units (x across the pad's width,
// 0 to 1; y in the same units, so the pad's proportions are kept), exported
// as a stroked SVG the engine reads as line art.

export type Pt = [number, number];

/** The pad's height as a fraction of its width. */
export const PAD_ASPECT = 2 / 3;
/** The file name the drawing travels under; the engine echoes it as the label. */
export const DRAW_FILE = "drawing.svg";

export const isDrawing = (label: string) => label === DRAW_FILE;

/** Ramer-Douglas-Peucker: the same line with fewer points. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let dmax = 0;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      // Distance from the chord; from the point itself when the ends meet
      // (a closed loop), or the whole loop would fold into one point.
      const d = len > 1e-6 ? Math.abs(dx * (ay - y) - dy * (ax - x)) / len : Math.hypot(x - ax, y - ay);
      if (d > dmax) {
        dmax = d;
        worst = i;
      }
    }
    if (worst >= 0 && dmax > tol) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Length of a stroke, in pad units. */
export function strokeLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** The strokes as an SVG of black lines on nothing: line art to the engine. */
export function drawingSvg(strokes: Pt[][]): string {
  const W = 1000;
  const H = Math.round(W * PAD_ASPECT);
  const d = strokes
    .map((s) => s.map(([x, y], i) => `${i ? "L" : "M"}${(x * W).toFixed(1)} ${(y * W).toFixed(1)}`).join(" "))
    .join(" ");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<path d="${d}" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}
