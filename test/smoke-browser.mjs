// Browser smoke test: two real Chromium pages walk their blobs through the
// whole embodied loop — into the gate, through a chamber, onto a vote zone.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 3198;
const BASE = `http://localhost:${PORT}`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });

const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function fail(msg) { console.error('❌ FAIL:', msg); process.exit(1); }

process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
process.on('uncaughtException', e => { console.error('❌ FAIL:', e.message); process.exit(1); });

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), FRIENDSLOP_FAST: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('sloppin')) res(); });
  setTimeout(() => rej(new Error('server never started')), 5000);
}).catch(e => fail(e.message));

const browser = await chromium.launch({
  executablePath: EXE,
  args: [
    // fake mic so voice chat can be exercised headlessly
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const pageErrors = [];

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(`[${name}] console: ${m.text()}`); });
  await page.goto(BASE);
  await page.fill('#nameInput', name);
  return page;
}

// Body autopilot: walk to wherever the current mode needs bodies.
function makeAutopilot(page) {
  const held = { a: false, d: false, w: false, s: false };
  return async () => {
    const want = await page.evaluate(() => {
      const S = window.__slop;
      if (!S || !S.snap || !S.meta) return null;
      const me = S.snap.players.find(p => p[0] === S.selfId);
      if (!me) return null;
      const [, x, y] = me;
      const HUB = { GATE: { x: 800, y: 150 }, STAND: { x: 980, y: 700 } };
      let t = null;
      if (S.phase === 'play') {
        if (S.minigame === 'casino') t = HUB.STAND;
        else if (S.minigame === 'rv' && S.snap?.extra?.rv) {
          const [rx, ry] = S.snap.extra.rv;
          t = { x: rx - 130, y: ry }; // shoulder on the bumper
        } else return { rand: true };
      } else if (S.hubMode === 'lobby' || S.hubMode === 'gate') t = HUB.GATE;
      if (!t) return null;
      return { a: t.x < x - 25, d: t.x > x + 25, w: t.y < y - 25, s: t.y > y + 25 };
    }).catch(() => null);
    if (!want) return;
    if (want.rand) {
      // press() releases keys — keep the held-state truthful first
      for (const k of Object.keys(held)) {
        if (held[k]) { held[k] = false; await page.keyboard.up(k).catch(() => {}); }
      }
      await page.keyboard.press('wasd'[Math.floor(Math.random() * 4)]).catch(() => {});
      if (Math.random() < 0.25) await page.keyboard.press(' ').catch(() => {});
      return;
    }
    for (const k of Object.keys(held)) {
      if (want[k] && !held[k]) { held[k] = true; await page.keyboard.down(k).catch(() => {}); }
      if (!want[k] && held[k]) { held[k] = false; await page.keyboard.up(k).catch(() => {}); }
    }
  };
}

const host = await newPage('BigDog');
await host.screenshot({ path: SHOTS + '01-menu.png' });

await host.click('#hostBtn');
await host.waitForSelector('#game:not(.hidden)');
await host.waitForFunction(() => window.__slop?.meta?.phase === 'hub', null, { polling: 250 });
const code = await host.evaluate(() => window.__slop.code);
if (!/^[A-Z2-9]{4}$/.test(code)) fail(`bad room code: "${code}"`);
console.log('✅ hosted — dropped straight into the 3D Den, room', code);

const p2 = await newPage('Goober');
await p2.fill('#codeInput', code);
await p2.click('#joinBtn');
await p2.waitForSelector('#game:not(.hidden)');
console.log('✅ second player joined into the Den');

await host.click('#addBotBtn');
await host.click('#addBotBtn');
await host.waitForFunction(() => window.__slop.meta.players.length === 4, null, { polling: 250 });

// Voice chat: both players join voice; a real WebRTC connection should form
// between the two pages (localhost is a secure context, mic is faked).
await host.click('#voiceJoinBtn');
await p2.click('#voiceJoinBtn');
await host.waitForFunction(() => window.__slop.voice?.on === true, null, { polling: 250 });
await p2.waitForFunction(() => window.__slop.voice?.on === true, null, { polling: 250 });
await host.waitForFunction(
  () => [...window.__slop.voice.peers.values()].some(p => p.pc.connectionState === 'connected'),
  null, { timeout: 20000, polling: 250 },
).catch(() => fail('voice peers never reached connected state'));
const talkers = await host.evaluate(() => window.__slop.meta.players.filter(p => p.voice).length);
if (talkers !== 2) fail(`expected 2 players flagged in voice, got ${talkers}`);
console.log('✅ voice chat: WebRTC mesh connected between both pages');

await host.waitForTimeout(1200); // let blobs mill about
await host.screenshot({ path: SHOTS + '02-den.png' });

const drive = [makeAutopilot(host), makeAutopilot(p2)];
const driver = setInterval(() => drive.forEach(fn => fn()), 150);

// Walking into the gate starts chamber 1.
await host.waitForFunction(() => window.__slop.phase === 'play', null, { timeout: 30000, polling: 250 });
console.log('✅ squad walked into the gate — chamber begins');
await host.waitForTimeout(1100);
await host.screenshot({ path: SHOTS + '04-gameplay.png' });

// Ride to the casino chamber: cards get dealt in-world.
await host.waitForFunction(() => window.__slop.phase === 'play' && window.__slop.minigame === 'casino' && window.__slop.snap?.extra?.bj?.squad?.length >= 2, null, { timeout: 120000, polling: 250 });
console.log("✅ THE BOSS'S CASINO deals in-world");
await host.waitForTimeout(450); // cards mid-deal
await host.screenshot({ path: SHOTS + '05-blackjack.png' });

let outcome = null;
await host.waitForFunction(() => window.__slop.snap?.extra?.bj?.outcome != null || window.__slop.minigame !== 'casino' || window.__slop.phase !== 'play', null, { timeout: 60000, polling: 250 });
outcome = await host.evaluate(() => window.__slop.snap?.extra?.bj?.outcome ?? 'resolved (chamber moved on)');
console.log(`✅ hand resolved by body-vote: ${outcome}`);

// Ride to the end of the expedition.
await host.waitForFunction(() => window.__slop.hubMode === 'celebrate', null, { timeout: 240000, polling: 250 });
clearInterval(driver);
await host.waitForTimeout(600);
await host.screenshot({ path: SHOTS + '07-celebrate.png' });
const esc = await host.evaluate(() => window.__slop.snap?.extra?.escaped);
console.log(`✅ expedition over (escaped=${esc}) — celebration in the Den`);

const realErrors = pageErrors.filter(e => !e.includes('favicon'));
if (realErrors.length) fail('page errors:\n' + realErrors.slice(0, 10).join('\n'));
console.log('✅ zero page/console errors across the whole expedition');

console.log('\n🎉 BROWSER SMOKE TEST PASSED — screenshots in test/screenshots/');
await browser.close();
server.kill();
process.exit(0);
