# NO MONEY DOWN — design document

> *You and the boys bought a $250,000 motorhome with no money down.
> Payments are due every night. None of you have jobs.*

A 1–6 player first-person co-op **road trip**: drive a dying RV across the
desert to Lost Wages, scavenging junk to pawn, climbing cliffs to winch the RV
over the parts of the road that don't exist anymore, and gambling the shared
bank account at roadside casinos, all to make each night's payment before the
Repo Man takes another piece of your RV.

Working title. The repo stays `FriendSlop-Game`. The menu calls it a
"friendslop road trip".

---

## 0. TL;DR

- **The spine is the RV road trip.** Everything else attaches to the RV or to
  the shared wallet. Anything that attaches to neither gets cut.
- **Steal one verb from each classic, not one level from each.**
  PEAK gives us *climbing with stamina*. R.V. There Yet? gives us *a shared
  physics vehicle and a winch*. Gamble With Your Friends gives us *one shared
  bank account and a nightly quota*. We Were Here gives us *asymmetric
  information you can only fix by talking*. REPO and Lethal Company give us
  *fragile physics loot and the extraction rhythm*.
- **One input does most of the work: GRAB.** Grab loot, rock (that's climbing),
  the winch hook, the RV's bumper, or your friends.
- **Proximity voice is a game mechanic**, not a feature. Distance, walls and
  walkie-talkies decide who knows what.
- **Every failure costs the shared bank money**: a fall means a medical bill,
  a dropped vase means lost value, a bad bet is just a bad bet. Physical
  comedy feeds straight into money arguments, and the money arguments are
  the game.
- **Chill by default.** There are no monsters and no permadeath. The danger
  comes from gravity, the road, the clock, and your friend Steve at the
  roulette table.

---

## 1. Why the last build ("THE SLOP PIT") didn't work

The previous version is preserved in git history (commit `a8cfdb1`) and on
branch `claude/friendslop-game-hnc1lm`. I read all of it. It is
competently engineered. The tests pass, the netcode is clean, and the voice
mesh works. As a design, though, it was doomed. In order of severity:

1. **It was a 2D game in a 3D costume.** The server simulated circles on a
   1600×900 plane. The only verbs were walk and dash: no jump, no grab, no
   carry, no throw, no climb. The "PEAK" chamber was a 2D plane remapped
   onto a cliff mesh, where "climbing" meant holding W over a green
   rectangle. Every game it paid homage to gets its comedy from a physics
   simulation that fails in visible, unscripted ways. With nothing physical
   in the sim, there was nothing to fail, and so nothing funny could happen.
2. **Six shallow homages make a Mario Party, not a friendslop game.** Each
   chamber lasted about 2 minutes and had about one decision in it. The
   genre's hits are the opposite: each has *one* loop that can run for
   hundreds of hours (see §2). Breadth made every part shallow and
   multiplied content cost by six.
3. **The voice chat was global, not proximity.** In this genre, spatial voice
   is the joke engine. You hear your friend's scream fade as he falls, you
   have to walk over to talk, and you get "WHAT? I can't hear you" across a
   canyon. Global voice turns all of that into a Discord call with a game
   attached.
4. **Nothing forced anyone to talk.** Everyone saw everything and the HUD
   stated the goal. There was no information asymmetry, which is exactly the
   We Were Here mechanic the boys love.
5. **There was no shared push-your-luck decision.** Money was a score
   ("bragging rights"). Nobody ever had to argue about whether to risk the
   rent. Gamble With Your Friends, REPO and Lethal Company all depend on a
   *shared* stake under a *deadline*.
6. **Bots shaped the design.** Every chamber had to be clearable by AI, which
   pushes mechanics toward the simple and deterministic. Bots can't be funny
   in voice chat. This genre is humans-only.
7. **Polish went to the wrong layer.** The last five commits were graphics
   passes. Art doesn't rescue a game that has no verbs.

What survives: the room-code server, the WebRTC voice mesh (which now gets
spatialized), the no-build-step Three.js client, the faceted toy-diorama art
direction, and the blackjack engine.

---

## 2. What the hits actually have in common

Verified figures (sources at the bottom):

| Game | Released | Scale | The ONE thing |
|---|---|---|---|
| **PEAK** (Aggro Crab + Landfall) | 16 Jun 2025 | 10M+ units by mid-Aug 2025; built in ~4 months after a jam | Climb a mountain on a stamina bar; help each other up |
| **R.V. There Yet?** (Nuggets Entertainment) | 21 Oct 2025 | 1.3M copies in week one | Get one shared RV home using a physics winch |
| **Gamble With Your Friends** (TEAM GWYF / TENSTACK) | 2 May 2026 | ~1M in its first week or two (reports differ), 2M+ in its first month | One shared bank account, one debt, a 5-minute daily quota |
| **Meccha Chameleon** | 9 Jun 2026 | 15M copies in under a month, ~340K peak concurrent; **2 devs, ~2 months, $4.79** | Paint yourself to hide |
| **R.E.P.O.** (semiwork) | 2025 (EA) | — | Carry fragile physics loot to extraction for the Taxman's quota |
| **Lethal Company** (Zeekerss) | 2023 | started the wave | Scrap for quota, proximity voice, and the ship operator calling the shots |
| **We Were Here** (Total Mayhem) | 2017 | long-running series | Two separated players, one walkie-talkie |

The pattern holds with high confidence:

1. **One verb, done with physics.** Climb, carry, winch, hide, gamble. Never six.
2. **Proximity voice.** PEAK even simulates echo and Doppler.
3. **Shared stakes under a clock**, either a quota (Lethal, REPO, GWYF) or the
   mountain itself (PEAK).
4. **Cheap and small.** The $5–8 range, built in months by tiny teams. The
   bar is *fun with friends*, not production value.
5. **Clip-able failure.** Falls, breakages, betrayals and screams.

## 3. The strongest argument against what you asked for

You asked what parts we can take from all of these and combine into the
ultimate game. The strongest counterargument is that *combining is exactly
what failed last time, and the market data says hits are single-mechanic*.
Meccha Chameleon is one verb, and it outsold everything in 2026. A union of
five games' features gives you five games' worth of content to build and a
diluted version of each.

The resolution is to **pick one spine and take only those mechanics that
plug into it.** The RV road trip is the one spine that can host the others
*organically*:

- A **journey**, with progress you can see, like PEAK's ascent.
- A **shared physical object** everyone is responsible for, like Chained
  Together's tether or R.V. There Yet?'s RV.
- **Stops**, where you scavenge loot and haul it back (REPO's extraction).
- **Towns**, where you gamble (GWYF's casino).
- **A cab**, where seats split the information: the driver can't see, the
  spotter can't drive, the navigator has the map (We Were Here).

The rule: **every mechanic must attach to the RV or to the wallet. If it
attaches to neither, cut it.**

---

## 4. Pillars (they settle arguments)

1. **The RV is everything.** It is your home, hub, vehicle, storage and
   collateral at once. Every system touches it.
2. **Physics or it didn't happen.** Every object, body, chip and the RV
   itself is a real rigid body. Failure must be physical, visible, and
   *somebody's fault*.
3. **One wallet.** All money is shared, and every mistake has a price tag.
4. **Your voice is a physical object.** It is spatial, muffled by walls, and
   carried by walkie-talkies. Roles and distance create the information gaps.
5. **Chill by default, panic on demand.** Most of the day is a road trip
   with your friends. The panic comes in spikes: the grade, the boulder,
   the coin flip.
6. **Nobody needs to be good.** Skill shows up as coordination, not aim.

## 5. The steal list

| From | Brilliant at | We take | We leave |
|---|---|---|---|
| **PEAK** | Stamina climbing on any surface; physically helping friends; campfires as pacing and hangout; proximity voice; ping; daily seeded map | Climbing any steep rock on stamina; carrying weight drains stamina faster; standing on friends' heads to boost; KO and revive; campfire nights; a daily seeded trip | Hunger, cold and poison afflictions. Money is our pressure system. |
| **R.V. There Yet?** | One shared vehicle; a physics winch with anchors; roles (driver, spotter, winch operator); a "funny and quite cozy" cab | The RV as a real raycast-wheel physics vehicle; carrying the winch hook to an anchor and reeling in; riding *inside* while it moves; driver blind spots | Fully linear levels (we generate roads); inventory-gated enemies (a reviewer complaint) |
| **Gamble With Your Friends** | One bank, one debt, a daily quota on a hard clock; physical casino games; sketchy items to fight the odds | The shared wallet, the nightly payment, physical table games, odds-shifting items | The casino as the whole game. Here it's the town stop. |
| **We Were Here / KTANE** | Separated players with asymmetric info and one radio channel | The paper map (only the holder sees it); gate codes posted where only a climber can read them; walkie-talkies as items; voice range as a puzzle | Single-use puzzle rooms, which have no replay value |
| **REPO / Lethal Company** | Quota, fragile physics loot, extraction to the vehicle, the operator role | Loot that loses value on impact; hauling it into the RV; the CB radio at the dash as the operator seat | Horror. You asked for chill. |
| **Meccha Chameleon** | One instantly legible verb that makes screenshots | **GRAB.** One button that does most of the game. | — |
| **Chained Together** | Tether physics: every failure is shared | The winch cable; co-carrying heavy loot (two people on one safe) | A permanent chain |

## 6. Controls

| Input | Verb |
|---|---|
| WASD / Shift / Space / Ctrl | Walk, sprint (stamina), jump, crouch |
| **Hold left mouse** | **GRAB**: loot, rock (climb), the winch hook, the RV bumper, a friend |
| Right mouse (holding something) | Throw |
| Mouse wheel (holding) | Hold distance |
| E | Use: seats, doors, the winch control, the pawn bell, casino buttons, keypads |
| Q | Drop |
| F | Look at the map (if you hold it) |
| T (hold) | Talk on walkie-talkie (if you own one) |
| V / M | Push-to-talk / mute |
| Middle mouse | Ping |
| Driving | WASD to drive, Space to brake, H for the horn, R to reel the winch in, E to get out |

---

## 7. The run

A run is **5 days**, about 60–90 minutes. Each day has three phases:

```
 ┌───────────── DAY N ─────────────────────────────────────────────┐
 │ 06:00  ROAD  ── seeded leg, ~1–1.5 km ───────▶  TOWN  ── 24:00 ─┼─▶ NIGHT ─▶ DAY N+1
 │        obstacles · POIs · loot · the map       pawn · casino     │   campfire · shop · sleep
 │                                                 Repo Man arrives │
 └──────────────────────────────────────────────────────────────────┘
```

- **The clock is the pressure.** One game hour is 45 real seconds, so a day
  from 06:00 to midnight takes 13.5 minutes. Arrive at 17:00 and you get
  7 hours (about 5 minutes) of casino. Arrive at 23:00 and you're paying the
  Repo Man with whatever you scavenged.
- **Arriving early is a choice.** You can pay at the tow truck and leave,
  which ends the day early and safely. Or you can stay and gamble the
  surplus until midnight. That's push-your-luck.
- **At midnight the Repo Man collects.** Short on the payment, he takes all
  the money *and* a piece of the RV. On the third miss he takes the whole RV
  and the run is over.
- **Day 5 is the balloon payment in Lost Wages.** Pay it and you own the RV.
  Credits roll as you drive into the sunset, over a recap: total medical
  bills, loot broken, the biggest bet, who lost it.

### 7.1 The Road

Each leg is generated from a seed: the road spline, the height profile, the
canyon walls, the obstacle placement and the POIs. Like PEAK's daily
mountain, there's a **daily trip seed**, so every group drives the same
roads that day.

**Every day is a different place.** The trip runs through five biomes in a
fixed order, each with its own ground, rock, plants, sky, fog and town
style (details in [ART.md](ART.md)):

| Day | Road | Biome | Town |
|---|---|---|---|
| 1 | The Westmeadow Road | meadow: oak groves, gray outcrops | Paydirt (timber-framed) |
| 2 | Goldenfield Pike | fields: golden grass, haybales, a windmill | Busted Flats (farmsteads) |
| 3 | Frostpeak Pass | snow: pines, granite, snow on every ledge | Last Chance (alpine stone halls) |
| 4 | The Redrock Badlands | badlands: red strata, hoodoos, buttes | Snake Eyes (frontier outpost) |
| 5 | The Lost Wages Flats | desert: dunes, sandstone arches, palms | Lost Wages (adobe) |

The biome changes the scenery and the walls (snow and badlands canyons are
higher and narrower), not the rules: every day has the same obstacle types
and the same economy, so the difficulty curve stays in the quota.

**Obstacles.** Each one is designed around a specific co-op verb:

| Obstacle | What happens | Verb it demands | Inspiration |
|---|---|---|---|
| **The Grade** | A washed-out slope too steep for the engine | Someone climbs the cliff with the winch hook, clips it to the anchor post at the top, and the driver reels in | RVTY + PEAK |
| **The Boulder** | A 2-ton rock in a narrow pass | Shove it with 3+ bodies, or winch it off the edge | physics + headcount |
| **The Mud Flat** | The wheels lose grip | Everyone out and push. Unloading heavy loot helps. | RVTY |
| **The Ranger Gate** | Locked gate, 4-digit keypad | The code is brushed on a slab of rock up on the canyon rim (a sign at the gate says which rim). Someone climbs up and reads it down to whoever's at the keypad, by shouting or by walkie. | We Were Here + proximity voice |
| *The Ledge Road* (M2) | Narrow road, invisible edge | A spotter walks ahead calling "left… LEFT… your OTHER left" | We Were Here |
| *The Washout Gap* (M2) | A gap in the road | Carry planks from the junk pile and lay a bridge. The RV crosses on raycast wheels. | RVTY |
| *Rockfall* (M2) | Falling rocks knock people over | Timing, and somebody's medical bill | PEAK |

**POIs** are worth the detour and cost time. Abandoned gas stations,
wrecked semis, yard sales, mesa-top crash sites (climb up and get the
suitcase *down*), junk piles, the roadside fiberglass dinosaur.

### 7.2 Loot

Every loot item is a rigid body with **mass, value, fragility and a carry
class**:

- *One-hand* (gnome, lamp, cash register drawer): sprint while carrying.
- *Two-hand* (TV, neon sign, vase): slow, blocks your view, drains climbing
  stamina.
- *Heavy* (safe, slot machine, dino head): one person can only drag it. Two
  grabbers lift it. Co-carrying isn't scripted; it falls out of summing the
  spring forces.

**Fragility.** Contact-force events above a threshold knock value off the
item, and at zero it breaks. Loot sitting loose in a moving RV slides
around. The fragile vase goes in the shower stall, and somebody will leave
it on the counter. That one rule produces endless comedy.

### 7.3 Climbing, stamina, falling

- Grab any steep surface (over ~50°) to cling. WASD moves along the surface
  and costs stamina; Space lunges, which costs a lot.
- Stamina regenerates on solid ground, and the bar is shorter while you
  carry weight (PEAK's backpack rule).
- **Boosting:** other players are solid. Stand on Dave's head.
- **Falls:** land too hard and you're **KO'd**. Your body ragdolls and your
  voice goes muffled. A friend holding E for 2.5 s revives you for free.
  Otherwise you wake after 20 s with a **medical bill** on the shared bank.
  Getting hit by your own RV is $500. The toast says who was driving.

### 7.4 The RV

The *Slopmaster 9000* is a real physics body, about 3 tons on four raycast
wheels. Inside: the driver and passenger seats, a dash with the CB radio and
the glovebox (where the map lives), a dinette, a kitchenette, a shower stall
that holds fragile loot, and bunks. The roof is walkable and is the best
view in the game. Falling off it is the second-best clip in the game.

**Repossession** is the failure ladder. Each missed payment takes a part:

1. **The doors.** Loot flies out on turns.
2. **The roof.** It's a convertible now, and everything's exposed.
3. **The RV.** Run over.

M2 adds more parts: a wheel (it pulls left), the windshield, the engine
(−30% top speed), and the bunks (no night skip).

### 7.5 The Town

- **Pawn shop:** put loot on the counter, the appraiser shows the price,
  ring the bell to sell. The money goes to the shared bank.
- **Casino:** every game bets *the shared bank*, and *anyone* can bet it.
  That's GWYF's comedy and it's ours too. In the first build:
  - **Blackjack.** Squad vs. dealer. Anyone can set the bet on the big
    +$100 / +$500 / ALL-IN buttons. Then **vote with your body**: stand on
    the HIT or STAND floor pad. Majority rules, and ties hit.
  - **Double or Nothing.** A coin-flip machine with a lever. It's 48.5%,
    because the house always wins.
  - **Big Lever Slots** (M2): the lever needs two people.
  - **Roulette with physical chip stacks** (M2): chips are rigid bodies you
    carry from the cashier, which means chips can be stolen, thrown and
    dropped.
- **General store (night):** walkie-talkies, energy drinks (refill stamina),
  rope, bungee tie-downs, and odds-shifting junk (M2: lucky rabbit foot,
  loaded dice).
- **The Repo Man** parks his tow truck outside. Pay early at the truck, or
  he collects at midnight.

### 7.6 Night

You park at the RV lot and sit at the campfire (PEAK's best idea: a
breather that is also a hangout). The day recap is read off a receipt. The
store is open. Everyone climbs into the bunks to sleep, and the next day
starts.

---

## 8. Economy

The quotas are tuned so **you can't scavenge your way out of the last two
days**. The game puts you at the roulette table at exactly the moment the run
matters most. The face values below are **measured from the generator**
(average over 20 seeds), not guessed:

| Day | Payment due | Stops | Loot on the leg (face value) | Due as a share of face value |
|---|---|---|---|---|
| 1 | $1,500 | 5 | ~$8,400 | 18% (a learning day: surplus to gamble) |
| 2 | $3,000 | 6 | ~$13,500 | 22% |
| 3 | $5,500 | 7 | ~$16,800 | 33% |
| 4 | $9,000 | 8 | ~$22,600 | 40% |
| 5 | $15,000 balloon | 8 | ~$24,300 | 62% (you will be gambling) |

The realistic haul is roughly 40–60% of face value: the clock, stops on mesa
tops you have to climb to, loot that breaks on the way down, and loot that
slides around in the RV. Day 5 is beyond that unless you banked surplus or got
lucky. The numbers need real playtests with real friends before anyone trusts
them (confidence: moderate).

- Every casino game has a house edge (blackjack about 1–2% played sensibly,
  the coin flip 3%). The casino is variance you choose, never free money.
- Medical bill: $250 + $50 × day per KO, unless a friend picks you up.
  Getting run over by your own RV: $500. RV on its back for 7 seconds: an
  $800 tow.
- Missing a payment: the Repo Man takes everything in the bank toward it,
  plus a part.

## 9. Voice and communication

- **Proximity voice:** an HRTF panner placed at the speaker's head. Full
  volume within about 2 m, fading to silence by about 45 m.
- **Occlusion:** if terrain or the RV body sits between two heads, the voice
  is low-passed. Players inside the RV hear each other clearly and hear
  outsiders muffled.
- **Walkie-talkies** ($150 at the store): hold T to transmit to every walkie
  holder, at any range, through a band-passed, crackly radio filter.
  Communication becomes something you have to *buy*.
- **KO'd players** sound muffled, like talking face-down in the dirt,
  because they are.
- **Information that only one person has:** the map (only its holder sees
  it), gate codes (only the climber sees them), the road ahead (only the
  driver sees it, and badly), what's behind the RV (only the person on the
  roof).
- There is no text chat. There are pings and emotes.

## 10. Comedy engines

Things the systems will produce without being scripted:

- The TV breaking in the back on a hard turn ("WHO LEFT IT ON THE TABLE").
- Falling off the roof at 50 km/h.
- Running over your friend: a $500 bill, and the toast names the driver.
- Going ALL IN on the coin flip with the payment money at 23:58.
- Losing the doors to the Repo Man, then watching the safe slide out on the
  next corner.
- Two people carrying a safe up a mesa. One of them lets go.
- The winch yanking the RV off the side of the grade.
- Carrying your KO'd friend back to the RV like a sack of potatoes.
- The navigator holding the map upside down, figuratively and literally.
- The driver gets up to grab a snack and the RV keeps rolling. Nobody is
  driving. (A driverless RV coasts; the parking brake only catches near a
  stop.)
- Riding in the back when the driver brake-checks, or rams the boulder:
  everyone standing gets thrown forward. Hard enough and it's a KO and a
  bill.

## 11. What we cut, and why

- **Bots.** They can't be funny. Solo play works (one person can do
  everything, slowly), but the game is tuned for 2–4.
- **Six separate chambers.** One spine.
- **Text chat.** Voice, pings and emotes only.
- **Combat and monsters.** Chill. The antagonists are the Repo Man and
  gravity.
- **Cosmetic shop and progression unlocks.** Later, if ever.

---

## 12. Tech architecture

- **Server (Node):** rooms and run state (days, clock, bank, quota, casino,
  pawn), plus a **Rapier 3D** physics world. That world holds the
  heightfield terrain, static buildings, the RV (dynamic body, compound
  colliders, `DynamicRayCastVehicleController`), all loot props, the winch
  cable (soft rope constraint plus a reel motor), and grab springs (PD
  forces from each grabber's hand target, which is what makes co-carry
  work). It steps at 60 Hz and sends snapshots at 20 Hz.
- **Client authority over your own body** is the indie friendslop standard
  (PEAK and Lethal Company run on owner-authoritative netcode). Each client
  runs a *local* Rapier world: the same seeded terrain, plus kinematic
  copies of the RV, the props and the other players. It moves its own
  first-person character with Rapier's `KinematicCharacterController`, so
  there's no input lag, and sends its pose.
  - **Riding the RV:** when you're grounded on the RV, your pose is
    expressed in RV-local coordinates. Everyone renders you relative to
    their own interpolated RV, so riders stay glued to it on every screen.
  - **Pushing** the RV or props is an *intent* (target, contact point,
    direction) that the server turns into force. Player proxies on the
    server are sensors only, so a player standing in the road can't stop a
    3-ton RV like a wall. Instead the RV knocks them flying.
- **Shared deterministic world generation** (`shared/world.js`): the server
  and every client build identical terrain from the seed. No meshes go over
  the wire.
- **Voice** is a WebRTC P2P mesh signaled over the game WebSocket, then
  routed through WebAudio: panner (HRTF), occlusion low-pass, and a radio
  band-pass path for walkies.
- **Client:** Three.js, no build step, no assets. All geometry and textures
  are procedural, and sound is synthesized. The art target is a 2004
  hand-painted MMO (see [ART.md](ART.md)). Textures are painted on canvases
  at load time by `client/js/paint/*`, one family per domain on a shared
  brush toolkit. Each domain has its own renderer (terrain, nature, town,
  roadside, RV, props, people). Static geometry is merged per material and
  per spatial cluster, so far clusters cull.
- **Colliders live in world gen, renderers follow them.** `shared/world.js`
  decides every solid thing's collider (tree boles, rocks by shape, shop
  shelves, yard props, the rim-code slab). Each renderer reads those sizes
  and fits its mesh to them, so the server, every client and the picture
  agree.
- **Steam path (later):** Electron shell, with Steam networking relay for
  NAT traversal.

## 13. Roadmap

| Milestone | Contents |
|---|---|
| **M1: vertical slice** (this branch) | First-person body, grab/carry/throw, climbing and stamina, KO and bills; the RV with driving, riding, pushing and the winch; loot and fragility; five generated legs in five biomes with the Grade, Boulder, Mud and Ranger Gate; a hand-painted art pass; a town with pawn, blackjack, double-or-nothing and the Repo Man; 5 days with quotas; repossession; the paper map; walkies; spatial voice |
| **M2: content** | Route forks, more biomes (the Strip, a swamp, a coast), the ledge road, the washout gap, rockfall, about 30 loot items, slots, physical roulette chips, store items, more RV parts, a fuel can loop, flat tires |
| **M3: feel** | Real ragdolls, a procedural radio with stations in the RV, better animation, weather (dust storms kill visibility, so there's more talking), night driving with headlights |
| **M4: ship** | Steam build, Steam networking, achievements, daily trip seed leaderboard ("lowest medical bills"), a $5–8 price point |

### What M1 actually contains (as built, October 2026)

All of this is implemented and covered by `test/logic.mjs` (31 server checks
over real WebSockets) and `test/smoke-browser.mjs` (two real Chromium clients):

- Seeded 5-day runs through five biomes (meadow, fields, snow, badlands,
  desert), each with its own town style. Each leg has a camp, a road through
  canyon walls, mesas, 4–8 stops, 2–5 obstacles (grade, mud, boulder, ranger
  gate), billboards and a cow skull as map landmarks, and a town.
- The art pass: hand-painted procedural textures, splatted terrain with
  ground clutter, per-biome sky, fog, clouds and horizon rings, groves of
  big oaks, hoodoos, buttes and arches, five town styles with furnished
  interiors, and stylized human characters.
- The RV on raycast wheels with a walkable interior, seats, a door, bunks,
  a dash odometer and clock, and a front winch with a payout spool, anchors
  and a reel. Riders stay glued to it on every client, and it can run you
  over.
- First-person bodies: walk, sprint, jump, crouch, stamina climbing with
  lunges and mantling, carrying weight shrinks your stamina bar, falls cause
  KOs, friends revive you.
- Loot: 15 item types with mass, value, fragility and carry class.
  Spring-force grabbing, so co-carrying emerges. Throwing. Impact damage. The
  pawn counter with appraisal.
- Casino: body-vote blackjack and double-or-nothing. Store: walkie-talkies,
  energy drinks, bungee tie-downs.
- The Repo Man, strikes, parts removal, night receipts, sleeping, and both
  endings.
- Proximity voice with occlusion, KO muffling, and the walkie radio path.

Not yet built (M2+): route forks, the ledge road, the washout gap and planks,
rockfall, slots, physical roulette chips, odds-shifting items, more RV parts,
fuel, weather, night driving beyond headlights, the radio, real ragdolls.

## 14. Risks

1. **Physics netcode jank past the point of funny.** Server-authoritative
   RV steering carries about 100–200 ms of latency, which is acceptable for
   a lumbering RV. If it isn't, the driver's client takes ownership of the
   RV (Photon-style). *Moderate confidence that's never needed.*
2. **The driver has fun and passengers don't.** The RV interior has to be a
   place: loot to babysit, the map to read, the roof to ride, the CB to
   yell into. Watch this in playtests.
3. **Gambling is just RNG.** It's mitigated by physicality (body-voting,
   levers), the shared stake, and keeping casino time to ≤30% of a day.
4. **Being called an R.V. There Yet? clone.** The differentiators are the
   money layer, the casino, climbing as a first-class verb, and route
   choice. Lean into the debt premise in all marketing.
5. **Scope.** The rule in §3 is the defense. If a mechanic doesn't touch
   the RV or the wallet, it doesn't ship.
6. **Load time.** Zero assets means every texture is painted and every mesh
   built in the browser. Three things now cut the wait. Painted textures are
   kept in the browser (IndexedDB, as PNG, keyed by a hash of the paint code
   that made them), so a returning player decodes them instead of painting.
   A pool of paint workers (the same family modules on OffscreenCanvas) paints
   the day's textures while the loading bar is up. At nightfall the next
   day's world data and textures get ready behind the night scene. Since a
   day now loads for seconds, the messages that come in meanwhile (loot
   breaking or pawned, the Repo Man's parts, toasts, your seat) wait for the
   new world and run in the order they came, as when the build ran straight
   after the world message; `tools/joinrace.mjs` checks a joining player and
   a new day against the server's props and parts.
   `tools/texhash.mjs` checks every texture comes out pixel-identical all
   three ways, `tools/texgame.mjs` checks every texture a running game holds
   against an older checkout, and `tools/loadtime.mjs` measures. With
   software rendering on 4 CPU cores, from "Start a Trip" (median of three
   runs, before → after): a first visit's world is built in 9.4 → 9.5 s and
   draws its first frames at 27.5 → 22.9 s; a returning player's world is
   built in 8.6 → 5.8 s and draws at 25.1 → 22.1 s; a new day draws in
   12.3–15.5 → 13.0–13.3 s the first time, 13.0–15.5 → 9.0–9.2 s once its
   textures are cached, and 10.0–13.4 → 9.8 s after a night. What's left: on
   that machine most of the wait is the software renderer's first frames
   after the build (about 16 s for a returning player; a trace of that load
   shows the GPU process busy for 28 of its 37 s, most of it waiting for
   SwiftShader to finish drawing, with the page's main thread blocked on it
   for 16 s); a first visit still paints about a third of the day's textures
   on the main thread, because their paints clip with antialiasing and an
   OffscreenCanvas clips without it, so its world isn't built any sooner;
   and the character atlases are never cached, because their pixels depend
   on what was painted before them (characters.js strokes through a shared
   scratch canvas whose size depends on history), so they're painted in game
   order as before. None of it has been measured on a real GPU.

---

## Sources

- Gamble With Your Friends: [games.gg overview](https://games.gg/gamble-with-your-friends/), [KeenGamer](https://www.keengamer.com/games/gamble-with-your-friends/), [GosuGamers: 1M in a week](https://www.gosugamers.net/entertainment/news/78409-gamble-with-your-friends-sells-one-million-copies-in-a-week), [Gamereactor](https://www.gamereactor.eu/the-latest-friendslop-hit-is-here-as-gamble-with-your-friends-sells-a-million-copies-in-less-than-two-weeks-1716843/); plus the reference video in `docs/reference/`
- PEAK: [Game Informer review](https://gameinformer.com/review/peak/a-brilliant-co-op-climbing-adventure), [Outlook Respawn: 10M units](https://respawn.outlookindia.com/gaming/gaming-news/from-game-jam-to-10-million-units-indie-hit-peak-success), [TweakTown: hot tub / Airbnb origin](https://www.tweaktown.com/news/106032/comedy-climber-peak-was-conceived-in-a-hot-tub-and-developed-in-an-airbnb/index.html), [PCGamesN: revive](https://www.pcgamesn.com/peak/revive)
- R.V. There Yet?: [Steam](https://store.steampowered.com/app/3949040/RV_There_Yet/), [Pure Xbox review roundup](https://www.purexbox.com/news/2026/06/rv-there-yet-is-available-today-with-xbox-game-pass-and-heres-what-the-reviews-are-saying), [Notebookcheck](https://www.notebookcheck.net/This-new-party-game-costing-only-8-with-proximity-based-voice-chat-is-blowing-up-on-Steam.1153790.0.html), [Deltia's controls guide](https://deltiasgaming.com/rv-there-yet-keybinds-and-controls-guide)
- Meccha Chameleon: [Windows Central](https://www.windowscentral.com/gaming/the-viral-hit-of-2026-has-sold-15-million-copies-in-a-month-on-steam-costs-usd5-and-was-made-by-2-people), [Digital Citizen](https://www.digitalcitizen.life/meccha-chameleon-sells-15-million-copies-on-steam-in-less-than-a-month/)
- We Were Here: [Thinky Games](https://thinkygames.com/games/we-were-here/), [IGF](https://igf.com/we-were-here)
- R.E.P.O.: [Valuables wiki](https://repo-2025horror.fandom.com/wiki/Valuables), [Dot Esports: extraction](https://dotesports.com/indies/news/how-to-extract-in-r-e-p-o)
- Friendslop as a term: [Know Your Meme](https://knowyourmeme.com/editorials/guides/whats-the-term-for-games-like-lethal-company-and-repo-people-calling-co-op-games-friendslop-explained), [AV Club](https://www.avclub.com/not-every-co-op-game-is-friendslop)
