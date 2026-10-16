# NO MONEY DOWN — design document

> *You and the boys bought a $30,500 motorhome with no money down.
> Payments are due every night. None of you have jobs.*

A 1–6 player first-person co-op **road trip**: drive a dying RV across the
desert to Lost Wages, scavenging junk to pawn, climbing cliffs to winch the RV
over the parts of the road that don't exist anymore, and gambling the shared
bank account at roadside casinos, all to make each night's payment before the
Repo Man takes the RV. Miss one and the trip is over.

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
- **Chill by default, wildlife on the side.** No permadeath, no health bars.
  The danger comes from gravity, the road, the clock, your friend Steve at
  the roulette table, and the wildlife and the road (Ringtails steal from the
  stops and, from day 2, from an RV left open; from day 2 a Grumphorn sleeps
  past an obstacle; from day 3 loose rock waits above the narrows): every
  theft costs loot you can go and take back, every toss costs time and, if
  nobody picks you up, a bill.
- **The RV has a condition, not the players.** Crashes and the wildlife dent
  it; worn, it's slower; at 0% it breaks down until somebody holds E at the
  engine hatch; Gus fixes it in town for cash or on the loan. It costs time
  and money, never the run: only a missed payment ends a trip.

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

What survives: the room-code server, the voice chat (now proximity voice,
relayed by the host), the no-build-step Three.js client, the faceted toy-diorama art
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
| **We Were Here / KTANE** | Separated players with asymmetric info and one radio channel | The paper map (only the holder sees it, never the driver); gate codes posted where only a climber can read them; walkie-talkies as items; voice range as a puzzle | Single-use puzzle rooms, which have no replay value |
| **REPO / Lethal Company** | Quota, fragile physics loot, extraction to the vehicle, the operator role | Loot that loses value on impact; hauling it into the RV; the CB radio at the dash as the operator seat | Horror. You asked for chill. |
| **Meccha Chameleon** | One instantly legible verb that makes screenshots | **GRAB.** One button that does most of the game. | — |
| **Chained Together** | Tether physics: every failure is shared | The winch cable; co-carrying heavy loot (two people on one safe) | A permanent chain |

## 6. Controls

| Input | Verb |
|---|---|
| WASD / Shift / Space / C | Walk, sprint (stamina), jump, crouch |
| **Hold left mouse** | **GRAB**: loot, rock (climb), the winch hook, the RV bumper, a friend |
| Right mouse (holding something) | Throw |
| Right mouse (empty hands) | Shove: whatever is in a 2.4 m cone in front of you (a friend stumbles back, loot gets a push, wildlife reacts). Never knocks anyone out by itself |
| C in the RV | Brace: crouched riders are never knocked out by a lurch (a stumble past 40 m/s²) |
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
  Repo Man with whatever you scavenged. The clock waits in camp until the RV
  rolls out, or until someone sets off down the road on foot (30 m past the
  camp's exit for 2 seconds): no walking to town on camp's frozen clock.
- **Arriving early is a choice.** You can pay at the tow truck and leave,
  which ends the day early and safely. Or you can stay and gamble the
  surplus until midnight. That's push-your-luck.
- **At midnight the Repo Man collects.** Short on the payment by a dollar,
  on any day, and he hooks the RV: the run is over. (Ed rings up whatever is
  still on his counter first, and money on the casino tables comes back.)
- **Day 5 is the balloon payment in Lost Wages.** Pay it and you own the RV.
  Short on it at midnight and he takes the RV: there's no day 6.
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
| 2 | Goldenfield Pike | fields: golden grass, fenced crop plots (standing wheat, stubble with round bales, furrows, scarecrows), a windmill | Busted Flats (farmsteads) |
| 3 | Frostpeak Pass | snow: pines, granite, snow on every ledge | Last Chance (alpine stone halls) |
| 4 | The Redrock Badlands | badlands: red strata, hoodoos, buttes | Snake Eyes (frontier outpost) |
| 5 | The Lost Wages Flats | desert: an open erg of dunes, sandstone only at the narrows, arches, palms | Lost Wages (adobe) |

The biome changes the scenery and the walls (snow and badlands canyons are
higher and narrower; the desert has no canyon at all, only dune banks, with
a short sandstone gorge where the gate or the boulder pinches the road), not
the rules: every day has the same obstacle types and the same economy, so
the difficulty curve stays in the quota.

**Obstacles.** Each one is designed around a specific co-op verb:

| Obstacle | What happens | Verb it demands | Inspiration |
|---|---|---|---|
| **The Grade** | A washed-out slope too steep for the engine | Someone climbs the cliff with the winch hook, clips it to the anchor post at the top, and the driver reels in | RVTY + PEAK |
| **The Boulder** | A one-ton rock in a narrow pass (a ROCKFALL sign warns you) | Two bodies shove it aside (one can't); alone, nudge it with the RV's bumper, or hook it and reel it while the RV stands angled | physics + headcount |
| **The Mud Flat** | The wheels lose grip | Everyone out and push (E on the RV's back, hold W: the engine alone barely moves it, one pusher hardly more, two get it out: test/rv.mjs). Unloading heavy loot helps. | RVTY |
| **The Ranger Gate** | Locked gate, 4-digit keypad | The code is brushed on a slab of rock up on the canyon rim (a sign at the gate says which rim). Someone climbs up and reads it down to whoever's at the keypad, by shouting or by walkie. | We Were Here + proximity voice |
| *The Ledge Road* (M2) | Narrow road, invisible edge | A spotter walks ahead calling "left… LEFT… your OTHER left" | We Were Here |
| *The Washout Gap* (M2) | A gap in the road | Carry planks from the junk pile and lay a bridge. The RV crosses on raycast wheels. | RVTY |
| **Rockfall** (days 3–5) | Loose rock on the rim above the boulder and the gate narrows (a LOOSE ROCK sign, "HONK FIRST" on the map). The RV coming close, or a shove on the boulder, brings it down after a rumble: a rock falling fast knocks out whoever it hits, a rolling one bowls them over | Honk at the sign and it falls before you get there; or hear the rumble and get clear of the walls. Afterwards the rocks are ammunition | timing + the driver's horn |
| **The Grumphorn** (days 2–5) | A one-ton beast asleep on the road past the mud (day 2), behind the ranger gate (3), past the boulder (4), or both (5). Woken, it charges a fixed line and tosses the first person in its horns | Sneak past crouched, creep the RV by, or wear out its patience: throw junk (a heap of stones waits by its sign), shove, ram it with everyone braced, winch it. Two friends shoving its side while it sleeps tip it over for 12 s. At zero it drops its cowbell and leaves for good | physics + headcount |
| **The Hoard** (day 5) | One den (the junkyard's) with six ringtails at home (four against a lone player, five against two) on the week's best stash, about $2,500 | A mob of teeth: shove them off, honk, lure them away with a cheese wheel, and carry it out together. The danger's way to make the balloon payment without the casino | headcount |
| **Ringtails** (every day) | Masked thieves in dens beside the stops (1 den on day 1, 3 by day 5). They sneak up on loot nobody is watching and run it home to their pile. From day 2 they raid an RV left open with nobody by its door, and nip anyone at their den (a stumble, and you drop what you carry) | Watch your loot (stand facing it); grab the thief (it drops it; from day 2 it bites a lone holder, so hold it with a friend), shove it, throw something at it, honk, or raid the den and take it all back. Shut the RV's door (a ringtail that gets in pries the locker open). A den steals at most 2–3 things a day | headcount + attention |

**POIs** are worth the detour and cost time. Abandoned gas stations,
wrecked semis, yard sales, crash sites on top of a butte (climb up and get
the suitcase *down*), junk piles, the roadside fiberglass dinosaur. A butte is
a few solid convex masses in world gen (`shared/butte.js`: a flat top, a lower
bench to rest on half-way up, two lobes), because the 2.5 m terrain grid can
only draw a steep hill as a cone. The masses are angular, jointed rock (flat
faces meeting at corners) and their walls lean in, 6-16° (typically 8°): upright
cylinders read as drums or tanks from the road. It stands on its own talus: a concave scree
apron in the heightfield that buries its lower third, about 31° at the foot so
you can walk up to the wall (never a triangle steeper than the 38° you can walk
where the apron changed the ground), and kept short on the road side so it
meets the ditch at nothing. What fell off it is solid: world gen lays and shapes
every fallen block and the physics takes its points as a convex hull, so you
stand on the rock you see, not in it.

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
the road map lying on it, a dinette, a kitchenette, a shower stall
that holds fragile loot, and bunks. The roof is walkable and is the best
view in the game. Falling off it is the second-best clip in the game.

**Condition** (0-100%, one per trip, shown in the top bar once it's hurt).
A crash is how much the RV's velocity changes across the physics step
itself, along the ground in its own frame: free up to 2 m/s (where an
unbraced rider is already thrown), then 3% per m/s; into the closed ranger
gate at 8 m/s it's about 18%, and the toast names the driver ("CRUNCH. Sam
put the RV into the ranger gate: -18%"). Everything within 2 s of the first
hit is one incident, capped at 25% (a roll is one dent and the $800 tow).
The wildlife dents it too: a Grumphorn by how fast they close across where
they touch (a charge into the parked RV about 8%; into the back of one
driving off, or a corner brushing past its flank, little or nothing), a live
rock landing on it 3%, a ringtail breaking out through a window 2%. Worn
down it loses its top end, never its pull (FINE above 60%, 12.9 m/s;
SMOKING to 31%, 12.1; LIMPING to 1%, 11.2, and a knock stalls the engine for
3 s); an incident of 10% or more throws the door open. At 0% it breaks
down: whoever holds E at the engine hatch on its back gets it running at
20% in 8 s (two hands 4 s, three 2.7 s; the day's second breakdown 12 s).
A breakdown 700 m out of town costs about 14 s, a third of a game hour
(tools/rvsoak.mjs). **Gus** fixes it by the RV lot at night once the Repo
Man is paid: 25% a press, for cash or on tomorrow's payment.

**Repossession** is all or nothing: one missed payment and the Repo Man
hooks the RV. (An earlier build took a part per miss, the doors, then the
roof, then the RV; it made the first four days too forgiving.)

### 7.5 The Town

- **Pawn shop:** put loot on the counter, the appraiser shows the price,
  ring the bell to sell. The money goes to the shared bank. Or park the RV in
  Ed's loading zone out front and the bell sells its whole load too, sight
  unseen, at 80%: carrying the good stuff in is worth it, carrying the junk in
  isn't. (Unloading 20 things one at a time ate three game hours.)
- **The RV's locker** (playtest ask: loot in the RV kept losing value, and
  lay in the aisle to trip over): loot that comes to rest in the cabin goes
  in the locker by the bunks, out of the physics, safe from the road's
  knocks. E on the locker opens its list (client/js/shop.js, the server's
  { t: 'locker', list } when it changes) and takes out the thing you pick,
  into your hands; Ed's loading zone buys the locker's loot with the load;
  it rides into the next day. The crew's gear goes in too (playtest: the
  shovel and the dynamite had nowhere to go), but Ed's dock leaves it, no
  ringtail pries it out, and a lit stick never goes in. The risk moves
  to getting the loot *to* the RV, and to the door: a ringtail that gets in
  pries the locker open. (Bungee cords now strap down what rides on the
  roof.)
- **Casino:** every game bets *the shared bank*, and *anyone* can bet it.
  That's GWYF's comedy and it's ours too. Each player can be at a different
  game at the same time (one at blackjack, one at craps, one on the coin
  machine), all of it out of the one bank; the blackjack table plays its seats
  together, one round. A station (a blackjack seat, a craps rail, a machine) is
  yours once you press E at its button and stays yours till you walk off. A
  game you leave half-played is played out the house's way: a hand stands, the
  dice roll on. The number keys play it: 1-4 set the stake (+$100, +$500, ALL
  IN, clear), 5 deals, hits, rolls or pulls; at blackjack 6 stands, 7 doubles,
  8 splits; at craps 7 lays odds. The stake leaves the bank when it's played;
  winnings come back when the game settles; the crew sees every result with the
  player's name.
  - **Blackjack.** One table, three seats, one round played together, the way
    a casino deals it (server/blackjack.js, a six-deck shoe). The first DEAL
    with a bet down starts a 5 s count for the others to get in (everyone
    seated and bet saying DEAL deals at once). The dealer deals round the seats
    in order and a card up to himself, then a second round and his hole card
    down. With an ace or a ten up he checks for blackjack (his natural ends the
    round: a player's natural pushes, the rest lose). Then each seat in turn,
    25 s each: hit, stand, double on the first two cards (one card, the stake
    doubled) or split a pair once (a stake on each hand; split aces get a card
    each). Last he turns his card and draws to 17 (stands on every 17). A
    natural pays 3 to 2. A stake the bank can't cover on top of the others'
    sits that hand out.
  - **Craps.** Two rails, the pass line: 7 or 11 on the come-out wins even
    money, 2, 3 or 12 loses, anything else is the point; roll it again before a
    7. The line pays even money (a 1.4% house edge). With a point up you can
    lay odds behind the line, a bet at a time up to 3x the line, paid at true
    odds: the harder the point, the more it pays (4 or 10 pays 2 to 1, 5 or 9
    3 to 2, 6 or 8 6 to 5), with no house edge on the odds. (The line itself
    can't pay by the point: the come-out's 7s and 11s already lean the
    player's way, and paying points at their odds as well would hand the crew
    an edge over the house.)
  - **Double or Nothing.** Two coin-flip machines with levers. It's 48.5%,
    because the house always wins. The stake stays set: pull again.
  - **The Ringtail Derby.** Everybody's game: four ringtails race down a
    sand track, a ticket on one (any stake, any number of players) pays 3.8
    times. The race runs 12 s after the first ticket, so the crew piles in.
  - At midnight (and at dawn) it's last call: whatever's on the tables is
    played out before the Repo Man counts the bank.
  - **Big Lever Slots** (M2): the lever needs two people.
  - **Roulette with physical chip stacks** (M2): chips are rigid bodies you
    carry from the cashier, which means chips can be stolen, thrown and
    dropped.
- **General store (night):** walkie-talkies, energy drinks (refill stamina),
  rope, bungee tie-downs, and odds-shifting junk (M2: lucky rabbit foot,
  loaded dice).
- **The Repo Man** parks his tow truck outside. Pay early at the truck, or
  he collects at midnight.
- **Gus's parts board** (playtest ask: "somewhere at the end where you can buy
  upgrades... make the RV stronger, a better winch"). A chalkboard by his
  bench at the RV lot; E opens his catalogue (shared/shop.js). He fits parts
  at night, once the day is paid, with the RV on his lot (the same rule as his
  repairs: the payment can't be what pays for them). They're the crew's, paid
  from the shared bank, for the rest of the trip; a new trip has a new RV. On
  top of the Garage's parts from Road Cards, which last for good. Six: a
  Reinforced Frame ($450, crashes, beasts and rock -30%), a Heavy-Duty Winch
  ($350, a 60 m cable, 1.5x the pull), a Big-Block V8 ($600, 1.25x the pull,
  20 m/s top end), Mud Tires ($250, 2x the grip and half the drag in mud), a
  Locker Padlock ($150, ringtails can't pry the locker) and a Nitrous Kit
  ($400, N at the wheel: 4 s at 1.7x the pull and +4 m/s, three shots a day).
  Priced against the surplus: on average the bot's first night leaves about
  $2,300, its second about $1,100 more, and days 3 to 5 eat all of it
  (section 8), so a crew that buys the V8 on night 1 is betting it hauls more
  than $600 extra by day 5. test/shop.mjs measures each on the server's
  physics.
- **Hardware at the general store** (playtest ask: a shovel and a metal
  detector that finds metal under the ground). A rack out front: a metal
  detector $250, a shovel $100, the things themselves set down by the rack,
  any hour. Each day has 6 + day caches buried (shared/dig.js, from its own
  random stream off the generated world, so nothing else moves): half within
  ~20 m of a stop (a stop down a side road three times as likely, and its
  caches richer: fewer scrap heaps, more gold and lockboxes), the rest out on
  the canyon floor, never on the road,
  in the mud, on a track or under anything. Held, the detector beeps faster
  and higher within 9 m of one and says DIG HERE inside 1.2 m (its sound is
  sfx.detect: it shared a name with the reversing beep, which drowned it). A
  held shovel digs where you look (LMB, held: a stroke each 0.45 s): each
  stroke goes into the hole within 1.2 m (a new one at a cache in reach, else
  where it landed), the spadeful flung onto the hole's pile (on the digger's
  right), the pit drawn deeper a stroke at a time (its mouth clears the depth
  buffer after the ground is drawn, so its walls and floor show below the
  surface). Six strokes reach the bottom: bare ground has nothing; a cache
  has its chest, which whoever holds E on (within 2.4 m) pulls up: 2.4 s
  alone, shared by up to three, each press 6% more (mashing E beats holding
  it: 81% in a second to 48%). It lands shut on the lip across from the pile;
  E opens it where it lies (a shut chest isn't carried), what was in it pops
  out unharmed (1.5 s with no knocks) and an old chest is left that Ed gives
  $30 for. The page draws the holes from the dig events (the full list on
  joining); the game state carries only the chests down holes and how far
  they're up. What comes up is loot (scrap $40, copper $85, silver $220, coins $300, gold $420, a
  lockbox $560, the day's 22% on top): about $255 a cache by the road and
  $375 down a side road at day 1's prices (test/dig.mjs measures 1.46x over
  25 legs; about one cache in six is down a side road). It's built for two (one sweeps, one digs, and each has
  their hands full), and it costs the time a stop would. Ed doesn't buy the
  gear back; set down in the RV it goes in the locker (which keeps it when Ed
  buys the load), and what's left on the road is gone. test/dig.mjs.
- **Dynamite** (playtest suggestion: dynamite to blow up rocks, and metals in
  them to sell). shared/blast.js. A stick ($60 at the hardware rack, gear) is
  lit with LMB in hand ({ t: 'light' }: the server checks it's held, not in
  town) and goes off BLAST.FUSE (4 s) later wherever it is: in hand, set
  down, or thrown (RMB). The bang: on foot within 2.6 m, knocked out; to
  5.5 m, knocked off your feet (why 'blast': what you held goes flying);
  the RV's walls keep a blast outside off whoever's inside, and one inside
  it knocks them down. Loose things within 5.5 m are thrown (9 m/s right by
  it, nothing at the edge), another stick within 2.2 m goes off with it
  0.15 s later, the RV is dented up to 18% by its distance from the RV's
  body (the Reinforced Frame takes 30%; told as dynamite), shoved, and the
  wildlife scattered (mobs.horn). Seamed rocks: 2 + day a day (oreRocks:
  their own random stream, 9 to 29 m off the road on open ground no more
  than 0.45 m from high to low round it, 25 m apart, never on a cache),
  copper 50%, silver 33%, gold 17%: four-tonne props nobody picks up, fixed
  bodies bedded 0.15 m below the lowest ground under them (seamY; sent to
  the pages once, like anything asleep, so seven of them on day 5 cost the
  snapshots nothing); a blast within 3.2 m of one blows it into its ore
  (copper $70, silver $160, gold $330, the day's 22% on top: a copper rock
  $210 to $280, silver $320 to $390, gold $490 to $820, about $350 on
  average at day 1's prices) and three stones of rubble. Within 4 m of
  the narrows' boulder it's blown into six stones (a second way through),
  and an armed rockfall within 18 m comes down (mobs.rfTrigger).
  test/dynamite.mjs.
- **Looks** (playtest ask: hats, outfits and colours for you and the RV,
  shared by the party, changed only where they were bought). shared/looks.js
  is the catalogue: 9 hats, the 6 outfit kits, 8 tabard dyes (the clothes
  rail left of the general store's door) and 6 RV paints (Gus, at night once
  paid, the RV on his lot, as his parts), $40 to $350. Unlocks are the
  crew's: the room keeps one pool, every player's save adds to it on joining
  and gets the whole pool back ({ t: 'unlock' }), so a hat bought on one trip
  comes along on every later trip with anyone who was aboard. A player wears
  { hat, kit, dye } (each null = what their seat issued), only from the
  pool; the server keeps it on the player as `wearing` (not `look`: that's
  where they're looking) and sends it in the meta, and the page builds the
  character again in it. The dye is the tabard's only: the name tag and
  the portrait keep the player's own colour, which is how the crew tells
  each other apart. Cosmetic only, nothing changes the game. test/looks.mjs.

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
| 1 | $1,000 | 5 | ~$8,400 | 12% (a learning day: surplus to gamble) |
| 2 | $2,500 | 6 | ~$13,500 | 19% |
| 3 | $4,500 | 7 | ~$16,800 | 27% |
| 4 | $7,500 | 8 | ~$22,600 | 33% |
| 5 | $15,000 balloon | 8 | ~$24,300 | 62% (you will be gambling) |

The realistic haul is well short of face value: the clock, stops on mesa tops
you have to climb to, loot that breaks on the way down, the ringtails, the
Grumphorn and the rockfall eating the day, and Ed's 80% for a load sold from
the loading zone.

**Measured** (`tools/econbot.mjs`, October 2026: a crew of three bots plays
whole trips through the real server, the wildlife on, every action a message
a page could send; it carries what lies within 24 m of each stop and below
2.5 m, the heavy things two-handed, as much as the RV holds, and never gambles;
20 seeds):

| Day | Reached | Paid | Pawned that day (mean / median) | Of what was loaded, sold |
|---|---|---|---|---|
| 1 | 20 | 20 (100%) | $3,139 / $3,242 | 98% |
| 2 | 20 | 18 (90%) | $3,600 / $4,170 | 95% |
| 3 | 18 | 17 (94%) | $3,847 / $4,035 | 98% |
| 4 | 17 | 10 (59%) | $5,024 / $4,837 | 98% |
| 5 | 10 | 0 | $4,763 / $4,960 | 98% |

A trip pawns $16,853 on average (median $17,442). Without the casino the bot
reaches day 5 on half the seeds and never pays the balloon: it ends $8,892
short at the median, $1,520 at best. Gambling boldly instead (double or
nothing at the coin flip whenever a payment is short, down to its last $100),
the same crew gets to day 5 on 18 of 20 seeds and pays the balloon on 2: it
wins one trip in ten.

That is harder than these quotas were set for. They were tuned before the
wildlife, the rockfall and the RV's condition existed, against a bot that paid
days 1-3 on every seed and usually day 4; now day 4 is a coin flip without the
casino, and even the casino rarely saves day 5. The bot is a floor, not a
ceiling: it never climbs for loot, ranges no further than 24 m from a stop,
and its boulder shove stalls short of the roadside 8 times in the 85 days it
played. Real crews will haul more where they range further and less where they
argue. Playtests decide (confidence that a practiced human crew out-hauls the
bot: moderate; by how much: low).

On **Bad Credit** (payments +15%, tougher wildlife: veteran crews) the same
bold crew on the same 20 seeds (`econbot --tier bad --casino bold`) paid day 4
on 14 of the 19 trips that reached it (Standard: 18 of 19) and reached day 5
on 14 (Standard: 18): the 15% bites where it should. It paid the balloon on 4
of 20 (Standard: 2 of 20), but twenty seeds can't tell those apart (95%
intervals of about 8-42% and 3-30%): Bad Credit doesn't shut a bold crew out,
and the casino's swings swamp the rest. The bot barely meets the tougher
wildlife (ringtails stole nothing from it on either terms), so for human crews
Bad Credit will cost more (confidence: moderate).

- Every casino game has a house edge (blackjack about 1–2% played sensibly,
  craps 1.4%, the coin flip 3%, a Derby ticket 5%). The casino is variance you
  choose, never free money.
- Medical bill: $250 + $50 × day per KO, unless a friend picks you up.
  Getting run over by your own RV: $500. RV on its back for 7 seconds: an
  $800 tow, and the truck sets it back on its wheels on the road nearby
  (never past a gate, the mud, the boulder or a grade).
- Missing a payment: the Repo Man takes the RV. The run is over.
- Gus's repairs: 25% of the RV's condition a press, $8 a point rising 22% a
  day like the loot (days 1-4: $200 / $245 / $290 / $330 cash, or $250 /
  $305 / $360 / $415 on the next day's payment; night 4's goes on the
  balloon, so the first press only says what it'll cost). Nothing heals
  overnight but Gus.

### 8.1 Records and the save

Every trip is timed and counted, so there's something to beat next time besides the Repo Man:

- **Road time**: the clock at each day's payment less 6:00, added up over the five days (a payment
  made by midnight's auto-pay counts 18 hours), shown as real time at 45 s a game hour. Paying at 2 PM
  every day is 40 game hours, 30:00. **Fastest payoff** counts wins only; **best payment times** keep
  each day's earliest payment on any trip.
- **Biggest haul**: everything pawned on a trip that paid days 1 to 4 (the skill number), with what was
  left after the balloon and the casino's net beside it. **Cleanest delivery**: the RV's condition when
  the balloon was paid.
- **Whose**: each player's own save. A crew (everyone aboard from day 1's departure to the end, known
  by hashes of their profile ids) has its own tally, the 12 most recent kept. A trip counts toward
  your records only if you were aboard when the RV left camp on day 1 and still aboard at the end;
  lifetime counters (trips, wins, days paid, money pawned, knockouts, friends picked up, RV damage as
  the driver, Gus's bills) take every trip.
- **Practice**: a trip from a typed menu seed counts only on that seed's board (the 20 most recent).
  A trip on a server with test switches (a fast clock, test levers, the wildlife off) or with a test
  lever pulled records nothing. The automatic next trip always has a seed of its own.

The save (`shared/profile.js`) is a few KB of JSON on the player's own machine: the desktop build's
`save/profile.json` (written atomically, the last one kept as `profile.bak.json`, an unreadable one
moved into `save/corrupt`), or the browser's localStorage. It carries a random profile id (never a
Steam id) and an FNV-1a sum that catches a torn write. It's the player's: they can edit it, and the
host's server only ever takes the profile id and the win count from it. The server sends each player
a summary of every trip they were on and holds it, by profile id, until their page says it has it, so
a player who dropped gets theirs when they come back. The desktop host is asked before leaving while
a friend's summary is still waiting.

## 9. Voice and communication

- **Proximity voice:** an HRTF panner placed at the speaker's head. Full
  volume within 4 m, fading to silence by 25 m (`shared/constants.js` VOICE;
  the host relays a voice to 27 m). Everyone in the RV hears everyone; a stop
  can shout to the RV; across town, or up on the canyon rim, takes a walkie.
- **Occlusion:** if terrain or the RV body sits between two heads, the voice
  is low-passed. Players inside the RV hear each other clearly and hear
  outsiders muffled.
- **Walkie-talkies** ($150 at the store): hold T to transmit to every walkie
  holder, at any range, through a band-passed, crackly radio filter.
  Communication becomes something you have to *buy*.
- **KO'd players** sound muffled, like talking face-down in the dirt,
  because they are.
- **Information that only one person has:** the map (only its holder sees
  it; each morning draws the day's driver and navigator, locked till the
  next morning: only the navigator takes the map, only while the driver
  drives, and the driver never sees it; if one of them drops out or goes
  AFK, anyone stands in till they're back), gate codes (only the climber sees them), the road ahead (only the
  driver sees it, and badly), what's behind the RV (only the person on the
  roof).
- There is no text chat. There are pings and emotes.

### 9.1 Music under the voices

The game is talked over, so its music has to get out of the way: the risk is a score fighting the
proximity chat for the same ears (the reason Lethal Company and Peak lean on ambience). So
(`client/js/score.js`, played by `client/js/western.js`):
- **A tune per place**, in verses of about a minute (twice round a 16-bar tune), then a rest of 25-60 s
  with only the wind and the wildlife. The Westmeadow Road (Travis-picked guitar, harmonica, G, 92 bpm),
  the fields (banjo rolls, fiddle, train beat, D, 116), the snowy pass (a whistled waltz, D minor, 84,
  in 3/4), the badlands (pedal steel over a twangy baritone arpeggio, A minor, 80), Lost Wages (a
  spaghetti western: tremolo baritone, castanets, choir, whistle, E Phrygian dominant, 68); the night's
  lullaby in the day's key; the menu's main theme on the full band.
- **Layers that answer the game**, coming in at once and leaving slowly: tension (a sleeping Grumphorn
  within 25 m, one waking or glaring within 45 m, the last 40 minutes before midnight), danger (a charge
  within 60 m, a rockfall: the gallop, a low riff, the fiddle sawing; the tune ducks out of its way in
  a fifth of a second), mischief (ringtails sneaking, snatching or raiding within 32 m), the clock (the
  two hours before midnight till the payment's made). Stings off the beat: the whip as a charge
  starts, a swell when one wakes, a pizzicato run on a theft, a slide whistle when you're knocked out,
  a lick when the payment's made.
- **It gives the floor away:** to the RV's radio when you can hear it (the radio itself is turned down
  under a charge), to the casino's band within 45 m of it, and to anyone talking (it ducks 6 dB while
  anyone near you speaks). Knocked out, it's under water like the voices. Settings: Music while you
  play.
- Each biome's ambience has its own wildlife too (`client/js/ambience.js`): a woodpecker and frogs in
  the meadow, crows over the fields, ravens and a wolf on the pass, cicadas and coyotes in the badlands
  and the desert, a rattlesnake in the desert.

## 10. Comedy engines

Things the systems will produce without being scripted:

- The TV breaking in the back on a hard turn ("WHO LEFT IT ON THE TABLE").
- Falling off the roof at 30 mph.
- Running over your friend: a $500 bill, and the toast names the driver.
- "CRUNCH. Sam put the RV into the ranger gate: -18%." The receipt that
  night: "RV 58% (-34% today: Sam -18%, the Grumphorn -8%, rocks -9%)".
- Broken down 700 m from town at 22:00, three people holding E at the back
  of the RV while the driver yells at them.
- Going ALL IN on the coin flip with the payment money at 23:58.
- Going ALL IN on blackjack with the payment money at 23:58, and losing the
  RV with it.
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
- **Health bars, weapons, aim combat.** The wildlife is fought with the verbs
  the game already has (grab, throw, shove, the RV, the winch, the horn), and
  it costs time and loot, and dents in the RV, never the bank directly. The
  RV's condition is the one bar in the game, and it never ends a run. The antagonists are still the Repo
  Man and gravity.
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
    direction) sent while you walk into it, or while your hands are on the
    RV (E on its outside, then W; client/js/main.js pushStep: playtest, the
    walk-into push was never explained), that the server turns into a set
    force, whatever the page sends. Player proxies on the
    server are sensors only, so a player standing in the road can't stop a
    3-ton RV like a wall. Instead the RV knocks them flying.
- **Shared deterministic world generation** (`shared/world.js`): the server
  and every client build identical terrain from the seed. No meshes go over
  the wire.
- **Voice** is Opus over the game's own connection (WebCodecs), relayed by
  the host only to players within earshot (27 m) or on a walkie, then routed
  through WebAudio: panner (HRTF), distance fade (silent by 25 m), occlusion
  low-pass, and a radio band-pass path for walkies. Nothing peer-to-peer.
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
| **M1: vertical slice** (this branch) | First-person body, grab/carry/throw, climbing and stamina, KO and bills; the RV with driving, riding, pushing and the winch; loot and fragility; five generated legs in five biomes with the Grade, Boulder, Mud and Ranger Gate; a hand-painted art pass; a town with pawn, blackjack, double-or-nothing and the Repo Man; 5 days with quotas; repossession on the first miss; the paper map; walkies; spatial voice |
| **M2: content** | Route forks, more biomes (the Strip, a swamp, a coast), the ledge road, the washout gap, about 30 loot items, slots, physical roulette chips, store items, a fuel can loop, flat tires |
| **M3: feel** | Real ragdolls, a procedural radio with stations in the RV, better animation, weather (dust storms kill visibility, so there's more talking), night driving with headlights |
| **M4: ship** | Steam build, Steam networking, achievements, daily trip seed leaderboard ("lowest medical bills"), a $5–8 price point |

### What M1 actually contains (as built, October 2026)

All of this is implemented and covered by `test/logic.mjs` (60 server checks
over real WebSockets) and `test/smoke-browser.mjs` (two real Chromium clients):

- Seeded 5-day runs through five biomes (meadow, fields, snow, badlands,
  desert), each with its own town style. Each leg has a camp, a road through
  canyon walls (the desert: dunes), buttes, 4–8 stops, 2–5 obstacles (grade, mud, boulder, ranger
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
- Casino: a game each on one bank (blackjack seats, craps, two double-or-nothing machines, the Ringtail Derby). Store: walkie-talkies,
  energy drinks, bungee tie-downs, a hard hat, a cheese wheel (bait).
- The Repo Man (one missed payment ends the run), night receipts, sleeping, and both
  endings.
- Proximity voice with occlusion, KO muffling, and the walkie radio path.
- The wildlife and the road's dangers: the Grumphorn (days 2–5), Ringtails at
  the stops (with RV raids and den nips from day 2), rockfall at the narrows
  (days 3–5), the shove, bracing, and beanings when you hit a friend.

Not yet built (M2+): route forks, the ledge road, the washout gap and planks,
slots, physical roulette chips, odds-shifting items,
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
   day's textures get ready behind the night scene (its world data is
   generated by the morning build, under the loading bar: generating it at
   night would be one long main-thread task, a hitch). Since a
   day now loads for seconds, the messages that come in meanwhile (loot
   breaking or pawned, toasts, your seat) wait for the
   new world and run in the order they came, as when the build ran straight
   after the world message; `tools/joinrace.mjs` checks a joining player and
   a new day against the server's props, and `tools/dayrace.mjs`
   a day that changes again mid-load (what came for the old day is dropped).
   A paint worker that is slow to start (a starved machine) doesn't hold the
   build up: the page paints meanwhile, and the worker joins the pool when it
   is up and stores what the page painted (`tools/texfaults.mjs`, 'slow').
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

- Gamble With Your Friends: [games.gg overview](https://games.gg/gamble-with-your-friends/), [KeenGamer](https://www.keengamer.com/games/gamble-with-your-friends/), [GosuGamers: 1M in a week](https://www.gosugamers.net/entertainment/news/78409-gamble-with-your-friends-sells-one-million-copies-in-a-week), [Gamereactor](https://www.gamereactor.eu/the-latest-friendslop-hit-is-here-as-gamble-with-your-friends-sells-a-million-copies-in-less-than-two-weeks-1716843/)
- PEAK: [Game Informer review](https://gameinformer.com/review/peak/a-brilliant-co-op-climbing-adventure), [Outlook Respawn: 10M units](https://respawn.outlookindia.com/gaming/gaming-news/from-game-jam-to-10-million-units-indie-hit-peak-success), [TweakTown: hot tub / Airbnb origin](https://www.tweaktown.com/news/106032/comedy-climber-peak-was-conceived-in-a-hot-tub-and-developed-in-an-airbnb/index.html), [PCGamesN: revive](https://www.pcgamesn.com/peak/revive)
- R.V. There Yet?: [Steam](https://store.steampowered.com/app/3949040/RV_There_Yet/), [Pure Xbox review roundup](https://www.purexbox.com/news/2026/06/rv-there-yet-is-available-today-with-xbox-game-pass-and-heres-what-the-reviews-are-saying), [Notebookcheck](https://www.notebookcheck.net/This-new-party-game-costing-only-8-with-proximity-based-voice-chat-is-blowing-up-on-Steam.1153790.0.html), [Deltia's controls guide](https://deltiasgaming.com/rv-there-yet-keybinds-and-controls-guide)
- Meccha Chameleon: [Windows Central](https://www.windowscentral.com/gaming/the-viral-hit-of-2026-has-sold-15-million-copies-in-a-month-on-steam-costs-usd5-and-was-made-by-2-people), [Digital Citizen](https://www.digitalcitizen.life/meccha-chameleon-sells-15-million-copies-on-steam-in-less-than-a-month/)
- We Were Here: [Thinky Games](https://thinkygames.com/games/we-were-here/), [IGF](https://igf.com/we-were-here)
- R.E.P.O.: [Valuables wiki](https://repo-2025horror.fandom.com/wiki/Valuables), [Dot Esports: extraction](https://dotesports.com/indies/news/how-to-extract-in-r-e-p-o)
- Friendslop as a term: [Know Your Meme](https://knowyourmeme.com/editorials/guides/whats-the-term-for-games-like-lethal-company-and-repo-people-calling-co-op-games-friendslop-explained), [AV Club](https://www.avclub.com/not-every-co-op-game-is-friendslop)
