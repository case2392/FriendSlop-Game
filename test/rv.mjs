// The RV's condition (shared/constants.js RVH): crashes and the wildlife wear it down, a worn RV is down on
// power, at 0% it breaks down until somebody fixes it at the engine hatch, and Gus fixes it in town for cash
// or on the loan. It never ends a trip: only a missed payment does. In process (Room + Sim with fake
// connections), the wildlife off (what it does to the RV is in test/mobs.mjs).
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOLOCKER = '1';   // (loose loot in the RV's cabin, as before the locker; its own tests turn it on)
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { RV_HATCH, RV_WHEELS, RV_DIM, RV_MAP_SPOT, qRotate, qYaw, toWorld, toLocal, insideRV } = await import('../shared/rv.js');
const { generateLeg } = await import('../shared/world.js');
const { LOOT, CARRY, carryDist } = await import('../shared/loot.js');

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
  room.onRVHit = e => { const r = f(e); seen.push({ ...e, priced: r, t: room.t }); return r; };
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
const press = (room, p, arg) => { const u = gusUse(room, arg); stand(room, p, u.x + 1.0, u.z, -Math.PI / 2); room.handle(p, { t: 'use', id: u.id }); tick(room, 1 / HZ); };
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
    // (the handbrake from cruise: at the first moment past 20 s at 11 m/s or more, else at 30 s)
    drive(room, A, 14, 30, { onTick: i => { top = Math.max(top, sim.rvSpeed()); secs = (i + 1) / HZ; return sim.rv.translation().z < stopAt && !(secs > 20 && sim.rvSpeed() > 11); } });
    const v0 = sim.rvSpeed(), inside = sim.cargo().length;
    pedal(room, A, 0, 4, 0, 1);
    out.push({ day, top, v0, secs, inside, stop: sim.rvSpeed(), worst: worst(seen), hp: room.rvc.hp });
  }
  check(out.every(o => o.worst <= C.RVH.FREE && o.hp === 100 && o.top > 11 && o.v0 > 9 && Math.abs(o.stop) < 0.5 && o.inside >= 6),
    `rv: keyboard driving on each day's road, then the handbrake from cruise with ${LOOSE.length} loose things (2 safes) aboard, costs nothing ` +
    out.map(o => `(day ${o.day}: ${o.secs.toFixed(0)} s, top ${o.top.toFixed(1)} m/s, braked from ${o.v0.toFixed(1)} with ${o.inside} aboard, worst ${o.worst.toFixed(2)} m/s)`).join(' '));
}
{
  // a teleport is no crash: the RV put down with its nose 0.6 m into the closed ranger gate's bars (day 3) is
  // shoved back out of them (without the settle window that's a 4 m/s knock, 6%), and nothing counts till it
  // has settled. Then on its side, settled, and set back on its wheels (the tow)
  const { room, ps: [A] } = crew(['Ann'], 3);
  A.seat = null;
  const sim = room.sim, W = room.W, g = W.gates[0], seen = hits(room), gz = g.z - 4.25 + 0.6;
  sim.placeRV(W.roadX(gz), gz, roadYaw(W, gz));
  tick(room, 3);
  const afterPlace = worst(seen), shoved = gz - sim.rv.translation().z, hpPlaced = room.rvc.hp;
  sim.placeRV(W.roadX(200), 200, roadYaw(W, 200));
  tick(room, 2);
  // on its side, settled, then righted (the tow)
  const t = sim.rv.translation();
  sim.rv.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true);
  sim.rv.setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) }, true);
  tick(room, 4);
  const n = seen.length, flipped = sim.rvFlipped();
  sim.rightRV();
  tick(room, 3);
  const righted = seen.slice(n);
  check(afterPlace <= C.RVH.FREE && hpPlaced === 100 && shoved > 0.3 && flipped && !sim.rvFlipped() && worst(righted) <= C.RVH.FREE,
    `rv: put down with its nose in the gate's bars it's shoved back ${shoved.toFixed(2)} m and nothing counts (RV ${hpPlaced}%), and set back on its wheels from its side (worst ${worst(righted).toFixed(2)} m/s): no crash`);
}
{
  // on its side on the steepest bank by the road (day 1, about 45 degrees): after 7 s the tow truck puts it back
  // on the road nearby, on its wheels and facing up it, and that costs the RV nothing (the $800 is the tow's)
  const { room, ps: [A] } = crew(['Ann'], 1);
  room.phase = 'road';
  const W = room.W, sim = room.sim;
  let best = null, bs = 0;
  for (let zz = 150; zz < 500; zz += 3) for (let off = 6; off < 40; off++) for (const s of [-1, 1]) {
    const xx = W.roadX(zz) + s * off, sl = Math.hypot(W.heightAt(xx + 1, zz) - W.heightAt(xx - 1, zz), W.heightAt(xx, zz + 1) - W.heightAt(xx, zz - 1)) / 2;
    if (sl > bs && sl < 1.0) { bs = sl; best = { x: xx, z: zz }; }
  }
  const yaw = roadYaw(W, best.z) + Math.PI / 2;
  sim.placeRV(best.x, best.z, yaw);
  const t = sim.rv.translation(), yq = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, rq = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
  sim.rv.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true);
  sim.rv.setRotation({ x: yq.w * rq.x + yq.x * rq.w + yq.y * rq.z - yq.z * rq.y, y: yq.w * rq.y - yq.x * rq.z + yq.y * rq.w + yq.z * rq.x, z: yq.w * rq.z + yq.x * rq.y - yq.y * rq.x + yq.z * rq.w, w: yq.w * rq.w - yq.x * rq.x - yq.y * rq.y - yq.z * rq.z }, true);
  const seen = hits(room), bills = room.stats.bills;
  let towAt = null;
  for (let i = 0; i < 16 * HZ; i++) { const b = room.stats.bills; room.tick(1 / HZ); if (room.stats.bills > b && towAt == null) towAt = room.t; }
  const after = seen.filter(h => h.priced && towAt != null && h.t > towAt), p = sim.rv.translation();
  check(bs > 0.9 && towAt != null && room.stats.bills - bills === 800 && !after.length && !sim.rvFlipped() && Math.abs(p.x - W.roadX(p.z)) < 1 && Math.abs(p.z - best.z) <= 41,
    `rv: towed off a ${(Math.atan(bs) * 180 / Math.PI).toFixed(0)}-degree bank: back on the road ${Math.abs(p.z - best.z).toFixed(0)} m along, on its wheels, and nothing more off the RV (${after.length} hits after the tow)`);
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
  // reeled in up the grade, the driver feathering the throttle, till the back wheels are 2 m over the top (where
  // a crew stops the reel), then the reel stopped and 3 s more
  sim.hook.reeling = true;
  let up = false;
  for (let i = 0; i < 40 * HZ && !up; i++) { pedal(room, A, 0.5, 1 / HZ); up = sim.rv.translation().z - 2.6 > grade.z1 + 2; }
  sim.hook.reeling = false;
  pedal(room, A, 0, 3);
  check(held < 1.5 && up && worst(seen) <= C.RVH.FREE && room.rvc.hp === 100,
    `rv: day ${day}: flooring it against the clipped winch (it moved ${held.toFixed(2)} m) and winching up the ${grade.h.toFixed(1)} m grade and over: no crash (worst ${worst(seen).toFixed(2)} m/s)`);
}
{
  // every grade on two seeds, hauled with nobody at the wheel (the crew outside working the winch) till the
  // back wheels are over the top, the reel stopped, 3 s more: a post clipped off to the side of the road has it
  // run on along its wheels faster than the cable shortens, so the winch gives no more pull past the drum's
  // speed: it never comes over at a run and into the post across the road. Nothing costs the RV anything
  const runs = [];
  for (const seed of [4242, 777]) for (let day = 1; day <= 5; day++) {
    const n = generateLeg(seed, day).obstacles.filter(o => o.type === 'grade').length;
    for (let gi = 0; gi < n; gi++) {
      const { room, ps: [A] } = crew(['Ann'], day, seed);
      A.seat = null;
      const W = room.W, sim = room.sim, grade = W.obstacles.filter(o => o.type === 'grade')[gi];
      for (const g of W.gates) sim.openGate(g.id);
      for (const p of [...sim.props.values()]) if (p.type === 'boulder') sim.removeProp(p.id);
      const rz = grade.z0 - 5.5;
      sim.placeRV(W.roadX(rz), rz, roadYaw(W, rz));
      tick(room, 1.5);
      const w = sim.winchWorld(), anc = W.anchors.filter(a => a.z > grade.z1 - 3 && Math.hypot(a.x - w.x, a.y - w.y, a.z - w.z) < C.WINCH.MAX_LEN - 2)
        .sort((a, b) => Math.hypot(a.x - w.x, a.z - w.z) - Math.hypot(b.x - w.x, b.z - w.z))[0];
      Object.assign(sim.hook, { state: 'anchored', body: null, anchor: { x: anc.x, y: anc.y, z: anc.z }, attach: null, holder: null, reeling: true, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 });
      const seen = hits(room);
      let vmax = 0, best = -Infinity, bestAt = 0, i = 0;
      for (; i < 60 * HZ && sim.rv.translation().z - 2.6 < grade.z1 + 2 && (i < 3 * HZ || i - bestAt < 2 * HZ); i++) {
        room.tick(1 / HZ);
        const v = sim.rv.linvel(), z = sim.rv.translation().z;
        vmax = Math.max(vmax, Math.hypot(v.x, v.y, v.z));
        if (z > best + 0.05) { best = z; bestAt = i; }
      }
      sim.hook.reeling = false;
      tick(room, 3);
      runs.push({ seed, day, gi, over: sim.rv.translation().z - 2.6 > grade.z1 + 1, vmax, cost: seen.filter(h => h.priced).reduce((s, h) => s + h.amt, 0) });
    }
  }
  const fast = Math.max(...runs.map(r => r.vmax));
  check(runs.length >= 10 && runs.every(r => r.over && !r.cost) && fast < C.WINCH.REEL_SPEED + C.WINCH.OVERRUN + 0.4,
    `rv: ${runs.length} grades hauled with nobody at the wheel: all over the top (${runs.filter(r => r.over).length}), nothing off the RV (${runs.filter(r => r.cost).map(r => `seed ${r.seed} day ${r.day}: -${r.cost}%`).join(', ') || 'none'}), never faster than ${fast.toFixed(2)} m/s on the cable`);
}
{
  // the steepest grade there is (day 5, seed 120: 14.5 m), three safes aboard (450 kg) and nobody at the
  // wheel: the winch alone hauls it up. Then the cable snagged (the RV held fast) while the drum winds, and let
  // go: the drum stalls at its rated pull, and the RV comes at about the drum's speed, not flung up the hill
  const { room, ps: [A] } = crew(['Ann'], 5, 120);
  const W = room.W, sim = room.sim, grade = W.obstacles.filter(o => o.type === 'grade').sort((a, b) => b.h - a.h)[0];
  const rz = grade.z0 - 7;
  sim.placeRV(W.roadX(rz), rz, roadYaw(W, rz));
  tick(room, 1.5);
  const top = { x: W.roadX(grade.z1), z: grade.z1 }, anc = W.anchors.reduce((b, a) => (Math.hypot(a.x - top.x, a.z - top.z) < Math.hypot(b.x - top.x, b.z - top.z) ? a : b));
  const clip = () => { const w = sim.winchWorld(); Object.assign(sim.hook, { state: 'anchored', body: null, anchor: { x: anc.x, y: anc.y, z: anc.z }, attach: null, holder: null, reeling: true, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 }); };
  const stretch = () => { const w = sim.winchWorld(); return Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) - sim.hook.len; };
  const seen = hits(room);
  // the snag first, at the foot
  clip();
  sim.rv.lockTranslations(true, true); sim.rv.lockRotations(true, true);
  tick(room, 4);
  const held = stretch();
  sim.rv.lockTranslations(false, true); sim.rv.lockRotations(false, true);
  let vmax = 0;
  for (let i = 0; i < 4 * HZ; i++) { room.tick(1 / HZ); const v = sim.rv.linvel(); vmax = Math.max(vmax, Math.hypot(v.x, v.z)); }
  check(held > 1.1 && held < 1.4 && vmax < 3.3 && worst(seen) <= C.RVH.FREE,
    `rv: the winch winding against a snag stalls at its rated pull (${held.toFixed(2)} m of stretch, ${(Math.min(held * C.WINCH.STIFF, C.WINCH.FORCE) / 1000).toFixed(0)} kN); let go, the RV comes at ${vmax.toFixed(2)} m/s at most, no crash`);
  // then the climb with the safes aboard
  sim.placeRV(W.roadX(rz), rz, roadYaw(W, rz));
  tick(room, 1.5);
  const rp = sim.rv.translation(), rq = sim.rv.rotation();
  for (let k = 0; k < 3; k++) sim.addProp('safe', toWorld(rp, rq, { x: k % 2 ? 0.5 : -0.5, y: 0.5, z: -2.6 + Math.floor(k / 2) * 1.0 }), { x: 0, y: 0, z: 0, w: 1 }, 100, 100);
  tick(room, 1.5);
  clip();
  A.seat = null;
  let up = false, secs = 0;
  for (let i = 0; i < 40 * HZ && !up; i++) { room.tick(1 / HZ); up = sim.rv.translation().z > grade.z1 + 1.5; secs = i / HZ; }
  check(grade.h > 14 && up && worst(seen) <= C.RVH.FREE && room.rvc.hp === 100,
    `rv: day 5's ${grade.h.toFixed(1)} m grade with three safes aboard and nobody driving: the winch alone gets it up (${up ? `${secs.toFixed(0)} s` : 'stuck'}), no crash`);
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
{
  // a rock and then a swerve into the wall 0.5 s later: one incident, told as both, and it counts as a crash
  const { room, ps: [A] } = crew(['Ann']);
  A.seat = 0;
  room.debug(A, { op: 'rvhit', why: 'rock', amt: 3 });
  tick(room, 0.5);
  room.debug(A, { op: 'rvhit', why: 'crash', dv: 8, what: 'the canyon wall' });
  tick(room, 2.5);
  A.seat = null;
  const said = A.conn.all('toast').filter(m => /\(RV \d+%\)\.$/.test(m.text)), S = room.stats.rv;
  check(said.length === 1 && said[0].text === 'CRUNCH. Ann put the RV into the canyon wall: -18%, plus rocks -3% (RV 79%).' && S.crashes === 1 && S.worst?.amt === 18 && S.worst?.what === 'the canyon wall' && room.dayStats.rv.src.Ann === 18 && room.dayStats.rv.src.rocks === 3,
    `rv: a rock and then a crash 0.5 s apart: '${said[0]?.text}' (${S.crashes} crash, the worst -${S.worst?.amt}% into ${S.worst?.what})`);
}
{
  // a 20% knock on an RV at 5% costs it the 5% it had: the float, the toast and the day's damage all say 5
  const { room, ps: [A] } = crew(['Ann']);
  room.debug(A, { op: 'rvhp', hp: 5 });
  tick(room, 0.1);
  room.debug(A, { op: 'rvhit', why: 'beast', amt: 20 });
  tick(room, 2.5);
  const ev = evs(A.conn, 'rvhit').at(-1), said = toasts(A.conn, /Grumphorn/);
  check(room.rvc.hp === 0 && ev?.amt === 5 && room.dayStats.rv.dmg === 5 && room.stats.rv.dmg === 5 && said.length === 1 && /: -5% \(RV 0%\)\.$/.test(said[0].text),
    `rv: a 20% knock on an RV at 5%: the float says -${ev?.amt}%, today -${room.dayStats.rv.dmg}%, '${said[0]?.text}'`);
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
{
  // night 4 with two at the bench: Bob's press after Ann's asks Bob (it doesn't sign Ann's), Ann's second
  // signs hers, and Bob's second asks again, the balloon having moved since he was told it
  const { room, ps: [A, B] } = crew(['Ann', 'Bob'], 4);
  const R = room.rvc, asked = p => toasts(p.conn, /Press again to sign/).length;
  payUp(room);
  room.debug(A, { op: 'rvhp', hp: 40 });
  press(room, A, 'loan');
  tick(room, 1);
  press(room, B, 'loan');
  const bob = R.hp === 40 && room.loanAdd === 0 && asked(B) === 1;
  tick(room, 1);
  press(room, A, 'loan');
  const ann = R.hp === 65 && room.loanAdd === 415;
  press(room, B, 'loan');
  const again = R.hp === 65 && room.loanAdd === 415 && asked(B) === 2;
  tick(room, 1);
  press(room, B, 'loan');
  check(bob && ann && again && R.hp === 90 && room.loanAdd === 830,
    `rv: night 4, two at Gus's bench: Bob's press asks Bob (${bob}), Ann's second signs hers (${ann}), Bob's next asks again at the new balloon (${again}), and his second signs: RV ${R.hp}%, ${room.loanAdd} on the balloon`);
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
  {
    // somebody joining tonight gets the RV as it is now (Gus may have fixed it since nightfall)
    room.bank += 1000;
    press(room, A, 'cash');
    const c = new FakeConn(), late = room.addPlayer(c, 'Cal').player;
    room.welcome(late);
    const r2 = c.last('receipt');
    check(room.rvc.hp === 100 && r2?.rv?.hp === 100 && r2.rv.quote.pts === 0 && r2.rv.today === 23 && A.conn.last('receipt')?.rv?.hp === 77,
      `rv: somebody joining after Gus fixed it gets the RV as it is (${r2?.rv?.hp}%, Gus's next ${r2?.rv?.quote?.pts}%), not as it was at nightfall`);
    room.removePlayer(late.id, 'left');
    room.debug(A, { op: 'rvhp', hp: 77 });
  }
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

// ---- the load: what rides inside the RV --------------------------------------------------------------------
{
  // L1: a knock is what a thing felt. Two slot machines in a parked RV, one jammed between the seats and into
  // the dash (the forces from each side cancel and it doesn't move), one pressed into the cab's rail. Jammed
  // things used to be counted as knocks, every step: two slot machines in the cab broke within four seconds
  const { room } = crew(['Ann']);
  const sim = room.sim, r = sim.rv.translation(), q = sim.rv.rotation();
  const a = sim.addProp('slot', toWorld(r, q, { x: 0, y: 0.75, z: 3.2 }), q, 950, 950);
  const b = sim.addProp('slot', toWorld(r, q, { x: -0.21, y: 0.75, z: 2.1 }), q, 950, 950);
  tick(room, 4);
  const va = sim.props.get(a.id)?.value, vb = sim.props.get(b.id)?.value;
  check(va > 900 && vb > 900, `load: two slot machines jammed into a parked RV's cab keep their value (${Math.round(va ?? 0)} and ${Math.round(vb ?? 0)} of 950)`);
  // and a real knock still counts: a vase dropped from 3 m onto the road
  const g = { x: r.x + 6, z: r.z + 6 }, y0 = room.W.heightAt(g.x, g.z);
  const v = sim.addProp('vase', { x: g.x, y: y0 + 3, z: g.z }, { x: 0, y: 0, z: 0, w: 1 }, 520, 520);
  tick(room, 2);
  const left = sim.props.get(v.id)?.value ?? 0;
  check(left < 470, `load: a vase dropped 3 m onto the road still takes the knock (${Math.round(left)} of 520 left)`);
}
{
  // L2: the RV's walls hold its load. A gnome riding inside that ends up out past the windshield (pressed
  // through it by a pile on a hard stop) is back inside on the next step; one out through the open door
  // stays out; one on the roof was never inside and is left alone
  const { room } = crew(['Ann']);
  const sim = room.sim, r = sim.rv.translation(), q = sim.rv.rotation();
  const gn = sim.addProp('gnome', toWorld(r, q, { x: 0.2, y: 0.3, z: 1.0 }), q, 70, 70);
  tick(room, 0.5);
  sim.props.get(gn.id).body.setTranslation(toWorld(r, q, { x: 0.2, y: 0.5, z: 4.45 }), true);
  tick(room, 1 / HZ);
  const l = toLocal(r, q, sim.props.get(gn.id).body.translation());
  check(insideRV(l.x, l.y, l.z, -0.05), `load: a gnome pressed out through the windshield is back inside (RV-local z ${l.z.toFixed(2)})`);
  sim.setDoor(true);
  tick(room, 0.3);
  sim.props.get(gn.id).body.setTranslation(toWorld(r, q, { x: -1.7, y: 0.4, z: RV_DIM.DOOR_Z }), true);
  tick(room, 0.5);
  const l2 = toLocal(r, q, sim.props.get(gn.id).body.translation());
  check(l2.x < -1.3, `load: a gnome out through the open door stays out (RV-local x ${l2.x.toFixed(2)})`);
  const top = sim.addProp('gnome', toWorld(r, q, { x: 0, y: RV_DIM.ROOF_Y + 0.3, z: 0 }), q, 70, 70);
  tick(room, 0.5);
  sim.props.get(top.id).body.setTranslation(toWorld(r, q, { x: 2.5, y: 0.5, z: 0 }), true);
  tick(room, 0.5);
  const l3 = toLocal(r, q, sim.props.get(top.id).body.translation());
  check(l3.x > 1.5, `load: a gnome off the roof isn't pulled inside (RV-local x ${l3.x.toFixed(2)})`);
}

// ---- K5-K7: the Garage's parts and perks (shared/garage.js) ---------------------------------------------------
// a player with a save's kit (shared/profile.js kitFor's shape), in `room`
const kitted = (room, name, kit, n) => {
  const c = new FakeConn(), p = room.addPlayer(c, name).player;
  p.key = 'tok:' + name; room.setProfile(p, { pid: String(n).repeat(16), kit }); room.welcome(p); p.conn = c;
  return p;
};
// the RV out of camp on day 1 (the trip's parts are fitted then)
const depart = room => { room.sim.placeRV(room.W.roadX(room.W.camp.exitZ + 8), room.W.camp.exitZ + 8, 0); tick(room, 1 / HZ); };
// what a crash at dv m/s into `zone` costs an RV at 100%
const crashCost = (room, dv, zone) => {
  room.rvc.hp = 100; room.rvc.inc = null; room.sim.setRvCond(100);
  room.onRVHit({ why: 'crash', dv, zone, what: 'a test wall' });
  return 100 - room.rvc.hp;
};
{
  // K5: fitted as the RV leaves camp on day 1 (the best of each kind among everyone aboard, a guest's too), on
  // every day's RV after; a late joiner's waits. The Bull Bar II: +250 kg on the nose, and a head-on crash at
  // 8 m/s costs 0.7 of what it did; one into the side the same
  const room = new Room('KIT', 4242);
  const A = kitted(room, 'Ann', { perks: {}, part: { id: 'bullbar', lv: 2 } }, 'a');
  kitted(room, 'Bob', { perks: { gloves: 1 }, part: { id: 'winch', lv: 1 } }, 'b');
  tick(room, 0.5);
  const m0 = room.sim.rv.mass(), before = JSON.stringify(room.partMods);
  depart(room);
  tick(room, 0.2);
  const m1 = room.sim.rv.mass(), fitted = JSON.stringify(room.fit.parts), departed = room.departed;
  kitted(room, 'Lou', { perks: {}, part: { id: 'toolbox', lv: 2 } }, 'c');
  room.nextDay();
  tick(room, 0.2);
  const m2 = room.sim.rv.mass(), reel2 = room.sim.parts.reel, fix2 = room.partMods.fixX, meta = A.conn.last('meta')?.trip;
  const front = crashCost(room, 8, 'front'), side = crashCost(room, 8, 'left');
  const stock = new Room('STK', 4242);
  kitted(stock, 'Cat', null, 'd');
  const sFront = crashCost(stock, 8, 'front'), sSide = crashCost(stock, 8, 'left');
  check(departed && before === JSON.stringify(stock.partMods) && fitted === '{"bullbar":2,"winch":1}' && Math.abs(m1 - m0 - 250) <= 1 && Math.abs(m2 - m1) <= 1 && reel2 === 2.0 && fix2 === 1
    && JSON.stringify(meta?.parts) === fitted && Math.abs(front - sFront * 0.7) <= 0.5 && side === sSide && sFront === C.crashDamage(8),
    `garage: the RV left camp fitted with ${fitted} (Ann's Bull Bar II, Bob's Winch Motor I), +${(m1 - m0).toFixed(1)} kg, still fitted on day 2 (${(m2 - m0).toFixed(1)} kg, reel ${reel2} m/s); Lou's Toolbox, joining late, waits; an 8 m/s crash head-on costs ${front}% (stock ${sFront}%), into the side ${side}% (stock ${sSide}%)`);
  room.sim.free?.(); stock.sim.free?.();
}
{
  // K6: Winch Motor II reels at 2.4 m/s, the cable still 42 m; a Toolbox II fix takes 4 s alone; Medic II gets a
  // friend up with 60 stamina; one pair of Gloves II hands can't lift the 120 kg dino head 0.3 m in 3 s, but can
  // the 85 kg slot machine, and two people the head
  const reelRate = kit => {
    const room = new Room('WIN', 4242);
    const A = kitted(room, 'Ann', kit, 'a');
    depart(room);
    const sim = room.sim;
    flatSpot(room);
    const f = fwdOf(room), w = sim.winchWorld(), anc = { x: w.x + f.x * 20, y: w.y + 1, z: w.z + f.z * 20 };
    Object.assign(sim.hook, { state: 'anchored', body: null, anchor: anc, attach: null, holder: null, reeling: true, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 });
    tick(room, 2);
    const l0 = sim.hook.len;
    tick(room, 2);
    const rate = (l0 - sim.hook.len) / 2;
    room.sim.free?.();
    return rate;
  };
  const stockReel = reelRate(null), fastReel = reelRate({ perks: {}, part: { id: 'winch', lv: 2 } });
  const fixAlone = kit => {
    const room = new Room('FIX', 4242);
    const A = kitted(room, 'Ann', kit, 'a');
    depart(room);
    flatSpot(room);
    room.debug(A, { op: 'rvhp', hp: 0 });
    behind(room, A, 1.5);
    fixing(room, [A], true);
    let t = null;
    for (let i = 0; i < 12 * HZ && t == null; i++) { room.tick(1 / HZ); if (room.rvc.hp > 0) t = (i + 1) / HZ; }
    room.sim.free?.();
    return t;
  };
  const fixT = fixAlone({ perks: {}, part: { id: 'toolbox', lv: 2 } });
  const revive = kit => {
    const room = new Room('MED', 4242);
    const A = kitted(room, 'Ann', kit, 'a'), B = kitted(room, 'Bob', null, 'b');
    tick(room, 0.3);
    stand(room, A, 0, 20); stand(room, B, 1.5, 20);
    tick(room, 1 / HZ);
    B.ko = true;
    room.handle(A, { t: 'use', kind: 'revive', id: B.id });
    room.sim.free?.();
    return B.conn.last('revived')?.stam;
  };
  const stam = [revive(null), revive({ perks: { medic: 2 }, part: null })];
  // how high hands get the thing in 3 s, aiming 0.8 m above where they hold it (every holder from 1.6 m off)
  const lift = (type, kits) => {
    const room = new Room('LFT', 4242);
    const ps = kits.map((k, i) => kitted(room, 'P' + i, k, 'abc'[i]));
    tick(room, 0.3);
    const g = { x: room.W.roadX(60), z: 60 }, y = room.W.heightAt(g.x, g.z), half = LOOT[type].shape[2];
    const pr = room.sim.addProp(type, { x: g.x, y: y + half + 0.05, z: g.z }, { x: 0, y: 0, z: 0, w: 1 }, 500, 500);
    tick(room, 1.5);
    const t0 = pr.body.translation(), top = { x: t0.x, y: t0.y + LOOT[type].shape[2] * 0.6, z: t0.z };
    ps.forEach((p, i) => {
      const a = i * Math.PI, px = t0.x + Math.sin(a) * 1.6, pz = t0.z + Math.cos(a) * 1.6, py = room.W.heightAt(px, pz);
      const eye = { x: px, y: py + C.PLAYER.EYE, z: pz }, aim = { x: top.x, y: top.y + 0.8, z: top.z };
      const dx = aim.x - eye.x, dy = aim.y - eye.y, dz = aim.z - eye.z;
      room.onPose(p, { x: px, y: py, z: pz, yaw: Math.atan2(dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)), m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
      tick(room, 1 / HZ);
      room.handle(p, { t: 'grab', kind: 'prop', id: pr.id, pt: [top.x, top.y, top.z], d: Math.hypot(dx, dy, dz) });
    });
    let up = 0;
    for (let i = 0; i < 3 * HZ; i++) { room.tick(1 / HZ); up = Math.max(up, pr.body.translation().y - t0.y); }
    const held = room.sim.holds.size;
    room.sim.free?.();
    return { up, held };
  };
  const G2 = { perks: { gloves: 2 }, part: null };
  const head1 = lift('dino', [G2]), slot1 = lift('slot', [G2]), head2 = lift('dino', [G2, null]), slotStock = lift('slot', [null]);
  check(Math.abs(stockReel - C.WINCH.REEL_SPEED) < 0.08 && Math.abs(fastReel - 2.4) < 0.08 && C.WINCH.MAX_LEN === 42,
    `garage: the winch reels ${stockReel.toFixed(2)} m/s stock, ${fastReel.toFixed(2)} m/s with a Winch Motor II (2.4); the cable is still ${C.WINCH.MAX_LEN} m`);
  check(fixT != null && Math.abs(fixT - 4) < 0.05, `garage: a Toolbox II fix takes ${fixT?.toFixed(2)} s alone (stock 8)`);
  check(stam[0] === 40 && stam[1] === 60, `garage: picked up by a friend, you get up with ${stam[0]} stamina; by one with a Medic Bag II, ${stam[1]}`);
  check(head1.up < 0.3 && slot1.up >= 0.3 && head2.up >= 0.3 && slotStock.up >= 0.3,
    `garage: Gloves II hands alone get the dino head ${head1.up.toFixed(2)} m up in 3 s (it takes two: ${head2.up.toFixed(2)} m), the slot machine ${slot1.up.toFixed(2)} m (stock hands ${slotStock.up.toFixed(2)} m)`);
}
{
  // K7: Steady Hands II at the wheel: full lock held for 5 s at 13 m/s on open ground keeps the RV under
  // 0.82 g sideways and on its wheels; the same input without it peaks higher (the perk never makes it worse)
  const run = kit => {
    let best = null;
    const room = new Room('STD', 4242);
    const A = kitted(room, 'Ann', kit, 'a');
    depart(room);
    const W = room.W, sim = room.sim;
    for (const g of W.gates) sim.openGate(g.id);
    // the flattest open 72 m square off the road, nothing standing in it (2.2 m of rise at most, seed 4242's day 1);
    // the RV started 18 m from its middle, the turn's side (full right turns it toward its +x) taking it round it
    let bs = Infinity;
    for (let z = 80; z < W.LEN - 80; z += 6) for (let off = -120; off <= 120; off += 10) {
      if (Math.abs(off) < 12) continue;
      const x = W.roadX(z) + off, h = W.heightAt(x, z);
      if (W.statics.some(b => Math.hypot(b.x - x, b.z - z) < 40) || W.cyls.some(c => Math.hypot(c.x - x, c.z - z) < 40) || (W.hulls || []).some(c => Math.hypot(c.x - x, c.z - z) < 40 + c.r)) continue;
      let dev = 0;
      for (let dx = -36; dx <= 36 && dev < bs; dx += 6) for (let dz = -36; dz <= 36; dz += 6) dev = Math.max(dev, Math.abs(W.heightAt(x + dx, z + dz) - h));
      if (dev < bs) { bs = dev; best = { x, z, dev }; }
    }
    sim.placeRV(best.x - 18, best.z, 0);
    tick(room, 1.5);
    const f = fwdOf(room);
    sim.rv.setLinvel({ x: f.x * 13, y: 0, z: f.z * 13 }, true);
    let peak = 0, g = 0, upright = 1;
    A.seat = 0;
    for (let i = 0; i < 5 * HZ; i++) {
      const v = sim.rvSpeed();
      room.handle(A, { t: 'drv', th: v < 12.7 ? 1 : 0, st: 1, hb: 0 });
      room.tick(1 / HZ);
      const lv = sim.rv.linvel(), w = sim.rv.angvel();
      g += (Math.abs(w.y) * Math.hypot(lv.x, lv.z) / 9.81 - g) * (1 / HZ) / 0.1;   // (smoothed over a tenth of a second)
      peak = Math.max(peak, g);
      upright = Math.min(upright, qRotate(sim.rv.rotation(), { x: 0, y: 1, z: 0 }).y);
    }
    room.sim.free?.();
    return { peak, upright, dev: best.dev };
  };
  const off = run(null), on = run({ perks: { steady: 2 }, part: null });
  check(on.peak <= 0.82 && on.upright > 0.7 && off.peak > on.peak,
    `garage: full lock at 13 m/s for 5 s: with Steady Hands II the RV peaks at ${on.peak.toFixed(2)} g sideways and stays up (its roof at ${on.upright.toFixed(2)}); without, ${off.peak.toFixed(2)} g (roof ${off.upright.toFixed(2)}) (ground within ${on.dev.toFixed(1)} m)`);
}

// ---- the road map stays put on the dash while the RV drives; put down anywhere, it goes back there ----
{
  const { room, ps: [A, B] } = crew(['Ann', 'Bo']);
  const sim = room.sim, map = [...sim.props.values()].find(p => p.type === 'map');
  const off = () => { const l = toLocal(sim.rv.translation(), sim.rv.rotation(), map.body.translation()); return Math.hypot(l.x - RV_MAP_SPOT.x, l.y - RV_MAP_SPOT.y, l.z - RV_MAP_SPOT.z); };
  const d0 = off();
  let worst = 0;
  const z0 = sim.rv.translation().z;
  drive(room, A, 9, 10, { onTick: () => { worst = Math.max(worst, off()); } });
  pedal(room, A, 0, 2, 0, 1);
  const went = sim.rv.translation().z - z0;
  // Bo takes it up (the physics' grab: who may is the room's rule) and lets go of it over the floor
  ride(room, B, -0.2, 2.2);
  tick(room, 0.2);
  const c = map.body.translation();
  const took = sim.grab(B.id, B, { kind: 'prop', id: map.id, pt: [c.x, c.y, c.z], d: 1.0 }) !== false && map.holders.has(B.id);
  tick(room, 0.8);
  const away = off();
  sim.release(B.id);
  tick(room, 0.5);
  const back = off();
  check(d0 < 0.02 && went > 30 && worst < 0.03 && took && away > 0.1 && back < 0.02,
    `rv: the road map sits on the passenger-side dash and stays there over ${went.toFixed(0)} m of road (moved at most ${(worst * 100).toFixed(1)} cm); taken up (${(away * 100).toFixed(0)} cm off its spot) and let go, it's back on it (${(back * 100).toFixed(1)} cm)`);
}

// ---- what one person carries is in both hands: by its middle, at chest height, turning as they turn ----
{
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim, W = room.W;
  const z = 120, x = W.roadX(z) + 3, y = W.heightAt(x, z);
  stand(room, A, x, z, Math.PI / 2);
  const tv = sim.addProp('tv', { x: x + 1.1, y: W.heightAt(x + 1.1, z) + 0.4, z }, { x: 0, y: 0, z: 0, w: 1 }, 300, 300);
  tick(room, 1);
  const c = tv.body.translation();
  room.handle(A, { t: 'grab', kind: 'prop', id: tv.id, pt: [c.x, c.y, c.z], d: carryDist('tv') });   // (as the page asks)
  tick(room, 1.5);
  const d = carryDist('tv'), e1 = A.eye, at1 = tv.body.translation();
  const off1 = Math.hypot(at1.x - (e1.x + d), at1.y - (e1.y - CARRY.DROP), at1.z - e1.z), yaw1 = qYaw(tv.body.rotation());
  stand(room, A, x, z, 0);   // a quarter turn, to face up the road
  tick(room, 1.5);
  const e2 = A.eye, at2 = tv.body.translation();
  const off2 = Math.hypot(at2.x - e2.x, at2.y - (e2.y - CARRY.DROP), at2.z - (e2.z + d));
  let turn = qYaw(tv.body.rotation()) - yaw1;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  check(tv.holders.has(A.id) && off1 < 0.12 && off2 < 0.12 && Math.abs(turn + Math.PI / 2) < 0.3,
    `rv: a TV carried is held ${d.toFixed(2)} m out at chest height (${(off1 * 100).toFixed(0)} cm off), and a quarter turn takes it round with her (${(off2 * 100).toFixed(0)} cm off; it turned ${(turn * 180 / Math.PI).toFixed(0)} deg)`);
}

// ---- the RV's locker: loot set down in the cabin goes in it and is safe there; E on it hands the best thing
// back; it rides into tomorrow; Ed buys it with the rest of the load at his loading zone ----
{
  const { room, ps: [A, B] } = crew(['Ann', 'Bo']);
  const sim = room.sim, rq = sim.rv.rotation(), at = (x, y, z) => sim.rvToWorld({ x, y, z });
  sim.lockerOn = true;
  const vase = sim.addProp('vase', at(0, 0.42, -1.0), rq, 400, 400), tv = sim.addProp('tv', at(-0.1, 0.33, 0.8), rq, 250, 260);
  // (Bo holds a lamp up in the cabin the while: what's held stays out)
  ride(room, B, 0.1, -0.5);
  tick(room, 0.2);
  const lamp = sim.addProp('lamp', at(0.1, 1.2, -0.25), rq, 140, 140), lc = lamp.body.translation();
  room.handle(B, { t: 'grab', kind: 'prop', id: lamp.id, pt: [lc.x, lc.y, lc.z], d: carryDist('lamp') });
  tick(room, 2);
  const stowed = evs(A.conn, 'stowed'), g = room.gameState(), v0 = sim.lockerValue();
  check(!sim.props.has(vase.id) && !sim.props.has(tv.id) && sim.props.has(lamp.id) && sim.locker.length === 2 && stowed.length === 2
    && stowed.every(e => sim.locker.some(it => it.type === e.type && Math.round(it.value) === e.value)) && g.lk?.[0] === 2 && g.lk[1] === v0 && g.lk[2] === 'vase',
    `rv: set down in the RV, a vase and a TV went in its locker (${stowed.map(e => `${e.type} $${e.value}`).join(', ')}); the lamp Bo is holding didn't; the page is told (${JSON.stringify(g.lk)})`);
  // the road can't touch it: a hard run and a hard stop
  sim.release(B.id);   // (the lamp let go of in the cabin: in it goes too)
  tick(room, 1.5);
  const v1 = sim.lockerValue(), n1 = sim.locker.length;
  flatSpot(room);
  drive(room, A, 12, 6);
  pedal(room, A, -1, 1.5, 0, 1);
  check(n1 === 3 && sim.lockerValue() === v1 && sim.locker.length === 3, `rv: the lamp let go of in the cabin went in too; the locker's ${sim.locker.length} things are worth $${sim.lockerValue()} after a hard run and a hard stop, as before it ($${v1}: nothing knocked off them)`);
  // E on it: the best thing comes out into your hands; set down in the cabin again, back it goes
  A.seat = null;
  ride(room, A, 0.25, -2.0);
  tick(room, 0.2);
  room.handle(A, { t: 'use', kind: 'locker' });
  const given = A.conn.last('given'), held = sim.holds.get(A.id), out = given && sim.props.get(given.id);
  tick(room, 0.5);
  const inHands = out && out.holders.has(A.id);
  sim.release(A.id);
  tick(room, 2);
  check(given?.type === 'vase' && held && inHands && sim.locker.length === 3 && !sim.props.has(given.id),
    `rv: E on the locker hands Ann its best thing (${given?.type}) and she holds it; set down in the cabin, it goes back in (${sim.locker.length} in the locker)`);
  // overnight: still in the locker on day 2
  room.nextDay();
  room.sim.lockerOn = true;
  tick(room, 0.5);
  const day2 = room.sim.locker.map(it => it.type).sort().join();
  check(day2 === 'lamp,tv,vase' && room.sim.lockerValue() === sim.lockerValue(), `rv: the locker rides into tomorrow (${day2}, $${room.sim.lockerValue()})`);
  // Ed's loading zone: the locker sold with the load, at his 80%
  const S2 = room.sim, d = room.W.town.dock;
  room.phase = 'road';
  S2.placeRV(d.x, d.z, 0);
  tick(room, 1.5);
  const want = S2.locker.reduce((a, it) => a + Math.round(it.value * C.DOCK_RATE), 0), offer = room.gameState().dock, b0 = room.bank;
  const got = room.sellCounter(A.id);
  check(room.docked() && offer === want && got === want && room.bank === b0 + want && !S2.locker.length,
    `rv: parked in Ed's loading zone, he offers $${offer} for the locker (80%) and buys it (+$${got}); it's empty after`);
}

// ---- set down in the RV, a thing goes in the locker from your hands: no drop to the floor first, so nothing
// knocked off it (let go of at chest height, a vase fell to the floor and lost value on its way into the one place
// nothing loses any). Thrown in the RV, it's thrown: it lands first ----
{
  const { room, ps: [A, B] } = crew(['Ann', 'Bo']);
  const sim = room.sim, rq = sim.rv.rotation(), at = (x, y, z) => sim.rvToWorld({ x, y, z });
  sim.lockerOn = true;
  ride(room, A, 0.1, -0.5); ride(room, B, -0.1, 0.6);
  tick(room, 0.3);
  const vase = sim.addProp('vase', at(0.1, 1.15, -0.1), rq, 400, 400), vc = vase.body.translation();
  room.handle(A, { t: 'grab', kind: 'prop', id: vase.id, pt: [vc.x, vc.y, vc.z], d: carryDist('vase') });
  tick(room, 0.5);
  const held = sim.holds.get(A.id)?.id === vase.id, hy = sim.rvToLocal(vase.body.translation()).y;
  evs(A.conn, 'dmg'); evs(A.conn, 'stowed');
  room.handle(A, { t: 'rel' });
  const at0 = sim.locker.find(it => it.type === 'vase');
  tick(room, 1);
  const dmg = evs(A.conn, 'dmg').filter(e => e.id === vase.id), st = evs(A.conn, 'stowed');
  check(held && hy > 0.6 && at0 && Math.round(at0.value) === 400 && !dmg.length && st.length === 1 && st[0].value === 400,
    `rv: a vase set down in the RV from chest height (${hy.toFixed(2)} m up) goes in the locker at once, at its full $${at0 ? Math.round(at0.value) : '?'} (knocks: ${dmg.length})`);
  const tv = sim.addProp('tv', at(-0.1, 1.15, 0.9), rq, 250, 260), tc = tv.body.translation();
  room.handle(B, { t: 'grab', kind: 'prop', id: tv.id, pt: [tc.x, tc.y, tc.z], d: carryDist('tv') });
  tick(room, 0.5);
  room.handle(B, { t: 'rel', thr: 1, dir: [0, 0.2, -1] });
  const thrownIn = sim.props.has(tv.id) && !sim.locker.some(it => it.type === 'tv');
  tick(room, 3);
  check(thrownIn && !sim.props.has(tv.id) && sim.locker.some(it => it.type === 'tv'), `rv: a TV thrown down the RV lands first (still loose as it flies: ${thrownIn}), then goes in the locker`);
}

// ---- bungee cords strap down what rides on the roof (the cabin's load is in the locker), and it stays strapped
// overnight ----
{
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim, rq = sim.rv.rotation();
  sim.lockerOn = true;
  const tv = sim.addProp('tv', sim.rvToWorld({ x: 0.3, y: RV_DIM.ROOF_Y + 0.35, z: -2.0 }), rq, 250, 260);
  const vase = sim.addProp('vase', sim.rvToWorld({ x: 0, y: 0.42, z: -1.0 }), rq, 300, 300);
  tick(room, 1.5);
  const n = sim.tieDown();
  room.nextDay();
  const S2 = room.sim, tied = [...S2.tied.keys()].map(id => S2.props.get(id)?.type);
  check(n === 1 && sim.locker.length === 1 && tied.join() === 'tv' && S2.locker.length === 1,
    `rv: the bungee straps down the TV on the roof (${n} tied; the vase went in the locker), and on day 2 it's still strapped there (${tied.join()})`);
}

// ---- bunks: into a bunk lays you down in one of your own; out of it frees it ----
{
  const { room, ps: [A, B, Cy] } = crew(['Ann', 'Bo', 'Cy']);
  room.phase = 'night';
  ride(room, A, 0, -2.5); ride(room, B, 0.2, -2.0); ride(room, Cy, -0.1, -1.6);
  tick(room, 0.2);
  room.handle(A, { t: 'use', kind: 'bunk' }); room.handle(B, { t: 'use', kind: 'bunk' });
  const a = A.conn.last('bed'), b = B.conn.last('bed'), g = room.gameState();
  room.handle(A, { t: 'use', kind: 'bunk' });
  const up = A.conn.last('bed');
  room.handle(Cy, { t: 'use', kind: 'bunk' });
  const c = Cy.conn.last('bed'), g2 = room.gameState();
  check(a?.on && a.slot === 0 && b?.on && b.slot === 1 && g.beds.join() === [A.id, B.id].join() && g.bk.join() === '0,1' && up && !up.on && c?.slot === 0 && g2.bk.join() === '1,0',
    `bunks: Ann gets bunk ${a?.slot} and Bo bunk ${b?.slot}, each told to lie down; Ann gets up and Cy has her bunk (${c?.slot}); the crew sees who's where (${g2.bk.join(', ')})`);
}

if (failed) { console.error('\nRV TESTS FAILED'); process.exit(1); }
console.log('\nall RV tests passed');
process.exit(0);
