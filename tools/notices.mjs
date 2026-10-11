// Writes desktop/THIRD_PARTY_NOTICES.txt: the licenses of everything the desktop build ships that isn't
// ours (electron-builder puts it next to the executable; Electron's and Chromium's own licenses are
// already there: LICENSE.electron.txt, LICENSES.chromium.html). Run after adding or updating a
// dependency: node tools/notices.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').trim();
const ver = p => JSON.parse(read(`node_modules/${p}/package.json`)).version;
const parts = [
  ['three.js (r185): 3D rendering', 'https://threejs.org', read('client/vendor/THREE-LICENSE')],
  [`Rapier ${ver('@dimforge/rapier3d-compat')} (@dimforge/rapier3d-compat): physics`, 'https://rapier.rs', read('node_modules/@dimforge/rapier3d-compat/LICENSE') + '\n\n' +
    // the Rust libraries compiled into Rapier's WebAssembly (crate paths in its .wasm; licenses from crates.io)
    'Rapier\'s WebAssembly also contains these Rust libraries, used under the Apache License 2.0 above\n' +
    '(the dual-licensed ones are also available under the MIT license):\n' +
    '  parry3d 0.31.1 and nalgebra 0.35.0 (Apache-2.0, Dimforge); glam 0.33.10, glamx 0.3.1, hashbrown 0.17.1,\n' +
    '  smallvec 1.16.2, once_cell 1.21.4, dlmalloc 0.2.13, ena 0.14.4, js-sys 0.3.106, web-time 1.1.0 and the\n' +
    '  Rust standard library (each MIT OR Apache-2.0).'],
  [`ws ${ver('ws')}: WebSockets`, 'https://github.com/websockets/ws', read('node_modules/ws/LICENSE')],
  [`steamworks.js ${ver('steamworks.js')}: the Steam API for Node`, 'https://github.com/ceifa/steamworks.js', read('node_modules/steamworks.js/LICENSE')],
  ['Steamworks SDK redistributables (steam_api64.dll, libsteam_api.so)', 'https://partner.steamgames.com',
    'Copyright (c) Valve Corporation. Distributed under the Steamworks SDK Access Agreement, for use with Steam.'],
  ['Fonts: Marcellus, Cinzel, Philosopher', 'https://fonts.google.com', read('client/fonts/OFL.txt')],
  [`Electron ${ver('electron')} and Chromium`, 'https://www.electronjs.org', 'See LICENSE.electron.txt and LICENSES.chromium.html in this folder.\n\n' +
    `Chromium's FFmpeg (the ffmpeg library next to the executable) is under the GNU LGPL 2.1 or later; its\n` +
    `source is the one Electron ${ver('electron')} builds from (https://github.com/electron/electron, tag v${ver('electron')}, and the\n` +
    `Chromium and FFmpeg sources it names). You may replace that library with your own build of it.`],
];
const out = ['NO MONEY DOWN: third-party software', '', 'NO MONEY DOWN uses the following software. Thank you to their authors.', '']
  .concat(...parts.map(([name, url, text]) => ['='.repeat(78), `${name}`, url, '-'.repeat(78), text, '']));
fs.writeFileSync(path.join(ROOT, 'desktop/THIRD_PARTY_NOTICES.txt'), out.join('\n') + '\n');
console.log(`desktop/THIRD_PARTY_NOTICES.txt: ${parts.length} entries, ${out.join('\n').length} bytes`);
