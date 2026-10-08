import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import * as C from '../shared/constants.js';
import { Room } from './room.js';
import { initPhysics } from './sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);
const RAPIER_ESM = path.join(path.dirname(require.resolve('@dimforge/rapier3d-compat')), 'rapier.mjs');

const portArg = process.argv.indexOf('--port');
const PORT = Number(process.env.PORT || (portArg !== -1 ? process.argv[portArg + 1] : 0) || 3000);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath;
  if (urlPath === '/vendor/rapier.mjs') filePath = RAPIER_ESM;
  else {
    const base = urlPath.startsWith('/shared/') ? ROOT : path.join(ROOT, 'client');
    filePath = path.normalize(path.join(base, urlPath));
    if (!filePath.startsWith(base)) { res.writeHead(403); res.end(); return; }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath === RAPIER_ESM ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}

wss.on('connection', ws => {
  let room = null, player = null;
  const fail = msg => ws.send(JSON.stringify({ t: 'error', msg }));
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try {
      if (m.t === 'create' && !player) {
        const seed = Number.isFinite(+m.seed) && m.seed !== '' && m.seed != null ? (+m.seed >>> 0) : null;
        const r = new Room(newCode(), seed);
        rooms.set(r.code, r);
        const res = r.addPlayer(ws, m.name);
        room = r; player = res.player;
        r.welcome(player);
      } else if (m.t === 'join' && !player) {
        const r = rooms.get(String(m.room || '').toUpperCase().trim());
        if (!r || r.closed) return fail('No RV with that code. Check it with your friend.');
        const res = r.addPlayer(ws, m.name);
        if (res.error) return fail(res.error);
        room = r; player = res.player;
        r.welcome(player);
        r.toast(`${player.name} climbed aboard.`, player.color, 3);
      } else if (room && player) {
        room.handle(player, m);
      }
    } catch (e) {
      console.error('message error', e);
    }
  });
  ws.on('close', () => { if (room && player) room.removePlayer(player.id); });
});

await initPhysics();

// physics + game loop at a fixed 60 Hz
let last = performance.now(), acc = 0;
const STEP = 1 / C.SIM_HZ;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, 0.25);
  last = now;
  while (acc >= STEP) {
    acc -= STEP;
    for (const [code, room] of rooms) {
      if (room.closed) { rooms.delete(code); continue; }
      try { room.tick(STEP); } catch (e) { console.error(`room ${code} tick error:`, e); }
    }
  }
}, 1000 / C.SIM_HZ / 2);

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.closed) continue;
    try { room.broadcast(room.snapshot()); } catch (e) { console.error('snapshot error', e); }
  }
}, 1000 / C.SNAP_HZ);

server.listen(PORT, () => console.log(`NO MONEY DOWN server rolling on http://localhost:${PORT}`));
