// Ambience: the sound of the world under everything else, synthesized like the rest (no audio files).
//   - a wind bed per biome: a breeze in the meadow, wind through the wheat, a howl on the pass, gusts in
//     the badlands, sand hiss on the flats; muffled inside the RV
//   - wildlife: birds by day (meadow, fields), a hawk over the badlands, crickets and an owl at night
//   - campfires crackle where they burn (positional)
// update() runs every frame with where the ears are; everything goes to the ambience bus.
import { audioCtx, bus, noiseBuffer, panner } from './audio.js';

const BEDS = {
  meadow:   { type: 'lowpass',  f: 700,  q: 0.7, g: 0.05,  gust: 0.45, rate: 0.08 },
  fields:   { type: 'bandpass', f: 1800, q: 0.9, g: 0.05,  gust: 0.6,  rate: 0.12 },
  snow:     { type: 'bandpass', f: 430,  q: 5,   g: 0.075, gust: 0.7,  rate: 0.05, sweep: 160 },
  badlands: { type: 'lowpass',  f: 380,  q: 0.8, g: 0.065, gust: 0.9,  rate: 0.1 },
  desert:   { type: 'highpass', f: 2600, q: 0.7, g: 0.03,  gust: 0.5,  rate: 0.07 },
};
const BIRDS = new Set(['meadow', 'fields']);
const CRICKETS = new Set(['meadow', 'fields', 'badlands', 'desert']);
const OWLS = new Set(['meadow', 'fields', 'snow']);

let A = null;                 // the running graph, made on first update()
function build(ctx) {
  const out = ctx.createGain(); out.gain.value = 0;
  const muffle = ctx.createBiquadFilter(); muffle.type = 'lowpass'; muffle.frequency.value = 20000;
  out.connect(muffle); muffle.connect(bus.amb);
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true;
  const f = ctx.createBiquadFilter(), g = ctx.createGain(); g.gain.value = 0;
  src.connect(f); f.connect(g); g.connect(out);
  src.start();
  const fire = ctx.createGain(); fire.gain.value = 0;            // the nearest campfire's rumble
  const fsrc = ctx.createBufferSource(); fsrc.buffer = noiseBuffer(); fsrc.loop = true;
  const flp = ctx.createBiquadFilter(); flp.type = 'lowpass'; flp.frequency.value = 320;
  fsrc.connect(flp); flp.connect(fire);
  fsrc.start(0, 0.37);
  out.gain.setTargetAtTime(1, ctx.currentTime, 1.5);
  return { out, muffle, f, g, fire, firePan: null, biome: null, gust: 0.5, gustT: 0, next: {}, t: 0 };
}

const rand = (a, b) => a + Math.random() * (b - a);
function around(pos, r0, r1, up = 0) {
  const a = Math.random() * Math.PI * 2, r = rand(r0, r1);
  return { x: pos.x + Math.cos(a) * r, y: pos.y + up + rand(-1, 4), z: pos.z + Math.sin(a) * r };
}
// a short enveloped oscillator into `dest` (a panner)
function blip(ctx, dest, t, f0, f1, dur, peak, type = 'sine') {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.01, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.02);
}
const CALLS = {
  bird(ctx, pos) {
    const p = panner(around(pos, 12, 40, 4), { ref: 6, out: A.out });
    const base = rand(2400, 4200), n = 2 + Math.floor(Math.random() * 4);
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      const up = Math.random() < 0.5;
      blip(ctx, p, t, base * (up ? 0.85 : 1.15), base * (up ? 1.2 : 0.8), rand(0.05, 0.12), 0.05);
      t += rand(0.08, 0.18);
    }
  },
  hawk(ctx, pos) {
    const p = panner(around(pos, 50, 80, 25), { ref: 20, out: A.out });
    const t = ctx.currentTime + 0.02, o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
    o.frequency.setValueAtTime(2300, t); o.frequency.exponentialRampToValueAtTime(1500, t + 0.9);
    lfo.frequency.value = 28; lg.gain.value = 60; lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    o.connect(g); g.connect(p);
    o.start(t); lfo.start(t); o.stop(t + 1); lfo.stop(t + 1);
  },
  cricket(ctx, pos) {
    const p = panner(around(pos, 6, 28, -1), { ref: 4, out: A.out });
    const f = rand(4300, 4900), n = 3 + Math.floor(Math.random() * 3);
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) { blip(ctx, p, t, f, f * 0.98, 0.018, 0.03); t += 0.045; }
  },
  owl(ctx, pos) {
    const p = panner(around(pos, 40, 70, 8), { ref: 15, out: A.out });
    const t = ctx.currentTime + 0.02;
    blip(ctx, p, t, 400, 360, 0.35, 0.07);
    blip(ctx, p, t + 0.55, 390, 340, 0.5, 0.06);
  },
  crackle(ctx, at) {
    if (!A.firePan) return;
    const t = ctx.currentTime + 0.01, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuffer();
    f.type = 'highpass'; f.frequency.value = rand(1500, 4000);
    const dur = rand(0.01, 0.04);
    g.gain.setValueAtTime(rand(0.05, 0.18), t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(A.firePan);
    s.start(t, Math.random() * 0.9); s.stop(t + dur + 0.02);
  },
};
// how often each call comes (seconds between, min-max), and when
const SCHEDULE = [
  ['bird', 1.5, 5, (b, night) => BIRDS.has(b) && !night],
  ['hawk', 18, 45, (b, night) => b === 'badlands' && !night],
  ['cricket', 0.25, 0.9, (b, night) => night && CRICKETS.has(b)],
  ['owl', 14, 40, (b, night) => night && OWLS.has(b)],
];

// s: { pos, biome, night, inside (in the RV or a building), fires: [{x, y, z}] }
export function updateAmbience(s, dt) {
  const ctx = audioCtx();
  if (!ctx || ctx.state !== 'running' || !s.pos) return;
  if (!A) A = build(ctx);
  const t = ctx.currentTime, bed = BEDS[s.biome] || BEDS.meadow;
  if (A.biome !== s.biome) {
    A.biome = s.biome;
    A.f.type = bed.type; A.f.Q.setTargetAtTime(bed.q, t, 0.5); A.f.frequency.setTargetAtTime(bed.f, t, 0.5);
  }
  // gusts: a slow random walk on the wind's level (and pitch, on the pass)
  A.gustT -= dt;
  if (A.gustT <= 0) { A.gust = rand(1 - bed.gust, 1); A.gustT = rand(1.5, 1 / bed.rate); }
  const nightK = s.night ? 0.6 : 1;
  A.g.gain.setTargetAtTime(bed.g * A.gust * nightK, t, 1.2);
  if (bed.sweep) A.f.frequency.setTargetAtTime(bed.f + bed.sweep * (A.gust - 0.5), t, 1.5);
  A.muffle.frequency.setTargetAtTime(s.inside ? 700 : 20000, t, 0.25);
  // the nearest fire within 30 m: its rumble and crackles come from there
  let fire = null, best = 30;
  for (const f of s.fires || []) { const d = Math.hypot(f.x - s.pos.x, f.z - s.pos.z); if (d < best) { best = d; fire = f; } }
  if (fire && !A.firePan) { A.firePan = panner({ x: fire.x, y: fire.y + 0.4, z: fire.z }, { ref: 2.5, out: A.out }); A.fire.connect(A.firePan); }
  if (A.firePan && fire) {
    const P = A.firePan;
    if (P.positionX) { P.positionX.value = fire.x; P.positionY.value = fire.y + 0.4; P.positionZ.value = fire.z; } else P.setPosition(fire.x, fire.y + 0.4, fire.z);
  }
  A.fire.gain.setTargetAtTime(fire ? 0.12 : 0, t, 0.5);
  // the calls
  for (const [name, a, b, when] of SCHEDULE) {
    if (!when(s.biome, s.night)) { A.next[name] = null; continue; }
    A.next[name] ??= t + rand(a, b) * 0.5;
    if (t >= A.next[name]) { CALLS[name](ctx, s.pos); A.next[name] = t + rand(a, b); }
  }
  if (fire && Math.random() < dt * 9) CALLS.crackle(ctx);
}

// the menu and loading screens: the wind dies away
export function quietAmbience() {
  if (!A) return;
  const ctx = audioCtx();
  A.g.gain.setTargetAtTime(0, ctx.currentTime, 0.8);
  A.fire.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
}
