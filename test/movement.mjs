// The controller's forgiveness (client/js/player.js on the page's own physics world): a jump a moment after
// walking off an edge still works (coyote time) but not long after, and only once; a jump pressed a moment
// before landing happens as you land (the buffer) but not one pressed long before. And the RV: you walk about
// in it parked on uneven ground, and nothing inside it is climbed (its outside is).
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
const aisle = [];
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
}
const short = aisle.filter(a => a.went < 2.2);
check(!short.length, `movement: in the RV parked level or a degree or more out, 0.7 s down its aisle goes ${aisle.map(a => a.went.toFixed(1)).join(', ')} m (walking pace is ${C.PLAYER.WALK} m/s)`);
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
lw.free();
if (failed) { console.error('💥 MOVEMENT TESTS FAILED'); process.exit(1); }
console.log('All movement checks passed');
process.exit(0);
