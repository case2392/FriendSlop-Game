// The server's physics world for one day's leg (Rapier 3D).
//
// The server owns everything that's shared: the RV, the loot, the boulders,
// the winch cable, the gates. Players own their own bodies (client-side
// controllers, no input lag) — on the server a player is just a reported pose
// that can GRAB things (spring forces from their hand), PUSH things (force
// intents from their client's collisions), and get RUN OVER (we check the
// RV's sweep against their pose and tell their client to go flying).

import RAPIER from '@dimforge/rapier3d-compat';
import * as C from '../shared/constants.js';
import { LOOT } from '../shared/loot.js';
import {
  RV_PARTS, RV_WHEELS, WHEEL_R, SUSP_REST, RV_WINCH, RV_DIM, RV_MAP_SPOT, RV_HULL,
  toWorld, toLocal, insideRV, qRotate, qConj, hitZone,
} from '../shared/rv.js';
import { inMud } from '../shared/world.js';
import { Mobs } from './mobs.js';
import { GST } from '../shared/mobs.js';

let ready = null;
// a full snapshot resends at most this many things lying still (the rest in the next ones, in turn)
const FULL_SHARE = 32;
export function initPhysics() { return (ready ||= RAPIER.init()); }

import { GROUPS, looseGroup } from './groups.js';
import { partMods } from '../shared/garage.js';

// stuff people bump into but a 3-ton RV flattens
const FLIMSY = new Set(['cactus', 'haybale', 'deadtree_decor', 'cairn']);

const yawQ = ry => ({ x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) });
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
// a number from a client: finite and within +-lim, or 0 (JSON can carry 1e999 = Infinity, which would
// turn a body's velocity into NaN and freeze it for good)
const num = (v, lim) => { const x = +v; return Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : 0; };
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const len = a => Math.hypot(a.x, a.y, a.z);
const r3 = n => Math.round(n * 1000) / 1000;
// what a crash into the world's parts is called (the toast: "Sam put the RV into the ranger gate")
const CYL_NAMES = { tree: 'a tree', deadtree: 'a dead tree', deadtree_decor: 'a dead tree', rock: 'a rock', post: 'a post', cactus: 'a cactus', haybale: 'a hay bale', cairn: 'a cairn', windmill: 'the windmill' };
function staticName(s) {
  if (s.part === 'fence') return 'a fence';
  if (s.part === 'rim_slab') return 'the canyon wall';
  if (s.part === 'parked_rv') return 'a parked RV';
  if (s.part === 'keypad_post') return 'the keypad post';
  if (s.part === 'log_seat') return 'the campfire logs';
  if (s.poiType === 'junk') return 'the junk heap';
  if (s.poiType === 'crash') return 'the wreck';
  if (s.poiType === 'yard') return 'the yard sale';
  if (s.poiType === 'gas') return 'the gas station';
  if (s.poiType === 'semi') return 'the wrecked semi';
  if (s.poiType === 'dino') return 'the dinosaur';
  if (s.town === 'pawn') return "Ed's pawn shop";
  if (s.town === 'store') return 'the general store';
  if (s.town === 'casino') return 'the casino';
  if (s.town === 'gus') return "Gus's bench";
  if (s.mat === 'invisible') return 'the edge of the world';
  return 'a building';
}
const r4 = n => Math.round(n * 10000) / 10000;

function shapeDesc(shape) {
  const [k, a, b, c] = shape;
  if (k === 'box') return RAPIER.ColliderDesc.cuboid(a, b, c);
  if (k === 'cyl') return RAPIER.ColliderDesc.cylinder(a, b);
  if (k === 'cap') return RAPIER.ColliderDesc.capsule(a, b).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });   // lying along z
  return RAPIER.ColliderDesc.ball(a);
}
export function shapeVolume(shape) {
  const [k, a, b, c] = shape;
  return k === 'box' ? 8 * a * b * c : k === 'cyl' ? Math.PI * b ** 2 * 2 * a
    : k === 'cap' ? Math.PI * b * b * 2 * a + 4 / 3 * Math.PI * b ** 3 : 4 / 3 * Math.PI * a ** 3;
}

// a loot type's smallest half-size: how close to a wall its middle can be while it lies against it
const HALF_MIN = {};
const HALF_MAX = {};
const halfMax = t => HALF_MAX[t] ??= (s => s[0] === 'box' ? Math.max(s[1], s[2], s[3]) : s[0] === 'cyl' ? Math.max(s[1], s[2]) : s[0] === 'cap' ? s[1] + s[2] : s[1])(LOOT[t]?.shape || ['ball', 0.2]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const BUMPER_KG = RV_PARTS.find(r => r[0] === 'bumperF')[7].mass;    // (the Bull Bar's iron goes on it)
const WHEELBASE = RV_WHEELS[0][2] - RV_WHEELS[2][2];                   // 5.25 m
const halfMin = t => HALF_MIN[t] ??= (s => s[0] === 'box' ? Math.min(s[1], s[2], s[3]) : s[0] === 'cyl' ? Math.min(s[1], s[2]) : s[0] === 'cap' ? s[2] : s[1])(LOOT[t]?.shape || ['ball', 0.2]);

export class Sim {
  // carry: [{type, value, max, lx,ly,lz, q}] — loot that rode over from yesterday; finds: the day's Road Card
  // tins (shared/finds.js); parts: the RV parts fitted for the trip (shared/garage.js partMods)
  constructor(W, { carry = [], spawnAt = null, cond = 100, finds = [], parts = null } = {}) {
    this.W = W;
    this.world = new RAPIER.World(v3(0, -9.81, 0));
    this.world.timestep = 1 / C.SIM_HZ;
    this.eq = new RAPIER.EventQueue(true);
    this.t = 0;
    this.props = new Map();          // id -> prop
    this.byCollider = new Map();     // collider handle -> prop id
    this.nextPropId = 5000;
    this.holds = new Map();          // playerId -> hold
    this.pushes = [];
    this.out = [];                   // events for the room to broadcast
    this.drive = { th: 0, st: 0, hb: 0 };
    this.steer = 0;
    this.doorOpen = false;
    this.gateCols = new Map();
    this.gatesOpen = new Set();
    this.knockCd = new Map();
    this.tied = new Map();           // prop id -> joint (bungee'd to the RV)
    this.mobs = null;                // the wildlife (server/mobs.js), from when the RV leaves camp till nightfall
    this.mobsDone = false;           // gone for the night: they don't come back the same day
    this.mobCols = new Set();        // the wildlife's collider handles (the RV's wheels drive over them, not up them)
    this.riding = new Map();         // prop id -> its RV-local pose: loot riding the RV (rideStep)
    this.calm = new Map();           // prop id -> how long it has sat still in the moving RV
    // the RV's condition, as it drives (the room keeps the number: shared/constants.js RVH), and the crash
    // being measured; nothing counts for the first moments of a day (or after a teleport)
    this.setRvCond(cond);
    this.quietUntil = C.RVH.QUIET; this.quietMax = C.RVH.QUIET_MAX;
    this.hit = null;
    this.colTag = new Map();         // collider handle -> what a crash into it is called

    this.buildTerrain();
    this.buildStatics();
    const camp = W.camp.rv;
    const sp = spawnAt || { x: camp.x, z: camp.z, yaw: camp.yaw };
    this.buildRV(sp.x, W.heightAt(sp.x, sp.z) + 1.45, sp.z, sp.yaw);
    this.assist = false;             // the driver has Steady Hands II (the room sets it each tick)
    this.setParts(parts || partMods(null));
    for (const p of W.props) this.addProp(p.type, v3(p.x, p.y, p.z), yawQ(p.ry), p.value, p.value, p.id);
    this.hook = { state: 'stowed', body: null, len: 0, reeling: false, holder: null, anchor: null, attach: null };
    // yesterday's loot, back where it was in the RV
    const rp = this.rv.translation(), rq = this.rv.rotation();
    const toTie = [];
    for (const c of carry) {
      const w = toWorld(rp, rq, v3(c.lx, c.ly + 0.04, c.lz));
      const q = mulQ(rq, c.q);
      const pr = this.addProp(c.type, w, q, c.value, c.max);
      if (pr) pr.ours = true;   // (the crew's: it rode over in the RV)
      if (c.tied && pr) toTie.push(pr);
    }
    // (bungee cords stay on overnight: what was tied down yesterday still is)
    for (const pr of toTie) this.tieProp(pr);
    this.spawnMap();
    // the day's Road Card tins, where they lie (id -> its spot: a den's are the ringtails', server/mobs.js)
    this.finds = new Map();
    for (const s of finds) {
      const pr = this.addProp(s.type, v3(s.x, s.y + LOOT[s.type].shape[2] + 0.02, s.z), yawQ(s.ry), 0, 0);
      if (pr) this.finds.set(pr.id, s);
    }
  }

  // ---- building the world --------------------------------------------------------

  buildTerrain() {
    const { nx, nz, cell, X0, Z0, heights } = this.W;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.heightfield(nz, nx, heights, v3(nx * cell, 1, nz * cell))
      .setTranslation(X0 + nx * cell / 2, 0, Z0 + nz * cell / 2)
      .setFriction(0.9).setCollisionGroups(GROUPS.world);
    this.terrain = this.world.createCollider(desc, body);
    this.colTag.set(this.terrain.handle, 'the ground');
  }

  buildStatics() {
    const W = this.W;
    this.statics = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.flimsy = new Set();   // what the RV's wheels roll through (cacti, fences)
    for (const s of W.statics) {
      const fence = s.part === 'fence';
      const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
        .setTranslation(s.x, s.y, s.z).setRotation(yawQ(s.ry)).setFriction(0.8)
        .setCollisionGroups(fence ? GROUPS.fence : GROUPS.world), this.statics);
      if (fence) this.flimsy.add(col.handle);
      this.colTag.set(col.handle, staticName(s));
    }
    for (const c of W.cyls) {
      const col = this.world.createCollider(RAPIER.ColliderDesc.cylinder(c.hh, c.r)
        .setTranslation(c.x, c.y, c.z).setCollisionGroups(FLIMSY.has(c.mat) ? GROUPS.flimsy : GROUPS.world), this.statics);
      if (FLIMSY.has(c.mat)) this.flimsy.add(col.handle);
      this.colTag.set(col.handle, CYL_NAMES[c.mat] || 'a post');
    }
    // convex rocks (the crash buttes' fallen blocks): world gen's points, the very ones the client draws
    for (const h of W.hulls || []) {
      const d = RAPIER.ColliderDesc.convexHull(h.pts);
      if (d) this.colTag.set(this.world.createCollider(d.setTranslation(h.x, h.y, h.z).setFriction(0.8).setCollisionGroups(GROUPS.world), this.statics).handle, 'a fallen rock');
    }
    for (const g of W.gates) {
      const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(g.hx, g.hy, g.hz)
        .setTranslation(g.x, g.y, g.z).setCollisionGroups(GROUPS.world), this.statics);
      this.gateCols.set(g.id, col);
      this.colTag.set(col.handle, 'the ranger gate');
    }
  }

  // the RV's parts for the trip (fitted when it leaves camp on day 1): the Bull Bar's iron on the nose (its
  // mass on the front bumper's collider), the winch's reel speed; the room reads the rest (the horn, the fix,
  // the front's knocks)
  setParts(pm) {
    this.parts = pm;
    this.rvCols.bumperF.setMass(BUMPER_KG + pm.bullKg);
  }

  buildRV(x, y, z, yaw) {
    // (it never sleeps: asleep, the vehicle controller went on adding suspension impulses to a body
    // that wasn't moving, it read ~0.6 m/s at a standstill, and 'brake before you change direction'
    // kept a parked RV parked for good)
    const bd = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(yawQ(yaw))
      .setLinearDamping(0.06).setAngularDamping(0.5).setCcdEnabled(true).setCanSleep(false);
    this.rv = this.world.createRigidBody(bd);
    this.rvCols = {};
    for (const [name, hx, hy, hz, cx, cy, cz, o] of RV_PARTS) {
      const vol = 8 * hx * hy * hz;
      const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz)
        .setDensity(o.mass ? o.mass / vol : 0).setFriction(name === 'chassis' ? 0.4 : 0.75)
        .setCollisionGroups(o.loot ? GROUPS.rvLoot : o.step ? GROUPS.rvStep : GROUPS.rv);
      const col = this.world.createCollider(cd, this.rv);
      this.rvCols[name] = col;
    }

    const v = this.world.createVehicleController(this.rv);
    v.indexUpAxis = 1;
    v.setIndexForwardAxis = 2;
    RV_WHEELS.forEach(([wx, wy, wz], i) => {
      v.addWheel(v3(wx, wy, wz), v3(0, -1, 0), v3(-1, 0, 0), SUSP_REST, WHEEL_R);
      v.setWheelSuspensionStiffness(i, 30);
      v.setWheelSuspensionCompression(i, 3.2);
      v.setWheelSuspensionRelaxation(i, 3.8);
      v.setWheelMaxSuspensionTravel(i, 0.42);
      v.setWheelMaxSuspensionForce(i, 120000);
      v.setWheelFrictionSlip(i, C.RV.FRICTION_SLIP);
      v.setWheelSideFrictionStiffness(i, 1.0);
    });
    this.vehicle = v;
  }

  addProp(type, pos, q, value, max, id = null) {
    const L = LOOT[type];
    if (!L) return null;
    id = id ?? this.nextPropId++;
    const bd = RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(q)
      .setLinearDamping(0.05).setAngularDamping(L.adamp ?? (L.mob ? 2 : 0.3)).setCcdEnabled(L.mass < 60 || !!L.mob);
    const body = this.world.createRigidBody(bd);
    const vol = shapeVolume(L.shape);
    let cd = shapeDesc(L.shape).setDensity(L.mass / vol).setRestitution(L.bounce ?? 0.1);
    if (L.mob) {
      // wildlife walks on its own legs (a velocity servo in mobs.js): no friction to fight, whatever it
      // stands on (Rapier averages the two frictions by default: 'Min' keeps it at 0). No contact-force
      // events: its hits are read from its change of speed and what it touched (mobs.js)
      cd = cd.setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setCollisionGroups(GROUPS.mob);
    } else {
      // the boulder: 1000 kg at friction 0.3 (0.6 against the ground's 0.9) slides at ~5.9 kN, more than
      // one shoving player (~4.5 kN), less than two; alone, it's the RV's bumper or the winch
      cd = cd.setFriction(type === 'boulder' ? 0.3 : 0.6).setCollisionGroups(looseGroup(type))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(L.mass * L.tough * 9.81);
    }
    const col = this.world.createCollider(cd, body);
    if (L.mob === 'ringtail') body.lockRotations(true, true);                    // it turns by setRotation
    else if (L.mob) body.setEnabledRotations(false, true, false, true);            // yaw only: it never tips
    const prop = { id, type, body, col, value, max: max ?? value, holders: new Set(), sentSleep: false, knockUntil: 0, knockG: 0 };
    this.props.set(id, prop);
    this.byCollider.set(col.handle, id);
    if (L.mob) this.mobCols.add(col.handle);
    return prop;
  }

  removeProp(id) {
    const p = this.props.get(id);
    if (!p) return;
    // (the wildlife lets go of it first: nothing may touch a body after it's freed, or this world's physics
    // is broken for the rest of the day)
    this.mobs?.onRemoved(id);
    for (const [pid, h] of this.holds) if (h.kind === 'prop' && h.id === id) this.holds.delete(pid);
    if (this.tied.has(id)) this.tied.delete(id);
    this.riding.delete(id); this.calm.delete(id);
    if (this.hook.attach && this.hook.attach.id === id) this.unhook();
    this.byCollider.delete(p.col.handle);
    this.mobCols.delete(p.col.handle);
    this.world.removeRigidBody(p.body);
    this.props.delete(id);
  }

  // ---- the wildlife (server/mobs.js) ----------------------------------------------------------------
  // the manager, made on first use (a test can spawn one critter without the day's whole cast)
  ensureMobs(opts) { return (this.mobs ||= new Mobs(this, opts)); }
  // the day's cast, once the RV leaves camp
  startMobs(opts) {
    if (this.mobsDone || this.mobs?.started) return;
    this.ensureMobs(opts).start();
  }
  // nightfall: every critter goes (one 'gone' event), and none come back today
  endMobs() {
    this.mobsDone = true;
    if (!this.mobs) return;
    this.mobs.end();
    this.mobs = null;
  }

  spawnMap() {
    // one paper map on the dash, every morning. whoever holds it navigates.
    for (const p of this.props.values()) if (p.type === 'map') return;
    const w = toWorld(this.rv.translation(), this.rv.rotation(), RV_MAP_SPOT);
    const prop = this.addProp('map', w, this.rv.rotation(), 0, 0);
    this.out.push({ k: 'spawn', p: this.describe(prop) });
  }

  // (the test lever) the map back on the dash, wherever it slid to on the drive
  mapHome() {
    const map = [...this.props.values()].find(p => p.type === 'map');
    if (!map || map.holders.size) return;
    map.body.setTranslation(toWorld(this.rv.translation(), this.rv.rotation(), RV_MAP_SPOT), true);
    map.body.setRotation(this.rv.rotation(), true);
    map.body.setLinvel(this.rv.linvel(), true);
    map.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  describe(p) {
    const t = p.body.translation(), q = p.body.rotation();
    const d = { id: p.id, type: p.type, value: Math.round(p.value), max: Math.round(p.max),
      x: r3(t.x), y: r3(t.y), z: r3(t.z), q: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)] };
    if (p.mob) d.st = p.mob.wire();
    if (p.mob?.tipSide && p.mob.st === GST.TIPPED) d.tip = p.mob.tipSide;   // (which side it lies on: a page that joins now)
    return d;
  }

  allProps() { return [...this.props.values()].map(p => this.describe(p)); }

  // ---- RV helpers ------------------------------------------------------------------

  rvPose() { return { p: this.rv.translation(), q: this.rv.rotation() }; }
  rvToWorld(l) { return toWorld(this.rv.translation(), this.rv.rotation(), l); }
  rvToLocal(w) { return toLocal(this.rv.translation(), this.rv.rotation(), w); }
  rvSpeed() {
    const lv = this.rv.linvel(), q = this.rv.rotation();
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y), n = Math.hypot(fx, fz) || 1;
    return (lv.x * fx + lv.z * fz) / n;
  }

  // give the physics world's WASM memory back (a new day builds a new Sim)
  free() {
    try { this.world.removeVehicleController(this.vehicle); } catch {}
    try { this.eq.free(); } catch {}
    try { this.world.free(); } catch {}
  }

  setDoor(open, pop = false) {
    this.doorOpen = open;
    this.rvCols.door.setEnabled(!open);
    this.rv.wakeUp();
    this.out.push({ k: 'door', open, ...(pop ? { pop: true } : {}) });   // (pop: a crash threw it open)
  }

  openGate(id) {
    const col = this.gateCols.get(id);
    if (!col || this.gatesOpen.has(id)) return false;
    this.world.removeCollider(col, true);
    this.gatesOpen.add(id);
    return true;
  }

  // Teleport the RV (night parking, morning camp). Loot inside comes along.
  // ---- the load riding along -----------------------------------------------------------------------
  // Loot at rest in the moving RV rides it: it goes where the RV goes, exactly, and touches none of it (a
  // kinematic body moving at the RV's velocity at its spot, put back on its spot after every step). The
  // physics engine copes badly with a pile of loose things in a fast, turning body: every so often its solver
  // shoved the whole RV 15-20 cm in one step, which slid the load through the cab's rail and into the dash
  // and rocked the RV up onto two wheels. A thing comes loose (a body of its own again, moving with the RV)
  // when it would slide or lift: the RV braking, swerving or leaning past 0.8 g (a worn RV, rattling, shakes it
  // loose sooner), dropping away under it, or parked; when somebody or
  // something takes hold of it or ties it down; when another thing hits it hard.
  // (before the step) the riders move at the RV's velocity where each one is
  rideVel() {
    if (!this.riding.size) return;
    const w = this.rv.angvel();
    for (const id of this.riding.keys()) {
      const p = this.props.get(id);
      if (!p) continue;
      p.body.setLinvel(this.rv.velocityAtPoint(p.body.translation()), true);
      p.body.setAngvel(w, true);
    }
  }
  ride(p, on) {
    if (on) {
      const rp = this.rv.translation(), rq = this.rv.rotation();
      this.riding.set(p.id, { l: toLocal(rp, rq, p.body.translation()), q: mulQ(conjQ(rq), p.body.rotation()) });
      p.body.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, true);
      p.body.enableCcd(false);
      p.col.setCollisionGroups(GROUPS.riding);
    } else {
      this.riding.delete(p.id);
      const v = this.rv.velocityAtPoint(p.body.translation()), w = this.rv.angvel();
      p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      p.body.enableCcd(LOOT[p.type].mass < 60);
      p.col.setCollisionGroups(looseGroup(p.type));
      p.body.setLinvel(v, true); p.body.setAngvel(w, true);
    }
    this.calm.delete(p.id);
  }
  unride(p) { if (this.riding.has(p.id)) this.ride(p, false); }
  // (after the step) what the load feels: gravity less the floor's acceleration, in the RV's frame, smoothed
  // over a tenth of a second (a pothole's jolt through the springs is no slide). struck: riders something hit
  // hard this step
  rideStep(dt, struck) {
    const rp = this.rv.translation(), rq = this.rv.rotation(), v1 = this.rv.linvel(), w1 = this.rv.angvel();
    const v0 = this.rvVprev || v1;
    this.rvVprev = { x: v1.x, y: v1.y, z: v1.z };
    const a = v3((v1.x - v0.x) / dt, (v1.y - v0.y) / dt, (v1.z - v0.z) / dt);
    const g = qRotate(qConj(rq), v3(-a.x, -9.81 - a.y, -a.z));
    const s = this.feel ||= g;
    for (const k of ['x', 'y', 'z']) s[k] += (g[k] - s[k]) * 0.15;
    // (a loaded floor holds better than a single box's friction: carpet, the pile leaning on itself; a worn RV
    // rattles it loose sooner)
    const mu = 0.8 * 0.5 / this.rvMods.rattle, sp = Math.hypot(v1.x, v1.z);
    // (parked: still for a second; a winch's crawl up a grade is no stop)
    this.stillT = sp < 0.1 && Math.hypot(w1.x, w1.y, w1.z) < 0.1 ? (this.stillT || 0) + dt : 0;
    const loose = -s.y < 2 || Math.hypot(s.x, s.z) > mu * -s.y || this.stillT > 1;
    const jaws = this.mobs?.carriedBy;
    for (const [id, k] of [...this.riding]) {
      const p = this.props.get(id);
      if (!p) { this.riding.delete(id); continue; }
      p.body.setTranslation(toWorld(rp, rq, k.l), true);
      p.body.setRotation(mulQ(rq, k.q), true);
      if (loose || struck.has(id) || p.holders.size || this.tied.has(id) || jaws?.has(id) || this.hook.attach?.id === id) this.ride(p, false);
    }
    if (loose) { this.calm.clear(); return; }
    // the rest of the load: still in the RV for a quarter of a second, it rides
    for (const p of this.props.values()) {
      if (p.max <= 0 || this.riding.has(p.id) || p.holders.size || this.tied.has(p.id) || jaws?.has(p.id) || p.body.isSleeping()) continue;
      const l = toLocal(rp, rq, p.body.translation());
      if (!insideRV(l.x, l.y, l.z, 0.05) || l.y > RV_DIM.ROOF_Y - 0.1 || l.y < 0) { this.calm.delete(p.id); continue; }
      const pv = p.body.linvel(), rv = this.rv.velocityAtPoint(p.body.translation()), pw = p.body.angvel();
      if (Math.hypot(pv.x - rv.x, pv.y - rv.y, pv.z - rv.z) > 0.15 || Math.hypot(pw.x - w1.x, pw.y - w1.y, pw.z - w1.z) > 0.4) { this.calm.delete(p.id); continue; }
      const t = (this.calm.get(p.id) || 0) + dt;
      if (t >= 0.25) this.ride(p, true); else this.calm.set(p.id, t);
    }
  }

  // The RV's walls hold its load. A thing riding inside that ends up outside without going through the open
  // door, with nobody holding it (a person or a critter's jaws) and not on the winch or a bungee, went
  // through a wall: a hard stop presses the whole pile forward, and a thin wall (the windshield's box was
  // 10 cm) lets the front of it through onto the road. It goes back to where it was last inside, moving with
  // the RV. Inside: all but a quarter of it within the walls, under the roof; out: more than half of it past
  // the hull's outer faces. Half through a wall, it's left to the physics. A thing that keeps getting out (a
  // safe on an RV lying on its side) is put back at most once a second and three times in ten seconds, then
  // left to it: shoving it back and forth into a wall kicks the RV like a crash
  keepLoad() {
    const rp = this.rv.translation(), rq = this.rv.rotation(), D = RV_DIM;
    const last = this.inLoad ||= new Map();
    let jaws = null, taken = null;
    for (const p of this.props.values()) {
      if (p.max <= 0) continue;
      const r = halfMin(p.type), l = toLocal(rp, rq, p.body.translation());
      let k = last.get(p.id);
      if (Math.abs(l.x) < D.HALF_W - 0.1 - r / 2 && Math.abs(l.z) < D.HALF_L - 0.1 - r / 2 && l.y > -0.05 && l.y < D.ROOF_Y - 0.1 - r / 2) {
        if (!k) last.set(p.id, k = { n: 0, at: -99 });
        k.l = l;
        continue;
      }
      if (!k?.l || !(Math.abs(l.x) > D.HALF_W + r / 2 || l.z > D.HALF_L + 0.15 + r / 2 || l.z < -D.HALF_L - r / 2 || l.y > D.ROOF_Y + r / 2 || l.y < -0.65 - r / 2)) continue;
      jaws ||= new Set([...(this.mobs?.jaws?.values() ?? [])].map(j => j.item));
      const gone = p.holders.size || jaws.has(p.id) || this.hook.attach?.id === p.id || this.tied.has(p.id)
        || (this.doorOpen && l.x < 0 && Math.abs(l.z - D.DOOR_Z) < D.DOOR_HALF + 0.25 && l.y < D.WALL_H)
        || (k.n >= 3 && this.t - k.at < 10);
      if (gone) { k.l = null; continue; }   // (taken out, out through the door, or given up on)
      if (this.t - k.at < 1) continue;      // (put back a moment ago: again once a second at most)
      const at = this.loadSpot(p, k.l, taken ||= []);
      if (!at) { k.at = this.t; continue; } // (nowhere free: again in a second)
      k.n = this.t - k.at < 10 ? k.n + 1 : 1; k.at = this.t;
      p.body.setTranslation(toWorld(rp, rq, at), true);
      p.body.setLinvel(this.rv.linvel(), true);
      p.body.setAngvel(v3(), true);
    }
    for (const id of last.keys()) if (!this.props.has(id)) last.delete(id);
    if (Math.round(this.t * C.SIM_HZ) % 15 === 0) this.unwedge(last, jaws, taken ||= []);
  }
  // Four times a second: loot sunk deep into the RV's own fittings (the floor, the bed, the counter: a
  // violent tumble can jam a thing in there, where no wall sees it leave) for half a second is put somewhere
  // free nearby, the same as a thing that went through a wall. Left there, the physics pushing it out of the
  // floor and the bed at once rolled the RV over on flat ground
  unwedge(last, jaws, taken) {
    const rp = this.rv.translation(), rq = this.rv.rotation(), D = RV_DIM, w = this.world;
    jaws ||= new Set([...(this.mobs?.jaws?.values() ?? [])].map(j => j.item));
    for (const p of this.props.values()) {
      if (p.max <= 0 || this.riding.has(p.id) || p.holders.size || this.tied.has(p.id) || jaws.has(p.id)) { p.wedged = 0; continue; }
      const l = toLocal(rp, rq, p.body.translation());
      if (Math.abs(l.x) > D.HALF_W || Math.abs(l.z) > D.HALF_L || l.y < -0.65 || l.y > D.ROOF_Y) { p.wedged = 0; continue; }
      let deep = 0;
      w.contactPairsWith(p.col, o => {
        if (o.parent()?.handle !== this.rv.handle) return;
        w.contactPair(p.col, o, m => { for (let i = 0; i < m.numContacts(); i++) deep = Math.min(deep, m.contactDist(i)); });
      });
      p.wedged = deep < -0.12 ? (p.wedged || 0) + 1 : 0;
      if (p.wedged < 2) continue;
      const k = last.get(p.id) || { n: 0, at: -99 };
      if (this.t - k.at < 1 || (k.n >= 3 && this.t - k.at < 10)) continue;
      const at = this.loadSpot(p, l, taken);
      if (!at) continue;
      k.n = this.t - k.at < 10 ? k.n + 1 : 1; k.at = this.t; k.l = at; last.set(p.id, k);
      p.wedged = 0;
      p.body.setTranslation(toWorld(rp, rq, at), true);
      p.body.setLinvel(this.rv.linvel(), true);
      p.body.setAngvel(v3(), true);
    }
  }
  // Where in the RV a thing that went through a wall goes back (RV-local), or null: a spot clear of the hull by
  // its own size where it touches nothing at all (the RV's insides, the rest of the load, the crew). Where it
  // was last inside first, else the nearest free spot over the floor or up on something. (Put back without
  // looking, a safe last seen half sunk into the floor, or into the counter, went back there: the physics
  // threw it out of the floor and rolled the RV over with it.) `taken`: spots handed out this step
  loadSpot(p, l, taken) {
    const rp = this.rv.translation(), rq = this.rv.rotation(), D = RV_DIM, R = halfMax(p.type);
    const fit = (x, y, z) => ({ x: clamp(x, -D.HALF_W + 0.1 + R, D.HALF_W - 0.1 - R), y: clamp(y, R + 0.02, D.ROOF_Y - 0.1 - R), z: clamp(z, -D.HALF_L + 0.1 + R, D.HALF_L - 0.1 - R) });
    const near = [];
    for (let y = R + 0.02; y < D.ROOF_Y - 0.1 - R; y += 0.6) for (let x = -0.8; x < 0.81; x += 0.4) for (let z = -3.4; z < 3.41; z += 0.4) near.push(fit(x, y, z));
    near.sort((a, b) => Math.hypot(a.x - l.x, a.y - l.y, a.z - l.z) - Math.hypot(b.x - l.x, b.y - l.y, b.z - l.z));
    const rot = p.col.rotation(), shape = p.col.shape;
    for (const c of [fit(l.x, l.y, l.z), ...near]) {
      if (taken.some(t => Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z) < t.R + R)) continue;
      let hit = false;
      this.world.intersectionsWithShape(toWorld(rp, rq, c), rot, shape, () => (hit = true, false), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.loot, undefined, p.body);
      if (!hit) { taken.push({ ...c, R }); return c; }
    }
    return null;
  }

  placeRV(x, z, yaw) {
    // (a teleport is no crash: nothing counts till it has settled where it was put)
    this.quietUntil = this.t + C.RVH.QUIET; this.quietMax = this.t + C.RVH.QUIET_MAX;
    this.hit = null;
    const rp = this.rv.translation(), rq = this.rv.rotation();
    const riders = [];
    for (const p of this.props.values()) {
      const l = toLocal(rp, rq, p.body.translation());
      if (insideRV(l.x, l.y, l.z, 0.1)) riders.push({ p, l, q: mulQ(conjQ(rq), p.body.rotation()) });
    }
    const q = yawQ(yaw);
    const pos = v3(x, this.W.heightAt(x, z) + 1.45, z);
    this.rv.setTranslation(pos, true);
    this.rv.setRotation(q, true);
    this.rv.setLinvel(v3(), true);
    this.rv.setAngvel(v3(), true);
    for (const r of riders) {
      r.p.body.setTranslation(toWorld(pos, q, r.l), true);
      r.p.body.setRotation(mulQ(q, r.q), true);
      r.p.body.setLinvel(v3(), true);
      r.p.body.setAngvel(v3(), true);
    }
    if (this.hook.state !== 'stowed') this.stowHook();
  }

  // The ids of the loot in the RV right now (not on the roof)
  cargo() {
    const rp = this.rv.translation(), rq = this.rv.rotation(), ids = [];
    for (const p of this.props.values()) {
      if (p.type === 'map' || p.type === 'boulder' || p.max <= 0) continue;
      const l = toLocal(rp, rq, p.body.translation());
      if (insideRV(l.x, l.y, l.z, 0.05) && l.y < RV_DIM.ROOF_Y - 0.1) ids.push(p.id);
    }
    return ids;
  }

  // Loot that's in the RV right now, in RV-local coordinates (rides into tomorrow).
  carryOver() {
    const rp = this.rv.translation(), rq = this.rv.rotation();
    const list = [];
    for (const p of this.props.values()) {
      if (p.type === 'map' || p.type === 'boulder' || LOOT[p.type].mob) continue;
      const l = toLocal(rp, rq, p.body.translation());
      if (!insideRV(l.x, l.y, l.z, 0.05) || l.y > RV_DIM.ROOF_Y - 0.1) continue;
      list.push({ type: p.type, value: p.value, max: p.max, lx: l.x, ly: l.y, lz: l.z, q: mulQ(conjQ(rq), p.body.rotation()), tied: this.tied.has(p.id) });
    }
    return list;
  }

  // ---- intents from players ------------------------------------------------------------

  // players: Map(id -> player) with .eye {x,y,z} and .look {x,y,z} in world space
  grab(pid, pl, m) {
    if (!pl?.eye) return false;
    this.release(pid);
    const pt = v3(num(m.pt?.[0], 1e5), num(m.pt?.[1], 1e5), num(m.pt?.[2], 1e5));
    if (len(sub(pt, pl.eye)) > C.PLAYER.REACH + 0.8) return false;
    const dist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, num(m.d, 100) || C.GRAB.HOLD_DEFAULT));
    if (m.kind === 'prop') {
      const p = this.props.get(Number(m.id));
      if (!p) return false;
      if (this.tied.has(p.id)) { this.world.removeImpulseJoint(this.tied.get(p.id), true); this.tied.delete(p.id); }
      this.unride(p);
      const local = toLocal(p.body.translation(), p.body.rotation(), pt);
      // clamp the grab point onto the object (hands, not telekinesis)
      local.x = Math.max(-1.2, Math.min(1.2, local.x));
      local.y = Math.max(-1.2, Math.min(1.2, local.y));
      local.z = Math.max(-1.2, Math.min(1.2, local.z));
      p.holders.add(pid);
      p.lastBy = pid;   // (who set it down: a tin's finder)
      if (!p.mob) p.ours = true;   // (in the crew's hands once: theirs, so a ringtail taking it is a theft)
      p.body.setAngularDamping(3.5);
      p.body.wakeUp();
      this.holds.set(pid, { kind: 'prop', id: p.id, local, dist, last: null });
      this.mobs?.onGrabbed(p, pid);
      return true;
    }
    if (m.kind === 'rv') {
      const local = this.rvToLocal(pt);
      this.holds.set(pid, { kind: 'rv', local, dist: Math.max(1.0, len(sub(pt, pl.eye))), last: null });
      return true;
    }
    if (m.kind === 'hook') {
      return this.takeHook(pid, pl);
    }
    return false;
  }

  // Loading the RV. A prop held at its open door, outside and low, is helped in the way people get a thing
  // through a door without thinking: lifted over the sill (the floor is a metre up; the hand's spring alone
  // rams it into the floor's edge or the steps) and, if it's long, turned end-on to the doorway (1.3 m).
  // Heavy loot still needs two pairs of hands to get that high. atDoor: the prop's RV-local middle, or null.
  atDoor(p) {
    if (!this.doorOpen) return null;
    const l = this.rvToLocal(p.body.translation());
    if (l.x < -3.4 || l.x > -0.95 || Math.abs(l.z - RV_DIM.DOOR_Z) > RV_DIM.DOOR_HALF + 0.6 || l.y < -2.4 || l.y > 1.2) return null;
    return l;
  }

  // the prop's axes in the RV's frame
  axesInRV(p) {
    const rq = this.rv.rotation(), iq = { x: -rq.x, y: -rq.y, z: -rq.z, w: rq.w }, pq = p.body.rotation();
    return [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)].map(v => qRotate(iq, qRotate(pq, v)));
  }

  // how far to raise the hold point so that, with it where the hand wants it, the prop's lowest point
  // clears the floor
  sillLift(p, l, gp, target) {
    const [kind, a, b, c] = LOOT[p.type].shape, ax = this.axesInRV(p);
    const down = kind === 'box' ? Math.abs(ax[0].y) * a + Math.abs(ax[1].y) * b + Math.abs(ax[2].y) * c
      : kind === 'cyl' ? Math.abs(ax[1].y) * a + b * Math.sqrt(Math.max(0, 1 - ax[1].y ** 2)) : a;
    const bottom = l.y - down + this.rvToLocal(target).y - this.rvToLocal(gp).y;
    return Math.max(0, Math.min(1.6, 0.08 - bottom));
  }

  // and turned to fit: stood up the way it's built to stand and, if it's long, turned end-on to the
  // doorway (the way people get a sofa through a door). Torques in the RV's frame; held props spin against
  // an angular damping of 3.5/s, so this settles at a few radians a second per radian off.
  turnToDoor(p, dt) {
    const L = LOOT[p.type], [kind, a, b, c] = L.shape;
    if (kind !== 'box' || L.tool || Math.max(a, b, c) < RV_DIM.DOOR_HALF - 0.15) return;
    const ax = this.axesInRV(p), I = p.body.mass() * (a * a + b * b + c * c) * 2 / 9, K = 12 * I;
    const up = ax[1], tilt = Math.acos(Math.max(-1, Math.min(1, up.y))), sx = -up.z, sz = up.x, sn = Math.hypot(sx, sz);
    const tq = sn > 1e-4 ? v3(sx / sn * K * tilt, 0, sz / sn * K * tilt) : v3(up.y < 0 ? K * Math.PI : 0, 0, 0);
    // the longest axis lying flat, if it's longer than the doorway is wide: its angle off the RV's x,
    // either end first (a positive turn about up takes +x toward -z)
    let best = null, ext = RV_DIM.DOOR_HALF - 0.08;
    [a, b, c].forEach((h, i) => { if (h > ext && Math.abs(ax[i].y) < 0.7) { ext = h; best = ax[i]; } });
    if (best) {
      let th = Math.atan2(best.z, best.x);
      if (th > Math.PI / 2) th -= Math.PI; else if (th < -Math.PI / 2) th += Math.PI;
      tq.y = K * th;
    }
    p.body.applyTorqueImpulse(mul(qRotate(this.rv.rotation(), tq), dt), true);
  }

  holdDist(pid, d) {
    const h = this.holds.get(pid);
    if (h) h.dist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, num(d, 100) || h.dist));
  }

  release(pid, throwDir = null, pl = null) {
    const h = this.holds.get(pid);
    if (!h) return;
    this.holds.delete(pid);
    if (h.kind !== 'prop') return;
    const p = this.props.get(h.id);
    if (!p) return;
    p.holders.delete(pid);
    if (p.holders.size === 0) p.body.setAngularDamping(LOOT[p.type].adamp ?? (LOOT[p.type].mob ? 2 : 0.3));
    if (throwDir) {
      const m = p.body.mass();
      const imp = Math.min(m * C.GRAB.THROW, C.GRAB.THROW_IMPULSE_CAP);
      const d = v3(num(throwDir[0], 100), num(throwDir[1], 100), num(throwDir[2], 100));
      const n = len(d) || 1;
      p.body.applyImpulse(mul(d, imp / n), true);
      if (pl?.vel) p.body.applyImpulse(mul(pl.vel, m * 0.6), true);
      p.thrownBy = pid; p.thrownAt = this.t; p.beaned = false;
      this.out.push({ k: 'throw', id: p.id, by: pid });
    }
    this.mobs?.onReleased(p, pid, !!throwDir);
  }

  // A body pushing into the RV or a prop. The contact point comes from the client, so it has to be where
  // the pusher actually is and on the thing pushed: a point far off would give the force a huge lever arm
  // (rolling the RV over from across the map, and billing the crew for the tow).
  push(pid, m, pl = null) {
    const pt = v3(num(m.pt?.[0], 1e5), num(m.pt?.[1], 1e5), num(m.pt?.[2], 1e5));
    const d = v3(num(m.dir?.[0], 100), 0, num(m.dir?.[2], 100));
    const n = len(d);
    if (n < 0.1) return;
    if (!pl?.pos || len(sub(pt, v3(pl.pos.x, pl.pos.y + 0.9, pl.pos.z))) > 2) return;
    if (m.kind === 'rv') {
      if (len(sub(pt, this.rv.translation())) > 7) return;
      this.pushes.push({ id: null, pt, f: mul(d, C.PUSH_FORCE_RV / n), until: this.t + 0.16 });
    } else if (m.kind === 'prop') {
      const p = this.props.get(Number(m.id));
      if (!p || len(sub(pt, p.body.translation())) > 3) return;
      const f = p.type === 'boulder' ? C.PUSH_FORCE_RV : C.PUSH_FORCE_PROP;
      this.pushes.push({ id: p.id, pt, f: mul(d, f / n), until: this.t + 0.16 });
      if (p.mob) this.mobs?.onPushed(p, pid);
    }
  }

  // The shove (right mouse with empty hands): what's in a cone in front of the shover, nearest first, at most
  // SHOVE.MAX of them, and nothing behind a wall (a ray against the world and the RV). A friend on foot gets a
  // knock (never a KO by itself), a friend riding the RV the same knock on top of the RV's motion (rel: their
  // page adds the RV's velocity), loot a push; wildlife answers in mobs.js. Never the RV, the boulder, the map,
  // anything bungee'd down, or a friend who is down or seated. Returns how many things it hit.
  shove(pl, players) {
    if (!pl?.eye || !pl.look || this.holds.has(pl.id)) return 0;
    const S = C.SHOVE, e = pl.eye, hl = Math.hypot(pl.look.x, pl.look.z);
    if (hl < 1e-3) return 0;
    const fx = pl.look.x / hl, fz = pl.look.z / hl, cosA = Math.cos(S.HALF_DEG * Math.PI / 180);
    const cands = [];
    const consider = (kind, ref, pt) => {
      const dx = pt.x - e.x, dz = pt.z - e.z, d = Math.hypot(dx, dz);
      if (d > S.REACH || Math.abs(pt.y - e.y) > S.DY) return;
      if (d > 0.3 && (dx * fx + dz * fz) / d < cosA) return;
      cands.push({ kind, ref, pt, d });
    };
    for (const q of players.values()) {
      if (q.id === pl.id || !q.pos || q.ko || q.seat != null) continue;
      consider('player', q, v3(q.pos.x, q.pos.y + 0.9, q.pos.z));
    }
    for (const p of this.props.values()) {
      const L = LOOT[p.type];
      if (!L || this.tied.has(p.id) || (L.tool && !L.mob)) continue;
      // (to the nearest point of it: a grumphorn's flank is a metre and a half nearer than its middle)
      const pr = p.col.projectPoint(e, true);
      consider('prop', p, pr ? v3(pr.point.x, pr.point.y, pr.point.z) : p.body.translation());
    }
    cands.sort((a, b) => a.d - b.d);
    let hit = 0;
    for (const c of cands) {
      if (hit >= S.MAX) break;
      if (!this.clearLine(e, c.pt)) continue;
      hit++;
      if (c.kind === 'player') {
        const q = c.ref;
        this.out.push({ k: 'knock', id: q.id, v: [r3(fx * S.FRIEND), S.FRIEND_UP, r3(fz * S.FRIEND)], ko: false, why: 'shove', by: pl.id, rel: q.par ? 1 : 0 });
      } else if (LOOT[c.ref.type].mob) {
        this.mobs?.onShoved(c.ref, pl, fx, fz);
      } else {
        const p = c.ref, J = Math.min(S.PROP_J, S.PROP_PER_KG * p.body.mass()), n = Math.hypot(1, 0.3);
        p.body.applyImpulse(v3(fx * J / n, 0.3 * J / n, fz * J / n), true);
      }
    }
    this.out.push({ k: 'shove', by: pl.id, at: [r3(e.x), r3(e.y), r3(e.z)], hit });
    return hit;
  }

  // nothing of the world or the RV between a and b (props and people don't count)
  clearLine(a, b) {
    const d = sub(b, a), L = len(d);
    if (L < 0.3) return true;
    return !this.world.castRay(new RAPIER.Ray(a, mul(d, 1 / L)), L - 0.25, true, undefined, GROUPS.solid);
  }

  setDrive(m) {
    this.drive.th = num(m.th, 1);
    this.drive.st = num(m.st, 1);
    this.drive.hb = m.hb ? 1 : 0;
    if (Math.abs(this.drive.th) > 0.05 || Math.abs(this.drive.st) > 0.05) this.rv.wakeUp();
  }

  // ---- the winch -------------------------------------------------------------------------

  winchWorld() { return this.rvToWorld(RV_WINCH); }

  takeHook(pid, pl) {
    const H = this.hook;
    if (H.state === 'anchored') return false;
    if (H.state === 'stowed') {
      const w = this.winchWorld();
      if (len(sub(w, pl.pos)) > C.PLAYER.REACH + 1.2) return false;
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(w.x, w.y, w.z + 0).setLinearDamping(0.4).setCcdEnabled(true));
      this.world.createCollider(RAPIER.ColliderDesc.ball(0.13).setDensity(3000).setCollisionGroups(GROUPS.hook), body);
      H.body = body;
      H.state = 'out';
      H.len = 1.5;
    } else if (len(sub(H.body.translation(), pl.pos)) > C.PLAYER.REACH + 0.8) {
      return false;
    }
    H.reeling = false;
    H.holder = pid;
    this.out.push({ k: 'hook', what: 'taken', by: pid });
    return true;
  }

  dropHook(pid) {
    if (this.hook.holder === pid) this.hook.holder = null;
  }

  // Clip the hook onto the nearest anchor post / dead tree, or onto a boulder.
  anchorHook(pid, pl) {
    const H = this.hook;
    if (H.state !== 'out' || H.holder !== pid) return false;
    const hp = H.body.translation();
    let best = null, bd = C.WINCH.ANCHOR_REACH + 0.8;
    for (const a of this.W.anchors) {
      const d = Math.min(len(sub(a, hp)), len(sub(a, pl.pos)) - 0.4);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) {
      this.world.removeRigidBody(H.body);
      H.body = null;
      H.state = 'anchored';
      H.anchor = v3(best.x, best.y, best.z);
      H.attach = null;
      H.holder = null;
      H.len = Math.min(C.WINCH.MAX_LEN, len(sub(H.anchor, this.winchWorld())) + 0.2);
      this.out.push({ k: 'hook', what: 'anchored', by: pid });
      return true;
    }
    // any prop heavy enough to be worth winching (the boulder, a safe...)
    for (const p of this.props.values()) {
      if (p.body.mass() < 60) continue;
      if (len(sub(p.body.translation(), hp)) < (p.type === 'boulder' ? 2.6 : p.mob ? 2.2 : 1.4)) {
        this.world.removeRigidBody(H.body);
        H.body = null;
        H.state = 'anchored';
        H.anchor = null;
        H.attach = { id: p.id, local: toLocal(p.body.translation(), p.body.rotation(), hp) };
        H.holder = null;
        H.len = Math.min(C.WINCH.MAX_LEN, len(sub(hp, this.winchWorld())) + 0.2);
        this.out.push({ k: 'hook', what: 'anchored', by: pid, prop: p.id });
        return true;
      }
    }
    return false;
  }

  unhook() {
    const H = this.hook;
    if (H.state !== 'anchored') return;
    const at = this.hookPos();
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(at.x, at.y, at.z).setLinearDamping(0.4).setCcdEnabled(true));
    this.world.createCollider(RAPIER.ColliderDesc.ball(0.13).setDensity(3000).setCollisionGroups(GROUPS.hook), body);
    H.body = body;
    H.state = 'out';
    H.anchor = null;
    H.attach = null;
    H.holder = null;
    this.out.push({ k: 'hook', what: 'unhooked' });
  }

  stowHook() {
    const H = this.hook;
    if (H.body) this.world.removeRigidBody(H.body);
    Object.assign(H, { state: 'stowed', body: null, len: 0, reeling: false, holder: null, anchor: null, attach: null });
    this.out.push({ k: 'hook', what: 'stowed' });
  }

  toggleReel() {
    const H = this.hook;
    if (H.state === 'stowed') return false;
    H.reeling = !H.reeling;
    if (H.reeling && H.holder != null) H.holder = null;   // the winch rips it out of your hands
    this.out.push({ k: 'reel', on: H.reeling });
    return true;
  }

  hookPos() {
    const H = this.hook;
    if (H.state === 'stowed') return this.winchWorld();
    if (H.anchor) return H.anchor;
    if (H.attach) {
      const p = this.props.get(H.attach.id);
      if (!p) return this.winchWorld();
      return toWorld(p.body.translation(), p.body.rotation(), H.attach.local);
    }
    return H.body.translation();
  }

  stepWinch(dt, players) {
    const H = this.hook;
    if (H.state === 'stowed') return;
    const wp = this.winchWorld();
    const hp = this.hookPos();
    const delta = sub(hp, wp);
    const d = len(delta) || 1e-4;
    const dir = mul(delta, 1 / d);

    // (up to the motor's rated pull: against a load it can't move it stalls there, the cable FORCE / STIFF m
    // stretched. It used to wind on regardless, storing metres of stretch, and flung the RV up a grade when it
    // broke free; the drum's speed limit below keeps even a full stretch from doing that)
    if (H.reeling && d - H.len < C.WINCH.FORCE / C.WINCH.STIFF) {
      H.len = Math.max(0.6, H.len - this.parts.reel * dt);
    }
    // carried hook: the spool pays out freely
    if (H.state === 'out' && H.holder != null) {
      const pl = players.get(H.holder);
      if (!pl || !pl.pos || pl.ko) { H.holder = null; }
      else {
        const belt = v3(pl.pos.x, pl.pos.y + 0.95, pl.pos.z);
        const toBelt = sub(belt, hp);
        const vel = H.body.linvel();
        const k = 260, c = 24, m = H.body.mass();
        H.body.applyImpulse(mul(sub(mul(toBelt, k), mul(vel, c)), m * dt), true);
        if (d > H.len) H.len = Math.min(C.WINCH.MAX_LEN, d);
        if (d > C.WINCH.MAX_LEN + 1.5) { H.holder = null; this.out.push({ k: 'hook', what: 'yanked', by: pl.id }); }
      }
    }
    // a hook flopping loose gets reeled home
    if (H.state === 'out' && H.holder == null && H.reeling && d < 1.3) { this.stowHook(); return; }

    if (d <= H.len) return;
    const rvVel = this.rv.velocityAtPoint(wp);
    let otherVel = v3();
    let otherBody = null;
    if (H.state === 'out') { otherBody = H.body; otherVel = H.body.linvel(); }
    else if (H.attach) { const p = this.props.get(H.attach.id); if (p) { otherBody = p.body; otherVel = p.body.velocityAtPoint(hp); } }
    const sep = (otherVel.x - rvVel.x) * dir.x + (otherVel.y - rvVel.y) * dir.y + (otherVel.z - rvVel.z) * dir.z;
    let T = C.WINCH.STIFF * (d - H.len) + C.WINCH.DAMP * Math.max(0, sep);
    T = Math.min(T, C.WINCH.FORCE);
    // the drum winds no faster than its reel speed (faster with a Winch Motor fitted): a load already coming
    // faster than that (the RV breaking free of a snag, a loose hook flying home) pulls the cable along no
    // harder, so the pull fades out over OVERRUN m/s past it, and the RV comes up a grade at about the drum's
    // speed, never flung. Hauled at an angle (a post off to the side of the road) it runs on along its wheels faster than the cable shortens:
    // that's no reason to pull harder either (it came over the crest at a run and into the far post). Pulled
    // away from it, the cable holds as hard as ever
    let fast = -sep;
    if (H.state === 'anchored' && sep <= 0) { const v = this.rv.linvel(); fast = Math.max(fast, Math.hypot(v.x, v.y, v.z)); }
    if (fast > this.parts.reel) T *= Math.max(0, 1 - (fast - this.parts.reel) / C.WINCH.OVERRUN);
    if (H.state === 'out' && H.holder == null) {
      // loose hook: just drag it in, the RV doesn't care about a 9 kg hook
      H.body.applyImpulse(mul(dir, -Math.min(T, 900) * dt), true);
      return;
    }
    if (H.state === 'out') return;   // someone's holding it: their belt fights the spool, not the RV
    this.rv.applyImpulseAtPoint(mul(dir, T * dt), wp, true);
    if (otherBody) otherBody.applyImpulseAtPoint(mul(dir, -T * dt), hp, true);
    if (T > 3000 && Math.random() < dt * 4) this.out.push({ k: 'creak' });
  }

  // ---- bungee cords: everything in the RV gets tied down until someone grabs it ---------

  tieDown() {
    let n = 0;
    for (const p of this.props.values()) if (this.tieProp(p)) n++;
    return n;
  }
  tieProp(p) {
    if (this.tied.has(p.id) || p.type === 'map' || p.type === 'boulder' || LOOT[p.type].mob) return false;
    const rp = this.rv.translation(), rq = this.rv.rotation();
    const l = toLocal(rp, rq, p.body.translation());
    if (!insideRV(l.x, l.y, l.z, 0.05) || l.y > RV_DIM.ROOF_Y - 0.1) return false;
    this.unride(p);
    const rel = mulQ(conjQ(rq), p.body.rotation());
    const j = this.world.createImpulseJoint(
      RAPIER.JointData.fixed(l, rel, v3(), { x: 0, y: 0, z: 0, w: 1 }), this.rv, p.body, true);
    this.tied.set(p.id, j);
    return true;
  }

  // ---- the step -------------------------------------------------------------------------

  step(dt, players) {
    this.t += dt;
    const W = this.W;

    // driving
    const v = this.vehicle;
    const sp = this.rvSpeed();
    const { th, st, hb } = this.drive;
    let engine = 0, brake = 0.6;
    // (a worn RV is down on power where it shows, at speed: its top end; crawling up a crest or out of the mud
    // it pulls as hard as ever)
    const top = C.RV.TOP_SPEED * this.rvMods.top;
    if (th > 0.05) {
      if (sp < -0.6) brake = C.RV.BRAKE;   // still rolling backwards: brake first
      else { engine = th * C.RV.ENGINE * (1 - Math.max(0, Math.min(1, sp / top)) ** 2); brake = 0; }
    } else if (th < -0.05) {
      if (sp > 0.6) { brake = C.RV.BRAKE; }
      else { engine = th * C.RV.REVERSE * (1 - Math.max(0, Math.min(1, -sp / 6))); brake = 0; }
    }
    // broken down, or stalled, the engine gives nothing: it coasts, and S (no reverse gear to find) holds it on
    // the brakes
    if (this.rvMods.dead || this.t < this.rvMods.stallUntil) { engine = 0; if (brake !== C.RV.BRAKE) brake = th < -0.05 ? C.RV.BRAKE : 0.6; }
    if (hb) { brake = C.RV.BRAKE * 1.6; engine = 0; }
    let steerTarget = st * C.RV.STEER_MAX * (1 - 0.5 * Math.min(1, Math.abs(sp) / C.RV.TOP_SPEED));
    // Steady Hands II at the wheel: stability control. At speed, no more lock than gives 0.8 g sideways on flat
    // ground (a = v^2 tan(lock) / wheelbase); and since a sudden full lock overshoots that as the RV turns in
    // (0.95 g at 13 m/s, measured), the wheel also backs off while the RV turns faster than 0.85 of what 0.8 g
    // allows. It only ever takes lock away (test/rv.mjs K7: 0.71 g at most at 13 m/s, stock 1.07)
    if (this.assist && Math.abs(sp) > 1) {
      const lim = Math.atan(0.8 * 9.81 * WHEELBASE / (sp * sp));
      steerTarget = clamp(steerTarget, -lim, lim);
      const r = this.rv.angvel().y, over = sp > 3 ? Math.abs(r) / (0.8 * 9.81 / sp) - 0.85 : 0;
      if (over > 0 && Math.sign(r) === Math.sign(steerTarget)) steerTarget *= Math.max(0, 1 - over * 8);
    }
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 5);
    let mudWheels = 0;
    RV_WHEELS.forEach(([, , , steer, drive], i) => {
      v.setWheelEngineForce(i, drive ? engine : 0);
      v.setWheelBrake(i, brake);
      if (steer) v.setWheelSteering(i, this.steer);
      const cp = v.wheelIsInContact(i) ? v.wheelContactPoint(i) : null;
      const mud = cp && inMud(W, cp.x, cp.z);
      if (mud) mudWheels++;
      v.setWheelFrictionSlip(i, mud ? C.RV.MUD_SLIP : C.RV.FRICTION_SLIP);
    });
    // mud sucks at the RV
    if (mudWheels) {
      const lv = this.rv.linvel();
      const hs = Math.hypot(lv.x, lv.z);
      const k = C.RV.MUD_DRAG * (mudWheels / 4) * Math.min(1, hs / 0.6);
      if (hs > 1e-3) this.rv.applyImpulse(v3(-lv.x / hs * k * dt, 0, -lv.z / hs * k * dt), true);
    }
    this.mudWheels = mudWheels;

    // hands on things
    const turned = new Set();
    for (const [pid, h] of this.holds) {
      const pl = players.get(pid);
      if (!pl || !pl.eye || pl.ko) { this.release(pid); continue; }
      const target = add(pl.eye, mul(pl.look, h.dist));
      const tv = h.last ? mul(sub(target, h.last), 1 / dt) : v3();
      const tvl = len(tv);
      if (tvl > 25) { tv.x *= 25 / tvl; tv.y *= 25 / tvl; tv.z *= 25 / tvl; }
      h.last = target;
      if (h.kind === 'prop') {
        const p = this.props.get(h.id);
        if (!p) { this.holds.delete(pid); continue; }
        const body = p.body;
        const gp = toWorld(body.translation(), body.rotation(), h.local);
        if (len(sub(gp, pl.eye)) > C.PLAYER.REACH + (pl.mods?.slip ?? 1.6)) {     // it got away from you (Work Gloves: further)
          this.release(pid);
          this.out.push({ k: 'slip', id: p.id, by: pid });
          continue;
        }
        const n = p.holders.size || 1;
        const m = Math.min(body.mass() / n, 400);
        const vp = body.velocityAtPoint(gp);
        const door = this.atDoor(p), lift = door ? this.sillLift(p, door, gp, target) : 0;
        if (door && !turned.has(p.id)) { turned.add(p.id); this.turnToDoor(p, dt); }
        // (and steered to the middle of the doorway)
        const goal = door ? add(target, qRotate(this.rv.rotation(), v3(0, lift, Math.max(-0.8, Math.min(0.8, RV_DIM.DOOR_Z - door.z))))) : target;
        let F = add(mul(add(mul(sub(goal, gp), C.GRAB.KP), mul(sub(tv, vp), C.GRAB.KD)), m), v3(0, m * 9.81, 0));
        const fl = len(F), fmax = pl.mods?.fmax ?? C.GRAB.FMAX;   // (Work Gloves II: stronger hands)
        if (fl > fmax) {
          if (lift > 0 && F.y > 0) {
            // over the sill, the hands hold it up first and push it along with what strength is left
            const fy = Math.min(F.y, fmax), fh = Math.hypot(F.x, F.z);
            const k = fh > 1e-6 ? Math.min(1, Math.sqrt(fmax ** 2 - fy * fy) / fh) : 0;
            F = v3(F.x * k, fy, F.z * k);
          } else F = mul(F, fmax / fl);
        }
        // at the door the hands guide it without wrenching it round (turnToDoor does the turning)
        if (door) body.applyImpulse(mul(F, dt), true);
        else body.applyImpulseAtPoint(mul(F, dt), gp, true);
      } else if (h.kind === 'rv') {
        const gp = this.rvToWorld(h.local);
        if (len(sub(gp, pl.eye)) > C.PLAYER.REACH + 1.4) { this.holds.delete(pid); continue; }
        let F = mul(sub(target, gp), 2600);
        F.y = Math.min(F.y, 300);
        const fl = len(F);
        if (fl > C.GRAB.RV_FMAX) F = mul(F, C.GRAB.RV_FMAX / fl);
        this.rv.applyImpulseAtPoint(mul(F, dt), gp, true);
      }
    }

    // shoves
    this.pushes = this.pushes.filter(p => p.until > this.t);
    // (a push names its prop, fetched each step: one sold, broken or gone for the night since is skipped)
    for (const p of this.pushes) (p.id == null ? this.rv : this.props.get(p.id)?.body)?.applyImpulseAtPoint(mul(p.f, dt), p.pt, true);

    // the wildlife thinks and moves its legs (and jaws)
    this.mobs?.preStep(dt, players);

    this.stepWinch(dt, players);

    // (the wheels don't see the wildlife: the RV would climb a critter like a kerb. Running one over is
    // the RV's footprint passing over it, mobs.js)
    v.updateVehicle(dt, undefined, undefined, c => c.parent()?.handle !== this.rv.handle && !this.flimsy.has(c.handle) && !this.mobCols.has(c.handle));
    this.mobs?.beforePhysics();
    const v0 = this.rv.linvel(), rvV0 = { x: v0.x, y: v0.y, z: v0.z };
    // (each loot's velocity going into the step: what a knock did to it is read from the change, below)
    const vIn = this.vIn ||= new Map();
    vIn.clear();
    for (const p of this.props.values()) if (p.max > 0) { const v = p.body.linvel(); vIn.set(p.id, { x: v.x, y: v.y, z: v.z }); }
    this.rideVel();
    this.world.step(this.eq);
    this.rvContact(dt, rvV0);
    // the wildlife reads what just happened to it (hits, run over, stuck) and to its jaws: before the knocks
    // below free anything that broke (a vase that shatters on a grumphorn still hit it)
    this.mobs?.postStep(dt, players);

    // impacts: knock value off the loot. Each knock counts once, at its hardest: a thing landing touches
    // down at several points over a few steps, and every contact used to count every step (one pothole hit
    // a guitar fifteen times). A knock is the step's hardest contact; within 0.12 s of one, only a harder
    // one adds (the part over it). Bungee'd loot is strapped down. Loot riding in the RV takes half (a
    // carpeted floor, and a rigid step makes every slide into a wall read like a fall), a third on the
    // grade (the RV tipped past 20 degrees, or being winched up it): sliding about there is no crash.
    // A knock is what the thing itself felt: the contact force over its weight, but never more than its own
    // change of velocity in the step (gravity's share taken out). A thing jammed between two surfaces (a slot
    // machine slid into the cab, wedged between the seat and the dash) is pushed hard from both sides every
    // step while it doesn't move at all: summing those forces wore it to pieces on a straight, smooth road
    const rq0 = this.rv.rotation(), rp0 = this.rv.translation();
    const upY = 1 - 2 * (rq0.x * rq0.x + rq0.z * rq0.z);
    const grade = this.hook.reeling || upY < 0.94;
    const hits = new Map(), struck = new Set();
    this.eq.drainContactForceEvents(e => {
      for (const h of [e.collider1(), e.collider2()]) {
        const id = this.byCollider.get(h);
        if (id == null) continue;
        const p = this.props.get(id);
        if (p && this.riding.has(id)) { struck.add(id); continue; }   // (riding: hit hard, it comes loose: rideStep)
        if (!p || p.max <= 0 || this.tied.has(id)) continue;
        const g = e.totalForceMagnitude() / p.body.mass() / 9.81;
        if (g > (hits.get(id) || 0)) hits.set(id, g);
      }
    });
    for (const [id, gF] of hits) {
      const p = this.props.get(id);
      if (!p) continue;
      const a = vIn.get(id), b = p.body.linvel();
      const g = a ? Math.min(gF, Math.hypot(b.x - a.x, b.y - a.y + 9.81 * dt, b.z - a.z) / dt / 9.81) : gF;
      const L = LOOT[p.type], knock = p.knockUntil > this.t;
      const over = g - Math.max(L.tough, knock ? p.knockG : 0);
      if (over <= 0) continue;
      if (!knock) p.knockUntil = this.t + 0.12;
      p.knockG = g;
      let dmg = over * L.frag * 0.006 * p.max;
      if (p.holders.size) dmg *= 0.5;
      { const l = toLocal(rp0, rq0, p.body.translation()); if (insideRV(l.x, l.y, l.z, 0.1)) dmg *= grade ? 0.33 : this.rvMods.rattle; }
      dmg = Math.min(dmg, p.max * 0.4);
      if (dmg < 1) continue;
      p.value -= dmg;
      if (p.value < Math.max(8, p.max * 0.07)) {
        this.out.push({ k: 'break', id: p.id, type: p.type, lost: Math.round(p.max), x: r3(p.body.translation().x), y: r3(p.body.translation().y), z: r3(p.body.translation().z) });
        this.removeProp(p.id);
      } else {
        this.out.push({ k: 'dmg', id: p.id, value: Math.round(p.value), lost: Math.round(dmg) });
      }
    }

    // a stone or rock barely moving for a second is put to sleep: one rocking on a fold of the ground (between
    // two of its triangles) never gets under the engine's own limits, and was sent in every snapshot for good
    for (const p of this.props.values()) {
      if (!LOOT[p.type].settle || p.holders.size || p.body.isSleeping()) continue;
      const v = p.body.linvel(), w = p.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) > 0.12 || Math.hypot(w.x, w.y, w.z) > 1) { p.calm = 0; continue; }
      if ((p.calm = (p.calm || 0) + dt) > 1) { p.body.sleep(); p.calm = 0; }
    }

    // a thrown thing hitting a friend (not whoever threw it) beans them: a stumble, and they drop what they
    // carry. Never a knockout, never a bill. To a rider it's how fast it comes at them in the RV (junk lying
    // still in the cabin of a moving RV isn't flying), and the knock is on top of the RV's motion
    for (const p of this.props.values()) {
      if (p.thrownBy == null || p.beaned || this.t - p.thrownAt > 1.5) continue;
      const t = p.body.translation(), v = p.body.linvel(), w = this.rv.velocityAtPoint(t);
      const rel = { x: v.x - w.x, y: v.y - w.y, z: v.z - w.z };
      if (Math.hypot(v.x, v.y, v.z) < 5 && Math.hypot(rel.x, rel.y, rel.z) < 5) continue;
      for (const pl of players.values()) {
        if (pl.id === p.thrownBy || !pl.pos || pl.ko || pl.seat != null || (this.knockCd.get(pl.id) || 0) > this.t) continue;
        const u = pl.par ? rel : v;
        if (Math.hypot(u.x, u.y, u.z) < 5) continue;
        const y = Math.max(pl.pos.y + 0.3, Math.min(pl.pos.y + 1.6, t.y));
        if (Math.hypot(t.x - pl.pos.x, t.y - y, t.z - pl.pos.z) > 0.6) continue;
        p.beaned = true;
        this.knockCd.set(pl.id, this.t + 1);
        const h = this.holds.get(pl.id);
        if (h) { this.release(pl.id); this.out.push({ k: 'slip', id: h.kind === 'prop' ? h.id : null, by: pl.id, why: 'bean' }); }
        const k = 2.5 / (Math.hypot(u.x, u.z) || 1);
        this.out.push({ k: 'knock', id: pl.id, v: [r3(u.x * k), 2, r3(u.z * k)], ko: false, why: 'bean', by: p.thrownBy, rel: pl.par ? 1 : 0 });
        this.out.push({ k: 'bean', id: pl.id, by: p.thrownBy, item: p.id, type: p.type });
        break;
      }
    }

    // the RV runs people over
    const rvv = this.rv.linvel();
    const rvs = Math.hypot(rvv.x, rvv.z);
    if (rvs > 2.6) {
      const rp = this.rv.translation(), rq = this.rv.rotation();
      for (const pl of players.values()) {
        if (!pl.pos || pl.par || pl.seat != null || pl.ko) continue;
        if ((this.knockCd.get(pl.id) || 0) > this.t) continue;
        const l = toLocal(rp, rq, pl.pos);
        if (Math.abs(l.x) < RV_DIM.HALF_W + 0.45 && Math.abs(l.z) < RV_DIM.HALF_L + 0.5 && l.y > -2.0 && l.y < 2.2) {
          const out = qRotate(rq, v3(Math.sign(l.x || 1), 0, 0));
          const ko = rvs > 6.5;
          const kv = add(add(mul(rvv, 1.25), mul(out, 3.5)), v3(0, 5 + rvs * 0.25, 0));
          this.knockCd.set(pl.id, this.t + 1.5);
          this.out.push({ k: 'knock', id: pl.id, v: [r3(kv.x), r3(kv.y), r3(kv.z)], ko, why: 'rv', speed: r3(rvs) });
        }
      }
    }

    this.rideStep(dt, struck);
    this.keepLoad();

    // anything that fell out of the world goes back to the road (and anything whose motion went
    // non-finite, which nothing else would ever fix: the test is written so NaN fails it)
    const sane = (t, v) => t.y > -60 && Number.isFinite(t.x + t.z + v.x + v.y + v.z);
    for (const p of this.props.values()) {
      const t = p.body.translation();
      if (!sane(t, p.body.linvel())) {
        const z = Number.isFinite(t.z) ? t.z : 0;
        p.body.setTranslation(v3(W.roadX(z), W.heightAt(W.roadX(z), z) + 2, z), true);
        p.body.setLinvel(v3(), true);
        p.body.setAngvel(v3(), true);
      }
    }
    const rt = this.rv.translation();
    if (!sane(rt, this.rv.linvel())) { const z = Number.isFinite(rt.z) ? rt.z : 0; this.placeRV(W.roadX(z), z, 0); }
  }

  // Is the RV upside-down / on its side?
  // the RV's condition as the drive sees it (the room keeps the number): its top end, the rattle loose loot
  // inside takes, broken down; a stall is set by the room (a knock while limping)
  setRvCond(hp) {
    const b = C.rvBand(hp);
    this.rvMods = { top: b.top, rattle: b.rattle, dead: hp <= 0, stallUntil: this.rvMods?.stallUntil || 0, band: b.name };
  }
  // A crash: how much the RV's velocity changed across the physics step itself (contacts only: the engine,
  // brakes, suspension, mud, the winch and pushes were all applied before it), gravity put back, along the
  // ground in its own frame (up and down is the springs'). Steps of GATE m/s or more within WIN s of each
  // other are one hit, its size their summed change; a hit goes out as an 'rvhit' for the room to price,
  // named for what the RV touched most (a hit on the wildlife is the wildlife's to price: mobs.js)
  rvContact(dt, v0) {
    const v1 = this.rv.linvel(), q = this.rv.rotation();
    const d = qRotate(qConj(q), v3(v1.x - v0.x, v1.y - v0.y + 9.81 * dt, v1.z - v0.z)), h = Math.hypot(d.x, d.z);
    // (put down somewhere, it's quiet till it has settled: QUIET s at least, QUIET_MAX at most. A tow set
    // down on a slope lurches and drops before it sits still)
    if (this.t < this.quietMax) {
      if (this.t >= this.quietUntil && this.rvSettled()) this.quietMax = 0;
      else { this.hit = null; return; }
    }
    if (h >= C.RVH.GATE) {
      // (each step goes to what the RV touched most in it: a step on the wildlife is the wildlife's to price
      // (mobs.js), and leaves the window to whatever the RV carries on into: the gate's bars behind a beast)
      const partner = this.rvPartner();
      if (partner === 'mob') { if (this.hit) this.hit.last = this.t; }
      else {
        if (!this.hit) this.hit = { x: 0, z: 0, last: this.t, partner };
        this.hit.x += d.x; this.hit.z += d.z; this.hit.last = this.t;
      }
    } else if (this.hit && this.t - this.hit.last > C.RVH.WIN) {
      const hit = this.hit, dv = Math.hypot(hit.x, hit.z);
      this.hit = null;
      const t = this.rv.translation();
      this.out.push({ k: 'rvhit', why: 'crash', dv: r3(dv), zone: hitZone(hit), what: hit.partner, at: [r3(t.x), r3(t.y + 1.2), r3(t.z)] });
    }
  }
  // what the RV's outside is touching most (its loot riding inside aside): the name a crash goes by
  rvPartner() {
    const count = new Map(), w = this.world, rp = this.rv.translation(), rq = this.rv.rotation();
    for (const name of RV_HULL) {
      const col = this.rvCols[name];
      if (!col) continue;
      w.contactPairsWith(col, c2 => {
        if (!c2) return;
        let n = 0;
        w.contactPair(col, c2, man => { n += man.numContacts(); });
        if (n > 0) count.set(c2.handle, (count.get(c2.handle) || 0) + n);
      });
    }
    let best = null, bn = 0;
    for (const [hd, n] of count) {
      let name = this.colTag.get(hd);
      if (!name) {
        if (this.mobCols.has(hd)) name = 'mob';
        else {
          const id = this.byCollider.get(hd), p = id != null && this.props.get(id);
          if (!p) continue;
          const l = toLocal(rp, rq, p.body.translation());
          if (insideRV(l.x, l.y, l.z, 0.2)) continue;   // (its own cargo)
          name = p.type === 'boulder' ? 'the boulder' : `the ${LOOT[p.type]?.name || 'thing'}`;
        }
      }
      if (n > bn) { bn = n; best = name; }
    }
    return best || 'something';
  }

  rvFlipped() {
    const up = qRotate(this.rv.rotation(), v3(0, 1, 0));
    return up.y < 0.35;
  }

  // sitting still on its wheels (at least three on the ground)
  // past saving without the tow truck: on its back or side, or lying past 53 degrees with fewer than three wheels
  // down (it slid off its side onto a steep bank: not flipped, not on its wheels, and no way to drive it)
  rvBeached() {
    if (this.rvFlipped()) return true;
    if (qRotate(this.rv.rotation(), v3(0, 1, 0)).y > 0.6) return false;
    let on = 0;
    for (let i = 0; i < RV_WHEELS.length; i++) if (this.vehicle.wheelIsInContact(i)) on++;
    return on < 3;
  }

  rvSettled() {
    const v = this.rv.linvel(), w = this.rv.angvel();
    let on = 0;
    for (let i = 0; i < RV_WHEELS.length; i++) if (this.vehicle.wheelIsInContact(i)) on++;
    return on >= 3 && Math.hypot(v.x, v.y, v.z) < 1 && Math.hypot(w.x, w.y, w.z) < 0.5;
  }

  // Shove it back on its wheels (costs money: the room charges for the tow). The tow truck drags it back onto
  // the road nearby, facing up it: the nearest gentle stretch within 40 m, clear of the day's obstacles and on
  // this side of them all (a tow is no way past a gate, the mud, the boulder or a grade). With none (in camp,
  // in town), it's righted where it lies. Moved, the truck unhooks the winch first
  rightRV() {
    const t = this.rv.translation(), W = this.W, z = this.towSpot(t.z);
    if (z != null) {
      if (this.hook.state !== 'stowed') this.stowHook();
      this.placeRV(W.roadX(z), z, Math.atan2(W.roadX(z + 3) - W.roadX(z - 3), 6));
      return;
    }
    const yaw = Math.atan2(qRotate(this.rv.rotation(), v3(0, 0, 1)).x, qRotate(this.rv.rotation(), v3(0, 0, 1)).z);
    this.placeRV(t.x, t.z, yaw);
  }

  // where on the road (its z) the tow truck puts the RV, from z0, or null
  towSpot(z0) {
    const W = this.W, h = z => W.heightAt(W.roadX(z), z);
    if (!(z0 > 10 && z0 < W.LEN - 10)) return null;
    // the stretches a tow mustn't land on or cross (the boulder only while it's still on the road)
    const spans = [];
    for (const o of W.obstacles) {
      if (o.type === 'gate') spans.push([o.z - 8, o.z + 8]);
      else if (o.type === 'mud') spans.push([o.z0 - 5, o.z1 + 5]);
      else if (o.type === 'grade') spans.push([o.z0 - 8, o.z1 + 14]);
      else if (o.type === 'boulder') {
        for (const p of this.props.values()) {
          if (p.type !== 'boulder') continue;
          const b = p.body.translation();
          if (Math.abs(b.x - W.roadX(b.z)) < 6) spans.push([b.z - 7, b.z + 7]);
        }
      }
    }
    // (in one already, it goes back to before it, never on past it)
    const inside = spans.find(([a, b]) => z0 >= a && z0 <= b), from = inside ? inside[0] - 0.01 : z0;
    for (let k = 0; k <= 20; k++) {
      for (const s of k ? [-1, 1] : [1]) {
        const z = z0 + s * k * 2;
        if (z < 10 || z > W.LEN - 10 || (inside && z > from)) continue;
        if (spans.some(([a, b]) => b >= Math.min(z, from) && a <= Math.max(z, from) && (a !== inside?.[0] || b !== inside?.[1]))) continue;
        if (spans.some(([a, b]) => z >= a && z <= b)) continue;
        if (Math.abs(h(z + 4) - h(z - 4)) / 8 > 0.1) continue;
        return z;
      }
    }
    return null;
  }

  propsIn(box) {
    const ids = [];
    for (const p of this.props.values()) {
      if (p.type === 'map' || p.type === 'boulder' || p.max <= 0) continue;
      const t = p.body.translation();
      if (Math.abs(t.x - box.x) < box.hx && Math.abs(t.z - box.z) < box.hz && t.y > box.y - 0.3 && t.y < box.y + 1.6) ids.push(p.id);
    }
    return ids;
  }

  // ---- snapshot -------------------------------------------------------------------------

  snapshot(full = false) {
    const r = this.rv, t = r.translation(), q = r.rotation(), lv = r.linvel(), v = this.vehicle;
    const wheels = [];
    for (let i = 0; i < RV_WHEELS.length; i++) {
      wheels.push(r3(v.wheelSuspensionLength(i) ?? SUSP_REST), Math.round((v.wheelRotation(i) || 0) * 100) / 100);
    }
    const rv = [r3(t.x), r3(t.y), r3(t.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w), r3(lv.x), r3(lv.y), r3(lv.z), r3(this.steer), ...wheels];
    // (things lying still that the pages already have are left out; a full one every so often resends them, a
    // share at a time, so it stays within the snapshot's size however much lies about)
    const props = [];
    let k = 0;
    const c0 = this.fullAt || 0;
    for (const p of this.props.values()) {
      const sleeping = p.body.isSleeping();
      if (sleeping && p.sentSleep) {
        if (!full) continue;
        const i = k++;
        if (i < c0 || i >= c0 + FULL_SHARE) continue;
      }
      p.sentSleep = sleeping;
      const pt = p.body.translation(), pq = p.body.rotation();
      const e = [p.id, r3(pt.x), r3(pt.y), r3(pt.z), r4(pq.x), r4(pq.y), r4(pq.z), r4(pq.w)];
      if (p.mob) e.push(p.mob.wire());   // wildlife: its state (shared/mobs.js RST / GST, plus flag bits)
      props.push(e);
    }
    if (full) this.fullAt = c0 + FULL_SHARE >= k ? 0 : c0 + FULL_SHARE;
    const H = this.hook;
    const hp = this.hookPos();
    const hook = [H.state === 'stowed' ? 0 : H.state === 'out' ? 1 : 2, r3(hp.x), r3(hp.y), r3(hp.z), r3(H.len), H.reeling ? 1 : 0, H.holder ?? 0];
    return { rv, props, hook };
  }
}

function mulQ(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function conjQ(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
