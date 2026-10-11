// Headless RV handling check: autopilot drives the generated road.
import { initPhysics, Sim } from '../server/sim.js';
import { generateLeg } from '../shared/world.js';
import { qYaw } from '../shared/rv.js';
await initPhysics();
const day = Number(process.argv[2] || 1), seed = Number(process.argv[3] || 4242);
const W = generateLeg(seed, day);
const sim = new Sim(W);
const players = new Map();
const dt = 1 / 60;
let t = 0, lastLog = -1;
const grade = W.obstacles.find(o => o.type === 'grade');
console.log('obstacles', W.obstacles.map(o => `${o.type}@${o.z}`).join(' '), 'LEN', W.LEN);
// settle
for (let i = 0; i < 120; i++) sim.step(dt, players);
let p = sim.rv.translation();
console.log('settled at', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), 'ground', W.heightAt(p.x, p.z).toFixed(2));
// open gates so we only test driving
for (const g of W.gates) sim.openGate(g.id);
let maxSpeed = 0, steerSign = null;
for (t = 0; t < 140; t += dt) {
  p = sim.rv.translation();
  const yaw = qYaw(sim.rv.rotation());
  const look = p.z + 12;
  const tx = W.roadX(look), tz = look;
  const want = Math.atan2(tx - p.x, tz - p.z);
  let err = want - yaw; while (err > Math.PI) err -= 2 * Math.PI; while (err < -Math.PI) err += 2 * Math.PI;
  const st = Math.max(-1, Math.min(1, err * 2.5));
  sim.setDrive({ th: 1, st, hb: 0 });
  sim.step(dt, players);
  const sp = sim.rvSpeed();
  maxSpeed = Math.max(maxSpeed, sp);
  if (Math.floor(t) !== lastLog && Math.floor(t) % 5 === 0) {
    lastLog = Math.floor(t);
    const up = sim.rvFlipped();
    console.log(`t=${t.toFixed(0)}s z=${p.z.toFixed(1)} x=${p.x.toFixed(1)} roadX=${W.roadX(p.z).toFixed(1)} y=${p.y.toFixed(1)} speed=${sp.toFixed(2)} mud=${sim.mudWheels} flipped=${up}`);
  }
  if (grade && p.z > grade.z1 + 3) { console.log('!! climbed the grade without the winch at t', t.toFixed(1)); break; }
}
console.log('max speed', maxSpeed.toFixed(2), 'final z', sim.rv.translation().z.toFixed(1), grade ? `grade z0=${grade.z0} z1=${grade.z1.toFixed(1)} h=${grade.h.toFixed(1)}` : '');

// ---- winch it up -----------------------------------------------------------
if (grade) {
  sim.setDrive({ th: 0, st: 0, hb: 0 });
  const rvp = sim.rv.translation();
  const fake = { id: 99, pos: { ...rvp }, eye: null, look: null };
  players.set(99, fake);
  const w = sim.winchWorld();
  fake.pos = { x: w.x, y: w.y - 0.5, z: w.z + 0.5 };
  console.log('take hook:', sim.takeHook(99, fake));
  // walk the hook up to the anchor over 6 seconds
  const anchor = W.anchors[0];
  const from = { ...fake.pos };
  for (let i = 0; i < 360; i++) {
    const f = i / 360;
    fake.pos = { x: from.x + (anchor.x - from.x) * f, y: from.y + (anchor.y - 1.2 - from.y) * f, z: from.z + (anchor.z - from.z) * f };
    sim.step(dt, players);
  }
  console.log('hook at', JSON.stringify(sim.hookPos()), 'len', sim.hook.len.toFixed(1));
  console.log('anchor:', sim.anchorHook(99, fake), 'state', sim.hook.state, 'len', sim.hook.len.toFixed(1));
  players.delete(99);
  console.log('reel:', sim.toggleReel());
  for (let t2 = 0; t2 < 40; t2 += dt) {
    sim.setDrive({ th: 0.6, st: 0, hb: 0 });
    sim.step(dt, players);
    const q = sim.rv.translation();
    if (Math.round(t2 * 60) % 120 === 0) console.log(`  winch t=${t2.toFixed(0)} z=${q.z.toFixed(1)} y=${q.y.toFixed(1)} len=${sim.hook.len.toFixed(1)} flipped=${sim.rvFlipped()}`);
    if (q.z > grade.z1 + 2) { console.log('  ✅ winched over the top at', t2.toFixed(1), 's'); break; }
  }
}
