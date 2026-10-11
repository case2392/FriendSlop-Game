'use strict';
// P2PNet: packets to and from Steam IDs over a steamworks.js client (the real one, or test/fakesteam).
// Uses only what steamworks.js 0.4.0 binds: networking.sendP2PPacket / isP2PPacketAvailable /
// readP2PPacket / acceptP2PSession and the P2PSessionRequest / P2PSessionConnectFail callbacks.
// What it adds: a fast poll (packets don't wait for the 30 Hz callback pump), an accept policy (only
// the lobby's members get a session), a heartbeat with the round trip, and a silence timeout per peer
// (the old API has no "connection closed" event).
const { EventEmitter } = require('node:events');
const { K, UNRELIABLE_MAX, RELIABLE_MAX, packTime } = require('./frame.cjs');

const SendType = { Unreliable: 0, UnreliableNoDelay: 1, Reliable: 2, ReliableWithBuffering: 3 };
const CB = { LobbyDataUpdate: 4, LobbyChatUpdate: 5, P2PSessionRequest: 6, P2PSessionConnectFail: 7, GameLobbyJoinRequested: 8 };
// steamworks.js types member_state_change as a number, but steamworks-rs serializes the Rust enum with
// serde, which gives the variant's NAME ("Left"). Take both.
const CHANGES = ['Entered', 'Left', 'Disconnected', 'Kicked', 'Banned'];
const memberChange = v => (typeof v === 'string' ? v : CHANGES[v] ?? String(v));
const big = v => (typeof v === 'bigint' ? v : BigInt(v));

class P2PNet extends EventEmitter {
  constructor(steam, { pollMs = 2, pingMs = 1000, timeoutMs = 10000, accept = () => false } = {}) {
    super();
    this.steam = steam; this.pollMs = pollMs; this.pingMs = pingMs; this.timeoutMs = timeoutMs; this.accept = accept;
    this.peers = new Map();
    this.stats = { sent: 0, sentBytes: 0, recv: 0, recvBytes: 0, sendFailed: 0 };
  }
  start() {
    const cb = this.steam.callback;
    this.handles = [
      cb.register(CB.P2PSessionRequest, ({ remote }) => {
        remote = big(remote);
        if (this.accept(remote)) { this.steam.networking.acceptP2PSession(remote); this.emit('accepted', remote); }
        else this.emit('refused', remote);
      }),
      cb.register(CB.P2PSessionConnectFail, ({ remote, error }) => this.emit('fail', big(remote), error)),
    ];
    this.pollT = setInterval(() => { try { this.poll(); } catch (e) { this.emit('error', e); } }, this.pollMs);
    this.pingT = setInterval(() => this.heartbeat(), this.pingMs);
    return this;
  }
  stop() {
    clearInterval(this.pollT); clearInterval(this.pingT);
    for (const h of this.handles || []) { try { h.disconnect(); } catch {} }
    this.handles = null;
  }
  peer(id) {
    let p = this.peers.get(id);
    if (!p) { p = { id, lastRecv: performance.now(), rtt: null, watched: false }; this.peers.set(id, p); }
    return p;
  }
  // the heartbeat and the silence timeout, for peers with a game connection
  watch(id) { const p = this.peer(id); p.watched = true; p.lastRecv = performance.now(); }
  unwatch(id) { const p = this.peers.get(id); if (p) p.watched = false; }

  // mode: 'reliable' (game messages, control), 'unreliable' (snapshot fragments), 'voice' (no Nagle delay)
  send(id, buf, mode = 'reliable') {
    const type = mode === 'reliable' ? SendType.Reliable : mode === 'voice' ? SendType.UnreliableNoDelay : SendType.Unreliable;
    if (buf.length > (type === SendType.Reliable ? RELIABLE_MAX : UNRELIABLE_MAX)) { this.stats.sendFailed++; return false; }
    let ok = false;
    try { ok = this.steam.networking.sendP2PPacket(id, type, buf); } catch { ok = false; }
    if (!ok) this.stats.sendFailed++;
    this.stats.sent++; this.stats.sentBytes += buf.length;
    return ok;
  }
  poll() {
    const n = this.steam.networking;
    let size, guard = 0;
    while ((size = n.isP2PPacketAvailable()) > 0 && guard++ < 4000) {
      const pk = n.readP2PPacket(size);
      const from = big(pk.steamId.steamId64);
      const data = pk.data.length === pk.size ? pk.data : pk.data.subarray(0, pk.size);
      if (!data.length) continue;
      const p = this.peer(from);
      p.lastRecv = performance.now();
      this.stats.recv++; this.stats.recvBytes += data.length;
      if (data[0] === K.PING) { if (data.length >= 9) this.send(from, packTime(K.PONG, data.readDoubleLE(1)), 'unreliable'); continue; }
      if (data[0] === K.PONG) { if (data.length >= 9) { const r = performance.now() - data.readDoubleLE(1); p.rtt = p.rtt == null ? r : p.rtt * 0.8 + r * 0.2; } continue; }
      this.emit('packet', from, data);
    }
  }
  heartbeat() {
    const t = performance.now();
    for (const p of this.peers.values()) {
      if (!p.watched) continue;
      this.send(p.id, packTime(K.PING, t), 'unreliable');
      if (t - p.lastRecv > this.timeoutMs) { p.watched = false; this.emit('timeout', p.id, t - p.lastRecv); }
    }
  }
}

// steamworks.js's lobby calls (createLobby, joinLobby) have no timeout, and Steam may never answer:
// give up after ms; a lobby that arrives after that is left at once, so nobody sits in a lobby unseen
function lobbyCall(p, ms, msg) {
  let late = false;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { late = true; rej(new Error(msg)); }, ms);
    p.then(l => { if (late) { try { l.leave(); } catch {} } else { clearTimeout(t); res(l); } },
      e => { clearTimeout(t); if (!late) rej(e); });
  });
}

module.exports = { P2PNet, SendType, CB, memberChange, big, lobbyCall };
