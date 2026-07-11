import * as C from '../shared/constants.js';
import { COLS, ROWS, TILE } from './minigames/floor.js';

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
  bot.input.left = dx < -12;
  bot.input.right = dx > 12;
  bot.input.up = dy < -12;
  bot.input.down = dy > 12;
}

function nearestEnemy(bot, players) {
  let best = null, bd = Infinity;
  for (const p of players) {
    if (p.id === bot.id || !p.alive) continue;
    const d = Math.hypot(p.x - bot.x, p.y - bot.y);
    if (d < bd) { bd = d; best = p; }
  }
  return { enemy: best, dist: bd };
}

// Called every tick for each alive bot while a minigame is running.
export function driveBot(bot, game, players, dt) {
  bot.aiT = (bot.aiT || 0) - dt;
  if (bot.aiT > 0) return;         // re-plan ~8x/sec so bots feel organic
  bot.aiT = 0.12 + Math.random() * 0.08;
  bot.input.dash = false;

  const cx = C.ARENA_W / 2, cy = C.ARENA_H / 2;

  if (game.constructor.id === 'sumo') {
    const { enemy, dist } = nearestEnemy(bot, players);
    const myD = Math.hypot(bot.x - cx, bot.y - cy);
    if (enemy && dist < 170 && bot.dashCd === 0 && myD < game.ring * 0.7 && Math.random() < 0.5) {
      steerToward(bot, enemy.x, enemy.y);
      bot.input.dash = true;
    } else {
      steerToward(bot, cx + (Math.random() - 0.5) * 120, cy + (Math.random() - 0.5) * 120);
    }
  } else if (game.constructor.id === 'tater') {
    const holder = players.find(p => p.id === game.taterId);
    if (bot.id === game.taterId) {
      const { enemy } = nearestEnemy(bot, players);
      if (enemy) {
        steerToward(bot, enemy.x, enemy.y);
        if (Math.hypot(enemy.x - bot.x, enemy.y - bot.y) < 220 && bot.dashCd === 0) bot.input.dash = true;
      }
    } else if (holder) {
      // Flee the holder, but curve back toward the middle near walls.
      let fx = bot.x + (bot.x - holder.x), fy = bot.y + (bot.y - holder.y);
      const margin = 130;
      if (bot.x < margin || bot.x > C.ARENA_W - margin || bot.y < margin || bot.y > C.ARENA_H - margin) {
        fx = fx * 0.3 + cx * 0.7; fy = fy * 0.3 + cy * 0.7;
      }
      steerToward(bot, fx, fy);
    }
  } else if (game.constructor.id === 'grab') {
    let best = null, bd = Infinity;
    for (const c of game.coins) {
      const d = Math.hypot(c.x - bot.x, c.y - bot.y) / (c.v >= 10 ? 2.5 : 1);
      if (d < bd) { bd = d; best = c; }
    }
    const { enemy, dist } = nearestEnemy(bot, players);
    if (enemy && enemy.score > 5 && dist < 150 && bot.dashCd === 0 && Math.random() < 0.35) {
      steerToward(bot, enemy.x, enemy.y);
      bot.input.dash = true;
    } else if (best) {
      steerToward(bot, best.x, best.y);
    }
  } else if (game.constructor.id === 'floor') {
    // Head to the nearest intact tile that isn't the one we're standing on.
    const myTile = game.tileAt(bot.x, bot.y);
    let best = null, bd = Infinity;
    for (let i = 0; i < game.tiles.length; i++) {
      if (game.tiles[i] !== 0 || i === myTile) continue;
      const tx = (i % COLS) * TILE + TILE / 2;
      const ty = Math.floor(i / COLS) * TILE + TILE / 2 + (C.ARENA_H - ROWS * TILE) / 2;
      const d = Math.hypot(tx - bot.x, ty - bot.y) + Math.random() * 120;
      if (d < bd) { bd = d; best = { tx, ty }; }
    }
    if (best) steerToward(bot, best.tx, best.ty);
  }
}

// Bots place a bet a moment into the betting phase.
export function botBet(bot, players) {
  const alive = players.filter(p => !p.disconnected);
  if (!alive.length || bot.coins <= 0) return null;
  // Weight by coins (rich friends look like winners), slight self-belief bias.
  const weights = alive.map(p => (p.coins + 20) * (p.id === bot.id ? 1.6 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let target = alive[0];
  for (let i = 0; i < alive.length; i++) { r -= weights[i]; if (r <= 0) { target = alive[i]; break; } }
  const amount = Math.max(1, Math.floor(bot.coins * (0.10 + Math.random() * 0.20)));
  return { target: target.id, amount };
}
