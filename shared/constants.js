// Shared between server (Node ESM) and client (browser ESM).

export const ARENA_W = 1600;
export const ARENA_H = 900;

export const PLAYER_RADIUS = 28;
export const ACCEL = 2400;
export const MAX_SPEED = 380;
export const FRICTION = 0.90;          // per-frame damping at 60fps equivalent
export const DASH_SPEED = 980;
export const DASH_CD = 1.6;            // seconds
export const DASH_TIME = 0.18;         // seconds of "heavy" knockback state
export const WALL_BOUNCE = 0.65;

export const TICK_RATE = 30;           // server simulation Hz
export const SNAPSHOT_RATE = 20;       // server -> client state Hz

export const MAX_PLAYERS = 8;
export const START_COINS = 100;
export const PITY_COINS = 10;          // broke players get topped up to this
export const PLACEMENT_PRIZES = [100, 50, 25];
export const ROUNDS_PER_GAME = 5;

// Phase durations (seconds). FRIENDSLOP_FAST=1 shrinks these for tests.
export const FAST = typeof process !== 'undefined' && process.env && process.env.FRIENDSLOP_FAST === '1';
export const BET_TIME = FAST ? 2 : 18;
export const RESULTS_TIME = FAST ? 2 : 9;
export const COUNTDOWN_TIME = FAST ? 1 : 3;
export const PODIUM_TIME = FAST ? 3 : 20;

export const SLOP_COLORS = [
  '#7CFC00', // slime green
  '#FF6EC7', // gum pink
  '#00E5FF', // toxic cyan
  '#FFA033', // cheese orange
  '#B26EFF', // grape purple
  '#FFE93B', // mustard yellow
  '#FF5252', // ketchup red
  '#5C7CFF', // blueberry
];

export const EMOTES = ['😂', '😭', '💀', '🤬', '👑', '🤡'];

export const MINIGAME_INFO = {
  sumo: {
    name: 'SLOP SUMO',
    desc: 'The ring is shrinking and the lava is hungry. Dash your friends out. Last blob standing wins.',
    icon: '🥵',
  },
  tater: {
    name: 'HOT TATER',
    desc: 'Somebody is holding a live explosive potato. Touch a friend to hand it off. Do not be holding it.',
    icon: '🥔',
  },
  grab: {
    name: 'GREED PIT',
    desc: 'Grab the most slop-coins. Dash into a friend and they DROP their coins. Greed is good.',
    icon: '🪙',
  },
  floor: {
    name: 'THE FLOOR IS SLOP',
    desc: 'Every tile you touch crumbles into the void. Keep moving. Outlast everyone.',
    icon: '🕳️',
  },
};
