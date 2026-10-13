// The wildlife (shared/mobs.js says who and where): bodies with brains. A critter is a prop like the boulder
// (Sim.addProp: a dynamic body in the prop list, so it rides the snapshot, the joiner's prop list and every
// client's interpolation for free) plus a Mob record here: its state, its home, what it's after. The Sim owns
// one Mobs from when the RV leaves camp till nightfall.
//
// The rule that keeps the physics world alive: nothing here holds on to a RigidBody across steps. Every
// step fetches a critter's (and its loot's) body through get(id), which is null once the prop is gone: a
// body touched after it was freed throws, and that world's physics is broken for the rest of the day.
import RAPIER from '@dimforge/rapier3d-compat';
import { LOOT } from '../shared/loot.js';
import { RT, GH, PLAN, GST, RST, ST_CARRY, ST_MOOD, crewFactor, cowbellValue, ringtailsPerDen } from '../shared/mobs.js';
import { FLAG, MODE } from '../shared/constants.js';
import { toLocal, qRotate, insideRV } from '../shared/rv.js';
import { inMud } from '../shared/world.js';
import { mulberry32 } from '../shared/rng.js';
import { GROUPS } from './groups.js';

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const yawQ = ry => ({ x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) });
const r3 = n => Math.round(n * 1000) / 1000;
// a body's heading (its local +z, flattened)
export const yawOf = q => Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));

class Mob {
  constructor(id, type, t) {
    this.id = id; this.type = type;
    this.st = 0; this.stAt = t;     // state (RST / GST) and when it began
    this.carry = false;             // something in its jaws (ringtail)
    this.mood = false;              // in a foul mood (grumphorn: patience below 40%)
    this.think = 0;                 // the brain runs every 0.1 s, staggered
    this.target = null;
  }
  // what the snapshot carries: the state plus its flag bits
  wire() { return this.st | (this.carry ? ST_CARRY : 0) | (this.mood ? ST_MOOD : 0); }
}

export class Mobs {
  // day: today (1..5); crew: how many play (scales the cast and the grumphorn's patience); seed: the run's
  constructor(sim, { day = 1, crew = 1, seed = 0 } = {}) {
    this.sim = sim;
    this.day = Math.max(1, Math.min(5, day | 0));
    this.crew = Math.max(1, crew | 0);
    this.rng = mulberry32((seed ^ Math.imul(this.day + 97, 0x2545F491)) >>> 0);   // never Math.random: a test replays a day exactly
    this.list = new Map();          // prop id -> Mob
    this.jaws = new Map();          // critter id -> { item: prop id }
    this.carriedBy = new Map();     // item id -> critter id
    this.vPre = new Map();          // prop id -> its velocity right before the physics step (hits are read from the change)
    this.vRV = v3();                // the RV's, likewise
    this.plan = PLAN[this.day - 1];
    this.dens = new Map();          // den id -> { ...world gen's den, thefts today, awake, seen (line-of-sight cache) }
    this.stolen = new Map();        // item id -> { den, value, at }: taken by ringtails and not yet got back
    this.hoard = new Map();         // item id -> den id: piled at a den (its stash, and what was brought home). Theirs
                                    // till a player picks it up: they don't steal it again from each other, and
                                    // step over it (it doesn't collide with critters: milling about the den would
                                    // nudge the pile apart)
    this.droppedByDowned = new Map();   // item id -> until when: let go of by someone knocked out (a ringtail's favourite)
    this.sold = new Set();          // items sold this step (a stolen thing sold counts as got back; broken doesn't)
    this.recT = 0;
    this.started = false;
  }
  // how long a ringtail sits at its den between raids (5-9 s)
  cooldown() { return RT.COOLDOWN[0] + this.rng() * (RT.COOLDOWN[1] - RT.COOLDOWN[0]); }

  get t() { return this.sim.t; }
  // a critter's or an item's prop (body and collider), or null once it's gone. Fetch it every step.
  get(id) { return this.sim.props.get(id) ?? null; }

  // ---- the cast -------------------------------------------------------------------------------------------

  // today's critters (the dens and beds world gen placed: shared/world.js placeWildlife)
  start() {
    this.started = true;
    for (const b of this.sim.W.beds || []) this.spawn('grumphorn', b.x, b.z, { yaw: b.ry, st: GST.SLEEP, bed: b });
    for (const d of this.sim.W.dens || []) this.rtSpawnDen(d);
  }

  // bed: a grumphorn's spot (where it sleeps, and its way off the road); by default where it's put. den: a
  // ringtail's den id (by default a den of its own where it's put)
  spawn(type, x, z, { yaw = 0, y = null, st = 0, bed = null, den = null } = {}) {
    const L = LOOT[type];
    if (!L?.mob) return null;
    const W = this.sim.W;
    const lift = type === 'grumphorn' ? GH.R : RT.R;
    const p = this.sim.addProp(type, v3(x, y ?? W.heightAt(x, z) + lift + 0.05, z), yawQ(yaw), 0, 0);
    if (!p) return null;
    const m = new Mob(p.id, type, this.t);
    m.st = st;
    m.think = this.rng() * 0.1;
    m.home = { x, y: W.heightAt(x, z), z, ry: yaw };
    if (type === 'grumphorn') {
      m.bed = bed || { x, y: W.heightAt(x, z), z, ry: yaw, exit: this.exitNear(x, z) };
      m.patienceMax = m.patience = GH.PATIENCE * crewFactor(this.crew);
      m.hits = new Map();
      m.rvTouch = false;
      if (st === GST.SLEEP || st === GST.LEFT) p.col.setFriction(0.9);
    }
    if (type === 'ringtail') {
      if (den == null) { den = 1000 + p.id; this.dens.set(den, { id: den, x, y: W.heightAt(x, z), z, ry: yaw, poiType: null, stash: [], thefts: 0, awake: false, quietSince: this.t, seen: new Map() }); }
      m.den = den;
      m.unreachable = new Map();
      m.stuns = 0; m.hops = 0;
      m.cd = this.t + this.cooldown();
    }
    p.mob = m;
    this.list.set(p.id, m);
    // (put down mid-charge or winded: with what that state needs)
    if (type === 'grumphorn' && (st === GST.CHARGE || st === GST.WINDED)) { m.st = GST.ROAM; this.force(m, st); }
    this.sim.out.push({ k: 'spawn', p: this.sim.describe(p) });
    return m;
  }

  // nightfall: every critter goes at once (one 'gone' event); whatever they carried drops where they stood
  end() {
    for (const id of [...this.jaws.keys()]) this.letGo(id);
    const ids = [...this.list.keys()].filter(id => this.sim.props.has(id));
    for (const id of ids) this.sim.removeProp(id);
    this.list.clear();
    if (ids.length) this.sim.out.push({ k: 'gone', ids });
  }

  // a prop is about to be freed (broken, sold, a critter despawned): let go of it everywhere
  onRemoved(id) {
    const mid = this.carriedBy.get(id);
    if (mid != null) {
      this.carriedBy.delete(id);
      this.jaws.delete(mid);
      const m = this.list.get(mid);
      if (m) m.carry = false;
    }
    if (this.list.has(id)) { this.letGo(id); this.list.delete(id); }
    const st = this.stolen.get(id);
    if (st) {
      this.stolen.delete(id);
      if (this.sold.has(id)) this.sim.out.push({ k: 'mob', id: st.mob, s: 'recovered', item: id, value: Math.round(st.value) });
    }
    this.sold.delete(id);
    this.hoard.delete(id);
    this.droppedByDowned.delete(id);
    this.vPre.delete(id);
    for (const m of this.list.values()) if (m.target === id) m.target = null;
  }

  // ---- jaws ------------------------------------------------------------------------------------------------
  // A critter carries loot in its jaws on a spring of its own, the players' grab spring (KP, KD) capped at
  // RT.JAW_F, the pull taken back on the critter (half of the lift: its legs brace). The point it pulls to is
  // its mouth, held at least a hand's width over the ground, so a vase isn't dragged along the dirt. The
  // item stops colliding with critters (it would snag on the thief's own body). A player's grab is three
  // times stronger: pull it away and the jaws lose it (JAW_SLIP).

  // the point a critter's jaws pull to: in front of its head, lifted for the item's size
  mouth(p, itemType) {
    const t = p.body.translation(), q = p.body.rotation(), yaw = yawOf(q);
    const mp = v3(t.x + Math.sin(yaw) * 0.34, t.y + 0.1, t.z + Math.cos(yaw) * 0.34);
    // carried high enough that no corner of it drags, however it swings (its bounding radius); put down on the
    // pile lowered to the ground (its standing half-height), so it isn't dropped from a height
    const s = LOOT[itemType]?.shape, g = this.sim.W.heightAt(mp.x, mp.z);
    const half = !s ? 0.2 : s[0] === 'box' ? s[2] : s[1], R = !s ? 0.3 : s[0] === 'box' ? Math.hypot(s[1], s[2], s[3]) : s[0] === 'cyl' ? Math.hypot(s[1], s[2]) : s[1];
    mp.y = p.mob?.st === RST.STASH ? g + half + 0.03 : Math.max(mp.y, g + R + RT.JAW_LIFT);
    return mp;
  }
  bite(m, itemId) {
    const it = this.get(itemId);
    if (!it || this.jaws.has(m.id) || this.carriedBy.has(itemId)) return false;
    this.jaws.set(m.id, { item: itemId });
    this.carriedBy.set(itemId, m.id);
    m.carry = true;
    it.col.setCollisionGroups(GROUPS.carried);
    it.body.setAngularDamping(3.5);
    it.body.wakeUp();
    return true;
  }
  // every step: pull each carried item to its critter's mouth. Returns the ids of critters that lost theirs.
  jawsStep(dt) {
    const lost = [];
    for (const [mid, j] of [...this.jaws]) {
      const p = this.get(mid), it = this.get(j.item);
      if (!p || !it) { this.letGo(mid); if (p) lost.push(mid); continue; }
      const mp = this.mouth(p, it.type), ip = it.body.translation(), iv = it.body.linvel(), mv = p.body.linvel(), m = it.body.mass();
      let F = v3((mp.x - ip.x) * 140 * m + (mv.x - iv.x) * 22 * m, (mp.y - ip.y) * 140 * m + (mv.y - iv.y) * 22 * m + m * 9.81, (mp.z - ip.z) * 140 * m + (mv.z - iv.z) * 22 * m);
      const fl = Math.hypot(F.x, F.y, F.z);
      if (fl > RT.JAW_F) F = v3(F.x * RT.JAW_F / fl, F.y * RT.JAW_F / fl, F.z * RT.JAW_F / fl);
      it.body.applyImpulse(v3(F.x * dt, F.y * dt, F.z * dt), true);
      p.body.applyImpulse(v3(-F.x * dt, -F.y * dt * 0.5, -F.z * dt), true);
      if (Math.hypot(mp.x - ip.x, mp.y - ip.y, mp.z - ip.z) > RT.JAW_SLIP) { this.letGo(mid); lost.push(mid); }
    }
    return lost;
  }

  // a critter lets go of what it carries: the item collides with critters again
  letGo(mid) {
    const j = this.jaws.get(mid);
    if (!j) return;
    this.jaws.delete(mid);
    this.carriedBy.delete(j.item);
    const m = this.list.get(mid);
    if (m) m.carry = false;
    const it = this.get(j.item);
    if (it) {
      it.col.setCollisionGroups(GROUPS.prop);
      if (!it.holders.size) it.body.setAngularDamping(0.3);
      it.body.wakeUp();
    }
  }

  // ---- what players do to them (Sim calls these) -------------------------------------------------------

  onGrabbed(p, pid) {
    const m = p.mob;
    // a player took hold of what a ringtail carries: three times its grip, the jaws let go
    if (!m) {
      if (this.hoard.delete(p.id)) p.col.setCollisionGroups(GROUPS.prop);
      const mid = this.carriedBy.get(p.id), c = mid != null ? this.list.get(mid) : null;
      if (c) { const cp = this.get(c.id); if (cp) this.rtSpook(c, cp); }
      return;
    }
    this.wake(p);
    if (m.type === 'ringtail') {
      // caught: it lets go of what it stole at once, and squirms
      this.rtDrop(m, p);
      m.target = null;
      this.setSt(m, RST.HELD);
      return;
    }
    if (m.type === 'grumphorn') {
      // (its mind is made up once it glares: a hand on its horns doesn't stop the charge, or the toss)
      if (m.st === GST.LEAVE || m.st === GST.LEFT || m.st === GST.GLARE || m.st === GST.CHARGE) return;
      // by the horns: it shakes you off in a moment
      const q = this.players?.get(pid);
      this.ghWake(m, p, q?.pos);
      this.setSt(m, GST.HELD);
    }
  }
  onReleased(p, pid, thrown) {
    const m = p.mob;
    if (!m) return;
    this.wake(p);
    if (m.type === 'ringtail' && m.st === RST.HELD && !p.holders.size) this.setSt(m, thrown ? RST.FLUNG : RST.SPOOK);
  }
  // someone walked into it
  onPushed(p, pid) {
    const m = p.mob;
    if (!m) return;
    if (m.type === 'grumphorn') this.ghWake(m, p, this.players?.get(pid)?.pos);
  }
  // a shove from a player (pl) along (fx, fz)
  onShoved(p, pl, fx, fz) {
    const m = p.mob;
    if (!m) return;
    if (m.type === 'ringtail') {
      if (m.st === RST.GONE || m.st === RST.HELD) return;
      p.body.applyImpulse(v3(fx * 4 * RT.MASS, 2 * RT.MASS, fz * 4 * RT.MASS), true);
      this.rtDrop(m, p);
      this.setSt(m, RST.FLUNG);
    } else if (m.type === 'grumphorn') { this.ghWake(m, p, pl.pos); this.ghCost(m, p, GH.COST.shove); }
    this.wake(p);
  }
  // the driver leaned on the horn (where the RV is): any grumphorn in earshot wakes, and goes for the RV
  horn(at) {
    for (const m of [...this.list.values()]) {
      const p = this.get(m.id);
      if (!p) continue;
      if (m.type === 'grumphorn') { if (this.ghDist(p, at) < GH.WAKE_HORN) this.ghWake(m, p, at, true); continue; }
      // ringtails near the RV drop what they carry and scatter (then pay the horn no mind for a while)
      const t = p.body.translation();
      if (Math.hypot(t.x - at.x, t.z - at.z) > RT.HORN_R || (m.deafUntil || 0) > this.t) continue;
      if (m.st === RST.HELD || m.st === RST.STUN || m.st === RST.GONE || m.st === RST.FLUNG) continue;
      m.deafUntil = this.t + RT.HORN_DEAF;
      this.rtSpook(m, p);
    }
  }
  // the room sold these (a stolen thing sold counts as got back)
  onSold(ids) { for (const id of ids) this.sold.add(id); }

  // ---- the step -----------------------------------------------------------------------------------------

  // the test lever: a state forced, with what that state needs (a charge its line, winded its breather)
  force(m, st) {
    const p = this.get(m.id);
    if (!p) return;
    if (m.type === 'grumphorn' && st === GST.CHARGE) {
      const t = p.body.translation(), yaw = yawOf(p.body.rotation());
      Object.assign(m, { line: { x: Math.sin(yaw), z: Math.cos(yaw) }, from: v3(t.x, t.y, t.z), tossed: false });
    }
    if (m.type === 'grumphorn' && st === GST.WINDED) { this.ghWinded(m, p, false); return; }
    this.setSt(m, st);
  }
  // a critter's state changed: the snapshot must carry it even if its body sleeps
  setSt(m, st) {
    if (m.st === st) return;
    m.st = st;
    m.stAt = this.t;
    const p = this.get(m.id);
    if (p) this.wake(p);
  }
  wake(p) { p.body.wakeUp(); p.sentSleep = false; }

  // before the physics step: the brains (10 times a second each, staggered) and the legs and jaws (every step)
  preStep(dt, players) {
    this.players = players;
    for (const m of [...this.list.values()]) {
      let p = this.get(m.id);
      if (!p) continue;
      m.think -= dt;
      if (m.think <= 0) { m.think += 0.1; this.brain(m, p, players); }
      if (!(p = this.get(m.id))) continue;
      if (m.type === 'grumphorn') this.ghStep(m, p, players, dt);
      else this.rtStep(m, p, players, dt);
    }
    for (const mid of this.jawsStep(dt)) { const m = this.list.get(mid); if (m) this.lostGrip(m); }
    if ((this.recT -= dt) <= 0) { this.recT = 0.5; this.recoveries(players); }
  }
  // its jaws lost what they carried (pulled away, or it broke)
  lostGrip(m) {
    const p = this.get(m.id);
    if (m.type === 'ringtail' && p && (m.st === RST.RUN || m.st === RST.SNATCH)) { this.sim.out.push({ k: 'mob', id: m.id, s: 'drop' }); this.setSt(m, RST.SPOOK); }
    else if (m.type === 'ringtail' && p && m.st === RST.STASH) this.setSt(m, RST.DEN);
  }
  brain(m, p, players) {
    if (m.type === 'grumphorn') this.grumphorn(m, p, players);
    else this.ringtail(m, p, players);
  }
  // stolen things got back: in the RV, or carried by a player more than 10 m from the den
  recoveries(players) {
    for (const [id, st] of [...this.stolen]) {
      const it = this.get(id);
      if (!it) { this.stolen.delete(id); continue; }
      if (this.carriedBy.has(id)) continue;
      const t = it.body.translation(), den = this.dens.get(st.den);
      const inRV = (() => { const l = this.sim.rvToLocal(t); return insideRV(l.x, l.y, l.z, 0.05); })();
      const held = it.holders.size && den && Math.hypot(t.x - den.x, t.z - den.z) > 10;
      if (inRV || held) {
        this.stolen.delete(id);
        if (this.hoard.delete(id)) it.col.setCollisionGroups(GROUPS.prop);
        this.sim.out.push({ k: 'mob', id: st.mob, s: 'recovered', item: id, value: Math.round(it.value) });
      }
    }
  }
  // what the ringtails hold of yours right now (the tracker's "Ringtails have $X of your stuff")
  stolenValue() { let v = 0; for (const id of this.stolen.keys()) { const it = this.get(id); if (it) v += it.value; } return Math.round(v); }
  // someone knocked out let go of these: the ringtails' favourite pickings for a while
  onDowned(ids) { for (const id of ids) this.droppedByDowned.set(id, this.t + 20); }

  // right before the physics step: every awake body's velocity, to read hits from the change
  beforePhysics() {
    this.vPre.clear();
    if (!this.list.size) return;
    for (const p of this.sim.props.values()) {
      if (p.body.isSleeping()) continue;
      const v = p.body.linvel();
      this.vPre.set(p.id, v3(v.x, v.y, v.z));
    }
    const rv = this.sim.rv.linvel();
    this.vRV = v3(rv.x, rv.y, rv.z);
  }

  // after the physics step: what hit them
  postStep(dt, players) {
    for (const m of [...this.list.values()]) {
      const p = this.get(m.id);
      if (!p) continue;
      // (a body at rest feels no hits; but the RV can roll over a ringtail sitting still without touching it)
      if (p.body.isSleeping()) { if (m.type === 'ringtail') this.rtSquash(m, p); continue; }
      if (m.type === 'grumphorn') this.ghPost(m, p, players);
      else this.rtPost(m, p, players);
    }
  }

  // what hit the grumphorn this step: loot (and critters) thrown at it, the RV, a wall in its way
  ghPost(m, p, players) {
    if (m.st === GST.LEFT) return;
    const part = this.partners(p), asleep = m.st === GST.SLEEP || m.st === GST.DOZE, t = p.body.translation(), now = this.t;
    // a thing coming at it (thrown, rolled, shoved into it), billed once per touch: J is the momentum it
    // brings, its mass times its own speed toward the beast as it touches. Loot leaning on it, or lying there
    // as it walks or charges into it, costs nothing; a contact that keeps going is the same hit
    for (const id of part.props) {
      const q = this.get(id);
      if (!q || id === m.id) continue;
      const seen = m.hits.get(id);
      m.hits.set(id, now);
      if (seen != null && now - seen < 0.3) continue;
      const vq = this.vPre.get(id);
      if (!vq) continue;
      const qt = q.body.translation(), dx = t.x - qt.x, dy = t.y - qt.y, dz = t.z - qt.z, d = Math.hypot(dx, dy, dz) || 1;
      const v = (vq.x * dx + vq.y * dy + vq.z * dz) / d, J = q.body.mass() * v;
      if (v < GH.HIT_V || J < GH.HIT_J) continue;
      this.ghWake(m, p, qt);
      this.ghCost(m, p, Math.min(GH.COST.propCap, J * GH.COST.propJ));
    }
    if (m.hits.size > 32) for (const [id, at] of m.hits) if (now - at > 1) m.hits.delete(id);
    if (part.rv) {
      if (!m.rvTouch) {
        m.rvTouch = true;
        // a ram: what it costs goes by how fast the RV comes at it (the RV's own speed toward it: it charging
        // a parked RV, or into the back of one driving off, only winds itself)
        const rt = this.sim.rv.translation(), vr = this.vRV, nx = t.x - rt.x, nz = t.z - rt.z, nl = Math.hypot(nx, nz) || 1;
        const at = Math.max(0, (vr.x * nx + vr.z * nz) / nl);
        if (asleep) this.ghWake(m, p, rt, true);
        if (at >= 2) this.ghCost(m, p, GH.COST.rvPerMs * at);
        if (m.st === GST.CHARGE) { m.rvWoke = false; this.ghWinded(m, p, true); }
      }
    } else m.rvTouch = false;
    // a charge into a wall or the gate's bars stops it short
    if (m.st === GST.CHARGE && part.statics && this.dv(p) >= 1.5) this.ghWinded(m, p, true);
  }

  // ---- ringtails -----------------------------------------------------------------------------------------
  // Masked thieves that live in a den beside a stop. They sneak up on loot nobody is watching, snatch it,
  // run it home and pile it at the den (where it lies, a real prop, for you to take back). A den only steals
  // so much a day (PLAN cap). Grab one and it drops what it carries (day 2 on, held by one person, it bites
  // after 2 s); a shove or a good hit stuns it; the horn scatters them; the RV running one over squashes it.

  // the den a ringtail belongs to (and its record: thefts today, awake, quiet since)
  denOf(m) { return this.dens.get(m.den) || null; }

  // is this item being watched: a player on foot (not down) within the day's fear radius of it, and either
  // right next to it or facing it. Players in the RV count only right next to it.
  watched(it, players) {
    const t = it.body.translation(), fear = this.plan.fear;
    for (const q of players.values()) {
      if (!q.pos || q.ko) continue;
      const dx = t.x - q.pos.x, dz = t.z - q.pos.z, d = Math.hypot(dx, dz);
      if (q.par || q.seat != null) { if (d < 3) return true; continue; }
      if (d > fear) continue;
      if (d < 2.5) return true;
      const lx = q.look?.x ?? 0, lz = q.look?.z ?? 1, ll = Math.hypot(lx, lz) || 1;
      if ((dx * lx + dz * lz) / (d * ll) > Math.cos(Math.PI / 3)) return true;
    }
    return false;
  }

  // in the RV or on its roof (thieves leave the RV alone in Phase 1)
  inRV(t) {
    const l = this.sim.rvToLocal(t);
    return Math.abs(l.x) < 1.55 && Math.abs(l.z) < 4.3 && l.y < 3.9 && l.y > -1.6;
  }

  // what this ringtail could go for right now, best first: light loot, loose (not held, tied, in the RV or
  // in another's jaws), near the den, in sight of it, nobody watching, not already home
  rtTarget(m, p, players) {
    const den = this.denOf(m), t = p.body.translation();
    if (!den) return null;
    let best = null, bs = 0;
    // (one thief per thing: what a pal is already sneaking up on is theirs)
    const taken = new Set();
    for (const o of this.list.values()) if (o !== m && o.st === RST.SNEAK && o.target != null) taken.add(o.target);
    for (const it of this.sim.props.values()) {
      const L = LOOT[it.type];
      if (!L || L.tool || L.mob || L.mass > 15 || it.holders.size || this.sim.tied.has(it.id) || this.carriedBy.has(it.id) || this.hoard.has(it.id)) continue;
      if ((m.unreachable.get(it.id) || 0) > this.t || taken.has(it.id)) continue;
      const it_t = it.body.translation();
      // (up on a counter or a shelf: out of its reach)
      if (it_t.y - this.sim.W.heightAt(it_t.x, it_t.z) > RT.UP) continue;
      const dd = Math.hypot(it_t.x - den.x, it_t.z - den.z), dm = Math.hypot(it_t.x - t.x, it_t.z - t.z);
      if (dd > RT.RANGE || dm > RT.SEE || dd < RT.HOME_R) continue;
      if (this.inRV(it_t)) continue;
      if (!this.seenFromDen(den, it, it_t)) continue;
      if (this.watched(it, players)) continue;
      const dropped = this.droppedByDowned.get(it.id);
      const score = it.value / (8 + dm) * (dropped && dropped > this.t ? 1.5 : 1);
      if (score > bs) { bs = score; best = it.id; }
    }
    return best;
  }
  // a ray at 0.35 m from the den to the item clears the ground, the walls and the RV (cached 2 s per item)
  seenFromDen(den, it, it_t) {
    const c = den.seen.get(it.id);
    if (c && c.until > this.t) return c.ok;
    const ok = this.clear(v3(den.x, den.y + 0.35, den.z), v3(it_t.x, it_t.y + 0.05, it_t.z));
    den.seen.set(it.id, { ok, until: this.t + 2 });
    return ok;
  }

  // the legs: a horizontal velocity servo toward a point (capped at LEG_F), facing where it goes
  rtLegs(p, goal, speed, dt) {
    const t = p.body.translation(), v = p.body.linvel();
    const dx = goal ? goal.x - t.x : 0, dz = goal ? goal.z - t.z : 0, d = Math.hypot(dx, dz);
    const s = goal ? Math.min(speed, d * 3) : 0, ux = d > 1e-3 ? dx / d : 0, uz = d > 1e-3 ? dz / d : 0;
    const k = RT.MASS * RT.LEG_GAIN;
    let fx = (ux * s - v.x) * k, fz = (uz * s - v.z) * k;
    const fl = Math.hypot(fx, fz);
    if (fl > RT.LEG_F) { fx *= RT.LEG_F / fl; fz *= RT.LEG_F / fl; }
    p.body.applyImpulse(v3(fx * dt, 0, fz * dt), true);
    if (d > 0.2 && s > 0.2) p.body.setRotation(yawQ(Math.atan2(dx, dz)), true);
    return d;
  }

  rtSpawnDen(den) {
    const n = ringtailsPerDen(this.day, this.crew), rec = { ...den, thefts: 0, awake: false, quietSince: this.t, seen: new Map() };
    this.dens.set(den.id, rec);
    for (const id of den.stash || []) this.toHoard(id, den.id);
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + this.rng(), r = 0.6 + this.rng() * 0.8;
      const m = this.spawn('ringtail', den.x + Math.cos(a) * r, den.z + Math.sin(a) * r, { yaw: this.rng() * 6.28, st: RST.DEN });
      if (!m) continue;
      m.den = den.id;
      m.cd = this.t + this.cooldown();
    }
  }

  // the brain, ten times a second
  ringtail(m, p, players) {
    const S = RST, den = this.denOf(m), now = this.t, age = now - m.stAt, t = p.body.translation();
    if (!den) return;
    // a den sleeps when nobody has been near it for a while (its critters cost nothing then)
    if (!den.awakeChecked || den.awakeChecked < now) {
      den.awakeChecked = now + 0.5;
      const near = [...players.values()].some(q => q.pos && Math.hypot(q.pos.x - den.x, q.pos.z - den.z) < RT.WAKE)
        || Math.hypot(this.sim.rv.translation().x - den.x, this.sim.rv.translation().z - den.z) < RT.WAKE;
      if (near) { den.awake = true; den.quietSince = now; }
      else if (den.awake && !([...players.values()].some(q => q.pos && Math.hypot(q.pos.x - den.x, q.pos.z - den.z) < RT.SLEEP)) && now - den.quietSince > 10) den.awake = false;
    }
    // carried off too far, or into town: gone
    const fromDen = Math.hypot(t.x - den.x, t.z - den.z);
    if (m.st !== S.GONE && (fromDen > RT.KIDNAP || t.z > this.sim.W.LEN - 20)) { this.rtGone(m, p); return; }
    if (!den.awake && (m.st === S.DEN)) return;
    switch (m.st) {
      case S.DEN: {
        if (now < m.cd || den.thefts >= this.plan.cap) return;
        const tg = this.rtTarget(m, p, players);
        if (tg != null) { m.target = tg; m.goT = now; m.hops = 0; m.prog = { x: t.x, z: t.z, t: now }; this.setSt(m, S.SNEAK); }
        return;
      }
      case S.SNEAK: {
        const it = this.get(m.target);
        if (!it || it.holders.size || this.sim.tied.has(it.id) || this.carriedBy.has(it.id) || this.inRV(it.body.translation()) || this.watched(it, players)) { this.rtHome(m, false); return; }
        if (now - m.goT > RT.GIVE_UP) { m.unreachable.set(m.target, now + RT.UNREACHABLE); this.rtHome(m, false); return; }
        const mp = this.mouth(p, it.type), ip = it.body.translation();
        if (Math.hypot(mp.x - ip.x, mp.z - ip.z) < RT.REACH && Math.abs(mp.y - ip.y) < 0.8) {
          if (this.bite(m, it.id)) {
            den.thefts++;
            this.stolen.set(it.id, { den: den.id, value: it.value, at: now, mob: m.id });
            this.sim.out.push({ k: 'mob', id: m.id, s: 'steal', item: it.id, value: Math.round(it.value), type: it.type, den: den.id, poi: den.poiType });
            this.setSt(m, S.SNATCH);
          }
        }
        return;
      }
      case S.SNATCH: if (age >= 0.35) { m.goT = now; m.prog = { x: t.x, z: t.z, t: now }; this.setSt(m, S.RUN); } return;
      case S.RUN: {
        if (!this.jaws.has(m.id)) { this.rtSpook(m, p); return; }
        if (fromDen < RT.STASH_R) this.setSt(m, S.STASH);
        return;
      }
      // home: it stops and puts the thing down on the pile
      case S.STASH: {
        if (age < 0.4) return;
        const it = this.jaws.get(m.id)?.item;
        this.letGo(m.id);
        if (it != null) { this.toHoard(it, den.id); this.sim.out.push({ k: 'mob', id: m.id, s: 'stash', item: it, den: den.id }); }
        m.cd = now + this.cooldown();
        this.setSt(m, S.DEN);
        return;
      }
      case S.HELD: {
        if (!p.holders.size) { this.rtSpook(m, p); return; }
        const one = p.holders.size === 1;
        if (this.plan.bites && one && age >= RT.BITE_T) {
          const pid = [...p.holders][0];
          this.sim.release(pid);
          this.sim.out.push({ k: 'slip', id: m.id, by: pid, why: 'bite' });
          this.sim.out.push({ k: 'mob', id: m.id, s: 'bite', by: pid });
          this.rtSpook(m, p);
        } else if (!this.plan.bites && age >= RT.WRIGGLE_T) {
          for (const pid of [...p.holders]) { this.sim.release(pid); this.sim.out.push({ k: 'slip', id: m.id, by: pid, why: 'wriggle' }); }
          this.sim.out.push({ k: 'mob', id: m.id, s: 'wriggle' });
          this.rtSpook(m, p);
        }
        return;
      }
      case S.FLUNG: {
        // landed: touching something (the ground, the RV's floor, a crate) and no longer falling
        if (age > 2.5) { this.rtStun(m, p); return; }
        if (age > 0.15 && Math.abs(p.body.linvel().y) < 1.5) { const pt = this.partners(p); if (pt.statics || pt.rv || pt.props.length) this.rtStun(m, p); }
        return;
      }
      case S.STUN: if (age >= RT.STUN_T) { if (m.stuns >= RT.GONE_AFTER) this.rtGone(m, p); else this.rtSpook(m, p); } return;
      case S.SPOOK: if (age >= RT.SPOOK_T || fromDen < RT.STASH_R) { m.cd = now + this.cooldown(); this.setSt(m, S.DEN); } return;
      case S.GONE: if (fromDen < 1.5 || age > 8) this.rtVanish(m, p); return;
      case S.TRAPPED: {
        if (!this.inRV(t)) { this.rtSpook(m, p); return; }
        if (!this.sim.doorOpen && age > RT.TRAP_T) this.rtVanish(m, p, 'window');
        return;
      }
    }
  }
  // onto a den's pile (theirs now: see hoard)
  toHoard(id, den) {
    const it = this.get(id);
    if (!it) return;
    this.hoard.set(id, den);
    it.col.setCollisionGroups(GROUPS.carried);
  }
  // back to the den without loot (gave up)
  rtHome(m, spooked) { m.target = null; m.cd = this.t + this.cooldown(); this.setSt(m, spooked ? RST.SPOOK : RST.DEN); }
  rtDrop(m, p) {
    if (!this.jaws.has(m.id)) return;
    const it = this.jaws.get(m.id).item;
    this.letGo(m.id);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'drop', item: it });
  }
  rtSpook(m, p) { this.rtDrop(m, p); m.target = null; this.setSt(m, RST.SPOOK); }
  rtStun(m, p) {
    this.rtDrop(m, p);
    m.stuns = (m.stuns || 0) + 1;
    this.setSt(m, RST.STUN);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'stun' });
  }
  rtGone(m, p) { this.rtDrop(m, p); this.setSt(m, RST.GONE); }
  // it's had enough for the day: a puff, and it's gone
  rtVanish(m, p, how = 'gone') {
    this.rtDrop(m, p);
    this.sim.out.push({ k: 'gone', ids: [m.id], how });
    this.sim.removeProp(m.id);
  }

  // every step: the legs (and the TRAPPED scramble)
  rtStep(m, p, players, dt) {
    const S = RST, den = this.denOf(m);
    if (!den) return;
    const t = p.body.translation(), home = v3(den.x, den.y, den.z);
    switch (m.st) {
      case S.DEN: {
        if (!den.awake) return;
        // milling about the den
        if (!m.mill || Math.hypot(m.mill.x - t.x, m.mill.z - t.z) < 0.3 || this.t > m.millT) {
          const a = this.rng() * Math.PI * 2, r = this.rng() * 2;
          m.mill = v3(den.x + Math.cos(a) * r, den.y, den.z + Math.sin(a) * r);
          m.millT = this.t + 2 + this.rng() * 3;
        }
        this.rtLegs(p, m.mill, RT.MILL, dt);
        return;
      }
      case S.SNEAK: { const it = this.get(m.target); if (it) this.rtGo(m, p, it.body.translation(), RT.SNEAK, dt, true); return; }
      case S.SNATCH: case S.STASH: this.rtLegs(p, null, 0, dt); return;
      case S.RUN: this.rtGo(m, p, home, RT.RUN, dt, false); return;
      case S.SPOOK: case S.GONE: this.rtGo(m, p, home, RT.SPOOK, dt, true); return;
      case S.TRAPPED: {
        // out through the open door, or bouncing off the walls (knocking loose loot about)
        if (this.sim.doorOpen) this.rtLegs(p, this.sim.rvToWorld(v3(-2.2, 0, 0.35)), RT.SPOOK, dt);
        else if (this.rng() < dt * 3) p.body.applyImpulse(v3((this.rng() - 0.5) * 60, 30, (this.rng() - 0.5) * 60), true);
        return;
      }
    }
  }
  // go somewhere: stuck for 1 s, hop (never with loot in its teeth: it drops it); leashed to its den
  rtGo(m, p, goal, speed, dt, mayHop) {
    const t = p.body.translation(), den = this.denOf(m);
    if (den && Math.hypot(t.x - den.x, t.z - den.z) > RT.LEASH && m.st === RST.SNEAK) { this.rtHome(m, true); return; }
    this.rtLegs(p, goal, speed, dt);
    if (!m.prog) m.prog = { x: t.x, z: t.z, t: this.t };
    if (this.t - m.prog.t >= 1) {
      const moved = Math.hypot(t.x - m.prog.x, t.z - m.prog.z);
      m.prog = { x: t.x, z: t.z, t: this.t };
      if (moved < 0.4 && Math.hypot(goal.x - t.x, goal.z - t.z) > 1) {
        if (this.jaws.has(m.id)) { this.rtDrop(m, p); if (m.st === RST.RUN) this.rtSpook(m, p); }
        else if (mayHop && (m.hops || 0) < RT.HOPS) {
          m.hops = (m.hops || 0) + 1;
          const dx = goal.x - t.x, dz = goal.z - t.z, d = Math.hypot(dx, dz) || 1;
          p.body.applyImpulse(v3(dx / d * RT.HOP_FWD * RT.MASS, RT.HOP_UP * RT.MASS, dz / d * RT.HOP_FWD * RT.MASS), true);
        }
      }
    }
  }

  // squashed: the RV rolling over it (anything over 2 m/s with it under the floor). Returns true if so
  rtSquash(m, p) {
    if (m.st === RST.STUN || m.st === RST.GONE || Math.hypot(this.vRV.x, this.vRV.z) <= RT.SQUASH_V) return false;
    const l = this.sim.rvToLocal(p.body.translation());
    if (!(Math.abs(l.x) < 1.15 && Math.abs(l.z) < 3.8 && l.y > -1.6 && l.y < 0.4)) return false;
    this.sim.out.push({ k: 'mob', id: m.id, s: 'squash' });
    this.rtStun(m, p);
    return true;
  }
  // after the physics step: hit by something thrown (or the RV), squashed under the RV, trapped in the RV
  rtPost(m, p, players) {
    const S = RST;
    if (m.st === S.GONE) return;
    const part = this.partners(p);
    let hit = 0;
    // a hit is something moving into it (thrown, knocked flying, the RV going by): not its pals, and not
    // a thing lying there that it ran into itself
    for (const id of part.props) {
      const q = this.get(id), vq = this.vPre.get(id);
      if (!q || id === m.id || q.mob || this.carriedBy.has(id) || !vq) continue;
      if (Math.hypot(vq.x, vq.y, vq.z) >= RT.HIT_V) hit = Math.max(hit, this.dv(p));
    }
    if (part.rv && Math.hypot(this.vRV.x, this.vRV.y, this.vRV.z) >= 1) hit = Math.max(hit, this.dv(p));
    // (trapped in the RV it bounces off the walls on its own: that's no hit)
    if (m.st === S.TRAPPED) hit = 0;
    if (hit >= RT.STUN_DV && m.st !== S.STUN && m.st !== S.HELD) this.rtStun(m, p);
    else if (hit >= RT.DROP_DV && (m.st === S.RUN || m.st === S.SNATCH || m.st === S.SNEAK)) this.rtSpook(m, p);
    if (this.rtSquash(m, p)) return;
    // inside the RV (thrown in, or it hopped in): out by the door, or it squeezes out a window
    if (m.st !== S.TRAPPED && m.st !== S.HELD && m.st !== S.FLUNG) {
      const l = this.sim.rvToLocal(p.body.translation());
      if (insideRV(l.x, l.y, l.z, 0) && l.y > -0.2) { m.inSince = m.inSince ?? this.t; if (this.t - m.inSince > 1) { this.rtDrop(m, p); this.setSt(m, S.TRAPPED); this.sim.out.push({ k: 'mob', id: m.id, s: 'trapped' }); } }
      else m.inSince = null;
    }
  }

  // ---- the grumphorn -----------------------------------------------------------------------------------
  // Asleep on the road past an obstacle. What wakes it: someone on foot close by (closer if they crouch,
  // much further if they sprint), someone standing in the RV going by, the RV coming past fast, the horn,
  // or anything touching it. Then: it rises, glares at whoever is standing nearest (and in sight), fixes a
  // line at where they stand and charges down it; the first person in its horns goes flying (knocked out),
  // anyone else it brushes stumbles. Winded, it gets its breath back and looks for the next one. It has no
  // health: patience. Hits, rams, the winch and its own charges and tosses use it up; at zero it drops its
  // cowbell and walks off the road for good.

  bedFor(m) { return m.bed; }
  // where a grumphorn put down somewhere walks off to when it's had enough: flat ground off the road (as world
  // gen picks for its beds)
  exitNear(x, z) {
    const W = this.sim.W, ez = z + 6;
    for (const off of [8, 9, 7.5, 10, 12, 16, 22]) for (const sd of [1, -1]) {
      const ex = W.roadX(ez) + sd * off, h = W.heightAt(ex, ez);
      if (Math.abs(h - W.roadY(ez)) > 1.5) continue;
      let sl = 0;
      for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) sl = Math.max(sl, Math.abs(W.heightAt(ex + dx, ez + dz) - h) / 1.2);
      if (sl <= 0.36) return { x: ex, y: h, z: ez };
    }
    return { x: x + 8, y: W.heightAt(x + 8, z), z };
  }

  // how close counts as "next to it": the distance from its body's middle line (it's 2.9 m long)
  ghDist(p, pos) {
    const t = p.body.translation(), yaw = yawOf(p.body.rotation());
    const fx = Math.sin(yaw), fz = Math.cos(yaw), dx = pos.x - t.x, dz = pos.z - t.z;
    const along = Math.max(-GH.HH, Math.min(GH.HH, dx * fx + dz * fz));
    return Math.hypot(dx - fx * along, dz - fz * along);
  }
  // anyone down nearby, and anyone kneeling over them, is left alone (KO'd players, and revivers)
  nearDowned(pos, players) {
    for (const q of players.values()) if (q.ko && q.pos && Math.hypot(q.pos.x - pos.x, q.pos.z - pos.z) < GH.REVIVE_SAFE) return true;
    return false;
  }
  onFoot(q) { return q.pos && !q.ko && !q.par && q.seat == null; }

  // what (if anything) wakes it this tick: { at: where the noise came from, rv: it was the RV }, or null
  ghWaker(m, p, players) {
    const sim = this.sim;
    for (const q of players.values()) {
      if (!q.pos || q.ko || q.seat != null) continue;
      const d = this.ghDist(p, q.pos), crouch = (q.flags & FLAG.CROUCH) !== 0, sprint = (q.flags & FLAG.SPRINT) !== 0;
      // (in the RV only someone standing counts: crouched or seated riders never do)
      if (q.par) { if (!crouch && q.mode === MODE.WALK && d < GH.WAKE_RIDER) return { at: v3(q.pos.x, q.pos.y, q.pos.z), rv: false }; continue; }
      if (d < (sprint ? GH.WAKE_SPRINT : crouch ? GH.WAKE_CROUCH : GH.WAKE_FOOT)) return { at: v3(q.pos.x, q.pos.y, q.pos.z), rv: false };
    }
    const rt = sim.rv.translation(), rv = sim.rv.linvel();
    if (Math.hypot(rv.x, rv.z) > GH.WAKE_RV_V && this.ghDist(p, rt) < GH.WAKE_RV) return { at: v3(rt.x, rt.y, rt.z), rv: true };
    if (sim.hook.attach?.id === m.id) return { at: sim.winchWorld(), rv: true };
    return null;
  }

  // who it goes for: the nearest player on foot it can see (standing; or crouched right next to it), else
  // the RV if it's close and moving (or what woke it)
  ghTarget(m, p, players) {
    const t = p.body.translation(), eye = v3(t.x, t.y + 0.3, t.z);
    let best = null, bd = GH.SEE;
    for (const q of players.values()) {
      if (!this.onFoot(q)) continue;
      const d = Math.hypot(q.pos.x - t.x, q.pos.z - t.z), crouch = (q.flags & FLAG.CROUCH) !== 0;
      if (d >= bd || (crouch && this.ghDist(p, q.pos) > GH.WAKE_CROUCH)) continue;
      if (this.nearDowned(q.pos, players)) continue;
      if (m.grace && this.t < m.grace.t && Math.hypot(q.pos.x - m.grace.x, q.pos.z - m.grace.z) < GH.GRACE_R) continue;
      if (!this.clear(eye, v3(q.pos.x, q.pos.y + 1, q.pos.z))) continue;
      bd = d; best = { kind: 'player', id: q.id };
    }
    if (best) return best;
    const rt = this.sim.rv.translation(), rv = this.sim.rv.linvel();
    if (Math.hypot(rt.x - t.x, rt.z - t.z) < GH.SEE && (Math.hypot(rv.x, rv.z) > 1 || m.rvWoke) && this.clear(eye, v3(rt.x, rt.y, rt.z), this.sim.rv)) return { kind: 'rv' };
    return null;
  }
  targetPos(tg, players) {
    if (!tg) return null;
    if (tg.kind === 'rv') return this.sim.rv.translation();
    const q = players.get(tg.id);
    return q && this.onFoot(q) ? q.pos : null;
  }

  ghWake(m, p, from, rvWoke = false) {
    if (m.st !== GST.SLEEP && m.st !== GST.DOZE) return;
    m.noise = from ? v3(from.x, from.y, from.z) : null;
    m.rvWoke = rvWoke;
    p.col.setFriction(0);
    this.setSt(m, GST.RISE);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'wake' });
  }

  // patience: hits, rams, the winch, its own charges and tosses. Gone: it leaves (for good)
  ghCost(m, p, n) {
    if (m.st === GST.LEAVE || m.st === GST.LEFT || n <= 0) return;
    m.patience -= n * (m.st === GST.WINDED ? GH.COST.windedX : 1);
    const mood = m.patience < 0.4 * m.patienceMax;
    if (mood !== m.mood) { m.mood = mood; this.wake(p); }
    if (m.patience <= 0) this.ghLeave(m, p);
  }
  ghLeave(m, p) {
    for (const pid of [...p.holders]) { this.sim.release(pid); this.sim.out.push({ k: 'slip', id: m.id, by: pid }); }
    p.col.setFriction(0);
    this.setSt(m, GST.LEAVE);
    m.mood = false;
    // its cowbell drops where it stood: ordinary loot, beside it (on its exit's far side, clear of where it
    // slides to a stop and walks off)
    const t = p.body.translation(), yaw = yawOf(p.body.rotation()), ex = m.bed?.exit;
    let sx = Math.cos(yaw), sz = -Math.sin(yaw);
    if (ex && sx * (ex.x - t.x) + sz * (ex.z - t.z) > 0) { sx = -sx; sz = -sz; }
    const bx = t.x + sx * 1.5, bz = t.z + sz * 1.5;
    const at = v3(bx, this.sim.W.heightAt(bx, bz) + 0.3, bz);
    const val = cowbellValue(this.day);
    const bell = this.sim.addProp('cowbell', at, yawQ(yaw), val, val);
    if (bell) this.sim.out.push({ k: 'spawn', p: this.sim.describe(bell) });
    this.sim.out.push({ k: 'mob', id: m.id, s: 'leave', bell: bell?.id ?? null, value: val });
  }

  // legs: a horizontal velocity servo, capped at LEG_G of its weight (half speed in the mud)
  ghLegs(p, dx, dz, speed, dt) {
    const t = p.body.translation(), v = p.body.linvel();
    if (inMud(this.sim.W, t.x, t.z)) speed *= GH.MUD;
    const k = GH.MASS * GH.LEG_GAIN, F = GH.MASS * 9.81 * GH.LEG_G;
    let fx = (dx * speed - v.x) * k, fz = (dz * speed - v.z) * k;
    const fl = Math.hypot(fx, fz);
    if (fl > F) { fx *= F / fl; fz *= F / fl; }
    p.body.applyImpulse(v3(fx * dt, 0, fz * dt), true);
  }
  // turn toward a heading, at most rate rad/s
  face(p, yaw, rate, dt) {
    const cur = yawOf(p.body.rotation());
    let d = yaw - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const ny = cur + Math.max(-rate * dt, Math.min(rate * dt, d));
    p.body.setRotation(yawQ(ny), true);
    p.body.setAngvel(v3(), true);
  }

  // the brain, ten times a second
  grumphorn(m, p, players) {
    const S = GST, now = this.t, age = now - m.stAt, t = p.body.translation();
    const bed = this.bedFor(m);
    if (m.st === S.LEFT) return;
    if (m.st === S.LEAVE) {
      const ex = bed.exit || v3(bed.x + 8, bed.y, bed.z);
      if (Math.hypot(ex.x - t.x, ex.z - t.z) < 1 || age > 30) {
        // down for good, right here (it doesn't slide on into the road)
        this.setSt(m, S.LEFT); p.col.setFriction(0.9);
        const v = p.body.linvel(); p.body.setLinvel(v3(0, Math.min(0, v.y), 0), true);
        this.sim.out.push({ k: 'mob', id: m.id, s: 'left' });
      }
      return;
    }
    // the winch reeling it in costs patience by the second (and wakes it)
    if (this.sim.hook.attach?.id === m.id && this.sim.hook.reeling) this.ghCost(m, p, GH.COST.winchPerS * 0.1);
    if (m.st === S.LEAVE || m.st === S.LEFT) return;
    if (m.st === S.SLEEP || m.st === S.DOZE) {
      const w = this.ghWaker(m, p, players);
      if (w) { this.ghWake(m, p, w.at, w.rv); return; }
      if (m.st === S.DOZE && Math.hypot(bed.x - t.x, bed.z - t.z) < 1.5) { this.setSt(m, S.SLEEP); p.col.setFriction(0.9); }
      return;
    }
    if (m.st === S.HELD) {
      if (!p.holders.size) { this.ghNext(m, p, players); return; }
      if (age >= GH.HELD_T) this.ghShake(m, p);
      return;
    }
    if (m.st === S.RISE) { if (age >= GH.RISE_T) this.ghNext(m, p, players); return; }
    if (m.st === S.GLARE) {
      const tp = this.targetPos(m.target, players);
      if (!tp) { this.ghNext(m, p, players); return; }
      if (age >= (this.plan?.glare || 1.0)) {
        const dx = tp.x - t.x, dz = tp.z - t.z, d = Math.hypot(dx, dz) || 1;
        m.line = { x: dx / d, z: dz / d };
        m.from = v3(t.x, t.y, t.z);
        m.tossed = false;
        this.setSt(m, S.CHARGE);
        this.ghCost(m, p, GH.COST.charge);
        this.sim.out.push({ k: 'mob', id: m.id, s: 'charge' });
      }
      return;
    }
    if (m.st === S.CHARGE) {
      if (age >= GH.CHARGE_T || Math.hypot(t.x - m.from.x, t.z - m.from.z) >= GH.CHARGE_D) this.ghWinded(m, p, false);
      return;
    }
    if (m.st === S.WINDED) {
      if (age >= m.windT) this.ghNext(m, p, players);
      return;
    }
    if (m.st === S.ROAM) {
      const tg = this.ghTarget(m, p, players);
      if (tg) { m.target = tg; this.setSt(m, S.GLARE); this.sim.out.push({ k: 'mob', id: m.id, s: 'glare' }); return; }
      if (age >= GH.DOZE_T) { this.setSt(m, S.DOZE); m.noise = null; }
      return;
    }
  }
  // done with what it was doing: someone to go for, or wander
  ghNext(m, p, players) {
    const tg = this.ghTarget(m, p, players);
    if (tg) { m.target = tg; this.setSt(m, GST.GLARE); this.sim.out.push({ k: 'mob', id: m.id, s: 'glare' }); }
    else { m.target = null; this.setSt(m, GST.ROAM); }
  }
  ghWinded(m, p, hard) {
    m.windT = hard ? GH.WINDED_HIT_T : GH.WINDED_T;
    this.setSt(m, GST.WINDED);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'winded' });
  }
  // grabbed by the horns too long: it shakes them off (a stumble, and the grip is gone)
  ghShake(m, p) {
    const t = p.body.translation();
    for (const pid of [...p.holders]) {
      const q = this.players?.get(pid);
      this.sim.release(pid);
      this.sim.out.push({ k: 'slip', id: m.id, by: pid });
      if (q?.pos) {
        const dx = q.pos.x - t.x, dz = q.pos.z - t.z, d = Math.hypot(dx, dz) || 1;
        this.sim.out.push({ k: 'knock', id: pid, v: [r3(dx / d * GH.STUMBLE_V), 2, r3(dz / d * GH.STUMBLE_V)], ko: false, why: 'mob', rel: q.par ? 1 : 0 });
      }
    }
  }

  // every step: the legs (and the toss during a charge)
  ghStep(m, p, players, dt) {
    const S = GST, t = p.body.translation(), bed = this.bedFor(m);
    switch (m.st) {
      case S.SLEEP: case S.LEFT: return;
      case S.DOZE: {
        const dx = bed.x - t.x, dz = bed.z - t.z, d = Math.hypot(dx, dz);
        if (d > 0.6) { this.face(p, Math.atan2(dx, dz), 2, dt); this.ghLegs(p, dx / d, dz / d, GH.ROAM, dt); }
        else { this.face(p, bed.ry, 1, dt); this.ghLegs(p, 0, 0, 0, dt); }
        return;
      }
      case S.LEAVE: {
        const ex = bed.exit || v3(bed.x + 8, bed.y, bed.z), dx = ex.x - t.x, dz = ex.z - t.z, d = Math.hypot(dx, dz) || 1;
        this.face(p, Math.atan2(dx, dz), 2, dt);
        this.ghLegs(p, dx / d, dz / d, d > 0.5 ? GH.LEAVE : 0, dt);
        return;
      }
      case S.RISE: case S.WINDED: case S.HELD: this.ghLegs(p, 0, 0, 0, dt); return;
      case S.GLARE: {
        const tp = this.targetPos(m.target, players);
        if (tp) this.face(p, Math.atan2(tp.x - t.x, tp.z - t.z), 3, dt);
        this.ghLegs(p, 0, 0, 0, dt);
        return;
      }
      case S.ROAM: {
        // toward the noise; leashed to its bed
        const far = Math.hypot(bed.x - t.x, bed.z - t.z) > GH.LEASH;
        const goal = far || !m.noise ? bed : m.noise, dx = goal.x - t.x, dz = goal.z - t.z, d = Math.hypot(dx, dz);
        if (d > 1.5) { this.face(p, Math.atan2(dx, dz), 2, dt); this.ghLegs(p, dx / d, dz / d, GH.ROAM, dt); }
        else { if (goal === m.noise) m.noise = null; this.ghLegs(p, 0, 0, 0, dt); }
        return;
      }
      case S.CHARGE: {
        this.face(p, Math.atan2(m.line.x, m.line.z), 6, dt);
        this.ghLegs(p, m.line.x, m.line.z, GH.CHARGE, dt);
        this.ghToss(m, p, players);
        return;
      }
    }
  }

  // the horns: the first person on foot in front of it this charge goes flying (knocked out); anyone else it
  // hits, or brushes with its flank, stumbles. Riders aren't tossed: the RV takes the hit
  ghToss(m, p, players) {
    const v = p.body.linvel();
    if (Math.hypot(v.x, v.z) < 3) return;
    const t = p.body.translation(), q0 = p.body.rotation();
    for (const q of players.values()) {
      if (!this.onFoot(q) || (this.sim.knockCd.get(q.id) || 0) > this.t || this.nearDowned(q.pos, players)) continue;
      const l = toLocal(t, q0, q.pos);
      if (l.y < -1.2 || l.y > 2.0) continue;
      const horns = l.z >= 0.6 && l.z <= 2.4 && Math.abs(l.x) <= 1.25;
      const flank = !horns && l.z > -1.45 && l.z < 0.6 && Math.abs(l.x) <= 1.15;
      if (!horns && !flank) continue;
      this.sim.knockCd.set(q.id, this.t + 1.5);
      if (horns && !m.tossed) {
        m.tossed = true;
        const kv = [r3(m.line.x * GH.TOSS_V + v.x * 0.4), r3(GH.TOSS_UP), r3(m.line.z * GH.TOSS_V + v.z * 0.4)];
        this.sim.out.push({ k: 'knock', id: q.id, v: kv, ko: true, why: 'mob' });
        this.sim.out.push({ k: 'mob', id: m.id, s: 'toss', by: q.id });
        m.grace = { x: q.pos.x, z: q.pos.z, t: this.t + GH.GRACE_T };
        m.tosses = (m.tosses || 0) + 1;
        this.ghCost(m, p, GH.COST.toss);
        if (m.st === GST.CHARGE) this.ghWinded(m, p, false);
      } else {
        const dx = l.x >= 0 ? 1 : -1, side = qRotate(q0, v3(dx, 0, 0));
        const kv = horns ? [r3(m.line.x * GH.STUMBLE_V), 2, r3(m.line.z * GH.STUMBLE_V)] : [r3(side.x * GH.STUMBLE_V), 2, r3(side.z * GH.STUMBLE_V)];
        this.sim.out.push({ k: 'knock', id: q.id, v: kv, ko: false, why: 'mob' });
      }
    }
  }

  // what a critter is touching right now (a live contact, not just overlapping boxes): the RV, the solid
  // world, and which props
  partners(p) {
    const out = { rv: false, statics: false, props: [] }, w = this.sim.world, rv = this.sim.rv.handle;
    w.contactPairsWith(p.col, c2 => {
      if (!c2) return;
      let live = false;
      w.contactPair(p.col, c2, man => { if (man.numContacts() > 0) live = true; });
      if (!live) return;
      const id = this.sim.byCollider.get(c2.handle);
      if (id != null) out.props.push(id);
      else if (c2.parent()?.handle === rv) out.rv = true;
      else out.statics = true;
    });
    return out;
  }
  // how much a body's velocity changed in the last step (gravity's share taken out)
  dv(p) {
    const a = this.vPre.get(p.id);
    if (!a) return 0;
    const b = p.body.linvel();
    return Math.hypot(b.x - a.x, b.y - a.y + 9.81 * this.sim.world.timestep, b.z - a.z);
  }
  // nothing solid (the ground, walls, the RV) between a and b
  // (except: a body that doesn't count, e.g. the RV's own shell round its middle when it's the RV in sight)
  clear(a, b, except = undefined) {
    const d = v3(b.x - a.x, b.y - a.y, b.z - a.z), L = Math.hypot(d.x, d.y, d.z);
    if (L < 0.3) return true;
    return !this.sim.world.castRay(new RAPIER.Ray(a, v3(d.x / L, d.y / L, d.z / L)), L - 0.3, true, undefined, GROUPS.solid, undefined, except);
  }
}

export { r3, yawQ };
