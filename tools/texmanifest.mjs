// Regenerates client/js/texmanifest.js: the textures each biome's day build asks for (in the order it
// asks), which of them a paint worker can't paint exactly (their paint clips off the pixel grid:
// OffscreenCanvas clips without antialiasing), so the page paints those itself, and which families
// paint differently depending on what was painted before (never prepared ahead or cached). Run it after adding or renaming
// textures; a stale manifest is only slower (a texture missing from it is painted on the main thread
// when the build asks for it, as before), never wrong.
//
//   node tools/texmanifest.mjs [--seeds 777,1,2] [--check]
//
// Builds every day on each seed in a fresh page (so every texture the build asks for is seen) and
// records what canvasFor is asked for; finds the families whose paints depend on paint order; then
// has a paint worker try each texture. --check only reports whether the file on disk is current.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'client/js/texmanifest.js');
const SEEDS = String(arg('seeds', '777,1,2')).split(',').map(s => s.trim()).filter(Boolean);
const CHECK = process.argv.includes('--check');
const BIOMES = ['meadow', 'fields', 'snow', 'badlands', 'desert'];

const UNSAFE_PORTS = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let PORT; do PORT = 9000 + Math.floor(Math.random() * 900); while (UNSAFE_PORTS.has(PORT));
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('no server')), 60000); });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const lists = Object.fromEntries(BIOMES.map(b => [b, []]));

// one fresh page per seed and day, so the build asks for every texture it uses (nothing cached by an
// earlier day): the world build, the paper map, every loot prop, one rendered frame
for (const seed of SEEDS) {
  for (let d = 1; d <= 5; d++) {
    const page = await browser.newPage();
    page.setDefaultTimeout(900000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/gallery.html?family=none`);
    const { biome, got } = await page.evaluate(async ([seed, day]) => {
      const P = await import('/js/paint/index.js');
      const gfx = await import('/js/gfx.js');
      const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; document.body.appendChild(cv);
      gfx.initGfx(cv);
      const [{ generateLeg }, { buildWorld, updateWorld }, props, { LOOT }] = await Promise.all([import('/shared/world.js'), import('/js/world3d.js'), import('/js/props3d.js'), import('/shared/loot.js')]);
      const set = new Set();
      P.hooks.requested = n => set.add(n);
      const W = generateLeg(+seed, day);
      gfx.setBiome(W.biome);
      const wv = buildWorld(W);
      gfx.scene.add(wv.group);
      props.mapCanvas(W);
      for (const k of Object.keys(LOOT)) gfx.scene.add(props.buildProp(k, W));
      gfx.camera.position.set(-13.5, W.heightAt(-13.5, -52.5) + 1.6, -52.5); gfx.camera.lookAt(0, 2, 0);
      updateWorld(wv, 0.016, 1, gfx.camera.position);
      gfx.setTimeOfDay(10); gfx.updateSun(gfx.camera.position);
      gfx.render();
      return { biome: W.biome, got: [...set] };
    }, [seed, d]);
    for (const n of got) if (!lists[biome].includes(n)) lists[biome].push(n);
    console.log(`seed ${seed} day ${d} (${biome}): ${got.length} textures, ${lists[biome].length} so far`);
    await page.close();
  }
}

// families whose paints depend on what was painted before them (characters.js strokes through a shared
// scratch canvas whose size depends on history): every texture painted forward, then backward
const hashes = async reverse => {
  const p = await browser.newPage();
  await p.goto(`http://localhost:${PORT}/gallery.html?family=none`);
  const out = await p.evaluate(async reverse => {
    const P = await import('/js/paint/index.js');
    const hex = async d => [...new Uint8Array(await crypto.subtle.digest('SHA-1', d))].map(b => b.toString(16).padStart(2, '0')).join('');
    const all = P.list(); if (reverse) all.reverse();
    const o = {};
    for (const t of all) { const cv = P.canvasFor(t.name); o[t.name] = [t.family, await hex(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data)]; }
    return o;
  }, reverse);
  await p.close();
  return out;
};
const fwd = await hashes(false), rev = await hashes(true);
const inOrder = [...new Set(Object.keys(fwd).filter(n => fwd[n][1] !== rev[n]?.[1]).map(n => fwd[n][0]))].sort();
console.log(`order-dependent families: ${inOrder.join(' ') || 'none'}`);

// which of them a worker can't paint exactly
const all = [...new Set(Object.values(lists).flat())].filter(n => !inOrder.includes(fwd[n]?.[0]));
const page = await browser.newPage();
page.setDefaultTimeout(1800000);
await page.goto(`http://localhost:${PORT}/?paintWorkers=0&texcache=0`);
const pageOnly = await page.evaluate(async names => {
  const { fontList } = await import('/js/texprep.js');
  const w = new Worker('/js/paint/worker.js', { type: 'module' });
  const call = (m, want) => new Promise(res => { w.onmessage = ({ data }) => { if (data.t === want || data.t === 'fail') res(data); }; w.postMessage(m); });
  await call({ t: 'init', fonts: fontList(), hashes: null }, 'ready');
  const out = [];
  for (const n of names) {
    const d = await call({ t: 'paint', id: 1, name: n }, 'done');
    if (d.t === 'done' && !d.exact) out.push(n);
    d.bmp?.close?.();
    w.postMessage({ t: 'drop', names: (d.fresh || []).map(f => f.name) });
  }
  w.terminate();
  return out.sort();
}, all);

const body = `// The textures each biome's day build asks for, in the order it asks: what texprep.js gets ready
// (from the texture cache or the paint workers) before the build starts. Generated by
// \`node tools/texmanifest.mjs\` from real builds of every day on seeds ${SEEDS.join(', ')}; a stale list only
// costs speed (a texture missing here is painted on the main thread when asked for, as it always was).
export const DAY_TEXTURES = {
${BIOMES.map(b => `  ${b}: ${JSON.stringify(lists[b])},`).join('\n')}
};
// textures whose paint clips off the pixel grid (an OffscreenCanvas clips without antialiasing): the page
// paints these
export const PAGE_ONLY = ${JSON.stringify(pageOnly)};
// families whose pixels depend on what was painted before them: never prepared ahead, never cached;
// the game paints them when it asks for them, in its own order, as it always has
export const IN_ORDER = ${JSON.stringify(inOrder)};
`;
const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (CHECK) {
  console.log(cur === body ? 'texmanifest.js is current' : 'texmanifest.js is STALE: run node tools/texmanifest.mjs');
} else {
  fs.writeFileSync(OUT, body);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${all.length} textures, ${pageOnly.length} page-only`);
}
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
process.exit(errors.length || (CHECK && cur !== body) ? 1 : 0);
