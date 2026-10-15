// Buried metal (shared/dig.js) and the general store's hardware (shared/shop.js GEAR): where the caches lie
// (the same every time, off the road, somewhere a shovel goes in, richer down the side roads), buying a detector
// and a shovel at the rack out front, and digging: four strokes of a held shovel on a cache bring its metal up
// as loot Ed buys; bare ground gives nothing; the gear is worth nothing to Ed and rides along in the RV.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { generateLeg, inMud } = await import('../shared/world.js');
const { buriedSpots, nearestCache, DIG, HOLE } = await import('../shared/dig.js');
const { GEAR } = await import('../shared/shop.js');
const { LOOT } = await import('../shared/loot.js');
const { nearTrack } = await import('../shared/tracks.js');
const { clearAt } = await import('../shared/finds.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { toWorld } = await import('../shared/rv.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

// ---- the caches ---------------------------------------------------------------------------------------
{
  const bad = [];
  let n = 0, deepV = 0, deepN = 0, roadV = 0, roadN = 0;
  for (const seed of [777, 4242, 7, 99, 1234]) for (let day = 1; day <= 5; day++) {
    const W = generateLeg(seed, day), L = buriedSpots(W), L2 = buriedSpots(generateLeg(seed, day));
    if (JSON.stringify(L) !== JSON.stringify(L2)) bad.push(`${seed}/${day} not the same twice`);
    if (L.length < 4 + day) bad.push(`${seed}/${day} only ${L.length}`);
    for (const c of L) {
      n++;
      const tag = `${seed}/${day} #${c.id}`;
      if (Math.abs(c.x - W.roadX(c.z)) < 6) bad.push(`${tag} on the road`);
      if (inMud(W, c.x, c.z)) bad.push(`${tag} in the mud`);
      if ((W.tracks || []).some(T => nearTrack(T, c.x, c.z).d < T.hw + 1)) bad.push(`${tag} on a side road`);
      if (!clearAt(W, c.x, W.heightAt(c.x, c.z), c.z, 1)) bad.push(`${tag} under something`);
      if (!c.items.length || c.items.some(it => !LOOT[it.type]?.dug || !(it.value > 0))) bad.push(`${tag} holds ${JSON.stringify(c.items)}`);
      if (L.some(q => q !== c && Math.hypot(q.x - c.x, q.z - c.z) < 9)) bad.push(`${tag} on top of another`);
      const v = c.items.reduce((a, it) => a + it.value, 0) / (1 + 0.22 * (day - 1));
      if (c.deep) { deepV += v; deepN++; } else { roadV += v; roadN++; }
    }
  }
  check(!bad.length && n > 200, `dig: ${n} caches over 25 days, the same every time, none on the road, in the mud, on a side road, under anything or on top of another, each with metal in it${bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''}`);
  check(deepN > 10 && deepV / deepN > 1.2 * (roadV / roadN), `dig: a cache down a side road is worth ${(deepV / deepN / (roadV / roadN)).toFixed(2)}x one by the road on average (${deepN} and ${roadN}; day 1's prices: $${Math.round(deepV / deepN)} and $${Math.round(roadV / roadN)})`);
}

// ---- buying, digging ----------------------------------------------------------------------------------
await initPhysics();
const HZ = C.SIM_HZ;
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  toasts() { return this.sent.filter(m => m.t === 'toast').map(m => m.text); }
  evs(k) { return this.sent.filter(m => m.t === 'ev').flatMap(m => m.list).filter(e => e.k === k); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * HZ); i++) room.tick(1 / HZ); };
function crew(names, day = 1, seed = 4242) {
  const room = new Room('DIG', seed);
  const ps = names.map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  if (day > 1) room.debug(ps[0], { op: 'day', d: day });
  tick(room, 0.2);
  return { room, ps };
}
const stand = (room, p, x, z, yaw = 0) => room.onPose(p, { x, y: room.W.heightAt(x, z), z, yaw, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
// (walked there in half-metre steps: a held thing is let go if its holder jumps metres at once)
const walk = (room, p, x, z, yaw = 0) => {
  const x0 = p.pos.x, z0 = p.pos.z, n = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 0.5));
  for (let i = 1; i <= n; i++) { stand(room, p, x0 + (x - x0) * i / n, z0 + (z - z0) * i / n, yaw); tick(room, 1 / 30); }
};
const at = (room, id) => room.sim.props.get(id).body.translation();
const grabIt = (room, P, id) => { const t = at(room, id); stand(room, P, t.x - 1.2, t.z, Math.PI / 2); tick(room, 1 / 60); room.handle(P, { t: 'grab', kind: 'prop', id, pt: [t.x, t.y, t.z], d: 1.4 }); tick(room, 0.1); };
const lastToast = p => p.conn.toasts().slice(-1)[0] || '';
const ofType = (room, type) => [...room.sim.props.values()].filter(p => p.type === type);

{
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  room.bank = 2000;
  const H = room.W.town.hardware, bank0 = room.bank;
  const use = room.W.uses.find(u => u.kind === 'shop' && u.arg === 'store');
  stand(room, A, H.x, H.z);
  room.handle(A, { t: 'use', id: use.id });
  const opened = A.conn.sent.some(m => m.t === 'shop' && m.v === 'store');
  // across the street: no
  stand(room, B, H.x + 15, H.z);
  tick(room, 0.35); room.handle(B, { t: 'shopBuy', v: 'store', id: 'shovel' });
  const far = room.bank === bank0 && !ofType(room, 'shovel').length;
  // at the rack, in the morning (no waiting for night): a shovel and a detector, set down by it
  tick(room, 0.35); room.handle(A, { t: 'shopBuy', v: 'store', id: 'shovel' });
  tick(room, 0.35); room.handle(A, { t: 'shopBuy', v: 'store', id: 'detector' });
  tick(room, 0.35); room.handle(A, { t: 'shopBuy', v: 'store', id: 'shovel' });
  tick(room, 1);
  const sh = ofType(room, 'shovel'), dt = ofType(room, 'detector');
  const by = p => Math.hypot(at(room, p.id).x - H.x, at(room, p.id).z - H.z) < 3;
  const bought = sh.length === 2 && dt.length === 1 && room.bank === bank0 - 2 * GEAR.shovel.price - GEAR.detector.price && [...sh, ...dt].every(by) && [...sh, ...dt].every(p => p.value === 0);
  // the bank short: no
  room.bank = GEAR.detector.price - 1;
  tick(room, 0.35); room.handle(A, { t: 'shopBuy', v: 'store', id: 'detector' });
  const short = ofType(room, 'detector').length === 1 && /The bank has/.test(lastToast(A));
  check(opened && far && bought && short, `dig: E on the hardware rack opens the store's catalogue (${opened}); a shovel and a detector bought there any time are set down by the rack, $${GEAR.shovel.price} and $${GEAR.detector.price} from the bank (${bought}); not from across the street (${far}) nor short of the price (${short})`);
}
{
  // strokes of a held shovel go down a hole: a cache's has a chest at the bottom (pulled up with E, opened with
  // E: what was in it pops out), bare ground's has nothing; no shovel, or out of reach, no stroke
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  const W = room.W, sim = room.sim;
  const c = room.caches.slice().sort((a, b) => a.items.length - b.items.length)[0];
  const y = W.heightAt(c.x, c.z);
  const sh = sim.addProp('shovel', { x: c.x + 1.2, y: y + 0.3, z: c.z }, { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, 0, 0);
  tick(room, 0.6);
  grabIt(room, A, sh.id);
  const held = sim.holds.get(A.id)?.id === sh.id;
  stand(room, B, c.x - 1, c.z);
  tick(room, 0.5); room.handle(B, { t: 'dig', pt: [c.x, y, c.z] });
  const noShovel = !B.conn.evs('dig').length && !room.holes.size;
  tick(room, 0.5); room.handle(A, { t: 'dig', pt: [c.x + 8, W.heightAt(c.x + 8, c.z), c.z] });
  const tooFar = !A.conn.evs('dig').length;
  // bare ground 6 m off the cache: down DIG.STROKES strokes into one hole, its dirt on one pile, nothing at the bottom
  walk(room, A, c.x + 6.5, c.z, Math.PI / 2);
  for (let k = 0; k <= DIG.STROKES; k++) { tick(room, DIG.CD + 0.05); room.handle(A, { t: 'dig', pt: [c.x + 6 + (k % 2) * 0.3, W.heightAt(c.x + 6, c.z), c.z] }); }
  const be = A.conn.evs('dig'), b0 = be[0]?.h || [];
  const bare = be.length === DIG.STROKES && be.every((e, i) => e.h[0] === b0[0] && e.h[3] === i + 1 && e.h[5] === b0[5] && e.h[6] === b0[6])
    && be.at(-1).h[4] === HOLE.EMPTY && Math.hypot(b0[5] - b0[1], b0[6] - b0[2]) > 0.9 && !room.dug.size && /Nothing down here/.test(A.conn.toasts().join('|'));
  // the cache: down to its chest
  walk(room, A, c.x + 1.2, c.z, -Math.PI / 2);
  const n0 = A.conn.evs('dig').length;
  for (let k = 0; k < DIG.STROKES; k++) { tick(room, DIG.CD + 0.05); room.handle(A, { t: 'dig', pt: [c.x + 0.3, y, c.z - 0.2] }); }
  const ce = A.conn.evs('dig').slice(n0), hid = ce[0]?.h[0];
  tick(room, DIG.CD + 0.05); room.handle(A, { t: 'dig', pt: [c.x, y, c.z] });   // (at the bottom: no more)
  const down = ce.length === DIG.STROKES && ce.every(e => e.h[0] === hid) && ce.at(-1).h[4] === HOLE.CHEST && A.conn.evs('dig').length === n0 + DIG.STROKES
    && room.dug.has(c.id) && room.gameState().chs?.[0]?.[0] === hid && A.conn.toasts().some(t => /a chest!/.test(t)) && /hold E on it to pull it out/.test(lastToast(A)) && !ofType(room, "chest").length;
  check(held && noShovel && tooFar && bare && down,
    `dig: ${DIG.STROKES} strokes of a held shovel go down a hole: on bare ground, one hole and one pile, and nothing at the bottom (${bare}); on the cache, its chest at the bottom (${down}); not with empty hands (${noShovel}), nor out of reach (${tooFar})`);
  // pulling: from too far, nothing; Ann and Bob holding E together bring it up in about half one's time
  room.handle(A, { t: 'rel' }); tick(room, 0.3);
  stand(room, B, c.x - 4, c.z);
  room.handle(B, { t: 'pull', h: hid, on: 1 }); tick(room, 1);
  const far = room.holes.get(hid).prog === 0;
  room.handle(B, { t: 'pull', h: hid, on: 0 });
  stand(room, B, c.x - 1.3, c.z);
  tick(room, 0.2);
  room.handle(A, { t: 'pull', h: hid, on: 1 }); room.handle(B, { t: 'pull', h: hid, on: 1 });
  let took = 0;
  while (room.holes.get(hid).st === HOLE.CHEST && took < 6) { tick(room, 0.05); took += 0.05; }
  const chest = ofType(room, 'chest')[0];
  tick(room, 1.5);
  const ct = chest && at(room, chest.id);
  const pulled = room.holes.get(hid).st === HOLE.PULLED && !!chest && Math.abs(took - (1 - 2 * DIG.PULL_TAP) * DIG.PULL_T / 2) < 0.2
    && Math.hypot(ct.x - c.x, ct.z - c.z) < 2 && Math.hypot(ct.x - c.x, ct.z - c.z) > 0.4 && ct.y > W.heightAt(ct.x, ct.z) - 0.05 && !room.gameState().chs && /hauled up a chest/.test(lastToast(A));
  // mashing E: quicker than holding it
  const mash = (() => {
    const r2 = crew(['Cy']), R = r2.room, P = r2.ps[0], h = R.newHole(R.W.roadX(300) + 12, 300, null, { pos: { x: R.W.roadX(300) + 10, z: 300 } });
    h.st = HOLE.CHEST; stand(R, P, h.x - 1, h.z); tick(R, 0.2);
    for (let k = 0; k < 10; k++) { R.handle(P, { t: 'pull', h: h.id, on: 1 }); tick(R, 0.05); R.handle(P, { t: 'pull', h: h.id, on: 0 }); tick(R, 0.05); }
    const mashed = h.prog;
    h.prog = 0; R.handle(P, { t: 'pull', h: h.id, on: 1 }); tick(R, 1);
    return [mashed, h.prog];
  })();
  // a shut chest isn't carried off: E opens it where it lies
  grabIt(room, A, chest.id);
  const shut = !sim.holds.get(A.id);
  room.handle(A, { t: 'open', id: chest.id });
  tick(room, 1.5);
  const items = [...sim.props.values()].filter(p => LOOT[p.type]?.dug && Math.hypot(at(room, p.id).x - ct.x, at(room, p.id).z - ct.z) < 3);
  const old = ofType(room, 'chestOpen');
  const opened = !sim.props.has(chest.id) && old.length === 1 && items.length === c.items.length && items.every(p => c.items.some(it => it.type === p.type && it.value === p.value) && p.value === p.max)
    && /opened the chest/.test(lastToast(A));
  check(far && pulled && mash[0] > mash[1] && shut && opened,
    `dig: E held on the chest: not from across the way (${far}); Ann and Bob together bring it up in ${took.toFixed(2)} s, onto the lip (${pulled}); mashing E pulls ${Math.round(mash[0] * 100)}% in a second to holding's ${Math.round(mash[1] * 100)}%; shut, it isn't carried off (${shut}); opened, its ${c.items.map(it => `${LOOT[it.type].name} $${it.value}`).join(', ')} pop out unharmed, and an old chest's left (${opened})`);
  // what came up sells at Ed's, and the old chest; the shovel doesn't
  const T = W.town.pawn;
  for (const p of [...items, ...old]) p.body.setTranslation({ x: T.x, y: T.y + 0.4, z: T.z }, true);
  sim.props.get(sh.id).body.setTranslation({ x: T.x, y: T.y + 0.7, z: T.z + 0.3 }, true);
  tick(room, 0.5);
  const bank0 = room.bank, sold = room.sellCounter(A.id);
  check(sold > 0 && room.bank === bank0 + sold && sim.props.has(sh.id) && items.every(p => !sim.props.has(p.id)) && !sim.props.has(old[0].id),
    `dig: Ed buys what came up and the old chest ($${sold}) and leaves the shovel on his counter`);
}
{
  // the gear rides along in the RV into tomorrow (it never goes in the locker), and the detector's signal
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim, rp = sim.rv.translation(), rq = sim.rv.rotation();
  const d = sim.addProp('detector', toWorld(rp, rq, { x: 0.3, y: 0.5, z: -1.5 }), { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, 0, 0);
  tick(room, 2);
  const stowed = sim.locker.some(it => it.type === 'detector');
  room.nextDay();
  tick(room, 0.5);
  const rides = !stowed && ofType(room, 'detector').length === 1;
  const c = room.caches[0];
  check(rides && nearestCache(room.caches, c.x, c.z, room.dug).d === 0,
    `dig: a detector in the RV rides into tomorrow, loose (${rides}); the nearest cache to one is found ${nearestCache(room.caches, c.x + 2, c.z, room.dug).d.toFixed(1)} m off`);
}

if (failed) { console.error('💥 DIG TESTS FAILED'); process.exit(1); }
console.log('All dig checks passed');
process.exit(0);
