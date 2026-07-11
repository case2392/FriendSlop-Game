import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as C from '../shared/constants.js';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const portArg = process.argv.indexOf('--port');
const PORT = Number(process.env.PORT || (portArg !== -1 ? process.argv[portArg + 1] : 0) || 3000);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Serve /shared/* from the shared dir, everything else from client/.
  const base = urlPath.startsWith('/shared/') ? ROOT : path.join(ROOT, 'client');
  const filePath = path.normalize(path.join(base, urlPath));
  if (!filePath.startsWith(base)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

wss.on('connection', ws => {
  let room = null;
  let player = null;

  const fail = msg => ws.send(JSON.stringify({ t: 'error', msg }));

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m !== 'object' || m === null) return;

    if (m.t === 'create') {
      if (player) return;
      const r = new Room(newCode());
      rooms.set(r.code, r);
      const res = r.addPlayer(ws, m.name);
      if (res.error) { fail(res.error); return; }
      room = r; player = res.player;
      ws.send(JSON.stringify({ t: 'welcome', id: player.id, code: r.code }));
      r.sendMeta();
    } else if (m.t === 'join') {
      if (player) return;
      const r = rooms.get(String(m.room || '').toUpperCase().trim());
      if (!r || r.closed) { fail('No room with that code. Check it with your friend.'); return; }
      const res = r.addPlayer(ws, m.name);
      if (res.error) { fail(res.error); return; }
      room = r; player = res.player;
      ws.send(JSON.stringify({ t: 'welcome', id: player.id, code: r.code }));
      r.sendMeta();
    } else if (room && player) {
      const inLobby = room.phase === 'hub' && room.hubMode === 'lobby';
      switch (m.t) {
        case 'input': room.handleInput(player, m); break;
        case 'addbot':
          if (player.id === room.hostId && inLobby) {
            const res = room.addBot();
            if (res.error) fail(res.error);
          }
          break;
        case 'kickbot':
          if (player.id === room.hostId && inLobby) {
            const bot = [...room.players.values()].reverse().find(p => p.isBot);
            if (bot) { room.players.delete(bot.id); room.sendMeta(); }
          }
          break;
        case 'emote': room.handleEmote(player, m.e); break;
        case 'voice': room.handleVoice(player, m); break;
        case 'rtc': room.relayRtc(player, m); break;
      }
    }
  });

  ws.on('close', () => {
    if (room && player) room.removePlayer(player.id);
  });
});

// Simulation loop.
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const [code, room] of rooms) {
    if (room.closed) { rooms.delete(code); continue; }
    try { room.tick(dt); } catch (e) { console.error(`room ${code} tick error:`, e); }
  }
}, 1000 / C.TICK_RATE);

// Snapshot loop.
setInterval(() => {
  for (const room of rooms.values()) {
    const snap = room.snapshot();
    if (snap) room.broadcast(snap);
  }
}, 1000 / C.SNAPSHOT_RATE);

server.listen(PORT, () => {
  console.log(`FRIENDSLOP server sloppin' on http://localhost:${PORT}`);
});
