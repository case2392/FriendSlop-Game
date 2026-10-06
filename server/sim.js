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
  RV_PARTS, RV_WHEELS, WHEEL_R, SUSP_REST, RV_WINCH, RV_DIM, RV_MAP_SPOT,
  toWorld, toLocal, insideRV, qRotate,
} from '../shared/rv.js';
import { inMud } from '../shared/world.js';

let ready = null;
export function initPhysics() { return (ready ||= RAPIER.init()); }

// collision groups: (membership << 16) | filter
const G_WORLD = 1, G_RV = 2, G_PROP = 4, G_HOOK = 8;
const grp = (m, f) => ((m << 16) | f) >>> 0;
const GROUPS = {
  world: grp(G_WORLD, 0xffff),
  rv: grp(G_RV, G_WORLD | G_RV | G_PROP),
  prop: grp(G_PROP, 0xffff),
  hook: grp(G_HOOK, G_WORLD | G_PROP),
};

const yawQ = ry => ({ x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) });
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const len = a => Math.hypot(a.x, a.y, a.z);
const r3 = n => Math.round(n * 1000) / 1000;
const r4 = n => Math.round(n * 10000) / 10000;

function shapeDesc(shape) {
  const [k, a, b, c] = shape;
  if (k === 'box') return RAPIER.ColliderDesc.cuboid(a, b, c);
  if (k === 'cyl') return RAPIER.ColliderDesc.cylinder(a, b);
  return RAPIER.ColliderDesc.ball(a);
}

export class Sim {
  // carry: [{type, value, max, lx,ly,lz, q}] — loot that rode over from yesterday
  constructor(W, { parts = { doors: true, roof: true }, carry = [], spawnAt = null } = {}) {
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
    this.parts = { ...parts };
    this.doorOpen = false;
    this.gateCols = new Map();
    this.gatesOpen = new Set();
    this.knockCd = new Map();
    this.tied = new Map();           // prop id -> joint (bungee'd to the RV)

    this.buildTerrain();
    this.buildStatics();
    const camp = W.camp.rv;
    const sp = spawnAt || { x: camp.x, z: camp.z, yaw: camp.yaw };
    this.buildRV(sp.x, W.heightAt(sp.x, sp.z) + 1.45, sp.z, sp.yaw);
    for (const p of W.props) this.addProp(p.type, v3(p.x, p.y, p.z), yawQ(p.ry), p.value, p.value, p.id);
    this.hook = { state: 'stowed', body: null, len: 0, reeling: false, holder: null, anchor: null, attach: null };
    // yesterday's loot, back where it was in the RV
    const rp = this.rv.translation(), rq = this.rv.rotation();
    for (const c of carry) {
      const w = toWorld(rp, rq, v3(c.lx, c.ly + 0.04, c.lz));
      const q = mulQ(rq, c.q);
      this.addProp(c.type, w, q, c.value, c.max);
    }
    this.spawnMap();
  }

  // ---- building the world --------------------------------------------------------

  buildTerrain() {
    const { nx, nz, cell, X0, Z0, heights } = this.W;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.heightfield(nz, nx, heights, v3(nx * cell, 1, nz * cell))
      .setTranslation(X0 + nx * cell / 2, 0, Z0 + nz * cell / 2)
      .setFriction(0.9).setCollisionGroups(GROUPS.world);
    this.terrain = this.world.createCollider(desc, body);
  }

  buildStatics() {
    const W = this.W;
    this.statics = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const s of W.statics) {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
        .setTranslation(s.x, s.y, s.z).setRotation(yawQ(s.ry)).setFriction(0.8)
        .setCollisionGroups(GROUPS.world), this.statics);
    }
    for (const c of W.cyls) {
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(c.hh, c.r)
        .setTranslation(c.x, c.y, c.z).setCollisionGroups(GROUPS.world), this.statics);
    }
    for (const g of W.gates) {
      const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(g.hx, g.hy, g.hz)
        .setTranslation(g.x, g.y, g.z).setCollisionGroups(GROUPS.world), this.statics);
      this.gateCols.set(g.id, col);
    }
  }

  buildRV(x, y, z, yaw) {
    const bd = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(yawQ(yaw))
      .setLinearDamping(0.06).setAngularDamping(0.5).setCcdEnabled(true);
    this.rv = this.world.createRigidBody(bd);
    this.rvCols = {};
    for (const [name, hx, hy, hz, cx, cy, cz, o] of RV_PARTS) {
      const vol = 8 * hx * hy * hz;
      const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz)
        .setDensity(o.mass ? o.mass / vol : 0).setFriction(name === 'chassis' ? 0.4 : 0.75)
        .setCollisionGroups(GROUPS.rv);
      const col = this.world.createCollider(cd, this.rv);
      this.rvCols[name] = col;
      if (o.part && !this.parts[o.part]) col.setEnabled(false);
    }
    this.rvCols.door.setEnabled(this.parts.doors && !this.doorOpen);

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
      .setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(L.mass < 60);
    const body = this.world.createRigidBody(bd);
    const [k] = L.shape;
    const vol = k === 'box' ? 8 * L.shape[1] * L.shape[2] * L.shape[3]
      : k === 'cyl' ? Math.PI * L.shape[2] ** 2 * 2 * L.shape[1]
        : 4 / 3 * Math.PI * L.shape[1] ** 3;
    const col = this.world.createCollider(shapeDesc(L.shape)
      .setDensity(L.mass / vol).setFriction(type === 'boulder' ? 0.85 : 0.6).setRestitution(0.1)
      .setCollisionGroups(GROUPS.prop)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(L.mass * L.tough * 9.81), body);
    const prop = { id, type, body, col, value, max: max ?? value, holders: new Set(), sentSleep: false };
    this.props.set(id, prop);
    this.byCollider.set(col.handle, id);
    return prop;
  }

  removeProp(id) {
    const p = this.props.get(id);
    if (!p) return;
    for (const [pid, h] of this.holds) if (h.kind === 'prop' && h.id === id) this.holds.delete(pid);
    if (this.tied.has(id)) this.tied.delete(id);
    if (this.hook.attach && this.hook.attach.id === id) this.unhook();
    this.byCollider.delete(p.col.handle);
    this.world.removeRigidBody(p.body);
    this.props.delete(id);
  }

  spawnMap() {
    // one paper map on the dash, every morning. whoever holds it navigates.
    for (const p of this.props.values()) if (p.type === 'map') return;
    const w = toWorld(this.rv.translation(), this.rv.rotation(), RV_MAP_SPOT);
    const prop = this.addProp('map', w, this.rv.rotation(), 0, 0);
    this.out.push({ k: 'spawn', p: this.describe(prop) });
  }

  describe(p) {
    const t = p.body.translation(), q = p.body.rotation();
    return { id: p.id, type: p.type, value: Math.round(p.value), max: Math.round(p.max),
      x: r3(t.x), y: r3(t.y), z: r3(t.z), q: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)] };
  }

  allProps() { return [...this.props.values()].map(p => this.describe(p)); }

  // ---- RV helpers ------------------------------------------------------------------

  rvPose() { return { p: this.rv.translation(), q: this.rv.rotation() }; }
  rvToWorld(l) { return toWorld(this.rv.translation(), this.rv.rotation(), l); }
  rvToLocal(w) { return toLocal(this.rv.translation(), this.rv.rotation(), w); }
  rvSpeed() { return this.vehicle.currentVehicleSpeed(); }

  setDoor(open) {
    if (!this.parts.doors) return;
    this.doorOpen = open;
    this.rvCols.door.setEnabled(!open);
    this.rv.wakeUp();
    this.out.push({ k: 'door', open });
  }

  removePart(part) {
    this.parts[part] = false;
    for (const [name, , , , , , , o] of RV_PARTS) if (o.part === part) this.rvCols[name].setEnabled(false);
    this.rv.wakeUp();
  }

  openGate(id) {
    const col = this.gateCols.get(id);
    if (!col || this.gatesOpen.has(id)) return false;
    this.world.removeCollider(col, true);
    this.gatesOpen.add(id);
    return true;
  }

  // Teleport the RV (night parking, morning camp). Loot inside comes along.
  placeRV(x, z, yaw) {
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

  // Loot that's in the RV right now, in RV-local coordinates (rides into tomorrow).
  carryOver() {
    const rp = this.rv.translation(), rq = this.rv.rotation();
    const list = [];
    for (const p of this.props.values()) {
      if (p.type === 'map' || p.type === 'boulder') continue;
      const l = toLocal(rp, rq, p.body.translation());
      if (!insideRV(l.x, l.y, l.z, 0.05) || l.y > RV_DIM.ROOF_Y - 0.1) continue;
      list.push({ type: p.type, value: p.value, max: p.max, lx: l.x, ly: l.y, lz: l.z, q: mulQ(conjQ(rq), p.body.rotation()) });
    }
    return list;
  }

  // ---- intents from players ------------------------------------------------------------

  // players: Map(id -> player) with .eye {x,y,z} and .look {x,y,z} in world space
  grab(pid, pl, m) {
    if (!pl?.eye) return false;
    this.release(pid);
    const pt = v3(Number(m.pt?.[0]) || 0, Number(m.pt?.[1]) || 0, Number(m.pt?.[2]) || 0);
    if (len(sub(pt, pl.eye)) > C.PLAYER.REACH + 0.8) return false;
    const dist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, Number(m.d) || C.GRAB.HOLD_DEFAULT));
    if (m.kind === 'prop') {
      const p = this.props.get(Number(m.id));
      if (!p) return false;
      if (this.tied.has(p.id)) { this.world.removeImpulseJoint(this.tied.get(p.id), true); this.tied.delete(p.id); }
      const local = toLocal(p.body.translation(), p.body.rotation(), pt);
      // clamp the grab point onto the object (hands, not telekinesis)
      local.x = Math.max(-1.2, Math.min(1.2, local.x));
      local.y = Math.max(-1.2, Math.min(1.2, local.y));
      local.z = Math.max(-1.2, Math.min(1.2, local.z));
      p.holders.add(pid);
      p.body.setAngularDamping(3.5);
      p.body.wakeUp();
      this.holds.set(pid, { kind: 'prop', id: p.id, local, dist, last: null });
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

  holdDist(pid, d) {
    const h = this.holds.get(pid);
    if (h) h.dist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, Number(d) || h.dist));
  }

  release(pid, throwDir = null, pl = null) {
    const h = this.holds.get(pid);
    if (!h) return;
    this.holds.delete(pid);
    if (h.kind !== 'prop') return;
    const p = this.props.get(h.id);
    if (!p) return;
    p.holders.delete(pid);
    if (p.holders.size === 0) p.body.setAngularDamping(0.3);
    if (throwDir) {
      const m = p.body.mass();
      const imp = Math.min(m * C.GRAB.THROW, C.GRAB.THROW_IMPULSE_CAP);
      const d = v3(Number(throwDir[0]) || 0, Number(throwDir[1]) || 0, Number(throwDir[2]) || 0);
      const n = len(d) || 1;
      p.body.applyImpulse(mul(d, imp / n), true);
      if (pl?.vel) p.body.applyImpulse(mul(pl.vel, m * 0.6), true);
      this.out.push({ k: 'throw', id: p.id, by: pid });
    }
  }

  push(pid, m) {
    const pt = v3(Number(m.pt?.[0]) || 0, Number(m.pt?.[1]) || 0, Number(m.pt?.[2]) || 0);
    const d = v3(Number(m.dir?.[0]) || 0, 0, Number(m.dir?.[2]) || 0);
    const n = len(d);
    if (n < 0.1) return;
    if (m.kind === 'rv') {
      this.pushes.push({ body: this.rv, pt, f: mul(d, C.PUSH_FORCE_RV / n), until: this.t + 0.16 });
    } else if (m.kind === 'prop') {
      const p = this.props.get(Number(m.id));
      if (!p) return;
      const f = p.type === 'boulder' ? C.PUSH_FORCE_RV : C.PUSH_FORCE_PROP;
      this.pushes.push({ body: p.body, pt, f: mul(d, f / n), until: this.t + 0.16 });
    }
  }

  setDrive(m) {
    this.drive.th = Math.max(-1, Math.min(1, Number(m.th) || 0));
    this.drive.st = Math.max(-1, Math.min(1, Number(m.st) || 0));
    this.drive.hb = m.hb ? 1 : 0;
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
      if (len(sub(p.body.translation(), hp)) < (p.type === 'boulder' ? 2.6 : 1.4)) {
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

    if (H.reeling) {
      H.len = Math.max(0.6, H.len - C.WINCH.REEL_SPEED * dt);
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
    const rp = this.rv.translation(), rq = this.rv.rotation();
    let n = 0;
    for (const p of this.props.values()) {
      if (this.tied.has(p.id) || p.type === 'map' || p.type === 'boulder') continue;
      const l = toLocal(rp, rq, p.body.translation());
      if (!insideRV(l.x, l.y, l.z, 0.05) || l.y > RV_DIM.ROOF_Y - 0.1) continue;
      const rel = mulQ(conjQ(rq), p.body.rotation());
      const j = this.world.createImpulseJoint(
        RAPIER.JointData.fixed(l, rel, v3(), { x: 0, y: 0, z: 0, w: 1 }), this.rv, p.body, true);
      this.tied.set(p.id, j);
      n++;
    }
    return n;
  }

  // ---- the step -------------------------------------------------------------------------

  step(dt, players) {
    this.t += dt;
    const W = this.W;

    // driving
    const v = this.vehicle;
    const sp = v.currentVehicleSpeed();
    const { th, st, hb } = this.drive;
    let engine = 0, brake = 0.6;
    if (th > 0.05) {
      if (sp < -0.6) brake = C.RV.BRAKE;
      else engine = th * C.RV.ENGINE * (1 - Math.max(0, Math.min(1, sp / C.RV.TOP_SPEED)) ** 2);
      brake = sp < -0.6 ? C.RV.BRAKE : 0;
    } else if (th < -0.05) {
      if (sp > 0.6) { brake = C.RV.BRAKE; }
      else { engine = th * C.RV.REVERSE * (1 - Math.max(0, Math.min(1, -sp / 6))); brake = 0; }
    }
    if (hb) { brake = C.RV.BRAKE * 1.6; engine = 0; }
    const steerTarget = st * C.RV.STEER_MAX * (1 - 0.5 * Math.min(1, Math.abs(sp) / C.RV.TOP_SPEED));
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
        if (len(sub(gp, pl.eye)) > C.PLAYER.REACH + 1.6) {     // it got away from you
          this.release(pid);
          this.out.push({ k: 'slip', id: p.id, by: pid });
          continue;
        }
        const n = p.holders.size || 1;
        const m = Math.min(body.mass() / n, 400);
        const vp = body.velocityAtPoint(gp);
        let F = add(mul(add(mul(sub(target, gp), C.GRAB.KP), mul(sub(tv, vp), C.GRAB.KD)), m), v3(0, m * 9.81, 0));
        const fl = len(F);
        if (fl > C.GRAB.FMAX) F = mul(F, C.GRAB.FMAX / fl);
        body.applyImpulseAtPoint(mul(F, dt), gp, true);
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
    for (const p of this.pushes) p.body.applyImpulseAtPoint(mul(p.f, dt), p.pt, true);

    this.stepWinch(dt, players);

    v.updateVehicle(dt, undefined, undefined, c => c.parent()?.handle !== this.rv.handle);
    this.world.step(this.eq);

    // impacts: knock value off the loot
    this.eq.drainContactForceEvents(e => {
      for (const h of [e.collider1(), e.collider2()]) {
        const id = this.byCollider.get(h);
        if (id == null) continue;
        const p = this.props.get(id);
        if (!p || p.max <= 0) continue;
        const L = LOOT[p.type];
        const g = e.totalForceMagnitude() / p.body.mass() / 9.81;
        if (g <= L.tough) continue;
        let dmg = (g - L.tough) * L.frag * 0.006 * p.max;
        if (p.holders.size) dmg *= 0.5;
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
    });

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
          this.out.push({ k: 'knock', id: pl.id, v: [r3(kv.x), r3(kv.y), r3(kv.z)], ko, speed: r3(rvs) });
        }
      }
    }

    // anything that fell out of the world goes back to the road
    for (const p of this.props.values()) {
      const t = p.body.translation();
      if (t.y < -60) {
        p.body.setTranslation(v3(W.roadX(t.z), W.heightAt(W.roadX(t.z), t.z) + 2, t.z), true);
        p.body.setLinvel(v3(), true);
      }
    }
    const rt = this.rv.translation();
    if (rt.y < -60) this.placeRV(W.roadX(rt.z), rt.z, 0);
  }

  // Is the RV upside-down / on its side?
  rvFlipped() {
    const up = qRotate(this.rv.rotation(), v3(0, 1, 0));
    return up.y < 0.35;
  }

  // Shove it back on its wheels (costs money — the room charges for the tow).
  rightRV() {
    const t = this.rv.translation();
    const yaw = Math.atan2(qRotate(this.rv.rotation(), v3(0, 0, 1)).x, qRotate(this.rv.rotation(), v3(0, 0, 1)).z);
    this.placeRV(t.x, t.z, yaw);
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
    const props = [];
    for (const p of this.props.values()) {
      const sleeping = p.body.isSleeping();
      if (!full && sleeping && p.sentSleep) continue;
      p.sentSleep = sleeping;
      const pt = p.body.translation(), pq = p.body.rotation();
      props.push([p.id, r3(pt.x), r3(pt.y), r3(pt.z), r4(pq.x), r4(pq.y), r4(pq.z), r4(pq.w)]);
    }
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
