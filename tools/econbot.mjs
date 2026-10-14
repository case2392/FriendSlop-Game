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
//                          [--trace] [--json file] [--gate]
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
const { fmt$ } = await import('../shared/loot.js');
import fs from 'node:fs';
await initPhysics();

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SEEDS = opt('--seed', null) != null ? [Number(opt('--seed'))] : Array.from({ length: Number(opt('--seeds', 20)) }, (_, i) => [4242, 7, 777][i] ?? 1000 + i * 7919);
const CREW = Math.max(1, Math.min(C.MAX_PLAYERS, Number(opt('--crew', 3))));
const [D0, D1] = String(opt('--days', '1-5')).split('-').map(Number).concat([5]).slice(0, 2);
const CASINO = opt('--casino', 'none');
const BANK = opt('--bank', null) != null ? Number(opt('--bank')) : null;
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
let room = null, crew = [], ev = [], trace = () => {}, health = null;
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
// open or shut the door (whoever is within reach of it)
function setDoor(open) {
  if (sim().doorOpen === open) return true;
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
  yield* until(() => setDoor(false), 3, 'shutting the door');
}

// ---- driving ------------------------------------------------------------------------------------------------
const pedals = { th: 0, st: 0, hb: 1 };
// keyboard steering at a world point (st -1/0/+1 with 0.06 rad of slack)
function steerAt(goal) {
  const p = sim().rv.translation(), f = fwd(), tx = goal.x - p.x, tz = goal.z - p.z;
  const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz);
  return err > 0.06 ? 1 : err < -0.06 ? -1 : 0;
}
// the lane's middle `ahead` m on, `lat` m to the side of the road's middle
const lane = (z, lat = 0, ahead = 10) => ({ x: W().roadX(z + ahead) + lat, z: z + ahead });
// drive to `z` (the RV's middle) and stop there: as fast as `vmax`, braking in time; `lat(z)` the lane offset
function* driveTo(zStop, { vmax = 13, lat = () => 0, stop = true, maxS = 300 } = {}) {
  for (let i = 0; i < maxS * HZ; i++) {
    const z = rvZ(), v = rvV(), dz = zStop - z;
    if (dz < 0.6 || (!stop && dz < 2)) break;
    const want = Math.min(vmax(z), Math.sqrt(2 * 2.2 * Math.max(0, dz - 0.5)));
    pedals.hb = 0;
    pedals.th = v < want - 0.25 ? 1 : v > want + 0.6 ? -1 : 0;
    pedals.st = steerAt(lane(z, lat(z), Math.max(6, v * 1.1)));
    yield;
    if (room.phase === 'over') return;
  }
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
    if (z > bed.z - 34 && z < bed.z + 24) return bedSide(bed) * 3.25;
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
  yield* all(
    (function* () { yield* climbOut(seller); yield* walk(seller, { x: -12.5 + 0.8, z: LEN + 42 }); yield* walk(seller, { x: bell.x + 1.2, z: bell.z }); seller.useId(bell); yield; })(),
    payer && payer !== seller ? (function* () { yield* climbOut(payer); yield* walk(payer, { x: pay.x - 1.0, z: pay.z }); })() : null,
  );
  const pb = payer && payer !== seller ? payer : seller;
  if (pb === seller) { yield* walk(seller, { x: -12.5 + 0.8, z: LEN + 42 }); yield* walk(seller, { x: pay.x - 1.0, z: pay.z }); }
  day.sold = room.dayStats.sold - sold0;
  if (BANK != null && room.bank < room.due) room.bank = room.due + BANK;
  if (room.bank < room.due && CASINO === 'bold') yield* gamble(pb);
  const done = () => { day.paid = room.paid || room.over?.won === true; day.bank = room.bank; day.hp = Math.round(room.rvc.hp); };
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
  if (BANK != null) { room.bank = Math.max(room.bank, BANK); d.bank0 = room.bank; }
  yield* board();
  for (const e of legPlan()) {
    if (room.phase !== 'road' && room.phase !== 'camp') break;
    const t0 = room.t;
    if (e.k === 'honk') yield* honk(e.rf);
    else if (e.k === 'gate') yield* gate(e.o);
    else if (e.k === 'boulder') yield* boulder(e.o);
    else if (e.k === 'mud') yield* mud(e.o);
    else if (e.k === 'grade') yield* grade(e.o);
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
      const r = g.next();
      // a page's driver sends its pedals 20 times a second; the bot every tick
      const dv = driver();
      if (dv) room.handle(dv.P, { t: 'drv', ...pedals });
      for (const b of crew) b.pose();
      room.tick(DT);
      if (r.done || room.phase === 'over') break;
    }
    if (room.day === day0 && room.phase !== 'over') { fail('the day never ended'); break; }
    await new Promise(r => setImmediate(r));   // (the old day's physics world is freed once this tick is done)
    if (room.day > D1) break;
  }
  const won = room.phase === 'over' && room.over?.won;
  room.sim.free?.();
  return { seed, won, days, stats: { sold: room.stats.sold, bills: room.stats.bills, broken: room.stats.broken, kos: room.stats.kos, rv: room.stats.rv } };
}
function fmtClock(h) { const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; }

// ---- main ---------------------------------------------------------------------------------------------------
health = { fails: [], kos: 0 };
const trips = [];
const t0 = Date.now();
for (const seed of SEEDS) {
  const r = await runTrip(seed);
  trips.push(r);
  for (const d of r.days) console.log(`seed ${seed} day ${d.day}: ${d.paid ? `paid at ${fmtClock(d.paidAt ?? 24)}` : 'NOT PAID'}, in town at ${d.arrive != null ? fmtClock(d.arrive) : '-'}, pawned ${fmt$(d.sold || 0)}, bank ${fmt$(d.bank0)} -> ${fmt$(d.bank)}, due ${fmt$(d.due)}, RV ${d.hp0}% -> ${d.hp}%${d.gus ? `, Gus ${fmt$(d.gus)}` : ''}; road ${Object.entries(d.time || {}).map(([k, v]) => `${k} ${v.toFixed(0)} s`).join(', ')}`);
  console.log(`seed ${seed}: ${r.won ? 'WON' : r.days.at(-1)?.paid ? `stopped after day ${r.days.at(-1).day}` : `lost on day ${r.days.at(-1)?.day}`} (${((Date.now() - t0) / 1000).toFixed(0)} s so far)`);
}
console.log(`\n${trips.length} trips, crew of ${CREW}, casino ${CASINO}: won ${trips.filter(t => t.won).length}`);
for (let d = D0; d <= D1; d++) {
  const ds = trips.map(t => t.days.find(x => x.day === d)).filter(Boolean);
  if (!ds.length) continue;
  const paid = ds.filter(x => x.paid).length, haul = ds.map(x => x.sold || 0);
  console.log(`day ${d}: reached ${ds.length}, paid ${paid} (${Math.round(paid / ds.length * 100)}%), pawned mean ${fmt$(Math.round(haul.reduce((a, b) => a + b, 0) / ds.length))}`);
}
if (health.fails.length) console.log(`\nbot failures (${health.fails.length}):\n  ${health.fails.slice(0, 30).join('\n  ')}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ crew: CREW, casino: CASINO, trips, fails: health.fails }, null, 1));
process.exit(GATE && health.fails.length ? 1 : 0);
