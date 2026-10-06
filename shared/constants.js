// Tunables shared by the server (Node ESM) and the client (browser ESM).
// Units: meters, seconds, kilograms. Y is up. The road runs toward +Z.

export const FAST = typeof process !== 'undefined' && process.env && process.env.FRIENDSLOP_FAST === '1';
export const TEST = typeof process !== 'undefined' && process.env && process.env.FRIENDSLOP_TEST === '1';

export const SIM_HZ = 60;               // server physics
export const SNAP_HZ = 20;              // server -> client snapshots
export const POSE_HZ = 30;              // client -> server own-body pose
export const INTERP_MS = 110;           // how far behind the server clients render the world

export const MAX_PLAYERS = 6;

// ---- the run ----------------------------------------------------------------
export const DAYS = 5;
export const QUOTAS = [1500, 3000, 5500, 9000, 15000];   // due at midnight, per day
export const STRIKES_TO_LOSE = 3;                        // 3rd missed payment: the RV is gone
export const HOUR_SEC = FAST ? 5 : 45;                   // real seconds per game hour
export const DAY_START = 6;                              // 06:00
export const MIDNIGHT = 24;
export const REPO_ARRIVES = 18;                          // the tow truck shows up in town at 18:00
export const medBill = day => 250 + 50 * day;            // KO'd and nobody picked you up
export const RV_HIT_BILL = 500;                          // got run over by your own RV
export const NIGHT_MIN_SEC = FAST ? 1 : 6;               // the receipt stays up at least this long

// what the Repo Man takes, in order, when you miss a payment
export const REPO_PARTS = ['doors', 'roof', 'rv'];

// ---- your body ----------------------------------------------------------------
export const PLAYER = {
  RADIUS: 0.34,
  HALF_H: 0.56,             // capsule half-height (cylinder part); total ≈ 1.8 m
  EYE: 1.62,                // eye height above the feet
  WALK: 4.4,
  SPRINT: 7.2,
  CROUCH: 2.2,
  ACCEL_GROUND: 38,
  ACCEL_AIR: 8,
  JUMP: 6.6,
  GRAVITY: 20,
  MAX_SLOPE_DEG: 38,        // steeper than this you can't walk — you climb or you slide
  STEP: 0.46,
  REACH: 3.0,               // grab / use distance
  KO_LAND_SPEED: 15.5,      // land faster than this and you're out
  STUMBLE_LAND_SPEED: 11,
  KO_TIME: 20,              // seconds until you wake up on your own (and pay for it)
  REVIVE_HOLD: 2.2,
};

export const STAMINA = {
  MAX: 100,
  SPRINT: 11,               // per second
  CLIMB_MOVE: 9.5,
  CLIMB_HANG: 3.5,
  LUNGE: 24,
  JUMP: 6,
  REGEN: 30,
  REGEN_DELAY: 0.7,
  WEIGHT_PER_KG: 0.45,      // max stamina lost per kg you're holding (PEAK's backpack rule)
  WEIGHT_CAP: 55,
};

export const CLIMB = {
  SPEED: 1.85,
  LUNGE: 4.6,
  MIN_STEEP_DEG: 38,        // surfaces at least this steep can be clung to
  REACH: 0.95,
};

// ---- grabbing ---------------------------------------------------------------
export const GRAB = {
  KP: 140,                  // spring toward the hand
  KD: 22,
  FMAX: 950,                // newtons one person can pull with (lifts ~95 kg alone)
  RV_FMAX: 1300,            // tugging the RV by its bumper
  HOLD_MIN: 1.0,
  HOLD_MAX: 2.6,
  HOLD_DEFAULT: 1.6,
  THROW: 9,                 // m/s for light things; heavy things get less
  THROW_IMPULSE_CAP: 260,
};

export const PUSH_FORCE_RV = 2600;      // per shoving player, newtons
export const PUSH_FORCE_PROP = 520;

// ---- the RV -------------------------------------------------------------------
export const RV = {
  MASS: 3000,
  ENGINE: 2900,             // newtons per driven wheel at full throttle
  REVERSE: 1700,
  BRAKE: 95,
  TOP_SPEED: 17,            // m/s
  STEER_MAX: 0.56,
  FRICTION_SLIP: 2.2,
  MUD_SLIP: 0.16,
  MUD_DRAG: 11000,
};

export const WINCH = {
  MAX_LEN: 42,
  REEL_SPEED: 1.6,          // m/s
  FORCE: 52000,             // max newtons on the cable
  STIFF: 42000,             // newtons per meter of stretch
  DAMP: 9000,
  ANCHOR_REACH: 1.6,
};

export const COLORS = ['#7CFC00', '#FF6EC7', '#00E5FF', '#FFA033', '#B26EFF', '#FFE93B'];
export const EMOTES = ['😂', '😭', '💀', '🤬', '👑', '🤡'];

// pose modes, sent as a small int
export const MODE = { WALK: 0, CLIMB: 1, SEAT: 2, KO: 3, AIR: 4 };
// pose flags (bitmask)
export const FLAG = { SPRINT: 1, CROUCH: 2, HOLDING: 4, WALKIE_TX: 8, MAP: 16 };
