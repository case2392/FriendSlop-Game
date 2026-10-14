// The score (client/js/score.js) and its band (client/js/western.js), played offline in Chromium: every theme
// renders, none clips, they sit within a few dB of each other, the layers that answer the wildlife and the
// clock make sound, the strings are in tune, and the score's levels follow what's going on. And the RV's horn.
//   node test/music.mjs                 the checks
//   MUSIC_DEMO=dist/music node test/music.mjs   also writes each theme and a "what's going on" demo as WAVs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = process.env.MUSIC_DEMO ? path.resolve(process.env.MUSIC_DEMO) : null;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) { passed++; console.log('✅', msg); } else { failed++; console.log('❌', msg); } };

// the page's own files, as the game serves them
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>music</title>'); }
  const f = path.join(ROOT, 'client', path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(path.join(ROOT, 'client')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', e => { failed++; console.log('❌ page error:', e.message); });
page.setDefaultTimeout(600000);
await page.goto(`http://localhost:${port}/`);

function wav(sr, chans) {
  const n = chans[0].length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767))), 44 + i * 4 + c * 2);
  return b;
}
// render in the page; stats there, and (for the demos) the samples back as 16-bit
async function render(opts, keep = false) {
  const r = await page.evaluate(async ([opts, keep]) => {
    const { renderTheme } = await import('/js/score.js');
    if (typeof opts.layers === 'string') opts.layers = new Function('t', opts.layers);
    const buf = await renderTheme(OfflineAudioContext, opts);
    const st = { peak: 0, rms: 0, nan: 0, secs: buf.duration };
    let sum = 0, n = 0;
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const x = d[i]; if (!Number.isFinite(x)) { st.nan++; continue; } const a = Math.abs(x); if (a > st.peak) st.peak = a; sum += x * x; n++; } }
    st.rms = Math.sqrt(sum / n);
    // loudness over the busiest 4 s (a theme's rests and intro don't count against it)
    const sr = buf.sampleRate, w = sr * 4, d0 = buf.getChannelData(0);
    let best = 0; for (let s0 = 0; s0 + w < d0.length; s0 += sr) { let q = 0; for (let i = s0; i < s0 + w; i++) q += d0[i] * d0[i]; best = Math.max(best, Math.sqrt(q / w)); }
    st.loud = best;
    if (keep) {
      const conv = d => { const a = new Int16Array(d.length); for (let i = 0; i < d.length; i++) a[i] = Math.max(-32768, Math.min(32767, Math.round(d[i] * 32767))); const u = new Uint8Array(a.buffer); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
      st.pcm = [0, 1].map(c => { const d = buf.getChannelData(c), parts = []; for (let i = 0; i < d.length; i += 32768) parts.push(conv(d.subarray(i, i + 32768))); return parts; }); st.sr = sr;
    }
    return st;
  }, [opts, keep]);
  if (r.pcm) {
    r.chans = r.pcm.map(parts => { const bufs = parts.map(p => Buffer.from(p, 'base64')); const all = Buffer.concat(bufs); const out = new Float32Array(all.length / 2); for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2) / 32767; return out; });
    delete r.pcm;
  }
  return r;
}
const dB = x => (20 * Math.log10(Math.max(1e-9, x))).toFixed(1);

// 1. every theme: no NaN, no clipping, loud enough, and within 6 dB of the others
const themes = ['title', 'meadow', 'fields', 'snow', 'badlands', 'desert', 'night'];
const loud = {};
for (const theme of themes) {
  const secs = DEMO ? 46 : 14;
  const r = await render({ theme, key: theme === 'night' ? 'G' : null, secs, layers: { bed: 1, groove: 1, lead: 1 } }, !!DEMO);
  loud[theme] = r.loud;
  check(r.nan === 0 && r.peak < 0.98 && r.loud > 0.02, `${theme}: ${r.secs.toFixed(0)} s, peak ${dB(r.peak)} dBFS, loudest 4 s ${dB(r.loud)} dBFS RMS, no NaN`);
  if (DEMO) { fs.mkdirSync(DEMO, { recursive: true }); fs.writeFileSync(path.join(DEMO, `theme-${theme}.wav`), wav(r.sr, r.chans)); }
}
const vals = Object.values(loud), spread = 20 * Math.log10(Math.max(...vals) / Math.min(...vals));
check(spread < 6, `the themes sit within ${spread.toFixed(1)} dB of each other (loudest 4 s)`);

// 2. the layers that answer the game, alone and over the tune
for (const [layer, theme] of [['tension', 'badlands'], ['danger', 'fields'], ['mischief', 'meadow'], ['clock', 'desert']]) {
  const r = await render({ theme, secs: 8, layers: { [layer]: 1 } });
  check(r.nan === 0 && r.peak < 0.98 && r.loud > 0.01, `${layer} (${theme}): peak ${dB(r.peak)} dBFS, loudest ${dB(r.loud)} dBFS`);
}
// 3. a demo of the director: wandering the meadow, ringtails creep in, a Grumphorn wakes, charges, gives up
{
  const L = `const c = t < 8 ? 1 : t < 14 ? 0.7 : t < 18 ? 0.35 : t < 25 ? 0 : t < 29 ? 0.3 : 1;
    return { bed: c, groove: c, lead: c, mischief: t >= 8 && t < 14 ? 1 : 0, tension: t >= 14 && t < 20 ? 0.8 : t >= 25 && t < 29 ? 0.4 : 0, danger: t >= 19 && t < 25 ? 1 : 0 };`;
  const r = await render({ theme: 'meadow', secs: 34, layers: L, stings: [[8, 'steal'], [14, 'wake'], [19, 'charge']] }, !!DEMO);
  check(r.nan === 0 && r.peak < 0.98, `the director demo (meadow: thieves, a wake, a charge): peak ${dB(r.peak)} dBFS`);
  if (DEMO) fs.writeFileSync(path.join(DEMO, 'demo-a-grumphorn-charges.wav'), wav(r.sr, r.chans));
}
// 4. in tune: a guitar's A4 (Karplus-Strong, its delay a whole number of samples) within 5 cents of 440 Hz
{
  const f = await page.evaluate(async () => {
    const { westernKit } = await import('/js/western.js');
    const sr = 48000, ctx = new OfflineAudioContext(1, sr, sr), k = westernKit(ctx, ctx.destination);
    for (const b of ['guitar']) k[b](0, 81, 0.8, 0.9);
    const d = (await ctx.startRendering()).getChannelData(0);
    // autocorrelation over 0.2-0.6 s: the best lag near 48000/880, refined by parabola
    const a = Math.round(0.2 * sr), n = Math.round(0.4 * sr), lo = 40, hi = 70;
    const r = lag => { let s = 0; for (let i = a; i < a + n; i++) s += d[i] * d[i + lag]; return s; };
    let best = lo, bv = -Infinity; for (let l = lo; l <= hi; l++) { const v = r(l); if (v > bv) { bv = v; best = l; } }
    const y0 = r(best - 1), y1 = bv, y2 = r(best + 1), p = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2);
    return sr / (best + p);
  });
  const cents = 1200 * Math.log2(f / 880);
  check(Math.abs(cents) < 5, `in tune: a guitar's A5 at ${f.toFixed(1)} Hz (${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents)`);
}
// 5. the director (createScore) in a live context: danger comes in at once and lingers; mischief and tension ease
//    in; the tune gives way to the RV radio and the town; a voice ducks it all
{
  const r = await page.evaluate(async () => {
    const { createScore } = await import('/js/score.js');
    const ctx = new AudioContext(), s = createScore(ctx, ctx.destination);
    const base = { mode: 'play', theme: 'badlands', town: 0, radio: 0, urgency: 0, threat: {}, ko: false, voice: false };
    const run = (secs, x) => { for (let i = 0; i < secs * 30; i++) s.update(1 / 30, { ...base, ...x }); return s.levels; };
    const calm = run(4, {});
    const charge = run(0.3, { threat: { charge: 1 } });
    const after = run(2, {});
    const later = run(10, {});
    const thieves = run(1.5, { threat: { thieves: 1 } });
    const radio = run(8, { radio: 1 });
    const town = run(8, { town: 1 });
    const late = run(5, { urgency: 0.95 });
    s.stop(); await ctx.close();
    return { calm, charge, after, later, thieves, radio, town, late, theme: s.theme };
  });
  check(r.calm.lead > 0.9 && r.calm.danger < 0.01, `the director: on the road, the tune (lead ${r.calm.lead.toFixed(2)}), nothing else`);
  check(r.charge.danger > 0.9 && r.charge.lead < 0.5, `a charge: the danger layer in within 0.3 s (${r.charge.danger.toFixed(2)}), the tune ducking (${r.charge.lead.toFixed(2)})`);
  check(r.after.danger > 0.4 && r.later.danger < 0.05, `the danger lingers 2 s after (${r.after.danger.toFixed(2)}) and is gone 10 s later (${r.later.danger.toFixed(3)})`);
  check(r.thieves.mischief > 0.9, `ringtails creeping in: the mischief layer (${r.thieves.mischief.toFixed(2)})`);
  check(r.radio.lead < 0.05 && r.town.lead < 0.05, `the tune gives the floor to the RV's radio (${r.radio.lead.toFixed(3)}) and to the town (${r.town.lead.toFixed(3)})`);
  check(r.late.clock > 0.9 && r.late.tension > 0.5, `five to midnight: the clock (${r.late.clock.toFixed(2)}) and the tension (${r.late.tension.toFixed(2)})`);
}

// 6. the RV's horn (client/js/sfx.js hornSynth): its two tones, held for 1.5 s then let go; loud but not
//    clipping, sounding all the while it's held, silent 0.3 s after
{
  const r = await page.evaluate(async () => {
    const { hornSynth } = await import('/js/sfx.js');
    const sr = 48000, ctx = new OfflineAudioContext(1, sr * 2.2, sr), h = hornSynth(ctx, ctx.destination);
    // (pressed and let go mid-render, as the game does it: at the context's own time)
    ctx.suspend(0.2).then(() => { h.on(ctx.currentTime); ctx.resume(); });
    ctx.suspend(1.7).then(() => { h.off(ctx.currentTime); ctx.resume(); });
    const d = (await ctx.startRendering()).getChannelData(0);
    const rms = (a, b) => { let q = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) q += d[i] * d[i]; return Math.sqrt(q / ((b - a) * sr)); };
    let peak = 0, nan = 0; for (const x of d) { if (!Number.isFinite(x)) nan++; else peak = Math.max(peak, Math.abs(x)); }
    // the spectrum while held (0.6-1.4 s, 1 Hz steps, 250-600 Hz): its two strongest peaks
    const a = Math.round(0.6 * sr), n = Math.round(0.8 * sr), spec = [];
    for (let f = 250; f <= 600; f++) { let re = 0, im = 0; const w = 2 * Math.PI * f / sr; for (let i = 0; i < n; i++) { const x = d[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); re += x * Math.cos(w * i); im += x * Math.sin(w * i); } spec.push([f, Math.hypot(re, im)]); }
    const peaks = spec.filter(([f, m], i) => i > 0 && i < spec.length - 1 && m >= spec[i - 1][1] && m >= spec[i + 1][1]).sort((x, y) => y[1] - x[1]);
    const floor = spec.map(s => s[1]).sort((x, y) => x - y)[Math.floor(spec.length / 2)];
    return { peak, nan, before: rms(0, 0.18), held: [rms(0.3, 0.7), rms(1.2, 1.6)], after: rms(2.0, 2.2), tops: peaks.slice(0, 2).map(p => p[0]).sort((x, y) => x - y), over: peaks[1][1] / floor };
  });
  check(r.nan === 0 && r.peak < 0.9 && r.before < 1e-4 && Math.min(...r.held) > 0.05 && Math.abs(20 * Math.log10(r.held[1] / r.held[0])) < 1.5 && r.after < 0.002,
    `the horn: silent before, sounds as long as it's held (${dB(r.held[0])} and ${dB(r.held[1])} dBFS RMS), peak ${dB(r.peak)} dBFS, gone 0.3 s after it's let go (${dB(r.after)} dBFS)`);
  check(Math.abs(r.tops[0] - 335) <= 3 && Math.abs(r.tops[1] - 420) <= 3 && r.over > 10, `the horn: its two strongest pitches are its two horns (${r.tops.join(' and ')} Hz; 335 and 420), ${dB(r.over)} dB over the median between 250 and 600 Hz`);
}

await browser.close();
server.close();
console.log(failed ? `\n💥 ${failed} MUSIC CHECK(S) FAILED (${passed} passed)` : `\n🎉 ALL ${passed} MUSIC CHECKS PASSED`);
process.exit(failed ? 1 : 0);
