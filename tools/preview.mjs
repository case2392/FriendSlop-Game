// Screenshot 3D assets:  node tools/preview.mjs oak,pine,rock [out.png] [biome] [hour] [WxH] [dist] [yaw]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
const [assets = '', out = 'test/screenshots/preview.png', biome = 'meadow', hour = '10', dims = '1200x700', dist = '1', yaw = '0.55'] = process.argv.slice(2);
const [W, H] = dims.split('x').map(Number);
fs.mkdirSync(path.dirname(out), { recursive: true });
const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);   // Chromium refuses these
let PORT; do PORT = 7000 + Math.floor(Math.random() * 800); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 10000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${PORT}/preview.html?assets=${assets}&biome=${biome}&hour=${hour}&dist=${dist}&yaw=${yaw}`);
await page.waitForFunction(() => window.__previewDone, null, { timeout: 180000 });
await page.waitForTimeout(300);
await page.screenshot({ path: out });
const err = await page.textContent('#err');
console.log(`preview → ${out}`);
if (err) console.log('PAGE ERROR:', err);
if (errors.length) console.log('console errors:\n' + errors.filter(e => !/404/.test(e)).join('\n'));
await browser.close();
process.exit(0);
