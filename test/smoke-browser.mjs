// Browser smoke test: two real Chromium clients in one room. Verifies the
// client end-to-end (rendering, controller, riding a moving RV, seeing each
// other) and captures the doc screenshots. Fails on any page error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { insideRV, toLocal, toWorld } from '../shared/rv.js';

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);   // Chromium refuses these
let PORT; do PORT = 4700 + Math.floor(Math.random() * 400); while (UNSAFE_PORTS.has(PORT));
const SHOTS = process.env.SHOTS || 'test/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1', FRIENDSLOP_NOMOBS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  await page.evaluate(() => (localStorage.setItem('nmdHelpSeen', '1'), localStorage.setItem('nmdVoiceAsked', '1')));
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
  const chip = await host.evaluate(() => document.getElementById('hCode').textContent);
  check(/^[1-9]\d{3}$/.test(code) && chip.includes(code), `hosted a trip: trip code ${code}, shown on the HUD ("${chip}")`);
  // the help page (it opens by itself on a first trip) fits a 1280x720 screen: its Got It button on it
  const helpFit = await host.evaluate(() => {
    const h = document.getElementById('help'); h.classList.remove('hidden');
    const b = document.getElementById('helpOk').getBoundingClientRect(), fits = b.top >= 0 && b.bottom <= innerHeight;
    h.classList.add('hidden');
    return { fits, bottom: Math.round(b.bottom), h: innerHeight };
  });
  check(helpFit.fits, `the help page fits the screen: its Got It button ends at y ${helpFit.bottom} of ${helpFit.h}`);
  const joiner = await open('Dave');
  // note when a prop smashes on Dave's side (his socket opens on his first Join click)
  await joiner.evaluate(() => { const WS = window.WebSocket; window.__breakAt = []; window.WebSocket = class extends WS { constructor(...a) { super(...a); this.addEventListener('message', e => { if (String(e.data).includes('"k":"break"')) window.__breakAt.push(performance.now()); }); } }; });
  // a wrong code first: a clear answer, and the menu stays usable
  const wrong = code === '5000' ? '5001' : '5000';
  await joiner.fill('#codeInput', wrong);
  await joiner.click('#joinBtn');
  await joiner.waitForFunction(() => /No trip with that code/.test(document.getElementById('menuError').textContent) && !document.getElementById('joinBtn').disabled, null, { timeout: 30000 });
  await joiner.fill('#codeInput', 'ab12');
  const typed = await joiner.evaluate(() => document.getElementById('codeInput').value);
  check(typed === '12', `a wrong code gets "No trip with that code", and the code box only takes digits ("ab12" -> "${typed}")`);
  // a pasted chat line gives its code, digits from other scripts count (a Persian keyboard's ۴۸۲۱), and a
  // code that starts with 0 is told why it can't be one
  const pasted = [];
  for (const v of ['code: 4821, see you at 8', '۴۸۲۱', '٤٨-٢١']) { await joiner.fill('#codeInput', v); pasted.push(await joiner.evaluate(() => document.getElementById('codeInput').value)); }
  await joiner.fill('#codeInput', '0482');
  await joiner.click('#joinBtn');
  const zero = await joiner.evaluate(() => document.getElementById('menuError').textContent);
  check(pasted.join() === '4821,4821,4821' && /never start with 0/.test(zero), `the code box takes a pasted chat line and other scripts' digits (${pasted.join(', ')}); "0482": "${zero}"`);
  await joiner.fill('#codeInput', `${code.slice(0, 2)} ${code.slice(2)}`);
  await joiner.click('#joinBtn');
  // while Dave's day loads (it waits seconds for its textures), Steve drops a vase that smashes and a
  // safe that takes a dent, out past the camp: Dave must end up with Steve's props, no ghost of the vase
  await joiner.waitForFunction(() => window.__nmd?.selfId != null, null, { polling: 50 });
  const dropped = await host.evaluate(() => {
    const S = window.__nmd, W = S.W, had = new Set(S.props.keys());
    for (const [type, z, h, value] of [['vase', 30, 25, 520], ['safe', 36, 10, 1300]]) { const x = W.roadX(z) + 6; S.send({ t: 'dbg', op: 'spawn', type, x, y: W.heightAt(x, z) + h, z, value }); }
    return [...had];
  });
  await ready(joiner);
  ok('second player joined through the menu');
  await quiet(host); await quiet(joiner);
  {
    const propsOf = p => p.evaluate(() => [...window.__nmd.props.values()].map(p => [p.id, p.type, Math.round(p.value)]).sort((a, b) => a[0] - b[0]));
    let hp, jp;
    for (let i = 0; i < 12; i++) {
      [hp, jp] = await Promise.all([propsOf(host), propsOf(joiner)]);
      if (JSON.stringify(hp) === JSON.stringify(jp) && !hp.some(([id, type]) => type === 'vase' && !dropped.includes(id))) break;
      await joiner.waitForTimeout(1500);
    }
    const hIds = hp.map(p => p[0]), ghosts = jp.filter(p => !hIds.includes(p[0])).map(p => `${p[0]} ${p[1]}`);
    const hv = new Map(hp.map(p => [p[0], p[2]])), stale = jp.filter(p => hv.has(p[0]) && hv.get(p[0]) !== p[2]).map(p => `${p[0]} ${p[1]} ${p[2]} (Steve ${hv.get(p[0])})`);
    const raced = await joiner.evaluate(() => window.__breakAt.some(t => t < (window.__nmd.builtAt ?? 0)));
    const smashed = !hp.some(([id, type]) => type === 'vase' && !dropped.includes(id));
    check(!ghosts.length && !stale.length && hp.length === jp.length, `${!smashed ? 'the vase did not smash (no race)' : raced ? 'a vase smashed while Dave\'s day loaded' : 'a vase smashed (after Dave\'s day loaded: no race this time)'}; Dave has Steve's ${hp.length} props and values${ghosts.length ? `; ghosts: ${ghosts.join(', ')}` : ''}${stale.length ? `; stale: ${stale.join(', ')}` : ''}`);
  }
  await host.waitForFunction(() => window.__nmd.views.size === 1, null, { timeout: 60000 });
  await joiner.waitForFunction(() => window.__nmd.views.size === 1, null, { timeout: 60000 });
  ok('each client renders the other player');

  // ---- camp screenshot: Dave looks at Steve and the RV ----
  await host.evaluate(() => { const S = window.__nmd; S.me.teleport(-3.5, 0.05, -38, 0); });
  await joiner.evaluate(() => { const S = window.__nmd; S.me.teleport(-8, 0.05, -33.5, 0); S.aimAt(-2.5, 1.2, -40); });
  await wait(host, 1200);
  await shot(joiner, 'camp');

  // ---- Dave rides inside, Steve drives ----
  // (the day's roles are drawn at random; the test sets them through a test-only lever)
  const ids = { steve: await host.evaluate(() => window.__nmd.selfId), dave: await joiner.evaluate(() => window.__nmd.selfId) };
  const rolesNow = (drv, nav) => host.evaluate(([drv, nav]) => window.__nmd.send({ t: 'dbg', op: 'roles', drv, nav }), [drv, nav]);
  await rolesNow(ids.steve, ids.dave);
  await host.waitForFunction(id => window.__nmd.meta?.roles?.drv === id, ids.steve, { timeout: 24000 });
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

  // ---- the map: the navigator reads it to the driver ----
  // now Dave drives and Steve navigates (set through the test lever). Nobody at the wheel yet: Steve can't take
  // it off the dash (the prompt says why), and a grab sent anyway is refused
  await rolesNow(ids.dave, ids.steve);
  await joiner.evaluate(() => { window.__nmd.me.yaw += 0.2; });   // (Dave looks around: here, not away, so nobody stands in)
  await host.waitForFunction(id => window.__nmd.meta?.roles?.nav === id && !window.__nmd.meta.roles.drvAway, ids.steve, { timeout: 24000 });
  await host.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.1, r.y + 0.1, r.z + 2.25, 0); });
  await wait(host, 900);
  const aimAtMap = () => host.evaluate(() => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); S.aimAt(m.pose.p.x, m.pose.p.y, m.pose.p.z); });
  const mapAt = () => host.evaluate(() => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); return { p: m.pose.p, rv: { p: S.rv.p, q: S.rv.q } }; });
  const toastSays = (pg, re) => pg.waitForFunction(src => [...document.querySelectorAll('.toast')].some(t => new RegExp(src).test(t.textContent)), re.source, { timeout: 24000 }).then(() => true, () => false);
  await aimAtMap();
  await wait(host, 300);
  const waitLabel = await host.evaluate(() => window.__nmd.target()?.label || '');
  await host.evaluate(() => window.__nmd.press('grab'));
  const m0 = await mapAt();
  const refusedToast = toastSays(host, /Dave has to be at the wheel/);
  await host.evaluate(() => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); S.send({ t: 'grab', kind: 'prop', id: m.id, pt: [m.pose.p.x, m.pose.p.y, m.pose.p.z], d: 1.2 }); });
  const refused = await refusedToast;
  await wait(host, 900);
  await host.evaluate(() => window.__nmd.send({ t: 'rel' }));   // (had the server taken it)
  const m1 = await mapAt(), l0 = toLocal(m0.rv.p, m0.rv.q, m0.p), l1 = toLocal(m1.rv.p, m1.rv.q, m1.p);
  const slid = Math.hypot(l1.x - l0.x, l1.y - l0.y, l1.z - l0.z);
  const early = await host.evaluate(() => ({ holding: window.__nmd.me.holding, up: window.__nmd.mapUp() }));
  check(/Dave has to be at the wheel/.test(waitLabel) && !early.holding && !early.up && refused && slid < 0.05, `nobody at the wheel: the map stays on the dash ("${waitLabel}"; a grab sent anyway is refused: ${refused}; the map moved ${slid.toFixed(2)} m)`);
  const route = await host.evaluate(() => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); let on = false; m.mesh.traverse(o => { if (o.material?.map?.image === S.mapCv) on = true; }); return on; });
  check(!route, 'the map lying on the dash shows no route (only its reader\'s raised sheet does)');
  // a grab the server refuses never puts the map up, not even while its answer is on the way (the hands
  // take hold at once; the sheet waits for the server's yes)
  const flash = await host.evaluate(async () => {
    const S = window.__nmd, m = [...S.props.values()].find(p => p.type === 'map');
    S.me.holding = { id: m.id, type: 'map' };
    S.send({ t: 'grab', kind: 'prop', id: m.id, pt: [m.pose.p.x, m.pose.p.y, m.pose.p.z], d: 1.2 });
    let up = false; const t0 = performance.now();
    while (S.me.holding && performance.now() - t0 < 20000) { up ||= S.mapUp(); await new Promise(r => setTimeout(r, 16)); }
    return { up, cleared: !S.me.holding };
  });
  check(!flash.up && flash.cleared, 'a refused grab never puts the map up, not even for the round trip');
  // Dave takes the wheel and stands on the brake: now Steve takes the map, and only Steve's screen shows it
  await joiner.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.4, r.y + 0.1, r.z - 0.6, 0); });
  await wait(joiner, 900);
  const cue = toastSays(host, /Steve, grab the map/);
  await joiner.evaluate(() => window.__nmd.send({ t: 'use', kind: 'seat0' }));
  await joiner.waitForFunction(() => window.__nmd.me.mode === 'seat' && window.__nmd.me.seat === 0, null, { timeout: 24000 });
  await joiner.keyboard.down(' ');
  const daveId = await joiner.evaluate(() => window.__nmd.selfId);
  await host.waitForFunction(id => window.__nmd.g?.drv === id, daveId, { timeout: 24000 });
  await aimAtMap();
  await wait(host, 300);
  const freeLabel = await host.evaluate(() => window.__nmd.target()?.label || '');
  await host.evaluate(() => window.__nmd.press('grab'));
  await host.waitForFunction(() => window.__nmd.me.holding?.ok === true, null, { timeout: 24000 }).catch(() => {});
  await wait(host, 900);
  const reading = await host.evaluate(() => ({ type: window.__nmd.me.holding?.type, ok: !!window.__nmd.me.holding?.ok, up: window.__nmd.mapUp() }));
  const daveSees = await joiner.evaluate(() => window.__nmd.mapUp());
  check(reading.type === 'map' && reading.ok && reading.up && !daveSees && (await cue) && /call out the road to Dave/.test(freeLabel), `with Dave at the wheel (and Steve called to grab the map), Steve took the road map ("${freeLabel}") and reads it; Dave's screen shows none of it`);
  // the roles hold: Steve (today's navigator) can't take the wheel, and Dave can't take the map
  const roster = await host.evaluate(() => [...document.querySelectorAll('#roster .pm')].map(e => e.querySelector('.pn')?.textContent));
  check(roster.some(t => /^Dave\s*driver$/i.test(t)) && roster.some(t => /^Steve\s*map$/i.test(t)), `the party frames say who drives and who reads the map today (${roster.join(' | ')})`);
  await host.evaluate(() => { window.__nmd.me.pitch = 0.1; });
  await shot(host, 'map');
  await host.evaluate(() => window.__nmd.press('release'));
  await joiner.keyboard.up(' ');
  await joiner.evaluate(() => window.__nmd.press('use'));   // Dave gets up (a teleport alone would leave Dave the server's driver)
  await joiner.waitForFunction(() => window.__nmd.me.mode === 'walk', null, { timeout: 24000 });
  // the roles hold on screen: Dave's map prompt says no peeking; Steve's seat prompt says Dave drives (and Steve
  // reads the map), and the server refuses Steve the wheel; each tracker says whose job is what. (Both move
  // first: just up from the wheel, Dave stands in Steve's line to the seat, and Steve where Dave reads the map
  // from. By now the RV has driven and turned a little, so both stand in the RV's own frame)
  const rvNow = await host.evaluate(() => ({ p: window.__nmd.rv.p, q: window.__nmd.rv.q }));
  const inRV = (x, y, z) => toWorld(rvNow.p, rvNow.q, { x, y, z });
  await host.evaluate(([a, t]) => { const S = window.__nmd; S.me.teleport(a.x, a.y, a.z, 0); S.aimAt(t.x, t.y, t.z); }, [inRV(0.25, 0.1, 2.0), inRV(0.62, 0.4, 2.85)]);
  await joiner.evaluate(a => { const S = window.__nmd; S.me.teleport(a.x, a.y, a.z, 0); }, inRV(-0.1, 0.1, 2.25));
  await wait(joiner, 600);
  await joiner.evaluate(() => { const S = window.__nmd; const m = [...S.props.values()].find(p => p.type === 'map'); S.aimAt(m.pose.p.x, m.pose.p.y, m.pose.p.z); });
  await wait(joiner, 600);
  await wait(host, 300);
  const what = p => p.evaluate(() => JSON.stringify(window.__nmd.target() && { kind: window.__nmd.target().kind, label: window.__nmd.target().label }));
  const peek = await joiner.evaluate(() => window.__nmd.target()?.label || '') || `(${await what(joiner)})`;
  const seatLabel = await host.waitForFunction(() => window.__nmd.target()?.use === 'seat0' && window.__nmd.target().label, null, { timeout: 24000 }).then(h => h.jsonValue(), async () => `(no seat: ${await what(host)})`);
  const ride = toastSays(host, /Dave drives today\. Ride along/);
  await host.evaluate(() => window.__nmd.send({ t: 'use', kind: 'seat0' }));
  const refusedSeat = (await ride) && (await host.evaluate(() => window.__nmd.me.mode)) !== 'seat';
  const qt = await Promise.all([host, joiner].map(p => p.evaluate(() => document.getElementById('qtLines').textContent)));
  check(/Dave drives today\. You read the map/.test(seatLabel) && refusedSeat && /no peeking/.test(peek) && /You read the map today\. Dave drives/.test(qt[0]) && /You drive today\. Steve reads the map/.test(qt[1]),
    `the roles hold on screen (seat: "${seatLabel}"; refused ${refusedSeat}; map: "${peek}"; trackers: ${qt.join(' | ')})`);

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

  // ---- voice: both join; Dave talks (push-to-talk held) next to Steve, who hears it through the game's own connection ----
  await host.evaluate(() => document.getElementById('voiceJoinBtn').click());
  await joiner.evaluate(() => document.getElementById('voiceJoinBtn').click());
  const hp = await host.evaluate(() => window.__nmd.me.pos);
  await joiner.evaluate(p => window.__nmd.me.teleport(p.x + 2, p.y, p.z, 0), hp);
  await joiner.waitForFunction(() => window.__nmdVoice?.on, null, { timeout: 30000 }).catch(() => {});
  await joiner.evaluate(() => { window.__nmdVoice.ptt = true; });
  await host.waitForFunction(() => (window.__nmdVoice?.stats.decoded || 0) > 20, null, { timeout: 60000 }).catch(() => {});
  await joiner.evaluate(() => { window.__nmdVoice.ptt = false; });
  const vs = await host.evaluate(() => { const V = window.__nmdVoice; return { on: V.on, err: V.err, decoded: V.stats.decoded, peers: [...V.peers.values()].map(p => !!p.panner) }; });
  const sent = await joiner.evaluate(() => ({ sent: window.__nmdVoice.stats.sent, err: window.__nmdVoice.err }));
  check(vs.on && vs.decoded > 20 && vs.peers.length === 1 && vs.peers[0], `proximity voice: Dave sent ${sent.sent} Opus frames, Steve decoded ${vs.decoded} into a 3D panner${vs.err || sent.err ? ` (${vs.err || sent.err})` : ''}`);

  // ---- wildlife: a grumphorn drawn and labelled; the shove; bracing in the RV; knocks on riders ----
  {
    // (2.8 m ahead, slantwise: its flank about 2 m off, in reach of the crosshair (3 m) and a shove (2.4 m))
    const spot = await host.evaluate(() => { const S = window.__nmd, y = S.me.yaw; return { x: S.me.pos.x + Math.sin(y) * 2.8, z: S.me.pos.z + Math.cos(y) * 2.8, yaw: y }; });
    // (lying there for good: a body that won't get up and charge the rest of the test)
    await host.evaluate(s => window.__nmd.send({ t: 'dbg', op: 'mob', type: 'grumphorn', x: s.x, z: s.z, yaw: s.yaw + 1.2, st: 8 }), spot);
    await host.waitForFunction(() => [...window.__nmd.props.values()].some(p => p.type === 'grumphorn' && p.view && p.mesh.visible), null, { timeout: 60000 });
    await wait(host, 400);
    const mb = await host.evaluate(s => {
      const S = window.__nmd, p = [...S.props.values()].find(q => q.type === 'grumphorn');
      S.aimAt(p.pose.p.x, p.pose.p.y + 0.2, p.pose.p.z);
      return { bones: p.view.b ? Object.keys(p.view.b).length : 0, skinned: !!p.view.mesh?.isSkinnedMesh };
    }, spot);
    await wait(host, 300);
    const lbl = await host.evaluate(() => window.__nmd.target()?.label || '');
    check(mb.skinned && mb.bones === 8 && /Grumphorn/.test(lbl), `a grumphorn is drawn (skinned ${mb.skinned}, on ${mb.bones} bones) and the crosshair names it ("${lbl}")`);
    // the shove: right mouse with empty hands; the server says it hit something
    await host.evaluate(() => { const S = window.__nmd; if (S.me.holding) S.press('release'); S.me.stamina = 100; S.press('throw'); });
    const shoved = await host.waitForFunction(() => window.__nmd.lastShove?.by === window.__nmd.selfId, null, { timeout: 30000 }).then(() => host.evaluate(() => window.__nmd.lastShove), () => null);
    check(shoved && shoved.hit >= 1, `right mouse with empty hands shoves (the server answered: hit ${shoved?.hit})`);
    // a ringtail behind Steve, out on the road before town (the wildlife never comes within 20 m of town):
    // drawn, named by the crosshair, and a shove sends it flying (it lands stunned)
    await host.evaluate(() => { const S = window.__nmd, z = S.W.LEN - 60, x = S.W.roadX(z); S.me.teleport(x, S.W.heightAt(x, z) + 0.05, z, 0); });
    await wait(host, 800);
    const rs = await host.evaluate(() => { const S = window.__nmd, y = S.me.yaw + Math.PI; return { x: S.me.pos.x + Math.sin(y) * 1.5, z: S.me.pos.z + Math.cos(y) * 1.5 }; });
    await host.evaluate(s => window.__nmd.send({ t: 'dbg', op: 'mob', type: 'ringtail', x: s.x, z: s.z }), rs);
    await host.waitForFunction(() => [...window.__nmd.props.values()].some(p => p.type === 'ringtail' && p.view && p.mesh.visible), null, { timeout: 60000 });
    // (it mills about its den: keep the crosshair on it)
    const aimRt = () => { const S = window.__nmd, p = [...S.props.values()].find(q => q.type === 'ringtail'); if (p) S.aimAt(p.pose.p.x, p.pose.p.y, p.pose.p.z); return p; };
    const named = await host.waitForFunction(`(${aimRt})() && /ringtail/.test(window.__nmd.target()?.label || '')`, null, { timeout: 20000, polling: 50 }).then(() => true, () => false);
    const rt = await host.evaluate(() => { const p = [...window.__nmd.props.values()].find(q => q.type === 'ringtail'); return p ? { bones: p.view?.b ? Object.keys(p.view.b).length : 0, skinned: !!p.view?.mesh?.isSkinnedMesh } : { gone: true }; });
    check(named && rt.skinned && rt.bones === 8, `a ringtail is drawn (skinned ${rt.skinned}, on ${rt.bones} bones) and the crosshair names it${rt.gone ? ' (it was gone)' : ''}`);
    let flung = false;
    for (let i = 0; i < 4 && !flung; i++) {
      await wait(host, 700);
      await host.evaluate(`(() => { (${aimRt})(); const S = window.__nmd; S.me.stamina = 100; S.press('throw'); })()`);
      flung = await host.waitForFunction(() => { const p = [...window.__nmd.props.values()].find(q => q.type === 'ringtail'); return p && [6, 8].includes((p.st ?? 0) & 31); }, null, { timeout: 4000, polling: 50 }).then(() => true, () => false);
    }
    check(flung, 'a shove sends a ringtail flying (its state reads flung or stunned)');
    // bracing and knocks, on a stand-in body (Steve's own stays as it is)
    const body = await host.evaluate(() => {
      const S = window.__nmd, M = S.me.constructor, crash = { acc: { x: 60, y: 0, z: 0 }, p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 0 } };
      const a = new M(); a.par = 1; a.mode = 'walk'; a.crouch = true; a.lurch(1 / 60, crash);
      const b = new M(); b.par = 1; b.mode = 'walk'; b.crouch = false; b.lurch(1 / 60, crash);
      const c = new M(); c.par = 1; c.mode = 'walk'; c.knock([0, 2, 3], false, 'shove', true, { v: { x: 10, y: 0, z: 0 } });
      const d = new M(); d.mode = 'ko'; d.knock([0, 2, 0], true, 'mob');
      // a hard hat on: the knockout is only a knock (once), and the page tells the server it's used up
      const h = new M(); h.mode = 'walk'; h.hat = true; h.knock([0, 2, 0], true, 'mob');
      const h2 = { mode: h.mode, hat: h.hat, told: h.events.some(e => e.k === 'hat') };
      h.knock([0, 2, 0], true, 'mob');
      return { braced: a.mode, standing: b.mode, riderVx: c.vel.x, riderPar: c.par, downStays: d.mode, hat: h2, hatThen: h.mode };
    });
    check(body.braced !== 'ko' && body.standing === 'ko', `a crash (60 m/s^2) knocks out a standing rider but not a crouched (braced) one (${body.standing} / ${body.braced})`);
    check(body.riderVx === 10 && body.riderPar === 0 && body.downStays === 'ko', `a rider knocked off keeps the RV's speed (vx ${body.riderVx}); someone down stays down (${body.downStays})`);
    check(body.hat.mode !== 'ko' && !body.hat.hat && body.hat.told && body.hatThen === 'ko', `a hard hat turns a knockout into a knock, once (${body.hat.mode}, then ${body.hatThen})`);
    // a knockout the server sends (a rock, a toss, the RV) reaches it: the hard hat takes the first, the
    // second puts Steve down where the crew can see it, and waking up alone bills the ambulance. The page
    // used to drop them: its next frame cleared what the knock had queued
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'hat', on: 1 }));
    await host.waitForFunction(() => window.__nmd.me.hat === true, null, { timeout: 24000 });
    const hatToast = toastSays(host, /Steve's hard hat took that one/);
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'knock', ko: 1, why: 'rock' }));
    const hatOk = await hatToast, hatMode = await host.evaluate(() => window.__nmd.me.mode);
    const downToast = toastSays(host, /Steve got hit by a falling rock/);
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'knock', ko: 1, why: 'rock' }));
    const down = await downToast;
    const wokeToast = toastSays(host, /Steve woke up alone/);
    await host.evaluate(() => { window.__nmd.me.koT = 0.05; });
    const woke = await wokeToast;
    check(hatOk && hatMode !== 'ko' && down && woke, `a knockout from the server reaches it: the hard hat takes the first (${hatOk}, ${hatMode}); the second puts Steve down for the crew to see (${down}); waking up alone bills the ambulance (${woke})`);
  }

  // ---- the RV's condition: the top bar on both pages; broken down, the fix at the engine hatch ----
  {
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'rvhp', hp: 70 }));
    const pill = p => p.waitForFunction(() => document.getElementById('hRV').textContent === 'RV 70%', null, { timeout: 24000 }).then(() => true, () => false);
    const pills = await Promise.all([pill(host), pill(joiner)]);
    check(pills.every(Boolean), `the RV at 70%: the top bar says "RV 70%" on both pages (${pills.join(', ')})`);
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'rvhp', hp: 0 }));
    await host.waitForFunction(() => window.__nmd.g?.brk === 1, null, { timeout: 24000 });
    // E already held before he gets there: the fix starts when he does, without a fresh press
    await host.evaluate(() => window.__nmd.key('e', true));
    // Steve 1.5 m behind the engine hatch on the RV's back wall, facing it
    await host.evaluate(() => {
      const S = window.__nmd, { p, q } = S.rv;
      const rot = v => { const x = q.y * v.z - q.z * v.y, y = q.z * v.x - q.x * v.z, z = q.x * v.y - q.y * v.x;
        const x2 = q.y * z - q.z * y, y2 = q.z * x - q.x * z, z2 = q.x * y - q.y * x;
        return { x: v.x + 2 * (q.w * x + x2), y: v.y + 2 * (q.w * y + y2), z: v.z + 2 * (q.w * z + z2) }; };
      const b = rot({ x: 0, y: 0, z: -5.65 }), f = rot({ x: 0, y: 0, z: 1 }), x = p.x + b.x, z = p.z + b.z;
      S.me.teleport(x, S.W.heightAt(x, z) + 0.05, z, Math.atan2(f.x, f.z));
      S.aimAt(p.x + rot({ x: 0, y: 0.3, z: -4.15 }).x, p.y + rot({ x: 0, y: 0.3, z: -4.15 }).y, p.z + rot({ x: 0, y: 0.3, z: -4.15 }).z);
    });
    const fixLabel = await host.waitForFunction(() => window.__nmd.target()?.kind === 'fix' && window.__nmd.target().label, null, { timeout: 20000 }).then(h => h.jsonValue(), () => '');
    const t0 = Date.now();
    const started = await host.waitForFunction(() => (window.__nmd.g?.fix || 0) > 0, null, { timeout: 8000, polling: 100 }).then(() => true, () => false);
    // a TV dropped at his feet and a look at it: the crosshair is on the TV now, and his hands stay on the engine
    const tvAt = await host.evaluate(() => {
      const S = window.__nmd, { p, q } = S.rv;
      const rot = v => { const x = q.y * v.z - q.z * v.y, y = q.z * v.x - q.x * v.z, z = q.x * v.y - q.y * v.x;
        const x2 = q.y * z - q.z * y, y2 = q.z * x - q.x * z, z2 = q.x * y - q.y * x;
        return { x: v.x + 2 * (q.w * x + x2), y: v.y + 2 * (q.w * y + y2), z: v.z + 2 * (q.w * z + z2) }; };
      const b = rot({ x: 0.7, y: 0, z: -4.95 }), x = p.x + b.x, z = p.z + b.z, y = S.W.heightAt(x, z);
      S.send({ t: 'dbg', op: 'spawn', type: 'tv', x, y: y + 0.5, z, value: 260 });
      return { x, y, z };
    });
    await host.waitForTimeout(1500);
    await host.evaluate(at => window.__nmd.aimAt(at.x, at.y + 0.2, at.z), tvAt);
    const blocked = await host.waitForFunction(() => window.__nmd.target()?.kind === 'prop', null, { timeout: 10000, polling: 100 }).then(() => true, () => false);
    const fixed = await host.waitForFunction(() => window.__nmd.g?.rvh === 20 && !window.__nmd.g?.brk, null, { timeout: 20000, polling: 100 }).then(() => true, () => false);
    const took = (Date.now() - t0) / 1000;
    await host.evaluate(() => window.__nmd.key('e', false));
    check(/\[Hold E\] fix the engine/.test(fixLabel) && started && blocked && fixed && took > 6 && took < 14, `broken down, behind the RV the crosshair says "${fixLabel}"; E held from before he got there starts the fix (${started}), a TV dropped into his crosshair doesn't stop it (${blocked}), and it's running again at 20% (${took.toFixed(1)} s)`);
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'rvhp', hp: 100 }));
  }

  // ---- painted textures: got ready off the main thread, written to the cache, read back next time ----
  const tx = await host.evaluate(() => window.__nmd.texCache.stats());
  check(tx.workers > 0 && !tx.fails && tx.workerPaints > 0, `paint workers painted the day's textures (${tx.workers} workers: ${tx.workerPaints} textures off the main thread, ${tx.pagePaints} on it)`);
  await host.waitForFunction(() => window.__nmd.texCache.idle(), null, { timeout: 240000, polling: 1000 });
  const tx2 = await host.evaluate(() => window.__nmd.texCache.stats());
  check(tx2.stored > 0 && !tx2.storeErr && !tx2.cache.broken, `painted textures went into the texture cache (${tx2.stored} textures, ${tx2.storedKB} KB)`);
  // a returning player: a new page in Steve's profile decodes the day's textures instead of painting them
  const back = await host.context().newPage();
  back.setDefaultTimeout(240000);
  back.on('pageerror', e => errors.push(`[Steve again] ${e.message}`));
  await back.goto(`http://localhost:${PORT}`);
  await back.fill('#nameInput', 'Steve');
  await back.fill('#seedInput', '777');
  await back.click('#hostBtn');
  await ready(back);
  const tx3 = await back.evaluate(() => window.__nmd.texCache.stats());
  check(tx3.cacheHits > 50 && tx3.workerPaints < 10, `a second visit decoded ${tx3.cacheHits} textures from the cache (${tx3.workerPaints} painted by workers, ${tx3.pagePaints} by the page)`);
  await back.close();

  // ---- connections: a dropped socket comes back to the same seat; Ctrl is the game's; no 3D says so; the end of the server is said out loud ----
  const was = await joiner.evaluate(() => ({ id: window.__nmd.selfId, built: window.__nmd.builtAt }));
  // (on one machine the reconnect can take less than a frame: watch for the banner, don't poll for it)
  await joiner.evaluate(() => {
    window.__sawConn = false;
    new MutationObserver(() => { if (/reconnecting/.test(document.getElementById('connBox')?.textContent || '')) window.__sawConn = true; })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__nmd.testDrop();
  });
  const backToast = host.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => /Dave is back/.test(t.textContent)), null, { timeout: 60000 }).then(() => true, () => false);
  await joiner.waitForFunction(() => !document.getElementById('connBox') && /Reconnected/.test([...document.querySelectorAll('.toast')].map(t => t.textContent).join(' ')), null, { timeout: 90000 });
  const after = await joiner.evaluate(() => ({ id: window.__nmd.selfId, built: window.__nmd.builtAt, saw: window.__sawConn }));
  const toldHost = await backToast;
  check(after.saw && toldHost && after.id === was.id && after.built === was.built, `Dave's dropped connection came back to the same seat without rebuilding the world (id ${was.id} -> ${after.id}; banner ${after.saw}, the host told ${toldHost}, rebuilt ${after.built !== was.built})`);
  const ctrlW = await joiner.evaluate(() => { const e = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true, bubbles: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  check(ctrlW, 'in game, Ctrl+W belongs to the game (crouch-walk), not the browser');
  {
    const nogl = await chromium.launch({ executablePath: EXE, args: ['--disable-3d-apis'] });
    const p = await nogl.newPage();
    await p.goto(`http://localhost:${PORT}`);
    const said = await p.waitForFunction(() => /couldn't start 3D/.test(document.body.textContent), null, { timeout: 60000 }).then(() => true, () => false);
    check(said, 'without WebGL the game says what to do, instead of a dead menu');
    await nogl.close();
  }
  {
    // a trip that closes before its welcome, then one that never answers: the menu says so, and works after
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(r => wss.once('listening', r));
    let joins = 0;
    wss.on('connection', ws => ws.on('message', d => { if (JSON.parse(d).t === 'join' && ++joins === 1) ws.close(4005, 'lost'); }));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(`[Lost] ${e.message}`));
    await p.goto(`http://localhost:${PORT}/?ws=ws://127.0.0.1:${wss.address().port}`);
    await p.fill('#codeInput', code);
    await p.click('#joinBtn');
    const lost = await p.waitForFunction(() => /Lost the connection/.test(document.getElementById('menuError').textContent) && !document.getElementById('joinBtn').disabled && !document.getElementById('menuStatus').textContent, null, { timeout: 30000 }).then(() => true, () => false);
    const t0 = Date.now();
    await p.click('#joinBtn');
    const gaveUp = await p.waitForFunction(() => /No answer/.test(document.getElementById('menuError').textContent) && !document.getElementById('hostBtn').disabled, null, { timeout: 40000 }).then(() => true, () => false);
    check(lost && gaveUp, `a trip that drops before its welcome says so; one that never answers is given up on after ${((Date.now() - t0) / 1000).toFixed(0)} s; the buttons work after both`);
    await ctx.close(); wss.close();
  }
  // ---- a map held overnight stays behind: the next day starts with empty hands, its map on the dash ----
  {
    await rolesNow(ids.dave, ids.steve);   // (still today's roles, set again after a reconnect and the town)
    await host.waitForFunction(id => window.__nmd.meta?.roles?.drv === id, ids.dave, { timeout: 24000 });
    await joiner.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.4, r.y + 0.1, r.z - 0.6, 0); });
    await wait(joiner, 900);
    await joiner.evaluate(() => window.__nmd.send({ t: 'use', kind: 'seat0' }));
    await joiner.waitForFunction(() => window.__nmd.me.mode === 'seat', null, { timeout: 24000 });
    const drv = await joiner.evaluate(() => window.__nmd.selfId);
    await host.waitForFunction(id => window.__nmd.g?.drv === id, drv, { timeout: 24000 });
    await host.evaluate(() => { const S = window.__nmd; const r = S.rv.p; S.me.teleport(r.x - 0.1, r.y + 0.1, r.z + 2.25, 0); });
    await wait(host, 900);
    await aimAtMap();
    await wait(host, 300);
    await host.evaluate(() => window.__nmd.press('grab'));
    const held = await host.waitForFunction(() => window.__nmd.me.holding?.ok === true, null, { timeout: 24000 }).then(() => true, () => false);
    const built = await host.evaluate(() => window.__nmd.builtAt);
    await host.evaluate(() => window.__nmd.send({ t: 'dbg', op: 'day', d: 2 }));
    await host.waitForFunction(b => window.__nmd.builtAt !== b && (window.__nmd.frames || 0) > 5, built, { timeout: 240000 });
    await wait(host, 900);
    const dawn = await host.evaluate(() => ({ holding: window.__nmd.me.holding, up: window.__nmd.mapUp() }));
    check(held && !dawn.holding && !dawn.up, `a map held overnight stays behind: day 2 starts with empty hands and no map up (held ${held}, then ${JSON.stringify(dawn.holding)}, map up ${dawn.up})`);
  }
  server.kill('SIGTERM');
  await joiner.waitForFunction(() => /The trip is over/.test(document.getElementById('netModal')?.textContent || ''), null, { timeout: 20000 });
  const said = (await joiner.evaluate(() => document.getElementById('netModal').textContent)).replace(/\s+/g, ' ').trim();
  check(/shut down/.test(said), `when the server shuts down, the guest is told why ("${said}")`);
} catch (e) {
  fail(e.stack || e.message);
}
const real = errors.filter(e => !/favicon|404/.test(e));
check(real.length === 0, real.length ? `page errors:\n${real.join('\n')}` : 'no page errors');
await browser.close();
console.log(failed ? '\n💥 BROWSER SMOKE TEST FAILED' : '\n🎉 BROWSER SMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
