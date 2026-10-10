// The painted-texture cache under faults: every scenario must end with every texture's pixels equal to
// a plain main-thread paint, and no page errors.
//
//   node tools/texfaults.mjs
//
//   cold        empty cache: the workers paint, the page paints its clip ones, flush writes them all
//   warm        a new page: everything decodes from the cache
//   corrupt     records with garbage PNGs, a truncated PNG, a wrong key, a wrong size and a deps field
//               that isn't a list: each one repainted, the bad records replaced
//   quota       writes fail on quota (?texcache=full): nothing more is written, reads go on
//   no-idb      IndexedDB throws on use (private windows, blocked storage; ?texcache=broken): the
//               workers still paint, nothing is cached
//   no-workers  ?paintWorkers=0: prepare() is a no-op, canvasFor paints as it always did
//   two-tabs    two pages fill the cache at the same time, a third reads it
//   learned     what a browser learned under other paint code (textures a worker can't paint
//               exactly, ones left alone) is forgotten: they go to the workers again
//   fonts       a worker that couldn't load a web font: a paint that sets text in it comes back
//               inexact (the page paints it), one that doesn't still comes back exact
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 9000 + Math.floor(Math.random() * 900); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// a spread of textures: plain ones, clip ones the page paints, alpha ones, ones that read others
const NAMES = ['ground_meadow', 'mud', 'cliff_meadow', 'leaves_oak', 'needles_pine', 'bark_oak', 'cliff_snow', 'cliff_snow_form', 'rs_gatelabels', 'loot_atlas', 'shingles_red', 'plaster_cream', 'sky_clouds_meadow', 'wall_holes'];
let failed = false;
const ok = m => console.log('✅', m), fail = m => { console.log('❌', m); failed = true; };

async function run(ctx, label, { query = '', init = null, corrupt = false, first = [] } = {}) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(900000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto(`http://localhost:${PORT}/gallery.html?family=none${query}`);
  const r = await page.evaluate(async ({ names, corrupt, first }) => {
    const P = await import('/js/paint/index.js');
    const T = await import('/js/texprep.js');
    const TC = await import('/js/texcache.js');
    names = names.filter(n => P.has(n));
    const settle = async () => { T.flush(); const t1 = performance.now(); while (!T.idle() && performance.now() - t1 < 300000) await new Promise(r => setTimeout(r, 250)); };
    if (first.length) { await T.prepare(first); await settle(); }   // some other textures first, painted and (tried to be) stored
    if (corrupt) {   // damage what the earlier pages stored, straight in IndexedDB
      const db = await new Promise((res, rej) => { const q = indexedDB.open('nmd-textures', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const recs = await TC.getMany(names);
      const tx = db.transaction('tex', 'readwrite'), st = tx.objectStore('tex');
      const [a, b, c, d, e] = names.filter(n => recs.has(n));
      st.put({ ...recs.get(a), blob: new Blob([crypto.getRandomValues(new Uint8Array(4000))], { type: 'image/png' }) });
      st.put({ ...recs.get(b), blob: recs.get(b).blob.slice(0, recs.get(b).blob.size >> 1, 'image/png') });
      st.put({ ...recs.get(c), key: 'not-the-key' });
      st.put({ ...recs.get(d), w: 3 });
      st.put({ ...recs.get(e), deps: 7 });   // an older format's record
      await new Promise(res => { tx.oncomplete = res; });
      db.close();
    }
    const hex = async d => [...new Uint8Array(await crypto.subtle.digest('SHA-1', d))].map(x => x.toString(16).padStart(2, '0')).join('');
    const px = cv => cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    const want = {};
    for (const n of names) want[n] = await hex(px(P.paintTexture(n).cv));   // a plain main-thread paint
    const t0 = performance.now();
    const prep = await T.prepare(names);
    const ms = performance.now() - t0;
    const bad = [];
    for (const n of names) if (await hex(px(P.canvasFor(n))) !== want[n]) bad.push(n);
    await settle();
    const ls = {};
    for (const k of ['nmdTexPageOnly', 'nmdTexAlone', 'nmdTexLearnedFor']) ls[k] = localStorage.getItem(k);
    return { bad, prep, ms: Math.round(ms), stats: T.stats(), idle: T.idle(), page: T.pagePainted().map(s => s.split(' ')[0]), ls };
  }, { names: NAMES, corrupt, first });
  await page.close();
  const s = r.stats;
  const line = `${label}: ${r.prep.ready}/${r.prep.total} ready in ${(r.ms / 1000).toFixed(1)} s · cache hits ${s.cacheHits}, worker paints ${s.workerPaints}, page paints ${s.pagePaints}, stored ${s.stored}${s.cache.broken ? ` · cache off (${s.cache.lastErr})` : s.cache.full ? ` · writes off (${s.cache.lastErr})` : ''}${s.failed ? ` · ${s.failed}` : ''}`;
  if (r.bad.length || errors.length || !r.idle) fail(`${line}\n   pixels differ: ${r.bad.join(' ') || 'none'}; errors: ${errors.join(' | ') || 'none'}; idle ${r.idle}`);
  else ok(line);
  return r;
}

const ctx = await browser.newContext();
const cold = await run(ctx, 'cold');
if (!(cold.stats.workerPaints > 0 && cold.stats.stored > 0)) fail('cold: expected worker paints and cache writes');
const warm = await run(ctx, 'warm');
if (warm.stats.cacheHits < warm.prep.total) fail(`warm: expected every texture from the cache (${warm.stats.cacheHits}/${warm.prep.total})`);
const bad = await run(ctx, 'corrupt', { corrupt: true });
if (!(bad.stats.cacheHits <= bad.prep.total - 5 && bad.stats.stored >= 5)) fail('corrupt: expected 5 misses repainted and rewritten');
const again = await run(ctx, 'after corrupt');
if (again.stats.cacheHits < again.prep.total) fail(`after corrupt: expected every texture from the cache again (${again.stats.cacheHits}/${again.prep.total})`);
// the quota runs out on the first writes (a worker's paint and a page paint, not cached yet): no more
// writes this session, and the textures already cached still come from the cache
const full = await run(ctx, 'quota', { query: '&texcache=full', first: ['ground_fields', 'ground_snow'] });
if (!(full.stats.cache.full && !full.stats.cache.broken && full.stats.stored === 0 && full.stats.cacheHits >= full.prep.total)) fail(`quota: expected writes off, nothing stored and every texture still read from the cache (${full.stats.cacheHits}/${full.prep.total})`);
await ctx.close();

const ctx2 = await browser.newContext();
const noidb = await run(ctx2, 'no-idb', { query: '&texcache=broken' });   // the workers' IndexedDB throws on use
if (!(noidb.stats.cache.broken && noidb.stats.stored === 0)) fail('no-idb: expected the cache off and nothing stored');
const nowk = await run(ctx2, 'no-workers', { query: '&paintWorkers=0&texcache=0' });
if (nowk.stats.workers !== 0) fail('no-workers: expected no workers');
await ctx2.close();

const ctx3 = await browser.newContext();
await Promise.all([run(ctx3, 'two tabs (1)'), run(ctx3, 'two tabs (2)')]);
const third = await run(ctx3, 'two tabs, then a third');
if (third.stats.cacheHits < third.prep.total) fail(`two tabs: expected the third page to read everything (${third.stats.cacheHits}/${third.prep.total})`);
await ctx3.close();

// a browser that learned, under some older paint code, that ground_meadow and leaves_oak can't be
// painted exactly by a worker and that bark_oak reads an order-dependent texture
const ctx4 = await browser.newContext();
const learned = await run(ctx4, 'learned', { init: () => { if (!localStorage.getItem('nmdTexLearnedFor')) { localStorage.setItem('nmdTexPageOnly', JSON.stringify(['ground_meadow', 'leaves_oak'])); localStorage.setItem('nmdTexAlone', JSON.stringify(['bark_oak'])); localStorage.setItem('nmdTexLearnedFor', 'older paint code'); } } });
const stale = ['ground_meadow', 'leaves_oak', 'bark_oak'];
if (stale.some(n => learned.page.includes(n)) || learned.ls.nmdTexLearnedFor === 'older paint code' || stale.some(n => String(learned.ls.nmdTexPageOnly).includes(n) || String(learned.ls.nmdTexAlone).includes(n))) fail(`learned: expected the older lists forgotten and those textures painted by the workers (page painted: ${learned.page.join(' ')}; ${JSON.stringify(learned.ls)})`);
await ctx4.close();

// a worker whose web font didn't load (here: "Georgia" pointed at a missing file) must not paint text
// in it: slot_face sets Georgia text, ground_meadow sets none
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/gallery.html?family=none`);
  const r = await page.evaluate(async () => {
    const { fontList } = await import('/js/texprep.js');
    const run = async (fonts, names) => {
      const w = new Worker('/js/paint/worker.js', { type: 'module' });
      const call = (m, want) => new Promise(res => { w.onmessage = ({ data }) => { if (data.t === want || data.t === 'fail') res(data); }; w.postMessage(m); });
      await call({ t: 'init', fonts, hashes: null }, 'ready');
      const out = {};
      for (const n of names) { const d = await call({ t: 'paint', id: 1, name: n }, 'done'); out[n] = d.t === 'fail' ? 'fail' : d.exact ? 'exact' : 'inexact'; d.bmp?.close?.(); }
      w.terminate();
      return out;
    };
    return {
      loaded: await run(fontList(), ['slot_face', 'ground_meadow']),
      missing: await run([{ family: 'Georgia', url: new URL('/fonts/missing.woff2', location.href).href }], ['slot_face', 'ground_meadow']),
    };
  });
  await page.close();
  const line = `fonts: with the page's fonts ${JSON.stringify(r.loaded)}; with Georgia missing ${JSON.stringify(r.missing)}`;
  if (r.loaded.slot_face === 'exact' && r.loaded.ground_meadow === 'exact' && r.missing.slot_face === 'inexact' && r.missing.ground_meadow === 'exact' && !errors.length) ok(line);
  else fail(`${line}; errors: ${errors.join(' | ') || 'none'}`);
}

await browser.close();
console.log(failed ? '\nTEXTURE CACHE FAULTS: FAILED' : '\nTEXTURE CACHE FAULTS: all scenarios end with the right pixels');
process.exit(failed ? 1 : 0);
