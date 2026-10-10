// Dev playtest: drive the real client through the RV mechanics, headless.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);   // Chromium refuses these
let PORT; do PORT = 3800 + Math.floor(Math.random() * 400); while (UNSAFE_PORTS.has(PORT));
const OUT = 'test/screenshots'; fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 8000); });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${PORT}`);
await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
await page.fill('#nameInput', 'Driver');
await page.fill('#seedInput', '4242');
await page.click('#hostBtn');
await page.waitForFunction(() => window.__nmd?.W && window.__nmd?.g && window.__nmd?.rv, null, { timeout: 30000 });
await page.evaluate(() => { const S = window.__nmd; S.noRender = true; S.forceLock = true; document.getElementById('clickToPlay').classList.add('hidden'); });
await page.waitForFunction(() => (window.__nmd.frames || 0) > 60, null, { timeout: 60000 });
const st = () => page.evaluate(() => { const S = window.__nmd, m = S.me; return { mode: m.mode, par: m.par, seat: m.seat, pos: [m.pos.x, m.pos.y, m.pos.z].map(v => +v.toFixed(2)), rv: S.rv ? [S.rv.p.x, S.rv.p.y, S.rv.p.z].map(v => +v.toFixed(2)) : null, g: S.g && { ph: S.g.ph, clk: S.g.clk, bank: S.g.bank }, target: S.target()?.label || null, holding: m.holding, stamina: +m.stamina.toFixed(0), frames: S.frames, drv: S.g?.drv, sid: S.selfId, rvRaw: S.interp.rv.length ? S.interp.rv[S.interp.rv.length-1].p : null }; });
const shot = async name => { await page.evaluate(() => { window.__nmd.noRender = false; }); await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${name}.png` }); await page.evaluate(() => { window.__nmd.noRender = true; }); console.log('  📸', name); };
const log = async label => console.log(label, JSON.stringify(await st()));
const wait = ms => page.waitForTimeout(ms);

await log('spawned');
// ---- GRAB: find a loot item near a POI, stand next to it, look at it, hold LMB
const loot = await page.evaluate(() => { const S = window.__nmd; const p = [...S.props.values()].find(p => p.type !== 'map' && p.type !== 'boulder' && ['1h', '2h'].includes(({ gnome: '1h', lamp: '1h', toaster: '1h', register: '1h', trophy: '1h' })[p.type] || '2h') && p.pose); return p ? { id: p.id, type: p.type, ...p.pose.p } : null; });
console.log('loot target', JSON.stringify(loot));
await page.evaluate(l => { const S = window.__nmd; const W = S.W; const x = l.x + 1.6, z = l.z; S.me.teleport(x, W.heightAt(x, z) + 0.3, z, 0); }, loot);
await wait(900);
await page.evaluate(l => window.__nmd.aimAt(l.x, l.y, l.z), loot);
await wait(300);
await log('aiming at loot');
await page.mouse.down();
await wait(1200);
await log('holding?');
const lootPos = id => page.evaluate(id => window.__nmd.props.get(id)?.pose?.p, loot.id);
console.log('loot pos while held', JSON.stringify(await lootPos()));
await page.evaluate(() => { window.__nmd.me.yaw += Math.PI; });
await page.keyboard.down('w'); await wait(2000); await page.keyboard.up('w');
console.log('loot pos after walking 2s', JSON.stringify(await lootPos()));
await shot('e-carrying');
await page.evaluate(() => window.__nmd.press('throw'));
await page.mouse.up();
await wait(1500);
console.log('loot pos after throw', JSON.stringify(await lootPos()));

// ---- CLIMB: find a steep canyon wall, face it, hold LMB + W
const wall = await page.evaluate(() => {
  const W = window.__nmd.W;
  for (let z = 120; z < 400; z += 7) {
    const rx = W.roadX(z);
    for (let d = 10; d < 60; d += 0.5) {
      const x = rx + d;
      const h0 = W.heightAt(x, z), h1 = W.heightAt(x + 1, z);
      if (h1 - h0 > 2.2 && W.heightAt(x + 12, z) - h0 > 8) return { x: x - 0.9, z, base: h0, top: W.heightAt(x + 12, z) };
    }
  }
  return null;
});
console.log('wall', JSON.stringify(wall));
await page.evaluate(w => { const S = window.__nmd; S.me.teleport(w.x, w.base + 0.2, w.z, Math.PI / 2); S.me.pitch = -0.3; S.me.stamina = 100; }, wall);
await wait(800);
await log('at the wall');
await page.mouse.down();
await page.keyboard.down('w');
for (let i = 0; i < 6; i++) { await wait(1000); await log(`climb t+${i + 1}s`); }
await shot('f-climbing');
await page.keyboard.up('w');
await page.mouse.up();
await wait(1500);
await log('let go');

// ---- WINCH: walk up to the front bumper, E to take the hook, walk away, see the cable pay out
await page.evaluate(() => { const S = window.__nmd; const rv = S.rv; S.me.teleport(rv.p.x, S.W.heightAt(rv.p.x, rv.p.z + 5.3), rv.p.z + 5.3, Math.PI); S.me.pitch = 0.6; });
await wait(800);
await log('at the bumper');
await page.evaluate(() => window.__nmd.press('use'));
await wait(700);
console.log('hasHook', await page.evaluate(() => window.__nmd.me.hasHook), 'hook', JSON.stringify(await page.evaluate(() => window.__nmd.hook)));
await page.evaluate(() => { window.__nmd.me.yaw = 0; window.__nmd.me.pitch = 0; });
await page.keyboard.down('w'); await wait(2500); await page.keyboard.up('w');
console.log('hook after walking', JSON.stringify(await page.evaluate(() => window.__nmd.hook)));
await shot('g-hook');
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close(); process.exit(0);
