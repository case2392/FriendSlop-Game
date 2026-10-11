// Pixel identity of every painted texture three ways: painted on the page's main thread, painted by a
// paint worker (client/js/paint/worker.js, in the opposite order, so no texture leans on what another
// one's paint left behind), and stored to the texture cache by the worker then read back, decoded and
// copied into the texture's canvas exactly the way a later load does (texprep.js -> core.adopt ->
// canvasFor). Hashes getImageData of each; any difference is a failure.
//
//   node tools/texhash.mjs [--names a,b,c] [--family terrain] [--every N] [--root DIR]
//   node tools/texhash.mjs --dump out.json [--root DIR] [--reverse]
//                                     main-thread hashes only: compare two checkouts, or the registry
//                                     order with the reverse order (a paint that depends on what was
//                                     painted before it shows up)
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
const DUMP = arg('dump', '');
if (DUMP) {
  // the plain texture page (no game boot, no web fonts), every texture through canvasFor in registry
  // order: the same calls on any checkout, so two dumps compare the main-thread pixels of two versions
  await page.goto(`http://localhost:${PORT}/gallery.html?family=none`);
  const main = await page.evaluate(async reverse => {
    const P = await import('/js/paint/index.js');
    const hex = async d => [...new Uint8Array(await crypto.subtle.digest('SHA-1', d))].map(b => b.toString(16).padStart(2, '0')).join('');
    const out = {};
    const all = P.list();
    if (reverse) all.reverse();
    for (const t of all) { const cv = P.canvasFor(t.name); out[t.name] = await hex(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data); }
    return out;
  }, process.argv.includes('--reverse'));
  const fs = await import('node:fs');
  fs.writeFileSync(DUMP, JSON.stringify(main));
  console.log(`${Object.keys(main).length} main-thread hashes -> ${DUMP}${errors.length ? '\npage errors:\n' + errors.join('\n') : ''}`);
  await browser.close(); process.exit(errors.length ? 1 : 0);
}
await page.goto(`http://localhost:${PORT}/?paintWorkers=0`);   // the game page, its own pool off: this tool drives a worker itself
const res = await page.evaluate(async ({ only, fam, every }) => {
  const P = await import('/js/paint/index.js');
  const TC = await import('/js/texcache.js');
  const { fontList } = await import('/js/texprep.js');
  const { IN_ORDER } = await import('/js/texmanifest.js');
  await Promise.all(['900 40px Cinzel', '700 40px Cinzel', '40px Marcellus', '40px "NMD UI"'].map(f => document.fonts.load(f, 'Aa09$').catch(() => null)));
  let names = P.list(fam || null).map(t => t.name);
  if (only) { const s = new Set(only.split(',')); names = names.filter(n => s.has(n)); }
  if (every > 1) names = names.filter((n, i) => i % every === 0);
  const hex = async d => [...new Uint8Array(await crypto.subtle.digest('SHA-1', d))].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashCv = cv => hex(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data);
  const hashBmp = bmp => { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d', { willReadFrequently: true }); g.globalCompositeOperation = 'copy'; g.drawImage(bmp, 0, 0); return hashCv(c); };
  const out = { n: names.length, main: {}, worker: {}, cache: {}, adopt: {}, inexact: [], dynamic: [], inorder: [], alone: [], keys: 0, ms: { main: 0, worker: 0, inexact: 0 } };
  // 1. main thread, registry order, fresh canvases (the page's own cache untouched)
  const mainMs = {}, mainDeps = {};
  for (const n of names) { const t0 = performance.now(); const { cv, deps } = P.paintTexture(n); mainMs[n] = performance.now() - t0; out.ms.main += mainMs[n]; out.main[n] = await hashCv(cv); mainDeps[n] = deps; }
  // 2. a paint worker, reverse order; each texture stored to the cache right after. One that clips comes
  //    back inexact (OffscreenCanvas clips without antialiasing): the page paints it, and the page's
  //    snapshot is what gets stored
  const H = await TC.sourceHashes(P.FAMILIES, fontList());
  const w = new Worker('/js/paint/worker.js', { type: 'module' });
  const call = (m, want) => new Promise((res, rej) => { w.onmessage = ({ data }) => { if (data.t === want || data.t === 'fail') res(data); }; w.onerror = e => rej(new Error(e.message)); w.postMessage(m); });
  const rd = await call({ t: 'init', fonts: fontList(), hashes: H }, 'ready');
  if (!rd.ok) return { error: 'worker: ' + rd.err };
  for (const n of [...names].reverse()) {
    if (IN_ORDER.includes(P.meta(n).family)) { out.inorder.push(n); continue; }   // left to the game, never cached
    const t0 = performance.now();
    const d = await call({ t: 'paint', id: 1, name: n }, 'done');
    out.ms.worker += performance.now() - t0;
    if (d.t === 'fail') {
      if (/no texture registered/.test(d.err) && !P.FAMILIES.includes(P.meta(n).family)) { out.dynamic.push(n); out.worker[n] = out.cache[n] = out.main[n]; continue; }   // registered at run time: page only, never cached
      out.worker[n] = 'FAIL ' + d.err; continue;
    }
    if (d.alone) { out.alone.push(n); continue; }
    if (!d.exact) {
      out.inexact.push(n); out.ms.inexact += mainMs[n]; out.worker[n] = out.main[n];
      const snap = await createImageBitmap(P.paintTexture(n).cv);
      const s = await call({ t: 'store', id: 2, names: [n], bmps: [snap], deps: [mainDeps[n]] }, 'stored');
      if (!s.n) out.worker[n] += ` (store: ${s.err || 'no key'})`;
      continue;
    }
    out.worker[n] = await hashBmp(d.bmp); d.bmp.close();
    const s = await call({ t: 'store', id: 2, names: [n] }, 'stored');
    if (!s.n) out.worker[n] += ` (store: ${s.err || 'no key'})`;
  }
  w.terminate();
  // 3. read back: the key must still match, decode, and the core's adopt -> canvasFor copy
  const recs = await TC.getMany(names);
  for (const n of names) {
    if (out.dynamic.includes(n) || out.inorder.includes(n) || out.alone.includes(n)) continue;
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
  for (const k in out.ms) out.ms[k] = Math.round(out.ms[k]);
  return out;
}, { only: arg('names', ''), fam: arg('family', ''), every: +arg('every', 1) });
if (res.error) { console.log('FAILED:', res.error); process.exit(1); }
const bad = [];
for (const n of Object.keys(res.main)) {
  if (res.inorder.includes(n) || res.alone.includes(n)) continue;
  if (res.worker[n] !== res.main[n]) bad.push(`${n}: worker ${String(res.worker[n]).slice(0, 12)} != main ${res.main[n].slice(0, 12)}`);
  if (res.cache[n] !== res.main[n]) bad.push(`${n}: cache ${String(res.cache[n]).slice(0, 12)} != main ${res.main[n].slice(0, 12)}`);
  if (n in res.adopt && res.adopt[n] !== res.main[n]) bad.push(`${n}: adopted copy ${res.adopt[n].slice(0, 12)} != main ${res.main[n].slice(0, 12)}`);
}
console.log(`${res.n} textures: main paint ${(res.ms.main / 1000).toFixed(1)} s, worker paint+store ${(res.ms.worker / 1000).toFixed(1)} s; ${res.keys} cache keys valid; ${Object.keys(res.adopt).length} checked through adopt -> canvasFor`);
console.log(`${res.inexact.length} clip off the pixel grid in their paint, painted by the page instead (${(res.ms.inexact / 1000).toFixed(1)} s of main-thread paint): ${res.inexact.join(' ')}`);
if (res.inorder.length) console.log(`${res.inorder.length} in families whose pixels depend on paint order (texmanifest IN_ORDER), left to the game to paint in its own order, never cached: ${res.inorder.join(' ')}`);
if (res.alone.length) console.log(`${res.alone.length} read such a texture, left alone too: ${res.alone.join(' ')}`);
if (res.dynamic.length) console.log(`${res.dynamic.length} registered at run time (page only, never cached): ${res.dynamic.join(' ')}`);
console.log(bad.length ? `MISMATCHES (${bad.length}):\n` + bad.join('\n') : 'all identical: main thread = worker = cache round trip');
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);
