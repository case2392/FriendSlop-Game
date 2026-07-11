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

// The chain. Every blob is tethered to the next one. This is the whole game.
export const LINK_LEN = 140;

export const TICK_RATE = 30;           // server simulation Hz
export const SNAPSHOT_RATE = 20;       // server -> client state Hz

export const MAX_PLAYERS = 8;
export const START_COINS = 0;

// ---- money (score, bragging rights, and blackjack table stakes energy) ----
export const CLEAR_PAY = 100;          // each blob, first time a chamber is cleared
export const RECLEAR_PAY = 25;         // each blob, clearing a chamber again after a lost hand
export const MVP_BONUS = 50;
export const LIFE_BONUS = 15;          // per unused team life on a clear
export const BJ_WIN_PAY = 25;          // the pit pays out when you beat the boss
export const BJ_NATURAL_PAY = 75;      // dealt a natural 21? the boys eat tonight

// ---- match structure ----
export const CHAMBER_COUNT = 4;

// Phase durations (seconds). FRIENDSLOP_FAST=1 shrinks these for tests.
export const FAST = typeof process !== 'undefined' && process.env && process.env.FRIENDSLOP_FAST === '1';
export const COUNTDOWN_TIME = FAST ? 1 : 3;
export const BJ_VOTE_TIME = FAST ? 1.5 : 14;    // seconds per hit/stand body-vote
export const BJ_RESULT_TIME = FAST ? 1.5 : 6;   // gloating window after the hand
export const MAX_TOTAL_PLAYS = FAST ? 5 : 14;   // pit collapses eventually — match always ends
export const CELEBRATE_TIME = FAST ? 3 : 18;
export const BANNER_TIME = FAST ? 1.5 : 6;

// ---- THE DEN (walkable hub) ----
// Everything you do between chambers, you do with your body:
// walk through the gate to enter the next chamber, stand in a zone to vote.
export const HUB = {
  SPAWN: { x: 800, y: 430 },
  GATE: { x: 800, y: 150, w: 500, h: 230 },      // walk-in zone under the gate arch
  TABLE: { x: 800, y: 660 },                     // the Pit Boss's table
  HIT: { x: 620, y: 700, r: 115 },
  STAND: { x: 980, y: 700, r: 115 },
};
export const GATE_CD_ALL = FAST ? 0.5 : 3;       // countdown when EVERYONE is in
export const GATE_CD_MAJORITY = FAST ? 1 : 9;    // countdown when most are in

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

// The four chambers of the Slop Pit, in expedition order.
export const MINIGAME_INFO = {
  gates: {
    name: 'THE GATES OF SLOP',
    desc: 'Three pressure plates, one chained squad. Cover ALL THREE at the same time to grind the gate open — while gremlins bodycheck you off. Spread out. Communicate. Scream.',
    goal: 'Hold all 3 plates to open the gate',
    icon: '🚪',
  },
  gut: {
    name: 'THE BELCHING GUT',
    desc: 'The floor is a stomach and it is about to be sick. When the gut rumbles, drag the whole chain onto a safe island before the acid wave hits. The islands shrink. The chain does not.',
    goal: 'Survive every acid wave',
    icon: '🌊',
  },
  tater: {
    name: 'GALLSTONE PANIC',
    desc: 'The pit keeps coughing up lit gallstones. Whoever is holding one must haul the ENTIRE CHAIN to the drain and dunk it before it blows. Pass it off by touching a friend. Teamwork or kaboom.',
    goal: 'Dunk the gallstones before they blow',
    icon: '🥔',
  },
  walk: {
    name: 'THE GREAT ESCAPE',
    desc: 'The way out. The crust crumbles under every step and the chain drags stragglers into the void. Get EVERY SINGLE BLOB onto the exit ledge. Nobody gets left behind.',
    goal: 'Everyone reaches the exit ledge',
    icon: '🕳️',
  },
};
