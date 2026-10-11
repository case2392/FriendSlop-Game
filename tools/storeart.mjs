// Steam's store and library images, made from the game itself: the title screen's painting (its 2D vista
// with the 3D diorama rendered over it, here at 3840 x 2160 and without the signpost, so the art has no
// words) and the title's own lettering, cropped and laid out at the sizes Steam asks for
// (partner.steamgames.com/doc/store/assets). Writes dist/store/ (not in git) and a contact sheet to look
// over, and fails if any file isn't exactly its size.
//   node tools/storeart.mjs [outdir]          (a few minutes on software GL, quicker on a real GPU)
// The store's screenshots (at least 5, 1920 x 1080, real play, no text added) come from tools/scene.mjs:
//   SCENE_W=1920 SCENE_H=1080 node tools/scene.mjs camp,road,crew dist/store/screenshots 1
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist/store'));
const ART = [3840, 2160];
// name, width, height, the art's crop (focus x, y as 0..1 of the art; zoom: 1 = as much as fits),
// the logo (two lines with the filigree, two lines, one line, or none) and the box it fits in (0..1 of
// the image), how dark the top and bottom go (so the gold title reads), and the file type
const ASSETS = [
  { name: 'header_capsule', w: 920, h: 430, fx: 0.5, fy: 0.55, zoom: 1, logo: 'fil', box: [0.2, 0.04, 0.6, 0.6], shade: 0.55 },
  { name: 'small_capsule', w: 462, h: 174, fx: 0.42, fy: 0.62, zoom: 0.78, logo: 'one', box: [0.04, 0.12, 0.92, 0.76], shade: 0.7 },
  { name: 'main_capsule', w: 1232, h: 706, fx: 0.5, fy: 0.55, zoom: 1, logo: 'fil', box: [0.22, 0.04, 0.56, 0.48], shade: 0.5 },
  { name: 'vertical_capsule', w: 748, h: 896, fx: 0.3, fy: 0.55, zoom: 1, logo: 'fil', box: [0.06, 0.03, 0.88, 0.36], shade: 0.55 },
  { name: 'page_background', w: 1438, h: 810, fx: 0.5, fy: 0.5, zoom: 1, logo: null, shade: 0.35, quiet: true, type: 'jpeg' },
  { name: 'library_capsule', w: 600, h: 900, fx: 0.27, fy: 0.55, zoom: 1, logo: 'fil', box: [0.05, 0.03, 0.9, 0.33], shade: 0.55 },
  { name: 'library_header', w: 920, h: 430, fx: 0.5, fy: 0.55, zoom: 1, logo: 'fil', box: [0.2, 0.04, 0.6, 0.6], shade: 0.55 },
  { name: 'library_hero', w: 3840, h: 1240, fx: 0.5, fy: 0.62, zoom: 1, logo: null, shade: 0 },     // no words at all
];

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 9000 + Math.floor(Math.random() * 900); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s]`, ...a);

// a PNG's or a JPEG's pixel size, from its header
function dims(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return null;
}
const save = (file, dataUrl, w, h) => {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64'), d = dims(buf);
  fs.writeFileSync(path.join(OUT, file), buf);
  const ok = !w || (d && d[0] === w && d[1] === h);
  log(`${ok ? 'ok ' : 'BAD'} ${file}  ${d ? d.join(' x ') : '?'}  ${(buf.length / 1024).toFixed(0)} KB`);
  return ok;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let bad = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(900000);
  await page.goto(`http://localhost:${PORT}/?titlesize=${ART[0]}x${ART[1]}&nosign`);
  await page.evaluate(() => document.fonts.ready);
  log('painting the title at', ART.join(' x '));
  await page.waitForFunction(() => document.documentElement.dataset.menuArt);
  log('title art:', await page.evaluate(() => document.documentElement.dataset.menuArt));
  // the finished painting, as the menu got it (a blob URL in --tx-menu-final)
  const artUrl = await page.evaluate(async () => {
    const v = document.documentElement.style.getPropertyValue('--tx-menu-final');
    const b = await (await fetch(v.match(/url\("?([^")]+)"?\)/)[1])).blob();
    return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
  });
  save('key_art.png', artUrl, ART[0], ART[1]) || bad++;

  // the logo: the menu's own title on a transparent page, big
  await page.setViewportSize({ width: 2800, height: 1500 });
  await page.addStyleTag({ content: `
    html, body { background: transparent !important; }
    #menu { background: none !important; justify-content: center !important; }
    #menu::before, #menu > :not(.title-wrap), .kicker, .tagline, #loading { display: none !important; }
    .game-title { font-size: 340px !important; }
    .filigree { width: 1500px !important; height: 120px !important; }` });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const shoot = async sel => {
    const bb = await page.locator(sel).boundingBox(), pad = 48;
    const clip = { x: Math.max(0, bb.x - pad), y: Math.max(0, bb.y - pad), width: Math.ceil(bb.width + pad * 2), height: Math.ceil(bb.height + pad * 2) };
    return 'data:image/png;base64,' + (await page.screenshot({ clip, omitBackground: true })).toString('base64');
  };
  const logos = { fil: await shoot('.title-wrap') };
  await page.addStyleTag({ content: '.filigree { display: none !important; }' });
  logos.two = await shoot('.game-title');
  await page.addStyleTag({ content: `.game-title { font-size: 260px !important; white-space: nowrap; }
    .game-title span { display: inline !important; } .game-title .t1 { font-size: 1em !important; letter-spacing: 6px !important; margin-right: 0.3em; }` });
  await page.waitForTimeout(300);
  logos.one = await shoot('.game-title');
  log('logos captured');

  // compose every image in a canvas, in the page
  const made = await page.evaluate(async ({ artUrl, logos, ASSETS }) => {
    const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    // trim a logo shot to its opaque pixels (the shot has padding round the letters' glow)
    const trim = im => {
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const t = document.createElement('canvas'); t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
      t.getContext('2d').drawImage(c, -x0, -y0);
      return t;
    };
    const art = await img(artUrl);
    const L = {};
    for (const k of Object.keys(logos)) L[k] = trim(await img(logos[k]));
    const out = {};
    for (const a of ASSETS) {
      const c = document.createElement('canvas'); c.width = a.w; c.height = a.h;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      // the crop: the target's aspect round the focus point, as big as the zoom allows
      const ar = a.w / a.h;
      let ch = Math.min(art.height, art.width / ar) * a.zoom, cw = ch * ar;
      if (cw > art.width) { cw = art.width; ch = cw / ar; }
      const sx = Math.min(Math.max(a.fx * art.width - cw / 2, 0), art.width - cw), sy = Math.min(Math.max(a.fy * art.height - ch / 2, 0), art.height - ch);
      if (a.quiet) g.filter = 'saturate(0.7) blur(1.2px)';
      g.drawImage(art, sx, sy, cw, ch, 0, 0, a.w, a.h);
      g.filter = 'none';
      if (a.shade) {
        const v = g.createLinearGradient(0, 0, 0, a.h);
        v.addColorStop(0, `rgba(10,8,16,${a.shade})`); v.addColorStop(0.45, `rgba(10,8,16,${a.shade * 0.25})`);
        v.addColorStop(0.7, 'rgba(10,8,16,0)'); v.addColorStop(1, `rgba(10,6,4,${a.shade * 0.9})`);
        g.fillStyle = v; g.fillRect(0, 0, a.w, a.h);
      }
      if (a.logo) {
        const lg = L[a.logo], [bx, by, bw, bh] = a.box;
        const k = Math.min(bw * a.w / lg.width, bh * a.h / lg.height), lw = lg.width * k, lh = lg.height * k;
        g.drawImage(lg, bx * a.w + (bw * a.w - lw) / 2, by * a.h + (bh * a.h - lh) / 2, lw, lh);
      }
      out[a.name] = a.type === 'jpeg' ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
    }
    // the library logo: the two-line title, 1280 wide (Steam: 1280 wide and/or 720 tall, transparent)
    {
      const lg = L.two, k = Math.min(1280 / lg.width, 720 / lg.height);
      const c = document.createElement('canvas'); c.width = Math.round(lg.width * k); c.height = Math.round(lg.height * k);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(lg, 0, 0, c.width, c.height);
      out.library_logo = c.toDataURL('image/png');
      out.library_logo_size = [c.width, c.height];
    }
    return out;
  }, { artUrl, logos, ASSETS });
  for (const a of ASSETS) save(`${a.name}.${a.type === 'jpeg' ? 'jpg' : 'png'}`, made[a.name], a.w, a.h) || bad++;
  const [lw, lh] = made.library_logo_size;
  save('library_logo.png', made.library_logo, lw, lh) || bad++;
  if (!(lw === 1280 || lh === 720)) { log('BAD library_logo: neither 1280 wide nor 720 tall'); bad++; }

  // the icons: the game's coin (the page's favicon, as the desktop build's icon) on the dark of the UI
  const icons = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="icon"]').href;
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = href; });
    const at = (s, bg) => { const c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d'); if (bg) { g.fillStyle = bg; g.fillRect(0, 0, s, s); } g.drawImage(im, s * 0.04, s * 0.04, s * 0.92, s * 0.92); return c; };
    return { community: at(184, '#20160e').toDataURL('image/jpeg', 0.95), shortcut: at(256, null).toDataURL('image/png') };
  });
  save('community_icon.jpg', icons.community, 184, 184) || bad++;
  save('shortcut_icon.png', icons.shortcut, 256, 256) || bad++;

  // a contact sheet to look everything over
  const files = fs.readdirSync(OUT).filter(f => /\.(png|jpg)$/.test(f) && f !== 'contact_sheet.jpg' && f !== 'key_art.png').sort();
  const sheet = await page.evaluate(async items => {
    const W = 1800, pad = 24, rowH = 300;
    const ims = await Promise.all(items.map(([n, src]) => new Promise(r => { const i = new Image(); i.onload = () => r([n, i]); i.src = src; })));
    let x = pad, y = pad, h = 0;
    const pos = ims.map(([n, i]) => { const s = Math.min(1, rowH / i.height, (W - 2 * pad) / i.width), w = i.width * s, hh = i.height * s; if (x + w > W - pad) { x = pad; y += h + 40; h = 0; } const p = [n, i, x, y, w, hh]; x += w + pad; h = Math.max(h, hh); return p; });
    const c = document.createElement('canvas'); c.width = W; c.height = y + h + 50;
    const g = c.getContext('2d'); g.fillStyle = '#1a1820'; g.fillRect(0, 0, c.width, c.height);
    g.font = '14px sans-serif'; g.fillStyle = '#ddd';
    for (const [n, i, px, py, w, hh] of pos) {
      if (/logo|shortcut/.test(n)) { for (let yy = 0; yy < hh; yy += 12) for (let xx = 0; xx < w; xx += 12) { g.fillStyle = ((xx + yy) / 12) % 2 ? '#555' : '#444'; g.fillRect(px + xx, py + yy, 12, 12); } }
      g.drawImage(i, px, py, w, hh); g.fillStyle = '#ddd'; g.fillText(`${n}  ${i.width}x${i.height}`, px, py + hh + 18);
    }
    return c.toDataURL('image/jpeg', 0.88);
  }, files.map(f => [f, `data:image/${f.endsWith('jpg') ? 'jpeg' : 'png'};base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}`]));
  save('contact_sheet.jpg', sheet);
  if (errors.length) log('page errors:', errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}
log(bad ? `❌ ${bad} image(s) not at Steam's size` : `✅ store art in ${path.relative(ROOT, OUT) || OUT}`);
process.exit(bad ? 1 : 0);
