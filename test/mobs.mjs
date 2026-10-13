// Wildlife and the rules around it, in process (Room + Sim with fake connections, fixed 1/60 s ticks): the
// shove, why a knock happened (and who pays for it), and the mobs themselves.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { toWorld } = await import('../shared/rv.js');

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
  has(pred) { return this.sent.some(pred); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * C.SIM_HZ); i++) room.tick(1 / C.SIM_HZ); };
const evs = (conn, k) => conn.sent.filter(m => m.t === 'ev').flatMap(m => m.list).filter(e => e.k === k);
// a crew in a fresh room, parked in camp (nobody drives: the RV sits on its handbrake)
function crew(names, seed = 4242) {
  const room = new Room('MOBS', seed);
  const ps = names.map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  tick(room, 0.2);
  return { room, ps };
}
// stand a player on the ground at (x, z), facing yaw (0: +z)
const stand = (room, p, x, z, yaw = 0, f = 0) => room.onPose(p, { x, y: room.W.heightAt(x, z), z, yaw, pitch: 0, m: C.MODE.WALK, f, v: [0, 0, 0] });
// ride: a pose in the RV's frame
const ride = (room, p, lx, lz, yaw = 0, f = 0) => room.onPose(p, { par: 1, x: lx, y: 0.05, z: lz, yaw, pitch: 0, m: C.MODE.WALK, f, v: [0, 0, 0] });
// open ground in camp, off to the side of the RV
const spot = room => { const c = room.W.camp.rv; return { x: c.x + 9, z: c.z - 4 }; };

// ---- why a knock happened, and who pays ------------------------------------------------------------------
{
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  const s = spot(room);
  stand(room, A, s.x, s.z); stand(room, B, s.x + 2, s.z);
  const bank = room.bank;
  room.sim.out.push({ k: 'knock', id: B.id, v: [0, 6, 0], ko: true, why: 'mob' });
  tick(room, 1 / 60);
  const kn = B.conn.last('knock');
  check(kn && kn.why === 'mob' && kn.ko === true && room.bank === bank && !evs(A.conn, 'bill').length,
    `knocks: wildlife knocking someone out sends why 'mob' and bills nothing (bank ${bank} -> ${room.bank})`);
  check(evs(A.conn, 'thud').some(e => e.id === B.id && e.why === 'mob'), 'knocks: the crew hears the thud, with its cause');
  // waking up alone after it costs only the usual doctor's bill
  room.handle(B, { t: 'ko', why: 'mob' });
  check(A.conn.has(m => m.t === 'toast' && /Bob got tossed by the Grumphorn/.test(m.text)), 'knocks: the KO toast says the Grumphorn tossed them');
  const b2 = room.bank;
  room.handle(B, { t: 'wake' });
  check(room.bank === b2 - C.medBill(room.day), `knocks: waking up alone after a mob KO bills only the doctor (${b2 - room.bank} = medBill ${C.medBill(room.day)})`);
  // regression: your own RV running a friend over still bills $500 and names the driver
  A.seat = 0;
  const b3 = room.bank;
  room.sim.out.push({ k: 'knock', id: B.id, v: [3, 6, 0], ko: true, why: 'rv' });
  tick(room, 1 / 60);
  check(room.bank === b3 - C.RV_HIT_BILL && A.conn.has(m => m.t === 'toast' && /Ann ran over Bob\. \$500/.test(m.text)) && B.conn.last('knock').why === 'rv',
    `knocks: the RV running a friend over still bills ${C.RV_HIT_BILL} and names the driver`);
  A.seat = null;
  // someone already down isn't stood back up by a knock (their page would make them walk again)
  room.handle(B, { t: 'ko', why: 'fall' });
  const n = B.conn.all('knock').length;
  room.sim.out.push({ k: 'knock', id: B.id, v: [0, 4, 0], ko: false, why: 'shove', by: A.id });
  tick(room, 1 / 60);
  check(B.conn.all('knock').length === n, 'knocks: a player who is down gets no further knocks');
}

// ---- the shove -----------------------------------------------------------------------------------------
{
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  const s = spot(room);
  stand(room, A, s.x, s.z, 0); stand(room, B, s.x, s.z + 1.6); stand(room, Cc, s.x + 6, s.z);
  tick(room, 0.1);
  room.handle(A, { t: 'shove' });
  tick(room, 1 / 60);
  const k = B.conn.last('knock');
  check(k && k.why === 'shove' && k.ko === false && k.rel === 0 && k.v[2] > 3 && k.v[1] > 1 && !Cc.conn.last('knock'),
    `shove: a friend in front gets a knock along your look (${JSON.stringify(k?.v)}), never a KO; a friend off to the side gets nothing`);
  check(evs(A.conn, 'shove').some(e => e.by === A.id && e.hit === 1), 'shove: the crew hears it, and that it hit');
  // spam: ten in one tick are one shove
  const n0 = B.conn.all('knock').length;
  tick(room, 0.6);
  for (let i = 0; i < 10; i++) room.handle(A, { t: 'shove' });
  tick(room, 1 / 60);
  check(B.conn.all('knock').length - n0 === 1, `shove: ten in one tick knock once (${B.conn.all('knock').length - n0})`);
  // facing away: nothing
  tick(room, 0.6);
  stand(room, A, s.x, s.z, Math.PI);
  const n1 = B.conn.all('knock').length;
  room.handle(A, { t: 'shove' });
  tick(room, 1 / 60);
  check(B.conn.all('knock').length === n1, 'shove: nothing behind you');
  // a friend who is down: nothing
  tick(room, 0.6);
  stand(room, A, s.x, s.z, 0);
  room.handle(B, { t: 'ko', why: 'fall' });
  const n2 = B.conn.all('knock').length;
  room.handle(A, { t: 'shove' });
  tick(room, 1 / 60);
  check(B.conn.all('knock').length === n2, 'shove: a friend who is down gets nothing');
  room.handle(B, { t: 'wake' });
  // loot in front gets a push; the boulder or the map don't move
  tick(room, 0.6);
  stand(room, B, s.x + 20, s.z + 20);
  const vase = room.sim.addProp('vase', { x: s.x, y: room.W.heightAt(s.x, s.z + 1.2) + 0.4, z: s.z + 1.2 }, { x: 0, y: 0, z: 0, w: 1 }, 300, 300);
  tick(room, 0.5);
  const v0 = vase.body.translation();
  room.handle(A, { t: 'shove' });
  tick(room, 0.3);
  const v1 = room.sim.props.get(vase.id)?.body.translation();
  check(v1 && v1.z - v0.z > 0.4, `shove: loot in front is pushed away (${v1 ? (v1.z - v0.z).toFixed(2) : 'broke'} m)`);
  // the shover's fall later: a KO from a fall within 3 s of a shove names the shover
  tick(room, 0.6);
  stand(room, B, s.x, s.z + 1.6);
  room.handle(A, { t: 'shove' });
  tick(room, 0.5);
  room.handle(B, { t: 'ko', why: 'fall' });
  check(A.conn.has(m => m.t === 'toast' && /Bob ate dirt \(Ann shoved them\)/.test(m.text)), 'shove: a fall right after a shove names the shover');
  room.handle(B, { t: 'wake' });
}
{
  // riders: the knock rides on the RV's motion (rel), and walls stop a shove from outside
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  ride(room, A, 0, -2.2, 0); ride(room, B, 0, -0.6, 0);
  tick(room, 0.2);
  room.handle(A, { t: 'shove' });
  tick(room, 1 / 60);
  const k = B.conn.last('knock');
  check(k && k.why === 'shove' && k.rel === 1, 'shove: a friend riding the RV gets a knock relative to the RV (rel 1)');
  // Cat outside the left wall, Bob just inside it, Cat facing him: the wall is in the way
  const rp = room.sim.rv.translation(), rq = room.sim.rv.rotation();
  const out = toWorld(rp, rq, { x: 2.3, y: 0, z: -0.6 });
  const yaw = Math.atan2(toWorld(rp, rq, { x: 0, y: 0, z: -0.6 }).x - out.x, toWorld(rp, rq, { x: 0, y: 0, z: -0.6 }).z - out.z);
  stand(room, Cc, out.x, out.z, yaw);
  tick(room, 0.6);
  const n = B.conn.all('knock').length;
  room.handle(Cc, { t: 'shove' });
  tick(room, 1 / 60);
  check(B.conn.all('knock').length === n, 'shove: not through the RV\'s wall');
  // seated players can't shove, and aren't shoved
  A.seat = 0;
  const n2 = B.conn.all('knock').length;
  room.handle(A, { t: 'shove' });
  tick(room, 1 / 60);
  check(B.conn.all('knock').length === n2, 'shove: nobody shoves from a seat');
  A.seat = null;
}

// ---- the plumbing: critters are props with a state, kept out of everything loot does --------------------------
const { Sim } = await import('../server/sim.js');
const { generateLeg } = await import('../shared/world.js');
const { RV_WHEELS } = await import('../shared/rv.js');
const { GROUPS } = await import('../server/groups.js');
const mobAt = (room, A, type, x, z, extra = {}) => { room.debug(A, { op: 'mob', type, x, z, ...extra }); return A.conn.last('dbg')?.id; };
{
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
  const w = toWorld(rp, rq, { x: 0, y: 0.35, z: -1.5 }), wv = toWorld(rp, rq, { x: 0, y: 0.45, z: 0.6 });
  const id = mobAt(room, A, 'ringtail', w.x, w.z, { y: w.y });
  const vase = sim.addProp('vase', wv, { x: 0, y: 0, z: 0, w: 1 }, 300, 300);
  tick(room, 0.5);
  const tied = sim.tieDown(), carry = sim.carryOver();
  check(id != null && tied === 1 && sim.tied.has(vase.id) && !sim.tied.has(id), `plumbing: the bungee ties the vase in the RV, not the ringtail beside it (${tied} tied)`);
  check(carry.length === 1 && carry[0].type === 'vase', `plumbing: only the vase rides into tomorrow (${carry.map(c => c.type)})`);
  const t = sim.props.get(id).body.translation();
  check(!sim.propsIn({ x: t.x, z: t.z, y: t.y - 0.3, hx: 2, hz: 2 }).includes(id) && !sim.cargo().includes(id), 'plumbing: a ringtail is never sold or counted as cargo');
  // the wire: a critter's snapshot entry carries its state (a 9th element), loot's doesn't; joiners get it too
  const snap = sim.snapshot(true);
  const me = snap.props.find(e => e[0] === id), ve = snap.props.find(e => e[0] === vase.id);
  check(me?.length === 9 && ve?.length === 8 && sim.describe(sim.props.get(id)).st === 0 && sim.describe(vase).st === undefined,
    'plumbing: a critter\'s snapshot entry and description carry its state; loot\'s don\'t');
  check(evs(A.conn, 'spawn').some(e => e.p.id === id && e.p.type === 'ringtail'), 'plumbing: a new critter is announced like any spawned prop');
  // nightfall: one 'gone' event with every critter, and none left
  const id2 = mobAt(room, A, 'grumphorn', t.x + 12, t.z + 6);
  tick(room, 0.1);
  room.phase = 'road';
  room.beginNight();
  tick(room, 1 / 60);
  const gone = evs(A.conn, 'gone');
  check(gone.length === 1 && gone[0].ids.includes(id) && gone[0].ids.includes(id2) && ![...sim.props.values()].some(p => p.mob) && sim.mobs === null && sim.mobsDone,
    `plumbing: nightfall sends one 'gone' with every critter and leaves none (${JSON.stringify(gone.map(g => g.ids))})`);
  tick(room, 0.5);
  check(!sim.mobs, 'plumbing: the wildlife doesn\'t come back the same night');
}
{
  // the day's cast starts when the RV leaves camp (and FRIENDSLOP_NOMOBS / the lever keeps it away)
  const { room } = crew(['Ann']);
  check(!room.sim.mobs, 'plumbing: no wildlife in camp');
  room.phase = 'road';
  tick(room, 0.1);
  check(room.sim.mobs?.started === true, 'plumbing: the wildlife starts once the road does');
  const r2 = crew(['Bob']).room;
  r2.mobsOn = false; r2.phase = 'road';
  tick(r2, 0.1);
  check(!r2.sim.mobs, 'plumbing: with the wildlife switched off, none starts');
}
{
  // a critter in the RV's wheel track: the wheels don't climb it (riders feel nothing); it stays finite
  const W = generateLeg(4242, 1);
  const sim = new Sim(W);
  for (const g of W.gates) sim.openGate(g.id);
  const z0 = 120;
  sim.placeRV(W.roadX(z0), z0, Math.atan2(W.roadX(z0 + 5) - W.roadX(z0), 5));
  const players = new Map();
  for (let i = 0; i < 30; i++) sim.step(1 / 60, players);
  const steer = () => { const p = sim.rv.translation(), q = sim.rv.rotation(); const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y); const ahead = p.z + 10, tx = W.roadX(ahead) - p.x, tz = ahead - p.z; return Math.max(-1, Math.min(1, -Math.atan2(fx * tz - fz * tx, fx * tx + fz * tz) * 2)); };
  let n = 0;
  while (sim.rvSpeed() < 7 && n++ < 60 * 20) { sim.setDrive({ th: 1, st: steer(), hb: 0 }); sim.step(1 / 60, players); }
  const rp = sim.rv.translation(), rq = sim.rv.rotation();
  const at = toWorld(rp, rq, { x: RV_WHEELS[0][0], y: 0, z: 16 });
  const mb = sim.ensureMobs({ day: 1 }).spawn('ringtail', at.x, at.z);
  const vs = [];
  let peak = 0, finite = true;
  for (let k = 0; k < 60 * 4; k++) {
    sim.setDrive({ th: sim.rvSpeed() < 7 ? 1 : 0, st: steer(), hb: 0 });
    sim.step(1 / 60, players);
    if (k % 3 === 0) vs.push(sim.rv.linvel());
    const t = sim.props.get(mb.id)?.body.translation();
    if (!t || !Number.isFinite(t.x + t.y + t.z)) finite = false;
  }
  // (the riders' lurch: the RV's horizontal change of speed over each 50 ms snapshot span, as the client reads it)
  for (let i = 1; i < vs.length; i++) peak = Math.max(peak, Math.hypot(vs[i].x - vs[i - 1].x, vs[i].z - vs[i - 1].z) / 0.05);
  const passed = sim.rvToLocal(sim.props.get(mb.id).body.translation()).z < -4;
  check(passed && peak < 6 && finite, `plumbing: the RV at 7 m/s rolls over a ringtail in its wheel track without a lurch (peak ${peak.toFixed(1)} m/s^2, passed ${passed}, finite ${finite})`);
  // and it does hit a grumphorn standing in the road (no driving through a one-ton beast)
  const rp2 = sim.rv.translation(), rq2 = sim.rv.rotation();
  const at2 = toWorld(rp2, rq2, { x: 0, y: 0, z: 14 });
  const gh = sim.mobs.spawn('grumphorn', at2.x, at2.z, { yaw: Math.PI / 2, st: 8 });   // (8: LEFT, lying there for good: a body, no brain)
  const g0 = sim.props.get(gh.id).body.translation();
  for (let k = 0; k < 60 * 3; k++) { sim.setDrive({ th: 0.6, st: steer(), hb: 0 }); sim.step(1 / 60, players); }
  const g1 = sim.props.get(gh.id).body.translation(), gl = sim.rvToLocal(g1);
  check(Math.hypot(g1.x - g0.x, g1.z - g0.z) > 0.5 && gl.z > 3.5, `plumbing: the RV shoves a grumphorn in its way instead of passing through it (moved ${Math.hypot(g1.x - g0.x, g1.z - g0.z).toFixed(1)} m, ${gl.z.toFixed(1)} m ahead of the RV's middle)`);
  // safety: an item in a critter's jaws breaks (or sells): nothing touches its freed body afterwards
  const t = sim.props.get(mb.id).body.translation();
  const vase = sim.addProp('vase', { x: t.x + 0.4, y: t.y + 0.3, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, 300, 300);
  sim.mobs.bite(sim.mobs.list.get(mb.id), vase.id);
  for (let i = 0; i < 30; i++) sim.step(1 / 60, players);
  const carried = vase.col.collisionGroups() === GROUPS.carried && sim.mobs.list.get(mb.id).carry;
  let threw = null;
  try {
    sim.removeProp(vase.id);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, players);
    sim.snapshot(true);
  } catch (e) { threw = e; }
  check(carried && !threw && !sim.mobs.jaws.size && !sim.mobs.list.get(mb.id).carry, `plumbing: loot that breaks in a critter's jaws leaves the physics running (${threw?.message || 'no error'})`);
  sim.free();
}
{
  // the same seed and the same inputs replay the same wildlife (no Math.random in the brains)
  const run = () => {
    const { room, ps: [A] } = crew(['Ann']);
    room.mobsOn = false;
    const s = spot(room);
    stand(room, A, s.x, s.z - 9, 0);
    const ids = [mobAt(room, A, 'ringtail', s.x + 3, s.z), mobAt(room, A, 'grumphorn', s.x - 4, s.z + 10)];
    tick(room, 30);
    return ids.map(id => { const t = room.sim.props.get(id)?.body.translation(); return t ? [t.x, t.y, t.z].map(v => v.toFixed(4)).join(',') : 'gone'; }).join(' | ');
  };
  const a = run(), b = run();
  check(a === b, `plumbing: the same seed and inputs replay the wildlife exactly (${a})`);
}

// ---- the grumphorn ----------------------------------------------------------------------------------------
const { GST, GH, crewFactor, cowbellValue } = await import('../shared/mobs.js');
const { yawOf } = await import('../server/mobs.js');
// a stretch of open road (z0 m out) and the yaw that faces along it
const roadAt = (room, z) => ({ x: room.W.roadX(z), z, yaw: Math.atan2(room.W.roadX(z + 3) - room.W.roadX(z - 3), 6) });
const mobOf = (room, id) => room.sim.mobs?.list.get(id);
const stOf = (room, id) => mobOf(room, id)?.st;
const knocks = p => p.conn.all('knock');
// drive the RV along the road at about `speed` for `secs` (A at the wheel)
function driveAt(room, A, speed, secs, onTick = null) {
  A.seat = 0;
  const sim = room.sim, W = room.W;
  for (let i = 0; i < Math.round(secs * C.SIM_HZ); i++) {
    const p = sim.rv.translation(), q = sim.rv.rotation();
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y), ahead = p.z + 10, tx = W.roadX(ahead) - p.x, tz = ahead - p.z;
    const st = Math.max(-1, Math.min(1, -Math.atan2(fx * tz - fz * tx, fx * tx + fz * tz) * 2));
    const v = sim.rvSpeed();
    room.handle(A, { t: 'drv', th: v < speed - 0.3 ? 1 : v > speed + 0.6 ? -0.4 : 0, st, hb: 0 });
    room.tick(1 / C.SIM_HZ);
    onTick?.(i);
  }
}
{
  // G1: what wakes it on foot (standing at 7 m: yes; crouched at 2.5 m: no)
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  room.mobsOn = false;
  const r = roadAt(room, 70);
  stand(room, A, r.x, r.z - 40, r.yaw); stand(room, B, r.x + 30, r.z, r.yaw);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw + 1 });
  tick(room, 1);
  check(stOf(room, id) === GST.SLEEP, 'grumphorn: asleep on the road');
  // (beside it: square off its flank, measured from the line down its middle; it's 2.9 m long)
  const yw = r.yaw + 1, sx = Math.cos(yw), sz = -Math.sin(yw);
  stand(room, B, r.x + sx * 3.4, r.z + sz * 3.4, r.yaw, C.FLAG.CROUCH);
  tick(room, 10);
  check(stOf(room, id) === GST.SLEEP, 'grumphorn: crouched beside it (2.7 m from its flank) for 10 s, it sleeps on');
  stand(room, B, r.x + sx * 7, r.z + sz * 7, r.yaw);
  tick(room, 0.2);
  check(stOf(room, id) === GST.RISE && evs(A.conn, 'mob').some(e => e.id === id && e.s === 'wake'), `grumphorn: standing 7 m away wakes it within 0.2 s (${stOf(room, id)})`);
  check(A.conn.has(m => m.t === 'toast' && /Grumphorn is awake/.test(m.text)), 'grumphorn: the crew is told it woke');
}
{
  // G2: the RV creeping past with everyone crouched lets it sleep; going faster wakes it; so does the horn
  for (const [speed, wakes] of [[2.5, false], [4.2, true]]) {
    const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
    room.mobsOn = false;
    const sim = room.sim, W = room.W;
    sim.placeRV(W.roadX(40), 40, Math.atan2(W.roadX(43) - W.roadX(37), 6));
    const r = roadAt(room, 75);
    const id = mobAt(room, A, 'grumphorn', r.x - 4.2, r.z, { yaw: r.yaw });
    ride(room, B, 0, -1.5, 0, C.FLAG.CROUCH);
    driveAt(room, A, speed, 26, () => ride(room, B, 0, -1.5, 0, C.FLAG.CROUCH));
    const passed = sim.rv.translation().z > r.z + 8;
    check(passed && (stOf(room, id) !== GST.SLEEP) === wakes, `grumphorn: the RV going by 4 m off at ${speed} m/s with the crew crouched ${wakes ? 'wakes' : 'doesn\'t wake'} it (state ${stOf(room, id)}, passed ${passed})`);
  }
  {
    const { room, ps: [A] } = crew(['Ann']);
    room.mobsOn = false;
    const rp = room.sim.rv.translation();
    const r = roadAt(room, rp.z + 35);
    const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw + 1 });
    tick(room, 0.5);
    A.seat = 0;
    room.handle(A, { t: 'horn' });
    tick(room, 0.2);
    check(stOf(room, id) !== GST.SLEEP, `grumphorn: the horn 35 m away wakes it (state ${stOf(room, id)})`);
  }
}
{
  // G3: two players side by side in its path: one is knocked out (no bill), the other stumbles
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  room.mobsOn = false;
  const r = roadAt(room, 70);
  stand(room, Cc, r.x + 40, r.z - 40, 0);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw });
  tick(room, 0.5);
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw), sx = Math.cos(r.yaw), sz = -Math.sin(r.yaw);
  stand(room, A, r.x + fx * 6 + sx * 0.5, r.z + fz * 6 + sz * 0.5, r.yaw + Math.PI);
  stand(room, B, r.x + fx * 6 - sx * 0.5, r.z + fz * 6 - sz * 0.5, r.yaw + Math.PI);
  const bank = room.bank;
  for (let i = 0; i < 60 * 8 && !knocks(A).length && !knocks(B).length; i++) tick(room, 1 / 60);
  tick(room, 0.3);
  const all = [...knocks(A), ...knocks(B)];
  const kos = all.filter(k => k.ko), stumbles = all.filter(k => !k.ko);
  check(kos.length === 1 && kos[0].why === 'mob' && stumbles.length <= 1 && room.bank === bank,
    `grumphorn: a charge knocks out one of two side by side (KOs ${kos.length}, stumbles ${stumbles.length}), and bills nothing (bank ${bank} -> ${room.bank})`);
  check(evs(Cc.conn, 'mob').some(e => e.id === id && e.s === 'toss'), 'grumphorn: the crew hears the toss');
}
{
  // G4: someone down, and whoever kneels by them, is left alone
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  room.mobsOn = false;
  const r = roadAt(room, 70);
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  stand(room, A, r.x + 50, r.z - 50, 0);
  stand(room, B, r.x + fx * 6, r.z + fz * 6, r.yaw + Math.PI);
  stand(room, Cc, r.x + fx * 6 + 1.5, r.z + fz * 6, r.yaw + Math.PI);
  room.handle(B, { t: 'ko', why: 'fall' });
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.ROAM });
  tick(room, 12);
  check(!knocks(B).length && !knocks(Cc).length && !evs(A.conn, 'mob').some(e => e.id === id && (e.s === 'glare' || e.s === 'charge')),
    `grumphorn: it never goes for a player who is down, or the friend kneeling by them (state ${stOf(room, id)})`);
}
{
  // G5: crew of 3, day 2: ramming it at 5 m/s+ uses up its patience at once: it drops its cowbell ($205 on day
  // 2), walks off the road to where it lies down for good, and then nothing wakes it
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  room.mobsOn = false;
  room.day = 2;
  const sim = room.sim, W = room.W;
  sim.placeRV(W.roadX(20), 20, Math.atan2(W.roadX(23) - W.roadX(17), 6));
  stand(room, B, W.roadX(10) + 9, 10, 0); stand(room, Cc, W.roadX(10) + 10, 10, 0);
  const r = roadAt(room, 80);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw + Math.PI / 2 });
  const m = mobOf(room, id);
  check(Math.abs(m.patience - GH.PATIENCE * crewFactor(3)) < 1e-6, `grumphorn: a crew of 3 meets it at ${m.patience} patience`);
  let leftAt = null;
  driveAt(room, A, 7.5, 16, i => { if (leftAt == null && m.st === GST.LEAVE) leftAt = i / 60; });
  const bell = [...sim.props.values()].find(p => p.type === 'cowbell');
  check(leftAt != null && bell && bell.value === cowbellValue(2) && bell.value === 205, `grumphorn: rammed, it gives up and drops a $${bell?.value} cowbell`);
  A.seat = null;
  tick(room, 30);
  const t = sim.props.get(id).body.translation(), ex = m.bed.exit || { x: m.bed.x + 8, z: m.bed.z };
  check(m.st === GST.LEFT, `grumphorn: it walks off the road and lies down for good (state ${m.st}, ${Math.hypot(t.x - ex.x, t.z - ex.z).toFixed(1)} m from its spot)`);
  stand(room, B, t.x + 2, t.z, 0);
  tick(room, 3);
  check(m.st === GST.LEFT, 'grumphorn: once it has left, standing right by it doesn\'t wake it');
}
{
  // G7: a crew of 4 feeding it one standing player after another: it knocks out at most 3 before it leaves
  const { room, ps } = crew(['Ann', 'Bob', 'Cat', 'Dee']);
  room.mobsOn = false;
  const [A] = ps;
  const r = roadAt(room, 70);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.ROAM });
  const m = mobOf(room, id);
  let kos = 0;
  for (let round = 0; round < 8 && m.st !== GST.LEAVE && m.st !== GST.LEFT; round++) {
    for (const p of ps) if (p.ko) { room.handle(p, { t: 'wake' }); }
    const t = room.sim.props.get(id).body.translation(), yaw = Math.atan2(t.x - r.x, t.z - r.z);
    const vict = ps[round % ps.length];
    for (const p of ps) if (p !== vict) stand(room, p, t.x + 40 + ps.indexOf(p) * 3, t.z - 40, 0);
    const yw = yawOf(room.sim.props.get(id).body.rotation());
    stand(room, vict, t.x + Math.sin(yw) * 6, t.z + Math.cos(yw) * 6, yw + Math.PI);
    const seen = knocks(vict).length;
    for (let i = 0; i < 60 * 10; i++) {
      tick(room, 1 / 60);
      const k = knocks(vict).slice(seen).find(x => x.ko);
      if (k && !vict.ko) { kos++; room.handle(vict, { t: 'ko', why: 'mob' }); break; }
      if (m.st === GST.LEAVE) break;
    }
  }
  check(kos <= 3 && (m.st === GST.LEAVE || m.st === GST.LEFT), `grumphorn: a crew of 4 loses at most 3 to it before it leaves (${kos} KOs, state ${m.st})`);
}
{
  // G8 / G9: patience: reeled in by the winch (6 a second), a TV thrown at it (about 20), a gnome (5 or less)
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim;
  const r = roadAt(room, 70);
  stand(room, A, r.x + 30, r.z - 30, 0);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw + 1 });
  const m = mobOf(room, id);
  tick(room, 0.5);
  const throwAt = (type) => {
    const t = sim.props.get(id).body.translation();
    const from = { x: t.x - 3.2, y: t.y + 0.4, z: t.z };
    const pr = sim.addProp(type, from, { x: 0, y: 0, z: 0, w: 1 }, 200, 200);
    const mass = pr.body.mass(), imp = Math.min(mass * C.GRAB.THROW, C.GRAB.THROW_IMPULSE_CAP);
    pr.body.applyImpulse({ x: imp, y: imp * 0.12, z: 0 }, true);
    const p0 = m.patience;
    tick(room, 0.8);
    return p0 - m.patience;
  };
  // a shove reaches its flank (2 m off, its middle nearer 3): it costs it a little patience and wakes it
  {
    const t = sim.props.get(id).body.translation(), yw = yawOf(sim.props.get(id).body.rotation());
    const sx = Math.cos(yw), sz = -Math.sin(yw);   // square off its flank
    stand(room, A, t.x + sx * 2.65, t.z + sz * 2.65, Math.atan2(-sx, -sz));
    tick(room, 0.2);
    const p0 = m.patience;
    room.handle(A, { t: 'shove' });
    tick(room, 1 / 60);
    check(p0 - m.patience >= GH.COST.shove - 1e-9 && m.st !== GST.SLEEP, `grumphorn: a shove from 2 m off its flank reaches it (patience ${p0} -> ${m.patience}, state ${m.st})`);
    stand(room, A, r.x + 30, r.z - 30, 0);
    m.st = GST.ROAM; m.stAt = room.t; m.patience = p0;
  }
  const tv = throwAt('tv');
  m.st = GST.ROAM; m.stAt = room.t;   // (not winded: that would double it)
  const gnome = throwAt('gnome');
  check(tv >= 15 && tv <= 25 && gnome <= 5, `grumphorn: a thrown TV costs it ${tv.toFixed(1)} patience (15-25), a gnome ${gnome.toFixed(1)} (5 or less)`);
  // the winch, clipped on and reeling
  // (clipped where it stands, the cable just taut: the way anchorHook leaves it)
  const hp = sim.props.get(id).body.translation(), wp = sim.winchWorld();
  Object.assign(sim.hook, { state: 'anchored', body: null, anchor: null, attach: { id, local: { x: 0, y: 0, z: 0 } }, holder: null, reeling: true, len: Math.hypot(hp.x - wp.x, hp.y - wp.y, hp.z - wp.z) + 0.2 });
  m.st = GST.ROAM; m.stAt = room.t;
  const p0 = m.patience;
  tick(room, 2);
  check(p0 - m.patience >= 10, `grumphorn: reeled in by the winch it loses ${((p0 - m.patience) / 2).toFixed(1)} patience a second (5+)`);
}
{
  // G6: day 3, its bed behind the ranger gate: woken from the near side it can't get through; once the gate
  // is open it comes for you
  const { room, ps: [A] } = crew(['Ann']);
  room.debug(A, { op: 'day', d: 3 });
  tick(room, 0.2);
  room.phase = 'road';
  tick(room, 0.2);
  const bed = room.W.beds?.[0], gate = room.W.obstacles.find(o => o.type === 'gate');
  const m = room.sim.mobs && [...room.sim.mobs.list.values()].find(x => x.type === 'grumphorn');
  check(bed && gate && m && bed.z > gate.z, `grumphorn: day 3's sleeps behind the ranger gate (bed ${bed?.z.toFixed(1)}, gate ${gate?.z})`);
  if (m) {
    stand(room, A, room.W.roadX(gate.z - 1), gate.z - 1, 0);
    tick(room, 20);
    const z = room.sim.props.get(m.id).body.translation().z;
    check(m.st !== GST.SLEEP && z > gate.z, `grumphorn: woken through the bars, it stays behind them (z ${z.toFixed(1)} past the gate at ${gate.z})`);
    room.sim.openGate(gate.gate);
    const n0 = evs(A.conn, 'mob').filter(e => e.id === m.id && e.s === 'glare').length;
    tick(room, 3);
    check(evs(A.conn, 'mob').filter(e => e.id === m.id && e.s === 'glare').length > n0, 'grumphorn: with the gate open, it comes for you within 3 s');
  }
}

// ---- world gen: the wildlife is placed last, from its own random stream: nothing else moves ---------------------
{
  const { PLAN } = await import('../shared/mobs.js');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const bad = [];
  for (const seed of [4242, 7, 777]) for (let day = 1; day <= 5; day++) {
    const W = generateLeg(seed, day), O = generateLeg(seed, day, { mobs: false });
    for (const k of ['pois', 'obstacles', 'statics', 'cyls', 'hulls', 'uses', 'anchors', 'gates', 'mud', 'landmarks']) if (!same(W[k], O[k])) bad.push(`${seed}/${day} ${k}`);
    if (W.heights.length !== O.heights.length || W.heights.some((h, i) => h !== O.heights[i])) bad.push(`${seed}/${day} heights`);
    for (const k of ['signs', 'decor', 'props']) if (!same(W[k].slice(0, O[k].length), O[k])) bad.push(`${seed}/${day} ${k} prefix`);
    const maxOld = Math.max(0, ...O.props.map(p => p.id));
    if (W.props.slice(O.props.length).some(p => p.id <= maxOld)) bad.push(`${seed}/${day} new prop ids`);
    if (W.beds.length !== PLAN[day - 1].beds.length) bad.push(`${seed}/${day} ${W.beds.length} beds`);
    for (const b of W.beds) {
      if (Math.abs(b.x - W.roadX(b.z)) > 1) bad.push(`${seed}/${day} bed off the road`);
      const o = W.obstacles.find(q => q.type === b.ob);
      if (!o || b.z <= o.z) bad.push(`${seed}/${day} bed not past its ${b.ob}`);
      if (Math.abs(b.exit.x - W.roadX(b.exit.z)) < 6) bad.push(`${seed}/${day} the way off the road is on it`);
    }
    if (O.dens.length || O.beds.length) bad.push(`${seed}/${day} {mobs:false} still has wildlife`);
  }
  check(!bad.length, `world gen: the wildlife changes nothing else (3 seeds x 5 days), beds sit on the road past their obstacle${bad.length ? ': ' + bad.slice(0, 6).join('; ') : ''}`);
}

if (failed) { console.error('\nSome wildlife checks FAILED'); process.exit(1); }
console.log('\nAll wildlife checks passed');
process.exit(0);
