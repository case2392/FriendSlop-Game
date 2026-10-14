// Server robustness: what keeps a crew's evening going when connections misbehave. Part runs the room
// rules in process (Room + Sim with fake connections), part talks real WebSockets to a spawned server
// (FRIENDSLOP_TEST + FAST): bad frames, kept seats, the build check, flooding, dead connections,
// snapshots that wait for a client's world build, and the goodbye when the server shuts down.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';   // (the wildlife has its own suite: test/mobs.mjs)
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
// a blackjack hand dealt for `stake` and still being voted on (a natural settles at once: deal again); the
// stake comes out of the bank as at the table. What the hand pays back once it's played out as a stand:
const dealHand = (room, stake) => {
  const bj = room.bj;
  do { bj.state = 'bet'; bj.hand = null; bj.bet = stake; bj.deal(room.t, 1e9); } while (bj.state !== 'vote');
  room.bank -= stake;
  return bj;
};
const paidBack = bj => ({ natural: Math.floor(bj.stake * 2.5), win: bj.stake * 2, push: bj.stake, lose: 0 })[bj.outcome];
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
  B.voice = true;
  const cb2 = new FakeConn();
  const back = room.resume('tok:b', cb2);
  room.welcome(back);
  check(back === B && B.connected && B.walkie && !B.voice && B.color === room.players.get(B.id).color && ca.last('meta').players.length === 2,
    'rooms: coming back with the token gives the same seat, color and walkie (out of voice till the page says it\'s in: a reload isn\'t)');
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
  tick(room, 0.6);
  const still = room.sim.drive.th;
  tick(room, 0.6);
  check(pressed === 1 && still === 1 && room.sim.drive.th === 0, `rooms: a silent driver keeps the throttle through a slow frame (0.7 s) and loses it after 1 s (${pressed} -> ${still} -> ${room.sim.drive.th})`);

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
  // voice goes only through the host's proximity relay (host.js relayVoice): the old peer-to-peer signalling
  // messages are not passed on to anyone, so a modified page can't carry voice past earshot that way
  const room = new Room('RTC', 4242);
  const A = room.addPlayer(new FakeConn(), 'Ann').player, D = room.addPlayer(new FakeConn(), 'Dee').player;
  for (let i = 0; i < 5; i++) room.handle(A, { t: 'rtc', to: D.id, data: { sdp: 'v=0 '.repeat(100) } });
  check(!D.conn.sent.some(m => m.t === 'rtc'), 'rooms: peer-to-peer signalling messages go nowhere (voice is relayed only within earshot)');
  // state is never dropped as spam: voice on and off in one tick ends off
  room.handle(A, { t: 'voice', on: true }); room.handle(A, { t: 'voice', on: false });
  check(A.voice === false, 'rooms: voice on then off in the same tick leaves the mic off');
}
{
  // a parked RV drives off again: it used to fall asleep, read ~0.6 m/s at a standstill, and brake
  // forever ('rolling backwards: brake first'). Parked on a -3% downhill with 56 kg of loot up front,
  // handbrake 3 s, then full throttle; and on the flat, stopped 3 s, then reverse
  const { toWorld } = await import('../shared/rv.js');
  const room = new Room('PARK', 4242);
  const c = new FakeConn(), D = room.addPlayer(c, 'Driver').player;
  room.welcome(D);
  const W = room.W, sim = room.sim;
  for (const g of W.gates) sim.openGate(g.id);
  const drive = (th, hb, secs) => { for (let i = 0; i < Math.round(secs * C.SIM_HZ); i++) { room.handle(D, { t: 'drv', th, st: 0, hb }); room.tick(1 / C.SIM_HZ); } };
  const z0 = 702;
  sim.placeRV(W.roadX(z0), z0, Math.atan2(W.roadX(z0 + 8) - W.roadX(z0), 8));
  room.phase = 'road';
  tick(room, 1);
  const r0 = sim.rvPose();
  for (let i = 0; i < 4; i++) sim.addProp('suitcase', toWorld(r0.p, r0.q, { x: -0.3 + (i % 2) * 0.6, y: 0.3, z: 1.2 + Math.floor(i / 2) * 0.5 }), r0.q, 600, 600);
  room.onPose(D, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  room.handle(D, { t: 'use', kind: 'seat0' });
  drive(0, 1, 3);
  const zA = sim.rv.translation().z;
  drive(1, 0, 6);
  const fwd = sim.rv.translation().z - zA;
  drive(0, 1, 4);
  const zB = sim.rv.translation().z;
  drive(-1, 0, 5);
  const back = zB - sim.rv.translation().z;
  check(D.seat === 0 && fwd > 5 && back > 2, `sim: a parked RV drives off (${fwd.toFixed(1)} m in 6 s, downhill with loot) and reverses after a stop (${back.toFixed(1)} m in 5 s)`);
  room.sim.free?.();
}
{
  // nightfall and dawn: loot left on Ed's counter is sold at midnight, the RV comes to the lot by the
  // fire, a knocked-out player comes round free, a hand still being voted on is played out at dawn (as a
  // stand), and a driver still in the seat is told they aren't any more
  const room = new Room('NIGHT', 4242);
  const ca = new FakeConn(), cb = new FakeConn();
  const A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(cb, 'Bob').player;
  room.welcome(A); room.welcome(B);
  room.phase = 'road';
  const T = room.W.town;
  room.sim.addProp('vase', { x: T.pawn.x, y: T.pawn.y + 0.5, z: T.pawn.z }, { x: 0, y: 0, z: 0, w: 1 }, 700, 700);
  tick(room, 0.5);
  B.ko = true; B.koAt = room.t;
  room.bank = 900; room.due = 1500;
  const bank0 = room.bank;
  room.midnight();
  const rv = room.sim.rv.translation();
  const sold = room.dayStats.sold;
  check(sold > 600 && room.paid && room.bank === bank0 + sold - 1500, `rooms: loot left on the pawn counter is sold at midnight (+$${sold}, and the payment made: bank $${room.bank})`);
  check(Math.hypot(rv.x - T.lot.x, rv.z - T.lot.z) < 1 && Math.hypot(T.lot.x - T.fire.x, T.lot.z - T.fire.z) < 25, `rooms: at night the RV is at the lot, ${Math.hypot(T.lot.x - T.fire.x, T.lot.z - T.fire.z).toFixed(0)} m from the crew's fire`);
  check(!B.ko && cb.has(m => m.t === 'revived') && room.bank === bank0 + sold - 1500, 'rooms: knocked out at nightfall, you come round at the fire with no bill');
  A.seat = 0;
  const table = dealHand(room, 400);
  const b1 = room.bank;
  room.nextDay();
  check(table.state === 'result' && room.bank === b1 + paidBack(table) && A.seat === null && ca.has(m => m.t === 'seat' && m.seat === null),
    `rooms: at dawn a hand mid-vote is played out as a stand (${table.outcome}: +$${room.bank - b1}) and the driver is told the seat is free`);
  // bungee cords stay on overnight
  const { toWorld } = await import('../shared/rv.js');
  const r = room.sim.rvPose();
  room.sim.addProp('vase', toWorld(r.p, r.q, { x: 0, y: 0.3, z: -1.5 }), r.q, 500, 500);
  tick(room, 0.5);
  const n = room.sim.tieDown();
  room.nextDay();
  check(n === 1 && room.sim.tied.size === 1, `sim: what was bungee'd in the RV is still tied down the next day (${n} tied, ${room.sim.tied.size} next day)`);
}
{
  // the crash buttes' fallen blocks are solid: every one of world gen's rocks builds a convex hull, the
  // same points every time (the server and each client build their own), and a block stops a ray
  const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
  const { generateLeg } = await import('../shared/world.js');
  let n = 0, bad = 0, same = true, hit = 0, tried = 0;
  for (const seed of [777, 1234, 4242]) for (let day = 1; day <= 5; day++) {
    const W = generateLeg(seed, day), W2 = generateLeg(seed, day);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    W.hulls.forEach((h, i) => {
      n++;
      const d = RAPIER.ColliderDesc.convexHull(h.pts);
      if (!d) { bad++; return; }
      world.createCollider(d.setTranslation(h.x, h.y, h.z));
      const o = W2.hulls[i];
      if (!o || o.x !== h.x || o.z !== h.z || o.pts.length !== h.pts.length || o.pts.some((v, k) => v !== h.pts[k])) same = false;
    });
    world.step();
    for (const h of W.hulls.slice(0, 4)) {
      tried++;
      const ray = new RAPIER.Ray({ x: h.x, y: h.y + 20, z: h.z }, { x: 0, y: -1, z: 0 });
      if (world.castRay(ray, 40, true)) hit++;
    }
    world.free();
  }
  check(n > 100 && bad === 0 && same && hit === tried, `world: ${n} fallen blocks at the buttes all build solid hulls (${bad} failed), the same every time, and stop a ray (${hit}/${tried})`);
}
{
  // the door steps hang 7 cm off the road: beside a canyon wall they used to rest on the rising ground,
  // lift a wheel, and hold the RV there for good (forward and reverse)
  const room = new Room('SNAG', 777);
  const c = new FakeConn(), D = room.addPlayer(c, 'Driver').player;
  room.welcome(D);
  room.day = 1; room.nextDay();
  const W = room.W, sim = room.sim;
  for (const p of [...sim.props.values()]) if (p.type === 'boulder') sim.removeProp(p.id);
  sim.placeRV(W.roadX(480.2) - 4.69, 480.2, 0);
  room.phase = 'road';
  tick(room, 1);
  room.onPose(D, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  room.handle(D, { t: 'use', kind: 'seat0' });
  const z0 = sim.rv.translation().z;
  for (let i = 0; i < 5 * C.SIM_HZ; i++) { room.handle(D, { t: 'drv', th: 0.6, st: 0.25, hb: 0 }); room.tick(1 / C.SIM_HZ); }
  const moved = sim.rv.translation().z - z0;
  check(D.seat === 0 && moved > 5, `sim: an RV with its door steps over the ground by a canyon wall drives on (${moved.toFixed(1)} m in 5 s)`);
}
{
  // the Rockfall: two friends shove the boulder aside; one alone can't (that's the RV's bumper or the winch).
  // It used to take four (2000 kg at friction 0.85).
  const shove = n => {
    const room = new Room('ROCK', 4242);
    const P = Array.from({ length: n }, (_, i) => { const p = room.addPlayer(new FakeConn(), 'R' + i).player; room.welcome(p); return p; });
    room.day = 1; room.nextDay();
    room.phase = 'road';
    const b = [...room.sim.props.values()].find(p => p.type === 'boulder'), W = room.W;
    tick(room, 1);
    const x0 = b.body.translation().x;
    for (let k = 0; k < 15 * C.SIM_HZ; k++) {
      const t = b.body.translation();
      P.forEach((p, i) => {
        const px = t.x - 2.35, pz = t.z + (i - (n - 1) / 2) * 0.7, py = W.heightAt(px, pz);
        room.onPose(p, { par: 0, x: px, y: py, z: pz, yaw: Math.PI / 2, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
        if (k % 5 === 0) room.handle(p, { t: 'push', kind: 'prop', id: b.id, pt: [px + 0.34, py + 0.9, pz], dir: [1, 0, 0] });
      });
      room.tick(1 / C.SIM_HZ);
    }
    return b.body.translation().x - x0;
  };
  const one = shove(1), two = shove(2);
  check(one < 0.5 && two > 2, `sim: two shoving players move the boulder (${two.toFixed(1)} m in 15 s), one doesn't (${one.toFixed(2)} m)`);
}
{
  // loading heavy loot: two friends carry a safe, then the dino head, to the open door and in (the lead
  // backing up the steps, the other behind it). Hands lift it over the sill, turn it end-on and steer it
  // to the middle of the 1.3 m doorway; it used to jam against the floor's edge a metre up and fall out.
  const { toWorld, toLocal, RV_DIM } = await import('../shared/rv.js');
  const { LOOT } = await import('../shared/loot.js');
  const load = (type, yaw0) => {
    const room = new Room('LOAD', 4242);
    const [A, B] = ['Lead', 'Back'].map(n => { const p = room.addPlayer(new FakeConn(), n).player; room.welcome(p); return p; });
    const W = room.W, sim = room.sim, DZ = RV_DIM.DOOR_Z;
    sim.placeRV(W.roadX(100), 100, 0);
    room.phase = 'road';
    tick(room, 1);
    sim.setDoor(true);
    const R = () => sim.rvPose(), lw = l => toWorld(R().p, R().q, l);
    const at = lw({ x: -6, y: 0, z: DZ }), half = LOOT[type].shape[2];
    const pr = sim.addProp(type, { x: at.x, y: W.heightAt(at.x, at.z) + half + 0.05, z: at.z }, { x: 0, y: Math.sin(yaw0 / 2), z: 0, w: Math.cos(yaw0 / 2) }, 1000, 1000);
    tick(room, 1);
    const item = () => toLocal(R().p, R().q, pr.body.translation());
    // stand at local (x, y?, DZ) looking at the item
    const pose = (p, x, y) => {
      const w = lw({ x, y: y ?? 0, z: DZ }), it = pr.body.translation();
      room.onPose(p, { par: 0, x: w.x, y: y == null ? W.heightAt(w.x, w.z) : w.y, z: w.z, yaw: Math.atan2(it.x - w.x, it.z - w.z), pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
    };
    let lead = -4.6, back = -7.4, leadY = null;
    pose(A, lead, null); pose(B, back, null);
    const t0 = pr.body.translation();
    for (const p of [A, B]) room.handle(p, { t: 'grab', kind: 'prop', id: pr.id, pt: [t0.x, t0.y + 0.15, t0.z], d: 1.2 });
    for (const [x, y] of [[-2.4, null], [-1.64, -0.85], [-1.42, -0.42], [-0.9, 0], [-0.2, 0], [0.5, 0]]) {
      for (let k = 0; k < 90; k++) {
        lead += (x - lead) * 0.06; leadY = y;
        back = Math.min(back + 1.2 / C.SIM_HZ, Math.min(-2.2, lead - 2.4));
        pose(A, lead, leadY); pose(B, back, null);
        room.tick(1 / C.SIM_HZ);
      }
    }
    for (let k = 0; k < 120; k++) { back = Math.min(back + 1 / C.SIM_HZ, -1.9); pose(A, lead, leadY); pose(B, back, null); room.tick(1 / C.SIM_HZ); }
    for (const p of [A, B]) room.handle(p, { t: 'rel' });
    tick(room, 2);
    const l = item();
    return { inside: l.x > -1.1 && l.y > -0.1 && sim.props.has(pr.id), l };
  };
  const safe = load('safe', 0.4), dino = load('dino', 1.1);
  check(safe.inside && dino.inside, `sim: two friends load a safe and the dino head through the RV's door (safe at x ${safe.l.x.toFixed(2)}, dino at x ${dino.l.x.toFixed(2)}; inside is > -1.2)`);
}
{
  // Ed's loading zone: with the RV parked in front of his shop, the bell sells its whole load at DOCK_RATE
  // (and the counter at full price); parked anywhere else, only the counter
  const { toWorld } = await import('../shared/rv.js');
  const sell = atDock => {
    const room = new Room('DOCK', 4242);
    const c = new FakeConn(), A = room.addPlayer(c, 'Ann').player;
    room.welcome(A);
    room.phase = 'road'; room.inTown = true;
    const W = room.W, sim = room.sim, d = W.town.dock;
    if (atDock) sim.placeRV(d.x, d.z, 0); else sim.placeRV(d.x, d.z + 30, 0);
    tick(room, 1);
    const r = sim.rvPose();
    for (let i = 0; i < 3; i++) sim.addProp('suitcase', toWorld(r.p, r.q, { x: 0.3, y: 0.3, z: -1 + i * 0.6 }), r.q, 500, 500);
    sim.addProp('vase', { x: W.town.pawn.x, y: W.town.pawn.y + 0.4, z: W.town.pawn.z }, { x: 0, y: 0, z: 0, w: 1 }, 300, 300);
    tick(room, 1);
    const bell = W.uses.find(u => u.kind === 'pawnBell');
    room.onPose(A, { par: 0, x: bell.x + 1, y: bell.y - 1, z: bell.z, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
    const bank0 = room.bank;
    room.handle(A, { t: 'use', id: bell.id });
    return { got: room.bank - bank0, left: sim.cargo().length, offer: room.gameState().dock };
  };
  const at = sell(true), away = sell(false);
  check(at.got === 300 + 3 * Math.round(500 * C.DOCK_RATE) && at.left === 0 && away.got === 300 && away.left === 3,
    `rooms: in Ed's loading zone the bell sells the RV's load at ${C.DOCK_RATE * 100}% (+$${at.got}, ${at.left} left in the RV); parked down the street, only the counter (+$${away.got}, ${away.left} left)`);
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

// ---- in process: the road map and the day's roles ------------------------------------------------------
{
  // today Ann drives and Bob navigates: Bob takes the map only while Ann is at the wheel; Ann never can, seated
  // or not; Bob keeps it when Ann gets up or is knocked out; neither takes the other's job
  const room = new Room('MAP', 4242);
  const ca = new FakeConn(), cb = new FakeConn();
  const A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(cb, 'Bob').player;
  room.welcome(A); room.welcome(B);
  room.setRoles(A.id, B.id);
  tick(room, 0.5);
  const sim = room.sim, map = [...sim.props.values()].find(p => p.type === 'map');
  // standing in the cab (RV-local): Ann behind the driver's seat, Bob on the passenger side, both looking ahead and down
  const stand = (p, x, z) => room.onPose(p, { par: 1, x, y: 0.05, z, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
  const grab = p => { const t = map.body.translation(); room.handle(p, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 }); };
  const holds = p => sim.holds.get(p.id)?.id === map.id;
  const said = (c, re) => c.has(m => m.t === 'toast' && re.test(m.text));
  stand(A, 0.6, 2.4); stand(B, -0.4, 2.3);
  grab(B);
  check(!!map && cb.last('grabbed')?.ok === false && !holds(B) && said(cb, /Ann has to be at the wheel/), 'map: with nobody at the wheel the navigator can\'t take it yet, and is told why');
  room.handle(A, { t: 'use', kind: 'seat0' });
  grab(B);
  tick(room, 0.5);
  check(A.seat === 0 && cb.last('grabbed')?.ok === true && holds(B) && said(cb, /Bob, grab the map/), 'map: once the driver is at the wheel (and the navigator is called by name), the navigator takes it');
  const n0 = ca.sent.filter(m => m.t === 'grabbed').length;
  grab(A);
  check(!holds(A) && ca.sent.filter(m => m.t === 'grabbed').length === n0 && map.holders.size === 1, 'map: the driver can\'t take it from the seat');
  room.handle(A, { t: 'use', kind: 'unseat' });
  stand(A, 0.6, 2.4);
  tick(room, 0.3);
  grab(A);
  check(A.seat === null && holds(B) && ca.last('grabbed')?.ok === false && !holds(A) && said(ca, /You drive today: no peeking/), 'map: the driver gets up: the navigator keeps it, and the driver still can\'t take it');
  room.handle(B, { t: 'use', kind: 'seat0' });
  check(B.seat === null && holds(B) && said(cb, /Ann drives today/), 'roles: the navigator can\'t take the wheel (and is told who drives), and keeps the map');
  room.handle(A, { t: 'use', kind: 'seat0' });
  room.handle(A, { t: 'ko', why: 'fall' });
  tick(room, 0.3);
  check(holds(B) && A.seat === null, 'map: a knocked-out driver leaves the seat; the navigator keeps the map');
  // the driver toast calls the navigator only while nobody has the map out
  const n1 = ca.sent.length;
  room.handle(A, { t: 'wake' });
  stand(A, 0.6, 2.4);
  room.handle(A, { t: 'use', kind: 'seat0' });
  const t1 = ca.sent.slice(n1).find(m => m.t === 'toast' && /is driving/.test(m.text));
  check(A.seat === 0 && holds(B) && t1 && !/grab the map/.test(t1.text), `map: back at the wheel with the map already out, nobody is called to grab it ("${t1?.text}")`);
  room.sim.free?.();
}
{
  // alone (a host waiting for friends at camp, the clock stopped, is alone too): you drive, nobody navigates,
  // so nobody takes the map; and taking the wheel calls nobody to grab it
  const room = new Room('MAP1', 4242);
  const c = new FakeConn(), P = room.addPlayer(c, 'Solo').player;
  room.welcome(P);
  tick(room, 0.5);
  const map = [...room.sim.props.values()].find(p => p.type === 'map'), t = map.body.translation();
  room.onPose(P, { par: 1, x: -0.4, y: 0.05, z: 2.3, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
  room.handle(P, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 });
  check(room.roles.drv === P.id && !room.roles.nav && c.last('grabbed')?.ok === false && !room.sim.holds.has(P.id), 'map: alone on a trip you drive and nobody navigates: nobody takes the map');
  room.handle(P, { t: 'use', kind: 'seat0' });
  check(P.seat === 0 && !c.has(m => m.t === 'toast' && /grab the map/.test(m.text)), 'map: ... and taking the wheel alone calls nobody to grab it');
  room.sim.free?.();
}
{
  // the day's roles: drawn in camp among who's here (again when the crew changes), locked once the RV leaves
  // camp, handed on when a player leaves for good, drawn again each morning (whoever has done a job least first)
  const room = new Room('ROLES', 4242);
  const cs = [new FakeConn(), new FakeConn(), new FakeConn()];
  const said = (c, re) => c.has(m => m.t === 'toast' && re.test(m.text));
  const A = room.addPlayer(cs[0], 'Ann').player;
  room.welcome(A);
  check(room.roles.drv === A.id && !room.roles.nav, 'roles: alone in camp, you drive and nobody navigates');
  const B = room.addPlayer(cs[1], 'Bob').player;
  room.welcome(B);
  const two = new Set([room.roles.drv, room.roles.nav]);
  check(two.size === 2 && two.has(A.id) && two.has(B.id) && said(cs[0], /drives today, and .* reads the map\. Locked in once the RV leaves camp/), 'roles: a friend climbs aboard in camp: drawn again, one drives and one navigates, and everyone is told (locked once the RV leaves camp)');
  check(cs[1].last('meta')?.roles?.drv === room.roles.drv && cs[1].last('meta')?.roles?.nav === room.roles.nav, 'roles: the party gets them with the player list (meta)');
  // drawn at random: over many draws in camp both of them get to drive
  const drivers = new Set();
  for (let i = 0; i < 40; i++) { room.rolesCrew = ''; room.checkRoles(); drivers.add(room.roles.drv); }
  check(drivers.size === 2, 'roles: the draw is random (either of two can drive)');
  // out of camp: the roles are locked
  const W = room.W, sim = room.sim, z = W.camp.exitZ + 4;
  sim.placeRV(W.roadX(z), z, 0);
  tick(room, 0.2);
  const locked = { ...room.roles };
  const Cat = room.addPlayer(cs[2], 'Cat').player;
  room.welcome(Cat);
  check(room.phase === 'road' && room.roles.drv === locked.drv && room.roles.nav === locked.nav, 'roles: on the road they are locked: a newcomer is crew');
  check(room.jobs.get(locked.drv)?.drv === 1 && room.jobs.get(locked.nav)?.nav === 1, 'roles: leaving camp counts the day\'s driver and navigator (the draw leans on these counts)');
  // crew can't drive or read the map
  room.onPose(Cat, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  room.handle(Cat, { t: 'use', kind: 'seat0' });
  const map = [...sim.props.values()].find(p => p.type === 'map'), mt = map.body.translation();
  room.handle(Cat, { t: 'grab', kind: 'prop', id: map.id, pt: [mt.x, mt.y, mt.z], d: 1.2 });
  check(Cat.seat === null && said(cs[2], /drives today\. Ride along/) && cs[2].last('grabbed')?.ok === false && said(cs[2], /Only .* reads the map today/), 'roles: crew can\'t take the wheel or the map, and is told whose job it is');
  // the navigator leaves the trip: the crew member takes the map over
  const navWas = locked.nav, drvWas = locked.drv;
  room.removePlayer(navWas, 'left');
  check(room.roles.nav === Cat.id && room.roles.drv === drvWas && room.jobs.get(Cat.id)?.nav === 1, 'roles: the navigator leaves the trip: Cat (crew) reads the map now (and it counts as Cat\'s day)');
  // the next morning: drawn again between the two of them
  room.nextDay();
  check(room.phase === 'camp' && new Set([room.roles.drv, room.roles.nav, Cat.id, drvWas]).size === 2 && said(cs[2], /DAY 2/), `roles: drawn again in the morning (driver ${room.roles.drv}, navigator ${room.roles.nav})`);
  room.sim.free?.();
}
{
  // the morning draw is random, but whoever has driven less this trip is likelier to drive: after a day at the
  // wheel, a quarter as likely as someone who hasn't (1 / (1 + times)^2)
  const room = new Room('DRAW', 4242);
  const A = room.addPlayer(new FakeConn(), 'Ann').player, B = room.addPlayer(new FakeConn(), 'Bob').player;
  room.welcome(A); room.welcome(B);
  room.jobs.set(A.id, { drv: 1, nav: 0 });
  let bob = 0;
  for (let i = 0; i < 400; i++) { room.drawRoles(); if (room.roles.drv === B.id) bob++; }
  check(bob > 280 && bob < 360 && room.roles.nav && room.roles.nav !== room.roles.drv, `roles: the morning draw leans to whoever has driven less, but stays random (Bob, who hasn't driven, drew the wheel ${bob} times in 400, Ann ${400 - bob})`);
  room.sim.free?.();
}
{
  // the review's cases: a player back to an empty role fills it; in camp only a newcomer to a parked RV draws
  // again (nobody pulled off a moving wheel, nobody who has read today's map drawn to drive); hand-overs at
  // night count nobody's day and say nothing; a full RV's newcomer is told the roles once
  const said = (c, re) => c.has(m => m.t === 'toast' && re.test(m.text));
  {
    // at night Ann is in a bunk and Bob drops: morning comes at once and is drawn without him; back, he reads the map
    const room = new Room('BACK', 4242);
    const ca = new FakeConn(), cb = new FakeConn();
    const A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(cb, 'Bob').player;
    B.key = 'tok:b';
    room.welcome(A); room.welcome(B);
    A.bed = true;
    room.hold(B, 30);
    room.nextDay();
    const drawn = { ...room.roles };
    room.welcome(room.resume('tok:b', new FakeConn()));
    check(drawn.drv === A.id && !drawn.nav && room.roles.drv === A.id && room.roles.nav === B.id && said(ca, /Ann drives today, and Bob reads the map/), 'roles: a morning drawn while Bob was away leaves the map to nobody; back, he reads it (no draw again: Ann still drives)');
    room.sim.free?.();
  }
  {
    // in camp, Ann rolling out at the wheel when Cat climbs aboard: no draw again, Ann keeps the wheel
    const room = new Room('ROLL', 4242);
    const A = room.addPlayer(new FakeConn(), 'Ann').player, B = room.addPlayer(new FakeConn(), 'Bob').player;
    room.welcome(A); room.welcome(B);
    tick(room, 0.3);
    room.setRoles(A.id, B.id);
    room.onPose(A, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
    room.handle(A, { t: 'use', kind: 'seat0' });
    let kept = 0;
    for (let i = 0; i < 12; i++) {
      room.sim.rv.setLinvel({ x: 0, y: 0, z: 4 }, true);
      const Cat = room.addPlayer(new FakeConn(), 'Cat' + i).player;
      room.welcome(Cat);
      if (A.seat === 0 && room.roles.drv === A.id && room.roles.nav === B.id) kept++;
      room.removePlayer(Cat.id, 'left');
    }
    check(room.phase === 'camp' && kept === 12 && A.seat === 0 && room.roles.drv === A.id, `roles: in camp, friends climbing aboard (or leaving) while the driver rolls out draw nothing again: the driver kept the wheel ${kept}/12 times`);
    room.sim.free?.();
  }
  {
    // in camp, parked, Ann at the wheel, Bob has read the map: Cat climbs aboard and the roles are drawn again,
    // but never with Bob at the wheel
    const room = new Room('READ', 4242);
    const cs = [new FakeConn(), new FakeConn(), new FakeConn()];
    const A = room.addPlayer(cs[0], 'Ann').player, B = room.addPlayer(cs[1], 'Bob').player;
    room.welcome(A); room.welcome(B);
    tick(room, 0.5);
    room.setRoles(A.id, B.id);
    const map = [...room.sim.props.values()].find(p => p.type === 'map'), t = map.body.translation();
    room.onPose(A, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
    room.handle(A, { t: 'use', kind: 'seat0' });
    room.onPose(B, { par: 1, x: -0.4, y: 0.05, z: 2.3, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
    room.handle(B, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 });
    const read = room.mapRead.has(B.id);
    const Cat = room.addPlayer(cs[2], 'Cat').player;
    room.welcome(Cat);
    const drivers = new Set([room.roles.drv]);
    for (let i = 0; i < 30; i++) { room.rolesCrew = ''; room.checkRoles(); drivers.add(room.roles.drv); }
    check(read && !drivers.has(B.id) && drivers.size === 2, `roles: drawn again in camp, the one who has read today's map never drives (drivers: ${[...drivers].map(id => room.players.get(id).name).join(', ')})`);
    // and a crew member leaving camp draws nothing again
    const before = { ...room.roles };
    let draws = 0;
    const draw = room.drawRoles.bind(room);
    room.drawRoles = () => { draws++; draw(); };
    room.removePlayer([A, B, Cat].find(p => p.id !== before.drv && p.id !== before.nav).id, 'left');
    check(room.phase === 'camp' && draws === 0 && room.roles.drv === before.drv && room.roles.nav === before.nav, 'roles: in camp, someone leaving draws nothing again (a role is only handed on)');
    room.sim.free?.();
  }
  {
    // a new draw in camp takes the wheel from the old driver and the map from the old navigator, and tells both
    const room = new Room('REDRAW', 4242), cs = [new FakeConn(), new FakeConn(), new FakeConn()];
    const A = room.addPlayer(cs[0], 'Ann').player, B = room.addPlayer(cs[1], 'Bob').player;
    room.welcome(A); room.welcome(B);
    tick(room, 0.5);
    room.setRoles(A.id, B.id);
    const map = [...room.sim.props.values()].find(p => p.type === 'map'), t = map.body.translation();
    room.onPose(A, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
    room.handle(A, { t: 'use', kind: 'seat0' });
    room.onPose(B, { par: 1, x: -0.4, y: 0.05, z: 2.3, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
    room.handle(B, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 });
    tick(room, 0.3);
    const before = A.seat === 0 && room.sim.holds.get(B.id)?.id === map.id;
    const Cat = room.addPlayer(cs[2], 'Cat').player;
    room.welcome(Cat);
    room.setRoles(Cat.id, A.id);   // whatever the draw picked, both jobs move now
    const st = cs[0].last('seat'), g = cs[1].last('grabbed');
    check(before && A.seat === null && st?.seat === null && !!st?.exit && !room.sim.holds.has(B.id) && g?.ok === false && g?.id === map.id && map.holders.size === 0,
      'roles: a new draw takes the wheel from the old driver and the map from the old navigator, and tells both');
    room.sim.free?.();
  }
  {
    // two on the road, and the driver quits: the navigator drives now, and the map leaves their hands (the
    // driver never reads it)
    const room = new Room('ALONE', 4242), ca = new FakeConn(), cb = new FakeConn();
    const A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(cb, 'Bob').player;
    room.welcome(A); room.welcome(B);
    room.setRoles(A.id, B.id);
    tick(room, 0.5);
    const z = room.W.camp.exitZ + 4;
    room.sim.placeRV(room.W.roadX(z), z, 0);
    tick(room, 0.2);
    const map = [...room.sim.props.values()].find(p => p.type === 'map');
    const stand = (p, x, z) => room.onPose(p, { par: 1, x, y: 0.05, z, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
    stand(A, 0.6, 2.4); room.handle(A, { t: 'use', kind: 'seat0' });
    stand(B, -0.4, 2.3);
    const t = map.body.translation();
    room.handle(B, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 });
    tick(room, 0.3);
    const reading = room.sim.holds.get(B.id)?.id === map.id;
    room.handle(A, { t: 'leave' });
    const pulled = !room.sim.holds.has(B.id) && cb.last('grabbed')?.ok === false && map.holders.size === 0;
    stand(B, 0.6, 2.4); room.handle(B, { t: 'use', kind: 'seat0' });
    check(room.phase === 'road' && reading && pulled && room.roles.drv === B.id && !room.roles.nav && B.seat === 0 && cb.has(m => m.t === 'toast' && /Bob drives today\. With nobody to read it/.test(m.text)),
      'roles: the driver quits and only the navigator is left: they take the wheel, and the map leaves their hands');
    room.sim.free?.();
  }
  {
    // in camp, the driver drops, Cat stands in at the wheel, and the driver never comes back: Cat keeps the
    // wheel and the job (no draw again)
    const room = new Room('STANDCAMP', 4242), cs = [0, 1, 2, 3].map(() => new FakeConn());
    const [A, B, Cat, Dan] = ['Ann', 'Bob', 'Cat', 'Dan'].map((n, i) => room.addPlayer(cs[i], n).player);
    for (const p of [A, B, Cat, Dan]) room.welcome(p);
    room.setRoles(A.id, B.id);
    tick(room, 0.5);
    room.hold(A, 0.5);
    room.onPose(Cat, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
    room.handle(Cat, { t: 'use', kind: 'seat0' });
    tick(room, 0.8);
    check(room.phase === 'camp' && !room.players.has(A.id) && Cat.seat === 0 && room.roles.drv === Cat.id && room.roles.nav === B.id, 'stand-ins in camp: the driver never comes back: the stand-in keeps the wheel and the job');
    room.sim.free?.();
  }
  {
    // at night the driver leaves: the role is handed on, but nobody is counted a day's drive, and nobody is told
    // "No swapping till tomorrow" hours before the morning's draw
    const room = new Room('NIGHT', 4242);
    const cs = [new FakeConn(), new FakeConn(), new FakeConn()];
    const [A, B, Cat] = ['Ann', 'Bob', 'Cat'].map((n, i) => room.addPlayer(cs[i], n).player);
    for (const p of [A, B, Cat]) room.welcome(p);
    room.setRoles(A.id, B.id);
    room.phase = 'night';
    const n0 = cs[2].sent.length;
    room.removePlayer(A.id, 'left');
    const jobs = JSON.stringify([...room.jobs]);
    check(room.roles.drv === Cat.id && jobs === '[]' && !cs[2].sent.slice(n0).some(m => m.t === 'toast' && /drives today/.test(m.text)), `roles: handed on at night: Cat drives, but nobody is counted a day's drive (${jobs}) or told about it till morning`);
    room.sim.free?.();
  }
  {
    // the RV is full and one seat is kept for someone who dropped: a newcomer takes it and is told the roles once
    const room = new Room('FULL', 4242);
    const c0 = new FakeConn(), ps = [];
    for (let i = 0; i < C.MAX_PLAYERS; i++) { const p = room.addPlayer(i ? new FakeConn() : c0, 'P' + i).player; room.welcome(p); ps.push(p); }
    room.hold(ps[C.MAX_PLAYERS - 1], 60);
    const n0 = c0.sent.length;
    const late = room.addPlayer(new FakeConn(), 'Late').player;
    room.welcome(late);
    const told = c0.sent.slice(n0).filter(m => m.t === 'toast' && /drives today/.test(m.text)).length;
    check(room.players.size === C.MAX_PLAYERS && told === 1, `roles: a newcomer taking a kept seat in a full RV is told the roles once (${told} toasts)`);
    room.sim.free?.();
  }
}
{
  // a role's player who drops (their seat kept) doesn't stop the RV: anyone stands in till they're back (the
  // day's driver still never reads the map); back, they get the job again once the stand-in lets go; never
  // back, the stand-in keeps the job
  const room = new Room('STAND', 4242);
  const cs = [new FakeConn(), new FakeConn(), new FakeConn(), new FakeConn()];
  const [A, B, Cat, Dan] = ['Ann', 'Bob', 'Cat', 'Dan'].map((n, i) => room.addPlayer(cs[i], n).player);
  A.key = 'tok:a';
  for (const p of [A, B, Cat, Dan]) room.welcome(p);
  room.setRoles(A.id, B.id);
  tick(room, 0.5);
  const W = room.W, sim = room.sim, z = W.camp.exitZ + 4;
  sim.placeRV(W.roadX(z), z, 0);
  tick(room, 0.2);
  const said = (c, re) => c.has(m => m.t === 'toast' && re.test(m.text));
  const map = [...sim.props.values()].find(p => p.type === 'map');
  const stand = (p, x, z) => room.onPose(p, { par: 1, x, y: 0.05, z, yaw: 0, pitch: 0.5, m: 0, f: 0, v: [0, 0, 0] });
  const grab = p => { const t = map.body.translation(); room.handle(p, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 }); };
  const holds = p => sim.holds.get(p.id)?.id === map.id;
  const sit = p => { stand(p, 0.6, 2.4); room.handle(p, { t: 'use', kind: 'seat0' }); };
  const up = p => room.handle(p, { t: 'use', kind: 'unseat' });
  sit(A);
  check(room.phase === 'road' && A.seat === 0 && room.roles.drv === A.id && room.roles.nav === B.id, 'stand-ins: on the road, Ann drives and Bob navigates');
  // the driver drops: anyone can drive till they're back, and the crew is told
  room.hold(A, 5);
  const meta = cs[2].last('meta');
  check(A.seat === null && said(cs[2], /Ann lost connection.*Anyone can drive till they're back/) && meta.away?.some(q => q.id === A.id && q.name === 'Ann') && meta.roles.drv === A.id && meta.roles.drvAway && meta.roles.wheel.includes(Cat.id),
    'stand-ins: the driver drops: the crew is told anyone can drive, and meta still names them (as away)');
  // Bob (the navigator) doesn't take the wheel while Cat (who hasn't seen the map) is here
  stand(B, 0.6, 2.4); room.handle(B, { t: 'use', kind: 'seat0' });
  check(B.seat === null && said(cs[1], /Ann is away\. Somebody who hasn't seen the map takes the wheel/) && !meta.roles.wheel.includes(B.id), 'stand-ins: the navigator leaves the wheel to somebody who hasn\'t seen the map');
  sit(Cat);
  check(Cat.seat === 0 && room.roles.drv === A.id && said(cs[1], /Cat is driving till Ann is back/), 'stand-ins: crew takes the wheel till the driver is back (still their job today)');
  stand(B, -0.4, 2.3); grab(B); tick(room, 0.3);
  check(holds(B), 'stand-ins: the navigator reads the map to whoever stands in at the wheel');
  // the driver is back: Cat keeps driving till Cat gets up; then the wheel is the driver's alone again
  const back = room.resume('tok:a', new FakeConn());
  room.welcome(back);
  check(back === A && Cat.seat === 0 && room.roles.drv === A.id && holds(B), 'stand-ins: the driver comes back: the stand-in keeps the wheel for now, the navigator the map');
  up(Cat); sit(Cat);
  check(Cat.seat === null && said(cs[2], /Ann drives today\. Ride along/), 'stand-ins: ... and once the stand-in gets up, only the driver takes the wheel again');
  sit(A);
  check(A.seat === 0, 'stand-ins: the driver back at the wheel');
  // the navigator drops: Cat (crew) reads the map, Ann (the driver) never
  room.hold(B, 0.5);
  tick(room, 0.1);
  check(!holds(B) && said(cs[2], /Bob lost connection.*Anyone but the driver can read the map/), 'stand-ins: the navigator drops (the map falls): the crew is told anyone but the driver can read it');
  up(A); stand(A, 0.6, 2.4); grab(A);
  check(!holds(A) && A.conn.last('grabbed')?.ok === false && A.conn.has(m => m.t === 'toast' && /no peeking/.test(m.text)), 'stand-ins: the driver still can\'t take the map');
  sit(A);
  stand(Cat, -0.4, 2.3); grab(Cat); tick(room, 0.3);
  check(holds(Cat) && cs[2].last('grabbed')?.ok === true && room.roles.nav === B.id, 'stand-ins: crew reads the map while the navigator is away (still their job today)');
  // the navigator never comes back: the stand-in keeps the map, and the job
  tick(room, 0.6);
  check(!room.players.has(B.id) && room.roles.nav === Cat.id && holds(Cat) && room.roles.drv === A.id, 'stand-ins: the navigator never comes back: the crew member reading the map keeps it, and the job');
  // the driver drops and never comes back while Dan stands in at the wheel: Dan keeps the wheel and the job
  room.hold(A, 0.5);
  sit(Dan);
  tick(room, 0.8);
  check(!room.players.has(A.id) && room.roles.drv === Dan.id && Dan.seat === 0 && room.roles.nav === Cat.id && holds(Cat),
    `stand-ins: the driver never comes back: the stand-in at the wheel keeps driving, and the job (driver ${room.roles.drv}, navigator ${room.roles.nav})`);
  room.sim.free?.();
}
{
  // a role handed on elsewhere doesn't pull a stand-in off the wheel or out of the map
  const room = new Room('KEEP', 4242);
  const cs = [new FakeConn(), new FakeConn(), new FakeConn(), new FakeConn()];
  const [A, B, Cat, Dan] = ['Ann', 'Bob', 'Cat', 'Dan'].map((n, i) => room.addPlayer(cs[i], n).player);
  for (const p of [A, B, Cat, Dan]) room.welcome(p);
  room.setRoles(A.id, B.id);
  tick(room, 0.5);
  const W = room.W, sim = room.sim, z = W.camp.exitZ + 4;
  sim.placeRV(W.roadX(z), z, 0);
  tick(room, 0.2);
  const map = [...sim.props.values()].find(p => p.type === 'map');
  const pose = (p, x, z, pitch = 0) => room.onPose(p, { par: 1, x, y: 0.05, z, yaw: 0, pitch, m: 0, f: 0, v: [0, 0, 0] });
  const grab = p => { const t = map.body.translation(); room.handle(p, { t: 'grab', kind: 'prop', id: map.id, pt: [t.x, t.y, t.z], d: 1.2 }); };
  // Ann (the driver) drops and Cat drives in Ann's place; then Bob (the navigator) leaves the trip: Dan reads
  // the map now, and Cat keeps the wheel
  room.hold(A, 30);
  pose(Cat, 0.6, 2.4); room.handle(Cat, { t: 'use', kind: 'seat0' });
  room.removePlayer(B.id, 'left');
  check(room.phase === 'road' && Cat.seat === 0 && room.roles.drv === A.id && room.roles.nav === Dan.id, 'stand-ins: the navigator leaving hands the map on, and doesn\'t pull the stand-in off the wheel');
  // Ann never comes back: Cat keeps the wheel, and the job
  tick(room, 31);
  check(!room.players.has(A.id) && room.roles.drv === Cat.id && Cat.seat === 0 && room.roles.nav === Dan.id, `stand-ins: the driver never comes back: the stand-in keeps the wheel and the job (driver ${room.roles.drv}, navigator ${room.roles.nav})`);
  // a stand-in reading the map keeps it when the driver's job is handed on: Dan (the navigator) drops, Eve reads
  // the map for Dan while Cat drives; then Cat leaves the trip and Fay (who hasn't seen the map) drives: Eve
  // keeps the map
  const [Eve, Fay] = ['Eve', 'Fay'].map(n => room.addPlayer(new FakeConn(), n).player);
  room.welcome(Eve); room.welcome(Fay);
  room.hold(Dan, 30);
  pose(Eve, -0.4, 2.3, 0.5); grab(Eve);
  tick(room, 0.3);
  const reading = sim.holds.get(Eve.id)?.id === map.id;
  room.removePlayer(Cat.id, 'left');
  check(reading && sim.holds.get(Eve.id)?.id === map.id && room.roles.nav === Dan.id && room.roles.drv === Fay.id, `stand-ins: the driver's job handed on doesn't take the map from whoever reads it for an away navigator (driver ${room.players.get(room.roles.drv)?.name}, Eve reading ${reading})`);
  room.sim.free?.();
}
{
  // AFK: a driver still connected but not moved for a minute (walked off, alt-tabbed, stuck loading) is away
  // too: the crew is told, and anyone stands in. Back at the keys, the wheel is theirs again once it's free
  const room = new Room('AFK', 4242);
  const cs = [new FakeConn(), new FakeConn(), new FakeConn()];
  const [A, B, Cat] = ['Ann', 'Bob', 'Cat'].map((n, i) => room.addPlayer(cs[i], n).player);
  for (const p of [A, B, Cat]) room.welcome(p);
  room.setRoles(A.id, B.id);
  tick(room, 0.5);
  const W = room.W, z = W.camp.exitZ + 4;
  room.sim.placeRV(W.roadX(z), z, 0);
  tick(room, 0.2);
  const pose = (p, x, z, yaw = 0) => room.onPose(p, { par: 1, x, y: 0.05, z, yaw, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  pose(A, -0.4, 1.2); pose(B, -0.4, 2.3); pose(Cat, 0.6, 2.4);
  room.handle(Cat, { t: 'use', kind: 'seat0' });
  check(room.phase === 'road' && Cat.seat === null && !cs[2].last('meta').roles.drvAway, 'AFK: Ann, at the keys, drives today: Cat rides along');
  // a minute on, Ann hasn't moved (Bob and Cat have)
  A.activeAt = room.t - 61; B.activeAt = Cat.activeAt = room.t;
  tick(room, 0.1);
  const meta = cs[2].last('meta');
  room.handle(Cat, { t: 'use', kind: 'seat0' });
  check(meta.roles.drvAway && meta.roles.wheel.includes(Cat.id) && Cat.seat === 0 && room.roles.drv === A.id && cs[1].has(m => m.t === 'toast' && /Cat is driving till Ann is back/.test(m.text)),
    'AFK: a driver who hasn\'t moved for a minute is away: the party is told (meta), and Cat takes the wheel till Ann is back');
  // Ann moves again: still Ann's day; the wheel is hers once Cat gets up
  pose(A, -0.2, 1.2, 0.3);
  tick(room, 0.1);
  room.handle(Cat, { t: 'use', kind: 'unseat' });
  pose(Cat, 0.6, 2.4); room.handle(Cat, { t: 'use', kind: 'seat0' });
  check(!cs[2].last('meta').roles.drvAway && Cat.seat === null && cs[2].has(m => m.t === 'toast' && /Ann drives today\. Ride along/.test(m.text)), 'AFK: Ann moves again: not away any more, and the wheel is hers again once Cat gets up');
  // nobody else here but the navigator (Cat AFK too): then the navigator may stand in, so the RV still moves
  A.activeAt = Cat.activeAt = room.t - 61;
  pose(B, 0.6, 2.4, 0.4); room.handle(B, { t: 'use', kind: 'seat0' });
  check(B.seat === 0, 'AFK: with the driver and the crew both away, the navigator takes the wheel rather than nobody');
  room.sim.free?.();
}

// ---- in process: one missed payment ends the run ------------------------------------------------------
{
  // short at midnight, on any day: no night, no receipt. The game-over says how short; the Repo Man can't
  // be paid after; a late joiner sees the same game-over
  const room = new Room('MISS', 4242);
  const ca = new FakeConn(), A = room.addPlayer(ca, 'Ann').player;
  room.welcome(A);
  room.nextDay();   // day 2
  room.phase = 'road'; room.bank = 100;
  const n0 = ca.sent.length;
  room.midnight();
  const after = ca.sent.slice(n0), over = after.find(m => m.t === 'over');
  check(room.day === 2 && room.phase === 'over' && over?.won === false && over.day === 2 && over.due === C.QUOTAS[1] && over.short === C.QUOTAS[1] - 100 && !after.some(m => m.t === 'receipt') && after.some(m => m.t === 'toast' && /short on the payment\. The Repo Man hooks the RV/.test(m.text)),
    `payments: short $${over?.short} on day 2 → the run is over, no night (no receipt)`);
  const pay = room.W.uses.findIndex(u => u.kind === 'pay'), u = room.W.uses[pay];
  room.onPose(A, { par: 0, x: u.x + 1, y: u.y - 1.5, z: u.z, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  room.bank = 50000;
  room.handle(A, { t: 'use', id: pay });
  check(!room.paid && room.bank === 50000 && ca.has(m => m.t === 'toast' && /Too late\. He already hooked the RV/.test(m.text)), 'payments: after the miss, the Repo Man can\'t be paid any more');
  const cl = new FakeConn(), L = room.addPlayer(cl, 'Lou').player;
  room.welcome(L);
  check(cl.last('over')?.short === C.QUOTAS[1] - 100 && cl.last('over')?.day === 2, 'payments: someone joining during the game-over sees the same game-over');
  // a new run: day 1, $200, and the walkies bought with the last run's money are gone
  A.walkie = true;
  room.newRun();
  check(room.day === 1 && room.bank === 200 && !A.walkie && !L.walkie, 'payments: a new run starts on day 1 with $200, and buys its own walkies');
  room.sim.free?.();
}
{
  // money still on the casino tables at midnight is settled before the Repo Man counts it: a blackjack hand
  // being voted on is played out as a stand (no taking it back after seeing the cards), a coin flip in the
  // air lands now
  const room = new Room('TABLE', 4242);
  const ca = new FakeConn(), A = room.addPlayer(ca, 'Ann').player;
  room.welcome(A);
  room.nextDay();   // day 2: $2,500 due
  room.phase = 'road';
  room.bank = 2600;
  const table = dealHand(room, 300);                 // $300 on the blackjack table
  room.pendingFlip = { win: true, stake: 200, by: A, at: room.t + 5 }; room.bank -= 200;   // $200 in the air, a winner
  room.midnight();
  const back = paidBack(table);
  check(table.state === 'result' && room.paid && room.phase === 'night' && room.bank === 2600 - 300 + back + 200 - C.QUOTAS[1] && !room.pendingFlip && ca.has(m => m.t === 'toast' && /Last call/.test(m.text)),
    `payments: a hand on the table (played out: ${table.outcome}) and a coin in the air at midnight count toward the payment (bank after: $${room.bank})`);
  room.sim.free?.();
}
{
  // a new run starts with $200, that's all: what was still on the casino tables when the last run ended
  // (bets made during the game-over) doesn't come along
  const room = new Room('FRESH', 4242);
  const ca = new FakeConn(), A = room.addPlayer(ca, 'Ann').player;
  room.welcome(A);
  room.bank = 5000;
  room.finish(true);
  dealHand(room, 3000);
  room.pendingFlip = { win: true, stake: 1000, by: A, at: room.t + 5 }; room.bank -= 1000;
  room.newRun();
  check(room.bank === 200 && !room.stats.bestWin && !room.stats.worstLoss && !room.pendingFlip && room.bj.state === 'bet', `payments: a new run starts with $200 and clean stats, whatever was bet during the game-over (bank $${room.bank})`);
  room.sim.free?.();
}

// ---- in process: the trip's record (each player's save) -------------------------------------------------
{
  // five days played (the RV leaves camp, each day paid at a set time): everyone on the trip gets a 'trip'
  // with the road time (each payment less 6:00, added up), the payment times, the haul, what was left and
  // the casino's net; the game-over carries the same run
  const room = new Room('TRIP', 4242);
  const ca = new FakeConn(), cb = new FakeConn(), cc = new FakeConn();
  const A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(cb, 'Bob').player;
  A.key = 'tok:a'; B.key = 'tok:b';
  room.setProfile(A, { pid: 'aaaaaaaaaaaaaaaa', wins: 2 }); room.setProfile(B, { pid: 'bbbbbbbbbbbbbbbb' });
  room.welcome(A); room.welcome(B);
  room.sim.placeRV(0, room.W.camp.exitZ + 6, 0);
  tick(room, 1 / C.SIM_HZ);
  const departed = room.phase === 'road' && room.departed && [...room.roster.values()].every(e => e.fromStart);
  let Cc = null;
  for (let d = 1; d <= 5; d++) {
    if (d === 3) {   // Cid joins on day 3, Bob drops on day 5 and his seat is kept
      Cc = room.addPlayer(cc, 'Cid').player; Cc.key = 'tok:c';
      room.setProfile(Cc, { pid: 'cccccccccccccccc' }); room.welcome(Cc);
    }
    room.phase = 'road'; room.ride(); room.clock = 13 + d * 0.25; room.bank = 100000;   // (the day's road begins)
    room.stats.sold += 1000;
    if (d === 2) room.betResult(300, 'Blackjack', A);
    if (d === 5) room.hold(B, 60);
    room.pay(A);
    if (d < 5) room.nextDay();
  }
  const ta = ca.last('trip'), over = ca.last('over'), tc = cc.last('trip');
  const splits = [13.25, 13.5, 13.75, 14, 14.25];
  check(departed && ta && ta.run === over?.run?.id && ta.won && Math.abs(ta.time - 38.75) < 1e-6 && JSON.stringify(ta.splits) === JSON.stringify(splits) && ta.sold === 5000 && ta.casino === 300 && ta.surplus === Math.round(room.bank)
    && ta.you.fromStart && ta.you.atEnd && ta.crew.length === 2 && ta.crew.every(c => /^[0-9a-f]{8}$/.test(c.h)),
    `the trip's record: everyone aboard at the end gets a 'trip': road time ${ta?.time} h (each payment less 6:00), the payment times, $${ta?.sold} pawned, $${ta?.casino} at the casino, $${ta?.surplus} left; the crew is whoever went all the way (${ta?.crew?.map(c => c.name).join(', ')})`);
  check(tc && !tc.you.fromStart && tc.you.atEnd && !cb.has(m => m.t === 'trip'),
    'the trip\'s record: who joined on day 3 gets theirs, marked not from the start; a dropped player\'s waits for them');
  // the host page is told whose summary waits (and asks before ending the trip)
  check(JSON.stringify(ca.last('meta').trip.pending) === '["Bob"]', `the trip's record: the meta names whose summary is waiting (${JSON.stringify(ca.last('meta').trip.pending)})`);
  // Bob comes back: his summary, with the same run id; again without saying he has it: the same one again;
  // once he says so, no more
  const cb2 = new FakeConn();
  room.welcome(room.resume('tok:b', cb2));
  const tb = cb2.last('trip');
  const cb3 = new FakeConn();
  room.welcome(room.resume('tok:b', cb3));
  const again = cb3.last('trip');
  room.handle(B, { t: 'tripAck', run: tb?.run });
  const cb4 = new FakeConn();
  room.welcome(room.resume('tok:b', cb4));
  check(tb?.run === ta.run && tb.you.atEnd && again?.run === ta.run && !cb4.has(m => m.t === 'trip') && JSON.stringify(cb4.last('meta').trip.pending) === '[]',
    'the trip\'s record: a kept seat gets its summary when it\'s back, the same run again until the page says it has it ("tripAck"), then no more');
  // somebody who joins during the game-over sees it, but it isn't their trip
  const cl = new FakeConn(), L = room.addPlayer(cl, 'Lou').player;
  room.setProfile(L, { pid: 'dddddddddddddddd' }); room.welcome(L);
  check(cl.last('over') && !cl.has(m => m.t === 'trip'), 'the trip\'s record: joining during the game-over shows it, but sends no summary');
  // Cid leaves, and comes back to the room on a later trip with the same profile: his is still there
  room.handle(Cc, { t: 'leave' });
  room.newRun();
  const cc2 = new FakeConn(), C2 = room.addPlayer(cc2, 'Cid').player;
  room.setProfile(C2, { pid: 'cccccccccccccccc' }); room.welcome(C2);
  check(cc2.last('trip')?.run === ta.run && room.runId !== ta.run, 'the trip\'s record: who left and rejoins the room later with the same profile still gets the summary they missed');
  room.sim.free?.();
}
{
  // practice: a typed seed's trip, a test lever, a server with test switches; the next trip in the room isn't
  const room = new Room('PRAC', 777, { typed: true });
  const ca = new FakeConn(), A = room.addPlayer(ca, 'Ann').player;
  room.welcome(A);
  const testServer = room.practice();
  room.serverTest = false; room.mobsOn = true;   // (as on a player's server)
  const typed = room.practice();
  room.newRun();
  const next = room.practice();
  room.handle(A, { t: 'dbg', op: 'clock', h: 9 });
  const lever = room.practice();
  room.newRun();
  room.mobsOn = false;
  const noMobs = room.practice();
  room.mobsOn = true;
  const fresh = new Room('PRAC2', null);
  fresh.serverTest = false; fresh.mobsOn = true;
  check(testServer === 'test' && typed === 'seed' && next === null && lever === 'test' && noMobs === 'test' && room.practice() === null && fresh.practice() === null,
    `the trip's record: a typed seed is practice ('${typed}'), the room's next trip isn't (${next}); a test lever (${lever}), test switches (${testServer}) or no wildlife (${noMobs}) make a test trip; a fresh trip after it counts again`);
  room.sim.free?.(); fresh.sim.free?.();
}
{
  // who the trip's record is for: the day starts when someone walks off down the road (camp's clock doesn't
  // wait while someone walks to town); a summary only for who rode; a new tab while their old seat is kept is
  // the same player; leaving and coming back later isn't the whole trip
  const room = new Room('WHO', 4242);
  const ca = new FakeConn(), cb = new FakeConn(), cc = new FakeConn();
  const A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(cb, 'Bob').player, Cc = room.addPlayer(cc, 'Cid').player;
  A.key = 'tok:a'; B.key = 'tok:b'; Cc.key = 'tok:c';
  room.setProfile(A, { pid: 'aaaaaaaaaaaaaaaa' }); room.setProfile(B, { pid: 'bbbbbbbbbbbbbbbb' }); room.setProfile(Cc, { pid: 'cccccccccccccccc' });
  room.welcome(A); room.welcome(B); room.welcome(Cc);
  room.handle(Cc, { t: 'leave' });   // Cid looks in at camp and goes before the RV does
  const z = room.W.camp.exitZ + 40;
  room.onPose(A, { par: 0, x: 0, y: room.W.heightAt(0, z) + 0.05, z, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  tick(room, 1);
  const waited = room.phase === 'camp' && room.clock === C.DAY_START;
  tick(room, 1.5);
  check(waited && room.phase === 'road' && room.departed && room.clock > C.DAY_START && ca.has(m => m.t === 'toast' && /Ann set off on foot, so the day has started/.test(m.text))
    && room.roster.get('aaaaaaaaaaaaaaaa').fromStart && room.roster.get('bbbbbbbbbbbbbbbb').fromStart,
    `the trip's record: someone 40 m down the road on foot for 2 s starts the day, the RV still in camp (clock ${room.clock.toFixed(3)})`);
  // Bob's tab dies and he opens a new one, his old seat still kept: the same profile id, the same trip
  room.hold(B, 90);
  const cb2 = new FakeConn(), B2 = room.addPlayer(cb2, 'Bob').player;
  B2.key = 'tok:b2'; room.setProfile(B2, { pid: 'bbbbbbbbbbbbbbbb' }); room.welcome(B2);
  room.removePlayer(B.id, 'expired');
  // Ann leaves the trip on day 1, and joins again later on
  room.handle(A, { t: 'leave' });
  const ca2 = new FakeConn(), A2 = room.addPlayer(ca2, 'Ann').player;
  A2.key = 'tok:a2'; room.setProfile(A2, { pid: 'aaaaaaaaaaaaaaaa' }); room.welcome(A2);
  room.finish(true);
  const ta = ca2.last('trip'), tb = cb2.last('trip');
  check(B2.pid === 'bbbbbbbbbbbbbbbb' && tb?.you.fromStart && tb.you.atEnd && ta && !ta.you.fromStart && ta.you.atEnd
    && JSON.stringify(ta.crew.map(c => c.name)) === '["Bob"]' && !room.pending.has('cccccccccccccccc') && JSON.stringify(cb2.last('meta').trip.pending) === '[]',
    `the trip's record: a new tab while the old seat is kept keeps its profile id (${B2.pid}); who left and came back isn't from the start (crew ${ta?.crew?.map(c => c.name).join(', ')}); who never rode gets no summary`);
  room.sim.free?.();
}

// ---- in process: the Garage's kit (shared/garage.js) --------------------------------------------------------
{
  // K4: the kit a page brings: clamped (five perks asked for and a bogus one: three known, levels I-II, in the
  // catalogue's order), echoed in the meta. A 'kit' in day-1 camp is taken, on the road refused (with a toast),
  // during the game-over taken; and once the RV has left camp, leaving and rejoining with another kit keeps the
  // one you came aboard with
  const room = new Room('KIT', 4242);
  const ca = new FakeConn(), A = room.addPlayer(ca, 'Ann').player, B = room.addPlayer(new FakeConn(), 'Bob').player;
  A.key = 'tok:a'; B.key = 'tok:b';
  room.setProfile(A, { pid: 'aaaaaaaaaaaaaaaa', kit: { perks: { medic: 2, eye: 2, gloves: 2, chalk: 3, steady: 1, bogus: 2 }, part: { id: 'horn', lv: 2 } } });
  room.setProfile(B, { pid: 'bbbbbbbbbbbbbbbb' });
  room.welcome(A); room.welcome(B);
  const echo = JSON.stringify(ca.last('meta').players.find(p => p.id === A.id).kit);
  room.handle(A, { t: 'kit', kit: { perks: { chalk: 2 }, part: { id: 'horn', lv: 2 } } });
  const inCamp = JSON.stringify(A.kit), climb = A.mods.climbMul;
  room.sim.placeRV(room.W.roadX(room.W.camp.exitZ + 8), room.W.camp.exitZ + 8, 0);
  tick(room, 0.3);
  const departed = room.departed && room.phase === 'road';
  room.handle(A, { t: 'kit', kit: { perks: { gloves: 2 }, part: null } });
  const onRoad = JSON.stringify(A.kit), told = ca.has(m => m.t === 'toast' && /kit is set for this trip/.test(m.text));
  room.handle(A, { t: 'leave' });
  const cc = new FakeConn(), A2 = room.addPlayer(cc, 'Ann').player;
  A2.key = 'tok:a2'; room.setProfile(A2, { pid: 'aaaaaaaaaaaaaaaa', kit: { perks: { eye: 1 }, part: null } }); room.welcome(A2);
  const rejoined = JSON.stringify(A2.kit);
  room.finish(false);
  tick(room, 0.3);
  room.handle(A2, { t: 'kit', kit: { perks: { eye: 1 }, part: null } });
  const over = JSON.stringify(A2.kit);
  check(echo === '{"perks":{"gloves":2,"steady":1,"eye":2},"part":{"id":"horn","lv":2}}' && inCamp === '{"perks":{"chalk":2},"part":{"id":"horn","lv":2}}' && climb === 0.76
    && departed && onRoad === inCamp && told && rejoined === inCamp && over === '{"perks":{"eye":1},"part":null}',
    `garage: a page's kit is clamped and echoed (${echo}); camp takes a new one (${inCamp}), the road refuses one, leaving and coming back keeps it (${rejoined}), the game-over takes one (${over})`);
  room.sim.free?.();
}

// ---- in process: trip codes (GameHost) -----------------------------------------------------------------
{
  const { GameHost } = await import('../server/host.js');
  const { EventEmitter } = await import('node:events');
  class Sock extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; this.closedWith = null; }
    send(s) { if (typeof s === 'string') this.sent.push(JSON.parse(s)); else (this.bin ||= []).push(s); }
    close(code) { this.closedWith = code; this.readyState = 3; }
    last(t) { return [...this.sent].reverse().find(m => m.t === t); }
    msg(m) { this.emit('message', JSON.stringify(m), false); }
  }
  const host = new GameHost({ build: 'x', log: () => {} });
  const codes = new Set();
  for (let i = 0; i < 300; i++) { const c = host.newCode(); codes.add(c); host.rooms.set(c, { closed: false }); }
  const easy = c => /^(\d)\1{3}$/.test(c) || '0123456789'.includes(c) || '9876543210'.includes(c);
  check(codes.size === 300 && [...codes].every(c => /^[1-9]\d{3}$/.test(c)) && ![...codes].some(easy),
    `trip codes: 300 new trips, 300 different codes, all 4 digits from 1000 to 9999, none like 7777 or 1234 (${[...codes].slice(0, 6).join(' ')} ...)`);
  host.rooms.clear();
  // a closed trip's code waits ten minutes: an old code read out in chat can't lead into a stranger's trip.
  // Every code taken but 4821 (closed a moment ago), 5832 and 4822 (closed 11 minutes ago): never 4821
  for (let i = 1000; i < 10000; i++) host.rooms.set(String(i), { closed: false });
  for (const c of ['4821', '5832', '4822']) host.rooms.delete(c);
  host.freed.set('4821', Date.now()); host.freed.set('4822', Date.now() - 11 * 60 * 1000);
  const fresh = new Set(Array.from({ length: 200 }, () => host.newCode()));
  host.rooms.set('5832', { closed: false }); host.rooms.set('4822', { closed: false });
  const last = host.newCode();
  check(!fresh.has('4821') && fresh.has('5832') && fresh.has('4822') && last === '4821',
    `trip codes: a closed trip's code is not handed out again for ten minutes (drawn: ${[...fresh].join(', ')}), unless it's the last code left`);
  // the loop is what records a closed trip's code
  host.rooms.clear(); host.freed.clear();
  host.rooms.set('6173', { closed: true });
  host.start(); await sleep(120); host.stop();
  check(!host.rooms.has('6173') && host.cooling('6173'), 'trip codes: a trip that closes has its code put aside');
  host.freed.clear();
  // every code taken: a clean refusal, not an endless loop
  for (let i = 1000; i < 10000; i++) host.rooms.set(String(i), { closed: false });
  const s1 = new Sock(); host.attach(s1, { kind: 'ws' }); s1.msg({ t: 'create', name: 'x' });
  check(s1.last('error')?.code === 'full' && host.newCode() === null, 'trip codes: with every code taken, a new trip is refused cleanly');
  host.rooms.clear();
  // guessing: ten wrong codes and the connection is closed
  const s2 = new Sock(); host.attach(s2, { kind: 'ws' });
  for (let i = 0; i < 10; i++) s2.msg({ t: 'join', name: 'g', room: String(2000 + i) });
  await sleep(120);
  check(s2.sent.filter(m => m.t === 'error' && m.code === 'noroom').length === 10 && s2.closedWith === 4008, 'trip codes: a connection that keeps guessing codes is closed after 10 wrong ones');
  {
    // ...and nothing it sends after that is looked at: a burst of 200 guesses, sent before the close lands
    // (or by a client that ignores it), finds nothing
    const hs = new Sock(); host.attach(hs, { kind: 'local' }); hs.msg({ t: 'create', name: 'Hosty' });
    const code = hs.last('welcome')?.code, n = Number(code), from = Math.max(1000, Math.min(9799, n - 150));
    const burst = new Sock(); host.attach(burst, { kind: 'ws', addr: '203.0.113.7' });
    for (let c = from; c < from + 200; c++) burst.msg({ t: 'join', name: 'Stranger', room: String(c) });
    await sleep(120);
    const room = host.rooms.get(code);
    check(!burst.last('welcome') && burst.sent.filter(m => m.t === 'error').length === 10 && burst.closedWith === 4008 && room.players.size === 1,
      `trip codes: a burst of 200 guesses around trip ${code} gets 10 answers, then nothing (players ${room.players.size})`);
    // a new socket from the same address doesn't start over: even the right code waits now
    const again = new Sock(); host.attach(again, { kind: 'ws', addr: '203.0.113.7' }); again.msg({ t: 'join', name: 'Stranger', room: code });
    const other = new Sock(); host.attach(other, { kind: 'ws', addr: '198.51.100.4' }); other.msg({ t: 'join', name: 'Friend', room: code });
    check(!again.last('welcome') && /Too many wrong trip codes/.test(again.last('error')?.msg) && other.last('welcome')?.code === code,
      'trip codes: after 10 wrong codes, a new socket from that address is refused even the right code; another address gets in');
    // a friend coming back to their kept seat from that address gets in (their token, not the code, says who)
    const token = other.last('session')?.resume;
    other.emit('close');
    const back = new Sock(); host.attach(back, { kind: 'ws', addr: '203.0.113.7' }); back.msg({ t: 'join', name: 'Friend', room: code, resume: token });
    check(back.last('welcome')?.id === other.last('welcome')?.id, 'trip codes: a friend coming back to their seat gets in from a slowed-down address');
    // and the address earns one more try every 30 s
    host.guesses.get('203.0.113.7').at -= 31000;
    const later = new Sock(); host.attach(later, { kind: 'ws', addr: '203.0.113.7' }); later.msg({ t: 'join', name: 'Stranger', room: '1001' }); later.msg({ t: 'join', name: 'Stranger', room: '1002' });
    const errs = later.sent.filter(m => m.t === 'error').map(m => m.msg);
    check(errs.length === 2 && /No trip with that code/.test(errs[0]) && /Too many wrong trip codes/.test(errs[1]), `trip codes: 30 s later the address gets one more try (${errs.join(' / ')})`);
    // a code that starts with 0 is four digits, but never a trip's; a huge code costs nothing
    const zero = new Sock(); host.attach(zero, { kind: 'ws', addr: '192.0.2.1' }); zero.msg({ t: 'join', name: 'z', room: '0482' });
    const t0 = performance.now();
    const huge = new Sock(); host.attach(huge, { kind: 'ws', addr: '192.0.2.2' });
    for (let i = 0; i < 20; i++) huge.msg({ t: 'join', name: 'h', room: '\uFDFA'.repeat(20000) });
    const ms = performance.now() - t0;
    check(/never start with 0/.test(zero.last('error')?.msg) && ms < 100, `trip codes: '0482' is told codes never start with 0; 20 joins with 20,000-character codes take ${ms.toFixed(1)} ms`);
    room.closed = true;
  }
  // the desktop host's own page may bring the code its shell found free on Steam; a Steam guest needs no
  // code (the lobby picked the trip); nobody else gets to choose a code
  const solo = new GameHost({ build: 'x', singleRoom: true, log: () => {} });
  const s3 = new Sock(); solo.attach(s3, { kind: 'local' }); s3.msg({ t: 'create', name: 'Hosty', code: '4821' });
  const s4 = new Sock(); solo.attach(s4, { kind: 'steam', key: 'steam:7' }); s4.msg({ t: 'join', name: 'Beans', room: '' });
  check(s3.last('welcome')?.code === '4821' && s4.last('welcome')?.code === '4821', 'trip codes: the desktop host\'s page picks its trip\'s code; a Steam guest joins it with no code');
  const multi = new GameHost({ build: 'x', log: () => {} });
  const s5 = new Sock(); multi.attach(s5, { kind: 'local' }); s5.msg({ t: 'create', name: 'Hosty', code: '1234' });
  const solo2 = new GameHost({ build: 'x', singleRoom: true, log: () => {} });
  const s6 = new Sock(); solo2.attach(s6, { kind: 'ws' }); s6.msg({ t: 'create', name: 'Lan', code: '4821' });
  const c5 = s5.last('welcome')?.code, c6 = s6.last('welcome')?.code;
  check(/^[1-9]\d{3}$/.test(c5) && c5 !== '1234' && /^[1-9]\d{3}$/.test(c6) && c6 !== '4821', `trip codes: a browser server, or a LAN socket, can't choose its code (${c5}, ${c6})`);
  {
    // proximity voice: the host passes a voice frame on only to players within earshot (C.VOICE.RELAY m,
    // just past where the page's fade reaches silence), or to another walkie holder at any range
    const vh = new GameHost({ build: 'x', log: () => {} });
    const sa = new Sock(); vh.attach(sa, { kind: 'local' }); sa.msg({ t: 'create', name: 'Ann' });
    const code = sa.last('welcome').code, room = vh.rooms.get(code);
    const join = (name, addr) => { const s = new Sock(); vh.attach(s, { kind: 'ws', addr }); s.msg({ t: 'join', name, room: code }); return s; };
    const sb = join('Bob', '10.0.0.2'), sc = join('Cat', '10.0.0.3');
    for (const k of [sa, sb, sc]) k.msg({ t: 'voice', on: true });
    const [A, B, Cc] = [sa, sb, sc].map(k => room.players.get(k.last('welcome').id));
    const at = (p, x) => room.onPose(p, { par: 0, x, y: 0, z: 0, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
    at(A, 0); at(B, C.VOICE.RANGE + 1); at(Cc, C.VOICE.RELAY + 1);
    const frame = (seq, walkie) => { const b = Buffer.alloc(40, 7); b[0] = 1; b[1] = walkie ? 1 : 0; b.writeUInt16LE(seq, 2); return b; };
    sa.emit('message', frame(1, false), true);
    const gotB = (sb.bin || []).length, gotC = (sc.bin || []).length;
    A.walkie = true; Cc.walkie = true;
    sa.emit('message', frame(2, true), true);
    check(gotB === 1 && gotC === 0 && (sc.bin || []).length === 1 && (sb.bin || []).length === 2 && sb.bin[0][0] === 2 && sb.bin[0][1] === A.id,
      `voice: heard ${C.VOICE.RANGE + 1} m away (${gotB} frame), not ${C.VOICE.RELAY + 1} m away (${gotC}); a walkie reaches a walkie past that, and still plays out loud nearby`);
    vh.close();
  }
  {
    // the page's fade: full volume within VOICE.FULL m, silent by VOICE.RANGE m, never louder farther out
    const g = d => C.voiceGain(d), ds = Array.from({ length: 61 }, (_, i) => i * 0.5);
    check(g(0) === 1 && g(C.VOICE.FULL) === 1 && g(C.VOICE.RANGE) === 0 && g(40) === 0 && ds.every((d, i) => !i || g(d) <= g(ds[i - 1])) && C.VOICE.RELAY > C.VOICE.RANGE,
      `voice: full within ${C.VOICE.FULL} m, ${(g(10) * 100).toFixed(0)}% at 10 m, ${(g(20) * 100).toFixed(0)}% at 20 m, silent by ${C.VOICE.RANGE} m (relayed to ${C.VOICE.RELAY} m)`);
  }
  for (const h of [host, solo, multi, solo2]) h.close();
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
