// Frostpeak Pass (the snow day) and Gus's Snow Tires: the black ice on its road (shared/world.js icePatches),
// the stock tyres ploughing its packed snow and sliding on its ice (server/sim.js; shared/constants.js RV
// SNOW_DRAG, ICE_SLIP), and the Snow Tires that grip on both (shared/shop.js). Measured on the server's own
// physics, with a driver who steers along the road.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { generateLeg, ICE, onIce } = await import('../shared/world.js');
const { initPhysics, Sim } = await import('../server/sim.js');
const { Room } = await import('../server/room.js');
const { qYaw, toWorld } = await import('../shared/rv.js');
const { rvMods, UPGRADES } = await import('../shared/shop.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

{
  // the ice: the snow day only, ICE.N stretches a leg, clear of the obstacles, the camp and the town, apart,
  // the same every time; a BLACK ICE sign (a solid one) before each
  const bad = [];
  let n = 0;
  for (const seed of [4242, 777, 7, 99, 1234, 31337]) {
    for (const day of [1, 2, 4, 5]) if (generateLeg(seed, day).ice.length) bad.push(`${seed}/${day} has ice`);
    const W = generateLeg(seed, 3), again = generateLeg(seed, 3).ice;
    if (JSON.stringify(W.ice) !== JSON.stringify(again)) bad.push(`${seed} not the same twice`);
    if (W.ice.length !== ICE.N) bad.push(`${seed}: ${W.ice.length} stretches`);
    for (const m of W.ice) {
      n++;
      if (m.z0 < 70 || m.z1 > W.LEN - 60) bad.push(`${seed} ${m.z0} by the camp or the town`);
      for (const o of W.obstacles) {
        const a = o.z0 ?? o.z, b = o.z1 ?? o.z;
        if (m.z1 > a - 25 && m.z0 < b + 25) bad.push(`${seed} ${m.z0} on the ${o.type}`);
      }
      if (W.ice.some(q => q !== m && Math.abs(q.z0 - m.z0) < ICE.LEN + ICE.GAP)) bad.push(`${seed} ${m.z0} on another`);
      const sign = W.signs.find(s => s.lines[0] === 'BLACK ICE' && Math.abs(s.z - (m.z0 - 12)) < 0.01);
      if (!sign || !W.statics.some(b => b.part === 'signpost' && Math.hypot(b.x - sign.x, b.z - sign.z) < 0.5)) bad.push(`${seed} ${m.z0} no solid sign`);
      if (!onIce(W, W.roadX((m.z0 + m.z1) / 2), (m.z0 + m.z1) / 2) || onIce(W, W.roadX(m.z0 + 5) + m.hw + 1, m.z0 + 5) || onIce(W, W.roadX(m.z1 + 3), m.z1 + 3)) bad.push(`${seed} ${m.z0} onIce wrong`);
    }
  }
  check(!bad.length && n === 18, `snow: ${n} stretches of black ice over 6 snow days (none on the other days), clear of the obstacles, the camp and the town, apart, the same every time, each with a solid BLACK ICE sign before it${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''}`);
}

await initPhysics();
const dt = 1 / 60;
// a driver who steers along the road, flat out (or held to cap m/s), from z0 to z1; pushers: crew pushing from
// behind -> { t: seconds, done, top: m/s }
function drive(W, parts, z0, z1, { cap = 99, pushers = 0 } = {}) {
  const sim = new Sim(W, { parts });
  for (const g of W.gates) sim.openGate(g.id);
  sim.placeRV(W.roadX(z0), z0, Math.atan2(W.roadX(z0 + 3) - W.roadX(z0 - 3), 6));
  const players = new Map();
  for (let i = 0; i < 60; i++) sim.step(dt, players);
  let t = 0, top = 0;
  for (; t < 90; t += dt) {
    const p = sim.rv.translation();
    if (p.z >= z1) break;
    const yaw = qYaw(sim.rv.rotation()), look = p.z + 12, want = Math.atan2(W.roadX(look) - p.x, look - p.z);
    let err = want - yaw; while (err > Math.PI) err -= 2 * Math.PI; while (err < -Math.PI) err += 2 * Math.PI;
    const sp = sim.rvSpeed();
    top = Math.max(top, sp);
    sim.setDrive({ th: sp < cap ? 1 : sp > cap + 1 ? -0.4 : 0, st: Math.max(-1, Math.min(1, err * 2.5)), hb: 0 });
    if (pushers && Math.round(t / dt) % 5 === 0) {
      const rp = sim.rv.translation(), rq = sim.rv.rotation(), f = toWorld(rp, rq, { x: 0, y: 0, z: 1 });
      for (let k = 0; k < pushers; k++) {
        const pt = toWorld(rp, rq, { x: -0.5 + k, y: 1, z: -4 }), at = toWorld(rp, rq, { x: -0.5 + k, y: 0, z: -4.6 });
        sim.push(100 + k, { kind: 'rv', pt: [pt.x, pt.y, pt.z], dir: [f.x - rp.x, 0, f.z - rp.z] }, { pos: at });
      }
    }
    sim.step(dt, players);
  }
  return { t, done: sim.rv.translation().z >= z1, top };
}
const stock = rvMods(null, null), studs = rvMods(null, { snow: 1 });
{
  // the snow: from camp to the gate, flat out, the stock tyres take about a quarter longer (and are slower at
  // their fastest), the Snow Tires as long as without the snow; a dry day isn't touched by it
  const rows = [];
  for (const seed of [4242, 777, 99]) {
    const W = generateLeg(seed, 3), gate = W.obstacles.find(o => o.type === 'gate');
    const a = drive(W, stock, 5, gate.z - 12), b = drive(W, studs, 5, gate.z - 12);
    rows.push({ seed, a, b });
  }
  const W1 = generateLeg(4242, 1), g1 = W1.obstacles.find(o => o.type === 'gate') || { z: 240 };
  const d1 = drive(W1, stock, 5, Math.min(g1.z - 12, 220)), d1s = drive(W1, studs, 5, Math.min(g1.z - 12, 220));
  check(rows.every(r => r.a.done && r.b.done && r.a.t > r.b.t * 1.15 && r.a.t < r.b.t * 1.4 && r.a.top < r.b.top - 1) && Math.abs(d1.t - d1s.t) < 0.05,
    `snow: camp to the gate on Frostpeak Pass, stock tyres ${rows.map(r => `${r.a.t.toFixed(1)} s (${(r.a.top * 2.237).toFixed(0)} mph tops)`).join(', ')}; Snow Tires ${rows.map(r => `${r.b.t.toFixed(1)} s (${(r.b.top * 2.237).toFixed(0)} mph)`).join(', ')}; on day 1 they make no difference (${d1.t.toFixed(1)} and ${d1s.t.toFixed(1)} s)`);
}
{
  // the ice: from a standstill on it, the stock tyres barely get going (two pushing get it moving); the Snow
  // Tires drive off it
  const rows = [];
  for (const seed of [4242, 777]) {
    const W = generateLeg(seed, 3);
    for (const m of W.ice) rows.push({ a: drive(W, stock, m.z0 + 2, m.z1), p: drive(W, stock, m.z0 + 2, m.z1, { pushers: 2 }), b: drive(W, studs, m.z0 + 2, m.z1) });
  }
  const avg = k => rows.reduce((s, r) => s + r[k].t, 0) / rows.length;
  check(rows.every(r => r.a.done && r.b.done && r.a.t > r.b.t * 1.3 && r.p.t < r.a.t * 0.6),
    `snow: from a standstill on the black ice (${rows.length} stretches), the stock tyres take ${avg('a').toFixed(1)} s to get off it on average, with two pushing ${avg('p').toFixed(1)} s, on Snow Tires ${avg('b').toFixed(1)} s`);
}
{
  // Gus sells them at night like his other parts, and the RV has them at once
  class FakeConn { constructor() { this.readyState = 1; this.sent = []; } send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); } close() {} }
  const room = new Room('SNOW', 4242);
  const A = room.addPlayer(new FakeConn(), 'Ann').player; room.welcome(A);
  for (let i = 0; i < 12; i++) room.tick(1 / C.SIM_HZ);
  room.bank = 5000 + room.due; room.pay();
  for (let i = 0; i < 30; i++) room.tick(1 / C.SIM_HZ);
  const b = room.W.town.gusBoard;
  room.onPose(A, { x: b.x + 1.2, y: room.W.heightAt(b.x + 1.2, b.z), z: b.z, yaw: -Math.PI / 2, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
  for (let i = 0; i < 24; i++) room.tick(1 / C.SIM_HZ);
  const bank0 = room.bank;
  room.handle(A, { t: 'shopBuy', v: 'gus', id: 'snow' });
  check(room.upg.snow === 1 && room.bank === bank0 - UPGRADES.snow.price && room.sim.parts.iceSlip === C.RV.FRICTION_SLIP && room.sim.parts.snowDragX === 0,
    `snow: Gus fits Snow Tires at night for $${UPGRADES.snow.price} (bank $${bank0} -> $${room.bank}), and the RV has their grip at once`);
}

if (failed) { console.error('\n💥 SNOW TESTS FAILED'); process.exit(1); }
console.log('\nAll snow checks passed');
process.exit(0);
