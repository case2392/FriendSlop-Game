// A room = one crew, one RV, one run of five days.
//
//   camp  — morning. the clock is frozen until the RV rolls out of camp. The day's roles are drawn
//           (one driver, one navigator who reads the road map), and drawn again when a friend climbs aboard.
//   road  — the clock runs, the roles are locked. scavenge, climb, winch, get to town, pawn, gamble.
//   night — paid. campfire, store, everyone into a bunk = next day.
//   over  — you own the RV, or the Repo Man owns you (one missed payment does it). then a fresh run.

import * as C from '../shared/constants.js';
import { generateLeg } from '../shared/world.js';
import { LOOT, fmt$ } from '../shared/loot.js';
import { RV_SEATS, RV_SEAT_EXIT, RV_DIM, RV_HATCH, toWorld, qRotate, insideRV } from '../shared/rv.js';
import { Sim } from './sim.js';
import { STOP_NAMES } from '../shared/mobs.js';
import { BJTable, FlipMachine } from './casino.js';

let nextPlayerId = 1;
const r3 = n => Math.round(n * 1000) / 1000;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const PRICES = { walkie: 150, drink: 40, bungee: 90, hardhat: 80, cheese: 30 };
const HOLD_SECS = 90;            // a dropped player's seat (id, color, walkie) is kept this long
const BED_WAIT = 45;             // once half the crew is in a bunk, the rest get this long
const IDLE_SECS = 60;            // not moved, looked around or done anything for this long: away (AFK), for the roles
const READY_WAIT = 60;           // snapshots wait this long at most for a client to finish building its world
// the least time between two of these from one player (a stuck key or a modified client can't flood the crew)
// a held key or a modified client can't spam the crew with these (anything that sets state, like
// 'voice', is never dropped: a lost 'voice off' would leave a mic open)
const COOLDOWN = { emote: 0.25, ping: 0.25, horn: 0.25, shove: 0.5 };
// a number from a client: finite and within +-lim, or 0
const num = (v, lim) => { const x = +v; return Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : 0; };

export class Room {
  constructor(code, seed = null) {
    this.code = code;
    this.players = new Map();
    this.hostId = null;
    this.closed = false;
    this.t = 0;
    this.snapN = 0;
    this.roles = { drv: 0, nav: 0 };   // the day's driver and navigator (player ids; 0: nobody)
    this.rolesCrew = '';               // the crew the roles were last settled for (a newcomer in camp draws again)
    // the wildlife comes out once the RV leaves camp (FRIENDSLOP_NOMOBS=1, or the test lever, keeps it away)
    this.mobsOn = typeof process === 'undefined' || process.env.FRIENDSLOP_NOMOBS !== '1';
    this.newRun(seed);
  }

  // ---- the run ---------------------------------------------------------------------

  newRun(seed = null) {
    this.seed = seed ?? (Math.floor(Math.random() * 1e9) >>> 0);
    this.day = 1;
    this.bank = 200;                 // gas money. that's it. that's all you have.
    for (const p of this.players.values()) p.walkie = p.hat = false;   // a new trip buys its own walkies (and hard hats)
    this.stats = { bills: 0, broken: 0, sold: 0, bestWin: null, worstLoss: null, kos: 0, stolen: 0, recovered: 0, beasts: 0, beanings: 0,
      rv: { dmg: 0, crashes: 0, worst: null, cash: 0, loan: 0, breakdowns: 0, end: 100 } };
    // the RV's condition (a new trip, a new RV): the hit being added up, the day's breakdowns, the roadside
    // fix's progress, Gus's pending loan question; repairs put on the loan land on tomorrow's payment
    this.rvc = { hp: 100, inc: null, brokeN: 0, fix: 0, gusAsk: {} };
    this.loanAdd = 0;
    this.over = null;
    this.jobs = new Map();           // id -> { drv, nav }: the days each has driven and navigated this trip
    this.startDay([]);
  }

  startDay(carry) {
    // the old day's physics world lives in WASM memory that garbage collection gives back late or
    // never: free it, once the tick that replaced it (which may still hold it) has finished
    if (this.sim) { const old = this.sim; setImmediate(() => old.free()); }
    // (a new run drops whatever the last one left on the casino tables: it starts with $200, that's all)
    this.W = generateLeg(this.seed, this.day);
    this.sim = new Sim(this.W, { carry, cond: this.rvc.hp });   // (nothing heals it overnight but Gus)
    this.phase = 'camp';
    this.clock = C.DAY_START;
    this.paid = false;
    this.due = C.QUOTAS[this.day - 1] + this.loanAdd;   // (Gus's repairs on the loan)
    this.loanAdd = 0;
    this.rvc.inc = null; this.rvc.brokeN = 0; this.rvc.fix = 0; this.rvc.gusAsk = {};
    this.inTown = false;
    this.flippedT = 0;
    this.nightAt = 0;
    this.dayStats = { sold: 0, bills: 0, broken: 0, gamble: 0, stolen: 0, recovered: 0, rv: { dmg: 0, src: {}, cash: 0, loan: 0 } };
    this.theftQ = new Map();         // den -> the thefts its ringtails made that the crew hasn't been told of yet
    this.theftToastAt = new Map();   // den -> when the crew was last told
    this.bj = new BJTable(this.W.town.bj);
    this.flip = new FlipMachine();
    this.pendingFlip = null;
    this.gatesOpen = new Set();
    this.bedAt = null;
    this.receipt = null;
    for (const p of this.players.values()) {
      if (p.seat != null) this.send(p, { t: 'seat', seat: null });
      if (p.bed) p.activeAt = this.t;   // asleep in a bunk at dawn: here (the draw prefers who's here)
      p.bed = false; p.seat = null; p.ko = false; this.awaitReady(p);
    }
    this.mapRead = new Set();   // who has had today's map in their hands
    this.drawRoles();   // a new morning, new roles
  }

  nextDay() {
    this.settleTables();
    const carry = this.sim.carryOver();
    // who's riding along? their RV-local pose survives the teleport
    this.day++;
    if (this.day > C.DAYS) return this.finish(this.paid);   // (a paid last day has already ended the run)
    this.startDay(carry);
    this.broadcast(this.worldMsg());
    this.broadcast({ t: 'props', list: this.sim.allProps() });
    this.spawnStragglers();
    this.toast(`DAY ${this.day} — ${fmt$(this.due)} due at midnight. Miss it and the Repo Man takes the RV.`, '#ffd166', 7);
    if (this.rolesText()) this.toast(this.rolesText(), '#ffd166', 7);
    this.sendMeta();
  }

  // short: how much the missed payment was short by (the game-over screen says so)
  finish(won, short = 0) {
    this.phase = 'over';
    this.stats.rv.end = Math.round(this.rvc.hp);
    this.over = { won, at: this.t, day: Math.min(this.day, C.DAYS), due: this.due, short };
    this.broadcast(this.overMsg());
    this.sendMeta();
  }

  overMsg() {
    const o = this.over;
    return { t: 'over', won: o.won, day: o.day, due: o.due, short: o.short, stats: this.stats, next: Math.max(0, Math.round((C.FAST ? 3 : 25) - (this.t - o.at))) };
  }

  worldMsg() {
    return { t: 'world', seed: this.seed, day: this.day, door: this.sim.doorOpen };
  }

  // ---- membership --------------------------------------------------------------------

  // opts.ready: the client says when it has built its world, and gets snapshots only after that
  addPlayer(conn, name, opts = {}) {
    if (this.players.size >= C.MAX_PLAYERS) {
      // a newcomer beats a seat that's being kept for someone who dropped
      const held = [...this.players.values()].filter(p => !p.connected).sort((a, b) => a.heldAt - b.heldAt)[0];
      if (held) this.removePlayer(held.id, 'expired', false);   // (the newcomer's welcome sees to the roles)
    }
    if (this.players.size >= C.MAX_PLAYERS) return { error: 'This RV is full (6 seats, 2 of them real).', code: 'full' };
    const used = [...this.players.values()].map(p => p.color);
    const color = C.COLORS.find(c => !used.includes(c)) || C.COLORS[0];
    const slots = new Set([...this.players.values()].map(p => p.slot));
    let slot = 0;
    while (slots.has(slot)) slot++;
    const p = {
      id: nextPlayerId++, name: String(name || 'Blob').replace(/[<>]/g, '').slice(0, 16) || 'Blob',
      color, conn, connected: true, slot, rdy: !!opts.ready, ready: false, waitAt: this.t,
      par: 0, lp: null, pos: null, eye: null, look: { x: 0, y: 0, z: 1 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, mode: 0, flags: 0, seat: null, ko: false, koAt: 0, bed: false,
      walkie: false, voice: false, lastPush: 0, drvAt: 0, activeAt: this.t, cd: {},
    };
    this.players.set(p.id, p);
    if (!this.hostId || !this.players.get(this.hostId)?.connected) this.hostId = p.id;
    return { player: p };
  }

  // why: 'left' (they chose to), 'expired' (dropped and never came back), or null (silent). roles: false when
  // a newcomer is taking the seat (their welcome hands the roles on)
  removePlayer(id, why = null, roles = true) {
    const p = this.players.get(id);
    if (!p) return;
    this.sim.release(id);
    this.sim.dropHook(id);
    this.players.delete(id);
    if (this.hostId === id) this.hostId = [...this.players.values()].find(q => q.connected)?.id ?? null;
    if (this.players.size === 0) { this.closed = true; return; }
    if (why === 'left') this.toast(`${p.name} left the trip.`, '#ffb4a2', 4);
    else if (why === 'expired' && p.heldAt != null) this.toast(`${p.name} didn't make it back. Their seat is free.`, '#ffb4a2', 4);
    if (roles) this.checkRoles();
    this.sendMeta();
  }

  // The connection dropped: keep the seat (id, color, walkie, slot) for `secs`, but take the body out of
  // the world at once, so nothing waits on them (bunks, the wheel, a held prop, the hook) and the RV has
  // no ghost to run over. The room stays open while anyone's seat is kept.
  hold(p, secs = HOLD_SECS, quiet = false) {
    if (!p.connected) return;
    p.connected = false; p.conn = null; p.heldAt = this.t; p.holdSecs = secs; p.ready = false;
    p.seat = null; p.bed = false; p.ko = false; p.fixing = false;
    this.sim.release(p.id);
    this.sim.dropHook(p.id);
    p.raw = null; p.pos = null; p.eye = null; p.par = 0; p.lp = null;
    if (this.hostId === p.id) this.hostId = [...this.players.values()].find(q => q.connected)?.id ?? null;
    if (!quiet && [...this.players.values()].some(q => q.connected)) {
      // a dropped driver or navigator doesn't hold the crew up: anyone stands in till they're back (onUse, mapRefusal)
      const road = this.phase === 'camp' || this.phase === 'road';
      const job = !road ? '' : p.id === this.roles.drv ? ' Anyone can drive till they\'re back.' : p.id === this.roles.nav ? ' Anyone but the driver can read the map till they\'re back.' : '';
      this.toast(`${p.name} lost connection. Their seat is saved for ${secs} s.${job}`, '#ffb4a2', job ? 6 : 4);
      this.sendMeta();
    }
  }

  // The same player again (a resume token, or the same Steam account) on a new connection: the same id,
  // color and walkie. A seat still connected elsewhere (a reload that beat its old socket's close) moves.
  resume(key, conn, opts = {}) {
    if (!key) return null;
    for (const p of this.players.values()) {
      if (p.key !== key) continue;
      if (p.connected) { const old = p.conn; this.hold(p, p.holdSecs || HOLD_SECS, true); try { old?.close?.(4002, 'replaced by a new connection'); } catch {} }
      p.conn = conn; p.connected = true; p.heldAt = null; p.rdy = !!opts.ready; p.activeAt = this.t;
      p.voice = false;   // (a reloaded page isn't in voice yet; a page that is says so on its welcome: main.js)
      this.awaitReady(p);
      if (!this.hostId || !this.players.get(this.hostId)?.connected) this.hostId = p.id;
      return p;
    }
    return null;
  }

  awaitReady(p) { p.ready = false; p.waitAt = this.t; }
  // does this player get snapshots? (one still building its world would only drop them)
  wantsSnapshots(p) { return p.connected && (!p.rdy || p.ready || this.t - p.waitAt > READY_WAIT); }

  // where a fresh (or left-behind) player appears
  spawnFor(p) {
    const W = this.W;
    if (this.phase === 'camp') {
      const s = W.camp.spawns[(p.slot ?? 0) % W.camp.spawns.length];
      return { x: s.x, y: W.heightAt(s.x, s.z) + 0.05, z: s.z, yaw: Math.atan2(W.camp.fire.x - s.x, W.camp.fire.z - s.z) };
    }
    // next to the RV's door, outside
    const { p: rp, q } = this.sim.rvPose();
    const w = toWorld(rp, q, { x: -2.6, y: 0, z: RV_DIM.DOOR_Z });
    return { x: w.x, y: W.heightAt(w.x, w.z) + 0.3, z: w.z, yaw: 0 };
  }

  spawnStragglers() {
    for (const p of this.players.values()) {
      if (!p.connected) { p.pos = null; continue; }   // a kept seat has no body until they're back
      if (p.par) continue;   // riding the RV: they come along
      const s = this.spawnFor(p);
      this.send(p, { t: 'tp', ...s });
      p.pos = { x: s.x, y: s.y, z: s.z };
    }
  }

  welcome(p) {
    this.send(p, { t: 'welcome', id: p.id, code: this.code });
    this.send(p, this.worldMsg());
    this.send(p, { t: 'props', list: this.sim.allProps() });
    const s = this.spawnFor(p);
    this.send(p, { t: 'tp', ...s });
    // joining at night or after the run ended: what everyone else is looking at
    if (this.phase === 'night' && this.receipt) this.send(p, { ...this.receipt, rv: this.rvReceipt() });
    if (this.phase === 'over' && this.over) this.send(p, this.overMsg());
    this.checkRoles();
    this.sendMeta();
  }

  // ---- the day's roles ------------------------------------------------------------------
  // Drawn at random each morning among the players here: the DRIVER (the only one who takes the wheel today)
  // and the NAVIGATOR (the only one who takes the road map, and only while somebody else is at the wheel:
  // server-side in onUse and onGrab). Everyone else is crew. Whoever has done a job less this trip is likelier
  // to get it, so it goes round without being predictable, and nobody who has had today's map in their hands
  // is drawn to drive. In camp, while the RV is parked, a newcomer draws the roles again (the host starts every
  // trip alone while friends type the code in); once the RV leaves camp they're locked till the next morning.
  // A role nobody has is filled (a player coming back to an empty one); a role whose player left the trip is
  // handed on. While a role's player is AWAY (dropped, their seat kept: hold(); or not moved for IDLE_SECS),
  // anyone stands in for them (the day's driver still never reads the map, and somebody who hasn't seen it
  // takes the wheel first), so an AFK or lost player doesn't stop the RV; if they never come back, whoever
  // stood in keeps the job.

  drawRoles() {
    const live = [...this.players.values()].filter(p => p.connected), here = live.filter(p => this.active(p));
    const pool = here.length ? here : live, fresh = pool.filter(p => !this.mapRead.has(p.id));
    const drv = this.pickFor('drv', fresh.length ? fresh : pool), navs = pool.filter(p => p.id !== drv);
    this.setRoles(drv, this.pickFor('nav', navs.length ? navs : live.filter(p => p.id !== drv)));
    this.rolesCrew = this.crewKey();
  }
  // at random, but weighted 1 / (1 + times done)^2: after a day at the wheel you're 4 times less likely to
  // drive again than someone who hasn't yet
  pickFor(job, pool) {
    if (!pool.length) return 0;
    const w = pool.map(p => 1 / (1 + (this.jobs.get(p.id)?.[job] || 0)) ** 2);
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) < 0) return pool[i].id;
    return pool[pool.length - 1].id;
  }
  // everyone on the trip, a kept seat included (a dropped connection coming back doesn't draw again)
  crewKey() { return [...this.players.keys()].sort((a, b) => a - b).join(','); }
  newcomer() { const had = new Set(this.rolesCrew.split(',')); return [...this.players.keys()].some(id => !had.has(String(id))); }
  countJob(job, id) { if (!id) return; const j = this.jobs.get(id) || { drv: 0, nav: 0 }; j[job]++; this.jobs.set(id, j); }

  setRoles(drv, nav) {
    const was = this.roles;
    this.roles = { drv: drv || 0, nav: nav || 0 };
    // (counted on the road only: a hand-over at night is nobody's day of work)
    if (this.phase === 'road') { if (this.roles.drv !== was.drv) this.countJob('drv', this.roles.drv); if (this.roles.nav !== was.nav) this.countJob('nav', this.roles.nav); }
    // a new driver: whoever else is at the wheel gets up; a new role: whoever may not read the map lets go
    // (a stand-in for a player who's away keeps the wheel or the map: a hand-on elsewhere doesn't pull them off)
    for (const p of this.players.values()) {
      if (this.roles.drv !== was.drv && p.seat === 0 && !this.mayDrive(p)) { p.seat = null; this.send(p, { t: 'seat', seat: null, exit: RV_SEAT_EXIT[0] }); }
      const mid = this.mapIn(p);
      if ((this.roles.drv !== was.drv || this.roles.nav !== was.nav) && mid && !this.mayRead(p)) { this.sim.release(p.id); this.send(p, { t: 'grabbed', ok: false, kind: 'prop', id: mid }); }
    }
    this.sendMeta();
  }

  // someone climbed aboard, came back, or left for good. A newcomer in camp, with the RV parked, draws again;
  // anything else only fills or hands on a role (nobody is pulled off the wheel of a moving RV)
  checkRoles() {
    const was = { ...this.roles };
    // (a draw for a newcomer is always said, even when it lands on the same two: the newcomer hasn't heard it)
    const draw = this.phase === 'camp' && this.newcomer() && Math.abs(this.sim.rvSpeed()) < 0.5;
    if (draw) this.drawRoles();
    else { this.fillRoles(); if (this.phase === 'camp') this.rolesCrew = this.crewKey(); }
    if ((draw || was.drv !== this.roles.drv || was.nav !== this.roles.nav) && (this.phase === 'camp' || this.phase === 'road') && this.rolesText()) this.toast(this.rolesText(), '#ffd166', 6);
  }
  // fill a role nobody has, or whose player left the trip: whoever stood in for them keeps it (at the wheel, or
  // holding the map); else the driver's first (without one nobody drives), from who's here and hasn't had
  // today's map in their hands; the navigator takes the wheel only if there's nobody else
  fillRoles() {
    let { drv, nav } = this.roles;
    const live = [...this.players.values()].filter(p => p.connected), here = live.filter(p => this.active(p)), pool = here.length ? here : live;
    if (!this.players.has(nav)) nav = live.find(p => p.id !== drv && this.mapIn(p))?.id || 0;
    if (!this.players.has(drv)) {
      const others = pool.filter(p => p.id !== nav), fresh = others.filter(p => !this.mapRead.has(p.id));
      drv = live.find(p => p.seat === 0)?.id || this.pickFor('drv', fresh.length ? fresh : others) || nav;
      if (drv === nav) nav = 0;
    }
    if (!nav) {
      // (not whoever is at the wheel, standing in for an away driver: they can't read it while they drive)
      const navs = pool.filter(p => p.id !== drv), walking = navs.filter(p => p.seat !== 0);
      nav = this.pickFor('nav', walking.length ? walking : navs) || this.pickFor('nav', live.filter(p => p.id !== drv));
    }
    if (drv !== this.roles.drv || nav !== this.roles.nav) this.setRoles(drv, nav);
  }
  // the id of the road map if p is holding it (else 0)
  mapIn(p) {
    const h = this.sim.holds.get(p.id);
    return h?.kind === 'prop' && this.sim.props.get(h.id)?.type === 'map' ? h.id : 0;
  }
  // is p here: connected, and at the wheel, holding the map, or moved or did something in the last IDLE_SECS?
  active(p) { return !!p?.connected && (p.seat === 0 || !!this.mapIn(p) || this.t - (p.activeAt ?? -1e9) < IDLE_SECS); }
  // may p take the wheel now? The day's driver; while they're away anyone, but somebody who hasn't seen today's
  // map first (the navigator, or whoever stood in reading it, only when nobody else here can)
  mayDrive(p) {
    const d = this.players.get(this.roles.drv);
    if (!d || p === d) return true;
    if (this.active(d)) return false;
    const seen = q => q.id === this.roles.nav || this.mapRead.has(q.id);
    return !seen(p) || ![...this.players.values()].some(q => q !== p && q !== d && this.active(q) && !seen(q));
  }
  // may p hold the road map? Today's navigator; while they're away, anyone but the day's driver (somebody
  // else must be at the wheel to take it: mapRefusal)
  mayRead(p) { const { drv, nav } = this.roles; return !!nav && p.id !== drv && (p.id === nav || !this.active(this.players.get(nav))); }
  // the roles as the party sees them: who, whether they're away (then anyone stands in), who may take the wheel
  metaRoles() {
    const { drv, nav } = this.roles;
    return {
      drv, nav, drvAway: !!drv && !this.active(this.players.get(drv)), navAway: !!nav && !this.active(this.players.get(nav)),
      wheel: [...this.players.values()].filter(p => p.connected && this.mayDrive(p)).map(p => p.id),
    };
  }
  rolesText() {
    const d = this.players.get(this.roles.drv)?.name, v = this.players.get(this.roles.nav)?.name;
    if (!d) return '';
    const lock = this.phase === 'camp' ? 'Locked in once the RV leaves camp.' : 'No swapping till tomorrow.';
    return v ? `${d} drives today, and ${v} reads the map. ${lock}` : `${d} drives today. With nobody to read it, the map stays on the dash.`;
  }

  // ---- messaging ----------------------------------------------------------------------

  // opts go to the connection: { unreliable: true } lets a Steam peer send it unreliably (plain ws ignores it)
  send(p, msg, opts) {
    if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(JSON.stringify(msg), opts);
  }
  broadcast(msg, except = null, opts) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p === except) continue;
      if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(s, opts);
    }
  }
  toast(text, color = '#fff', secs = 4, to = null) {
    const m = { t: 'toast', text, color, secs };
    if (to) this.send(to, m); else this.broadcast(m);
  }
  sendMeta() {
    const roles = this.metaRoles();
    this.rolesKey = JSON.stringify(roles);   // (tick sends it again when this changes)
    this.broadcast({
      t: 'meta', code: this.code, host: this.hostId, roles,
      players: [...this.players.values()].filter(p => p.connected).map(p => ({ id: p.id, name: p.name, color: p.color, walkie: p.walkie, voice: p.voice, hat: p.hat ? 1 : 0 })),
      away: [...this.players.values()].filter(p => !p.connected).map(p => ({ id: p.id, name: p.name })),   // seats kept for players who dropped
    });
  }

  // ---- intents ----------------------------------------------------------------------------

  // too soon after the last one of this kind?
  spam(p, kind) {
    const cd = COOLDOWN[kind];
    if (!cd) return false;
    if (this.t - (p.cd[kind] ?? -1e9) < cd) return true;
    p.cd[kind] = this.t;
    return false;
  }

  handle(p, m) {
    if (this.spam(p, m.t)) return;
    switch (m.t) {
      case 'p': return this.onPose(p, m);
      case 'ready': p.ready = true; p.activeAt = this.t; return;
      case 'leave': this.removePlayer(p.id, 'left'); return;
      case 'grab': return this.onGrab(p, m);
      case 'rel': this.sim.release(p.id, m.thr ? m.dir : null, p); return;
      case 'hd': this.sim.holdDist(p.id, m.d); return;
      case 'push': if (this.t - p.lastPush > 0.05) { p.lastPush = this.t; this.sim.push(p.id, m, p); } return;
      case 'drv': if (p.seat === 0) { p.drvAt = this.t; this.sim.setDrive(m); } return;
      case 'horn':
        if (p.seat !== 0) return;
        this.broadcast({ t: 'ev', list: [{ k: 'horn' }] });
        this.sim.mobs?.horn(this.sim.rv.translation());   // (it scatters ringtails, and wakes a grumphorn)
        return;
      case 'use': return this.onUse(p, m);
      case 'shove': p.activeAt = this.t; if (!p.ko && p.seat == null && p.pos) this.sim.shove(p, this.players); return;
      // holding E at the engine hatch of a broken-down RV, or letting go (fixStep does the work)
      case 'fix': p.activeAt = this.t; p.fixing = !!m.on; return;
      case 'ko': return this.onKO(p, m);
      // the hard hat took a knockout (the page turned it into a knock): it's done for
      case 'hat':
        if (!p.hat) return;
        p.hat = false; this.sendMeta();
        this.toast(`${p.name}'s hard hat took that one. (It's done for.)`, '#ffd166', 3);
        return;
      case 'wake': return this.onWake(p);
      case 'emote': if (C.EMOTES.includes(m.e)) this.broadcast({ t: 'emote', id: p.id, e: m.e }); return;
      case 'ping': {
        const pt = Array.isArray(m.pt) ? m.pt.slice(0, 3).map(Number) : null;
        if (pt && pt.every(Number.isFinite)) this.broadcast({ t: 'ping', id: p.id, pt });
        return;
      }
      case 'voice': p.voice = !!m.on; this.sendMeta(); return;
      case 'dbg': if (C.TEST) this.debug(p, m); return;
    }
  }

  // test-only levers (FRIENDSLOP_TEST=1): teleport the RV, set the clock / bank, spawn loot
  debug(p, m) {
    const sim = this.sim;
    if (m.op === 'tpRV') sim.placeRV(+m.x, +m.z, +m.yaw || 0);
    else if (m.op === 'clock') this.clock = +m.h;
    else if (m.op === 'bank') this.bank = +m.v;
    else if (m.op === 'phase') this.phase = m.ph;
    else if (m.op === 'day') { this.day = Math.max(0, (+m.d | 0) - 1); this.nextDay(); }
    else if (m.op === 'roles') { this.setRoles(+m.drv || 0, +m.nav || 0); this.rolesCrew = this.crewKey(); }
    else if (m.op === 'spawn') {
      const pr = sim.addProp(m.type, { x: +m.x, y: +m.y, z: +m.z }, { x: 0, y: 0, z: 0, w: 1 }, +m.value || 100, +m.value || 100);
      if (pr) this.broadcast({ t: 'ev', list: [{ k: 'spawn', p: sim.describe(pr) }] });
      this.send(p, { t: 'dbg', op: 'spawned', id: pr?.id });
    }
    // the wildlife: one critter where you say (its 'spawn' event goes out with the tick's events); the day's
    // cast on or off (off also clears whatever is out); a critter's state forced
    else if (m.op === 'mob') {
      const mb = sim.ensureMobs({ day: this.day, crew: this.liveCrew(), seed: this.seed }).spawn(String(m.type), +m.x, +m.z, { yaw: +m.yaw || 0, y: m.y != null ? +m.y : null, st: m.st != null ? +m.st | 0 : 0 });
      this.send(p, { t: 'dbg', op: 'mob', id: mb?.id ?? null });
    }
    else if (m.op === 'mobs') {
      this.mobsOn = !!m.on;
      if (!this.mobsOn && sim.mobs) { sim.mobs.end(); sim.mobs = null; }
    }
    else if (m.op === 'mobstate') { const mb = sim.mobs?.list.get(+m.id); if (mb) sim.mobs.force(mb, +m.st | 0); }
    // a knock as the physics sends one (a rock, a toss), through the same relay; a hard hat on or off
    else if (m.op === 'knock') sim.out.push({ k: 'knock', id: p.id, v: [0, 2, 0], ko: !!m.ko, why: String(m.why || 'rock') });
    // the RV's condition set outright, or a hit as the physics would send one
    else if (m.op === 'rvhp') { this.rvc.hp = Math.max(0, Math.min(100, +m.hp || 0)); this.rvc.fix = 0; if (this.rvc.hp <= 0) this.rvc.brokeN = Math.max(1, this.rvc.brokeN); sim.setRvCond(this.rvc.hp); }
    else if (m.op === 'rvhit') sim.out.push({ k: 'rvhit', why: String(m.why || 'crash'), amt: +m.amt || 0, dv: +m.dv || 0, what: m.what || 'the test lever', at: [0, 0, 0] });
    else if (m.op === 'hat') { p.hat = !!m.on; this.sendMeta(); }
  }

  // who's here and playing right now (the wildlife is sized for them)
  liveCrew() { return Math.max(1, [...this.players.values()].filter(p => p.connected).length); }

  onPose(p, m) {
    const raw = { x: num(m.x, 1e5), y: num(m.y, 1e5), z: num(m.z, 1e5) }, par = m.par ? 1 : 0, yaw = num(m.yaw, 1e4), pitch = num(m.pitch, 1.6);
    // moved or looked around: here, not AFK (the roles)
    if (!p.raw || par !== p.par || Math.abs(raw.x - p.raw.x) + Math.abs(raw.z - p.raw.z) > 0.05 || Math.abs(yaw - p.yaw) + Math.abs(pitch - p.pitch) > 0.02) p.activeAt = this.t;
    p.par = par;
    p.yaw = yaw; p.pitch = pitch;
    p.mode = num(m.m, 99) | 0; p.flags = num(m.f, 1e6) | 0;
    p.vel = { x: num(m.v?.[0], 60), y: num(m.v?.[1], 60), z: num(m.v?.[2], 60) };
    p.lp = p.par ? raw : null;
    p.raw = raw;
    this.resolvePlayer(p);
  }

  // RV-local poses are re-anchored to the RV every tick (it moves under them)
  resolvePlayer(p) {
    if (!p.raw) return;
    if (p.par) {
      const { p: rp, q } = this.sim.rvPose();
      p.pos = toWorld(rp, q, p.raw);
      const cp = Math.cos(p.pitch);
      const lookL = { x: Math.sin(p.yaw) * cp, y: -Math.sin(p.pitch), z: Math.cos(p.yaw) * cp };
      p.look = qRotate(q, lookL);
    } else {
      p.pos = { ...p.raw };
      const cp = Math.cos(p.pitch);
      p.look = { x: Math.sin(p.yaw) * cp, y: -Math.sin(p.pitch), z: Math.cos(p.yaw) * cp };
    }
    const up = p.par ? qRotate(this.sim.rvPose().q, { x: 0, y: 1, z: 0 }) : { x: 0, y: 1, z: 0 };
    const eyeH = p.mode === C.MODE.KO ? 0.3 : (p.flags & C.FLAG.CROUCH) ? 1.05 : C.PLAYER.EYE;
    p.eye = { x: p.pos.x + up.x * eyeH, y: p.pos.y + up.y * eyeH, z: p.pos.z + up.z * eyeH };
  }

  near(p, pt, r) { return p.pos && dist3(p.pos, pt) < r; }

  // Nobody seated grabs anything (sitting down lets go of what you hold), so the driver never holds the
  // road map; and the map comes off the dash only while somebody else is at the wheel: a passenger reads it
  // and calls out the road. (The check comes before sim.grab, which lets go of what you hold first; a
  // refusal is answered, so the client drops the hold it took ahead of us.)
  onGrab(p, m) {
    p.activeAt = this.t;
    if (p.ko || p.seat != null) return;
    const no = m.kind === 'prop' && this.sim.props.get(Number(m.id))?.type === 'map' && this.mapRefusal(p);
    if (no) {
      this.send(p, { t: 'grabbed', ok: false, kind: m.kind, id: m.id });
      this.toast(no, '#fff', 3, p);
      return;
    }
    const ok = this.sim.grab(p.id, p, m);
    if (ok && m.kind === 'prop' && this.sim.props.get(Number(m.id))?.type === 'map') this.mapRead.add(p.id);   // (nobody who has, drives today)
    this.send(p, { t: 'grabbed', ok, kind: m.kind, id: m.id });
  }
  // Why p may not take the road map now (null: they may): only today's navigator takes it (or, while they're
  // away, anyone but the day's driver), and only while somebody else is at the wheel (a dropped player's seat
  // is freed at once: hold()). Alone there's no navigator: nobody to read it to you. The client words its
  // prompt the same way (main.js mapNo).
  mapRefusal(p) {
    const { drv, nav } = this.roles, name = id => this.players.get(id)?.name, here = id => this.active(this.players.get(id));
    if (!nav) return 'It takes two: one drives, one reads the map.';
    if (p.id === drv) return 'You drive today: no peeking.';
    if (!this.mayRead(p)) return `Only ${name(nav)} reads the map today.`;
    if (![...this.players.values()].some(q => q !== p && q.seat === 0)) return `${here(drv) ? name(drv) : 'Somebody'} has to be at the wheel before you take the map.`;
    return null;
  }

  onUse(p, m) {
    p.activeAt = this.t;
    if (p.ko || !p.pos) return;
    const W = this.W, sim = this.sim;
    const kind = String(m.kind || '');
    const rvLocal = p.pos ? sim.rvToLocal(p.pos) : null;
    const inRV = rvLocal && insideRV(rvLocal.x, rvLocal.y, rvLocal.z, 0.6);

    if (kind === 'seat0' || kind === 'seat1') {
      const idx = kind === 'seat0' ? 0 : 1;
      if (!inRV) return;
      if ([...this.players.values()].some(q => q.seat === idx && q !== p)) { this.toast('Somebody\'s already sitting there.', '#fff', 2, p); return; }
      const drv = this.players.get(this.roles.drv);
      if (idx === 0 && !this.mayDrive(p)) { this.toast(this.active(drv) ? `${drv.name} drives today. Ride along.` : `${drv.name} is away. Somebody who hasn't seen the map takes the wheel.`, '#fff', 3, p); return; }
      sim.release(p.id);
      p.seat = idx;
      if (idx === 0) sim.setDrive({ th: 0, st: 0, hb: 0 });
      this.send(p, { t: 'seat', seat: idx });
      if (idx === 0) {
        // (the map is up for grabs now: tell the navigator, while it lies in the RV with nobody reading it and
        // the road ahead matters)
        const map = [...sim.props.values()].find(q => q.type === 'map'), ml = map && sim.rvToLocal(map.body.translation());
        const nav = this.players.get(this.roles.nav);
        const ask = nav?.connected && nav !== p && map && !map.holders.size && insideRV(ml.x, ml.y, ml.z, 0.3) && (this.phase === 'camp' || this.phase === 'road') && !this.inTown;
        const sub = drv && p !== drv ? ` till ${drv.name} is back` : '';   // standing in for a driver who's away
        this.toast(`${p.name} is driving${sub}. God help us.${ask ? ` ${nav.name}, grab the map.` : ''}`, p.color, 3);
      }
      return;
    }
    if (kind === 'unseat') {
      const ex = RV_SEAT_EXIT[p.seat ?? 0];
      p.seat = null;
      this.send(p, { t: 'seat', seat: null, exit: ex });
      return;
    }
    if (kind === 'door') {
      if (rvLocal && Math.hypot(rvLocal.x + 1.2, rvLocal.z - RV_DIM.DOOR_Z) < 3.2) sim.setDoor(!sim.doorOpen);
      return;
    }
    if (kind === 'winch') {
      const w = sim.winchWorld();
      const close = dist3(p.pos, w) < 3.6;
      if (sim.hook.state === 'stowed') {
        if (close && sim.takeHook(p.id, p)) this.send(p, { t: 'hooked', on: true });
      } else if (close || p.seat === 0) {
        sim.toggleReel();
      }
      return;
    }
    if (kind === 'reel') { if (p.seat === 0 || dist3(p.pos, sim.winchWorld()) < 3.6) sim.toggleReel(); return; }
    if (kind === 'hook') {
      const H = sim.hook;
      if (H.state === 'out' && H.holder === p.id) {
        if (sim.anchorHook(p.id, p)) { this.send(p, { t: 'hooked', on: false }); this.toast(`${p.name} hooked the winch. Driver: R to reel in!`, p.color, 4); }
        else this.toast('Nothing to hook onto here — find a post, a dead tree, or a big rock.', '#fff', 3, p);
      } else if (H.state === 'anchored' && dist3(p.pos, sim.hookPos()) < 3.2) {
        sim.unhook();
      } else if (H.state === 'out' && H.holder == null && dist3(p.pos, sim.hookPos()) < 3.2) {
        if (sim.takeHook(p.id, p)) this.send(p, { t: 'hooked', on: true });
      }
      return;
    }
    if (kind === 'dropHook') { sim.dropHook(p.id); this.send(p, { t: 'hooked', on: false }); return; }
    if (kind === 'bunk') {
      if (!inRV) return;
      if (this.phase !== 'night') { this.toast('Not bedtime. The Repo Man doesn\'t sleep and neither do you.', '#fff', 3, p); return; }
      p.bed = !p.bed;
      this.toast(p.bed ? `${p.name} is in a bunk.` : `${p.name} got up.`, p.color, 2);
      return;
    }
    if (kind === 'revive') {
      const q = this.players.get(Number(m.id));
      if (!q || !q.ko || !q.pos || dist3(q.pos, p.pos) > 3.5) return;
      q.ko = false;
      this.send(q, { t: 'revived', by: p.id });
      this.toast(`${p.name} picked ${q.name} up off the ground. No ambulance bill.`, '#7CFC00', 3);
      return;
    }

    // world interactables
    const u = W.uses[Number(m.id)];
    if (!u || !this.near(p, u, 3.4)) return;
    if (u.kind === 'keypad') {
      const g = W.gates[u.arg];
      const code = String(m.code || '').replace(/\D/g, '').slice(0, 4);
      if (!g || this.gatesOpen.has(g.id)) return;
      if (code === g.code) {
        this.gatesOpen.add(g.id);
        sim.openGate(g.id);
        this.broadcast({ t: 'ev', list: [{ k: 'gate', id: g.id }] });
        this.toast(`${p.name} cracked the gate. ${code}.`, '#7CFC00', 4);
      } else {
        this.broadcast({ t: 'ev', list: [{ k: 'buzz', id: g.id }] });
        this.toast(`${code || '????'} — wrong. Somebody go read the rock.`, '#ff8a80', 3, p);
      }
    } else if (u.kind === 'pawnBell') {
      if (!this.sellCounter(p.id)) this.toast('Ed looks at the empty counter. Ed looks at you. (Loot on the counter, or the RV in his loading zone.)', '#fff', 4, p);
    } else if (u.kind === 'bj') {
      if (u.arg === 'deal') {
        const r = this.bj.deal(this.t, this.bank);
        if (r?.err) return this.toast(r.err, '#fff', 3, p);
        if (r) this.applyBet(r, p, 'Blackjack');
      } else this.bj.adjust(u.arg, Math.max(0, this.bank));
    } else if (u.kind === 'flip') {
      if (u.arg === 'pull') {
        const r = this.flip.pull(this.t, this.bank);
        if (r?.err) return this.toast(r.err, '#fff', 3, p);
        if (r) {
          this.bank -= r.stake;                 // in it goes
          this.pendingFlip = { ...r, by: p, at: r.revealAt };
          this.broadcast({ t: 'ev', list: [{ k: 'flip', by: p.id, stake: r.stake }] });
        }
      } else this.flip.adjust(u.arg, Math.max(0, this.bank), this.t);
    } else if (u.kind === 'buy') {
      const what = u.arg, price = PRICES[what];
      if (this.bank < price) return this.toast(`${fmt$(price)}. The bank has ${fmt$(this.bank)}. No.`, '#ff8a80', 3, p);
      if (what === 'walkie' && p.walkie) return this.toast('You already have a walkie. Hold T to talk.', '#fff', 3, p);
      if (what === 'hardhat' && p.hat) return this.toast('You\'ve got one on already.', '#fff', 3, p);
      if (what === 'bungee') {
        const n = sim.tieDown();
        if (!n) return this.toast('Nothing loose in the RV to tie down.', '#fff', 3, p);
        this.bank -= price;
        this.toast(`${p.name} bungee'd ${n} things down in the RV (${fmt$(price)}). Grab one to untie it.`, p.color, 4);
        return;
      }
      this.bank -= price;
      if (what === 'walkie') {
        p.walkie = true; this.sendMeta();
        const others = [...this.players.values()].filter(q => q !== p && q.walkie).length;
        this.toast(`${p.name} bought a walkie-talkie. Hold T to talk to anyone else with one, at any range.${others ? '' : ' (Nobody else has one yet.)'}`, p.color, 5);
      }
      if (what === 'drink') { this.send(p, { t: 'drink' }); this.toast(`${p.name} chugged an energy drink.`, p.color, 3); }
      if (what === 'hardhat') { p.hat = true; this.sendMeta(); this.toast(`${p.name} bought a hard hat. The next knockout is only a knock.`, p.color, 4); }
      if (what === 'cheese') {
        // on the counter, to carry out: ringtails go for it before anything else about
        const at = this.W.town.store?.shelf || u;
        const c = sim.addProp('cheese', { x: at.x, y: at.y + 0.25, z: at.z }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
        if (c) sim.out.push({ k: 'spawn', p: sim.describe(c) });
        this.toast(`${p.name} bought a cheese wheel. Ringtails can't resist it: put it where you want them.`, p.color, 4);
      }
    } else if (u.kind === 'pay') {
      if (this.paid) return this.toast('Already paid. He\'s just... watching you now.', '#fff', 3, p);
      // past midnight he has already taken the RV: there's no paying him now
      if (this.phase === 'over') return this.toast('Too late. He already hooked the RV.', '#ff8a80', 4, p);
      if (this.bank < this.due) return this.toast(`The Repo Man wants ${fmt$(this.due)}. You have ${fmt$(this.bank)}.`, '#ff8a80', 4, p);
      this.pay(p);
    } else if (u.kind === 'repair') {
      this.repair(p, u.arg);
    }
  }

  // ---- the RV's condition ------------------------------------------------------------------------------
  // A hit (sim.js: a crash; mobs.js: the wildlife), priced. Hits until GAP s pass with none are one incident,
  // capped at CAP% (a tumble is one bill), told in one toast when it's over; the event goes out with what it
  // cost (the pages float it and shake). A worn RV is down on power; limping, a knock stalls it; a big
  // incident throws the door open; at 0% it breaks down. Never a way to lose: only a missed payment is
  onRVHit(e) {
    if (this.phase === 'over') return false;
    const R = this.rvc, now = this.t;
    let amt = e.why === 'crash' ? C.crashDamage(e.dv) : Math.round(e.amt || 0);
    if (amt <= 0 || R.hp <= 0) return false;
    const drv = [...this.players.values()].find(q => q.seat === 0);
    if (!R.inc || now - R.inc.last > C.RVH.GAP) {
      if (R.inc && !R.inc.told) this.tellIncident();
      R.inc = { sum: 0, last: now, parts: {}, first: {}, popped: false, told: false };
    }
    const I = R.inc;
    I.last = now;
    // no more than the incident's cap, nor than the RV has left (a 20% hit on an RV at 5% cost it 5%)
    amt = Math.min(amt, C.RVH.CAP - I.sum, Math.ceil(R.hp));
    if (amt <= 0) return false;
    // each cause keeps its own share, and its first hit says who and what: a rock and then a swerve into the
    // wall is told as both, and counts as a crash
    if (!I.first[e.why]) {
      I.first[e.why] = { what: e.what || null, how: e.how || null, by: drv ? drv.name : null };
      if (e.why === 'crash') this.stats.rv.crashes++;
    }
    I.parts[e.why] = (I.parts[e.why] || 0) + amt;
    I.sum += amt;
    const before = C.rvBand(R.hp).name;
    R.hp = Math.max(0, R.hp - amt);
    this.sim.setRvCond(R.hp);
    const S = this.stats.rv, D = this.dayStats.rv;
    S.dmg += amt; D.dmg += amt;
    const src = e.why === 'crash' ? (I.first.crash.by || 'nobody') : e.why === 'beast' ? 'the Grumphorn' : e.why === 'rock' ? 'rocks' : 'a ringtail';
    D.src[src] = (D.src[src] || 0) + amt;
    if (e.why === 'crash' && (!S.worst || I.parts.crash > S.worst.amt)) S.worst = { amt: I.parts.crash, by: I.first.crash.by, what: I.first.crash.what, day: this.day };
    if (!C.TEST) console.log('[rv]', this.code, this.day, e.why, e.dv ?? '', e.what || '', amt, R.hp);
    Object.assign(e, { amt, hp: R.hp, by: e.why === 'crash' ? drv?.id ?? 0 : 0 });
    // a big incident throws the door open (E shuts it): loot slides out on a turn, ringtails come calling
    if (I.sum >= C.RVH.POP && !I.popped && !this.sim.doorOpen) { I.popped = true; this.sim.setDoor(true, true); this.toast('The door flew open!', '#ffb74d', 3); }
    const after = C.rvBand(R.hp).name;
    // limping, a knock stalls the engine for a moment
    if (after === 'LIMPING' && amt >= C.RVH.STALL_HIT) this.sim.rvMods.stallUntil = this.sim.t + C.RVH.STALL_T;
    if (R.hp <= 0) {
      R.brokeN++; S.breakdowns++; R.fix = 0;
      this.toast('The RV broke down. Everybody out: hold E at the engine hatch at the back.', '#ff8a65', 6);
    } else if (after !== before) {
      this.toast(after === 'SMOKING' ? `The engine's smoking (RV ${R.hp}%). She's down on power.` : `The RV is limping (${R.hp}%): one more knock and the engine cuts out.`, '#ffb74d', 5);
    }
    return true;
  }
  // the incident's toast, once it's over: who did it and what to, and what it cost. The biggest share gets
  // the sentence and any other cause rides along ('CRUNCH. Sam put the RV into the canyon wall: -18%, plus
  // rocks -3% (RV 79%).')
  tellIncident() {
    const I = this.rvc.inc;
    if (!I || I.told) return;
    I.told = true;
    const ks = Object.keys(I.parts).sort((a, b) => I.parts[b] - I.parts[a]);
    if (!ks.length) return;
    const k = ks[0], F = I.first[k];
    let text;
    if (k === 'crash') text = F.by ? `CRUNCH. ${F.by} put the RV into ${F.what || 'something'}` : `CRUNCH. The RV ran into ${F.what || 'something'} with nobody at the wheel`;
    else if (k === 'beast') text = F.how === 'charge' ? 'The Grumphorn charged the RV' : `${F.by || 'Somebody'} rammed the Grumphorn`;
    else if (k === 'rock') text = 'Rocks on the RV';
    else text = 'A ringtail broke out through a window';
    const also = ks.slice(1).map(j => `${j === 'crash' ? (I.first.crash.by ? `${I.first.crash.by}'s crash` : 'a crash') : j === 'beast' ? 'the Grumphorn' : j === 'rock' ? 'rocks' : 'a ringtail'} -${I.parts[j]}%`);
    this.toast(`${text}: -${I.parts[k]}%${also.length ? `, plus ${also.join(' and ')}` : ''} (RV ${Math.round(this.rvc.hp)}%).`, '#ffb74d', 4);
  }
  // broken down: whoever holds E at the engine hatch (on foot, awake, within FIX_R m of it, the RV standing
  // still) works on it; up to FIX_HANDS share the work, and letting go keeps what's done. The day's first
  // breakdown is quickest to fix, later ones slower; it comes back LIMPING, never better
  fixStep(dt) {
    const R = this.rvc;
    if (R.hp > 0 || this.phase === 'over' || Math.abs(this.sim.rvSpeed()) >= C.RVH.FIX_V) return;
    const hatch = this.sim.rvToWorld(RV_HATCH), names = [];
    for (const p of this.players.values()) {
      if (!p.fixing || !p.connected || p.ko || p.seat != null || p.par || !p.pos) continue;
      if (Math.hypot(p.pos.x - hatch.x, p.pos.z - hatch.z) > C.RVH.FIX_R || Math.abs(p.pos.y - hatch.y) > 2) continue;
      names.push(p.name);
    }
    if (!names.length) return;
    R.fix += dt * Math.min(names.length, C.RVH.FIX_HANDS) / C.RVH.FIX_T[Math.max(1, Math.min(R.brokeN, C.RVH.FIX_T.length)) - 1];
    if (R.fix < 1) return;
    R.fix = 0; R.hp = C.RVH.FIX_TO;
    this.sim.setRvCond(R.hp);
    this.sim.out.push({ k: 'rvfix', hp: R.hp });
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    this.toast(`${who} got it running with a coat hanger and a prayer. (RV ${R.hp}%.)`, '#7CFC00', 5);
  }
  // Gus, at the RV lot: STEP points a press, only once the day's payment is made (so it can never cost the
  // payment, and day 5 has no night), for cash or on tomorrow's payment (night 4: on the balloon, the first
  // press only says what it'll cost)
  repair(p, how) {
    const R = this.rvc;
    if (this.phase === 'over') return;
    if (!this.paid || this.phase !== 'night') return this.toast('Gus: "I don\'t touch an RV till the Repo Man\'s been paid."', '#fff', 3, p);
    if (R.hp >= 100) return this.toast('Gus: "Nothing to fix. Go on."', '#fff', 3, p);
    const gus = this.W.town.gus, rt = this.sim.rv.translation();
    if (!gus || Math.hypot(rt.x - gus.x, rt.z - gus.z) > C.RVH.GUS_R) return this.toast('Gus: "Bring the RV round to the lot, then."', '#fff', 3, p);
    const q = C.repairQuote(this.day, R.hp), S = this.stats.rv, D = this.dayStats.rv;
    let paidHow;
    if (how === 'loan') {
      const next = C.QUOTAS[this.day] + this.loanAdd, A = R.gusAsk[p.id];
      // (night 4: each presser has their own ask, and it signs only the balloon they were told: if somebody
      // signed since, or the price moved, it asks afresh)
      if (this.day === C.DAYS - 1 && (!A || A.due !== next + q.loan || this.t - A.at > C.RVH.LOAN_CONFIRM)) {
        R.gusAsk[p.id] = { at: this.t, due: next + q.loan };
        return this.toast(`Gus: "That puts ${fmt$(q.loan)} on the balloon: ${fmt$(next + q.loan)}. Press again to sign."`, '#ffd166', 5, p);
      }
      R.gusAsk = {};
      this.loanAdd += q.loan; S.loan += q.loan; D.loan += q.loan;
      paidHow = `on the loan (tomorrow's payment: ${fmt$(next + q.loan)})`;
    } else {
      if (this.bank < q.cash) return this.toast(`Gus wants ${fmt$(q.cash)} cash. (Or put it on the loan.)`, '#fff', 3, p);
      this.bank -= q.cash; S.cash += q.cash; D.cash += q.cash;
      paidHow = `for ${fmt$(q.cash)} cash`;
    }
    R.hp = Math.min(100, R.hp + q.pts); R.fix = 0;
    this.sim.setRvCond(R.hp);
    this.toast(`Gus fixed ${q.pts}% ${paidHow}. RV ${R.hp}%.`, '#7CFC00', 4);
  }

  applyBet(r, p, game) {
    this.bank += r.delta;
    if (r.msg) this.toast(r.msg, '#ffd166', 3);
    if (r.outcome) this.betResult(r.won, game, p);
  }

  betResult(won, game, p) {
    this.dayStats.gamble += won;
    if (won > 0 && (!this.stats.bestWin || won > this.stats.bestWin.amt)) this.stats.bestWin = { amt: won, name: p?.name, game };
    if (won < 0 && (!this.stats.worstLoss || won < this.stats.worstLoss.amt)) this.stats.worstLoss = { amt: won, name: p?.name, game };
    this.broadcast({ t: 'ev', list: [{ k: 'bet', won, game }] });
    this.toast(won > 0 ? `${game}: +${fmt$(won)}!` : won < 0 ? `${game}: ${fmt$(won)}. Ouch.` : `${game}: push.`, won > 0 ? '#7CFC00' : won < 0 ? '#ff8a80' : '#fff', 4);
  }

  pay(p = null) {
    this.bank -= this.due;
    this.paid = true;
    this.toast(`Paid the Repo Man ${fmt$(this.due)}${p ? ` (${p.name} handed it over)` : ''}. The RV is yours for one more night.`, '#7CFC00', 6);
    if (this.day >= C.DAYS) return this.finish(true);
    this.beginNight();
  }

  onKO(p, m) {
    if (p.ko) return;
    p.ko = true;
    p.fixing = false;
    p.koAt = this.t;
    p.seat = null;
    const h = this.sim.holds.get(p.id);
    this.sim.release(p.id);
    if (h?.kind === 'prop') this.sim.mobs?.onDowned([h.id]);   // (what they dropped: the ringtails' favourite pickings)
    this.sim.dropHook(p.id);
    this.stats.kos++;
    // what knocked them about in the last 3 s says how they went down (the page only knows it fell)
    const k = p.lastKnock && this.t - p.lastKnock.t < 3 ? p.lastKnock : null;
    const by = k?.by != null ? this.players.get(k.by)?.name : null;
    let how = { fall: 'ate dirt', rv: 'got run over', crash: 'went through the windshield (almost)', mob: 'got tossed by the Grumphorn' }[m.why] || 'is down';
    if (k?.why === 'mob') how = 'got tossed by the Grumphorn';
    else if (k?.why === 'rock') how = 'got hit by a falling rock';
    else if ((k?.why === 'shove' || k?.why === 'bean') && by && m.why === 'fall') how = `ate dirt (${by} ${k.why === 'bean' ? 'beaned' : 'shoved'} them)`;
    this.toast(`${p.name} ${how}. Hold E on them to pick them up.`, '#ffb4a2', 4);
  }

  onWake(p) {
    if (!p.ko) return;
    p.ko = false;
    const bill = C.medBill(this.day);
    this.bill(bill, `${p.name} woke up alone. Ambulance: ${fmt$(bill)}`);
  }

  bill(amt, text) {
    this.bank -= amt;
    this.stats.bills += amt;
    this.dayStats.bills += amt;
    this.toast(text, '#ff8a80', 5);
    this.broadcast({ t: 'ev', list: [{ k: 'bill', amt }] });
  }

  // ---- the clock ------------------------------------------------------------------------

  beginNight() {
    if (this.phase === 'night' || this.phase === 'over') return;
    this.phase = 'night';
    this.nightAt = this.t;
    // the RV parks at the lot by the town's campfire (whoever rides in it and whatever it carries come
    // along), so nobody wakes up at the fire 100 m from it, next to the junkyard's decoys
    const lot = this.W.town.lot;
    if (!this.inTown) this.toast('You limped into town overnight.', '#fff', 4);
    this.sim.endMobs();   // the wildlife goes to bed (before the RV moves: nothing rides along into town)
    this.sim.placeRV(lot.x, lot.z, lot.yaw);
    // and anyone knocked out comes round by the fire: no doctor's bill for sleeping through midnight
    for (const p of this.players.values()) if (p.ko) { p.ko = false; this.send(p, { t: 'revived' }); }
    // anyone not riding the RV gets dragged to the campfire
    for (const p of this.players.values()) {
      if (p.par) continue;
      const f = this.W.town.fire;
      const a = (p.id * 1.7) % (Math.PI * 2);
      const s = { x: f.x + Math.cos(a) * 3, z: f.z + Math.sin(a) * 3 };
      this.send(p, { t: 'tp', x: s.x, y: this.W.townY + 0.1, z: s.z, yaw: Math.atan2(f.x - s.x, f.z - s.z) });
    }
    this.receipt = { t: 'receipt', day: this.day, due: this.due, bank: this.bank, ...this.dayStats, rv: this.rvReceipt() };
    this.broadcast(this.receipt);
  }

  // the receipt's RV line: its condition, what it lost today and to whom, and what Gus would charge for the
  // next 25% (built afresh for whoever joins at night: Gus may have fixed it since nightfall)
  rvReceipt() {
    const D = this.dayStats.rv;
    return { hp: Math.round(this.rvc.hp), today: D.dmg, src: { ...D.src }, quote: C.repairQuote(this.day, this.rvc.hp) };
  }

  // the RV parked in Ed's loading zone, stopped: his bell buys its load too
  docked() {
    const d = this.W.town.dock, sim = this.sim;
    if (!d || !this.inTown || sim.rvFlipped()) return false;
    const t = sim.rv.translation();
    return Math.hypot(t.x - d.x, t.z - d.z) < d.r && Math.abs(sim.rvSpeed()) < 1.5;
  }

  // Honest Ed buys whatever is on his counter, and the RV's whole load at DOCK_RATE when it's parked in
  // his loading zone: the bell, or midnight (nobody rang it). Returns the total.
  sellCounter(by = 0, late = false) {
    const sim = this.sim, ids = sim.propsIn(this.W.town.pawn);
    const load = this.docked() ? sim.cargo().filter(id => !ids.includes(id)) : [];
    if (!ids.length && !load.length) return 0;
    sim.mobs?.onSold([...ids, ...load]);   // (a stolen thing sold counts as got back)
    let total = 0, lot = 0;
    const names = [];
    for (const id of ids) {
      const pr = sim.props.get(id);
      total += Math.round(pr.value);
      names.push(LOOT[pr.type].name);
      sim.removeProp(id);
    }
    for (const id of load) {
      lot += Math.round(sim.props.get(id).value * C.DOCK_RATE);
      sim.removeProp(id);
    }
    total += lot;
    if (load.length) names.push(`the RV's load (${load.length} thing${load.length > 1 ? 's' : ''}, ${fmt$(lot)})`);
    this.bank += total;
    this.stats.sold += total; this.dayStats.sold += total;
    this.broadcast({ t: 'ev', list: [{ k: 'sold', ids: [...ids, ...load], total, by }] });
    this.toast(`${late ? 'Ed rang it up himself: ' : 'SOLD: '}${names.join(', ')} → +${fmt$(total)}`, '#7CFC00', 5);
    return total;
  }

  // Midnight: Ed rings up what's still on his counter (and a docked load), money still on the casino tables
  // comes back, and the Repo Man takes his payment. Short by a dollar, on any day, and he takes the RV:
  // the trip is over.
  midnight() {
    if (this.paid) return;
    this.settleTables();
    this.sellCounter(0, true);
    if (this.bank >= this.due) { this.pay(); return; }
    const short = this.due - this.bank;
    this.broadcast({ t: 'ev', list: [{ k: 'repo', took: Math.max(0, this.bank) }] });
    this.bank = Math.min(0, this.bank);
    this.toast(`MIDNIGHT. ${fmt$(short)} short on the ${this.day >= C.DAYS ? 'balloon payment' : 'payment'}. The Repo Man hooks the RV. It's over.`, '#ff5252', 8);
    this.finish(false, short);
  }

  // money still on the casino tables when the day ends (at midnight, before the Repo Man counts it, and at
  // dawn): a blackjack hand being voted on is played out as a stand, a coin flip in the air lands now
  settleTables() {
    const r = this.bj?.callIt(this.t);
    if (r) {
      this.bank += r.delta;
      this.toast('Last call: the dealer plays out the hand on the table (you stand).', '#ffd166', 4);
      this.betResult(r.won, 'Blackjack', null);
    }
    if (this.pendingFlip) {
      const f = this.pendingFlip;
      this.pendingFlip = null;
      if (f.win) this.bank += f.stake * 2;
      this.betResult(f.win ? f.stake : -f.stake, 'Double or Nothing', f.by);
    }
  }

  // ---- simulation -------------------------------------------------------------------------

  tick(dt) {
    this.t += dt;
    const sim = this.sim;
    for (const p of this.players.values()) this.resolvePlayer(p);
    // nobody at the wheel, or a driver who stopped sending (frozen tab, minimized window, dead link)? it
    // coasts ("WHO'S DRIVING?!") until it's nearly stopped, then the parking brake catches
    const drv = [...this.players.values()].find(p => p.seat === 0);
    // (a driver unheard from for a second has frozen or dropped: off the pedals. The page sends 20 a second
    // on its own timer, so even a PC drawing a frame a second keeps driving)
    if (!drv || this.t - drv.drvAt > 1.0) sim.setDrive({ th: 0, st: 0, hb: Math.abs(sim.rvSpeed()) < 1.2 && !sim.hook.reeling ? 1 : 0 });
    sim.step(dt, this.players);
    this.fixStep(dt);
    // (an incident is told once it's over)
    if (this.rvc.inc && !this.rvc.inc.told && this.t - this.rvc.inc.last > C.RVH.GAP) this.tellIncident();
    for (const p of this.players.values()) this.resolvePlayer(p);
    // the driver floors it against a winch cable still clipped to its post: say why nothing happens
    if (drv && sim.hook.state === 'anchored' && !sim.hook.reeling && Math.abs(sim.drive.th) > 0.3 && Math.abs(sim.rvSpeed()) < 0.4) {
      this.hookedT = (this.hookedT || 0) + dt;
      if (this.hookedT > 1.5 && this.t - (this.hookedToastAt ?? -99) > 12) { this.hookedToastAt = this.t; this.toast('The winch is still clipped to the post. Someone unhook it: E on the hook.', '#ffd166', 5); }
    } else this.hookedT = 0;

    const rvp = sim.rv.translation();
    if (this.phase === 'camp' && rvp.z > this.W.camp.exitZ) {
      this.phase = 'road';
      this.countJob('drv', this.roles.drv); this.countJob('nav', this.roles.nav);   // locked now: counted
      this.toast(`ON THE ROAD. ${fmt$(this.due)} due at midnight. Town is ${this.W.LEN} m out.`, '#ffd166', 6);
    }
    if (this.phase === 'road') {
      // the wildlife: today's cast, sized for the crew that's here as the road begins
      if (this.mobsOn && !sim.mobsDone && !sim.mobs?.started) sim.startMobs({ day: this.day, crew: this.liveCrew(), seed: this.seed });
      this.clock += dt / C.HOUR_SEC;
      if (!this.inTown && rvp.z > this.W.LEN - 8) {
        this.inTown = true;
        this.toast(`Made it to town at ${fmtClock(this.clock)}. Pawn shop on the left, casino on the right, Repo Man out front.`, '#7CFC00', 7);
      }
      if (this.clock >= C.MIDNIGHT) { this.clock = C.MIDNIGHT; this.midnight(); }
    }
    if (this.phase === 'night' && this.t - this.nightAt > C.NIGHT_MIN_SEC) {
      // everyone in a bunk: morning. Half of them: the rest get BED_WAIT seconds (someone AFK, or still
      // loading, must not hold the whole crew at the campfire forever)
      const live = [...this.players.values()].filter(p => p.connected);
      const abed = live.filter(p => p.bed);
      if (live.length && abed.length === live.length) this.nextDay();
      else if (live.length && abed.length * 2 >= live.length) {
        if (this.bedAt == null) {
          this.bedAt = this.t;
          const awake = live.filter(p => !p.bed).map(p => p.name);
          this.toast(`${awake.join(', ')} ${awake.length > 1 ? 'are' : 'is'} still up. The RV leaves at dawn in ${BED_WAIT} s, awake or not.`, '#ffd166', 6);
        } else if (this.t - this.bedAt > BED_WAIT) this.nextDay();
      } else this.bedAt = null;
    }
    if (this.phase === 'over' && this.t - this.over.at > (C.FAST ? 3 : 25)) {
      this.newRun();
      this.broadcast(this.worldMsg());
      this.broadcast({ t: 'props', list: this.sim.allProps() });
      for (const p of this.players.values()) p.par = 0;
      this.spawnStragglers();
      this.sendMeta();
      this.toast('A new RV. A new loan. The same idiots.', '#ffd166', 6);
      if (this.rolesText()) this.toast(this.rolesText(), '#ffd166', 6);
    }

    // casino
    const inCasino = [...this.players.values()].filter(p => p.pos && this.inCasino(p.pos));
    const r = this.bj.tick(this.t, inCasino, inCasino);
    if (r) {
      this.bank += r.delta || 0;
      if (r.msg) this.toast(r.msg, '#ffd166', 2);
      if (r.outcome) this.betResult(r.won, 'Blackjack', null);
    }
    if (this.pendingFlip && this.t >= this.pendingFlip.at) {
      const f = this.pendingFlip;
      this.pendingFlip = null;
      if (f.win) this.bank += f.stake * 2;
      this.betResult(f.win ? f.stake : -f.stake, 'Double or Nothing', f.by);
    }

    // a flipped RV gets towed (for a price)
    if (sim.rvFlipped()) {
      this.flippedT += dt;
      if (this.flippedT > 7) {
        this.flippedT = 0;
        sim.rightRV();
        if (this.rvc.inc && !this.rvc.inc.told) this.tellIncident();
        this.rvc.inc = null;
        this.bill(800, 'The RV was on its back. Tow truck: $800.');
      }
    } else this.flippedT = 0;

    // KO'd too long: you wake up and pay
    // (the client normally sends 'wake' itself; this is the backstop)
    for (const p of this.players.values()) {
      if (p.ko && this.t - p.koAt > C.PLAYER.KO_TIME + 5) this.onWake(p);
    }

    // a kept seat whose player never came back is freed
    for (const p of [...this.players.values()]) if (!p.connected && this.t - p.heldAt > p.holdSecs) this.removePlayer(p.id, 'expired');
    // a role's player who went quiet (or came back to life): the crew's prompts change (stand-ins)
    if (JSON.stringify(this.metaRoles()) !== this.rolesKey) this.sendMeta();

    // physics events out (if a new day or run began in this tick, the old world's events would land on
    // the new one's props, whose ids start over: drop them)
    const evs = sim.out.splice(0);
    if (evs.length && this.sim === sim) {
      const pub = [];
      for (const e of evs) {
        if (e.k === 'knock') {
          // why: 'rv' (run over), 'shove' (a friend), 'mob' (wildlife). Only your own RV running a friend
          // over bills: the rest cost time and, if nobody picks you up, the usual doctor's bill. A player who
          // is already down stays down (a knock would stand them up on their page)
          const pl = this.players.get(e.id);
          if (!pl || (pl.ko && e.why !== 'rv')) continue;
          const why = e.why || 'rv';
          this.send(pl, { t: 'knock', v: e.v, ko: !!e.ko, why, rel: e.rel ? 1 : 0 });
          pl.lastKnock = { why, by: e.by ?? null, t: this.t };
          // (a hard hat takes it: the page turns it into a knock, and nobody was knocked out)
          if (e.ko && why === 'rv' && !pl.hat) {
            const drv = [...this.players.values()].find(q => q.seat === 0);
            this.bill(C.RV_HIT_BILL, `${drv ? drv.name : 'The RV'} ran over ${pl.name}. ${fmt$(C.RV_HIT_BILL)}.`);
          }
          pub.push({ k: 'thud', id: e.id, why });
        } else if (e.k === 'rvhit') {
          if (this.onRVHit(e)) pub.push(e);
        } else {
          if (e.k === 'break') { this.stats.broken += e.lost; this.dayStats.broken += e.lost; }
          if (e.k === 'bean') {
            const a = this.players.get(e.by), b = this.players.get(e.id);
            this.stats.beanings = (this.stats.beanings || 0) + 1;
            if (a && b) this.toast(`${a.name} beaned ${b.name} with the ${LOOT[e.type]?.name || 'loot'}.`, '#ffd166', 3);
          }
          if (e.k === 'mob') this.onMobEvent(e);
          pub.push(e);
        }
      }
      if (pub.length) this.broadcast({ t: 'ev', list: pub });
    }
    if (this.theftQ.size) this.flushThefts();
  }

  // what the wildlife did, in words for the crew (the sounds and the rest are the pages' business)
  onMobEvent(e) {
    if (e.s === 'wake' && this.t - (this.beastToastAt ?? -99) > 10) {
      this.beastToastAt = this.t;
      this.toast('The Grumphorn is awake. Get off the road, or crouch and keep still.', '#ff8a65', 4);
    } else if (e.s === 'leave') {
      this.stats.beasts++;
      this.toast(`The Grumphorn has had enough of you. It wanders off, clanking. (It dropped its cowbell: ${fmt$(e.value)}.)`, '#7CFC00', 6);
    } else if (e.s === 'steal' && e.bait) {
      this.toast('A ringtail took the bait: off home with the cheese wheel.', '#ffd166', 3);
    } else if (e.s === 'steal' && !e.again) {
      if (e.ours) { this.stats.stolen += e.value; this.dayStats.stolen += e.value; }
      const q = this.theftQ.get(e.den) || { n: 0, value: 0, what: null, poi: e.poi, ours: false, at: Math.max(this.t, (this.theftToastAt.get(e.den) ?? -99) + 3) };
      q.n++; q.value += e.value; q.what = LOOT[e.type]?.name || 'loot'; q.ours = q.ours || !!e.ours; q.raid = q.raid || !!e.raid;
      this.theftQ.set(e.den, q);
    } else if (e.s === 'rumble') {
      const where = e.ob === 'gate' ? 'the ranger gate' : 'the boulder';
      this.toast(e.why === 'horn' ? `The horn shook loose rock off the rim by ${where}. Let it come down before you go through.`
        : `ROCKS! Loose rock is coming down by ${where}. Get away from the walls!`, '#ff8a65', 4);
    } else if (e.s === 'recovered') {
      this.stats.recovered += e.value; this.dayStats.recovered += e.value;
    } else if (e.s === 'bite') {
      const pl = this.players.get(e.by);
      if (pl) this.toast(`The ringtail bit ${pl.name}. (Two of you hold one and it can't.)`, '#ffb4a2', 3);
    }
  }
  // the crew hears of a den's thefts at most every 3 s (a raid of three is one line)
  flushThefts() {
    for (const [den, q] of [...this.theftQ]) {
      if (this.t < q.at) continue;
      this.theftQ.delete(den);
      this.theftToastAt.set(den, this.t);
      const where = q.poi ? ` at ${STOP_NAMES[q.poi] || 'the stop'}` : '';
      // (the stop's own loot nobody had touched yet: they beat you to it)
      const from = q.raid ? ' out of the RV' : '';
      if (!q.ours) this.toast(q.n === 1 ? `A ringtail beat you to the ${q.what} (${fmt$(q.value)})${where}. Its den is close by.`
        : `Ringtails beat you to ${q.n} things (${fmt$(q.value)})${where}. Their den is close by.`, '#ffd166', 4);
      else this.toast((q.n === 1 ? `A ringtail ran off with the ${q.what} (${fmt$(q.value)})${from}${where}! Its den is close by.`
        : `Ringtails ran off with ${q.n} things (${fmt$(q.value)})${from}${where}! Their den is close by.`) + (q.raid ? ' Shut the door when you leave the RV.' : ''), '#ffb74d', 5);
    }
  }

  inCasino(pos) {
    const c = this.W.town.casino;
    return Math.abs(pos.x - c.x) < 9.2 && Math.abs(pos.z - c.z) < 11.2 && pos.y > c.y - 1 && pos.y < c.y + 6;
  }

  gameState() {
    const sim = this.sim;
    const pawnIds = sim.propsIn(this.W.town.pawn);
    let pawn = 0, dock = 0;
    for (const id of pawnIds) pawn += Math.round(sim.props.get(id).value);
    if (this.docked()) for (const id of sim.cargo()) if (!pawnIds.includes(id)) dock += Math.round(sim.props.get(id).value * C.DOCK_RATE);
    return {
      ph: this.phase, day: this.day, clk: Math.round(this.clock * 100) / 100,
      bank: Math.round(this.bank), due: this.due, paid: this.paid ? 1 : 0,
      town: this.inTown ? 1 : 0, door: sim.doorOpen ? 1 : 0,
      bj: this.bj.view(this.t), flip: this.flip.view(this.t), pawn, pawnIds, dock,
      gates: [...this.gatesOpen], beds: [...this.players.values()].filter(p => p.bed).map(p => p.id),
      drv: [...this.players.values()].find(p => p.seat === 0)?.id ?? 0,
      mud: sim.mudWheels || 0,
      thf: sim.mobs?.stolenValue() || 0,   // what the ringtails hold of yours right now
      rfd: sim.mobs?.rockfalls.filter(r => r.st !== 'armed').map(r => r.id) || [],   // the loose rock that's come down
      rvh: Math.round(this.rvc.hp),   // the RV's condition (and, only when they apply: broken down, the fix's progress, tomorrow's due with Gus's loan)
      ...(this.rvc.hp <= 0 ? { brk: 1 } : {}),
      ...(this.rvc.fix > 0 ? { fix: Math.round(this.rvc.fix * 100) } : {}),
      ...(this.loanAdd > 0 ? { nxt: (C.QUOTAS[this.day] ?? 0) + this.loanAdd } : {}),
    };
  }

  snapshot() {
    this.snapN++;
    const s = this.sim.snapshot(this.snapN % 20 === 0);
    const pl = [];
    for (const p of this.players.values()) {
      if (!p.raw) continue;
      pl.push([p.id, p.par, r3(p.raw.x), r3(p.raw.y), r3(p.raw.z), r3(p.yaw), r3(p.pitch), p.ko ? C.MODE.KO : p.mode, p.flags, p.seat ?? -1]);
    }
    return { t: 's', tm: Math.round(this.t * 1000), rv: s.rv, pr: s.props, hk: s.hook, pl, g: this.gameState() };
  }
}

export function fmtClock(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60);
  const ap = hh >= 12 ? 'PM' : 'AM';
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${ap}`;
}
