// The app's icons, drawn from the page's own favicon (client/index.html's inline SVG):
//   desktop/build/icon.png (512 px: Linux), desktop/build/icon.ico (Windows: 16-256 px), desktop/icon.png
//   (256 px: the window's icon). Run after changing the favicon: npm run icons
// (Steam's own library art is separate: docs/STEAM.md.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, '../client/index.html'), 'utf8');
const href = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)"/)[1];
const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
const png = {};
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  png[s] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
}
await browser.close();
// ICO: a 6-byte header, a 16-byte entry per image, then the PNGs (Windows Vista and later read PNG entries)
const sizes = [16, 24, 32, 48, 64, 128, 256];
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png[s].length, e + 8); head.writeUInt32LE(off, e + 12);
  off += png[s].length;
});
fs.mkdirSync(path.join(HERE, 'build'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'build/icon.ico'), Buffer.concat([head, ...sizes.map(s => png[s])]));
fs.writeFileSync(path.join(HERE, 'build/icon.png'), png[512]);
fs.writeFileSync(path.join(HERE, 'icon.png'), png[256]);
console.log('icons:', ['build/icon.ico', 'build/icon.png', 'icon.png'].map(f => `desktop/${f} ${fs.statSync(path.join(HERE, f)).size} B`).join(', '));
