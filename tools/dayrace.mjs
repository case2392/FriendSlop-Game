// Back-to-back world messages (main.js buildDay). One client, a fresh profile:
//  1. day 3 (snow), then day 5 right after day 3's second frame, as tools/loadtime.mjs does. Day 3's
//     build is still learning what snow asks for (localStorage nmdTexDay:snow) for 3 s after that frame:
//     the desert textures day 5 gets ready meanwhile must not go into snow's list.
//  2. day 2, then day 4 while day 2 is still loading. Day 2's build is superseded: what came for day 2
//     (its props list) must not be applied to day 4 (no extra meshes and colliders on the way: main.js
//     drops it, S.staleDropped), its queued texture work must be dropped and nothing it got ready that
//     day 4 doesn't want may stay ready (texprep.js keepOnly). The client must end with the server's
//     props (a probe socket joins and reads them).
//   node tools/dayrace.mjs [root]     exit code 1 on a failure
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const require = createRequire(path.join(HERE, '..', 'package.json'));
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 5600 + Math.floor(Math.random() * 400); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('server never started')), 60000); });

const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = false;
const check = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed = true; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await ctx.newPage();
page.setDefaultTimeout(600000);
page.on('pageerror', e => errors.push(e.message));
// tell this script the moment a world message arrives
const worldWaiters = [];
await page.exposeFunction('__worldArrived', d => { for (const w of worldWaiters.splice(0)) w(d); });
await page.addInitScript(() => {
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(...a) { super(...a); this.addEventListener('message', e => { try { const m = JSON.parse(e.data); if (m.t === 'world') window.__worldArrived(m.day); } catch {} }); }
  };
});
await page.goto(`http://localhost:${PORT}`);
await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
await page.fill('#nameInput', 'Steve'); await page.fill('#seedInput', '777'); await page.click('#hostBtn');
const built = d => page.waitForFunction(d => { const S = window.__nmd; return S?.W && S.lw && S.wv && S.W.day === d; }, d, { polling: 100 });
const frames = async n => { const f0 = await page.evaluate(() => window.__nmd.frames || 0); await page.waitForFunction(n => (window.__nmd.frames || 0) >= n, f0 + n, { polling: 50 }); };
const cacheIdle = () => page.waitForFunction(() => window.__nmd.texCache.idle(), null, { timeout: 600000, polling: 500 });
const day = d => page.evaluate(d => window.__nmd.send({ t: 'dbg', op: 'day', d }), d);
await built(1);
const code = await page.evaluate(() => window.__nmd.code);
await frames(3);
await cacheIdle();

// ---- 1. a day change right after a build: the learned list of the day before ----
await day(3);
await built(3);
await frames(2);
await day(5);
await built(5);
await frames(2);
await page.waitForTimeout(4000);   // day 5's own learning window (3 s after its second frame) closes
await cacheIdle();
const learned = await page.evaluate(async () => {
  const M = await import('/js/texmanifest.js');
  const snow = JSON.parse(localStorage.getItem('nmdTexDay:snow') || '[]');
  const desert = new Set(M.DAY_TEXTURES.desert), snowShip = new Set(M.DAY_TEXTURES.snow);
  return { snow, desertOnly: snow.filter(n => desert.has(n) && !snowShip.has(n)) };
});
check(!learned.desertOnly.length, `1. snow's learned list (${learned.snow.length}: ${learned.snow.join(' ') || 'empty'}) has no desert textures${learned.desertOnly.length ? `; desert: ${learned.desertOnly.join(' ')}` : ''}`);

// ---- 2. a day change while a day is still loading ----
const arrived = new Promise(r => worldWaiters.push(r));
await day(2);
check((await arrived) === 2, '2. day 2\'s world message arrived');
await page.waitForTimeout(300);   // its build is under way: textures queued, its props list waiting for it
const mid = await page.evaluate(() => ({ stats: window.__nmd.texCache.stats().pending, drop0: window.__nmd.staleDropped || 0 }));
await day(4);
await built(4);
await frames(2);
const after = await page.evaluate(async () => {
  const S = window.__nmd, P = await import('/js/paint/index.js'), T = await import('/js/texprep.js');
  const want = new Set(T.dayList(S.W.biome));
  return {
    superseded: !performance.getEntriesByName('build day 2').length,
    dropped: (S.staleDropped || 0),
    stray: P.adopted().filter(n => !want.has(n)),
    props: [...S.props.keys()].sort((a, b) => a - b), lw: [...S.lw.props.keys()].sort((a, b) => a - b),
    textures: performance.getEntriesByName('textures day 4').map(m => Math.round(m.duration))[0],
  };
});
check(after.superseded, `2. day 2's build was superseded (day 2 still loading when day 4 came: ${JSON.stringify(mid.stats)})`);
check(after.dropped - mid.drop0 >= 1, `2. what came for day 2 was dropped, not applied to day 4 (${after.dropped - mid.drop0} queued messages)`);
check(!after.stray.length, `2. nothing day 4 doesn't want is held ready${after.stray.length ? `: ${after.stray.join(' ')}` : ''} (day 4's textures ready in ${(after.textures / 1000).toFixed(1)} s)`);
// the server's props, read by a probe player
const sv = await new Promise((res, rej) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Probe', room: code })));
  ws.on('message', d => { const m = JSON.parse(String(d)); if (m.t === 'props') { ws.close(); res(m.list.map(p => p.id).sort((a, b) => a - b)); } });
  ws.on('error', rej);
  setTimeout(() => rej(new Error('probe: no props')), 30000);
});
check(JSON.stringify(after.props) === JSON.stringify(sv) && JSON.stringify(after.lw) === JSON.stringify(sv), `2. the client has the server's ${sv.length} props and colliders (client ${after.props.length} props, ${after.lw.length} colliders)`);
await cacheIdle();

check(!errors.length, `page errors: ${errors.join(' | ') || 'none'}`);
await browser.close();
process.exit(failed ? 1 : 0);
