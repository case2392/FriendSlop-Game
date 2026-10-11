// The desktop build, end to end: the real Electron app (desktop/main.cjs), driven by Playwright.
//   1. On its own, with no Steam running: the app:// page, the build it reports, the locked-down shell
//      (no navigation away, no pop-ups, no Ctrl+W, the page's files only), a trip, leaving it and starting
//      another, F11, and Quit (the game server goes with it).
//   2. Two copies over test/fakesteam (a stand-in for Steam): the host starts a trip (a lobby opens), a
//      friend's invite arrives while their game sits on the menu, they join through the bridge, both see
//      each other, rich presence is set, the texture cache survived the restart, and when the host leaves
//      the friend is told the trip is over.
//   node test/desktop-smoke.mjs      (runs itself under xvfb-run when there's no display)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.DISPLAY && process.platform === 'linux' && !process.env.NMD_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x900x24', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NMD_XVFB: '1' } });
  process.exit(r.status ?? 1);
}
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const ELECTRON = require('electron');            // the binary's path
const { computeBuild } = await import('../server/build.js');
const { startBackend } = await import('./fakesteam/backend.mjs');
const { initFakeSteam } = await import('./fakesteam/client.mjs');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(step); } return false; };
const BUILD = computeBuild();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nmd-desktop-'));
const ARGS = [ROOT, '--no-sandbox', '--swiftshader', '--windowed'];
const errors = [];

async function launch(name, { userData, env = {}, args = [] }) {
  const app = await electron.launch({
    executablePath: ELECTRON, args: [...ARGS, ...args], timeout: 60000,
    env: { ...process.env, NMD_USER_DATA: userData, ...env },
  });
  const page = await app.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(240000);
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[${name} console] ${m.text()}`); });
  await page.waitForFunction(() => window.__nmd && document.getElementById('hostBtn'));
  return { app, page, name };
}
const ready = p => p.waitForFunction(() => window.__nmd?.W && window.__nmd?.rv && (window.__nmd.frames || 0) > 20, null, { timeout: 300000 });
const startTrip = async (p, name) => { await p.fill('#nameInput', name); await p.fill('#seedInput', '777'); await p.click('#hostBtn'); await ready(p); };
const isFull = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
// keys through the window's native input path (Playwright's keyboard goes straight to the page, past the shell)
const nativeKey = (app, keyCode, modifiers = []) => app.evaluate(({ BrowserWindow }, [k, m]) => {
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
  wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
}, [keyCode, modifiers]);
const pids = app => app.evaluate(({ app: a }) => a.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '' })));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

let solo = null;
try {
  // ---- 1. on its own, no Steam -----------------------------------------------------------------------
  const udHost = path.join(tmp, 'host');
  solo = await launch('solo', { userData: udHost });
  const { app, page } = solo;
  const info = await page.evaluate(async () => ({
    origin: location.origin, secure: isSecureContext, desk: !!window.desktop?.isDesktop, build: window.desktop.build,
    ws: window.desktop.wsUrl, steam: window.desktop.steam, joinHidden: document.getElementById('joinBox').classList.contains('hidden'),
    quit: !document.getElementById('quitBtn').classList.contains('hidden'), note: document.getElementById('menuSteam').textContent,
    csp: (await fetch('/')).headers.get('content-security-policy') || '',
  }));
  check(info.origin === 'app://nmd' && info.secure && info.desk, `the page runs at ${info.origin} (a secure context) with window.desktop`);
  check(info.build === BUILD && /^ws:\/\/127\.0\.0\.1:\d+$/.test(info.ws || ''), `the shell reports this build (${info.build}) and the game server's socket (${info.ws})`);
  check(info.steam.ok === false && /Steam isn't running/.test(info.note) && info.joinHidden && info.quit, `no Steam running: the menu says so ("${info.note}"), no trip codes, a Quit button`);
  check(/script-src 'self'/.test(info.csp) && /connect-src 'self' ws:\/\/127\.0\.0\.1:\*/.test(info.csp), 'the page has a content security policy (its own scripts, sockets to this PC only)');
  const files = await page.evaluate(async () => Promise.all(['/%2e%2e/package.json', '/..%2fpackage.json', '/shared/%2e%2e/server/host.js', '/vendor/rapier.mjs', '/shared/world.js'].map(u => fetch(u).then(r => r.status, () => 'blocked'))));
  check(files[0] !== 200 && files[1] !== 200 && files[2] !== 200 && files[3] === 200 && files[4] === 200, `app:// serves the game's files and nothing outside them (${files.join(', ')})`);
  check(await page.evaluate(() => window.open('https://example.com/') === null), 'the page can\'t open a pop-up window');
  const mic = await page.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then(s => s.state, e => String(e)));
  check(mic === 'granted', `the microphone is allowed for voice chat (${mic})`);

  await startTrip(page, 'Solo');
  check(await page.evaluate(() => window.__nmd.phase === 'game' && !!window.__nmd.code), 'a trip starts and the world builds in the desktop app');
  check(await page.evaluate(() => document.getElementById('hCode').classList.contains('hidden')), 'no room code or invite pill without Steam');
  await nativeKey(app, 'W', ['control']);
  await nativeKey(app, 'R', ['control']);
  await nativeKey(app, 'Q', ['control']);
  await sleep(1500);
  check(!page.isClosed() && (await page.evaluate(() => window.__nmd.phase)) === 'game', 'Ctrl+W, Ctrl+R and Ctrl+Q don\'t close, reload or quit the game');
  await nativeKey(app, 'F11');
  const fsOn = await until(() => isFull(app), 5000);
  await nativeKey(app, 'Enter', ['alt']);
  const fsOff = await until(async () => !(await isFull(app)), 5000);
  check(fsOn && fsOff, 'F11 and Alt+Enter toggle fullscreen');

  // leave the trip from the in-game menu and start another one (the host's game ends its own trip)
  await page.evaluate(() => { document.exitPointerLock?.(); document.getElementById('help').classList.add('hidden'); document.getElementById('clickToPlay').classList.remove('hidden'); });
  await page.click('#ctpLeave');
  await page.click('#netModal button:has-text("Leave")');
  await page.waitForFunction(() => window.__nmd?.phase === 'menu' && !document.getElementById('menu').classList.contains('hidden'), null, { timeout: 60000 });
  await page.fill('#nameInput', 'Solo');
  await page.click('#hostBtn');
  const again = await page.waitForFunction(() => window.__nmd.phase === 'game', null, { timeout: 120000 }).then(() => true, () => false);
  check(again, 'Leave Trip goes back to the menu, and the next trip starts');
  await page.evaluate(() => window.__nmd.backToMenu(null));
  await page.waitForFunction(() => window.__nmd?.phase === 'menu', null, { timeout: 60000 });

  // a second copy hands over to the first and quits
  const t2 = Date.now();
  const second = spawn(ELECTRON, [...ARGS], { env: { ...process.env, NMD_USER_DATA: udHost }, stdio: 'ignore' });
  const code2 = await new Promise(res => { second.on('exit', c => res(c)); setTimeout(() => { second.kill(); res('still running'); }, 30000); });
  check(code2 === 0, `a second copy started by hand exits at once (code ${code2}, ${Date.now() - t2} ms)`);

  // the page can't be sent away from the game (Playwright waits forever for a navigation the shell
  // refused, so this goes last, and only page.evaluate from here on)
  await page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
  await sleep(1000);
  const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  check(url.startsWith('app://nmd/'), `the page can't navigate away from the game (still at ${url})`);

  // Quit: the window, the game server and the rest of Electron's processes all go
  const procs = (await pids(app)).filter(p => p.type === 'Utility');
  const closed = new Promise(res => app.process().once('exit', c => res(c)));
  await page.evaluate(() => document.getElementById('quitBtn').click());
  const exitCode = await Promise.race([closed, sleep(15000).then(() => 'timeout')]);
  await sleep(500);
  const left = procs.filter(p => alive(p.pid));
  check(exitCode === 0 && procs.length > 0 && !left.length, `Quit closes the game (exit ${exitCode}) and its game server (${procs.map(p => p.name || p.pid).join(', ')})`);
  const log = fs.readFileSync(path.join(udHost, 'logs', 'main.log'), 'utf8');
  check(/the game server is up/.test(log) && /\[main\] bye/.test(log), 'the log file has the run, start to finish');
  solo = null;

  // ---- 2. two copies over the fake Steam ------------------------------------------------------------
  const be = await startBackend({});
  const fakeEnv = (id, name) => ({ NMD_FAKE_STEAM: String(be.port), NMD_FAKE_ID: String(76561190000000000n + BigInt(id)), NMD_FAKE_NAME: name });
  const host = await launch('host', { userData: udHost, env: fakeEnv(1, 'Hosty') });
  const guest = await launch('guest', { userData: path.join(tmp, 'guest'), env: fakeEnv(2, 'Dave') });
  try {
    const hs = await host.page.evaluate(() => ({ steam: window.desktop.steam, note: document.getElementById('menuSteam').textContent, name: document.getElementById('nameInput').value }));
    check(hs.steam.ok && hs.steam.name === 'Hosty' && /On Steam as Hosty/.test(hs.note) && hs.name, `with Steam: "${hs.note}"`);
    await host.page.fill('#seedInput', '777');
    await host.page.click('#hostBtn');
    await ready(host.page);
    const tex = await host.page.evaluate(() => window.__nmd.texCache.stats());
    check(tex.cacheHits > 50, `the texture cache survived the restart: ${tex.cacheHits} textures from the cache, ${tex.workerPaints} painted`);
    const lobbyUp = await until(() => [...be.lobbies.values()].some(L => L.data.code), 15000);
    const L = [...be.lobbies.values()].find(L => L.data.code);
    check(lobbyUp && L.data.build === BUILD && L.type === 1 && L.max === 6, `starting a trip opened a friends-only Steam lobby (code ${L?.data.code}, build ${L?.data.build})`);
    check(await host.page.evaluate(() => /Invite/.test(document.getElementById('hCode').textContent) && !document.getElementById('ctpInvite').classList.contains('hidden')), 'the host gets Invite Friends (the pill and the Esc menu)');
    const inv = await host.page.evaluate(() => window.desktop.invite());
    check(inv.ok, 'Invite Friends opens Steam\'s invite dialog');

    // a friend accepts the invite while their game sits on the menu
    const inviter = await initFakeSteam({ port: be.port, steamId: 76561190000000009n, name: 'Steam' });
    inviter.__fake.invite(L.id, 76561190000000002n);
    await ready(guest.page);
    const gs = await guest.page.evaluate(() => ({ id: window.__nmd.selfId, code: window.__nmd.code, roster: window.__nmd.meta?.players.map(p => p.name) }));
    await until(() => host.page.evaluate(() => window.__nmd.meta?.players.length === 2), 20000);
    const hr = await host.page.evaluate(() => window.__nmd.meta?.players.map(p => p.name));
    check(gs.code === L.data.code && hr.length === 2 && hr.includes('Dave') && gs.roster?.length === 2, `the friend's invite brought them into the host's trip over Steam (host sees ${hr.join(', ')}; Dave sees ${gs.roster?.join(', ')})`);
    const quiet = await guest.page.evaluate(() => new Promise(res => setTimeout(() => res(performance.now() - window.__nmd.lastMsgAt()), 1500)));
    check(quiet < 500, `the friend's game is live (the last message came ${Math.round(quiet)} ms ago: snapshots keep coming through the bridge)`);
    await until(() => (be.users.get('76561190000000001')?.presence.steam_player_group_size) === '2', 5000);
    await sleep(1500);
    const pres = Object.fromEntries([...be.users].map(([id, u]) => [id, u.presence]));
    const hp = pres['76561190000000001'], gp = pres['76561190000000002'];
    check(hp?.steam_display === '#Status_Camp' && gp?.steam_display === '#Status_Camp' && hp?.steam_player_group === String(L.id) && gp?.steam_player_group === String(L.id) && hp?.steam_player_group_size === '2', `rich presence for both, grouped by the lobby (${JSON.stringify(hp)})`);

    // the host leaves: the friend is told the trip is over, and goes back to the menu
    await host.page.evaluate(() => window.__nmd.backToMenu(null));
    const told = await guest.page.waitForFunction(() => /The trip is over/.test(document.getElementById('netModal')?.textContent || ''), null, { timeout: 20000 }).then(() => guest.page.evaluate(() => document.getElementById('netModal').textContent), () => null);
    check(told && /Hosty ended the trip/.test(told), `when the host leaves, the friend is told: "${told}"`);
    await guest.page.click('#netModal button');
    const menu = await guest.page.waitForFunction(() => window.__nmd?.phase === 'menu' && !document.getElementById('menu').classList.contains('hidden'), null, { timeout: 60000 }).then(() => true, () => false);
    await until(() => ![...be.lobbies.values()].some(L2 => L2.members.includes('76561190000000002')), 5000);
    check(menu && ![...be.lobbies.values()].some(L2 => L2.members.length), 'the friend is back on their menu, and the lobby is gone');
    inviter.__fake.close();
  } finally {
    await host.app.close().catch(() => {});
    await guest.app.close().catch(() => {});
    be.close();
  }
} catch (e) {
  fail('exception: ' + (e.stack || e));
} finally {
  if (solo) await solo.app.close().catch(() => {});
}

const bad = errors.filter(e => !/ResizeObserver loop|net::ERR_ABORTED/.test(e));
check(!bad.length, bad.length ? `page errors:\n  ${bad.slice(0, 12).join('\n  ')}` : 'no page errors');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(failed ? '\n💥 DESKTOP TEST FAILED' : '\n🎉 DESKTOP TEST PASSED');
process.exit(failed ? 1 : 0);
