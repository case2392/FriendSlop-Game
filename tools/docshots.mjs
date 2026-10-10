// Captures the README screenshots into docs/screenshots/. Two clients: Dave
// holds the camera, Steve (and sometimes Dave) acts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);   // Chromium refuses these
let PORT; do PORT = 5200 + Math.floor(Math.random() * 300); while (UNSAFE_PORTS.has(PORT));
const OUT = 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 8000); });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const want = n => !ONLY || ONLY.has(n);
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);   // software GL: the first world build can take ~30 s per client
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  await page.goto(`http://localhost:${PORT}`, { timeout: 240000 });
  await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  await page.fill('#nameInput', name);
  return page;
}
const ready = p => p.waitForFunction(() => window.__nmd?.W && window.__nmd?.rv && (window.__nmd.frames || 0) > 30, null, { timeout: 400000 });
const quiet = p => p.evaluate(() => { const S = window.__nmd; S.noRender = true; S.forceLock = true; document.getElementById('clickToPlay').classList.add('hidden'); document.getElementById('toasts').style.display = 'none'; });
const ev = (p, fn, arg) => p.evaluate(fn, arg);
// wait at least `ms` AND at least `n` game frames: on software GL a client can run under 1 fps, and it reads
// aim and input, sends its pose and draws teleports only once per frame
const wait = async (p, ms, n = 3) => {
  const f0 = await p.evaluate(() => window.__nmd?.frames || 0);
  await p.waitForTimeout(ms);
  await p.waitForFunction(f => (window.__nmd?.frames || 0) >= f, f0 + n, { timeout: 180000 });
};
// until Dave's copy of Steve stands where Steve really is (snapshots reach a slow page late)
const daveSeesSteve = async () => {
  const p = await steve.evaluate(() => window.__nmd.me.pos);
  await dave.waitForFunction(([x, z]) => [...window.__nmd.views.values()].some(v => v.group.visible && Math.hypot(v.group.position.x - x, v.group.position.z - z) < 1.0), [p.x, p.z], { timeout: 180000 }).catch(() => console.log('  (Dave never saw Steve at his spot)'));
};
async function shot(p, name, { hud = true, settle = 1100 } = {}) {
  // (the use prompt never shows: it reads as a UI bug in a still)
  await p.evaluate(h => { window.__nmd.noRender = false; for (const id of ['hud', 'roster', 'prompt', 'voiceDock', 'heldLabel', 'stamina']) { const e = document.getElementById(id); if (e) e.style.visibility = h && id !== 'prompt' ? '' : 'hidden'; } }, hud);
  await wait(p, settle, 3);   // fresh frames drawn after the last teleport
  if (name.startsWith('_')) { await p.evaluate(() => { window.__nmd.noRender = true; }); return; }   // positioning-only steps
  await p.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 86 });
  await p.evaluate(() => { window.__nmd.noRender = true; });
  console.log('📸', name);
}

const steve = await open('Steve');
await steve.fill('#seedInput', '777');
await steve.click('#hostBtn');
await ready(steve);
// stop the host rendering first: on software GL it otherwise starves Dave's page of frames
await quiet(steve);
const code = await steve.evaluate(() => window.__nmd.code);
const dave = await open('Dave');
await dave.fill('#codeInput', code);
await dave.click('#joinBtn');
await ready(dave);
await quiet(steve); await quiet(dave);
await dave.waitForFunction(() => window.__nmd.views.size === 1, null, { timeout: 60000 });
const send = (m) => steve.evaluate(m => window.__nmd.send(m), m);
const W = await steve.evaluate(() => { const W = window.__nmd.W; return { LEN: W.LEN, town: W.town, obstacles: W.obstacles, anchors: W.anchors, camp: W.camp }; });
const roadX = z => steve.evaluate(z => window.__nmd.W.roadX(z), z);
const hAt = (x, z) => steve.evaluate(([x, z]) => window.__nmd.W.heightAt(x, z), [x, z]);

if (want('camp')) { // 1. camp: the crew + the RV + the fire
await ev(steve, () => { const S = window.__nmd; S.me.teleport(-4.2, 0.05, -45.5, 2.4); S.me.pitch = 0; });
await ev(dave, () => { const S = window.__nmd; S.me.teleport(-13.5, 0.05, -52.5, 0); S.aimAt(-3, 1.4, -42); });
await shot(dave, 'camp');

}
if (want('riding')) { // 2. riding: Steve drives, Dave stands at the dinette
await ev(steve, () => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x + 0.25, r.y + 0.1, r.z + 2.0, 0); S.aimAt(r.x + 0.62, r.y + 0.4, r.z + 2.85); });
await ev(dave, () => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.3, r.y + 0.1, r.z - 1.2, 0); S.me.pitch = 0.1; });
await wait(steve, 900);
await ev(steve, () => window.__nmd.press('use'));
await steve.waitForFunction(() => window.__nmd.me.mode === 'seat', null, { timeout: 120000 });
await steve.keyboard.down('w');
await wait(steve, 7000);
await ev(dave, () => { const S = window.__nmd; const q = S.rv.q; S.me.yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)) - 0.12; S.me.pitch = 0.12; });
await shot(dave, 'riding');
await steve.keyboard.up('w');
// brake to a standstill before getting up: the RV keeps rolling without a driver, and on software GL
// the throttle is held long enough that a fixed brake time left it coasting down the road into the
// later shots (Dave was teleported onto it at the gate and knocked out)
await steve.keyboard.down(' ');
await wait(steve, 1500);
await steve.waitForFunction(() => { const r = window.__nmd.rv; return r && Math.hypot(r.v.x, r.v.z) < 0.3; }, null, { timeout: 120000, polling: 250 }).catch(() => console.log('  (the RV never came to a stop)'));
await steve.keyboard.up(' ');
await ev(steve, () => window.__nmd.press('use'));
await wait(steve, 600);
console.log('after riding: rv', JSON.stringify(await steve.evaluate(() => ({ z: window.__nmd.rv.p.z, v: Math.hypot(window.__nmd.rv.v.x, window.__nmd.rv.v.z) }))));

}
if (want('map')) { // 3. the map, from the passenger side
await ev(steve, () => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.1, r.y + 0.1, r.z + 2.25, 0); });
await wait(steve, 900);
await ev(steve, () => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); S.aimAt(m.pose.p.x, m.pose.p.y, m.pose.p.z); });
await wait(steve, 300);
await ev(steve, () => window.__nmd.press('grab'));
await wait(steve, 800);
await ev(steve, () => { window.__nmd.me.pitch = 0.12; });
await shot(steve, 'map');
await ev(steve, () => window.__nmd.press('release'));

}
if (want('carrying')) { // 4. carrying a TV down the road
{
  const z = 150, x = (await roadX(z)) + 2, y = await hAt(x, z);
  await send({ t: 'dbg', op: 'spawn', type: 'tv', x, y: y + 0.6, z, value: 260 });
  await ev(steve, ([x, y, z]) => { window.__nmd.me.teleport(x - 1.6, y + 0.1, z, Math.PI / 2); }, [x, y, z]);
  await wait(steve, 1500);
  await ev(steve, () => { const S = window.__nmd; const tv = [...S.props.values()].find(p => p.type === 'tv' && Math.abs(p.pose.p.z - 150) < 3); S.aimAt(tv.pose.p.x, tv.pose.p.y, tv.pose.p.z); });
  await wait(steve, 300);
  await ev(steve, () => window.__nmd.press('grab'));
  await wait(steve, 900);
  await ev(steve, () => { const S = window.__nmd; S.me.yaw = 0; S.me.pitch = 0.1; });
  await wait(steve, 1200);
  const z2 = 157, x2 = await roadX(z2);
  await ev(dave, ([x, y, z]) => { const S = window.__nmd; S.me.teleport(x, y + 0.1, z, Math.PI); }, [x2 - 1, await hAt(x2 - 1, z2), z2]);
  await wait(dave, 700);
  await daveSeesSteve();
  await ev(dave, () => { const S = window.__nmd; const v = [...S.views.values()][0]; S.aimAt(v.group.position.x, v.group.position.y + 1.1, v.group.position.z); });
  await shot(dave, 'carrying');
  await ev(steve, () => window.__nmd.press('release'));
}

}
if (want('rim-code')) { // 6. the ranger gate, and the code painted up on the rim
{
  const gate = W.obstacles.find(o => o.type === 'gate');
  if (gate) {
    const gz = gate.z - 13, gx = await roadX(gz);
    await ev(dave, ([x, y, z, gx2, gz2]) => { const S = window.__nmd; S.me.teleport(x, y + 0.05, z, 0); S.aimAt(gx2, y + 1.6, gz2); }, [gx - 1.5, await hAt(gx - 1.5, gz), gz, await roadX(gate.z), gate.z]);
    await ev(steve, ([x, y, z]) => { window.__nmd.me.teleport(x, y + 0.05, z, 0); }, [(await roadX(gate.z - 2.5)) - 4.4, await hAt((await roadX(gate.z - 2.5)) - 4.4, gate.z - 2.5), gate.z - 2.5]);
    await shot(dave, '_gate');
    const c = gate.codeAt;
    await ev(dave, c => { const S = window.__nmd; S.me.teleport(c.x - 2.2, c.y + 0.1, c.z - 2.2, 0); S.aimAt(c.x, c.y, c.z); }, c);
    await shot(dave, 'rim-code');
  }
}

console.log('before winch: dave', JSON.stringify(await dave.evaluate(() => ({ par: window.__nmd.me.par, pos: window.__nmd.me.pos, ko: window.__nmd.me.koLog?.length || 0, rv: window.__nmd.rv && { z: window.__nmd.rv.p.z, v: Math.hypot(window.__nmd.rv.v.x, window.__nmd.rv.v.z) } }))));
}
if (want('winch')) { // 7. the winch: RV at the foot of the grade, hook up top, cable taut
{
  const grade = W.obstacles.find(o => o.type === 'grade');
  const rz = grade.z0 - 7, rx = await roadX(rz);
  await send({ t: 'dbg', op: 'tpRV', x: rx, z: rz, yaw: 0 });
  await wait(steve, 1500);
  await ev(steve, () => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x, S.W.heightAt(r.x, r.z + 5.4) + 0.05, r.z + 5.4, Math.PI); S.me.pitch = 0.5; });
  await wait(steve, 900);
  await steve.waitForFunction(() => /winch hook/.test(window.__nmd.target()?.label || ''), null, { timeout: 120000 }).catch(() => {});
  console.log('  winch target:', await steve.evaluate(() => window.__nmd.target()?.label));
  await ev(steve, () => window.__nmd.press('use'));
  await wait(steve, 700);
  await steve.waitForFunction(() => window.__nmd.me.hasHook || (window.__nmd.hook?.state || 0) !== 0, null, { timeout: 120000 }).catch(() => {});
  console.log('  hasHook:', await steve.evaluate(() => window.__nmd.me.hasHook), 'hook', JSON.stringify(await steve.evaluate(() => window.__nmd.hook)));
  const anc = W.anchors[0];
  for (let i = 1; i <= 12; i++) {
    await ev(steve, ([ax, az, f]) => { const S = window.__nmd; const r = S.rv.p; const x = r.x + (ax - 0.9 - r.x) * f, z = r.z + 5.4 + (az - 0.9 - r.z - 5.4) * f; S.me.teleport(x, S.W.heightAt(x, z) + 0.1, z, 0); }, [anc.x, anc.z, i / 12]);
    await wait(steve, 250);
  }
  await wait(steve, 800);
  await steve.waitForFunction(() => /hook the winch/.test(window.__nmd.target()?.label || ''), null, { timeout: 120000 }).catch(() => {});
  console.log('  anchor target:', await steve.evaluate(() => window.__nmd.target()?.label));
  await ev(steve, () => window.__nmd.press('use'));
  await wait(steve, 800);
  await steve.waitForFunction(() => window.__nmd.hook?.state === 2, null, { timeout: 120000 }).catch(() => {});
  console.log('  hook after anchor', JSON.stringify(await steve.evaluate(() => window.__nmd.hook)));
  const camX = rx - 11, camZ = rz - 7;
  await ev(dave, ([x, y, z, tx, ty, tz]) => { const S = window.__nmd; S.me.teleport(x, y + 0.1, z, 0); S.aimAt(tx, ty, tz); }, [camX, await hAt(camX, camZ), camZ, rx + 1, (await hAt(rx, rz + 10)) + 1.5, rz + 13]);
  await shot(dave, 'winch');
}

}
if (want('town')) {
// 8. town at sunset, casino, pawn, the Repo Man
await send({ t: 'dbg', op: 'tpRV', x: 0, z: W.LEN + 6, yaw: 0 });
await send({ t: 'dbg', op: 'phase', ph: 'road' });
await send({ t: 'dbg', op: 'clock', h: 18.4 });
await send({ t: 'dbg', op: 'bank', v: 3100 });
await steve.waitForFunction(() => window.__nmd.g?.town === 1, null, { timeout: 120000 });
const T = W.town;
await ev(dave, T => { const S = window.__nmd; S.me.teleport(4.5, T.y + 0.05, T.z - 6, 0); S.aimAt(3, T.y + 2.6, T.z + 70); }, T);
await ev(steve, T => { const S = window.__nmd; S.me.teleport(3.5, T.y + 0.05, T.z + 26, Math.PI); }, T);
await shot(dave, '_town');
await ev(steve, T => { const S = window.__nmd; S.me.teleport(T.repo.x - 7.5, T.y + 0.05, T.repo.z - 3.5, 0); S.aimAt(T.repo.x - 0.8, T.y + 1.5, T.repo.z + 0.3); }, T);
await shot(steve, 'repo-man');
{
  await ev(steve, T => { const S = window.__nmd; const u = S.W.uses.find(u => u.kind === 'bj' && u.arg === '+500'); S.me.teleport(u.x - 1.3, T.y + 0.05, u.z, Math.PI / 2); }, T);
  await wait(steve, 900);
  for (const arg of ['+500', '+500', '+500', 'deal']) { await ev(steve, arg => { const S = window.__nmd; const u = S.W.uses.find(u => u.kind === 'bj' && u.arg === arg); S.send({ t: 'use', id: u.id }); }, arg); await wait(steve, 250); }
  await ev(steve, T => { const S = window.__nmd; const h = T.bj.hit; S.me.teleport(h.x, T.y + 0.05, h.z, 0); S.aimAt(T.bj.table.x, T.bj.table.y, T.bj.table.z); }, T);
  await ev(dave, T => { const S = window.__nmd; const s = T.bj.stand; S.me.teleport(s.x + 2.4, T.y + 0.05, s.z + 2.2, 0); S.aimAt((T.bj.hit.x + T.bj.table.x) / 2, T.bj.table.y + 0.1, (T.bj.hit.z + T.bj.table.z) / 2); }, T);
  await shot(dave, 'casino');
}
await send({ t: 'dbg', op: 'spawn', type: 'vase', x: T.pawn.x, y: T.pawn.y + 0.4, z: T.pawn.z - 1.4, value: 520 });
await send({ t: 'dbg', op: 'spawn', type: 'neon', x: T.pawn.x, y: T.pawn.y + 0.4, z: T.pawn.z + 1.0, value: 380 });
await send({ t: 'dbg', op: 'spawn', type: 'painting', x: T.pawn.x, y: T.pawn.y + 0.4, z: T.pawn.z - 0.2, value: 450 });
await ev(steve, T => { const S = window.__nmd; S.me.teleport(T.pawn.x + 3.6, T.y + 0.05, T.pawn.z + 0.4, -Math.PI / 2); S.aimAt(T.pawn.x - 1.2, T.pawn.y + 0.5, T.pawn.z - 0.2); }, T);
await steve.waitForFunction(() => (window.__nmd.g?.pawn || 0) > 0, null, { timeout: 120000 });
await shot(steve, 'pawn');

// 9. night at the RV lot
await send({ t: 'dbg', op: 'bank', v: 9000 });
const pay = await steve.evaluate(() => window.__nmd.W.uses.find(u => u.kind === 'pay'));
await ev(steve, ([u, T]) => { window.__nmd.me.teleport(u.x + 1, T.y + 0.05, u.z, 0); }, [pay, T]);
await wait(steve, 900);
await send({ t: 'use', id: pay.id });
await steve.waitForFunction(() => window.__nmd.g?.ph === 'night', null, { timeout: 120000 });
await wait(steve, 1500);
await ev(dave, T => { const S = window.__nmd; document.getElementById('receipt').classList.add('hidden'); S.me.teleport(T.fire.x - 4.5, T.y + 0.05, T.fire.z - 5.5, 0); S.aimAt(T.fire.x + 4, T.y + 1.0, T.fire.z + 3); }, T);
await ev(steve, T => { const S = window.__nmd; S.me.teleport(T.fire.x + 1.6, T.y + 0.05, T.fire.z - 1.2, -0.8); }, T);
await shot(dave, 'night');
await ev(steve, () => document.getElementById('receipt').classList.remove('hidden'));
await shot(steve, '_receipt');

}
// 5. climbing a canyon wall: shot on day 4, where the badlands walls are steep banded rock (day 1's meadow walls
// are grassy hills, and a climb up one doesn't read)
async function climbShot() {
  const wall = await steve.evaluate(() => {
    const W = window.__nmd.W;
    // the steepest face (it paints as bare rock) that still rises 6 m, left of the road: every biome's walls differ
    let best = null;
    for (let z = 200; z < 520; z += 5) {
      if (W.obstacles.some(o => Math.abs(o.z - z) < 30) || W.pois.some(p => Math.abs(p.z - z) < 25)) continue;   // gates, stops: props in the way
      const rx = W.roadX(z);
      for (let d = 10; d < 60; d += 0.5) { const x = rx + d, h = W.heightAt(x, z), s1 = W.heightAt(x + 1, z) - h; if (W.heightAt(x + 12, z) - h > 6 && (!best || s1 > best.s1)) best = { x: x - 0.9, z, base: h, s1 }; }
    }
    return best;
  });
  await ev(steve, w => { const S = window.__nmd; S.me.teleport(w.x, w.base + 0.2, w.z, Math.PI / 2); S.me.pitch = -0.25; S.me.stamina = 100; }, wall);
  await wait(steve, 600);
  await steve.mouse.down(); await steve.keyboard.down('w');
  await wait(steve, 2800);
  await steve.waitForFunction(b => window.__nmd.me.pos.y > b + 2.5, wall.base, { timeout: 240000 }).catch(() => console.log('  (Steve did not get 2.5 m up the wall)'));
  await steve.keyboard.up('w');
  // Dave watches from the valley floor (nobody can stand on the face itself: he'd slide down it)
  await ev(dave, w => { const S = window.__nmd; const W = S.W; const x = w.x - 10, z = w.z - 7; S.me.teleport(x, W.heightAt(x, z) + 0.1, z, 0); }, wall);
  await wait(dave, 600);
  await daveSeesSteve();
  await ev(dave, () => { const S = window.__nmd; const v = [...S.views.values()][0]; S.aimAt(v.group.position.x, v.group.position.y + 1.4, v.group.position.z); S.me.pitch -= 0.08; });
  await shot(dave, 'climbing');
  await ev(steve, () => { window.__nmd.me.pitch = 0.95; window.__nmd.me.yaw += Math.PI; });
  await shot(steve, '_climbing-fp');
  await steve.mouse.up();
}

if (want('biomes') || want('climbing')) { // 10. one road view per biome after the first: days 2 (fields), 3 (snow), 4 (badlands), 5 (desert); the climb on day 4
  for (const [day, name] of [[2, 'fields'], [3, 'snow'], [4, 'badlands'], [5, 'desert']]) {
    if (!want('biomes') && day !== 4) continue;
    await send({ t: 'dbg', op: 'day', d: day });
    for (const p of [steve, dave]) await p.waitForFunction(d => window.__nmd.W?.day === d && window.__nmd.lw, day, { timeout: 180000 });
    await send({ t: 'dbg', op: 'clock', h: 10.5 });
    await wait(dave, 1500);
    const z = 95, x = (await roadX(z)) - 1.4;
    const tz = z + 55, tx = await roadX(tz);
    await ev(steve, ([x, z]) => { const S = window.__nmd; S.me.teleport(x, S.W.heightAt(x, z) + 0.05, z, Math.PI); }, [x + 2.6, z + 8]);
    await ev(dave, ([x, z, tx, ty, tz]) => { const S = window.__nmd; S.me.teleport(x, S.W.heightAt(x, z) + 0.05, z, 0); S.aimAt(tx, ty, tz); }, [x, z, tx, (await hAt(tx, tz)) + 1.8, tz]);
    if (want('biomes')) await shot(dave, `biome-${name}`, { hud: false });
    if (day === 4 && want('climbing')) await climbShot();
  }
}
console.log('dave KOs', JSON.stringify(await dave.evaluate(() => ({ log: window.__nmd.me.koLog, fall: window.__nmd.me.lastFall, crash: window.__nmd.me.lastCrash }))));
console.log('steve KOs', JSON.stringify(await steve.evaluate(() => ({ log: window.__nmd.me.koLog, fall: window.__nmd.me.lastFall }))));
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(0);
