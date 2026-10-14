// The score: music under the game that follows what's going on, played by the western band (western.js).
// Every biome has its own tune, written out here; layers come and go with what's happening near you:
//
//   bed, groove, lead   the biome's tune: verses of a minute or so, then a rest (the wind and the birds alone),
//                       quiet in town (the casino has its band) and in the RV when its radio is on
//   tension             a sleeping Grumphorn close by, one waking and glaring, the last hour before midnight:
//                       tremolo strings on a cluster, a heartbeat, the timpani
//   danger              a Grumphorn charging, rock coming down: a gallop, a low riff, the fiddle sawing
//   mischief            ringtails creeping in: pizzicato on tiptoe, a woodblock, the jaw harp
//   clock               the deadline: tick, tock, and a bell in the last quarter hour
//
// The stings (sting(name)) play at once, off the beat: the whip as a Grumphorn charges, a slide whistle down
// when you're knocked out, a lick when the payment's made. Everything ducks while anyone is talking.
//
//   const s = createScore(ctx, out); s.update(dt, { mode, theme, town, radio, threat, urgency, ko, voice }); s.sting('charge')
// renderTheme() (below) plays a theme offline into an OfflineAudioContext, for tests and the trailer.
import { westernKit, chord, voicing, tonesIn, bassRoot, midi as M } from './western.js';

// ---- the tunes -------------------------------------------------------------------------------
// a melody: bars split by '|', notes 'D5:1.5' (a note and its length in beats), 'r:1' a rest; in a theme with
// `degrees`, '5:2' is the scale's fifth degree (1-8 from the key's root, then 9-14 the octave above)
function parseMelody(src, key = null) {
  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  return src.split('|').map(bar => {
    const out = []; let at = 0;
    for (const tok of bar.trim().split(/\s+/).filter(Boolean)) {
      const [n, d] = tok.split(':'), dur = parseFloat(d);
      if (n !== 'r') {
        let m;
        if (key != null) { const deg = +n - 1; m = key + 12 * Math.floor(deg / 7) + SCALE[deg % 7]; }
        else m = M(n);
        out.push([at, m, dur]);
      }
      at += dur;
    }
    return out;
  });
}
// the main theme (the Westmeadow Road): the menu's and day 1's
const MAIN = `D5:1.5 B4:.5 D5:1 E5:1 | D5:1 B4:1 G4:2 | E5:1.5 D5:.5 C5:1 E5:1 | D5:3 r:1 |
  G5:1.5 E5:.5 D5:1 B4:1 | D5:1 E5:1 D5:2 | A4:1 B4:1 C5:1 A4:1 | A4:3 r:1 |
  B4:1 D5:1 G5:1.5 F#5:.5 | E5:1 D5:1 B4:2 | C5:1 E5:1 G5:1.5 E5:.5 | D5:3 r:1 |
  B4:1.5 D5:.5 G5:1 E5:1 | D5:1 C5:1 B4:1 A4:1 | G4:3 r:1 | r:4`;
const FIELDS = `A4:1 D5:.5 E5:.5 F#5:.5 E5:.5 D5:.5 B4:.5 | A4:1 F#4:.5 A4:.5 D5:2 | B4:.5 D5:.5 G5:1 F#5:.5 E5:.5 D5:1 | F#5:1 E5:.5 D5:.5 A4:2 |
  A4:.5 B4:.5 D5:.5 E5:.5 F#5:1 A5:1 | B5:.5 A5:.5 F#5:.5 E5:.5 D5:2 | E5:1 C#5:.5 E5:.5 A5:1 G5:.5 E5:.5 | C#5:1 B4:.5 C#5:.5 A4:2 |
  D5:.5 F#5:.5 A5:1 F#5:.5 A5:.5 D6:1 | B5:.5 A5:.5 F#5:1 D5:2 | G5:1 B5:.5 G5:.5 D5:1 B4:1 | G4:.5 A4:.5 B4:.5 D5:.5 G5:2 |
  F#5:1 A5:.5 F#5:.5 E5:.5 D5:.5 B4:1 | A4:1 C#5:.5 E5:.5 G5:1 E5:1 | D5:2 F#5:.5 E5:.5 D5:1 | r:4`;
const SNOW = `A4:2 D5:1 | F5:2 E5:1 | D5:2 F5:1 | E5:3 | A4:1 D5:1 F5:1 | A5:2 G5:1 | F5:1 E5:1 D5:1 | C#5:3 |
  D5:2 F5:1 | A5:2 C6:1 | G5:2 E5:1 | F5:2 D5:1 | D5:1.5 F5:.5 Bb5:1 | A5:1 G5:1 E5:1 | D5:3 | r:3`;
const BADLANDS = `E4:1.5 G4:.5 A4:2 | C5:1 B4:.5 A4:.5 G4:1 E4:1 | D4:1 G4:1 B4:1.5 A4:.5 | A4:3 r:1 |
  E5:1.5 D5:.5 C5:1 A4:1 | C5:1 D5:1 E5:2 | F5:1 E5:1 C5:1 A4:1 | B4:2 G#4:2 |
  A4:1 C5:1 E5:1.5 G5:.5 | E5:1 D5:1 C5:2 | B4:1 D5:1 G5:1.5 F5:.5 | E5:3 r:1 |
  F5:1.5 E5:.5 C5:1 A4:1 | G#4:1 B4:1 E5:2 | A4:3 r:1 | r:4`;
const DESERT = `B4:1 E5:1 G#5:1.5 F5:.5 | E5:3 r:1 | A5:1.5 G#5:.5 F5:1 E5:1 | B5:3 r:1 |
  D6:1.5 C6:.5 B5:1 A5:1 | F5:3 r:1 | G#5:1 B5:1 E6:2 | r:4 |
  C6:1.5 B5:.5 A5:2 | B5:1 A5:.5 G5:.5 D5:2 | A5:1 G5:1 F5:1 E5:1 | G#5:3 r:1 |
  F5:1 A5:1 C6:1.5 B5:.5 | B5:1 D6:1 B5:2 | A5:1.5 G5:.5 F5:1 E5:1 | E5:4`;
// the twang's answers in the whistle's rests (desert): [bar, [[beat, note, beats]]]
const DESERT_ANSWER = { 1: [[3, 'E3', 0.5], [3.5, 'F3', 0.5]], 3: [[3, 'B2', 0.33], [3.33, 'D3', 0.33], [3.66, 'E3', 0.34]], 5: [[3, 'A2', 0.5], [3.5, 'C3', 0.5]], 7: [[0, 'E3', 1], [1, 'G#3', 1], [2, 'B3', 1], [3, 'E4', 1]], 11: [[3, 'E3', 0.5], [3.5, 'G#3', 0.5]] };
// the night (any biome, after the payment): a lullaby in the biome's key, in degrees
const NIGHT = `5:2 3:1 | 1:2 3:1 | 4:2 6:1 | 5:3 | 5:1 6:1 5:1 | 3:2 1:1 | 2:2 3:1 | 2:3 |
  5:2 3:1 | 1:2 3:1 | 4:2 6:1 | 8:3 | 7:1 6:1 5:1 | 2:2 4:1 | 3:1 2:1 1:1 | 1:3`;

export const THEMES = {
  title:    { name: 'The Westmeadow Road (full band)', bpm: 112, meter: 4, swing: 0, chords: 'G G C G G G D D G G7 C C G D G G', melody: MAIN, lead: 'harmonica', lead2: 'fiddle', groove: 'boomchick', banjo: true, drums: 'train', bed: 'organ', key: 'G', gain: 0.85 },
  meadow:   { name: 'The Westmeadow Road', bpm: 92, meter: 4, swing: 0.1, chords: 'G G C G G G D D G G7 C C G D G G', melody: MAIN, lead: 'harmonica', lead2: 'steel', groove: 'travis', drums: 'brush', bed: 'organ', key: 'G' },
  fields:   { name: 'Harvest Hoedown', bpm: 116, meter: 4, swing: 0, chords: 'D D G D D D A A D D G G D A D D', melody: FIELDS, lead: 'fiddle', lead2: 'harmonica', groove: 'boomchick', banjo: true, drums: 'train', bed: 'organ', key: 'D' },
  snow:     { name: 'The High Pass', bpm: 84, meter: 3, swing: 0, chords: 'Dm Dm Bb C Dm Dm Gm A Dm F C Dm Bb C Dm Dm', melody: SNOW, lead: 'whistle', lead2: 'fiddle', groove: 'waltz', drums: 'waltz', bed: 'strings', key: 'Dm' },
  badlands: { name: 'Red Rock Lament', bpm: 80, meter: 4, swing: 0.08, chords: 'Am Am G Am Am Am F E Am C G Am F E Am Am', melody: BADLANDS, lead: 'steel', lead2: 'harmonica', groove: 'twangArp', drums: 'halftime', bed: 'drone', key: 'Am', tremolo: [5.2, 0.25] },
  desert:   { name: 'Lost Wages', bpm: 68, meter: 4, swing: 0, chords: 'E E F E Dm Dm E E Am G F E F G F E', melody: DESERT, answer: DESERT_ANSWER, lead: 'whistle', groove: 'spaghetti', drums: 'castanets', bed: 'choir', key: 'E', tremolo: [6.4, 0.75] },
  night:    { name: 'Under the Stars', bpm: 72, meter: 3, swing: 0, roman: 'I I IV I I vi ii V I I IV I ii V I I', degrees: NIGHT, lead: 'harmonica', groove: 'lullaby', drums: null, bed: 'organ', soft: true, gain: 1.6 },
};
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const NAME = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// a theme made ready to play, in a key (the night's follows the biome's)
function prepare(th, keyName = null) {
  const key = keyName || th.key || 'G', minor = /m$/.test(key), pc = PC[key.replace(/m$/, '')];
  let chords;
  if (th.roman) {
    const STEP = { I: [0, ''], ii: [2, 'm'], iii: [4, 'm'], IV: [5, ''], V: [7, ''], vi: [9, 'm'] };
    // (a minor biome's night is in its relative major: warmer)
    const home = minor ? (pc + 3) % 12 : pc;
    chords = th.roman.split(/\s+/).map(r => chord(NAME[(home + STEP[r][0]) % 12] + STEP[r][1]));
    const root = 60 + ((home - 0 + 12) % 12) - (home > 7 ? 12 : 0);
    return { ...th, key, kpc: home, minor: false, chords, mel: parseMelody(th.degrees, root) };
  }
  chords = th.chords.split(/\s+/).map(chord);
  return { ...th, key, kpc: pc, minor, chords, mel: parseMelody(th.melody), answerMel: th.answer || null };
}

// ---- the layers: each plays one beat ------------------------------------------------------------
// b: { k (the layer's kit), t (the beat's time), B (a beat in s), beat (0..meter-1), bar (0..15), pass (how many
// times round the 16 bars), th (the theme), ch (this bar's chord), lvl (the layer's level), rnd }
const sw = (b, x) => b.t + x * b.B + ((x % 1) >= 0.49 && (x % 1) <= 0.51 ? b.th.swing * b.B : 0);
const LAYERS = {
  bed(b) {
    if (b.beat !== 0) return;
    const { k, th, ch } = b, r = bassRoot(ch), dur = b.B * th.meter;
    const third = ch.tones[1], fifth = ch.tones[2];
    if (th.bed === 'organ') for (const n of [r + 12, r + 12 + third, r + 12 + fifth]) k.organ(b.t, n, th.soft ? 0.35 : 0.5, dur);
    if (th.bed === 'strings') for (const n of [r + 24, r + 24 + fifth]) k.strings(b.t, n, 0.32, dur);
    if (th.bed === 'drone') { k.organ(b.t, r, 0.45, dur); k.organ(b.t, r + 7, 0.3, dur); if (b.bar % 4 === 0) k.strings(b.t, r + 24, 0.18, dur * 4); }
    if (th.bed === 'choir') { if (b.bar % 2 === 0) { k.choir(b.t, r + 12, 0.55, dur * 2); k.choir(b.t, r + 19, 0.4, dur * 2); } }
  },
  groove(b) {
    const { k, th, ch, beat, B } = b, r = bassRoot(ch), v = voicing(ch), up = r - 12;
    if (th.groove === 'travis') {
      // the thumb alternating the bass, the fingers on the off-beats, a pinch on one
      const thumb = [r, r + ch.tones[2], r + 12, r + ch.tones[2]][beat];
      // (the strings ring on over each other, as they do)
      k.guitar(sw(b, beat), thumb, 0.5, B * 1.9);
      if (beat === 0) k.guitar(sw(b, beat), v[v.length - 1], 0.42, B * 2.5);
      k.guitar(sw(b, beat + 0.5), v[3 + ((b.bar + beat) % Math.max(1, v.length - 3))], 0.36, B * 1.6);
      if (beat === 0 || beat === 2) k.bass(b.t, beat === 0 ? up : up + ch.tones[2], 0.5, B * 1.8);
    }
    if (th.groove === 'boomchick') {
      if (beat === 0 || beat === 2) k.bass(b.t, beat === 0 ? up : up + ch.tones[2] - 12 + (ch.tones[2] - 12 < -5 ? 12 : 0), 0.65, B * 0.85);
      if (beat === 1 || beat === 3) k.strum(sw(b, beat), v.slice(-4), { vel: 0.42, dur: B * 0.4, mute: true, spread: 0.008 });
      if (beat === 0) k.guitar(b.t, r, 0.4, B * 0.8);
      if (th.banjo) {
        // the forward roll: 3rd, 2nd, 1st string, the drone, 2nd, 1st, 3rd, 1st
        // (the short fifth string rings the key's root, high: G4 in G, D5 in D)
        const top = tonesIn(ch, 55, 74).slice(-3), drone = 65 + ((th.kpc - 5 + 12) % 12);
        const [s3, s2, s1] = top.length === 3 ? top : [top[0], top[0], top[0]];
        const roll = [s3, s2, s1, drone, s2, s1, s3, s1];
        for (const h of [0, 0.5]) k.banjo(b.t + h * B, roll[beat * 2 + h * 2], 0.55 + (h ? 0 : 0.1), B * 0.7);
      }
    }
    if (th.groove === 'waltz') {
      // oom-pah-pah: the bass alternating root and fifth by bar, the chord on two and three
      if (beat === 0) { k.bass(b.t, b.bar % 2 ? up + 7 : up, 0.55, B * 0.95); k.guitar(b.t, b.bar % 2 ? r + 7 : r, 0.35, B); }
      else k.strum(b.t, v.slice(-4), { vel: 0.3, dur: B * 0.7, spread: 0.01 });
    }
    if (th.groove === 'lullaby') {
      if (beat === 0) { k.guitar(b.t, r, 0.38, B * 2.6); k.bass(b.t, up, 0.3, B * 2.5); }
      else k.guitar(b.t, v[2 + beat + (b.bar % 2)] ?? v[v.length - 1], 0.26, B * 1.8);
    }
    if (th.groove === 'twangArp') {
      // the baritone: an arpeggio in eighths, palm-muted but for the one and the and-of-three
      const pat = [r, r + 7, r + 12, r + 12 + ch.tones[1], r + 12, r + 7, r + 12, r + 7];
      for (const h of [0, 0.5]) { const i = beat * 2 + h * 2, open = i === 0 || i === 5; k.twang(sw(b, beat + h), pat[i], open ? 0.55 : 0.4, open ? B * 1.4 : B * 0.4, { mute: !open }); }
      if (beat === 0) k.bass(b.t, up, 0.6, B * 1.4);
      if (beat === 2) k.bass(b.t + B * 0.5, up + 7, 0.5, B);
    }
    if (th.groove === 'spaghetti') {
      // the twang's low note left ringing on the tremolo; a flamenco flourish on the nylon at the top of a phrase
      if (beat === 0) { k.twang(b.t, r, 0.6, B * 2); k.bass(b.t, up, 0.55, B * 1.8); if (b.bar % 4 === 0) k.rasgueado(b.t, voicing(ch), { vel: 0.5 }); else k.strum(b.t, voicing(ch), { vel: 0.35, inst: 'nylon', dur: B * 1.5 }); }
      if (beat === 2) { k.twang(b.t, r + 7, 0.45, B * 1.5); k.bass(b.t, up + 7, 0.45, B); }
    }
    // the drums
    const d = th.drums;
    if (d === 'brush') { if (beat % 2) k.snare(b.t, 0.4, { brush: true }); else k.kick(b.t, 0.35); k.shaker(sw(b, beat + 0.5), 0.4); }
    if (d === 'train') {
      // the train beat: sixteenths on the snare, the backbeat leaned on, the kick on one and three
      for (let q = 0; q < 4; q++) k.snare(b.t + q * B / 4, (q === 0 && beat % 2 ? 0.55 : q === 2 ? 0.28 : 0.16), { brush: true });
      if (beat % 2 === 0) k.kick(b.t, 0.55);
    }
    if (d === 'waltz') { if (beat === 0) k.kick(b.t, 0.3); else k.snare(b.t, 0.22, { brush: true }); }
    if (d === 'halftime') {
      if (beat === 0) k.kick(b.t, 0.55); if (beat === 2) k.rim(b.t, 0.5);
      k.shaker(sw(b, beat + 0.5), 0.3);
      if (b.bar % 4 === 3 && beat === 3) [0, 0.25, 0.5, 0.75].forEach((x, i) => k.tom(b.t + x * B, 45 - i * 3, 0.45));
    }
    if (d === 'castanets') {
      if (beat === 0) k.tom(b.t, 38, 0.35);
      if (beat === 2) for (const x of [0.5, 1, 1.25, 1.5]) k.castanets(b.t + x * B, x === 1 ? 0.55 : 0.4);
    }
  },
  lead(b) {
    const { k, th, beat } = b, notes = (th.mel[b.bar] || []).filter(([at]) => at >= beat && at < beat + 1);
    const second = b.bar >= 8 && th.lead2 && b.pass % 2 === 1;
    const inst = second ? th.lead2 : th.lead;
    for (const [at, m, dur] of notes) {
      const t = sw(b, at), d = dur * b.B * 0.96, prev = b.prev;
      // (a glide into the note from the last one, when it's near: the steel, the whistle and the fiddle slide)
      const from = prev != null && Math.abs(prev - m) <= 4 && prev !== m ? prev : null;
      const vel = th.soft ? 0.42 : 0.6;
      if (inst === 'harmonica') k.harmonica(t, m, vel, d, { bend: dur >= 1.5 ? 1 : 0 });
      if (inst === 'fiddle') k.fiddle(t, m, vel, d, { from, slide: from == null && dur >= 1 });
      if (inst === 'whistle') k.whistle(t, m, vel, d, { from });
      if (inst === 'steel') k.steel(t, m, vel, d, { from });
      b.prev = m;
    }
    // the answers (in the lead's rests)
    const ans = th.answerMel?.[b.bar];
    if (ans) for (const [at, n, beats] of ans) if (at >= beat && at < beat + 1) k.twang(b.t + (at - beat) * b.B, M(n), 0.55, beats * b.B * 1.4, { bend: beats >= 1 ? 1 : 0 });
  },
  // a sleeping beast close by, a waking one: a cluster bowed in tremolo, a heartbeat, the timpani
  tension(b) {
    const { k, th, beat, B, lvl } = b, kr = 40 + ((th.kpc - 4 + 12) % 12);
    if (beat === 0) {
      k.strings(b.t, kr, 0.35 + 0.4 * lvl, B * th.meter, { trem: 10 });
      k.strings(b.t, kr + 1, 0.25 + 0.35 * lvl, B * th.meter, { trem: 10 });
      if (b.bar % 2 === 0) k.timp(b.t, kr, 0.35 + 0.3 * lvl);
      if (lvl > 0.6 && b.bar % 4 === 0) k.strings(b.t, kr + 30, 0.25, B * th.meter * 4);
    }
    // lub-dub
    if (beat === 0 || (th.meter === 4 && beat === 2)) { k.kick(b.t, 0.38); k.kick(b.t + 0.22, 0.24); }
    if (lvl > 0.5) for (const h of [0, 0.5]) k.pizz(b.t + h * B, kr + 12 + ((beat * 2 + h * 2) % 2), 0.35);
  },
  // a charge, a rockfall: the gallop, a low riff, stabs, the fiddle sawing away
  danger(b) {
    const { k, th, beat, B, lvl } = b, kr = 40 + ((th.kpc - 4 + 12) % 12);
    k.kick(b.t, 0.7);
    k.snare(b.t + B * 0.5, 0.32); k.snare(b.t + B * 0.75, 0.38);
    if (beat % 2 === 1) k.snare(b.t, 0.6);
    const riff = th.meter === 3 ? [0, 0, 3, 0, 5, 6] : [0, 0, 3, 0, 5, 6, 7, 3];
    for (const h of [0, 0.5]) { const i = beat * 2 + h * 2; k.twang(b.t + h * B, kr + riff[i % riff.length], i === 0 ? 0.7 : 0.55, i === 0 ? B : B * 0.45, { mute: i !== 0 }); }
    if (beat === 0) {
      k.strum(b.t, voicing(chord(NAME[th.kpc] + 'm')), { vel: 0.6, dur: B * 0.5 });
      k.strings(b.t, kr + 12, 0.5, B * 0.5); k.strings(b.t, kr + 15, 0.45, B * 0.5);
    }
    if (lvl > 0.55) for (let q = 0; q < 4; q++) k.fiddle(b.t + q * B / 4, kr + 24 + (q % 2 ? 7 : 0), 0.5, B / 4 * 0.9, { slide: false, vib: 0 });
    if (b.bar % 4 === 3 && beat === th.meter - 1) [0, 0.25, 0.5, 0.75].forEach((x, i) => k.tom(b.t + x * B, 47 - i * 4, 0.6));
  },
  // ringtails about: tiptoeing pizzicato, a woodblock, the jaw harp now and then
  mischief(b) {
    const { k, th, beat, B } = b, kr = 52 + ((th.kpc - 4 + 12) % 12);
    const pat = th.meter === 3 ? [0, null, 3, 2, 0, -1] : [0, null, 3, 2, 0, null, -1, 0];
    for (const h of [0, 0.5]) { const n = pat[(beat * 2 + h * 2) % pat.length]; if (n != null) k.pizz(b.t + h * B, kr + n, 0.85, B * 0.3); }
    if (beat % 2 === 1) k.block(b.t + B * 0.5, 0.6, (b.bar + beat) % 4 === 1);
    if (b.bar % 2 === 1 && beat === th.meter - 1) k.jawharp(b.t, kr - 12, 0.8, B * 0.9);
  },
  // the deadline: tick, tock; the bell in the last quarter hour
  clock(b) {
    const { k, th, beat, lvl } = b;
    k.block(b.t, 0.55 + 0.3 * lvl, beat % 2 === 0);
    if (lvl > 0.85 && beat === 0 && b.bar % 2 === 0) k.bell(b.t, 45 + ((th.kpc - 9 + 12) % 12), 0.5);
  },
};
const ORDER = ['bed', 'groove', 'lead', 'tension', 'danger', 'mischief', 'clock'];
// the mix: each layer's gain at full
const MIX = { bed: 0.55, groove: 0.8, lead: 0.85, tension: 0.8, danger: 0.7, mischief: 1.4, clock: 1.5 };

// the score's way out: a glue compressor and a limiter (the game, the tests and the demos hear the same)
function outChain(ctx, out) {
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20; glue.knee.value = 8; glue.ratio.value = 2.5; glue.attack.value = 0.01; glue.release.value = 0.25;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
  const trim = ctx.createGain(); trim.gain.value = 1;
  // (and under the game: the music sits below the sounds and the voices; the Music slider does the rest)
  const level = ctx.createGain(); level.gain.value = 0.55;
  trim.connect(glue).connect(lim).connect(level).connect(out);
  return trim;
}

// ---- the player ------------------------------------------------------------------------------
export function createScore(ctx, out, { seed = 1 } = {}) {
  const master = ctx.createGain(); master.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.8;
  const trim = outChain(ctx, out);
  master.connect(lp).connect(trim);
  const gains = {}, kits = {};
  let first = null;
  for (const name of [...ORDER, 'sting']) {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(master); gains[name] = g;
    kits[name] = first ? westernKit(ctx, g, { shared: first }) : (first = westernKit(ctx, g, { verbOut: master }));
  }
  gains.sting.gain.value = 1;
  // the twang's tremolo follows the theme (a kit's is set when it's made: one per theme, made as needed)
  const twangKits = new Map();
  const kitFor = (layer, th) => {
    if (layer !== 'groove' && layer !== 'lead' && layer !== 'danger') return kits[layer];
    if (!th.tremolo) return kits[layer];
    const key = `${layer}|${th.tremolo}`;
    if (!twangKits.has(key)) twangKits.set(key, westernKit(ctx, gains[layer], { shared: first, tremolo: th.tremolo }));
    return twangKits.get(key);
  };
  const lvl = Object.fromEntries(ORDER.map(n => [n, 0]));     // each layer's level now (0..1)
  const want = Object.fromEntries(ORDER.map(n => [n, 0]));
  let th = null, thName = null, pending = null, nextT = 0, beat = 0, bar = 0, pass = 0, on = false, timer = null;
  const prev = { lead: null };
  // verses and rests (the biome's tune only): bars of verse left; while resting, the seconds left of it (null:
  // not resting); a new verse starts from the top at the next bar line
  let verse = 0, rest = null, again = false, mode = 'off';
  const rnd = (() => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; })();

  function setTheme(name, key) {
    const nm = THEMES[name] ? name : 'meadow', id = `${nm}|${key || ''}`;
    if (id === thName) { pending = null; return; }
    if (id === pending?.id) return;
    pending = { name: nm, key, id };
    if (!th) startPending(ctx.currentTime + 0.05);
  }
  function startPending(t) {
    th = prepare(THEMES[pending.name], pending.key); thName = pending.id; pending = null;
    trim.gain.setTargetAtTime(th.gain ?? 1, t, 0.3);
    beat = 0; bar = 0; pass = 0; nextT = t; prev.lead = null;
    verse = 32; rest = null; again = false;   // (a new place: its tune at once)
  }
  // one beat's notes, every layer; returns when the next beat falls
  function scheduleBeat(t) {
    const B = 60 / th.bpm;
    if (beat === 0 && again) { again = false; bar = 0; pass = 0; verse = 32; prev.lead = null; }
    for (const name of ORDER) {
      if (lvl[name] < 0.01 && want[name] < 0.01) continue;
      if ((name === 'bed' || name === 'groove' || name === 'lead') && verse <= 0 && mode !== 'menu') continue;
      const b = { k: kitFor(name, th), t, B, beat, bar, pass, th, ch: th.chords[bar % th.chords.length], lvl: Math.max(lvl[name], want[name]), rnd, prev: name === 'lead' ? prev.lead : null };
      LAYERS[name](b);
      if (name === 'lead') prev.lead = b.prev;
    }
    beat++;
    if (beat >= th.meter) {
      beat = 0; bar++;
      if (verse > 0) verse--;
      if (bar >= 16) { bar = 0; pass++; }
      if (pending) startPending(t + B);     // (a new theme starts on the bar line)
    }
    return t + B;
  }
  function tick() {
    if (!on || !th) return;
    const now = ctx.currentTime;
    if (nextT < now) nextT = now + 0.05;    // (the page was asleep: start again from now)
    while (nextT < now + 0.3) nextT = scheduleBeat(nextT);
  }
  // (a gain is only touched when it has moved: update() runs every frame)
  const last = new Map();
  const set = (g, v, tau) => { const o = last.get(g); if (o != null && Math.abs(o - v) < 0.003) return; last.set(g, v); g.gain.setTargetAtTime(v, ctx.currentTime, tau); };
  return {
    output: master,
    get theme() { return thName; },
    get levels() { return { ...lvl }; },
    start() { if (on) return; on = true; last.delete(master); master.gain.setTargetAtTime(1, ctx.currentTime, 0.6); timer ||= setInterval(tick, 50); tick(); },
    stop() { if (!on) return; on = false; last.delete(master); master.gain.setTargetAtTime(0, ctx.currentTime, 0.5); clearInterval(timer); timer = null; th = null; thName = null; pending = null; },
    // what's going on, every frame:
    //   mode 'menu' (the full band, no rests) | 'play' | 'off'
    //   theme: the biome ('meadow'...) or 'night'; key: the biome's key, for the night's lullaby
    //   town, radio: 0..1 (how much the town or the RV's radio has the floor); urgency 0..1 (the deadline)
    //   threat: { sleep, alert, charge, thieves, rumble } 0..1; ko, voice: booleans
    update(dt, s) {
      mode = s.mode;
      if (mode === 'off') { this.stop(); return; }
      this.start();
      setTheme(s.theme, s.key);
      const T = s.threat || {}, urg = s.urgency || 0;
      // verses and rests: a verse is two times round the tune (about a minute), a rest 25-60 s
      if (mode === 'play' && verse <= 0 && !again) {
        if (rest == null) rest = 25 + rnd() * 35;
        rest -= dt;
        if (rest <= 0) { rest = null; again = true; }
      }
      const tension = Math.max(0.35 * (T.sleep || 0), 0.9 * (T.alert || 0), urg > 0.75 ? (urg - 0.75) * 3 : 0);
      const danger = Math.max(T.charge || 0, T.rumble ? 0.7 : 0);
      const calm = (mode === 'menu' ? 1 : 1 - Math.max(s.town || 0, s.radio || 0)) * (1 - Math.max(danger, 0.75 * tension)) * (1 - 0.5 * urg);
      want.bed = calm; want.groove = calm; want.lead = calm;
      want.tension = mode === 'menu' ? 0 : tension;
      want.danger = mode === 'menu' ? 0 : danger;
      want.mischief = mode === 'menu' ? 0 : (T.thieves || 0) * (1 - danger);
      want.clock = mode === 'menu' ? 0 : urg > 0.05 ? 0.4 + 0.6 * urg : 0;
      const resting = mode === 'play' && verse <= 0 && !again;
      for (const n of ORDER) {
        const calmLayer = n === 'bed' || n === 'groove' || n === 'lead';
        const target = calmLayer && resting ? 0 : want[n];
        // (danger comes in at once and lingers; the rest ease)
        const up = n === 'danger' ? 0.08 : n === 'tension' ? 0.6 : n === 'mischief' ? 0.4 : 1.2;
        const down = n === 'danger' ? 3 : n === 'tension' ? 4 : n === 'mischief' ? 3 : danger > 0.5 ? 0.2 : 2;   // (the tune gets out of a charge's way)
        const tau = target > lvl[n] ? up : down;
        lvl[n] += (target - lvl[n]) * (1 - Math.exp(-dt / tau));
        set(gains[n], lvl[n] * MIX[n], 0.05);
      }
      // ducked under voices; knocked out: under water
      set(master, on ? (s.voice ? 0.5 : 1) * (s.ko ? 0.55 : 1) : 0, s.voice ? 0.12 : 0.8);
      if (lp.ko !== !!s.ko) { lp.ko = !!s.ko; lp.frequency.setTargetAtTime(s.ko ? 480 : 20000, ctx.currentTime, 0.25); }
    },
    // a one-shot, at once
    sting(name) { if (on) playSting(kits.sting, name, ctx.currentTime + 0.02, th); },
  };
}

// the stings: one-shots in the theme's key, at t
export function playSting(k, name, t, th) {
  const kpc = th?.kpc ?? 7, kr = 40 + ((kpc - 4 + 12) % 12);
  if (name === 'charge') { k.whip(t, 0.9); k.timp(t + 0.14, kr, 0.9); k.cymbal(t + 0.14, 0.5); }
  if (name === 'wake') { k.strings(t, kr + 12, 0.6, 1.4, { swell: true }); k.strings(t, kr + 13, 0.5, 1.4, { swell: true }); k.roll(t + 0.3, kr, 1.1, 0.1, 0.6); }
  if (name === 'steal') { [0, 2, 3, 5, 7, 8].forEach((n, i) => k.pizz(t + i * 0.07, kr + 24 - n, 0.5)); k.jawharp(t + 0.45, kr, 0.6, 0.5); }
  if (name === 'ko') { k.slideWhistle(t, 1500, 260, 0.9, 0.6); k.timp(t + 0.85, kr - 2, 0.6); }
  if (name === 'rumble') k.roll(t, kr - 2, 1.4, 0.2, 0.9);
  if (name === 'paid') {
    const c = chord(NAME[kpc] + (th?.minor ? 'm' : '')), r = bassRoot(c);
    k.strum(t, voicing(chord(NAME[(kpc + 7) % 12])), { vel: 0.5, dur: 0.4 });
    k.strum(t + 0.45, voicing(c), { vel: 0.6, dur: 2.2 });
    [0, 4, 7, 12].forEach((n, i) => k.harmonica(t + 0.45 + i * 0.12, r + 24 + n - (c.minor && n === 4 ? 1 : 0), 0.55, i === 3 ? 1.2 : 0.14));
    k.cymbal(t + 0.45, 0.25);
  }
}

// a theme played offline, from its first bar, into an OfflineAudioContext (the class: OAC): for the tests and
// the demos. layers: { name: level } or (t) => { name: level } (sampled each beat); stings: [[t, name]]
export async function renderTheme(OAC, { theme = 'meadow', key = null, secs = 20, layers = { bed: 1, groove: 1, lead: 1 }, sr = 44100, stings = [] } = {}) {
  const ctx = new OAC(2, Math.ceil(sr * secs), sr);
  const th = prepare(THEMES[theme], key), B = 60 / th.bpm;
  const out = ctx.createGain(); out.gain.value = th.gain ?? 1; out.connect(outChain(ctx, ctx.destination));
  const gains = {}, kits = {};
  let first = null;
  for (const name of [...ORDER, 'sting']) {
    const g = ctx.createGain(); g.gain.value = name === 'sting' ? 1 : 0; g.connect(out); gains[name] = g;
    kits[name] = first ? westernKit(ctx, g, { shared: first, tremolo: th.tremolo }) : (first = westernKit(ctx, g, { verbOut: out, tremolo: th.tremolo }));
  }
  const at = typeof layers === 'function' ? layers : () => layers;
  let beat = 0, bar = 0, pass = 0, prev = null;
  for (let t = 0.05; t < secs - 0.5; t += B) {
    const L = at(t);
    for (const name of ORDER) {
      const l = L[name] || 0;
      gains[name].gain.setTargetAtTime(l * MIX[name], t, name === 'danger' ? 0.05 : 0.4);
      if (l < 0.01) continue;
      const b = { k: kits[name], t, B, beat, bar, pass, th, ch: th.chords[bar % th.chords.length], lvl: l, rnd: Math.random, prev: name === 'lead' ? prev : null };
      LAYERS[name](b);
      if (name === 'lead') prev = b.prev;
    }
    if (++beat >= th.meter) { beat = 0; if (++bar >= 16) { bar = 0; pass++; } }
  }
  for (const [t, name] of stings) playSting(kits.sting, name, t, th);
  return ctx.startRendering();
}
