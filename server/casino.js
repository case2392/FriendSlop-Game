// The Lucky Slop. One bank, the crew's: every game bets it and anybody can bet it. But each player plays their
// own game, and nobody waits for anybody: a seat at the blackjack table, a rail at the craps table, a Double or
// Nothing machine, a ticket on the Ringtail Derby. A stake leaves the bank when it's played (the deal, the
// roll, the pull, the ticket) and its winnings come back when the game settles.
//
// Stations (world gen: shared/world.js town.casino.stations): one player each, the one who sat down there;
// whoever walks off (or drops) gives it up, and a game left half-played is finished for them the way the
// house would (a hand stands, the dice roll on). The Derby is everybody's: a ticket each, one race.
import { Blackjack } from './blackjack.js';
import { FAST, CASINO } from '../shared/constants.js';

export const FLIP_ODDS = 0.485;              // Double or Nothing: the house always wins (eventually)
export const DERBY = { LANES: 4, PAYS: 3.8, OPEN_T: FAST ? 2 : 12, RACE_T: CASINO.RACE_T, SHOW_T: FAST ? 1 : 4 };
const RESULT_T = FAST ? 1 : 4;               // a settled game's result stays up this long
const ROLL_T = FAST ? 0.4 : 1.6;             // the dice tumble, the coin spins, before they say
export const SEAT_R = CASINO.SEAT_R;         // m from a station's spot: walk further and it's free again
export const GAMES = { bj: 'Blackjack', craps: 'Craps', flip: 'Double or Nothing', derby: 'the Ringtail Derby' };

// a stake set with the buttons: never more than the bank has right now
export function stepBet(cur, a, bank) {
  if (a === 'b100') return Math.min(Math.max(0, bank), cur + 100);
  if (a === 'b500') return Math.min(Math.max(0, bank), cur + 500);
  if (a === 'ball') return Math.max(0, bank);
  if (a === 'bclr') return 0;
  return cur;
}
const d6 = rng => 1 + Math.floor(rng() * 6);

export class Casino {
  // spots: [{ id, kind, x, z }] (the derby: one, everybody's)
  constructor(spots = [], rng = Math.random) {
    this.rng = rng;
    this.st = new Map();
    for (const s of spots) {
      const base = { id: s.id, kind: s.kind, x: s.x, z: s.z, owner: null, bet: 0, stake: 0, state: 'bet', until: 0, out: null, won: 0 };
      if (s.kind === 'craps') Object.assign(base, { point: 0, dice: null, rollAt: 0, pend: null });
      if (s.kind === 'flip') Object.assign(base, { pend: null, last: null });
      if (s.kind === 'derby') Object.assign(base, { state: 'open', tickets: [], bets: new Map(), order: null, seed: 0, race: 0 });
      this.st.set(s.id, base);
    }
  }

  // ---- taking a seat --------------------------------------------------------------------------------
  // p sat down at a station (its use point): it's theirs if it's free. One game at a time: a seat they had is
  // given up, its game played out the house's way -> { ok, results } or { err }
  sit(p, id, t = 0) {
    const s = this.st.get(id);
    if (!s || s.kind === 'derby') return { ok: !!s, results: [] };
    if (s.owner != null && s.owner !== p.id) return { err: 'Somebody\'s playing that one. There are others.' };
    const results = [];
    for (const o of this.st.values()) if (o !== s && o.owner === p.id) { results.push(...this.finish(o, t, p)); o.owner = null; o.bet = 0; }
    s.owner = p.id;
    return { ok: true, results };
  }
  // the stations each player holds, given up when they walk off or drop (an unfinished game is played out)
  // -> settled results
  release(players, t) {
    const out = [];
    for (const s of this.st.values()) {
      if (s.owner == null) continue;
      const p = players.get(s.owner);
      if (p?.connected && p.pos && Math.hypot(p.pos.x - s.x, p.pos.z - s.z) <= SEAT_R) continue;
      out.push(...this.finish(s, t, p || null));
      s.owner = null; s.bet = 0;
    }
    return out;
  }

  // ---- playing ---------------------------------------------------------------------------------------
  // a = b100 | b500 | ball | bclr (the stake), go (deal / roll / pull / buy a ticket on lane n), hit, stand.
  // -> { spend: what leaves the bank now, results: [settled], err, msg }
  act(p, id, a, n, t, bank) {
    const s = this.st.get(id);
    if (!s) return { err: 'No such game.' };
    if (s.kind !== 'derby' && s.owner !== p.id) return { err: s.owner == null ? 'Take a seat first.' : 'Somebody\'s playing that one.' };
    if (a === 'b100' || a === 'b500' || a === 'ball' || a === 'bclr') {
      if (s.kind === 'derby') { s.bets.set(p.id, stepBet(s.bets.get(p.id) || 0, a, bank)); return {}; }
      if (s.state === 'play' || s.state === 'point' || s.pend) return { err: 'Not in the middle of a game.' };
      s.bet = stepBet(s.bet, a, bank);
      return {};
    }
    const fn = { bj: this.bjAct, craps: this.crapsAct, flip: this.flipAct, derby: this.derbyAct }[s.kind];
    return fn.call(this, s, p, a, n, t, bank);
  }
  // a stake ready to go in
  stakeOf(amount, bank) {
    if (amount <= 0) return { err: 'Set a bet first: +$100, +$500 or ALL IN.' };
    if (amount > bank) return { err: `The bank has ${Math.max(0, Math.floor(bank)).toLocaleString('en-US')}. Bet less.` };
    return null;
  }

  // Blackjack: your own hand against the dealer. A natural pays 3 to 2.
  bjAct(s, p, a, n, t, bank) {
    if (a === 'go' && s.state !== 'play') {
      const no = this.stakeOf(s.bet, bank);
      if (no) return no;
      s.stake = s.bet; s.hand = new Blackjack(this.rng); s.out = null; s.state = 'play';
      if (s.hand.state === 'done') return { spend: s.stake, results: [this.bjSettle(s, t, p)] };
      return { spend: s.stake };
    }
    if (s.state !== 'play' || (a !== 'hit' && a !== 'stand' && a !== 'go')) return {};
    const done = s.hand.act(a === 'stand' ? 'stand' : 'hit');
    return done ? { results: [this.bjSettle(s, t, p)] } : {};
  }
  bjSettle(s, t, p) {
    const o = s.hand.outcome, back = o === 'natural' ? Math.floor(s.stake * 2.5) : o === 'win' ? s.stake * 2 : o === 'push' ? s.stake : 0;
    s.state = 'result'; s.out = o; s.won = back - s.stake; s.until = t + RESULT_T;
    return { back, won: s.won, game: GAMES.bj, p, id: s.id };
  }

  // Craps, the pass line: a 7 or 11 on the come-out wins, 2, 3 or 12 loses; anything else is the point, and
  // you roll till you make it again (win) or throw a 7 (lose). Even money; the house's edge is 1.4%.
  crapsAct(s, p, a, n, t, bank) {
    if (a !== 'go' || s.pend) return {};
    let spend = 0;
    if (s.state !== 'point') {
      const no = this.stakeOf(s.bet, bank);
      if (no) return no;
      s.stake = s.bet; spend = s.stake; s.point = 0; s.out = null;
    }
    const dice = [d6(this.rng), d6(this.rng)], sum = dice[0] + dice[1];
    s.dice = dice; s.rollAt = t; s.state = s.point ? 'point' : 'roll';
    // (it tells once they land)
    const out = !s.point ? (sum === 7 || sum === 11 ? 'win' : sum === 2 || sum === 3 || sum === 12 ? 'lose' : 'point')
      : sum === s.point ? 'win' : sum === 7 ? 'lose' : 'again';
    s.pend = { at: t + ROLL_T, out, sum, p };
    return { spend };
  }
  crapsLand(s, t) {
    const { out, sum, p } = s.pend;
    s.pend = null;
    if (out === 'point') { s.point = sum; s.state = 'point'; return []; }
    if (out === 'again') return [];
    const back = out === 'win' ? s.stake * 2 : 0;
    s.state = 'result'; s.out = out; s.won = back - s.stake; s.until = t + RESULT_T; s.point = 0;
    return [{ back, won: s.won, game: GAMES.craps, p, id: s.id }];
  }

  // Double or Nothing: the stake in, the lever pulled, a coin spins. The stake stays set for the next pull.
  flipAct(s, p, a, n, t, bank) {
    if (a !== 'go' || s.pend) return {};
    const no = this.stakeOf(s.bet, bank);
    if (no) return no;
    s.stake = s.bet;
    s.pend = { at: t + ROLL_T, win: this.rng() < FLIP_ODDS, p };
    s.state = 'spin';
    return { spend: s.stake };
  }
  flipLand(s, t) {
    const { win, p } = s.pend;
    s.pend = null;
    const back = win ? s.stake * 2 : 0;
    s.state = 'result'; s.out = win ? 'win' : 'lose'; s.won = back - s.stake; s.until = t + RESULT_T;
    s.last = { win, stake: s.stake, at: t };
    return [{ back, won: s.won, game: GAMES.flip, p, id: s.id }];
  }

  // The Ringtail Derby: four ringtails, a ticket on one. The board opens with the first ticket and the race
  // runs OPEN_T s later; the winner pays PAYS times the ticket (the house keeps 5%).
  derbyAct(s, p, a, n, t, bank) {
    if (a !== 'go') return {};
    if (s.state !== 'open') return { err: 'They\'re running. Next race.' };
    const lane = n | 0, amt = s.bets.get(p.id) || 0;
    if (lane < 1 || lane > DERBY.LANES) return { err: 'Pick a ringtail: 1 to 4.' };
    const no = this.stakeOf(amt, bank);
    if (no) return no;
    s.tickets.push({ pid: p.id, p, lane, stake: amt });
    if (!s.until) s.until = t + DERBY.OPEN_T;
    s.bets.set(p.id, 0);
    return { spend: amt, msg: `${p.name}: ${amt.toLocaleString('en-US')} on number ${lane}.` };
  }
  derbyRun(s, t) {
    // the finishing order, and a seed the pages draw the race from (the winner leads at the line)
    const order = [1, 2, 3, 4];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    s.order = order; s.seed = Math.floor(this.rng() * 1e9); s.state = 'race'; s.until = t + DERBY.RACE_T; s.race++;
  }
  derbyPay(s, t) {
    const out = [];
    for (const k of s.tickets) {
      const back = k.lane === s.order[0] ? Math.round(k.stake * DERBY.PAYS) : 0;
      out.push({ back, won: back - k.stake, game: GAMES.derby, p: k.p, id: s.id });
    }
    s.tickets = []; s.state = 'result'; s.until = t + DERBY.SHOW_T;
    return out;
  }

  // ---- time --------------------------------------------------------------------------------------------
  // -> settled results
  tick(t) {
    const out = [];
    for (const s of this.st.values()) {
      if (s.pend && t >= s.pend.at) out.push(...(s.kind === 'craps' ? this.crapsLand(s, t) : this.flipLand(s, t)));
      if (s.kind === 'derby') {
        if (s.state === 'open' && s.until && t >= s.until) this.derbyRun(s, t);
        else if (s.state === 'race' && t >= s.until) out.push(...this.derbyPay(s, t));
        else if (s.state === 'result' && t >= s.until) { s.state = 'open'; s.until = 0; s.order = null; }
        continue;
      }
      if (s.state === 'result' && t >= s.until) { s.state = 'bet'; s.hand = null; s.dice = null; s.out = null; }
    }
    return out;
  }
  // a station's game played out the house's way: a hand stands, the dice roll on to a decision, a coin lands
  finish(s, t, p) {
    const out = [];
    if (s.kind === 'bj' && s.state === 'play') { s.hand.act('stand'); out.push(this.bjSettle(s, t, p)); }
    if (s.kind === 'craps') {
      if (s.pend) out.push(...this.crapsLand(s, t));
      for (let i = 0; i < 200 && s.state === 'point'; i++) {
        const sum = d6(this.rng) + d6(this.rng);
        if (sum === s.point || sum === 7) { s.pend = { at: t, out: sum === s.point ? 'win' : 'lose', sum, p }; out.push(...this.crapsLand(s, t)); }
      }
    }
    if (s.kind === 'flip' && s.pend) out.push(...this.flipLand(s, t));
    return out;
  }
  // last call (the day's over): every game on the floor played out, the Derby run now if it has tickets
  closeAll(t) {
    const out = [];
    for (const s of this.st.values()) {
      if (s.kind === 'derby') {
        if (s.state === 'open' && s.tickets.length) this.derbyRun(s, t);
        if (s.state === 'race') out.push(...this.derbyPay(s, t));
        continue;
      }
      out.push(...this.finish(s, t, null));
    }
    return out;
  }
  // a stake on the table right now (in a hand, on a point, in a coin, on a ticket)
  inPlay() {
    let n = 0;
    for (const s of this.st.values()) {
      if (s.kind === 'derby') n += s.tickets.reduce((a, k) => a + k.stake, 0);
      else if (s.state === 'play' || s.state === 'point' || s.state === 'roll' || s.pend) n += s.stake;
    }
    return n;
  }

  // ---- what the pages see ------------------------------------------------------------------------------
  view(t) {
    const out = {};
    for (const s of this.st.values()) {
      const v = { k: s.kind, o: s.owner, st: s.state, bet: s.bet, stake: s.stake, out: s.out, won: s.won };
      if (s.kind === 'bj' && s.hand) {
        const h = s.hand.publicState();
        Object.assign(v, { cards: h.squad, tot: h.squadTotal, up: h.dealerUp, dl: h.dealer, dt: h.dealerTotal });
      }
      if (s.kind === 'craps') Object.assign(v, { pt: s.point, dice: s.dice, roll: s.dice ? Math.round((t - s.rollAt) * 10) / 10 : null, land: s.pend ? 0 : 1 });
      if (s.kind === 'flip') Object.assign(v, { spin: s.pend ? 1 : 0 });
      if (s.kind === 'derby') {
        Object.assign(v, { left: s.until ? Math.max(0, Math.ceil(s.until - t)) : null, order: s.order, seed: s.seed, race: s.race, rt: DERBY.RACE_T,
          el: s.state === 'race' ? Math.round((DERBY.RACE_T - (s.until - t)) * 10) / 10 : null,
          tix: s.tickets.map(k => [k.pid, k.lane, k.stake]), bets: Object.fromEntries(s.bets) });
      }
      out[s.id] = v;
    }
    return out;
  }
}
