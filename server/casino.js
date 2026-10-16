// The Lucky Slop. One bank, the crew's: every game bets it and anybody can bet it. A seat at the blackjack
// table (the table plays its rounds together, dealt round the seats the way a casino deals: server/blackjack.js),
// a rail at the craps table (one game for the table too, one shooter, the dice going round: server/craps.js), a
// Double or Nothing machine, a ticket on the Ringtail Derby. A stake leaves the bank when it's played (the
// deal, a double or a split, the come-out, the odds, the pull, the ticket) and its winnings come back when the
// game settles.
//
// Stations (world gen: shared/world.js town.casino.stations): one player each, the one who sat down there;
// whoever walks off (or drops) gives it up, and a game left half-played is finished for them the way the
// house would (a hand stands, a line bet rides the table's game). The Derby is everybody's: a ticket each, one
// race.
import { BJTable } from './blackjack.js';
import { CrapsTable, ODDS } from './craps.js';
import { FAST, CASINO } from '../shared/constants.js';
export { ODDS };

export const FLIP_ODDS = 0.485;              // Double or Nothing: the house always wins (eventually)
export const DERBY = { LANES: 4, PAYS: 3.8, OPEN_T: FAST ? 2 : 12, RACE_T: CASINO.RACE_T, SHOW_T: FAST ? 1 : 4 };
const RESULT_T = FAST ? 1 : 4;               // a settled game's result stays up this long
const ROLL_T = FAST ? 0.4 : 1.6;             // the coin spins before it says
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

export class Casino {
  // spots: [{ id, kind, x, z }] (the derby: one, everybody's)
  constructor(spots = [], rng = Math.random) {
    this.rng = rng;
    this.st = new Map();
    for (const s of spots) {
      const base = { id: s.id, kind: s.kind, x: s.x, z: s.z, owner: null, bet: 0, stake: 0, state: 'bet', until: 0, out: null, won: 0 };
      if (s.kind === 'flip') Object.assign(base, { pend: null, last: null });
      if (s.kind === 'derby') Object.assign(base, { state: 'open', tickets: [], bets: new Map(), order: null, seed: 0, race: 0 });
      this.st.set(s.id, base);
    }
    // the blackjack table: its seats in the order the dealer deals them; the craps table: its rails in the order
    // the dice go round
    this.bj = new BJTable([...this.st.values()].filter(s => s.kind === 'bj').map(s => s.id).sort(), rng);
    this.cr = new CrapsTable(this.crapsRails().map(s => s.id).sort(), rng);
  }
  bjSeats() { return [...this.st.values()].filter(s => s.kind === 'bj'); }
  crapsRails() { return [...this.st.values()].filter(s => s.kind === 'craps'); }
  // the rails with somebody at them (but not `but`)
  crLive(but = null) { return this.crapsRails().filter(s => s.owner != null && s.id !== but).map(s => s.id); }

  // ---- taking a seat --------------------------------------------------------------------------------
  // p sat down at a station (its use point): it's theirs if it's free. One game at a time: a seat they had is
  // given up, its game played out the house's way -> { ok, results } or { err }
  sit(p, id, t = 0) {
    const s = this.st.get(id);
    if (!s || s.kind === 'derby') return { ok: !!s, results: [] };
    if (s.owner != null && s.owner !== p.id) return { err: 'Somebody\'s playing that one. There are others.' };
    const results = [];
    for (const o of this.st.values()) if (o !== s && o.owner === p.id) { results.push(...this.finish(o, t, p)); o.owner = null; o.bet = 0; }
    s.owner = p.id; s.pl = p;
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
      if (s.kind === 'bj' ? this.bj.hands.has(s.id) : s.kind === 'craps' ? this.cr.stakes.has(s.id) && this.cr.state !== 'result' : s.state === 'play' || s.pend) return { err: 'Not in the middle of a game.' };
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

  // Blackjack, at the table: DEAL with a bet down says you're in (the first starts the count); in your turn
  // DEAL hits, then stand, double or split
  bjAct(s, p, a, n, t, bank) {
    const T = this.bj, mine = T.state === 'turn' && T.current()?.id === s.id;
    if (a === 'go' && !mine) {
      if (T.state !== 'bet' && T.state !== 'count') return { err: T.state === 'result' ? 'The next hand\'s coming.' : 'A hand\'s being played: you\'re in the next one.' };
      const no = this.stakeOf(s.bet, bank);
      if (no) return no;
      const first = T.state === 'bet';
      T.callDeal(s.id, this.bjSeats().filter(x => x.owner != null && x.bet > 0).map(x => x.id), t);
      return first ? { msg: `${p.name} is in at Blackjack. Bets down: dealing in ${Math.ceil(T.until - t)} s.` } : {};
    }
    const move = a === 'go' ? 'hit' : a;
    if (!mine || !['hit', 'stand', 'double', 'split'].includes(move)) return {};
    if ((move === 'double' || move === 'split') && T.options()[move]) {
      const more = T.current().h.stake;
      if (more > bank) return { err: `That takes another ${more.toLocaleString('en-US')}: the bank has ${Math.max(0, Math.floor(bank)).toLocaleString('en-US')}.` };
    }
    const r = T.act(s.id, move, t);
    return r.ok ? { spend: r.spend || 0 } : {};
  }
  // the table on its own clock: the count runs out (the stakes go down), the cards come, the dealer plays,
  // the round settles -> [{ spend } | settled result]
  bjTick(t, bank) {
    const T = this.bj, out = [];
    if (T.state === 'count' && t >= T.until) {
      const stakes = new Map();
      let left = bank;
      for (const s of this.bjSeats()) {
        if (s.owner == null || !(s.bet > 0)) continue;
        // (the seats' stakes go down in seat order: one the bank can't cover now sits this hand out)
        if (s.bet > left) { out.push({ msg: `${s.pl?.name || 'Somebody'}: the bank can't cover ${s.bet.toLocaleString('en-US')} on top of the others' bets. Sitting this hand out.` }); continue; }
        stakes.set(s.id, s.bet); left -= s.bet; s.dealt = s.pl;
      }
      if (T.begin(stakes, t)) out.push({ spend: bank - left, game: GAMES.bj });
      return out;
    }
    const r = T.step(t);
    if (r) for (const x of r) {
      const s = this.st.get(x.id);
      s.out = x.out; s.won = x.won;
      out.push({ back: x.back, won: x.won, game: GAMES.bj, p: s.dealt || null, id: x.id });
    }
    return out;
  }

  // Craps, at the table (server/craps.js): ROLL ME IN with a bet on the line says you're in the come-out (the
  // first starts the count); the shooter's ROLL throws the dice; with a point up, ODDS lays your bet again behind
  // the line (up to ODDS.MAX times it: true odds, so the harder point pays more, and the house has no edge on
  // them). The line pays even money (the house's edge is 1.4%). (Paying the line itself by the point would hand
  // the players the edge: the come-out's 7s and 11s already favour them)
  crapsAct(s, p, a, n, t, bank) {
    const T = this.cr, inIt = T.stakes.has(s.id) && T.state !== 'result', shooter = this.st.get(T.shooter)?.pl?.name || 'The house';
    if (a === 'odds') {
      if (!inIt) return { err: 'You\'re not in this game: you\'re in the next come-out.' };
      if (!T.point || T.state !== 'shoot') return { err: 'Odds go behind the line once there\'s a point, between throws.' };
      const line = T.stakes.get(s.id), add = Math.min(s.bet || line, line * ODDS.MAX - (T.odds.get(s.id) || 0));
      if (add <= 0) return { err: `The odds are full: up to ${ODDS.MAX}x the line.` };
      const no = this.stakeOf(add, bank);
      if (no) return no;
      return { spend: T.layOdds(s.id, add) };
    }
    if (a !== 'go') return {};
    if (T.state === 'shoot' && T.shooter === s.id) { T.roll(s.id, t); return { roll: s.id }; }
    if (T.state === 'bet' || T.state === 'count') {
      if (T.ready.has(s.id)) return {};
      const no = this.stakeOf(s.bet, bank);
      if (no) return no;
      const first = T.state === 'bet';
      T.callIn(s.id, this.crapsRails().filter(x => x.owner != null && x.bet > 0).map(x => x.id), t);
      return first ? { msg: `${p.name} is in at Craps. Bets on the line: the dice go in ${Math.ceil(T.until - t)} s.` } : {};
    }
    if (T.state === 'shoot') return { err: inIt ? `${shooter} has the dice.` : 'A game\'s on: you\'re in the next come-out.' };
    return { err: T.state === 'result' ? 'The next come-out\'s coming.' : 'The dice are rolling.' };
  }
  // the table on its own clock: the count runs out (the line bets go down), the shooter's time runs out (the
  // house throws), the dice land, the game settles -> [{ spend } | { roll } | settled result]
  crTick(t, bank) {
    const T = this.cr, out = [], live = this.crLive();
    if (T.state === 'count' && t >= T.until) {
      const stakes = new Map();
      let left = bank;
      for (const s of this.crapsRails()) {
        if (s.owner == null || !(s.bet > 0)) continue;
        if (s.bet > left) { out.push({ msg: `${s.pl?.name || 'Somebody'}: the bank can't cover ${s.bet.toLocaleString('en-US')} on top of the others' bets. Sitting this game out.` }); continue; }
        stakes.set(s.id, s.bet); left -= s.bet; s.dealt = s.pl;
      }
      if (T.begin(stakes, live, t)) out.push({ spend: bank - left, game: GAMES.craps });
      return out;
    }
    const shot = T.state === 'shoot' && t >= T.until;
    const r = T.step(t, live);
    if (shot && T.state === 'roll') out.push({ roll: T.shooter ?? T.order[0], house: true });
    if (r) for (const x of r) {
      const s = this.st.get(x.id);
      out.push({ back: x.back, won: x.won, game: GAMES.craps, p: s.dealt || null, id: x.id });
    }
    return out;
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
  tick(t, bank = Infinity) {
    const out = this.bjTick(t, bank);
    const left = bank - out.reduce((a, x) => a + (x.spend || 0), 0);
    out.push(...this.crTick(t, left));
    for (const s of this.st.values()) {
      if (s.kind === 'bj' || s.kind === 'craps') continue;
      if (s.pend && t >= s.pend.at) out.push(...this.flipLand(s, t));
      if (s.kind === 'derby') {
        if (s.state === 'open' && s.until && t >= s.until) this.derbyRun(s, t);
        else if (s.state === 'race' && t >= s.until) out.push(...this.derbyPay(s, t));
        else if (s.state === 'result' && t >= s.until) { s.state = 'open'; s.until = 0; s.order = null; }
        continue;
      }
      if (s.state === 'result' && t >= s.until) { s.state = 'bet'; s.hand = null; s.out = null; }
    }
    return out;
  }
  // a station's game played out the house's way: a hand stands, a line bet rides the table's game (the dice
  // go round to the next shooter), a coin lands
  finish(s, t, p) {
    const out = [];
    if (s.kind === 'bj') this.bj.vacated(s.id, t);   // (its hand stands when its turn comes: the round plays on)
    if (s.kind === 'craps') this.cr.vacated(s.id, this.crLive(s.id), t);
    if (s.kind === 'flip' && s.pend) out.push(...this.flipLand(s, t));
    return out;
  }
  // last call (the day's over): every game on the floor played out, the Derby run now if it has tickets
  closeAll(t) {
    const out = [];
    for (const x of this.bj.close(t)) {
      const s = this.st.get(x.id);
      s.out = x.out; s.won = x.won;
      out.push({ back: x.back, won: x.won, game: GAMES.bj, p: s.dealt || null, id: x.id });
    }
    for (const x of this.cr.close(t, this.crLive())) out.push({ back: x.back, won: x.won, game: GAMES.craps, p: this.st.get(x.id).dealt || null, id: x.id });
    for (const s of this.st.values()) {
      if (s.kind === 'bj' || s.kind === 'craps') continue;
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
    let n = this.cr.inPlay();
    for (const s of this.st.values()) {
      if (s.kind === 'derby') n += s.tickets.reduce((a, k) => a + k.stake, 0);
      else if (s.kind === 'bj') { if (this.bj.state !== 'result') n += this.bj.hands.get(s.id)?.stake || 0; }
      else if (s.kind === 'flip' && s.pend) n += s.stake;
    }
    return n;
  }

  // ---- what the pages see (the client fills in what's left out: 0 or nothing) -----------------------------
  view(t) {
    const out = {};
    for (const s of this.st.values()) {
      const v = { k: s.kind, o: s.owner, st: s.state, bet: s.bet, stake: s.stake, out: s.out, won: s.won };
      if (s.kind === 'bj') {
        const h = this.bj.seatView(s.id);
        v.st = h ? this.bj.state : 'bet';
        if (h) Object.assign(v, { hands: h.hands, tots: h.tots, outs: h.outs, stake: h.stake });
        if (v.st !== 'result') { v.out = null; v.won = 0; }
      }
      if (s.kind === 'craps') { const r = this.cr.railView(s.id); Object.assign(v, { st: r.stake ? this.cr.state : 'bet', stake: r.stake, odds: r.odds, out: r.out, won: r.won }); }
      if (s.kind === 'flip') Object.assign(v, { spin: s.pend ? 1 : 0 });
      if (s.kind === 'derby') {
        Object.assign(v, { left: s.until ? Math.max(0, Math.ceil(s.until - t)) : null, order: s.order, seed: s.seed, race: s.race, rt: DERBY.RACE_T,
          el: s.state === 'race' ? Math.round((DERBY.RACE_T - (s.until - t)) * 10) / 10 : null,
          tix: s.tickets.map(k => [k.pid, k.lane, k.stake]), bets: Object.fromEntries(s.bets) });
      }
      // (only what's set: an idle station is a few bytes in every snapshot)
      for (const k of Object.keys(v)) if (v[k] == null || v[k] === 0 || v[k] === false) delete v[k];
      out[s.id] = v;
    }
    out.bjt = this.bj.view(t);   // the table itself: the dealer's cards, whose turn
    out.crt = this.cr.view(t);   // the craps table: the shooter, the point, the dice
    return out;
  }
}
