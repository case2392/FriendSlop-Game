'use strict';
// The host's side of playing over Steam (in the host's main process, next to steamworks.js).
//   - a friends-only lobby (6 max) with { build, proto, host, name, code } in its data: friends join it
//     from an invite or with Join Game in their friends list
//   - P2P sessions ONLY with that lobby's members
//   - each guest page connection (HELLO) becomes a SteamPeerConn, a ws-like socket handed to the game
//     server (through main's ServerLink), so the server doesn't know Steam exists
//   - a guest who leaves the lobby, fails, or goes quiet for 10 s loses their connection (the server
//     keeps their seat); close() says BYE to everyone, then leaves the lobby
const { EventEmitter } = require('node:events');
const { K, LINK_PROTO, packJson, unpackJson, packGame, packSnap, packVoice } = require('./frame.cjs');
const { P2PNet, CB, memberChange, big } = require('./p2p.cjs');

const LobbyType = { Private: 0, FriendsOnly: 1, Public: 2, Invisible: 3 };

class SteamPeerConn extends EventEmitter {
  constructor(host, steamId, id) {
    super();
    this.host = host; this.steamId = steamId; this.id = id;
    this.readyState = 1;               // ws.OPEN
    this.relSent = 0; this.snapSeq = 0; this.bufferedAmount = 0;
  }
  // ws's send(data, opts): opts.unreliable marks a snapshot; binary data is voice
  send(data, opts = {}) {
    if (this.readyState !== 1) return;
    const net = this.host.net, to = this.steamId;
    if (typeof data !== 'string') net.send(to, packVoice(this.id, data), 'voice');
    else if (opts?.unreliable) for (const pk of packSnap(this.id, ++this.snapSeq, this.relSent, data)) net.send(to, pk, 'unreliable');
    else { this.relSent++; net.send(to, packGame(this.id, data), 'reliable'); }
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.host.net.send(this.steamId, packJson(K.CLOSE, { conn: this.id, code, reason: String(reason).slice(0, 120) }), 'reliable');
    this._closed(code, reason);
  }
  terminate() { this.close(1006, 'terminated'); }
  _message(data, isBinary) { if (this.readyState === 1) this.emit('message', data, isBinary); }
  _closed(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.host.peers.get(this.steamId) === this) this.host.peers.delete(this.steamId);
    this.emit('close', code, Buffer.from(String(reason)));
  }
}

class SteamHost extends EventEmitter {
  // link: anything with attach(conn, info), the game server's door (main.cjs ServerLink, or a GameHost)
  constructor({ steam, link, build, code = '', maxMembers = 6, timeoutMs = 10000, log = () => {} }) {
    super();
    Object.assign(this, { steam, link, build, code, maxMembers, log });
    this.me = big(steam.localplayer.getSteamId().steamId64);
    this.peers = new Map();            // steamId -> SteamPeerConn
    this.net = new P2PNet(steam, { timeoutMs, accept: id => this.isMember(id) });
    this.closed = false;
  }
  isMember(id) { try { return !!this.lobby && this.lobby.getMembers().some(m => big(m.steamId64) === id); } catch { return false; } }

  async open() {
    this.lobby = await this.steam.matchmaking.createLobby(LobbyType.FriendsOnly, this.maxMembers);
    if (this.closed) { try { this.lobby.leave(); } catch {} throw new Error('closed while opening'); }
    this.lobby.mergeFullData({ build: this.build, proto: String(LINK_PROTO), host: String(this.me), name: this.steam.localplayer.getName(), code: this.code });
    this.net.on('packet', (from, buf) => { try { this.onPacket(from, buf); } catch (e) { this.log('[steam] bad packet from', String(from), e.message); } });
    this.net.on('timeout', (id, ms) => this.drop(id, `no packets for ${Math.round(ms)} ms`));
    this.net.on('fail', (id, err) => this.drop(id, `P2P session failed (${err})`));
    this.net.on('refused', id => this.log(`[steam] refused a P2P session from ${id} (not in the lobby)`));
    this.chatH = this.steam.callback.register(CB.LobbyChatUpdate, e => {
      if (!this.lobby || big(e.lobby) !== this.lobby.id) return;
      const what = memberChange(e.member_state_change), who = big(e.user_changed);
      this.log(`[steam] lobby: ${who} ${what}`);
      if (what !== 'Entered') this.drop(who, `left the lobby (${what})`);
      if (this.presence) this.setPresence(this.presence);          // the crew's size in the friends list
    });
    this.net.start();
    this.log(`[steam] hosting lobby ${this.lobby.id} for trip ${this.code} (build ${this.build})`);
    return this.lobby;
  }
  setCode(code) { this.code = code; try { this.lobby?.mergeFullData({ code }); } catch {} }

  onPacket(from, buf) {
    const kind = buf[0], peer = this.peers.get(from);
    if (kind === K.HELLO) {
      let h; try { h = unpackJson(buf); } catch { return; }
      const conn = Number(h.conn) & 255;
      const reject = (code, msg) => this.net.send(from, packJson(K.REJECT, { conn, code, msg }), 'reliable');
      if (this.closed) return reject('closing', 'The host is closing the game.');
      if (!this.isMember(from)) return reject('lobby', 'Join the host\'s trip from Steam first.');
      if (h.proto !== LINK_PROTO || h.build !== this.build) return reject('version', `Version mismatch: your game is ${h.build}, the host's is ${this.build}. Restart Steam so both of you get the latest update.`);
      // the same HELLO again (the guest resends until WELCOME): answer it again
      if (peer && peer.id === conn && peer.readyState === 1) { this.net.send(from, packJson(K.WELCOME, { conn }), 'reliable'); return; }
      if (peer) peer._closed(4002, 'replaced by a new connection');   // a reload or a reconnect replaces the old one
      const c = new SteamPeerConn(this, from, conn);
      this.peers.set(from, c);
      this.net.watch(from);
      this.net.send(from, packJson(K.WELCOME, { conn }), 'reliable');
      this.link.attach(c, { kind: 'steam', key: `steam:${from}` });
      this.log(`[steam] ${String(h.name || from).slice(0, 32)} connected (conn ${conn})`);
      return;
    }
    if (!peer) return;
    if (kind === K.GAME) { if (buf[1] === peer.id) peer._message(buf.subarray(2).toString(), false); return; }
    if (kind === K.VOICE) { if (buf[1] === peer.id) peer._message(Buffer.from(buf.subarray(2)), true); return; }
    if (kind === K.CLOSE) {
      let j = {}; try { j = unpackJson(buf); } catch {}
      if (j.conn === peer.id) { this.net.unwatch(from); peer._closed(1000, j.reason || 'closed by the guest'); }
      return;
    }
    if (kind === K.BYE) this.drop(from, 'the guest left');
  }

  drop(id, why) {
    const p = this.peers.get(id);
    if (!p) return;
    this.log(`[steam] dropping ${id}: ${why}`);
    this.net.unwatch(id);
    p._closed(4003, why);
  }

  // the trip is over (the host quit, or went back to the menu): every guest hears it, then the lobby goes
  close(msg = 'The host ended the trip.') {
    if (this.closed) return;
    this.closed = true;
    let members = [];
    try { members = this.lobby ? this.lobby.getMembers().map(m => big(m.steamId64)) : []; } catch {}
    for (const id of new Set([...members, ...this.peers.keys()])) if (id !== this.me) this.net.send(id, packJson(K.BYE, { reason: 'host-left', msg }), 'reliable');
    for (const p of [...this.peers.values()]) p._closed(4000, 'host left');
    try { this.lobby?.setJoinable?.(false); } catch {}
    // a moment for the reliable BYEs to leave before the sessions go
    setTimeout(() => {
      try { this.lobby?.leave(); } catch {}
      try { this.chatH?.disconnect(); } catch {}
      this.net.stop();
    }, 250);
  }

  // the host's own rich presence (guests set theirs from their own page)
  setPresence(p) {
    this.presence = p;
    let size = 1;
    try { size = this.lobby ? Number(this.lobby.getMemberCount()) : 1; } catch {}
    setPresence(this.steam, { ...p, group: this.lobby ? String(this.lobby.id) : '', size });
  }
}

// Rich presence: steam_display must be a token from the app's localization file (steam/richpresence.vdf,
// uploaded in Steamworks); %day% and %biome% fill it. steam_player_group puts the crew together in the
// friends list.
const PHASES = { camp: '#Status_Camp', road: '#Status_Road', night: '#Status_Night', over: '#Status_Over' };
function presenceFor({ ph, day, biome } = {}) {
  if (!ph || ph === 'menu' || !PHASES[ph]) return { steam_display: '#Status_Menu', day: '', biome: '' };
  return { steam_display: PHASES[ph], day: String(day || 1), biome: /^[a-z]{1,16}$/.test(biome || '') ? biome : 'meadow' };
}
function setPresence(steam, { ph, day, biome, group = '', size = 1 } = {}) {
  const kv = { ...presenceFor({ ph, day, biome }), steam_player_group: group, steam_player_group_size: group ? String(size) : '' };
  for (const [k, v] of Object.entries(kv)) { try { steam.localplayer.setRichPresence(k, v || null); } catch {} }
  return kv;
}

module.exports = { SteamHost, SteamPeerConn, presenceFor, setPresence, LobbyType };
