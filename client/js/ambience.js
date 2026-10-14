// Ambience: the sound of the world under everything else, synthesized like the rest (no audio files).
//   - a wind bed per biome: a breeze in the meadow, wind through the wheat, a howl on the pass, gusts in
//     the badlands, sand hiss on the flats; muffled inside the RV
//   - wildlife, each biome its own: songbirds and a woodpecker in the meadow (frogs at night), crows over the
//     fields, ravens on the pass (a wolf at night), a hawk over the badlands, cicadas and a rattlesnake in the
//     desert, coyotes in the badlands and the desert at night; crickets and an owl where they belong
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
  // a crow's caw, two or three: a harsh nasal saw through a formant, falling
  crow(ctx, pos) {
    const p = panner(around(pos, 25, 60, 10), { ref: 10, out: A.out }), n = 2 + Math.floor(Math.random() * 2), f = rand(560, 680);
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + 0.02 + i * rand(0.38, 0.5), o = ctx.createOscillator(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 1.08, t); o.frequency.exponentialRampToValueAtTime(f * 0.86, t + 0.26);
      bp.type = 'bandpass'; bp.frequency.value = 1350; bp.Q.value = 2.2;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(bp); bp.connect(g); g.connect(p); o.start(t); o.stop(t + 0.3);
    }
  },
  // a raven: lower and rounder ("kraa"), once or twice
  raven(ctx, pos) {
    const p = panner(around(pos, 30, 70, 14), { ref: 12, out: A.out }), n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + 0.02 + i * 0.6, o = ctx.createOscillator(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(330, t); o.frequency.linearRampToValueAtTime(380, t + 0.12); o.frequency.exponentialRampToValueAtTime(300, t + 0.36);
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 3;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      o.connect(bp); bp.connect(g); g.connect(p); o.start(t); o.stop(t + 0.4);
    }
  },
  // a woodpecker drumming on a trunk: fifteen knocks, quickening and fading
  woodpecker(ctx, pos) {
    const p = panner(around(pos, 20, 45, 4), { ref: 8, out: A.out }), n = 12 + Math.floor(Math.random() * 6);
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuffer(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 6;
      g.gain.setValueAtTime(0.09 * (1 - i / n * 0.6), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      s.connect(bp); bp.connect(g); g.connect(p); s.start(t, Math.random() * 0.9); s.stop(t + 0.04);
      t += 0.058 - i * 0.0012;
    }
  },
  // a frog: a creaky two-part croak (a buzz chopped at 30 Hz)
  frog(ctx, pos) {
    const p = panner(around(pos, 10, 30, -1), { ref: 4, out: A.out }), f = rand(260, 340);
    for (const [dt, len] of [[0, 0.16], [0.24, 0.22]]) {
      const t = ctx.currentTime + 0.02 + dt, o = ctx.createOscillator(), am = ctx.createOscillator(), ag = ctx.createGain(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = f; am.type = 'square'; am.frequency.value = 30; ag.gain.value = 0.5;
      g.gain.value = 0; am.connect(ag); ag.connect(g.gain);
      const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.04, t + 0.02); e.gain.exponentialRampToValueAtTime(0.0001, t + len);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      o.connect(g); g.connect(lp); lp.connect(e); e.connect(p); o.start(t); am.start(t); o.stop(t + len + 0.02); am.stop(t + len + 0.02);
    }
  },
  // cicadas: a shrill buzz swelling and dying over a few seconds
  cicada(ctx, pos) {
    const p = panner(around(pos, 12, 35, 2), { ref: 6, out: A.out }), t = ctx.currentTime + 0.02, len = rand(2.5, 4.5);
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), am = ctx.createOscillator(), ag = ctx.createGain(), g = ctx.createGain(), e = ctx.createGain();
    s.buffer = noiseBuffer(); s.loop = true; bp.type = 'bandpass'; bp.frequency.value = rand(4200, 5200); bp.Q.value = 7;
    am.frequency.value = rand(150, 210); ag.gain.value = 0.5; g.gain.value = 0.5; am.connect(ag); ag.connect(g.gain);
    e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.05, t + len * 0.4); e.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp); bp.connect(g); g.connect(e); e.connect(p); s.start(t); am.start(t); s.stop(t + len + 0.05); am.stop(t + len + 0.05);
  },
  // a rattlesnake somewhere in the scrub: a dry rattle, a second and a half
  rattle(ctx, pos) {
    const p = panner(around(pos, 6, 16, -1), { ref: 3, out: A.out }), t = ctx.currentTime + 0.02, len = rand(1.2, 2);
    const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), am = ctx.createOscillator(), ag = ctx.createGain(), g = ctx.createGain(), e = ctx.createGain();
    s.buffer = noiseBuffer(); s.loop = true; hp.type = 'highpass'; hp.frequency.value = 4500;
    am.type = 'square'; am.frequency.value = rand(48, 60); ag.gain.value = 0.5; g.gain.value = 0.5; am.connect(ag); ag.connect(g.gain);
    e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.045, t + 0.15); e.gain.setValueAtTime(0.045, t + len - 0.3); e.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(hp); hp.connect(g); g.connect(e); e.connect(p); s.start(t); am.start(t); s.stop(t + len + 0.05); am.stop(t + len + 0.05);
  },
  // a long howl, far off: up, held with a waver, falling away (a wolf on the pass, a coyote's lower and with yips first)
  howl(ctx, pos, coyote) {
    const p = panner(around(pos, 80, 130, 10), { ref: 30, out: A.out }), t0 = ctx.currentTime + 0.02;
    let t = t0;
    if (coyote) for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) { blip(ctx, p, t, rand(700, 900), rand(1000, 1250), 0.12, 0.025, 'triangle'); t += rand(0.14, 0.22); }
    const f = coyote ? rand(620, 720) : rand(380, 440), len = coyote ? rand(1.0, 1.5) : rand(2.2, 3.2);
    const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(f * 0.8, t); o.frequency.exponentialRampToValueAtTime(f * 1.25, t + len * 0.3); o.frequency.setValueAtTime(f * 1.25, t + len * 0.6); o.frequency.exponentialRampToValueAtTime(f * 0.9, t + len);
    lfo.frequency.value = 5; lg.gain.value = f * 0.012; lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.045, t + 0.3); g.gain.setValueAtTime(0.045, t + len * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(p); o.start(t); lfo.start(t); o.stop(t + len + 0.05); lfo.stop(t + len + 0.05);
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
  ['crow', 9, 26, (b, night) => b === 'fields' && !night],
  ['woodpecker', 20, 50, (b, night) => b === 'meadow' && !night],
  ['frog', 3, 9, (b, night) => b === 'meadow' && night],
  ['raven', 14, 35, (b, night) => b === 'snow' && !night],
  ['wolf', 35, 80, (b, night) => b === 'snow' && night],
  ['cicada', 5, 14, (b, night) => (b === 'desert' || b === 'badlands') && !night],
  ['rattle', 40, 110, (b, night) => b === 'desert' && !night],
  ['coyote', 30, 70, (b, night) => (b === 'badlands' || b === 'desert') && night],
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
    if (t >= A.next[name]) { (name === 'wolf' || name === 'coyote' ? CALLS.howl(ctx, s.pos, name === 'coyote') : CALLS[name](ctx, s.pos)); A.next[name] = t + rand(a, b); }
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
