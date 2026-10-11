// A steamworks.js-shaped client backed by the fake Steam backend (backend.mjs).
// It implements exactly the subset of the steamworks.js 0.4.0 API the game uses, with the same shapes:
// BigInt Steam IDs, PlayerSteamId objects, isP2PPacketAvailable() -> size, readP2PPacket(size) ->
// { data, size, steamId }, Lobby objects with synchronous getters, callbacks delivered on a 30 Hz pump
// (steamworks.js runs runCallbacks every 1000/30 ms), member_state_change as a string.
import net from 'node:net';
import { OP, frame, jframe, decoder, json } from './wire.mjs';

export const SteamCallback = {
  PersonaStateChange: 0, SteamServersConnected: 1, SteamServersDisconnected: 2, SteamServerConnectFailure: 3,
  LobbyDataUpdate: 4, LobbyChatUpdate: 5, P2PSessionRequest: 6, P2PSessionConnectFail: 7,
  GameLobbyJoinRequested: 8, MicroTxnAuthorizationResponse: 9,
};
const pid = id => ({ steamId64: BigInt(id), steamId32: `STEAM_0:${BigInt(id) & 1n}:${(BigInt(id) & 0xffffffffn) >> 1n}`, accountId: Number(BigInt(id) & 0xffffffffn) });

export async function initFakeSteam({ port, steamId, name, netem = null }) {
  const me = String(steamId);
  const sock = net.connect(port, '127.0.0.1');
  sock.setNoDelay(true);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const inbox = [];                 // received P2P packets: { from, data }
  const lobbies = new Map();        // id(str) -> state pushed by the backend
  const handlers = new Map();       // callback id -> Set(fn)
  const cbQueue = [];
  const waiting = new Map();        // reqId -> resolve
  let reqN = 1;
  const stats = { sent: 0, sentBytes: 0, recv: 0, recvBytes: 0, refusedBig: 0 };
  const raise = (cb, v) => cbQueue.push([cb, v]);
  const big = v => BigInt(v);

  let registered;
  const ready = new Promise(r => { registered = r; });
  sock.on('data', decoder((op, p) => {
    switch (op) {
      case OP.REGISTERED: registered(); return;
      case OP.PKT: { const from = p.subarray(0, 20).toString().replace(/^0+/, ''); const data = Buffer.from(p.subarray(20)); inbox.push({ from, data }); stats.recv++; stats.recvBytes += data.length; return; }
      case OP.SESSION_REQUEST: raise(SteamCallback.P2PSessionRequest, { remote: big(json(p).remote) }); return;
      case OP.SESSION_FAIL: { const j = json(p); raise(SteamCallback.P2PSessionConnectFail, { remote: big(j.remote), error: j.error }); return; }
      case OP.LOBBY_STATE: { const j = json(p); lobbies.set(String(j.lobby), j); return; }
      case OP.LOBBY_CHAT_UPDATE: { const j = json(p); raise(SteamCallback.LobbyChatUpdate, { lobby: big(j.lobby), user_changed: big(j.user_changed), making_change: big(j.making_change), member_state_change: j.member_state_change }); return; }
      case OP.LOBBY_DATA_UPDATE: { const j = json(p); raise(SteamCallback.LobbyDataUpdate, { lobby: big(j.lobby), member: big(j.member), success: j.success }); return; }
      case OP.JOIN_REQUESTED: { const j = json(p); raise(SteamCallback.GameLobbyJoinRequested, { lobby_steam_id: big(j.lobby_steam_id), friend_steam_id: big(j.friend_steam_id) }); return; }
      case OP.LOBBY_RESULT: case OP.CONTROL_RESULT: { const j = json(p); waiting.get(j.reqId)?.(j); waiting.delete(j.reqId); return; }
    }
  }));
  const request = (op, obj) => new Promise(res => { const reqId = reqN++; waiting.set(reqId, res); sock.write(jframe(op, { ...obj, reqId })); });
  sock.write(jframe(OP.REGISTER, { steamId: me, name, net: netem }));
  await ready;

  // the runCallbacks pump
  const pump = setInterval(() => {
    for (const [cb, v] of cbQueue.splice(0)) for (const fn of handlers.get(cb) || []) { try { fn(v); } catch (e) { console.error('callback error', e); } }
  }, 1000 / 30);

  class Lobby {
    constructor(id) { this.id = BigInt(id); this._k = String(id); }
    get _s() { return lobbies.get(this._k) || { members: [], data: {}, owner: null, max: 0 }; }
    join() { return mm.joinLobby(this.id); }
    leave() { sock.write(frame(OP.LEAVE_LOBBY, Buffer.from(this._k))); lobbies.delete(this._k); }
    openInviteDialog() { client.overlay.activateInviteDialog(this.id); }
    getMemberCount() { return BigInt(this._s.members.length); }
    getMemberLimit() { return this._s.max == null ? null : BigInt(this._s.max); }
    getMembers() { return this._s.members.map(pid); }
    getOwner() { return pid(this._s.owner ?? 0); }
    setJoinable(j) { sock.write(jframe(OP.SET_JOINABLE, { lobby: this._k, joinable: j })); return this._s.owner === me; }
    getData(k) { return this._s.data[k] ?? null; }
    setData(k, v) { return this.mergeFullData({ [k]: v }); }
    deleteData(k) { return this.mergeFullData({ [k]: null }); }
    getFullData() { return { ...this._s.data }; }
    mergeFullData(d) {
      if (this._s.owner !== me) return false;
      Object.assign(this._s.data, d);   // Steam updates the local copy at once
      sock.write(jframe(OP.SET_LOBBY_DATA, { lobby: this._k, data: d }));
      return true;
    }
  }
  const mm = {
    LobbyType: { Private: 0, FriendsOnly: 1, Public: 2, Invisible: 3 },
    async createLobby(type, max) {
      const r = await request(OP.CREATE_LOBBY, { type, max });
      if (!r.ok) throw new Error(r.err);
      await waitFor(() => lobbies.has(String(r.lobby)));
      return new Lobby(r.lobby);
    },
    async joinLobby(id) {
      const r = await request(OP.JOIN_LOBBY, { lobby: String(id) });
      if (!r.ok) { const e = new Error(r.err); e.why = r.why; throw e; }
      await waitFor(() => lobbies.has(String(r.lobby)));
      return new Lobby(r.lobby);
    },
    async getLobbies() { return []; },
  };
  const waitFor = (fn, ms = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const k = setInterval(() => { if (fn()) { clearInterval(k); res(); } else if (Date.now() - t0 > ms) { clearInterval(k); rej(new Error('timeout')); } }, 5); });

  const client = {
    localplayer: {
      getSteamId: () => pid(me), getName: () => name, getLevel: () => 1, getIpCountry: () => 'US',
      setRichPresence: (key, value) => sock.write(jframe(OP.RICH_PRESENCE, { key, value: value ?? null })),
    },
    networking: {
      SendType: { Unreliable: 0, UnreliableNoDelay: 1, Reliable: 2, ReliableWithBuffering: 3 },
      sendP2PPacket(steamId64, sendType, data) {
        if (sendType < 2 && data.length > 1200) { stats.refusedBig++; return false; }    // the API refuses it
        const to = Buffer.from(String(steamId64).padStart(20, '0'));
        const b = Buffer.allocUnsafe(1 + 20 + data.length);
        b[0] = sendType; to.copy(b, 1); data.copy ? data.copy(b, 21) : Buffer.from(data).copy(b, 21);
        sock.write(frame(OP.SEND, b));
        stats.sent++; stats.sentBytes += data.length;
        return true;
      },
      isP2PPacketAvailable: () => (inbox.length ? inbox[0].data.length : 0),
      readP2PPacket(size) {
        const p = inbox.shift();
        if (!p) throw new Error('No packet available');
        const data = Buffer.alloc(size); p.data.copy(data, 0, 0, Math.min(size, p.data.length));
        return { data, size: Math.min(size, p.data.length), steamId: pid(p.from) };
      },
      acceptP2PSession: steamId64 => sock.write(frame(OP.ACCEPT, Buffer.from(String(steamId64)))),
    },
    matchmaking: mm,
    callback: {
      SteamCallback,
      register(cb, fn) { if (!handlers.has(cb)) handlers.set(cb, new Set()); handlers.get(cb).add(fn); return { disconnect: () => handlers.get(cb).delete(fn) }; },
    },
    overlay: {
      invites: [],
      activateInviteDialog(lobbyId) { client.overlay.invites.push(BigInt(lobbyId)); },   // no overlay here: tests call __fake.invite
    },
    utils: { getAppId: () => 480 },
    // test-only levers
    __fake: {
      me, stats,
      invite: (lobbyId, to) => sock.write(jframe(OP.INVITE, { lobby: String(lobbyId), to: String(to) })),
      control: obj => request(OP.CONTROL, obj).then(r => r.res),
      close: () => { clearInterval(pump); sock.destroy(); },
    },
  };
  return client;
}
