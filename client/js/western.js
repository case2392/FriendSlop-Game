// A western band, synthesized: no samples, nothing to license. It plays into any BaseAudioContext: the game's
// own (client/js/score.js) and the trailer's OfflineAudioContext (tools/trailer-score.js).
//
//   const k = westernKit(ctx, out);
//   k.strum(t, voicing('G'), { dir: 1 }); k.banjo(t, 62, 0.7); k.whistle(t, 76, 0.6, 1.5, { from: 74 });
//
// The plucked strings (guitar, banjo, upright bass, the twangy baritone, pizzicato) are Karplus-Strong: a burst
// of noise, plucked at a point along the string, decaying in a delay line; computed once per pitch and kept.
// The blown and bowed voices (harmonica, fiddle, whistle, pedal steel, choir, harmonium, strings) are
// oscillators through formant filters, with breath or bow noise. The drums are filtered noise and pitched sines.
// Each instrument plays through its own bus (EQ, pan, a send to the hall and to the twang's spring tank).
// Several kits can share one hall and one spring (opts.shared): the score gives each of its layers a kit.

export const NOTE = n => 440 * 2 ** ((n - 69) / 12);
const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// 'C4' -> 60, 'F#3' -> 54, 'Bb2' -> 46
export function midi(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`not a note: ${name}`);
  return 12 * (+m[3] + 1) + NAMES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
// chords by name: 'G', 'Em', 'D7', 'Am7', 'Bb', 'F#m', 'Esus', 'Bdim': the root (as a pitch class) and its tones
export function chord(name) {
  const m = /^([A-G][#b]?)(m7|maj7|m|7|sus|dim|6)?$/.exec(name);
  if (!m) throw new Error(`not a chord: ${name}`);
  const pc = ((midi(m[1] + '2') % 12) + 12) % 12;
  const tones = { m: [0, 3, 7], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], 7: [0, 4, 7, 10], sus: [0, 5, 7], dim: [0, 3, 6], 6: [0, 4, 7, 9] }[m[2]] || [0, 4, 7];
  return { name, pc, tones, minor: m[2] === 'm' || m[2] === 'm7' || m[2] === 'dim' };
}
// the bass's root for a chord: E2..D#3
export const bassRoot = c => 40 + ((c.pc - 4 + 12) % 12);
// a guitar's open-position voicing (low to high), within E2..E5
export function voicing(c, top = 76) {
  c = typeof c === 'string' ? chord(c) : c;
  const r = bassRoot(c), third = c.tones[1], fifth = c.tones[2], sev = c.tones[3];
  const v = [r, r + fifth, r + 12, r + 12 + third, r + 12 + fifth, r + 24];
  if (sev != null) v[5] = r + 12 + sev;
  return v.filter(n => n <= top).sort((a, b) => a - b);
}
// the chord's tones in a range (low..high), for banjo rolls and arpeggios
export function tonesIn(c, lo, hi) {
  c = typeof c === 'string' ? chord(c) : c;
  const out = [];
  for (let n = lo; n <= hi; n++) if (c.tones.some(t => (n - c.pc - t) % 12 === 0)) out.push(n);
  return out;
}

// ---- what every kit on a context shares ------------------------------------------------------
const RES = new WeakMap();
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
function res(ctx) {
  if (RES.has(ctx)) return RES.get(ctx);
  const sr = ctx.sampleRate, R = rng(1234);
  const noise = ctx.createBuffer(2, sr * 2, sr);
  for (let c = 0; c < 2; c++) { const d = noise.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = R() * 2 - 1; }
  // the hall: 2.4 s of decaying noise, darker as it decays, with a few early reflections
  const hall = ctx.createBuffer(2, Math.round(sr * 2.4), sr);
  for (let c = 0; c < 2; c++) {
    const d = hall.getChannelData(c); let lp = 0;
    for (let i = 0; i < d.length; i++) { const t = i / sr, a = 0.9 - 0.75 * Math.min(1, t / 2); lp += a * ((R() * 2 - 1) - lp); d[i] = lp * Math.exp(-t * 3.0) * (t < 0.01 ? t / 0.01 : 1) * 0.7; }
    for (const [t, g] of [[0.013, 0.4], [0.021 + c * 0.003, 0.3], [0.034, 0.22], [0.047 - c * 0.004, 0.15]]) d[Math.round(t * sr)] += g;
  }
  // the spring tank: a metallic flutter (echoes every 29-37 ms, each one smeared upward) dying in 1.6 s
  const spring = ctx.createBuffer(2, Math.round(sr * 1.6), sr);
  for (let c = 0; c < 2; c++) {
    const d = spring.getChannelData(c), per = 0.029 + c * 0.008; let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr, ph = (t % per) / per;
      lp += 0.35 * ((R() * 2 - 1) - lp);
      d[i] = (lp * 0.5 + Math.sin(2 * Math.PI * (900 + 2600 * ph) * t) * 0.35 * Math.exp(-ph * 9)) * Math.exp(-t * 3.6) * 0.5;
    }
  }
  // a cymbal's metal: six square waves at inharmonic ratios
  const metal = ctx.createBuffer(2, sr * 3, sr);
  for (let c = 0; c < 2; c++) {
    const d = metal.getChannelData(c), fs = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * (1.62 + c * 0.013));
    for (let i = 0; i < d.length; i++) { let v = 0; for (const f of fs) v += Math.sign(Math.sin(2 * Math.PI * f * i / sr)); d[i] = v / 6; }
  }
  const waves = {};
  const wave = (name, amps) => waves[name] ||= ctx.createPeriodicWave(new Float32Array(amps.length + 1), Float32Array.from([0, ...amps]), { disableNormalization: false });
  const r = { noise, hall, spring, metal, ks: new Map(), wave, R };
  RES.set(ctx, r);
  return r;
}
// Karplus-Strong: a string at f, plucked at `pos` (0..0.5 along it), `bright` 0..1 (the pluck's tone), losing
// `loss` of its energy per period (a short decay for a banjo, long for a guitar), `secs` long. Rendered at
// 32 kHz (plenty for strings, and a third of the memory) and kept, at most 200 of them; `rate` tunes it
// exactly (the delay line is a whole number of samples, and averaging each sample with the next one out of
// the line takes half of one off: the period is N - 1/2)
const KS_SR = 32000, KS_MAX = 200;
function ks(ctx, f, { bright = 0.55, pos = 0.18, loss = 0.004, secs = 1.8 } = {}) {
  const R = res(ctx), key = `${Math.round(f * 4)}|${bright}|${pos}|${loss}|${secs}`;
  const hit = R.ks.get(key);
  if (hit) { R.ks.delete(key); R.ks.set(key, hit); return hit; }
  const sr = KS_SR, N = Math.max(2, Math.floor(sr / f + 0.5)), len = Math.round(sr * secs);
  const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0), line = new Float32Array(N), ex = new Float32Array(N);
  let prev = 0;
  for (let i = 0; i < N; i++) { prev += bright * ((R.R() * 2 - 1) - prev); ex[i] = prev; }
  // the pluck point: a comb on the excitation takes out the harmonics with a node there
  const P = Math.max(1, Math.round(N * pos));
  let mean = 0;
  for (let i = 0; i < N; i++) { line[i] = ex[i] - (i >= P ? ex[i - P] : 0) * 0.9; mean += line[i]; }
  mean /= N;
  let peak = 0;
  for (let i = 0; i < N; i++) { line[i] -= mean; peak = Math.max(peak, Math.abs(line[i])); }
  for (let i = 0; i < N; i++) line[i] /= peak || 1;
  const g = 0.5 * (1 - loss);
  for (let i = 0, p = 0; i < len; i++) {
    const a = line[p], nx = line[(p + 1) % N];
    d[i] = a;
    line[p] = g * (a + nx);
    p = (p + 1) % N;
  }
  // (a soft start: no click)
  for (let i = 0; i < 16 && i < len; i++) d[i] *= i / 16;
  const out = { b, rate: f * (N - 0.5) / sr };
  R.ks.set(key, out);
  if (R.ks.size > KS_MAX) R.ks.delete(R.ks.keys().next().value);
  return out;
}

// ---- the kit ---------------------------------------------------------------------------------
// opts: { shared: another kit (its hall and spring), level, tremolo: [Hz, depth] for the twang }
export function westernKit(ctx, out, opts = {}) {
  const R = res(ctx);
  const master = ctx.createGain(); master.gain.value = opts.level ?? 1; master.connect(out);
  let verb, spring;
  if (opts.shared) { verb = opts.shared.verbIn; spring = opts.shared.springIn; }
  else {
    const v = ctx.createConvolver(); v.buffer = R.hall;
    const vo = ctx.createGain(); vo.gain.value = 0.5; v.connect(vo).connect(opts.verbOut || master);
    const s = ctx.createConvolver(); s.buffer = R.spring;
    const so = ctx.createGain(); so.gain.value = 0.55; s.connect(so).connect(opts.verbOut || master);
    verb = v; spring = s;
  }
  const filt = (type, f, q = 0.7, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };
  const shaper = drive => {
    const w = ctx.createWaveShaper(), n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(drive * x) / Math.tanh(drive); }
    w.curve = c; return w;
  };
  // the twang's tremolo: an LFO on a gain (the amp's own)
  const trem = ctx.createGain(), tremLfo = ctx.createOscillator(), tremDepth = ctx.createGain();
  const [tHz, tDepth] = opts.tremolo || [5.6, 0];
  tremLfo.frequency.value = tHz; tremDepth.gain.value = tDepth / 2; trem.gain.value = 1 - tDepth / 2;
  tremLfo.connect(tremDepth).connect(trem.gain); tremLfo.start();
  const SPEC = {
    guitar: { pan: -0.28, send: 0.16, chain: () => [filt('highpass', 85), filt('peaking', 115, 1.2, 3), filt('peaking', 900, 1, -2), filt('peaking', 2600, 1, 2), filt('highshelf', 6000, 0.7, 3)] },
    nylon: { pan: 0.22, send: 0.2, chain: () => [filt('highpass', 90), filt('peaking', 180, 1, 2), filt('lowpass', 5200)] },
    banjo: { pan: 0.36, send: 0.13, level: 1.15, chain: () => [filt('highpass', 170), filt('peaking', 1300, 1.2, 6), filt('highshelf', 5000, 0.7, 2)] },
    bass: { pan: 0, send: 0.03, level: 0.85, chain: () => [filt('lowpass', 1100), filt('peaking', 85, 1, 2)] },
    twang: { pan: 0.08, send: 0.08, spring: 0.55, level: 0.9, chain: () => [filt('highpass', 100), shaper(2.2), filt('peaking', 1600, 1, 5), filt('lowpass', 6200), trem] },
    pizz: { pan: -0.18, send: 0.22, chain: () => [filt('highpass', 140), filt('peaking', 700, 1, 2)] },
    steel: { pan: 0.2, send: 0.28, spring: 0.18, chain: () => [filt('lowpass', 3200)] },
    fiddle: { pan: -0.14, send: 0.3, chain: () => [filt('highpass', 190), filt('peaking', 300, 1, 4), filt('peaking', 1150, 1.5, 5), filt('peaking', 2800, 2, 4), filt('lowpass', 6500)] },
    harmonica: { pan: 0.1, send: 0.24, chain: () => [filt('highpass', 230), filt('peaking', 1100, 1.4, 5), filt('peaking', 2600, 1.5, 3), filt('lowpass', 5200)] },
    whistle: { pan: 0, send: 0.42, chain: () => [filt('highpass', 300), filt('lowpass', 7500)] },
    choir: { pan: 0, send: 0.5, chain: () => [filt('lowpass', 4200)] },
    organ: { pan: -0.05, send: 0.32, chain: () => [filt('lowpass', 2200)] },
    strings: { pan: 0.05, send: 0.38, chain: () => [filt('lowpass', 2600), filt('highpass', 70)] },
    piano: { pan: 0.05, send: 0.2, chain: () => [filt('highpass', 60), filt('peaking', 2800, 1, 2)] },
    harp: { pan: 0.25, send: 0.12, chain: () => [filt('highpass', 120)] },
    kick: { pan: 0, send: 0.03, level: 0.95, chain: () => [filt('peaking', 60, 1, 3)] },
    snare: { pan: 0.04, send: 0.15, level: 0.6, chain: () => [filt('highpass', 120)] },
    hat: { pan: 0.3, send: 0.05, level: 0.32, chain: () => [filt('highpass', 6000)] },
    perc: { pan: -0.3, send: 0.16, level: 0.6, chain: () => [filt('highpass', 300)] },
    tom: { pan: -0.1, send: 0.18, level: 0.8, chain: () => [] },
    timp: { pan: 0, send: 0.35, level: 0.9, chain: () => [filt('lowpass', 1800)] },
    cym: { pan: 0.1, send: 0.14, level: 0.3, chain: () => [filt('highpass', 3800)] },
    bell: { pan: 0, send: 0.45, level: 0.6, chain: () => [] },
    fx: { pan: 0, send: 0.25, level: 0.7, chain: () => [] },
  };
  const buses = {};
  function bus(name) {
    if (buses[name]) return buses[name];
    const s = SPEC[name], input = ctx.createGain();
    let n = input;
    for (const f of s.chain()) { n.connect(f); n = f; }
    const p = ctx.createStereoPanner(); p.pan.value = s.pan || 0; n.connect(p);
    const g = ctx.createGain(); g.gain.value = s.level ?? 1; p.connect(g); g.connect(master);
    if (s.send) { const v = ctx.createGain(); v.gain.value = s.send; g.connect(v); v.connect(verb); }
    if (s.spring) { const v = ctx.createGain(); v.gain.value = s.spring; g.connect(v); v.connect(spring); }
    buses[name] = input;
    return input;
  }
  // an envelope on a new gain: rise in `a` to `peak`, hold, fall over `rel` to end at t + dur
  function env(t, a, peak, dur, rel) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.max(0.002, a));
    g.gain.setValueAtTime(Math.max(peak, 0.0002), t + Math.max(a, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.01, dur));
    return g;
  }
  const osc = (type, f, t, stop) => { const o = ctx.createOscillator(); if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type); o.frequency.setValueAtTime(f, t); o.start(t); o.stop(stop); return o; };
  const noiseSrc = (t, stop) => { const s = ctx.createBufferSource(); s.buffer = R.noise; s.loop = true; s.start(t, R.R() * 1.5); s.stop(stop); return s; };
  // a vibrato on an oscillator's frequency: `rate` Hz, `cents` deep, fading in after `delay`
  function vibrato(o, f, t, delay, rate, cents, stop) {
    const l = ctx.createOscillator(), g = ctx.createGain();
    l.frequency.value = rate;
    const depth = f * (2 ** (cents / 1200) - 1);
    g.gain.setValueAtTime(0, t); g.gain.setValueAtTime(0, t + delay); g.gain.linearRampToValueAtTime(depth, t + delay + 0.25);
    l.connect(g).connect(o.frequency); l.start(t); l.stop(stop);
  }
  // a plucked string through `to`, with an optional pitch scoop (a bend up into the note)
  function pluck(to, t, m, vel, dur, ks0, { bend = 0, release = 0.08 } = {}) {
    const s = ctx.createBufferSource(); s.buffer = ks0.b;
    s.playbackRate.setValueAtTime(ks0.rate * 2 ** (-bend / 12), t);
    if (bend) s.playbackRate.exponentialRampToValueAtTime(ks0.rate, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.setValueAtTime(vel, t + Math.max(0.01, dur));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, dur) + release);
    s.connect(g).connect(to);
    s.start(t); s.stop(t + dur + release + 0.02);
  }

  const k = {
    ctx, master, buses, verbIn: verb, springIn: spring,
    // ---- strings, plucked
    guitar(t, m, vel = 0.6, dur = 1.6, { mute = false, bright = 0.5 } = {}) {
      const b = ks(ctx, NOTE(m), { bright: mute ? 0.3 : bright, pos: 0.15, loss: mute ? 0.05 : 0.0035, secs: mute ? 0.4 : 1.8 });
      pluck(bus('guitar'), t, m, vel * 0.42, mute ? Math.min(dur, 0.18) : dur, b, { release: mute ? 0.04 : 0.12 });
    },
    nylon(t, m, vel = 0.6, dur = 1.6) { pluck(bus('nylon'), t, m, vel * 0.45, dur, ks(ctx, NOTE(m), { bright: 0.35, pos: 0.2, loss: 0.004, secs: 1.8 }), { release: 0.15 }); },
    // a strum across a voicing: dir 1 down (low to high), -1 up (the top four, lighter)
    strum(t, notes, { dir = 1, spread = 0.013, vel = 0.55, dur = 1.4, mute = false, inst = 'guitar' } = {}) {
      const ns = dir > 0 ? notes : notes.slice(-4).reverse();
      ns.forEach((n, i) => k[inst](t + i * spread * (mute ? 0.7 : 1), n, vel * (dir > 0 ? 1 - i * 0.04 : 0.75), dur - i * spread, { mute }));
    },
    // a rasgueado: four fingers flicked out one after another, then the thumb
    rasgueado(t, notes, { vel = 0.55, dur = 1.2, gap = 0.045, inst = 'nylon' } = {}) {
      for (let f = 0; f < 4; f++) k.strum(t + f * gap, notes, { dir: f % 2 ? -1 : 1, spread: 0.006, vel: vel * (0.7 + f * 0.08), dur: dur - f * gap, inst });
    },
    banjo(t, m, vel = 0.6, dur = 0.7) {
      pluck(bus('banjo'), t, m, vel * 0.34, dur, ks(ctx, NOTE(m), { bright: 0.92, pos: 0.12, loss: 0.012, secs: 0.8 }), { release: 0.05 });
      // the head's snap
      const n = noiseSrc(t, t + 0.02), f = filt('highpass', 3500), g = env(t, 0.001, vel * 0.05, 0.015, 0.01);
      n.connect(f).connect(g).connect(bus('banjo'));
    },
    bass(t, m, vel = 0.7, dur = 0.5) {
      pluck(bus('bass'), t, m, vel * 0.4, dur, ks(ctx, NOTE(m), { bright: 0.3, pos: 0.25, loss: 0.006, secs: 1.2 }), { release: 0.06 });
      // the body: a sine under it
      const o = osc('sine', NOTE(m), t, t + dur + 0.1), g = env(t, 0.006, vel * 0.14, dur + 0.05, Math.min(0.2, dur * 0.6));
      o.connect(g).connect(bus('bass'));
    },
    // the baritone guitar through a hot amp: tremolo and a spring tank (the bus); bend: a scoop up in semitones
    twang(t, m, vel = 0.6, dur = 1.2, { bend = 0, mute = false } = {}) {
      const b = ks(ctx, NOTE(m), { bright: mute ? 0.4 : 0.75, pos: 0.1, loss: mute ? 0.04 : 0.0025, secs: mute ? 0.4 : 2.2 });
      pluck(bus('twang'), t, m, vel * 0.4, mute ? Math.min(dur, 0.2) : dur, b, { bend, release: 0.1 });
    },
    pizz(t, m, vel = 0.6, dur = 0.25) { pluck(bus('pizz'), t, m, vel * 0.42, dur, ks(ctx, NOTE(m), { bright: 0.45, pos: 0.3, loss: 0.02, secs: 0.6 }), { release: 0.05 }); },
    // ---- blown and bowed
    whistle(t, m, vel = 0.6, dur = 1, { from = null, vib = 1 } = {}) {
      const f = NOTE(m), stop = t + dur + 0.2, f0 = from != null ? NOTE(from) : f * 2 ** (-0.6 / 12);
      const o = osc('sine', f0, t, stop), o2 = osc('sine', f0 * 2, t, stop);
      o.frequency.exponentialRampToValueAtTime(f, t + (from != null ? 0.1 : 0.06));
      o2.frequency.exponentialRampToValueAtTime(f * 2, t + (from != null ? 0.1 : 0.06));
      if (vib) { vibrato(o, f, t, 0.22, 5.6, 22 * vib, stop); vibrato(o2, f * 2, t, 0.22, 5.6, 22 * vib, stop); }
      const g = env(t, 0.045, vel * 0.2, dur, Math.min(0.15, dur * 0.3)), g2 = ctx.createGain(); g2.gain.value = 0.035;
      o.connect(g); o2.connect(g2).connect(g);
      // breath through the lips: noise in a narrow band at the note
      const n = noiseSrc(t, stop), bp = filt('bandpass', f, 9), ng = env(t, 0.03, vel * 0.05, dur, 0.1);
      n.connect(bp).connect(ng).connect(bus('whistle'));
      g.connect(bus('whistle'));
    },
    harmonica(t, m, vel = 0.6, dur = 0.8, { bend = 0, from = null } = {}) {
      const f = NOTE(m), stop = t + dur + 0.15, W = R.wave('reed', [1, 0.8, 0.62, 0.5, 0.42, 0.33, 0.26, 0.2, 0.15, 0.12, 0.09, 0.07, 0.05]);
      const f0 = from != null ? NOTE(from) : bend ? f * 2 ** (-bend / 12) : f;
      const g = env(t, 0.03, vel * 0.075, dur, Math.min(0.12, dur * 0.3));
      for (const det of [-5, 6]) {
        const o = osc(W, f0, t, stop); o.detune.value = det;
        if (f0 !== f) o.frequency.exponentialRampToValueAtTime(f, t + (bend ? 0.14 : 0.08));
        vibrato(o, f, t, 0.3, 4.8, 9, stop);
        o.connect(g);
      }
      // the hands: a lowpass opening as the note speaks
      const lp = filt('lowpass', 1300, 1.2);
      lp.frequency.setValueAtTime(1300, t); lp.frequency.exponentialRampToValueAtTime(4200, t + 0.12);
      const n = noiseSrc(t, stop), bp = filt('bandpass', 1600, 0.8), ng = env(t, 0.02, vel * 0.02, dur, 0.1);
      n.connect(bp).connect(ng).connect(bus('harmonica'));
      g.connect(lp).connect(bus('harmonica'));
    },
    fiddle(t, m, vel = 0.6, dur = 0.6, { from = null, slide = true, vib = 1 } = {}) {
      const f = NOTE(m), stop = t + dur + 0.15, f0 = from != null ? NOTE(from) : slide ? f * 2 ** (-1.5 / 12) : f;
      const g = env(t, 0.035, vel * 0.11, dur, Math.min(0.1, dur * 0.3));
      for (const det of [-4, 5]) {
        const o = osc('sawtooth', f0, t, stop); o.detune.value = det;
        if (f0 !== f) o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
        if (vib) vibrato(o, f, t, Math.min(0.15, dur * 0.4), 6.0, 14 * vib, stop);
        o.connect(g);
      }
      const n = noiseSrc(t, stop), bp = filt('bandpass', 2600, 0.7), ng = env(t, 0.02, vel * 0.018, dur, 0.06);
      n.connect(bp).connect(ng).connect(bus('fiddle'));
      g.connect(bus('fiddle'));
    },
    // pedal steel: a sine and a quiet saw an octave up, swelled in with the volume pedal, gliding from the last note
    steel(t, m, vel = 0.6, dur = 1, { from = null } = {}) {
      const f = NOTE(m), stop = t + dur + 0.1, f0 = from != null ? NOTE(from) : f;
      const o = osc('sine', f0, t, stop), o2 = osc('sawtooth', f0 * 2, t, stop), o3 = osc('triangle', f0, t, stop);
      for (const [x, ff] of [[o, f], [o2, f * 2], [o3, f]]) { x.frequency.exponentialRampToValueAtTime(ff, t + 0.12); vibrato(x, ff, t, dur * 0.5, 5.0, 8, stop); }
      const g2 = ctx.createGain(); g2.gain.value = 0.1;
      const g3 = ctx.createGain(); g3.gain.value = 0.4;
      const e = env(t, Math.min(0.12, dur * 0.3), vel * 0.2, dur, Math.min(0.25, dur * 0.4));
      o.connect(e); o2.connect(g2).connect(e); o3.connect(g3).connect(e);
      e.connect(bus('steel'));
    },
    // 'aah': two detuned saws and one an octave down through three formants
    choir(t, m, vel = 0.5, dur = 2, { vowel = 'a' } = {}) {
      const f = NOTE(m), stop = t + dur + 0.6, F = { a: [730, 1090, 2440], o: [570, 840, 2410], u: [440, 1020, 2240] }[vowel];
      const mix = ctx.createGain();
      for (const [det, mult, gg] of [[-9, 1, 0.5], [8, 1, 0.5], [0, 0.5, 0.35]]) {
        const o = osc('sawtooth', f * mult, t, stop); o.detune.value = det; vibrato(o, f * mult, t, 0.4, 5.0, 12, stop);
        const g = ctx.createGain(); g.gain.value = gg; o.connect(g).connect(mix);
      }
      const e = env(t, Math.min(0.5, dur * 0.35), vel * 0.06, dur + 0.5, 0.6);
      F.forEach((ff, i) => { const b = filt('bandpass', ff, 6 + i * 3); const g = ctx.createGain(); g.gain.value = [1, 0.5, 0.28][i]; mix.connect(b).connect(g).connect(e); });
      e.connect(bus('choir'));
    },
    // a pump organ (harmonium): a reedy wave, slow to speak
    organ(t, m, vel = 0.5, dur = 2) {
      const f = NOTE(m), stop = t + dur + 0.7, W = R.wave('harmonium', [1, 0.55, 0.6, 0.28, 0.32, 0.15, 0.16, 0.08]);
      const e = env(t, Math.min(0.35, dur * 0.3), vel * 0.05, dur + 0.6, 0.6);
      for (const det of [-3, 4]) { const o = osc(W, f, t, stop); o.detune.value = det; o.connect(e); }
      e.connect(bus('organ'));
    },
    // a string section: three detuned saws, bowed in slowly (or tremolo: the bow shaking at `trem` Hz)
    strings(t, m, vel = 0.5, dur = 2, { trem = 0, swell = false } = {}) {
      const f = NOTE(m), stop = t + dur + 0.6;
      const e = env(t, trem ? 0.08 : Math.min(0.6, dur * 0.4), vel * 0.045, dur + 0.4, 0.45);
      if (swell) { e.gain.cancelScheduledValues(t); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(vel * 0.06, t + dur); e.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3); }
      for (const det of [-9, 0, 8]) { const o = osc('sawtooth', f, t, stop); o.detune.value = det; o.connect(e); }
      if (trem) {
        const a = ctx.createGain(), l = ctx.createOscillator(), lg = ctx.createGain();
        a.gain.value = 0.55; l.frequency.value = trem; lg.gain.value = 0.45; l.connect(lg).connect(a.gain); l.start(t); l.stop(stop);
        e.connect(a).connect(bus('strings'));
      } else e.connect(bus('strings'));
    },
    // a honky-tonk upright: two strings a little apart, a hammer, a fast first decay then a slow one
    piano(t, m, vel = 0.6, dur = 1) {
      const f = NOTE(m), stop = t + dur + 0.5, W = R.wave('piano', [1, 0.6, 0.35, 0.25, 0.16, 0.1, 0.07, 0.05, 0.03]);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel * 0.11, t + 0.004);
      g.gain.exponentialRampToValueAtTime(vel * 0.04, t + 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.45);
      const lp = filt('lowpass', 1500 + 3000 * vel); lp.frequency.setValueAtTime(1500 + 3000 * vel, t); lp.frequency.exponentialRampToValueAtTime(900, t + dur);
      for (const det of [-13, 12]) { const o = osc(W, f, t, stop); o.detune.value = det; o.connect(g); }
      g.connect(lp).connect(bus('piano'));
      const n = noiseSrc(t, t + 0.03), bp = filt('bandpass', 2600, 1), ng = env(t, 0.001, vel * 0.03, 0.025, 0.02);
      n.connect(bp).connect(ng).connect(bus('piano'));
    },
    // the jaw harp: a buzzing reed and the mouth's formant sweeping (boi-oing)
    jawharp(t, m = 43, vel = 0.6, dur = 0.45, { wah = [450, 1900, 650] } = {}) {
      const f = NOTE(m), stop = t + dur + 0.1, W = R.wave('pulse', Array.from({ length: 24 }, (_, i) => Math.sin(Math.PI * (i + 1) * 0.12) / (i + 1)));
      const o = osc(W, f, t, stop), bp = filt('bandpass', wah[0], 7), e = env(t, 0.004, vel * 0.5, dur, dur * 0.6);
      bp.frequency.setValueAtTime(wah[0], t); bp.frequency.exponentialRampToValueAtTime(wah[1], t + dur * 0.35); bp.frequency.exponentialRampToValueAtTime(wah[2], t + dur);
      o.connect(bp).connect(e).connect(bus('harp'));
    },
    // a slide whistle, from one pitch to another (Hz)
    slideWhistle(t, f0, f1, dur = 0.8, vel = 0.5) {
      const o = osc('sine', f0, t, t + dur + 0.1), e = env(t, 0.03, vel * 0.16, dur, 0.1);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      o.connect(e).connect(bus('whistle'));
    },
    // ---- drums
    kick(t, vel = 0.7) {
      const o = osc('sine', 125, t, t + 0.4); o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
      const e = env(t, 0.002, vel * 0.8, 0.32, 0.22); o.connect(e).connect(bus('kick'));
      const n = noiseSrc(t, t + 0.01), f = filt('highpass', 1800), g = env(t, 0.001, vel * 0.08, 0.006, 0.004);
      n.connect(f).connect(g).connect(bus('kick'));
    },
    snare(t, vel = 0.5, { brush = false } = {}) {
      const n = noiseSrc(t, t + 0.3), f = filt('bandpass', brush ? 3400 : 1900, brush ? 0.5 : 0.8);
      const e = brush ? env(t, 0.012, vel * 0.32, 0.2, 0.17) : env(t, 0.001, vel * 0.55, 0.17, 0.15);
      n.connect(f).connect(e).connect(bus('snare'));
      if (!brush) { const o = osc('triangle', 190, t, t + 0.1); o.frequency.exponentialRampToValueAtTime(150, t + 0.06); const g = env(t, 0.001, vel * 0.25, 0.08, 0.06); o.connect(g).connect(bus('snare')); }
    },
    rim(t, vel = 0.5) {
      const n = noiseSrc(t, t + 0.05), f = filt('bandpass', 1800, 5), e = env(t, 0.001, vel * 0.5, 0.03, 0.025);
      n.connect(f).connect(e).connect(bus('perc'));
      const o = osc('sine', 820, t, t + 0.05), g = env(t, 0.001, vel * 0.2, 0.03, 0.025); o.connect(g).connect(bus('perc'));
    },
    hat(t, vel = 0.4, { open = false } = {}) {
      const s = ctx.createBufferSource(); s.buffer = R.metal; const d = open ? 0.35 : 0.045;
      const e = env(t, 0.001, vel * 0.5, d, d * 0.85); s.connect(e).connect(bus('hat')); s.start(t, R.R() * 2); s.stop(t + d + 0.05);
    },
    shaker(t, vel = 0.4) { const n = noiseSrc(t, t + 0.1), f = filt('highpass', 5200), e = env(t, 0.015, vel * 0.16, 0.07, 0.05); n.connect(f).connect(e).connect(bus('hat')); },
    castanets(t, vel = 0.6) {
      for (const dt of [0, 0.028]) {
        const n = noiseSrc(t + dt, t + dt + 0.04), f = filt('bandpass', 2900, 3), e = env(t + dt, 0.001, vel * 0.55 * (dt ? 1 : 0.7), 0.02, 0.018);
        n.connect(f).connect(e).connect(bus('perc'));
        const o = osc('sine', 1350, t + dt, t + dt + 0.04), g = env(t + dt, 0.001, vel * 0.12, 0.02, 0.018); o.connect(g).connect(bus('perc'));
      }
    },
    block(t, vel = 0.5, hi = true) {
      const o = osc('sine', hi ? 980 : 690, t, t + 0.1), e = env(t, 0.001, vel * 0.35, 0.07, 0.06); o.connect(e).connect(bus('perc'));
      const n = noiseSrc(t, t + 0.02), f = filt('bandpass', hi ? 2400 : 1700, 4), g = env(t, 0.001, vel * 0.15, 0.012, 0.01); n.connect(f).connect(g).connect(bus('perc'));
    },
    // a bullwhip: the swish rising, then the crack
    whip(t, vel = 0.8) {
      const n = noiseSrc(t, t + 0.25), f = filt('bandpass', 1400, 2), e = env(t, 0.12, vel * 0.18, 0.14, 0.02);
      f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(6500, t + 0.14);
      n.connect(f).connect(e).connect(bus('fx'));
      const c = noiseSrc(t + 0.14, t + 0.2), cf = filt('highpass', 2200), ce = env(t + 0.14, 0.0005, vel * 1.1, 0.035, 0.03);
      c.connect(cf).connect(ce).connect(bus('fx'));
    },
    tom(t, m = 45, vel = 0.6) {
      const f = NOTE(m), o = osc('sine', f * 1.6, t, t + 0.6); o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
      const e = env(t, 0.002, vel * 0.6, 0.45, 0.35); o.connect(e).connect(bus('tom'));
      const n = noiseSrc(t, t + 0.05), lp = filt('lowpass', 900), g = env(t, 0.001, vel * 0.15, 0.04, 0.03); n.connect(lp).connect(g).connect(bus('tom'));
    },
    timp(t, m = 40, vel = 0.7, dur = 1.8) {
      const f = NOTE(m), stop = t + dur + 0.1;
      for (const [mult, gg, d] of [[1, 0.6, 1], [1.5, 0.22, 0.6], [1.99, 0.14, 0.45], [2.44, 0.07, 0.3]]) {
        const o = osc('sine', f * mult * 1.02, t, stop); o.frequency.exponentialRampToValueAtTime(f * mult, t + 0.06);
        const e = env(t, 0.003, vel * gg, dur * d, dur * d * 0.9); o.connect(e).connect(bus('timp'));
      }
      const n = noiseSrc(t, t + 0.05), lp = filt('lowpass', 600), g = env(t, 0.001, vel * 0.2, 0.04, 0.03); n.connect(lp).connect(g).connect(bus('timp'));
    },
    // a timpani roll: hits 70 ms apart swelling from `v0` to `v1`
    roll(t, m = 40, dur = 1.5, v0 = 0.15, v1 = 0.8) { for (let x = 0; x < dur; x += 0.07) k.timp(t + x, m, v0 + (v1 - v0) * (x / dur), 0.5); },
    cymbal(t, vel = 0.6, dur = 2.2) {
      const s = ctx.createBufferSource(); s.buffer = R.metal; const e = env(t, 0.002, vel * 0.55, dur, dur * 0.9);
      s.connect(e).connect(bus('cym')); s.start(t, R.R()); s.stop(t + dur + 0.05);
      const n = noiseSrc(t, t + dur), f = filt('highpass', 6000), g = env(t, 0.002, vel * 0.12, dur * 0.7, dur * 0.6); n.connect(f).connect(g).connect(bus('cym'));
    },
    // a church bell (FM: a clangorous ratio, the index dying away)
    bell(t, m = 57, vel = 0.6, dur = 3.5) {
      const f = NOTE(m), stop = t + dur + 0.1, c = osc('sine', f, t, stop), mo = osc('sine', f * 1.4, t, stop), mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 3.5, t); mg.gain.exponentialRampToValueAtTime(f * 0.2, t + dur);
      mo.connect(mg).connect(c.frequency);
      const e = env(t, 0.002, vel * 0.3, dur, dur * 0.95); c.connect(e).connect(bus('bell'));
      const h = osc('sine', f * 2.76, t, stop), he = env(t, 0.002, vel * 0.08, dur * 0.4, dur * 0.35); h.connect(he).connect(bus('bell'));
    },
  };
  return k;
}
