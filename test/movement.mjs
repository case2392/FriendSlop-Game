// The controller's forgiveness (client/js/player.js on the page's own physics world): a jump a moment after
// walking off an edge still works (coyote time) but not long after, and only once; a jump pressed a moment
// before landing happens as you land (the buffer) but not one pressed long before. And the RV: you walk about
// in it parked on uneven ground, and nothing inside it is climbed (its outside is). And indoors: across a
// building's level floor at full pace, no step cut short.
import './pagemods.mjs';
const C = await import('../shared/constants.js');
const { generateLeg } = await import('../shared/world.js');
const { initPhys, LocalWorld } = await import('../client/js/phys.js');
const { Me } = await import('../client/js/player.js');
const { toWorld, toLocal } = await import('../shared/rv.js');
let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));
await initPhys();

// a test stage high above the day's ground (nothing else up there): a 30 m floor, and a box 2 m high on it
// to walk off
const W0 = generateLeg(777, 1);
const at = { x: 0, z: 0, g: 300 };
const H = 2.0;
const W = { ...W0, statics: [...W0.statics,
  { x: at.x, y: at.g - 0.5, z: at.z, hx: 15, hy: 0.5, hz: 15, ry: 0, mat: 'wall' },
  { x: at.x, y: at.g + H / 2, z: at.z, hx: 3, hy: H / 2, hz: 3, ry: 0, mat: 'wall' }] };
const lw = new LocalWorld(W);
const DT = 1 / 60;
const step = (me, inp) => { lw.step(); me.update(DT, { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: false, ...inp }, lw, null, null); };
// walk off the box's edge (+z), pressing jump t s after leaving it; -> the highest the feet got after
const offEdge = (t, again = false) => {
  const me = new Me();
  me.teleport(at.x, at.g + H + 0.05, at.z + 1.5, 0);
  for (let i = 0; i < 30; i++) step(me, {});
  let left = null, top = -Infinity, jumps = 0;
  for (let i = 0; i < 120; i++) {
    const was = me.grounded;
    const press = left != null && Math.abs((i - left) * DT - t) < DT / 2;
    step(me, { f: 1, jump: press || (again && left != null && (i - left) * DT > t + 0.05 && (i - left) * DT < t + 0.2) });
    if (was && !me.grounded && left == null) left = i;
    if (me.events.some(e => e.k === 'jump')) jumps++;
    if (left != null) top = Math.max(top, me.pos.y);
  }
  return { rose: top - (at.g + H), jumps };
};
const late = offEdge(0.2), coy = offEdge(0.08, true);   // (a 2 m drop takes 0.45 s: 0.2 s off it is past the coyote time and short of the buffer)
check(coy.rose > 0.5 && coy.jumps === 1 && late.rose < 0.05 && late.jumps === 0,
  `movement: a jump ${Math.round(0.08 * 1000)} ms after walking off an edge still jumps (the feet rose ${coy.rose.toFixed(2)} m, one jump though it was pressed again); ${Math.round(0.2 * 1000)} ms after, it doesn't (${late.jumps} jumps)`);
// fall onto the ground from 1.5 m, pressing jump t s before touching down
const buffered = t => {
  const me = new Me();
  me.teleport(at.x + 6, at.g + 2.5, at.z, 0);
  const fallT = Math.sqrt(2 * 2.45 / C.PLAYER.GRAVITY);   // (about)
  let jumps = 0, landedAt = null, i = 0;
  for (; i < 150; i++) {
    const press = Math.abs(i * DT - (fallT - t)) < DT / 2;
    step(me, { jump: press });
    if (me.grounded && landedAt == null) landedAt = i;
    if (me.events.some(e => e.k === 'jump')) jumps++;
  }
  return jumps;
};
const early = buffered(0.1), tooEarly = buffered(0.4);
check(early === 1 && tooEarly === 0, `movement: a jump pressed 100 ms before landing jumps as you land (${early}); pressed 400 ms before, it's dropped (${tooEarly})`);
// the RV parked on ground a degree or two out of level, its pose wobbling by a few mm a frame as the server's
// does: walk down its aisle (the page's copy of the RV was a kinematic body, and on one tilted like that the
// controller stuck to the floor at every step: you got about only by jumping)
const qOf = (yaw, pitch = 0, roll = 0) => {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return { w: cy * cp * cr + sy * sp * sr, x: cy * sp * cr + sy * cp * sr, y: sy * cp * cr - cy * sp * sr, z: cy * cp * sr - sy * sp * cr };
};
const aisle = [], roof = [];
for (const [pitch, roll] of [[0, 0], [0.012, 0], [0, 0.03], [0.03, -0.02], [-0.08, 0.04]]) {
  const rv0 = { p: { x: at.x + 8, y: at.g + 0.9, z: at.z - 8 }, q: qOf(0.3, pitch, roll), v: { x: 0, y: 0, z: 0 } };
  const me = new Me();
  const s0 = toWorld(rv0.p, rv0.q, { x: -0.2, y: 0.03, z: -1.5 });
  me.teleport(s0.x, s0.y, s0.z, 0.3);
  let t = 0;
  const go = (n, inp) => { for (let i = 0; i < n; i++, t += DT) {
    const rv = { ...rv0, p: { ...rv0.p, y: rv0.p.y + 0.004 * Math.sin(t * 31) }, q: qOf(0.3, pitch + 0.002 * Math.sin(t * 17), roll) };
    lw.setRV(rv.p, rv.q); lw.setDoor(true); lw.step();
    me.update(DT, { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: false, ...inp }, lw, rv, null);
  } };
  go(20, {});
  const z0 = toLocal(rv0.p, rv0.q, me.pos).z;
  go(42, { f: 1 });   // 0.7 s
  aisle.push({ pitch, roll, went: toLocal(rv0.p, rv0.q, me.pos).z - z0, jumped: me.events.some(e => e.k === 'jump') });
  // and on its roof (the planks the ladder comes up to): the same walk, back to front
  const r0 = toWorld(rv0.p, rv0.q, { x: 0.6, y: 2.43, z: -3.2 });
  me.teleport(r0.x, r0.y, r0.z, 0.3);
  go(20, {});
  const rz0 = toLocal(rv0.p, rv0.q, me.pos).z;
  go(42, { f: 1 });
  roof.push(toLocal(rv0.p, rv0.q, me.pos).z - rz0);
}
const short = aisle.filter(a => a.went < 2.2);
check(!short.length, `movement: in the RV parked level or a degree or more out, 0.7 s down its aisle goes ${aisle.map(a => a.went.toFixed(1)).join(', ')} m (walking pace is ${C.PLAYER.WALK} m/s)`);
check(roof.every(d => d > 2.2), `movement: on the RV's roof, the same 0.7 s goes ${roof.map(d => d.toFixed(1)).join(', ')} m`);
// a hand on its walls: from inside (the shower stall's wall), nothing; from outside (its side), a climb
{
  const rv = { p: { x: at.x + 8, y: at.g + 0.9, z: at.z - 8 }, q: qOf(0, 0, 0), v: { x: 0, y: 0, z: 0 } };
  lw.setRV(rv.p, rv.q); lw.setDoor(true); lw.step(); lw.step();
  const tryGrab = (l, yaw) => {
    const me = new Me(), w = toWorld(rv.p, rv.q, l);
    me.teleport(w.x, w.y, w.z, yaw);
    for (let i = 0; i < 10; i++) { lw.step(); me.update(DT, { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: false }, lw, rv, null); }
    me.pitch = 0.1;
    lw.step(); me.update(DT, { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: true }, lw, rv, null);
    return me.mode;
  };
  const inside = tryGrab({ x: -0.1, y: 0.03, z: -2.25 }, -Math.PI / 2), outside = tryGrab({ x: 2.0, y: -0.85, z: 0 }, -Math.PI / 2);
  check(inside === 'walk' && outside === 'climb', `movement: a hand on the RV's shower stall from inside climbs nothing (${inside}); on its side from outside, it climbs (${outside})`);
}
// a new day while riding (asleep in a bunk): the page's new world has no RV for a moment, then has it at the
// new camp. The rider stays in it, and comes up in it there (not left at yesterday's spot)
{
  const rvA = { p: { x: at.x + 8, y: at.g + 0.9, z: at.z - 8 }, q: qOf(0.4), v: { x: 0, y: 0, z: 0 } };
  const rvB = { p: { x: at.x - 9, y: at.g + 0.9, z: at.z + 9 }, q: qOf(-1.2), v: { x: 0, y: 0, z: 0 } };
  const me = new Me(), s0 = toWorld(rvA.p, rvA.q, { x: 0.2, y: 0.03, z: -2.2 });
  me.teleport(s0.x, s0.y, s0.z, 0.4);
  const go = (n, rv) => { for (let i = 0; i < n; i++) { if (rv) lw.setRV(rv.p, rv.q); lw.step(); me.update(DT, { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: false }, lw, rv, null); } };
  go(30, rvA);
  const riding = me.par === 1, lp = me.lp && { ...me.lp };
  lw.setRV({ x: 0, y: -100, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
  go(30, null);   // (half a second without an RV)
  const kept = me.par === 1;
  go(10, rvB);
  const l = toLocal(rvB.p, rvB.q, me.pos);
  check(riding && kept && me.par === 1 && Math.hypot(l.x - lp.x, l.z - lp.z) < 0.05 && Math.abs(l.y - lp.y) < 0.05,
    `movement: riding the RV into a new day (no RV for half a second, then it's at the new camp), you wake in it where you lay (${l.x.toFixed(2)}, ${l.y.toFixed(2)}, ${l.z.toFixed(2)} in the RV, was ${lp.x.toFixed(2)}, ${lp.y.toFixed(2)}, ${lp.z.toFixed(2)}; riding ${me.par === 1})`);
}
// out of breath: Shift held on and on runs the stamina out, and then still held, it comes back (you're winded,
// not sprinting) and the sprint with it; and Space jumps all the way through, empty or not
{
  const me = new Me(), S = C.STAMINA;
  me.teleport(at.x, at.g + 0.05, at.z - 13, 0);
  for (let i = 0; i < 30; i++) step(me, {});
  let emptyAt = null, back = null, low = Infinity;
  const jumpsAt = [];
  for (let i = 0; i < 60 * 22; i++) {
    const t = i * DT, run = { f: 1, sprint: true };
    if (me.pos.z > at.z + 12 || me.pos.z < at.z - 14) me.yaw = me.pos.z > 0 ? Math.PI : 0;   // (pace the floor, not off it)
    const jump = emptyAt != null && jumpsAt.length < 3 && t > emptyAt + 0.2 + jumpsAt.length * 1.2 && me.grounded;
    const y0 = me.pos.y;
    step(me, { ...run, jump });
    if (me.events.some(e => e.k === 'jump')) jumpsAt.push({ t, st: me.stamina, y0, top: y0 });
    for (const j of jumpsAt) if (t - j.t < 1) j.top = Math.max(j.top, me.pos.y);
    me.events.length = 0;
    low = Math.min(low, me.stamina);
    if (emptyAt == null && me.stamina <= 1) emptyAt = t;
    if (emptyAt != null && back == null && me.sprinting && t > emptyAt + 0.1) back = { t: t - emptyAt, st: me.stamina };
  }
  const rose = jumpsAt.map(j => j.top - j.y0);
  check(emptyAt != null && emptyAt < 12 && back && back.st >= S.SPRINT_BACK - 1 && back.t < 4,
    `movement: Shift held runs the stamina out (${emptyAt?.toFixed(1)} s) and, still held, it comes back to ${back?.st.toFixed(0)} and the sprint with it ${back?.t.toFixed(1)} s later`);
  check(jumpsAt.length === 3 && rose.every(r => r > 1), `movement: and Space jumps out of breath too: ${rose.map(r => r.toFixed(2)).join(', ')} m (stamina ${jumpsAt.map(j => j.st.toFixed(0)).join(', ')})`);
}

lw.free();
// indoors: the town's general store, walked through from its door (seed 7, day 3: the walk the playtest
// felt stutter on), every step at full pace with only the floor underfoot
{
  const W2 = generateLeg(7, 3), lw2 = new LocalWorld(W2), T = W2.town.z;
  lw2.setRV({ x: 0, y: -100, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }); lw2.step();
  const orig = lw2.moveSelf.bind(lw2); let last = null, want = null;
  lw2.moveSelf = (c, d, ...r) => { want = d; return (last = orig(c, d, ...r)); };
  const me = new Me(), x0 = W2.roadX(T) - 18, z0 = T + 45;
  me.teleport(x0, W2.heightAt(x0, z0) + 0.05, z0, Math.PI);
  let cut = 0, indoor = 0, dist = 0, prev = null;
  for (let i = 0; i < 60 * 9; i++) {
    lw2.step();
    me.update(DT, { f: i >= 10 ? 1 : 0, r: 0, jump: false, sprint: false, crouch: false, grab: false }, lw2, null, null);
    const floor = last.hits.length && last.hits.every(h => h.normal.y > 0.95), onFloor = last.hits.some(h => h.kind === 'static' && h.mat === 'floor');
    if (onFloor && floor && i > 40) { indoor++; if (prev) dist += Math.hypot(me.pos.x - prev.x, me.pos.z - prev.z); }   // (nothing but the floor underfoot: no counter or wall in the way)
    if (i > 40 && floor && Math.hypot(want.x, want.z) > 0.03 && Math.hypot(last.move.x, last.move.z) < Math.hypot(want.x, want.z) * 0.7) cut++;
    prev = { ...me.pos };
  }
  lw2.free();
  check(indoor > 60 && cut === 0 && dist / (indoor * DT) > C.PLAYER.WALK * 0.93, `movement: across the general store's floor (${(indoor * DT).toFixed(1)} s with nothing else in the way) at ${(dist / Math.max(1, indoor) / DT).toFixed(2)} m/s, ${cut} steps cut short by the floor`);
}
// the RV's door steps, walked: parked at camp (by the server's own physics, on several days' ground), walking at
// its open door from outside takes you up the steps and in, and walking out takes you down them, no jumping
// (they're 43 cm risers on treads narrower than you: you stopped at the first one)
{
  process.env.FRIENDSLOP_TEST = '1'; process.env.FRIENDSLOP_NOMOBS = '1';
  const { Room } = await import('../server/room.js');
  const { initPhysics } = await import('../server/sim.js');
  const { RV_DIM } = await import('../shared/rv.js');
  await initPhysics();
  const res = [];
  for (const [seed, day] of [[777, 1], [4242, 3], [7, 2]]) {
    const room = new Room('ST', seed);
    if (day > 1) room.debug({ id: 0, name: 'x' }, { op: 'day', d: day });
    for (let i = 0; i < 180; i++) room.tick(1 / 60);
    const t = room.sim.rv.translation(), q = room.sim.rv.rotation();
    const rv = { p: { x: t.x, y: t.y, z: t.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w }, v: { x: 0, y: 0, z: 0 } };
    const lw3 = new LocalWorld(room.W); lw3.setRV(rv.p, rv.q); lw3.setDoor(true); lw3.step();
    const yawTo = sx => { const a = toWorld(rv.p, rv.q, { x: sx, y: 0, z: 0 }), o = toWorld(rv.p, rv.q, { x: 0, y: 0, z: 0 }); return Math.atan2(a.x - o.x, a.z - o.z); };
    const me = new Me(), s0 = toWorld(rv.p, rv.q, { x: -2.9, y: 0, z: RV_DIM.DOOR_Z });
    me.teleport(s0.x, room.W.heightAt(s0.x, s0.z) + 0.05, s0.z, yawTo(1));
    let jumps = 0;
    const walk = (secs, yaw) => { for (let i = 0; i < secs * 60; i++) { lw3.step(); me.yaw = yaw; me.update(DT, { f: 1, r: 0, jump: false, sprint: false, crouch: false, grab: false }, lw3, rv, null); jumps += me.events.filter(e => e.k === 'jump').length; me.events.length = 0; } return toLocal(rv.p, rv.q, me.pos); };
    const a = walk(1.5, yawTo(1)), inside = a.x > -1 && a.y > -0.1 && me.par === 1;
    const b = walk(1.5, yawTo(-1)), out = b.x < -2.2 && b.y < -0.9 && me.mode === 'walk';
    // and back in, then out of it rolling at 6 m/s over this ground and dipping on a bump: down on the ground, not
    // under it
    walk(1.5, yawTo(1));
    const fw = { x: toWorld(rv.p, rv.q, { x: 0, y: 0, z: 1 }).x - rv.p.x, z: toWorld(rv.p, rv.q, { x: 0, y: 0, z: 1 }).z - rv.p.z };
    const lift = rv.p.y - room.W.heightAt(rv.p.x, rv.p.z), yawOut = yawTo(-1);
    rv.v = { x: fw.x * 6, y: 0, z: fw.z * 6 };
    let under = 0;
    for (let i = 0; i < 90; i++) {
      rv.p = { x: rv.p.x + rv.v.x * DT, y: 0, z: rv.p.z + rv.v.z * DT }; rv.p.y = room.W.heightAt(rv.p.x, rv.p.z) + lift - 0.3 * Math.min(1, i / 30);   // (dipping 30 cm on its springs over a bump as you go)
      lw3.setRV(rv.p, rv.q); lw3.step();
      if (i < 40) me.yaw = yawOut;
      me.update(DT, { f: i < 40 ? 1 : 0, r: 0, jump: false, sprint: false, crouch: false, grab: false }, lw3, rv, null);
      me.events.length = 0;
      if (!me.par) under = Math.max(under, room.W.heightAt(me.pos.x, me.pos.z) - me.pos.y);
    }
    const rolled = !me.par && under < 0.05;
    res.push({ ok: inside && out && rolled && !jumps, s: `${seed}/${day}: in to (${a.x.toFixed(1)}, ${a.y.toFixed(2)}), out to (${b.x.toFixed(1)}, ${b.y.toFixed(2)}); out rolling, ${under > 0 ? (under * 100).toFixed(1) + ' cm under' : 'on'} the ground` });
    room.sim.free?.();
  }
  check(res.every(r => r.ok), `movement: walking at the RV's open door goes up its steps and in, and walking out goes down them (the RV parked, or rolling), no jump (${res.map(r => r.s).join('; ')})`);
}

if (failed) { console.error('💥 MOVEMENT TESTS FAILED'); process.exit(1); }
console.log('All movement checks passed');
process.exit(0);
