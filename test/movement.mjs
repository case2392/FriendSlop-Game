// The controller's forgiveness (client/js/player.js on the page's own physics world): a jump a moment after
// walking off an edge still works (coyote time) but not long after, and only once; a jump pressed a moment
// before landing happens as you land (the buffer) but not one pressed long before.
import './pagemods.mjs';
const C = await import('../shared/constants.js');
const { generateLeg } = await import('../shared/world.js');
const { initPhys, LocalWorld } = await import('../client/js/phys.js');
const { Me } = await import('../client/js/player.js');
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
lw.free();
if (failed) { console.error('💥 MOVEMENT TESTS FAILED'); process.exit(1); }
console.log('All movement checks passed');
process.exit(0);
