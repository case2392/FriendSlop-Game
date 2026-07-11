// Browser smoke test: three real Chromium pages host/join a room via the UI,
// start a match, and screenshot every major screen.
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
  env: { ...process.env, PORT: String(PORT), FRIENDSLOP_FAST: process.env.SLOW_SHOTS ? '' : '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('sloppin')) res(); });
  setTimeout(() => rej(new Error('server never started')), 5000);
}).catch(e => fail(e.message));

const browser = await chromium.launch({ executablePath: EXE });
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

const host = await newPage('BigDog');
await host.screenshot({ path: SHOTS + '01-menu.png' });

await host.click('#hostBtn');
await host.waitForSelector('#lobby:not(.hidden)');
const code = (await host.textContent('#roomCode')).trim();
if (!/^[A-Z2-9]{4}$/.test(code)) fail(`bad room code in UI: "${code}"`);
console.log('✅ hosted room', code);

const p2 = await newPage('Goober');
await p2.fill('#codeInput', code);
await p2.click('#joinBtn');
await p2.waitForSelector('#lobby:not(.hidden)');
console.log('✅ second player joined via UI');

// two bots so the arena is lively
await host.click('#addBotBtn');
await host.click('#addBotBtn');
await host.waitForFunction(() => document.querySelectorAll('.lobby-player').length === 4);

await host.fill('#chatInput', 'prepare to lose everything');
await host.click('#chatSend');
await p2.waitForFunction(() => document.querySelector('#chatLog').textContent.includes('prepare to lose'));
console.log('✅ lobby chat works');
await host.screenshot({ path: SHOTS + '02-lobby.png' });

await host.click('#startBtn');
await host.waitForSelector('#betOverlay:not(.hidden)', { timeout: 10000 });
console.log('✅ betting phase reached');

// host bets on player 2 through the UI
await host.waitForSelector('.bet-target');
const targets = await host.$$('.bet-target');
await targets[1].click();
await host.click('.bet-amounts .chip[data-frac="0.5"]');
await host.waitForFunction(() => document.querySelector('#betCurrent').textContent.includes('🪙 on'));
console.log('✅ bet placed via UI');
await host.screenshot({ path: SHOTS + '03-betting.png' });

await host.waitForSelector('#betOverlay.hidden', { state: 'attached', timeout: 30000 });
// hold a direction so our blob visibly moves; mash dash sometimes
await host.keyboard.down('d');
await p2.keyboard.down('a');
const masher = setInterval(async () => {
  try {
    for (const pg of [host, p2]) {
      const key = 'wasd'[Math.floor(Math.random() * 4)];
      await pg.keyboard.press(key);
      if (Math.random() < 0.3) await pg.keyboard.press(' ');
    }
  } catch { /* page may be closing */ }
}, 400);

await host.waitForFunction(() => {
  const cv = document.getElementById('canvas');
  return cv && !document.getElementById('game').classList.contains('hidden');
});
await host.waitForTimeout(process.env.SLOW_SHOTS ? 6000 : 2500);
await host.screenshot({ path: SHOTS + '04-gameplay.png' });
console.log('✅ gameplay running, screenshot taken');

await host.waitForSelector('#resultsOverlay:not(.hidden)', { timeout: 120000 });
await host.waitForTimeout(400);
await host.screenshot({ path: SHOTS + '05-results.png' });
console.log('✅ results overlay shown');

if (!process.env.SLOW_SHOTS) {
  await host.waitForSelector('#podiumOverlay:not(.hidden)', { timeout: 180000 });
  await host.waitForTimeout(400);
  await host.screenshot({ path: SHOTS + '06-podium.png' });
  console.log('✅ podium shown after 5 rounds');
}
clearInterval(masher);

const realErrors = pageErrors.filter(e => !e.includes('favicon'));
if (realErrors.length) fail('page errors:\n' + realErrors.join('\n'));
console.log('✅ zero page/console errors across the whole match');

console.log('\n🎉 BROWSER SMOKE TEST PASSED — screenshots in test/screenshots/');
await browser.close();
server.kill();
process.exit(0);
