// The search, shown on the map: pulses that set out from the pin and run
// along the streets, the way the engine's search does, until the first
// answer arrives. The streets come from the basemap's own vector tiles
// (querySourceFeatures on the transportation layer), joined into a graph,
// and every point of it is given its distance from the pin by road; a
// pulse is then a distance that grows with time, and a piece of street is
// lit by how far behind the pulse's head it lies. Over that, a radar's
// sweep turning about the pin and a faint ring at each pulse's reach as the
// crow flies, which the street pulse can never pass. Drawn on a canvas laid
// over the map, on the map's own projection, every frame.
import type maplibregl from "maplibre-gl";

const SOURCE = "openmaptiles";
const LAYER = "transportation";
// what a runner can run: not motorways, not rails
const CLASSES = ["minor", "service", "primary", "secondary", "tertiary", "trunk", "path", "track", "residential", "unclassified", "living_street", "pedestrian"];
const PIECE = 36;        // m: a street is cut into pieces this long, lit one at a time
const SNAP = 2;          // m: points this close are one node
const SPEED = 640;       // m/s: how fast a pulse runs out along the streets
const PERIOD = 1.5;      // s: between pulses
const HEAD = 130;        // m: the bright head of a pulse
const TAIL = 520;        // m: over which it dies away behind the head
const TURN = 3.2;        // s: one turn of the sweep
const NEAR = 400;        // m: the pin must be this close to a street for the streets to light

type Piece = { x0: number; y0: number; x1: number; y1: number; d: number; w: number };

/** A binary heap of (distance, node) for Dijkstra. */
class Heap {
  private a: number[] = [];   // pairs, flat: d0, n0, d1, n1, ...
  get size() {
    return this.a.length / 2;
  }
  push(d: number, n: number) {
    const a = this.a;
    a.push(d, n);
    let i = a.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p * 2] <= a[i * 2]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top: [number, number] = [a[0], a[1]];
    const ld = a.pop() as number;
    const ln = a.pop() as number;
    if (a.length) {
      a[0] = ln;
      a[1] = ld;
      let i = 0;
      const n = a.length / 2;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < n && a[l * 2] < a[s * 2]) s = l;
        if (r < n && a[r * 2] < a[s * 2]) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }
  private swap(i: number, j: number) {
    const a = this.a;
    const d = a[i * 2];
    const n = a[i * 2 + 1];
    a[i * 2] = a[j * 2];
    a[i * 2 + 1] = a[j * 2 + 1];
    a[j * 2] = d;
    a[j * 2 + 1] = n;
  }
}

export class StreetPulse {
  pieces: Piece[] = [];   // read by the tests
  stats = "";              // and this: the graph's size, for the tests
  frameMs = 0;             // and the last frame's drawing time
  private raf = 0;
  private t0 = 0;
  private retry = 0;
  private stopped = false;
  private readonly kx: number;
  private readonly ky: number;
  private reach = 2400;    // m: how far the pulses run, set from the view
  private onIdle = () => {
    if (this.stopped) return;
    // more streets may have come in (tiles loading, the map moved): join them in
    if (this.pieces.length === 0 || this.moved) this.build();
    this.moved = false;
  };
  private moved = false;
  private onMove = () => {
    this.moved = true;
  };

  constructor(
    private readonly map: maplibregl.Map,
    private readonly canvas: HTMLCanvasElement,
    private readonly pin: { lat: number; lon: number },
    private readonly dark: boolean,
  ) {
    this.kx = Math.cos((pin.lat * Math.PI) / 180) * 111320;
    this.ky = 110540;
  }

  start() {
    const el = this.map.getContainer();
    // the pulses run to the edge of the view and a little past it
    const mpp = this.metresPerPixel();
    this.reach = Math.min(4200, Math.max(1500, Math.hypot(el.clientWidth, el.clientHeight) * 0.55 * mpp));
    // the graph is built a moment after the key press, so the press itself is not held up
    this.retry = window.setTimeout(() => this.build(), 40);
    this.map.on("idle", this.onIdle);
    this.map.on("moveend", this.onMove);
    this.t0 = performance.now();
    this.canvas.style.opacity = "1";
    const frame = (now: number) => {
      if (this.stopped) return;
      const t = performance.now();
      this.draw(now);
      this.frameMs = performance.now() - t;
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.retry);
    this.map.off("idle", this.onIdle);
    this.map.off("moveend", this.onMove);
    this.canvas.style.opacity = "0";
    const c = this.canvas;
    window.setTimeout(() => {
      c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    }, 500);
  }

  private metresPerPixel() {
    return (156543.03392 * Math.cos((this.pin.lat * Math.PI) / 180)) / Math.pow(2, this.map.getZoom());
  }

  /** The streets in the loaded tiles, as a graph, with every piece's distance from the pin by road. */
  private build(): boolean {
    const m = this.map;
    if (!m.getSource(SOURCE)) return this.later();
    let feats: GeoJSON.Feature[];
    try {
      feats = m.querySourceFeatures(SOURCE, {
        sourceLayer: LAYER,
        filter: ["all", ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false], ["match", ["get", "class"], CLASSES, true, false]],
      }) as GeoJSON.Feature[];
    } catch {
      return this.later();
    }
    const lon0 = this.pin.lon;
    const lat0 = this.pin.lat;
    const limit = this.reach * 1.2;
    // The streets as straight pieces, in metres about the pin. The tiles'
    // streets do not share their crossings as points (a straight street's
    // junctions are simplified away), so the crossings are found here: every
    // pair of pieces near each other is tested, and both are cut where they
    // cross or where one's end touches the other; the cut points are the
    // graph's nodes, snapped so the same crossing is one node.
    const sx0: number[] = [];
    const sy0: number[] = [];
    const sx1: number[] = [];
    const sy1: number[] = [];
    const sw: number[] = [];
    const raw = new Set<string>();
    for (const f of feats) {
      const g = f.geometry;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      const cls = String(f.properties?.class ?? "");
      const w = cls === "path" || cls === "track" ? 0.55 : cls === "service" ? 0.75 : 1;
      for (const line of lines) {
        let px = NaN;
        let py = NaN;
        for (const [lon, lat] of line) {
          const x = (lon - lon0) * this.kx;
          const y = (lat - lat0) * this.ky;
          if (Math.hypot(x, y) > limit) {
            px = NaN;
            continue;
          }
          if (!Number.isNaN(px) && (Math.abs(px - x) > 0.5 || Math.abs(py - y) > 0.5)) {
            const k = `${Math.round(px)},${Math.round(py)},${Math.round(x)},${Math.round(y)}`;
            const kr = `${Math.round(x)},${Math.round(y)},${Math.round(px)},${Math.round(py)}`;
            if (!raw.has(k) && !raw.has(kr)) {
              raw.add(k);
              sx0.push(px);
              sy0.push(py);
              sx1.push(x);
              sy1.push(y);
              sw.push(w);
            }
          }
          px = x;
          py = y;
        }
      }
    }
    const S = sx0.length;
    if (S < 30) return this.later();
    // a grid over the pieces, to find the pairs near each other
    const CELL = 60;
    const grid = new Map<number, number[]>();
    const cellKey = (cx: number, cy: number) => (cx + 4096) * 8192 + (cy + 4096);
    for (let i = 0; i < S; i++) {
      const ax = Math.floor(Math.min(sx0[i], sx1[i]) / CELL);
      const bx = Math.floor(Math.max(sx0[i], sx1[i]) / CELL);
      const ay = Math.floor(Math.min(sy0[i], sy1[i]) / CELL);
      const by = Math.floor(Math.max(sy0[i], sy1[i]) / CELL);
      for (let cx = ax; cx <= bx; cx++) {
        for (let cy = ay; cy <= by; cy++) {
          const k = cellKey(cx, cy);
          const cell = grid.get(k);
          if (cell) cell.push(i);
          else grid.set(k, [i]);
        }
      }
    }
    // the cuts: for each piece, where along it (0..1) and the point itself
    const cuts: number[][] = new Array(S);
    const cut = (i: number, t: number, x: number, y: number) => {
      (cuts[i] ??= []).push(t, x, y);
    };
    const TOUCH = 3;   // m: an end this close to another piece is on it
    const touch = (i: number, j: number, x: number, y: number) => {
      // the end (x, y) of piece j, against piece i
      const rx = sx1[i] - sx0[i];
      const ry = sy1[i] - sy0[i];
      const L2 = rx * rx + ry * ry;
      if (L2 < 1) return;
      const t = ((x - sx0[i]) * rx + (y - sy0[i]) * ry) / L2;
      if (t <= 0.001 || t >= 0.999) return;
      const dx = sx0[i] + rx * t - x;
      const dy = sy0[i] + ry * t - y;
      if (dx * dx + dy * dy < TOUCH * TOUCH) cut(i, t, x, y);
      void j;
    };
    const done = new Set<number>();
    for (const cell of grid.values()) {
      for (let a = 0; a < cell.length; a++) {
        for (let b = a + 1; b < cell.length; b++) {
          const i = cell[a];
          const j = cell[b];
          const pk = i < j ? i * S + j : j * S + i;
          if (done.has(pk)) continue;
          done.add(pk);
          const rx = sx1[i] - sx0[i];
          const ry = sy1[i] - sy0[i];
          const qx = sx1[j] - sx0[j];
          const qy = sy1[j] - sy0[j];
          const den = rx * qy - ry * qx;
          if (Math.abs(den) > 1e-6) {
            const dx = sx0[j] - sx0[i];
            const dy = sy0[j] - sy0[i];
            const t = (dx * qy - dy * qx) / den;
            const u = (dx * ry - dy * rx) / den;
            if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) {
              const x = sx0[i] + rx * t;
              const y = sy0[i] + ry * t;
              cut(i, t, x, y);
              cut(j, u, x, y);
              continue;
            }
          }
          touch(i, j, sx0[j], sy0[j]);
          touch(i, j, sx1[j], sy1[j]);
          touch(j, i, sx0[i], sy0[i]);
          touch(j, i, sx1[i], sy1[i]);
        }
      }
    }
    // the graph: nodes at every end and cut, snapped; edges between them
    const ids = new Map<string, number>();
    const xs: number[] = [];
    const ys: number[] = [];
    const adj: number[][] = [];
    const ea: number[] = [];
    const eb: number[] = [];
    const eL: number[] = [];
    const ew: number[] = [];
    const node = (x: number, y: number) => {
      const k = `${Math.round(x / SNAP)},${Math.round(y / SNAP)}`;
      let id = ids.get(k);
      if (id === undefined) {
        id = xs.length;
        ids.set(k, id);
        xs.push(x);
        ys.push(y);
        adj.push([]);
      }
      return id;
    };
    const edge = (a: number, b: number, w: number) => {
      if (a === b) return;
      const e = ea.length;
      ea.push(a);
      eb.push(b);
      eL.push(Math.hypot(xs[b] - xs[a], ys[b] - ys[a]));
      ew.push(w);
      adj[a].push(e);
      adj[b].push(e);
    };
    for (let i = 0; i < S; i++) {
      const c = cuts[i];
      let prev = node(sx0[i], sy0[i]);
      if (c) {
        // in order along the piece
        const order: number[] = [];
        for (let k = 0; k < c.length; k += 3) order.push(k);
        order.sort((p, q) => c[p] - c[q]);
        for (const k of order) {
          const n = node(c[k + 1], c[k + 2]);
          edge(prev, n, sw[i]);
          prev = n;
        }
      }
      edge(prev, node(sx1[i], sy1[i]), sw[i]);
    }
    if (ea.length < 30) return this.later();
    // the pin's own spot: the nearest node, if a street is anywhere near
    let s = -1;
    let best = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.hypot(xs[i], ys[i]);
      if (d < best) {
        best = d;
        s = i;
      }
    }
    if (s < 0 || best > NEAR) return this.later();
    // Dijkstra: the distance by road from the pin to every node
    const dist = new Float64Array(xs.length).fill(Infinity);
    dist[s] = best;
    const heap = new Heap();
    heap.push(best, s);
    while (heap.size) {
      const [d, n] = heap.pop();
      if (d > dist[n] || d > this.reach + TAIL) continue;
      for (const e of adj[n]) {
        const o = ea[e] === n ? eb[e] : ea[e];
        const nd = d + eL[e];
        if (nd < dist[o]) {
          dist[o] = nd;
          heap.push(nd, o);
        }
      }
    }
    // the pieces to draw: each edge cut short, with the distance at its
    // middle (the nearer of its two ends' distances plus the way along)
    const pieces: Piece[] = [];
    for (let e = 0; e < ea.length; e++) {
      const a = ea[e];
      const b = eb[e];
      const da = dist[a];
      const db = dist[b];
      if (da === Infinity && db === Infinity) continue;
      const L = eL[e];
      const n = Math.max(1, Math.ceil(L / PIECE));
      for (let i = 0; i < n; i++) {
        const s0 = i / n;
        const s1 = (i + 1) / n;
        const sm = ((s0 + s1) / 2) * L;
        const d = Math.min(da + sm, db + (L - sm));
        if (d > this.reach + TAIL) continue;
        pieces.push({
          x0: xs[a] + (xs[b] - xs[a]) * s0,
          y0: ys[a] + (ys[b] - ys[a]) * s0,
          x1: xs[a] + (xs[b] - xs[a]) * s1,
          y1: ys[a] + (ys[b] - ys[a]) * s1,
          d,
          w: ew[e],
        });
      }
    }
    this.pieces = pieces;
    let reached = 0;
    for (let i = 0; i < xs.length; i++) if (dist[i] < Infinity) reached++;
    this.stats = `features ${feats.length}, pieces ${S}, nodes ${xs.length}, edges ${ea.length}, start ${s} at ${best.toFixed(0)} m with ${adj[s].length} edges, reached ${reached}`;
    return true;
  }

  /** No streets yet (tiles still coming in): try again shortly. */
  private later(): boolean {
    window.clearTimeout(this.retry);
    if (!this.stopped) this.retry = window.setTimeout(() => this.build(), 700);
    return false;
  }

  private draw(now: number) {
    const c = this.canvas;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const m = this.map;
    const el = m.getContainer();
    const W = el.clientWidth;
    const H = el.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = (now - this.t0) / 1000;
    const fade = Math.min(1, t / 0.6);   // the whole thing comes up over the first moment
    const p = m.project([this.pin.lon, this.pin.lat]);
    const s = 1 / this.metresPerPixel();   // px per metre
    const br = (-m.getBearing() * Math.PI) / 180;
    const cb = Math.cos(br);
    const sb = Math.sin(br);
    // local metres (x east, y north) to the screen
    const X = (x: number, y: number) => p.x + (x * cb - y * sb) * s;
    const Y = (x: number, y: number) => p.y - (x * sb + y * cb) * s;
    const reach = this.reach;
    // the pulses alive now: how far each has run
    const life = (reach + TAIL) / SPEED;
    const heads: number[] = [];
    for (let i = Math.floor(t / PERIOD); i >= 0; i--) {
      const age = t - i * PERIOD;
      if (age > life) break;
      heads.push(age * SPEED);
    }
    const orange = this.dark ? "255, 130, 50" : "252, 82, 0";
    const hot = this.dark ? "255, 225, 200" : "255, 205, 165";
    ctx.globalCompositeOperation = this.dark ? "lighter" : "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // the sweep: a wedge of light turning about the pin, its leading edge a thin line
    const R = Math.min(reach * s, Math.hypot(W, H));
    const theta = ((t / TURN) * Math.PI * 2) % (Math.PI * 2);
    const conic = (ctx as CanvasRenderingContext2D & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient }).createConicGradient;
    if (conic) {
      const g = conic.call(ctx, theta, p.x, p.y);
      g.addColorStop(0, `rgba(${orange}, ${(this.dark ? 0.2 : 0.13) * fade})`);
      g.addColorStop(0.16, `rgba(${orange}, 0)`);
      g.addColorStop(1, `rgba(${orange}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = `rgba(${orange}, ${0.45 * fade})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(theta) * R, p.y + Math.sin(theta) * R);
    ctx.stroke();
    // the rings: each pulse's reach as the crow flies, faint, fading as it goes
    for (const h of heads) {
      const a = 0.32 * (1 - h / (reach + TAIL)) * fade;
      if (a <= 0.01) continue;
      ctx.strokeStyle = `rgba(${orange}, ${a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, h * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    // the streets: every piece lit by the pulse nearest behind it, drawn in
    // batches by brightness (a glow under a bright core), the head whiter
    const N = 8;
    const core: Piece[][] = [];
    const head: Piece[][] = [];
    for (let i = 0; i < N; i++) {
      core.push([]);
      head.push([]);
    }
    const cull = 40;
    for (const q of this.pieces) {
      let v = 0;
      let inHead = false;
      for (const h of heads) {
        const x = h - q.d;
        if (x < 0) continue;
        if (x <= HEAD) {
          v = 1;
          inHead = true;
          break;
        }
        const u = 1 - (x - HEAD) / TAIL;
        if (u > 0 && u * u > v) v = u * u;
      }
      if (v <= 0.02) continue;
      const x0 = X(q.x0, q.y0);
      const y0 = Y(q.x0, q.y0);
      if (x0 < -cull || x0 > W + cull || y0 < -cull || y0 > H + cull) continue;
      const b = Math.min(N - 1, Math.floor(v * q.w * N));
      (inHead ? head : core)[b].push(q);
    }
    const strokeAll = (batch: Piece[], width: number, style: string) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      ctx.beginPath();
      for (const q of batch) {
        ctx.moveTo(X(q.x0, q.y0), Y(q.x0, q.y0));
        ctx.lineTo(X(q.x1, q.y1), Y(q.x1, q.y1));
      }
      ctx.stroke();
    };
    for (let b = 0; b < N; b++) {
      const a = ((b + 1) / N) * fade;
      if (core[b].length) {
        strokeAll(core[b], 7, `rgba(${orange}, ${a * 0.24})`);
        strokeAll(core[b], 2.4, `rgba(${orange}, ${a * 0.85})`);
      }
      if (head[b].length) {
        strokeAll(head[b], 9, `rgba(${orange}, ${a * 0.4})`);
        strokeAll(head[b], 2.8, `rgba(${hot}, ${a})`);
      }
    }
    // the pin's own light: a small bloom that beats with the pulses
    const beat = 1 - ((t % PERIOD) / PERIOD);
    const g2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 18 + 22 * (1 - beat));
    g2.addColorStop(0, `rgba(${orange}, ${0.35 * beat * fade})`);
    g2.addColorStop(1, `rgba(${orange}, 0)`);
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 44, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
}
