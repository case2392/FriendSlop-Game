// Dynamite (shared/blast.js) and the rock seamed with metal it's for: where the seamed rocks lie (the same every
// time, off the road, clear of everything and of the caches), a stick bought at the rack, lit with LMB, and what
// its bang does: knocked out close in, off their feet further out, nobody beyond; loose things thrown; a seamed
// rock blown into its ore, the boulder into rubble (and the rockfall above it brought down); the RV dented
// (less with the Reinforced Frame); sticks close by go off with it; never in town; Ed buys the ore.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { generateLeg, inMud } = await import('../shared/world.js');
const { oreRocks, BLAST, seamY } = await import('../shared/blast.js');
const { buriedSpots } = await import('../shared/dig.js');
const { GEAR } = await import('../shared/shop.js');
const { LOOT } = await import('../shared/loot.js');
const { nearTrack } = await import('../shared/tracks.js');
const { RV_DIM, toWorld } = await import('../shared/rv.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

// ---- the seamed rocks -------------------------------------------------------------------------------------
{
  const bad = [];
  let n = 0;
  const kinds = {};
  for (const seed of [777, 4242, 7, 99, 1234]) for (let day = 1; day <= 5; day++) {
    const W = generateLeg(seed, day), L = oreRocks(W), caches = buriedSpots(W);
    if (JSON.stringify(L) !== JSON.stringify(oreRocks(generateLeg(seed, day)))) bad.push(`${seed}/${day} not the same twice`);
    if (L.length < 2 + day) bad.push(`${seed}/${day} only ${L.length}`);
    for (const o of L) {
      n++; kinds[o.kind] = (kinds[o.kind] || 0) + 1;
      const tag = `${seed}/${day} #${o.id}`;
      if (Math.abs(o.x - W.roadX(o.z)) < 8) bad.push(`${tag} on the road`);
      if (inMud(W, o.x, o.z)) bad.push(`${tag} in the mud`);
      if ((W.tracks || []).some(T => nearTrack(T, o.x, o.z).d < T.hw + 1.5)) bad.push(`${tag} on a side road`);
      if (caches.some(c => Math.hypot(c.x - o.x, c.z - o.z) < 4)) bad.push(`${tag} on a cache`);
      if (L.some(q => q !== o && Math.hypot(q.x - o.x, q.z - o.z) < 25)) bad.push(`${tag} by another`);
      if (!o.items.length || o.items.some(it => !LOOT[it.type]?.ore || !(it.value > 0)) || !LOOT[o.type]?.seam) bad.push(`${tag} holds ${JSON.stringify(o.items)}`);
    }
  }
  check(!bad.length && n >= 100 && kinds.copper && kinds.silver && kinds.gold,
    `dynamite: ${n} seamed rocks over 25 days (${Object.entries(kinds).map(([k, c]) => `${c} ${k}`).join(', ')}), the same every time, none on the road, in the mud, on a side road, on a cache or by another, each with ore in it${bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''}`);
}

// ---- in a room ----------------------------------------------------------------------------------------------
await initPhysics();
const HZ = C.SIM_HZ;
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  toasts() { return this.sent.filter(m => m.t === 'toast').map(m => m.text); }
  evs(k) { return this.sent.filter(m => m.t === 'ev').flatMap(m => m.list).filter(e => e.k === k); }
  knocks() { return this.sent.filter(m => m.t === 'knock'); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * HZ); i++) room.tick(1 / HZ); };
function crew(names, day = 1, seed = 4242) {
  const room = new Room('BOOM', seed);
  const ps = names.map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  if (day > 1) room.debug(ps[0], { op: 'day', d: day });
  tick(room, 0.2);
  return { room, ps };
}
const stand = (room, p, x, z, yaw = 0) => room.onPose(p, { x, y: room.W.heightAt(x, z), z, yaw, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
const at = (room, id) => room.sim.props.get(id).body.translation();
const grabIt = (room, P, id) => { const t = at(room, id); stand(room, P, t.x - 1.2, t.z, Math.PI / 2); tick(room, 1 / 60); room.handle(P, { t: 'grab', kind: 'prop', id, pt: [t.x, t.y, t.z], d: 1.4 }); tick(room, 0.1); };
const ofType = (room, type) => [...room.sim.props.values()].filter(p => p.type === type);
const lastToast = p => p.conn.toasts().slice(-1)[0] || '';
// a stick lying at (x, z), and one lit right there with `secs` to go (the test's own match)
const stick = (room, x, z) => room.sim.addProp('dynamite', { x, y: room.W.heightAt(x, z) + 0.1, z }, { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, 0, 0);
const litStick = (room, x, z, by, secs = 0.1) => { const s = stick(room, x, z); room.fuses.set(s.id, { at: room.t + secs, by }); return s; };
const clearX = W => z => W.roadX(z) + 1.5;

{
  // the seamed rocks are bedded in the ground, too big to pick up, and (fixed: they never move) sent to the
  // pages once, not in every snapshot
  const { room, ps: [A] } = crew(['Ann']);
  const rocks = [...room.oreAt.entries()].map(([id, o]) => ({ p: room.sim.props.get(id), o }));
  const bedded = rocks.every(({ p, o }) => { const t = p.body.translation(); return p.body.isFixed() && Math.hypot(t.x - o.x, t.z - o.z) < 1e-3 && Math.abs(t.y - seamY(room.W, o)) < 1e-3; });
  grabIt(room, A, rocks[0].p.id);
  room.snapshot();
  tick(room, 0.5);
  const sent = rocks.filter(({ p }) => room.snapshot().pr.some(e => e[0] === p.id)).length;
  check(rocks.length === room.ores.length && rocks.length >= 3 && bedded && !room.sim.holds.get(A.id) && sent === 0,
    `dynamite: today's ${rocks.length} seamed rocks lie where shared/blast.js put them, bedded in the ground (${bedded}), nobody picks one up, and once sent they're left out of the snapshots (${sent} in the next)`);
}
{
  // a stick at the rack: $60, set down by it, and it's gear (Ed won't have it)
  const { room, ps: [A] } = crew(['Ann']);
  room.bank = 1000;
  const H = room.W.town.hardware;
  stand(room, A, H.x, H.z);
  tick(room, 0.35); room.handle(A, { t: 'shopBuy', v: 'store', id: 'dynamite' });
  tick(room, 0.5);
  const s = ofType(room, 'dynamite')[0];
  check(!!s && room.bank === 1000 - GEAR.dynamite.price && Math.hypot(at(room, s.id).x - H.x, at(room, s.id).z - H.z) < 3 && s.value === 0,
    `dynamite: a stick at the hardware rack, $${GEAR.dynamite.price} from the bank, set down by it`);
  // and not lit in town: the sheriff
  grabIt(room, A, s.id);
  room.handle(A, { t: 'light' });
  check(!room.fuses.size && /Not in town/.test(lastToast(A)), 'dynamite: not lit in town (the sheriff\'d lock you up)');
}
{
  // lit in hand, set down, it goes off BLAST.FUSE s later where it lies: out cold close in, off their feet
  // further out, nobody beyond; a loose thing thrown; the stick gone
  const { room, ps: [A, B, Cy, D] } = crew(['Ann', 'Bob', 'Cy', 'Dee']);
  // (on the road, the crew along it: the canyon's sides are steep, and a stick set down there rolls away)
  const W = room.W, z = 300, x = W.roadX(z);
  const s = stick(room, x, z);
  tick(room, 0.5);
  grabIt(room, A, s.id);
  room.handle(A, { t: 'light' });
  const lit = room.fuses.has(s.id) && room.gameState().fz?.[0]?.[0] === s.id && A.conn.evs('fuse').length === 1;
  room.handle(A, { t: 'rel' });
  tick(room, 0.6);
  const p0 = at(room, s.id), sx = p0.x, sz = p0.z;
  stand(room, A, W.roadX(sz + 25), sz + 25); stand(room, B, W.roadX(sz + 1.5), sz + 1.5); stand(room, Cy, W.roadX(sz - 4), sz - 4); stand(room, D, W.roadX(sz - 9), sz - 9);
  const box = room.sim.addProp('stone', { x: sx + 3, y: W.heightAt(sx + 3, sz) + 0.3, z: sz }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
  tick(room, BLAST.FUSE - 0.6 - 0.25 - 0.1);
  const early = room.sim.props.has(s.id) && !A.conn.evs('boom').length;
  tick(room, 0.5);
  const vb = room.sim.props.get(box.id)?.body.linvel();
  const kb = B.conn.knocks(), kc = Cy.conn.knocks(), kd = D.conn.knocks();
  const bang = !room.sim.props.has(s.id) && A.conn.evs('boom').length === 1 && !room.fuses.size;
  const ko = kb.length === 1 && kb[0].ko && kb[0].why === 'blast', down = kc.length === 1 && !kc[0].ko, clear = !kd.length && !A.conn.knocks().length;
  const thrown = vb && Math.hypot(vb.x, vb.y, vb.z) > 2;
  check(lit && early && bang && ko && down && clear && thrown,
    `dynamite: LMB lights the stick in hand (${lit}); set down, it goes off ${BLAST.FUSE} s on (not before: ${early}) where it lies (${bang}): Bob 1.5 m off is out cold (${ko}), Cy at 4 m off his feet (${down}), Dee at 9 m and Ann at 25 untouched (${clear}); a stone 3 m off thrown (${thrown ? Math.hypot(vb.x, vb.y, vb.z).toFixed(1) : 'no'} m/s)`);
}
{
  // a seamed rock blown into its ore (and rubble), the one beyond it untouched; a stick close by goes off too
  const { room, ps: [A] } = crew(['Ann']);
  const [r1, r2] = [...room.oreAt.entries()], [id1, o1] = r1;
  const t1 = at(room, id1);
  stand(room, A, t1.x + 20, t1.z);
  const n0 = room.sim.props.size;
  const s1 = litStick(room, t1.x + 1.3, t1.z, A.id), s2 = stick(room, t1.x + 1.3, t1.z + 1.2);
  tick(room, 0.6);
  const ore = [...room.sim.props.values()].filter(p => LOOT[p.type]?.ore && Math.hypot(at(room, p.id).x - t1.x, at(room, p.id).z - t1.z) < 8);
  const rubble = ofType(room, 'stone').filter(p => Math.hypot(at(room, p.id).x - t1.x, at(room, p.id).z - t1.z) < 8);
  const blown = !room.sim.props.has(id1) && !room.oreAt.has(id1) && ore.length === o1.items.length
    && ore.every(p => o1.items.some(it => it.type === p.type && it.value === p.value) && p.value === p.max) && rubble.length >= 3 && /blew the .* apart/.test(lastToast(A));
  const chain = !room.sim.props.has(s1.id) && !room.sim.props.has(s2.id) && A.conn.evs('boom').length === 2;
  const other = room.sim.props.has(r2[0]);
  check(blown && chain && other,
    `dynamite: a stick by the ${LOOT[o1.type].name} blows it into ${o1.items.map(it => `${LOOT[it.type].name} $${it.value}`).join(', ')} and rubble (${blown}); the stick 1.2 m off goes off with it (${chain}); the next rock along is still there (${other})`);
  // Ed buys the ore
  const T = room.W.town.pawn;
  for (const p of ore) { p.body.setTranslation({ x: T.x, y: T.y + 0.4, z: T.z }, true); p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); p.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
  tick(room, 1);
  const bank0 = room.bank, sold = room.sellCounter(A.id);
  check(sold > 0 && room.bank === bank0 + sold && ore.every(p => !room.sim.props.has(p.id)), `dynamite: Ed buys the ore ($${sold})`);
}
{
  // the RV dented by a blast by its side (by the distance to its body), less with the Reinforced Frame; the
  // crew inside it are spared one outside
  const hit = frame => {
    const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
    if (frame) { room.upg.frame = 1; room.partMods = (room.partMods && { ...room.partMods, hitX: 0.7 }); }
    const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
    const side = toWorld(rp, rq, { x: RV_DIM.HALF_W + 2, y: 0.2, z: 0 }), inside = toWorld(rp, rq, { x: 0, y: 0.3, z: 1.5 });
    room.onPose(B, { x: inside.x, y: inside.y, z: inside.z, yaw: 0, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
    stand(room, A, side.x + 30, side.z);
    tick(room, 0.3);
    const hp0 = room.rvc.hp;
    litStick(room, side.x, side.z, A.id);
    tick(room, C.RVH.GAP + 1);   // (an incident is told once it's over)
    return { lost: hp0 - room.rvc.hp, bob: B.conn.knocks().length, told: A.conn.toasts().some(t => /dynamite/i.test(t)) };
  };
  const bare = hit(false), framed = hit(true), want = Math.round(BLAST.RV_HIT * (1 - 2 / BLAST.RV_R));
  check(bare.lost <= want && bare.lost >= want - 2 && framed.lost > 0 && framed.lost < bare.lost && !bare.bob && bare.told,
    `dynamite: a stick 2 m off the RV's side dents it ${bare.lost}% (${want} expected), ${framed.lost}% with the Reinforced Frame; Bob inside isn't knocked down (${!bare.bob}); the toast says dynamite (${bare.told})`);
}
{
  // the boulder blown to rubble, and the loose rock on the rim above it comes down
  const room = new Room('BOOM', 4242);
  room.mobsOn = true;
  const ps = ['Ann', 'Bob'].map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  room.debug(ps[0], { op: 'day', d: 3 });
  tick(room, 0.2);
  room.phase = 'road';
  tick(room, 0.1);
  const mobs = room.sim.mobs, rf = mobs?.rockfalls.find(r => r.ob === 'boulder'), b = rf && room.sim.props.get(rf.boulder);
  if (!b) fail('dynamite: no boulder with a rockfall on day 3 of seed 4242 to test with');
  else {
    const t = b.body.translation();
    stand(room, ps[0], t.x, t.z - 40);
    stand(room, ps[1], t.x, t.z - 45);
    litStick(room, t.x + 1.6, t.z - 1.6, ps[0].id);
    tick(room, 0.5);
    const gone = !room.sim.props.has(b.id) && ofType(room, 'stone').filter(p => Math.hypot(at(room, p.id).x - t.x, at(room, p.id).z - t.z) < 10).length >= 6;
    check(gone && rf.st !== 'armed' && ps[0].conn.toasts().some(t => /boulder to pieces/.test(t)),
      `dynamite: the boulder in the narrows blown to rubble, the road open (${gone}); the loose rock on the rim above it comes down (${rf.st})`);
  }
}

if (failed) { console.error('💥 DYNAMITE TESTS FAILED'); process.exit(1); }
console.log('All dynamite checks passed');
process.exit(0);
