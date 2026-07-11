# FRIENDSLOP — Design Document

> chained to the boys. one way out of the pit. don't bust.

## The pitch

2–8 friends are chunky ragdolly slop-people in dumb hats escaping a living
dungeon. It's a **co-op expedition of six chambers — each an homage to a
friendslop classic** (Keep Digging, R.V. There Yet?, Mecha Chameleon, Gamble
With Friends, Chained Together, PEAK) — with a walkable 3D hub between them.
True friendslop: one common goal, constant physical comedy, and just enough
gambling to start arguments.

## Design pillars

1. **Embodied everything.** There are no menus mid-game. Start a chamber by
   walking the squad through the gate. Vote in blackjack by standing on a floor
   zone. If a mechanic can be a *place*, it's a place.
2. **The chain is the twist, not the default.** Five chambers you're free.
   Then CHAINED TOGETHER binds the squad (server-side distance constraints,
   momentum-sharing) for one climb where a single slip drags everybody.
3. **One common goal.** Nobody wins a chamber alone — team lives are shared,
   and The Great Escape requires every single blob on the ledge. Money is
   bragging rights, not victory.
4. **A little gambling.** One casino chamber, mid-expedition. The Boss deals
   to the whole squad; majority of bodies decides hit/stand; ties hit,
   because of course they do.

## The loop

```
THE DEN ──walk into gate──▶ CHAMBER ──cleared──▶ next gate (×6) ──▶ ESCAPE
   ▲                            │ failed
   └──────── run it back ◀──────┘        (pit collapses after 20 attempts)
```

## The Den

A casino-carpeted room (Gamble With Friends energy): wallpaper, neon, ceiling
panels, the Pit Boss (a blob in a top hat) behind a felt table with real dealt
3D cards. North: the chamber gate — glowing walk-in zone; when 60%+ of the
squad is in, a countdown starts (everyone in = fast countdown). South: the
table with HIT 👊 and STAND ✋ floor zones. Voting is per-decision: each hit
deals a card and opens a fresh vote window. The zones are close enough that a
chained squad *can* split across them — and the tug-of-war when they disagree
is the design.

## Economy

- Chamber cleared (first time): **+100 💰 each**, +15/unused team life each,
  MVP +50. Re-clear after a lost hand: +25 each.
- Beat the Boss: +25 each; dealt a natural 21: +75 each.
- Failed chamber: MVP gets 25 for carrying.
- Money is the podium ranking at the end. The real result is ESCAPED or NOT.

## Chambers

| | Homage | Rules | Shared lives |
|---|---|---|---|
| ⛏️ **THE DIG SITE** | Keep Digging | Dash tiles (2 hits) or loiter to dig; fall through holes; EVERYONE to the bottom of 3 floors in 110s. | time only |
| 🚐 **ARE WE SLOP YET?** | R.V. There Yet? | Push a 7×-mass RV to the far exit in 110s. Mud kills its momentum; gremlins push back; dashes shove hard. MVP: shoulder time. | time only |
| 🦎 **THE CHAMELEON** | Mecha Chameleon | ~2n statues mimic the squad; the real one twitches every ~4s. Dash it ×3. Wrong smash: −1 life + stun. | 2 + n/2 |
| 🎩 **THE BOSS'S CASINO** | Gamble With Friends | Squad blackjack: bodies in HIT/STAND zones vote each decision (window 14s, all-in resolves early). Win 2 hands; 3 losses busts the squad. | 3 losses |
| ⛓️ **CHAINED TOGETHER** | Chained Together | Chained (long links) up a cliff of ledges + vines while the slop tide rises. Tide catch: −1 life + rescue to a safe ledge. Everyone up top. | 2 + 0.7n |
| 🏔️ **THE PEAK** | PEAK | Full-height free solo, falling slop globs knock you off. Bare rock slides; vines climb; every climber to the summit in 170s. | time only |

Adding a chamber = one file in `server/minigames/` implementing
`constructor(players)`, `tick(dt) → rankings|null`, `extras()`, `teamWin`,
optional `lives` — plus a renderer branch and an entry in `MINIGAME_INFO`.

## Tech notes

- Server-authoritative: 30Hz sim, 20Hz snapshots, movement as camera-relative
  unit vectors. The chain is 3 iterations of distance constraints with
  momentum blending — dashing yanks the whole squad.
- Client is Three.js with zero assets: all geometry procedural, all textures
  canvas-generated (carpet, wallpaper, cards), all SFX WebAudio-synthesized.
- Bots are first-class: hub walking, chamber AI per game, blackjack instincts
  (12% chaos agent), and they vote with their bodies like everyone else.

## Tone

Self-aware slop with casino-den maximalism. Little humanoids with swinging arms, per-player hats, and eyes that look where they walk.
The Pit Boss never speaks. The chain comes off — except when it doesn't.
