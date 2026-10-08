// Browser smoke test: two real Chromium clients in one room. Verifies the
// client end-to-end (rendering, controller, riding a moving RV, seeing each
// other) and captures the doc screenshots. Fails on any page error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { insideRV, toLocal } from '../shared/rv.js';

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);   // Chromium refuses these
let PORT; do PORT = 4700 + Math.floor(Math.random() * 400); while (UNSAFE_PORTS.has(PORT));
const SHOTS = process.env.SHOTS || 'test/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('server never started')), 8000); });

const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);   // software GL: the first world build can take ~30 s per client
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}`, { timeout: 240000 });
  await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  await page.fill('#nameInput', name);
  return page;
}
const ready = p => p.waitForFunction(() => window.__nmd?.W && window.__nmd?.rv && (window.__nmd.frames || 0) > 30, null, { timeout: 270000 });
const quiet = p => p.evaluate(() => { const S = window.__nmd; S.noRender = true; S.forceLock = true; document.getElementById('clickToPlay').classList.add('hidden'); });
const shot = async (p, name, settle = 900) => { await p.evaluate(() => { window.__nmd.noRender = false; }); await p.waitForTimeout(settle); await p.screenshot({ path: `${SHOTS}/${name}.png` }); await p.evaluate(() => { window.__nmd.noRender = true; }); console.log('  📸', name); };
const me = p => p.evaluate(() => { const S = window.__nmd, m = S.me; return { mode: m.mode, par: m.par, seat: m.seat, pos: m.pos, lp: m.lp, rv: S.rv && { p: S.rv.p, q: S.rv.q }, g: S.g && { ph: S.g.ph, day: S.g.day, bank: S.g.bank } }; });
// wait at least `ms` AND at least 3 rendered frames: the game reads aim and input once per frame, and
// software GL renders the new art at about 1 fps with two clients, so wall-clock waits alone race it
const wait = async (p, ms, n = 3) => {
  const f0 = await p.evaluate(() => window.__nmd?.frames || 0);
  await p.waitForTimeout(ms);
  await p.waitForFunction(f => (window.__nmd?.frames || 0) >= f, f0 + n, { timeout: 180000 });
};

try {
  // ---- menu ----
  const host = await open('Steve');
  await wait(host, 400);
  await host.screenshot({ path: `${SHOTS}/menu.png` });
  await host.fill('#seedInput', '777');
  await host.click('#hostBtn');
  await ready(host);
  const code = await host.evaluate(() => window.__nmd.code);
  check(/^[A-Z0-9]{4}$/.test(code), `hosted a trip (code ${code})`);
  const joiner = await open('Dave');
  await joiner.fill('#codeInput', code);
  await joiner.click('#joinBtn');
  await ready(joiner);
  ok('second player joined through the menu');
  await quiet(host); await quiet(joiner);
  await host.waitForFunction(() => window.__nmd.views.size === 1, null, { timeout: 60000 });
  await joiner.waitForFunction(() => window.__nmd.views.size === 1, null, { timeout: 60000 });
  ok('each client renders the other player');

  // ---- camp screenshot: Dave looks at Steve and the RV ----
  await host.evaluate(() => { const S = window.__nmd; S.me.teleport(-3.5, 0.05, -38, 0); });
  await joiner.evaluate(() => { const S = window.__nmd; S.me.teleport(-8, 0.05, -33.5, 0); S.aimAt(-2.5, 1.2, -40); });
  await wait(host, 1200);
  await shot(joiner, 'camp');

  // ---- Dave rides inside, Steve drives ----
  await joiner.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.4, r.y + 0.1, r.z - 0.6, 0); S.me.pitch = 0.05; });
  await host.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x + 0.25, r.y + 0.1, r.z + 2.0, 0); S.aimAt(r.x + 0.62, r.y + 0.4, r.z + 2.85); });
  await wait(host, 900);
  await host.waitForFunction(() => window.__nmd.target()?.use === 'seat0', null, { timeout: 60000 });
  await host.evaluate(() => window.__nmd.press('use'));
  await host.waitForFunction(() => window.__nmd.me.mode === 'seat', null, { timeout: 24000 });
  ok('Steve is in the driver seat');
  const before = await me(joiner);
  check(before.par === 1, 'Dave is standing inside the RV (parented to it)');
  await host.keyboard.down('w');
  await wait(host, 5000);
  await host.keyboard.up('w');
  const during = await me(joiner);
  const moved = Math.hypot(during.rv.p.x - before.rv.p.x, during.rv.p.z - before.rv.p.z);
  const l = toLocal(during.rv.p, during.rv.q, during.pos);
  check(moved > 12 && during.par === 1 && insideRV(l.x, l.y, l.z), `the RV drove ${moved.toFixed(1)} m and Dave rode along inside it (local ${l.x.toFixed(2)}, ${l.y.toFixed(2)}, ${l.z.toFixed(2)})`);
  // what does Steve see of Dave? his view should be inside the RV too
  const daveOnSteve = await host.evaluate(() => { const S = window.__nmd; const v = [...S.views.values()][0]; return { p: v.group.position, rv: S.rv }; });
  const l2 = toLocal(daveOnSteve.rv.p, daveOnSteve.rv.q, daveOnSteve.p);
  check(insideRV(l2.x, l2.y, l2.z, 0.2), `on Steve's screen Dave is inside the RV too (local ${l2.x.toFixed(2)}, ${l2.y.toFixed(2)}, ${l2.z.toFixed(2)})`);
  await host.keyboard.down('w');
  await joiner.evaluate(() => { const S = window.__nmd; S.me.yaw = Math.atan2(2 * (S.rv.q.w * S.rv.q.y + S.rv.q.x * S.rv.q.z), 1 - 2 * (S.rv.q.y ** 2 + S.rv.q.x ** 2)); S.me.pitch = 0.08; });
  await shot(joiner, 'riding');
  await host.keyboard.up('w');
  await host.keyboard.down(' '); await wait(host, 1200); await host.keyboard.up(' ');
  await host.evaluate(() => window.__nmd.press('use'));
  await host.waitForFunction(() => window.__nmd.me.mode === 'walk', null, { timeout: 24000 });
  ok('Steve got up from the wheel');

  // ---- carry a TV in the open ----
  await host.evaluate(() => { const S = window.__nmd; const W = S.W; const z = 140, x = W.roadX(z) + 2; S.send({ t: 'dbg', op: 'spawn', type: 'tv', x, y: W.heightAt(x, z) + 0.6, z, value: 260 }); S.me.teleport(x - 1.6, W.heightAt(x - 1.6, z) + 0.1, z, Math.PI / 2); });
  await wait(host, 1500);
  await host.evaluate(() => { const S = window.__nmd; const tv = [...S.props.values()].find(p => p.type === 'tv' && Math.abs(p.pose.p.z - 140) < 3); S.aimAt(tv.pose.p.x, tv.pose.p.y, tv.pose.p.z); });
  await wait(host, 300);
  await host.evaluate(() => window.__nmd.press('grab'));
  await wait(host, 1200);
  await host.evaluate(() => { const S = window.__nmd; S.me.pitch = 0.05; });
  await wait(host, 900);
  const holding = await host.evaluate(() => window.__nmd.me.holding);
  check(holding?.type === 'tv', 'Steve picked up the CRT TV');
  await joiner.evaluate(() => { const S = window.__nmd; const W = S.W; const z = 146, x = W.roadX(z) + 1; S.me.teleport(x, W.heightAt(x, z) + 0.1, z, Math.PI); });
  await wait(joiner, 600);
  await joiner.evaluate(() => { const S = window.__nmd; const v = [...S.views.values()][0]; S.aimAt(v.group.position.x, v.group.position.y + 1.2, v.group.position.z); });
  await shot(joiner, 'carrying');
  await shot(host, 'carrying-fp');
  await host.evaluate(() => window.__nmd.press('release'));

  // ---- climbing ----
  const wall = await host.evaluate(() => {
    const W = window.__nmd.W;
    for (let z = 160; z < 500; z += 5) {
      const rx = W.roadX(z);
      for (let d = 10; d < 60; d += 0.5) { const x = rx + d; if (W.heightAt(x + 1, z) - W.heightAt(x, z) > 2.2 && W.heightAt(x + 12, z) - W.heightAt(x, z) > 9) return { x: x - 0.9, z, base: W.heightAt(x, z) }; }
    }
    return null;
  });
  await host.evaluate(w => { const S = window.__nmd; S.me.teleport(w.x, w.base + 0.2, w.z, Math.PI / 2); S.me.pitch = -0.2; S.me.stamina = 100; }, wall);
  await wait(host, 600);
  await host.mouse.down();
  await host.keyboard.down('w');
  // climbing moves per frame (dt is capped at 50 ms), so hold W until he is up there, not for a fixed time
  await wait(host, 2600);
  await host.waitForFunction(b => { const m = window.__nmd.me; return m.mode !== 'climb' || m.pos.y > b + 3.2; }, wall.base, { timeout: 180000 }).catch(() => {});
  await host.keyboard.up('w');
  const climbing = await me(host);
  check(climbing.mode === 'climb' && climbing.pos.y > wall.base + 3, `Steve is climbing the canyon wall (${(climbing.pos.y - wall.base).toFixed(1)} m up)`);
  await joiner.evaluate(w => { const S = window.__nmd; const W = S.W; const x = w.x - 9, z = w.z - 6; S.me.teleport(x, W.heightAt(x, z) + 0.1, z, 0); }, wall);
  await wait(joiner, 500);
  await joiner.evaluate(() => { const S = window.__nmd; const v = [...S.views.values()][0]; S.aimAt(v.group.position.x, v.group.position.y + 0.8, v.group.position.z); });
  await shot(joiner, 'climbing');
  await host.evaluate(() => { window.__nmd.me.pitch = 0.9; window.__nmd.me.yaw += Math.PI; });
  await shot(host, 'climbing-fp');
  await host.mouse.up();

  // ---- the map ----
  await host.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.1, r.y + 0.1, r.z + 2.25, 0); });
  await wait(host, 900);
  await host.evaluate(() => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); S.aimAt(m.pose.p.x, m.pose.p.y, m.pose.p.z); });
  await wait(host, 300);
  await host.evaluate(() => window.__nmd.press('grab'));
  await wait(host, 900);
  check((await host.evaluate(() => window.__nmd.me.holding?.type)) === 'map', 'Steve took the road map off the dash');
  await host.evaluate(() => { window.__nmd.me.pitch = 0.1; });
  await shot(host, 'map');
  await host.evaluate(() => window.__nmd.press('release'));

  // ---- town ----
  await host.evaluate(() => { const S = window.__nmd; S.send({ t: 'dbg', op: 'tpRV', x: 0, z: S.W.LEN + 6, yaw: 0 }); S.send({ t: 'dbg', op: 'clock', h: 18.6 }); S.send({ t: 'dbg', op: 'phase', ph: 'road' }); S.send({ t: 'dbg', op: 'bank', v: 2600 }); });
  await host.waitForFunction(() => window.__nmd.g?.town === 1, null, { timeout: 45000 });
  ok('rolled into town');
  const T = await host.evaluate(() => window.__nmd.W.town);
  await joiner.evaluate(T => { const S = window.__nmd; S.me.teleport(-3, T.y + 0.05, T.z + 8, 0); S.aimAt(4, T.y + 2.2, T.z + 60); }, T);
  await host.evaluate(T => { const S = window.__nmd; S.me.teleport(4, T.y + 0.05, T.z + 30, 0); }, T);
  await wait(joiner, 900);
  await shot(joiner, 'town');
  // blackjack: Steve bets and deals, both vote on the pads
  await host.evaluate(T => { const S = window.__nmd; const u = S.W.uses.find(u => u.kind === 'bj' && u.arg === '+500'); S.me.teleport(u.x - 1.3, T.y + 0.05, u.z, Math.PI / 2); }, T);
  await wait(host, 900);
  await host.evaluate(() => { window.__nmd.bets = 0; });
  for (const arg of ['+500', '+500', 'deal']) {
    await host.evaluate(arg => { const S = window.__nmd; const u = S.W.uses.find(u => u.kind === 'bj' && u.arg === arg); S.send({ t: 'use', id: u.id }); }, arg);
    await wait(host, 250);
  }
  await host.waitForFunction(() => window.__nmd.g?.bj?.st === 'vote' || window.__nmd.g?.bj?.st === 'result', null, { timeout: 24000 });
  ok('blackjack hand dealt for $1,000 of the shared bank');
  await host.evaluate(T => { const S = window.__nmd; const h = T.bj.hit; S.me.teleport(h.x, T.y + 0.05, h.z, 0); S.aimAt(T.bj.table.x, T.bj.table.y, T.bj.table.z); }, T);
  await joiner.evaluate(T => { const S = window.__nmd; const s = T.bj.stand; S.me.teleport(s.x + 0.4, T.y + 0.05, s.z + 0.5, 0); S.aimAt(T.bj.hit.x, T.bj.table.y, T.bj.hit.z); }, T);
  await wait(joiner, 700);
  await shot(joiner, 'casino');
  await host.waitForFunction(() => (window.__nmd.bets || 0) > 0, null, { timeout: 135000 })
    .catch(async e => { throw new Error(`hand never resolved: ${JSON.stringify(await host.evaluate(() => window.__nmd.g?.bj))}`); });
  const out = await host.evaluate(() => window.__nmd.lastBet);
  ok(`the hand resolved by body-vote: ${out.won > 0 ? 'won' : out.won < 0 ? 'lost' : 'push'} ${out.won}`);
  // pawn shop
  await host.evaluate(T => { const S = window.__nmd; S.send({ t: 'dbg', op: 'spawn', type: 'vase', x: T.pawn.x, y: T.pawn.y + 0.6, z: T.pawn.z - 1.2, value: 520 }); S.send({ t: 'dbg', op: 'spawn', type: 'neon', x: T.pawn.x, y: T.pawn.y + 0.6, z: T.pawn.z + 0.8, value: 380 }); S.me.teleport(T.pawn.x + 3.4, T.y + 0.05, T.pawn.z + 0.5, -Math.PI / 2); S.aimAt(T.pawn.x - 1.5, T.pawn.y + 0.3, T.pawn.z - 0.2); }, T);
  await host.waitForFunction(() => (window.__nmd.g?.pawn || 0) > 0, null, { timeout: 24000 });
  await wait(host, 800);
  await shot(host, 'pawn');
  // the Repo Man
  await host.evaluate(T => { const S = window.__nmd; S.me.teleport(T.repo.x - 3, T.y + 0.05, T.repo.z - 9, 0); S.aimAt(T.repo.x + 1, T.y + 1.6, T.repo.z); }, T);
  await wait(host, 800);
  await shot(host, 'repo-man');

  // ---- voice: both join, the WebRTC mesh connects, panners exist ----
  await host.evaluate(() => document.getElementById('voiceJoinBtn').click());
  await joiner.evaluate(() => document.getElementById('voiceJoinBtn').click());
  await host.waitForFunction(() => { const p = [...window.__nmd.voicePeers?.() || []]; return p.length === 1 && p[0].panner; }, null, { timeout: 60000 }).catch(() => {});
  const vstate = await host.evaluate(() => ({ on: window.__nmdVoice?.on, peers: window.__nmdVoice ? [...window.__nmdVoice.peers.values()].map(p => ({ state: p.pc.connectionState, spatial: !!p.panner })) : null }));
  check(vstate.on && vstate.peers?.length === 1 && vstate.peers[0].spatial, `proximity voice mesh up (${JSON.stringify(vstate.peers)})`);
} catch (e) {
  fail(e.stack || e.message);
}
const real = errors.filter(e => !/favicon|404/.test(e));
check(real.length === 0, real.length ? `page errors:\n${real.join('\n')}` : 'no page errors');
await browser.close();
console.log(failed ? '\n💥 BROWSER SMOKE TEST FAILED' : '\n🎉 BROWSER SMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
