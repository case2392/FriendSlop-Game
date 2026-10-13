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

if (failed) { console.error('\nSome wildlife checks FAILED'); process.exit(1); }
console.log('\nAll wildlife checks passed');
process.exit(0);
