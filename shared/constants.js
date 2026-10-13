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
export const QUOTAS = [1000, 2500, 4500, 7500, 15000];   // due at midnight, per day: miss one and the RV is gone
export const DOCK_RATE = 0.8;                            // what Ed pays for the RV's load at his loading zone
export const HOUR_SEC = FAST ? 5 : 45;                   // real seconds per game hour
export const DAY_START = 6;                              // 06:00
export const MIDNIGHT = 24;
export const REPO_ARRIVES = 18;                          // the tow truck shows up in town at 18:00
export const medBill = day => 250 + 50 * day;            // KO'd and nobody picked you up
export const RV_HIT_BILL = 500;                          // got run over by your own RV
export const NIGHT_MIN_SEC = FAST ? 1 : 6;               // the receipt stays up at least this long

// ---- voice ----------------------------------------------------------------------
// Proximity voice carries only so far: full volume within FULL m, fading to silence at RANGE m. Past that
// only walkie-talkies get through (to anyone else holding one, any range). The host relays a voice frame
// up to RELAY m (a little past RANGE: positions on a page trail the host's by a few frames)
export const VOICE = { FULL: 4, RANGE: 25, RELAY: 27 };
export const voiceGain = d => d < VOICE.FULL ? 1 : Math.pow(Math.max(0, 1 - (d - VOICE.FULL) / (VOICE.RANGE - VOICE.FULL)), 1.6);

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

// the shove: right mouse with empty hands. A cone in front of you (no aim needed): REACH m out, HALF_DEG
// either side of where you look, at most MAX things. A friend gets a knock (never a KO by itself: a roof edge
// can finish the job); loot a push of up to PROP_J N*s; wildlife its own reaction (server/mobs.js)
export const SHOVE = { REACH: 2.4, HALF_DEG: 35, DY: 1.6, MAX: 3, STAMINA: 12, COOLDOWN: 0.6, FRIEND: 3.5, FRIEND_UP: 1.5, PROP_J: 36, PROP_PER_KG: 4 };

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

// ---- the RV's condition (0-100%, one per trip; it never ends a trip: only a missed payment does) ----------
// A crash is how much the RV's velocity changes across the physics step itself (gravity put back), along the
// ground in its own frame: the engine, brakes, suspension, mud, the winch and friends pushing all act before
// that step, so only real contacts are left (landings belong to the springs). A step counts at GATE m/s or
// more; steps within WIN s are one hit, its size their summed change. Free up to FREE m/s (where an unbraced
// rider is already thrown down the cabin), then K% a m/s. Everything from the first hit until GAP s pass with
// none is one incident, capped at CAP% (a tumble is one bill: the $800 tow prices the rest). Nothing counts
// for QUIET s after a teleport (night parking, the tow). A grumphorn: by closing speed, free under GH_FREE
// m/s, GH_K% a m/s, at most GH_CAP%. A live rock landing on it fast: ROCK%; a ringtail squeezing out of a
// window: WINDOW%. An incident of POP% throws the door open; limping, a hit of STALL_HIT% stalls the engine
// for STALL_T s. Broken down (0%): the roadside fix, FIX_T s for the day's 1st/2nd/3rd breakdown (shared by
// up to FIX_HANDS within FIX_R m of the hatch, the RV slower than FIX_V m/s) brings it back to FIX_TO%.
// Gus at the town's RV lot (within GUS_R m) fixes STEP points a press, PER_PT dollars a point (rising like
// the loot does), cash, or LOAN_X times that on tomorrow's payment (night 4: on the balloon, a second press
// within LOAN_CONFIRM s signs it)
export const RVH = {
  GATE: 0.4, WIN: 0.15, QUIET: 0.5, GAP: 2, FREE: 2, K: 3, CAP: 25,
  GH_FREE: 3, GH_K: 1.2, GH_CAP: 20, ROCK: 3, WINDOW: 2, POP: 10, STALL_HIT: 3, STALL_T: 3,
  FIX_T: [8, 12, 16], FIX_HANDS: 3, FIX_R: 2.2, FIX_V: 1, FIX_TO: 20,
  PER_PT: 8, STEP: 25, LOAN_X: 1.25, LOAN_CONFIRM: 5, GUS_R: 15,
};
// [lowest %, name, engine force x, knocks on loose loot riding inside x]
export const RV_BANDS = [[61, 'FINE', 1, 0.5], [31, 'SMOKING', 0.85, 0.6], [1, 'LIMPING', 0.7, 0.7], [0, 'BROKEN DOWN', 0, 0.7]];
export const rvBand = hp => { const b = RV_BANDS.find(x => hp >= x[0]) || RV_BANDS[RV_BANDS.length - 1]; return { min: b[0], name: b[1], engine: b[2], rattle: b[3] }; };
export const crashDamage = dv => dv <= RVH.FREE ? 0 : Math.round(RVH.K * (dv - RVH.FREE));
export const beastDamage = v => v < RVH.GH_FREE ? 0 : Math.min(RVH.GH_CAP, Math.round(RVH.GH_K * v));
// Gus's price for the next press (the day's price rise is the loot's: 22% a day)
export function repairQuote(day, hp) {
  const pts = Math.max(0, Math.min(RVH.STEP, 100 - Math.round(hp))), base = RVH.PER_PT * pts * (1 + 0.22 * (day - 1));
  return { pts, cash: Math.round(base / 5) * 5, loan: Math.round(base * RVH.LOAN_X / 5) * 5 };
}

export const COLORS = ['#7CFC00', '#FF6EC7', '#00E5FF', '#FFA033', '#B26EFF', '#F4F4F4'];   // (white, not yellow: a yellow was too close to the green for red-blind players)
export const EMOTES = ['😂', '😭', '💀', '🤬', '👑', '🤡'];

// pose modes, sent as a small int
export const MODE = { WALK: 0, CLIMB: 1, SEAT: 2, KO: 3, AIR: 4 };
// pose flags (bitmask)
export const FLAG = { SPRINT: 1, CROUCH: 2, HOLDING: 4, WALKIE_TX: 8, MAP: 16, SHOVE: 32 };
