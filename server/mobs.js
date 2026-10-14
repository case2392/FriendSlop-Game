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
import { RT, GH, RF, PLAN, GST, RST, ST_CARRY, ST_MOOD, crewFactor, cowbellValue, ringtailsPerDen, hoardRingtails } from '../shared/mobs.js';
import { FLAG, MODE, RVH, beastDamage } from '../shared/constants.js';
import { toLocal, qRotate, insideRV, RV_DIM } from '../shared/rv.js';
import { inMud, bedExit } from '../shared/world.js';
import { mulberry32 } from '../shared/rng.js';
import { GROUPS, looseGroup } from './groups.js';

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

// does the segment a-b pass through the rectangle [x0, x1] x [z0, z1] (on x and z)? (Liang-Barsky)
function segRect(a, b, x0, x1, z0, z1) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dz, a.z - z0], [dz, z1 - a.z]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

export class Mobs {
  // day: today (1..5); crew: how many play (scales the cast and the grumphorn's patience); seed: the run's
  // tier: the loan terms ('bad': Bad Credit's tougher wildlife, below)
  constructor(sim, { day = 1, crew = 1, seed = 0, tier = 'std' } = {}) {
    this.sim = sim;
    this.day = Math.max(1, Math.min(5, day | 0));
    this.crew = Math.max(1, crew | 0);
    this.rng = mulberry32((seed ^ Math.imul(this.day + 97, 0x2545F491)) >>> 0);   // never Math.random: a test replays a day exactly
    this.list = new Map();          // prop id -> Mob
    this.jaws = new Map();          // critter id -> { item: prop id }
    this.carriedBy = new Map();     // item id -> critter id
    this.vPre = new Map();          // prop id -> its velocity right before the physics step (hits are read from the change)
    this.vRV = v3();                // the RV's, likewise
    // BAD CREDIT: each den may steal one more a day, ringtails are 15% quicker, a Grumphorn glares 0.1 s
    // less and has 20% more patience, and loose rock rumbles 1.0 s before it falls (from 1.5)
    this.bad = tier === 'bad';
    const P = PLAN[this.day - 1];
    this.plan = this.bad ? { ...P, cap: P.cap + 1, glare: P.glare ? P.glare - 0.1 : 0 } : P;
    this.rtK = this.bad ? 1.15 : 1;
    this.dens = new Map();          // den id -> { ...world gen's den, thefts today, awake, seen (line-of-sight cache) }
    this.stolen = new Map();        // item id -> { den, value, at }: taken by ringtails and not yet got back
    this.hoard = new Map();         // item id -> den id: piled at a den (its stash, and what was brought home). Theirs
                                    // till a player picks it up: they don't steal it again from each other, and
                                    // step over it (it doesn't collide with critters: milling about the den would
                                    // nudge the pile apart)
    this.droppedByDowned = new Map();   // item id -> until when: let go of by someone knocked out (a ringtail's favourite)
    this.sold = new Set();          // items sold this step (a stolen thing sold counts as got back; broken doesn't)
    this.recT = 0;
    this.rockfalls = [];            // the day's loose rock up on the narrows' rims (rfArm)
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
    // a den's Road Card tin is on its pile: theirs till somebody picks it up
    for (const [id, s] of this.sim.finds || []) if (s.den != null && this.dens.has(s.den)) this.toHoard(id, s.den);
    this.rockfalls = (this.sim.W.rockfalls || []).map(r => this.rfArm(r));
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
      m.patienceMax = m.patience = GH.PATIENCE * crewFactor(this.crew) * (this.bad ? 1.2 : 1);
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
      if (Math.hypot(mp.x - ip.x, mp.y - ip.y, mp.z - ip.z) > RT.JAW_SLIP) { this.balk(mid, j.item); this.letGo(mid); lost.push(mid); }
    }
    return lost;
  }

  // it couldn't get that home (stuck with it, or it snagged out of its jaws): its den leaves it be a while
  // (else they took it again and again, and lost it at the same spot every time)
  balk(mid, itemId) {
    const m = this.list.get(mid), den = m && this.denOf(m);
    if (den) (den.balk ||= new Map()).set(itemId, this.t + RT.UNREACHABLE);
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
      it.col.setCollisionGroups(looseGroup(it.type));
      if (!it.holders.size) it.body.setAngularDamping(LOOT[it.type]?.adamp ?? 0.3);
      it.body.wakeUp();
    }
  }

  // ---- what players do to them (Sim calls these) -------------------------------------------------------

  onGrabbed(p, pid) {
    const m = p.mob;
    // a player took hold of what a ringtail carries: three times its grip, the jaws let go
    if (!m) {
      if (this.hoard.delete(p.id)) p.col.setCollisionGroups(looseGroup(p.type));
      if (this.stolen.get(p.id)?.ours === false) this.stolen.delete(p.id);
      const mid = this.carriedBy.get(p.id), c = mid != null ? this.list.get(mid) : null;
      if (c) { const cp = this.get(c.id); if (cp) this.rtSpook(c, cp); }
      return;
    }
    this.wake(p);
    if (m.type === 'ringtail') {
      // (off for good already: it can be carried about, but it's going all the same)
      if (m.st === RST.GONE) return;
      // caught: it lets go of what it stole at once, and squirms (a second pair of hands: it squirms on)
      this.rtDrop(m, p);
      m.target = null;
      if (m.st !== RST.HELD) { m.soloAt = p.holders.size > 1 ? null : this.t; this.setSt(m, RST.HELD); }
      return;
    }
    if (m.type === 'grumphorn') {
      // (its mind is made up once it glares: a hand on its horns doesn't stop the charge, or the toss)
      if (m.st === GST.LEAVE || m.st === GST.LEFT || m.st === GST.GLARE || m.st === GST.CHARGE || m.st === GST.TIPPED) return;
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
    if (m.type === 'ringtail' && m.st === RST.HELD) {
      if (!p.holders.size) { if (thrown) this.setSt(m, RST.FLUNG); else this.rtLoose(m, p); }
      else if (p.holders.size === 1) m.soloAt = this.t;
    }
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
    } else if (m.type === 'grumphorn') {
      if (m.st === GST.TIPPED) return;
      // asleep and shoved on its flank, it stirs (a moment before it's up): a second friend's shove on the
      // flank in that moment tips it over (the brain wakes it if nobody does)
      if ((m.st === GST.SLEEP || m.st === GST.DOZE) && this.ghFlank(p, fx, fz)) {
        if (m.stir && this.t - m.stir.t <= GH.TIP_WIN && m.stir.by !== pl.id) { m.stir = null; this.ghTip(m, p, fx, fz); }
        else if (!m.stir || this.t - m.stir.t > GH.TIP_WIN) m.stir = { t: this.t, by: pl.id, at: pl.pos ? v3(pl.pos.x, pl.pos.y, pl.pos.z) : null };
      } else { this.ghWake(m, p, pl.pos); this.ghCost(m, p, GH.COST.shove); }
    }
    this.wake(p);
  }
  // a shove along (fx, fz) side-on to it (not at its head or its rump)
  ghFlank(p, fx, fz) {
    const yaw = yawOf(p.body.rotation());
    return Math.abs(fx * Math.sin(yaw) + fz * Math.cos(yaw)) < GH.FLANK * Math.hypot(fx, fz);
  }
  // over it goes, on its side, legs in the air: TIP_T s to get by, and then it's up (and not best pleased)
  ghTip(m, p, fx, fz) {
    for (const pid of [...p.holders]) { this.sim.release(pid); this.sim.out.push({ k: 'slip', id: m.id, by: pid }); }
    const yaw = yawOf(p.body.rotation());
    m.tipSide = Math.sign(fx * Math.cos(yaw) - fz * Math.sin(yaw)) || 1;   // (which way it fell: its right, or left)
    p.col.setFriction(0.9);
    this.setSt(m, GST.TIPPED);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'tip', side: m.tipSide });
    this.ghCost(m, p, GH.COST.tip);
    // a Road Card tin falls out of its fur (once a beast), on the side it fell away from
    if (!m.furGiven) {
      m.furGiven = true;
      const t = p.body.translation(), sx = -Math.cos(yaw) * m.tipSide, sz = Math.sin(yaw) * m.tipSide;
      const x = t.x + sx * 1.5, z = t.z + sz * 1.5;
      const tin = this.sim.addProp('tin', v3(x, this.sim.W.heightAt(x, z) + 0.3, z), yawQ(yaw), 0, 0);
      if (tin) this.sim.out.push({ k: 'spawn', p: this.sim.describe(tin), fur: m.id });
    }
  }
  // the driver leaned on the horn (where the RV is): any grumphorn in earshot wakes, and goes for the RV; loose
  // rock up ahead comes down (early: on nobody, if they had the sense to honk well back). k: how far it
  // carries (an Air Horn fitted: x1.25 or x1.5, every one of these reaches, both ways)
  horn(at, k = 1) {
    for (const r of this.rockfalls) if (r.st === 'armed' && Math.hypot(at.x - this.sim.W.roadX(r.obz), at.z - r.obz) < RF.HONK_R * k) this.rfTrigger(r, 'horn');
    for (const m of [...this.list.values()]) {
      const p = this.get(m.id);
      if (!p) continue;
      if (m.type === 'grumphorn') { if (this.ghDist(p, at) < GH.WAKE_HORN * k) this.ghWake(m, p, at, true); continue; }
      // ringtails near the RV drop what they carry and scatter (then pay the horn no mind for a while)
      const t = p.body.translation();
      if (Math.hypot(t.x - at.x, t.z - at.z) > RT.HORN_R * k || (m.deafUntil || 0) > this.t) continue;
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
    if (this.rockfalls.length) this.rocksStep(players);
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
      // taken in a raid and it never got out of the RV (it lost its grip in the doorway): no theft after all
      if (st.raid && !st.left) {
        if (!inRV) this.raidOut(id, st);
        else {
          if (this.t - st.at > 2) { this.stolen.delete(id); if (den) den.thefts = Math.max(0, den.thefts - 1); }
          continue;
        }
      }
      const held = it.holders.size && den && Math.hypot(t.x - den.x, t.z - den.z) > 10;
      if (inRV || held) {
        this.stolen.delete(id);
        if (this.hoard.delete(id)) it.col.setCollisionGroups(looseGroup(it.type));
        if (st.ours) this.sim.out.push({ k: 'mob', id: st.mob, s: 'recovered', item: id, value: Math.round(it.value) });
      }
    }
  }
  // what the ringtails hold of yours right now (the tracker's "Ringtails have $X of your stuff")
  stolenValue() { let v = 0; for (const [id, st] of this.stolen) { const it = this.get(id); if (it && st.ours && st.left) v += it.value; } return Math.round(v); }
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
        // (along the ground, across where they touch: the contact's normal, pointed from the RV at the beast;
        // the line between their middles only when the touch is on its roof or under it. A front corner
        // brushing past its flank closes slowly across the touch, however fast the RV goes)
        const rt = this.sim.rv.translation(), vr = this.vRV, N = part.rvN;
        let nx = t.x - rt.x, nz = t.z - rt.z;
        if (N && Math.hypot(N.x, N.z) > 0.3) { const s = N.x * nx + N.z * nz < 0 ? -1 : 1; nx = N.x * s; nz = N.z * s; }
        const nl = Math.hypot(nx, nz) || 1;
        // a ram: what it costs goes by how fast the RV comes at it (the RV's own speed toward it: it charging
        // a parked RV, or into the back of one driving off, only winds itself)
        const at = Math.max(0, (vr.x * nx + vr.z * nz) / nl);
        // and what it costs the RV: how fast they close, just before they touched (the RV toward it, less
        // the RV away from it): a charge into a parked RV dents it, one into the back of an RV driving off
        // at 5 m/s closes at only 2 m/s, and doesn't
        const vb = this.vPre.get(m.id) || v3(), closing = Math.max(0, ((vr.x - vb.x) * nx + (vr.z - vb.z) * nz) / nl);
        if (closing >= RVH.GH_FREE) {
          const l = this.sim.rvToLocal(t), zone = l.z > 2.5 ? 'front' : l.z < -2.5 ? 'rear' : l.x > 0 ? 'left' : 'right';
          this.sim.out.push({ k: 'rvhit', why: 'beast', amt: beastDamage(closing), zone, how: m.st === GST.CHARGE ? 'charge' : 'ram', at: [r3(t.x), r3(t.y + 0.8), r3(t.z)] });
        }
        if (asleep) this.ghWake(m, p, rt, true);
        if (at >= 2) this.ghCost(m, p, GH.COST.rvPerMs * at);
        if (m.st === GST.CHARGE) { m.rvWoke = false; this.ghWinded(m, p, true); }
      }
    } else m.rvTouch = false;
    // a charge into a wall or the gate's bars stops it short (along the ground: a fold in the road it runs
    // over bumps it up, which is no wall)
    if (m.st === GST.CHARGE && part.statics && this.dv(p, true) >= 1.5) this.ghWinded(m, p, true);
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
      if (!L || (L.tool && !L.bait) || L.mob || L.mass > 15 || it.holders.size || this.sim.tied.has(it.id) || this.carriedBy.has(it.id) || this.hoard.has(it.id)) continue;
      if ((m.unreachable.get(it.id) || 0) > this.t || (den.balk?.get(it.id) || 0) > this.t || taken.has(it.id)) continue;
      const it_t = it.body.translation();
      // (up on a counter or a shelf: out of its reach)
      if (it_t.y - this.sim.W.heightAt(it_t.x, it_t.z) > RT.UP) continue;
      const dd = Math.hypot(it_t.x - den.x, it_t.z - den.z), dm = Math.hypot(it_t.x - t.x, it_t.z - t.z);
      if (dd > RT.RANGE || dm > RT.SEE || dd < RT.HOME_R) continue;
      if (this.inRV(it_t)) continue;
      if (!this.seenFromDen(den, it, it_t)) continue;
      if (this.watched(it, players)) continue;
      const dropped = this.droppedByDowned.get(it.id);
      const score = (L.bait ? RT.BAIT_V : L.find ? RT.SHINY_V : it.value) / (8 + dm) * (dropped && dropped > this.t ? 1.5 : 1);
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
  // base: the velocity of what it stands on (inside the RV, the RV's: it walks on the floor, not the road)
  rtLegs(p, goal, speed, dt, base = null) {
    const t = p.body.translation(), v = p.body.linvel();
    const dx = goal ? goal.x - t.x : 0, dz = goal ? goal.z - t.z : 0, d = Math.hypot(dx, dz);
    const s = goal ? Math.min(speed, d * 3) : 0, ux = d > 1e-3 ? dx / d : 0, uz = d > 1e-3 ? dz / d : 0;
    const k = RT.MASS * RT.LEG_GAIN;
    let fx = (ux * s + (base?.x || 0) - v.x) * k, fz = (uz * s + (base?.z || 0) - v.z) * k;
    const fl = Math.hypot(fx, fz);
    if (fl > RT.LEG_F) { fx *= RT.LEG_F / fl; fz *= RT.LEG_F / fl; }
    p.body.applyImpulse(v3(fx * dt, 0, fz * dt), true);
    if (d > 0.2 && s > 0.2) p.body.setRotation(yawQ(Math.atan2(dx, dz)), true);
    return d;
  }

  rtSpawnDen(den) {
    const n = den.hoard ? hoardRingtails(this.crew) : ringtailsPerDen(this.day, this.crew), rec = { ...den, thefts: 0, awake: false, quietSince: this.t, seen: new Map() };
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
        // a stranger at the den (day 2 on): seen off with a nip
        if (this.plan.bites && now >= (m.nipCd || 0)) {
          const q = this.rtNipTarget(den, players);
          if (q) { m.nipAt = q.id; this.setSt(m, S.NIP); return; }
        }
        // (the day's cap counts those of the den already out after something: sneaking up, or off to the RV)
        if (now < m.cd) return;
        let out = 0;
        for (const o of this.list.values()) if (o.den === den.id && (o.st === S.SNEAK || o.st === S.RAID || (o.st === S.INRV && !this.jaws.has(o.id)))) out++;
        if (den.thefts + out >= this.plan.cap) return;
        const tg = this.rtTarget(m, p, players);
        if (tg != null) { m.target = tg; m.way = null; m.goT = now; m.hops = 0; m.prog = { x: t.x, z: t.z, t: now }; this.setSt(m, S.SNEAK); return; }
        // nothing loose about: the RV, if it's been left open
        const rt = this.rtRaidTarget(den, players);
        if (rt != null) {
          // (the time it has: the walk to the door, and RAID_T s there to get in)
          const f = this.sim.rvToWorld(v3(-2.75, 0, RV_DIM.DOOR_Z));
          m.target = rt; m.way = den.rway.way.map(q => ({ ...q })); m.goT = now; m.raidBy = now + RT.RAID_T + Math.hypot(f.x - t.x, f.z - t.z) / (RT.SNEAK * this.rtK);
          m.hops = 0; m.prog = { x: t.x, z: t.z, t: now };
          m.hopped = false; m.leave = false; m.outHop = false; this.setSt(m, S.RAID);
        }
        return;
      }
      // off to the RV left open: the door, a hop up the steps (rtStep), then inside (INRV)
      case S.RAID: {
        const it = this.get(m.target);
        if (!it || it.holders.size || this.sim.tied.has(it.id) || !this.sim.doorOpen || Math.abs(this.sim.rvSpeed()) > 0.5 || this.doorGuarded(players) || now > m.raidBy) {
          if (!m.hopped) this.rtHome(m, false);
        }
        return;
      }
      // inside the RV: snatch it, then back out through the door (rtStep). The door shut: trapped; the RV
      // driving off, or it can't get at the thing: out, with or without it
      case S.INRV: {
        if (!this.sim.doorOpen) { this.rtDrop(m, p); this.setSt(m, S.TRAPPED); this.sim.out.push({ k: 'mob', id: m.id, s: 'trapped' }); return; }
        const it = this.get(m.target);
        // (the RV driving off: it lets go of what it took and bails out, the crew's loot still aboard)
        if (Math.abs(this.sim.rvSpeed()) > 1) { this.rtDrop(m, p); m.leave = true; }
        if (now > m.raidBy + 10 || (!this.jaws.has(m.id) && (!it || it.holders.size || this.sim.tied.has(it.id)))) m.leave = true;
        if (!this.jaws.has(m.id) && !m.leave && it) {
          const mp = this.mouth(p, it.type), ip = it.body.translation();
          if (Math.hypot(mp.x - ip.x, mp.z - ip.z) < RT.REACH && Math.abs(mp.y - ip.y) < 0.8 && this.bite(m, it.id)) {
            this.rtTake(m, it, den, true);
            m.leave = true; m.biteT = now;
          }
        }
        return;
      }
      // seeing off a stranger: the nip itself is in rtStep
      case S.NIP: {
        const q = players.get(m.nipAt);
        if (!this.nippable(q) || Math.hypot(q.pos.x - den.x, q.pos.z - den.z) > RT.NIP_R + 2 || this.nearDowned(q.pos, players) || age > 4) { m.nipCd = now + 1; this.setSt(m, S.SPOOK); }
        return;
      }
      case S.SNEAK: {
        const it = this.get(m.target);
        if (!it || it.holders.size || this.sim.tied.has(it.id) || this.carriedBy.has(it.id) || this.inRV(it.body.translation()) || this.watched(it, players)) { this.rtHome(m, false); return; }
        if (now - m.goT > RT.GIVE_UP) { m.unreachable.set(m.target, now + RT.UNREACHABLE); this.rtHome(m, false); return; }
        const mp = this.mouth(p, it.type), ip = it.body.translation();
        if (Math.hypot(mp.x - ip.x, mp.z - ip.z) < RT.REACH && Math.abs(mp.y - ip.y) < 0.8) {
          if (this.bite(m, it.id)) { this.rtTake(m, it, den, false); this.setSt(m, S.SNATCH); }
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
        if (!p.holders.size) { this.rtLoose(m, p); return; }
        // (it bites one holder 2 s after it's down to one: a friend letting go doesn't get the other bitten at once;
        // Work Gloves hold it 3 s)
        if (p.holders.size > 1) m.soloAt = null;
        else m.soloAt ??= now;
        const pid = [...p.holders][0], biteT = this.players?.get(pid)?.mods?.biteT ?? RT.BITE_T;
        if (this.plan.bites && m.soloAt != null && now - m.soloAt >= biteT) {
          this.sim.release(pid);
          this.sim.out.push({ k: 'slip', id: m.id, by: pid, why: 'bite' });
          this.sim.out.push({ k: 'mob', id: m.id, s: 'bite', by: pid });
          this.rtLoose(m, p);
        } else if (!this.plan.bites && age >= RT.WRIGGLE_T) {
          for (const pid of [...p.holders]) { this.sim.release(pid); this.sim.out.push({ k: 'slip', id: m.id, by: pid, why: 'wriggle' }); }
          this.sim.out.push({ k: 'mob', id: m.id, s: 'wriggle' });
          this.rtLoose(m, p);
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
        if (age > RT.TRAP_T && (!this.sim.doorOpen || age > RT.TRAP_T * 2)) this.rtVanish(m, p, 'window');
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
  // a theft: counted once per thing (taken again before anyone got it back, it's the same theft, now this
  // den's). ours: the crew had it (held it once, or it rode in the RV: so anything taken in a raid); the stop's
  // own loot that nobody touched yet is taken all the same, but it was never theirs to lose (no theft in the
  // tally, nothing "got back")
  rtTake(m, it, den, raid) {
    // the cheese wheel: bait, not loot. Off home with it, but nobody lost anything (and it's none of the day's thefts)
    if (LOOT[it.type]?.bait) { this.sim.out.push({ k: 'mob', id: m.id, s: 'steal', item: it.id, value: 0, type: it.type, den: den.id, poi: den.poiType, raid, again: false, ours: false, bait: true }); return; }
    const again = this.stolen.get(it.id), value = Math.round(it.value), ours = !!it.ours || !!raid;
    if (!again) { den.thefts++; this.stolen.set(it.id, { den: den.id, value, at: this.t, mob: m.id, ours, raid, left: !raid }); }
    else { again.mob = m.id; again.den = den.id; }
    // (taken in a raid, the crew hears of it once it's out of the door: in the RV it may yet lose it, raidOut)
    if (!raid || again) this.sim.out.push({ k: 'mob', id: m.id, s: 'steal', item: it.id, value, type: it.type, den: den.id, poi: den.poiType, raid, again: !!again, ours: again ? again.ours : ours });
  }
  raidOut(id, st) {
    st.left = true;
    const den = this.dens.get(st.den);
    this.sim.out.push({ k: 'mob', id: st.mob, s: 'steal', item: id, value: st.value, type: this.get(id)?.type, den: st.den, poi: den?.poiType, raid: true, again: false, ours: st.ours });
  }
  // back to the den without loot (gave up)
  rtHome(m, spooked) { m.target = null; m.way = null; m.cd = this.t + this.cooldown(); this.setSt(m, spooked ? RST.SPOOK : RST.DEN); }
  rtDrop(m, p) {
    if (!this.jaws.has(m.id)) return;
    const it = this.jaws.get(m.id).item;
    this.letGo(m.id);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'drop', item: it });
  }
  rtSpook(m, p) { this.rtDrop(m, p); m.target = null; m.way = null; this.setSt(m, RST.SPOOK); }
  rtStun(m, p) {
    this.rtDrop(m, p);
    m.stuns = (m.stuns || 0) + 1;
    this.setSt(m, RST.STUN);
    this.sim.out.push({ k: 'mob', id: m.id, s: 'stun' });
  }
  rtGone(m, p) { this.rtDrop(m, p); this.setSt(m, RST.GONE); }
  // let go of: off home, or (after its third stun) off for good
  rtLoose(m, p) { if ((m.stuns || 0) >= RT.GONE_AFTER) this.rtGone(m, p); else this.rtSpook(m, p); }
  // it's had enough for the day: a puff, and it's gone
  rtVanish(m, p, how = 'gone') {
    this.rtDrop(m, p);
    // (out through a window: it cracks it)
    if (how === 'window') { const t = p.body.translation(); this.sim.out.push({ k: 'rvhit', why: 'window', amt: RVH.WINDOW, zone: 'side', at: [r3(t.x), r3(t.y), r3(t.z)] }); }
    this.sim.out.push({ k: 'gone', ids: [m.id], how });
    this.sim.removeProp(m.id);
  }

  // every step: the legs (and the TRAPPED scramble)
  rtStep(m, p, players, dt) {
    const S = RST, den = this.denOf(m);
    if (!den) return;
    const t = p.body.translation(), home = v3(den.x, den.y, den.z);
    // (a den asleep: no legs, so its critters sit tight on the friction a sleeping grumphorn gets; else they
    // slid downhill off the den)
    const park = m.st === S.DEN && !den.awake;
    if (park !== !!m.parked) { m.parked = park; p.col.setFriction(park ? 0.9 : 0); }
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
      case S.SNEAK: { const it = this.get(m.target); if (it) this.rtGo(m, p, it.body.translation(), RT.SNEAK * this.rtK, dt, true); return; }
      case S.SNATCH: case S.STASH: this.rtLegs(p, null, 0, dt); return;
      case S.RUN: {
        // out of the RV with it: round the RV the way worked out when the raid began (it's in the RV's frame:
        // the RV moving off, it makes straight for home)
        if (m.way?.length && Math.abs(this.sim.rvSpeed()) > 0.5) m.way = null;
        while (m.way?.length) {
          const w = this.sim.rvToWorld(v3(m.way[0].x, 0, m.way[0].z));
          if (Math.hypot(w.x - t.x, w.z - t.z) > 0.9) { this.rtGo(m, p, w, RT.RUN * this.rtK, dt, false); return; }
          m.way.shift();
        }
        this.rtGo(m, p, home, RT.RUN * this.rtK, dt, false); return;
      }
      case S.SPOOK: case S.GONE: this.rtGo(m, p, home, RT.SPOOK * this.rtK, dt, true); return;
      case S.RAID: {
        // to the foot of the RV's steps, then a hop up and in through the door (no legs while in the air)
        if (m.hopped && this.t - m.hopAt < 0.8) return;
        // (far enough out that the hop tops out over the sill, clear of the steps on the way up)
        const foot = this.sim.rvToWorld(v3(-2.75, 0, RV_DIM.DOOR_Z));
        this.rtGo(m, p, foot, RT.SNEAK * this.rtK, dt, true);
        if (!m.hopped && Math.hypot(foot.x - t.x, foot.z - t.z) < 0.5) {
          m.hopped = true; m.hopAt = this.t;
          const inn = qRotate(this.sim.rv.rotation(), v3(1, 0, 0));
          p.body.setLinvel(v3(inn.x * RT.HOP_IN[0], RT.HOP_IN[1], inn.z * RT.HOP_IN[0]), true);
          p.body.setRotation(yawQ(Math.atan2(inn.x, inn.z)), true);
        } else if (m.hopped) {
          const l = this.sim.rvToLocal(t);
          if (insideRV(l.x, l.y, l.z, 0) && l.y > -0.3) this.setSt(m, RST.INRV);
          else m.hopped = false;   // (missed the door: again)
        }
        return;
      }
      case S.INRV: {
        if (m.outHop && this.t - m.raidT < 0.8) return;
        if (m.outHop) {
          // out: home with it (or without)
          m.outHop = false;
          const l = this.sim.rvToLocal(t);
          if (!insideRV(l.x, l.y, l.z, 0)) {
            const j = this.jaws.get(m.id), st = j && this.stolen.get(j.item);
            if (st?.raid && !st.left) this.raidOut(j.item, st);
            if (j) { m.goT = this.t; m.prog = { x: t.x, z: t.z, t: this.t }; this.setSt(m, S.RUN); } else this.rtHome(m, false);
          }
          return;
        }
        const base = this.sim.rv.velocityAtPoint(t);
        if (this.jaws.has(m.id) || m.leave) {
          // back to the doorway, and a hop down the steps; with the thing well in its jaws first (it lifts it
          // before it goes: hopping off with it still on the floor, it'd lose it)
          const j = this.jaws.get(m.id), it = j && this.get(j.item);
          let gap = 0;
          if (it) { const mp = this.mouth(p, it.type), ip = it.body.translation(); gap = Math.hypot(mp.x - ip.x, mp.y - ip.y, mp.z - ip.z); }
          if (gap > 0.3 && this.t - (m.biteT ?? -99) < 2) { this.rtLegs(p, null, 0, dt, base); return; }
          const d = this.rtLegs(p, this.sim.rvToWorld(v3(-0.75, 0, RV_DIM.DOOR_Z)), it ? RT.SNEAK * this.rtK * 0.6 : RT.RUN * this.rtK * 0.7, dt, base);
          if (d < 0.45 && gap < 0.45) {
            m.outHop = true; m.raidT = this.t;
            const out = qRotate(this.sim.rv.rotation(), v3(-1, 0, 0));
            p.body.setLinvel(v3(base.x + out.x * RT.HOP_OUT[0], base.y + RT.HOP_OUT[1], base.z + out.z * RT.HOP_OUT[0]), true);
            p.body.setRotation(yawQ(Math.atan2(out.x, out.z)), true);
          }
        } else { const it = this.get(m.target); if (it) this.rtLegs(p, it.body.translation(), RT.SNEAK * this.rtK, dt, base); }
        return;
      }
      case S.NIP: {
        const q = players.get(m.nipAt);
        if (!q?.pos) return;
        const d = this.rtLegs(p, v3(q.pos.x, q.pos.y, q.pos.z), RT.SPOOK * this.rtK, dt);
        if (d < 0.75 && Math.abs(q.pos.y - p.body.translation().y) < 1.2) this.rtNip(m, p, q);
        return;
      }
      case S.TRAPPED: {
        // out through the open door, or bouncing off the walls (knocking loose loot about)
        if (this.sim.doorOpen) this.rtLegs(p, this.sim.rvToWorld(v3(-2.2, 0, 0.35)), RT.SPOOK * this.rtK, dt, this.sim.rv.velocityAtPoint(p.body.translation()));
        else if (this.rng() < dt * 3) p.body.applyImpulse(v3((this.rng() - 0.5) * 60, 30, (this.rng() - 0.5) * 60), true);
        return;
      }
    }
  }
  // go somewhere: stuck for 1 s, hop (never with loot in its teeth: it drops it); leashed to its den
  rtGo(m, p, goal, speed, dt, mayHop) {
    const t = p.body.translation(), den = this.denOf(m);
    if (den && Math.hypot(t.x - den.x, t.z - den.z) > RT.LEASH && m.st === RST.SNEAK) { this.rtHome(m, true); return; }
    this.rtLegs(p, this.rvRoute(t, goal, this.jaws.has(m.id)), speed, dt);
    if (!m.prog) m.prog = { x: t.x, z: t.z, t: this.t };
    if (this.t - m.prog.t >= 1) {
      const moved = Math.hypot(t.x - m.prog.x, t.z - m.prog.z);
      m.prog = { x: t.x, z: t.z, t: this.t };
      if (moved < 0.4 && Math.hypot(goal.x - t.x, goal.z - t.z) > 1) {
        if (this.jaws.has(m.id)) { this.balk(m.id, this.jaws.get(m.id).item); this.rtDrop(m, p); if (m.st === RST.RUN) this.rtSpook(m, p); }
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
    if (m.st === RST.STUN || m.st === RST.GONE || m.st === RST.INRV || Math.hypot(this.vRV.x, this.vRV.z) <= RT.SQUASH_V) return false;
    const l = this.sim.rvToLocal(p.body.translation());
    if (!(Math.abs(l.x) < 1.15 && Math.abs(l.z) < 3.8 && l.y > -1.6 && l.y < -0.3)) return false;
    this.sim.out.push({ k: 'mob', id: m.id, s: 'squash' });
    this.rtStun(m, p);
    return true;
  }
  // ---- raids and nips ----------------------------------------------------------------------------------
  // the way to a spot by the RV that doesn't run into it. Empty-handed a ringtail fits under the RV, but not
  // under the steps by its door; with something in its jaws it goes round the RV (the thing would snag on
  // the floor). The next point to make for: the goal itself when the way is clear
  rvRoute(t, goal, laden) {
    const sim = this.sim, a = sim.rvToLocal(t), Z = RV_DIM.DOOR_Z;
    if (Math.abs(a.x) > 12 || Math.abs(a.z) > 14 || a.y > 0) return goal;
    const s = Math.sign(a.z - Z) || 1, out = v3(-2.7, 0, Z + s * 1.4);
    // on the steps (just out of the door): off them, out and to one side
    if (a.x < -1.15 && a.x > -2.0 && Math.abs(a.z - Z) < 0.85 && a.y > -0.75) return sim.rvToWorld(out);
    if (a.y > -0.5) return goal;
    const b = sim.rvToLocal(goal);
    if (laden) {
      // round the RV (and its steps) by the corners: the one that makes the shortest way, in sight of here
      const x0 = -2.1, x1 = RV_DIM.HALF_W + 0.7, z0 = -RV_DIM.HALF_L - 0.7, z1 = RV_DIM.HALF_L + 0.7;
      if (!segRect(a, b, x0, x1, z0, z1)) return goal;
      let best = null, bd = Infinity;
      for (const cx of [x0 - 0.5, x1 + 0.5]) for (const cz of [z0 - 0.5, z1 + 0.5]) {
        const c = { x: cx, z: cz }, ac = Math.hypot(c.x - a.x, c.z - a.z);
        if (ac < 0.3 || segRect(a, c, x0, x1, z0, z1)) continue;
        const d = ac + Math.hypot(b.x - c.x, b.z - c.z);
        if (d < bd) { bd = d; best = c; }
      }
      return best ? sim.rvToWorld(v3(best.x, 0, best.z)) : goal;
    }
    if (!segRect(a, b, -1.95, -1.15, Z - 0.8, Z + 0.8)) return goal;
    // out past the steps' end and round them; under the RV level with the steps, first along to clear them
    return sim.rvToWorld(a.x < -1.95 || Math.abs(a.z - Z) >= 1.2 ? out : v3(a.x, 0, Z + s * 1.4));
  }
  // someone near the RV's door (it's not left alone)
  doorGuarded(players) {
    const door = this.sim.rvToWorld(v3(-1.6, 0, RV_DIM.DOOR_Z));
    for (const q of players.values()) if (q.pos && !q.ko && Math.hypot(q.pos.x - door.x, q.pos.z - door.z) < RT.RAID_CLEAR) return true;
    return false;
  }
  // the way home from the RV's door with something in its jaws, round the RV (it can't take it under the
  // floor): RV-frame points from where the hop out lands to one the den can see. null: there's none
  raidWay(den) {
    const sim = this.sim, Z = RV_DIM.DOOR_Z, dl = sim.rvToLocal(v3(den.x, den.y, den.z));
    const x0 = -2.1, x1 = RV_DIM.HALF_W + 0.7, z1 = RV_DIM.HALF_L + 0.7;
    const sees = l => {
      const w = sim.rvToWorld(v3(l.x, 0, l.z));
      return this.clearWide(v3(den.x, den.y + 0.35, den.z), v3(w.x, sim.W.heightAt(w.x, w.z) + 0.35, w.z), sim.rv);
    };
    const open = (a, b) => !segRect(a, b, x0, x1, -z1, z1);
    const L = { x: -2.8, z: Z };
    if (open(L, dl) && sees(L)) return [];
    const s0 = Math.sign(dl.z - Z) || 1;
    for (const s of [s0, -s0]) {
      const D = { x: x0 - 0.5, z: s * (z1 + 0.5) }, F = { x: x1 + 0.5, z: s * (z1 + 0.5) };
      if (open(D, dl) && sees(D)) return [D];
      if (open(F, dl) && sees(F)) return [D, F];
    }
    return null;
  }
  // what a ringtail could take from the RV (day 2 on): parked within RAID_R m of the den, its door open and
  // nobody near it; the most valuable light thing loose in the cabin (bungee'd cargo is safe)
  rtRaidTarget(den, players) {
    const sim = this.sim;
    if (!this.plan.raids || !sim.doorOpen || Math.abs(sim.rvSpeed()) > 0.5 || den.thefts >= this.plan.cap) return null;
    // one of a den's at a time goes in (the doorway is narrow)
    for (const o of this.list.values()) if (o.den === den.id && (o.st === RST.RAID || o.st === RST.INRV)) return null;
    const door = sim.rvToWorld(v3(-1.6, 0, RV_DIM.DOOR_Z));
    if (Math.hypot(door.x - den.x, door.z - den.z) > RT.RAID_R || this.doorGuarded(players)) return null;
    // in sight of the den: the foot of the steps (under the RV is fine, empty-handed), and a way back round it
    if (!den.rway || this.t > den.rway.until) {
      const f = sim.rvToWorld(v3(-2.75, 0, RV_DIM.DOOR_Z));
      const ok = this.clearWide(v3(den.x, den.y + 0.35, den.z), v3(f.x, sim.W.heightAt(f.x, f.z) + 0.35, f.z), sim.rv);
      den.rway = { until: this.t + 2, way: ok ? this.raidWay(den) : null };
    }
    if (!den.rway.way) return null;
    const taken = new Set();
    for (const o of this.list.values()) if ((o.st === RST.RAID || o.st === RST.INRV || o.st === RST.SNEAK) && o.target != null) taken.add(o.target);
    let best = null, bv = 0;
    for (const it of sim.props.values()) {
      const L = LOOT[it.type];
      if (!L || (L.tool && !L.bait) || L.mob || L.mass > 15 || it.holders.size || sim.tied.has(it.id) || this.carriedBy.has(it.id) || taken.has(it.id)) continue;
      const l = sim.rvToLocal(it.body.translation());
      if (!insideRV(l.x, l.y, l.z, 0) || l.y > 1.5) continue;
      const v = L.bait ? RT.BAIT_V : L.find ? RT.SHINY_V : it.value;
      if (v > bv) { bv = v; best = it.id; }
    }
    return best;
  }
  // a stranger at the den: someone on foot within NIP_R m of it, not nipped in the last NIP_CD s, not by a
  // friend who's down (or reviving one), and not already being seen to by another of the den's ringtails
  rtNipTarget(den, players) {
    let best = null, bd = RT.NIP_R;
    const busy = new Set([...this.list.values()].filter(o => o.st === RST.NIP).map(o => o.nipAt));
    for (const q of players.values()) {
      if (!this.nippable(q) || busy.has(q.id) || (den.nipCd?.get(q.id) || 0) > this.t) continue;
      const d = Math.hypot(q.pos.x - den.x, q.pos.z - den.z);
      if (d < bd && !this.nearDowned(q.pos, players)) { bd = d; best = q; }
    }
    return best;
  }
  // on foot on the ground, where its teeth reach: not up a wall (knocked off, they'd fall), on a roof or a
  // rock, or riding the RV
  nippable(q) {
    return !!q?.pos && !q.ko && q.seat == null && !q.par && q.mode !== MODE.CLIMB && q.pos.y - this.sim.W.heightAt(q.pos.x, q.pos.z) < 1.2;
  }
  // the nip: a stumble (never a knockout), and whatever they carried is dropped
  rtNip(m, p, q) {
    const den = this.denOf(m), t = p.body.translation(), now = this.t;
    if (!den.nipCd) den.nipCd = new Map();
    den.nipCd.set(q.id, now + RT.NIP_CD);
    m.nipCd = now + RT.NIP_REST;
    const dx = q.pos.x - t.x, dz = q.pos.z - t.z, d = Math.hypot(dx, dz) || 1;
    const h = this.sim.holds.get(q.id);
    if (h) { this.sim.release(q.id); this.sim.out.push({ k: 'slip', id: h.kind === 'prop' ? h.id : null, by: q.id, why: 'nip' }); }
    if ((this.sim.knockCd.get(q.id) || 0) <= now) {
      this.sim.knockCd.set(q.id, now + 1);
      this.sim.out.push({ k: 'knock', id: q.id, v: [r3(dx / d * 2.5), 2, r3(dz / d * 2.5)], ko: false, why: 'nip' });
    }
    this.sim.out.push({ k: 'mob', id: m.id, s: 'nip', by: q.id });
    this.setSt(m, RST.SPOOK);
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
    if (m.st !== S.TRAPPED && m.st !== S.HELD && m.st !== S.FLUNG && m.st !== S.RAID && m.st !== S.INRV && !(m.st === S.RUN && this.t - (m.raidT ?? -99) < 2)) {
      const l = this.sim.rvToLocal(p.body.translation());
      if (insideRV(l.x, l.y, l.z, 0) && l.y > -0.2) { m.inSince = m.inSince ?? this.t; if (this.t - m.inSince > 1) { this.rtDrop(m, p); this.setSt(m, S.TRAPPED); this.sim.out.push({ k: 'mob', id: m.id, s: 'trapped' }); } }
      else m.inSince = null;
    }
  }

  // ---- rockfall ---------------------------------------------------------------------------------------------
  // Loose rock up on a rim of the narrows (days 3-5: world gen's W.rockfalls). It comes down when the RV gets
  // close or the boulder is disturbed, after a rumble and dust off the lip; a honk well back brings it down
  // early, on nobody. A rock still coming down fast knocks out whoever it hits (no bill: the doctor's, if
  // nobody picks them up); after that it's an ordinary heavy stone, good for throwing at a grumphorn.
  rfArm(r) {
    const rec = { ...r, st: 'armed', at: 0, n: 0, rocks: [], boulder: null, b0: null };
    if (r.ob === 'boulder') {
      const b = [...this.sim.props.values()].find(p => p.type === 'boulder' && Math.abs(p.body.translation().z - r.obz) < 4);
      if (b) { const t = b.body.translation(); rec.boulder = b.id; rec.b0 = v3(t.x, t.y, t.z); }
    }
    return rec;
  }
  rocksStep(players) {
    const now = this.t, rv = this.sim.rv.translation();
    for (const r of this.rockfalls) {
      if (r.st === 'armed') {
        let go = Math.hypot(rv.x - this.sim.W.roadX(r.obz), rv.z - r.obz) < RF.NEAR;
        const b = r.boulder != null ? this.get(r.boulder) : null;
        if (b) { const t = b.body.translation(); if (Math.hypot(t.x - r.b0.x, t.z - r.b0.z) > 0.5) go = true; }
        if (go) this.rfTrigger(r, 'near');
      } else if (r.st === 'rumble' && now >= r.at) { r.st = 'fall'; r.at = now; r.n = 0; }
      if (r.st === 'fall') {
        while (r.n < r.rim.length && now >= r.at + r.n * RF.GAP) this.rfDrop(r, r.rim[r.n++]);
        if (r.n >= r.rim.length) r.st = 'done';
      }
      // a rock still coming down fast knocks out whoever it hits; rolling, it bowls them over (not riders
      // under the RV's roof; to one on it, it's how fast it comes at them there). Once someone has picked
      // it up it's an ordinary stone: thrown, it beans like any junk (sim.js)
      for (const fr of r.rocks) {
        if (now - fr.at > RF.LIVE) continue;
        const p = this.get(fr.id);
        if (!p) continue;
        if (p.holders.size || p.thrownBy != null) { fr.at = -Infinity; continue; }
        // one landing on the RV still coming down fast dents it (once a rock; how fast it was going as it hit)
        if (!fr.rv && this.partners(p).rv) {
          const vp = this.vPre.get(fr.id), vr = this.vRV;
          if (vp && Math.hypot(vp.x - vr.x, vp.y - vr.y, vp.z - vr.z) >= RF.KO_V) {
            fr.rv = true;
            const pt = p.body.translation(), l = this.sim.rvToLocal(pt);
            this.sim.out.push({ k: 'rvhit', why: 'rock', amt: RVH.ROCK, zone: l.y > RV_DIM.ROOF_Y - 0.3 ? 'roof' : 'side', at: [r3(pt.x), r3(pt.y), r3(pt.z)] });
          }
        }
        const v = p.body.linvel(), t = p.body.translation(), w = this.sim.rv.velocityAtPoint(t);
        const rel = v3(v.x - w.x, v.y - w.y, v.z - w.z);
        if (Math.hypot(v.x, v.y, v.z) < RF.BUMP_V && Math.hypot(rel.x, rel.y, rel.z) < RF.BUMP_V) continue;
        for (const q of players.values()) {
          if (!q.pos || q.ko || q.seat != null || (this.sim.knockCd.get(q.id) || 0) > now) continue;
          const y = Math.max(q.pos.y + 0.3, Math.min(q.pos.y + 1.5, t.y));
          const dx = q.pos.x - t.x, dy = y - t.y, dz = q.pos.z - t.z, dl = Math.hypot(dx, dy, dz);
          if (dl > RF.HIT_R) continue;
          const l = this.sim.rvToLocal(v3(q.pos.x, q.pos.y + 0.9, q.pos.z));
          if (insideRV(l.x, l.y, l.z, 0)) continue;
          // how fast it comes at them (over the ground they stand on: a rider's is the RV): one rolling on
          // ahead of someone who walked into it and pushed it is no hit
          const u = q.par ? rel : v, sp = dl > 1e-3 ? (u.x * dx + u.y * dy + u.z * dz) / dl : Math.hypot(u.x, u.y, u.z);
          if (sp < RF.BUMP_V) continue;
          this.sim.knockCd.set(q.id, now + 1.5);
          const ko = sp >= RF.KO_V, k = (ko ? 3 : 2.5) / (Math.hypot(u.x, u.z) || 1);
          if (!ko) { const h = this.sim.holds.get(q.id); if (h) { this.sim.release(q.id); this.sim.out.push({ k: 'slip', id: h.kind === 'prop' ? h.id : null, by: q.id, why: 'rock' }); } }   // (bowled over: what they carried goes flying)
          this.sim.out.push({ k: 'knock', id: q.id, v: [r3(u.x * k), ko ? 5 : 3, r3(u.z * k)], ko, why: 'rock', rel: q.par ? 1 : 0 });
          this.sim.out.push({ k: 'mob', id: fr.id, s: 'rockhit', by: q.id, ko });
        }
      }
    }
  }
  // the rumble: dust off the lip, and RF.WARN s to get clear
  rfTrigger(r, why) {
    if (r.st !== 'armed') return;
    r.st = 'rumble'; r.at = this.t + (this.bad ? 1.0 : RF.WARN);
    this.sim.out.push({ k: 'mob', id: null, s: 'rumble', rf: r.id, ob: r.ob, why, rim: r.rim.map(p => [r3(p.x), r3(p.y), r3(p.z)]) });
  }
  // one rock off the lip, rolled toward the road
  rfDrop(r, at) {
    const p = this.sim.addProp('rock', v3(at.x, at.y, at.z), yawQ(this.rng() * 6.283), 0, 0);
    if (!p) return;
    const dx = this.sim.W.roadX(at.z) - at.x;
    p.body.setLinvel(v3(Math.sign(dx) * RF.PUSH, 0.5, (this.rng() - 0.5) * 1.2), true);
    r.rocks.push({ id: p.id, at: this.t });
    this.sim.out.push({ k: 'spawn', p: this.sim.describe(p) });
    this.sim.out.push({ k: 'mob', id: p.id, s: 'rockfall', rf: r.id });
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
  exitNear(x, z) { return bedExit(this.sim.W, z); }

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
    let creeping = null;
    for (const q of players.values()) {
      if (!q.pos || q.ko || q.seat != null) continue;
      const d = this.ghDist(p, q.pos), crouch = (q.flags & FLAG.CROUCH) !== 0, sprint = (q.flags & FLAG.SPRINT) !== 0;
      // (in the RV only someone standing counts: crouched or seated riders never do)
      if (q.par) { if (!crouch && q.mode === MODE.WALK && d < GH.WAKE_RIDER) return { at: v3(q.pos.x, q.pos.y, q.pos.z), rv: false }; continue; }
      // (crouched right by it, it takes a moment to notice: long enough to creep up and tip it)
      if (crouch && !sprint) { if (d < GH.WAKE_CROUCH) creeping = q; continue; }
      if (d < (sprint ? GH.WAKE_SPRINT : GH.WAKE_FOOT)) return { at: v3(q.pos.x, q.pos.y, q.pos.z), rv: false };
    }
    if (!creeping) m.creepAt = null;
    else if ((m.creepAt ??= this.t) && this.t - m.creepAt >= GH.NOTICE) return { at: v3(creeping.pos.x, creeping.pos.y, creeping.pos.z), rv: false };
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
    m.stir = null;   // (a flank shove still waiting on a second: whatever woke it first, it's up now)
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
    m.mood = false; m.exit = null; m.lprog = null;
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

  // where it goes off the road for good (world gen's first flat ground beside its bed; or, if it couldn't get
  // back there, the nearest from where it got stuck)
  ghExit(m, bed) { return m.exit || bed.exit || v3(bed.x + 8, bed.y, bed.z); }
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
      const ex = this.ghExit(m, bed);
      // no headway in 3 s (the boulder's in the way back, say): off the road at the nearest place from here
      if (!m.lprog || now - m.lprog.t >= 3) {
        if (m.lprog && !m.exit && Math.hypot(t.x - m.lprog.x, t.z - m.lprog.z) < 0.6) m.exit = bedExit(this.sim.W, t.z, true);
        m.lprog = { x: t.x, z: t.z, t: now };
      }
      if (Math.hypot(ex.x - t.x, ex.z - t.z) < 1 || age > 45) {
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
    if (m.st === S.TIPPED) {
      if (age >= GH.TIP_T) { m.noise = null; m.rvWoke = false; p.col.setFriction(0); this.setSt(m, S.RISE); this.sim.out.push({ k: 'mob', id: m.id, s: 'wake' }); }
      return;
    }
    if (m.st === S.SLEEP || m.st === S.DOZE) {
      // stirred by a shove on its flank: a second friend's has TIP_WIN s to tip it, then it's up
      if (m.stir) { if (now - m.stir.t > GH.TIP_WIN) { const at = m.stir.at; m.stir = null; this.ghWake(m, p, at); this.ghCost(m, p, GH.COST.shove); } return; }
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
        // back along the road till it's abreast of its way off, then off it (cutting across from wherever its
        // charges left it, it slid along the canyon walls)
        const ex = this.ghExit(m, bed), W = this.sim.W, side = Math.sign(ex.x - W.roadX(ex.z)) || 1;
        const g = Math.abs(t.z - ex.z) > 2.5 && Math.abs(t.x - W.roadX(t.z)) < Math.abs(ex.x - W.roadX(ex.z)) - 1 ? v3(W.roadX(ex.z) + side * 2.5, 0, ex.z) : ex;
        const dx = g.x - t.x, dz = g.z - t.z, d = Math.hypot(dx, dz) || 1;
        this.face(p, Math.atan2(dx, dz), 2, dt);
        this.ghLegs(p, dx / d, dz / d, g !== ex || d > 0.5 ? GH.LEAVE : 0, dt);
        return;
      }
      case S.RISE: case S.WINDED: case S.HELD: case S.TIPPED: this.ghLegs(p, 0, 0, 0, dt); return;
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

  // what a critter is touching right now (a live contact, not just overlapping boxes): the RV (and the
  // contact's normal there, world space, either sign), the solid world, and which props
  partners(p) {
    const out = { rv: false, rvN: null, statics: false, props: [] }, w = this.sim.world, rv = this.sim.rv.handle;
    w.contactPairsWith(p.col, c2 => {
      if (!c2) return;
      let live = false, n = null;
      w.contactPair(p.col, c2, man => { if (man.numContacts() > 0) { live = true; n ||= man.normal(); } });
      if (!live) return;
      const id = this.sim.byCollider.get(c2.handle);
      if (id != null) out.props.push(id);
      else if (c2.parent()?.handle === rv) { out.rv = true; out.rvN ||= n && { x: n.x, y: n.y, z: n.z }; }
      else out.statics = true;
    });
    return out;
  }
  // how much a body's velocity changed in the last step (gravity's share taken out); flat: along the ground only
  dv(p, flat = false) {
    const a = this.vPre.get(p.id);
    if (!a) return 0;
    const b = p.body.linvel();
    return Math.hypot(b.x - a.x, flat ? 0 : b.y - a.y + 9.81 * this.sim.world.timestep, b.z - a.z);
  }
  // nothing solid (the ground, walls, the RV) between a and b
  // (except: a body that doesn't count, e.g. the RV's own shell round its middle when it's the RV in sight)
  // clear for a body as wide as a ringtail: the line, and one either side of it (w m off)
  clearWide(a, b, except = undefined, w = 0.3) {
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, ox = -dz / l * w, oz = dx / l * w;
    return this.clear(a, b, except) && this.clear(v3(a.x + ox, a.y, a.z + oz), v3(b.x + ox, b.y, b.z + oz), except)
      && this.clear(v3(a.x - ox, a.y, a.z - oz), v3(b.x - ox, b.y, b.z - oz), except);
  }
  clear(a, b, except = undefined) {
    const d = v3(b.x - a.x, b.y - a.y, b.z - a.z), L = Math.hypot(d.x, d.y, d.z);
    if (L < 0.3) return true;
    return !this.sim.world.castRay(new RAPIER.Ray(a, v3(d.x / L, d.y / L, d.z / L)), L - 0.3, true, undefined, GROUPS.solid, undefined, except);
  }
}

export { r3, yawQ };
