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
  // fire, a knocked-out player comes round free, a hand still being voted on is refunded at dawn, and a
  // driver still in the seat is told he isn't
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
  room.bj.state = 'vote'; room.bj.stake = 400; room.bank -= 400;
  const b1 = room.bank;
  room.nextDay();
  check(room.bank === b1 + 400 && A.seat === null && ca.has(m => m.t === 'seat' && m.seat === null), `rooms: at dawn a hand mid-vote is refunded ($${room.bank - b1}) and the driver is told the seat is free`);
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
  check(A.seat === null && holds(B) && ca.last('grabbed')?.ok === false && !holds(A) && said(ca, /Only Bob reads the map/), 'map: the driver gets up: the navigator keeps it, and the driver still can\'t take it');
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
  check(two.size === 2 && two.has(A.id) && two.has(B.id) && said(cs[0], /drives today, and .* reads the map/), 'roles: a friend climbs aboard in camp: drawn again, one drives and one navigates, and everyone is told');
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
  // crew can't drive or read the map
  room.onPose(Cat, { par: 1, x: 0.6, y: 0.05, z: 2.4, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] });
  room.handle(Cat, { t: 'use', kind: 'seat0' });
  const map = [...sim.props.values()].find(p => p.type === 'map'), mt = map.body.translation();
  room.handle(Cat, { t: 'grab', kind: 'prop', id: map.id, pt: [mt.x, mt.y, mt.z], d: 1.2 });
  check(Cat.seat === null && said(cs[2], /drives today\. Ride along/) && cs[2].last('grabbed')?.ok === false && said(cs[2], /Only .* reads the map today/), 'roles: crew can\'t take the wheel or the map, and is told whose job it is');
  // the navigator leaves the trip: the crew member takes the map over
  const navWas = locked.nav, drvWas = locked.drv;
  room.removePlayer(navWas, 'left');
  check(room.roles.nav === Cat.id && room.roles.drv === drvWas, 'roles: the navigator leaves the trip: Cat (crew) reads the map now');
  // the next morning: drawn again, whoever has done a job least first: Cat (who hasn't driven) drives, the
  // old driver navigates
  room.nextDay();
  check(room.phase === 'camp' && room.roles.drv === Cat.id && room.roles.nav === drvWas, `roles: drawn again in the morning, the one who hasn't driven yet drives (driver ${room.roles.drv}, navigator ${room.roles.nav})`);
  room.sim.free?.();
}

// ---- in process: trip codes (GameHost) -----------------------------------------------------------------
{
  const { GameHost } = await import('../server/host.js');
  const { EventEmitter } = await import('node:events');
  class Sock extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; this.closedWith = null; }
    send(s) { if (typeof s === 'string') this.sent.push(JSON.parse(s)); }
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
