// One communal hand of blackjack: the squad vs THE PIT BOSS.
// Pure game logic — the Room drives votes and timing.

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function handTotal(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === 'A') { total += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(r)) total += 10;
    else total += Number(r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export class Blackjack {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.deck = [];
    for (const s of SUITS) for (const r of RANKS) this.deck.push(r + s);
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
    this.squad = [this.draw(), this.draw()];
    this.dealer = [this.draw(), this.draw()];
    this.state = 'voting'; // voting | done
    this.outcome = null;   // win | lose | push | natural
    if (handTotal(this.squad) === 21) {
      this.outcome = handTotal(this.dealer) === 21 ? 'push' : 'natural';
      this.state = 'done';
    }
  }

  draw() { return this.deck.pop(); }

  squadTotal() { return handTotal(this.squad); }
  dealerTotal() { return handTotal(this.dealer); }

  // Apply the squad's majority decision. Returns true when the hand is over.
  act(choice) {
    if (this.state !== 'voting') return true;
    if (choice === 'hit') {
      this.squad.push(this.draw());
      if (this.squadTotal() > 21) {
        this.outcome = 'lose';
        this.state = 'done';
        return true;
      }
      if (this.squadTotal() === 21) return this.act('stand'); // no choice left
      return false;
    }
    // stand: the boss plays out
    while (this.dealerTotal() < 17) this.dealer.push(this.draw());
    const d = this.dealerTotal(), s = this.squadTotal();
    this.outcome = d > 21 || s > d ? 'win' : s === d ? 'push' : 'lose';
    this.state = 'done';
    return true;
  }

  publicState() {
    return {
      squad: this.squad,
      squadTotal: this.squadTotal(),
      dealerUp: this.dealer[0],
      dealer: this.state === 'done' ? this.dealer : null,
      dealerTotal: this.state === 'done' ? this.dealerTotal() : null,
      state: this.state,
      outcome: this.outcome,
    };
  }
}
