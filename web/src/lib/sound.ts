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
  /** a second voice sounding with this one: a ring under a click */
  ring?: Shape;
};

const VOICES: Record<string, Shape> = {
  // a small key on the deck: the paper keys, the tiles, the map's keys
  key: { freq: 2600, q: 1.1, gain: 0.2, decay: 0.032, body: { freq: 230, gain: 0.11, decay: 0.05 } },
  // the start key: bigger, and it knocks
  go: { freq: 1500, q: 0.9, gain: 0.28, decay: 0.05, body: { freq: 128, gain: 0.24, decay: 0.09 } },
  // the start key coming back up, lighter than it went down
  goUp: { freq: 3100, q: 1.4, gain: 0.13, decay: 0.022 },
  // a switch: the click as it leaves, then the snap as it arrives
  snap: {
    freq: 3400,
    q: 2,
    gain: 0.15,
    decay: 0.018,
    then: { freq: 1900, q: 1.4, gain: 0.24, decay: 0.028, body: { freq: 170, gain: 0.12, decay: 0.05 } },
  },
  // one leaf of the split-flap board falling onto the next: metal on metal,
  // a sharp bright click with a short high ring under it, and no thud
  flap: { freq: 5800, q: 1.3, gain: 0.22, decay: 0.013, ring: { freq: 7900, q: 12, gain: 0.12, decay: 0.045 } },
  // a bib pulled out of the pile, or thrown aside
  paper: { freq: 900, q: 0.7, gain: 0.11, decay: 0.14, to: 2800 },
};

const STORE = "drawmyrun.sound";
const GAP = 0.045;              // between a switch's two clicks, in seconds

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let on = true;
let touched = false;            // no audio at all until the visitor has touched something
let stale = false;              // the context has been through an interruption or a spell in the background: it is replaced at the next chance

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
  // A context opened ahead of any touch starts suspended, and a phone only
  // lets it go on the events it counts as a touch: the finger lifting, the
  // click, a key. (A finger landing is not one of them, so the sound asked
  // for on the way down could not open it by itself, and a phone stayed
  // silent.) So every one of those events wakes it. They keep doing so for
  // the life of the page: an iPhone puts the context to sleep again when
  // the phone is locked, a call comes in or another app plays, and the
  // sound asked for on the way down cannot wake it, only the finger
  // lifting can. And a context opened before any touch is not always let
  // go by resume() alone: the first touch also plays a moment of silence
  // through it, which is what unlocks it for good.
  const wake = () => {
    if (!on) return;
    // A context that has been interrupted (the phone locked, a call, another
    // app playing, Safari sent to the back) is not to be trusted after it
    // comes back: on an iPhone it often says it is running and plays
    // nothing. It is closed and a fresh one opened, here, inside the touch,
    // where a phone lets a context start.
    const c = stale ? fresh() : start();
    if (!c || c.state === "running") return;
    c.resume().catch(() => undefined);
    unlock(c);
  };
  window.addEventListener("touchend", wake, true);
  window.addEventListener("pointerup", wake, true);
  window.addEventListener("click", wake, true);
  window.addEventListener("keydown", wake, true);
  // Coming back from another app or a locked screen: the context is marked
  // for replacement, and one resume is tried straight away for the browsers
  // that allow it.
  const back = () => {
    stale = true;
    if (on && ctx && ctx.state !== "running") ctx.resume().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") back();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) back();
  });
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
  session(next ? "playback" : "auto");
  try {
    window.localStorage.setItem(STORE, next ? "on" : "off");
  } catch {
    /* nothing to remember it by; the choice holds for this visit */
  }
  if (next && touched) start();
}

/** On an iPhone, sounds are by default an "ambient" session, which the silent
 *  switch mutes; the deck asks for a playback session, as a music app has,
 *  so its keys are heard. Put back when the deck is quieted. */
function session(kind: "playback" | "auto") {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { audioSession?: { type: string } }) : undefined;
  if (!nav?.audioSession) return;
  try {
    nav.audioSession.type = kind;
  } catch {
    /* an older phone: the sounds still play when the switch allows */
  }
}

/** A moment of silence through the context, inside a touch: on an
 *  iPhone this is what turns a context opened ahead of any touch into one
 *  that plays. */
function unlock(c: AudioContext) {
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, c.sampleRate);
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* a context that will not take it: resume() has to do */
  }
}

/** The context closed and a new one opened in its place. */
function fresh(): AudioContext | null {
  stale = false;
  const old = ctx;
  ctx = null;
  master = null;
  noise = null;
  if (old) {
    try {
      old.close().catch(() => undefined);
    } catch {
      /* already gone */
    }
  }
  return start();
}

function start(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    session("playback");
    ctx = new Ctor();
    // an iPhone interrupts a context for a call or another app's sound and
    // does not always bring it back whole: once interrupted, it is replaced
    ctx.addEventListener("statechange", () => {
      if (ctx && (ctx.state as string) === "interrupted") stale = true;
    });
    master = ctx.createGain();
    master.gain.value = 0.75;
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
  if (s.ring) fire(s.ring, at);
  if (s.then) fire(s.then, at + GAP);
}

/** Make one of the deck's noises, if the deck is making them. */
export function play(voice: keyof typeof VOICES) {
  if (!on || !touched) return;
  let c = stale ? fresh() : start();
  if (!c) return;
  if (c.state === "closed") {
    // a context the browser has shut (a phone reclaiming it): a fresh one
    ctx = null;
    c = start();
    if (!c) return;
  }
  if (c.state !== "running") c.resume().catch(() => undefined);   // also "interrupted", on an iPhone after a call
  fire(VOICES[voice], c.currentTime + 0.001);
}
