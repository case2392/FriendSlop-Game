// The Lucky Slop. Every game bets the SHARED bank, and anybody can bet it.
import { Blackjack } from './blackjack.js';
import { FAST } from '../shared/constants.js';

const VOTE_TIME = FAST ? 1.5 : 10;
const RESULT_TIME = FAST ? 1 : 4;
const FLIP_TIME = FAST ? 0.5 : 2.2;
export const FLIP_ODDS = 0.485;           // the house always wins (eventually)

const step = (cur, arg, bank) => {
  if (arg === '+100') return Math.min(bank, cur + 100);
  if (arg === '+500') return Math.min(bank, cur + 500);
  if (arg === 'all') return Math.max(0, bank);
  if (arg === 'clear') return 0;
  return cur;
};

// Blackjack: the squad plays ONE hand against the dealer. Anyone can set the
// bet; then you vote with your body — stand on the HIT pad or the STAND pad.
export class BJTable {
  constructor(spot, rng = Math.random) {
    this.spot = spot;           // {hit:{x,z,r}, stand:{x,z,r}}
    this.rng = rng;
    this.state = 'bet';         // bet | vote | result
    this.bet = 0;
    this.stake = 0;
    this.hand = null;
    this.until = 0;
    this.outcome = null;
    this.votes = { hit: [], stand: [] };
  }

  adjust(arg, bank) {
    if (this.state !== 'bet') return false;
    this.bet = step(this.bet, arg, bank);
    return true;
  }

  // returns {delta, msg} for the room to apply
  deal(t, bank) {
    if (this.state !== 'bet') return null;
    if (this.bet <= 0) return { err: 'Set a bet first. (+$100 / +$500 / ALL IN)' };
    if (this.bet > bank) return { err: 'The bank can\'t cover that bet.' };
    this.stake = this.bet;
    this.hand = new Blackjack(this.rng);
    this.outcome = null;
    if (this.hand.state === 'done') return this.settle(t, -this.stake);
    this.state = 'vote';
    this.until = t + VOTE_TIME;
    return { delta: -this.stake, msg: `Dealt — ${this.stake.toLocaleString()} on the line. HIT pad or STAND pad!` };
  }

  settle(t, already = 0) {
    const o = this.hand.outcome;
    const back = o === 'natural' ? Math.floor(this.stake * 2.5) : o === 'win' ? this.stake * 2 : o === 'push' ? this.stake : 0;
    this.outcome = o;
    this.state = 'result';
    this.until = t + RESULT_TIME;
    return { delta: already + back, outcome: o, stake: this.stake, won: back - this.stake };
  }

  // players: [{id, pos}] — who's standing where
  tick(t, players, inCasino) {
    if (this.state === 'result' && t >= this.until) {
      this.state = 'bet';
      this.hand = null;
      if (this.bet === 0) this.bet = 0;
      return null;
    }
    if (this.state !== 'vote') return null;
    const on = (p, z) => Math.hypot(p.pos.x - z.x, p.pos.z - z.z) < z.r;
    this.votes.hit = players.filter(p => p.pos && on(p, this.spot.hit)).map(p => p.id);
    this.votes.stand = players.filter(p => p.pos && on(p, this.spot.stand)).map(p => p.id);
    const voters = this.votes.hit.length + this.votes.stand.length;
    const everyone = inCasino.length > 0 && voters >= inCasino.length;
    if (t < this.until && !(everyone && t > this.until - VOTE_TIME + 1.2)) return null;
    // nobody voted = stand. ties hit, because of course they do.
    const choice = voters === 0 ? 'stand' : this.votes.hit.length >= this.votes.stand.length ? 'hit' : 'stand';
    const done = this.hand.act(choice);
    if (done) return this.settle(t);
    this.until = t + VOTE_TIME;
    return { delta: 0, msg: choice === 'hit' ? `HIT → ${this.hand.squadTotal()}` : null };
  }

  view(t) {
    const h = this.hand?.publicState();
    return {
      st: this.state, bet: this.bet, stake: this.stake,
      cards: h?.squad || null, tot: h?.squadTotal ?? null,
      up: h?.dealerUp || null, dl: h?.dealer || null, dt: h?.dealerTotal ?? null,
      out: this.outcome, left: this.state === 'vote' ? Math.max(0, Math.ceil(this.until - t)) : null,
      hit: this.votes.hit, stand: this.votes.stand,
    };
  }
}

// Double or Nothing: put the stake in, pull the lever.
export class FlipMachine {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.stake = 0;
    this.busyUntil = 0;
    this.last = null;
  }
  adjust(arg, bank, t) {
    if (t < this.busyUntil) return false;
    this.stake = step(this.stake, arg, bank);
    return true;
  }
  pull(t, bank) {
    if (t < this.busyUntil) return null;
    if (this.stake <= 0) return { err: 'Put a stake in first.' };
    if (this.stake > bank) return { err: 'The bank can\'t cover that.' };
    const win = this.rng() < FLIP_ODDS;
    this.busyUntil = t + FLIP_TIME;
    const stake = this.stake;
    this.last = { win, stake, at: t };
    this.stake = 0;
    return { delta: win ? stake : -stake, win, stake, revealAt: t + FLIP_TIME * 0.8 };
  }
  view(t) {
    return { stake: this.stake, busy: t < this.busyUntil ? 1 : 0, last: this.last ? { win: this.last.win, stake: this.last.stake, ago: Math.round((t - this.last.at) * 10) / 10 } : null };
  }
}
