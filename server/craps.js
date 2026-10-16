// The craps table: the rails play one game together, the way a casino runs it (playtest: craps should be table
// play like blackjack).
//   the come-out: bets go down on the pass line; the first ROLL ME IN starts a short count (the others can
//   still bet; everyone at a rail with a bet down saying so ends it at once) -> the shooter (the rails take the
//   dice in turn) throws: a 7 or 11 wins every line bet even money, 2, 3 or 12 loses them, anything else is the
//   point -> the shooter throws on till the point comes again (every line wins, and the odds laid behind it pay
//   true odds: casino.js ODDS) or a 7 (every line loses: seven-out, and the dice pass to the next rail) ->
//   the results stand a moment, then the next come-out, the same shooter (the dice pass only on a seven-out).
// A shooter slow to throw has the house throw for them; one who walks off hands the dice on. Pure game logic,
// on the caller's clock (t, seconds): server/casino.js seats the players and moves the money.
import { FAST } from '../shared/constants.js';

export const CR = {
  COUNT_T: FAST ? 1 : 6,       // after the first ROLL ME IN, the others' time to bet
  SHOOT_T: FAST ? 2 : 12,      // the shooter's time to throw, then the house throws for them
  ROLL_T: FAST ? 0.4 : 1.6,    // the dice in the air
  RESULT_T: FAST ? 1 : 4,
};
// odds behind the line pay true odds, up to MAX times the line
export const ODDS = { 4: 2, 10: 2, 5: 1.5, 9: 1.5, 6: 1.2, 8: 1.2, MAX: 3 };
const d6 = rng => 1 + Math.floor(rng() * 6);

export class CrapsTable {
  // rails: the rail ids in the order the dice go round
  constructor(rails, rng = Math.random) {
    this.rng = rng;
    this.order = [...rails];
    this.shooter = null;      // who has the dice (kept from round to round till a seven-out)
    this.reset();
  }
  reset() {
    this.state = 'bet';       // bet | count | shoot | roll | result
    this.until = 0;
    this.ready = new Set();   // rails that said ROLL ME IN
    this.stakes = new Map();  // rail id -> the line bet in this game
    this.odds = new Map();    // rail id -> odds behind the line
    this.outs = new Map();    // rail id -> { out, back, won } once settled
    this.playing = [];
    this.point = 0;
    this.dice = null;
    this.rollAt = 0;
    this.pend = null;         // the dice in the air: { at, sum, by }
    this.last = null;         // what the last throw did: 'natural' | 'craps' | 'point' | 'made' | 'seven-out' | 'again'
  }

  // ---- the come-out ---------------------------------------------------------------------------------------
  // a rail says ROLL ME IN with its bet down: the count starts (or, everyone at a rail with a bet down being
  // in, it's over at once). seated: the rails with someone at them and a bet down -> true if it took
  callIn(id, seated, t) {
    if (this.state !== 'bet' && this.state !== 'count') return false;
    this.ready.add(id);
    if (this.state === 'bet') { this.state = 'count'; this.until = t + CR.COUNT_T; }
    if (seated.every(s => this.ready.has(s))) this.until = t;
    return true;
  }
  // the count's run out: the game's on for the rails with a stake down (stakes: rail id -> amount, taken)
  // live: the rails with somebody at them (the dice go to one of those)
  begin(stakes, live, t) {
    this.playing = this.order.filter(id => stakes.get(id) > 0);
    if (!this.playing.length) { this.reset(); return false; }
    for (const id of this.playing) this.stakes.set(id, stakes.get(id));
    this.ready.clear();
    this.passTo(live, false);
    this.state = 'shoot'; this.until = t + CR.SHOOT_T;
    return true;
  }
  // the dice to the shooter, or (on: true, a seven-out, or they walked off) on round to the next rail that's in
  // the game, else the next with somebody at it
  passTo(live, on) {
    const n = this.order.length, i0 = this.shooter == null ? -1 : this.order.indexOf(this.shooter);
    if (!on && this.shooter != null && (this.playing.includes(this.shooter) || live.includes(this.shooter))) return;
    for (const pool of [this.playing, live]) {
      for (let k = 1; k <= n; k++) {
        const id = this.order[((i0 < 0 ? -1 : i0) + k + n) % n];
        if (pool.includes(id)) { this.shooter = id; return; }
      }
    }
    this.shooter = null;   // (nobody at the table: the house throws)
  }

  // ---- the throws -----------------------------------------------------------------------------------------
  // the shooter throws (by: their rail, or null for the house) -> true if it took
  roll(by, t) {
    if (this.state !== 'shoot' || (by != null && by !== this.shooter)) return false;
    const dice = [d6(this.rng), d6(this.rng)];
    this.dice = dice; this.rollAt = t; this.state = 'roll';
    this.pend = { at: t + CR.ROLL_T, sum: dice[0] + dice[1], by };
    return true;
  }
  // odds behind the line, once there's a point and the dice are down: up to ODDS.MAX times the line ->
  // how much more goes on (0: none)
  layOdds(id, amount) {
    if (this.state !== 'shoot' || !this.point || !this.stakes.has(id)) return 0;
    const room = this.stakes.get(id) * ODDS.MAX - (this.odds.get(id) || 0), add = Math.max(0, Math.min(amount, room));
    if (add > 0) this.odds.set(id, (this.odds.get(id) || 0) + add);
    return add;
  }
  // the time's come for the next step -> the results when the game settles: [{ id, back, won, out }]
  // live: the rails with somebody at them
  step(t, live = []) {
    if (this.state === 'shoot' && t >= this.until) { this.roll(null, t); return null; }   // (the house throws for a slow shooter)
    if (this.state === 'roll' && t >= this.pend.at) {
      const { sum } = this.pend;
      this.pend = null;
      if (!this.point) {
        if (sum === 7 || sum === 11) { this.last = 'natural'; return this.settle(true, t); }
        if (sum === 2 || sum === 3 || sum === 12) { this.last = 'craps'; return this.settle(false, t); }
        this.point = sum; this.last = 'point';
      } else if (sum === this.point) { this.last = 'made'; return this.settle(true, t); }
      else if (sum === 7) { this.last = 'seven-out'; const r = this.settle(false, t); this.passTo(live, true); return r; }
      else this.last = 'again';
      this.state = 'shoot'; this.until = t + CR.SHOOT_T;
      return null;
    }
    if (this.state === 'result' && t >= this.until) {
      const keep = this.shooter;
      this.reset();
      this.shooter = keep;
      return null;
    }
    return null;
  }
  settle(win, t) {
    const out = [];
    for (const id of this.playing) {
      const stake = this.stakes.get(id) || 0, odds = this.odds.get(id) || 0;
      const back = win ? stake * 2 + (odds ? odds + Math.floor(odds * ODDS[this.point]) : 0) : 0;
      const r = { id, back, won: back - stake - odds, out: win ? 'win' : 'lose' };
      this.outs.set(id, r);
      out.push(r);
    }
    this.state = 'result'; this.until = t + CR.RESULT_T;
    return out;
  }
  // the shooter walked off: the dice go round to the next one in the game, else the house throws (its clock)
  vacated(id, live, t) {
    if (this.shooter !== id) return;
    this.passTo(live.filter(x => x !== id), true);
    if (this.state === 'shoot') this.until = this.shooter != null && live.includes(this.shooter) ? t + CR.SHOOT_T : t;
  }
  // last call: thrown on to a decision now, everything paid
  close(t, live = []) {
    if (this.state === 'bet' || this.state === 'count') { this.reset(); return []; }
    for (let i = 0; i < 400; i++) {
      if (this.state === 'result') return [...this.outs.values()];
      if (this.state === 'shoot') this.roll(null, t);
      if (this.state === 'roll') { this.pend.at = t; const r = this.step(t, live); if (r) return r; }
    }
    return [];
  }
  // what's on the felt for the pages
  view(t) {
    return {
      st: this.state, pt: this.point, sh: this.shooter, last: this.last,
      dice: this.dice, roll: this.dice ? Math.round((t - this.rollAt) * 10) / 10 : null, land: this.pend ? 0 : 1,
      left: this.until && (this.state === 'count' || this.state === 'shoot') ? Math.max(0, Math.ceil(this.until - t)) : null,
      ready: [...this.ready],
    };
  }
  railView(id) {
    const o = this.outs.get(id);
    return { stake: this.stakes.get(id) || 0, odds: this.odds.get(id) || 0, out: o?.out || null, won: o?.won || 0 };
  }
  // what's riding on the table now
  inPlay() {
    if (this.state === 'result') return 0;
    let n = 0;
    for (const id of this.playing) n += (this.stakes.get(id) || 0) + (this.odds.get(id) || 0);
    return n;
  }
}
