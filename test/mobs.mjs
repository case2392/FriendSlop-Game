// Wildlife and the rules around it, in process (Room + Sim with fake connections, fixed 1/60 s ticks): the
// shove, why a knock happened (and who pays for it), and the mobs themselves.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { toWorld, qRotate, insideRV } = await import('../shared/rv.js');

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
const { yawOf, yawQ } = await import('../server/mobs.js');
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
  stand(room, A, r.x + fx * 6, r.z + fz * 6, r.yaw + Math.PI);
  stand(room, B, r.x + 30, r.z - 30, 0);
  const bank = room.bank;
  // (Bob steps in beside Ann once its line is fixed on her: both are in its horns at once)
  for (let i = 0; i < 60 * 8 && !evs(A.conn, 'mob').some(e => e.id === id && e.s === 'charge'); i++) tick(room, 1 / 60);
  stand(room, B, r.x + fx * 6 + sx * 0.8, r.z + fz * 6 + sz * 0.8, r.yaw + Math.PI);
  for (let i = 0; i < 60 * 4 && !(knocks(A).length && knocks(B).length); i++) tick(room, 1 / 60);
  tick(room, 0.3);
  const all = [...knocks(A), ...knocks(B)];
  const kos = all.filter(k => k.ko), stumbles = all.filter(k => !k.ko);
  check(kos.length === 1 && kos[0].why === 'mob' && stumbles.length === 1 && room.bank === bank,
    `grumphorn: two in its horns at once: one is knocked out, the other stumbles (KOs ${kos.length}, stumbles ${stumbles.length}), and it bills nothing (bank ${bank} -> ${room.bank})`);
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
  // G-exit: out of patience on the wrong side of the boulder (its charges took it back down the road, and the
  // boulder's still there), it can't get back to its own way off: it takes the nearest, off the road all the
  // same (the soak's own case: seed 80190's day 5, a fake player walking up to each beast for a minute)
  const { soakBeds } = await import('../tools/mobsoak.mjs');
  const r = soakBeds(80190, 5);
  check(r.length === 2 && r.every(b => b.st === GST.LEFT && b.fromExit <= 1.2 && b.fromRoad >= 6.5) && r.some(b => b.replan),
    `grumphorn: out of patience, each lies down by its way off the road, clear of it (${r.map(b => `${b.ob}: ${b.fromExit.toFixed(2)} m from it, ${b.fromRoad.toFixed(1)} m off the road${b.replan ? ', the nearest way off from behind the boulder' : ''}`).join('; ')})`);
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

{
  // safety: a push still in flight when nightfall takes the beast away touches nothing that's been freed
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const r = roadAt(room, 70);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.LEFT });
  tick(room, 0.3);
  const t = room.sim.props.get(id).body.translation();
  stand(room, A, t.x - 2.2, t.z, Math.PI / 2);
  tick(room, 1 / 60);
  room.handle(A, { t: 'push', kind: 'prop', id, pt: [t.x - 1.2, t.y, t.z], dir: [1, 0, 0] });
  const pending = room.sim.pushes.length;
  room.phase = 'road';
  room.beginNight();
  let threw = null;
  try { tick(room, 2); room.snapshot(); } catch (e) { threw = e; }
  check(pending === 1 && !threw && !room.sim.props.has(id), `grumphorn: a push still in flight at nightfall, when it's taken away, breaks nothing (${threw?.message || 'no error'})`);
}
// patience billed to it: (the amounts charged, before a winded beast's doubling)
const billed = (room, fn) => { const M = room.sim.mobs, f = M.ghCost.bind(M), log = []; M.ghCost = (m, p, n) => { log.push(n); return f(m, p, n); }; fn(); M.ghCost = f; return log.reduce((a, b) => a + b, 0); };
{
  // things touching it cost patience once per hit, by the momentum they bring: the boulder shoved into it at
  // a walk costs 40 at most; a TV left leaning on it, or a safe it walks into, nothing
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim, r = roadAt(room, 70);
  stand(room, A, r.x + 40, r.z - 40, 0);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.ROAM });
  const m = mobOf(room, id);
  tick(room, 1);
  const t = sim.props.get(id).body.translation(), yw = yawOf(sim.props.get(id).body.rotation()), sx = Math.cos(yw), sz = -Math.sin(yw);
  // (the boulder 0.5 m off its flank, rolling at it at 1 m/s)
  const bd = sim.addProp('boulder', { x: t.x + sx * 2.95, y: room.W.heightAt(t.x + sx * 2.95, t.z + sz * 2.95) + 1.35, z: t.z + sz * 2.95 }, yawQ(yw), 0, 0);
  const boulder = billed(room, () => { sim.props.get(bd.id).body.setLinvel({ x: -sx, y: 0, z: -sz }, true); for (let i = 0; i < 120; i++) { const b = sim.props.get(bd.id)?.body; if (b && i < 60) { const v = b.linvel(); b.setLinvel({ x: -sx, y: v.y, z: -sz }, true); } tick(room, 1 / 60); } });
  sim.removeProp(bd.id);
  m.st = GST.ROAM; m.stAt = room.t;
  tick(room, 0.5);
  const t2 = sim.props.get(id).body.translation();
  const tv = sim.addProp('tv', { x: t2.x - sx * 0.95, y: t2.y + 0.2, z: t2.z - sz * 0.95 }, { x: 0, y: 0, z: 0, w: 1 }, 200, 200);
  const lean = billed(room, () => tick(room, 3));
  sim.removeProp(tv.id);
  // a safe in its way as it walks off toward a noise
  m.st = GST.ROAM; m.stAt = room.t;
  const t3 = sim.props.get(id).body.translation(), fx = Math.sin(yw), fz = Math.cos(yw);
  sim.addProp('safe', { x: t3.x + fx * 2.6, y: room.W.heightAt(t3.x + fx * 2.6, t3.z + fz * 2.6) + 0.45, z: t3.z + fz * 2.6 }, yawQ(yw), 300, 300);
  m.noise = { x: t3.x + fx * 12, y: t3.y, z: t3.z + fz * 12 };
  const safe = billed(room, () => tick(room, 3));
  check(boulder > 0 && boulder <= GH.COST.propCap + 1e-6 && lean < 1 && safe < 1, `grumphorn: the boulder rolled into it costs ${boulder.toFixed(1)} patience (40 at most), a TV leaning on it ${lean.toFixed(1)}, walking into a safe ${safe.toFixed(1)}`);
}
{
  // the horn wakes it, and with nobody on foot it goes for the RV (parked: ramming it costs only the charge)
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
  const ahead = toWorld(rp, rq, { x: 0, y: 0, z: 12 });
  const id = mobAt(room, A, 'grumphorn', ahead.x, ahead.z, { yaw: Math.atan2(rp.x - ahead.x, rp.z - ahead.z) + 1.2 });
  const m = mobOf(room, id);
  tick(room, 0.5);
  A.seat = 0;
  const p0 = m.patience;
  room.handle(A, { t: 'horn' });
  for (let i = 0; i < 60 * 8 && m.st !== GST.WINDED; i++) tick(room, 1 / 60);
  const said = s => evs(A.conn, 'mob').some(e => e.id === id && e.s === s);
  check(said('glare') && said('charge') && m.st === GST.WINDED && Math.abs(p0 - m.patience - GH.COST.charge) < 1e-6,
    `grumphorn: honked at from the RV, it glares at the RV and charges it (patience ${p0} -> ${m.patience}: the charge's ${GH.COST.charge}, nothing for the parked RV)`);
  A.seat = null;
}
{
  // whoever revives a friend is left alone, from as far as a revive reaches (3.5 m)
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  room.mobsOn = false;
  const r = roadAt(room, 70);
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  stand(room, A, r.x + 50, r.z - 50, 0);
  stand(room, B, r.x + fx * 7, r.z + fz * 7, r.yaw + Math.PI);
  stand(room, Cc, r.x + fx * 7 + 3.4, r.z + fz * 7, r.yaw + Math.PI);
  room.handle(B, { t: 'ko', why: 'fall' });
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.ROAM });
  tick(room, 12);
  check(!knocks(Cc).length && !evs(A.conn, 'mob').some(e => e.id === id && e.s === 'charge'), `grumphorn: a friend reviving from 3.4 m away is left alone (state ${stOf(room, id)})`);
}
{
  // a hand on its horns as it charges doesn't stop the toss
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const r = roadAt(room, 70);
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.ROAM });
  stand(room, A, r.x + fx * 8, r.z + fz * 8, r.yaw + Math.PI);
  let grabbed = false;
  for (let i = 0; i < 60 * 10 && !knocks(A).some(k => k.ko); i++) {
    tick(room, 1 / 60);
    const t = room.sim.props.get(id).body.translation();
    if (!grabbed && stOf(room, id) === GST.CHARGE && Math.hypot(t.x - A.pos.x, t.z - A.pos.z) < 3.2) {
      room.handle(A, { t: 'grab', kind: 'prop', id, pt: [t.x, t.y, t.z], d: 2 });
      grabbed = A.conn.last('grabbed')?.ok;
    }
  }
  check(grabbed && knocks(A).some(k => k.ko && k.why === 'mob'), `grumphorn: grabbing its horns as it charges doesn't save you (grabbed ${grabbed}, tossed ${knocks(A).some(k => k.ko)})`);
}
{
  // it has had enough while someone holds its horns: they're told they let go; its cowbell drops clear of its
  // hooves (it isn't trampled as it slides to a stop out of a charge)
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  room.day = 2;
  const sim = room.sim, r = roadAt(room, 70);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.ROAM });
  const m = mobOf(room, id);
  tick(room, 0.5);
  let t = sim.props.get(id).body.translation();
  stand(room, A, t.x - 2.2, t.z, Math.PI / 2);
  tick(room, 1 / 60);
  room.handle(A, { t: 'grab', kind: 'prop', id, pt: [t.x - 0.9, t.y + 0.3, t.z], d: 1.4 });
  tick(room, 0.2);
  const held = m.st === GST.HELD;
  sim.mobs.ghCost(m, sim.props.get(id), m.patience + 1);
  tick(room, 1 / 60);
  check(held && evs(A.conn, 'slip').some(e => e.id === id && e.by === A.id) && !sim.holds.has(A.id), 'grumphorn: if it gives up while you hold its horns, your hands are told they let go');
  const r2 = crew(['Bob']);
  r2.room.mobsOn = false; r2.room.day = 2;
  const id2 = mobAt(r2.room, r2.ps[0], 'grumphorn', r.x, r.z, { yaw: r.yaw, st: GST.CHARGE });
  const m2 = mobOf(r2.room, id2);
  tick(r2.room, 0.6);
  r2.room.sim.mobs.ghCost(m2, r2.room.sim.props.get(id2), m2.patience + 1);
  tick(r2.room, 4);
  const bell = [...r2.room.sim.props.values()].find(p => p.type === 'cowbell');
  check(bell && bell.value === cowbellValue(2), `grumphorn: giving up mid-charge, it doesn't trample its own cowbell ($${bell?.value?.toFixed(0)} of $${cowbellValue(2)})`);
}
{
  // a vase that shatters on it still hit it (it wakes); the test levers can't wedge it (a forced charge runs
  // its course, a forced breather ends)
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim, r = roadAt(room, 70);
  stand(room, A, r.x + 40, r.z - 40, 0);
  const id = mobAt(room, A, 'grumphorn', r.x, r.z, { yaw: r.yaw + Math.PI / 2 });
  tick(room, 0.5);
  const t = sim.props.get(id).body.translation();
  const vase = sim.addProp('vase', { x: t.x - 3, y: t.y + 0.3, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, 30, 300);
  vase.body.applyImpulse({ x: vase.body.mass() * 9, y: 0.5, z: 0 }, true);
  tick(room, 1);
  check(!sim.props.has(vase.id) && evs(A.conn, 'mob').some(e => e.id === id && e.s === 'wake'), `grumphorn: a vase that shatters on it still wakes it (broke ${!sim.props.has(vase.id)}, state ${stOf(room, id)})`);
  const r2 = roadAt(room, 140);
  let threw = null, st = [];
  try {
    const i2 = mobAt(room, A, 'grumphorn', r2.x, r2.z, { yaw: r2.yaw, st: GST.CHARGE });
    tick(room, 3); st.push(stOf(room, i2));
    room.debug(A, { op: 'mobstate', id: i2, st: GST.WINDED });
    tick(room, GH.WINDED_T + 0.5); st.push(stOf(room, i2));
  } catch (e) { threw = e; }
  check(!threw && st[0] !== GST.CHARGE && st[1] !== GST.WINDED, `grumphorn: a charge or a breather forced by the test lever ends as it should (states ${st.join(', ')}${threw ? ': ' + threw.message : ''})`);
}

// ---- ringtails ------------------------------------------------------------------------------------------------
const { RST, RT, PLAN: RPLAN, ringtailsPerDen } = await import('../shared/mobs.js');
// flat open ground well off the road, no loot or buildings within 40 m (and no den of the day's within 60)
function openGround(room) {
  const W = room.W;
  for (let z = 150; z < W.LEN - 150; z += 7) for (const off of [30, -30, 40, -40]) {
    const x = W.roadX(z) + off, h = W.heightAt(x, z);
    let ok = true;
    for (let dx = -10; dx <= 10 && ok; dx += 2.5) for (let dz = -10; dz <= 10 && ok; dz += 2.5) if (Math.abs(W.heightAt(x + dx, z + dz) - h) > 1.2) ok = false;
    if (ok && !W.props.some(p => Math.hypot(p.x - x, p.z - z) < 40) && !W.statics.some(b => Math.hypot(b.x - x, b.z - z) < 15) && !(W.dens || []).some(d => Math.hypot(d.x - x, d.z - z) < 60)) return { x, z };
  }
  return null;
}
// loot the crew left lying there (theirs: carried there; ours false: the stop's own, never touched)
const putLoot = (room, type, x, z, value = 300, ours = true) => { const p = room.sim.addProp(type, { x, y: room.W.heightAt(x, z) + 0.5, z }, { x: 0, y: 0, z: 0, w: 1 }, value, value); if (p) p.ours = ours; return p; };
const at = (room, id) => room.sim.props.get(id)?.body.translation();
const mobEvs = (p, s) => evs(p.conn, 'mob').filter(e => e.s === s);
// a ringtail of its own (its den where it's put), in a fresh room on `day`
function thief(names, day = 1) {
  const c = crew(names);
  if (day !== 1) { c.room.debug(c.ps[0], { op: 'day', d: day }); tick(c.room, 0.2); }
  c.room.mobsOn = false;
  const g = openGround(c.room);
  const id = mobAt(c.room, c.ps[0], 'ringtail', g.x, g.z);
  return { ...c, g, id, m: mobOf(c.room, id) };
}
const grabIt = (room, P, id) => { const t = at(room, id); stand(room, P, t.x - 1.2, t.z, Math.PI / 2); tick(room, 1 / 60); room.handle(P, { t: 'grab', kind: 'prop', id, pt: [t.x, t.y, t.z], d: 1.4 }); };
{
  // R1: loot left lying 8 m from a den is stolen and piled at the den, unharmed, and the day's tally counts it
  const { room, ps: [A], g, id, m } = thief(['Ann']);
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  const vase = putLoot(room, 'vase', g.x - 8, g.z);
  let stealAt = null, stashAt = null;
  const t0 = room.t;
  for (let i = 0; i < 60 * 25 && stashAt == null; i++) {
    tick(room, 1 / 60);
    if (stealAt == null && mobEvs(A, 'steal').length) stealAt = room.t - t0;
    if (stashAt == null && mobEvs(A, 'stash').length) stashAt = room.t - t0;
  }
  tick(room, 2);
  const t = at(room, vase.id), val = room.sim.props.get(vase.id)?.value;
  check(stealAt != null && stashAt != null && Math.hypot(t.x - g.x, t.z - g.z) < 2.5 && val >= 0.95 * 300 && room.dayStats.stolen >= 300,
    `ringtails: a vase left 8 m from a den is stolen (${stealAt?.toFixed(1)} s) and piled at the den (${stashAt?.toFixed(1)} s, ${t && Math.hypot(t.x - g.x, t.z - g.z).toFixed(1)} m from it, $${val?.toFixed(0)} of $300; stolen today $${room.dayStats.stolen})`);
  check(A.conn.has(x => x.t === 'toast' && /ringtail ran off with the Ming-ish Vase \(\$300\)/.test(x.text)) && room.gameState().thf === Math.round(val),
    `ringtails: the crew is told, and the tracker knows what they hold ($${room.gameState().thf})`);
  tick(room, 30);
  check(mobEvs(A, 'steal').length === 1, `ringtails: what they piled at the den they leave there (${mobEvs(A, 'steal').length} thefts in 30 s more)`);
}
{
  // R2: watched loot is safe; turned away (or too far for the day's nerve) it isn't
  const { room, ps: [A], g } = thief(['Ann']);
  putLoot(room, 'vase', g.x - 8, g.z);
  stand(room, A, g.x - 10, g.z, Math.PI / 2);   // 2 m from it, facing it
  tick(room, 20);
  check(!mobEvs(A, 'steal').length, 'ringtails: a vase someone stands by, facing it, is left alone for 20 s');
  const r = thief(['Bob'], 5);
  putLoot(r.room, 'vase', r.g.x - 8, r.g.z);
  stand(r.room, r.ps[0], r.g.x - 12.5, r.g.z, -Math.PI / 2);   // 4.5 m off, back turned
  tick(r.room, 20);
  check(mobEvs(r.ps[0], 'steal').length === 1, `ringtails: day 5, with your back turned 4.5 m away (their nerve: ${RPLAN[4].fear} m), it's stolen within 20 s`);
}
{
  // R3: grab what it carries: your grip beats its jaws
  const { room, ps: [A], g, id, m } = thief(['Ann']);
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  const vase = putLoot(room, 'vase', g.x - 8, g.z);
  for (let i = 0; i < 60 * 25; i++) { tick(room, 1 / 60); const t = at(room, vase.id); if (m.st === RST.RUN && Math.hypot(t.x - g.x, t.z - g.z) < 6.5) break; }
  const running = m.st === RST.RUN && room.sim.mobs.carriedBy.has(vase.id);
  grabIt(room, A, vase.id);
  let freeAt = null;
  const t0 = room.t;
  for (let i = 0; i < 60; i++) { tick(room, 1 / 60); if (!room.sim.mobs.carriedBy.has(vase.id)) { freeAt = room.t - t0; break; } }
  check(running && freeAt != null && freeAt < 1 && room.sim.props.get(vase.id).holders.has(A.id) && mobEvs(A, 'drop').length === 1,
    `ringtails: grabbing the vase it runs off with takes it back (its jaws let go in ${freeAt?.toFixed(2)} s)`);
}
{
  // R4: held: day 2 on, one person holding it is bitten at 2 s (and lets go); two can hold it; day 1 it wriggles free at 3 s
  for (const [day, n, want] of [[2, 1, 'bite'], [2, 2, null], [1, 1, 'wriggle']]) {
    const { room, ps: [A, B], id } = thief(['Ann', 'Bob'], day);
    tick(room, 0.3);
    grabIt(room, A, id);
    if (n === 2) { const t = at(room, id); stand(room, B, t.x + 1.2, t.z, -Math.PI / 2); tick(room, 1 / 60); room.handle(B, { t: 'grab', kind: 'prop', id, pt: [t.x, t.y, t.z], d: 1.4 }); }
    const t0 = room.t;
    let bite = null, wr = null;
    for (let i = 0; i < 60 * 4.5; i++) {
      tick(room, 1 / 60);
      if (bite == null && mobEvs(A, 'bite').length) bite = room.t - t0;
      if (wr == null && mobEvs(A, 'wriggle').length) wr = room.t - t0;
    }
    if (want === 'bite') check(bite != null && Math.abs(bite - RT.BITE_T) <= 0.12 && !room.sim.holds.has(A.id) && evs(A.conn, 'slip').length === 1 && A.conn.has(x => x.t === 'toast' && /bit Ann/.test(x.text)),
      `ringtails: day 2, held by one person it bites at ${bite?.toFixed(2)} s and is let go`);
    else if (want === 'wriggle') check(bite == null && wr != null && Math.abs(wr - RT.WRIGGLE_T) <= 0.12 && !room.sim.holds.has(A.id),
      `ringtails: day 1 it never bites; it wriggles free at ${wr?.toFixed(2)} s`);
    else check(bite == null && wr == null && room.sim.holds.has(A.id) && room.sim.holds.has(B.id), 'ringtails: held by two it can\'t bite (4.5 s)');
  }
}
{
  // R5: a TV thrown at it from 3 m: stunned at once, up again in a few seconds; the TV takes its knock
  const { room, ps: [A], id, m, g } = thief(['Ann']);
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  tick(room, 0.5);
  const sim = room.sim, t = at(room, id);
  const tv = sim.addProp('tv', { x: t.x - 3, y: t.y + 0.5, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, 200, 200);
  const imp = Math.min(tv.body.mass() * C.GRAB.THROW, C.GRAB.THROW_IMPULSE_CAP), t2 = at(room, id), d = Math.hypot(t2.x - t.x + 3, t2.z - t.z);
  tv.body.applyImpulse({ x: imp * (t2.x - t.x + 3) / d, y: imp * 0.12, z: imp * (t2.z - t.z) / d }, true);
  const t0 = room.t;
  let stun = null, up = null;
  for (let i = 0; i < 60 * 5; i++) {
    tick(room, 1 / 60);
    if (stun == null && m.st === RST.STUN) stun = room.t - t0;
    if (stun != null && up == null && m.st !== RST.STUN) up = room.t - t0;
  }
  check(stun != null && stun <= 0.3 && up != null && up <= 4 && sim.props.get(tv.id).value < 200 && mobEvs(A, 'stun').length === 1,
    `ringtails: a TV thrown from 3 m stuns it (${stun?.toFixed(2)} s), up again at ${up?.toFixed(2)} s; the TV took a knock ($${sim.props.get(tv.id).value.toFixed(0)})`);
}
{
  // R6: the horn: ringtails near the RV drop what they carry and scatter; a second honk soon after does nothing
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  room.mobsOn = false;
  const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
  const a = toWorld(rp, rq, { x: 7, y: 0, z: 2 }), b = toWorld(rp, rq, { x: -9, y: 0, z: -4 });
  const i1 = mobAt(room, A, 'ringtail', a.x, a.z), i2 = mobAt(room, A, 'ringtail', b.x, b.z);
  stand(room, B, a.x + 40, a.z + 40, 0);
  tick(room, 0.5);
  const M1 = mobOf(room, i1), M2 = mobOf(room, i2), t1 = at(room, i1);
  const gnome = sim.addProp('gnome', { x: t1.x + 0.3, y: t1.y + 0.2, z: t1.z }, { x: 0, y: 0, z: 0, w: 1 }, 70, 70);
  sim.mobs.bite(M1, gnome.id); sim.mobs.setSt(M1, RST.RUN);
  tick(room, 0.3);
  A.seat = 0;
  room.handle(A, { t: 'horn' });
  tick(room, 1 / 60);
  check(M1.st === RST.SPOOK && M2.st === RST.SPOOK && !sim.mobs.carriedBy.has(gnome.id) && mobEvs(B, 'drop').length === 1, 'ringtails: the horn makes them drop what they carry and scatter');
  tick(room, 5);
  sim.mobs.setSt(M1, RST.DEN); sim.mobs.setSt(M2, RST.DEN);
  room.handle(A, { t: 'horn' });
  tick(room, 1 / 60);
  check(M1.st === RST.DEN && M2.st === RST.DEN, `ringtails: honk again within ${RT.HORN_DEAF} s and they pay it no mind`);
  A.seat = null;
}
{
  // R7: the RV at 4 m/s over one: squashed (stunned), and nobody pays for it
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim, W = room.W;
  sim.placeRV(W.roadX(40), 40, Math.atan2(W.roadX(43) - W.roadX(37), 6));
  const bank = room.bank;
  let id = null, M1 = null, squash = false;
  driveAt(room, A, 4.3, 22, () => {
    if (id == null && sim.rvSpeed() > 3.4) {
      const w = toWorld(sim.rv.translation(), sim.rv.rotation(), { x: 0.3, y: 0, z: 9 });
      id = mobAt(room, A, 'ringtail', w.x, w.z); M1 = mobOf(room, id);
      const D = sim.mobs.denOf(M1); D.awakeChecked = 1e9; D.awake = false;   // (its den asleep: it sits still)
    }
    if (id != null && mobEvs(A, 'squash').some(e => e.id === id)) squash = true;
  });
  A.seat = null;
  const t = at(room, id);
  check(squash && mobEvs(A, 'stun').some(e => e.id === id) && room.bank === bank && t && Number.isFinite(t.x + t.y + t.z), `ringtails: the RV at 4 m/s over one squashes it flat (stunned), and bills nothing (bank ${bank} -> ${room.bank})`);
}
{
  // R8: one in the RV with the door shut is trapped, and squeezes out a window within 10 s; with the door open it leaves by it
  for (const open of [false, true]) {
    const { room, ps: [A] } = crew(['Ann']);
    room.mobsOn = false;
    const sim = room.sim;
    if (sim.doorOpen !== open) sim.setDoor(open);
    const rp = sim.rv.translation(), rq = sim.rv.rotation(), w = toWorld(rp, rq, { x: 0, y: 0.6, z: -1.5 });
    const id = mobAt(room, A, 'ringtail', w.x, w.z, { y: w.y }), M1 = mobOf(room, id), D = sim.mobs.denOf(M1);
    const dp = toWorld(rp, rq, { x: -12, y: 0, z: 0 });
    Object.assign(D, { x: dp.x, y: room.W.heightAt(dp.x, dp.z), z: dp.z });   // (its den out past the door)
    sim.mobs.setSt(M1, RST.FLUNG);   // (thrown in)
    const t0 = room.t;
    let trapped = null, gone = null, out = null;
    for (let i = 0; i < 60 * 12; i++) {
      tick(room, 1 / 60);
      if (trapped == null && M1.st === RST.TRAPPED) trapped = room.t - t0;
      if (gone == null && !sim.props.has(id)) gone = room.t - t0;
      if (out == null && trapped != null && sim.props.has(id) && M1.st !== RST.TRAPPED) out = room.t - t0;
    }
    if (!open) check(trapped != null && gone != null && gone <= 10 && evs(A.conn, 'gone').some(e => e.ids.includes(id) && e.how === 'window'),
      `ringtails: thrown into the RV with the door shut it's trapped (${trapped?.toFixed(1)} s) and squeezes out a window (${gone?.toFixed(1)} s)`);
    else check(trapped != null && out != null && gone == null && !sim.mobs.inRV(at(room, id)), `ringtails: with the door open it leaves by it (${out?.toFixed(1)} s)`);
  }
}
{
  // R9: a den steals only so much a day: day 1's takes at most 2 things in 5 minutes, with 6 left out
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const g = openGround(room), mobs = room.sim.ensureMobs({ day: 1, crew: 1, seed: room.seed });
  mobs.rtSpawnDen({ id: 7, x: g.x, y: room.W.heightAt(g.x, g.z), z: g.z, ry: 0, stash: [] });
  stand(room, A, g.x + 30, g.z, Math.PI / 2);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; putLoot(room, ['vase', 'gnome', 'toaster', 'lamp', 'vase', 'gnome'][i], g.x + Math.cos(a) * 9, g.z + Math.sin(a) * 9, 100); }
  tick(room, 300);
  check(mobEvs(A, 'steal').length === RPLAN[0].cap && mobEvs(A, 'stash').length === RPLAN[0].cap, `ringtails: a day-1 den steals ${mobEvs(A, 'steal').length} things in 5 minutes with 6 left out (its cap: ${RPLAN[0].cap})`);
}
{
  // R10: what you take back counts: a stolen vase picked up off the pile and put in the RV
  const { room, ps: [A], g } = thief(['Ann']);
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  const vase = putLoot(room, 'vase', g.x - 8, g.z);
  for (let i = 0; i < 60 * 25 && !mobEvs(A, 'stash').length; i++) tick(room, 1 / 60);
  grabIt(room, A, vase.id);
  tick(room, 0.2);
  room.handle(A, { t: 'rel' });
  const sim = room.sim, w = toWorld(sim.rv.translation(), sim.rv.rotation(), { x: 0, y: 0.5, z: 1 });
  sim.props.get(vase.id).body.setTranslation(w, true);
  tick(room, 1.2);
  check(mobEvs(A, 'recovered').some(e => e.item === vase.id) && room.dayStats.recovered > 0 && room.gameState().thf === 0,
    `ringtails: a stolen vase taken back to the RV counts as got back (recovered today $${room.dayStats.recovered})`);
}
{
  // R11: a mini-soak, every den of seed 4242's five days left alone with its stop's loot for 90 s
  const { soakDens } = await import('../tools/mobsoak.mjs');
  const T = { picks: 0, steals: 0, stashes: 0, nonFinite: 0 };
  for (let day = 1; day <= 5; day++) { const r = soakDens(4242, day, { secs: 90 }); for (const k in T) T[k] += r[k]; }
  check(T.picks > 0 && T.steals / T.picks >= 0.95 && T.stashes / T.steals >= 0.85 && T.nonFinite === 0,
    `ringtails: over 5 days they reach ${T.steals} of the ${T.picks} things they go for and get ${T.stashes} home; nothing goes non-finite`);
}
{
  // R12: the snapshot budget: day 5, every critter out and awake, 20 loose things in the driving RV
  const { room, ps } = crew(['Ann', 'Bob', 'Cat', 'Dee']);
  room.debug(ps[0], { op: 'day', d: 5 });
  tick(room, 0.2);
  room.mobsOn = true;
  const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
  for (let i = 0; i < 20; i++) sim.addProp(['gnome', 'toaster', 'lamp', 'trophy', 'vase'][i % 5], toWorld(rp, rq, { x: -0.8 + (i % 4) * 0.5, y: 0.5 + Math.floor(i / 8) * 0.4, z: -3 + Math.floor(i / 4) * 1.2 }), { x: 0, y: 0, z: 0, w: 1 }, 100, 100);
  room.phase = 'road';
  tick(room, 0.5);
  for (const d of sim.mobs.dens.values()) Object.assign(d, { awake: true, awakeChecked: 1e9 });
  for (const m of sim.mobs.list.values()) if (m.type === 'grumphorn') { const p = sim.props.get(m.id); sim.mobs.ghWake(m, p, p.body.translation()); }
  // (the day's first snapshot carries every prop once, the pages' first look at it: the budget is for the ones after)
  room.snapshot();
  let max = 0, sum = 0, n = 0;
  driveAt(room, ps[0], 8, 20, i => {
    for (const [k, P] of ps.entries()) if (k) ride(room, P, 0, -1 + k, 0);
    if (i % 3 === 0) { const L = JSON.stringify(room.snapshot()).length; max = Math.max(max, L); sum += L; n++; }
  });
  // (the mean: 2,520 B before the Hoard, whose six awake cost 150 B more than a den of three)
  check(max <= 4752 && sum / n <= 2800, `ringtails: day 5 with every critter awake and 20 things loose in the RV, snapshots stay in 4 Steam fragments (max ${max} B, mean ${(sum / n).toFixed(0)} B)`);
}

{
  // R13: taken again before anyone got it back, it's the same theft: the day's tally counts it once
  const { room, ps: [A], g, id, m } = thief(['Ann']);
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  const vase = putLoot(room, 'vase', g.x - 9, g.z);
  for (let i = 0; i < 60 * 25 && !(m.st === RST.RUN && room.sim.mobs.carriedBy.has(vase.id)); i++) tick(room, 1 / 60);
  const first = room.dayStats.stolen;
  grabIt(room, A, id);   // (caught: it drops the vase)
  tick(room, 0.3);
  room.handle(A, { t: 'rel' });
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  for (let i = 0; i < 60 * 40 && mobEvs(A, 'steal').length < 2; i++) tick(room, 1 / 60);
  const st = mobEvs(A, 'steal');
  check(st.length === 2 && st[1].again && first > 0 && room.dayStats.stolen === first && room.stats.stolen === first && room.sim.mobs.denOf(m).thefts === 1,
    `ringtails: a vase dropped and stolen again is one theft ($${first} then $${room.dayStats.stolen} today; ${st.length} steals, the den's count ${room.sim.mobs.denOf(m).thefts})`);
}
{
  // R14: the day's cap holds with the whole den setting out at once (day 1: 2 things, 3 ringtails ready together)
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const g = openGround(room), mobs = room.sim.ensureMobs({ day: 1, crew: 5, seed: room.seed });
  mobs.rtSpawnDen({ id: 7, x: g.x, y: room.W.heightAt(g.x, g.z), z: g.z, ry: 0, stash: [] });
  stand(room, A, g.x + 30, g.z, Math.PI / 2);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; putLoot(room, ['vase', 'gnome', 'toaster', 'lamp', 'vase', 'gnome'][i], g.x + Math.cos(a) * 9, g.z + Math.sin(a) * 9, 100); }
  tick(room, 0.5);
  const crew3 = [...mobs.list.values()].filter(q => q.den === 7);
  for (const q of crew3) q.cd = 0;
  tick(room, 60);
  check(crew3.length >= 3 && mobEvs(A, 'steal').length === RPLAN[0].cap, `ringtails: ${crew3.length} of a den all ready at once still steal only the day's ${RPLAN[0].cap} (${mobEvs(A, 'steal').length})`);
}
{
  // R15: a den asleep (nobody near) on a slope: its ringtails sit tight, they don't slide off downhill
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const W = room.W;
  let spotS = null;
  for (let z = 150; z < W.LEN - 150 && !spotS; z += 5) for (const off of [20, -20, 30, -30, 45, -45]) {
    const x = W.roadX(z) + off, h = W.heightAt(x, z), gx = (W.heightAt(x + 1, z) - W.heightAt(x - 1, z)) / 2, gz = (W.heightAt(x, z + 1) - W.heightAt(x, z - 1)) / 2;
    if (Math.hypot(gx, gz) > 0.3 && Math.hypot(gx, gz) < 0.6 && !W.statics.some(b => Math.hypot(b.x - x, b.z - z) < 12) && !W.props.some(q => Math.hypot(q.x - x, q.z - z) < 12)) { spotS = { x, z, slope: Math.hypot(gx, gz) }; break; }
  }
  const mobs = room.sim.ensureMobs({ day: 1, crew: 2, seed: room.seed });
  mobs.rtSpawnDen({ id: 8, x: spotS.x, y: W.heightAt(spotS.x, spotS.z), z: spotS.z, ry: 0, stash: [] });
  stand(room, A, spotS.x + 150, spotS.z, 0);
  tick(room, 0.5);
  const ids = [...mobs.list.values()].filter(q => q.den === 8).map(q => q.id), p0 = ids.map(i => ({ ...at(room, i) }));
  tick(room, 20);
  const moved = Math.max(...ids.map((i, k) => { const t = at(room, i); return Math.hypot(t.x - p0[k].x, t.z - p0[k].z); }));
  check(spotS && !mobs.dens.get(8).awake && moved < 0.3, `ringtails: at a den asleep on a ${(Math.atan(spotS?.slope ?? 0) * 57.3).toFixed(0)}° slope they sit tight (the most one moved in 20 s: ${moved.toFixed(2)} m)`);
}
{
  // R16: let go of while dizzy from its third stun, it's still had enough: off for good, not back to stealing
  const { room, ps: [A], id, m } = thief(['Ann']);
  tick(room, 0.5);
  m.stuns = RT.GONE_AFTER - 1;
  room.sim.mobs.rtStun(m, room.sim.props.get(id));   // (its third)
  grabIt(room, A, id);
  tick(room, 0.5);
  room.handle(A, { t: 'rel' });
  stand(room, A, at(room, id).x + 25, at(room, id).z, 0);
  tick(room, 1 / 60);
  const st = m.st;
  tick(room, 10);
  check(st === RST.GONE && !room.sim.props.has(id) && evs(A.conn, 'gone').some(e => e.ids.includes(id)), `ringtails: grabbed and let go after its third stun it goes for good (state ${st}, gone ${!room.sim.props.has(id)})`);
}
{
  // R17: held by two, one lets go: the other is bitten 2 s after that, not at once
  const { room, ps: [A, B], id } = thief(['Ann', 'Bob'], 2);
  tick(room, 0.3);
  grabIt(room, A, id);
  const t = at(room, id); stand(room, B, t.x + 1.2, t.z, -Math.PI / 2); tick(room, 1 / 60); room.handle(B, { t: 'grab', kind: 'prop', id, pt: [t.x, t.y, t.z], d: 1.4 });
  tick(room, 3);
  room.handle(B, { t: 'rel' });
  const t0 = room.t;
  let bite = null;
  for (let i = 0; i < 60 * 4 && bite == null; i++) { tick(room, 1 / 60); if (mobEvs(A, 'bite').length) bite = room.t - t0; }
  check(bite != null && Math.abs(bite - RT.BITE_T) <= 0.15 && mobEvs(A, 'bite')[0].by === A.id, `ringtails: held by two for 3 s, then one lets go: the other is bitten ${bite?.toFixed(2)} s later`);
}
{
  // R18: thrown into the RV (it lands stunned on the floor) as it drives off, door shut: trapped once, never
  // squashed by the RV it's riding in, and out a window
  const { room, ps: [A] } = crew(['Ann']);
  room.mobsOn = false;
  const sim = room.sim, W = room.W;
  sim.placeRV(W.roadX(40), 40, Math.atan2(W.roadX(43) - W.roadX(37), 6));
  if (sim.doorOpen) sim.setDoor(false);
  tick(room, 0.5);
  const w = toWorld(sim.rv.translation(), sim.rv.rotation(), { x: 0, y: 0.6, z: -1.5 });
  const id = mobAt(room, A, 'ringtail', w.x, w.z, { y: w.y }), M1 = mobOf(room, id);
  tick(room, 0.5);
  sim.mobs.rtStun(M1, sim.props.get(id));   // (landed stunned)
  let gone = null;
  const t0 = room.t;
  driveAt(room, A, 4, 12, () => { if (gone == null && !sim.props.has(id)) gone = room.t - t0; });
  A.seat = null;
  const stuns = mobEvs(A, 'stun').filter(e => e.id === id).length, squash = mobEvs(A, 'squash').filter(e => e.id === id).length, traps = mobEvs(A, 'trapped').filter(e => e.id === id).length;
  check(squash === 0 && stuns === 1 && traps === 1 && gone != null && evs(A.conn, 'gone').some(e => e.ids.includes(id) && e.how === 'window'),
    `ringtails: stunned in the RV as it drives off: trapped ${traps}x, stunned ${stuns}x, squashed ${squash}x, out a window after ${gone?.toFixed(1)} s of driving`);
}

{
  // R19: the stop's own loot, taken before anyone touched it: not a theft from the crew (no tally, no "your
  // stuff" on the tracker, "beat you to it"), and taking it off the pile isn't "got back"
  const { room, ps: [A], g } = thief(['Ann']);
  stand(room, A, g.x + 25, g.z, Math.PI / 2);
  const vase = putLoot(room, 'vase', g.x - 8, g.z, 300, false);
  for (let i = 0; i < 60 * 25 && !mobEvs(A, 'stash').length; i++) tick(room, 1 / 60);
  tick(room, 4);
  const told = A.conn.has(x => x.t === 'toast' && /ringtail beat you to the Ming-ish Vase/.test(x.text)), thf = room.gameState().thf;
  grabIt(room, A, vase.id);
  tick(room, 0.2);
  room.handle(A, { t: 'rel' });
  const sim = room.sim, w = toWorld(sim.rv.translation(), sim.rv.rotation(), { x: 0, y: 0.5, z: 1 });
  sim.props.get(vase.id).body.setTranslation(w, true);
  tick(room, 1.2);
  check(mobEvs(A, 'stash').length === 1 && told && thf === 0 && room.dayStats.stolen === 0 && room.stats.stolen === 0 && room.dayStats.recovered === 0 && !mobEvs(A, 'recovered').length,
    `ringtails: the stop's own vase taken before anyone touched it isn't a theft from the crew (told ${told}, tracker $${thf}, stolen $${room.dayStats.stolen}, got back $${room.dayStats.recovered})`);
}

// ---- rockfall ----------------------------------------------------------------------------------------------
const { RF } = await import('../shared/mobs.js');
// a crew on day `day` of seed 4242 with the road started (the rockfalls armed); the RV parked well back
function narrows(day, names = ['Ann', 'Bob']) {
  const c = crew(names);
  c.room.debug(c.ps[0], { op: 'day', d: day });
  tick(c.room, 0.2);
  c.room.phase = 'road';
  tick(c.room, 0.1);
  return { ...c, W: c.room.W, mobs: c.room.sim.mobs };
}
// where its first rock lands: the same fall with nobody about (the sim is deterministic)
function firstLanding(day) {
  const { room, ps: [A, B], W, mobs } = narrows(day);
  const rf = mobs.rockfalls[0];
  stand(room, B, W.roadX(rf.obz - 150), rf.obz - 150, 0);
  mobs.rfTrigger(rf, 'test');
  for (let i = 0; i < 60 * 6; i++) {
    tick(room, 1 / 60);
    const p = rf.rocks[0] && room.sim.props.get(rf.rocks[0].id);
    if (!p) continue;
    const t = p.body.translation(), v = p.body.linvel();
    if (t.y - W.heightAt(t.x, t.z) < 0.6 && Math.hypot(v.x, v.y, v.z) > RF.KO_V) return { x: t.x, z: t.z };
  }
  return null;
}
{
  // RF1: standing where a rock lands: knocked out (no bill), the crew warned first and told what happened
  const at = firstLanding(4);
  const { room, ps: [A, B], mobs } = narrows(4);
  const rf = mobs.rockfalls[0], bank = room.bank;
  stand(room, A, room.W.roadX(rf.obz - 150), rf.obz - 150, 0);
  mobs.rfTrigger(rf, 'test');
  for (let i = 0; i < 60 * 6 && !knocks(B).length; i++) { stand(room, B, at.x, at.z, 0); tick(room, 1 / 60); }
  const k = knocks(B)[0];
  if (k?.ko) room.handle(B, { t: 'ko', why: 'fall' });
  check(at && k?.ko && k.why === 'rock' && room.bank === bank && evs(A.conn, 'mob').some(e => e.s === 'rumble') && A.conn.has(x => x.t === 'toast' && /ROCKS!/.test(x.text)) && A.conn.has(x => x.t === 'toast' && /Bob got hit by a falling rock/.test(x.text)),
    `rockfall: standing where a rock lands knocks you out (${k ? (k.ko ? 'KO' : 'stumble') : 'missed'}, why ${k?.why}), after the rumble and a warning, and bills nothing`);
}
{
  // RF2: the RV coming within 25 m brings it down; a honk 50 m back brings it down early, and only once
  for (const honk of [false, true]) {
    const { room, ps: [A], W, mobs } = narrows(4, ['Ann']);
    const rf = mobs.rockfalls.find(r => r.ob === 'boulder');
    room.sim.placeRV(W.roadX(rf.obz - 70), rf.obz - 70, Math.atan2(W.roadX(rf.obz - 67) - W.roadX(rf.obz - 73), 6));
    tick(room, 0.2);
    let rumbleAt = null, honked = false;
    driveAt(room, A, 4, 18, i => {
      const z = room.sim.rv.translation().z;
      if (honk && !honked && rf.obz - z < 52) { honked = true; room.handle(A, { t: 'horn' }); }
      if (rumbleAt == null && rf.st !== 'armed') rumbleAt = rf.obz - z;
      if (z > rf.obz - 18) room.handle(A, { t: 'drv', th: -1, st: 0, hb: 1 });
    });
    const rumbles = evs(A.conn, 'mob').filter(e => e.s === 'rumble' && e.rf === rf.id).length;
    if (!honk) check(rumbleAt != null && rumbleAt <= RF.NEAR + 1 && rf.rocks.length >= 5 && rumbles === 1, `rockfall: the RV coming within ${RF.NEAR} m brings it down (at ${rumbleAt?.toFixed(1)} m, ${rf.rocks.length} rocks)`);
    else check(rumbleAt != null && rumbleAt > 40 && rumbles === 1, `rockfall: a honk ${rumbleAt?.toFixed(0)} m back brings it down early, and driving up after doesn't bring down more (${rumbles} rumble)`);
    A.seat = null;
  }
}
{
  // RF3: moving the boulder brings it down too
  const { room, ps: [A], W, mobs } = narrows(4, ['Ann']);
  const rf = mobs.rockfalls.find(r => r.ob === 'boulder'), b = room.sim.props.get(rf.boulder);
  tick(room, 0.5);
  const st0 = rf.st;
  b.body.setTranslation({ x: rf.b0.x + 0.8, y: rf.b0.y, z: rf.b0.z }, true);
  tick(room, 0.1);
  check(st0 === 'armed' && rf.st === 'rumble', `rockfall: shoving the boulder aside brings it down (${st0} -> ${rf.st})`);
}
{
  // RF4: where: days 3-5, on the face of a wall at each narrows (the boulder's, the gate's), 5-6 rocks; signs
  const bad = [];
  for (const seed of [4242, 7, 777]) for (let day = 1; day <= 5; day++) {
    const W = generateLeg(seed, day), n = W.obstacles.filter(o => o.type === 'boulder' || o.type === 'gate').length;
    if (day < 3 && W.rockfalls.length) bad.push(`${seed}/${day} rockfall before day 3`);
    if (day >= 3 && W.rockfalls.length !== n) bad.push(`${seed}/${day} ${W.rockfalls.length} rockfalls for ${n} narrows`);
    for (const r of W.rockfalls) {
      if (r.rim.length < 5) bad.push(`${seed}/${day} ${r.rim.length} rocks`);
      for (const p of r.rim) { const up = p.y - W.roadY(p.z), off = Math.abs(p.x - W.roadX(p.z)); if (up < 3 || up > 25 || off < 6 || off > 25 || p.z > r.obz - 3) bad.push(`${seed}/${day} rock at ${off.toFixed(1)} m out, ${up.toFixed(1)} m up`); }
      if (!W.signs.some(q => q.rock && Math.abs(q.z - (r.obz - 48)) < 10)) bad.push(`${seed}/${day} no warning sign`);
    }
  }
  check(!bad.length, `rockfall: loose rock on the walls of every narrows on days 3-5 (3 seeds), with a sign back down the road${bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''}`);
}

// ---- raids, nips, beanings ---------------------------------------------------------------------------------
// a ringtail with its den 14 m off the RV's door side (side -1; side 1: off the other side), the RV parked in
// camp, on day `day`
function byTheRV(day, names = ['Ann'], side = -1) {
  const c = crew(names);
  if (day !== 1) { c.room.debug(c.ps[0], { op: 'day', d: day }); tick(c.room, 0.2); }
  c.room.mobsOn = false;
  const sim = c.room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
  if (!sim.doorOpen) sim.setDoor(true);
  const dp = toWorld(rp, rq, { x: 14 * side, y: 0, z: 2 });
  const id = mobAt(c.room, c.ps[0], 'ringtail', dp.x, dp.z);
  const far = toWorld(rp, rq, { x: 30, y: 0, z: 30 });
  for (const P of c.ps) stand(c.room, P, far.x, far.z, 0);
  const vase = c.room.sim.addProp('vase', toWorld(rp, rq, { x: 0.3, y: 0.5, z: -1.2 }), { x: 0, y: 0, z: 0, w: 1 }, 300, 300);
  return { ...c, sim, id, m: mobOf(c.room, id), vase, rp, rq };
}
{
  // P1: the RV parked with its door open and nobody by it: a ringtail hops in and takes the vase home. Its den
  // off the far side, it goes under the RV to the door, and back round the RV with the vase
  const res = [];
  for (const side of [-1, 1]) {
    const { room, ps: [A], sim, m, vase } = byTheRV(2, ['Ann'], side);
    let home = false, dmg = 0;
    for (let i = 0; i < 60 * 45 && !home; i++) { tick(room, 1 / 60); home = mobEvs(A, 'stash').some(e => e.item === vase.id); }
    const t = at(room, vase.id), D = sim.mobs.denOf(m);
    const ok = home && Math.hypot(t.x - D.x, t.z - D.z) < 3 && room.dayStats.stolen > 0 && room.dayStats.stolen <= 300 && D.thefts === 1 && A.conn.has(x => x.t === 'toast' && /out of the RV/.test(x.text) && /Shut the door/.test(x.text));
    res.push(`${side < 0 ? 'door side' : 'far side'}: ${ok ? 'home' : 'FAILED'} (stolen $${room.dayStats.stolen}, counted ${D.thefts}, vase $${Math.round(sim.props.get(vase.id)?.value ?? 0)})`);
  }
  check(res.every(r => /: home/.test(r)), `raids: the RV left open with nobody by it, a ringtail takes the vase out of it and home, its den off either side (${res.join('; ')})`);
}
{
  // P2: a shut door, a bungee'd vase, someone by the door, or day 1: nothing goes
  const cases = [['door shut', r => r.sim.setDoor(false)], ['tied down', r => r.sim.tieDown()], ['guarded', r => { const d = toWorld(r.rp, r.rq, { x: -3, y: 0, z: 0.35 }); stand(r.room, r.ps[0], d.x, d.z, 0); }], ['day 1', null]];
  const out = [];
  for (const [name, fn] of cases) {
    const r = byTheRV(name === 'day 1' ? 1 : 2);
    fn?.(r);
    const guard = name === 'guarded' ? toWorld(r.rp, r.rq, { x: -3, y: 0, z: 0.35 }) : null;
    for (let i = 0; i < 60 * 30; i++) { if (guard) stand(r.room, r.ps[0], guard.x, guard.z, 0); tick(r.room, 1 / 60); }
    out.push(`${name}: ${mobEvs(r.ps[0], 'steal').length ? 'RAIDED' : 'safe'}`);
  }
  check(out.every(o => o.endsWith('safe')), `raids: never through a shut door, never bungee'd cargo, never with someone by the door, never on day 1 (${out.join(', ')})`);
}
{
  // P3: a stranger at a den, day 2 on: nipped (a stumble, never a knockout), and drops what they carry; day 1 never
  const res = {};
  for (const day of [1, 2]) {
    const c = crew(['Ann', 'Bob']);
    if (day > 1) { c.room.debug(c.ps[0], { op: 'day', d: day }); tick(c.room, 0.2); }
    c.room.mobsOn = false;
    const { room, ps: [A, B] } = c, W = room.W, g = openGround(room);
    room.sim.ensureMobs({ day, crew: 2, seed: room.seed }).rtSpawnDen({ id: 7, x: g.x, y: W.heightAt(g.x, g.z), z: g.z, ry: 0, stash: [] });
    stand(room, A, g.x - 20, g.z, Math.PI / 2); stand(room, B, g.x + 40, g.z, 0);
    tick(room, 1);
    const gn = room.sim.addProp('gnome', { x: g.x - 19, y: W.heightAt(g.x - 19, g.z) + 1, z: g.z }, { x: 0, y: 0, z: 0, w: 1 }, 70, 70);
    tick(room, 0.2);
    const gt = at(room, gn.id);
    room.handle(A, { t: 'grab', kind: 'prop', id: gn.id, pt: [gt.x, gt.y, gt.z], d: 1.2 });
    const held = room.sim.holds.has(A.id);
    // walk in with it (a jump of 15 m would break the hold), then stand 5 m from the den
    for (let i = 0; i < 60 * 10; i++) { stand(room, A, g.x - 20 + Math.min(15, i * 0.06), g.z, Math.PI / 2); tick(room, 1 / 60); }
    const kn = knocks(A);
    res[day] = { held, nips: mobEvs(A, 'nip').length, ko: kn.some(k => k.ko), dropped: evs(A.conn, 'slip').some(e => e.by === A.id && e.why === 'nip') && !room.sim.holds.has(A.id) };
    // and nobody kneeling by a friend who is down is nipped
    if (day === 2) {
      room.handle(B, { t: 'ko', why: 'fall' });
      stand(room, B, g.x - 5, g.z + 1, 0);
      tick(room, 3.5);
      const n0 = mobEvs(A, 'nip').length;
      for (let i = 0; i < 60 * 6; i++) { stand(room, A, g.x - 5, g.z, Math.PI / 2); stand(room, B, g.x - 5, g.z + 1, 0); tick(room, 1 / 60); }
      res.downed = mobEvs(A, 'nip').length - n0;
    }
  }
  check(res[1].held && res[2].held && res[1].nips === 0 && res[2].nips >= 2 && res[2].nips <= 10 / RT.NIP_CD + 1 && !res[2].ko && res[2].dropped && res.downed === 0,
    `nips: none on day 1; day 2, ${res[2].nips} in 10 s by a den (one every ${RT.NIP_CD} s at most), never a knockout, the gnome dropped; none by a friend who is down (${res.downed}) ${JSON.stringify(res)}`);
}
{
  // P4: a gnome thrown at a friend beans them: a stumble, they drop what they hold, the toast names the thrower
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  room.mobsOn = false;
  const s = spot(room), sim = room.sim;
  // (Bob faces off to the side, the toaster held out there, clear of the gnome's line)
  stand(room, A, s.x, s.z, 0); stand(room, B, s.x, s.z + 3, Math.PI / 2); stand(room, Cc, s.x + 20, s.z, 0);
  const tv = sim.addProp('toaster', { x: s.x + 1, y: room.W.heightAt(s.x + 1, s.z + 3) + 1.4, z: s.z + 3 }, { x: 0, y: 0, z: 0, w: 1 }, 50, 50);
  tick(room, 0.3);
  const tt = at(room, tv.id);
  room.handle(B, { t: 'grab', kind: 'prop', id: tv.id, pt: [tt.x, tt.y, tt.z], d: 1 });
  const gn = sim.addProp('gnome', { x: s.x, y: room.W.heightAt(s.x, s.z) + 1.4, z: s.z + 0.8 }, { x: 0, y: 0, z: 0, w: 1 }, 70, 70);
  tick(room, 0.1);
  const g0 = at(room, gn.id);
  room.handle(A, { t: 'grab', kind: 'prop', id: gn.id, pt: [g0.x, g0.y, g0.z], d: 1 });
  tick(room, 0.1);
  room.handle(A, { t: 'rel', thr: 1, dir: [0, 0.05, 1] });
  tick(room, 1);
  const k = knocks(B).find(x => x.why === 'bean');
  check(k && !k.ko && !knocks(A).length && !sim.holds.has(B.id) && evs(B.conn, 'slip').some(e => e.why === 'bean') && Cc.conn.has(x => x.t === 'toast' && /Ann beaned Bob with the Garden Gnome/.test(x.text)) && room.stats.beanings === 1,
    `beanings: a gnome thrown at Bob knocks him over (never out) and he drops the toaster; the crew hears who did it (${k ? (k.ko ? 'KO' : 'stumble') : 'missed'})`);
}

// ---- the Hoard, the store's hard hat and cheese, tipping, stones ---------------------------------------------
{
  // H1: day 5's Hoard: one den of them (none before), its pile four good things
  const bad = [], seen = [];
  for (const seed of [4242, 7, 777, 24757, 32676]) {
    const W = generateLeg(seed, 5), H = W.dens.filter(d => d.hoard);
    if (H.length !== 1) { bad.push(`${seed}: ${H.length} hoards`); continue; }
    const h = H[0], poi = W.pois.find(p => p.id === h.poi);
    const stash = h.stash.map(id => W.props.find(p => p.id === id)), total = stash.reduce((a, p) => a + (p?.value || 0), 0);
    if (stash.length !== 4 || stash.some(p => !p) || total < 2000 || total > 3200) bad.push(`${seed}: stash of ${stash.length} worth $${total}`);
    seen.push(`$${total} at the ${poi?.type}${W.pois.some(p => p.type === 'junk') ? ' (a junkyard that day)' : ''}`);
    for (let day = 1; day <= 4; day++) if (generateLeg(seed, day).dens.some(d => d.hoard)) bad.push(`${seed}/${day} a hoard`);
  }
  check(!bad.length, `hoard: day 5 has one, and no day before it; its pile is four good things (${seen.join('; ')})${bad.length ? ': ' + bad.join('; ') : ''}`);
}
{
  // H2: all of them at home: six ringtails at the Hoard for a crew of four
  const { room, ps } = crew(['Ann', 'Bob', 'Cat', 'Dee']);
  room.debug(ps[0], { op: 'day', d: 5 });
  tick(room, 0.2);
  room.mobsOn = true;
  room.phase = 'road';
  tick(room, 0.5);
  const M = room.sim.mobs, h = [...(M?.dens.values() || [])].find(d => d.hoard);
  const n = h ? [...M.list.values()].filter(m => m.den === h.id).length : 0;
  check(h && n === 6 && h.stash.every(id => M.hoard.has(id)), `hoard: six ringtails at home for a crew of four (${n}), sitting on the pile`);
}
{
  // S1: the hard hat: bought at the store (on the crew's roster), and it takes a knockout once
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  room.bank = 1000;
  const u = room.W.uses.find(q => q.kind === 'buy' && q.arg === 'hardhat');
  stand(room, A, u.x + 1.2, u.z, -Math.PI / 2);
  room.handle(A, { t: 'use', id: u.id });
  const meta = B.conn.last('meta'), bought = A.hat && room.bank === 920 && meta?.players.find(q => q.id === A.id)?.hat === 1;
  room.handle(A, { t: 'use', id: u.id });   // (a second: no)
  const once = room.bank === 920;
  room.handle(A, { t: 'hat', why: 'fall' });
  check(bought && once && !A.hat && B.conn.has(x => x.t === 'toast' && /Ann's hard hat took that one/.test(x.text)) && room.stats.kos === 0,
    `store: a hard hat for $80, on the roster; one at a time; when it takes a knockout it's done for (bank $${room.bank})`);
}
{
  // S2: the cheese wheel: on the counter when bought, and a den goes for it before a vase
  const { room, ps: [A] } = crew(['Ann']);
  room.bank = 1000;
  const u = room.W.uses.find(q => q.kind === 'buy' && q.arg === 'cheese');
  stand(room, A, u.x + 1.2, u.z, -Math.PI / 2);
  room.handle(A, { t: 'use', id: u.id });
  const ch = [...room.sim.props.values()].find(p => p.type === 'cheese');
  // (a wheel, lying flat on it: 14 cm tall, 32 cm across. Its collider was once stood on end, 32 cm tall)
  tick(room, 1.5);
  // (settled on the counter top, by the cheese's spot and clear of every buy spot's ball: inside one, the
  // crosshair found only the spot, and E bought another)
  const t0 = ch && at(room, ch.id), buys = room.W.uses.filter(q => q.kind === 'buy');
  const clear = t0 && buys.every(q => Math.hypot(t0.x - q.x, t0.y - q.y, t0.z - q.z) > (q.r ?? 0.3) + 0.2);
  const onCounter = ch && Math.abs(t0.y - 0.07 - (u.y - 0.1)) < 0.04 && Math.hypot(t0.x - u.x, t0.z - u.z) < 2 && clear && room.bank === 970;
  const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
  const cq = ch?.body.rotation(), up = cq ? 1 - 2 * (cq.x * cq.x + cq.z * cq.z) : 0;
  const under = ch && room.sim.world.castRay(new RAPIER.Ray(ch.body.translation(), { x: 0, y: -1, z: 0 }), 1, true, undefined, undefined, ch.col);
  const flat = !!under && Math.abs(under.timeOfImpact - 0.07) < 0.02 && up > 0.9;
  const r = thief(['Bob']);
  stand(r.room, r.ps[0], r.g.x + 30, r.g.z, Math.PI / 2);
  putLoot(r.room, 'vase', r.g.x - 8, r.g.z, 300);
  const bait = r.room.sim.addProp('cheese', { x: r.g.x, y: r.room.W.heightAt(r.g.x, r.g.z + 9) + 0.3, z: r.g.z + 9 }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
  for (let i = 0; i < 60 * 25 && !mobEvs(r.ps[0], 'steal').length; i++) tick(r.room, 1 / 60);
  const first = mobEvs(r.ps[0], 'steal')[0];
  // (and it's no theft: not one of the den's day, no "ran off with the Cheese Wheel ($0)")
  const D = r.room.sim.mobs.denOf(r.m), told = r.ps[0].conn.has(x => x.t === 'toast' && /took the bait/.test(x.text)) && !r.ps[0].conn.has(x => x.t === 'toast' && /Cheese Wheel \(/.test(x.text));
  check(onCounter && flat && first?.item === bait.id && r.room.dayStats.stolen === 0 && D.thefts === 0 && told, `store: a cheese wheel for $30 lands on the counter, clear of the buy spots (${clear}), lying flat (its middle ${under ? under.timeOfImpact.toFixed(3) : '?'} m up); a den goes for it before a $300 vase (it took the ${first ? (first.item === bait.id ? 'cheese' : 'vase') : 'nothing'}), and that's no theft (${D.thefts} counted)`);
}
{
  // T1: asleep, two friends shoving its flank together tip it over: down for 12 s, then up; one shove on its
  // own just wakes it a moment later
  const out = {};
  for (const two of [true, false]) {
    const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
    room.mobsOn = false;
    const g = openGround(room), id = mobAt(room, A, 'grumphorn', g.x, g.z, { yaw: 0, st: GST.SLEEP }), m = mobOf(room, id);
    // (crept up crouched, side on to it, 1.6 m off its middle, facing it)
    stand(room, A, g.x - 1.6, g.z + 0.4, Math.PI / 2, C.FLAG.CROUCH); stand(room, B, g.x - 1.6, g.z - 0.4, Math.PI / 2, C.FLAG.CROUCH);
    tick(room, 0.5);
    room.handle(A, { t: 'shove' });
    tick(room, 0.3);
    if (two) room.handle(B, { t: 'shove' });
    tick(room, 1 / 60);
    const st0 = m.st;
    tick(room, 1);
    const st1 = m.st;
    // (down the whole TIP_T s: still over half a second before, up half a second after)
    if (two) { tick(room, GH.TIP_T - 1.53); const late = m.st; tick(room, 1); out.two = { st0, st1, late, after: m.st, ev: mobEvs(A, 'tip').length }; }
    else out.one = { st0, st1 };
  }
  check(out.two.st0 === GST.TIPPED && out.two.st1 === GST.TIPPED && out.two.late === GST.TIPPED && out.two.after !== GST.TIPPED && out.two.after !== GST.SLEEP && out.two.ev === 1
    && out.one.st0 === GST.SLEEP && out.one.st1 !== GST.SLEEP,
    `grumphorn: two friends shoving its side tip it over (${out.two.st0 === GST.TIPPED ? 'tipped' : out.two.st0}), it's up after ${GH.TIP_T} s; one shove alone wakes it a moment later (${JSON.stringify(out)})`);
}
{
  // W1: stones heaped at the foot of each Grumphorn sign (seed 14's day 5 put one in a cairn by the road)
  const bad = [];
  let n = 0;
  for (const seed of [4242, 7, 777, 14]) for (let day = 2; day <= 5; day++) {
    const W = generateLeg(seed, day);
    for (const sg of W.signs.filter(q => q.beast)) {
      const k = W.props.filter(p => p.type === 'stone' && Math.hypot(p.x - sg.x, p.z - sg.z) < 3).length;
      n += k;
      if (k < 3) bad.push(`${seed}/${day}: ${k} stones`);
    }
    // (none inside a cairn or a rock)
    for (const p of W.props.filter(q => q.type === 'stone')) {
      if (W.cyls.some(c => Math.hypot(c.x - p.x, c.z - p.z) < c.r + 0.2) || W.hulls.some(c => Math.hypot(c.x - p.x, c.z - p.z) < (c.r || 2) + 0.2)) bad.push(`${seed}/${day}: a stone in a ${W.cyls.some(c => Math.hypot(c.x - p.x, c.z - p.z) < c.r + 0.2) ? 'cairn' : 'rock'}`);
    }
  }
  check(!bad.length, `grumphorn: a heap of stones by every warning sign, none in a cairn or a rock (${n} over 4 seeds x days 2-5)${bad.length ? ': ' + bad.join('; ') : ''}`);
}
{
  // W2: the stones stay in their heaps, asleep (they were balls and rolled off down the slope, 6 m and more;
  // one rocking on a fold of the ground was sent in every snapshot for good)
  const bad = [];
  let n = 0;
  for (const day of [2, 5]) {
    const { room, ps: [A] } = crew(['Ann']);
    room.debug(A, { op: 'day', d: day });
    tick(room, 0.2);
    room.phase = 'road';
    const st = [...room.sim.props.values()].filter(p => p.type === 'stone'), at0 = st.map(p => ({ ...p.body.translation() }));
    tick(room, 20);
    n += st.length;
    st.forEach((p, i) => {
      const d = Math.hypot(p.body.translation().x - at0[i].x, p.body.translation().z - at0[i].z);
      if (!p.body.isSleeping() || d > 0.3) bad.push(`day ${day} stone ${p.id}: ${p.body.isSleeping() ? 'asleep' : 'awake'}, moved ${d.toFixed(2)} m`);
    });
  }
  check(n && !bad.length, `grumphorn: the ${n} stones by the signs stay in their heaps, asleep after 20 s (seed 4242, days 2 and 5)${bad.length ? ': ' + bad.join('; ') : ''}`);
}

// ---- the review's (each failed before its fix) ------------------------------------------------------------
{
  // V1: in the moving RV, junk lying still in the cabin isn't flying (it beaned a rider at the RV's own speed,
  // and flung him back down the cabin); thrown at a rider there, it beans them, on top of the RV's motion
  const { room, ps: [A, B, Cc] } = crew(['Ann', 'Bob', 'Cat']);
  room.mobsOn = false;
  const sim = room.sim, threw = it => Object.assign(it, { thrownBy: Cc.id, thrownAt: sim.t, beaned: false });
  driveAt(room, A, 8, 6, i => {
    ride(room, B, 0, -1, 0); ride(room, Cc, 0, 1.5, 0);
    if (i === 60 * 4) {
      // (a gnome Cat threw down by Bob's feet a moment ago, lying there now)
      const w = toWorld(sim.rv.translation(), sim.rv.rotation(), { x: 0.3, y: 0.3, z: -1 }), g = threw(sim.addProp('gnome', w, sim.rv.rotation(), 70, 70));
      g.body.setLinvel(sim.rv.velocityAtPoint(w), true);
    }
  });
  const still = knocks(B).filter(k => k.why === 'bean').length, v0 = sim.rvSpeed();
  let dir = null;
  driveAt(room, A, 8, 2, i => {
    ride(room, B, 0, -1, 0); ride(room, Cc, 0, 1.5, 0);
    if (i === 30) {
      const rq = sim.rv.rotation(), w = toWorld(sim.rv.translation(), rq, { x: 0, y: 1, z: 0.5 }), g = threw(sim.addProp('gnome', w, rq, 70, 70)), base = sim.rv.velocityAtPoint(w);
      dir = qRotate(rq, { x: 0, y: 0, z: -1 });
      g.body.setLinvel({ x: base.x + dir.x * 8, y: base.y, z: base.z + dir.z * 8 }, true);
    }
  });
  const k = knocks(B).find(x => x.why === 'bean'), along = k && dir ? (k.v[0] * dir.x + k.v[2] * dir.z) / Math.hypot(k.v[0], k.v[2]) : 0;
  check(v0 > 6 && still === 0 && k && k.rel === 1 && along > 0.9 && Math.abs(Math.hypot(k.v[0], k.v[2]) - 2.5) < 0.1,
    `beanings in the moving RV (${v0.toFixed(1)} m/s): a gnome lying in the cabin beans nobody (${still}); one thrown at Bob beans him, the knock on top of the RV's motion (rel ${k?.rel}, ${k ? Math.hypot(k.v[0], k.v[2]).toFixed(2) : '?'} m/s down the cabin)`);
}
{
  // V2: a raider in the RV when it drives off lets go of what it took and jumps out (its legs aimed for a
  // speed over the road: it was pinned in the cabin with the loot, and the crew told it had run off with it).
  // (Off it goes as soon as it's in: whether it has bitten yet or not, it's still in the cabin)
  // (at road speed too: the steps brushing it on its way out were a hit, and it was stunned on them)
  for (const speed of [5, 8.5]) {
    const { room, ps: [A], sim, m, vase } = byTheRV(2, ['Ann']);
    for (let i = 0; i < 60 * 45 && m.st !== RST.INRV; i++) tick(room, 1 / 60);
    let bit = false;
    driveAt(room, A, speed, 12, () => { bit ||= sim.mobs.jaws.has(m.id); });
    bit ||= mobEvs(A, 'drop').length > 0;
    const rl = p => { const l = sim.rvToLocal(p.body.translation()); return insideRV(l.x, l.y, l.z, 0); };
    const critter = sim.props.get(m.id), v = sim.props.get(vase.id);
    check((!critter || !rl(critter)) && v && rl(v) && room.dayStats.stolen === 0 && sim.mobs.denOf(m).thefts === 0 && !A.conn.has(x => x.t === 'toast' && /ran off with/.test(x.text)) && !mobEvs(A, 'stun').length,
      `raids: the RV driving off at ${speed} m/s with a raider inside, it lets go and jumps out, unhurt (state ${m.st}, out ${critter ? !rl(critter) : 'gone'}, it had bitten ${bit}); the vase stays aboard (${v && rl(v)}), no theft, nobody told one (stolen $${room.dayStats.stolen})`);
  }
}
{
  // V3: the door shut on a raider with the vase in its teeth: no theft, and nobody was told of one (the toast
  // went out as it bit)
  const { room, ps: [A], sim, m } = byTheRV(2, ['Ann']);
  for (let i = 0; i < 60 * 45 && !(m.st === RST.INRV && sim.mobs.jaws.has(m.id)); i++) tick(room, 1 / 60);
  const bit = sim.mobs.jaws.has(m.id);
  sim.setDoor(false);
  tick(room, 5);
  check(bit && m.st === RST.TRAPPED && room.dayStats.stolen === 0 && sim.mobs.denOf(m).thefts === 0 && !A.conn.has(x => x.t === 'toast' && /ran off with/.test(x.text)) && !mobEvs(A, 'steal').length,
    `raids: the door shut on a raider with the vase in its teeth: trapped, no theft, and the crew wasn't told of one (stolen $${room.dayStats.stolen})`);
}
{
  // V4: a fallen rock someone picked up and threw is an ordinary stone: at a friend it beans them (it used to
  // knock them out as a "falling rock" for 8 s after it came down)
  const { room, ps: [A, B], W, mobs } = narrows(4);
  const rf = mobs.rockfalls[0], sim = room.sim, s = { x: W.roadX(rf.obz - 120), z: rf.obz - 120 };
  stand(room, A, s.x, s.z, 0); stand(room, B, s.x, s.z + 3, Math.PI);
  tick(room, 0.2);
  const rock = sim.addProp('rock', { x: s.x, y: W.heightAt(s.x, s.z) + 1.2, z: s.z + 0.8 }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
  rf.rocks.push({ id: rock.id, at: mobs.t });   // (one that came down a moment ago)
  Object.assign(rock, { thrownBy: A.id, thrownAt: sim.t, beaned: false });
  rock.body.setLinvel({ x: 0, y: 1, z: 9 }, true);
  tick(room, 1);
  const k = knocks(B)[0];
  // and one rolling on ahead of someone who walked into it and pushed it is no hit (it bowled the pusher over)
  stand(room, B, s.x + 6, s.z, 0);
  tick(room, 1.6);
  const n0 = knocks(B).length, r2 = sim.addProp('rock', { x: s.x + 6, y: W.heightAt(s.x + 6, s.z + 0.6) + 0.3, z: s.z + 0.6 }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
  rf.rocks.push({ id: r2.id, at: mobs.t });
  for (let i = 0; i < 30; i++) { r2.body.setLinvel({ x: 0, y: 0, z: 3 }, true); stand(room, B, s.x + 6, s.z + i * 0.05, 0); tick(room, 1 / 60); }
  const pushed = knocks(B).length - n0;
  check(k && !k.ko && k.why === 'bean' && evs(A.conn, 'bean').length === 1 && pushed === 0, `rockfall: a fallen rock picked up and thrown at a friend beans them, not a knockout (${k ? (k.ko ? 'KO' : 'stumble') + ', ' + k.why : 'missed'}); one rolling on ahead of whoever pushed it is no hit (${pushed})`);
}
{
  // V5: a flank shove waiting on a second, and something else wakes it first: once it dozes off again it
  // stays asleep (the stale shove woke it again out of nowhere)
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  room.mobsOn = false;
  const g = openGround(room), id = mobAt(room, A, 'grumphorn', g.x, g.z, { yaw: 0, st: GST.SLEEP }), m = mobOf(room, id), mobs = room.sim.mobs;
  stand(room, A, g.x - 1.6, g.z + 0.4, Math.PI / 2, C.FLAG.CROUCH); stand(room, B, g.x + 60, g.z, 0);
  tick(room, 0.5);
  room.handle(A, { t: 'shove' });
  tick(room, 0.2);
  const stirred = !!m.stir;
  mobs.horn({ x: g.x, y: room.W.heightAt(g.x, g.z), z: g.z + 10 });
  stand(room, A, g.x - 70, g.z, 0);
  let dozed = null, after = 0;
  for (let i = 0; i < 60 * 60; i++) {
    tick(room, 1 / 60);
    if (dozed == null && (m.st === GST.DOZE || m.st === GST.SLEEP)) dozed = mobEvs(B, 'wake').length;
    if (dozed != null && m.st !== GST.DOZE && m.st !== GST.SLEEP) after++;
  }
  check(stirred && dozed === 1 && after === 0 && mobEvs(B, 'wake').length === 1, `grumphorn: stirred by a shove and woken by the horn first, it dozes off again and stays down (woke ${mobEvs(B, 'wake').length} time(s), ${after ? 'up again' : 'asleep'})`);
}
{
  // V6: nobody up a wall, or standing up high, is nipped (a nip knocked a climber 8 m off the wall: a knockout)
  const c = crew(['Ann', 'Bob']);
  c.room.debug(c.ps[0], { op: 'day', d: 2 }); tick(c.room, 0.2);
  c.room.mobsOn = false;
  const { room, ps: [A, B] } = c, W = room.W, g = openGround(room);
  room.sim.ensureMobs({ day: 2, crew: 2, seed: room.seed }).rtSpawnDen({ id: 7, x: g.x, y: W.heightAt(g.x, g.z), z: g.z, ry: 0, stash: [] });
  stand(room, B, g.x + 60, g.z, 0);
  const pose = (m, up) => room.onPose(A, { x: g.x - 5, y: W.heightAt(g.x - 5, g.z) + up, z: g.z, yaw: Math.PI / 2, pitch: 0, m, f: 0, v: [0, 0, 0] });
  const n = {};
  for (const [k, m, up] of [['climbing', C.MODE.CLIMB, 3], ['up high', C.MODE.WALK, 2.2], ['on the ground', C.MODE.WALK, 0]]) {
    const n0 = mobEvs(A, 'nip').length;
    for (let i = 0; i < 60 * 8; i++) { pose(m, up); tick(room, 1 / 60); }
    n[k] = mobEvs(A, 'nip').length - n0;
  }
  check(n.climbing === 0 && n['up high'] === 0 && n['on the ground'] >= 1, `nips: never someone climbing, or up out of reach; on the ground by the den, yes (${JSON.stringify(n)})`);
}
{
  // V7: a hard hat on, the RV running you over is only a knock: no $500 knockout bill (it was billed, and the
  // hat used up); V8: a new run starts without the last one's hats
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  const s = spot(room);
  stand(room, A, s.x, s.z); stand(room, B, s.x + 2, s.z);
  A.seat = 0; B.hat = true;
  const bank = room.bank;
  room.sim.out.push({ k: 'knock', id: B.id, v: [3, 6, 0], ko: true, why: 'rv' });
  tick(room, 1 / 60);
  const hatSaved = room.bank === bank && B.conn.last('knock')?.ko === true;
  A.seat = null;
  room.newRun(4242);
  check(hatSaved && !B.hat, `store: with a hard hat on, the RV running you over bills nothing (bank ${bank} -> ${room.bank}); a new run starts without the last one's hats (${B.hat})`);
}
{
  // V9: a raid goes for the cheese wheel before the vase (raids skipped it)
  const { room, ps: [A], sim, m, vase, rp, rq } = byTheRV(2, ['Ann']);
  const ch = sim.addProp('cheese', toWorld(rp, rq, { x: -0.3, y: 0.4, z: -2.2 }), { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
  for (let i = 0; i < 60 * 45 && !mobEvs(A, 'steal').length; i++) tick(room, 1 / 60);
  const first = mobEvs(A, 'steal')[0];
  check(first?.item === ch.id && first.bait && room.dayStats.stolen === 0, `raids: a raider takes the cheese wheel before the $300 vase (it took the ${first ? (first.item === ch.id ? 'cheese' : first.item === vase.id ? 'vase' : first.item) : 'nothing'})`);
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
    // dens: beside a ground stop (10-18 m out, away from the road), never at day 1's first stop, with a stash
    if (!W.dens.length || W.dens.length > PLAN[day - 1].dens) bad.push(`${seed}/${day} ${W.dens.length} dens`);
    const first = W.pois.filter(p => p.type !== 'crash').sort((a, b) => a.z - b.z)[0];
    for (const d of W.dens) {
      const poi = W.pois.find(p => p.id === d.poi), r = poi && Math.hypot(d.x - poi.x, d.z - poi.z);
      if (!poi || poi.type === 'crash' || r < 9.9 || r > 18.1) bad.push(`${seed}/${day} den ${d.id} not by a ground stop (${r?.toFixed(1)} m)`);
      if (Math.abs(d.x - W.roadX(d.z)) < 14) bad.push(`${seed}/${day} den ${d.id} by the road`);
      if (W.obstacles.some(o => Math.abs(o.z - d.z) < 30)) bad.push(`${seed}/${day} den ${d.id} by an obstacle`);
      if (day === 1 && poi === first) bad.push(`${seed}/${day} den at the first stop`);
      if (d.stash.length !== (d.hoard ? 4 : 1) || d.stash.some(id => !W.props.some(p => p.id === id && p.id > maxOld))) bad.push(`${seed}/${day} den ${d.id} stash`);
    }
  }
  check(!bad.length, `world gen: the wildlife changes nothing else (3 seeds x 5 days), beds sit on the road past their obstacle, dens beside the stops${bad.length ? ': ' + bad.slice(0, 6).join('; ') : ''}`);
}

if (failed) { console.error('\nSome wildlife checks FAILED'); process.exit(1); }
console.log('\nAll wildlife checks passed');
process.exit(0);
