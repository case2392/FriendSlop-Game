// The side roads (shared/tracks.js, planned last in shared/world.js): every day has some; a back road round a
// gate or a boulder on most days from day 2; the same with the wildlife or without; their floor the canyon
// floor's height, gentle, nothing standing on them; each spur's stop at its end, its loot worth more; a sign at
// each junction; and the RV, driven by the server's physics, gets down every one (to the stop, or round and
// back onto the road).
process.env.FRIENDSLOP_TEST = '1'; process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { generateLeg } = await import('../shared/world.js');
const { nearTrack, TRACK } = await import('../shared/tracks.js');
const { LOOT } = await import('../shared/loot.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { qRotate } = await import('../shared/rv.js');
let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

const SEEDS = [777, 4242, 7, 99, 1234, 31337];
const worlds = [];
for (const s of SEEDS) for (let d = 1; d <= 5; d++) worlds.push(generateLeg(s, d));

// ---- how many, and the same every time --------------------------------------------------------------------
{
  const none = worlds.filter(W => !W.tracks.length).map(W => `${W.seed}/${W.day}`);
  const later = worlds.filter(W => W.day >= 2), loops = later.filter(W => W.tracks.some(T => T.kind === 'loop'));
  const per = worlds.reduce((a, W) => a + W.tracks.length, 0) / worlds.length;
  check(!none.length && loops.length >= 0.6 * later.length,
    `tracks: every day has side roads (${per.toFixed(1)} a day; none on ${none.join(', ') || 'no day'}), and a back road on ${loops.length} of ${later.length} days from day 2`);
  const a = generateLeg(4242, 3), b = generateLeg(4242, 3), c = generateLeg(4242, 3, { mobs: false });
  const same = (x, y) => JSON.stringify(x.tracks) === JSON.stringify(y.tracks) && JSON.stringify(x.pois) === JSON.stringify(y.pois) && x.heights.every((v, i) => v === y.heights[i]);
  check(same(a, b) && same(a, c), 'tracks: the same tracks, stops and ground every time, and with the wildlife off');
}

// ---- on the ground: the floor, the grade, nothing in the way, the stops, the signs --------------------------
{
  const bad = [];
  for (const W of worlds) for (const T of W.tracks) {
    const tag = `${W.seed}/${W.day} ${T.kind}${T.id}`;
    let worstY = 0, worstG = 0;
    for (let i = 0; i < T.pts.length; i++) {
      // (the canyon floor's height at its z; into a spur's stop, eased to the stop's own flat yard)
      const q = T.pts[i], h = W.heightAt(q.x, q.z), dd = T.dest ? Math.hypot(q.x - T.dest.x, q.z - T.dest.z) : Infinity;
      const ease = T.dest ? 1 - Math.min(1, Math.max(0, (dd - (T.dest.r - 8)) / 8)) : 0, k = ease * ease * (3 - 2 * ease);
      const want = W.roadY(q.z) + (T.dest ? (T.dest.padY - W.roadY(q.z)) * k : 0);
      worstY = Math.max(worstY, Math.abs(h - want));
      if (i) { const p = T.pts[i - 1]; worstG = Math.max(worstG, Math.abs(h - W.heightAt(p.x, p.z)) / Math.hypot(q.x - p.x, q.z - p.z)); }
    }
    if (worstY > 0.3) bad.push(`${tag} floor off by ${worstY.toFixed(2)} m`);
    if (worstG > 0.12) bad.push(`${tag} a ${(worstG * 100).toFixed(0)}% grade`);
    // nothing solid on the track (the roadside's own things stand off it)
    const onIt = (x, z, r) => nearTrack(T, x, z).d < T.hw + r;
    const solid = [...W.cyls.filter(c => onIt(c.x, c.z, c.r)), ...W.statics.filter(b => b.part !== 'signpost' && b.mat !== 'invisible' && onIt(b.x, b.z, Math.min(Math.max(b.hx, b.hz), 2)))];
    if (solid.length) bad.push(`${tag} ${solid.length} solid things on it (${solid.slice(0, 3).map(b => b.part || b.mat).join(', ')})`);
    if (!W.signs.some(sg => sg.track === T.id)) bad.push(`${tag} no sign at its junction`);
    if (T.dest) {
      const p = W.pois.find(q => q.deep && q.track === T.id);
      const loot = W.props.filter(pr => LOOT[pr.type]?.value && Math.hypot(pr.x - T.dest.x, pr.z - T.dest.z) < T.dest.r);
      if (!p || loot.length < 3) bad.push(`${tag} its stop: ${p ? p.type : 'none'}, ${loot.length} things to take`);
    }
  }
  check(!bad.length, `tracks: their floor is the canyon floor's height, gentle, with nothing standing on it, a sign at each junction and a stocked stop at each spur's end${bad.length ? ': ' + bad.slice(0, 6).join('; ') : ''}`);
  // the spurs' stops are worth the drive: their things against the same kind at the roadside stops
  let deep = 0, nd = 0, road = 0, nr = 0;
  for (const W of worlds) for (const pr of W.props) {
    const L = LOOT[pr.type]; if (!L?.value || L.mob || L.find) continue;
    const p = W.pois.find(q => Math.hypot(pr.x - q.x, pr.z - q.z) < (q.deep ? 21 : 15));
    if (!p) continue;
    const r = pr.value / (L.value * (1 + 0.22 * (W.day - 1)));
    if (p.deep) { deep += r; nd++; } else { road += r; nr++; }
  }
  check(nd > 20 && deep / nd > 1.45 * (road / nr), `tracks: a spur's stop's things are worth ${(deep / nd / (road / nr)).toFixed(2)} times the roadside stops' (${nd} and ${nr} things)`);
}

// ---- driven: the RV gets down every one (the server's physics) ------------------------------------------
{
  await initPhysics();
  class FakeConn { constructor() { this.readyState = 1; } send() {} close() {} }
  const HZ = C.SIM_HZ, res = [];
  for (const seed of [777, 4242]) for (let day = 1; day <= 5; day++) {
    const room = new Room('TK', seed), c = new FakeConn(), A = room.addPlayer(c, 'Ann').player;
    room.welcome(A); A.conn = c;
    if (day > 1) room.debug(A, { op: 'day', d: day });
    for (let i = 0; i < 12; i++) room.tick(1 / HZ);
    const W = room.W, sim = room.sim;
    for (const T of W.tracks) {
      const P = T.pts, start = P[0], end = P[P.length - 1], z0 = start.z - 25;
      sim.placeRV(W.roadX(z0), z0, Math.atan2(W.roadX(z0 + 3) - W.roadX(z0 - 3), 6));
      for (let i = 0; i < 30; i++) room.tick(1 / HZ);
      A.seat = 0;
      let t = 0, done = false, flipped = false, stuck = 0, on = false;
      for (; t < 120 * HZ && !done; t++) {
        const p = sim.rv.translation(), f = qRotate(sim.rv.rotation(), { x: 0, y: 0, z: 1 }), n = nearTrack(T, p.x, p.z);
        let goal;
        if (!on && n.s < 4 && Math.hypot(p.x - start.x, p.z - start.z) > 6) goal = { x: W.roadX(p.z + 10), z: p.z + 10 };
        else { on = true; const k = T.s.findIndex(v => v >= Math.min(T.len, n.s + 9)); goal = P[k < 0 ? P.length - 1 : k]; }
        const tx = goal.x - p.x, tz = goal.z - p.z, err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz), v = sim.rvSpeed();
        room.handle(A, { t: 'drv', th: v < 6.7 ? 1 : v > 7.6 ? -0.4 : 0, st: Math.max(-1, Math.min(1, err * 2.5)), hb: 0 });
        room.tick(1 / HZ);
        if (sim.rvFlipped()) { flipped = true; break; }
        stuck = on && Math.abs(sim.rvSpeed()) < 0.3 ? stuck + 1 : 0;
        if (stuck > 4 * HZ) break;
        done = Math.hypot(p.x - end.x, p.z - end.z) < (T.dest ? 6 : 4);
      }
      res.push({ ok: done, s: `${seed}/${day} ${T.kind} ${T.len.toFixed(0)} m: ${done ? (t / HZ).toFixed(0) + ' s' : flipped ? 'flipped' : 'stuck'}` });
    }
    room.sim.free?.();
  }
  check(res.length >= 10 && res.every(r => r.ok), `tracks: the RV gets down every one of ${res.length} (${res.map(r => r.s).join('; ')})`);
}

if (failed) { console.error('💥 TRACK TESTS FAILED'); process.exit(1); }
console.log('All track checks passed');
process.exit(0);
