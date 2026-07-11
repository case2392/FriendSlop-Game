# FRIENDSLOP — Design Document

> chained to the boys. one way out of the pit. don't bust.

## The pitch

2–8 friends are blobs of slop chained into one squad, escaping a living dungeon.
It's a **co-op expedition**: four original chambers with shared team lives, a
walkable 3D hub between them, and one hand of blackjack against the Pit Boss
gating every advance. True friendslop: one common goal, constant physical
comedy, and just enough gambling to start arguments.

## Design pillars

1. **Embodied everything.** There are no menus mid-game. Start a chamber by
   walking the squad through the gate. Vote in blackjack by standing on a floor
   zone. If a mechanic can be a *place*, it's a place.
2. **The chain is the game.** Every blob is tethered to the next (server-side
   distance constraint, momentum-sharing). Every chamber is designed around
   what a chain ruins: spreading out, fleeing, splitting up, leaving someone.
3. **One common goal.** Nobody wins a chamber alone — team lives are shared,
   and The Great Escape requires every single blob on the ledge. Money is
   bragging rights, not victory.
4. **A little gambling.** Exactly one hand of blackjack between chambers.
   Win = advance, lose = run it back, push = re-deal. Majority of bodies
   decides hit/stand; ties hit, because of course they do.

## The loop

```
THE DEN (hub) ──walk into gate──▶ CHAMBER ──cleared──▶ PIT BOSS BLACKJACK
   ▲                                 │ failed              │ win: next gate
   └──────── run it back ◀───────────┴──── lose ◀──────────┘
```

- Expedition = chambers 1→4 in order. Clearing chamber 4 IS the escape
  (no hand after it — the finale can't be undone by a card).
- The pit collapses after 14 total chamber attempts — matches always end.
- Celebration in the Den: confetti, floating standings, back to the lobby.

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

| | Rules | Shared lives | MVP metric |
|---|---|---|---|
| 🚪 **THE GATES OF SLOP** | Cover all pressure plates simultaneously for a cumulative 8s. Gremlins shove and stagger you (a staggered blob still holds a plate — only displacement matters). Plate count and spread scale with squad size so the chain can always physically reach. | none (time race, 75s) | plate time |
| 🌊 **THE BELCHING GUT** | Wave cycle: calm 4.5s → warning 3.2s (islands telegraph) → acid flood 2.2s. Caught outside an island = burn, stun, −1 life. Survive 4 waves; islands shrink and dwindle. Island size scales with squad. | 2 + 0.8/blob | clean waves |
| 🥔 **GALLSTONE PANIC** | A lit gallstone (13s fuse) spawns on someone; touching a friend passes it; holder is faster. Dunk it in the relocating drain. Explosion: knockback + stun + −1 life. Dunk 4 to clear. | 2 + blob/3 | dunks |
| 🕳️ **THE GREAT ESCAPE** | Tiles crack 0.5s after touch, crumble 1s later. Fall = −1 life + respawn at start (and you drop out of the chain while you run back). Everyone alive on the exit ledge = escape. | 2 + 0.7/blob | first across, then tiles scouted |

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

Self-aware slop with casino-den maximalism. Googly eyes look where you walk.
The Pit Boss never speaks. The chain never comes off.
