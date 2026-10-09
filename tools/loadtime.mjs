// Load-time harness: how long from opening the page to a built, rendering world, and how long each
// later day takes to rebuild. One Chromium context, so the painted-texture cache (IndexedDB) carries
// over from the cold page to the warm one exactly as it would for a returning player.
//
//   node tools/loadtime.mjs [--root DIR] [--seed N] [--skip cold,warm,night]
//
//   cold   a fresh profile: page load, host -> world built -> 5 frames, then days 3 and 5 (dbg jumps)
//   warm   a second page in the same profile once the cold page's cache writes are done
//   night  a fresh profile again: day 2, a night (prefetch runs), then day 3; day 4, a night, then day 5;
//          also records the longest frame gap while the night scene renders
//
// --root runs another checkout's server and client (e.g. a pre-change copy) for before/after numbers.
// Software GL (swiftshader) like every other tool here, so absolute numbers are a CPU-only worst case.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const SEED = arg('seed', '777');
const SKIP = new Set(String(arg('skip', '')).split(',').filter(Boolean));
const NIGHT_SECS = +arg('night', 12);

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 9000 + Math.floor(Math.random() * 900); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const R = {};
const log = (k, v) => { R[k] = v; console.log(`${k}: ${typeof v === 'number' ? (v / 1000).toFixed(1) + ' s' : v}`); };

async function open(ctx, tag) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(900000);
  page.on('pageerror', e => errors.push(`[${tag}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(`[${tag}] ${m.text()}`); });
  return page;
}
const built = (page, d) => page.waitForFunction(d => { const S = window.__nmd; return S?.W && S.lw && S.wv && (d == null || S.W.day === d); }, d);
const frames = (page, n) => page.waitForFunction(n => (window.__nmd.frames || 0) > n, n);
const send = (page, m) => page.evaluate(m => window.__nmd.send(m), m);
async function firstLoad(page, tag) {
  let t = Date.now();
  await page.goto(`http://localhost:${PORT}`);
  log(`${tag} page load`, Date.now() - t);
  await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  await page.fill('#nameInput', 'Steve');
  await page.fill('#seedInput', SEED);
  t = Date.now();
  await page.click('#hostBtn');
  await built(page, 1);
  log(`${tag} host -> world built`, Date.now() - t);
  const f0 = await page.evaluate(() => window.__nmd.frames || 0);
  await frames(page, f0 + 5);
  log(`${tag} host -> 5 frames`, Date.now() - t);
}
async function jump(page, d, tag) {
  const t = Date.now();
  await send(page, { t: 'dbg', op: 'day', d });
  await built(page, d);
  const f0 = await page.evaluate(() => window.__nmd.frames || 0);
  await frames(page, f0 + 2);
  log(`${tag} day ${d} rebuild`, Date.now() - t);
}
// the texture cache writes in idle time after the world is up: wait for it to drain (no-op on old code)
const cacheIdle = page => page.waitForFunction(() => { const c = window.__nmd?.texCache; return !c || c.idle(); }, null, { timeout: 600000, polling: 500 }).catch(() => console.log('  (cache never went idle)'));
// the client's own marks (main.js): textures ready, build, prefetch; and texprep.js's counters
const marks = page => page.evaluate(() => performance.getEntriesByType('measure').map(m => `${m.name} ${(m.duration / 1000).toFixed(1)}s`).join(' · ')).catch(() => '');
const texStats = page => page.evaluate(() => { const s = window.__nmd?.texCache?.stats?.(); return s ? `workers ${s.workers}, cache hits ${s.cacheHits}, misses ${s.cacheMiss}, worker paints ${s.workerPaints}, page paints ${s.pagePaints} (${(s.pageMs / 1000).toFixed(1)} s), stored ${s.stored} (${s.storedKB} KB)${s.storeErr ? ', store error: ' + s.storeErr : ''}${s.failed ? ', ' + s.failed : ''}` : '(no texture cache)'; }).catch(() => '');
async function night(page, secs) {
  await send(page, { t: 'dbg', op: 'phase', ph: 'night' });
  await send(page, { t: 'dbg', op: 'clock', h: 22.5 });
  // frame gaps while the night scene renders and the next day is prepared behind it
  const gaps = await page.evaluate(ms => new Promise(res => {
    const g = []; let last = performance.now(); const t0 = last;
    const f = now => { g.push(now - last); last = now; if (now - t0 < ms) requestAnimationFrame(f); else res(g); };
    requestAnimationFrame(f);
  }), secs * 1000);
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1] || 0;
  return `${gaps.length} frames, median ${med.toFixed(0)} ms, worst ${(gaps[gaps.length - 1] || 0).toFixed(0)} ms`;
}

console.log(`root ${ROOT} · seed ${SEED}`);
if (!SKIP.has('cold') || !SKIP.has('warm')) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const a = await open(ctx, 'cold');
  await firstLoad(a, 'cold');
  for (const d of [3, 5]) await jump(a, d, 'cold');
  let t = Date.now();
  await cacheIdle(a);
  console.log(`  (cache writes drained ${((Date.now() - t) / 1000).toFixed(1)} s after the last build)`);
  console.log('  marks:', await marks(a));
  console.log('  textures:', await texStats(a));
  await a.close();
  if (!SKIP.has('warm')) {
    const b = await open(ctx, 'warm');
    await firstLoad(b, 'warm');
    for (const d of [3, 5]) await jump(b, d, 'warm');
    console.log('  marks:', await marks(b));
    console.log('  textures:', await texStats(b));
    await b.close();
  }
  await ctx.close();
}
if (!SKIP.has('night')) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const c = await open(ctx, 'night');
  await firstLoad(c, 'night');
  for (const [d0, d1] of [[2, 3], [4, 5]]) {
    await jump(c, d0, 'night');
    const fr = await night(c, NIGHT_SECS);
    console.log(`  night before day ${d1}: ${fr}`);
    console.log('  prefetch:', JSON.stringify(await c.evaluate(() => window.__nmd.prefetch || null)));
    await jump(c, d1, 'after-night');
  }
  console.log('  marks:', await marks(c));
  console.log('  textures:', await texStats(c));
  await ctx.close();
}
const perf = errors.length ? 'PAGE ERRORS:\n' + errors.slice(0, 20).join('\n') : 'no page errors';
console.log(perf);
console.log('JSON ' + JSON.stringify(R));
await browser.close();
process.exit(errors.length ? 1 : 0);
