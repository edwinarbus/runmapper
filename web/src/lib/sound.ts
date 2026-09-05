"use client";

// The deck's own noises, made rather than recorded. Every sound here is a
// burst of noise shaped by a filter with a knock under it, so nothing is
// downloaded and no two presses land quite alike. A browser will not start
// audio before the first tap, so the context is opened early but stays
// silent until the first sound, and every sound is asked for by a tap or a
// key press.

type Shape = {
  /** the noise's colour, in hertz, and how tightly it is filtered */
  freq: number;
  q: number;
  /** how loud the noise and how long it takes to go */
  gain: number;
  decay: number;
  /** the knock under it: a low tone that goes almost at once */
  body?: { freq: number; gain: number; decay: number };
  /** the noise sweeps to this colour over its life, for a brush or a slide */
  to?: number;
  /** a second click this long after the first: the far end of a switch's travel */
  then?: Shape;
};

const VOICES: Record<string, Shape> = {
  // a small key on the deck: the paper keys, the tiles, the map's keys
  key: { freq: 2600, q: 1.1, gain: 0.16, decay: 0.032, body: { freq: 230, gain: 0.09, decay: 0.05 } },
  // the start key: bigger, and it knocks
  go: { freq: 1500, q: 0.9, gain: 0.24, decay: 0.05, body: { freq: 128, gain: 0.2, decay: 0.09 } },
  // the start key coming back up, lighter than it went down
  goUp: { freq: 3100, q: 1.4, gain: 0.1, decay: 0.022 },
  // a switch: the click as it leaves, then the snap as it arrives
  snap: {
    freq: 3400,
    q: 2,
    gain: 0.12,
    decay: 0.018,
    then: { freq: 1900, q: 1.4, gain: 0.2, decay: 0.028, body: { freq: 170, gain: 0.1, decay: 0.05 } },
  },
  // one leaf of the split-flap board falling
  flap: { freq: 4300, q: 2.4, gain: 0.05, decay: 0.017 },
  // a bib pulled out of the pile, or thrown aside
  paper: { freq: 900, q: 0.7, gain: 0.09, decay: 0.14, to: 2800 },
};

const STORE = "drawmyrun.sound";
const GAP = 0.045;              // between a switch's two clicks, in seconds

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let on = true;
let touched = false;            // no audio at all until the visitor has touched something

if (typeof window !== "undefined") {
  try {
    on = window.localStorage.getItem(STORE) !== "off";
  } catch {
    /* a browser that keeps nothing: the deck still makes its noises */
  }
  // Caught on the way down, before anything that plays a sound is reached.
  const first = () => {
    touched = true;
    window.removeEventListener("pointerdown", first, true);
    window.removeEventListener("keydown", first, true);
  };
  window.addEventListener("pointerdown", first, true);
  window.addEventListener("keydown", first, true);
  // Opening the context takes the browser a moment, long enough to hold up
  // whatever the first tap was meant to do, so it is opened ahead of time,
  // once the page has settled, and simply waits, silent, for the first sound.
  const ahead = () => {
    if (on) start();
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(ahead, { timeout: 2500 });
  else window.setTimeout(ahead, 1200);
}

/** Whether the deck is making its noises. */
export const soundOn = () => on;

/** Turn them on or off, and remember which. */
export function setSound(next: boolean) {
  on = next;
  try {
    window.localStorage.setItem(STORE, next ? "on" : "off");
  } catch {
    /* nothing to remember it by; the choice holds for this visit */
  }
  if (next && touched) start();
}

function start(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    const n = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noise = n;
  } catch {
    ctx = null;
  }
  return ctx;
}

function fire(s: Shape, at: number) {
  if (!ctx || !master || !noise) return;
  const vary = 0.9 + Math.random() * 0.2;         // no two alike
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = vary;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.setValueAtTime(s.freq * vary, at);
  if (s.to) band.frequency.exponentialRampToValueAtTime(s.to * vary, at + s.decay);
  band.Q.value = s.q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(s.gain, at + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, at + s.decay);
  src.connect(band).connect(g).connect(master);
  src.start(at);
  src.stop(at + s.decay + 0.02);
  if (s.body) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(s.body.freq * vary, at);
    o.frequency.exponentialRampToValueAtTime(s.body.freq * 0.7, at + s.body.decay);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, at);
    bg.gain.linearRampToValueAtTime(s.body.gain, at + 0.002);
    bg.gain.exponentialRampToValueAtTime(0.0001, at + s.body.decay);
    o.connect(bg).connect(master);
    o.start(at);
    o.stop(at + s.body.decay + 0.02);
  }
  if (s.then) fire(s.then, at + GAP);
}

/** Make one of the deck's noises, if the deck is making them. */
export function play(voice: keyof typeof VOICES) {
  if (!on || !touched) return;
  const c = start();
  if (!c) return;
  if (c.state !== "running") c.resume().catch(() => undefined);   // also "interrupted", on an iPhone after a call
  fire(VOICES[voice], c.currentTime + 0.001);
}
