// Playing over Steam, without Steam: the desktop build's lobby, P2P link and guest bridge (desktop/steam/)
// against test/fakesteam, a stand-in for the Steam client and Valve's relay network (P2P sessions with
// loss and lag, lobbies, invites, a game that dies). The game server is the real one (GameHost); the
// "pages" are bots that speak the client's protocol and reconnect the way client/js/main.js does.
//   node test/steamnet.mjs          (VERBOSE=1 for the transport's log)
import { createRequire } from 'node:module';
import WebSocket from 'ws';

process.env.FRIENDSLOP_TEST = '1';             // the room's dbg levers (move the RV) for the late-join case
const require = createRequire(import.meta.url);
const { startBackend } = await import('./fakesteam/backend.mjs');
const { initFakeSteam } = await import('./fakesteam/client.mjs');
const { GameHost } = await import('../server/host.js');
const { computeBuild } = await import('../server/build.js');
const { SteamHost, GuestBridge } = require('../desktop/steam/index.cjs');
const { P2PNet, CB } = require('../desktop/steam/p2p.cjs');
const { K, LINK_PROTO, packJson, unpackJson } = require('../desktop/steam/frame.cjs');

const VERBOSE = !!process.env.VERBOSE;
const log = VERBOSE ? (...a) => console.log(...a) : () => {};
let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 25) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; };
const ORIGIN = 'app://nmd';

// A page: the client's protocol, poses at 30 Hz, and its connection rules (main.js): 4000 or a
// 'hostleft' ends the trip, 4002 too (joined again elsewhere); anything else reconnects for up to
// `reconnectSecs` (connect, join with the same code, wait up to 8 s for the welcome, back off 1-5 s).
class Page {
  constructor(name, url, { build = null, origin, reconnectSecs = 60 } = {}) {
    Object.assign(this, { name, url, build, origin, reconnectSecs });
    this.byType = {}; this.snapTimes = []; this.closes = []; this.over = null; this.voiceIn = [];
    this.pos = { x: 0, y: 0, z: 0 }; this.lastTm = 0; this.tmBackwards = 0; this.reconnects = 0;
  }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url, this.origin ? { origin: this.origin } : {});
      let opened = false;
      ws.on('open', () => { opened = true; this.ws = ws; res(this); });
      ws.on('error', e => { if (!opened) rej(e); });
      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.closes.push({ code, reason: String(reason), at: performance.now() });
        if (this.quiet) return;
        if (this.hostLeft || code === 4000 || code === 4002) { this.over = { code, msg: this.hostLeft, at: performance.now() }; clearInterval(this.poseT); return; }
        if (this.code) this.reconnect();
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) { this.voiceIn.push(Buffer.from(data)); return; }
        const m = JSON.parse(data);
        m._at = performance.now();
        (this.byType[m.t] ||= []).push(m);
        if (m.t === 's') {
          this.snapTimes.push(m._at);
          if (this.snapTimes.length > 2000) this.snapTimes.splice(0, 1000);
          if (m.tm < this.lastTm) this.tmBackwards++;      // interp.js would wipe its buffers
          this.lastTm = m.tm;
          if (this.byType.s.length > 200) this.byType.s.splice(0, 100);
        }
        if (m.t === 'welcome') { this.id = m.id; this.code = m.code; this.welcomeWait?.res(m); }
        if (m.t === 'error') this.welcomeWait?.rej(m);
        if (m.t === 'hostleft') this.hostLeft = m.msg;
        if (m.t === 'tp') this.pos = { x: m.x, y: m.y, z: m.z };
        if (m.t === 'meta') this.meta = m;
      });
    });
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  hello(t, extra = {}) {
    const got = new Promise((res, rej) => { this.welcomeWait = { res, rej }; setTimeout(() => rej({ code: 'timeout' }), 8000); });
    this.send({ t, name: this.name, ...(this.build ? { build: this.build } : {}), rdy: 0, ...extra });
    return got.finally(() => { this.welcomeWait = null; });
  }
  create(seed = 777) { return this.hello('create', { seed }); }
  join(room) { return this.hello('join', { room }); }
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const t0 = performance.now();
    let delay = 1000;
    while (performance.now() - t0 < this.reconnectSecs * 1000) {
      try {
        await this.connect();
        await this.join(this.code);
        this.reconnects++; this.reconnecting = false;
        return;
      } catch (e) {
        if (e?.code === 'noroom' || e?.code === 'version' || e?.code === 'full') break;
        const ws = this.ws; this.ws = null; try { ws?.close(); } catch {}
      }
      await sleep(delay);
      delay = Math.min(5000, delay * 2);
    }
    this.reconnecting = false;
    this.over = { code: 'gave-up', msg: 'Couldn\'t reach the trip again.', at: performance.now() };
    clearInterval(this.poseT);
  }
  startPoses() {
    clearInterval(this.poseT);
    let k = 0;
    this.poseT = setInterval(() => {
      const p = this.poseFn ? this.poseFn(this, ++k) : this.pos;
      this.send({ t: 'p', par: 0, x: p.x, y: p.y, z: p.z, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
    }, 1000 / 30);
  }
  waitFor(type, pred = () => true, ms = 15000) {
    return until(() => (this.byType[type] || []).some(pred), ms, 10).then(got => { if (!got) throw new Error(`${this.name}: no '${type}' in ${ms} ms`); return this.byType[type].find(pred); });
  }
  snapRate(ms) { const t = performance.now() - ms; return this.snapTimes.filter(x => x > t).length / (ms / 1000); }
  close() { this.quiet = true; clearInterval(this.poseT); try { this.ws?.close(); } catch {} }
}

const BUILD = computeBuild();
const be = await startBackend({ log });
const SID = n => 76561190000000000n + BigInt(n);
const steamFor = (n, name, netem, region = 0) => initFakeSteam({ port: be.port, steamId: SID(n), name, netem, region });
const cleanup = [];

// the host: a game server (its own page connects over loopback, as in the desktop build) and the lobby
async function hostTrip(n, name, seed, { region = 0, maxMembers = 6 } = {}) {
  const gh = await new GameHost({ build: BUILD, holdSecs: 20, singleRoom: true, log }).init();
  gh.start();
  const port = await gh.listen({ port: 0, host: '127.0.0.1', origin: ORIGIN });
  const page = await new Page(name, `ws://127.0.0.1:${port}`, { build: BUILD, origin: ORIGIN }).connect();
  await page.create(seed);
  page.startPoses();
  const steam = await steamFor(n, name, null, region);
  const sh = new SteamHost({ steam, link: gh, build: BUILD, code: page.code, maxMembers, log });
  const lobby = await sh.open();
  cleanup.push(() => { page.close(); try { sh.close(); } catch {} gh.close(); steam.__fake.close(); });
  return { gh, port, page, steam, sh, lobby };
}
// a guest: their own Steam, the bridge in their main process, their page on the bridge's socket
async function guest(H, n, name, { build = BUILD, invite = true, netem = null, timeoutMs = 4000, reconnectSecs = 60 } = {}) {
  const steam = await steamFor(n, name, netem);
  const br = new GuestBridge({ steam, build, origin: ORIGIN, timeoutMs, log });
  const joinReq = new Promise(res => steam.callback.register(CB.GameLobbyJoinRequested, e => res(e)));
  if (invite) H.steam.__fake.invite(H.lobby.id, SID(n));         // the host picked them in the overlay's invite dialog
  const req = await Promise.race([joinReq, sleep(3000).then(() => null)]);
  const g = { n, name, steam, br, req };
  cleanup.push(() => { g.page?.close(); br.close(); steam.__fake.close(); });
  try { g.joined = await br.joinLobby(req ? req.lobby_steam_id : H.lobby.id); }
  catch (e) { g.err = e; return g; }
  const port = await br.listen();
  g.page = await new Page(name, `ws://127.0.0.1:${port}`, { build, origin: ORIGIN, reconnectSecs }).connect();
  return g;
}
// a guest who typed the trip code: the search the desktop shell runs (lobbysearch.cjs, with the fake's
// lobby filters where the real build has its FFI ones), then the bridge, exactly as after an invite
const { findTripByCode, pickFreeCode, ffiFilters } = require('../desktop/steam/lobbysearch.cjs');
async function guestByCode(n, name, code, { build = BUILD, region = 0, timeoutMs = 4000 } = {}) {
  const steam = await steamFor(n, name, null, region);
  const br = new GuestBridge({ steam, build, origin: ORIGIN, timeoutMs, log });
  const g = { n, name, steam, br };
  cleanup.push(() => { g.page?.close(); br.close(); steam.__fake.close(); });
  g.found = await findTripByCode(steam, steam.lobbyFilters, code, { me: String(SID(n)), build, retryMs: 300, log });
  if (!g.found.ok) return g;
  try { g.joined = await br.joinLobby(g.found.lobbyId); }
  catch (e) { g.err = e; return g; }
  const port = await br.listen();
  g.page = await new Page(name, `ws://127.0.0.1:${port}`, { build, origin: ORIGIN }).connect();
  return g;
}

try {
  const H = await hostTrip(1, 'Hosty', 777);
  const { gh, page: hostPage, lobby, sh } = H;
  const room = gh.room;
  check(lobby.getData('build') === BUILD && lobby.getData('host') === String(SID(1)) && lobby.getData('code') === hostPage.code && Number(lobby.getMemberLimit()) === 6 && be.lobbies.get(String(lobby.id))?.type === 2,
    `the host's trip ${hostPage.code} opened a Public lobby (6 max) with the build, the host and the code in its data`);

  // ---- two friends join through Steam ----
  const g2 = await guest(H, 2, 'Dave');
  check(g2.req && g2.req.friend_steam_id === SID(1) && g2.req.lobby_steam_id === lobby.id, 'an invite arrives as GameLobbyJoinRequested { lobby_steam_id, friend_steam_id }');
  check(g2.joined?.code === hostPage.code && g2.joined?.hostName === 'Hosty', `the guest read the trip from the lobby data (${g2.joined?.code}, ${g2.joined?.hostName})`);
  await g2.page.join(g2.joined.code);
  g2.page.startPoses();
  const g3 = await guest(H, 3, 'Erin');
  await g3.page.join(g3.joined.code);
  g3.page.startPoses();
  await until(() => hostPage.meta?.players.length === 3);
  check(hostPage.meta?.players.length === 3, `the host's roster: ${hostPage.meta?.players.map(p => p.name).join(', ')}`);
  const gotAll = p => ['welcome', 'world', 'props', 'tp', 'meta'].every(t => p.byType[t]);
  for (const p of [g2.page, g3.page]) { await until(() => gotAll(p), 5000); check(gotAll(p), `${p.name} got welcome, world, props, tp and meta through Steam`); }
  await sleep(3000);
  const rate = g2.page.snapRate(3000);
  check(rate > 16 && rate < 22, `snapshots reach a Steam guest at ${rate.toFixed(1)} Hz (20 Hz sent)`);
  check([...room.players.values()].find(p => p.name === 'Dave')?.raw != null, 'the guest\'s moves reach the host\'s game');
  check(g2.page.tmBackwards === 0, 'no snapshot reached the page out of order');
  sh.setPresence({ ph: 'camp', day: 1, biome: 'meadow' });
  await sleep(100);
  const pres = (await H.steam.__fake.control({ op: 'presence' }))[String(SID(1))];
  check(pres?.steam_display === '#Status_Camp' && pres?.day === '1' && pres?.steam_player_group === String(lobby.id) && pres?.steam_player_group_size === '3', `rich presence: ${JSON.stringify(pres)}`);

  // ---- nobody else drives the game through ws://127.0.0.1 ----
  {
    const tryOrigin = (url, origin) => new Promise(res => { const w = new WebSocket(url, { origin }); w.on('open', () => { w.close(); res('open'); }); w.on('error', e => res(String(e.message))); });
    const evilHost = await tryOrigin(`ws://127.0.0.1:${H.port}`, 'https://evil.example');
    const evilBridge = await tryOrigin(`ws://127.0.0.1:${g3.br.port}`, 'https://evil.example');
    check(evilHost !== 'open' && evilBridge !== 'open', `a web page's socket is refused by the host's server (${evilHost}) and by a guest's bridge`);
  }

  // ---- the wrong build is turned away, at every door ----
  const gBad = await guest(H, 9, 'OldVersion', { build: '0.5.9+deadbeef00' });
  check(gBad.err?.code === 'version' && /Version mismatch/.test(gBad.err.message), `the lobby data stops a different build before anything loads: "${gBad.err?.message}"`);
  await until(() => !lobby.getMembers().some(m => m.steamId64 === SID(9)), 3000);
  check(!lobby.getMembers().some(m => m.steamId64 === SID(9)), 'and that guest left the lobby again');
  {
    // a client that skips the lobby check still can't get in: the host checks the HELLO
    const steam = await steamFor(10, 'Sneaky');
    await steam.matchmaking.joinLobby(lobby.id);
    const net = new P2PNet(steam, { accept: () => true }).start();
    const got = new Promise(res => net.on('packet', (_from, buf) => res(buf)));
    net.send(SID(1), packJson(K.HELLO, { proto: LINK_PROTO, build: 'nope', name: 'Sneaky', conn: 1 }), 'reliable');
    const r = await Promise.race([got, sleep(4000).then(() => null)]);
    check(r && r[0] === K.REJECT && unpackJson(r).code === 'version', 'the host REJECTs a HELLO from a different build');
    net.stop(); steam.matchmaking && (await sleep(50)); steam.__fake.close();
  }
  {
    // someone outside the lobby can't even open a P2P session with the host
    const steam = await steamFor(11, 'Stranger');
    const net = new P2PNet(steam, { accept: () => true }).start();
    let refused = false;
    sh.net.once('refused', () => { refused = true; });
    net.send(SID(1), packJson(K.HELLO, { proto: LINK_PROTO, build: BUILD, name: 'Stranger', conn: 1 }), 'reliable');
    await until(() => refused, 3000);
    check(refused, 'a P2P session request from outside the lobby is refused');
    net.stop(); steam.__fake.close();
  }

  // ---- a friend joins mid-day: next to the RV, with the day as it is ----
  const W = room.W;
  hostPage.send({ t: 'dbg', op: 'tpRV', x: W.roadX(140), z: 140, yaw: 0 });
  await until(() => room.phase === 'road', 5000);
  const g4 = await guest(H, 4, 'Frank');
  await g4.page.join(g4.joined.code);
  g4.page.startPoses();
  await g4.page.waitFor('s');
  const tp = g4.page.byType.tp.at(-1), rv = room.sim.rv.translation();
  check(room.phase === 'road' && Math.hypot(tp.x - rv.x, tp.z - rv.z) < 8, `a friend joining on the road appears at the RV's door (${Math.hypot(tp.x - rv.x, tp.z - rv.z).toFixed(1)} m away)`);
  check(g4.page.byType.world[0].day === room.day && g4.page.byType.props[0].list.length === room.sim.props.size, `and gets day ${room.day} with all ${room.sim.props.size} props`);

  // ---- six is the limit: Steam's lobby stops the 7th (the room's own limit is the same 6) ----
  const g5 = await guest(H, 5, 'Gus');
  await g5.page.join(g5.joined.code);
  const g6 = await guest(H, 6, 'Hank');
  await g6.page.join(g6.joined.code);
  const g7 = await guest(H, 7, 'Ida');
  check(room.players.size === 6 && /full/.test(g7.err?.message || ''), `six aboard, and the 7th is stopped at Steam's lobby: "${g7.err?.message}"`);
  g6.page.close(); g6.br.close();
  await sleep(300);

  // ---- a friend's connection drops for 13 s: the seat waits, and they come back to it by themselves ----
  const was = { id: g3.page.id, color: hostPage.meta.players.find(p => p.name === 'Erin')?.color };
  room.players.get(was.id).walkie = true;
  await H.steam.__fake.control({ op: 'partition', id: String(SID(3)), ms: 13000 });
  const dropT = performance.now();
  await until(() => !hostPage.meta.players.some(p => p.name === 'Erin'), 12000);
  const held = room.players.get(was.id);
  check(held && !held.connected, `the host noticed after ${((performance.now() - dropT) / 1000).toFixed(1)} s and is keeping Erin's seat`);
  const back = await until(() => g3.page.reconnects >= 1, 30000);
  check(back && g3.page.id === was.id && g3.page.closes.some(c => c.code === 4005), `Erin's page was told the link went (4005), reconnected ${((performance.now() - dropT) / 1000).toFixed(1)} s after the cable was pulled, and got seat ${g3.page.id} back`);
  await until(() => hostPage.meta.players.some(p => p.name === 'Erin'), 5000);
  const after = hostPage.meta.players.find(p => p.name === 'Erin');
  check(after?.color === was.color && room.players.get(was.id)?.walkie === true, `same color (${after?.color}) and still holding the walkie`);

  // ---- a friend's game dies: Steam says so, the seat is kept ----
  const gusId = g5.page.id;
  g5.steam.__fake.close();
  g5.page.close();
  await until(() => !hostPage.meta.players.some(p => p.name === 'Gus'), 5000);
  check(room.players.get(gusId) && !room.players.get(gusId).connected, 'a guest whose game died has their seat kept (the lobby said "Disconnected")');

  // ---- proximity voice through Steam: only those in earshot, or on the walkie ----
  {
    const near = g2.page, far = g4.page, talker = hostPage;
    for (const p of [near, far, talker]) p.send({ t: 'voice', on: true });
    const hp = room.players.get(talker.id).pos;
    near.poseFn = () => ({ x: hp.x + 3, y: hp.y, z: hp.z });
    far.poseFn = () => ({ x: hp.x + 200, y: hp.y, z: hp.z });
    await sleep(500);
    const n0 = near.voiceIn.length, f0 = far.voiceIn.length;
    const frame = (seq, walkie) => { const b = Buffer.alloc(64, 7); b[0] = 1; b[1] = walkie ? 1 : 0; b.writeUInt16LE(seq, 2); return b; };
    for (let i = 0; i < 25; i++) { talker.ws.send(frame(i, false)); await sleep(20); }
    await sleep(500);
    const gotNear = near.voiceIn.length - n0, gotFar = far.voiceIn.length - f0;
    check(gotNear >= 22 && gotFar === 0 && near.voiceIn.at(-1)?.[0] === 2 && near.voiceIn.at(-1)?.[1] === talker.id, `voice: 3 m away got ${gotNear}/25 frames (tagged with the speaker), 200 m away got ${gotFar}`);
    room.players.get(talker.id).walkie = true; room.players.get(far.id).walkie = true;
    const f1 = far.voiceIn.length;
    for (let i = 0; i < 10; i++) { talker.ws.send(frame(100 + i, true)); await sleep(20); }
    await sleep(500);
    check(far.voiceIn.length - f1 >= 8, `walkie to walkie: 200 m away got ${far.voiceIn.length - f1}/10 frames`);
    // and the other way: a Steam guest talking reaches the host's page
    const h0 = hostPage.voiceIn.length;
    near.poseFn = null; near.pos = { ...hp, x: hp.x + 2 };
    await sleep(300);
    for (let i = 0; i < 10; i++) { near.ws.send(frame(200 + i, false)); await sleep(20); }
    await sleep(500);
    check(hostPage.voiceIn.length - h0 >= 8, `a guest's voice reaches the host (${hostPage.voiceIn.length - h0}/10 frames)`);
  }

  // ---- a lossy, laggy link still plays ----
  {
    const g = await guest(H, 12, 'Lossy', { netem: { lat: 60, jit: 20, loss: 0.05 } });
    const e = g.page ? await g.page.join(g.joined.code).catch(e => e) : g.err;
    if (e?.t !== 'welcome') fail(`the lossy guest couldn't join: ${e?.msg || e?.message || e?.code}`);
    else {
      g.page.startPoses();
      await sleep(4000);
      const r = g.page.snapRate(3000);
      check(r > 13 && g.page.tmBackwards === 0, `at 5% loss and 60 ms lag a guest still gets ${r.toFixed(1)} snapshots a second, in order (fragments: ${JSON.stringify(g.br.asm.stats)})`);
      g.page.close(); g.br.close();
    }
  }

  // ---- the host ends the trip: every guest is told why ----
  const goneT = performance.now();
  sh.close('Hosty ended the trip.');
  gh.endRooms('Hosty ended the trip.');
  await until(() => g2.page.over && g4.page.over, 6000);
  check(g2.page.over?.code === 4000 && g2.page.over?.msg === 'Hosty ended the trip.' && g4.page.over?.code === 4000,
    `the guests' pages closed with 4000 and "${g2.page.over?.msg}" ${(g2.page.over?.at - goneT).toFixed(0)} ms after the host ended the trip`);
} catch (e) {
  fail('exception: ' + (e.stack || e));
}

// ---- the host's game crashes (no BYE): the guests hear it from Steam's lobby ----
try {
  const H = await hostTrip(21, 'Crashy', 55);
  const g = await guest(H, 22, 'Kim');
  await g.page.join(g.joined.code);
  await g.page.waitFor('s');
  const t0 = performance.now();
  H.steam.__fake.close();             // the host's game process is gone
  H.sh.net.stop(); H.gh.stop();
  await until(() => g.page.over, 8000);
  check(g.page.over?.code === 4000 && /left the game/.test(g.page.over?.msg || ''), `the host's game died: the guest was told "${g.page.over?.msg}" ${(g.page.over?.at - t0).toFixed(0)} ms later`);
} catch (e) {
  fail('exception (host crash): ' + (e.stack || e));
}

// ---- the host drops off the network but stays in the lobby: retries, then a clear end ----
try {
  const H = await hostTrip(31, 'Ghost', 56);
  const g = await guest(H, 32, 'Lou', { timeoutMs: 3000, reconnectSecs: 8 });
  await g.page.join(g.joined.code);
  await g.page.waitFor('s');
  const t1 = performance.now();
  await H.steam.__fake.control({ op: 'partition', ms: 60000 });
  await until(() => g.page.over, 25000);
  check(g.page.over?.code === 'gave-up' && g.page.closes[0]?.code === 4005, `the host went unreachable: the page reconnected for its window, then gave up ${((g.page.over?.at - t1) / 1000).toFixed(1)} s in (3 s silence + 8 s of retries)`);
} catch (e) {
  fail('exception (host unreachable): ' + (e.stack || e));
}

// ---- a friend types the trip code: the lobby search (lobbysearch.cjs) ----
try {
  const H = await hostTrip(41, 'Coder', 57, { region: 2 });
  const code = H.page.code;
  const off = k => String(1000 + ((Number(code) - 1000 + k) % 9000));     // other codes, near this one
  check(be.lobbies.get(String(H.lobby.id))?.type === 2 && /^[1-9]\d{3}$/.test(code) && H.lobby.getData('nmd_code') === code,
    `code join: the host's lobby is Public (searches list it) and carries trip code ${code} as nmd_code`);
  // other people's lobbies: 55 trips nearer the friend than the host is (an unfiltered search stops at 50),
  // and another game on the shared test app that happens to use 'code' too
  const crowd = await steamFor(42, 'Crowd', null, 1), other = await steamFor(43, 'OtherGame', null, 1);
  cleanup.push(() => { crowd.__fake.close(); other.__fake.close(); });
  for (let i = 1; i <= 55; i++) (await crowd.matchmaking.createLobby(2, 4)).mergeFullData({ nmd_code: off(i) });
  (await other.matchmaking.createLobby(2, 4)).mergeFullData({ code });
  await sleep(200);

  const g = await guestByCode(44, 'Faraway', code, { region: 1 });
  const ask = be.lists.find(x => x.by === String(SID(44)))?.filters;
  check(g.found?.ok && g.found.lobbyId === String(H.lobby.id) && g.joined?.hostName === 'Coder',
    `code join: a friend a region away typed ${code} and found the host's lobby past 56 others (${g.found?.hostName || g.found?.msg})`);
  check(ask?.distance === 3 && ask.count === 10 && ask.strings?.length === 1 && ask.strings[0].key === 'nmd_code' && ask.strings[0].value === code && ask.strings[0].cmp === 0,
    `code join: the search asked Steam for nmd_code = ${code}, worldwide, 10 at most (${JSON.stringify(ask)})`);
  const w = g.page ? await g.page.join(g.joined.code).catch(e => e) : null;
  await until(() => H.page.meta?.players.some(p => p.name === 'Faraway'), 8000);
  check(w?.t === 'welcome' && w.code === code && H.page.meta?.players.some(p => p.name === 'Faraway'), 'code join: and they play: welcome, and the host\'s roster has them');
  const blind = await findTripByCode(g.steam, null, code, { me: String(SID(44)), retryMs: 50, log });
  check(!blind.ok, 'code join: without the filters (Steam\'s default: 50 lobbies, nearby) the same search misses it, which is why the build sets them');

  const nobody = off(4500);
  const t = await guestByCode(45, 'Typo', nobody, { region: 2 });
  check(!t.found.ok && t.found.code === 'noroom' && /No trip with code/.test(t.found.msg) && !H.lobby.getMembers().some(m => m.steamId64 === SID(45)),
    `code join: a code no trip has: "${t.found.msg}" (no lobby joined)`);
  const self = await findTripByCode(H.steam, H.steam.lobbyFilters, code, { me: String(SID(41)), build: BUILD, retryMs: 50, log });
  check(!self.ok && self.code === 'self', `code join: the host typing their own code: "${self.msg}"`);
  const v = await guestByCode(46, 'OldCode', code, { region: 2, build: '0.5.9+deadbeef00' });
  check(v.found?.ok && v.err?.code === 'version' && /Version mismatch/.test(v.err.message), `code join: a friend on another version finds the trip and is told: "${v.err?.message}"`);

  // two trips on one code (the host checks first, but two can draw it at once): this version's, the newest
  const H2 = await hostTrip(50, 'Twin', 59, { region: 0 });
  H2.sh.setCode(code);
  await sleep(150);
  const both = await findTripByCode(g.steam, g.steam.lobbyFilters, code, { me: String(SID(44)), build: BUILD, retryMs: 50, log });
  H2.sh.lobby.mergeFullData({ build: '0.5.9+deadbeef00' });
  await sleep(150);
  const sameBuild = await findTripByCode(g.steam, g.steam.lobbyFilters, code, { me: String(SID(44)), build: BUILD, retryMs: 50, log });
  check(both.ok && both.matches === 2 && both.lobbyId === String(H2.lobby.id) && sameBuild.lobbyId === String(H.lobby.id),
    'code join: two trips on one code: the newest wins, unless only the older one runs this version');
  const picked = await pickFreeCode(H2.steam, H2.steam.lobbyFilters, (q => () => q.shift() ?? nobody)([code, nobody]), { log });
  check(picked === nobody, `code join: hosting passes over a code another trip carries (${code} -> ${picked})`);

  // a full trip doesn't show up (Steam leaves full lobbies out of searches)
  const H3 = await hostTrip(51, 'Small', 60, { maxMembers: 2 });
  const a = await guestByCode(52, 'First', H3.page.code);
  const b = await guestByCode(53, 'Second', H3.page.code);
  check(a.found?.ok && !b.found.ok && /full trip doesn't show up/.test(b.found.msg), `code join: a full trip isn't listed, and the message says it may be full: "${b.found.msg}"`);
  H3.sh.close('bye');
  await sleep(500);
  const ended = await findTripByCode(g.steam, g.steam.lobbyFilters, H3.page.code, { me: String(SID(44)), retryMs: 50, log });
  check(!ended.ok && ended.code === 'noroom', 'code join: a trip that ended can\'t be found by its code');

  // Steam failing, or never answering: an error, never a hang, and the next search still works
  await H.steam.__fake.control({ op: 'search', search: { fail: true } });
  const e1 = await findTripByCode(g.steam, g.steam.lobbyFilters, code, { retryMs: 50, log }).then(() => null, e => e);
  await H.steam.__fake.control({ op: 'search', search: { fail: false, hang: true } });
  const t0 = performance.now();
  const e2 = await findTripByCode(g.steam, g.steam.lobbyFilters, code, { retryMs: 50, timeoutMs: 800, log }).then(() => null, e => e);
  const waited = performance.now() - t0;
  await H.steam.__fake.control({ op: 'search', search: { hang: false } });
  const again = await findTripByCode(g.steam, g.steam.lobbyFilters, code, { me: String(SID(44)), build: BUILD, retryMs: 50, log });
  check(/IOFailure/.test(e1?.message || '') && e2?.code === 'search' && waited < 2000 && again.ok,
    `code join: Steam failing ("${e1?.message}") or silent (gave up after ${waited.toFixed(0)} ms: "${e2?.message}"), then the next search works`);
} catch (e) {
  fail('exception (code join): ' + (e.stack || e));
}
// the real build's filters: koffi loads the Steam library steamworks.js ships and finds Steam's flat-API
// lobby-list functions; before Steam is up the interface is null and the wrapper refuses (no crash)
if (process.platform === 'linux' || process.platform === 'win32') {
  try {
    const f = ffiFilters();
    let refused = null;
    try { f.stringFilter('nmd_code', '1234'); } catch (e) { refused = e.message; }
    check(f && typeof f.distanceFilter === 'function' && /not ready/.test(refused || ''), `the FFI lobby filters bind to the bundled Steam library, and refuse before Steam starts ("${refused}")`);
  } catch (e) { fail('FFI filters: ' + (e.stack || e)); }
}

for (const f of cleanup) { try { f(); } catch {} }
console.log(`fake Steam traffic: ${JSON.stringify(be.stats)}`);
console.log(failed ? '\nSTEAM NETWORK TEST FAILED' : '\nSTEAM NETWORK TEST PASSED');
setTimeout(() => process.exit(failed ? 1 : 0), 300);
