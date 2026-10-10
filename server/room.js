// A room = one crew, one RV, one run of five days.
//
//   camp  — morning. the clock is frozen until the RV rolls out of camp.
//   road  — the clock runs. scavenge, climb, winch, get to town, pawn, gamble.
//   night — paid (or repo'd). campfire, store, everyone into a bunk = next day.
//   over  — you own the RV, or the Repo Man owns you. then a fresh run.

import * as C from '../shared/constants.js';
import { generateLeg } from '../shared/world.js';
import { LOOT, fmt$ } from '../shared/loot.js';
import { RV_SEATS, RV_SEAT_EXIT, RV_DIM, toWorld, qRotate, insideRV } from '../shared/rv.js';
import { Sim } from './sim.js';
import { BJTable, FlipMachine } from './casino.js';

let nextPlayerId = 1;
const r3 = n => Math.round(n * 1000) / 1000;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const PRICES = { walkie: 150, drink: 40, bungee: 90 };

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
    for (const p of this.players.values()) { p.bed = false; p.seat = null; p.ko = false; }
  }

  nextDay() {
    const carry = this.sim.carryOver();
    // who's riding along? their RV-local pose survives the teleport
    this.day++;
    if (this.day > C.DAYS) return this.finish(true);
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
    this.broadcast({ t: 'over', won, day: this.over.day, stats: this.stats, bank: this.bank, strikes: this.strikes });
    this.sendMeta();
  }

  worldMsg() {
    return { t: 'world', seed: this.seed, day: this.day, parts: this.parts, door: this.sim.doorOpen };
  }

  // ---- membership --------------------------------------------------------------------

  addPlayer(conn, name) {
    if (this.players.size >= C.MAX_PLAYERS) return { error: 'This RV is full (6 seats, 2 of them real).' };
    const used = [...this.players.values()].map(p => p.color);
    const color = C.COLORS.find(c => !used.includes(c)) || C.COLORS[0];
    const p = {
      id: nextPlayerId++, name: String(name || 'Blob').replace(/[<>]/g, '').slice(0, 16) || 'Blob',
      color, conn, connected: true,
      par: 0, lp: null, pos: null, eye: null, look: { x: 0, y: 0, z: 1 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, mode: 0, flags: 0, seat: null, ko: false, koAt: 0, bed: false,
      walkie: false, voice: false, lastPush: 0,
    };
    this.players.set(p.id, p);
    if (!this.hostId || !this.players.get(this.hostId)?.connected) this.hostId = p.id;
    return { player: p };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.sim.release(id);
    this.sim.dropHook(id);
    this.players.delete(id);
    if (this.hostId === id) this.hostId = [...this.players.values()][0]?.id ?? null;
    if (this.players.size === 0) this.closed = true;
    else this.sendMeta();
  }

  // where a fresh (or left-behind) player appears
  spawnFor(p) {
    const W = this.W;
    if (this.phase === 'camp') {
      const s = W.camp.spawns[(p.id - 1) % W.camp.spawns.length];
      return { x: s.x, y: W.heightAt(s.x, s.z) + 0.05, z: s.z, yaw: Math.atan2(W.camp.fire.x - s.x, W.camp.fire.z - s.z) };
    }
    // next to the RV's door, outside
    const { p: rp, q } = this.sim.rvPose();
    const w = toWorld(rp, q, { x: -2.6, y: 0, z: RV_DIM.DOOR_Z });
    return { x: w.x, y: W.heightAt(w.x, w.z) + 0.3, z: w.z, yaw: 0 };
  }

  spawnStragglers() {
    for (const p of this.players.values()) {
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
    this.sendMeta();
  }

  // ---- messaging ----------------------------------------------------------------------

  send(p, msg) {
    if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(JSON.stringify(msg));
  }
  broadcast(msg, except = null) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p === except) continue;
      if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(s);
    }
  }
  toast(text, color = '#fff', secs = 4, to = null) {
    const m = { t: 'toast', text, color, secs };
    if (to) this.send(to, m); else this.broadcast(m);
  }
  sendMeta() {
    this.broadcast({
      t: 'meta', code: this.code, host: this.hostId,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, walkie: p.walkie, voice: p.voice })),
    });
  }

  // ---- intents ----------------------------------------------------------------------------

  handle(p, m) {
    switch (m.t) {
      case 'p': return this.onPose(p, m);
      case 'grab': if (!p.ko && p.seat == null) { const ok = this.sim.grab(p.id, p, m); this.send(p, { t: 'grabbed', ok, kind: m.kind, id: m.id }); } return;
      case 'rel': this.sim.release(p.id, m.thr ? m.dir : null, p); return;
      case 'hd': this.sim.holdDist(p.id, m.d); return;
      case 'push': if (this.t - p.lastPush > 0.05) { p.lastPush = this.t; this.sim.push(p.id, m); } return;
      case 'drv': if (p.seat === 0) this.sim.setDrive(m); return;
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
        if (!target || target === p || JSON.stringify(m.data ?? null).length > 20000) return;
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
    const f = a => (Number.isFinite(+a) ? +a : 0);
    p.par = m.par ? 1 : 0;
    p.yaw = f(m.yaw); p.pitch = Math.max(-1.6, Math.min(1.6, f(m.pitch)));
    p.mode = f(m.m) | 0; p.flags = f(m.f) | 0;
    p.vel = { x: f(m.v?.[0]), y: f(m.v?.[1]), z: f(m.v?.[2]) };
    const raw = { x: f(m.x), y: f(m.y), z: f(m.z) };
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
      if (idx === 0) this.toast(`${p.name} is driving. God help us.`, p.color, 3);
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
      const ids = sim.propsIn(W.town.pawn);
      if (!ids.length) { this.toast('Ed looks at the empty counter. Ed looks at you.', '#fff', 3, p); return; }
      let total = 0;
      const names = [];
      for (const id of ids) {
        const pr = sim.props.get(id);
        total += Math.round(pr.value);
        names.push(LOOT[pr.type].name);
        sim.removeProp(id);
      }
      this.bank += total;
      this.stats.sold += total; this.dayStats.sold += total;
      this.broadcast({ t: 'ev', list: [{ k: 'sold', ids, total, by: p.id }] });
      this.toast(`SOLD: ${names.join(', ')} → +${fmt$(total)}`, '#7CFC00', 5);
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
    const lot = this.W.town.lot;
    if (!this.inTown) {
      this.sim.placeRV(lot.x, lot.z, lot.yaw);
      this.toast('You limped into town overnight.', '#fff', 4);
    }
    // anyone not riding the RV gets dragged to the campfire
    for (const p of this.players.values()) {
      if (p.par) continue;
      const f = this.W.town.fire;
      const a = (p.id * 1.7) % (Math.PI * 2);
      const s = { x: f.x + Math.cos(a) * 3, z: f.z + Math.sin(a) * 3 };
      this.send(p, { t: 'tp', x: s.x, y: this.W.townY + 0.1, z: s.z, yaw: Math.atan2(f.x - s.x, f.z - s.z) });
    }
    this.broadcast({ t: 'receipt', day: this.day, paid: this.paid, due: this.due, bank: this.bank, strikes: this.strikes, parts: this.parts, ...this.dayStats });
  }

  midnight() {
    if (this.paid) return;
    if (this.bank >= this.due) { this.pay(); return; }
    // short. he takes everything you have, and a piece of the RV.
    const part = C.REPO_PARTS[this.strikes];
    this.strikes++;
    const took = Math.max(0, this.bank);
    this.bank = Math.min(0, this.bank);
    this.broadcast({ t: 'ev', list: [{ k: 'repo', part, took }] });
    if (part === 'rv' || this.strikes >= C.STRIKES_TO_LOSE) {
      this.toast('The Repo Man hooks the RV. It\'s over.', '#ff5252', 8);
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
    // nobody at the wheel? it coasts ("WHO'S DRIVING?!") until it's nearly stopped, then the parking brake catches
    if (![...this.players.values()].some(p => p.seat === 0)) sim.setDrive({ th: 0, st: 0, hb: Math.abs(sim.rvSpeed()) < 1.2 && !sim.hook.reeling ? 1 : 0 });
    sim.step(dt, this.players);
    for (const p of this.players.values()) this.resolvePlayer(p);

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
      const live = [...this.players.values()].filter(p => p.connected);
      if (live.length && live.every(p => p.bed)) this.nextDay();
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

    // physics events out
    const evs = sim.out.splice(0);
    if (evs.length) {
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
    let pawn = 0;
    for (const id of pawnIds) pawn += Math.round(sim.props.get(id).value);
    return {
      ph: this.phase, day: this.day, clk: Math.round(this.clock * 100) / 100,
      bank: Math.round(this.bank), due: this.due, paid: this.paid ? 1 : 0, str: this.strikes,
      town: this.inTown ? 1 : 0, door: sim.doorOpen ? 1 : 0,
      bj: this.bj.view(this.t), flip: this.flip.view(this.t), pawn, pawnIds,
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
