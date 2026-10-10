// A day takes seconds to load (its textures get ready before the build, main.js prepareDay), and the
// messages that come in meanwhile must land on the new world in the order they came. Two rounds:
//  1. a second player joins; while the joiner's day loads, a vase smashes, a safe takes a dent and
//     the clock runs into midnight broke, so the Repo Man takes the RV's doors;
//  2. a new day starts (day 3: not the day the night got ready, so it loads in full); while both
//     clients load it, a vase smashes and a safe takes a dent.
// After each round, both clients must match the server (a probe socket joins and reads its props list
// and parts): the same props (no ghost of the vase with a local collider), the same values, the same
// parts. And the toasts that came during a load must go up after it, not run out under the loading
// screen. The drops and the clock come from a probe player's debug messages (the server runs with
// FRIENDSLOP_TEST), aimed with the world generated here, so no client's main thread is involved.
// Works on any checkout (it finds the world messages with a WebSocket hook), for before/after runs.
//   node tools/joinrace.mjs [root] [--delay ms]     exit code 1 when a client and the server disagree
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || path.join(HERE, '..'));
const DELAY = Number(opt('--delay', 500));
const SEED = '777';
const require = createRequire(path.join(HERE, '..', 'package.json'));
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { generateLeg } = await import(pathToFileURL(path.join(ROOT, 'shared/world.js')).href);
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 5200 + Math.floor(Math.random() * 400); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('server never started')), 60000); });

const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
let failed = false;
const check = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = x => JSON.stringify(x);

// a page that logs when each message arrives (page clock) and when each toast goes up, and tells this
// script the moment a world message arrives
const worldWaiters = new Map();
const open = async tag => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });   // a fresh profile: no texture cache
  const p = await ctx.newPage();
  p.setDefaultTimeout(600000);
  p.on('pageerror', e => errors.push(`[${tag}] ${e.message}`));
  await p.exposeFunction('__worldArrived', () => { const w = worldWaiters.get(tag); worldWaiters.delete(tag); w?.(Date.now()); });
  await p.addInitScript(() => {
    window.__race = { msgs: [], toasts: [] };
    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', e => {   // runs before the game's own handler (set later)
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'world') window.__worldArrived();
          if (m.t !== 's') window.__race.msgs.push({ t: m.t, k: m.list?.map(x => x.k), at: performance.now() });
        });
      }
    };
    addEventListener('DOMContentLoaded', () => {
      const box = document.getElementById('toasts');
      if (box) new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) window.__race.toasts.push({ text: n.textContent, at: performance.now() }); }).observe(box, { childList: true });
    });
  });
  await p.goto(`http://localhost:${PORT}`);
  await p.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  return p;
};
const nextWorld = tag => new Promise(r => worldWaiters.set(tag, r));
const built = (p, day, after = 0) => p.waitForFunction(([d, a]) => { const S = window.__nmd; return S?.W?.day === d && S.lw && (S.builtAt ?? Infinity) > a && (S.frames || 0) > 2; }, [day, after], { polling: 200 });

// a socket player: debug messages, and what the server has (a fresh one joins, reads, leaves)
const socket = code => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`), seen = [], waits = [];
  const waitFor = (pred, ms = 30000) => new Promise((ok, no) => {
    const hit = seen.find(pred);
    if (hit) return ok(hit);
    waits.push({ pred, ok });
    setTimeout(() => no(new Error('timed out')), ms);
  });
  ws.on('open', () => { ws.send(J({ t: 'join', name: 'Probe', room: code })); res({ ws, seen, waitFor, send: m => ws.send(J(m)) }); });
  ws.on('message', d => { const m = JSON.parse(String(d)); seen.push(m); for (const w of waits.splice(0)) if (w.pred(m)) w.ok(m); else waits.push(w); });
  ws.on('error', rej);
});
const serverState = async code => {
  const s = await socket(code);
  const world = await s.waitFor(m => m.t === 'world'), props = await s.waitFor(m => m.t === 'props');
  s.ws.close();
  return { props: props.list.map(p => [p.id, Math.round(p.value)]).sort((a, b) => a[0] - b[0]), parts: world.parts };
};
const snap = p => p.evaluate(() => {
  const S = window.__nmd;
  return { props: [...S.props.values()].map(p => [p.id, Math.round(p.value)]).sort((a, b) => a[0] - b[0]), lw: [...S.lw.props.keys()].sort((a, b) => a - b), parts: S.parts };
});
// drop a vase from 25 m (it smashes after a dent or two) and a safe from 10 m (a dent) past the camp
const drop = async (probe, W) => {
  const ids = {};
  for (const [type, z, h, value] of [['vase', 30, 25, 520], ['safe', 36, 10, 1300]]) {
    const x = W.roadX(z) + 6, n = probe.seen.length;
    probe.send({ t: 'dbg', op: 'spawn', type, x, y: W.heightAt(x, z) + h, z, value });
    ids[type] = (await probe.waitFor(m => m.t === 'dbg' && m.op === 'spawned' && probe.seen.indexOf(m) >= n)).id;
  }
  return ids;
};
const smashed = (probe, ids, from, round, t0) => probe.waitFor(m => m.t === 'ev' && m.list.some(e => e.k === 'break' && e.id === ids.vase) && probe.seen.indexOf(m) >= from)
  .then(() => console.log(`${round}: vase ${ids.vase} smashed ${((Date.now() - t0) / 1000).toFixed(1)} s after the joiner's world message (safe ${ids.safe})`), () => console.log(`${round}: (the vase did not smash)`));

// both clients against the server, once the props have settled (a dent in flight lands on each a
// moment apart); then what came in while each client loaded, and when its toasts went up
async function compare(round, clients, code, want) {
  let snaps, sv;
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    [sv, ...snaps] = await Promise.all([serverState(code), ...clients.map(([, p]) => snap(p))]);
    if (snaps.every(c => J(c.props) === J(sv.props) && J(c.parts) === J(sv.parts))) break;
  }
  const sIds = sv.props.map(p => p[0]), svv = new Map(sv.props);
  for (const [k, [who, page]] of clients.entries()) {
    const c = snaps[k], ids = c.props.map(p => p[0]);
    const ghosts = ids.filter(i => !svv.has(i)), missing = sIds.filter(i => !ids.includes(i));
    const stale = c.props.filter(([id, v]) => svv.has(id) && svv.get(id) !== v).map(([id, v]) => `${id}: ${v} (server ${svv.get(id)})`);
    check(!ghosts.length && !missing.length, `${round}, ${who}: ${ids.length} props, the server ${sIds.length}; ghosts: [${ghosts.join(' ')}], missing: [${missing.join(' ')}]`);
    check(J(c.lw) === J(ids), `${round}, ${who}: the local colliders match the props (${c.lw.length})`);
    check(!stale.length, `${round}, ${who}: prop values match the server's${stale.length ? `; stale: ${stale.join(', ')}` : ''}`);
    check(J(c.parts) === J(sv.parts), `${round}, ${who}: RV parts match the server's (${J(c.parts)} vs ${J(sv.parts)})`);
    const r = await page.evaluate(() => ({ ...window.__race, builtAt: window.__nmd.builtAt ?? null }));
    const w = r.msgs.filter(m => m.t === 'world').pop();
    if (r.builtAt == null) { console.log(`     ${who}: no builtAt on this checkout (its build runs straight after the world message)`); continue; }
    const kinds = new Set(r.msgs.filter(m => m.at > w.at && m.at < r.builtAt).flatMap(m => (m.t === 'ev' ? m.k.map(x => `ev:${x}`) : [m.t])));
    console.log(`     ${who}: built ${((r.builtAt - w.at) / 1000).toFixed(1)} s after its world message; came in meanwhile: ${[...kinds].join(' ') || 'nothing'}`);
    if (want?.[who]) check(want[who].every(k => kinds.has(k)), `${round}, ${who}: the race was on (${want[who].join(', ')} came in while it loaded)`);
    const early = r.toasts.filter(t => t.at > w.at && t.at < r.builtAt);
    check(!early.length, `${round}, ${who}: the toasts that came during the load went up after it${early.length ? `; under the loading screen: ${early.map(t => J(t.text.slice(0, 40))).join(', ')}` : ''}`);
  }
}

// ---- round 1: a player joins while things happen ----
const host = await open('host');
await host.fill('#nameInput', 'Steve'); await host.fill('#seedInput', SEED); await host.click('#hostBtn');
await built(host, 1);
await host.evaluate(() => { window.__nmd.noRender = true; });
const code = await host.evaluate(() => window.__nmd.code);
const probe = await socket(code);
await probe.waitFor(m => m.t === 'props');
const W1 = generateLeg(Number(SEED), 1), W3 = generateLeg(Number(SEED), 3);
const joiner = await open('joiner');
await joiner.fill('#nameInput', 'Dave'); await joiner.fill('#codeInput', code);
let w = nextWorld('joiner');
await joiner.click('#joinBtn');
let t0 = await w;
await sleep(DELAY);
let from = probe.seen.length, ids = await drop(probe, W1);
probe.send({ t: 'dbg', op: 'bank', v: 0 });
probe.send({ t: 'dbg', op: 'phase', ph: 'road' });
probe.send({ t: 'dbg', op: 'clock', h: 23.999 });
await smashed(probe, ids, from, 'round 1', t0);
await probe.waitFor(m => m.t === 'parts').catch(() => console.log('round 1: (the Repo Man took nothing)'));
await built(joiner, 1);
await joiner.evaluate(() => { window.__nmd.noRender = true; });
await compare('round 1 (join)', [['joiner', joiner], ['host', host]], code, { joiner: ['ev:break', 'ev:dmg', 'parts', 'toast'] });

// ---- round 2: a new day starts while things happen (the drops go out with the day change) ----
const mark = await Promise.all([host, joiner].map(p => p.evaluate(() => window.__nmd.builtAt ?? -1)));
w = nextWorld('joiner');
from = probe.seen.length;
probe.send({ t: 'dbg', op: 'day', d: 3 });
ids = await drop(probe, W3);
t0 = await w;
await smashed(probe, ids, from, 'round 2', t0);
await Promise.all([built(host, 3, mark[0]), built(joiner, 3, mark[1])]);
await compare('round 2 (day 3)', [['joiner', joiner], ['host', host]], code, { joiner: ['ev:break'], host: ['ev:break'] });

check(errors.length === 0, `page errors: ${errors.join(' | ') || 'none'}`);
probe.ws.close();
await browser.close();
process.exit(failed ? 1 : 0);
