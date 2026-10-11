// GameHost: the rooms, the fixed-rate loops and every connection, whatever carries it.
//
// A connection is anything ws-like: send(data, opts) / on('message', (data, isBinary)) / on('close') /
// readyState / close(code, reason). That's a real WebSocket (the browser build, LAN players, the host's
// own page in the desktop build) or a Steam peer handed over by the desktop shell. One host serves them
// all the same way; info.key names a player who can come back (a Steam account) and gets their seat back.
//
// Used by server/index.js (npm start: the browser build, the tools and the tests) and by the desktop
// shell, which runs it in a utility process on 127.0.0.1 (desktop/server-process.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import * as C from '../shared/constants.js';
import { Room } from './room.js';
import { initPhysics } from './sim.js';
import { computeBuild } from './build.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const RAPIER_ESM = path.join(path.dirname(require.resolve('@dimforge/rapier3d-compat')), 'rapier.mjs');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOLD_SECS = 90;              // a dropped player's seat is kept this long (room.js does the keeping)
const VOICE_RANGE = 45;            // voice.js spatialize(): the gain reaches 0 at 2.5 + 42.5 m
const RATE = 120, BURST = 240;     // messages per second per connection, sustained / burst
const VOICE_RATE = 60, VOICE_BURST = 120;   // voice frames (50 a second while talking) have their own
const PING_MS = 5000, DEAD_MS = 15000;
const SNAP_SKIP = 64 * 1024, SNAP_KILL = 2 * 1024 * 1024;   // a socket this far behind skips snapshots / is dropped

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
};

// The browser build's files: client/ at /, the repo's shared/ at /shared/, Rapier's ESM build at
// /vendor/rapier.mjs. A malformed escape or a NUL byte must never reach the file system (either one,
// thrown, would take every room down), and a path has to stay inside its own folder.
export function staticHandler(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { urlPath = null; }
  if (!urlPath || urlPath.includes('\0')) { res.writeHead(400); res.end('bad request'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  let filePath;
  if (urlPath === '/vendor/rapier.mjs') filePath = RAPIER_ESM;
  else {
    const shared = urlPath.startsWith('/shared/');
    const base = path.join(ROOT, shared ? 'shared' : 'client');
    filePath = path.normalize(path.join(base, shared ? urlPath.slice('/shared'.length) : urlPath));
    if (!filePath.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath === RAPIER_ESM ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
}

export class GameHost {
  // singleRoom: the desktop build hosts one trip; a join needs no code (Steam guests can't type one)
  constructor({ build = null, holdSecs = HOLD_SECS, singleRoom = false, log = (...a) => console.log(...a) } = {}) {
    this.build = build ?? computeBuild();
    this.holdSecs = holdSecs; this.singleRoom = singleRoom; this.log = log;
    this.rooms = new Map();
    this.closing = false;
    this.stats = { voiceIn: 0, voiceOut: 0, snapsOut: 0, snapsSkipped: 0, dropped: 0 };
  }
  async init() { await initPhysics(); return this; }
  newCode() { let c; do c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); while (this.rooms.has(c)); return c; }
  get room() { return [...this.rooms.values()].find(r => !r.closed) || null; }

  // info: { kind: 'local' | 'ws' | 'steam', key?: 'steam:<id>' }
  attach(conn, info = {}) {
    let room = null, player = null;
    const fail = (msg, code) => { try { conn.send(JSON.stringify({ t: 'error', msg, code })); } catch {} };
    // a token bucket: a stuck key or a modified client can't flood the crew; a connection that keeps
    // trying at ten times the rate is dropped
    const bucket = (rate, burst) => ({ rate, burst, tokens: burst, last: performance.now() });
    const msgs = bucket(RATE, BURST), voiceB = bucket(VOICE_RATE, VOICE_BURST);
    let excess = 0, excessAt = 0;
    const allow = b => {
      const now = performance.now();
      b.tokens = Math.min(b.burst, b.tokens + (now - b.last) / 1000 * b.rate);
      b.last = now;
      if (b.tokens >= 1) { b.tokens--; return true; }
      if (now - excessAt > 5000) { excess = 0; excessAt = now; }
      if (++excess > RATE * 10 * 5) { this.log(`[host] dropping a flooding connection (${info.kind || 'ws'})`); try { conn.terminate ? conn.terminate() : conn.close(4008, 'flood'); } catch {} }
      this.stats.dropped++;
      return false;
    };
    conn.on('message', (raw, isBinary) => {
      if (!allow(isBinary ? voiceB : msgs)) return;
      if (isBinary) { if (room && player) this.relayVoice(room, player, raw); return; }
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      try {
        if ((m.t === 'create' || m.t === 'join') && !player) {
          if (this.closing) return fail('The host is closing the game.', 'closing');
          if (m.build != null && m.build !== this.build) return fail(`Version mismatch: your game is ${m.build}, the host's is ${this.build}. Restart Steam so both of you get the latest update.`, 'version');
          let r;
          if (m.t === 'create') {
            if (this.singleRoom && this.room) return fail('This game is already hosting a trip.', 'denied');
            const seed = Number.isFinite(+m.seed) && m.seed !== '' && m.seed != null ? (+m.seed >>> 0) : null;
            r = new Room(this.newCode(), seed);
            this.rooms.set(r.code, r);
          } else {
            r = this.singleRoom ? this.room : this.rooms.get(String(m.room || '').toUpperCase().trim());
            if (!r || r.closed) return fail('No trip with that code. Check it with your friend.', 'noroom');
          }
          const opts = { ready: !!m.rdy };
          const key = info.key ?? (typeof m.resume === 'string' && /^[0-9a-f]{24}$/.test(m.resume) ? 'tok:' + m.resume : null);
          const back = key && m.t === 'join' ? r.resume(key, conn, opts) : null;
          if (back) {
            player = back;
            const name = m.name != null ? String(m.name).replace(/[<>]/g, '').slice(0, 16) : '';
            if (name) back.name = name;
          } else {
            const res = r.addPlayer(conn, m.name, opts);
            if (res.error) { if (!r.players.size) r.closed = true; return fail(res.error, res.code || 'full'); }
            player = res.player;
            player.key = key || 'tok:' + crypto.randomBytes(12).toString('hex');
          }
          room = r;
          r.welcome(player);
          if (!info.key) conn.send(JSON.stringify({ t: 'session', resume: player.key.slice(4), build: this.build }));   // a ws client keeps this to come back
          if (m.t === 'join') r.toast(back ? `${player.name} is back.` : `${player.name} climbed aboard.`, player.color, 3);
          this.log(`[host] ${player.name} ${back ? 'resumed' : m.t === 'create' ? 'created' : 'joined'} ${r.code} via ${info.kind || 'ws'} (id ${player.id})`);
        } else if (room && player) {
          if (room.players.get(player.id) !== player) return;   // they left (or their seat expired)
          room.handle(player, m);
        }
      } catch (e) { console.error('message error', e); }
    });
    conn.on('close', () => {
      try {
        if (!room || !player || player.conn !== conn || room.players.get(player.id) !== player) return;
        if (player.key && this.holdSecs > 0 && !this.closing && !room.closed) room.hold(player, this.holdSecs);
        else room.removePlayer(player.id);
      } catch (e) { console.error('close error', e); }
    });
  }

  // a binary voice frame from a page: [1][flags][seq u16][opus...]; flags & 1 = on the walkie. Out it
  // goes as [2][speaker id][flags][seq][opus...], only to players in voice who can hear it: within
  // earshot, or both holding walkies
  relayVoice(room, p, raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length < 4 || buf.length > 600 || buf[0] !== 1 || !p.connected || !p.voice) return;
    this.stats.voiceIn++;
    const walkie = (buf[1] & 1) && p.walkie;
    const out = Buffer.allocUnsafe(buf.length + 1);
    out[0] = 2; out[1] = p.id & 255; buf.copy(out, 2, 1);
    for (const q of room.players.values()) {
      if (q === p || !q.connected || !q.conn || q.conn.readyState !== 1 || !q.voice) continue;
      const near = p.eye && q.eye && Math.hypot(p.eye.x - q.eye.x, p.eye.y - q.eye.y, p.eye.z - q.eye.z) < VOICE_RANGE;
      if (!near && !(walkie && q.walkie)) continue;
      q.conn.send(out, { unreliable: true, voice: true, binary: true });
      this.stats.voiceOut++;
    }
  }

  start() {
    let last = performance.now(), acc = 0;
    const STEP = 1 / C.SIM_HZ;
    this.tickT = setInterval(() => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, 0.25);
      last = now;
      while (acc >= STEP) {
        acc -= STEP;
        for (const [code, room] of this.rooms) {
          if (room.closed) { this.rooms.delete(code); room.sim?.free(); continue; }
          try { room.tick(STEP); } catch (e) { console.error(`room ${code} tick error:`, e); }
        }
      }
    }, 1000 / C.SIM_HZ / 2);
    this.snapT = setInterval(() => {
      for (const room of this.rooms.values()) {
        if (room.closed) continue;
        try {
          const s = JSON.stringify(room.snapshot());
          for (const p of room.players.values()) {
            const c = p.conn;
            if (!c || !room.wantsSnapshots(p) || c.readyState !== 1) continue;
            // a socket this far behind gets no more snapshots (the next one supersedes them anyway), and
            // one that never drains is dropped (its seat is kept)
            const queued = c.bufferedAmount || 0;
            if (queued > SNAP_KILL) { try { c.terminate ? c.terminate() : c.close(4003, 'too slow'); } catch {} continue; }
            if (queued > SNAP_SKIP) { this.stats.snapsSkipped++; continue; }
            c.send(s, { unreliable: true });
            this.stats.snapsOut++;
          }
        } catch (e) { console.error('snapshot error', e); }
      }
    }, 1000 / C.SNAP_HZ);
    return this;
  }
  stop() { clearInterval(this.tickT); clearInterval(this.snapT); clearInterval(this.pingT); }

  // The trip is over (the desktop host went back to the menu): every page hears why, then every
  // connection closes with 4000 so guests show 'the host ended the trip' instead of reconnecting
  endRooms(reason = 'The host ended the trip.') {
    for (const room of this.rooms.values()) {
      if (room.closed) continue;
      room.closed = true;
      room.broadcast({ t: 'hostleft', msg: reason });
      room.broadcast({ t: 'toast', text: reason, color: '#ff8a80', secs: 10 });
      for (const p of room.players.values()) { try { p.conn?.close?.(4000, 'host left'); } catch {} }
    }
  }
  // The host is quitting: the same, and no new trips from here on
  closeAll(reason = 'The host ended the trip.') {
    this.closing = true;
    this.endRooms(reason);
  }

  // HTTP (the browser build's files) + WebSocket. origin: the desktop page's origin (app://nmd). A
  // browser always sends Origin, so a web page elsewhere can't open ws://127.0.0.1:<port> and drive the
  // game; non-browser clients (tools, bots) send none. Resolves to the port actually bound.
  listen({ port = 0, host, origin = null } = {}) {
    const server = http.createServer(staticHandler);
    const wss = new WebSocketServer({
      server, maxPayload: 64 * 1024,
      verifyClient: ({ origin: o, req }) => !o || o === `http://${req.headers.host}` || o === `https://${req.headers.host}` || (origin && o === origin),
    });
    wss.on('connection', (ws, req) => {
      // a protocol error (an oversize frame, invalid UTF-8, a bad close code) is an 'error' event: with no
      // listener it would throw and kill every room. Drop that socket; 'close' follows as usual
      ws.on('error', e => { this.log(`[host] socket error: ${e.message}`); try { ws.terminate(); } catch {} });
      ws.seenAt = Date.now();
      ws.on('pong', () => { ws.seenAt = Date.now(); });
      ws.on('message', () => { ws.seenAt = Date.now(); });
      const a = req.socket.remoteAddress;
      this.attach(ws, { kind: a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' ? 'local' : 'ws' });
    });
    wss.on('error', e => this.log(`[host] websocket server error: ${e.message}`));
    // heartbeat: a peer that answers nothing for DEAD_MS (pulled cable, frozen machine) is dropped and its
    // seat kept, so it stops blocking bedtime and the wheel. (Browsers answer pings off the page's
    // thread, so a client busy building its world still counts as alive.)
    this.pingT = setInterval(() => {
      const now = Date.now();
      for (const ws of wss.clients) {
        if (now - ws.seenAt > DEAD_MS) { this.log('[host] dropping a silent connection'); try { ws.terminate(); } catch {} continue; }
        try { ws.ping(); } catch {}
      }
    }, PING_MS);
    this.http = server; this.wss = wss;
    return new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(port, host, () => {
        server.off('error', rej);
        server.on('error', e => this.log(`[host] http server error: ${e.message}`));
        res(server.address().port);
      });
    });
  }

  close() {
    this.stop();
    try { this.wss?.close(); } catch {}
    try { this.http?.close(); } catch {}
    for (const room of this.rooms.values()) room.sim?.free?.();
    this.rooms.clear();
  }
}
