// All sound is synthesized with WebAudio: zero audio files. Everything goes through the mixer
// (audio.js): world sounds to the sfx bus, menu and HUD sounds to the ui bus. at(pos, fn) plays what fn
// makes from a point in the world (panned, quieter with distance); the RV's engine and winch come from
// the RV.
import { resumeAudio, bus, panner, noiseBuffer } from './audio.js';

let ctx = null;
let engine = null, winch = null, wind = null, gravel = null, rvPan = null;

export function initAudio() {
  ctx = resumeAudio();
  if (!ctx || engine) return;
  try {
    rvPan = panner({ x: 0, y: -1000, z: 0 }, { ref: 6, max: 120 });
    engine = loop('sawtooth', 48, 360, rvPan);
    winch = loop('square', 220, 1800, rvPan);
    gravel = noiseLoop(220, rvPan);
    wind = noiseLoop(500, bus.sfx);
  } catch (e) { console.warn('audio', e); }
}

function loop(type, freq, lp, dest) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const o2 = ctx.createOscillator(); o2.type = type; o2.frequency.value = freq * 1.51;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
  const g = ctx.createGain(); g.gain.value = 0;
  o.connect(f); o2.connect(f); f.connect(g); g.connect(dest);
  o.start(); o2.start();
  return { o, o2, f, g };
}
function noiseLoop(lp, dest) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
  const g = ctx.createGain(); g.gain.value = 0;
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(0, Math.random());
  return { f, g };
}

// continuous sounds, every frame. rv: the RV's position (the engine, the winch and the gravel come from there)
export function setLoops({ engineOn = false, rpm = 0, near = 1, winchOn = false, windAmt = 0.2, rv = null, speed = 0 }) {
  if (!engine) return;
  const t = ctx.currentTime;
  if (rv) { if (rvPan.positionX) { rvPan.positionX.value = rv.x; rvPan.positionY.value = rv.y + 0.6; rvPan.positionZ.value = rv.z; } else rvPan.setPosition(rv.x, rv.y + 0.6, rv.z); }
  engine.g.gain.setTargetAtTime(engineOn ? 0.09 * Math.max(near, 0.35) : 0, t, 0.15);
  engine.o.frequency.setTargetAtTime(42 + rpm * 70, t, 0.1);
  engine.o2.frequency.setTargetAtTime((42 + rpm * 70) * 1.51, t, 0.1);
  engine.f.frequency.setTargetAtTime(260 + rpm * 500, t, 0.1);
  winch.g.gain.setTargetAtTime(winchOn ? 0.035 : 0, t, 0.1);
  gravel.g.gain.setTargetAtTime(Math.min(1, speed / 14) * 0.16, t, 0.2);
  gravel.f.frequency.setTargetAtTime(160 + speed * 18, t, 0.3);
  wind.g.gain.setTargetAtTime(windAmt * 0.12, t, 0.5);
  wind.f.frequency.setTargetAtTime(300 + windAmt * 900, t, 0.5);
}

// where the next sounds come from: at(pos, () => sfx.shatter())
let spot = null, ui = false;
export function at(pos, fn) {
  if (!ctx || !pos) return fn();
  const prev = spot;
  spot = panner(pos);
  try { fn(); } finally { spot = prev; }
}
function uiSound(fn) { const prev = ui; ui = true; try { fn(); } finally { ui = prev; } }
const dest = () => spot || (ui ? bus.ui : bus.sfx);

function env(node, t, dur, peak = 1, out = dest()) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g); g.connect(out);
  return g;
}
function tone(freq, dur, type = 'square', peak = 0.4, slideTo = null, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  env(o, t, dur, peak);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, freq = 800, peak = 0.5, slideTo = null, type = 'lowpass', delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = dur > 0.9;
  const f = ctx.createBiquadFilter(); f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  s.connect(f); env(f, t, dur, peak);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}

export const sfx = {
  click: () => uiSound(() => tone(700, 0.06, 'square', 0.2, 1000)),
  hover: () => uiSound(() => tone(1400, 0.025, 'sine', 0.05)),
  step: (k = 1) => noise(0.06, 900 + Math.random() * 400, 0.12 * k),
  climb: () => noise(0.08, 1800, 0.12),
  jump: () => noise(0.12, 1200, 0.16, 400),
  land: s => { noise(0.18, 500, Math.min(0.7, 0.15 + s * 0.03), 120); if (s > 9) tone(90, 0.2, 'sine', 0.4, 50); },
  stumble: () => { noise(0.2, 700, 0.3, 200); tone(160, 0.15, 'triangle', 0.15, 90); },
  grab: () => tone(330, 0.07, 'triangle', 0.25, 480),
  wall: () => noise(0.1, 2500, 0.2),
  letgo: () => tone(400, 0.12, 'triangle', 0.2, 250),
  lunge: () => noise(0.25, 1600, 0.35, 300),
  throw: () => noise(0.22, 3000, 0.3, 500, 'bandpass'),
  whoosh: () => { noise(0.2, 1400, 0.26, 500, 'bandpass'); noise(0.12, 3200, 0.08, 1200, 'bandpass', 0.03); },
  // the grumphorn: snoring, a snort, the bellow when it wakes, hooves when it charges, its cowbell
  snore: () => { noise(1.1, 240, 0.16, 110); tone(62, 1.1, 'sawtooth', 0.045, 48); noise(0.5, 900, 0.05, 300, 'bandpass', 0.7); },
  snort: () => { noise(0.22, 1100, 0.32, 260); noise(0.18, 700, 0.22, 200, 'lowpass', 0.14); },
  bellow: () => { tone(118, 1.3, 'sawtooth', 0.22, 74); tone(176, 1.0, 'square', 0.06, 110, 0.06); noise(1.1, 420, 0.14, 140); },
  stampede: () => { for (let i = 0; i < 4; i++) { tone(58, 0.15, 'sine', 0.55, 34, i * 0.13); noise(0.11, 320, 0.3, 90, 'lowpass', i * 0.13); } },
  clang: () => { tone(560, 0.45, 'square', 0.09); tone(845, 0.35, 'square', 0.06); tone(1250, 0.15, 'triangle', 0.04); },
  bonk: () => { tone(330, 0.12, 'triangle', 0.3, 170); noise(0.08, 1300, 0.2); },
  thunk: (k = 1) => { tone(140, 0.12, 'sine', 0.35 * k, 60); noise(0.08, 700, 0.2 * k); },
  shatter: () => { noise(0.5, 6000, 0.6, 1500, 'highpass'); for (let i = 0; i < 6; i++) tone(2000 + Math.random() * 3000, 0.08, 'sine', 0.12, null, Math.random() * 0.25); },
  kaching: () => { tone(1320, 0.08, 'square', 0.25); tone(1760, 0.3, 'square', 0.25, null, 0.07); noise(0.15, 5000, 0.2, null, 'highpass', 0.05); },
  bell: () => { tone(1568, 0.6, 'sine', 0.22); tone(2350, 0.4, 'sine', 0.08, null, 0.01); },
  bill: () => { [392, 370, 349, 262].forEach((f, i) => tone(f, i === 3 ? 0.6 : 0.22, 'sawtooth', 0.18, i === 3 ? 230 : null, i * 0.22)); },
  horn: () => { tone(330, 0.55, 'square', 0.25); tone(415, 0.55, 'square', 0.2); },
  door: () => { noise(0.15, 600, 0.3); tone(180, 0.1, 'triangle', 0.2, 120); },
  engineStart: () => { noise(0.5, 300, 0.25, 900); tone(55, 0.6, 'sawtooth', 0.12, 80, 0.15); },
  engineStop: () => { tone(70, 0.5, 'sawtooth', 0.1, 35); noise(0.3, 400, 0.12, 120, 'lowpass', 0.1); },
  brake: (k = 1) => { tone(2300, 0.35, 'sawtooth', 0.03 * k, 2100); noise(0.3, 3500, 0.06 * k, 1800, 'bandpass'); },
  hook: () => { tone(1200, 0.05, 'triangle', 0.25); tone(900, 0.08, 'triangle', 0.2, null, 0.05); },
  creak: () => tone(120 + Math.random() * 60, 0.4, 'sawtooth', 0.05, 90),
  gate: () => { for (let i = 0; i < 5; i++) noise(0.08, 1500, 0.25, null, 'bandpass', i * 0.12); tone(200, 0.6, 'square', 0.1, 120); },
  buzz: () => tone(110, 0.35, 'square', 0.25),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'square', 0.22, null, i * 0.1)),
  lose: () => [400, 340, 280, 200].forEach((f, i) => tone(f, 0.25, 'sawtooth', 0.18, null, i * 0.13)),
  coin: () => { for (let i = 0; i < 8; i++) tone(1800 + (i % 2) * 400, 0.04, 'square', 0.1, null, i * 0.12); },
  knock: () => { noise(0.3, 400, 0.8, 80); tone(80, 0.3, 'sine', 0.6, 40); },
  ko: () => { tone(880, 0.12, 'sine', 0.2, 440); tone(660, 0.4, 'sine', 0.2, 220, 0.12); },
  wake: () => tone(300, 0.3, 'triangle', 0.2, 600),
  drink: () => { noise(0.4, 900, 0.3, 300); tone(500, 0.3, 'sine', 0.15, 900, 0.3); },
  ping: () => { tone(1500, 0.08, 'sine', 0.25); tone(2000, 0.12, 'sine', 0.2, null, 0.08); },
  // toasts by kind: good news rises, bad news falls, the rest is a soft tick
  toast: (kind = 'info') => uiSound(() => {
    if (kind === 'good') { tone(880, 0.07, 'sine', 0.1); tone(1320, 0.1, 'sine', 0.08, null, 0.06); }
    else if (kind === 'bad') { tone(520, 0.09, 'triangle', 0.12); tone(390, 0.14, 'triangle', 0.1, null, 0.08); }
    else tone(900, 0.05, 'sine', 0.08);
  }),
  radio: () => noise(0.12, 2500, 0.18, null, 'bandpass'),
  repo: () => { tone(98, 1.2, 'sawtooth', 0.3, 60); noise(1.0, 300, 0.4, 60); },
  repoArrives: () => { [196, 185, 175, 98].forEach((f, i) => tone(f, i === 3 ? 0.9 : 0.25, 'sawtooth', 0.14, null, i * 0.25)); },
  sleep: () => [392, 330, 262].forEach((f, i) => tone(f, 0.5, 'sine', 0.15, null, i * 0.3)),
  day: () => [262, 330, 392, 523].forEach((f, i) => tone(f, 0.35, 'triangle', 0.2, null, i * 0.12)),
  owned: () => { [392, 494, 587, 784, 988, 1175].forEach((f, i) => tone(f, i > 3 ? 0.6 : 0.2, 'square', 0.16, null, i * 0.12)); noise(0.8, 6000, 0.1, 2000, 'highpass', 0.7); },
};
