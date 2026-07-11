# FRIENDSLOP — Design Document

> bet on your friends. betray your friends. become the slop.

## The pitch

2–8 friends are sentient blobs of slop. Every round, the game announces a chaotic
physics minigame — then **everyone publicly bets Slop Coins on who's going to win it**
before it starts. Winner takes prize money, correct bettors split the pot, and when
nobody calls it, the pot rolls into a growing jackpot that hangs over the lobby like
a guillotine. After 5 rounds, the richest blob wins.

The betting layer is the social engine: it means every round matters even when you're
bad at the minigame (gamble well!), it makes alliances ("I'm ALL IN on you, do NOT
choke") and betrayals ("you bet on HIM?") automatic, and public bets = automatic
trash talk. The minigames are the slapstick; the wagers are the friendship-ruiner.

## The loop

```
LOBBY → [ BET (18s) → MINIGAME (~60s) → RESULTS (9s) ] × 5 → PODIUM → LOBBY
```

### Economy
- Everyone starts a match with **100 🪙**.
- Betting: pick a blob (yourself allowed), stake 10% / 25% / 50% / ALL IN.
- Minigame placement prizes: **100 / 50 / 25** for 1st / 2nd / 3rd.
- The pot (all stakes + any jackpot) is split among everyone who bet on the winner,
  proportional to stake. Nobody called it → the whole pot **rolls into the jackpot**.
- Broke? You get a **pity slop** top-up to 10 🪙 — you're never out of the game,
  and an ALL-IN comeback from 10 coins is the best story of the night.

### Controls
WASD / arrows to squish around, **Space/Shift to dash** (1.6s cooldown). Dashing is
the universal verb: it's the shove in Sumo, the tag in Tater, the robbery in Greed
Pit, and the panic button everywhere. Keys 1–6 fire emotes.

## Minigames

| | Rules | Win |
|---|---|---|
| 🥵 **SLOP SUMO** | Circular platform over lava shrinks for 60s. Outside the ring = splat. | Last blob standing (timeout: closest to center) |
| 🥔 **HOT TATER** | One blob holds an exploding potato (14s fuse, shrinking each cycle). Touch someone to pass it. Holder moves 18% faster. | Last blob alive |
| 🪙 **GREED PIT** | Coins rain for 45s (golden = 10). Dash into a friend: they drop 35% of their haul, scattered. | Most coins collected |
| 🕳️ **THE FLOOR IS SLOP** | Every tile you touch cracks (0.45s) then crumbles (0.9s). Falling = splat. | Last blob alive (timeout: most tiles touched) |

Adding a fifth minigame = one file in `server/minigames/` implementing
`constructor(players)`, `tick(dt) → rankings | null`, `extras()`, plus a renderer
branch in `client/js/render.js` and an entry in `shared/constants.js`. The round
queue picks it up automatically.

## Design pillars

1. **Nobody sits out.** Dead blobs still won/lost their bets; results are 9 seconds
   away; pity coins mean no one's mathematically eliminated.
2. **Public information is content.** Bets are visible live during the betting phase
   on purpose — the UI is a trash-talk generator.
3. **One verb.** Everything is move + dash. Your grandma can play round 1;
   round 5 she's slide-canceling into your sumo blindside.
4. **The house never wins.** All coins flow between friends. The jackpot is the
   only "bank," and it always pays back out.

## Tone

Self-aware slop. Comic Sans-adjacent fonts, wet sounds, blobs with googly eyes that
look where they're going, goo stains that persist where your friends died. The game
knows what it is: the store page should too.
