// The mixer: one AudioContext for every sound in the game.
//   ui, sfx, amb (ambience), music, voice  ->  master  ->  limiter  ->  speakers
// Each bus follows its volume setting (the gain is the square of the slider: sliders feel linear), the
// limiter keeps a stack of loud sounds (a horn over a crash over a knock) from clipping, and the master
// fades out while the game is in the background (a setting).
import { settings, onSettings } from './settings.js';

let ctx = null, master = null, limiter = null, hidden = false;
export const bus = {};
const BUSES = ['ui', 'sfx', 'amb', 'music', 'voice'];

// the context, made on first use (browsers start it suspended until a click: resume() after one)
export function audioCtx() {
  if (ctx) return ctx;
  try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); }
  catch { try { ctx = new AudioContext(); } catch { return null; } }
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.003; limiter.release.value = 0.25;
  master = ctx.createGain();
  master.connect(limiter);
  limiter.connect(ctx.destination);
  for (const k of BUSES) { bus[k] = ctx.createGain(); bus[k].connect(master); }
  applyVolumes(true);
  return ctx;
}
export function resumeAudio() { const c = audioCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {}); return c; }

function applyVolumes(now = false) {
  if (!ctx) return;
  const t = ctx.currentTime, set = (g, v) => (now ? (g.gain.value = v) : g.gain.setTargetAtTime(v, t, 0.05));
  for (const k of BUSES) set(bus[k], (k === 'ui' ? 1 : settings[k] ?? 1) ** 2);    // (menu clicks follow the master only)
  set(master, hidden && settings.muteInBackground ? 0 : settings.master ** 2);
}
onSettings(k => { if (k in settings) applyVolumes(); });
const onFocus = () => {
  const h = document.hidden || !document.hasFocus();
  if (h === hidden) return;
  hidden = h;
  applyVolumes();
};
document.addEventListener('visibilitychange', onFocus);
window.addEventListener('blur', onFocus);
window.addEventListener('focus', onFocus);

// a positional source: sound played into it comes from `pos` (x, y, z) in the world
export function panner(pos, { ref = 3, max = 80, out = bus.sfx } = {}) {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';          // (HRTF is kept for voices)
  p.distanceModel = 'inverse'; p.refDistance = ref; p.maxDistance = max; p.rolloffFactor = 1.2;
  if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
  else p.setPosition(pos.x, pos.y, pos.z);
  p.connect(out);
  return p;
}
// the ears: the camera, every frame
export function setListener(pos, fwd) {
  if (!ctx) return;
  const L = ctx.listener;
  if (L.positionX) {
    L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
    L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
    L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
  } else { L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0); }
}
// one second of white noise, shared (sounds start it at a random offset)
let noiseBuf = null;
export function noiseBuffer() {
  if (noiseBuf || !ctx) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
if (typeof window !== 'undefined') window.__nmdAudio = { bus, get ctx() { return ctx; }, get master() { return master; } };
