// Pixel identity of every painted texture three ways: painted on the page's main thread, painted by a
// paint worker (client/js/paint/worker.js, in the opposite order, so no texture leans on what another
// one's paint left behind), and stored to the texture cache by the worker then read back, decoded and
// copied into the texture's canvas exactly the way a later load does (texprep.js -> core.adopt ->
// canvasFor). Hashes getImageData of each; any difference is a failure.
//
//   node tools/texhash.mjs [--names a,b,c] [--family terrain] [--every N]
//
// Runs in the game page (index.html) so the web fonts are the game's; waits for them first.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 9000 + Math.floor(Math.random() * 900); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.setDefaultTimeout(1800000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://localhost:${PORT}/?paintWorkers=0`);   // the game page, its own pool off: this tool drives a worker itself
const res = await page.evaluate(async ({ only, fam, every }) => {
  const P = await import('/js/paint/index.js');
  const TC = await import('/js/texcache.js');
  const { fontList } = await import('/js/texprep.js');
  await Promise.all(['900 40px Cinzel', '700 40px Cinzel', '40px Marcellus', '40px "NMD UI"'].map(f => document.fonts.load(f, 'Aa09$').catch(() => null)));
  let names = P.list(fam || null).map(t => t.name);
  if (only) { const s = new Set(only.split(',')); names = names.filter(n => s.has(n)); }
  if (every > 1) names = names.filter((n, i) => i % every === 0);
  const hex = async d => [...new Uint8Array(await crypto.subtle.digest('SHA-1', d))].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashCv = cv => hex(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data);
  const hashBmp = bmp => { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d', { willReadFrequently: true }); g.globalCompositeOperation = 'copy'; g.drawImage(bmp, 0, 0); return hashCv(c); };
  const out = { n: names.length, main: {}, worker: {}, cache: {}, adopt: {}, keys: 0, ms: { main: 0, worker: 0 } };
  // 1. main thread, registry order, fresh canvases (the page's own cache untouched)
  for (const n of names) { const t0 = performance.now(); const { cv } = P.paintTexture(n); out.ms.main += performance.now() - t0; out.main[n] = await hashCv(cv); }
  // 2. a paint worker, reverse order; each texture stored to the cache right after
  const H = await TC.sourceHashes(P.FAMILIES);
  const w = new Worker('/js/paint/worker.js', { type: 'module' });
  const call = (m, want) => new Promise((res, rej) => { w.onmessage = ({ data }) => { if (data.t === want || data.t === 'fail') res(data); }; w.onerror = e => rej(new Error(e.message)); w.postMessage(m); });
  const rd = await call({ t: 'init', fonts: fontList(), hashes: H }, 'ready');
  if (!rd.ok) return { error: 'worker: ' + rd.err };
  for (const n of [...names].reverse()) {
    const t0 = performance.now();
    const d = await call({ t: 'paint', id: 1, name: n }, 'done');
    out.ms.worker += performance.now() - t0;
    if (d.t === 'fail') { out.worker[n] = 'FAIL ' + d.err; continue; }
    out.worker[n] = await hashBmp(d.bmp); d.bmp.close();
    const s = await call({ t: 'store', id: 2, names: [n] }, 'stored');
    if (!s.n) out.worker[n] += ` (store: ${s.err || 'no key'})`;
  }
  w.terminate();
  // 3. read back: the key must still match, decode, and the core's adopt -> canvasFor copy
  const recs = await TC.getMany(names);
  for (const n of names) {
    const r = recs.get(n);
    if (!r) { out.cache[n] = 'MISSING'; continue; }
    if (r.key !== TC.keyOf(n, r.deps, H, P.meta)) { out.cache[n] = 'KEY MISMATCH'; continue; }
    out.keys++;
    const bmp = await createImageBitmap(r.blob, { premultiplyAlpha: 'default', colorSpaceConversion: 'none' });
    out.cache[n] = await hashBmp(bmp);
    if (!P.ready(n)) {
      if (P.adopt(n, bmp)) out.adopt[n] = await hashCv(P.canvasFor(n));
    } else bmp.close();
  }
  out.ms.main = Math.round(out.ms.main); out.ms.worker = Math.round(out.ms.worker);
  return out;
}, { only: arg('names', ''), fam: arg('family', ''), every: +arg('every', 1) });
if (res.error) { console.log('FAILED:', res.error); process.exit(1); }
const bad = [];
for (const n of Object.keys(res.main)) {
  if (res.worker[n] !== res.main[n]) bad.push(`${n}: worker ${String(res.worker[n]).slice(0, 12)} != main ${res.main[n].slice(0, 12)}`);
  if (res.cache[n] !== res.main[n]) bad.push(`${n}: cache ${String(res.cache[n]).slice(0, 12)} != main ${res.main[n].slice(0, 12)}`);
  if (n in res.adopt && res.adopt[n] !== res.main[n]) bad.push(`${n}: adopted copy ${res.adopt[n].slice(0, 12)} != main ${res.main[n].slice(0, 12)}`);
}
console.log(`${res.n} textures: main paint ${(res.ms.main / 1000).toFixed(1)} s, worker paint+store ${(res.ms.worker / 1000).toFixed(1)} s; ${res.keys} cache keys valid; ${Object.keys(res.adopt).length} checked through adopt -> canvasFor`);
console.log(bad.length ? `MISMATCHES (${bad.length}):\n` + bad.join('\n') : 'all identical: main thread = worker = cache round trip');
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);
