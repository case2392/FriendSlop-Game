// The economy bot: a crew of bots plays whole trips in process (the real Room and Sim, the real clock, the
// wildlife on), every action a message a page could send, so the numbers it prints are what the stock game
// gives a competent crew: which days get paid, how much is pawned, what the road costs in time and the RV.
// The Garage (perks and parts) and the loan terms are gated on these numbers, and docs/DESIGN.md section 8
// quotes them.
//
// What the crew does each day (no test levers: only messages, and only what a page can see):
//  - camp: everyone aboard (the day's drawn driver at the wheel, the rest riding crouched), door shut, roll out;
//  - the road, in order: honk at each LOOSE ROCK sign and let it come down; the ranger gate (one climbs to the
//    painted code on the rim, another enters it at the keypad); the boulder (shoved aside by hand); the mud
//    (stuck, then pushed out from behind); each grade (the hook walked up to a post and reeled in); every
//    sleeping Grumphorn crept past at a walking pace, off to the side, everyone crouched or seated;
//  - town: back into Ed's loading zone, ring his bell (the load sells at 80%), pay the Repo Man;
//  - night: Gus fixes the RV for cash if it's under 61% and the bank can spare it; everyone into a bunk.
// Speeds are the page's (walk 4.4 m/s, climb 1.85); the server checks none of them, so the bot keeps itself
// honest and says so if it ever moves a porter faster.
//
//   node tools/econbot.mjs [--seeds 20 | --seed N] [--crew 3] [--days 1-5] [--casino none|bold] [--bank N]
//                          [--trace] [--json file] [--gate] [--part k/n] [--kit stock|max|<perk or part id>]
//   node tools/econbot.mjs --merge a.json b.json ...   (the summary of runs split with --part k/n --json)
// --bank N: the bank at the start of each day (to run the whole flow without loot); --gate: exit 1 on a bot
// failure (a stuck porter or RV, a run-over, a move faster than a page allows)
process.env.FRIENDSLOP_TEST = '1';            // (mutes the per-hit log line)
delete process.env.FRIENDSLOP_FAST;           // a real clock: 45 s a game hour
delete process.env.FRIENDSLOP_NOMOBS;         // the wildlife on
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { RV_DIM, RV_SEAT_EXIT, toWorld, toLocal, qRotate, qYaw, insideRV } = await import('../shared/rv.js');
const { GST, ST_MASK, RF } = await import('../shared/mobs.js');
const { mulberry32 } = await import('../shared/rng.js');
const { LOOT, fmt$ } = await import('../shared/loot.js');
import fs from 'node:fs';
await initPhysics();

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PART = String(opt('--part', '0/1')).split('/').map(Number);   // (every n-th seed from the k-th: run in parallel)
const SEEDS = (opt('--seed', null) != null ? [Number(opt('--seed'))] : Array.from({ length: Number(opt('--seeds', 20)) }, (_, i) => [4242, 7, 777][i] ?? 1000 + i * 7919))
  .filter((_, i) => i % PART[1] === PART[0]);
const MERGE = args.includes('--merge') ? args.slice(args.indexOf('--merge') + 1).filter(a => !a.startsWith('--')) : null;
const CREW = Math.max(1, Math.min(C.MAX_PLAYERS, Number(opt('--crew', 3))));
const [D0, D1] = (([a, b]) => [a, b ?? a])(String(opt('--days', '1-5')).split('-').map(Number));   // ('3' is day 3 alone)
const CASINO = opt('--casino', 'none');
// the Garage (shared/garage.js): 'max' is the money-relevant kit maxed (Work Gloves II, Climbing Chalk II and Medic
// Bag II on everyone; a Winch Motor II and a Bull Bar II fitted); a perk's or a part's id, that one at II alone.
// (The bot models no stamina, sight or hold times: Chalk, Medic, Keen Eye, Call Sign and Steady Hands I do
// nothing a bot can measure)
const KIT = opt('--kit', 'stock');
const { PERK_IDS, PART_IDS } = await import('../shared/garage.js');
const kitFor = slot => {
  if (KIT === 'max') return { perks: { gloves: 2, chalk: 2, medic: 2 }, part: [{ id: 'winch', lv: 2 }, { id: 'bullbar', lv: 2 }][slot] || null };
  if (PERK_IDS.includes(KIT)) return { perks: { [KIT]: 2 }, part: null };
  if (PART_IDS.includes(KIT)) return { perks: {}, part: slot === 0 ? { id: KIT, lv: 2 } : null };
  return null;
};
const BANK = opt('--bank', null) != null ? Number(opt('--bank')) : null;
const WHY = args.includes('--why'), accHist = [], WHYLOG = [];
const TRACE = args.includes('--trace'), GATE = args.includes('--gate'), JSON_OUT = opt('--json', null);
const HZ = C.SIM_HZ, DT = 1 / HZ, DZ = RV_DIM.DOOR_Z;
const NAMES = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay'];
const SEAT_POSE = [{ x: 0.62, y: 0.02, z: 2.72 }, { x: -0.62, y: 0.02, z: 2.72 }];
// where riders crouch (RV-local floor): the front aisle and beside the table, clear of the loot's floor
const RIDE = [{ x: -0.1, z: 1.3 }, { x: 0.15, z: 0.9 }, { x: -0.3, z: 1.95 }, { x: 0.25, z: 1.65 }];
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const hyp = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- one trip's world: the room, the crew, the clock -------------------------------------------------------
let room = null, crew = [], ev = [], trace = () => {}, health = null, PHASE = '';
const W = () => room.W, sim = () => room.sim;
const rvPose = () => sim().rvPose();
const rvAt = l => { const r = rvPose(); return toWorld(r.p, r.q, l); };
const rvLocal = w => { const r = rvPose(); return toLocal(r.p, r.q, w); };
const fwd = () => qRotate(sim().rv.rotation(), { x: 0, y: 0, z: 1 });
const rvZ = () => sim().rv.translation().z;
const rvV = () => sim().rvSpeed();
const ground = (x, z) => W().heightAt(x, z);

// a connection that reads what the server sends a page and acts on it the way the page does
class BotConn {
  constructor(bot) { this.bot = bot; this.readyState = 1; }
  send(s) {
    const m = typeof s === 'string' ? JSON.parse(s) : s, b = this.bot;
    if (m.t === 'tp') b.teleport(m);
    else if (m.t === 'seat') b.onSeat(m);
    else if (m.t === 'knock') b.onKnock(m);
    else if (m.t === 'revived') { b.ko = false; b.koAt = null; }
    else if (m.t === 'ev' && b.slot === 0) for (const e of m.list) ev.push(e);
    else if (m.t === 'toast' && b.slot === 0) trace(`  "${m.text}"`);
    else if (m.t === 'over' && b.slot === 0) ev.push({ k: 'over', won: m.won, short: m.short });
  }
  close() { this.readyState = 3; }
}

// A crew member: a pose the server reads every tick, moved by the bot at a page's speeds
class Bot {
  constructor(slot) {
    this.slot = slot; this.name = NAMES[slot];
    this.conn = new BotConn(this);
    this.frame = 'ground'; this.feet = { x: 0, y: 0, z: 0 }; this.yaw = 0; this.pitch = 0;
    this.crouch = false; this.mode = C.MODE.WALK; this.seat = null; this.ko = false; this.koAt = null;
    this.P = room.addPlayer(this.conn, this.name).player;
    this.P.key = 'bot:' + slot;
    room.setProfile(this.P, { pid: String(slot + 1).repeat(16), wins: 0, kit: kitFor(slot) });
    room.welcome(this.P);   // (its 'tp' puts the bot at its camp spawn)
    this.last = { ...this.feet };
  }
  get id() { return this.P.id; }
  teleport(m) { this.frame = 'ground'; this.feet = { x: m.x, y: m.y, z: m.z }; this.yaw = m.yaw || 0; this.mode = C.MODE.WALK; this.last = { ...this.feet }; }
  onSeat(m) {
    this.seat = m.seat;
    if (m.seat == null) { const ex = m.exit || RV_SEAT_EXIT[0]; this.frame = 'rv'; this.feet = { x: ex.x, y: 0, z: ex.z }; }
  }
  onKnock(m) {
    if (this.seat != null) return;
    if (m.ko) { this.ko = true; this.koAt = room.t; room.handle(this.P, { t: 'ko', why: m.why || 'fall' }); health.kos++; }
  }
  // the world position of the feet (riding: where the RV has them now)
  world() { return this.frame === 'rv' ? rvAt(this.seat != null ? SEAT_POSE[this.seat] : this.feet) : this.feet; }
  pose() {
    if (this.ko && this.koAt != null && room.t - this.koAt > C.PLAYER.KO_TIME) { this.koAt = null; room.handle(this.P, { t: 'wake' }); }
    const f = (this.crouch ? C.FLAG.CROUCH : 0);
    if (this.frame === 'rv') {
      const l = this.seat != null ? SEAT_POSE[this.seat] : this.feet;
      room.handle(this.P, { t: 'p', par: 1, x: l.x, y: l.y, z: l.z, yaw: this.yaw, pitch: this.pitch, m: this.seat != null ? C.MODE.SEAT : this.ko ? C.MODE.KO : this.mode, f, v: [0, 0, 0] });
    } else {
      const v = [(this.feet.x - this.last.x) * HZ, (this.feet.y - this.last.y) * HZ, (this.feet.z - this.last.z) * HZ];
      room.handle(this.P, { t: 'p', par: 0, x: this.feet.x, y: this.feet.y, z: this.feet.z, yaw: this.yaw, pitch: this.pitch, m: this.ko ? C.MODE.KO : this.mode, f, v });
    }
    this.last = { ...this.feet };
  }
  use(kind, extra = {}) { room.handle(this.P, { t: 'use', kind, ...extra }); }
  useId(u, extra = {}) { room.handle(this.P, { t: 'use', id: u.id, ...extra }); }
}

// ---- tasks: generators that do one tick's worth each step --------------------------------------------------
function* wait(s) { for (let i = 0; i < Math.round(s * HZ); i++) yield; }
// until pred() holds (false after maxS, with a note)
function* until(pred, maxS, what) {
  for (let i = 0; i < maxS * HZ; i++) { if (pred()) return true; yield; }
  if (what) fail(`timed out: ${what}`);
  return false;
}
// several at once, done when all are
function* all(...gens) {
  const live = gens.filter(Boolean);
  while (live.length) {
    for (let i = live.length - 1; i >= 0; i--) if (live[i].next().done) live.splice(i, 1);
    if (live.length) yield;
  }
}
function fail(msg) { health.fails.push(`${room.seed} d${room.day} ${(room.clock).toFixed(2)}: ${msg}`); trace(`!! ${msg}`); }

// ---- walking ------------------------------------------------------------------------------------------------
// on foot toward `to` (a world point, or a function giving one) at `speed`, the ground under the feet; a slope
// steeper than the page lets you walk is climbed at its climbing speed. Crouches within 10 m of a sleeping
// Grumphorn
function* walk(bot, to, speed = C.PLAYER.WALK, near = 0.05) {
  bot.frame = 'ground'; bot.seat = null;
  for (let i = 0; i < 120 * HZ; i++) {
    const t = typeof to === 'function' ? to() : to, f = bot.feet;
    const dx = t.x - f.x, dz = t.z - f.z, d = Math.hypot(dx, dz);
    if (d <= near) { bot.mode = C.MODE.WALK; return true; }
    const sleeper = beastNear(f, 10);
    const sp = sleeper ? Math.min(speed, C.PLAYER.CROUCH) : speed;
    bot.crouch = !!sleeper;
    // (how steep is it the next step on? climbing: along the face at its speed)
    const s = Math.min(d, sp * DT), nx = f.x + dx / d * s, nz = f.z + dz / d * s;
    const y0 = ground(f.x, f.z), y1 = ground(nx, nz), slope = Math.atan2(Math.abs(y1 - y0), s) * 180 / Math.PI;
    let k = 1;
    if (slope > C.PLAYER.MAX_SLOPE_DEG) { bot.mode = C.MODE.CLIMB; k = C.CLIMB.SPEED * Math.cos(Math.atan2(Math.abs(y1 - y0), s)) / sp; } else bot.mode = C.MODE.WALK;
    const s2 = s * Math.min(1, k);
    bot.feet = { x: f.x + dx / d * s2, y: ground(f.x + dx / d * s2, f.z + dz / d * s2), z: f.z + dz / d * s2 };
    bot.yaw = Math.atan2(dx, dz);
    yield;
  }
  fail(`${bot.name} never got to (${(typeof to === 'function' ? to() : to).x.toFixed(1)}, ${(typeof to === 'function' ? to() : to).z.toFixed(1)})`);
  return false;
}
// a sleeping Grumphorn within r of p (its body's middle), from the snapshot's states
function beastNear(p, r) {
  for (const pr of sim().props.values()) {
    if (pr.type !== 'grumphorn') continue;
    const st = mobSt(pr), t = pr.body.translation();
    if ((st === GST.SLEEP || st === GST.DOZE) && Math.hypot(t.x - p.x, t.z - p.z) < r) return pr;
  }
  return null;
}
// a critter's state as the snapshot sends it
const mobSt = pr => (pr.mob ? pr.mob.wire() & ST_MASK : 0);
// inside the RV: along the floor to a local point (the steps on the door's line)
function* walkIn(bot, to, speed = C.PLAYER.WALK) {
  bot.frame = 'rv';
  for (let i = 0; i < 30 * HZ; i++) {
    const f = bot.feet, dx = to.x - f.x, dz = to.z - f.z, d = Math.hypot(dx, dz);
    if (d < 0.05) { bot.feet = { x: to.x, y: floorY(to.x, to.z), z: to.z }; return; }
    const s = Math.min(d, speed * DT), x = f.x + dx / d * s, z = f.z + dz / d * s;
    bot.feet = { x, y: floorY(x, z), z };
    bot.yaw = Math.atan2(dx, dz);
    yield;
  }
}
// the floor or a step under an RV-local point on the door's line
const floorY = (x, z) => (Math.abs(z - DZ) < 0.7 && x < -1.22 ? (x < -1.62 ? -0.85 : -0.42) : 0);

// ---- getting in and out -------------------------------------------------------------------------------------
const doorFoot = () => { const w = rvAt({ x: -2.6, y: 0, z: DZ }); return { x: w.x, y: ground(w.x, w.z), z: w.z }; };
// nothing in the doorway (a door shut on something poking through it crushes it)
function doorwayClear() {
  for (const p of sim().props.values()) if (p.type !== 'map' && inDoorway(p, 0)) return false;
  return true;
}
// a prop in the doorway (pad: m more on the inside, where the RV's first lurch slides it out of the open door)
function inDoorway(p, pad = 0.25) {
  const L = LOOT[p.type];
  if (!L) return false;
  const l = rvLocal(p.body.translation()), r = L.shape[0] === 'box' ? Math.max(L.shape[1], L.shape[2], L.shape[3]) : Math.max(L.shape[1], L.shape[2] || 0);
  return l.x - r < -1.12 + pad && l.x + r > -1.3 && l.z + r > -0.32 - pad && l.z - r < 1.02 + pad && l.y > -0.6 && l.y < 2.2;
}
// open or shut the door (whoever is within reach of it); never shut on something in the doorway
function setDoor(open) {
  if (sim().doorOpen === open) return true;
  if (!open && !doorwayClear()) { health.doorLeftOpen++; return true; }
  const by = crew.find(b => !b.ko && b.seat == null && (() => { const l = rvLocal(b.world()); return Math.hypot(l.x + 1.2, l.z - DZ) < 3.0; })());
  if (by) by.use('door');
  return sim().doorOpen === open;
}
// a bot on the ground climbs in: to the door's foot, the door opened, up the steps, to `spot` (RV-local)
function* climbIn(bot, spot) {
  yield* walk(bot, doorFoot);
  if (!sim().doorOpen) { bot.use('door'); yield; }
  // up to the first step on foot, then riding (a page parents you to the RV on its steps)
  yield* walk(bot, () => { const w = rvAt({ x: -1.95, y: 0, z: DZ }); return { x: w.x, z: w.z }; });
  bot.frame = 'rv'; bot.feet = { x: -1.8, y: -0.85, z: DZ };
  yield* walkIn(bot, { x: -0.85, z: DZ });
  yield* walkIn(bot, spot);
}
// a rider or a seated bot gets out: up from the seat, to the door, opened, down the steps, `away` m off it
function* climbOut(bot, away = 0) {
  if (bot.seat != null) { bot.use('unseat'); yield; }
  if (bot.frame === 'rv') {
    yield* walkIn(bot, { x: -0.85, z: DZ });
    if (!sim().doorOpen) { bot.use('door'); yield; }
    yield* walkIn(bot, { x: -1.8, z: DZ });
    const w = rvAt({ x: -1.95, y: 0, z: DZ });
    bot.frame = 'ground'; bot.feet = { x: w.x, y: ground(w.x, w.z), z: w.z }; bot.last = { ...bot.feet };
    yield* walk(bot, doorFoot);
  }
  if (away) { const w = rvAt({ x: -2.6 - away, y: 0, z: DZ }); yield* walk(bot, { x: w.x, z: w.z }); }
}
// everyone aboard: the day's driver at the wheel, the next one in the passenger seat, the rest crouched on
// the floor; the door shut behind the last one in
function* board() {
  const drvId = room.roles.drv, drvBot = crew.find(b => b.id === drvId && !b.ko) || crew.find(b => !b.ko);
  const order = [drvBot, ...crew.filter(b => b !== drvBot)];
  yield* all(...order.map((b, i) => (function* () {
    if (b.ko) return;
    if (b.frame !== 'rv') yield* climbIn(b, i === 0 ? RV_SEAT_EXIT[0] : i === 1 ? RV_SEAT_EXIT[1] : RIDE[(i - 2) % RIDE.length]);
    else if (b.seat == null) yield* walkIn(b, i === 0 ? RV_SEAT_EXIT[0] : i === 1 ? RV_SEAT_EXIT[1] : RIDE[(i - 2) % RIDE.length]);
    if (i < 2 && b.seat == null) { b.use(i === 0 ? 'seat0' : 'seat1'); yield; }
    b.crouch = b.seat == null;
  })()));
  if (drvBot.seat !== 0) {
    // (somebody else may take the wheel while the drawn driver is away: the room decides)
    for (const b of order) { if (b.seat == null && !b.ko) { yield* walkIn(b, RV_SEAT_EXIT[0]); b.use('seat0'); yield; if (b.seat === 0) break; } }
  }
  if (!crew.some(b => b.seat === 0)) fail('nobody could take the wheel');
  // (something in the doorway: the door can't shut on it, and the road throws it out. A rider tidies it away)
  if (!doorwayClear()) {
    const i = order.findIndex(b => !b.ko && b.seat == null && b.frame === 'rv');
    if (i >= 0) { yield* tidy(order[i]); yield* walkIn(order[i], i === 1 ? RV_SEAT_EXIT[1] : RIDE[(i - 2 + RIDE.length) % RIDE.length]); if (i === 1) { order[i].use('seat1'); yield; } }
  }
  yield* until(() => setDoor(false), 3, 'shutting the door');
}
// a rider picks up what's in the doorway and sets it down at a free spot in the RV (one too heavy to lift alone
// is dragged there along the floor: one pair of hands drags what it can't lift)
function* tidy(bot) {
  for (let n = 0; n < 4; n++) {
    const p = [...sim().props.values()].find(q => q.type !== 'map' && LOOT[q.type] && !q.holders.size && inDoorway(q, 0));
    if (!p) return true;
    const L = LOOT[p.type], half = halfOf(L), drag = hands(L) > 1;
    const spot = packer.take(L, p.type);
    if (!spot) { trace(`  nowhere to put the ${p.type} from the doorway`); return false; }
    const at = rvLocal(p.body.translation());
    yield* walkIn(bot, { x: -0.6, z: clamp(at.z, -0.2, 0.9) });
    const w = p.body.translation(), d = reach(bot, w);
    room.handle(bot.P, { t: 'grab', kind: 'prop', id: p.id, pt: [w.x, w.y, w.z], d });
    bot.holdD = sim().holds.get(bot.id)?.dist ?? d;
    if (held(bot) !== p.id) { packer.give(spot); room.handle(bot.P, { t: 'rel' }); trace(`  couldn't pick up the ${p.type} in the doorway`); return false; }
    let GL = { ...at };
    const over = Math.min(1.75 - half, Math.max(half + 0.12, spot.y + half + 0.12, packer.top() + half + 0.12));
    const path = drag ? [{ x: -0.55, y: at.y, z: at.z }, { x: spot.x, y: at.y, z: spot.z }]
      : [{ x: at.x, y: over, z: at.z }, { x: -0.55, y: over, z: at.z }, { x: spot.x, y: over, z: spot.z }, { x: spot.x, y: spot.y + half + 0.01, z: spot.z }];
    for (const q of path) {
      const from = { ...GL }, steps = Math.max(1, Math.round(Math.hypot(q.x - from.x, q.y - from.y, q.z - from.z) / (drag ? 0.45 : 0.8) * HZ));
      for (let i = 1; i <= steps; i++) {
        GL = { x: from.x + (q.x - from.x) * i / steps, y: from.y + (q.y - from.y) * i / steps, z: from.z + (q.z - from.z) * i / steps };
        const dx = GL.x - bot.feet.x, dz = GL.z - bot.feet.z, dd = Math.hypot(dx, dz);
        if (dd > 1.1) stepLocal(bot, { x: clamp(GL.x - dx / dd * 0.9, -1.0, 1.0), z: clamp(GL.z - dz / dd * 0.9, -3.7, 2.4) }, C.PLAYER.WALK);
        reach(bot, rvAt(GL));
        yield;
        if (held(bot) !== p.id) break;
      }
    }
    for (let i = 0; i < 0.5 * HZ; i++) { reach(bot, rvAt(GL)); yield; }
    room.handle(bot.P, { t: 'rel' }); bot.holdD = null;
    packer.give(spot);
    yield* wait(0.3);
    trace(`  tidied the ${p.type} out of the doorway`);
  }
  return doorwayClear();
}

// ---- driving ------------------------------------------------------------------------------------------------
const pedals = { th: 0, st: 0, hb: 1 };
// keyboard steering at a world point, the way a careful driver taps A and D: the key is held for a share of
// each 0.1 s that grows with the heading error (full lock only for a big one; at speed it takes a bigger
// error), so the load isn't thrown about by a full-lock correction at 13 m/s (0.7 g sideways)
const tap = duty => (room.t * 10) % 1 < duty;
function steerAt(goal) {
  const p = sim().rv.translation(), f = fwd(), tx = goal.x - p.x, tz = goal.z - p.z;
  const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz);
  if (Math.abs(err) < 0.015) return 0;
  const full = Math.abs(rvV()) > 6 ? 0.3 : 0.18;
  return tap(Math.min(1, Math.abs(err) / full)) ? Math.sign(err) : 0;
}
// the lane's middle `ahead` m on, `lat` m to the side of the road's middle
const lane = (z, lat = 0, ahead = 10) => ({ x: W().roadX(z + ahead) + lat, z: z + ahead });
// drive to `z` (the RV's middle) and stop there: as fast as `vmax`, braking in time; `lat(z)` the lane offset
function* driveTo(zStop, { vmax = 13, lat = () => 0, stop = true, maxS = 300 } = {}) {
  const was = PHASE; PHASE = `driving (${was})`;
  for (let i = 0; i < maxS * HZ; i++) {
    const z = rvZ(), v = rvV(), dz = zStop - z;
    if (dz < 0.6 || (!stop && dz < 2)) break;
    // (slowing the way a careful driver does: off the throttle early and coasting, then taps of the brake that
    // grow with how much too fast; a held brake only at a crawl. A held brake from cruise slides the load
    // the length of the floor into the front wall)
    const want = Math.min(vmax(z), Math.sqrt(2 * 1.0 * Math.max(0, dz - 0.8)) + 0.3), over = v - want;
    pedals.hb = 0;
    pedals.th = over < -0.25 ? 1 : over < 0.5 ? 0 : v < 2.5 ? -1 : tap(Math.min(1, (over - 0.5) / 2.5)) ? -1 : 0;
    pedals.st = steerAt(lane(z, lat(z), Math.max(8, v * 1.6)));
    yield;
    if (room.phase === 'over') { PHASE = was; return; }
  }
  PHASE = was;
  if (stop) yield* halt();
}
// on the brakes to a standstill, then the handbrake
function* halt() {
  pedals.st = 0;
  for (let i = 0; i < 8 * HZ && Math.abs(rvV()) > 0.25; i++) { pedals.th = rvV() > 0 ? -1 : 1; pedals.hb = 0; yield; }
  pedals.th = 0; pedals.hb = 1;
  yield* wait(0.3);
}

// ---- the leg's plan -------------------------------------------------------------------------------------
// what happens on today's road, in order: honks, obstacles, the Grumphorns to creep past, town
function legPlan() {
  const w = W(), out = [];
  for (const r of w.rockfalls || []) out.push({ k: 'honk', z: r.obz - 42, rf: r });
  for (const o of w.obstacles) out.push({ k: o.type, z: (o.z0 ?? o.z) - ({ gate: 8.5, boulder: 11, mud: 12, grade: 5.5 }[o.type] ?? 10), o });
  for (const p of w.pois) if (p.type !== 'crash') out.push({ k: 'stop', z: p.z - DZ, poi: p });
  out.push({ k: 'town', z: w.LEN - 8 });
  return out.sort((a, b) => a.z - b.z);
}
// the lane offset past the day's sleeping Grumphorns: 3.25 m off the road's middle on the side clear of the
// obstacle's hardware (mud: -x, its tree is on +x; the gate: +x, the keypad post is on -x; the boulder: away
// from its dead tree), held from 34 m short of the bed to 24 m past it
function bedSide(bed) {
  if (bed.ob === 'mud') return -1;
  if (bed.ob === 'gate') return 1;
  const tree = W().anchors.find(a => Math.abs(a.z - (bed.obz + 26)) < 1);
  return tree ? -Math.sign(tree.x - W().roadX(tree.z)) || 1 : 1;
}
function latFor(z) {
  for (const bed of W().beds || []) {
    const m = beastAt(bed);
    if (!m || mobSt(m) === GST.LEFT) continue;
    // (eased over and back over 12 m: snapping back to the middle at 5 m/s threw the load at the wall)
    const k = clamp(Math.min(z - (bed.z - 46), (bed.z + 36) - z) / 12, 0, 1);
    if (k > 0) return bedSide(bed) * 3.25 * k;
  }
  return 0;
}
// how fast the RV may go here: creeping (2.4 m/s) past a sleeping Grumphorn
function vmaxFor(z) {
  for (const bed of W().beds || []) {
    const m = beastAt(bed);
    if (!m) continue;
    const st = mobSt(m);
    if (st === GST.LEFT || st === GST.LEAVE) continue;
    if (z > bed.z - 34 && z < bed.z + 22) return 2.4;
    if (z > bed.z - 60 && z <= bed.z - 34) return Math.max(2.4, (bed.z - 34 - z) * 0.4 + 2.4);
  }
  return 13;
}
const beastAt = bed => [...sim().props.values()].find(p => p.type === 'grumphorn' && Math.hypot(p.body.translation().x - bed.x, p.body.translation().z - bed.z) < 30) || null;

// ---- obstacles ----------------------------------------------------------------------------------------------
const driver = () => crew.find(b => b.seat === 0);
const footCrew = (n, except = []) => crew.filter(b => !b.ko && !except.includes(b)).sort((a, b) => (a.seat === 0) - (b.seat === 0)).slice(0, n);

// the LOOSE ROCK sign: stop, honk, let it come down (the rocks are live 8 s after they fall)
function* honk(rf) {
  if ((room.gameState().rfd || []).includes(rf.id)) return;
  yield* driveTo(rf.obz - 42, { vmax: vmaxFor, lat: latFor });
  const d = driver();
  if (d) room.handle(d.P, { t: 'horn' });
  const fell = yield* until(() => (room.gameState().rfd || []).includes(rf.id), 4);
  if (!fell) { trace('  (the honk brought nothing down)'); return; }
  yield* wait(RF.WARN + RF.GAP * 6 + RF.LIVE);
}
// the ranger gate: one walks out and climbs to the painted code on the rim, one waits by the keypad and types
// what they shout down (from within a voice's range)
function* gate(o) {
  if ((room.gameState().gates || []).includes(o.gate)) return;
  yield* driveTo(o.z - 8.5, { vmax: vmaxFor, lat: latFor });
  const [reader, typer] = footCrew(2);
  const kp = W().uses.find(u => u.kind === 'keypad' && u.arg === o.gate);
  const at = o.codeAt, side = Math.sign(at.x - W().roadX(at.z)) || 1;
  // (the reader stops 4 m short of the paint, on the rim)
  const goal = { x: at.x - side * 4, z: at.z };
  let heard = false;
  yield* all(
    (function* () { yield* climbOut(reader); yield* walk(reader, goal); })(),
    typer && typer !== reader ? (function* () { yield* climbOut(typer); yield* walk(typer, { x: kp.x + 1.0, z: kp.z }); })() : null,
  );
  const tb = typer && typer !== reader ? typer : reader;
  if (tb === reader) yield* walk(reader, { x: kp.x + 1.0, z: kp.z });
  // (shouted down: within a voice's range of the keypad, else the reader comes down closer)
  heard = Math.hypot(reader.feet.x - tb.feet.x, reader.feet.y - tb.feet.y, reader.feet.z - tb.feet.z) < C.VOICE.RANGE - 2;
  if (!heard) yield* walk(reader, () => ({ x: tb.feet.x + side * 4, z: tb.feet.z }), C.PLAYER.WALK, C.VOICE.RANGE - 3);
  yield* wait(1.5);
  tb.useId(kp, { code: o.code });
  yield;
  if (!(room.gameState().gates || []).includes(o.gate)) fail(`the gate didn't open (code ${o.code})`);
  yield* board();
}
// the boulder: two or three of them walk into its side and shove it across the road (a push every 0.1 s, as a
// page sends one while you walk into something), clear of the lane the RV takes
function* boulder(o) {
  const b0 = [...sim().props.values()].find(p => p.type === 'boulder' && Math.abs(p.body.translation().z - o.z) < 5);
  if (!b0) return;
  yield* driveTo(o.z - 11, { vmax: vmaxFor, lat: latFor });
  const bed = (W().beds || []).find(b => b.ob === 'boulder' && b.obz === o.z);
  // (pushed toward the side the RV won't take: away from the beast's pass lane, else whichever has more room)
  const side = bed ? -bedSide(bed) : roomSide(o.z);
  const pushers = footCrew(Math.min(3, crew.length));
  yield* all(...pushers.map(b => climbOut(b)));
  const faceOf = (k, n) => {
    const t = b0.body.translation(), ax = qRotate(b0.body.rotation(), { x: 1, y: 0, z: 0 }), az = qRotate(b0.body.rotation(), { x: 0, y: 0, z: 1 });
    const s = Math.sign(ax.x * side) || 1, along = (k - (n - 1) / 2) * 0.9;
    return { foot: { x: t.x - s * ax.x * 2.36 + az.x * along, z: t.z - s * ax.z * 2.36 + az.z * along }, pt: { x: t.x - s * ax.x * 2.0 + az.x * along, z: t.z - s * ax.z * 2.0 + az.z * along }, dir: { x: s * ax.x, z: s * ax.z } };
  };
  yield* all(...pushers.map((b, k) => walk(b, () => faceOf(k, pushers.length).foot)));
  const done = () => { const t = b0.body.translation(); return Math.abs(t.x - W().roadX(t.z)) > 4.6; };
  let still = 0, last = { ...b0.body.translation() };
  for (let i = 0; i < 40 * HZ && !done(); i++) {
    pushers.forEach((b, k) => {
      const f = faceOf(k, pushers.length);
      b.feet = { x: f.foot.x, y: ground(f.foot.x, f.foot.z), z: f.foot.z }; b.yaw = Math.atan2(f.dir.x, f.dir.z);
      if ((i + 2 * k) % 6 === 0) room.handle(b.P, { t: 'push', kind: 'prop', id: b0.id, pt: [f.pt.x, b.feet.y + 0.9, f.pt.z], dir: [f.dir.x, 0, f.dir.z] });
    });
    yield;
    const t = b0.body.translation();
    if (Math.hypot(t.x - last.x, t.z - last.z) < 0.002) still++; else still = 0;
    last = { ...t };
    if (still > 4 * HZ) break;
  }
  if (!done()) fail(`the boulder only went ${Math.abs(b0.body.translation().x - W().roadX(b0.body.translation().z)).toFixed(1)} m off the road`);
  yield* board();
}
// which side of the road has more room at z (+1 or -1)
function roomSide(z) {
  const rx = W().roadX(z), ry = W().roadY(z);
  let L = 0, R = 0;
  for (let d = 0; d < 20; d += 0.25) { if (!L && ground(rx - d, z) - ry > 0.6) L = d; if (!R && ground(rx + d, z) - ry > 0.6) R = d; }
  return (R || 20) >= (L || 20) ? 1 : -1;
}
// the mud: in at 5 m/s until it's stuck, then everyone but the driver out and pushing from behind while the
// driver floors it; once it's out, they walk up and climb back in
function* mud(o) {
  yield* driveTo(o.z0 - 12, { vmax: vmaxFor, lat: latFor, stop: false });
  let stuck = 0;
  for (let i = 0; i < 40 * HZ; i++) {
    const z = rvZ(), v = rvV();
    pedals.hb = 0; pedals.th = v < 5 ? 1 : 0; pedals.st = steerAt(lane(z, latFor(z), 8));
    yield;
    stuck = (room.gameState().mud || 0) && Math.abs(v) < 0.4 ? stuck + 1 : 0;
    if (stuck > 2 * HZ || z - 2.6 > o.z1 + 0.5) break;
  }
  if (rvZ() - 2.6 > o.z1 + 0.5) return;
  const pushers = footCrew(crew.length).filter(b => b.seat !== 0);
  if (!pushers.length) { trace('  nobody to push: the driver crawls it out'); }
  yield* all(...pushers.map(b => climbOut(b)));
  const behind = k => { const lx = (k - (pushers.length - 1) / 2) * 0.7; return rvAt({ x: lx, y: 0, z: -4.6 }); };
  yield* all(...pushers.map((b, k) => walk(b, () => behind(k))));
  const out = () => rvZ() - 2.6 > o.z1 + 0.5;
  for (let i = 0; i < 150 * HZ && !out(); i++) {
    const z = rvZ(), v = rvV(), f = fwd();
    const near = vmaxFor(z) < 13;
    pedals.hb = 0; pedals.th = near ? (v > 2.4 ? -1 : 0.6) : 1; pedals.st = steerAt(lane(z, latFor(z), 8));
    pushers.forEach((b, k) => {
      const spot = behind(k), d = hyp(b.feet, spot), s = Math.min(d, C.PLAYER.WALK * DT);
      if (d > 1e-3) b.feet = { x: b.feet.x + (spot.x - b.feet.x) / d * s, y: ground(b.feet.x, b.feet.z), z: b.feet.z + (spot.z - b.feet.z) / d * s };
      b.yaw = Math.atan2(f.x, f.z);
      if (d < 0.3 && (i + 2 * k) % 6 === 0) { const c = rvAt({ x: (k - (pushers.length - 1) / 2) * 0.7, y: -0.3, z: -4.18 }); room.handle(b.P, { t: 'push', kind: 'rv', pt: [c.x, b.feet.y + 0.9, c.z], dir: [f.x, 0, f.z] }); }
    });
    yield;
  }
  if (!out()) fail('stuck in the mud');
  yield* halt();
  yield* board();
}
// a grade: stop at its foot; one takes the hook up to the nearer post and clips it on; the driver reels in
// (easing the throttle) until the back wheels are over the top; unhooked, the hook reeled home
function* grade(o) {
  yield* driveTo(o.z0 - 5.5, { vmax: vmaxFor, lat: latFor });
  const [hk] = footCrew(1, [driver()]).length ? footCrew(1, [driver()]) : footCrew(1);
  const d = driver();
  yield* climbOut(hk);
  const w = sim().winchWorld();
  yield* walk(hk, { x: w.x - 1.2, z: w.z + 1.0 });
  hk.use('winch'); yield;
  if (sim().hook.state !== 'out' || sim().hook.holder !== hk.id) { fail('could not take the hook'); return; }
  const posts = W().anchors.filter(a => Math.abs(a.z - (o.z1 + 12)) < 1.5);
  const post = posts.sort((a, b) => Math.abs(a.x - hk.feet.x) - Math.abs(b.x - hk.feet.x))[0];
  if (!post) { fail('no posts past the grade'); return; }
  const inward = Math.sign(W().roadX(post.z) - post.x) || 1;
  yield* walk(hk, { x: post.x + inward * 1.0, z: post.z - 0.6 });
  hk.use('hook'); yield;
  if (sim().hook.state !== 'anchored') { fail('could not clip the hook on'); return; }
  // (stand clear of the road while it comes up)
  yield* walk(hk, { x: post.x - inward * 1.5, z: post.z - 3 });
  if (d) d.use('reel'); else hk.use('reel');
  let best = rvZ(), still = 0;
  const over = () => rvZ() - 2.6 > o.z1 + 2;
  for (let i = 0; i < 60 * HZ && !over(); i++) {
    pedals.hb = 0; pedals.th = 0.5; pedals.st = steerAt(lane(rvZ(), 0, 8));
    yield;
    if (rvZ() > best + 0.02) { best = rvZ(); still = 0; } else still++;
    if (still > 2 * HZ) break;
  }
  if (sim().hook.reeling) (d || hk).use('reel');
  yield* halt();
  if (!over()) fail(`the winch left it ${(o.z1 + 2 - (rvZ() - 2.6)).toFixed(1)} m short of the top`);
  // unhook, reel it home
  yield* walk(hk, () => { const a = sim().hookPos(); return { x: a.x - inward * 1.2, z: a.z }; });
  hk.use('hook'); yield;
  if (d) d.use('reel'); else hk.use('reel');
  yield* until(() => sim().hook.state === 'stowed', 12, 'reeling the hook home');
  yield* board();
}

// ---- carrying ------------------------------------------------------------------------------------------------
// The validated controller (scratch carry3 in the mapping run): the item's middle follows a planned point G; each
// porter looks at G and sets its hold distance to reach it ({t:'hd'}) whenever it drifts by 3 cm; feet follow at
// a page's carrying speed (2-handed x0.78, heavy x0.5); at the RV's open door the room's own helpers lift it
// over the sill and turn it end-on. One thing through the door at a time.
const halfOf = L => (L.shape[0] === 'box' ? L.shape[2] : L.shape[1]);
// (for getting through doorways people turn things edge-on: a box plans with the middle of its narrow and
// wide sides)
const radiusOf = L => (L.shape[0] === 'box' ? (Math.min(L.shape[1], L.shape[3]) + Math.max(L.shape[1], L.shape[3])) / 2 : L.shape[0] === 'cyl' ? L.shape[2] : L.shape[1]);
const speedOf = L => (L.cls === 'heavy' ? 0.5 : L.cls === '2h' ? 0.78 : 1) * C.PLAYER.WALK;
const hands = L => (L.cls === 'heavy' && L.mass > 96 ? 2 : 1);   // (one pair of hands lifts 96.8 kg: 950 N)
// Where it goes in the RV: fitted into what's free right now (RV-local), the deep end first. The floor's open
// areas take anything; the bunks, the table, the counter, the benches and the icebox take small things. The
// landing inside the door stays clear for the next one in, and so does the doorway (a door shut on something
// poking through it crushes it).
const AREAS = [
  { x0: -1.1, x1: 0.7, z0: -1.7, z1: 0.25, y: 0 },          // the rear open floor
  { x0: 0.7, x1: 1.12, z0: -0.55, z1: 0.25, y: 0 },          // (its corner by the icebox)
  { x0: -0.35, x1: 1.12, z0: -2.9, z1: -1.45, y: 0 },        // the aisle by the shower
  { x0: -0.55, x1: 0.3, z0: 0.8, z1: 2.5, y: 0 },            // the front aisle
  { x0: -1.1, x1: 1.1, z0: -3.85, z1: -3.0, y: 0.56, small: true },   // the bed
  { x0: -1.1, x1: 1.1, z0: -3.85, z1: -3.0, y: 1.5, small: true },    // the upper bunk
  { x0: 0.4, x1: 1.15, z0: 0.8, z1: 1.5, y: 0.78, small: true },      // the table
  { x0: -1.15, x1: -0.65, z0: 1.4, z1: 2.5, y: 0.92, small: true },   // the counter
  { x0: 0.4, x1: 1.15, z0: 0.32, z1: 0.68, y: 0.44, small: true },    // the benches
  { x0: 0.4, x1: 1.15, z0: 1.62, z1: 1.98, y: 0.44, small: true },
  { x0: 0.75, x1: 1.12, z0: -1.38, z1: -0.62, y: 0.7, small: true },  // the icebox
];
const LANDING = { x0: -1.4, x1: -0.15, z0: -0.15, z1: 0.95 };
const small = L => L.cls === '1h' || (L.cls === '2h' && L.mass <= 9 && halfOf(L) < 0.4);
// a thing's footprint (its widest horizontal half-extent: it may turn as it's set down)
const footOf = L => (L.shape[0] === 'box' ? Math.max(L.shape[1], L.shape[3]) : L.shape[0] === 'cyl' ? L.shape[2] : L.shape[1]);
class Packer {
  constructor() { this.held = []; }   // spots promised to things on their way in
  take(L, type) {
    const r = footOf(L) + 0.06, h = halfOf(L);
    const here = sim().cargo().map(id => { const p = sim().props.get(id), l = rvLocal(p.body.translation()); return { x: l.x, y: l.y, z: l.z, r: footOf(LOOT[p.type]) + 0.04 }; });
    const busy = [...here, ...this.held];
    let best = null;
    for (const A of AREAS) {
      if (A.small && !small(L)) continue;
      if (L.cls === 'heavy' && A.y > 0) continue;
      for (let z = A.z0 + r; z <= A.z1 - r + 1e-6; z += 0.1) for (let x = A.x0 + r; x <= A.x1 - r + 1e-6; x += 0.1) {
        if (x - r < LANDING.x1 && x + r > LANDING.x0 && z + r > LANDING.z0 && z - r < LANDING.z1) continue;
        if (busy.some(b => Math.hypot(b.x - x, b.z - z) < b.r + r && Math.abs(b.y - (A.y + h)) < 0.9)) continue;
        // (deepest first; among equals, nearest the middle; the floor before the furniture)
        const score = z + Math.abs(x) * 0.05 + A.y * 0.5;
        if (!best || score < best.score) best = { x, z, y: A.y, r, score };
      }
    }
    if (!best) return null;
    const spot = { x: best.x, z: best.z, y: best.y + h, r: best.r, top: best.y, idx: [] };
    this.held.push(spot);
    return { ...spot, y: best.y, ref: spot };
  }
  give(spot) { this.held = this.held.filter(s => s !== (spot.ref || spot)); }
  // the highest top of anything in the RV now (a thing carried in goes over it)
  top() { let t = 0; for (const id of sim().cargo()) { const p = sim().props.get(id), l = rvLocal(p.body.translation()); t = Math.max(t, l.y + halfOf(LOOT[p.type])); } return t; }
}
let packer = new Packer(), doorBusy = null;

// what's solid for a carried thing's middle at (x, z): boxes taller than its bottom, posts and trees, rocks,
// the RV; `lift`: its middle over the ground there
function solidAt(x, z, r, half, lift, list) {
  const g = ground(x, z), lo = g + lift - half - 0.04, hi = g + lift + half;
  for (const s of list.statics) {
    if (s.y + s.hy < lo || s.y - s.hy > hi) continue;
    const c = Math.cos(s.ry || 0), sn = Math.sin(s.ry || 0), dx = x - s.x, dz = z - s.z;
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    const qx = Math.max(-s.hx, Math.min(s.hx, lx)), qz = Math.max(-s.hz, Math.min(s.hz, lz));
    if (Math.hypot(lx - qx, lz - qz) < r) return true;
  }
  for (const cy of list.cyls) if (Math.hypot(x - cy.x, z - cy.z) < cy.r + r) return true;
  for (const h of list.hulls) if (Math.hypot(x - h.x, z - h.z) < h.r * 0.8 + r) return true;
  const l = rvLocal({ x, y: g + lift, z });
  if (Math.abs(l.x) < RV_DIM.HALF_W + r && Math.abs(l.z) < RV_DIM.HALF_L + r) return true;
  return false;
}
// a binary heap of (cost, cell)
class Heap {
  constructor() { this.c = []; this.k = []; }
  get size() { return this.c.length; }
  push(c, k) {
    const C2 = this.c, K = this.k; let i = C2.length; C2.push(c); K.push(k);
    while (i > 0) { const p = (i - 1) >> 1; if (C2[p] <= c) break; C2[i] = C2[p]; K[i] = K[p]; i = p; }
    C2[i] = c; K[i] = k;
  }
  pop() {
    const C2 = this.c, K = this.k, top = K[0], c = C2.pop(), k = K.pop(), n = C2.length;
    if (n) {
      let i = 0;
      for (;;) { let m = 2 * i + 1; if (m >= n) break; if (m + 1 < n && C2[m + 1] < C2[m]) m++; if (C2[m] >= c) break; C2[i] = C2[m]; K[i] = K[m]; i = m; }
      C2[i] = c; K[i] = k;
    }
    return top;
  }
}
// the carried thing's path (world x/z points) from `from` to `to`: A* over a 0.35 m grid round everything solid,
// on ground a porter can walk (no step steeper than 35 degrees), then pulled straight where it can be
function carryPath(from, to, L, lift, squeeze = 1) {
  const r = (radiusOf(L) + 0.1) * squeeze, half = halfOf(L), cs = 0.25;
  const x0 = Math.min(from.x, to.x) - 8, z0 = Math.min(from.z, to.z) - 8, nx = Math.ceil((Math.max(from.x, to.x) + 8 - x0) / cs), nz = Math.ceil((Math.max(from.z, to.z) + 8 - z0) / cs);
  if (nx * nz > 160000) return null;
  const cx = i => x0 + (i + 0.5) * cs, cz = j => z0 + (j + 0.5) * cs;
  const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }, R = Math.hypot(from.x - to.x, from.z - to.z) / 2 + 14;
  const list = {
    statics: W().statics.filter(s => s.mat !== 'invisible' && Math.hypot(s.x - mid.x, s.z - mid.z) < R + Math.max(s.hx, s.hz)),
    cyls: W().cyls.filter(c => Math.hypot(c.x - mid.x, c.z - mid.z) < R),
    hulls: (W().hulls || []).filter(h => Math.hypot(h.x - mid.x, h.z - mid.z) < R + h.r),
  };
  const N = nx * nz, blocked = new Uint8Array(N), gy = new Float32Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; gy[k] = ground(cx(i), cz(j)); blocked[k] = solidAt(cx(i), cz(j), r, half, lift, list) ? 1 : 0; }
  const cellOf = p => [clamp(Math.floor((p.x - x0) / cs), 0, nx - 1), clamp(Math.floor((p.z - z0) / cs), 0, nz - 1)];
  const [si, sj] = cellOf(from), [ti, tj] = cellOf(to), sk = sj * nx + si, tk = tj * nx + ti;
  blocked[sk] = 0; blocked[tk] = 0;   // (it starts and ends where it is)
  const tan = Math.tan(35 * Math.PI / 180);
  const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), shut = new Uint8Array(N), open = new Heap();
  g[sk] = 0; open.push(0, sk);
  const h = k => Math.hypot((k % nx) - ti, Math.floor(k / nx) - tj) * cs;
  let found = false;
  for (let it = 0; open.size && it < 400000; it++) {
    const k = open.pop();
    if (shut[k]) continue;
    shut[k] = 1;
    if (k === tk) { found = true; break; }
    const i = k % nx, j = Math.floor(k / nx);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = b * nx + a, step = Math.hypot(di, dj) * cs;
      if (blocked[n] || Math.abs(gy[n] - gy[k]) > step * tan) continue;
      const ng = g[k] + step;
      if (ng < g[n]) { g[n] = ng; came[n] = k; open.push(ng + h(n), n); }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let k = tk; k !== -1; k = came[k]) cells.unshift({ x: cx(k % nx), z: cz(Math.floor(k / nx)) });
  cells[0] = { x: from.x, z: from.z }; cells[cells.length - 1] = { x: to.x, z: to.z };
  // pulled straight: from each point, as far along as a straight line stays clear and walkable
  const clear = (a, b) => {
    const n = Math.max(2, Math.ceil(hyp(a, b) / 0.15));
    let py = ground(a.x, a.z);
    for (let q = 1; q <= n; q++) {
      const x = a.x + (b.x - a.x) * q / n, z = a.z + (b.z - a.z) * q / n, y = ground(x, z);
      if (solidAt(x, z, r, half, lift, list) || Math.abs(y - py) > (hyp(a, b) / n) * tan) return false;
      py = y;
    }
    return true;
  };
  const out = [cells[0]];
  for (let q = 0; q < cells.length - 1;) {
    let best = q + 1;
    for (let e = cells.length - 1; e > q + 1; e--) if (clear(cells[q], cells[e])) { best = e; break; }
    out.push(cells[best]); q = best;
  }
  return out;
}
// a point `s` m along a path (clamped to its ends), and the path's length
const pathLen = P => { let L = 0; for (let i = 1; i < P.length; i++) L += hyp(P[i - 1], P[i]); return L; };
function along(P, s) {
  if (s <= 0) return { ...P[0] };
  for (let i = 1; i < P.length; i++) { const d = hyp(P[i - 1], P[i]); if (s <= d) { const f = d > 1e-6 ? s / d : 0; return { x: P[i - 1].x + (P[i].x - P[i - 1].x) * f, z: P[i - 1].z + (P[i].z - P[i - 1].z) * f }; } s -= d; }
  return { ...P[P.length - 1] };
}
// where a porter stands: the ground, or a floor it's on (a shop's slab, a trailer's floor or ramp)
const FLOORS = new Set(['floor', 'trailer_floor', 'ramp']);
function standY(x, z) {
  let y = W().topAt ? W().topAt(x, z) : ground(x, z);
  for (const s of W().statics) {
    if (!FLOORS.has(s.part) || Math.abs(s.x - x) > s.hx + s.hz + 1 || Math.abs(s.z - z) > s.hx + s.hz + 1) continue;
    const c = Math.cos(s.ry || 0), sn = Math.sin(s.ry || 0), dx = x - s.x, dz = z - s.z;
    if (Math.abs(dx * c - dz * sn) < s.hx && Math.abs(dx * sn + dz * c) < s.hz) y = Math.max(y, s.y + s.hy);
  }
  return y;
}
// a porter's eye (world)
const eyeOf = b => { const f = b.world(); return { x: f.x, y: f.y + (b.crouch ? 1.05 : C.PLAYER.EYE), z: f.z }; };
// look at G and reach it: the hold distance follows the eye's distance to G
function reach(b, G) {
  const e = eyeOf(b), dx = G.x - e.x, dy = G.y - e.y, dz = G.z - e.z, d = Math.hypot(dx, dy, dz);
  const yawW = Math.atan2(dx, dz);
  b.yaw = b.frame === 'rv' ? wrap(yawW - qYaw(rvPose().q)) : yawW;
  b.pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -1.45, 1.45);
  const want = clamp(d, C.GRAB.HOLD_MIN, C.GRAB.HOLD_MAX);
  if (b.holdD == null || Math.abs(want - b.holdD) > 0.03) { b.holdD = want; room.handle(b.P, { t: 'hd', d: want }); }
  return d;
}
// a porter's feet to a world point on foot (no faster than `v`), standing on whatever floor is there
function stepToward(b, to, v) {
  b.frame = 'ground'; b.seat = null; b.crouch = false;
  const f = b.feet, dx = to.x - f.x, dz = to.z - f.z, d = Math.hypot(dx, dz), s = Math.min(d, v * DT);
  const x = d > 1e-6 ? f.x + dx / d * s : f.x, z = d > 1e-6 ? f.z + dz / d * s : f.z;
  b.feet = { x, y: standY(x, z), z };
}
// the same in the RV's frame on the door's line (the steps), switching between the ground and the RV
function stepLocal(b, to, v) {
  const cur = b.frame === 'rv' ? b.feet : (() => { const l = rvLocal(b.feet); return { x: l.x, y: l.y, z: l.z }; })();
  const dx = to.x - cur.x, dz = to.z - cur.z, d = Math.hypot(dx, dz), s = Math.min(d, v * DT);
  const x = d > 1e-6 ? cur.x + dx / d * s : cur.x, z = d > 1e-6 ? cur.z + dz / d * s : cur.z;
  if (x <= -1.84) { const w = rvAt({ x, y: 0, z }); b.frame = 'ground'; b.feet = { x: w.x, y: ground(w.x, w.z), z: w.z }; }
  else { b.frame = 'rv'; b.feet = { x, y: Math.abs(z - DZ) < 0.7 && x < -1.22 ? (x < -1.62 ? -0.85 : -0.42) : 0, z }; }
  b.seat = null;
}
const held = b => sim().holds.get(b.id)?.id ?? null;

// one item, from where it lies to its spot in the RV: false if it couldn't be (no way through, dropped, a jam)
function* carry(team, prop, spot) {
  const L = LOOT[prop.type], half = halfOf(L), v = speedOf(L) * 0.8, heavy = team.length > 1;
  const c0 = prop.body.translation(), g0 = ground(c0.x, c0.z);
  const lift = Math.max(1.0, 0.95 + half, (c0.y - half) - g0 + half + 0.12);
  const door = () => rvAt({ x: -3.0, y: 0, z: DZ });
  const P = carryPath({ x: c0.x, z: c0.z }, door(), L, lift) || carryPath({ x: c0.x, z: c0.z }, door(), L, lift, 0.6);
  if (!P) { trace(`  no way to carry the ${prop.type} out (at ${c0.x.toFixed(1)}, ${(c0.y - ground(c0.x, c0.z)).toFixed(2)} up, ${c0.z.toFixed(1)})`); return false; }
  const len = pathLen(P), dir0 = len > 0.1 ? { x: (along(P, 0.3).x - c0.x) / 0.3, z: (along(P, 0.3).z - c0.z) / 0.3 } : { x: 1, z: 0 };
  // stances: one at 1.2 m along the way out; a second (heavy) 1.2 m behind it
  const st = [along(P, 1.2), { x: c0.x - dir0.x * 1.2, z: c0.z - dir0.z * 1.2 }];
  yield* all(...team.map((b, i) => walk(b, st[i], C.PLAYER.WALK, 0.1)));
  for (const b of team) {
    const cw = prop.body.translation(), d = reach(b, cw);
    if (d > C.PLAYER.REACH + 0.75) { trace(`  ${b.name} can't reach the ${prop.type} (${d.toFixed(1)} m)`); return false; }
    room.handle(b.P, { t: 'grab', kind: 'prop', id: prop.id, pt: [cw.x, cw.y, cw.z], d });
    b.holdD = sim().holds.get(b.id)?.dist ?? d;
  }
  if (team.some(b => held(b) !== prop.id)) { for (const b of team) room.handle(b.P, { t: 'rel' }); trace(`  couldn't grab the ${prop.type}`); return false; }
  const ok = () => sim().props.has(prop.id) && team.every(b => held(b) === prop.id);
  let G = { x: c0.x, y: c0.y, z: c0.z }, sAt = 0;
  const feetFor = () => {
    team.forEach((b, i) => {
      const w = heavy ? (i === 0 ? along(P, sAt + 1.3) : along(P, sAt - 1.3)) : along(P, sAt - 1.3);
      stepToward(b, w, C.PLAYER.WALK);
    });
  };
  // up to carrying height
  const top = g0 + lift;
  for (let i = 0; i < 4 * HZ && G.y < top - 1e-3; i++) { G.y = Math.min(top, G.y + 1.0 * DT); for (const b of team) reach(b, G); yield; if (!ok()) break; }
  for (let i = 0; i < 0.3 * HZ; i++) { for (const b of team) reach(b, G); yield; }
  // along the path to the door's foot
  for (let i = 0; i < 120 * HZ && sAt < len && ok(); i++) {
    // (one thing through the door at a time: wait 3 m short while it's taken)
    if (doorBusy && doorBusy !== prop.id && len - sAt < 3) { for (const b of team) reach(b, G); yield; continue; }
    sAt = Math.min(len, sAt + v * DT);
    const p = along(P, sAt);
    G = { x: p.x, y: ground(p.x, p.z) + lift, z: p.z };
    feetFor();
    for (const b of team) reach(b, G);
    yield;
  }
  if (!ok()) { trace(`  lost the ${prop.type} on the way (${sim().props.has(prop.id) ? 'dropped' : 'broken'})`); for (const b of team) room.handle(b.P, { t: 'rel' }); return false; }
  doorBusy = prop.id;
  // the door: in the RV's frame from here (carry3's path), the door opened if it isn't
  if (!sim().doorOpen) { const near = team.find(b => hyp(b.feet, doorFoot()) < 3.0) || team[0]; near.use('door'); yield; }
  const Hs = half + 0.12, gl = rvLocal(G);
  let GL = { x: gl.x, y: gl.y, z: gl.z };
  const moveL = function* (pts, speed, settle = 0) {
    for (const q of pts) {
      const from = { ...GL }, n = Math.max(1, Math.round(Math.hypot(q.x - from.x, q.y - from.y, q.z - from.z) / speed * HZ));
      for (let i = 1; i <= n; i++) {
        GL = { x: from.x + (q.x - from.x) * i / n, y: from.y + (q.y - from.y) * i / n, z: from.z + (q.z - from.z) * i / n };
        feetL(); const Gw = rvAt(GL); for (const b of team) reach(b, Gw); yield;
        if (!ok()) return;
      }
    }
    for (let i = 0; i < settle * HZ; i++) { feetL(); const Gw = rvAt(GL); for (const b of team) reach(b, Gw); yield; }
  };
  // carry3's feet: one porter 1.3 m behind it on the door's line, up the steps once it's in, then in behind it
  // (within reach) to the spot; heavy: the lead backing in ahead of it, the back one behind it
  const inside = g => { const dx = g.x - (-0.85), dz = g.z - DZ, d = Math.hypot(dx, dz); return d < 1.3 ? { x: -0.85, z: DZ } : { x: clamp(g.x - dx / d * 1.2, -1.0, 1.0), z: clamp(g.z - dz / d * 1.2, -3.7, 2.4) }; };
  const feetL = () => {
    const g = GL;
    team.forEach((b, i) => {
      let want;
      if (!heavy) want = g.x < -2.0 ? { x: g.x - 1.3, z: g.z } : g.x < -1.0 ? { x: Math.max(g.x - 1.3, -2.4), z: DZ } : inside(g);
      else if (i === 0) want = g.x < -3.2 ? { x: g.x + 1.3, z: g.z } : g.x < -1.3 ? { x: Math.min(-0.85, g.x + 1.3), z: DZ } : { x: clamp(g.x + 1.2, -0.6, 0.45), z: clamp(g.z + (g.z < -0.5 ? -1.0 : 0.6), -3.4, DZ) };
      else want = g.x < -0.6 ? { x: Math.min(g.x - 1.3, -2.2), z: g.x < -3.2 ? g.z : DZ } : inside(g);
      stepLocal(b, want, (heavy ? 0.5 : L.cls === '2h' ? 0.78 : 1) * C.PLAYER.WALK);
    });
  };
  const gyL = rvLocal({ x: G.x, y: ground(G.x, G.z), z: G.z }).y;
  yield* moveL([{ x: -3.0, y: Math.max(gyL + lift, Hs), z: DZ }, { x: -2.6, y: Hs, z: DZ }], heavy ? 1.76 : 3.5 * (L.cls === '2h' ? 0.78 : 1), heavy ? 2 : 0.3);
  const dino = prop.type === 'dino';
  if (dino) yield* moveL([{ x: -1.6, y: Hs, z: DZ }, { x: -1.2, y: 0.44 + half + 0.08, z: DZ }, { x: -0.2, y: 0.44 + half + 0.08, z: DZ }], 0.4, 0.3);
  else yield* moveL([{ x: -0.55, y: Hs, z: DZ }], heavy ? 0.4 : 0.8, 0.3);
  const sy = spot.y + half, over = Math.min(1.75 - half, Math.max(Hs, sy + 0.12, packer.top() + half + 0.12));
  if (dino) yield* moveL([{ x: -0.2, y: Math.max(0.44 + half + 0.08, over), z: DZ }, { x: spot.x, y: Math.max(0.44 + half + 0.08, over), z: spot.z }], 0.4, 0.3);
  else yield* moveL([{ x: -0.55, y: over, z: DZ }, { x: spot.x, y: over, z: Math.min(DZ, spot.z + 0.6) }, { x: spot.x, y: over, z: spot.z }], heavy ? 0.4 : 0.8, 0.3);
  yield* moveL([{ x: spot.x, y: sy + 0.01, z: spot.z }], 0.3, 0.6);
  const loaded = ok();
  for (const b of team) { room.handle(b.P, { t: 'rel' }); b.holdD = null; }
  packer.give(spot);
  if (doorBusy === prop.id) doorBusy = null;
  yield* wait(0.4);
  const inRV = sim().cargo().includes(prop.id);
  if (!loaded || !inRV) trace(`  the ${prop.type} didn't make it in (${!sim().props.has(prop.id) ? 'broken' : loaded ? 'fell out' : 'dropped'})`);
  return inRV;
}
// everyone on foot back outside the door (after a carry)
function* outOfRV(b) {
  if (b.frame !== 'rv') return;
  for (let i = 0; i < 6 * HZ; i++) { stepLocal(b, { x: -2.2, z: DZ }, C.PLAYER.WALK); yield; if (b.frame === 'ground') break; }
}

// ---- a stop -------------------------------------------------------------------------------------------------
// its loot: loose and worth something, within 24 m, not on a ringtail's pile or within 7.5 m of a den from day 2
// (they nip), not up on a butte (that's the crash site's own way down)
function stopItems(poi) {
  const dens = (W().dens || []).map(d => d);
  const out = [];
  for (const p of sim().props.values()) {
    const L = LOOT[p.type];
    if (!L || L.tool || p.value <= 0 || p.holders.size) continue;
    const t = p.body.translation();
    if (Math.hypot(t.x - poi.x, t.z - poi.z) > 24) continue;
    if (sim().cargo().includes(p.id)) continue;
    if (room.day >= 2 && dens.some(d => Math.hypot(d.x - t.x, d.z - t.z) < 7.5)) continue;
    if (t.y - ground(t.x, t.z) > 2.5) continue;
    const dist = Math.hypot(t.x - rvZ() * 0 - rvAt({ x: -3, y: 0, z: DZ }).x, t.z - rvAt({ x: -3, y: 0, z: DZ }).z);
    out.push({ prop: p, L, dist, score: p.value / (2 * dist / speedOf(L) + 8) });
  }
  return out.sort((a, b) => b.score - a.score);
}
// is there time for `secs` more here, and the rest of the road and town, before midnight (with a margin)?
function budgetOK(secs, restZ) {
  const w = W(), road = Math.max(0, w.LEN - restZ) / 10;
  const obs = legPlan().filter(e => e.z > restZ + 3).reduce((a, e) => a + ({ honk: 15, gate: 45, boulder: 35, mud: 45, grade: 60, stop: 0, town: 60 }[e.k] ?? 20), 0);
  const left = (C.MIDNIGHT - room.clock) * C.HOUR_SEC;
  return secs + road + obs + 0.75 * C.HOUR_SEC < left;
}
function* stopAt(poi) {
  const zPark = poi.z - DZ, side = poi.side || Math.sign(poi.x - W().roadX(poi.z)) || -1;
  if (!budgetOK(30, poi.z)) { trace(`  no time for the ${poi.type}`); return; }
  // (pulled over toward it, the door abreast of its middle)
  yield* driveTo(zPark, { vmax: vmaxFor, lat: z => (Math.abs(z - zPark) < 30 ? side * 2.4 : latFor(z)) });
  const porters = crew.filter(b => !b.ko && b.seat !== 0);
  if (!porters.length) return;
  yield* all(...porters.map(b => climbOut(b)));
  const tried = new Set();
  let carried = 0;
  for (let round = 0; round < 40; round++) {
    const items = stopItems(poi).filter(x => !tried.has(x.prop.id));
    if (!items.length) break;
    // the heavy ones with every free pair of hands; the rest one each, all at once
    const free = porters.filter(b => !b.ko);
    const heavyIt = items.find(x => hands(x.L) > 1);
    const jobs = [];
    if (heavyIt && free.length >= 2) {
      const spot = packer.take(heavyIt.L, heavyIt.prop.type);
      tried.add(heavyIt.prop.id);
      if (spot && budgetOK(2 * heavyIt.dist / speedOf(heavyIt.L) + 25, poi.z)) jobs.push({ team: free.slice(0, 2), it: heavyIt, spot });
      else if (spot) packer.give(spot);
    } else {
      const light = items.filter(x => hands(x.L) === 1);
      for (const b of free) {
        const it = light.find(x => !tried.has(x.prop.id));
        if (!it) break;
        tried.add(it.prop.id);
        const spot = packer.take(it.L, it.prop.type);
        if (!spot || !budgetOK(2 * it.dist / speedOf(it.L) + 15, poi.z)) { if (spot) packer.give(spot); continue; }
        jobs.push({ team: [b], it, spot });
      }
    }
    if (!jobs.length) { if (heavyIt && free.length < 2 && items.every(x => hands(x.L) > 1)) break; continue; }
    yield* all(...jobs.map(j => (function* () {
      const v0 = Math.round(j.it.prop.value);
      const ok = yield* carry(j.team, j.it.prop, j.spot);
      if (ok) { carried++; dayLog.carried.push({ id: j.it.prop.id, type: j.it.prop.type, v0, vIn: Math.round(j.it.prop.value), poi: poi.type, stop: poi.z, spot: j.spot }); }
      else { packer.give(j.spot); dayLog.failed.push(j.it.prop.type); }
      for (const b of j.team) yield* outOfRV(b);
    })()));
  }
  trace(`  ${poi.type}: ${carried} carried`);
  yield* reload(poi, porters);
  yield* board();
}
// anything carried in at this stop that rolled back out, or sits in the doorway (the first lurch throws it
// out of the door that can't shut on it): carried in again, to a new spot
function* reload(poi, porters) {
  for (let sweep = 0; sweep < 3; sweep++) {
    const inRV = new Set(sim().cargo());
    const mine = dayLog.carried.filter(x => x.stop === poi.z && !x.fate && sim().props.get(x.id));
    for (const x of mine) {
      const p = sim().props.get(x.id), t = p.body.translation(), l = rvLocal(t);
      if (!inRV.has(x.id) || inDoorway(p)) trace(`  ${x.type} #${x.id}: ${inRV.has(x.id) ? 'in the load' : 'not in the load'}${inDoorway(p) ? ', in the doorway' : ''}, RV-local ${l.x.toFixed(2)} ${l.y.toFixed(2)} ${l.z.toFixed(2)}, ${(t.y - ground(t.x, t.z)).toFixed(2)} m up`);
    }
    // (only what's on the ground out here: something in the RV can't be carried in from outside)
    const loose = mine.filter(x => { const p = sim().props.get(x.id), t = p.body.translation(); return !inRV.has(x.id) && t.y - ground(t.x, t.z) < 0.8 && Math.abs(rvLocal(t).x) > RV_DIM.HALF_W + 0.3; });
    if (!loose.length) return;
    trace(`  ${loose.length} loose (${loose.map(x => x.type).join(', ')}): in again`);
    health.reloads = (health.reloads || 0) + loose.length;
    let free = porters.filter(b => !b.ko);
    const jobs = [];
    for (const x of loose) {
      const p = sim().props.get(x.id), L = LOOT[p.type], n = hands(L);
      if (free.length < n) continue;
      packer.give(x.spot);
      const spot = packer.take(L, p.type);
      if (!spot) continue;
      x.spot = spot;
      jobs.push({ team: free.slice(0, n), p, x });
      free = free.slice(n);
    }
    if (!jobs.length) return;
    yield* all(...jobs.map(j => (function* () {
      if (!(yield* carry(j.team, j.p, j.x.spot))) dayLog.failed.push(j.p.type);
      for (const b of j.team) yield* outOfRV(b);
    })()));
  }
}
let dayLog = { carried: [], failed: [] };
// (trace) the moment a thing carried in leaves the RV's load: where it was, and what the RV was doing
let leaveTick = 0, lastIn = new Map();
function watchLoad() {
  const now = new Set(sim().cargo());
  for (const x of dayLog.carried) {
    if (x.fate) continue;
    const p = sim().props.get(x.id);
    if (!p) continue;
    const was = lastIn.get(x.id);
    if (now.has(x.id)) { const l = rvLocal(p.body.translation()); lastIn.set(x.id, { x: l.x, y: l.y, z: l.z }); continue; }
    if (!was) continue;
    lastIn.delete(x.id);
    const q = rvPose().q, up = qRotate(q, { x: 0, y: 1, z: 0 });
    trace(`  OUT: ${x.type} #${x.id} left the load (last RV-local ${was.x.toFixed(2)} ${was.y.toFixed(2)} ${was.z.toFixed(2)}); RV ${sim().rvSpeed().toFixed(1)} m/s at z ${sim().rv.translation().z.toFixed(0)}, tilt ${(Math.acos(Math.min(1, up.y)) * 57.3).toFixed(0)} deg, door ${sim().doorOpen ? 'open' : 'shut'}, hatch ${sim().hatchOpen ?? '?'}`);
  }
}
// what became of each thing carried in (broken, stolen; the bell's sale is noted in the main loop)
function ledgerEvents(evs) {
  for (const e of evs) {
    const c = dayLog.carried.find(x => x.id === e.id && !x.fate);
    if (!c) continue;
    if (e.k === 'break') {
      c.fate = 'broken';
      const l = rvLocal(e), up = qRotate(rvPose().q, { x: 0, y: 1, z: 0 });
      trace(`  BROKE: ${e.type} #${e.id} (in at ${fmt$(c.vIn)}, knocked ${c.knocks || 0} before) at RV-local ${l.x.toFixed(2)} ${l.y.toFixed(2)} ${l.z.toFixed(2)} (${insideRV(l.x, l.y, l.z, 0.1) ? 'inside' : 'outside'}); RV ${rvV().toFixed(1)} m/s, tilt ${(Math.acos(Math.min(1, up.y)) * 57.3).toFixed(0)} deg, ${PHASE}`);
    }
    else if (e.k === 'dmg') {
      c.knocks = (c.knocks || 0) + (e.lost || 0);
      if (WHY && accHist.length) {
        const p = sim().props.get(e.id), l = p && rvLocal(p.body.translation());
        if (l && insideRV(l.x, l.y, l.z, 0.1)) {
          const pk = k => Math.max(...accHist.map(a => Math.abs(a[k])));
          const fz = pk('z'), fx = pk('x'), fy = Math.max(...accHist.map(a => Math.abs(a.y - 9.81)));
          const cause = Math.abs(rvV()) < 0.5 ? 'parked' : fz >= fx && fz >= fy ? 'fore-aft' : fx >= fy ? 'side' : 'bump';
          // (what it's touching, and how deep: two bodies packed into each other get shoved apart hard every step)
          const touch = [];
          const w = sim().world, rvH = sim().rv.handle, rvName = new Map(Object.entries(sim().rvCols).map(([n, cc]) => [cc.handle, n]));
          w.contactPairsWith(p.col, c2 => {
            if (!c2) return;
            let depth = 0, n = 0;
            w.contactPair(p.col, c2, man => { n += man.numContacts(); for (let i = 0; i < man.numContacts(); i++) depth = Math.min(depth, man.contactDist(i)); });
            if (!n) return;
            const id = sim().byCollider.get(c2.handle), nm = id != null ? sim().props.get(id)?.type : c2.parent()?.handle === rvH ? 'rv:' + (rvName.get(c2.handle) || '?') : 'static';
            touch.push(`${nm} ${(depth * 100).toFixed(1)}cm`);
          });
          WHYLOG.push({ touch: touch.join(', '), type: c.type, lost: e.lost, cause, fz, fx, fy, v: rvV(), phase: PHASE, z: rvZ(), x: sim().rv.translation().x - W().roadX(rvZ()), clock: room.clock, st: pedals.st, th: pedals.th, roll: Math.asin(Math.max(-1, Math.min(1, qRotate(rvPose().q, { x: 1, y: 0, z: 0 }).y))) * 57.3 });
        }
      }
    }
    else if (e.k === 'mob' && e.s === 'steal') c.fate = 'stolen';
  }
}

// ---- town and night -----------------------------------------------------------------------------------------
// into Ed's loading zone (the lane on the shop's side), then the bell and the Repo Man
function* town(day) {
  const T = W().town, LEN = W().LEN;
  // (down the street in the lane by Ed's, stopped abreast of his door)
  yield* driveTo(LEN + 38.7, { vmax: z => (z < LEN - 10 ? 13 : z < LEN + 14 ? 8 : 3), lat: z => (z < LEN - 10 ? 0 : -4 - W().roadX(z)) });
  day.arrive = room.clock;
  if (!room.docked()) fail(`not docked (${hyp(sim().rv.translation(), T.dock).toFixed(1)} m from the zone)`);
  const bell = W().uses.find(u => u.kind === 'pawnBell'), pay = W().uses.find(u => u.kind === 'pay');
  const [seller, payer] = footCrew(2);
  const sold0 = room.dayStats.sold;
  // (carried in but not in the RV's load now: where it went)
  if (TRACE) {
    const inRV = new Set(sim().cargo());
    for (const x of dayLog.carried) {
      if (x.fate || inRV.has(x.id)) continue;
      const p = sim().props.get(x.id);
      if (!p) { trace(`  missing #${x.id} ${x.type}: gone from the world`); continue; }
      const t = p.body.translation(), l = rvLocal(t);
      trace(`  outside the load #${x.id} ${x.type} $${x.vIn}: world z ${t.z.toFixed(1)}, RV-local ${l.x.toFixed(2)} ${l.y.toFixed(2)} ${l.z.toFixed(2)}`);
    }
  }
  yield* all(
    (function* () { yield* climbOut(seller); yield* walk(seller, { x: -12.5 + 0.8, z: LEN + 42 }); yield* walk(seller, { x: bell.x + 1.2, z: bell.z }); seller.useId(bell); yield; })(),
    payer && payer !== seller ? (function* () { yield* climbOut(payer); yield* walk(payer, { x: pay.x - 1.0, z: pay.z }); })() : null,
  );
  const pb = payer && payer !== seller ? payer : seller;
  if (pb === seller) { yield* walk(seller, { x: -12.5 + 0.8, z: LEN + 42 }); yield* walk(seller, { x: pay.x - 1.0, z: pay.z }); }
  day.sold = room.dayStats.sold - sold0;
  if (BANK != null && room.bank < room.due) room.bank = room.due + BANK;
  if (room.bank < room.due && CASINO === 'bold') yield* gamble(pb);
  const done = () => { day.paid = room.paid || room.over?.won === true; day.bank = room.bank; day.hp = Math.round(room.phase === 'over' ? room.stats.rv.end : room.rvc.hp); };   // (after a miss, the game-over has the RV's last condition)
  if (room.bank >= room.due) { pb.useId(pay); day.paidAt = room.clock; done(); yield; }
  else {
    trace(`  short: ${fmt$(room.bank)} of ${fmt$(room.due)}; waiting for midnight`);
    day.bank = room.bank;
    yield* until(() => room.phase !== 'road', 18 * C.HOUR_SEC);
    done();
  }
}
// Double or Nothing till the bank covers the payment (or it's gone)
function* gamble(b) {
  const W0 = W(), U = arg => W0.uses.find(u => u.kind === 'flip' && u.arg === arg);
  yield* walk(b, { x: 12 - 0.8, z: W0.LEN + 58 });
  yield* walk(b, { x: U('+500').x - 1.0, z: U('+500').z });
  for (let n = 0; n < 40 && room.bank < room.due && room.bank >= 100 && room.clock < 23.98; n++) {
    const want = Math.min(room.bank, Math.ceil((room.due - room.bank) / 100) * 100);
    while (room.flip.stake + 500 <= want) { b.useId(U('+500')); yield; }
    while (room.flip.stake + 100 <= want) { b.useId(U('+100')); yield; }
    if (room.flip.stake < 100) b.useId(U('all'));
    yield;
    b.useId(U('pull'));
    yield* until(() => !room.pendingFlip, 4);
    yield* wait(0.6);
  }
  yield* walk(b, { x: 12 - 0.8, z: W0.LEN + 58 });
  yield* walk(b, { x: W0.uses.find(u => u.kind === 'pay').x - 1.0, z: W0.uses.find(u => u.kind === 'pay').z });
}
// night: Gus for cash if the RV is under 61% and the bank has it; then everyone into a bunk (the RV is at the lot)
function* night() {
  const T = W().town;
  const hp = room.rvc.hp, q = C.repairQuote(room.day, hp);
  let gus = 0;
  if (hp < 61 && room.bank >= q.cash) {
    const g = W().uses.find(u => u.kind === 'repair' && u.arg === 'cash'), [b] = footCrew(1);
    if (b.frame === 'rv') yield* climbOut(b);
    yield* walk(b, { x: g.x + 1.0, z: g.z });
    while (room.rvc.hp < 61 && room.bank >= C.repairQuote(room.day, room.rvc.hp).cash) { const b0 = room.bank; b.useId(g); yield; if (room.bank === b0) break; gus += b0 - room.bank; }
  }
  yield* all(...crew.filter(b => !b.ko).map((b, i) => (function* () {
    if (b.frame !== 'rv') yield* climbIn(b, { x: 0.3 - 0.3 * (i % 2), z: -2.6 + 0.4 * Math.floor(i / 2) });
    else yield* walkIn(b, { x: 0.3 - 0.3 * (i % 2), z: -2.6 + 0.4 * Math.floor(i / 2) });
    b.crouch = false;
    if (!room.players.get(b.id)?.bed) { b.use('bunk'); yield; }
  })()));
  const d0 = room.day;
  yield* until(() => room.day !== d0 || room.phase !== 'night', 60, 'the next morning');
  return gus;
}

// ---- a day, a trip ------------------------------------------------------------------------------------------
function* dayScript(out) {
  const d = { day: room.day, due: room.due, bank0: room.bank, hp0: Math.round(room.rvc.hp) };
  out.push(d);   // (filled in as the day goes: a day-5 payment ends the trip in the middle of it)
  packer = new Packer(); doorBusy = null;
  dayLog = d.log = { carried: [], failed: [] };
  if (BANK != null) { room.bank = Math.max(room.bank, BANK); d.bank0 = room.bank; }
  yield* board();
  for (const e of legPlan()) {
    if (room.phase !== 'road' && room.phase !== 'camp') break;
    const t0 = room.t;
    PHASE = e.k;
    if (e.k === 'honk') yield* honk(e.rf);
    else if (e.k === 'gate') yield* gate(e.o);
    else if (e.k === 'boulder') yield* boulder(e.o);
    else if (e.k === 'mud') yield* mud(e.o);
    else if (e.k === 'grade') yield* grade(e.o);
    else if (e.k === 'stop') yield* stopAt(e.poi);
    else if (e.k === 'town') { yield* driveTo(e.z, { vmax: vmaxFor, lat: latFor, stop: false }); yield* town(d); }
    d.time = d.time || {};
    d.time[e.k] = (d.time[e.k] || 0) + room.t - t0;
    trace(`  ${e.k} at z ${e.z.toFixed(0)}: ${(room.t - t0).toFixed(1)} s, clock ${room.clock.toFixed(2)}`);
  }
  if (room.phase === 'night') d.gus = yield* night();
}

async function runTrip(seed) {
  Math.random = mulberry32(seed ^ 0x5eed);   // (the roles and the casino draw from it)
  room = new Room('ECON', seed);
  crew = []; ev = [];
  for (let i = 0; i < CREW; i++) crew.push(new Bot(i));
  if (D0 > 1) room.debug(crew[0].P, { op: 'day', d: D0 });
  const days = [];
  trace = TRACE ? s => console.log(`[${seed} d${room.day} ${fmtClock(room.clock)}] ${s}`) : () => {};
  while (room.phase !== 'over' && room.day <= D1) {
    const g = dayScript(days), day0 = room.day;
    for (;;) {
      // (what's sold is gone once the bell is rung or the tick is over: note each thing's value first)
      const vals = new Map(dayLog.carried.filter(x => !x.fate).map(x => [x.id, Math.round(sim().props.get(x.id)?.value ?? 0)]));
      const r = g.next();
      // a page's driver sends its pedals 20 times a second; the bot every tick
      const dv = driver();
      if (dv) room.handle(dv.P, { t: 'drv', ...pedals });
      for (const b of crew) b.pose();
      const v0 = sim().rv.linvel();
      room.tick(DT);
      if (WHY && room.sim) {
        const v1 = sim().rv.linvel(), q = rvPose().q, iq = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
        const a = qRotate(iq, { x: (v1.x - v0.x) / DT, y: (v1.y - v0.y) / DT + 9.81, z: (v1.z - v0.z) / DT });
        accHist.push(a); if (accHist.length > 9) accHist.shift();
      }
      if (TRACE && (++leaveTick % 5) === 0) watchLoad();
      if (ev.length) { for (const e of ev) if (e.k === 'sold') for (const id of e.ids || []) { const x = dayLog.carried.find(y => y.id === id && !y.fate); if (x) { x.fate = 'sold'; x.sold = vals.get(id) ?? 0; } } ledgerEvents(ev.filter(e => e.k !== 'sold')); ev.length = 0; }
      if (r.done || room.phase === 'over') break;
    }
    if (room.day === day0 && room.phase !== 'over') { fail('the day never ended'); break; }
    await new Promise(r => setImmediate(r));   // (the old day's physics world is freed once this tick is done)
    if (room.day > D1) break;
  }
  const won = room.phase === 'over' && room.over?.won;
  // (a missed payment ends the trip at midnight, in the middle of the day's script: close its day here)
  const last = days.at(-1);
  // (the bank as midnight came: the Repo Man's game-over says how short it was; the room's bank is gone by now)
  if (last && last.hp == null) { last.paid = !!room.over?.won; last.bank = room.over ? room.over.due - room.over.short : room.bank; last.hp = Math.round(room.stats.rv.end); }
  room.sim.free?.();
  return { seed, won, days, stats: { sold: room.stats.sold, bills: room.stats.bills, broken: room.stats.broken, kos: room.stats.kos, rv: room.stats.rv } };
}
function fmtClock(h) { const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; }

// ---- main ---------------------------------------------------------------------------------------------------
health = { fails: [], kos: 0, doorLeftOpen: 0 };
const trips = [];
const t0 = Date.now();
if (MERGE) for (const f of MERGE) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); trips.push(...j.trips); health.fails.push(...j.fails); }
for (const seed of MERGE ? [] : SEEDS) {
  const r = await runTrip(seed);
  trips.push(r);
  for (const d of r.days) {
    const cs = d.log?.carried || [], fate = k => cs.filter(x => x.fate === k);
    d.fates = { sold: fate('sold').length, broken: fate('broken').length, stolen: fate('stolen').length, lost: cs.filter(x => !x.fate).length, inValue: cs.reduce((a, x) => a + x.vIn, 0), soldValue: fate('sold').reduce((a, x) => a + x.sold, 0) };
    console.log(`seed ${seed} day ${d.day}: ${d.paid ? `paid at ${fmtClock(d.paidAt ?? 24)}` : 'NOT PAID'}, in town at ${d.arrive != null ? fmtClock(d.arrive) : '-'}, pawned ${fmt$(d.sold || 0)} (${cs.length} carried in worth ${fmt$(d.fates.inValue)}: ${d.fates.sold} sold for ${fmt$(d.fates.soldValue)}, ${d.fates.broken} broken, ${d.fates.stolen} stolen, ${d.fates.lost} lost${d.log?.failed.length ? `; ${d.log.failed.length} carries failed` : ''}), bank ${fmt$(d.bank0)} -> ${fmt$(d.bank)}, due ${fmt$(d.due)}, RV ${d.hp0}% -> ${d.hp}%${d.gus ? `, Gus ${fmt$(d.gus)}` : ''}; road ${Object.entries(d.time || {}).map(([k, v]) => `${k} ${v.toFixed(0)} s`).join(', ')}`);
  }
  console.log(`seed ${seed}: ${r.won ? 'WON' : r.days.at(-1)?.paid ? `stopped after day ${r.days.at(-1).day}` : `lost on day ${r.days.at(-1)?.day}`} (${((Date.now() - t0) / 1000).toFixed(0)} s so far)`);
}
console.log(`\n${trips.length} trips, crew of ${CREW}, casino ${CASINO}, kit ${KIT}: won ${trips.filter(t => t.won).length}`);
if (WHY) {   // what knocked the loot riding in the RV: the RV's sharpest acceleration in the 0.15 s before each knock
  const by = {};
  for (const w of WHYLOG) { const k = `${w.cause}`; (by[k] ||= { n: 0, lost: 0, g: 0 }); by[k].n++; by[k].lost += w.lost; by[k].g = Math.max(by[k].g, Math.max(w.fz, w.fx, w.fy) / 9.81); }
  console.log('knocks to loot riding in the RV, by the RV\'s sharpest acceleration just before:');
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].lost - a[1].lost)) console.log(`  ${k.padEnd(9)} ${String(v.n).padStart(5)} knocks, $${v.lost} lost, peak ${v.g.toFixed(2)} g`);
  const sp = [[0, 0.5], [0.5, 3], [3, 6], [6, 9], [9, 14]];
  for (const [lo, hi] of sp) { const xs = WHYLOG.filter(w => Math.abs(w.v) >= lo && Math.abs(w.v) < hi); console.log(`  RV at ${lo}-${hi} m/s: ${xs.length} knocks, $${xs.reduce((a, w) => a + w.lost, 0)}`); }
  const ph = {};
  for (const w of WHYLOG) { const k = `${w.phase} / ${w.cause}`; (ph[k] ||= { n: 0, lost: 0 }); ph[k].n++; ph[k].lost += w.lost; }
  for (const [k, v] of Object.entries(ph).sort((a, b) => b[1].lost - a[1].lost).slice(0, 10)) console.log(`  ${k}: ${v.n} knocks, $${v.lost}`);
  for (const w of [...WHYLOG].sort((a, b) => b.lost - a.lost).slice(0, 12)) console.log(`  $${w.lost} ${w.type} ${w.cause} ${w.phase} at ${fmtClock(w.clock)} z ${w.z.toFixed(0)} off-road ${w.x.toFixed(1)} m, ${w.v.toFixed(1)} m/s, roll ${w.roll.toFixed(0)} deg, fwd ${(w.fz / 9.81).toFixed(2)} g side ${(w.fx / 9.81).toFixed(2)} g up ${(w.fy / 9.81).toFixed(2)} g, st ${w.st} th ${w.th}; touching ${w.touch}`);
}
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = xs => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (let d = D0; d <= D1; d++) {
  const ds = trips.map(t => t.days.find(x => x.day === d)).filter(Boolean);
  if (!ds.length) continue;
  const paid = ds.filter(x => x.paid).length, haul = ds.map(x => x.sold || 0), at = ds.filter(x => x.paid && x.paidAt != null).map(x => x.paidAt);
  const f = k => ds.reduce((a, x) => a + (x.fates?.[k] || 0), 0), n = ds.reduce((a, x) => a + (x.log?.carried.length || 0), 0);
  const inV = ds.reduce((a, x) => a + (x.fates?.inValue || 0), 0), soldV = ds.reduce((a, x) => a + (x.fates?.soldValue || 0), 0);
  console.log(`day ${d}: reached ${ds.length}, paid ${paid} (${Math.round(paid / ds.length * 100)}%)${at.length ? ` at ${fmtClock(mean(at))} on average` : ''}; pawned mean ${fmt$(Math.round(mean(haul)))} (median ${fmt$(Math.round(median(haul)))}); ${n} things carried in, worth ${fmt$(inV)}: ${f('sold')} sold (${Math.round(soldV / Math.max(1, inV) * 100)}% of the value), ${f('broken')} broken, ${f('stolen')} stolen, ${f('lost')} lost`);
}
// the whole trip: what a crew pawns over five days, and how short of the balloon it ends without the casino
if (D0 === 1 && D1 === 5) {
  const hauls = trips.map(t => t.days.reduce((a, x) => a + (x.sold || 0), 0)), reached5 = trips.filter(t => t.days.some(x => x.day === 5));
  console.log(`the trip: pawned ${fmt$(Math.round(mean(hauls)))} on average (median ${fmt$(Math.round(median(hauls)))}); reached day 5 on ${reached5.length} of ${trips.length}; paid the balloon on ${trips.filter(t => t.won).length}`);
  const short = reached5.filter(t => !t.won).map(t => { const d5 = t.days.find(x => x.day === 5); return d5.due - d5.bank; });
  if (short.length) console.log(`  short of the balloon on day 5: ${fmt$(Math.round(median(short)))} (median), ${fmt$(Math.round(Math.min(...short)))} at best`);
}
if (health.fails.length) console.log(`\nbot failures (${health.fails.length}):\n  ${health.fails.slice(0, 30).join('\n  ')}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ crew: CREW, casino: CASINO, trips, fails: health.fails }, null, 1));
process.exit(GATE && health.fails.length ? 1 : 0);
