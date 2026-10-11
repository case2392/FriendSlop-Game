// Dev harness: boot the server, open Chromium, start a trip, take screenshots.
//   node tools/shot.mjs [script.json-ish steps via env]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);   // Chromium refuses these
let PORT; do PORT = 3300 + Math.floor(Math.random() * 500); while (UNSAFE_PORTS.has(PORT));
const OUT = process.env.OUT || 'test/screenshots';
fs.mkdirSync(OUT, { recursive: true });
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 8000); });

const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
export async function newPage(name, w = 1280, h = 720) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.type()}: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}`);
  await page.evaluate(() => localStorage.setItem('nmdHelpSeen', '1'));
  await page.fill('#nameInput', name);
  return page;
}
const page = await newPage('Steve');
if (process.env.SEED) await page.fill('#seedInput', process.env.SEED);
await page.click('#hostBtn');
await page.waitForFunction(() => window.__nmd?.W && window.__nmd?.g, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate(() => { document.getElementById('clickToPlay').classList.add('hidden'); });
const steps = JSON.parse(process.env.STEPS || '[]');
let i = 0;
for (const s of steps) {
  if (s.eval) await page.evaluate(s.eval);
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.shot) { await page.screenshot({ path: `${OUT}/${s.shot}.png` }); console.log('shot', s.shot); }
  if (s.log) console.log(s.log, JSON.stringify(await page.evaluate(s.logEval)));
  i++;
}
const fps = await page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); }; requestAnimationFrame(f); }));
console.log('fps (swiftshader)', fps);
console.log('errors:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'none');
await browser.close();
process.exit(0);
