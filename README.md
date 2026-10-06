# 🚐 NO MONEY DOWN

> You and the boys bought a $250,000 motorhome with no money down.
> Payments are due every night. None of you have jobs.

A 1–6 player **first-person co-op road trip** — the FRIENDSLOP project's
second attempt, rebuilt from scratch around one spine: **a shared physics RV,
a shared bank account, and a Repo Man who collects at midnight.**

Drive the Slopmaster 9000 across a procedurally generated desert. The road is
broken: **climb** cliffs on a stamina bar to carry the **winch** hook up to an
anchor, shove 2-ton boulders, push the RV out of mud, read a gate code off a
canyon rim and shout it down to whoever's at the keypad. Scavenge **fragile
physics loot** from gas stations, wrecked semis and mesa-top plane crashes and
get it into the RV in one piece. Pawn it in town, **gamble the shared bank** at
the Lucky Slop casino (vote hit/stand with your body), and pay the Repo Man by
midnight — or he takes the doors. Then the roof. Then the RV.

The design (why the last version failed, what we steal from PEAK, R.V. There
Yet?, Gamble With Your Friends, We Were Here, REPO) is in
**[docs/DESIGN.md](docs/DESIGN.md)**.

## Play it

```bash
npm install
npm start          # → http://localhost:3000
```

One person **STARTS A TRIP**, sends the 4-letter code, everyone else **JOINS**.
Click the window to grab the mouse. **F1** shows the controls.

| | |
|---|---|
| `WASD` `Shift` `Space` `Ctrl` | walk · sprint · jump · crouch |
| **hold `LMB`** | **GRAB** — loot, or any steep rock/wall to **climb** it (`Space` = lunge) |
| `RMB` · `Q` · wheel | throw · drop · hold distance |
| `E` | use: driver seat, door, winch, pawn bell, casino buttons, keypad, bunk — hold on a knocked-out friend to pick them up |
| driving | `WASD` · `Space` brake · `R` reel the winch · `H` horn · `E` get up |
| `MMB` · `1-6` | ping · emotes |
| `V` · `M` · `T` | push-to-talk · mute · walkie-talkie |

## Voice

Hit **🎙 JOIN VOICE**. It's **proximity chat**: WebRTC peer-to-peer audio run
through a 3D HRTF panner at each player's head, fading out by ~45 m, muffled
when terrain or the RV is between you, and face-down-in-the-dirt muffled when
someone's knocked out. **Walkie-talkies** ($150 at the general store) reach
anyone else who owns one at any range — hold `T`.

Mics need a secure context (https or localhost). For LAN/internet play put the
server behind any TLS tunnel (Tailscale, cloudflared, ngrok) or reverse proxy.

## How it's built

```
shared/   world.js   seeded deterministic leg generator (terrain, road, obstacles, stops, town)
          rv.js      the RV's collider layout (server body, client copy, renderer all use it)
          loot.js    loot catalog: mass, value, fragility, carry class
server/   sim.js     Rapier 3D physics: heightfield, RV on raycast wheels, loot, grab springs,
                     push intents, winch cable, impact damage, run-over detection
          room.js    the run: days, clock, bank, pawn, casino, store, Repo Man, KO bills
          casino.js  body-vote blackjack + double-or-nothing
client/   player.js  first-person controller: walk/sprint/jump, PEAK-style climbing,
                     riding the moving RV (RV-local coordinates), knockouts
          phys.js    local Rapier world (kinematic copies) for the controller
          world3d.js · rv3d.js · props3d.js · people.js — procedural Three.js, no assets
          voice.js   WebRTC mesh + spatial audio · sfx.js — synthesized sound
```

- **Server-authoritative shared world, client-authoritative bodies.** The
  server simulates the RV, the loot and the winch at 60 Hz and snapshots at
  20 Hz. Each client moves its own body through a local copy of the same
  seeded world with Rapier's character controller — no input lag — and
  reports its pose. Grabs are spring forces from your hand on the server, so
  two people on one safe just *works*.
- **Zero assets.** Every mesh, texture and sound is generated.

## Tests

```bash
npm test
```

`test/logic.mjs` plays a whole run over real WebSockets with two fake players
and real physics: drive, carry and throw a vase (it chips), crack the ranger
gate, winch the RV up the grade, pawn a TV, win/lose blackjack by standing on
a pad, flip double-or-nothing, buy a walkie, pay the Repo Man, sleep into day
2, get billed for a KO, get run over, lose the doors, the roof, then the RV,
start over, and win on day 5.

The previous game (THE SLOP PIT) lives in git history at `a8cfdb1`.
