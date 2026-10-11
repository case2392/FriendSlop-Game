// Compare two folders of screenshots (same file names), e.g. scene.mjs output before and after a change.
// For each pair: the share of pixels that differ at all, the share that differ by more than 24 levels in
// any channel (what an eye would catch), and the mean difference. Writes an amplified diff image of each
// pair that differs to <out>/ when --out is given.
//
//   node tools/shotdiff.mjs <dirA> <dirB> [--out diffdir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [A, B] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const oi = process.argv.indexOf('--out'), OUT = oi > 0 ? process.argv[oi + 1] : null;
if (!A || !B) { console.error('usage: node tools/shotdiff.mjs <dirA> <dirB> [--out diffdir]'); process.exit(2); }
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync(A).filter(f => f.endsWith('.png') && fs.existsSync(path.join(B, f))).sort();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.setContent('<p>diff</p>');
const rows = [];
for (const f of files) {
  const a = fs.readFileSync(path.join(A, f)).toString('base64'), b = fs.readFileSync(path.join(B, f)).toString('base64');
  const r = await page.evaluate(async ([a, b, want]) => {
    const load = async s => { const bin = Uint8Array.from(atob(s), c => c.charCodeAt(0)); return createImageBitmap(new Blob([bin], { type: 'image/png' })); };
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: true };
    const W = ia.width, H = ia.height;
    const px = im => { const c = new OffscreenCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, W, H).data; };
    const da = px(ia), db = px(ib);
    let any = 0, big = 0, sum = 0;
    const out = want ? new ImageData(W, H) : null;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d) any++;
      if (d > 24) big++;
      sum += d;
      if (out) { const v = Math.min(255, d * 8); out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255; }
    }
    const n = W * H;
    let png = null;
    if (out && any) { const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(out, 0, 0); const u = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); png = btoa(s); }
    return { any: any / n, big: big / n, mean: sum / n, png };
  }, [a, b, !!OUT]);
  if (r.size) { rows.push([f, 'size differs']); continue; }
  if (OUT && r.png) fs.writeFileSync(path.join(OUT, f), Buffer.from(r.png, 'base64'));
  rows.push([f, `${(r.any * 100).toFixed(2)}% differ`, `${(r.big * 100).toFixed(3)}% by >24`, `mean ${r.mean.toFixed(3)}`]);
}
for (const r of rows) console.log(r.join('  '));
await browser.close();
