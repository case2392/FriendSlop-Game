import * as C from '../shared/constants.js';
import { MINIGAMES } from './minigames/index.js';
import { driveBot, botBet, botName } from './bots.js';

let nextPlayerId = 1;

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.phase = 'lobby'; // lobby | betting | play | results | podium
    this.round = 0;
    this.jackpot = 0;
    this.game = null;
    this.gameClass = null;
    this.queue = [];
    this.phaseEnds = 0;
    this.countdown = 0;
    this.hostId = null;
    this.lastResults = null;
    this.closed = false;
  }

  // ---- membership ----------------------------------------------------------

  addPlayer(conn, name, isBot = false) {
    if (this.players.size >= C.MAX_PLAYERS) return { error: 'Room is full (8 blobs max).' };
    if (this.phase !== 'lobby') return { error: 'Game already in progress. Wait for the lobby.' };
    const used = [...this.players.values()].map(p => p.color);
    const color = C.SLOP_COLORS.find(c => !used.includes(c)) || C.SLOP_COLORS[0];
    const p = {
      id: nextPlayerId++,
      name: String(name || 'Blob').slice(0, 18),
      color,
      isBot,
      conn,
      connected: true,
      coins: C.START_COINS,
      bet: null,
      input: { up: false, down: false, left: false, right: false, dash: false },
      x: 0, y: 0, vx: 0, vy: 0, face: 0,
      dashCd: 0, dashTime: 0, speedMult: 1,
      alive: true, freeze: false, score: 0,
      events: [],
    };
    this.players.set(p.id, p);
    if (!this.hostId || !this.players.get(this.hostId)) this.hostId = isBot ? this.hostId : p.id;
    if (!isBot && !this.humans().some(h => h.id === this.hostId)) this.hostId = p.id;
    this.sendMeta();
    return { player: p };
  }

  addBot() {
    const taken = [...this.players.values()].map(p => p.name);
    return this.addPlayer(null, botName(taken), true);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
    } else {
      p.connected = false;
      p.alive = false; // zombie until game over; bets on them can still resolve
    }
    if (this.hostId === id) {
      const nextHost = this.humans().find(h => h.connected);
      this.hostId = nextHost ? nextHost.id : null;
    }
    if (this.humans().filter(h => h.connected).length === 0) this.closed = true;
    else this.sendMeta();
  }

  humans() { return [...this.players.values()].filter(p => !p.isBot); }
  list() { return [...this.players.values()]; }

  // ---- messaging -----------------------------------------------------------

  send(p, msg) {
    if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(s);
    }
  }

  sendMeta() {
    this.broadcast({
      t: 'meta',
      code: this.code,
      phase: this.phase,
      round: this.round,
      rounds: C.ROUNDS_PER_GAME,
      hostId: this.hostId,
      jackpot: this.jackpot,
      phaseEnds: this.phaseEnds,
      minigame: this.gameClass ? this.gameClass.id : null,
      players: this.list().map(p => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot,
        connected: p.connected, coins: p.coins,
        bet: p.bet ? { target: p.bet.target, amount: p.bet.amount } : null,
      })),
      lastResults: this.lastResults,
    });
  }

  // ---- player intents ------------------------------------------------------

  handleInput(p, keys) {
    if (!keys || typeof keys !== 'object') return;
    for (const k of ['up', 'down', 'left', 'right']) p.input[k] = !!keys[k];
    if (keys.dash) p.input.dash = true; // edge-triggered, consumed by physics
  }

  handleBet(p, target, amount) {
    if (this.phase !== 'betting') return;
    const t = this.players.get(Number(target));
    if (!t) return;
    const amt = Math.max(0, Math.min(p.coins, Math.floor(Number(amount) || 0)));
    p.bet = amt > 0 ? { target: t.id, amount: amt } : null;
    this.sendMeta(); // bets are public — that's the fun
  }

  handleStart(p) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return;
    if (this.players.size < 2) {
      this.send(p, { t: 'error', msg: 'You need at least 2 blobs (add a bot?).' });
      return;
    }
    this.startGame();
  }

  handleEmote(p, e) {
    if (!C.EMOTES.includes(e)) return;
    this.broadcast({ t: 'emote', id: p.id, e });
  }

  handleChat(p, msg) {
    const clean = String(msg || '').slice(0, 120).trim();
    if (!clean) return;
    this.broadcast({ t: 'chat', id: p.id, name: p.name, msg: clean });
  }

  // ---- game flow -----------------------------------------------------------

  startGame() {
    this.round = 0;
    this.jackpot = 0;
    this.lastResults = null;
    for (const p of this.players.values()) { p.coins = C.START_COINS; p.bet = null; }
    // Build the round queue: shuffle, repeat if more rounds than games.
    this.queue = [];
    while (this.queue.length < C.ROUNDS_PER_GAME) this.queue.push(...shuffled(MINIGAMES));
    this.beginBetting();
  }

  beginBetting() {
    this.round++;
    this.phase = 'betting';
    this.game = null;
    this.gameClass = this.queue.shift();
    this.phaseEnds = Date.now() + C.BET_TIME * 1000;
    for (const p of this.players.values()) {
      p.bet = null;
      if (p.connected && p.coins < C.PITY_COINS) p.coins = C.PITY_COINS; // pity slop
      if (p.isBot) p.botBetAt = Date.now() + 500 + Math.random() * 1500;
    }
    this.sendMeta();
  }

  beginPlay() {
    this.phase = 'play';
    // Collect the pot before the chaos starts.
    let pot = this.jackpot;
    for (const p of this.players.values()) {
      if (p.bet) { p.coins -= p.bet.amount; pot += p.bet.amount; }
    }
    this.pot = pot;
    const participants = this.list().filter(p => p.connected);
    this.participants = participants.map(p => p.id);
    this.game = new this.gameClass(participants);
    this.countdown = C.COUNTDOWN_TIME;
    for (const p of participants) p.freeze = true;
    this.phaseEnds = 0;
    this.sendMeta();
  }

  endPlay(rankings) {
    // Ensure every participant appears (disconnects can vanish from rankings).
    for (const id of this.participants) if (!rankings.includes(id)) rankings.push(id);

    const winnerId = rankings[0];
    const payouts = {};
    const add = (id, amt, why) => {
      const p = this.players.get(id);
      if (!p || amt <= 0) return;
      p.coins += amt;
      if (!payouts[id]) payouts[id] = [];
      payouts[id].push({ amt, why });
    };

    rankings.slice(0, C.PLACEMENT_PRIZES.length).forEach((id, i) => {
      add(id, C.PLACEMENT_PRIZES[i], ['1st place', '2nd place', '3rd place'][i]);
    });

    // Split the pot among everyone who bet on the winner, proportional to stake.
    const winners = this.list().filter(p => p.bet && p.bet.target === winnerId);
    const staked = winners.reduce((s, p) => s + p.bet.amount, 0);
    let potWon = false;
    if (staked > 0 && this.pot > 0) {
      potWon = true;
      for (const p of winners) add(p.id, Math.floor(this.pot * (p.bet.amount / staked)), 'won the pot');
      this.jackpot = 0;
    } else {
      this.jackpot = this.pot; // nobody called it — the jackpot grows
    }

    this.lastResults = {
      minigame: this.gameClass.id,
      rankings,
      winnerId,
      payouts,
      potWon,
      pot: this.pot,
      jackpot: this.jackpot,
      bets: this.list().filter(p => p.bet).map(p => ({ id: p.id, target: p.bet.target, amount: p.bet.amount })),
    };
    this.phase = 'results';
    this.phaseEnds = Date.now() + C.RESULTS_TIME * 1000;
    this.game = null;
    this.sendMeta();
  }

  beginPodium() {
    this.phase = 'podium';
    this.phaseEnds = Date.now() + C.PODIUM_TIME * 1000;
    this.standings = this.list()
      .slice()
      .sort((a, b) => b.coins - a.coins)
      .map(p => ({ id: p.id, name: p.name, color: p.color, coins: p.coins }));
    this.broadcast({ t: 'podium', standings: this.standings });
    this.sendMeta();
  }

  backToLobby() {
    this.phase = 'lobby';
    this.round = 0;
    this.game = null;
    this.gameClass = null;
    this.lastResults = null;
    // Drop zombie disconnects now that the match is over.
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    for (const p of this.players.values()) { p.alive = true; p.freeze = false; p.bet = null; }
    this.sendMeta();
  }

  // ---- simulation ----------------------------------------------------------

  tick(dt) {
    const now = Date.now();

    if (this.phase === 'betting') {
      for (const p of this.players.values()) {
        if (p.isBot && !p.bet && now >= p.botBetAt) {
          p.bet = botBet(p, this.list());
          this.sendMeta();
        }
      }
      if (now >= this.phaseEnds) this.beginPlay();
    } else if (this.phase === 'play' && this.game) {
      if (this.countdown > 0) {
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.countdown = 0;
          for (const p of this.players.values()) p.freeze = false;
        }
        return; // world is frozen during the countdown
      }
      const participants = this.list().filter(p => this.participants.includes(p.id));
      for (const p of participants) {
        if (p.isBot && p.alive) driveBot(p, this.game, participants, dt);
        if (!p.connected) { p.input = { up: false, down: false, left: false, right: false, dash: false }; }
      }
      const rankings = this.game.tick(dt);
      if (rankings) this.endPlay(rankings);
    } else if (this.phase === 'results') {
      if (now >= this.phaseEnds) {
        if (this.round >= C.ROUNDS_PER_GAME) this.beginPodium();
        else this.beginBetting();
      }
    } else if (this.phase === 'podium') {
      if (now >= this.phaseEnds) this.backToLobby();
    }
  }

  snapshot() {
    if (this.phase !== 'play' || !this.game) return null;
    const players = this.list()
      .filter(p => this.participants.includes(p.id))
      .map(p => {
        const ev = p.events;
        p.events = [];
        return [
          p.id,
          Math.round(p.x * 10) / 10,
          Math.round(p.y * 10) / 10,
          p.alive ? 1 : 0,
          p.score || 0,
          Math.round(p.dashCd * 100) / 100,
          p.dashTime > 0 ? 1 : 0,
          ev,
        ];
      });
    return {
      t: 'state',
      countdown: Math.ceil(this.countdown),
      players,
      extra: this.game.extras(),
    };
  }
}
