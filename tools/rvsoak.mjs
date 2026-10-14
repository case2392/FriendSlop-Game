// The RV's condition, soaked (the merge gate for shared/constants.js RVH). A keyboard-style driver (steering
// -1/0/+1 with 0.06 rad of slack, the throttle on or off, S to brake) does what a crew does with the RV on N
// seeds x 5 days, and none of it may cost the RV anything:
//  - the road at full throttle (the gates open, the boulder rolled aside), easing into mud and up to each
//    grade, floored backwards against the winch cable clipped to the post ahead, winched up and out, then
//    floored forwards against the cable still clipped;
//  - a handbrake stop from cruise with 12 loose things aboard (2 safes);
//  - every stop's apron (the crash sites too): slow to 4 m/s, turn in, stop 4 m short of the nearest solid
//    thing ahead (a wall, a post, loot, a fallen rock, ground too steep to drive), back out 8 m, rejoin the road;
//  - backing into Ed's loading zone at 3 m/s;
//  - put down elsewhere, and set back on its wheels from its side (the tow);
//  - every grade hauled up with nobody at the wheel (the crew outside working the winch), and with a driver
//    sat with their hands off, the reel stopped once it's over and 3 s more; and the winch never has the RV
//    going faster than its drum's speed (plus OVERRUN).
// Every window the crash detector closes is listed (dv, what) for tuning. Then the crash table (the ranger
// gate at 3, 5, 8, 12 m/s: dearer the faster, never free from 5 m/s) and the breakdown bound: day 5, 700 m out
// of town, broken down: one player's fix and limping in costs at most half a game hour more than the same run
// healthy (the clock it docks at is printed). A gate whose part didn't run says so and doesn't pass.
//   node tools/rvsoak.mjs [--seeds 12] [--days 1-5] [--quick] [--only soak,hauls,table,bound] [--poi crash]
// (--quick: no aprons)     exit code 1 when a gate fails
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';   // (the wildlife's hits on the RV are test/mobs.mjs's)
delete process.env.FRIENDSLOP_FAST;    // (a real clock: half a game hour is 22.5 s)
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { RV_HATCH, qRotate, toWorld } = await import('../shared/rv.js');
const { generateLeg } = await import('../shared/world.js');
await initPhysics();
// (the room draws each day's driver at random, and a draw can take the wheel off the soak's driver: seeded
// for each seed and day, a run is the same run every time, alone or in the whole soak)
const { mulberry32 } = await import('../shared/rng.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SEEDS = opt("--seed", null) ? [Number(opt("--seed"))] : Array.from({ length: Number(opt("--seeds", 12)) }, (_, i) => [4242, 7, 777][i] ?? 1000 + i * 7919);
const [D0, D1] = String(opt('--days', '1-5')).split('-').map(Number);
const QUICK = args.includes('--quick'), TRACE = args.includes('--trace');
const ONLY = new Set(String(opt('--only', 'soak,hauls,table,bound')).split(','));
const POI = opt('--poi', null);   // (only this kind of stop's apron, traced with --trace)
const HZ = C.SIM_HZ;

class FakeConn { constructor() { this.readyState = 1; } send() {} close() {} }
const fwd = sim => qRotate(sim.rv.rotation(), { x: 0, y: 0, z: 1 });
const roadYaw = (W, z) => Math.atan2(W.roadX(z + 3) - W.roadX(z - 3), 6);

// a room on (seed, day) with Ann at the wheel and Bob on foot; every hit the room hears, tagged with what
// the driver was doing
function setup(seed, day) {
  Math.random = mulberry32((seed * 7919 + day) >>> 0);
  const room = new Room('SOAK', seed);
  const [A, B] = ['Ann', 'Bob'].map(n => { const p = room.addPlayer(new FakeConn(), n).player; room.welcome(p); return p; });
  if (day > 1) room.debug(A, { op: 'day', d: day });
  for (let i = 0; i < 12; i++) room.tick(1 / HZ);
  const ctx = { room, A, B, seed, day, doing: 'camp', hits: [], t: 0, notes: [] };
  const f = room.onRVHit.bind(room);
  room.onRVHit = e => { const r = f(e); ctx.hits.push({ doing: ctx.doing, seed, day, why: e.why, dv: e.dv ?? 0, what: e.what, amt: e.amt ?? 0, priced: r, zone: e.zone }); return r; };
  A.seat = 0;
  return ctx;
}
// one step: steer at the goal (keyboard), hold about `speed` (negative: in reverse)
function step(ctx, goal, speed, { hb = 0, st = null, th = null } = {}) {
  const { room, A } = ctx, sim = room.sim, v = sim.rvSpeed();
  let s = st ?? 0;
  if (st == null && goal) {
    const p = sim.rv.translation(), f = fwd(sim), tx = goal.x - p.x, tz = goal.z - p.z;
    const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz);
    s = err > 0.06 ? 1 : err < -0.06 ? -1 : 0;
  }
  if (th == null) th = speed >= 0 ? (v < speed ? 1 : v > speed + 1.5 ? -1 : 0) : (v > speed ? -1 : v < speed - 1.5 ? 1 : 0);
  room.handle(A, { t: 'drv', th, st: s, hb });
  room.tick(1 / HZ);
  ctx.t += 1 / HZ;
}
const settle = (ctx, secs) => { for (let i = 0; i < secs * HZ; i++) step(ctx, null, 0, { th: 0, hb: 1 }); };
// on the brakes to a stop
function stop(ctx) {
  const sim = ctx.room.sim;
  for (let i = 0; i < 8 * HZ && Math.abs(sim.rvSpeed()) > 0.3; i++) step(ctx, null, 0, { th: sim.rvSpeed() > 0 ? -1 : 1 });
  settle(ctx, 0.5);
}
const roadAhead = (W, p, d = 10) => ({ x: W.roadX(p.z + d), z: p.z + d });

// the distance from the RV's nose (dir 1: its two front corners and the middle) or its tail (dir -1) to the
// nearest solid thing that way: the world's boxes and posts, and loot lying about, within 25 m
function clearance(sim, W, dir = 1) {
  const rp = sim.rv.translation(), f0 = fwd(sim), f = { x: f0.x * dir, z: f0.z * dir };
  const nose = [-1.2, 0, 1.2].map(x => toWorld(rp, sim.rv.rotation(), { x, y: 0, z: 4.4 * dir }));
  let best = Infinity;
  const ahead = (x, z) => (x - rp.x) * f.x + (z - rp.z) * f.z > 4;
  for (const p of sim.props.values()) {
    const t = p.body.translation();
    if (Math.hypot(t.x - rp.x, t.z - rp.z) > 26) continue;
    const l = sim.rvToLocal(t);
    if (Math.abs(l.x) < 1.3 && Math.abs(l.z) < 4.5) continue;   // (aboard)
    // (ahead of the nose itself, however close: loot at the bumper's corner is in the way too)
    if (l.z * dir < 3.6 || Math.abs(l.x) > 2.6 + Math.max(0, l.z * dir - 4.4)) continue;
    for (const n of nose) best = Math.min(best, Math.hypot(n.x - t.x, n.z - t.z) - 0.4);
  }
  for (const s of W.statics) {
    if (Math.hypot(s.x - rp.x, s.z - rp.z) > 25 + Math.max(s.hx, s.hz) || s.mat === 'invisible') continue;
    const c = Math.cos(-(s.ry || 0)), sn = Math.sin(-(s.ry || 0));
    for (const n of nose) {
      const dx = n.x - s.x, dz = n.z - s.z, lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
      const qx = Math.max(-s.hx, Math.min(s.hx, lx)), qz = Math.max(-s.hz, Math.min(s.hz, lz));
      const wx = s.x + qx * Math.cos(s.ry || 0) + qz * Math.sin(s.ry || 0), wz = s.z - qx * Math.sin(s.ry || 0) + qz * Math.cos(s.ry || 0);
      if (s.y + s.hy < sim.W.heightAt(wx, wz) + 0.3 || !ahead(wx, wz)) continue;   // (a pad flush with the ground isn't in the way)
      best = Math.min(best, Math.hypot(lx - qx, lz - qz));
    }
  }
  for (const cy of W.cyls) {
    if (Math.hypot(cy.x - rp.x, cy.z - rp.z) > 26 || !ahead(cy.x, cy.z)) continue;
    for (const n of nose) best = Math.min(best, Math.hypot(n.x - cy.x, n.z - cy.z) - cy.r);
  }
  // (the buttes' fallen rocks, as round as they reach)
  for (const hl of W.hulls || []) {
    if (Math.hypot(hl.x - rp.x, hl.z - rp.z) > 26 + hl.r || !ahead(hl.x, hl.z)) continue;
    for (const n of nose) best = Math.min(best, Math.hypot(n.x - hl.x, n.z - hl.z) - hl.r);
  }
  // (ground too steep to drive up: a rise of more than 0.8 m a metre, walked out ahead of each corner)
  for (const n of nose) {
    let prev = W.heightAt(n.x, n.z);
    for (let d = 0.5; d < Math.min(best, 25); d += 0.5) {
      const x = n.x + f.x * d, z = n.z + f.z * d, h = W.heightAt(x, z);
      if (h - prev > 0.4) { best = Math.min(best, d - 0.5); break; }
      prev = h;
    }
  }
  return best;
}

// the road from where the RV is to town: full throttle; easing into mud (5 m/s) and up to a grade's foot,
// the winch then; the handbrake stop from cruise (once, if asked); stops at `until` (z) or in town
function road(ctx, { until = null, handbrake = false, floored = true } = {}) {
  const { room } = ctx, sim = room.sim, W = room.W;
  const end = until ?? W.LEN + 30;
  const obs = W.obstacles.filter(o => o.type === 'mud' || o.type === 'grade').map(o => ({ type: o.type, z0: o.z0 ?? o.z, z1: o.z1 ?? o.z + 20, done: false }));
  let braked = !handbrake, stuck = 0, beached = 0;
  for (let g = 0; g < 900 * HZ; g++) {
    const p = sim.rv.translation();
    if (p.z > end) return true;
    const ob = obs.find(o => !o.done && p.z > o.z0 - 35 && p.z < o.z1 + 3);
    if (ob?.type === 'grade' && p.z > ob.z0 - 5.5) {
      ctx.doing = 'grade'; stop(ctx);
      if (!winch(ctx, ob, floored)) ctx.notes.push(`no post in reach up the grade at ${ob.z0.toFixed(0)}`);
      ob.done = true; ctx.doing = 'road';
      continue;
    }
    if (!braked && !ob && sim.rvSpeed() > 11) {
      // the handbrake from cruise, with the loose loot aboard
      ctx.doing = 'handbrake';
      for (let i = 0; i < 6 * HZ && Math.abs(sim.rvSpeed()) > 0.2; i++) step(ctx, roadAhead(W, sim.rv.translation()), 0, { th: 0, hb: 1 });
      braked = true; ctx.doing = 'road';
      continue;
    }
    if (TRACE && g % (5 * HZ) === 0) console.log(`  [${ctx.t.toFixed(0)} s] z ${p.z.toFixed(1)} x-road ${(p.x - W.roadX(p.z)).toFixed(1)} v ${sim.rvSpeed().toFixed(1)}${ob ? ' at the ' + ob.type : ''} hp ${ctx.room.rvc.hp}`);
    step(ctx, roadAhead(W, p), ob ? (ob.type === 'grade' ? 3 : 5) : 30);
    stuck = ob?.type === 'mud' && Math.abs(sim.rvSpeed()) < 0.4 ? stuck + 1 / HZ : 0;
    // (beached on loot that fell out and ended up under it: the crew drags it clear, as they would. The loose
    // loot is chaos: the smallest change upstream decides whether a safe rolls out, and where)
    beached = Math.abs(sim.rvSpeed()) < 0.3 ? beached + 1 / HZ : 0;
    if (beached > 3) {
      beached = 0;
      for (const q of [...sim.props.values()]) {
        if (q.type === 'boulder' || q.type === 'map') continue;
        const l = sim.rvToLocal(q.body.translation());
        if (Math.abs(l.x) < 1.6 && Math.abs(l.z) < 5 && l.y < 0) { sim.removeProp(q.id); ctx.notes.push(`beached on a ${q.type} that fell out, at ${p.z.toFixed(0)}: dragged clear`); }
      }
    }
    // (stuck in the mud: the winch, once a post past it is in reach; till then it crawls on)
    if (stuck > 2) { ctx.doing = 'mud'; if (winch(ctx, ob, floored)) ob.done = true; stuck = 0; ctx.doing = 'road'; }
  }
  ctx.notes.push(`seed ${ctx.seed} day ${ctx.day}: the road run timed out at z ${sim.rv.translation().z.toFixed(0)}`);
  return false;
}
// clipped to the nearest post past the obstacle: floored backwards against the cable for 5 s, reeled in
// (the driver feathering the throttle) till it's through, floored forwards against the cable still clipped
// for 5 s, unhooked
function winch(ctx, ob, floored = true) {
  const sim = ctx.room.sim, W = ctx.room.W, w = sim.winchWorld();
  const anc = W.anchors.filter(a => a.z > ob.z1 - 3 && Math.hypot(a.x - w.x, a.y - w.y, a.z - w.z) < C.WINCH.MAX_LEN - 2)
    .sort((a, b) => Math.hypot(a.x - w.x, a.z - w.z) - Math.hypot(b.x - w.x, b.z - w.z))[0];
  if (!anc) return false;
  Object.assign(sim.hook, { state: 'anchored', body: null, anchor: { x: anc.x, y: anc.y, z: anc.z }, attach: null, holder: null, reeling: false, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 });
  const was = ctx.doing;
  if (floored) {
    ctx.doing = 'floored (cable)';
    for (let i = 0; i < 5 * HZ; i++) step(ctx, null, 0, { th: -1 });
    ctx.doing = was;
  }
  sim.hook.reeling = true;
  // (till the drive wheels at the back are 2 m over the top too: unhooked with them on the lip, a limping RV
  // can't pull itself over and rolls back down; or till the winch gains nothing more, at the post)
  let best = -Infinity, bestAt = 0;
  for (let i = 0; i < 60 * HZ && sim.rv.translation().z - 2.6 < ob.z1 + 2 && (i < 3 * HZ || i - bestAt < 2 * HZ); i++) {
    step(ctx, roadAhead(W, sim.rv.translation()), 0, { th: 0.5 });
    const z = sim.rv.translation().z, w = sim.winchWorld(), a = sim.hook.anchor;
    // (a cable gone slack is the reel catching up, not a stall)
    if (z > best + 0.05 || (a && Math.hypot(a.x - w.x, a.y - w.y, a.z - w.z) < sim.hook.len - 0.3)) { best = Math.max(best, z); bestAt = i; }
    if (TRACE && (i % 30 === 0 || i > 11.5 * HZ && i % 3 === 0)) { const w = sim.winchWorld(), a = sim.hook.anchor, f = fwd(sim); console.log(`  [reel] ${(i / HZ).toFixed(1)} s z ${z.toFixed(2)} pitch ${(Math.asin(f.y) * 57.3).toFixed(0)} len ${sim.hook.len.toFixed(2)} dist ${a ? Math.hypot(a.x - w.x, a.y - w.y, a.z - w.z).toFixed(2) : '-'} v ${sim.rvSpeed().toFixed(2)}`); }
  }
  sim.hook.reeling = false;
  if (floored) {
    ctx.doing = 'floored (cable)';
    for (let i = 0; i < 5 * HZ; i++) step(ctx, roadAhead(W, sim.rv.translation()), 0, { th: 1 });
    ctx.doing = was;
  }
  stop(ctx);
  sim.stowHook();
  return true;
}
// a grade hauled up from its foot with nobody steering: nobody in the seat (the crew outside on the winch), or
// a driver sat with their hands off (pressed R, nothing else); the reel stopped once the back wheels are 2 m
// over the top (or the winch gains nothing more), then 3 s more. The fastest the RV went on the cable
function haul(ctx, ob, seated) {
  const { room, A } = ctx, sim = room.sim, W = room.W;
  const rz = ob.z0 - 5.5;
  sim.placeRV(W.roadX(rz), rz, roadYaw(W, rz));
  ctx.doing = 'placed'; settle(ctx, 1.5);
  const w = sim.winchWorld();
  const anc = W.anchors.filter(a => a.z > ob.z1 - 3 && Math.hypot(a.x - w.x, a.y - w.y, a.z - w.z) < C.WINCH.MAX_LEN - 2)
    .sort((a, b) => Math.hypot(a.x - w.x, a.z - w.z) - Math.hypot(b.x - w.x, b.z - w.z))[0];
  if (!anc) return null;
  Object.assign(sim.hook, { state: 'anchored', body: null, anchor: { x: anc.x, y: anc.y, z: anc.z }, attach: null, holder: null, reeling: true, len: Math.hypot(anc.x - w.x, anc.y - w.y, anc.z - w.z) + 0.2 });
  ctx.doing = seated ? 'haul (hands off)' : 'haul (nobody driving)';
  A.seat = seated ? 0 : null;
  const tick = () => { if (seated) room.handle(A, { t: 'drv', th: 0, st: 0, hb: 0 }); room.tick(1 / HZ); ctx.t += 1 / HZ; };
  let vmax = 0, best = -Infinity, bestAt = 0;
  for (let i = 0; i < 60 * HZ && sim.rv.translation().z - 2.6 < ob.z1 + 2 && (i < 3 * HZ || i - bestAt < 2 * HZ); i++) {
    tick();
    const v = sim.rv.linvel(), z = sim.rv.translation().z;
    vmax = Math.max(vmax, Math.hypot(v.x, v.y, v.z));
    if (z > best + 0.05) { best = z; bestAt = i; }
  }
  sim.hook.reeling = false;
  for (let i = 0; i < 3 * HZ; i++) tick();
  const over = sim.rv.translation().z - 2.6 > ob.z1 + 1;
  sim.stowHook();
  A.seat = 0;
  return { vmax, over };
}
// a stop's apron: in at 4 m/s, 4 m short of whatever is ahead, back out 8 m, back onto the road
function apron(ctx, poi) {
  const { room } = ctx, sim = room.sim, W = room.W;
  // (from the road short of the stop, with no grade or mud in between: never put down on a grade's slope)
  let z0 = poi.z - Math.max(35, poi.off * 2);
  for (const o of W.obstacles) {
    if (o.type !== 'grade' && o.type !== 'mud') continue;
    const a = (o.z0 ?? o.z) - 6, b = (o.z1 ?? o.z) + 8;
    if (b > z0 - 6 && a < poi.z) z0 = Math.max(z0, b);
  }
  if (z0 > poi.z - poi.off * 0.9 - 6) { ctx.notes.push(`the ${poi.type} at ${poi.z.toFixed(0)}: no clear road up to it`); return false; }
  sim.placeRV(W.roadX(z0), z0, roadYaw(W, z0));
  ctx.doing = 'placed'; settle(ctx, 1.5);
  ctx.doing = `apron ${poi.type}`;
  const turn = poi.z - poi.off * 0.9;
  for (let i = 0; i < 40 * HZ && sim.rv.translation().z < turn; i++) step(ctx, roadAhead(W, sim.rv.translation(), 8), 4);
  let short = Infinity, stuck = 0;
  for (let i = 0; i < 30 * HZ; i++) {
    stuck = Math.abs(sim.rvSpeed()) < 0.3 && i > HZ ? stuck + 1 / HZ : 0;
    if (stuck > 2) { ctx.notes.push(`the ${poi.type} at ${poi.z.toFixed(0)}: stuck on the way in`); break; }
    short = clearance(sim, W);
    if (TRACE && i % 15 === 0) { const p = sim.rv.translation(), u = qRotate(sim.rv.rotation(), { x: 0, y: 1, z: 0 }), f = fwd(sim); console.log(`  [apron ${poi.type}] ${(i / HZ).toFixed(2)} s at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ground ${W.heightAt(p.x, p.z).toFixed(1)} v ${sim.rvSpeed().toFixed(1)} pitch ${(Math.asin(f.y) * 57.3).toFixed(0)} tilt ${(Math.acos(Math.min(1, u.y)) * 57.3).toFixed(0)} clear ${short.toFixed(1)} to poi ${Math.hypot(poi.x - p.x, poi.z - p.z).toFixed(1)} hits ${ctx.hits.length}`); }
    if (short < 4 + Math.max(0, sim.rvSpeed()) * 0.4) break;
    const p = sim.rv.translation();
    if (Math.hypot(poi.x - p.x, poi.z - p.z) < 3) break;
    step(ctx, { x: poi.x, z: poi.z }, 4);
  }
  stop(ctx);
  // back out 8 m (looking behind: stopping 3 m short of anything there)
  const at = sim.rv.translation();
  for (let i = 0; i < 12 * HZ && Math.hypot(sim.rv.translation().x - at.x, sim.rv.translation().z - at.z) < 8 && clearance(sim, W, -1) > 3 + Math.max(0, -sim.rvSpeed()) * 0.4; i++) step(ctx, null, -3, { st: 0 });
  stop(ctx);
  for (let i = 0; i < 25 * HZ; i++) {
    const p = sim.rv.translation(), f = fwd(sim);
    if (Math.abs(p.x - W.roadX(p.z)) < 1.5 && Math.abs(Math.atan2(f.x, f.z) - roadYaw(W, p.z)) < 0.3) break;
    step(ctx, roadAhead(W, p, 22), 4);
  }
  stop(ctx);
}
// backing into Ed's loading zone at 3 m/s from up the street
function dock(ctx) {
  const { room } = ctx, sim = room.sim, d = room.W.town.dock;
  sim.placeRV(d.x + 4, d.z + 16, 0);
  ctx.doing = 'placed'; settle(ctx, 1.5);
  ctx.doing = 'dock';
  for (let i = 0; i < 15 * HZ && sim.rv.translation().z > d.z + 0.5; i++) step(ctx, null, -3, { st: 0 });
  stop(ctx);
  return room.docked();
}
// put down elsewhere; set on its side (that fall is the setup, not part of the gate), then the tow
function teleports(ctx) {
  const { room } = ctx, sim = room.sim, W = room.W, z = W.LEN - 140;
  sim.placeRV(W.roadX(z), z, roadYaw(W, z));
  ctx.doing = 'placed'; settle(ctx, 3);
  const t = sim.rv.translation(), hp = room.rvc.hp;
  sim.rv.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true);
  sim.rv.setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) }, true);
  ctx.doing = 'setup'; for (let i = 0; i < 4 * HZ; i++) { room.tick(1 / HZ); }
  room.rvc.hp = hp; room.rvc.inc = null; sim.setRvCond(hp);
  ctx.doing = 'righted'; sim.rightRV(); settle(ctx, 3);
}

// ---- the soak ----------------------------------------------------------------------------------------------
const LOOSE = ['safe', 'safe', 'tv', 'toaster', 'lamp', 'vase', 'gnome', 'trophy', 'tv', 'lamp', 'toaster', 'gnome'];
const all = [], days = [];
const t0 = Date.now();
if (ONLY.has('soak')) for (const seed of SEEDS) for (let day = D0; day <= Math.min(C.DAYS, D1 || D0); day++) {
  const ctx = setup(seed, day), { room } = ctx, sim = room.sim, W = room.W;
  for (const g of W.gates) sim.openGate(g.id);
  for (const p of [...sim.props.values()]) if (p.type === 'boulder') sim.removeProp(p.id);
  const rp = sim.rv.translation(), rq = sim.rv.rotation();
  const loose = LOOSE.map((type, i) => sim.addProp(type, toWorld(rp, rq, i < 2 ? { x: i ? 0.5 : -0.5, y: 0.6, z: -1.2 } : { x: -0.6 + ((i - 2) % 3) * 0.6, y: 0.5, z: -3.4 + Math.floor((i - 2) / 3) * 0.8 }), { x: 0, y: 0, z: 0, w: 1 }, 100, 100)?.id);
  settle(ctx, 1.5);
  ctx.doing = 'road';
  const t = ctx.t;
  const made = road(ctx, { handbrake: true });
  const roadT = ctx.t - t, inRV = new Set(sim.cargo()), aboard = loose.filter(id => inRV.has(id)).length;
  const broke = loose.filter(id => !sim.props.has(id)).map(id => LOOSE[loose.indexOf(id)]), out = loose.filter(id => sim.props.has(id) && !inRV.has(id)).map(id => LOOSE[loose.indexOf(id)]);
  if (made) { room.clock = 9; ctx.doing = 'dock'; ctx.docked = dock(ctx); }
  teleports(ctx);
  // (the loose things that came out on the road stay out of the aprons: the crew would have picked them up,
  // and they aren't the stops' own loot)
  // (after the tow's tumble too: what's still aboard now)
  const still = new Set(sim.cargo());
  for (const id of loose) if (sim.props.has(id) && !still.has(id)) sim.removeProp(id);
  let aprons = 0;
  if (!QUICK) for (const poi of W.pois) {
    if (POI && poi.type !== POI) continue;
    if (Math.abs((poi.padY ?? poi.y) - W.heightAt(W.roadX(poi.z), poi.z)) > 2.5) continue;   // (a stop up on a ledge: no apron to drive)
    room.clock = 9;
    if (apron(ctx, poi) !== false) aprons++;
  }
  const own = ctx.hits.filter(h => h.doing !== 'setup');
  days.push({ seed, day, made, roadT, aboard, docked: ctx.docked, aprons, hp: room.rvc.hp, priced: own.filter(h => h.priced), n: own.length, notes: ctx.notes });
  all.push(...own);
  const d = days[days.length - 1];
  console.log(`seed ${seed} day ${day}: road ${made ? `${roadT.toFixed(0)} s` : 'DIDN\'T MAKE IT'}, ${aboard} of ${LOOSE.length} loose things still aboard${broke.length ? ` (broke: ${broke.join(', ')})` : ''}${out.length ? ` (fell out: ${out.join(', ')})` : ''}, docked ${!!ctx.docked}, ${aprons} aprons; ${own.length} windows, ${d.priced.length} cost anything; RV ${room.rvc.hp}%${ctx.notes.length ? '; ' + ctx.notes.join('; ') : ''}`);
}

// every grade, hauled with nobody steering (nobody in the seat; a driver sat with their hands off)
const hauls = [];
if (ONLY.has('hauls')) for (const seed of SEEDS) for (let day = D0; day <= Math.min(C.DAYS, D1 || D0); day++) {
  const grades = generateLeg(seed, day).obstacles.filter(o => o.type === 'grade');
  for (let gi = 0; gi < grades.length; gi++) for (const seated of [false, true]) {
    const ctx = setup(seed, day), { room } = ctx, sim = room.sim, W = room.W;
    for (const g of W.gates) sim.openGate(g.id);
    for (const p of [...sim.props.values()]) if (p.type === 'boulder') sim.removeProp(p.id);
    const ob = W.obstacles.filter(o => o.type === 'grade')[gi];
    const r = haul(ctx, ob, seated);
    if (!r) { ctx.notes.push(`seed ${seed} day ${day}: no post in reach up the grade at ${ob.z0.toFixed(0)}`); continue; }
    const own = ctx.hits.filter(h => h.doing !== 'placed');
    hauls.push({ seed, day, gi, seated, ...r, priced: own.filter(h => h.priced), hp: room.rvc.hp });
    all.push(...own);
    if (TRACE || own.some(h => h.priced) || !r.over) console.log(`  haul: seed ${seed} day ${day} grade ${gi} (${seated ? 'hands off' : 'nobody driving'}): ${r.over ? 'over' : 'NOT OVER'}, fastest ${r.vmax.toFixed(2)} m/s, RV ${room.rvc.hp}%`);
  }
}

// every window the crash detector closed, by what was going on and what it touched
const byDoing = new Map();
for (const h of all) { const k = `${h.doing} / ${h.why} / ${h.what}`; const e = byDoing.get(k) || { n: 0, max: 0 }; e.n++; e.max = Math.max(e.max, h.dv); byDoing.set(k, e); }
console.log(`\nwindows (${all.length}): what was going on / why / what it touched: count, worst dv`);
for (const [k, e] of [...byDoing].sort((a, b) => b[1].max - a[1].max)) console.log(`  ${k}: ${e.n}, ${e.max.toFixed(2)} m/s`);
for (const h of all.filter(h => h.priced)) console.log(`  COST: seed ${h.seed} day ${h.day}, ${h.doing}: ${h.why} ${h.dv} m/s into ${h.what} (${h.zone}): -${h.amt}%`);

// the crash table: the closed ranger gate, square on, at 3, 5, 8, 12 m/s
console.log('\nthe crash table (the ranger gate, square on):');
const table = [];
if (ONLY.has('table')) for (const seed of SEEDS.slice(0, 3)) {
  let day = 1;
  while (day < 5 && !generateLeg(seed, day).gates.length) day++;
  for (const speed of [3, 5, 8, 12]) {
    const ctx = setup(seed, day), { room } = ctx, sim = room.sim, W = room.W, g = W.gates[0];
    if (!g) break;
    for (const p of [...sim.props.values()]) if (p.type === 'boulder') sim.removeProp(p.id);
    const z0 = g.z - 60;
    sim.placeRV(W.roadX(z0), z0, roadYaw(W, z0));
    settle(ctx, 1);
    ctx.doing = 'gate';
    for (let i = 0; i < 20 * HZ && !ctx.hits.length; i++) {
      const p = sim.rv.translation(), f = fwd(sim), tx = g.x - p.x, tz = g.z - p.z;
      const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz), v = sim.rvSpeed();
      room.handle(ctx.A, { t: 'drv', th: v < speed - 0.2 ? 1 : v > speed + 0.3 ? -0.3 : 0.15, st: Math.max(-1, Math.min(1, err * 2.5)), hb: 0 });
      room.tick(1 / HZ);
    }
    for (let i = 0; i < 3 * HZ; i++) step(ctx, null, 0, { th: 0 });
    const h = ctx.hits.filter(x => x.priced || x.dv > 0)[0];
    table.push({ seed, speed, h });
    console.log(`  seed ${seed} day ${day}, ${String(speed).padStart(2)} m/s: ${h ? `dv ${h.dv.toFixed(2)} m/s, -${h.amt}% (${h.what}, the ${h.zone})` : 'no hit'}${room.sim.doorOpen ? ', the door flew open' : ''}`);
  }
}

// the breakdown bound: day 5, 700 m out of town: healthy, and broken down (Bob fixes it alone, then it limps in)
console.log('\nthe breakdown bound (day 5, 700 m out of town):');
const bound = [];
if (ONLY.has('bound')) for (const seed of SEEDS) {
  const r = {};
  for (const hp of [100, 0]) {
    const ctx = setup(seed, 5), { room, B } = ctx, sim = room.sim, W = room.W;
    for (const g of W.gates) sim.openGate(g.id);
    for (const p of [...sim.props.values()]) if (p.type === 'boulder') sim.removeProp(p.id);
    const z0 = W.LEN - 700, dz = W.town.dock.z;
    sim.placeRV(W.roadX(z0), z0, roadYaw(W, z0));
    settle(ctx, 1.5);
    room.phase = 'road'; room.clock = 8;
    const t = ctx.t;
    if (hp === 0) {
      room.debug(ctx.A, { op: 'rvhp', hp: 0 });
      const w = sim.rvToWorld({ x: RV_HATCH.x, y: 0, z: RV_HATCH.z - 1.5 });
      room.onPose(B, { x: w.x, y: W.heightAt(w.x, w.z), z: w.z, yaw: 0, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
      room.handle(B, { t: 'fix', on: 1 });
      for (let i = 0; i < 30 * HZ && room.rvc.hp <= 0; i++) step(ctx, null, 0, { th: 0, hb: 1 });
      room.handle(B, { t: 'fix', on: 0 });
    }
    ctx.doing = 'road';
    const made = road(ctx, { until: dz, floored: false });
    r[hp] = { t: ctx.t - t, made, hp: room.rvc.hp };
  }
  const extra = r[0].t - r[100].t;
  bound.push({ seed, extra, t0: r[0].t, t100: r[100].t, made: r[0].made && r[100].made });
  console.log(`  seed ${seed}: healthy ${r[100].t.toFixed(1)} s, broken down ${r[0].t.toFixed(1)} s (fixed, then limping at ${r[0].hp}%): +${extra.toFixed(1)} s`);
}

// ---- the gates ---------------------------------------------------------------------------------------------
let failed = false;
const gate = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
// (a part that didn't run says so: it neither passes nor fails)
const ran = (part, n) => { if (!n) console.log(`--   ${part}: didn't run`); return n > 0; };
if (ran('the soak', days.length)) {
  gate(days.every(d => d.made), `every road run made it to town (${days.filter(d => d.made).length} of ${days.length})`);
  gate(days.every(d => !d.priced.length && d.hp === 100), `none of it cost the RV anything (${days.reduce((n, d) => n + d.priced.length, 0)} of ${days.reduce((n, d) => n + d.n, 0)} windows did; worst ${Math.max(0, ...all.map(h => h.dv)).toFixed(2)} m/s)`);
  gate(days.every(d => !d.made || d.docked), `backed into Ed's loading zone every time (${days.filter(d => d.docked).length})`);
}
if (ran('the hauls', hauls.length)) {
  gate(hauls.every(h => h.over && !h.priced.length && h.hp === 100), `every grade hauled up with nobody steering made it over, and none of it cost the RV anything (${hauls.filter(h => h.over).length} of ${hauls.length} over; ${hauls.filter(h => h.priced.length).length} cost something)`);
  const fastest = Math.max(...hauls.map(h => h.vmax));
  gate(fastest < C.WINCH.REEL_SPEED + C.WINCH.OVERRUN + 0.4, `the winch never had the RV going faster than its drum (${C.WINCH.REEL_SPEED} m/s, plus ${C.WINCH.OVERRUN}): fastest ${fastest.toFixed(2)} m/s`);
}
if (ran('the crash table', table.length)) {
  // (each seed's four rows: every one a hit on the gate, dearer the faster, never free from 5 m/s)
  const rows = [...new Set(table.map(r => r.seed))].map(sd => table.filter(r => r.seed === sd));
  gate(rows.every(r => r.length === 4 && r.every(({ h }) => h && h.what === 'the ranger gate') && r.every(({ h, speed }, i) => (speed < 5 || h.amt > 0) && (i === 0 || h.amt > r[i - 1].h.amt))),
    `the crash table rises with speed (${rows.map(r => r.map(({ h }) => h ? `${h.amt}%` : '-').join('/')).join(', ')})`);
}
const HALF = C.HOUR_SEC / 2;
if (ran('the breakdown bound', bound.length)) gate(bound.every(b => b.made && b.extra <= HALF), `a breakdown 700 m out costs at most half a game hour (${HALF} s): worst +${Math.max(...bound.map(b => b.extra)).toFixed(1)} s`);
// (day 5's last 700 m always has a grade or two to winch up: from there at 22:00 a healthy crew misses
// midnight too, so what's gated is what the breakdown itself costs; the clock is printed)
const clk = s => { const h = 22 + s / C.HOUR_SEC; return `${Math.floor(h) % 24}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`; };
if (bound.length) console.log(`     from 22:00 there, healthy docks at ${clk(Math.max(...bound.map(b => b.t100)))} at the latest, broken down at ${clk(Math.max(...bound.map(b => b.t0)))}`);
process.exit(failed ? 1 : 0);
