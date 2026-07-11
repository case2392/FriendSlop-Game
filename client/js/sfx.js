// All sound is synthesized with WebAudio — zero audio assets.

let ctx = null;
let master = null;

export function initAudio() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  } catch { /* no audio, no problem */ }
}

function env(node, t, dur, peak = 1) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g);
  g.connect(master);
  return g;
}

function tone(freq, dur, type = 'square', peak = 0.5, slideTo = null) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  env(o, t, dur, peak);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur, filterFreq = 800, peak = 0.6, slideTo = null) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(filterFreq, t);
  if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  src.connect(f);
  env(f, t, dur, peak);
  src.start(t);
}

export const sfx = {
  click: () => tone(600, 0.08, 'square', 0.3, 900),
  dash: () => noise(0.18, 2500, 0.4, 300),
  bonk: () => { tone(160, 0.12, 'square', 0.5, 80); noise(0.1, 1200, 0.3); },
  splat: () => { noise(0.35, 500, 0.7, 80); tone(120, 0.3, 'sawtooth', 0.3, 40); },
  boom: () => { noise(0.6, 900, 0.9, 60); tone(70, 0.5, 'sawtooth', 0.5, 30); },
  coin: () => { tone(880, 0.07, 'square', 0.25); setTimeout(() => tone(1320, 0.12, 'square', 0.25), 60); },
  tater: () => tone(300, 0.15, 'sawtooth', 0.4, 700),
  tick: () => tone(1000, 0.05, 'square', 0.2),
  go: () => tone(520, 0.4, 'square', 0.4, 1040),
  win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'square', 0.3), i * 120)); },
  lose: () => { [400, 350, 300, 200].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'sawtooth', 0.25), i * 150)); },
  robbed: () => tone(700, 0.2, 'sawtooth', 0.3, 200),
  bet: () => { tone(660, 0.06, 'square', 0.25); setTimeout(() => tone(880, 0.06, 'square', 0.25), 50); },
};
