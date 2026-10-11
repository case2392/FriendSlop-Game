'use strict';
// A guest's side of playing over Steam: the bridge in the joining friend's main process.
//   page (the friend's own copy of the game)  --ws://127.0.0.1:<port>-->  bridge
//   bridge  --Steam P2P to the host's Steam ID-->  SteamHost  -->  the host's game server
// The page talks to the bridge exactly as it talks to a game server. The bridge:
//   - joins the lobby and checks the build in its data BEFORE anything loads (a clear message, fast)
//   - takes the host's Steam ID from the lobby data, not getOwner(): Steam hands a lobby to another
//     member when its owner leaves, and that member isn't running the trip
//   - sends one HELLO per page connection (again every 2 s until WELCOME); the page's messages wait for
//     the WELCOME, then go as GAME (reliable)
//   - puts snapshot fragments back together and releases them in order (frame.cjs)
//   - the host says BYE, or leaves the lobby: the page hears why, and its socket closes with 4000
//   - the link goes quiet (10 s) or fails: the page's socket closes with 4005 and the page reconnects
//     by itself, the way it does after any dropped connection; the host gives the seat back
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { K, LINK_PROTO, packJson, unpackJson, packGame, packVoice, SnapAssembler } = require('./frame.cjs');
const { P2PNet, CB, memberChange, big, lobbyCall, useLobby, leaveUnlessUsed } = require('./p2p.cjs');
const { setPresence } = require('./host.cjs');

class GuestBridge extends EventEmitter {
  constructor({ steam, build, origin = null, timeoutMs = 10000, lobbyTimeoutMs = 20000, log = () => {} }) {
    super();
    Object.assign(this, { steam, build, origin, timeoutMs, lobbyTimeoutMs, log });
    this.me = big(steam.localplayer.getSteamId().steamId64);
    this.state = 'idle';          // idle | joined | hello | open | ended
    this.connId = 0;
    this.ws = null; this.queue = [];
    this.asm = new SnapAssembler();
    this.stats = { toPage: 0, fromPage: 0, snapsToPage: 0, rejects: 0, links: 0 };
  }

  // a lobby id from an invite, Join Game, a trip code's search, or +connect_lobby
  async joinLobby(lobbyId) {
    const unuse = this.unuse = useLobby(this.steam, big(lobbyId));     // until leave(), or this join fails
    let lobby;
    try { lobby = await lobbyCall(this.steam.matchmaking.joinLobby(big(lobbyId)), this.lobbyTimeoutMs, 'no answer', this.steam); }
    catch (e) { unuse(); throw Object.assign(new Error(e.message === 'no answer' ? 'Steam didn\'t let us into that trip. Try again.' : 'Couldn\'t get into that trip. It may be full (6 max) or over.'), { code: 'lobby' }); }
    const fail = (msg, code) => { unuse(); leaveUnlessUsed(this.steam, lobby); throw Object.assign(new Error(msg), { code }); };
    // closed while Steam was answering (the player went on to host, or to another trip): nothing more
    if (this.closed) fail('Joining that trip was called off.', 'closed');
    let d = {};
    try { d = lobby.getFullData() || {}; } catch {}
    if (!d.host || !/^\d+$/.test(d.host)) fail('That trip isn\'t running any more.', 'noroom');
    if (big(d.host) === this.me) fail('That\'s your own trip.', 'self');
    if (d.proto !== String(LINK_PROTO) || d.build !== this.build) {
      fail(`Version mismatch: your game is ${this.build}, ${d.name || 'the host'} has ${d.build || 'another version'}. Restart Steam so you both get the latest update.`, 'version');
    }
    this.lobby = lobby;
    this.host = big(d.host);
    this.hostName = String(d.name || 'The host').slice(0, 32);
    this.code = String(d.code || '');
    this.net = new P2PNet(this.steam, { timeoutMs: this.timeoutMs, accept: id => id === this.host });
    this.net.on('packet', (from, buf) => { if (from === this.host) try { this.onHost(buf); } catch (e) { this.log('[steam] bad packet from the host:', e.message); } });
    this.net.on('timeout', () => this.linkLost('no packets from the host'));
    this.net.on('fail', (id, err) => { if (id === this.host) this.linkLost(`P2P session failed (${err})`); });
    this.chatH = this.steam.callback.register(CB.LobbyChatUpdate, e => {
      if (!this.lobby || big(e.lobby) !== this.lobby.id) return;
      if (big(e.user_changed) === this.host && memberChange(e.member_state_change) !== 'Entered') this.hostGone(`${this.hostName} left the game. The trip is over.`);
      else if (this.presence) this.setPresence(this.presence);     // the crew's size in the friends list
    });
    this.net.start();
    this.state = 'joined';
    this.log(`[steam] in lobby ${lobby.id}: host ${this.host} (${this.hostName}), trip ${this.code}`);
    return { code: this.code, hostName: this.hostName };
  }

  // the page connects here as if this were a game server. Only the game's own page may (a browser always
  // sends Origin: a web page can't drive the game through ws://127.0.0.1); tools send none.
  listen(port = 0) {
    if (this.closed) return Promise.reject(Object.assign(new Error('Joining that trip was called off.'), { code: 'closed' }));
    this.http = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 64 * 1024, verifyClient: ({ origin }) => !origin || origin === this.origin });
    this.wss.on('connection', ws => this.onPage(ws));
    this.wss.on('error', e => this.log('[steam] bridge socket error:', e.message));
    return new Promise((res, rej) => {
      this.http.once('error', rej);
      // closed before it was listening: the callback never comes
      this.http.once('close', () => rej(Object.assign(new Error('Joining that trip was called off.'), { code: 'closed' })));
      this.http.listen(port, '127.0.0.1', () => { this.http.off('error', rej); this.port = this.http.address().port; res(this.port); });
    });
  }

  onPage(ws) {
    ws.on('error', () => { try { ws.terminate(); } catch {} });
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(1000, 'replaced'); } catch {} }
    this.ws = ws; this.queue = [];
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.stats.fromPage++;
      if (this.state === 'open') this.forward(data, isBinary);
      else if (this.state === 'hello' && !isBinary && this.queue.length < 256) this.queue.push(data.toString());
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.helloT);
      if (this.state === 'open' || this.state === 'hello') {
        this.net.send(this.host, packJson(K.CLOSE, { conn: this.connId, code: 1000, reason: 'page closed' }), 'reliable');
        this.state = 'joined';
      }
    });
    if (this.state === 'ended' || !this.lobby) {
      this.toPage({ t: 'error', msg: this.endMsg || 'That trip is over.', code: 'noroom' });
      ws.close(4004, 'no trip');
      return;
    }
    this.hello();
  }

  hello() {
    this.connId = (this.connId % 255) + 1;
    this.asm.reset(this.connId);
    this.state = 'hello';
    this.stats.links++;
    this.net.watch(this.host);
    const pk = packJson(K.HELLO, { proto: LINK_PROTO, build: this.build, name: this.steam.localplayer.getName(), conn: this.connId });
    this.net.send(this.host, pk, 'reliable');
    // a HELLO from someone the host's Steam hasn't seen in the lobby yet waits for the next session request
    clearInterval(this.helloT);
    this.helloT = setInterval(() => { if (this.state === 'hello') this.net.send(this.host, pk, 'reliable'); else clearInterval(this.helloT); }, 2000);
  }

  forward(data, isBinary) {
    if (isBinary) this.net.send(this.host, packVoice(this.connId, data), 'voice');
    else this.net.send(this.host, packGame(this.connId, data.toString()), 'reliable');
  }
  toPage(obj) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    this.stats.toPage++;
  }
  closePage(code, reason) { const ws = this.ws; if (!ws) return; try { ws.close(code, String(reason).slice(0, 100)); } catch { try { ws.terminate(); } catch {} } }

  onHost(buf) {
    const kind = buf[0];
    if (kind === K.WELCOME) {
      if (unpackJson(buf).conn !== this.connId || this.state !== 'hello') return;
      this.state = 'open';
      clearInterval(this.helloT);
      for (const text of this.queue.splice(0)) this.forward(text, false);
      this.emit('open');
      return;
    }
    if (kind === K.REJECT) {
      const j = unpackJson(buf);
      if (j.conn !== this.connId || this.state !== 'hello') return;
      this.stats.rejects++;
      this.state = 'joined';
      clearInterval(this.helloT);
      this.toPage({ t: 'error', msg: String(j.msg || 'The host turned the connection away.'), code: j.code === 'version' ? 'version' : 'noroom' });
      this.closePage(4004, j.code);
      this.emit('reject', j);
      return;
    }
    if (kind === K.GAME) {
      if (buf[1] !== this.connId || this.state !== 'open') return;
      this.toPage(buf.subarray(2).toString());
      for (const s of this.asm.onReliable()) { this.toPage(s); this.stats.snapsToPage++; }
      return;
    }
    if (kind === K.SNAP) {
      if (this.state !== 'open') return;
      for (const s of this.asm.push(buf)) { this.toPage(s); this.stats.snapsToPage++; }
      return;
    }
    if (kind === K.VOICE) { if (buf[1] === this.connId && this.state === 'open' && this.ws?.readyState === 1) this.ws.send(buf.subarray(2), { binary: true }); return; }
    if (kind === K.CLOSE) {
      const j = unpackJson(buf);
      if (j.conn !== this.connId || (this.state !== 'open' && this.state !== 'hello')) return;
      this.state = 'joined';
      clearInterval(this.helloT);
      const code = j.code === 1000 || (j.code >= 4000 && j.code <= 4999) ? j.code : 4005;
      this.closePage(code, j.reason || 'closed by the host');
      return;
    }
    if (kind === K.BYE) { let j = {}; try { j = unpackJson(buf); } catch {} this.hostGone(String(j.msg || `${this.hostName} ended the trip.`)); }
  }

  linkLost(why) {
    if (this.state !== 'open' && this.state !== 'hello') return;
    this.log(`[steam] lost the link to the host: ${why}`);
    this.state = 'joined';
    clearInterval(this.helloT);
    this.closePage(4005, 'lost the host');        // the page reconnects (a new HELLO)
  }

  hostGone(msg) {
    if (this.state === 'ended') return;
    this.log(`[steam] the trip is over: ${msg}`);
    this.state = 'ended'; this.endMsg = msg;
    clearInterval(this.helloT);
    this.toPage({ t: 'hostleft', msg });
    this.closePage(4000, 'host left');
    this.leave(false);
    this.emit('ended', msg);
  }

  setPresence(p) {
    this.presence = p;
    let size = 1;
    try { size = this.lobby ? Number(this.lobby.getMemberCount()) : 1; } catch {}
    setPresence(this.steam, { ...p, group: this.lobby ? String(this.lobby.id) : '', size });
  }

  // leaving on purpose (back to the menu, quitting)
  leave(sayBye = true) {
    clearInterval(this.helloT);
    if (sayBye && this.host && this.net && this.state !== 'ended') this.net.send(this.host, packJson(K.BYE, { reason: 'guest-left' }), 'reliable');
    try { this.chatH?.disconnect(); } catch {}
    this.unuse?.();
    leaveUnlessUsed(this.steam, this.lobby);
    this.chatH = null; this.lobby = null;
    if (this.state !== 'ended') this.state = 'idle';
    const net = this.net;
    setTimeout(() => net?.stop(), 250);
  }
  // for good: a join still waiting on Steam stops when Steam answers (and leaves the lobby it got)
  close() {
    this.closed = true;
    this.leave(true);
    this.closePage(1000, 'bridge closed');
    try { this.wss?.close(); } catch {}
    try { this.http?.close(); } catch {}
  }
}

module.exports = { GuestBridge };
