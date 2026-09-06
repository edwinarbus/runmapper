// The search, shown on the map: light that sets out from the pin and runs
// the streets outwards, the way the engine's search does, until the first
// answer arrives. Every few seconds a few lines leave the pin, each
// running along a street at about road speed (no two quite alike), one
// width all along, brightest at its front and dying away over the length
// behind it; at a junction a line most often keeps on along the way most
// nearly straight ahead, sometimes turns, and now and then sends another
// down a side street (more so near the pin, less so far out), and none
// ever turns back towards the pin. Each line runs out to a distance of
// its own from the pin as the crow flies, so the light reaches a circle
// round the pin rather than the diamond a road distance would make, then
// stops and drains away; and every wave keeps off the streets the last
// five waves took, so each pulse lights different streets.
//
// The streets come from the basemap's own vector tiles (querySourceFeatures
// on the transportation layer). Their crossings are found (a straight
// street's junctions are simplified out of the tiles), the cuts and ends
// snapped into nodes, and every node is given its distance from the pin by
// road, which is how "outwards" is known. Drawn on a canvas laid over the
// map, on the map's own projection, every frame.
import type maplibregl from "maplibre-gl";

const SOURCE = "openmaptiles";
const LAYER = "transportation";
// what a runner can run: not motorways, not rails
const CLASSES = ["minor", "service", "primary", "secondary", "tertiary", "trunk", "path", "track", "residential", "unclassified", "living_street", "pedestrian"];
const SNAP = 2;          // m: points this close are one node
const NEAR = 400;        // m: the pin must be this close to a street for the streets to light
const SPEED = 600;       // m/s: how fast a line runs, once under way
const WAVE = 3.2;        // s: between waves leaving the pin
const BRIGHT = 260;      // m: the front of a line, at full strength
const TAIL = 1100;       // m: over which it dies away behind that
const STEPS = 28;        // the dying away is drawn in this many steps, fine enough to read as one fade
const BRANCH = 0.3;      // the chance a side street is taken at a junction near the pin, besides the way on
const FRESH = 5;         // waves: a street taken by one wave is kept off for this many after
const ALIVE = 32;        // lines alive in one wave, at most
const WIDTH = 3;         // px: a line at its front; it thins towards its tail
const SPARK = 0.45;      // s: the small flash where a line branches

type Tracer = {
  e: number;        // the edge it is on
  from: number;     // the node it came from
  to: number;       // the node it is running to
  s: number;        // m along the edge
  L: number;        // the edge's length
  d: number;        // m run in all; once the line has stopped, it keeps counting, and the light drains along it
  rMax: number;     // m from the pin, as the crow flies, at which it stops
  v: number;        // m/s: its own pace
  born: number;     // s: when it sets off
  trail: number[];  // the points passed: x, y, d triples, oldest first
  stopD: number;    // where the line stopped, in m run; -1 while it runs
  gone: boolean;    // drained away, nothing left to draw
};
type Wave = { t0: number; visited: Uint8Array; tracers: Tracer[] };

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
    const lastN = a.pop() as number;
    const lastD = a.pop() as number;
    if (a.length) {
      a[0] = lastD;
      a[1] = lastN;
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
  // the graph: nodes, and edges between them, with every node's distance from the pin by road
  private xs: number[] = [];
  private ys: number[] = [];
  private adj: number[][] = [];
  private ea: number[] = [];
  private eb: number[] = [];
  private eL: number[] = [];
  private ew: number[] = [];
  private dist = new Float64Array(0);
  private origin = -1;     // the node nearest the pin
  private waves: Wave[] = [];
  private sparks: number[] = [];   // where lines have branched: x, y, t triples
  private nextWave = 0;
  private waveNo = 0;
  private lastWave = new Int32Array(0);   // for each edge, the wave that last took it
  private raf = 0;
  private t0 = 0;
  private last = 0;
  private retry = 0;
  private stopped = false;
  private moved = false;
  private readonly kx: number;
  private readonly ky: number;
  private reach = 2400;    // m: how far the light runs, set from the view
  stats = "";              // the graph's size, for the tests
  frameMs = 0;             // the last frame's drawing time, for the tests
  alive = 0;               // tracers running now, for the tests
  private onIdle = () => {
    if (this.stopped) return;
    // more streets may have come in (tiles loading, the map moved): join them in
    if (this.ea.length === 0 || this.moved) this.build();
    this.moved = false;
  };
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
    this.ky = 111320;   // the sphere the map is drawn on, both ways
  }

  start() {
    const el = this.map.getContainer();
    // the light runs out past the edge of the view, well across the city
    const mpp = this.metresPerPixel();
    this.reach = Math.min(6500, Math.max(2500, Math.hypot(el.clientWidth, el.clientHeight) * 0.85 * mpp));
    // the graph is built a moment after the key press, so the press itself is not held up
    this.retry = window.setTimeout(() => this.build(), 40);
    this.map.on("idle", this.onIdle);
    this.map.on("moveend", this.onMove);
    this.t0 = performance.now();
    this.last = this.t0;
    this.nextWave = 0;
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
    const c = this.canvas;
    c.setAttribute("data-off", "");
    c.style.opacity = "0";
    window.setTimeout(() => {
      c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      c.removeAttribute("data-off");
    }, 150);
  }

  private metresPerPixel() {
    // measured on the map itself: a hundred metres east of the pin, in pixels
    const a = this.map.project([this.pin.lon, this.pin.lat]);
    const b = this.map.project([this.pin.lon + 100 / this.kx, this.pin.lat]);
    return 100 / Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
  }

  /** The streets in the loaded tiles, as a graph, with every node's distance from the pin by road. */
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
      const w = cls === "path" || cls === "track" ? 0.5 : cls === "service" ? 0.7 : 1;
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
    const touch = (i: number, x: number, y: number) => {
      // an end (x, y) of some other piece, against piece i
      const rx = sx1[i] - sx0[i];
      const ry = sy1[i] - sy0[i];
      const L2 = rx * rx + ry * ry;
      if (L2 < 1) return;
      const t = ((x - sx0[i]) * rx + (y - sy0[i]) * ry) / L2;
      if (t <= 0.001 || t >= 0.999) return;
      const dx = sx0[i] + rx * t - x;
      const dy = sy0[i] + ry * t - y;
      if (dx * dx + dy * dy < TOUCH * TOUCH) cut(i, t, x, y);
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
          touch(i, sx0[j], sy0[j]);
          touch(i, sx1[j], sy1[j]);
          touch(j, sx0[i], sy0[i]);
          touch(j, sx1[i], sy1[i]);
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
      if (d > dist[n] || d > limit * 2) continue;
      for (const e of adj[n]) {
        const o = ea[e] === n ? eb[e] : ea[e];
        const nd = d + eL[e];
        if (nd < dist[o]) {
          dist[o] = nd;
          heap.push(nd, o);
        }
      }
    }
    this.xs = xs;
    this.ys = ys;
    this.adj = adj;
    this.ea = ea;
    this.eb = eb;
    this.eL = eL;
    this.ew = ew;
    this.dist = dist;
    this.origin = s;
    this.waves = [];   // the old graph's tracers are on edges that no longer exist
    this.lastWave = new Int32Array(ea.length).fill(-100);
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

  /** A wave sets off: a line down every street from the pin, each leaving
   *  the pin itself (a short stub to the nearest street) a moment apart. */
  private launch(t: number) {
    const s = this.origin;
    if (s < 0) return;
    const wave: Wave = { t0: t, visited: new Uint8Array(this.ea.length), tracers: [] };
    this.waveNo++;
    const stub = Math.hypot(this.xs[s], this.ys[s]);
    for (const e of this.adj[s]) {
      const o = this.ea[e] === s ? this.eb[e] : this.ea[e];
      if (!(this.dist[o] > this.dist[s])) continue;
      wave.visited[e] = 1;
      this.lastWave[e] = this.waveNo;
      wave.tracers.push({
        e,
        from: s,
        to: o,
        s: 0,
        L: this.eL[e],
        d: stub,
        rMax: this.reach * (0.5 + Math.random() * 0.5),
        v: SPEED * (0.85 + Math.random() * 0.3),
        born: t + Math.random() * 0.25,
        trail: [0, 0, 0, this.xs[s], this.ys[s], stub],
        stopD: -1,
        gone: false,
      });
    }
    this.waves.push(wave);
  }

  /** Every line runs on; at a junction it keeps on, and may send others down
   *  the side streets. A line with no way on stops, and its light drains
   *  away along it from the tail to the front. */
  private run(wave: Wave, dt: number, t: number) {
    const { xs, ys, adj, ea, eb, eL, ew, dist } = this;
    const born: Tracer[] = [];
    for (const tr of wave.tracers) {
      if (tr.gone || t < tr.born) continue;
      // out of the pin gently, then at its own pace
      const step = tr.v * (0.45 + 0.55 * Math.min(1, tr.d / 240)) * dt;
      if (tr.stopD >= 0) {
        tr.d += step;
        if (tr.d - tr.stopD > BRIGHT + TAIL) tr.gone = true;
      } else if (Math.hypot(xs[tr.from] + (xs[tr.to] - xs[tr.from]) * (tr.s / (tr.L || 1)), ys[tr.from] + (ys[tr.to] - ys[tr.from]) * (tr.s / (tr.L || 1))) >= tr.rMax) {
        // it has run out to its distance from the pin: it stops where it is, and drains
        tr.stopD = tr.d;
      } else {
        tr.s += step;
        tr.d += step;
        while (tr.s >= tr.L) {
          const over = tr.s - tr.L;
          const n = tr.to;
          const dn = tr.d - over;
          tr.trail.push(xs[n], ys[n], dn);
          // the ways on from here: outwards only, and never a street already
          // lit in this wave; the way most nearly straight ahead is the most
          // likely, but not the only one, so no two waves run the same rays
          const hx = xs[n] - xs[tr.from];
          const hy = ys[n] - ys[tr.from];
          const hl = Math.hypot(hx, hy) || 1;
          // streets the last few waves took are kept off, unless nothing else leads on
          const fresh: number[] = [];
          const stale: number[] = [];
          for (const e of adj[n]) {
            if (wave.visited[e]) continue;
            const o = ea[e] === n ? eb[e] : ea[e];
            if (!(dist[o] > dist[n])) continue;
            (this.waveNo - this.lastWave[e] >= FRESH ? fresh : stale).push(e);
          }
          const ways = fresh.length ? fresh : stale;
          const weights: number[] = [];
          let total = 0;
          for (const e of ways) {
            const o = ea[e] === n ? eb[e] : ea[e];
            const vx = xs[o] - xs[n];
            const vy = ys[o] - ys[n];
            const cos = (hx * vx + hy * vy) / (hl * (Math.hypot(vx, vy) || 1));
            const w = Math.exp(3 * cos) * ew[e];
            weights.push(w);
            total += w;
          }
          if (!ways.length) {
            // the end of the line: it stops here, and drains
            tr.stopD = dn;
            tr.d = dn;
            tr.s = tr.L;
            break;
          }
          let pick = Math.random() * total;
          let on = ways[ways.length - 1];
          for (let i = 0; i < ways.length; i++) {
            pick -= weights[i];
            if (pick <= 0) {
              on = ways[i];
              break;
            }
          }
          wave.visited[on] = 1;
          this.lastWave[on] = this.waveNo;
          // the side streets: nearly always taken close to the pin, so a wave
          // fans out all round before its lines run on; rarely far out
          const chance = tr.d < 400 ? 0.9 : BRANCH * Math.max(0.25, 1 - (tr.d - 400) / (0.8 * this.reach));
          for (const e of ways) {
            if (e === on) continue;
            if (wave.tracers.length + born.length >= ALIVE) break;
            if (Math.random() >= chance * ew[e]) continue;
            wave.visited[e] = 1;
            this.lastWave[e] = this.waveNo;
            const o = ea[e] === n ? eb[e] : ea[e];
            born.push({
              e,
              from: n,
              to: o,
              s: over,
              L: eL[e],
              d: tr.d,
              rMax: this.reach * (0.4 + Math.random() * 0.5),
              v: SPEED * (0.85 + Math.random() * 0.3),
              born: t,
              trail: [xs[n], ys[n], dn],
              stopD: -1,
              gone: false,
            });
            this.sparks.push(xs[n], ys[n], t);
          }
          tr.e = on;
          tr.from = n;
          tr.to = ea[on] === n ? eb[on] : ea[on];
          tr.L = eL[on];
          tr.s = over;
        }
      }
      // the trail behind the light is let go
      const keep = tr.d - BRIGHT - TAIL;
      let drop = 0;
      while (drop + 3 < tr.trail.length && tr.trail[drop + 5] < keep) drop += 3;
      if (drop) tr.trail.splice(0, drop);
    }
    if (born.length) wave.tracers.push(...born);
    wave.tracers = wave.tracers.filter((tr) => !tr.gone);
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
    const dt = Math.min(0.05, (now - this.last) / 1000);   // a stalled frame is not a leap
    this.last = now;
    const fade = Math.min(1, t / 0.5);
    // the waves: a new one when it is time, and every line run on
    if (this.origin >= 0 && t >= this.nextWave) {
      this.launch(t);
      this.nextWave = t + WAVE;
    }
    for (const w of this.waves) this.run(w, dt, t);
    this.waves = this.waves.filter((w) => w.tracers.length > 0);
    while (this.sparks.length && t - this.sparks[2] > SPARK) this.sparks.splice(0, 3);
    this.alive = this.waves.reduce((n, w) => n + w.tracers.length, 0);
    // every point goes through the map's own projection, so the lines lie on the streets exactly
    const lon0 = this.pin.lon;
    const lat0 = this.pin.lat;
    const kx = this.kx;
    const ky = this.ky;
    const P = (x: number, y: number) => m.project([lon0 + x / kx, lat0 + y / ky]);
    const orange = this.dark ? "255, 130, 50" : "252, 82, 0";
    // the line's colour along its length: a touch lighter at the front, the deck's orange behind
    const front = this.dark ? [255, 158, 78] : [255, 118, 44];
    const back = this.dark ? [255, 124, 44] : [246, 78, 0];
    ctx.globalCompositeOperation = this.dark ? "lighter" : "source-over";
    ctx.lineCap = "butt";   // the steps of the fade meet edge to edge, with nothing doubled where they meet
    ctx.lineJoin = "round";
    // each line in steps from its front back: the bright front, then the tail dying away
    const paths: Path2D[] = [];
    for (let k = 0; k < STEPS; k++) paths.push(new Path2D());
    const ends = new Path2D();   // the fronts, rounded off at the line's own width
    const { xs, ys } = this;
    const part = (path: Path2D, pts: number[], lo: number, hi: number) => {
      // the stretch of the trail run between lo and hi metres
      let on = false;
      for (let i = 3; i < pts.length; i += 3) {
        const d0 = pts[i - 1];
        const d1 = pts[i + 2];
        if (d1 <= lo || d0 >= hi || d1 <= d0) continue;
        const fa = (Math.max(lo, d0) - d0) / (d1 - d0);
        const fb = (Math.min(hi, d1) - d0) / (d1 - d0);
        const x0 = pts[i - 3];
        const y0 = pts[i - 2];
        const dx = pts[i] - x0;
        const dy = pts[i + 1] - y0;
        if (!on) {
          const a = P(x0 + dx * fa, y0 + dy * fa);
          path.moveTo(a.x, a.y);
          on = true;
        }
        const b = P(x0 + dx * fb, y0 + dy * fb);
        path.lineTo(b.x, b.y);
      }
    };
    const margin = 160;
    const stepLen = TAIL / (STEPS - 1);
    for (const w of this.waves) {
      for (const tr of w.tracers) {
        if (t < tr.born) continue;
        const f = tr.s / (tr.L || 1);
        const hx = xs[tr.from] + (xs[tr.to] - xs[tr.from]) * f;
        const hy = ys[tr.from] + (ys[tr.to] - ys[tr.from]) * f;
        const head = P(hx, hy);
        if (head.x < -margin || head.x > W + margin || head.y < -margin || head.y > H + margin) continue;
        // a stopped line's front stays put while the fade (measured by d) moves up to it
        const headD = tr.stopD >= 0 ? tr.stopD : tr.d;
        const pts = tr.trail.concat(hx, hy, headD);
        part(paths[0], pts, tr.d - BRIGHT, tr.d);
        for (let k = 1; k < STEPS; k++) {
          const hi = tr.d - BRIGHT - stepLen * (k - 1);
          part(paths[k], pts, hi - stepLen, hi);
        }
        if (tr.stopD < 0) {
          ends.moveTo(head.x + WIDTH / 2, head.y);
          ends.arc(head.x, head.y, WIDTH / 2, 0, Math.PI * 2);
        }
      }
    }
    for (let k = STEPS - 1; k >= 0; k--) {
      // the front at full strength; behind it the light dies away, easing out, and the line thins with it
      const u = k === 0 ? 0 : (k - 1) / (STEPS - 1);
      const a = (k === 0 ? 1 : 0.92 * Math.pow(1 - u, 1.6)) * fade;
      const width = WIDTH - (WIDTH - 1.4) * (k / (STEPS - 1));
      const c = front.map((v, i) => Math.round(v + (back[i] - v) * u));
      ctx.lineWidth = width * 3;
      ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a * 0.12})`;
      ctx.stroke(paths[k]);
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a * 0.9})`;
      ctx.stroke(paths[k]);
    }
    ctx.fillStyle = `rgba(${front[0]}, ${front[1]}, ${front[2]}, ${0.9 * fade})`;
    ctx.fill(ends);
    // where a line has branched, a small flash that goes as quickly as it came
    for (let i = 0; i < this.sparks.length; i += 3) {
      const u = (t - this.sparks[i + 2]) / SPARK;
      if (u < 0 || u > 1) continue;
      const q = P(this.sparks[i], this.sparks[i + 1]);
      const r = 3 + 9 * u;
      const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
      g.addColorStop(0, `rgba(${orange}, ${0.5 * (1 - u) * (1 - u) * fade})`);
      g.addColorStop(1, `rgba(${orange}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
