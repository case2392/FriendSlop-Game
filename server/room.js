// A room = one crew, one RV, one run of five days.
//
//   camp  — morning. the clock is frozen until the RV rolls out of camp.
//   road  — the clock runs. scavenge, climb, winch, get to town, pawn, gamble.
//   night — paid (or repo'd). campfire, store, everyone into a bunk = next day.
//   over  — you own the RV, or the Repo Man owns you. then a fresh run.

import * as C from '../shared/constants.js';
import { generateLeg } from '../shared/world.js';
import { LOOT, fmt$, MAP_NO_DRIVER } from '../shared/loot.js';
import { RV_SEATS, RV_SEAT_EXIT, RV_DIM, toWorld, qRotate, insideRV } from '../shared/rv.js';
import { Sim } from './sim.js';
import { BJTable, FlipMachine } from './casino.js';

let nextPlayerId = 1;
const r3 = n => Math.round(n * 1000) / 1000;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const PRICES = { walkie: 150, drink: 40, bungee: 90 };
const HOLD_SECS = 90;            // a dropped player's seat (id, color, walkie) is kept this long
const BED_WAIT = 45;             // once half the crew is in a bunk, the rest get this long
const READY_WAIT = 60;           // snapshots wait this long at most for a client to finish building its world
// the least time between two of these from one player (a stuck key or a modified client can't flood the crew)
// a held key or a modified client can't spam the crew with these (anything that sets state, like
// 'voice', is never dropped: a lost 'voice off' would leave a mic open)
const COOLDOWN = { emote: 0.25, ping: 0.25, horn: 0.25 };
// voice-chat signalling comes in bursts (an offer and a dozen ICE candidates within milliseconds), so
// it gets a byte budget instead: 48 KB a second, 96 KB at once
const RTC_RATE = 48 * 1024, RTC_BURST = 96 * 1024;
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
    this.newRun(seed);
  }

  // ---- the run ---------------------------------------------------------------------

  newRun(seed = null) {
    this.seed = seed ?? (Math.floor(Math.random() * 1e9) >>> 0);
    this.day = 1;
    this.bank = 200;                 // gas money. that's it. that's all you have.
    this.strikes = 0;
    this.parts = { doors: true, roof: true };
    this.stats = { bills: 0, broken: 0, sold: 0, bestWin: null, worstLoss: null, kos: 0 };
    this.over = null;
    this.startDay([]);
  }

  startDay(carry) {
    // the old day's physics world lives in WASM memory that garbage collection gives back late or
    // never: free it, once the tick that replaced it (which may still hold it) has finished
    if (this.sim) { const old = this.sim; setImmediate(() => old.free()); }
    // (a blackjack hand still being voted on when the day ends: the stake comes back)
    if (this.bj?.state === 'vote' && this.bj.stake > 0) { this.bank += this.bj.stake; this.toast(`The dealer pushed the hand back: ${fmt$(this.bj.stake)} returned.`, '#fff', 4); }
    this.W = generateLeg(this.seed, this.day);
    this.sim = new Sim(this.W, { parts: this.parts, carry });
    this.phase = 'camp';
    this.clock = C.DAY_START;
    this.paid = false;
    this.due = C.QUOTAS[this.day - 1];
    this.inTown = false;
    this.flippedT = 0;
    this.nightAt = 0;
    this.dayStats = { sold: 0, bills: 0, broken: 0, gamble: 0 };
    this.bj = new BJTable(this.W.town.bj);
    this.flip = new FlipMachine();
    this.pendingFlip = null;
    this.gatesOpen = new Set();
    this.bedAt = null;
    this.receipt = null;
    for (const p of this.players.values()) {
      if (p.seat != null) this.send(p, { t: 'seat', seat: null });
      p.bed = false; p.seat = null; p.ko = false; this.awaitReady(p);
    }
  }

  nextDay() {
    const carry = this.sim.carryOver();
    // who's riding along? their RV-local pose survives the teleport
    this.day++;
    if (this.day > C.DAYS) return this.finish(this.paid);   // (a paid last day has already ended the run)
    this.startDay(carry);
    this.broadcast(this.worldMsg());
    this.broadcast({ t: 'props', list: this.sim.allProps() });
    this.spawnStragglers();
    this.toast(`DAY ${this.day} — ${fmt$(this.due)} due at midnight. The Repo Man is already on the road.`, '#ffd166', 7);
    this.sendMeta();
  }

  finish(won) {
    this.phase = 'over';
    this.over = { won, at: this.t, day: Math.min(this.day, C.DAYS), stats: this.stats, bank: this.bank };
    this.broadcast(this.overMsg());
    this.sendMeta();
  }

  overMsg() { return { t: 'over', won: this.over.won, day: this.over.day, stats: this.stats, bank: this.bank, strikes: this.strikes, next: Math.max(0, Math.round((C.FAST ? 3 : 25) - (this.t - this.over.at))) }; }

  worldMsg() {
    return { t: 'world', seed: this.seed, day: this.day, parts: this.parts, door: this.sim.doorOpen };
  }

  // ---- membership --------------------------------------------------------------------

  // opts.ready: the client says when it has built its world, and gets snapshots only after that
  addPlayer(conn, name, opts = {}) {
    if (this.players.size >= C.MAX_PLAYERS) {
      // a newcomer beats a seat that's being kept for someone who dropped
      const held = [...this.players.values()].filter(p => !p.connected).sort((a, b) => a.heldAt - b.heldAt)[0];
      if (held) this.removePlayer(held.id, 'expired');
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
      walkie: false, voice: false, lastPush: 0, drvAt: 0, cd: {},
    };
    this.players.set(p.id, p);
    if (!this.hostId || !this.players.get(this.hostId)?.connected) this.hostId = p.id;
    return { player: p };
  }

  // why: 'left' (they chose to), 'expired' (dropped and never came back), or null (silent)
  removePlayer(id, why = null) {
    const p = this.players.get(id);
    if (!p) return;
    this.sim.release(id);
    this.sim.dropHook(id);
    this.players.delete(id);
    if (this.hostId === id) this.hostId = [...this.players.values()].find(q => q.connected)?.id ?? null;
    if (this.players.size === 0) { this.closed = true; return; }
    if (why === 'left') this.toast(`${p.name} left the trip.`, '#ffb4a2', 4);
    else if (why === 'expired' && p.heldAt != null) this.toast(`${p.name} didn't make it back. Their seat is free.`, '#ffb4a2', 4);
    this.sendMeta();
  }

  // The connection dropped: keep the seat (id, color, walkie, slot) for `secs`, but take the body out of
  // the world at once, so nothing waits on them (bunks, the wheel, a held prop, the hook) and the RV has
  // no ghost to run over. The room stays open while anyone's seat is kept.
  hold(p, secs = HOLD_SECS, quiet = false) {
    if (!p.connected) return;
    p.connected = false; p.conn = null; p.heldAt = this.t; p.holdSecs = secs; p.ready = false;
    p.seat = null; p.bed = false; p.ko = false;
    this.sim.release(p.id);
    this.sim.dropHook(p.id);
    p.raw = null; p.pos = null; p.eye = null; p.par = 0; p.lp = null;
    if (this.hostId === p.id) this.hostId = [...this.players.values()].find(q => q.connected)?.id ?? null;
    if (!quiet && [...this.players.values()].some(q => q.connected)) {
      this.toast(`${p.name} lost connection. Their seat is saved for ${secs} s.`, '#ffb4a2', 4);
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
      p.conn = conn; p.connected = true; p.heldAt = null; p.rdy = !!opts.ready;
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
    if (this.phase === 'night' && this.receipt) this.send(p, this.receipt);
    if (this.phase === 'over' && this.over) this.send(p, this.overMsg());
    this.sendMeta();
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
    this.broadcast({
      t: 'meta', code: this.code, host: this.hostId,
      players: [...this.players.values()].filter(p => p.connected).map(p => ({ id: p.id, name: p.name, color: p.color, walkie: p.walkie, voice: p.voice })),
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
      case 'ready': p.ready = true; return;
      case 'leave': this.removePlayer(p.id, 'left'); return;
      case 'grab': return this.onGrab(p, m);
      case 'rel': this.sim.release(p.id, m.thr ? m.dir : null, p); return;
      case 'hd': this.sim.holdDist(p.id, m.d); return;
      case 'push': if (this.t - p.lastPush > 0.05) { p.lastPush = this.t; this.sim.push(p.id, m, p); } return;
      case 'drv': if (p.seat === 0) { p.drvAt = this.t; this.sim.setDrive(m); } return;
      case 'horn': if (p.seat === 0) this.broadcast({ t: 'ev', list: [{ k: 'horn' }] }); return;
      case 'use': return this.onUse(p, m);
      case 'ko': return this.onKO(p, m);
      case 'wake': return this.onWake(p);
      case 'emote': if (C.EMOTES.includes(m.e)) this.broadcast({ t: 'emote', id: p.id, e: m.e }); return;
      case 'ping': {
        const pt = Array.isArray(m.pt) ? m.pt.slice(0, 3).map(Number) : null;
        if (pt && pt.every(Number.isFinite)) this.broadcast({ t: 'ping', id: p.id, pt });
        return;
      }
      case 'voice': p.voice = !!m.on; this.sendMeta(); return;
      case 'dbg': if (C.TEST) this.debug(p, m); return;
      case 'rtc': {
        const target = this.players.get(Number(m.to));
        const size = JSON.stringify(m.data ?? null).length;
        if (!target || target === p || size > 20000) return;
        p.rtcBudget = Math.min(RTC_BURST, (p.rtcBudget ?? RTC_BURST) + (this.t - (p.rtcAt ?? this.t)) * RTC_RATE);
        p.rtcAt = this.t;
        if (p.rtcBudget < size) return;
        p.rtcBudget -= size;
        this.send(target, { t: 'rtc', from: p.id, data: m.data });
        return;
      }
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
    else if (m.op === 'spawn') {
      const pr = sim.addProp(m.type, { x: +m.x, y: +m.y, z: +m.z }, { x: 0, y: 0, z: 0, w: 1 }, +m.value || 100, +m.value || 100);
      if (pr) this.broadcast({ t: 'ev', list: [{ k: 'spawn', p: sim.describe(pr) }] });
      this.send(p, { t: 'dbg', op: 'spawned', id: pr?.id });
    }
  }

  onPose(p, m) {
    p.par = m.par ? 1 : 0;
    p.yaw = num(m.yaw, 1e4); p.pitch = num(m.pitch, 1.6);
    p.mode = num(m.m, 99) | 0; p.flags = num(m.f, 1e6) | 0;
    p.vel = { x: num(m.v?.[0], 60), y: num(m.v?.[1], 60), z: num(m.v?.[2], 60) };
    const raw = { x: num(m.x, 1e5), y: num(m.y, 1e5), z: num(m.z, 1e5) };
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
    if (p.ko || p.seat != null) return;
    if (m.kind === 'prop' && this.sim.props.get(Number(m.id))?.type === 'map' && !this.mayTakeMap(p)) {
      this.send(p, { t: 'grabbed', ok: false, kind: m.kind, id: m.id });
      this.toast(MAP_NO_DRIVER, '#fff', 3, p);
      return;
    }
    const ok = this.sim.grab(p.id, p, m);
    this.send(p, { t: 'grabbed', ok, kind: m.kind, id: m.id });
  }
  // Someone else is in the driver's seat (a dropped player's seat is freed at once: hold()). No exception for
  // a player alone: every trip starts with its host alone while friends type the code in, the clock stopped
  // in camp. Solo, there's nobody to read it to you. The client asks the same (main.js mapFree).
  mayTakeMap(p) { return [...this.players.values()].some(q => q !== p && q.seat === 0); }

  onUse(p, m) {
    if (p.ko || !p.pos) return;
    const W = this.W, sim = this.sim;
    const kind = String(m.kind || '');
    const rvLocal = p.pos ? sim.rvToLocal(p.pos) : null;
    const inRV = rvLocal && insideRV(rvLocal.x, rvLocal.y, rvLocal.z, 0.6);

    if (kind === 'seat0' || kind === 'seat1') {
      const idx = kind === 'seat0' ? 0 : 1;
      if (!inRV) return;
      if ([...this.players.values()].some(q => q.seat === idx && q !== p)) { this.toast('Somebody\'s already sitting there.', '#fff', 2, p); return; }
      sim.release(p.id);
      p.seat = idx;
      if (idx === 0) sim.setDrive({ th: 0, st: 0, hb: 0 });
      this.send(p, { t: 'seat', seat: idx });
      if (idx === 0) {
        // (the map is up for grabs now: say so while it lies in the RV with nobody reading it, there's somebody
        // else to read it, and the road ahead matters)
        const map = [...sim.props.values()].find(q => q.type === 'map'), ml = map && sim.rvToLocal(map.body.translation());
        const ask = map && !map.holders.size && insideRV(ml.x, ml.y, ml.z, 0.3) && (this.phase === 'camp' || this.phase === 'road') && !this.inTown
          && [...this.players.values()].filter(q => q.connected).length > 1;
        this.toast(`${p.name} is driving. God help us.${ask ? ' Somebody grab the map.' : ''}`, p.color, 3);
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
      if (!sim.parts.doors) { this.toast('There is no door. The Repo Man has the door.', '#ff8a80', 3, p); return; }
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
      if (what === 'bungee') {
        const n = sim.tieDown();
        if (!n) return this.toast('Nothing loose in the RV to tie down.', '#fff', 3, p);
        this.bank -= price;
        this.toast(`${p.name} bungee'd ${n} things down in the RV (${fmt$(price)}). Grab one to untie it.`, p.color, 4);
        return;
      }
      this.bank -= price;
      if (what === 'walkie') { p.walkie = true; this.sendMeta(); this.toast(`${p.name} bought a walkie-talkie. Hold T to talk to anyone else with one.`, p.color, 4); }
      if (what === 'drink') { this.send(p, { t: 'drink' }); this.toast(`${p.name} chugged an energy drink.`, p.color, 3); }
    } else if (u.kind === 'pay') {
      if (this.paid) return this.toast('Already paid. He\'s just... watching you now.', '#fff', 3, p);
      // past midnight he has already taken what he came for: today's payment can't be made any more
      if (this.phase === 'night' || this.phase === 'over') return this.toast('Too late. He already came at midnight. Next payment is tomorrow.', '#ff8a80', 4, p);
      if (this.bank < this.due) return this.toast(`The Repo Man wants ${fmt$(this.due)}. You have ${fmt$(this.bank)}.`, '#ff8a80', 4, p);
      this.pay(p);
    }
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
    p.koAt = this.t;
    p.seat = null;
    this.sim.release(p.id);
    this.sim.dropHook(p.id);
    this.stats.kos++;
    const how = { fall: 'ate dirt', rv: 'got run over', crash: 'went through the windshield (almost)' }[m.why] || 'is down';
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
    this.receipt = { t: 'receipt', day: this.day, paid: this.paid, due: this.due, bank: this.bank, strikes: this.strikes, parts: this.parts, ...this.dayStats };
    this.broadcast(this.receipt);
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

  midnight() {
    if (this.paid) return;
    this.sellCounter(0, true);
    if (this.bank >= this.due) { this.pay(); return; }
    // short. he takes everything you have, and a piece of the RV.
    const part = C.REPO_PARTS[this.strikes];
    this.strikes++;
    const took = Math.max(0, this.bank);
    this.bank = Math.min(0, this.bank);
    this.broadcast({ t: 'ev', list: [{ k: 'repo', part, took }] });
    // the last day's balloon payment is all or nothing: short on it, the RV goes whatever the strikes
    if (part === 'rv' || this.strikes >= C.STRIKES_TO_LOSE || this.day >= C.DAYS) {
      this.toast(this.day >= C.DAYS && part !== 'rv' ? 'Short on the balloon payment. The Repo Man hooks the RV. It\'s over.' : 'The Repo Man hooks the RV. It\'s over.', '#ff5252', 8);
      return this.finish(false);
    }
    this.parts[part] = false;
    this.sim.removePart(part);
    this.broadcast({ t: 'parts', parts: this.parts });
    this.toast(`MIDNIGHT. Short on the payment — the Repo Man took ${fmt$(took)} AND THE ${part.toUpperCase()}. Strike ${this.strikes}/${C.STRIKES_TO_LOSE - 1}.`, '#ff5252', 8);
    this.beginNight();
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
    for (const p of this.players.values()) this.resolvePlayer(p);
    // the driver floors it against a winch cable still clipped to its post: say why nothing happens
    if (drv && sim.hook.state === 'anchored' && !sim.hook.reeling && Math.abs(sim.drive.th) > 0.3 && Math.abs(sim.rvSpeed()) < 0.4) {
      this.hookedT = (this.hookedT || 0) + dt;
      if (this.hookedT > 1.5 && this.t - (this.hookedToastAt ?? -99) > 12) { this.hookedToastAt = this.t; this.toast('The winch is still clipped to the post. Someone unhook it: E on the hook.', '#ffd166', 5); }
    } else this.hookedT = 0;

    const rvp = sim.rv.translation();
    if (this.phase === 'camp' && rvp.z > this.W.camp.exitZ) {
      this.phase = 'road';
      this.toast(`ON THE ROAD. ${fmt$(this.due)} due at midnight. Town is ${this.W.LEN} m out.`, '#ffd166', 6);
    }
    if (this.phase === 'road') {
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

    // physics events out (if a new day or run began in this tick, the old world's events would land on
    // the new one's props, whose ids start over: drop them)
    const evs = sim.out.splice(0);
    if (evs.length && this.sim === sim) {
      const pub = [];
      for (const e of evs) {
        if (e.k === 'knock') {
          const pl = this.players.get(e.id);
          if (!pl) continue;
          this.send(pl, { t: 'knock', v: e.v, ko: e.ko });
          if (e.ko) {
            const drv = [...this.players.values()].find(q => q.seat === 0);
            this.bill(C.RV_HIT_BILL, `${drv ? drv.name : 'The RV'} ran over ${pl.name}. ${fmt$(C.RV_HIT_BILL)}.`);
          }
          pub.push({ k: 'thud', id: e.id });
        } else {
          if (e.k === 'break') { this.stats.broken += e.lost; this.dayStats.broken += e.lost; }
          pub.push(e);
        }
      }
      if (pub.length) this.broadcast({ t: 'ev', list: pub });
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
      bank: Math.round(this.bank), due: this.due, paid: this.paid ? 1 : 0, str: this.strikes,
      town: this.inTown ? 1 : 0, door: sim.doorOpen ? 1 : 0,
      bj: this.bj.view(this.t), flip: this.flip.view(this.t), pawn, pawnIds, dock,
      gates: [...this.gatesOpen], beds: [...this.players.values()].filter(p => p.bed).map(p => p.id),
      drv: [...this.players.values()].find(p => p.seat === 0)?.id ?? 0,
      mud: sim.mudWheels || 0,
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
