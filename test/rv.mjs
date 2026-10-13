// The RV's condition (shared/constants.js RVH): crashes and the wildlife wear it down, a worn RV is down on
// power, at 0% it breaks down until somebody fixes it at the engine hatch, and Gus fixes it in town for cash
// or on the loan. It never ends a trip: only a missed payment does. In process (Room + Sim with fake
// connections), the wildlife off (what it does to the RV is in test/mobs.mjs).
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { RV_HATCH, RV_WHEELS, qRotate, toWorld } = await import('../shared/rv.js');
const { generateLeg } = await import('../shared/world.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

await initPhysics();
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  last(t) { return [...this.sent].reverse().find(m => m.t === t); }
  all(t) { return this.sent.filter(m => m.t === t); }
}
const HZ = C.SIM_HZ;
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * HZ); i++) room.tick(1 / HZ); };
const evs = (conn, k) => conn.sent.filter(m => m.t === 'ev').flatMap(m => m.list).filter(e => e.k === k);
const toasts = (conn, re) => conn.all('toast').filter(m => re.test(m.text));
// a crew in a fresh room on day `day` (the RV parked in camp on its handbrake)
function crew(names, day = 1, seed = 4242) {
  const room = new Room('RVH', seed);
  const ps = names.map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  if (day > 1) room.debug(ps[0], { op: 'day', d: day });
  tick(room, 0.2);
  return { room, ps };
}
// every hit the room is told of, priced or free (the published 'rvhit' events are only the ones that cost)
function hits(room) {
  const seen = [], f = room.onRVHit.bind(room);
  room.onRVHit = e => { const r = f(e); seen.push({ ...e, priced: r }); return r; };
  return seen;
}
const worst = seen => seen.filter(h => h.why === 'crash').reduce((m, h) => Math.max(m, h.dv), 0);
const stand = (room, p, x, z, yaw = 0) => room.onPose(p, { x, y: room.W.heightAt(x, z), z, yaw, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
const ride = (room, p, lx, lz) => room.onPose(p, { par: 1, x: lx, y: 0.05, z: lz, yaw: 0, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
const fwdOf = room => qRotate(room.sim.rv.rotation(), { x: 0, y: 0, z: 1 });
// stand d m straight behind the engine hatch, facing it
const behind = (room, p, d = 1.5) => { const w = room.sim.rvToWorld({ x: RV_HATCH.x, y: 0, z: RV_HATCH.z - d }), f = fwdOf(room); stand(room, p, w.x, w.z, Math.atan2(f.x, f.z)); };
const roadYaw = (W, z) => Math.atan2(W.roadX(z + 3) - W.roadX(z - 3), 6);
const fixing = (room, ps, on) => { for (const p of ps) room.handle(p, { t: 'fix', on: on ? 1 : 0 }); };
// drive at about `speed`, steering along the road (10 m ahead) or at a point: keyboard-style (-1/0/+1, as
// the page sends from A/D) or smooth. onTick returning false stops early
function drive(room, A, speed, secs, { kb = true, at = null, onTick = null } = {}) {
  A.seat = 0;
  const sim = room.sim, W = room.W;
  for (let i = 0; i < Math.round(secs * HZ); i++) {
    const p = sim.rv.translation(), f = fwdOf(room);
    const goal = at || { x: W.roadX(p.z + 10), z: p.z + 10 }, tx = goal.x - p.x, tz = goal.z - p.z;
    const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz);
    const st = kb ? (err > 0.06 ? 1 : err < -0.06 ? -1 : 0) : Math.max(-1, Math.min(1, err * 2.5));
    const v = sim.rvSpeed();
    room.handle(A, { t: 'drv', th: v < speed - 0.3 ? 1 : v > speed + 0.6 ? -0.4 : 0, st, hb: 0 });
    room.tick(1 / HZ);
    if (onTick?.(i) === false) break;
  }
}
// the flattest straight stretch of road clear of the day's obstacles (the gates opened: the crew has the code),
// and the RV put down on it, settled
function flatSpot(room) {
  const W = room.W, h = z => W.heightAt(W.roadX(z), z);
  let best = null, bs = Infinity;
  for (let z = 60; z < 600; z += 5) {
    if (W.obstacles.some(o => o.type !== 'gate' && Math.abs((o.z ?? o.z0) - z) < 50)) continue;
    const s = Math.abs(h(z + 15) - h(z - 15)) / 30 + Math.abs(W.roadX(z + 15) + W.roadX(z - 15) - 2 * W.roadX(z)) * 0.01;
    if (s < bs) { bs = s; best = z; }
  }
  for (const g of W.gates) room.sim.openGate(g.id);
  room.sim.placeRV(W.roadX(best), best, roadYaw(W, best));
  tick(room, 1.5);
  return best;
}
const engineForce = sim => RV_WHEELS.reduce((s, w, i) => s + Math.abs(sim.vehicle.wheelEngineForce(i)), 0);
const pedal = (room, A, th, secs, st = 0, hb = 0) => { A.seat = 0; for (let i = 0; i < Math.round(secs * HZ); i++) { room.handle(A, { t: 'drv', th, st, hb }); room.tick(1 / HZ); } };
// Gus's two buttons (cash, loan), and a press of one from where it can be reached
const gusUse = (room, arg) => room.W.uses.find(u => u.kind === 'repair' && u.arg === arg);
const press = (room, p, arg) => { const u = gusUse(room, arg); stand(room, p, u.x - 0.9, u.z, 0); room.handle(p, { t: 'use', id: u.id }); tick(room, 1 / HZ); };
// the day paid and the night begun (the RV parked at the lot by the fire, 10 m from Gus)
const payUp = room => { room.bank = Math.max(room.bank, room.due); room.pay(); tick(room, 0.1); };

// ---- RV1: the rules on paper --------------------------------------------------------------------------------
{
  const cd = [1.9, 2, 3, 5, 10].map(C.crashDamage), bd = [2.9, 3, 7, 30].map(C.beastDamage);
  const bands = [100, 61, 60, 31, 30, 1, 0].map(h => C.rvBand(h).name), eng = [100, 60, 30, 0].map(h => C.rvBand(h).top);
  const q1 = C.repairQuote(2, 40), q2 = C.repairQuote(1, 90);
  check(cd.join() === '0,0,3,9,24' && bd.join() === '0,4,8,20', `rv: a crash costs ${cd.join('/')}% at 1.9/2/3/5/10 m/s, a grumphorn ${bd.join('/')}% at 2.9/3/7/30 m/s`);
  check(bands.join() === 'FINE,FINE,SMOKING,SMOKING,LIMPING,LIMPING,BROKEN DOWN' && eng.join() === '1,0.92,0.84,0',
    `rv: 100/61/60/31/30/1/0% read ${bands.join('/')}, its top end at x${eng.join('/x')}`);
  check(q1.pts === 25 && q1.cash === 245 && q1.loan === 305 && q2.pts === 10 && q2.cash === 80 && q2.loan === 100,
    `rv: Gus's next 25% on night 2 at 40% costs $${q1.cash} cash or $${q1.loan} on the loan; the last 10% on night 1, $${q2.cash} / $${q2.loan}`);
}

// ---- RV2: what must never count as a crash -------------------------------------------------------------------
{
  // keyboard driving (steer only -1/0/+1) on each day's road, then a handbrake stop from cruise with ten
  // loose things in the back, two of them safes
  const LOOSE = ['safe', 'safe', 'tv', 'toaster', 'lamp', 'vase', 'gnome', 'trophy', 'tv', 'lamp'];
  const out = [];
  for (let day = 1; day <= 5; day++) {
    const { room, ps: [A] } = crew(['Ann'], day);
    const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
    LOOSE.forEach((type, i) => sim.addProp(type, toWorld(rp, rq, i < 2 ? { x: i ? 0.5 : -0.5, y: 0.6, z: -1.2 } : { x: -0.6 + ((i - 2) % 3) * 0.6, y: 0.5, z: -3.2 + Math.floor((i - 2) / 3) * 0.9 }), { x: 0, y: 0, z: 0, w: 1 }, 100, 100));
    tick(room, 1.5);
    // (the crew has the gate's code; the boulder is a real crash: stop short of it)
    for (const g of room.W.gates) sim.openGate(g.id);
    const stopAt = Math.min(...room.W.obstacles.filter(o => o.type === 'boulder').map(o => o.z - 60), Infinity);
    const seen = hits(room);
    let top = 0, secs = 0;
    drive(room, A, 14, 30, { onTick: i => { top = Math.max(top, sim.rvSpeed()); secs = (i + 1) / HZ; return sim.rv.translation().z < stopAt; } });
    const v0 = sim.rvSpeed(), inside = sim.cargo().length;
    pedal(room, A, 0, 4, 0, 1);
    out.push({ day, top, v0, secs, inside, stop: sim.rvSpeed(), worst: worst(seen), hp: room.rvc.hp });
  }
  check(out.every(o => o.worst <= C.RVH.FREE && o.hp === 100 && o.top > 11 && o.v0 > 9 && Math.abs(o.stop) < 0.5 && o.inside >= 6),
    `rv: keyboard driving on each day's road, then the handbrake from cruise with ${LOOSE.length} loose things (2 safes) aboard, costs nothing ` +
    out.map(o => `(day ${o.day}: ${o.secs.toFixed(0)} s, top ${o.top.toFixed(1)} m/s, braked from ${o.v0.toFixed(1)} with ${o.inside} aboard, worst ${o.worst.toFixed(2)} m/s)`).join(' '));
}
{
  // teleports: the RV put somewhere else while doing 15 m/s, and set back on its wheels
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim, W = room.W, seen = hits(room);
  drive(room, A, 14, 6);
  const f = fwdOf(room);
  sim.rv.setLinvel({ x: f.x * 15, y: 0, z: f.z * 15 }, true);
  sim.placeRV(W.roadX(200), 200, roadYaw(W, 200));
  A.seat = null;
  tick(room, 3);
  const afterPlace = worst(seen);
  // on its side, settled, then righted (the tow)
  const t = sim.rv.translation();
  sim.rv.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true);
  sim.rv.setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) }, true);
  tick(room, 4);
  const n = seen.length, flipped = sim.rvFlipped();
  sim.rightRV();
  tick(room, 3);
  const righted = seen.slice(n);
  check(afterPlace <= C.RVH.FREE && flipped && !sim.rvFlipped() && worst(righted) <= C.RVH.FREE,
    `rv: put down elsewhere at 15 m/s (worst ${afterPlace.toFixed(2)} m/s) and set back on its wheels from its side (worst ${worst(righted).toFixed(2)} m/s): no crash`);
}
{
  // the winch hauling the RV up a grade, and flooring it against the cable still clipped to its post
  let day = 1;
  while (day < 5 && !generateLeg(4242, day).obstacles.some(o => o.type === 'grade')) day++;
  const { room, ps: [A] } = crew(['Ann'], day);
  const W = room.W, sim = room.sim, grade = W.obstacles.find(o => o.type === 'grade');
  const rz = grade.z0 - 7;
  sim.placeRV(W.roadX(rz), rz, roadYaw(W, rz));
  tick(room, 1.5);
  const top = { x: W.roadX(grade.z1), z: grade.z1 }, anc = W.anchors.reduce((b, a) => (Math.hypot(a.x - top.x, a.z - top.z) < Math.hypot(b.x - top.x, b.z - top.z) ? a : b));
  const clip = () => { const w = sim.winchWorld(); Object.assign(sim.hook, { state: 'anchored', body: null, anchor: { x: anc.x, y: anc.y, z: anc.z }, attach: null, holder: null, reeling: false, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 }); };
  clip();
  const seen = hits(room);
  // backing away from the post at full throttle: the cable holds it
  const z0 = sim.rv.translation().z;
  pedal(room, A, -1, 5);
  const held = Math.abs(sim.rv.translation().z - z0);
  // reeled in up the grade, the driver feathering the throttle
  sim.hook.reeling = true;
  let up = false;
  for (let i = 0; i < 30 * HZ && !up; i++) { pedal(room, A, 0.5, 1 / HZ); up = sim.rv.translation().z > grade.z1 + 1.5; }
  check(held < 1.5 && up && worst(seen) <= C.RVH.FREE && room.rvc.hp === 100,
    `rv: day ${day}: flooring it against the clipped winch (it moved ${held.toFixed(2)} m) and winching up the ${grade.h.toFixed(1)} m grade: no crash (worst ${worst(seen).toFixed(2)} m/s)`);
}

// ---- RV3: a crash --------------------------------------------------------------------------------------------
// day 3's closed ranger gate, straight at it: with Ann at the wheel at 8 m/s, and with nobody driving
function gateRun(speed, driver) {
  const { room, ps: [A] } = crew(['Ann'], 3);
  room.phase = 'road';
  const W = room.W, sim = room.sim, g = W.gates[0];
  const z0 = g.z - (driver ? 40 : 14);
  sim.placeRV(W.roadX(z0), z0, driver ? roadYaw(W, z0) : Math.atan2(g.x - W.roadX(z0), g.z - z0));
  tick(room, 0.8);
  const seen = hits(room), bank = room.bank;
  let at = null;
  if (driver) {
    drive(room, A, speed, 14, { kb: false, at: g, onTick: () => { if (seen.length && at == null) at = sim.rvSpeed(); return !seen.length; } });
    pedal(room, A, 0, 3);
  } else {
    const f = fwdOf(room);
    sim.rv.setLinvel({ x: f.x * speed, y: 0, z: f.z * speed }, true);
    tick(room, 5);
  }
  return { room, A, seen, bank, g };
}
{
  const { room, A, seen: all, bank } = gateRun(8, true);
  const seen = all.filter(h => h.priced), h = seen[0], said = toasts(A.conn, /^CRUNCH/);
  check(seen.length === 1 && h.why === 'crash' && h.dv >= 7 && h.dv <= 8.5 && h.amt >= 15 && h.amt <= 20 && h.zone === 'front' && h.what === 'the ranger gate' && room.rvc.hp === 100 - h.amt,
    `rv: into the closed ranger gate at 8 m/s: one hit, ${h?.dv} m/s, -${h?.amt}% (RV ${room.rvc.hp}%), the ${h?.zone}, '${h?.what}' (${all.length - seen.length} free bumps after)`);
  check(said.length === 1 && /Ann put the RV into the ranger gate: -\d+% \(RV \d+%\)/.test(said[0].text) && room.bank === bank && evs(A.conn, 'rvhit').length === 1,
    `rv: the crew hears who did it ('${said[0]?.text}'), the bank is untouched, the pages get one 'rvhit'`);
}
{
  const { A, seen: all } = gateRun(8.6, false);
  const seen = all.filter(h => h.priced), said = toasts(A.conn, /^CRUNCH/);
  check(seen.length === 1 && seen[0].amt > 0 && seen[0].what === 'the ranger gate' && said.length === 1 && /nobody at the wheel/.test(said[0].text),
    `rv: rolling into it with nobody driving: '${said[0]?.text}'`);
}

// ---- RV4: one incident, one bill --------------------------------------------------------------------------
{
  const { room, ps: [A] } = crew(['Ann']);
  const lever = () => { room.debug(A, { op: 'rvhit', why: 'crash', dv: 2 + 20 / 3 }); tick(room, 0.5); };
  lever(); lever(); lever();
  const three = 100 - room.rvc.hp;
  tick(room, 2.0);
  lever();
  const four = 100 - room.rvc.hp;
  check(three === 25 && four === 45, `rv: three 20% knocks 0.5 s apart cost ${three}% all told (one incident); a fourth 2.5 s later counts afresh (${four}%)`);
}
{
  // a roll at 13 m/s (day 4): the tumble is one incident, capped, and one tow
  const { room, ps: [A] } = crew(['Ann'], 4);
  const sim = room.sim, seen = hits(room);
  drive(room, A, 13, 14, { kb: false });
  const v = sim.rvSpeed(), f = fwdOf(room), bills = room.stats.bills;
  // a kerb under the left wheels: a twist about the long axis and a hop
  sim.rv.setAngvel({ x: f.x * 3.2, y: 0, z: f.z * 3.2 }, true);
  const lv = sim.rv.linvel();
  sim.rv.setLinvel({ x: lv.x, y: lv.y + 3, z: lv.z }, true);
  A.seat = null;
  let rolled = false;
  for (let i = 0; i < 14 * HZ; i++) { tick(room, 1 / HZ); rolled ||= sim.rvFlipped(); }
  const tows = toasts(A.conn, /Tow truck/).length, lost = 100 - room.rvc.hp;
  check(rolled && lost > 0 && lost <= C.RVH.CAP && tows === 1 && room.stats.bills - bills === 800 && !sim.rvFlipped(),
    `rv: rolled at ${v.toFixed(1)} m/s: -${lost}% (${seen.filter(h => h.priced).length} hits, at most ${C.RVH.CAP}%) and one $800 tow`);
}

// ---- RV5: the bands, on the road -------------------------------------------------------------------------
{
  const top = {};
  for (const hp of [100, 50, 20]) {
    const { room, ps: [A] } = crew(['Ann']);
    room.debug(A, { op: 'rvhp', hp });
    let mx = 0;
    drive(room, A, 30, 25, { onTick: () => { mx = Math.max(mx, room.sim.rvSpeed()); } });
    top[hp] = mx;
  }
  check(Math.abs(top[100] - 13.0) <= 0.4 && top[50] <= 12.7 && top[20] <= 11.9 && top[100] > top[50] && top[50] > top[20],
    `rv: flat out for 25 s it makes ${top[100].toFixed(2)} m/s FINE, ${top[50].toFixed(2)} SMOKING, ${top[20].toFixed(2)} LIMPING`);
}
{
  // broken down: no power, but it brakes, steers and can be winched
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim;
  flatSpot(room);
  room.debug(A, { op: 'rvhp', hp: 0 });
  pedal(room, A, 1, 5);
  const crept = Math.abs(sim.rvSpeed());
  let f = fwdOf(room);
  sim.rv.setLinvel({ x: f.x * 8, y: 0, z: f.z * 8 }, true);
  let stopT = null;
  for (let i = 0; i < 5 * HZ && stopT == null; i++) { pedal(room, A, -1, 1 / HZ); if (Math.abs(sim.rvSpeed()) < 0.3) stopT = (i + 1) / HZ; }
  f = fwdOf(room);
  sim.rv.setLinvel({ x: f.x * 6, y: 0, z: f.z * 6 }, true);
  const y0 = Math.atan2(f.x, f.z);
  pedal(room, A, 0, 1.5, 1);
  const f2 = fwdOf(room), turned = Math.abs(Math.atan2(Math.sin(Math.atan2(f2.x, f2.z) - y0), Math.cos(Math.atan2(f2.x, f2.z) - y0)));
  // the winch reels it in, engine or no (back on the road, a post 14 m dead ahead)
  flatSpot(room);
  f = fwdOf(room);
  const w = sim.winchWorld(), anc = { x: w.x + f.x * 14, y: w.y + 1, z: w.z + f.z * 14 };
  Object.assign(sim.hook, { state: 'anchored', body: null, anchor: anc, attach: null, holder: null, reeling: true, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 });
  const d0 = Math.hypot(anc.x - w.x, anc.z - w.z);
  pedal(room, A, 0, 5);
  const w2 = sim.winchWorld(), reeled = d0 - Math.hypot(anc.x - w2.x, anc.z - w2.z);
  check(crept < 0.3 && stopT != null && stopT <= 4 && turned > 0.15 && reeled > 5,
    `rv: broken down, flooring it gets ${crept.toFixed(2)} m/s in 5 s; the brakes stop it from 8 m/s in ${stopT?.toFixed(2)} s; it still steers (${(turned * 180 / Math.PI).toFixed(0)}° in 1.5 s); the winch reels it ${reeled.toFixed(1)} m in 5 s`);
}

// ---- RV6: stalls and the door --------------------------------------------------------------------------------
{
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim;
  flatSpot(room);
  room.debug(A, { op: 'rvhp', hp: 20 });
  room.debug(A, { op: 'rvhit', why: 'beast', amt: 3 });
  tick(room, 1 / HZ);
  let dead = 0, back = null;
  for (let i = 0; i < 4 * HZ; i++) { pedal(room, A, 1, 1 / HZ); if (engineForce(sim) === 0) dead = (i + 1) / HZ; else if (back == null) back = (i + 1) / HZ; }
  check(room.rvc.hp === 17 && dead >= 2.9 && dead <= 3.1 && back != null && back >= 2.9,
    `rv: limping (17%), a 3% knock stalls the engine: no drive for ${dead.toFixed(2)} s, then it's back`);
  room.debug(A, { op: 'rvhp', hp: 60 });
  room.debug(A, { op: 'rvhit', why: 'beast', amt: 3 });
  pedal(room, A, 1, 0.5);
  check(room.rvc.hp === 57 && engineForce(sim) > 0, 'rv: smoking, the same knock doesn\'t stall it');
}
{
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim;
  if (sim.doorOpen) sim.setDoor(false);
  tick(room, 0.1);
  room.debug(A, { op: 'rvhit', why: 'crash', dv: 2 + 8 / 3 });
  tick(room, 3);
  const shut = !sim.doorOpen && !evs(A.conn, 'door').some(e => e.pop);
  room.debug(A, { op: 'rvhit', why: 'crash', dv: 2 + 10 / 3 });
  tick(room, 0.2);
  const pops = evs(A.conn, 'door').filter(e => e.pop && e.open);
  check(shut && sim.doorOpen && pops.length === 1 && toasts(A.conn, /door flew open/).length === 1,
    'rv: an 8% knock leaves the door shut; a 10% one throws it open (a door event with pop, and the crew is told)');
}

// ---- RV7: the roadside fix ---------------------------------------------------------------------------------
{
  const { room, ps } = crew(['Ann', 'Bob', 'Cat', 'Dee']);
  const [A, B, Cc, D] = ps, R = room.rvc;
  // how long n of them take, holding E 1.5 m behind the hatch
  const fixTime = (who, limit = 20) => {
    room.debug(A, { op: 'rvhp', hp: 0 });
    for (const p of who) behind(room, p, 1.5);
    const n0 = evs(A.conn, 'rvfix').length;
    fixing(room, who, true);
    let t = null;
    for (let i = 0; i < limit * HZ && t == null; i++) { room.tick(1 / HZ); if (R.hp > 0) t = (i + 1) / HZ; }
    fixing(room, who, false);
    return { t, fixes: evs(A.conn, 'rvfix').length - n0 };
  };
  room.debug(A, { op: 'rvhp', hp: 0 });
  behind(room, A, 1.5);
  fixing(room, [A], true);
  tick(room, 7.5);
  const at75 = R.hp;
  tick(room, 0.6);
  fixing(room, [A], false);
  const fx = evs(A.conn, 'rvfix');
  check(at75 === 0 && R.hp === C.RVH.FIX_TO && fx.length === 1 && fx[0].hp === 20 && !room.sim.rvMods.dead && toasts(A.conn, /Ann got it running/).length === 1,
    `rv: broken down, Ann holding E behind it: still 0% at 7.5 s, ${R.hp}% at 8.1 s (one 'rvfix', and a toast)`);
  const two = fixTime([A, B]), three = fixTime([A, B, Cc]), four = fixTime([A, B, Cc, D]);
  check(Math.abs(two.t - 4) < 0.05 && Math.abs(three.t - 8 / 3) < 0.05 && Math.abs(four.t - 8 / 3) < 0.05 && two.fixes === 1 && three.fixes === 1,
    `rv: two of them fix it in ${two.t?.toFixed(2)} s, three in ${three.t?.toFixed(2)} s, a fourth adds nothing (${four.t?.toFixed(2)} s)`);
  // where it doesn't count
  const none = {};
  const tryIt = (name, set, unset) => {
    room.debug(A, { op: 'rvhp', hp: 0 });
    behind(room, A, 1.5);
    set();
    fixing(room, [A], true);
    tick(room, 3);
    none[name] = R.fix === 0 && R.hp === 0;
    fixing(room, [A], false);
    unset?.();
  };
  tryIt('4 m away', () => behind(room, A, 4.2));
  tryIt('knocked out', () => { room.handle(A, { t: 'ko', why: 'fall' }); }, () => { A.ko = false; });
  tryIt('seated', () => { A.seat = 1; }, () => { A.seat = null; });
  tryIt('riding', () => ride(room, A, 0, RV_HATCH.z + 0.8));
  check(Object.values(none).every(Boolean), `rv: no progress ${Object.entries(none).map(([k, v]) => `${k} ${v ? 'none' : 'SOME'}`).join(', ')}`);
  {
    // rolling at 1.2 m/s (Bob at the wheel, so the parking brake stays off; Ann keeping up with the hatch)
    room.debug(A, { op: 'rvhp', hp: 0 });
    B.seat = 0;
    let slow = 99;
    room.handle(A, { t: 'fix', on: 1 });
    for (let i = 0; i < 3 * HZ; i++) {
      const f = fwdOf(room);
      room.sim.rv.setLinvel({ x: f.x * 1.25, y: room.sim.rv.linvel().y, z: f.z * 1.25 }, true);
      behind(room, A, 1.5);
      room.handle(B, { t: 'drv', th: 0, st: 0, hb: 0 });
      room.tick(1 / HZ);
      slow = Math.min(slow, Math.abs(room.sim.rvSpeed()));
    }
    room.handle(A, { t: 'fix', on: 0 });
    B.seat = null;
    check(R.fix === 0 && R.hp === 0 && slow >= C.RVH.FIX_V, `rv: no progress with the RV rolling (${slow.toFixed(2)} m/s at the slowest)`);
  }
  // letting go keeps what's done (once the RV has rolled to a stop)
  room.debug(A, { op: 'rvhp', hp: 0 });
  for (let i = 0; i < 10 * HZ && Math.abs(room.sim.rvSpeed()) > 0.05; i++) room.tick(1 / HZ);
  behind(room, A, 1.5);
  fixing(room, [A], true); tick(room, 4); fixing(room, [A], false);
  const half = R.fix;
  tick(room, 3);
  const kept = R.fix;
  fixing(room, [A], true);
  let rest = null;
  for (let i = 0; i < 8 * HZ && rest == null; i++) { room.tick(1 / HZ); if (R.hp > 0) rest = (i + 1) / HZ; }
  fixing(room, [A], false);
  check(Math.abs(half - 0.5) < 0.01 && kept === half && Math.abs(rest - 4) < 0.05, `rv: let go halfway (${(half * 100).toFixed(0)}%), it waits (${(kept * 100).toFixed(0)}% 3 s later), and 4 more seconds finish it (${rest?.toFixed(2)} s)`);
  // the day's second breakdown is slower to fix; a fix at 5% does nothing
  room.debug(A, { op: 'rvhit', why: 'beast', amt: 20 });
  tick(room, 0.1);
  const broke2 = R.hp === 0 && R.brokeN === 2;
  behind(room, A, 1.5);
  fixing(room, [A], true);
  let t2 = null;
  for (let i = 0; i < 16 * HZ && t2 == null; i++) { room.tick(1 / HZ); if (R.hp > 0) t2 = (i + 1) / HZ; }
  fixing(room, [A], false);
  room.debug(A, { op: 'rvhp', hp: 5 });
  const nfix = evs(A.conn, 'rvfix').length;
  fixing(room, [A], true); tick(room, 10); fixing(room, [A], false);
  check(broke2 && Math.abs(t2 - 12) < 0.05 && R.hp === 5 && evs(A.conn, 'rvfix').length === nfix,
    `rv: the day's second breakdown takes ${t2?.toFixed(2)} s alone; holding E at 5% does nothing`);
}

// ---- RV8: Gus's Garage ------------------------------------------------------------------------------------
{
  const { room, ps: [A] } = crew(['Ann'], 2);
  const R = room.rvc, W = room.W, gus = W.town.gus, lot = W.town.lot;
  check(gusUse(room, 'cash') && gusUse(room, 'loan') && Math.hypot(lot.x - gus.x, lot.z - gus.z) < C.RVH.GUS_R - 2,
    `rv: Gus's bench is ${Math.hypot(lot.x - gus.x, lot.z - gus.z).toFixed(1)} m from where the RV parks at night, with a cash and a loan button`);
  // not before the Repo Man is paid
  room.sim.placeRV(lot.x, lot.z, lot.yaw);
  room.debug(A, { op: 'rvhp', hp: 40 });
  room.bank = 3000;
  press(room, A, 'cash');
  const early = R.hp === 40 && room.bank === 3000 && toasts(A.conn, /Repo Man's been paid/).length === 1;
  payUp(room);
  room.bank = 1000;
  press(room, A, 'cash');
  const cash = [room.bank, R.hp];
  press(room, A, 'loan');
  const loan = [R.hp, room.loanAdd, room.gameState().nxt];
  press(room, A, 'cash');
  const third = [room.bank, R.hp];
  press(room, A, 'cash');
  const fourth = [room.bank, R.hp];
  check(early, 'rv: Gus won\'t touch it before the day is paid');
  check(cash.join() === '755,65' && loan.join() === '90,305,4805' && third.join() === '655,100' && fourth.join() === '655,100' && toasts(A.conn, /Nothing to fix/).length === 1,
    `rv: night 2 at 40% with $1,000: cash -> $${cash[0]}, ${cash[1]}%; on the loan -> ${loan[0]}%, tomorrow's due $${loan[2]}; the last 10% for $100 -> ${third[1]}%; at 100% he waves you off`);
  check(room.due === C.QUOTAS[1], `rv: the loan doesn't touch tonight's payment ($${room.due})`);
  // broke: the loan still works; the RV too far off: no
  room.debug(A, { op: 'rvhp', hp: 40 });
  room.bank = 100;
  press(room, A, 'cash');
  const refused = R.hp === 40 && room.bank === 100;
  press(room, A, 'loan');
  const took = R.hp === 65 && room.loanAdd === 610;
  room.sim.placeRV(lot.x, gus.z - 20, lot.yaw);
  tick(room, 0.5);
  press(room, A, 'loan');
  check(refused && took && R.hp === 65 && room.loanAdd === 610 && toasts(A.conn, /Bring the RV round/).length === 1,
    'rv: with $100 Gus wants cash he can\'t have, but takes the loan; with the RV 20 m away he won\'t start');
  // tomorrow's due carries the loan, then it's gone
  room.nextDay();
  tick(room, 0.1);
  check(room.day === 3 && room.due === C.QUOTAS[2] + 610 && room.loanAdd === 0 && room.gameState().nxt == null,
    `rv: day 3's payment is $${room.due} (${C.QUOTAS[2]} + the $610 on the loan), and the loan is clear`);
}
{
  // night 4: the loan goes on the balloon, so the first press only says what it'd cost
  const { room, ps: [A] } = crew(['Ann'], 4);
  const R = room.rvc, lot = room.W.town.lot;
  payUp(room);
  room.debug(A, { op: 'rvhp', hp: 40 });
  press(room, A, 'loan');
  const asked = R.hp === 40 && room.loanAdd === 0 && toasts(A.conn, /Press again to sign/).length === 1;
  tick(room, 2);
  press(room, A, 'loan');
  check(asked && R.hp === 65 && room.loanAdd === 415 && room.gameState().nxt === C.QUOTAS[4] + 415 && Math.hypot(room.sim.rv.translation().x - lot.x, room.sim.rv.translation().z - lot.z) < 1,
    `rv: night 4, one press on the loan only asks; a second within 5 s signs: the balloon is $${room.gameState().nxt}`);
  room.debug(A, { op: 'rvhp', hp: 40 });
  press(room, A, 'loan');
  tick(room, 6);
  press(room, A, 'loan');
  check(R.hp === 40 && room.loanAdd === 415, 'rv: two presses 6 s apart only ask twice');
}

// ---- RV9: never a way to lose ------------------------------------------------------------------------------
{
  for (const day of [3, 5]) {
    const { room, ps: [A] } = crew(['Ann'], day);
    let ended = [];
    const fin = room.finish.bind(room);
    room.finish = (...a) => { ended.push(a); return fin(...a); };
    room.phase = 'road';
    room.debug(A, { op: 'rvhit', why: 'beast', amt: 20 });
    tick(room, 0.1);
    room.debug(A, { op: 'rvhp', hp: 0 });
    room.bank = room.due + 50;
    room.clock = 23.98;
    tick(room, 1);
    if (day === 3) check(room.paid && room.phase === 'night' && !ended.length && room.rvc.hp === 0,
      'rv: day 3, broken down at 23:59 with the money in the bank: midnight pays and the night begins (still broken down)');
    else check(ended.length === 1 && ended[0][0] === true && room.over?.won && room.stats.rv.end === 0,
      'rv: day 5, broken down with the balloon in the bank: a win (the RV ends the trip at 0%)');
  }
}

// ---- RV10 / RV11: carried over, reset, and told ----------------------------------------------------------------
{
  const { room, ps: [A] } = crew(['Ann']);
  A.seat = 0;
  room.debug(A, { op: 'rvhit', why: 'crash', dv: 2 + 20 / 3 });
  tick(room, 2.5);
  room.debug(A, { op: 'rvhit', why: 'rock', amt: 3 });
  tick(room, 0.2);
  A.seat = null;
  payUp(room);
  const r = A.conn.last('receipt');
  check(r?.rv && r.rv.hp === 77 && r.rv.today === 23 && r.rv.src.Ann === 20 && r.rv.src.rocks === 3 && r.rv.quote.pts === 23 && r.rv.quote.cash === C.repairQuote(1, 77).cash,
    `rv: the night's receipt: RV ${r?.rv?.hp}%, -${r?.rv?.today}% today (${JSON.stringify(r?.rv?.src)}), Gus's quote ${r?.rv?.quote?.pts}% for $${r?.rv?.quote?.cash}`);
  room.nextDay();
  tick(room, 0.2);
  check(room.rvc.hp === 77 && room.sim.rvMods.band === 'FINE' && room.dayStats.rv.dmg === 0, `rv: it wakes up as it went to bed: ${room.rvc.hp}% on day 2, today's damage back to 0`);
  room.debug(A, { op: 'rvhp', hp: 50 });
  room.nextDay();
  tick(room, 0.2);
  check(room.rvc.hp === 50 && room.sim.rvMods.band === 'SMOKING' && room.sim.rvMods.top === 0.92, 'rv: a smoking RV is still smoking the next morning (the new day\'s physics knows)');
  // a missed payment: the game-over carries the trip's RV
  room.bank = 0;
  room.phase = 'road';
  room.clock = 23.99;
  tick(room, 1);
  const o = A.conn.last('over');
  check(o && !o.won && o.stats.rv && o.stats.rv.end === 50 && o.stats.rv.dmg === 23 && o.stats.rv.crashes === 1 && o.stats.rv.worst?.by === 'Ann' && o.stats.rv.worst?.amt === 20,
    `rv: the game-over's stats carry the RV: ended at ${o?.stats?.rv?.end}%, -${o?.stats?.rv?.dmg}% all told, ${o?.stats?.rv?.crashes} crash, the worst ${o?.stats?.rv?.worst?.by}'s ${o?.stats?.rv?.worst?.amt}%`);
  tick(room, 4);
  check(room.phase === 'camp' && room.day === 1 && room.rvc.hp === 100 && room.sim.rvMods.band === 'FINE' && room.stats.rv.dmg === 0 && room.loanAdd === 0,
    'rv: a new trip, a new RV: 100%, nothing owed');
}

if (failed) { console.error('\nRV TESTS FAILED'); process.exit(1); }
console.log('\nall RV tests passed');
process.exit(0);
