// All sound is synthesized with WebAudio — zero audio files.
let ctx = null, master = null;
let engine = null, winch = null, wind = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
    engine = loop('sawtooth', 48, 360);
    winch = loop('square', 220, 1800);
    wind = noiseLoop(500);
  } catch { ctx = null; }
}
export function audioCtx() { return ctx; }

function loop(type, freq, lp) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const o2 = ctx.createOscillator(); o2.type = type; o2.frequency.value = freq * 1.51;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
  const g = ctx.createGain(); g.gain.value = 0;
  o.connect(f); o2.connect(f); f.connect(g); g.connect(master);
  o.start(); o2.start();
  return { o, o2, f, g };
}
function noiseLoop(lp) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
  const g = ctx.createGain(); g.gain.value = 0;
  src.connect(f); f.connect(g); g.connect(master);
  src.start();
  return { f, g };
}

// continuous sounds, called every frame
export function setLoops({ engineOn = false, rpm = 0, near = 1, winchOn = false, windAmt = 0.2 }) {
  if (!ctx) return;
  const t = ctx.currentTime;
  engine.g.gain.setTargetAtTime(engineOn ? 0.09 * near : 0, t, 0.15);
  engine.o.frequency.setTargetAtTime(42 + rpm * 70, t, 0.1);
  engine.o2.frequency.setTargetAtTime((42 + rpm * 70) * 1.51, t, 0.1);
  engine.f.frequency.setTargetAtTime(260 + rpm * 500, t, 0.1);
  winch.g.gain.setTargetAtTime(winchOn ? 0.035 : 0, t, 0.1);
  wind.g.gain.setTargetAtTime(windAmt * 0.12, t, 0.5);
  wind.f.frequency.setTargetAtTime(300 + windAmt * 900, t, 0.5);
}

function env(node, t, dur, peak = 1, dest = master) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g); g.connect(dest);
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
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  s.connect(f); env(f, t, dur, peak);
  s.start(t);
}

export const sfx = {
  click: () => tone(700, 0.06, 'square', 0.2, 1000),
  step: () => noise(0.06, 900 + Math.random() * 400, 0.12),
  climb: () => noise(0.08, 1800, 0.12),
  jump: () => noise(0.12, 1200, 0.16, 400),
  land: s => { noise(0.18, 500, Math.min(0.7, 0.15 + s * 0.03), 120); if (s > 9) tone(90, 0.2, 'sine', 0.4, 50); },
  grab: () => tone(330, 0.07, 'triangle', 0.25, 480),
  wall: () => noise(0.1, 2500, 0.2),
  letgo: () => tone(400, 0.12, 'triangle', 0.2, 250),
  lunge: () => noise(0.25, 1600, 0.35, 300),
  throw: () => noise(0.22, 3000, 0.3, 500, 'bandpass'),
  thunk: (k = 1) => { tone(140, 0.12, 'sine', 0.35 * k, 60); noise(0.08, 700, 0.2 * k); },
  shatter: () => { noise(0.5, 6000, 0.6, 1500, 'highpass'); for (let i = 0; i < 6; i++) tone(2000 + Math.random() * 3000, 0.08, 'sine', 0.12, null, Math.random() * 0.25); },
  kaching: () => { tone(1320, 0.08, 'square', 0.25); tone(1760, 0.3, 'square', 0.25, null, 0.07); noise(0.15, 5000, 0.2, null, 'highpass', 0.05); },
  bill: () => { [392, 370, 349, 262].forEach((f, i) => tone(f, i === 3 ? 0.6 : 0.22, 'sawtooth', 0.18, i === 3 ? 230 : null, i * 0.22)); },
  horn: () => { tone(330, 0.55, 'square', 0.25); tone(415, 0.55, 'square', 0.2); },
  door: () => { noise(0.15, 600, 0.3); tone(180, 0.1, 'triangle', 0.2, 120); },
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
  toast: () => tone(900, 0.05, 'sine', 0.1),
  radio: () => noise(0.12, 2500, 0.18, null, 'bandpass'),
  repo: () => { tone(98, 1.2, 'sawtooth', 0.3, 60); noise(1.0, 300, 0.4, 60); },
  sleep: () => [392, 330, 262].forEach((f, i) => tone(f, 0.5, 'sine', 0.15, null, i * 0.3)),
  day: () => [262, 330, 392, 523].forEach((f, i) => tone(f, 0.35, 'triangle', 0.2, null, i * 0.12)),
};
