// The last look before a SteamPipe upload: checks the folders `npm run dist` made (what the depots in
// steam/ upload) for what must and must not ship.
//   node tools/depotcheck.mjs [dist]          exit 1 on any problem
// Each of dist/win-unpacked and dist/linux-unpacked that exists must have its executable, the licence
// files at its root (LICENSE.electron.txt, LICENSES.chromium.html, THIRD_PARTY_NOTICES.txt) and an
// app.asar holding the game (package.json, desktop/, server/, shared/, client/, the font licence and
// three.js's) and nothing else of the repo's (tests, tools, docs, screenshots, the texture gallery,
// steam_appid.txt). The text players see in it must pass tools/namecheck.mjs's list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANNED, jsStrings } from './namecheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = new RegExp(`(?<![A-Za-z])(${BANNED.map(esc).join('|')})(?![A-Za-z])`, 'i');

// app.asar: a Chromium pickle holding a JSON index (uint32 sizes at 4 and 12, the JSON from 16), then the
// files back to back from 8 + the pickle's size; offsets are strings in the index
function readAsar(file) {
  const buf = fs.readFileSync(file);
  const index = JSON.parse(buf.toString('utf8', 16, 16 + buf.readUInt32LE(12)));
  const base = 8 + buf.readUInt32LE(4), out = new Map();
  const walk = (node, at) => {
    for (const [name, e] of Object.entries(node.files || {})) {
      const p = at ? `${at}/${name}` : name;
      if (e.files) walk(e, p);
      else out.set(p, e.unpacked ? null : buf.subarray(base + Number(e.offset), base + Number(e.offset) + e.size));
    }
  };
  walk(index, '');
  return out;
}

const problems = [];
const builds = [['win-unpacked', 'NoMoneyDown.exe'], ['linux-unpacked', 'nomoneydown']].filter(([d]) => fs.existsSync(path.join(DIST, d)));
if (!builds.length) problems.push(`no build in ${DIST} (npm run dist:win / dist:linux)`);
for (const [dir, exe] of builds) {
  const at = path.join(DIST, dir), bad = m => problems.push(`${dir}: ${m}`);
  const win = dir.startsWith('win'), un = 'resources/app.asar.unpacked/node_modules/';
  // the native files beside the archive: Steam's library and its addon, koffi (the trip-code search)
  const natives = win ? [`${un}steamworks.js/dist/win64/steam_api64.dll`, `${un}steamworks.js/dist/win64/steamworksjs.win32-x64-msvc.node`, `${un}koffi/build/koffi/win32_x64/koffi.node`]
    : [`${un}steamworks.js/dist/linux64/libsteam_api.so`, `${un}steamworks.js/dist/linux64/steamworksjs.linux-x64-gnu.node`, `${un}koffi/build/koffi/linux_x64/koffi.node`];
  for (const f of [exe, 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'THIRD_PARTY_NOTICES.txt', 'resources/app.asar', ...natives]) if (!fs.existsSync(path.join(at, f))) bad(`missing ${f}`);
  if (fs.existsSync(path.join(at, 'steam_appid.txt'))) bad('steam_appid.txt is in the folder (a developer\'s file: the depot excludes it, but don\'t leave it there)');
  const asarFile = path.join(at, 'resources/app.asar');
  if (!fs.existsSync(asarFile)) continue;
  const files = readAsar(asarFile), names = [...files.keys()];
  for (const f of ['package.json', 'desktop/main.cjs', 'desktop/steam/lobbysearch.cjs', 'server/host.js', 'shared/world.js', 'shared/tripcode.js', 'client/index.html', 'client/js/main.js', 'client/fonts/OFL.txt', 'client/vendor/THREE-LICENSE', 'node_modules/koffi/index.js']) if (!files.has(f)) bad(`app.asar lacks ${f}`);
  const stray = names.filter(n => /^(test|tools|docs|steam|dist|\.git|\.github)\//.test(n) || /(^|\/)(README|DESIGN|ART|STEAM)\.md$/.test(n) || /^client\/(gallery|preview)\.html$/.test(n) || /(^|\/)steam_appid\.txt$/.test(n) || /\.(mp4|map)$/.test(n));
  for (const n of stray.slice(0, 10)) bad(`app.asar ships ${n}`);
  if (stray.length > 10) bad(`... and ${stray.length - 10} more stray files`);
  let hits = 0;
  for (const [n, b] of files) {
    if (!b) continue;
    const strs = /\.(m|c)?js$/.test(n) && !n.startsWith('node_modules/') && !n.startsWith('client/vendor/') ? jsStrings(b.toString('utf8')).map(([s, l]) => [s, l])
      : /^client\/.*\.(html|css)$/.test(n) ? b.toString('utf8').replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '').split('\n').map((s, i) => [s, i + 1]) : [];
    for (const [s, l] of strs) { const m = s.match(RE); if (m) { hits++; if (hits <= 10) bad(`${n}:${l} names "${m[1]}"`); } }
  }
  const mb = fs.statSync(asarFile).size / 1048576;
  console.log(`${dir}: ${exe}, ${files.size} files in app.asar (${mb.toFixed(1)} MB)${hits ? `, ${hits} borrowed names` : ''}`);
}
for (const p of problems) console.log('  ❌ ' + p);
console.log(problems.length ? `❌ DEPOT CHECK: ${problems.length} problem(s)` : '✅ depot check: ready for SteamPipe');
process.exit(problems.length ? 1 : 0);
