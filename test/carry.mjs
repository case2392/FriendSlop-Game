// The heavy loot takes two (shared/loot.js TANDEM): one of you takes an end and it stays where it lies; two
// lift it between them, an end each, its long side along the line between them; a third finds no room on it.
// The two go where both lean (tandemVel: the page moves each by it, main.js tandemDrive): the same way, together;
// pulling against each other along it, nowhere; one alone, the pair with them, at half pace; one leaning
// across it, the pair turns about the other. Each one's lean reaches the other's page ('tw'). Let go of, it's
// down; nobody throws it.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { LOOT, TANDEM, twoMan, longSide, tandemGap, tandemVel } = await import('../shared/loot.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

// ---- which, and how the pair moves (pure) ---------------------------------------------------------------
{
  const heavy = Object.keys(LOOT).filter(twoMan);
  check(heavy.sort().join() === 'dino,safe,slot' && !twoMan('boulder') && !twoMan('grumphorn') && !twoMan('tv'),
    `carry: the heavy loot that takes two: ${heavy.join(', ')} (not the boulder, the grumphorn or a TV); feet to feet ${heavy.map(t => `${t} ${tandemGap(t).toFixed(2)} m`).join(', ')}`);
  // two carriers, A at the origin and B gap along x, each moved by tandemVel with the other's lean, 4 s at 60 Hz
  const S = C.PLAYER.WALK * 0.5, gap = tandemGap('safe');
  const walk = (wa, wb, secs = 4) => {
    const A = { x: 0, z: 0 }, B = { x: gap, z: 0 };
    for (let i = 0; i < secs * 60; i++) {
      const va = tandemVel(wa, wb, { x: B.x - A.x, z: B.z - A.z }, gap), vb = tandemVel(wb, wa, { x: A.x - B.x, z: A.z - B.z }, gap);
      A.x += va.x / 60; A.z += va.z / 60; B.x += vb.x / 60; B.z += vb.z / 60;
    }
    return { A, B, a: Math.hypot(A.x, A.z), b: Math.hypot(B.x - gap, B.z), d: Math.hypot(B.x - A.x, B.z - A.z) };
  };
  const same = walk({ x: 0, z: S }, { x: 0, z: S }), tug = walk({ x: -S, z: 0 }, { x: S, z: 0 }), tug2 = walk({ x: S, z: 0 }, { x: -S, z: 0 });
  const one = walk({ x: -S, z: 0 }, { x: 0, z: 0 }), turn = walk({ x: 0, z: S }, { x: 0, z: 0 }, 2);
  const full = S * 4;
  check(Math.abs(same.a - full) < 0.05 && Math.abs(same.b - full) < 0.05 && Math.abs(same.d - gap) < 0.01,
    `carry: both leaning the same way, the pair goes together: ${same.a.toFixed(2)} m and ${same.b.toFixed(2)} m in 4 s (a heavy walk: ${full.toFixed(2)} m), still ${same.d.toFixed(2)} m apart`);
  check(tug.a < 0.3 && tug.b < 0.3 && tug2.a < 0.3 && tug2.b < 0.3,
    `carry: pulling against each other along it, nowhere: ${tug.a.toFixed(2)} m and ${tug.b.toFixed(2)} m pulling apart, ${tug2.a.toFixed(2)} m and ${tug2.b.toFixed(2)} m pushing together`);
  check(Math.abs(one.a - full / 2) < 0.4 && Math.abs(one.b - full / 2) < 0.4 && Math.abs(one.d - gap) < 0.3,
    `carry: one leaning, the other not: the pair goes at half pace (${one.a.toFixed(2)} m and ${one.b.toFixed(2)} m of ${(full / 2).toFixed(2)})`);
  check(turn.a > turn.b * 1.8 && turn.b > 0.1 && Math.abs(turn.d - gap) < TANDEM.SLACK + 0.1,
    `carry: one leaning across it turns the pair about the other: ${turn.a.toFixed(2)} m against ${turn.b.toFixed(2)} m in 2 s, ${turn.d.toFixed(2)} m apart (${gap.toFixed(2)})`);
}

// ---- in a room -------------------------------------------------------------------------------------------
await initPhysics();
const HZ = C.SIM_HZ;
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  evs(k) { return this.sent.filter(m => m.t === 'ev').flatMap(m => m.list).filter(e => e.k === k); }
  toasts() { return this.sent.filter(m => m.t === 'toast').map(m => m.text); }
}
const tick = (room, secs, f) => { for (let i = 0; i < Math.round(secs * HZ); i++) { f?.(i); room.tick(1 / HZ); } };
{
  const room = new Room('CARRY', 4242);
  const [A, B, Cy] = ['Ann', 'Bo', 'Cy'].map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  tick(room, 0.3);
  const W = room.W, sim = room.sim, z0 = 60, x0 = W.roadX(z0) + 1, g0 = W.heightAt(x0, z0), L = LOOT.safe;
  const pr = sim.addProp('safe', { x: x0, y: g0 + L.shape[2] + 0.05, z: z0 }, { x: 0, y: 0, z: 0, w: 1 }, 1300, 1300);
  tick(room, 1.5);
  const t0 = { ...pr.body.translation() }, gap = tandemGap('safe'), ls = longSide('safe');
  // stand at (x, z) looking at the safe, and say which way you lean
  const stand = (p, x, z, w) => {
    const y = W.heightAt(x, z), t = pr.body.translation(), dx = t.x - x, dz = t.z - z, dy = t.y - (y + C.PLAYER.EYE);
    room.onPose(p, { x, y, z, yaw: Math.atan2(dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)), m: C.MODE.WALK, f: 0, v: [0, 0, 0], ...(w ? { w } : {}) });
  };
  const grab = p => { const t = pr.body.translation(); room.handle(p, { t: 'grab', kind: 'prop', id: pr.id, pt: [t.x, t.y + 0.2, t.z], d: 1.2 }); };
  const pairEv = () => A.conn.evs('pair').slice(-1)[0]?.ids || [];
  // Ann alone, an end: it stays down
  stand(A, x0 - gap / 2, z0); tick(room, 1 / HZ); grab(A); tick(room, 2);
  const alone = pr.body.translation().y - t0.y, aloneHeld = sim.holds.get(A.id)?.id === pr.id, pair1 = pairEv().join();
  // Bo takes the other end: up between them, its long side along them
  stand(B, x0 + gap / 2, z0); tick(room, 1 / HZ); grab(B); tick(room, 2, () => { stand(A, x0 - gap / 2, z0); stand(B, x0 + gap / 2, z0); });
  const up = pr.body.translation(), ends = [sim.holds.get(A.id)?.end, sim.holds.get(B.id)?.end], pair2 = pairEv().join();
  const q = pr.body.rotation(), lx = 1 - 2 * (q.y * q.y + q.z * q.z), lz = 2 * (q.x * q.z - q.w * q.y);   // (its local x in the world)
  const along = Math.abs(ls.ax === 'x' ? lx : 0);
  check(alone < 0.05 && aloneHeld && pair1 === String(A.id),
    `carry: Ann alone with an end of the safe: it stays down (${alone.toFixed(2)} m), in her hands, the crew told she has it (${pair1})`);
  check(up.y - g0 > TANDEM.HIGH - 0.2 && Math.abs(up.x - x0) < 0.25 && ends[0] === -ends[1] && pair2 === `${A.id},${B.id}` && along > 0.9,
    `carry: Bo takes the other end: the safe comes up between them to ${(up.y - g0).toFixed(2)} m (their hands' ${TANDEM.HIGH} m), ${Math.abs(up.x - x0).toFixed(2)} m off their middle, an end each (${ends.join(', ')}), its long side along them (${along.toFixed(2)})`);
  // Cy finds no room on it
  stand(Cy, x0, z0 + 1.4); tick(room, 1 / HZ); Cy.conn.sent.length = 0; grab(Cy); tick(room, 0.1);
  check(!sim.holds.get(Cy.id) && Cy.conn.sent.some(m => m.t === 'grabbed' && !m.ok) && /Two have it already/.test(Cy.conn.toasts().join('|')),
    'carry: a third pair of hands finds no room on it (refused, and told)');
  // the two carry it 5 m along, each leaning that way: Bo's page hears how Ann leans
  B.conn.sent.length = 0;
  tick(room, 4, i => { const d = Math.min(5, i / HZ * 1.6); stand(A, x0 - gap / 2, z0 + d, [0, 1.6]); stand(B, x0 + gap / 2, z0 + d, [0, 1.6]); });
  tick(room, 1, () => { stand(A, x0 - gap / 2, z0 + 5); stand(B, x0 + gap / 2, z0 + 5); });
  const there = pr.body.translation(), tw = B.conn.sent.filter(m => m.t === 'tw' && m.id === A.id);
  check(Math.abs(there.z - (z0 + 5)) < 0.4 && there.y - W.heightAt(there.x, there.z) > TANDEM.HIGH - 0.25 && tw.length >= 2 && tw.some(m => m.w[1] === 1.6),
    `carry: the two carry it 5 m along (it's ${(there.z - z0).toFixed(2)} m along, ${(there.y - W.heightAt(there.x, there.z)).toFixed(2)} m up), and Bo's page hears how Ann leans (${tw.length} 'tw')`);
  // Ann lets go (a throw is only a letting go): it's down, Bo alone with his end
  A.conn.sent.length = 0;
  room.handle(A, { t: 'rel', thr: 1, dir: [0, 0.2, 1] });
  tick(room, 2, () => stand(B, x0 + gap / 2, z0 + 5));
  const down = pr.body.translation().y - W.heightAt(pr.body.translation().x, pr.body.translation().z), v = pr.body.linvel();
  check(down < L.shape[2] + 0.1 && !A.conn.evs('throw').length && pairEv().join() === String(B.id) && sim.holds.get(B.id)?.id === pr.id && Math.hypot(v.x, v.z) < 0.5,
    `carry: Ann lets go (RMB: no throw): it comes down (${down.toFixed(2)} m, its half height ${L.shape[2]}), Bo left with his end (${pairEv().join()})`);
  sim.free?.();
}

if (failed) { console.error('\nCARRY TESTS FAILED'); process.exit(1); }
console.log('\nall carry tests passed');
process.exit(0);
