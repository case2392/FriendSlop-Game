// Fences are solid (shared/world.js: a thin invisible box per rail span). Checks world gen's boxes against the
// fences drawn, that a walking player stops at one and a jump clears it (the page's own controller, client/js/
// player.js, on the page's physics world), that loot thrown at one stops, and that the RV drives through.
import './pagemods.mjs';
const C = await import('../shared/constants.js');
const { generateLeg } = await import('../shared/world.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { initPhys, LocalWorld } = await import('../client/js/phys.js');
const { Me } = await import('../client/js/player.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));
await initPhysics();
await initPhys();

// F1: a box for each span drawn (posts 1.9 m apart; a span steeper than 0.4 has no rails, and no box)
{
  let runs = 0, spans = 0, boxes = 0, off = 0;
  for (const seed of [777, 4242, 7]) for (let d = 1; d <= 5; d++) {
    const W = generateLeg(seed, d), F = W.statics.filter(s => s.part === 'fence');
    boxes += F.length;
    for (const f of W.decor.filter(q => q.k === 'fence')) {
      runs++;
      const n = Math.max(2, f.len || 4), s = Math.sin(f.ry || 0), c = Math.cos(f.ry || 0);
      for (let i = 0; i < n - 1; i++) {
        const z0 = (i - (n - 1) / 2) * 1.9, A = { x: f.x + z0 * s, z: f.z + z0 * c }, B = { x: f.x + (z0 + 1.9) * s, z: f.z + (z0 + 1.9) * c };
        if (Math.abs(W.heightAt(B.x, B.z) - W.heightAt(A.x, A.z)) / 1.9 > 0.4) continue;
        spans++;
        const m = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
        if (!F.some(b => Math.hypot(b.x - m.x, b.z - m.z) < 0.01 && b.mat === 'invisible' && b.hy * 2 >= 0.94)) off++;
      }
    }
  }
  check(runs > 100 && spans === boxes && !off, `fences: ${boxes} solid spans for the ${runs} fence runs on 3 seeds x 5 days, one for every span drawn (${off} missing)`);
}

// a fence run on the fields day (Westfall: the most of them), on flat enough ground, and a spot 2.2 m off its side
const W = generateLeg(777, 2);
const F = W.statics.filter(s => s.part === 'fence');
const pick = F.find(b => {
  const nx = Math.cos(b.ry), nz = -Math.sin(b.ry), g = W.heightAt(b.x, b.z);
  return [-2.2, 2.2].every(d => Math.abs(W.heightAt(b.x + nx * d, b.z + nz * d) - g) < 0.15) && b.hy * 2 < 1.05
    && !W.statics.some(o => o !== b && o.part !== 'fence' && Math.hypot(o.x - b.x, o.z - b.z) < 5) && !W.cyls.some(o => Math.hypot(o.x - b.x, o.z - b.z) < 4);
});
const side = pick && { nx: Math.cos(pick.ry), nz: -Math.sin(pick.ry) };   // the box's local x: across the fence
const across = p => (p.x - pick.x) * side.nx + (p.z - pick.z) * side.nz;

// F2: the page's own controller: walking into it stops, a jump clears it, and with the fences gone you walk through
{
  const walk = (lw, jumpAt = null, secs = 2.5) => {
    const me = new Me(), st = { x: pick.x - side.nx * 2.2, z: pick.z - side.nz * 2.2 };
    me.teleport(st.x, W.heightAt(st.x, st.z) + 0.05, st.z, Math.atan2(side.nx, side.nz));
    for (let i = 0; i < secs * 60; i++) {
      lw.step();   // (as the page does each frame, before the controller)
      const jump = jumpAt != null && Math.abs(across(me.pos) + pick.hx + jumpAt) < 0.06 && me.grounded;
      me.update(1 / 60, { f: 1, r: 0, jump, sprint: true, crouch: false, grab: false }, lw, null, null);
    }
    return across(me.pos);
  };
  const lw = new LocalWorld(W);
  const stopped = walk(lw);
  // (a running jump from 0.9 m out)
  let jumped = -Infinity;
  for (const at of [0.7, 0.9, 1.1, 1.3]) { jumped = Math.max(jumped, walk(lw, at)); if (jumped > 1) break; }
  lw.free();
  const W0 = { ...W, statics: W.statics.filter(s => s.part !== 'fence') }, lw0 = new LocalWorld(W0);
  const through = walk(lw0);
  lw0.free();
  check(pick && stopped < -pick.hx - 0.2 && through > 2 && jumped > 1,
    `fences: walking into one stops you ${(-stopped - pick.hx).toFixed(2)} m short of it (without the fences you'd walk on ${through.toFixed(1)} m past); a running jump clears it (${jumped.toFixed(1)} m past)`);
}

// F3: the server: loot thrown at one stops, the RV drives through
{
  const room = new Room('FENCE', 777);
  room.day = 1; room.nextDay();
  const sim = room.sim, W2 = room.W;
  const b = W2.statics.find(s => s.part === 'fence' && Math.abs(s.x - pick.x) < 0.01 && Math.abs(s.z - pick.z) < 0.01);
  const a = { x: b.x - side.nx * 2, z: b.z - side.nz * 2 };
  const bag = sim.addProp('suitcase', { x: a.x, y: W2.heightAt(a.x, a.z) + 0.45, z: a.z }, { x: 0, y: 0, z: 0, w: 1 }, 50, 50);
  bag.body.setLinvel({ x: side.nx * 6, y: 1, z: side.nz * 6 }, true);
  for (let i = 0; i < 90; i++) sim.step(1 / C.SIM_HZ, room.players);
  const cr = across(bag.body.translation());
  // the RV, parked across the fence: no pushing about, its wheels on the ground (not up on the box)
  sim.placeRV(b.x, b.z, b.ry + Math.PI / 2);
  const y0 = sim.rv.translation().y;
  for (let i = 0; i < 120; i++) sim.step(1 / C.SIM_HZ, room.players);
  const rp = sim.rv.translation(), moved = Math.hypot(rp.x - b.x, rp.z - b.z);
  check(cr < -b.hx && moved < 0.3 && Math.abs(rp.y - y0) < 0.4,
    `fences: a suitcase thrown at one stops on its side (${(-cr - b.hx).toFixed(2)} m short); the RV parked across one sits there (moved ${moved.toFixed(2)} m, rose ${(rp.y - y0).toFixed(2)} m)`);
  sim.free?.();
}

if (failed) { console.error('💥 FENCE TESTS FAILED'); process.exit(1); }
console.log('All fence checks passed');
process.exit(0);
