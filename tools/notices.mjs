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
  [`Rapier ${ver('@dimforge/rapier3d-compat')} (@dimforge/rapier3d-compat): physics`, 'https://rapier.rs', read('node_modules/@dimforge/rapier3d-compat/LICENSE')],
  [`ws ${ver('ws')}: WebSockets`, 'https://github.com/websockets/ws', read('node_modules/ws/LICENSE')],
  [`steamworks.js ${ver('steamworks.js')}: the Steam API for Node`, 'https://github.com/ceifa/steamworks.js', read('node_modules/steamworks.js/LICENSE')],
  ['Steamworks SDK redistributables (steam_api64.dll, libsteam_api.so)', 'https://partner.steamgames.com',
    'Copyright (c) Valve Corporation. Distributed under the Steamworks SDK Access Agreement, for use with Steam.'],
  ['Fonts: Marcellus, Cinzel, Philosopher', 'https://fonts.google.com', read('client/fonts/OFL.txt')],
  [`Electron ${ver('electron')} and Chromium`, 'https://www.electronjs.org', 'See LICENSE.electron.txt and LICENSES.chromium.html in this folder.'],
];
const out = ['NO MONEY DOWN: third-party software', '', 'NO MONEY DOWN uses the following software. Thank you to their authors.', '']
  .concat(...parts.map(([name, url, text]) => ['='.repeat(78), `${name}`, url, '-'.repeat(78), text, '']));
fs.writeFileSync(path.join(ROOT, 'desktop/THIRD_PARTY_NOTICES.txt'), out.join('\n') + '\n');
console.log(`desktop/THIRD_PARTY_NOTICES.txt: ${parts.length} entries, ${out.join('\n').length} bytes`);
