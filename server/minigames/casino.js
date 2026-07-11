import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, spawnInCircle } from '../physics.js';
import { Blackjack } from '../blackjack.js';

// THE BOSS'S CASINO (a Gamble With Friends homage): the Pit Boss deals
// blackjack to the whole squad. Vote with your body — stand in the HIT or
// STAND zone. Win enough hands before you bust out and the gate opens.

const WINS_NEED = C.FAST ? 1 : 2;
const MAX_LOSSES = 3;
const MAX_TIME = C.FAST ? 12 : 130;
const TABLE_R = 130;

export default class Casino {
  static id = 'casino';
  static team = true;

  constructor(players) {
    this.players = players;
    this.t = 0;
    this.teamWin = false;
    this.wins = 0;
    this.losses = 0;
    this.lives = MAX_LOSSES;
    this.handNo = 0;
    this.windowNo = 0;
    this.handsResolved = 0;
    this.handVoters = new Set();
    spawnInCircle(players, C.ARENA_W / 2, 300, 220);
    players.forEach(p => { p.alive = true; p.score = 0; p.stun = 0; });
    this.newHand();
  }

  newHand() {
    this.bj = new Blackjack();
    this.handNo++;
    this.windowNo = 0;
    this.handVoters.clear();
    this.voteT = C.BJ_VOTE_TIME;
    this.voteAge = 0;
    this.showdownT = this.bj.state === 'done' ? C.BJ_RESULT_TIME : 0;
  }

  zones() {
    const crew = this.players.filter(p => p.alive);
    return {
      hitIds: crew.filter(p => Math.hypot(p.x - C.HUB.HIT.x, p.y - C.HUB.HIT.y) < C.HUB.HIT.r).map(p => p.id),
      standIds: crew.filter(p => Math.hypot(p.x - C.HUB.STAND.x, p.y - C.HUB.STAND.y) < C.HUB.STAND.r).map(p => p.id),
    };
  }

  tick(dt) {
    this.t += dt;

    for (const p of this.players) {
      if (!p.alive) continue;
      p.stun = Math.max(0, p.stun - dt);
      p.freeze = p.stun > 0;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
      // the table is solid
      const dx = p.x - C.HUB.TABLE.x, dy = p.y - C.HUB.TABLE.y;
      const d = Math.hypot(dx, dy);
      const minD = TABLE_R + C.PLAYER_RADIUS;
      if (d < minD && d > 0) { p.x = C.HUB.TABLE.x + dx / d * minD; p.y = C.HUB.TABLE.y + dy / d * minD; }
    }
    collidePlayers(this.players);

    if (this.bj.state === 'voting') {
      const { hitIds, standIds } = this.zones();
      for (const id of [...hitIds, ...standIds]) this.handVoters.add(id);
      this.voteT -= dt;
      this.voteAge += dt;
      const crew = this.players.filter(p => p.alive);
      const allIn = crew.length > 0 && hitIds.length + standIds.length === crew.length;
      const minWindow = Math.min(2.5, C.BJ_VOTE_TIME * 0.4);
      if (this.voteT <= 0 || (allIn && this.voteAge >= minWindow)) {
        const choice = hitIds.length > standIds.length ? 'hit'
          : standIds.length > hitIds.length ? 'stand'
          : hitIds.length > 0 ? 'hit' : 'stand';
        const done = this.bj.act(choice);
        this.windowNo++;
        if (done) this.showdownT = C.BJ_RESULT_TIME;
        else { this.voteT = C.BJ_VOTE_TIME; this.voteAge = 0; }
      }
    } else if (this.showdownT > 0) {
      this.showdownT -= dt;
      if (this.showdownT <= 0) {
        const o = this.bj.outcome;
        this.handsResolved++;
        if (o === 'win' || o === 'natural') {
          this.wins++;
          for (const id of this.handVoters) {
            const p = this.players.find(q => q.id === id);
            if (p) { p.score++; p.events.push('catch'); }
          }
        } else if (o === 'lose') {
          this.losses++;
          this.lives = MAX_LOSSES - this.losses;
        }
        if (C.FAST && this.handsResolved >= 1) {
          this.teamWin = true; // test shortcut: any resolved hand ends the chamber
          return this.rankings();
        }
        if (this.wins >= WINS_NEED) {
          this.teamWin = true;
          return this.rankings();
        }
        if (this.losses >= MAX_LOSSES) return this.rankings();
        this.newHand();
      }
    }

    if (this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  rankings() {
    return this.players.slice().sort((a, b) => b.score - a.score).map(p => p.id);
  }

  extras() {
    const { hitIds, standIds } = this.zones();
    return {
      casino: 1,
      bj: {
        ...this.bj.publicState(),
        hitIds, standIds,
        voteLeft: this.bj.state === 'voting' ? Math.max(0, Math.round(this.voteT * 10) / 10) : null,
      },
      wins: this.wins,
      need: WINS_NEED,
      lives: this.lives,
      goal: `hands won ${this.wins}/${WINS_NEED}`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
