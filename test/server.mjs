// Server robustness: what keeps a crew's evening going when connections misbehave. Part runs the room
// rules in process (Room + Sim with fake connections), part talks real WebSockets to a spawned server
// (FRIENDSLOP_TEST + FAST): bad frames, kept seats, the build check, flooding, dead connections,
// snapshots that wait for a client's world build, and the goodbye when the server shuts down.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- in process: the room rules -------------------------------------------------------------------------
await initPhysics();
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  last(t) { return [...this.sent].reverse().find(m => m.t === t); }
  has(pred) { return this.sent.some(pred); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * C.SIM_HZ); i++) room.tick(1 / C.SIM_HZ); };
{
  const room = new Room('TEST', 4242);
  const ca = new FakeConn(), cb = new FakeConn();
  const A = room.addPlayer(ca, 'Hosty').player, B = room.addPlayer(cb, 'Beans').player;
  A.key = 'tok:a'; B.key = 'tok:b';
  room.welcome(A); room.welcome(B);
  check(A.slot === 0 && B.slot === 1, `rooms: spawn slots in join order (${A.slot}, ${B.slot})`);

  // a drop keeps the seat; the body leaves the world; the crew is told
  B.walkie = true;
  room.hold(B, 0.5);
  const meta = ca.last('meta');
  check(!B.connected && B.pos === null && room.players.has(B.id) && meta.players.length === 1 && ca.has(m => m.t === 'toast' && /Beans lost connection/.test(m.text)),
    'rooms: a dropped player keeps their seat, leaves the world and the roster, and the crew hears about it');
  const cb2 = new FakeConn();
  const back = room.resume('tok:b', cb2);
  room.welcome(back);
  check(back === B && B.connected && B.walkie && B.color === room.players.get(B.id).color && ca.last('meta').players.length === 2,
    'rooms: coming back with the token gives the same seat, color and walkie');
  // a kept seat that nobody comes back for is freed
  room.hold(B, 0.2);
  tick(room, 0.4);
  check(!room.players.has(B.id) && ca.has(m => m.t === 'toast' && /didn't make it back/.test(m.text)) && !room.closed,
    'rooms: a kept seat expires, the crew hears about it, the room stays open');
  const C2 = room.addPlayer(new FakeConn(), 'Cid').player;
  check(C2.slot === 1, `rooms: a newcomer takes the lowest free spawn slot (${C2.slot})`);

  // a full room: a seat kept for someone who dropped gives way to a newcomer; otherwise 'full'
  for (let i = 0; room.players.size < C.MAX_PLAYERS; i++) room.addPlayer(new FakeConn(), 'P' + i);
  const victim = [...room.players.values()].find(p => p.name === 'P0');
  room.hold(victim, 60);
  const late = room.addPlayer(new FakeConn(), 'Late');
  const full = room.addPlayer(new FakeConn(), 'TooLate');
  check(late.player && !room.players.has(victim.id) && full.error && full.code === 'full', 'rooms: a newcomer bumps a kept seat when the RV is full, and is told it\'s full when none is kept');

  // a driver who stops sending: the RV must not keep his last throttle
  A.seat = 0;
  room.handle(A, { t: 'drv', th: 1, st: 0.5, hb: 0 });
  tick(room, 0.1);
  const pressed = room.sim.drive.th;
  tick(room, 0.5);
  check(pressed === 1 && room.sim.drive.th === 0, `rooms: a silent driver's throttle lets go after 0.3 s (${pressed} -> ${room.sim.drive.th})`);

  // client numbers that would poison the physics: Infinity / huge in push and throw
  const rp = room.sim.rv.translation();
  room.sim.push(A.id, { kind: 'rv', pt: [rp.x, rp.y, rp.z], dir: [Infinity, 0, 1e300] }, { pos: { x: rp.x, y: rp.y - 0.9, z: rp.z } });
  tick(room, 0.3);
  const lv = room.sim.rv.linvel();
  check(Number.isFinite(lv.x + lv.y + lv.z), 'sim: an Infinity in a push leaves the RV\'s motion finite');
  room.onPose(A, { x: 1e999, y: NaN, z: '5', v: [1e300, 0, 0], yaw: Infinity });
  check(Number.isFinite(A.raw.x + A.raw.y + A.raw.z + A.vel.x + A.yaw) && A.vel.x === 60, 'rooms: poses are clamped to finite, sane numbers');

  // flooding: emotes and pings at most 4 a second each
  const before = ca.sent.filter(m => m.t === 'emote').length;
  for (let i = 0; i < 200; i++) room.handle(A, { t: 'emote', e: C.EMOTES[0] });
  check(ca.sent.filter(m => m.t === 'emote').length - before === 1, 'rooms: 200 emotes in one tick go out once');
}
{
  // voice chat's signalling comes in a burst (an offer and a dozen ICE candidates at once): all of it
  // gets through, while a flood of big messages is capped
  const room = new Room('RTC', 4242);
  const A = room.addPlayer(new FakeConn(), 'Ann').player, D = room.addPlayer(new FakeConn(), 'Dee').player;
  const rtcTo = c => c.sent.filter(m => m.t === 'rtc').length;
  const r0 = rtcTo(D.conn);
  room.handle(A, { t: 'rtc', to: D.id, data: { sdp: 'v=0 '.repeat(1000) } });
  for (let i = 0; i < 14; i++) room.handle(A, { t: 'rtc', to: D.id, data: { cand: 'candidate:1 1 udp 2122260223 192.168.1.20 5' + i + ' typ host' } });
  check(rtcTo(D.conn) - r0 === 15, `rooms: an offer and 14 ICE candidates in one tick all reach the other player (${rtcTo(D.conn) - r0}/15)`);
  const r1 = rtcTo(D.conn);
  for (let i = 0; i < 200; i++) room.handle(A, { t: 'rtc', to: D.id, data: 'x'.repeat(15000) });
  check(rtcTo(D.conn) - r1 <= 7, `rooms: 200 big signalling messages at once are capped (${rtcTo(D.conn) - r1} relayed)`);
  // state is never dropped as spam: voice on and off in one tick ends off
  room.handle(A, { t: 'voice', on: true }); room.handle(A, { t: 'voice', on: false });
  check(A.voice === false, 'rooms: voice on then off in the same tick leaves the mic off');
}
{
  // bedtime: half the crew in a bunk starts a countdown; the rest can't hold everyone at the campfire
  const room = new Room('BEDS', 4242);
  const conns = [new FakeConn(), new FakeConn(), new FakeConn()];
  const P = conns.map((c, i) => room.addPlayer(c, ['A', 'B', 'C'][i]).player);
  room.paid = true;
  room.beginNight();
  P[0].bed = true; P[1].bed = true;
  tick(room, C.NIGHT_MIN_SEC + 0.2);
  check(room.day === 1 && conns[0].has(m => m.t === 'toast' && /still up/.test(m.text)), 'rooms: two of three in a bunk starts the dawn countdown');
  // a late joiner during the night gets the receipt everyone else is looking at
  const lc = new FakeConn();
  const L = room.addPlayer(lc, 'Late').player;
  room.welcome(L);
  check(lc.has(m => m.t === 'receipt' && m.day === 1), 'rooms: joining at night shows the night\'s receipt');
  tick(room, 46);
  check(room.day === 2, `rooms: after 45 s the RV leaves at dawn anyway (day ${room.day})`);
}

// ---- over the wire --------------------------------------------------------------------------------------
const PORT = 4700 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1', FRIENDSLOP_FAST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverExit = null, serverErr = '';
server.on('exit', code => { serverExit = code; });
server.stderr.on('data', d => { serverErr += d; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('server did not start')), 8000); });

class Bot {
  constructor(name) { this.name = name; this.q = []; this.waiters = []; this.snaps = 0; this.closeCode = null; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('close', code => { this.closeCode = code; });
      this.ws.on('message', d => {
        let m; try { m = JSON.parse(d); } catch { return; }
        if (m.t === 's') { this.snaps++; return; }
        if (m.t === 'welcome') this.id = m.id;
        if (m.t === 'session') this.token = m.resume;
        const w = this.waiters.find(w => w.pred(m));
        if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); } else this.q.push(m);
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 6000, label = '') {
    const hit = this.q.find(pred);
    if (hit) { this.q.splice(this.q.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`${this.name} timed out waiting for ${label}`)); } }, ms);
    });
  }
  count(pred) { return this.q.filter(pred).length; }
}

try {
  const A = new Bot('Hosty');
  await A.connect();
  A.send({ t: 'create', name: A.name, seed: 4242 });
  const wA = await A.wait(m => m.t === 'welcome', 8000, 'welcome');
  await A.wait(m => m.t === 'session', 3000, 'session');
  check(/^[0-9a-f]{24}$/.test(A.token || ''), 'host: a ws client gets a resume token');

  // one malformed frame from anyone must never take the server (and every room) down
  const alive = async label => {
    await sleep(400);
    const n0 = A.snaps;
    await sleep(500);
    const probe = new Bot('Probe');
    await probe.connect();
    probe.send({ t: 'create', name: 'Probe' });
    const w = await probe.wait(m => m.t === 'welcome', 6000, 'probe welcome').catch(() => null);
    probe.ws.close();
    check(serverExit === null && A.snaps > n0 && !!w, `host: survives ${label} (server up, the existing room still gets snapshots, a new room opens)`);
  };
  const raw = async bytes => { const b = new Bot('Bad'); await b.connect(); b.ws._socket.write(Buffer.from(bytes)); };
  { const b = new Bot('Big'); await b.connect(); b.ws.send('x'.repeat(70 * 1024)); }
  await alive('an oversize frame');
  await raw([0x81, 0x82, 0, 0, 0, 0, 0xc3, 0x28]);            // a masked text frame with invalid UTF-8
  await alive('invalid UTF-8');
  await raw([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe7]);            // a close frame with status 999
  await alive('a bad close code');

  // the build check: two copies must run exactly the same code
  const V = new Bot('Old');
  await V.connect();
  V.send({ t: 'join', name: 'Old', room: wA.code, build: '0.0.1+deadbeef00' });
  const ver = await V.wait(m => m.t === 'error', 4000, 'version error');
  check(ver.code === 'version' && /Version mismatch/.test(ver.msg), 'host: a join from a different build is refused with a clear message');
  V.ws.close();

  // a guest drops and comes back with the token: same seat; the host hears both
  const B = new Bot('Beans');
  await B.connect();
  B.send({ t: 'join', name: B.name, room: wA.code });
  await B.wait(m => m.t === 'welcome', 6000, 'B welcome');
  await B.wait(m => m.t === 'session', 3000, 'B session');
  const idB = B.id, tok = B.token;
  B.ws.terminate();
  await A.wait(m => m.t === 'toast' && /Beans lost connection/.test(m.text), 4000, 'lost toast');
  const B2 = new Bot('Beans');
  await B2.connect();
  B2.send({ t: 'join', name: 'Beans', room: wA.code, resume: tok });
  const wb = await B2.wait(m => m.t === 'welcome', 6000, 'B2 welcome');
  await A.wait(m => m.t === 'toast' && /Beans is back/.test(m.text), 4000, 'back toast');
  check(wb.id === idB, `host: a token rejoin gets the same seat back (id ${idB} -> ${wb.id})`);

  // snapshots wait for a client that says it's still building its world
  const R = new Bot('Ready');
  await R.connect();
  R.send({ t: 'join', name: 'Ready', room: wA.code, rdy: 1 });
  await R.wait(m => m.t === 'welcome', 6000, 'R welcome');
  await sleep(800);
  const early = R.snaps;
  R.send({ t: 'ready' });
  await sleep(600);
  check(early === 0 && R.snaps > 3, `host: no snapshots before 'ready', then they flow (${early} -> ${R.snaps})`);

  // flooding: 1000 pings in a burst reach the crew a handful of times, not 1000
  for (let i = 0; i < 1000; i++) B2.send({ t: 'ping', pt: [1, 2, 3] });
  await sleep(1200);
  const pings = A.count(m => m.t === 'ping');
  check(pings >= 1 && pings <= 8, `host: a burst of 1000 pings reaches the others ${pings} time(s)`);

  // a connection that goes silent (frozen machine, pulled cable) is dropped and its seat kept
  R.ws._socket.pause();
  await A.wait(m => m.t === 'toast' && /Ready lost connection/.test(m.text), 25000, 'silent drop');
  ok('host: a connection that stops answering is dropped within the heartbeat window');

  // shutting down: every page hears why, and the socket closes with 4000 (not a silent vanish)
  server.kill('SIGTERM');
  const bye = await A.wait(m => m.t === 'hostleft', 3000, 'hostleft').catch(() => null);
  await sleep(400);
  check(!!bye && A.closeCode === 4000, `host: shutting down tells every page and closes with 4000 (code ${A.closeCode})`);
} catch (e) {
  fail(e.message);
  if (serverErr) console.error(serverErr.slice(-2000));
}

console.log(failed ? '\n💥 SERVER TESTS FAILED' : '\n🎉 ALL SERVER TESTS PASSED');
process.exit(failed ? 1 : 0);
