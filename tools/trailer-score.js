// The trailer's music: a western theme scored to the cut. 96 bpm, so a bar is 2.5 s and every cut in the
// trailer falls on a half bar. Every sound is synthesized here and in the game's own band
// (client/js/western.js: the harmonica, the whistle, the saloon piano, the choir, the bell, the whip): no samples,
// nothing to license. It runs in a page (it needs OfflineAudioContext): renderScore(timing) gives the two
// channels. timing: { secs, sfx: [[s, name]], cuts: [[s, id]] } from the tool's plan(), so the hits land on the
// picture's events.
//
// The form, in trailer seconds:
//    0     the billboard: a twang chord, a lone whistle, a banjo roll in
//    2.5   the pitch: a train beat, strums, the bass on one and three, the harmonica answering the captions
//    7.5   the verbs: the theme on the harmonica, the fiddle under it, a cymbal on each caption
//   15.97  the gate: the band stops dead on the crunch
//   17.5   the Grumphorn asleep: pizzicato on tiptoe, a jaw harp; then (its bellow) a whip and the gallop:
//          toms, a low riff, the fiddle sawing; the timpani when Steve is tossed
//   21.5   knocked out: the band under water, a ringing
//   22.5   the ringtail (a frantic banjo) and the run-over (a whip and the timpani on the thunk)
//   27.6   the breakdown: the tape winds down; fixed, a harmonica lick brings it back
//   30     the casino: the theme as a rag on a saloon piano
//   34.03  NOTHING: the tape stops
//   35     a minute to midnight: a clock, a heartbeat, the church bell, a choir rising; 38.77 REPO'D: the boom
//   40     again: one strum, a snare pick-up
//   41.27  five days: the gallop, the theme on the harmonica and the fiddle; each day its own colour (the
//          snow's whistle, the badlands' steel, the desert's castanets)
//   47.5   up a step for the payoff; 50 the arrival; 51.27 the title's last chord, a whistle and a choir
//   55     the stinger: silence
//   57.5   the button: a harmonica lick and the last chord

import { westernKit } from '../client/js/western.js';

const BPM = 96, BEAT = 60 / BPM, BAR = 4 * BEAT, S16 = BEAT / 4, E8 = BEAT / 2;
const hz = m => 440 * 2 ** ((m - 69) / 12);
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// guitar voicings (MIDI, low string first)
const CH = {
  G: [43, 47, 50, 55, 59, 67], G6: [43, 47, 50, 55, 59, 64], C: [48, 52, 55, 60, 64], D: [50, 57, 62, 66], Em: [40, 47, 52, 55, 59, 64],
  A: [45, 52, 57, 61, 64], A6: [45, 52, 57, 61, 66], E: [40, 47, 52, 56, 59, 64], E7: [40, 47, 50, 56, 59, 64],
};
// the bass's root and fifth for each chord
const BASS = { G: [31, 38], G6: [31, 38], C: [36, 31], D: [38, 33], Em: [28, 35], A: [33, 40], A6: [33, 40], E: [28, 35], E7: [28, 35] };
// a banjo's four notes on a chord (third, second, first string, and the short fifth string)
const BANJO = { G: [55, 59, 62, 67], C: [55, 60, 64, 67], D: [57, 62, 66, 69], Em: [55, 59, 64, 67], A: [57, 61, 64, 69], A6: [57, 61, 66, 69], E: [56, 59, 64, 68], E7: [56, 59, 62, 68], G6: [55, 59, 64, 67] };

export async function renderScore(T, { sr = 48000, solo = null } = {}) {
  const secs = T.secs;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * secs), sr);
  const R = rng(777);
  const cue = name => { const s = T.sfx.find(x => x[1] === name); if (!s) throw new Error(`the cut has no '${name}'`); return s[0]; };
  const warn = [];
  // a bar line the score assumes, checked against the cut (an EDL change that moves a cut shows up here)
  const cutAt = (id, t, nth = 0) => { const c = T.cuts.filter(x => x[1] === id)[nth]; if (!c || Math.abs(c[0] - t) > 0.05) warn.push(`${id}: the score has it at ${t}, the cut at ${c?.[0]}`); return t; };
  const CRUNCH = cue('crunch:30'), KNOCK = cue('knock'), KO = cue('ko'), SPUTTER = cue('sputter'), LOSE = cue('lose');
  const REPOD = cue('repoArrives'), OWNED = cue('owned');
  // (two thunks: the dino's haul, then the run-over)
  function cueN(name, n) { const all = T.sfx.filter(x => x[1] === name); return all[n]?.[0]; }
  const RUNOVER = cueN('thunk:1.4', 1);
  for (const [id, t, nth = 0] of [['cab', 2.5], ['mapfp', 7.5], ['pawn', 12.5], ['gate', 15], ['grumsign', 17.5], ['ringtail', 22.5], ['runover', 25], ['breakdown', 27.5], ['neon', 30], ['hud.png', 35], ['chase1', 41.25], ['payoff', 47.5], ['gnome', 55], ['title.png', 57.5, 1]]) cutAt(id, t, nth);

  // ---- the buses ------------------------------------------------------------------------------------------
  const NOISE = ctx.createBuffer(2, sr * 2, sr);
  for (let c = 0; c < 2; c++) { const d = NOISE.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = R() * 2 - 1; }
  // a cymbal's metal: six square waves at inharmonic ratios, per channel a little apart
  const METAL = ctx.createBuffer(2, sr * 3, sr);
  for (let c = 0; c < 2; c++) {
    const d = METAL.getChannelData(c), fs = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * (1.62 + c * 0.013));
    for (let i = 0; i < d.length; i++) { let v = 0; for (const f of fs) v += Math.sign(Math.sin(2 * Math.PI * f * i / sr)); d[i] = v / 6; }
  }
  // the room: a 2.4 s hall, the decay darker as it goes
  const IR = ctx.createBuffer(2, Math.round(sr * 2.4), sr);
  for (let c = 0; c < 2; c++) {
    const d = IR.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr, a = 0.9 - 0.75 * Math.min(1, t / 2.0);
      lp += a * ((R() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-t * 3.1) * (t < 0.012 ? t / 0.012 : 1);
    }
    for (const [t, g] of [[0.011, 0.5], [0.019, 0.35], [0.027 + c * 0.004, 0.3], [0.041, 0.22]]) d[Math.round(t * sr)] += g;
  }
  const master = ctx.createGain(); master.gain.value = 0.6;   // (headroom: the kick alone peaks near full scale)
  const koF = ctx.createBiquadFilter(); koF.type = 'lowpass'; koF.frequency.value = 20000; koF.Q.value = 0.9;
  const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 2.5; glue.attack.value = 0.012; glue.release.value = 0.25;
  const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  // (a solo render skips the bus compressors, so its level can be measured against the others)
  if (solo) master.connect(koF).connect(ctx.destination); else master.connect(koF).connect(glue).connect(lim).connect(ctx.destination);
  const verb = ctx.createConvolver(); verb.buffer = IR;
  const verbOut = ctx.createGain(); verbOut.gain.value = 0.55; verb.connect(verbOut).connect(master);
  const slap = ctx.createDelay(1); slap.delayTime.value = 0.105;
  const slapFb = ctx.createGain(); slapFb.gain.value = 0.2; slap.connect(slapFb).connect(slap);
  const slapOut = ctx.createGain(); slapOut.gain.value = 0.42; slap.connect(slapOut).connect(master);
  const filt = (type, f, q = 0.7, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };
  const shaper = drive => {
    const w = ctx.createWaveShaper(), n = 4096, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(drive * x) / Math.tanh(drive); }
    w.curve = c; w.oversample = '4x'; return w;
  };
  const comp = (th, ratio, atk = 0.005, rel = 0.12) => { const c = ctx.createDynamicsCompressor(); c.threshold.value = th; c.ratio.value = ratio; c.knee.value = 6; c.attack.value = atk; c.release.value = rel; return c; };
  function bus(name, { level = 1, pan = 0, send = 0.15, slapSend = 0, chain = [] } = {}) {
    const input = ctx.createGain();
    let n = input;
    for (const f of chain) { n.connect(f); n = f; }
    const p = ctx.createStereoPanner(); p.pan.value = pan; n.connect(p);
    const g = ctx.createGain(); g.gain.value = solo && !solo.split(',').includes(name) ? 0 : level; p.connect(g); g.connect(master);
    if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(verb); }
    if (slapSend) { const s = ctx.createGain(); s.gain.value = slapSend; g.connect(s); s.connect(slap); }
    return input;
  }
  const B = {
    kick: bus('drums', { level: 0.9, send: 0.04, chain: [filt('peaking', 60, 1, 3), comp(-14, 4, 0.003, 0.1)] }),
    snare: bus('drums', { level: 0.55, pan: 0.04, send: 0.16, chain: [filt('highpass', 120), comp(-16, 3)] }),
    hats: bus('drums', { level: 0.3, pan: 0.28, send: 0.06, chain: [filt('highpass', 6000)] }),
    cym: bus('drums', { level: 0.32, send: 0.12, chain: [filt('highpass', 3800)] }),
    toms: bus('drums', { level: 0.75, pan: -0.12, send: 0.14, chain: [comp(-14, 3)] }),
    bass: bus('bass', { level: 0.57, send: 0.02, chain: [filt('lowpass', 2000), filt('peaking', 90, 1, 3), comp(-18, 4, 0.004, 0.15)] }),
    sub: bus('bass', { level: 0.12, send: 0 }),
    acoustic: bus('guitars', { level: 0.4, pan: -0.32, send: 0.16, chain: [filt('highpass', 95), filt('peaking', 140, 1.2, 3), filt('peaking', 900, 1, -2), filt('highshelf', 5500, 0.7, 4), comp(-20, 3, 0.004, 0.1)] }),
    banjo: bus('banjo', { level: 1.2, pan: 0.42, send: 0.14, chain: [filt('highpass', 170), filt('peaking', 1300, 1.2, 6), filt('highshelf', 5000, 0.7, 2)] }),
    twang: bus('lead', { level: 0.33, pan: 0.1, send: 0.14, slapSend: 0.55, chain: [filt('highpass', 120), shaper(2.4), filt('peaking', 1700, 1, 5), filt('lowpass', 7200), comp(-18, 3)] }),
    fiddle: bus('lead', { level: 0.2, pan: -0.15, send: 0.28, chain: [filt('peaking', 300, 1, 4), filt('peaking', 1150, 1.5, 5), filt('peaking', 2800, 2, 4), filt('lowpass', 6500), filt('highpass', 180)] }),
    strings: bus('fx', { level: 0.18, send: 0.45, chain: [filt('lowpass', 2200)] }),
    fx: bus('fx', { level: 0.33, send: 0.35 }),
    clock: bus('fx', { level: 0.24, pan: 0.12, send: 0.08 }),
  };

  // the rest of the band: the game's own (client/js/western.js), through its own bus ('band' for --solo)
  const K = westernKit(ctx, bus('band', { level: 0.9, send: 0 }), { tremolo: [6.2, 0.6] });
  // a melody on the kit's harmonica or whistle: [beat offset, beats long, midi, { bend, v }], from t0
  function kline(inst, t0, notes, { v = 0.6 } = {}) {
    let prev = null;
    for (const [b, d, m, o = {}] of notes) {
      const t = t0 + b * BEAT, dur = d * BEAT * 0.97, vv = (o.v ?? 1) * v;
      if (inst === 'harmonica') K.harmonica(t, m, vv, dur, { bend: o.bend ? 1 : 0 });
      else K.whistle(t, m, vv, dur, { from: prev != null && Math.abs(prev - m) <= 5 && prev !== m ? prev : null });
      prev = m;
    }
  }

  // ---- the sounds --------------------------------------------------------------------------------------
  const env = (g, t, v, a, d) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + a); g.gain.exponentialRampToValueAtTime(0.0008, t + a + d); };
  function noiseHit(dest, t, type, f, q, v, dur, attack = 0.001, buf = NOISE) {
    const s = ctx.createBufferSource(); s.buffer = buf;
    const b = filt(type, f, q), g = ctx.createGain();
    env(g, t, v, attack, dur);
    s.connect(b).connect(g).connect(dest); s.start(t, R() * 0.8); s.stop(t + attack + dur + 0.05);
  }
  function tone(dest, t, type, f0, f1, v, dur, attack = 0.002) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    const g = ctx.createGain(); env(g, t, v, attack, dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + attack + dur + 0.05);
  }
  function kick(t, v = 0.85) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.06); o.frequency.exponentialRampToValueAtTime(44, t + 0.3);
    const g = ctx.createGain(); env(g, t, v, 0.002, 0.38);
    o.connect(g).connect(B.kick); o.start(t); o.stop(t + 0.45);
    noiseHit(B.kick, t, 'highpass', 2600, 0.7, v * 0.22, 0.012);
  }
  function snare(t, v = 0.8) {
    noiseHit(B.snare, t, 'bandpass', 2300, 0.55, v * 0.95, 0.17);
    noiseHit(B.snare, t, 'highpass', 6500, 0.7, v * 0.35, 0.09);
    tone(B.snare, t, 'triangle', 200, 165, v * 0.55, 0.09);
    tone(B.snare, t, 'sine', 340, 300, v * 0.2, 0.05);
  }
  const brush = (t, v = 0.3, len = 0.11) => noiseHit(B.snare, t, 'bandpass', 4200, 0.45, v, len, 0.008);
  const hat = (t, v = 0.3, open = false) => { noiseHit(B.hats, t, 'bandpass', 10500, 0.8, v, open ? 0.32 : 0.045, 0.001, METAL); noiseHit(B.hats, t, 'highpass', 9000, 0.7, v * 0.4, open ? 0.25 : 0.03); };
  const crash = (t, v = 0.5, len = 2.2) => { noiseHit(B.cym, t, 'highpass', 4200, 0.6, v, len, 0.002, METAL); noiseHit(B.cym, t, 'highpass', 5200, 0.6, v * 0.7, len * 0.85); };
  const tom = (t, f, v = 0.7) => { tone(B.toms, t, 'sine', f * 1.6, f, v, 0.34); noiseHit(B.toms, t, 'lowpass', 1100, 0.7, v * 0.28, 0.06); };
  const wood = (t, f, v = 0.35) => { tone(B.clock, t, 'sine', f, f * 0.97, v, 0.035); noiseHit(B.clock, t, 'bandpass', f * 1.6, 5, v * 0.5, 0.012); };

  // plucked strings (Karplus-Strong with a fractional delay, so they're in tune): a buffer per note
  const KS = new Map();
  function ksBuf(midi, { t60 = 2, bright = 0.5, damp = 0.5, pick = 0.2, len = null } = {}, vb = 1) {
    const key = [midi, t60, bright, damp, pick, len, vb].join();
    if (KS.has(key)) return KS.get(key);
    const f = hz(midi), P = sr / f, L = Math.max(2, Math.floor(P - damp)), fd = P - damp - L, C = (1 - fd) / (1 + fd);
    const rho = Math.pow(10, -3 / (t60 * f)), N = Math.ceil(sr * (len ?? Math.min(t60, 4)));
    const r = rng(midi * 131 + vb * 7 + Math.round(bright * 100));
    const exc = new Float32Array(L), a = Math.min(0.97, 0.06 + bright * (0.5 + vb * 0.15));
    let lp = 0;
    for (let i = 0; i < L; i++) { lp += a * ((r() * 2 - 1) - lp); exc[i] = lp; }
    const pk = Math.max(1, Math.round(pick * L)), dl = new Float32Array(L);
    let peak = 0, mean = 0;
    for (let i = 0; i < L; i++) { dl[i] = exc[i] - (i >= pk ? exc[i - pk] : 0); mean += dl[i]; }
    mean /= L;
    for (let i = 0; i < L; i++) { dl[i] -= mean; peak = Math.max(peak, Math.abs(dl[i])); }
    for (let i = 0; i < L; i++) dl[i] /= peak || 1;
    const out = new Float32Array(N);
    let idx = 0, prev = 0, ax = 0, ay = 0;
    for (let i = 0; i < N; i++) {
      const cur = dl[idx];
      out[i] = cur;
      const lpv = rho * ((1 - damp) * cur + damp * prev); prev = cur;
      const y = C * lpv + ax - C * ay; ax = lpv; ay = y;
      dl[idx] = y; if (++idx === L) idx = 0;
    }
    const fn = Math.min(N, Math.round(sr * 0.04));
    for (let k = 0; k < fn; k++) out[N - 1 - k] *= k / fn;
    const b = ctx.createBuffer(1, N, sr); b.copyToChannel(out, 0);
    KS.set(key, b); return b;
  }
  function pluck(dest, t, buf, { v = 0.7, bend = 0, bendT = 0.07, mute = null } = {}) {
    const s = ctx.createBufferSource(); s.buffer = buf;
    if (bend) { s.detune.setValueAtTime(bend, t); s.detune.linearRampToValueAtTime(0, t + bendT); }
    const g = ctx.createGain(); g.gain.value = v;
    s.connect(g).connect(dest); s.start(t);
    const note = { g, v, s, t, end: t + buf.duration };
    if (mute != null) damp(note, mute); else s.stop(note.end);
    return note;
  }
  function damp(note, t, rel = 0.035) {
    if (!note || note.muted || t >= note.end || t < note.t) return;
    note.muted = true;
    note.g.gain.setValueAtTime(note.v, t); note.g.gain.linearRampToValueAtTime(0, t + rel); note.s.stop(t + rel + 0.01);
  }
  const vb = v => (v > 0.62 ? 2 : v > 0.35 ? 1 : 0);

  // the acoustic: strums, each string stopping the note it rang before
  const acStr = [];
  function strum(t, chord, { down = true, v = 0.55, spread = 0.011, top = 6 } = {}) {
    const notes = CH[chord], first = 6 - notes.length;
    let order = notes.map((_, i) => i);
    if (!down) order = order.reverse().slice(0, Math.min(top, 4));
    order.forEach((i, k) => {
      const tt = t + k * spread + R() * 0.003, s = first + i, vv = v * (down ? 1 - k * 0.04 : 0.75 - k * 0.05);
      damp(acStr[s], tt);
      acStr[s] = pluck(B.acoustic, tt, ksBuf(notes[i], { t60: 2.6, bright: 0.55, damp: 0.42, pick: 0.17, len: 2.6 }, vb(vv)), { v: vv });
    });
  }
  function choke(t) { for (const n of acStr) damp(n, t, 0.06); }
  // one chord per half bar, strummed down on the beat and up on the and
  function strums(t0, chords, { v = 0.5, upV = 0.6 } = {}) {
    chords.forEach((c, h) => { if (!c) return; for (let b = 0; b < 2; b++) { const t = t0 + h * 2 * BEAT + b * BEAT; strum(t, c, { v }); strum(t + E8, c, { down: false, v: v * upV }); } });
  }
  let bassNote = null;
  function bass(t, midi, { v = 0.8, len = BEAT * 0.85 } = {}) {
    damp(bassNote, t, 0.02);
    bassNote = pluck(B.bass, t, ksBuf(midi, { t60: 1.6, bright: 0.28, damp: 0.5, pick: 0.28, len: 2 }, 1), { v, mute: t + len });
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz(midi);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * 0.6, t + 0.01); g.gain.setTargetAtTime(0, t + len, 0.03);
    o.connect(g).connect(B.sub); o.start(t); o.stop(t + len + 0.25);
  }
  // root on the beat, fifth on the next, per half bar; a walk into the next chord when asked
  function boomChick(t0, chords, { v = 0.8 } = {}) {
    chords.forEach((c, h) => { if (!c) return; const t = t0 + h * 2 * BEAT, [r, f] = BASS[c]; bass(t, r, { v }); bass(t + BEAT, f, { v: v * 0.85 }); });
  }
  const banjo = (t, midi, v = 0.3) => pluck(B.banjo, t, ksBuf(midi, { t60: 0.9, bright: 0.9, damp: 0.28, pick: 0.12, len: 1.1 }, vb(v)), { v });
  // a forward roll: third, second, first, fifth string, as 16ths
  function roll(t0, chord, n16, v = 0.28, cresc = 0) {
    const s = BANJO[chord], order = [0, 1, 2, 3, 1, 2, 3, 2];
    for (let i = 0; i < n16; i++) banjo(t0 + i * S16, s[order[i % 8]], v * (1 + cresc * i / n16) * (i % 4 === 0 ? 1.15 : 1));
  }
  // the twang lead: one note at a time (a new note stops the last); bend: from how many cents below
  let lead = null;
  function twang(t, midi, { v = 0.62, len = null, bend = 0, bendT = 0.08, keep = false } = {}) {
    if (!keep) damp(lead, t, 0.02);
    const n = pluck(B.twang, t, ksBuf(midi, { t60: 2.6, bright: 0.72, damp: 0.33, pick: 0.14, len: 2.8 }, vb(v)), { v, bend, bendT, mute: len != null ? t + len : null });
    if (!keep) lead = n;
    return n;
  }
  // a melody: [beat offset, beats long, midi, { bend }], from t0
  function fiddle(t, midi, dur, { v = 0.3, slide = -40 } = {}) {
    const g = ctx.createGain(), end = t + dur;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.06); g.gain.setValueAtTime(v * 0.92, end - 0.02); g.gain.linearRampToValueAtTime(0, end + 0.12);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.7;
    const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(dur > 0.4 ? 16 : 6, t + Math.min(0.35, dur * 0.7));
    lfo.connect(lg);
    for (const dt of [-7, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(midi);
      o.detune.setValueAtTime(dt + slide, t); o.detune.linearRampToValueAtTime(dt, t + 0.07);
      lg.connect(o.detune); o.connect(g); o.start(t); o.stop(end + 0.15);
    }
    lfo.start(t); lfo.stop(end + 0.15);
    g.connect(B.fiddle);
    noiseHit(B.fiddle, t, 'bandpass', 3200, 1.2, v * 0.12, Math.max(0.05, dur * 0.8), 0.04);
  }
  // sustained, bowed-sounding cluster with a tremolo: the build to midnight
  function strings(t, midis, dur, v0, v1) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(v0, t); g.gain.linearRampToValueAtTime(v1, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
    const tr = ctx.createGain(); tr.gain.value = 0.6;
    const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 12.8;
    const lg = ctx.createGain(); lg.gain.value = 0.4; lfo.connect(lg).connect(tr.gain);
    for (const m of midis) for (const dt of [-9, 0, 8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = dt;
      o.connect(tr); o.start(t); o.stop(t + dur + 0.05);
    }
    tr.connect(g).connect(B.strings); lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  function brass(t, midis, dur, v = 0.4) {
    const lp = filt('lowpass', 400, 1.2);
    lp.frequency.setValueAtTime(400, t); lp.frequency.exponentialRampToValueAtTime(3000, t + 0.05); lp.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.exponentialRampToValueAtTime(v * 0.4, t + dur * 0.6); g.gain.linearRampToValueAtTime(0, t + dur);
    for (const m of midis) for (const dt of [-12, 0, 11]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = dt;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
    }
    lp.connect(g).connect(B.fx);
  }
  function riser(t, dur, v = 0.15) {
    const s = ctx.createBufferSource(); s.buffer = NOISE; s.loop = true;
    const b = filt('bandpass', 300, 2.5); b.frequency.setValueAtTime(300, t); b.frequency.exponentialRampToValueAtTime(7500, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    s.connect(b).connect(g).connect(B.fx); s.start(t); s.stop(t + dur + 0.05);
  }
  function boom(t, v = 0.9) {
    tone(B.fx, t, 'sine', 72, 27, v, 2.2, 0.004);
    noiseHit(B.fx, t, 'lowpass', 220, 0.8, v * 0.6, 0.5);
    kick(t, 1);
  }
  // a stab: the band hits one chord together
  function stab(t, chord, { v = 0.6, cym = 0.45 } = {}) {
    kick(t, 0.9); crash(t, cym, 1.6);
    strum(t, chord, { v: v * 0.9, spread: 0.006 });
    const [r] = BASS[chord]; bass(t, r, { v, len: 0.35 });
  }

  // ---- the score ---------------------------------------------------------------------------------------
  const bar = n => n * BAR;
  // drums: the train beat (brushes on 16ths, the backbeat accented); the gallop is below
  const TRAIN = [0.42, 0.14, 0.22, 0.14, 0.7, 0.14, 0.24, 0.16, 0.42, 0.14, 0.22, 0.14, 0.7, 0.14, 0.26, 0.2];
  function trainBeat(t0, beats, v = 1) {
    for (let i = 0; i < beats * 4; i++) {
      const t = t0 + i * S16, k = i % 16;
      brush(t, TRAIN[k] * 0.55 * v, k % 4 === 0 ? 0.13 : 0.08);
      if (k === 4 || k === 12) snare(t, 0.28 * v);
      if (k === 0 || k === 8) kick(t, 0.62 * v);
    }
  }
  // the gallop: da-da-DUM on the toms and the kick every beat, the snare on two and four, brushes in 16ths
  function gallop(t0, beats, v = 1) {
    for (let i = 0; i < beats; i++) {
      const t = t0 + i * BEAT;
      kick(t, 0.8 * v); tom(t + E8, 96, 0.42 * v); tom(t + E8 + S16, 120, 0.5 * v);
      if (i % 2) snare(t, 0.7 * v);
      for (let q = 0; q < 4; q++) brush(t + q * S16, (q === 0 ? 0.3 : 0.16) * v, 0.08);
    }
  }
  // the fiddle sawing away on 16ths (the chase)
  function saw(t0, beats, notes = [76, 71], v = 0.16) { for (let i = 0; i < beats * 4; i++) fiddle(t0 + i * S16, notes[i % notes.length], S16 * 0.9, { v: v * (i % 4 === 0 ? 1.2 : 1), slide: 0 }); }
  // the low riff on the twang (muted but for the one), the bass doubling it
  function wriff(t0, notes, v = 0.6) { notes.forEach((m, i) => { twang(t0 + i * E8, m, { v: (i % 4 === 0 ? 1.1 : 0.85) * v, len: i % 4 === 0 ? E8 * 1.6 : E8 * 0.5, keep: true }); bass(t0 + i * E8, m - 12, { v: 0.7, len: E8 * 0.8 }); }); }
  function fill(t0, n16, v0 = 0.3, v1 = 0.8, toms = false) {
    for (let i = 0; i < n16; i++) { const v = v0 + (v1 - v0) * i / Math.max(1, n16 - 1); if (toms) tom(t0 + i * S16, [150, 120, 96, 72][Math.floor(i * 4 / n16)], v); else snare(t0 + i * S16, v); }
  }
  // the chase riff in E minor, on the twang's low strings
  const RIFF = [40, 40, 43, 40, 45, 43, 40, 38], RIFF2 = [45, 45, 48, 45, 47, 47, 43, 42];

  // 0: the billboard. A twang chord rings; a banjo roll and a snare pick-up into the groove
  for (const [k, m] of [55, 59, 64, 67].entries()) twang(0.03 + k * 0.022, m, { v: 0.42, keep: true });
  K.whistle(0.12, 74, 0.5, 0.5); K.whistle(0.62, 79, 0.55, 0.85, { from: 74 }); K.whistle(1.5, 78, 0.4, 0.3, { from: 79 }); K.whistle(1.8, 74, 0.45, 0.6, { from: 78 });
  riser(1.25, 1.25, 0.06);
  roll(bar(0) + 2 * BEAT, 'G', 8, 0.22, 0.8);
  fill(bar(0) + 3 * BEAT, 4, 0.2, 0.55);

  // 2.5: the pitch (G, C, D): the train beat; the twang answers the captions
  trainBeat(bar(1), 8);
  strums(bar(1), ['G', 'G', 'C', 'D'], { v: 0.46 });
  boomChick(bar(1), ['G', 'G', 'C']); bass(bar(2) + 2 * BEAT, 38);
  roll(bar(2), 'C', 8, 0.18); roll(bar(2) + 2 * BEAT, 'D', 8, 0.2);
  kline('harmonica', bar(1) + 3 * BEAT, [[0, 0.5, 71, { bend: 1 }], [0.5, 0.25, 74], [0.75, 0.25, 76]], { v: 0.6 });
  kline('harmonica', bar(2) + 3 * BEAT, [[0.25, 0.25, 67], [0.5, 0.25, 69], [0.75, 0.25, 71]], { v: 0.6 });
  bass(bar(2) + 3 * BEAT, 36, { v: 0.72, len: E8 * 0.85 }); bass(bar(2) + 3.5 * BEAT, 35, { v: 0.72, len: E8 * 0.85 });

  // 7.5: the verbs (G C | G D | C D) and the theme
  const T1 = bar(3);
  trainBeat(T1, 12, 1.2);
  for (const [t, v] of [[T1, 0.45], [T1 + 2 * BEAT, 0.25], [bar(4), 0.4], [bar(4) + 2 * BEAT, 0.25], [bar(5), 0.4]]) crash(t, v, 1.6);
  strums(T1, ['G', 'C', 'G', 'D', 'C', 'D'], { v: 0.5 });
  boomChick(T1, ['G', 'C', 'G', 'D', 'C', 'D']);
  roll(T1, 'G', 8, 0.16); roll(T1 + 2 * BEAT, 'C', 8, 0.16); roll(bar(4), 'G', 8, 0.16); roll(bar(4) + 2 * BEAT, 'D', 8, 0.16); roll(bar(5), 'C', 8, 0.18); roll(bar(5) + 2 * BEAT, 'D', 8, 0.22, 0.6);
  const THEME = [
    [0, 1, 74], [1, 0.5, 71], [1.5, 0.5, 74], [2, 1, 76], [3, 0.5, 74], [3.5, 0.5, 72],
    [4, 1, 71, { bend: 1 }], [5, 0.5, 69], [5.5, 0.5, 67], [6, 1.5, 69], [7.5, 0.5, 74],
    [8, 1, 76], [9, 0.5, 74], [9.5, 0.5, 72], [10, 1, 71], [11, 0.5, 69], [11.5, 0.5, 71],
  ];
  kline('harmonica', T1, THEME, { v: 0.62 });
  for (const [b, d, m] of THEME) fiddle(T1 + b * BEAT, m - 12, d * BEAT, { v: 0.14, slide: -30 });
  riser(bar(5) + 2 * BEAT, 2 * BEAT, 0.1);
  fill(bar(5) + 3 * BEAT, 4, 0.35, 0.85);
  // 15: the gate: on G till the RV hits it
  const G0 = cutAt('gate', 15);
  crash(G0, 0.6, 2); kick(G0, 0.9); snare(G0 + BEAT, 0.75); kick(G0 + 2 * BEAT, 0.8);
  for (let i = 0; i < 4; i++) hat(G0 + i * E8, 0.22);
  strum(G0, 'G', { v: 0.55 }); strum(G0 + E8, 'G', { down: false, v: 0.3 }); strum(G0 + BEAT, 'G', { v: 0.5 });
  bass(G0, 31); bass(G0 + BEAT, 38);
  roll(G0, 'G', 6, 0.2);
  twang(G0, 67, { v: 0.55 }); twang(G0, 71, { v: 0.45, keep: true });

  // 17.5: the Grumphorn asleep: a tiptoe on the bass
  [52, 53, 54, 55, 56].forEach((m, i) => { K.pizz(bar(7) + i * E8, m, 0.75, 0.12); bass(bar(7) + i * E8, m - 12, { v: 0.35, len: 0.08 }); });
  K.jawharp(bar(7) + 2.75 * BEAT, 40, 0.7, 0.4);
  // 19: its bellow: the riff (on its own bar from the bellow), a stab when Steve goes up
  const C0 = cue('bellow');
  K.whip(C0 - 0.14, 0.9); crash(C0, 0.55, 2); gallop(C0, 6); wriff(C0, RIFF); wriff(C0 + BAR, RIFF.slice(0, 4)); saw(C0 + 2 * BEAT, 4);
  twang(C0, 76, { v: 0.5, bend: -200, bendT: 0.15, len: 1.0 });
  K.timp(KNOCK, 40, 0.9); K.strings(KNOCK, 52, 0.7, 0.5); K.strings(KNOCK, 55, 0.6, 0.5); crash(KNOCK, 0.55, 1.8); kick(KNOCK, 1);
  // 21.5: knocked out: the band under water, a ringing in the ears
  koF.frequency.setValueAtTime(20000, KO); koF.frequency.exponentialRampToValueAtTime(360, KO + 0.06);
  koF.frequency.setValueAtTime(360, cutAt('ringtail', 22.5) - 0.08); koF.frequency.exponentialRampToValueAtTime(20000, 22.5);
  { const o = ctx.createOscillator(); o.frequency.value = 3300; const g = ctx.createGain(); g.gain.setValueAtTime(0, KO); g.gain.linearRampToValueAtTime(0.02, KO + 0.05); g.gain.linearRampToValueAtTime(0, 22.45); o.connect(g).connect(ctx.destination); o.start(KO); o.stop(22.5); }
  // 22.5: the ringtail (a frantic banjo) and the run-over (a stab on the thunk), into the breakdown
  gallop(bar(9), 8); crash(bar(9), 0.5, 1.8);
  wriff(bar(9), RIFF); wriff(bar(10), RIFF2); saw(bar(10), 4, [81, 76]);
  [64, 62, 59, 55, 59, 62, 64, 67, 71, 67, 64, 62, 64, 62, 59, 55].forEach((m, i) => banjo(bar(9) + i * S16, m, 0.36));
  [64, 67, 71, 76, 71, 67, 64, 62].forEach((m, i) => banjo(bar(9) + 2 * BEAT + i * S16 * 2, m, 0.3));
  K.whip(RUNOVER - 0.14, 0.8); K.timp(RUNOVER, 38, 0.85); crash(RUNOVER, 0.55, 1.6); kick(RUNOVER, 1);
  gallop(bar(11), 2); wriff(bar(11), RIFF.slice(0, 4)); crash(bar(11), 0.5, 1.5);
  // fixed: a lick back in, into the casino
  const BACK = bar(11) + 3.5 * BEAT;
  kline('harmonica', BACK, [[0, 0.25, 74], [0.25, 0.25, 76], [0.5, 0.5, 79, { bend: 1 }]], { v: 0.65 });
  snare(BACK + 0.5 * BEAT, 0.5);

  // 30: the casino: the theme as a rag on a saloon piano (stride: a bass note, then the chord), brushes
  const L0 = cutAt('neon', 30);
  const RAG = [['G', 43, [55, 59, 62]], ['G', 38, [55, 59, 62]], ['C', 36, [55, 60, 64]], ['C', 43, [55, 60, 64]], ['G', 43, [55, 59, 62]], ['D', 38, [54, 57, 62]], ['G', 43, [55, 59, 62]]];
  RAG.forEach(([, b, ch], i) => {
    const t = L0 + i * BEAT;
    K.piano(t, b, 0.75, E8 * 0.9); K.piano(t, b + 12, 0.45, E8 * 0.9);
    for (const n of ch) K.piano(t + E8, n, 0.5, E8 * 0.8);
    brush(t, 0.3, 0.12); brush(t + E8, 0.18, 0.08);
    bass(t, b - 12 + (b < 40 ? 12 : 0), { v: 0.55, len: BEAT * 0.85 });
  });
  // the right hand: the theme, ragged (a grace note into the long ones, the octave on top)
  [[0, 1, 74], [1, 0.5, 71], [1.5, 0.5, 74], [2, 1, 76], [3, 0.5, 74], [3.5, 0.5, 72], [4, 1, 71], [5, 0.5, 69], [5.5, 0.5, 67], [6, 1, 71]]
    .forEach(([b, d, m]) => { const t = L0 + b * BEAT; if (d >= 1) K.piano(t - 0.06, m - 1, 0.35, 0.06); K.piano(t, m, 0.6, d * BEAT * 0.9); K.piano(t, m + 12, 0.32, d * BEAT * 0.9); });

  // 35: a minute to midnight: a clock, a heartbeat, a drone, a rising cluster; 38.77: REPO'D, the boom
  const M0 = cutAt('hud.png', 35), HIT = REPOD;
  for (let t = M0, k = 0; t < HIT - 0.01; t += E8, k++) wood(t, k % 2 ? 1550 : 2050, 0.3 + 0.25 * (t - M0) / (HIT - M0));
  for (let t = M0, k = 0; t < HIT - 0.05; t += BEAT, k++) { const v = 0.35 + 0.4 * (t - M0) / (HIT - M0); tone(B.kick, t, 'sine', 70, 42, v, 0.22); tone(B.kick, t + 0.17, 'sine', 64, 40, v * 0.6, 0.2); }
  { const g = ctx.createGain(); g.gain.setValueAtTime(0, M0); g.gain.linearRampToValueAtTime(0.28, HIT); g.gain.linearRampToValueAtTime(0, HIT + 0.02); const lp = filt('lowpass', 240, 0.8);
    for (const m of [28, 35, 40]) for (const dt of [-6, 5]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = dt; o.connect(lp); o.start(M0); o.stop(HIT + 0.05); }
    lp.connect(g).connect(B.fx); }
  strings(M0, [52, 53], 2 * BEAT, 0.04, 0.06); strings(M0 + 2 * BEAT, [53, 54], 2 * BEAT, 0.06, 0.09);
  strings(M0 + 4 * BEAT, [54, 55, 66], BEAT, 0.09, 0.12); strings(M0 + 5 * BEAT, [55, 56, 67, 68], HIT - (M0 + 5 * BEAT), 0.12, 0.22);
  // the church bell striking (the last one is the boom), a choir rising under it
  for (const k of [0, 1, 2]) K.bell(M0 + k * 2 * BEAT, 45, 0.55 + 0.1 * k, 2.6);
  K.choir(M0, 52, 0.45, 2 * BEAT, { vowel: 'o' }); K.choir(M0 + 2 * BEAT, 53, 0.5, 2 * BEAT, { vowel: 'o' });
  K.choir(M0 + 4 * BEAT, 55, 0.55, HIT - (M0 + 4 * BEAT)); K.choir(M0 + 4 * BEAT, 58, 0.45, HIT - (M0 + 4 * BEAT));
  riser(M0 + 4 * BEAT, HIT - (M0 + 4 * BEAT), 0.2);
  for (let t = HIT - 0.625, i = 0; t < HIT - 0.01; t += S16 / 2, i++) snare(t, 0.1 + 0.45 * i / 8);
  boom(HIT, 0.95); K.whip(HIT - 0.14, 0.9); K.bell(HIT, 40, 0.9, 3.5); K.timp(HIT, 40, 1); brass(HIT, [40, 46, 52], 1.3, 0.3); crash(HIT, 0.75, 3); tom(HIT, 60, 0.9);

  // 40: again: one strum, a pick-up; 41.27: five days (G D Em C D E7), the fiddle on the tune
  const A0 = cutAt('campfire', 40, 1);
  strum(A0 + 0.02, 'G', { v: 0.45, spread: 0.02 });
  fill(A0 + BEAT, 2, 0.4, 0.55); fill(A0 + 1.5 * BEAT, 2, 0.6, 0.8);
  const F0 = cutAt('chase1', 41.25);
  trainBeat(F0, 10, 1.15); for (let i = 0; i < 10; i++) kick(F0 + i * BEAT, 0.55);
  for (let h = 0; h < 5; h++) crash(F0 + h * 2 * BEAT, h ? 0.4 : 0.55, 1.6);
  // each day its colour: the snow's whistle, the badlands' steel, the desert's castanets and tremolo twang
  K.whistle(F0 + 4 * BEAT, 83, 0.35, 1.6 * BEAT);
  K.steel(F0 + 6 * BEAT, 64, 0.45, 1.6 * BEAT, { from: 60 });
  for (const x of [0, 0.5, 0.75, 1, 1.5]) K.castanets(F0 + 8 * BEAT + x * BEAT, 0.5);
  strums(F0, ['G', 'D', 'Em', 'C'], { v: 0.52 });
  strum(F0 + 8 * BEAT, 'D', { v: 0.52 }); strum(F0 + 8.5 * BEAT, 'D', { down: false, v: 0.3 });
  strum(F0 + 9 * BEAT, 'E7', { v: 0.52 }); strum(F0 + 9.5 * BEAT, 'E7', { down: false, v: 0.3 });
  boomChick(F0, ['G', 'D', 'Em', 'C']); bass(F0 + 8 * BEAT, 38); bass(F0 + 9 * BEAT, 28); bass(F0 + 9.5 * BEAT, 32, { len: E8 * 0.85 });
  roll(F0, 'G', 8, 0.2); roll(F0 + 2 * BEAT, 'D', 8, 0.2); roll(F0 + 4 * BEAT, 'Em', 8, 0.2); roll(F0 + 6 * BEAT, 'C', 8, 0.2); roll(F0 + 8 * BEAT, 'D', 4, 0.22); roll(F0 + 9 * BEAT, 'E7', 4, 0.25);
  const DAYS = [
    [0, 1, 74], [1, 0.5, 71], [1.5, 0.5, 74], [2, 1, 76], [3, 0.5, 74], [3.5, 0.5, 69],
    [4, 1, 71, { bend: 1 }], [5, 0.5, 76], [5.5, 0.5, 79], [6, 1, 76], [7, 0.5, 74], [7.5, 0.5, 72],
    [8, 0.5, 74], [8.5, 0.5, 76], [9, 0.5, 78], [9.5, 0.5, 80],
  ];
  kline('harmonica', F0, DAYS, { v: 0.62 });
  for (const [b, d, m] of DAYS) fiddle(F0 + b * BEAT, m, d * BEAT, { v: 0.2, slide: -30 });
  riser(F0 + 8 * BEAT, 2 * BEAT, 0.12); fill(F0 + 9 * BEAT, 4, 0.4, 0.9, true);

  // 47.5: up a step: the payoff in A (A | D E | A), the arrival on 50, a roll to the title
  const P0 = cutAt('payoff', 47.5);
  trainBeat(P0, 4, 1.2); for (let i = 0; i < 4; i++) kick(P0 + i * BEAT, 0.6); crash(P0, 0.7, 2);
  K.choir(P0, 57, 0.45, 4 * BEAT); K.choir(P0, 64, 0.4, 4 * BEAT);
  strums(P0, ['A', null], { v: 0.55 }); strum(P0 + 2 * BEAT, 'D', { v: 0.55 }); strum(P0 + 2.5 * BEAT, 'D', { down: false, v: 0.3 }); strum(P0 + 3 * BEAT, 'E', { v: 0.55 }); strum(P0 + 3.5 * BEAT, 'E', { down: false, v: 0.3 });
  bass(P0, 33); bass(P0 + BEAT, 40); bass(P0 + 2 * BEAT, 38); bass(P0 + 3 * BEAT, 28);
  roll(P0, 'A', 8, 0.24); roll(P0 + 2 * BEAT, 'D', 4, 0.24); roll(P0 + 3 * BEAT, 'E', 4, 0.26);
  const PAY = [[0, 1, 81], [1, 0.5, 76], [1.5, 0.5, 73], [2, 1, 78], [3, 0.5, 80], [3.5, 0.5, 83]];
  kline('harmonica', P0, PAY.map(([b, d, m]) => [b, d, m - 12]), { v: 0.6 });
  kline('whistle', P0, PAY, { v: 0.45 });
  for (const [b, d, m] of PAY) fiddle(P0 + b * BEAT, m - 12, d * BEAT, { v: 0.22, slide: -30 });
  const O0 = OWNED;
  stab(O0, 'A', { v: 0.62, cym: 0.65 }); K.timp(O0, 45, 0.8); K.whistle(O0, 81, 0.5, 2 * BEAT - 0.05); fiddle(O0, 76, 2 * BEAT, { v: 0.26 });
  bass(O0, 33, { len: 2 * BEAT });
  fill(O0 + BEAT, 4, 0.3, 0.85, true);
  // 51.27: the title: the last chord, left to ring
  const E0 = cutAt('title.png', 51.25);
  stab(E0, 'A6', { v: 0.7, cym: 0.75 }); tom(E0, 70, 0.8);
  for (const [k, m] of [69, 73, 78].entries()) twang(E0 + k * 0.03, m, { v: 0.5, keep: true });
  fiddle(E0, 76, 3.2, { v: 0.2 });
  K.whistle(E0 + 0.08, 81, 0.5, 3.0, { from: 76 }); K.choir(E0, 57, 0.4, 3.3); K.choir(E0, 64, 0.35, 3.3); K.choir(E0, 69, 0.3, 3.3);
  [57, 61, 64, 69, 73, 76, 81].forEach((m, i) => banjo(E0 + 0.04 + i * S16 * 0.5, m, 0.26));
  bass(E0, 33, { len: 1.6 });

  // 57.5: the button: after the horns, a lick and the last chord
  const W0 = cutAt('title.png', 57.5, 1) + 1.5 * BEAT;
  kline('harmonica', W0, [[0, 0.25, 76], [0.25, 0.25, 78]], { v: 0.6 });
  const W1 = W0 + 0.5 * BEAT;
  kick(W1, 0.9); crash(W1, 0.45, 1.4); strum(W1, 'A6', { v: 0.6, spread: 0.014 }); bass(W1, 33, { len: 1.2 });
  for (const [k, m] of [69, 73, 78].entries()) twang(W1 + k * 0.02, m, { v: 0.45, keep: true });
  [69, 73, 76, 81].forEach((m, i) => banjo(W1 + 0.03 + i * S16 * 0.5, m, 0.22));

  const buf = await ctx.startRendering();
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];

  // ---- the gags, on the rendered tape ---------------------------------------------------------------------
  const idx = t => Math.max(0, Math.min(ch[0].length, Math.round(t * sr)));
  function silence(a, b, fade = 0.012) {
    const i0 = idx(a), i1 = idx(b), f = Math.round(fade * sr);
    for (const d of ch) {
      for (let i = Math.max(0, i0 - f); i < i0; i++) d[i] *= (i0 - i) / f;
      d.fill(0, i0, i1);
      for (let i = i1; i < Math.min(d.length, i1 + f); i++) d[i] *= (i - i1) / f;
    }
  }
  // the tape slowing to a stop over D seconds from a (the record winding down), then nothing till b
  function tapeStop(a, D, b) {
    const i0 = idx(a), n = Math.round(D * sr);
    for (const d of ch) {
      const src = d.slice(i0, i0 + n);
      for (let i = 0; i < n; i++) {
        const tau = i / sr, p = (tau - tau * tau / (2 * D)) * sr, j = Math.floor(p), fr = p - j;
        const v = (src[j] ?? 0) * (1 - fr) + (src[j + 1] ?? 0) * fr;
        d[i0 + i] = v * Math.min(1, (n - i) / (0.06 * sr));
      }
    }
    silence(a + D, b, 0.004);
  }
  function fadeOut(a, b) { const i0 = idx(a), i1 = idx(b); for (const d of ch) { for (let i = i0; i < i1; i++) d[i] *= 1 - (i - i0) / (i1 - i0); d.fill(0, i1); } }
  silence(CRUNCH - 0.01, bar(7) - 0.004, 0.006);                       // the band stops dead on the crunch
  tapeStop(SPUTTER - 0.06, 0.62, BACK - 0.004);                          // the breakdown
  tapeStop(LOSE - 0.02, 0.3, M0 - 0.004);                                // NOTHING
  { const i0 = idx(cutAt('gnome', 55) - 0.8), i1 = idx(55); for (const d of ch) { for (let i = i0; i < i1; i++) d[i] *= 1 - (i - i0) / (i1 - i0); } }
  silence(55, W0 - 0.004);                                               // the stinger
  fadeOut(secs - 0.65, secs);
  return { ch, warn };
}
