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

// The chain. For four chambers you're free — then the pit chains the squad
// together for the final climb. One slip drags everyone.
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

// ---- match structure ----
export const CHAMBER_COUNT = 6;

// Phase durations (seconds). FRIENDSLOP_FAST=1 shrinks these for tests.
export const FAST = typeof process !== 'undefined' && process.env && process.env.FRIENDSLOP_FAST === '1';
export const COUNTDOWN_TIME = FAST ? 1 : 3;
export const BJ_VOTE_TIME = FAST ? 1.5 : 14;    // seconds per hit/stand body-vote
export const BJ_RESULT_TIME = FAST ? 1.5 : 6;   // gloating window after the hand
export const MAX_TOTAL_PLAYS = FAST ? 7 : 20;   // pit collapses eventually — match always ends
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

// The five chambers of the Slop Pit, in expedition order.
// Every level is an homage to a friendslop classic (plus the Pit Boss's
// blackjack table between levels — that one's for Gamble With Friends).
export const MINIGAME_INFO = {
  dig: {
    name: 'THE DIG SITE',
    based: 'Keep Digging (via a certain village & a certain marketplace)',
    desc: 'Start on the green grass of SLOPSHIRE. DASH the ground to crack it, drop through, repeat — three floors down — until you splash into THE GRAND SLOPCHANGE. Everyone to the bottom. Mind the merchants.',
    goal: 'Everyone digs down to the Slopchange',
    icon: '⛏️',
  },
  rv: {
    name: 'ARE WE SLOP YET?',
    based: 'R.V. There Yet?',
    desc: 'The old RV is the only way through and it does not drive. PUSH IT. Mud bogs it down, gremlins shove it backwards, and the exit is all the way across the pit. All shoulders on the bumper.',
    goal: 'Push the RV to the exit',
    icon: '🚐',
  },
  cham: {
    name: 'THE CHAMELEON',
    based: 'Mecha Chameleon',
    desc: 'One of those statues is ALIVE and wearing your friend\'s face. Watch for the twitch, then DASH it. Smash a wrong statue and the squad pays for it. Catch it three times.',
    goal: 'Catch the chameleon 3 times',
    icon: '🦎',
  },
  casino: {
    name: "THE BOSS'S CASINO",
    based: 'Gamble With Friends',
    desc: 'The Pit Boss deals blackjack to the whole squad. Vote with your BODY — stand in the HIT or STAND zone before the timer. Win 2 hands before you bust out 3 times and the gate opens.',
    goal: 'Beat the Boss at blackjack',
    icon: '🎩',
  },
  chained: {
    name: 'CHAINED TOGETHER',
    based: 'Chained Together',
    desc: 'The pit CHAINS THE SQUAD for this climb — and the slop tide is rising. Ledges hold you, slime vines climb you, and one slip drags the whole chain down. Everyone to the top. Together.',
    goal: 'Everyone above the tide, up top — CHAINED',
    icon: '⛓️',
  },
  peak: {
    name: 'THE PEAK',
    based: 'PEAK',
    desc: 'The final free solo. No chain now — just you, the boys, the falling slop, and the summit. Get every single climber to THE PEAK and the Slop Pit is history.',
    goal: 'Every climber reaches the summit',
    icon: '🏔️',
  },
};
