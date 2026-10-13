// The wildlife over whole days, in process (the real Sim and Mobs, no network, fixed 1/60 s steps):
//  - every den of every day, its ringtails left alone with the stop's loot (a fake player stands 50 m out
//    so the den is awake): of what a ringtail goes for, how much it reaches, how much of that it gets
//    home, what the loot loses on the way, and that no body ever goes non-finite;
//  - every bed's grumphorn, woken by a fake player who keeps walking up to it: its charges stay by the
//    road, and once its patience is gone it walks off and lies down within a metre of its spot.
//  - with --raids instead: RV raids (day 2 on), see soakRaids.
//   node tools/mobsoak.mjs [--seeds 12] [--days 1-5] [--secs 90] [--theft] [--raids]     exit code 1 when a gate fails
// --theft also runs each day's dens guarded (the fake player at the stop, facing the loot) and prints
// thefts careless vs guarded.
// Gates: reach >= 95%, stash >= 85%, carried loss p90 <= $30, 0 non-finite, the wildlife's share of a
// step <= 0.3 ms (mean), grumphorn charges within 20 m of the road, LEAVE ends by its exit (1.2 m) and at least
// 6.5 m off the road's middle.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const imp = f => import(pathToFileURL(path.join(HERE, '..', f)).href);
const { generateLeg } = await imp('shared/world.js');
const { Sim, initPhysics } = await imp('server/sim.js');
const { RST, GST, FLAG } = { ...(await imp('shared/mobs.js')), ...(await imp('shared/constants.js')) };
const { LOOT } = await imp('shared/loot.js');
const { toWorld, RV_DIM } = await imp('shared/rv.js');
await initPhysics();

const fake = (id, x, y, z, look) => ({ id, pos: { x, y: y + 0.9, z }, eye: { x, y: y + 1.6, z }, look, ko: false, par: 0, seat: null, flags: 0, mode: 0, name: `P${id}` });
const finite = t => t && Number.isFinite(t.x + t.y + t.z);
// time spent in the wildlife's hooks (ms), and how many steps
function timed(mobs) {
  const acc = { ms: 0, n: 0 };
  for (const k of ['preStep', 'beforePhysics', 'postStep']) {
    const f = mobs[k].bind(mobs);
    mobs[k] = (...a) => { const t0 = performance.now(); const r = f(...a); acc.ms += performance.now() - t0; return r; };
  }
  return acc;
}

// the ringtails of every den on (seed, day). guarded: a fake player stands at each stop, facing its loot
export function soakDens(seed, day, { secs = 90, guarded = false } = {}) {
  const W = generateLeg(seed, day);
  const sim = new Sim(W);
  for (const g of W.gates) sim.openGate(g.id);
  const mobs = sim.ensureMobs({ day, crew: 4, seed });
  const acc = timed(mobs);
  const players = new Map();
  let pid = 1;
  for (const d of W.dens) {
    mobs.rtSpawnDen(d);
    const poi = W.pois.find(p => p.id === d.poi);
    if (guarded && poi) {
      // at the stop, facing the den side (where the loot lies between it and the den)
      const dx = d.x - poi.x, dz = d.z - poi.z, l = Math.hypot(dx, dz) || 1;
      players.set(pid, fake(pid, poi.x, W.heightAt(poi.x, poi.z), poi.z, { x: dx / l, y: 0, z: dz / l })); pid++;
    } else {
      // 50 m out past the den (away from the road and the stop's loot), facing away: the den is awake
      const ax = d.x - (poi?.x ?? W.roadX(d.z)), az = d.z - (poi?.z ?? d.z), l = Math.hypot(ax, az) || 1;
      const x = d.x + ax / l * 50, z = d.z + az / l * 50;
      players.set(pid, fake(pid, x, W.heightAt(x, z), z, { x: ax / l, y: 0, z: az / l })); pid++;
    }
  }
  const r = { dens: W.dens.length, picks: 0, steals: 0, stashes: 0, losses: [], nonFinite: 0, stepMs: 0 };
  const last = new Map(), atSteal = new Map();
  const steps = Math.round(secs * 60);
  for (let i = 0; i < steps; i++) {
    sim.step(1 / 60, players);
    for (const e of sim.out.splice(0)) {
      if (e.k !== 'mob') continue;
      if (e.s === 'steal') { r.steals++; atSteal.set(e.item, e.value); }
      if (e.s === 'stash') { r.stashes++; const it = sim.props.get(e.item); if (it && atSteal.has(e.item)) r.losses.push(atSteal.get(e.item) - it.value); }
    }
    for (const m of mobs.list.values()) {
      if (m.type !== 'ringtail') continue;
      if (last.get(m.id) === RST.DEN && m.st === RST.SNEAK) r.picks++;
      last.set(m.id, m.st);
    }
    if (i % 30 === 0) for (const id of [...mobs.list.keys(), ...mobs.carriedBy.keys()]) { const p = sim.props.get(id); if (p && !finite(p.body.translation())) r.nonFinite++; }
  }
  r.stepMs = acc.ms / steps;
  sim.free();
  return r;
}

// the grumphorns of (seed, day): a fake player keeps walking up to each (7 m in front of it); how far from
// the road its charges take it; then its patience runs out: where it ends up against its exit
export function soakBeds(seed, day, { secs = 60 } = {}) {
  const W = generateLeg(seed, day);
  const sim = new Sim(W);
  for (const g of W.gates) sim.openGate(g.id);
  const mobs = sim.ensureMobs({ day, crew: 4, seed });
  const out = [];
  for (const b of W.beds) {
    const m = mobs.spawn('grumphorn', b.x, b.z, { yaw: b.ry, st: GST.SLEEP, bed: b });
    const players = new Map();
    let off = 0, kos = 0;
    for (let i = 0; i < secs * 60; i++) {
      const p = sim.props.get(m.id), t = p.body.translation();
      // the player: 7 m up the road from it, facing it (stood back up after each toss, somewhere else)
      if (i % 120 === 0) {
        const z = t.z - 7, x = W.roadX(z) + (kos % 3 - 1) * 2;
        players.set(1, fake(1, x, W.heightAt(x, z), z, { x: 0, y: 0, z: 1 }));
      }
      sim.step(1 / 60, players);
      for (const e of sim.out.splice(0)) if (e.k === 'knock' && e.ko) kos++;
      off = Math.max(off, Math.abs(t.x - W.roadX(t.z)));
    }
    // out of patience: it leaves
    players.clear();
    const p = sim.props.get(m.id);
    mobs.ghCost(m, p, m.patience + 1);
    for (let i = 0; i < 45 * 60 && m.st !== GST.LEFT; i++) sim.step(1 / 60, players);
    const t = sim.props.get(m.id).body.translation();
    // (by the way off it walked to: its bed's, or the nearest from where it got stuck)
    const ex = m.exit || b.exit;
    out.push({ ob: b.ob, off, kos, st: m.st, fromExit: Math.hypot(t.x - ex.x, t.z - ex.z), fromRoad: Math.abs(t.x - W.roadX(t.z)), replan: !!m.exit });
  }
  sim.free();
  return out;
}

// RV raids on (seed, day >= 2): for each den, the RV parked on the road by its stop (facing up the road, then
// turned round: its door on one side, then the other), door open, three light things loose in the cabin,
// the stop's loose loot cleared away (so the den has nothing else to go for) and nobody about but a fake
// player 50 m out past the den. Of the raids started, how many get the thing home.
export function soakRaids(seed, day, { secs = 60 } = {}) {
  const W = generateLeg(seed, day);
  const out = [];
  for (const d of W.dens) for (const turn of [0, Math.PI]) {
    const sim = new Sim(W);
    for (const g of W.gates) sim.openGate(g.id);
    const mobs = sim.ensureMobs({ day, crew: 4, seed });
    mobs.rtSpawnDen(d);
    const poi = W.pois.find(p => p.id === d.poi);
    const z = poi?.z ?? d.z, x = W.roadX(z), yaw = Math.atan2(W.roadX(z + 1) - W.roadX(z - 1), 2) + turn;
    sim.placeRV(x, z, yaw);
    sim.setDrive({ th: 0, st: 0, hb: 1 });   // parked: the parking brake (the room sets it with nobody at the wheel)
    if (!sim.doorOpen) sim.setDoor(true);
    for (const p of [...sim.props.values()]) if (!p.mob && !mobs.hoard.has(p.id) && LOOT[p.type] && !LOOT[p.type].tool && Math.hypot(p.body.translation().x - d.x, p.body.translation().z - d.z) < 60) sim.removeProp(p.id);
    const types = ['vase', 'painting', 'trophy', 'lamp', 'gnome', 'toaster'];
    const rp = sim.rv.translation(), rq = sim.rv.rotation();
    for (let k = 0; k < 3; k++) {
      const t = types[(seed + day * 3 + d.id + k) % types.length];
      sim.addProp(t, toWorld(rp, rq, { x: 0.35 - k * 0.35, y: 0.5, z: -1.4 + k * 1.1 }), { x: 0, y: 0, z: 0, w: 1 }, 200, 200);
    }
    const ax = d.x - (poi?.x ?? x), az = d.z - (poi?.z ?? d.z), l = Math.hypot(ax, az) || 1;
    const fx = d.x + ax / l * 50, fz = d.z + az / l * 50;
    const players = new Map([[1, fake(1, fx, W.heightAt(fx, fz), fz, { x: ax / l, y: 0, z: az / l })]]);
    const r = { seed, day, den: d.id, turn, door: 0, starts: 0, inrv: 0, took: 0, home: 0, nonFinite: 0, losses: [] };
    const door = sim.rvToWorld({ x: -1.6, y: 0, z: RV_DIM.DOOR_Z });
    r.door = Math.hypot(door.x - d.x, door.z - d.z);
    const last = new Map(), raided = new Map();
    for (let i = 0; i < secs * 60; i++) {
      sim.step(1 / 60, players);
      for (const e of sim.out.splice(0)) {
        if (e.k !== 'mob') continue;
        if (e.s === 'steal' && e.raid && !e.again) { r.took++; raided.set(e.item, e.value); }
        if (e.s === 'stash' && raided.has(e.item)) { r.home++; r.losses.push(raided.get(e.item) - (sim.props.get(e.item)?.value ?? 0)); }
      }
      for (const m of mobs.list.values()) {
        if (m.type !== 'ringtail') continue;
        const was = last.get(m.id);
        if (was !== RST.RAID && m.st === RST.RAID) r.starts++;
        if (was !== RST.INRV && m.st === RST.INRV) r.inrv++;
        last.set(m.id, m.st);
      }
      if (i % 30 === 0) for (const id of mobs.list.keys()) { const p = sim.props.get(id); if (p && !finite(p.body.translation())) r.nonFinite++; }
    }
    sim.free();
    out.push(r);
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const seeds = Array.from({ length: Number(opt('--seeds', 12)) }, (_, i) => [4242, 7, 777][i] ?? 1000 + i * 7919);
  const [d0, d1] = String(opt('--days', '1-5')).split('-').map(Number);
  const secs = Number(opt('--secs', 90));
  const theft = args.includes('--theft');
  let failed = false;
  const gate = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed = true; };
  if (args.includes('--raids')) {
    const R = [];
    for (let day = Math.max(2, d0); day <= (d1 || d0); day++) for (const seed of seeds) {
      for (const r of soakRaids(seed, day)) {
        R.push(r);
        console.log(`seed ${seed} day ${day} den ${r.den}${r.turn ? ' (RV turned round)' : ''}: door ${r.door.toFixed(1)} m away, ${r.starts} raids, ${r.inrv} got in, ${r.took} took something, ${r.home} got it home`);
      }
    }
    const sum = k => R.reduce((a, r) => a + r[k], 0), dens = new Set(R.map(r => `${r.seed}/${r.day}/${r.den}`)), raided = new Set(R.filter(r => r.starts).map(r => `${r.seed}/${r.day}/${r.den}`));
    const ls = R.flatMap(r => r.losses).sort((a, b) => a - b), q = f => ls.length ? ls[Math.min(ls.length - 1, Math.floor(f * ls.length))] : 0;
    console.log(`\nraids: ${sum('starts')} started, ${sum('inrv')} got in, ${sum('took')} took something, ${sum('home')} got it home; what it lost on the way: median $${q(0.5).toFixed(0)}, p90 $${q(0.9).toFixed(0)}, worst $${(ls[ls.length - 1] ?? 0).toFixed(0)}`);
    gate(sum('starts') > 0 && sum('home') / sum('starts') >= 0.8, `raids completing ${(100 * sum('home') / Math.max(1, sum('starts'))).toFixed(1)}% (>= 80%)`);
    // (a den raids only when it sees the RV's door and a way home round it with the loot: not every stop)
    gate(raided.size >= dens.size * 0.5, `dens that raid the RV parked by their stop, its door one way or the other: ${raided.size} of ${dens.size} (>= half)`);
    gate(sum('nonFinite') === 0, `${sum('nonFinite')} non-finite bodies`);
    process.exit(failed ? 1 : 0);
  }
  const T = { picks: 0, steals: 0, stashes: 0, losses: [], nonFinite: 0, stepMs: [], guarded: 0, careless: 0 };
  const beds = [];
  for (let day = d0; day <= (d1 || d0); day++) {
    for (const seed of seeds) {
      const r = soakDens(seed, day, { secs });
      T.picks += r.picks; T.steals += r.steals; T.stashes += r.stashes; T.losses.push(...r.losses); T.nonFinite += r.nonFinite; T.stepMs.push(r.stepMs);
      T.careless += r.steals;
      let g = null;
      if (theft) { g = soakDens(seed, day, { secs, guarded: true }); T.guarded += g.steals; }
      beds.push(...soakBeds(seed, day).map(b => ({ ...b, seed, day })));
      console.log(`seed ${seed} day ${day}: ${r.dens} dens, ${r.picks} picks, ${r.steals} stolen, ${r.stashes} stashed${g ? `, guarded ${g.steals} stolen` : ''}, wildlife ${r.stepMs.toFixed(3)} ms/step`);
    }
  }
  const ls = T.losses.slice().sort((a, b) => a - b), q = f => ls.length ? ls[Math.min(ls.length - 1, Math.floor(f * ls.length))] : 0;
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  console.log(`\nthefts: ${T.steals} of ${T.picks} picks reached, ${T.stashes} stashed; carried loss median $${q(0.5).toFixed(0)}, p90 $${q(0.9).toFixed(0)}`);
  if (theft) console.log(`careless ${T.careless} vs guarded ${T.guarded} thefts`);
  gate(T.picks === 0 || T.steals / T.picks >= 0.95, `reach ${(100 * T.steals / Math.max(1, T.picks)).toFixed(1)}% (>= 95%)`);
  gate(T.steals === 0 || T.stashes / T.steals >= 0.85, `stash ${(100 * T.stashes / Math.max(1, T.steals)).toFixed(1)}% (>= 85%)`);
  gate(q(0.9) <= 30, `carried loss p90 $${q(0.9).toFixed(0)} (<= $30)`);
  gate(T.nonFinite === 0, `${T.nonFinite} non-finite bodies`);
  gate(mean(T.stepMs) <= 0.3, `the wildlife's share of a step ${mean(T.stepMs).toFixed(3)} ms (<= 0.3)`);
  gate(beds.every(b => b.off <= 20), `grumphorn charges stay within 20 m of the road (worst ${Math.max(0, ...beds.map(b => b.off)).toFixed(1)} m)`);
  gate(beds.every(b => b.st === GST.LEFT && b.fromExit <= 1.2 && b.fromRoad >= 6.5), `every grumphorn that ran out of patience lay down by its exit, clear of the road (worst ${Math.max(0, ...beds.map(b => b.fromExit)).toFixed(2)} m from its spot, nearest ${Math.min(99, ...beds.map(b => b.fromRoad)).toFixed(1)} m from the road's middle; ${beds.filter(b => b.replan).length} couldn't get back to its own and took the nearest; ${beds.filter(b => b.st !== GST.LEFT).length} never did)`);
  process.exit(failed ? 1 : 0);
}
