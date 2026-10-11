// Fake Steam backend: stands in for the Steam client + Valve's relay network so the transport can be
// tested here with no Steam. Emulates what the game code relies on:
//   - P2P (old ISteamNetworking semantics): a packet from someone you haven't accepted is held and a
//     P2PSessionRequest is raised; acceptP2PSession (or sending to them) opens the session. Unreliable
//     packets: <=1200 B, may be lost, duplicated or reordered. Reliable: never lost, ordered per pair,
//     a lost packet costs a retransmit (head-of-line blocking).
//   - a network model per process: one-way latency, jitter, loss, duplication; partitions (cable
//     pulled) that make reliable senders get P2PSessionConnectFail after `failMs`.
//   - lobbies: create/join/leave, max members, data (owner writes), joinable, owner migration when the
//     owner leaves (Steam does this), LobbyChatUpdate with string member_state_change ("Entered",
//     "Left", "Disconnected") as steamworks.js delivers it, invites -> GameLobbyJoinRequested.
//   - a process exit (socket close) = the Steam client noticing the game died: "Disconnected".
//   - the lobby list (RequestLobbyList) as Steam answers it: only Public and Invisible lobbies that are
//     joinable and not full; string filters (Equal / NotEqual, compared as text); a distance filter over
//     regions (each user has one; a lobby takes its creator's: Close = the same region, Default = up to
//     one away, Far = two, Worldwide = all); nearest first; 50 results unless a count filter says
//     otherwise. Every search is recorded (CONTROL 'lists'); levers make it slow, fail or never answer.
//   - JoinLobby can answer late (CONTROL 'joins'); joining a lobby you're in answers yes (one membership).
import net from 'node:net';
import { OP, frame, jframe, decoder, json } from './wire.mjs';

export function startBackend({ port = 0, seed = 1, log = () => {} } = {}) {
  let rs = seed >>> 0;
  const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296);
  const users = new Map();          // steamId(str) -> { sock, name, accepted:Set, pending:Map(from->[]), lastReq:Map, presence:{}, net }
  const lobbies = new Map();        // lobbyId(str) -> { id, owner, members:[], data:{}, max, type, joinable }
  let nextLobby = 109775240000000000n;
  const defaults = { lat: 25, jit: 8, loss: 0, dup: 0, failMs: 6000 };
  const pairState = new Map();      // `${a}>${b}` -> { lastRel }
  const stats = { pkts: 0, bytes: 0, dropped: 0, dupd: 0, retrans: 0, held: 0, rejectedBig: 0, lists: 0 };
  const lists = [];                 // every lobby search: { by, filters, results }
  const search = { delayMs: 40, fail: false, hang: false };   // levers (CONTROL 'search')
  const joins = { delayMs: 0 };                                 // a slow JoinLobby answer (CONTROL 'joins')

  const now = () => performance.now();
  const netOf = id => ({ ...defaults, ...(users.get(id)?.net || {}) });
  const send = (id, buf) => { const u = users.get(id); if (u && !u.sock.destroyed) u.sock.write(buf); };
  const partitioned = id => (users.get(id)?.partitionUntil || 0) > now();

  function pushLobby(L) {
    const st = { lobby: L.id, owner: L.owner, members: [...L.members], data: L.data, max: L.max, type: L.type, joinable: L.joinable };
    for (const m of L.members) send(m, jframe(OP.LOBBY_STATE, st));
  }
  function chatUpdate(L, user, change, by = user) {
    for (const m of L.members) send(m, jframe(OP.LOBBY_CHAT_UPDATE, { lobby: L.id, user_changed: user, making_change: by, member_state_change: change }));
    if (change !== 'Entered') send(user, jframe(OP.LOBBY_CHAT_UPDATE, { lobby: L.id, user_changed: user, making_change: by, member_state_change: change }));
  }
  function leaveLobby(L, id, change) {
    const i = L.members.indexOf(id);
    if (i < 0) return;
    L.members.splice(i, 1);
    if (L.owner === id) L.owner = L.members[0] ?? null;    // Steam hands the lobby to someone else
    if (!L.members.length) { lobbies.delete(L.id); return; }
    chatUpdate(L, id, change);
    pushLobby(L);
  }

  // deliver one P2P packet a -> b through the network model
  function deliver(a, b, sendType, data) {
    stats.pkts++; stats.bytes += data.length;
    if (partitioned(a) || partitioned(b)) {
      stats.dropped++;
      if (sendType >= 2) {   // reliable data that can't get through: the sender hears about it eventually
        const u = users.get(a);
        if (u && !u.failTimer?.has(b)) {
          (u.failTimer ||= new Map()).set(b, setTimeout(() => { u.failTimer.delete(b); if (partitioned(a) || partitioned(b)) send(a, jframe(OP.SESSION_FAIL, { remote: b, error: 4 })); }, netOf(a).failMs));
        }
      }
      return;
    }
    const na = netOf(a), nb = netOf(b);
    const lat = (na.lat + nb.lat) / 2, jit = Math.max(na.jit, nb.jit), loss = 1 - (1 - na.loss) * (1 - nb.loss), dup = Math.max(na.dup, nb.dup);
    const t = now();
    let at = t + lat + rnd() * jit;
    if (sendType >= 2) {
      // reliable: every lost ~1200-byte packet costs one retransmit timeout; order is kept per pair
      const pkts = Math.max(1, Math.ceil(data.length / 1200));
      for (let i = 0; i < pkts; i++) while (rnd() < loss) { at += 2 * lat + 30; stats.retrans++; }
      // a FIFO per pair: timers alone can't keep order (Node resolves them to the millisecond)
      const k = `${a}>${b}`;
      let ps = pairState.get(k);
      if (!ps) { ps = { q: [], timer: null, lastRel: 0 }; pairState.set(k, ps); }
      at = Math.max(at, ps.lastRel); ps.lastRel = at;
      ps.q.push({ at, data, sendType });
      const drain = () => {
        ps.timer = null;
        const tn = now();
        while (ps.q.length && ps.q[0].at <= tn + 0.5) { const m = ps.q.shift(); arrive(a, b, m.sendType, m.data); }
        if (ps.q.length) ps.timer = setTimeout(drain, Math.max(0, ps.q[0].at - now()));
      };
      if (!ps.timer) ps.timer = setTimeout(drain, Math.max(0, ps.q[0].at - t));
      return;
    } else {
      if (rnd() < loss) { stats.dropped++; return; }
      if (rnd() < dup) { stats.dupd++; setTimeout(() => arrive(a, b, sendType, data), Math.max(0, at - t + rnd() * jit)); }
    }
    setTimeout(() => arrive(a, b, sendType, data), Math.max(0, at - t));
  }
  function arrive(a, b, sendType, data) {
    const ub = users.get(b);
    if (!ub) return;
    if (!ub.accepted.has(a)) {
      // no session yet: hold it and ask (like P2PSessionRequest_t, re-posted while they keep sending)
      if (sendType === 1) { stats.dropped++; return; }          // UnreliableNoDelay: thrown away
      const q = ub.pending.get(a) || [];
      if (q.length < 512) q.push(data); ub.pending.set(a, q); stats.held++;
      const lr = ub.lastReq.get(a) || 0;
      if (now() - lr > 1000) { ub.lastReq.set(a, now()); send(b, jframe(OP.SESSION_REQUEST, { remote: a })); }
      return;
    }
    const idb = Buffer.from(a.padStart(20, '0'));
    send(b, frame(OP.PKT, Buffer.concat([idb, data])));
  }
  function accept(b, a) {
    const ub = users.get(b);
    if (!ub) return;
    ub.accepted.add(a);
    const q = ub.pending.get(a);
    if (q) { ub.pending.delete(a); for (const d of q) arrive(a, b, 2, d); }
  }

  const server = net.createServer(sock => {
    sock.setNoDelay(true);
    let me = null;
    sock.on('data', decoder((op, p) => {
      if (op === OP.REGISTER) {
        const j = json(p);
        me = String(j.steamId);
        const old = users.get(me);
        if (old) old.sock.destroy();
        users.set(me, { sock, name: j.name, accepted: new Set(), pending: new Map(), lastReq: new Map(), presence: {}, net: j.net || null, region: Number(j.region) || 0 });
        send(me, jframe(OP.REGISTERED, { steamId: me }));
        log(`[backend] ${j.name} (${me}) online`);
        return;
      }
      if (!me) return;
      const u = users.get(me);
      switch (op) {
        case OP.SEND: {
          const sendType = p[0], to = p.subarray(1, 21).toString().replace(/^0+/, ''), data = Buffer.from(p.subarray(21));
          if (sendType < 2 && data.length > 1200) { stats.rejectedBig++; return; }
          if (!u.accepted.has(to)) accept(me, to);     // sending to someone implicitly accepts them
          deliver(me, to, sendType, data);
          return;
        }
        case OP.ACCEPT: accept(me, p.toString()); return;
        case OP.CREATE_LOBBY: {
          const j = json(p);
          const id = String(nextLobby++);
          const L = { id, owner: me, members: [me], data: {}, max: j.max, type: j.type, joinable: true, region: u.region };
          lobbies.set(id, L);
          send(me, jframe(OP.LOBBY_RESULT, { reqId: j.reqId, ok: true, lobby: id }));
          pushLobby(L);
          return;
        }
        case OP.JOIN_LOBBY: {
          const j = json(p);
          const answer = () => {
            if (!users.has(me)) return;
            const L = lobbies.get(String(j.lobby));
            // steamworks.js reports every failure the same way ("Failed to join lobby"); the reason is kept here for logs
            const why = !L ? 'no such lobby' : !L.joinable ? 'not joinable' : L.members.length >= L.max ? 'full' : null;
            if (why) { send(me, jframe(OP.LOBBY_RESULT, { reqId: j.reqId, ok: false, err: 'Failed to join lobby', why })); return; }
            // already in it (an earlier join got there first): Steam answers yes, with one membership
            const fresh = !L.members.includes(me);
            if (fresh) L.members.push(me);
            send(me, jframe(OP.LOBBY_RESULT, { reqId: j.reqId, ok: true, lobby: L.id }));
            if (fresh) chatUpdate(L, me, 'Entered');
            pushLobby(L);
          };
          if (joins.delayMs) setTimeout(answer, joins.delayMs); else answer();
          return;
        }
        case OP.LEAVE_LOBBY: { const L = lobbies.get(p.toString()); if (L) leaveLobby(L, me, 'Left'); return; }
        case OP.SET_LOBBY_DATA: {
          const j = json(p), L = lobbies.get(String(j.lobby));
          if (!L || L.owner !== me) return;
          for (const [k, v] of Object.entries(j.data)) { if (v == null) delete L.data[k]; else L.data[k] = String(v); }
          for (const m of L.members) send(m, jframe(OP.LOBBY_DATA_UPDATE, { lobby: L.id, member: L.id, success: true }));
          pushLobby(L);
          return;
        }
        case OP.SET_JOINABLE: { const j = json(p), L = lobbies.get(String(j.lobby)); if (L && L.owner === me) { L.joinable = !!j.joinable; pushLobby(L); } return; }
        case OP.LIST_LOBBIES: {
          const j = json(p), f = j.filters || {}, entry = { by: me, filters: f, results: null };
          lists.push(entry); stats.lists++;
          if (search.hang) return;                                   // Steam never answers: the caller's timeout
          setTimeout(() => {
            if (!users.has(me)) return;
            if (search.fail) { send(me, jframe(OP.LOBBY_LIST, { reqId: j.reqId, ok: false, err: 'IOFailure' })); return; }
            const here = users.get(me).region, far = [0, 1, 2, Infinity][f.distance ?? 1] ?? 1;
            const out = [...lobbies.values()]
              .filter(L => (L.type === 2 || L.type === 3) && L.joinable && L.members.length < L.max && Math.abs(L.region - here) <= far)
              .filter(L => (f.strings || []).every(s => (s.cmp === 3 ? (L.data[s.key] ?? '') !== s.value : (L.data[s.key] ?? '') === s.value)))
              .sort((a, b) => Math.abs(a.region - here) - Math.abs(b.region - here))
              .slice(0, f.count ?? 50);
            entry.results = out.map(L => L.id);
            send(me, jframe(OP.LOBBY_LIST, { reqId: j.reqId, ok: true, lobbies: out.map(L => ({ lobby: L.id, data: { ...L.data }, max: L.max, count: L.members.length })) }));
          }, search.delayMs);
          return;
        }
        case OP.INVITE: { const j = json(p); send(String(j.to), jframe(OP.JOIN_REQUESTED, { lobby_steam_id: String(j.lobby), friend_steam_id: me })); return; }
        case OP.RICH_PRESENCE: { const j = json(p); if (j.value == null) delete u.presence[j.key]; else u.presence[j.key] = j.value; return; }
        case OP.CONTROL: {
          const j = json(p);
          let res = null;
          if (j.op === 'net') users.get(String(j.id ?? me)).net = { ...(users.get(String(j.id ?? me)).net || {}), ...j.net };
          else if (j.op === 'partition') users.get(String(j.id ?? me)).partitionUntil = now() + j.ms;
          else if (j.op === 'presence') res = Object.fromEntries([...users].map(([id, x]) => [id, x.presence]));
          else if (j.op === 'lobbies') res = [...lobbies.values()];
          else if (j.op === 'stats') res = stats;
          else if (j.op === 'region') users.get(String(j.id ?? me)).region = Number(j.region) || 0;
          else if (j.op === 'search') Object.assign(search, j.search || {});
          else if (j.op === 'joins') Object.assign(joins, j.joins || {});
          else if (j.op === 'lists') res = lists;
          send(me, jframe(OP.CONTROL_RESULT, { reqId: j.reqId, res }));
          return;
        }
      }
    }));
    const gone = () => {
      if (!me || users.get(me)?.sock !== sock) return;
      log(`[backend] ${users.get(me).name} (${me}) offline`);
      users.delete(me);
      for (const L of [...lobbies.values()]) leaveLobby(L, me, 'Disconnected');
    };
    sock.on('close', gone);
    sock.on('error', () => {});
  });
  return new Promise(res => server.listen(port, '127.0.0.1', () => res({ port: server.address().port, close: () => server.close(), stats, users, lobbies, lists, search })));
}
