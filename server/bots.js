import * as C from '../shared/constants.js';

const BOT_NAMES = [
  'Gravy Boat', 'Moist Goblin', 'Crusty Dave', 'Lord Slop', 'Beans',
  'Wet Bandit', 'Soggy Kyle', 'Grease Wizard', 'Chunk', 'Damp Steve',
];

export function botName(taken) {
  const free = BOT_NAMES.filter(n => !taken.includes(n));
  const pool = free.length ? free : BOT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)] + ' 🤖';
}

function steerToward(bot, tx, ty) {
  const dx = tx - bot.x, dy = ty - bot.y;
  const d = Math.hypot(dx, dy);
  if (d < 16) { bot.input.mx = 0; bot.input.my = 0; return; }
  bot.input.mx = dx / d;
  bot.input.my = dy / d;
}

// Called every tick for each alive bot while a chamber is running.
export function driveBot(bot, game, players, dt) {
  bot.aiT = (bot.aiT || 0) - dt;
  if (bot.aiT > 0) return;         // re-plan ~8x/sec so bots feel organic
  bot.aiT = 0.12 + Math.random() * 0.08;
  bot.input.dash = false;

  const id = game.constructor.id;

  if (id === 'gates') {
    // Claim the least-crowded plate; shove gremlins that get close.
    const ex = game.extras();
    const plates = ex.plates; // [x, y, r, covered]
    let target = null, bestScore = Infinity;
    for (const [px, py] of plates) {
      const crowd = players.filter(p => p.alive && p.id !== bot.id && Math.hypot(p.x - px, p.y - py) < 130).length;
      const d = Math.hypot(px - bot.x, py - bot.y);
      const s = crowd * 900 + d;
      if (s < bestScore) { bestScore = s; target = [px, py]; }
    }
    const grem = game.gremlins?.find(g => g.alive && Math.hypot(g.x - bot.x, g.y - bot.y) < 140);
    if (grem && bot.dashCd === 0) {
      steerToward(bot, grem.x, grem.y);
      bot.input.dash = true;
    } else if (target) {
      steerToward(bot, target[0] + (Math.random() - 0.5) * 40, target[1] + (Math.random() - 0.5) * 40);
    }
  } else if (id === 'gut') {
    if (game.islands.length) {
      // Nearest island, with a dash of panic when the wave is imminent.
      let best = null, bd = Infinity;
      for (const i of game.islands) {
        const d = Math.hypot(i.x - bot.x, i.y - bot.y);
        if (d < bd) { bd = d; best = i; }
      }
      if (best) {
        steerToward(bot, best.x, best.y);
        if (game.state === 'warn' && game.stateT < 1 && bd > best.r && bot.dashCd === 0) bot.input.dash = true;
      }
    } else {
      steerToward(bot, C.ARENA_W / 2 + (Math.random() - 0.5) * 300, C.ARENA_H / 2 + (Math.random() - 0.5) * 200);
    }
  } else if (id === 'tater') {
    if (bot.id === game.taterId) {
      // I am the problem: sprint to the drain.
      steerToward(bot, game.hole.x, game.hole.y);
      if (bot.dashCd === 0 && Math.hypot(game.hole.x - bot.x, game.hole.y - bot.y) > 300) bot.input.dash = true;
    } else if (game.taterId !== null) {
      // Shadow the holder loosely — the chain needs slack toward the drain.
      const holder = players.find(p => p.id === game.taterId);
      if (holder) {
        const mx = (holder.x + game.hole.x) / 2, my = (holder.y + game.hole.y) / 2;
        steerToward(bot, mx + (Math.random() - 0.5) * 120, my + (Math.random() - 0.5) * 120);
      }
    } else {
      steerToward(bot, game.hole.x + (Math.random() - 0.5) * 300, game.hole.y + (Math.random() - 0.5) * 300);
    }
  } else if (id === 'walk') {
    // March right, preferring intact tiles; hop holes with a dash when stuck.
    const probe = game.tileAt(bot.x + 70, bot.y);
    let ty = bot.y;
    if (probe !== -1 && game.tiles[probe] === 2) {
      // Hole ahead — look for a safer lane above or below.
      const up = game.tileAt(bot.x + 70, bot.y - 85);
      const down = game.tileAt(bot.x + 70, bot.y + 85);
      if (up !== -1 && game.tiles[up] !== 2) ty = bot.y - 90;
      else if (down !== -1 && game.tiles[down] !== 2) ty = bot.y + 90;
      else if (bot.dashCd === 0) bot.input.dash = true; // send it
    }
    steerToward(bot, bot.x + 200, ty);
  }
}

// Blackjack instincts. Mostly sensible, occasionally degenerate — like the boys.
export function botVote(squadTotal) {
  if (Math.random() < 0.12) return Math.random() < 0.5 ? 'hit' : 'stand'; // chaos agent
  return squadTotal <= 15 ? 'hit' : 'stand';
}

// Hub life: mill around, then walk where the squad needs to be.
export function driveHubBot(bot, room, dt) {
  bot.aiT = (bot.aiT || 0) - dt;
  if (bot.aiT > 0) return;
  bot.aiT = 0.15 + Math.random() * 0.1;
  bot.input.dash = false;

  const mode = room.hubMode;
  if (mode === 'lobby' || mode === 'gate') {
    bot.hubDelay ??= 1.5 + Math.random() * 3.5;
    bot.hubDelay -= 0.2;
    if (bot.hubDelay > 0) {
      wander(bot);
      return;
    }
    steerToward(bot, C.HUB.GATE.x + (Math.random() - 0.5) * (C.HUB.GATE.w - 120),
      C.HUB.GATE.y + (Math.random() - 0.5) * (C.HUB.GATE.h - 100));
  } else if (mode === 'blackjack' && room.bj) {
    if (room.bj.state === 'voting') {
      if (bot.bjChoice === undefined) {
        bot.bjChoice = null;
        bot.bjDecideIn = 0.8 + Math.random() * 2.2;
      }
      if (bot.bjChoice === null) {
        bot.bjDecideIn -= 0.2;
        if (bot.bjDecideIn <= 0) bot.bjChoice = botVote(room.bj.squadTotal());
        wander(bot);
        return;
      }
      const zone = bot.bjChoice === 'hit' ? C.HUB.HIT : C.HUB.STAND;
      steerToward(bot, zone.x + (Math.random() - 0.5) * zone.r, zone.y + (Math.random() - 0.5) * zone.r);
    } else {
      wander(bot);
    }
  } else {
    wander(bot);
    if (Math.random() < 0.05) bot.input.dash = true; // celebration zoomies
  }
}

function wander(bot) {
  if (!bot.wanderTo || Math.hypot(bot.wanderTo.x - bot.x, bot.wanderTo.y - bot.y) < 60 || Math.random() < 0.02) {
    bot.wanderTo = { x: 300 + Math.random() * 1000, y: 300 + Math.random() * 350 };
  }
  steerToward(bot, bot.wanderTo.x, bot.wanderTo.y);
}
