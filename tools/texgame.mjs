// In-game texture identity: host a trip, let a day build the way a player gets it, then hash every
// texture canvas the game holds (getImageData, SHA-1). Run it on two checkouts and compare: the
// textures the game painted itself, the ones a paint worker painted, the ones copied out of the
// texture cache, and the character atlases the game paints in its own order must all come out the
// same as before the load-time work.
//
//   node tools/texgame.mjs [--root DIR] [--day N] [--seed N] --out run.json
//                          a fresh profile: a first visit (cold), then a second page in the same
//                          profile once the first one's cache writes are done (warm; skipped on a
//                          checkout without the texture cache)
//   node tools/texgame.mjs --compare a.json b.json
//
// Textures the day never asked for are painted when the hashing reaches them, in registry order, on
// both checkouts alike.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
if (process.argv.includes('--compare')) {
  const i = process.argv.indexOf('--compare');
  const [A, B] = [process.argv[i + 1], process.argv[i + 2]].map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  let bad = 0;
  for (const pa of Object.keys(A)) for (const pb of Object.keys(B)) {
    const a = A[pa], b = B[pb], names = Object.keys(a).filter(n => n in b);
    const diff = names.filter(n => a[n] !== b[n]);
    const only = [...Object.keys(a).filter(n => !(n in b)), ...Object.keys(b).filter(n => !(n in a))];
    // a name in one run only is a texture registered at run time for that run's game state (a player's
    // look, say): reported, not a failure
    console.log(`${pa} vs ${pb}: ${names.length} textures compared, ${diff.length} differ${diff.length ? ': ' + diff.join(' ') : ''}${only.length ? ` · in one run only: ${only.join(' ')}` : ''}`);
    bad += diff.length;
  }
  process.exit(bad ? 1 : 0);
}

const { chromium } = await import('playwright-core');
const ROOT = path.resolve(arg('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const DAY = +arg('day', 1), SEED = arg('seed', '777'), OUT = arg('out', '');
if (!OUT) { console.error('usage: node tools/texgame.mjs [--root DIR] [--day N] --out run.json'); process.exit(2); }
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 9000 + Math.floor(Math.random() * 900); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const errors = [], out = {};
const built = (page, d) => page.waitForFunction(d => { const S = window.__nmd; return S?.W && S.lw && S.wv && S.W.day === d; }, d);
for (const pass of ['cold', 'warm']) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(900000);
  page.on('pageerror', e => errors.push(`[${pass}] ${e.message}`));
  await page.goto(`http://localhost:${PORT}`);
  const hasCache = await page.evaluate(() => !!window.__nmd?.texCache);
  if (pass === 'warm' && !hasCache) { await page.close(); break; }
  await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  await page.fill('#nameInput', 'Steve');
  await page.fill('#seedInput', SEED);
  await page.click('#hostBtn');
  await built(page, 1);
  if (DAY !== 1) { await page.evaluate(d => window.__nmd.send({ t: 'dbg', op: 'day', d }), DAY); await built(page, DAY); }
  const f0 = await page.evaluate(() => window.__nmd.frames || 0);
  await page.waitForFunction(n => (window.__nmd.frames || 0) > n, f0 + 3);
  // the cache writes after the build (the warm pass reads them); a no-op on a checkout without them
  await page.waitForFunction(() => { const c = window.__nmd?.texCache; return !c || c.idle(); }, null, { timeout: 600000, polling: 500 });
  const src = hasCache ? await page.evaluate(() => window.__nmd.texCache.stats()) : null;
  const h = await page.evaluate(async () => {
    const P = await import('/js/paint/index.js');
    const hex = async d => [...new Uint8Array(await crypto.subtle.digest('SHA-1', d))].map(b => b.toString(16).padStart(2, '0')).join('');
    const r = {};
    for (const t of P.list()) { const cv = P.canvasFor(t.name); r[t.name] = await hex(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data); }
    return r;
  });
  out[pass] = h;
  console.log(`${pass}: ${Object.keys(h).length} textures hashed${src ? ` (this page: ${src.cacheHits} from the cache, ${src.workerPaints} painted by workers, ${src.pagePaints} by the page)` : ''}`);
  await page.close();
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(errors.length ? 'page errors:\n' + errors.slice(0, 20).join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
