'use strict';
// The link format between two players' games over Steam P2P.
//
// steamworks.js exposes only channel 0 of Steam's old P2P API, so every packet starts with a kind byte.
// The game's own messages (JSON text, exactly what a WebSocket carries) ride inside GAME and SNAP.
//
//   HELLO   guest -> host  reliable    [k][json {proto, build, name, conn}]     once per page connection
//   WELCOME host -> guest  reliable    [k][json {conn}]
//   REJECT  host -> guest  reliable    [k][json {conn, code, msg}]              version | lobby | closing
//   GAME    both ways      reliable    [k][conn u8][utf8 json]                  every game message but snapshots
//   SNAP    host -> guest  unreliable  [k][conn u8][seq u32][rel u32][i u8][n u8][bytes]   a snapshot fragment
//   VOICE   both ways      unreliable  [k][conn u8][bytes]                      an Opus frame (the page's own format)
//   PING    both ways      unreliable  [k][t f64]                               heartbeat and round trip
//   PONG    both ways      unreliable  [k][t f64]
//   CLOSE   both ways      reliable    [k][json {conn, code, reason}]           that page connection ended
//   BYE     both ways      reliable    [k][json {reason, msg}]                  the whole link is going away
//
// SNAP: snapshots are the only big, frequent, disposable messages (1.2-4.5 KB at 20 Hz), and unreliable
// sends stop at 1200 bytes, so they are split here and put back together all-or-nothing on the guest.
// `rel` is how many GAME messages the host had sent on this connection before the snapshot: the guest
// hands a snapshot to the page only once exactly that many have arrived, so a snapshot never overtakes
// (or trails) a reliable message, the order the client was written against. A stale or duplicate
// snapshot (seq <= the last delivered) is dropped: interp.js would take an older one for a restart.

const LINK_PROTO = 1;
const K = { HELLO: 1, WELCOME: 2, REJECT: 3, GAME: 4, SNAP: 5, VOICE: 6, PING: 7, PONG: 8, CLOSE: 9, BYE: 10 };
const UNRELIABLE_MAX = 1200;          // Steam: an unreliable packet can't be larger than 1200 bytes
const RELIABLE_MAX = 1024 * 1024;     // a reliable one, 1 MB
const SNAP_HDR = 12;
const SNAP_PAYLOAD = UNRELIABLE_MAX - SNAP_HDR;

function packJson(kind, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const out = Buffer.allocUnsafe(1 + b.length);
  out[0] = kind; b.copy(out, 1);
  return out;
}
const unpackJson = buf => JSON.parse(buf.subarray(1).toString());

function packGame(conn, text) {
  const n = Buffer.byteLength(text);
  const out = Buffer.allocUnsafe(2 + n);
  out[0] = K.GAME; out[1] = conn & 255; out.write(text, 2);
  return out;
}
function packVoice(conn, bytes) {
  const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const out = Buffer.allocUnsafe(2 + src.length);
  out[0] = K.VOICE; out[1] = conn & 255; src.copy(out, 2);
  return out;
}
function packTime(kind, t) {
  const out = Buffer.allocUnsafe(9);
  out[0] = kind; out.writeDoubleLE(t, 1);
  return out;
}

// one snapshot (utf8 text) as <=1200-byte unreliable packets
function packSnap(conn, seq, rel, text) {
  const body = Buffer.from(text);
  const n = Math.max(1, Math.ceil(body.length / SNAP_PAYLOAD));
  if (n > 255) throw new Error(`snapshot too big for 255 fragments: ${body.length} B`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const part = body.subarray(i * SNAP_PAYLOAD, (i + 1) * SNAP_PAYLOAD);
    const b = Buffer.allocUnsafe(SNAP_HDR + part.length);
    b[0] = K.SNAP; b[1] = conn & 255; b.writeUInt32LE(seq >>> 0, 2); b.writeUInt32LE(rel >>> 0, 6); b[10] = i; b[11] = n;
    part.copy(b, SNAP_HDR);
    out.push(b);
  }
  return out;
}

// The guest's side: puts snapshot fragments back together and releases them by the rules above.
class SnapAssembler {
  constructor({ maxAgeMs = 400, now = () => performance.now() } = {}) {
    this.maxAgeMs = maxAgeMs; this.now = now;
    this.reset(0);
    this.stats = { completed: 0, delivered: 0, stale: 0, overtaken: 0, expired: 0, held: 0, fragments: 0 };
  }
  reset(conn) { this.conn = conn; this.pending = new Map(); this.ready = []; this.lastSeq = 0; this.relDelivered = 0; }
  // a GAME message reached the page: snapshots waiting for it may go now
  onReliable() { this.relDelivered++; return this.release(); }
  // one SNAP packet in; the snapshot texts that may go to the page now, in order
  push(buf) {
    if (buf.length < SNAP_HDR) return [];
    const conn = buf[1], seq = buf.readUInt32LE(2), rel = buf.readUInt32LE(6), i = buf[10], n = buf[11];
    this.stats.fragments++;
    if (conn !== this.conn || seq <= this.lastSeq || !n || i >= n) { this.stats.stale++; return []; }
    let e = this.pending.get(seq);
    if (!e) { e = { seq, rel, n, got: 0, parts: new Array(n), at: this.now() }; this.pending.set(seq, e); }
    if (e.n !== n || e.parts[i]) return [];          // a duplicate (or a corrupt) fragment
    e.parts[i] = Buffer.from(buf.subarray(SNAP_HDR)); e.got++;
    if (e.got < e.n) { this.gc(); return []; }
    this.pending.delete(seq);
    this.stats.completed++;
    this.ready.push({ seq, rel, text: Buffer.concat(e.parts).toString(), at: this.now() });
    this.ready.sort((a, b) => a.seq - b.seq);
    return this.release();
  }
  release() {
    const out = [];
    while (this.ready.length) {
      const s = this.ready[0];
      if (s.seq <= this.lastSeq) { this.ready.shift(); this.stats.stale++; continue; }
      if (s.rel < this.relDelivered) { this.ready.shift(); this.stats.overtaken++; continue; }   // older than a reliable message the page already has
      if (s.rel > this.relDelivered) { this.stats.held++; break; }                             // follows a reliable message still on its way
      this.ready.shift();
      this.lastSeq = s.seq; this.stats.delivered++;
      out.push(s.text);
    }
    this.gc();
    return out;
  }
  gc() {
    const t = this.now();
    for (const [seq, e] of this.pending) if (seq <= this.lastSeq || t - e.at > this.maxAgeMs) { this.pending.delete(seq); this.stats.expired++; }
    while (this.ready.length && t - this.ready[0].at > this.maxAgeMs) { this.ready.shift(); this.stats.expired++; }
  }
}

module.exports = { LINK_PROTO, K, UNRELIABLE_MAX, RELIABLE_MAX, SNAP_PAYLOAD, packJson, unpackJson, packGame, packVoice, packTime, packSnap, SnapAssembler };
