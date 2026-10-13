// The wildlife: who lives where on which day, and every number that tunes them. World gen, the server and
// the client all read this file, so it imports nothing.
//
//   ringtails  masked thieves that live in dens beside the stops: they sneak up on loot nobody is watching,
//              run it home and pile it at the den (where you can take it back). Grab, shove, throw things,
//              honk or run them over.
//   grumphorn  a one-ton shaggy beast asleep on the road past an obstacle. Wake it and it charges in a
//              straight line and tosses whoever it hits. It has patience, not health: hit it, ram it, winch
//              it, or let it wear itself out, and it wanders off for good (dropping its brass cowbell).
//
// Nothing here ever touches the bank: wildlife costs loot (which you can get back), time, and the doctor's
// bill if nobody picks you up.

// ringtail (RT) and grumphorn (GH) tunables: metres, seconds, kilograms, m/s, newtons
export const RT = {
  R: 0.24, MASS: 12, PICK_R: 0.34,                   // ball collider; the client's (bigger) sensor ball
  LEG_F: 450, LEG_GAIN: 30,                          // legs: a velocity servo capped at LEG_F newtons
  SNEAK: 3.5, RUN: 4.2, SPOOK: 6.0, MILL: 1.0,        // speeds
  JAW_F: 300, JAW_SLIP: 1.4, JAW_LIFT: 0.1,          // jaws: a spring capped at JAW_F; lose it past JAW_SLIP m
  REACH: 0.9, RANGE: 32, SEE: 24,                    // snatch reach; loot within RANGE of the den, SEE of it
  LEASH: 40, KIDNAP: 150, WAKE: 60, SLEEP: 80,       // home range; carried off this far it's gone; den wake/sleep
  HOP_UP: 4.6, HOP_FWD: 2.5, HOPS: 4,                // stuck: hop (empty-handed only)
  GIVE_UP: 6, UNREACHABLE: 30,                       // can't get there in 6 s: forget that item for 30 s
  DROP_DV: 0.9, STUN_DV: 2.4, STUN_T: 2.5, GONE_AFTER: 3,   // a hit this hard drops the loot / stuns it
  HIT_V: 1.5, UP: 0.9,                               // a hit: by a thing moving this fast; loot higher than UP is out of reach
  SQUASH_V: 2.0,                                     // the RV over it at this speed squashes it
  BITE_T: 2.0, WRIGGLE_T: 3.0, BITE_STAMINA: 20,     // held by one person: bites (day 2 on) or wriggles free
  HORN_R: 20, HORN_DEAF: 15, SPOOK_T: 4,             // the horn scatters them (then they ignore it a while)
  STASH_R: 1.2, HOME_R: 3, COOLDOWN: [5, 9], TRAP_T: 8,
  RAID_R: 40, RAID_CLEAR: 6, RAID_T: 8, HOP_IN: [2.5, 5.6], HOP_OUT: [2.5, 2.5],   // raids on the RV left open
  BAIT_V: 1500,                                      // a cheese wheel, to a ringtail picking what to go for
  NIP_R: 7, NIP_CD: 3, NIP_REST: 5,                  // a stranger at the den is nipped (each player every NIP_CD s)
};
export const GH = {
  HH: 0.75, R: 0.7, MASS: 800,                       // capsule lying along z: 2.9 m long, 1.4 m thick
  LEG_G: 0.8, LEG_GAIN: 20,                          // legs: velocity servo capped at 0.8 g
  CHARGE: 7.0, CHARGE_T: 2.4, CHARGE_D: 16,          // a charge: this fast, at most this long / far
  ROAM: 1.5, LEAVE: 2.0, MUD: 0.5,                   // walking speeds; in mud everything is halved
  WAKE_FOOT: 8, WAKE_SPRINT: 14, WAKE_CROUCH: 3,     // what wakes it: someone on foot this close
  WAKE_RIDER: 6, WAKE_RV: 18, WAKE_RV_V: 3.0,        // someone standing in the RV; the RV going faster than this
  WAKE_HORN: 40,
  RISE_T: 1.2, WINDED_T: 2.5, WINDED_HIT_T: 4, DOZE_T: 15,
  SEE: 16, LEASH: 50, HELD_T: 1.5,
  TOSS_V: 7, TOSS_UP: 6.5, STUMBLE_V: 3,             // what a toss does to you (and a brush with it)
  REVIVE_SAFE: 3.8, GRACE_T: 10, GRACE_R: 6,         // it leaves alone anyone near a downed friend (a revive reaches 3.5 m), and a toss's spot
  PATIENCE: 100,
  CREW: [0.7, 0.85, 1.0, 1.15, 1.3, 1.45],          // patience x this, for crews of 1..6
  COST: { propJ: 0.1, propCap: 40, windedX: 2, shove: 2, rvPerMs: 20, winchPerS: 6, charge: 8, toss: 35, tip: 10 },
  TIP_WIN: 1.0, TIP_T: 12, FLANK: 0.6,               // asleep, two friends shoving its flank within TIP_WIN s tip it over for TIP_T s
  NOTICE: 1.5,                                       // someone crouched right by it: this long before it notices
  HIT_J: 10, HIT_V: 0.5,                             // a hit: a thing coming at it this fast, bringing this much momentum (kg m/s)
};
// rockfall (days 3-5, at the narrows): it comes down when the RV gets within NEAR m or the boulder is moved,
// or early on a honk within HONK_R m; WARN s of rumble first, then a rock every GAP s breaks off the face at
// PUSH m/s; a rock within HIT_R m of someone on foot knocks them out going faster than KO_V, and bowls them
// over (a stumble: they drop what they hold) faster than BUMP_V, for LIVE s after it drops (then it's an
// ordinary stone)
export const RF = { NEAR: 25, HONK_R: 60, WARN: 1.5, GAP: 0.3, PUSH: 2.5, KO_V: 6, BUMP_V: 2.5, HIT_R: 0.9, LIVE: 8 };
// per day: ringtail dens (how many, ringtails in each, items each den may steal, how close a watcher scares
// them off; whether they bite, nip strangers at the den and raid the RV left open), where the grumphorns
// sleep (past which obstacle, how far) and how long one glares before it charges, and whether there's loose
// rock on the narrows. Day 5's Hoard: one den is the ringtails' big pile (these four, and all of them home)
export const PLAN = [
  { dens: 1, perDen: 2, cap: 2, fear: 6,   bites: false, raids: false, glare: 0,   rocks: false, beds: [] },
  { dens: 2, perDen: 3, cap: 3, fear: 5,   bites: true,  raids: true,  glare: 1.0, rocks: false, beds: [{ ob: 'mud', from: 'z1', dz: 12 }] },
  { dens: 2, perDen: 3, cap: 3, fear: 4,   bites: true,  raids: true,  glare: 0.9, rocks: true,  beds: [{ ob: 'gate', dz: 6.5 }] },
  { dens: 3, perDen: 3, cap: 3, fear: 4,   bites: true,  raids: true,  glare: 0.8, rocks: true,  beds: [{ ob: 'boulder', dz: 12 }] },
  { dens: 3, perDen: 3, cap: 3, fear: 3.5, bites: true,  raids: true,  glare: 0.7, rocks: true,  beds: [{ ob: 'gate', dz: 6.5 }, { ob: 'boulder', dz: 12 }],
    hoard: { stash: ['painting', 'neon', 'guitar', 'trophy'] } },
];
// states, sent in the snapshot (plus the bits below)
export const RST = { DEN: 0, SNEAK: 1, SNATCH: 2, RUN: 3, STASH: 4, HELD: 5, STUN: 6, SPOOK: 7, FLUNG: 8, GONE: 9, TRAPPED: 10, RAID: 11, INRV: 12, NIP: 13 };
export const GST = { SLEEP: 0, RISE: 1, GLARE: 2, CHARGE: 3, WINDED: 4, ROAM: 5, DOZE: 6, LEAVE: 7, LEFT: 8, HELD: 9, TIPPED: 10 };
export const ST_CARRY = 32, ST_MOOD = 64, ST_MASK = 31;
export const crewFactor = n => GH.CREW[Math.max(1, Math.min(6, n)) - 1];
export const ringtailsPerDen = (day, n) => Math.max(1, Math.min(5, PLAN[day - 1].perDen + (n >= 5) + (n >= 6) - (n <= 1)));
// the Hoard's: six of them (four against one player, five against two)
export const hoardRingtails = n => n <= 1 ? 4 : n === 2 ? 5 : 6;
export const STOP_NAMES = { gas: 'the gas station', semi: 'the wrecked semi', yard: 'the yard sale', junk: 'the junkyard', dino: 'the dinosaur' };
// the brass cowbell a grumphorn leaves behind: ordinary loot, worth more each day
export const cowbellValue = day => Math.round(170 * (1 + 0.22 * (day - 1)) / 5) * 5;
