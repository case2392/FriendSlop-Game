// In-game screenshots for art work: boots the server, two clients (Dave holds the
// camera, Steve poses), jumps to named viewpoints on a given day, saves PNGs.
//
//   node tools/scene.mjs camp,road,town [outdir] [day 1-5] [hour] [seed]
//
// Views: camp road vista wall poi(=every stop on the leg) gate grade winch town pawn casino
//        pawnin casinoin repo rv rvin crew hands loot night   (or "all")
// Output: <outdir>/<view>-d<day>.png.  Day picks the biome: 1 meadow, 2 fields,
// 3-4 badlands, 5 desert.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const ALL = ['camp', 'road', 'vista', 'wall', 'poi', 'gate', 'grade', 'winch', 'town', 'pawn', 'casino', 'pawnin', 'casinoin', 'repo', 'rv', 'rvin', 'crew', 'hands', 'loot', 'night'];
const [viewArg = 'camp,road,town', OUT = 'test/screenshots/scene', dayArg = '1', hourArg = '10', seed = '777'] = process.argv.slice(2);
const views = viewArg === 'all' ? ALL : viewArg.split(',').filter(Boolean);
const DAY = Math.max(1, Math.min(5, +dayArg | 0)), HOUR = +hourArg;
for (const v of views) if (!ALL.includes(v)) { console.error(`unknown view "${v}" (have: ${ALL.join(' ')})`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const PORT = 8000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);   // several agents may be rendering on swiftshader at once
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}`, { timeout: 240000 });
  await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  await page.fill('#nameInput', name);
  return page;
}
const ready = p => p.waitForFunction(() => window.__nmd?.W && window.__nmd?.rv && (window.__nmd.frames || 0) > 20, null, { timeout: 400000 });
const quiet = p => p.evaluate(() => { const S = window.__nmd; S.noRender = true; S.forceLock = true; document.getElementById('clickToPlay').classList.add('hidden'); document.getElementById('toasts').style.display = 'none'; });
const ev = (p, fn, arg) => p.evaluate(fn, arg);
const wait = (p, ms) => p.waitForTimeout(ms);

const steve = await open('Steve');
await steve.fill('#seedInput', seed);
await steve.click('#hostBtn');
await ready(steve);
const code = await steve.evaluate(() => window.__nmd.code);
const dave = await open('Dave');
await dave.fill('#codeInput', code);
await dave.click('#joinBtn');
await ready(dave);
await quiet(steve); await quiet(dave);
await dave.waitForFunction(() => window.__nmd.views.size === 1, null, { timeout: 120000 });
const send = m => steve.evaluate(m => window.__nmd.send(m), m);
if (DAY !== 1) {
  await send({ t: 'dbg', op: 'day', d: DAY });
  for (const p of [steve, dave]) await p.waitForFunction(d => window.__nmd.W?.day === d && window.__nmd.lw && window.__nmd.rv, DAY, { timeout: 240000 });
  await wait(steve, 1500);
}
const setClock = async (h, night = false) => {
  if (night) await send({ t: 'dbg', op: 'phase', ph: 'night' });
  await send({ t: 'dbg', op: 'clock', h });
  await wait(steve, 300);
};
await setClock(HOUR);

async function shot(p, name, { hud = true, settle = 1400 } = {}) {
  await p.evaluate(h => { window.__nmd.noRender = false; for (const id of ['hud', 'roster', 'prompt', 'voiceDock', 'heldLabel', 'stamina']) { const e = document.getElementById(id); if (e) e.style.visibility = h ? '' : 'hidden'; } }, hud);
  await p.waitForTimeout(settle);
  const file = `${OUT}/${name}-d${DAY}.png`;
  await p.screenshot({ path: file });
  await p.evaluate(() => { window.__nmd.noRender = true; });
  console.log('📸', file);
}
// stand Dave at (x,z) on the ground, look at (tx,ty,tz)
const camAt = (x, z, tx, ty, tz, who = dave) => ev(who, ([x, z, tx, ty, tz]) => { const S = window.__nmd; const y = S.W.heightAt(x, z); S.me.teleport(x, y + 0.05, z, 0); S.aimAt(tx, ty, tz); }, [x, z, tx, ty, tz]);
const steveAt = (x, z, yaw) => ev(steve, ([x, z, yaw]) => { const S = window.__nmd; S.me.teleport(x, S.W.heightAt(x, z) + 0.05, z, yaw); }, [x, z, yaw]);
const W = await steve.evaluate(() => { const W = window.__nmd.W; return { LEN: W.LEN, town: W.town, pois: W.pois.map(p => ({ type: p.type, x: p.x, z: p.z, side: p.side })), obstacles: W.obstacles, anchors: W.anchors, camp: W.camp, biome: W.biome }; });
const rx = z => steve.evaluate(z => window.__nmd.W.roadX(z), z);
const hy = (x, z) => steve.evaluate(([x, z]) => window.__nmd.W.heightAt(x, z), [x, z]);
console.log(`day ${DAY} · biome ${W.biome} · hour ${HOUR}`);
const T = W.town;

for (const v of views) {
  try {
    if (v === 'camp') {
      await steveAt(-4.2, -45.5, 2.4);
      await camAt(-13.5, -52.5, -3, (await hy(-3, -42)) + 1.4, -42);
      await shot(dave, v);
    } else if (v === 'road') {
      const z = 70, x = (await rx(z)) - 1.2;
      await steveAt(x + 2.2, z + 9, Math.PI);
      await camAt(x, z, await rx(z + 60), (await hy(await rx(z + 60), z + 60)) + 1.6, z + 60);
      await shot(dave, v);
    } else if (v === 'vista') {
      // the highest ground within ~45 m of the road, looking down the road
      const p = await steve.evaluate(() => { const W = window.__nmd.W; let best = null;
        for (let z = 90; z < 300; z += 6) for (const s of [-1, 1]) for (let d = 14; d < 46; d += 2) { const x = W.roadX(z) + s * d; const h = W.heightAt(x, z) - W.roadY(z); if (h < 30 && (!best || h > best.h)) best = { x, z, h }; }
        return best; });
      await camAt(p.x, p.z, await rx(p.z + 90), (await hy(await rx(p.z + 90), p.z + 90)) + 1, p.z + 90);
      await ev(dave, () => { window.__nmd.me.pitch += 0.06; });
      await shot(dave, v);
    } else if (v === 'wall') {
      const w = await steve.evaluate(() => { const W = window.__nmd.W;
        for (let z = 120; z < 600; z += 5) { const r = W.roadX(z); for (let d = 8; d < 60; d += 0.5) { const x = r + d; if (W.heightAt(x + 1, z) - W.heightAt(x, z) > 1.6 && W.heightAt(x + 10, z) - W.heightAt(x, z) > 6) return { x, z }; } }
        return null; });
      if (!w) { console.log('  (no steep wall on this day)'); continue; }
      await camAt(w.x - 9, w.z - 6, w.x + 3, (await hy(w.x + 3, w.z)) + 1, w.z + 2);
      await shot(dave, v);
    } else if (v === 'poi') {
      for (const [i, p] of W.pois.entries()) {
        const z = p.z - 13, x = (await rx(z)) - p.side * 2.5;
        await camAt(x, z, p.x, (await hy(p.x, p.z)) + (p.type === 'crash' ? 4 : 1.6), p.z);
        await shot(dave, `poi${i}-${p.type}`);
      }
    } else if (v === 'gate') {
      const g = W.obstacles.find(o => o.type === 'gate');
      if (!g) { console.log('  (no gate on this day)'); continue; }
      const gz = g.z - 13, gx = await rx(gz);
      await steveAt((await rx(g.z - 2.5)) - 4.4, g.z - 2.5, 0);
      await camAt(gx - 1.5, gz, await rx(g.z), (await hy(await rx(g.z), g.z)) + 1.6, g.z);
      await shot(dave, v);
      const c = g.codeAt;
      await ev(dave, c => { const S = window.__nmd; S.me.teleport(c.x - 2.2, c.y + 0.1, c.z - 2.2, 0); S.aimAt(c.x, c.y, c.z); }, c);
      await shot(dave, 'rimcode');
    } else if (v === 'grade') {
      const g = W.obstacles.find(o => o.type === 'grade');
      const z = g.z - 16, x = (await rx(z)) - 3;
      await camAt(x, z, await rx(g.z + 8), (await hy(await rx(g.z + 8), g.z + 8)) + 1, g.z + 8);
      await shot(dave, v);
      const a = W.anchors[0];
      if (a) { await camAt(a.x - 2.6, a.z - 2.6, a.x, a.y - 0.4, a.z); await shot(dave, 'anchor'); }
    } else if (v === 'winch') {
      // the RV at the foot of the grade, Steve carries the hook up and clips it to the anchor, cable taut
      const g = W.obstacles.find(o => o.type === 'grade');
      const rz = g.z0 - 7, rxx = await rx(rz);
      await send({ t: 'dbg', op: 'tpRV', x: rxx, z: rz, yaw: 0 });
      await wait(steve, 1500);
      await ev(steve, () => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x, S.W.heightAt(r.x, r.z + 5.4) + 0.05, r.z + 5.4, Math.PI); S.me.pitch = 0.5; });
      await wait(steve, 900);
      await ev(steve, () => window.__nmd.press('use'));
      await wait(steve, 700);
      const anc = W.anchors[0];
      for (let i = 1; i <= 12; i++) {
        await ev(steve, ([ax, az, f]) => { const S = window.__nmd; const r = S.rv.p; const x = r.x + (ax - 0.9 - r.x) * f, z = r.z + 5.4 + (az - 0.9 - r.z - 5.4) * f; S.me.teleport(x, S.W.heightAt(x, z) + 0.1, z, 0); }, [anc.x, anc.z, i / 12]);
        await wait(steve, 250);
      }
      await wait(steve, 800);
      await ev(steve, () => window.__nmd.press('use'));
      await wait(steve, 800);
      console.log('  hook', JSON.stringify(await steve.evaluate(() => window.__nmd.hook)));
      const cx = rxx - 11, cz = rz - 7;
      await camAt(cx, cz, rxx + 1, (await hy(rxx, rz + 10)) + 1.5, rz + 13);
      await shot(dave, v);
      await camAt(anc.x - 3, anc.z - 3.5, anc.x, anc.y - 0.3, anc.z);
      await shot(dave, 'winch-anchor');
    } else if (v === 'town') {
      await steveAt(3.5, T.z + 26, Math.PI);
      await camAt(4.5, T.z - 6, 3, T.y + 2.6, T.z + 70);
      await shot(dave, v);
    } else if (v === 'pawn') {
      await camAt(-1, T.z + 30, -17, T.y + 2.4, T.z + 42);
      await shot(dave, v);
    } else if (v === 'casino') {
      await camAt(2, T.z + 44, 21, T.y + 3.2, T.z + 58);
      await shot(dave, v);
    } else if (v === 'pawnin') {
      await camAt(T.pawn.x + 3.6, T.pawn.z + 0.4, T.pawn.x - 1.2, T.pawn.y + 0.5, T.pawn.z - 0.2);
      await shot(dave, v);
    } else if (v === 'casinoin') {
      const s = T.bj.stand, h = T.bj.hit, t = T.bj.table;
      await steveAt(h.x, h.z, 0);
      await camAt(s.x + 2.4, s.z + 2.2, (h.x + t.x) / 2, t.y + 0.1, (h.z + t.z) / 2);
      await shot(dave, v);
    } else if (v === 'repo') {
      await camAt(T.repo.x - 7.5, T.repo.z - 3.5, T.repo.x - 0.8, T.y + 1.5, T.repo.z + 0.3);
      await shot(dave, v);
    } else if (v === 'rv') {
      const r = await dave.evaluate(() => window.__nmd.rv.p);
      await camAt(r.x - 7, r.z + 8.5, r.x, r.y + 1.0, r.z);
      await shot(dave, v);
    } else if (v === 'rvin') {
      await ev(dave, () => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x + 0.2, r.y + 0.1, r.z - 2.6, 0); S.aimAt(r.x + 0.3, r.y + 0.9, r.z + 3); });
      await shot(dave, v);
    } else if (v === 'crew') {
      const x = -10, z = -58;
      await steveAt(x + 0.4, z + 3.0, Math.PI - 0.35);
      await ev(steve, () => { window.__nmd.me.pitch = 0; });
      await camAt(x, z, x + 0.4, (await hy(x, z)) + 1.2, z + 3.0);
      await shot(dave, v, { hud: false });
    } else if (v === 'hands') {
      await ev(dave, () => { const S = window.__nmd; S.me.teleport(-12, S.W.heightAt(-12, -56) + 0.05, -56, 0.6); S.me.pitch = 0.35; });
      await shot(dave, v);
    } else if (v === 'loot') {
      const types = ['tv', 'vase', 'painting', 'neon', 'gnome', 'safe', 'slot', 'suitcase', 'guitar', 'trophy', 'toaster', 'register', 'lamp', 'tire', 'dino'];
      const z = 30, x0 = await rx(z) - 5;
      for (const [i, type] of types.entries()) {
        const x = x0 + (i % 5) * 2.1, zz = z + Math.floor(i / 5) * 2.4;
        await send({ t: 'dbg', op: 'spawn', type, x, y: (await hy(x, zz)) + 0.8, z: zz, value: 300 });
      }
      await wait(steve, 2500);
      await camAt(x0 + 4.2, z - 6.5, x0 + 4.2, (await hy(x0 + 4, z)) + 0.3, z + 2.6);
      await shot(dave, v);
    } else if (v === 'night') {
      await setClock(22.5, true);
      await steveAt(-6.5, -48.5, -0.8);
      await camAt(-12, -55, -5, (await hy(-5, -46)) + 1.0, -46);
      await shot(dave, v);
      await send({ t: 'dbg', op: 'phase', ph: 'camp' });
      await setClock(HOUR);
    }
  } catch (e) { console.log(`  ✗ ${v}: ${e.message.split('\n')[0]}`); }
}
await dave.evaluate(() => { window.__nmd.noRender = false; });
const fps = await dave.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2500) requestAnimationFrame(f); else r(n / 2.5); }; requestAnimationFrame(f); }));
const calls = await dave.evaluate(() => window.__nmd.renderer?.()?.info?.render?.calls ?? null);
console.log(`fps (swiftshader, last view): ${fps.toFixed(1)}${calls != null ? ` · draw calls ${calls}` : ''}`);
console.log(errors.length ? 'errors:\n' + errors.slice(0, 20).join('\n') : 'no page errors');
await browser.close();
process.exit(0);
