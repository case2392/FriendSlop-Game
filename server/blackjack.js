// The blackjack table: the dealer and the seats play one round together, the way a casino deals it.
//   bets go down; the first DEAL starts a short count (the others can still bet; when everyone seated with a
//   bet has said DEAL, it deals at once) -> the dealer deals round the seats in order and one card face up to
//   himself, then a second round and his hole card face down, a card at a time -> with an ace or a ten up he
//   looks for blackjack (a dealer's blackjack ends the round: a player's natural pushes, the rest lose) ->
//   each seat in turn plays its hand: hit, stand, double (one card, the stake doubled) or split a pair (two
//   hands, a stake each; split aces get one card each) -> he turns his card and draws to 17 (he stands on
//   every 17) -> every hand is paid: a natural 3 to 2, a win 1 to 1, a push its stake back.
// Pure game logic, on the caller's clock (t, seconds): server/casino.js seats the players and moves the money.
import { FAST } from '../shared/constants.js';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const BJ = {
  DECKS: 6,
  COUNT_T: FAST ? 1 : 5,        // after the first DEAL, the others' time to bet
  DEAL_T: FAST ? 0.05 : 0.45,   // a card at a time
  TURN_T: FAST ? 3 : 25,        // a seat's time to act, then its hand stands
  DEALER_T: FAST ? 0.05 : 0.7,  // the dealer's cards, one at a time
  RESULT_T: FAST ? 1 : 5,
};

const rankOf = c => c.slice(0, -1);
const tenish = r => r === '10' || r === 'J' || r === 'Q' || r === 'K';
export const cardValue = c => { const r = rankOf(c); return r === 'A' ? 11 : tenish(r) ? 10 : Number(r); };
export function handTotal(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { const v = cardValue(c); total += v; if (v === 11) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
const natural = cards => cards.length === 2 && handTotal(cards) === 21;

export class BJTable {
  // seats: the seat ids in dealing order (left to right as the dealer sees them)
  constructor(seats, rng = Math.random) {
    this.rng = rng;
    this.order = [...seats];
    this.shoe = [];
    this.reset();
  }
  reset() {
    this.state = 'bet';       // bet | count | deal | turn | dealer | result
    this.until = 0;
    this.hands = new Map();   // seat id -> { stake, hands: [{ cards, stake, done, dbl, split, out, back }], cur }
    this.dealer = [];
    this.hole = true;         // his second card face down
    this.queue = [];          // the deal: [seat id | 'D', ...] still to come
    this.turn = -1;           // index into this.playing
    this.playing = [];        // the seats in this round, in order
    this.ready = new Set();   // seats that said DEAL
  }
  draw() {
    if (this.shoe.length < 52) {   // (a fresh shoe, shuffled, when it runs low)
      this.shoe = [];
      for (let d = 0; d < BJ.DECKS; d++) for (const s of SUITS) for (const r of RANKS) this.shoe.push(r + s);
      for (let i = this.shoe.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [this.shoe[i], this.shoe[j]] = [this.shoe[j], this.shoe[i]]; }
    }
    return this.shoe.pop();
  }

  // ---- the round -----------------------------------------------------------------------------------------
  // a seat says DEAL with its bet down: the count starts (or, everyone seated and bet being ready, the deal)
  // seated: the seats with someone in them and a bet down -> true if it took
  callDeal(id, seated, t) {
    if (this.state !== 'bet' && this.state !== 'count') return false;
    this.ready.add(id);
    if (this.state === 'bet') { this.state = 'count'; this.until = t + BJ.COUNT_T; }
    if (seated.every(s => this.ready.has(s))) this.until = t;
    return true;
  }
  // the count's run out: deal to the seats with a stake down (stakes: seat id -> amount, already taken)
  begin(stakes, t) {
    this.playing = this.order.filter(id => stakes.get(id) > 0);
    if (!this.playing.length) { this.reset(); return false; }
    for (const id of this.playing) this.hands.set(id, { stake: stakes.get(id), cur: 0, hands: [{ cards: [], stake: stakes.get(id), done: false, dbl: false, split: false, out: null, back: 0 }] });
    this.queue = [...this.playing, 'D', ...this.playing, 'D'];
    this.state = 'deal'; this.until = t + BJ.DEAL_T; this.ready.clear();
    return true;
  }
  // the hand whose turn it is: { id, h, i } or null
  current() {
    const id = this.playing[this.turn], s = id && this.hands.get(id);
    return s ? { id, s, h: s.hands[s.cur], i: s.cur } : null;
  }
  // what the hand in turn may do now
  options() {
    const c = this.current();
    if (this.state !== 'turn' || !c) return {};
    const two = c.h.cards.length === 2 && !c.h.dbl;
    const pair = two && c.s.hands.length === 1 && cardValue(c.h.cards[0]) === cardValue(c.h.cards[1]);
    return { hit: true, stand: true, double: two, split: pair };
  }
  // the seat in turn acts: hit | stand | double | split -> { ok, spend } (spend: more of the bank on it)
  act(id, a, t) {
    const c = this.current();
    if (this.state !== 'turn' || !c || c.id !== id) return { ok: false };
    const o = this.options();
    if (!o[a]) return { ok: false };
    let spend = 0;
    if (a === 'hit') { c.h.cards.push(this.draw()); if (handTotal(c.h.cards) >= 21) c.h.done = true; }
    else if (a === 'stand') c.h.done = true;
    else if (a === 'double') { spend = c.h.stake; c.h.stake *= 2; c.h.dbl = true; c.h.cards.push(this.draw()); c.h.done = true; }
    else if (a === 'split') {
      spend = c.h.stake;
      const [x, y] = c.h.cards, aces = rankOf(x) === 'A';
      c.s.hands = [{ cards: [x, this.draw()], stake: c.h.stake, done: aces, dbl: false, split: true, out: null, back: 0 },
        { cards: [y, this.draw()], stake: c.h.stake, done: aces, dbl: false, split: true, out: null, back: 0 }];
      for (const h of c.s.hands) if (handTotal(h.cards) === 21) h.done = true;
    }
    c.s.stake += spend;
    this.advance(t);
    return { ok: true, spend };
  }
  // on to the next hand that still has a move (this seat's next split hand, then the next seat), or the dealer
  advance(t) {
    for (;;) {
      const c = this.current();
      if (c && !c.h.done) { this.until = t + BJ.TURN_T; return; }
      if (c && c.s.cur < c.s.hands.length - 1) { c.s.cur++; continue; }
      this.turn++;
      if (this.turn >= this.playing.length) { this.state = 'dealer'; this.hole = false; this.until = t + BJ.DEALER_T; return; }
      this.hands.get(this.playing[this.turn]).cur = 0;
    }
  }
  // the time's come for the next step -> the results when the round settles: [{ id, back, won, out }]
  step(t) {
    if (t < this.until) return null;
    if (this.state === 'deal') {
      const who = this.queue.shift();
      if (who === 'D') this.dealer.push(this.draw());
      else this.hands.get(who).hands[0].cards.push(this.draw());
      if (this.queue.length) { this.until = t + BJ.DEAL_T; return null; }
      // dealt: the dealer looks under an ace or a ten; a natural in a seat is done
      if (natural(this.dealer)) { this.hole = false; return this.settle(t); }
      for (const id of this.playing) { const h = this.hands.get(id).hands[0]; if (natural(h.cards)) h.done = true; }
      this.state = 'turn'; this.turn = 0; this.hands.get(this.playing[0]).cur = 0;
      this.advance(t);
      return null;
    }
    if (this.state === 'turn') {   // (out of time, or nobody in the seat any more: the hand stands)
      const c = this.current();
      if (c) { c.h.done = true; this.advance(t); }
      return null;
    }
    if (this.state === 'dealer') {
      // nothing left to beat (every hand bust): he just turns his card
      const live = [...this.hands.values()].some(s => s.hands.some(h => handTotal(h.cards) <= 21));
      if (live && handTotal(this.dealer) < 17) { this.dealer.push(this.draw()); this.until = t + BJ.DEALER_T; return null; }
      return this.settle(t);
    }
    if (this.state === 'result') { this.reset(); return null; }
    return null;
  }
  // a seat in turn with nobody in it any more stands at once
  vacated(id, t) {
    const c = this.current();
    if (this.state === 'turn' && c?.id === id) this.until = t;
  }
  settle(t) {
    const d = handTotal(this.dealer), dNat = natural(this.dealer), out = [];
    for (const id of this.playing) {
      const s = this.hands.get(id);
      let back = 0;
      for (const h of s.hands) {
        const v = handTotal(h.cards), nat = natural(h.cards) && !h.split;
        h.out = nat && !dNat ? 'natural' : v > 21 ? 'bust' : dNat ? (nat ? 'push' : 'lose') : d > 21 || v > d ? 'win' : v === d ? 'push' : 'lose';
        h.back = h.out === 'natural' ? Math.floor(h.stake * 2.5) : h.out === 'win' ? h.stake * 2 : h.out === 'push' ? h.stake : 0;
        back += h.back;
      }
      out.push({ id, back, won: back - s.stake, out: s.hands.map(h => h.out) });
    }
    this.state = 'result'; this.hole = false; this.until = t + BJ.RESULT_T;
    return out;
  }
  // last call: every hand stands where it is, the dealer plays out, all paid now
  close(t) {
    if (this.state === 'bet' || this.state === 'count') { this.reset(); return []; }
    if (this.state === 'result') return [];   // (settled already)
    while (this.state === 'deal') { this.until = 0; const r = this.step(t); if (r) return r; }
    for (const s of this.hands.values()) for (const h of s.hands) h.done = true;
    if (this.state === 'turn') { this.turn = this.playing.length; this.state = 'dealer'; this.hole = false; }
    for (let i = 0; i < 40 && this.state === 'dealer'; i++) { this.until = 0; const r = this.step(t); if (r) return r; }
    return [];
  }
  // what's on the felt for the pages
  view(t) {
    const c = this.current();
    return {
      st: this.state,
      dl: this.dealer.map((card, i) => (i === 1 && this.hole ? '??' : card)),
      dt: this.hole ? (this.dealer.length ? cardValue(this.dealer[0]) : 0) : handTotal(this.dealer),
      turn: this.state === 'turn' && c ? c.id : null, hand: this.state === 'turn' && c ? c.i : 0,
      left: this.until && (this.state === 'count' || this.state === 'turn') ? Math.max(0, Math.ceil(this.until - t)) : null,
      ready: [...this.ready],
    };
  }
  seatView(id) {
    const s = this.hands.get(id);
    if (!s) return null;
    return { hands: s.hands.map(h => h.cards), tots: s.hands.map(h => handTotal(h.cards)), outs: s.hands.map(h => h.out), stake: s.stake };
  }
}
