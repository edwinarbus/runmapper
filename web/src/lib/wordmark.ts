// The wordmark as a run: DRAWMYRUN in block letters on a lattice, two units
// wide and four tall, drawn by one route line that joins the letters along
// the baseline and retraces where a runner would, and the green start dot
// standing at the foot of RUN's R as the period. One path, in lattice units;
// the header, the bib, the GIF's caption band and the social card all draw it.
export const WORDMARK_D = "M0.00 4L0.00 0L1.00 0L2.00 1L2.00 3L1.00 4L0.00 4L2.00 4L3.00 4L3.00 0L4.20 0L5.00 0.8L5.00 1.5L4.20 2.3L3.50 2.3L5.00 4L6.00 4L6.00 1L7.00 0L8.00 1L8.00 2.4L6.00 2.4L8.00 2.4L8.00 4L9.00 4L9.00 0L9.00 4L10.00 1.6L11.00 4L11.00 0L11.00 4L12.00 4L12.00 0L13.00 2L14.00 0L14.00 4L15.00 4L16.00 4L16.00 2L15.00 0L16.00 2L17.00 0L16.00 2L16.00 4L17.00 4L18.00 4L18.00 0L19.20 0L20.00 0.8L20.00 1.5L19.20 2.3L18.50 2.3L20.00 4L21.00 4L21.00 0L21.00 4L23.00 4L23.00 0L23.00 4L24.00 4L24.00 0L26.00 4L26.00 0L26.00 4";
export const WORDMARK_DOT = { x: 18, y: 4, r: 0.62 };
export const WORDMARK_W = 26;          // the letters' width, in units
export const WORDMARK_H = 4;
export const WORDMARK_STROKE = 0.6;
// The box round the mark: the line's half width and a little air on every
// side, and below, the start dot and its ring whole (it stands on the
// baseline, so it reaches further down than the line does).
export const WORDMARK_PAD = WORDMARK_STROKE / 2 + 0.25;
export const WORDMARK_PAD_BOTTOM = WORDMARK_DOT.r + 0.11 + 0.25;
export const WORDMARK_BOX_W = WORDMARK_W + 2 * WORDMARK_PAD;
export const WORDMARK_BOX_H = WORDMARK_H + WORDMARK_PAD + WORDMARK_PAD_BOTTOM;
export const WORDMARK_VIEWBOX = `${-WORDMARK_PAD} ${-WORDMARK_PAD} ${WORDMARK_BOX_W} ${WORDMARK_BOX_H}`;
export const WORDMARK_ASPECT = WORDMARK_BOX_W / WORDMARK_BOX_H;
