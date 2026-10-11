// Music, all of it synthesized: no audio files. A "radio" plays an endless written-in-code song on one of
// three stations, and the same tune comes back for the same seed:
//   country   (96 bpm, G major, a train beat and a pedal-steel lead): the road, and the menu
//   lounge    (84 bpm swing, ii-V-I on an FM electric piano): the casino
//   midnight  (112 bpm, E minor, a drone and ticking hats): the last hour before the Repo Man
// Each voice is plain WebAudio (Karplus-Strong plucks computed into buffers, FM, detuned saws, synthesized
// drums) with a convolution reverb on generated noise. A look-ahead scheduler queues a bar at a time.
//   const r = createRadio(ctx, out, { seed, station }); r.start(); r.setStation('lounge'); r.setTension(x); r.stop()

const NOTE = n => 440 * 2 ** ((n - 69) / 12);          // MIDI -> Hz
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

const STATIONS = {
  country: { bpm: 96, root: 55, scale: [0, 2, 4, 7, 9], swing: 0,
    prog: [[0, 4, 7], [0, 4, 7], [5, 9, 12], [0, 4, 7], [7, 11, 14], [5, 9, 12], [0, 4, 7], [7, 11, 14]],
    drums: 'train', lead: 'steel', comp: 'pluck', bass: 'rootfifth' },
  lounge: { bpm: 84, root: 50, scale: [0, 2, 3, 5, 7, 9, 10], swing: 0.18,
    prog: [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [0, 4, 7, 11], [9, 12, 16, 19], [2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11]],
    drums: 'brush', lead: 'epiano', comp: 'epiano', bass: 'walk' },
  midnight: { bpm: 112, root: 52, scale: [0, 3, 5, 7, 10], swing: 0,
    prog: [[0, 3, 7], [0, 3, 7], [8, 12, 15], [7, 10, 14], [0, 3, 7], [5, 8, 12], [3, 7, 10], [7, 11, 14]],
    drums: 'tick', lead: 'steel', comp: 'pad', bass: 'pulse' },
};

// ---- shared resources per context ------------------------------------------------------------
const RES = new WeakMap();
function res(ctx) {
  if (RES.has(ctx)) return RES.get(ctx);
  const sr = ctx.sampleRate;
  // reverb: 2.4 s of exponentially decaying stereo noise, a little darker as it decays
  const len = Math.round(sr * 2.4), ir = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = 0; i < len; i++) { const t = i / sr; const k = 0.35 + 0.6 * Math.exp(-t * 2.5); lp += k * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.exp(-t * 2.6) * 0.6; }
  }
  const noise = ctx.createBuffer(1, sr, sr); const nd = noise.getChannelData(0); for (let i = 0; i < sr; i++) nd[i] = Math.random() * 2 - 1;
  const r = { ir, noise, plucks: new Map() };
  RES.set(ctx, r);
  return r;
}
// Karplus-Strong pluck, cached per pitch: a burst of filtered noise in a decaying delay line
function pluckBuf(ctx, f, bright = 0.5) {
  const R = res(ctx), key = `${Math.round(f * 10)}|${bright}`;
  if (R.plucks.has(key)) return R.plucks.get(key);
  const sr = ctx.sampleRate, N = Math.max(2, Math.round(sr / f)), len = Math.round(sr * 1.6);
  const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0), line = new Float32Array(N);
  let prev = 0;
  for (let i = 0; i < N; i++) { const x = Math.random() * 2 - 1; prev = prev + bright * (x - prev); line[i] = prev; }
  const decay = 0.996 - 0.0000025 * f;
  for (let i = 0, p = 0; i < len; i++) {
    const a = line[p], nx = line[(p + 1) % N];
    d[i] = a;
    line[p] = decay * 0.5 * (a + nx);
    p = (p + 1) % N;
  }
  R.plucks.set(key, b);
  return b;
}

// ---- instruments: each schedules one note at absolute time t into `out` ------------------------
function env(ctx, t, a, peak, dur, rel) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + Math.max(a, dur - rel));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}
const I = {
  pluck(ctx, out, t, midi, vel = 0.5, dur = 1.2) {
    const s = ctx.createBufferSource(); s.buffer = pluckBuf(ctx, NOTE(midi), 0.55);
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.55, t); g.gain.setValueAtTime(vel * 0.55, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.7 + 0.35);
    s.connect(g).connect(out); s.start(t); s.stop(t + dur + 0.5);
  },
  steel(ctx, out, t, midi, vel = 0.5, dur = 0.6, from = null) {
    // pedal steel: sine + a quiet saw an octave up, gliding in from the last note, slow vibrato
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = 'sine'; o2.type = 'sawtooth';
    const f = NOTE(midi), f0 = from != null ? NOTE(from) : f;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
    o2.frequency.setValueAtTime(f0 * 2, t); o2.frequency.exponentialRampToValueAtTime(f * 2, t + 0.09);
    lfo.frequency.value = 5.2; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.006, t + dur * 0.6);
    lfo.connect(lg); lg.connect(o.frequency);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    const g2 = ctx.createGain(); g2.gain.value = 0.12;
    const e = env(ctx, t, 0.06, vel * 0.32, dur, Math.min(0.25, dur * 0.4));
    o.connect(lp); o2.connect(g2).connect(lp); lp.connect(e).connect(out);
    for (const x of [o, o2, lfo]) { x.start(t); x.stop(t + dur + 0.05); }
  },
  epiano(ctx, out, t, midi, vel = 0.5, dur = 0.8) {
    // two-operator FM "Rhodes": ratio 1:1 carrier, modulator at 14x with a fast decaying index (the tine)
    const c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain(), f = NOTE(midi);
    c.frequency.value = f; m.frequency.value = f * 14;
    mg.gain.setValueAtTime(f * 2.2, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.25);
    m.connect(mg).connect(c.frequency);
    const e = env(ctx, t, 0.005, vel * 0.3, dur, dur * 0.6);
    c.connect(e).connect(out);
    c.start(t); m.start(t); c.stop(t + dur + 0.05); m.stop(t + dur + 0.05);
  },
  pad(ctx, out, t, midi, vel = 0.5, dur = 2) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.4;
    const e = env(ctx, t, Math.min(0.6, dur * 0.3), vel * 0.08, dur, Math.min(0.8, dur * 0.4));
    for (const det of [-7, 0, 6]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = NOTE(midi); o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.05); }
    lp.connect(e).connect(out);
  },
  bass(ctx, out, t, midi, vel = 0.6, dur = 0.4) {
    const o = ctx.createOscillator(), s = ctx.createOscillator(); o.type = 'triangle'; s.type = 'sine';
    o.frequency.value = NOTE(midi); s.frequency.value = NOTE(midi);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const e = env(ctx, t, 0.01, vel * 0.5, dur, dur * 0.5);
    o.connect(lp); s.connect(lp); lp.connect(e).connect(out);
    o.start(t); s.start(t); o.stop(t + dur + 0.05); s.stop(t + dur + 0.05);
  },
  kick(ctx, out, t, vel = 0.7) {
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const e = env(ctx, t, 0.003, vel * 0.75, 0.28, 0.2); o.connect(e).connect(out); o.start(t); o.stop(t + 0.32);
  },
  noiseHit(ctx, out, t, type, freq, q, vel, dur) {
    const s = ctx.createBufferSource(); s.buffer = res(ctx).noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const e = env(ctx, t, 0.002, vel, dur, dur * 0.8);
    s.connect(f).connect(e).connect(out); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  },
  snare(ctx, out, t, vel = 0.5) { I.noiseHit(ctx, out, t, 'bandpass', 1900, 0.7, vel * 0.5, 0.16); const o = ctx.createOscillator(); o.frequency.value = 190; const e = env(ctx, t, 0.002, vel * 0.2, 0.08, 0.06); o.connect(e).connect(out); o.start(t); o.stop(t + 0.1); },
  brush(ctx, out, t, vel = 0.3) { I.noiseHit(ctx, out, t, 'bandpass', 3200, 0.5, vel * 0.25, 0.22); },
  hat(ctx, out, t, vel = 0.3) { I.noiseHit(ctx, out, t, 'highpass', 7600, 0.7, vel * 0.22, 0.035); },
};

// ---- the tune --------------------------------------------------------------------------------
// One bar = 4 beats. A 16-bar song: A A B A over the station's 8-chord progression (B = the second half).
// The melody is a motif (4 notes, seeded) on the scale, repeated with a variation, so it sounds written,
// not random; the B section moves the motif up a third.
function motif(r, scaleLen) { const m = []; let d = Math.floor(r() * 3) + 2; for (let i = 0; i < 6; i++) { m.push(d); d = Math.max(0, Math.min(scaleLen * 2 - 1, d + [-2, -1, 1, 1, 2][Math.floor(r() * 5)])); } return m; }
function degreeToMidi(st, deg) { const n = st.scale.length; return st.root + 12 + 12 * Math.floor(deg / n) + st.scale[((deg % n) + n) % n]; }

function scheduleBar(ctx, bus, st, seed, bar, t0, tension = 0) {
  const beat = 60 / st.bpm, sw = st.swing * beat;
  const r = rng(seed * 7919 + bar * 104729 + 1);
  const section = Math.floor(bar / 4) % 4;                 // A A B A
  const chord = st.prog[(bar % 4) + (section === 2 ? 4 : 0)];
  const R = st.root;
  const { dry, wet } = bus;
  // drums
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * beat;
    if (st.drums === 'train') { if (b % 2 === 0) I.kick(ctx, dry, t, 0.6); else I.snare(ctx, dry, t, 0.35); for (let h = 0; h < 2; h++) I.hat(ctx, dry, t + h * beat / 2 + (h ? sw : 0), h ? 0.25 : 0.35); }
    if (st.drums === 'brush') { if (b === 0) I.kick(ctx, dry, t, 0.35); I.brush(ctx, dry, t, b % 2 ? 0.5 : 0.3); I.hat(ctx, dry, t + beat / 2 + sw, 0.2); }
    if (st.drums === 'tick') { I.kick(ctx, dry, t, b === 0 ? 0.7 : 0.4); for (let h = 0; h < 4; h++) I.hat(ctx, dry, t + h * beat / 4, 0.18 + 0.12 * tension); }
  }
  // bass
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * beat;
    if (st.bass === 'rootfifth') I.bass(ctx, dry, t, R - 12 + (b % 2 ? chord[2] - 12 : chord[0]), 0.6, beat * 0.8);
    if (st.bass === 'walk') I.bass(ctx, dry, t, R - 12 + chord[0] + [0, 4, 7, 9][b] % 12, 0.5, beat * 0.9);
    if (st.bass === 'pulse') for (let h = 0; h < 2; h++) I.bass(ctx, dry, t + h * beat / 2, R - 12 + chord[0], 0.45, beat * 0.4);
  }
  // comping
  if (st.comp === 'pluck') for (let b = 0; b < 4; b++) { const t = t0 + b * beat + beat / 2; chord.forEach((c, i) => I.pluck(ctx, wet, t + i * 0.012, R + c, 0.35, beat * 0.9)); }
  if (st.comp === 'epiano') for (const b of [0, 1.5, 2.5]) chord.forEach((c, i) => I.epiano(ctx, wet, t0 + b * beat + sw * (b % 1 ? 1 : 0) + i * 0.008, R + c, 0.4, beat * 1.2));
  if (st.comp === 'pad') chord.forEach(c => I.pad(ctx, wet, t0, R + c, 0.5 + 0.4 * tension, beat * 4));
  // melody: two phrases of the motif per 4 bars; rests on the 4th bar of each phrase
  const mr = rng(seed * 31 + 7);
  const m = motif(mr, st.scale.length), lift = section === 2 ? 2 : 0;
  if (bar % 4 !== 3) {
    const play = st.lead === 'epiano' ? I.epiano : I.steel;
    let prev = null;
    const rhythm = bar % 2 ? [0, 1, 1.5, 2.5] : [0, 0.5, 1, 2];
    rhythm.forEach((pos, i) => {
      const deg = m[(i + bar) % m.length] + lift + (r() < 0.2 ? 1 : 0);
      const midi = degreeToMidi(st, deg);
      const dur = (i === rhythm.length - 1 ? 4 - pos : rhythm[i + 1] - pos) * beat * 0.95;
      play(ctx, wet, t0 + pos * beat + (pos % 1 ? sw : 0), midi, 0.55, dur, prev);
      prev = midi;
    });
  }
  return 4 * beat;
}

function makeBus(ctx, out) {
  const dry = ctx.createGain(), wet = ctx.createGain(), verb = ctx.createConvolver(), send = ctx.createGain();
  verb.buffer = res(ctx).ir; send.gain.value = 0.35;
  wet.connect(out); wet.connect(send); send.connect(verb); verb.connect(out);
  dry.connect(out);
  dry.gain.value = 0.9; wet.gain.value = 0.9;
  return { dry, wet };
}

// Real-time: schedule a bar whenever the next one starts within 0.3 s (call tick() from a 50 ms timer).
// `songTime` lets every client line up on the same bar from the server clock (snapshot `tm`).
export function createRadio(ctx, out, { seed = 1, station = 'country' } = {}) {
  const master = ctx.createGain(); master.gain.value = 0; master.connect(out);
  const bus = makeBus(ctx, master);
  let st = STATIONS[station], nextT = 0, bar = 0, on = false, tension = 0, timer = null;
  const tick = () => {
    if (!on) return;
    while (nextT < ctx.currentTime + 0.3) { nextT += scheduleBar(ctx, bus, st, seed, bar++, Math.max(nextT, ctx.currentTime + 0.02), tension); }
  };
  return {
    start(songTimeSec = 0) { on = true; const barLen = 240 / st.bpm; bar = Math.floor(songTimeSec / barLen); nextT = ctx.currentTime + (barLen - (songTimeSec % barLen)); master.gain.setTargetAtTime(1, ctx.currentTime, 0.5); timer ||= setInterval(tick, 50); tick(); },
    stop() { on = false; master.gain.setTargetAtTime(0, ctx.currentTime, 0.4); clearInterval(timer); timer = null; },
    setStation(name) { if (STATIONS[name]) { st = STATIONS[name]; } },
    setTension(x) { tension = Math.max(0, Math.min(1, x)); },
    output: master,
  };
}
export { STATIONS };
