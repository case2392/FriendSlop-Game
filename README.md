# NO MONEY DOWN

> You and the boys bought a $250,000 motorhome with no money down.
> Payments are due every night. None of you have jobs.

A 1–6 player **first-person co-op road trip**, built for proximity voice and
bad decisions. Drive the Slopmaster 9000 across five days of procedurally
generated road (green meadows, golden farmland, a snowbound pass, red canyon
country, open desert), scavenge fragile junk, climb, winch, shove, gamble the
shared bank account, and pay the Repo Man by midnight, every night. Miss one
payment and he takes the RV.

![riding in the RV while your friend drives](docs/screenshots/riding.jpg)

| | |
|---|---|
| ![the crew at camp](docs/screenshots/camp.jpg) | ![winching the RV up a washed-out grade](docs/screenshots/winch.jpg) |
| **Morning camp.** The clock doesn't start until the RV rolls out. | **The Grade.** Too steep to drive. Somebody climbs up with the winch hook. |
| ![climbing a canyon wall](docs/screenshots/climbing.jpg) | ![the code painted on the canyon rim](docs/screenshots/rim-code.jpg) |
| **Climb anything steep**, on a stamina bar (PEAK rules). | **The ranger gate code** is painted up on the rim. Shout it down. |
| ![carrying a CRT TV](docs/screenshots/carrying.jpg) | ![the paper road map](docs/screenshots/map.jpg) |
| **Fragile physics loot.** Every bump costs money. | **One paper map, and the driver can't see it.** Each morning picks a driver and a navigator; the navigator calls out the road. |
| ![body-vote blackjack](docs/screenshots/casino.jpg) | ![the pawn counter](docs/screenshots/pawn.jpg) |
| **The Lucky Slop.** Bet the *shared* bank, vote HIT/STAND with your body. | **Honest Ed's Pawn.** Put it on the counter, ring the bell (or park in his loading zone: he buys the whole load). |
| ![the Repo Man](docs/screenshots/repo-man.jpg) | ![night at the campfire](docs/screenshots/night.jpg) |
| **The Repo Man** collects at midnight. | **Night.** Receipt, campfire, store, bunks, day 2. |

## Wildlife

From day 2 a **Grumphorn**, a one-ton shaggy beast with curled horns and a brass cowbell, sleeps on the
road past one of the obstacles (two on day 5). A yellow sign warns you, the navigator's map marks it, and
you hear it snoring. Walk up to it standing, sprint near it, drive past fast, stand up in the RV going
by, or honk, and it wakes, glares, fixes a line and charges down it. The first person in its horns goes
flying (knocked out: pick them up within 20 s or it's the doctor's bill); anyone else it brushes stumbles.

It has no health bar, only **patience**. Sneak past crouched, creep the RV by, or wear it out: throw junk
at it, shove it, ram it with the RV (everyone crouch to brace first), winch it. Each charge and each toss
costs it patience too. When it runs out, it drops its cowbell (worth $205 to $320 at the pawn shop) and
walks off the road for good. It never touches the bank, leaves alone anyone who is down (and whoever
kneels by them), and knocks out at most one player per charge.

Every day, **Ringtails** (raccoon-sized bandits with black masks and ringed tails) live in dens beside
some of the stops: one den on day 1, three by day 5, marked with paw prints on the map. They sneak up on
loot nobody is watching, grab it and run it home to their pile. Stand facing your loot and they keep
their distance. Catch one and it drops what it took (from day 2 it bites if you hold it alone: hold it
with a friend); shove it or hit it with something and it's stunned; honk and they scatter; run one over
and it's squashed flat for a while. A den only steals so much a day, and everything it took is still
there at its den: go and get it back. The tracker says what they're holding of yours.

## Five days, five places

Every day is a different biome with its own ground, sky, fog, rocks, plants
and town. You never see the same place twice in a run.

| Day | Road | Looks like | Town |
|---|---|---|---|
| 1 | The Westmeadow Road | Green meadows, huge gnarled oaks in groves, gray outcrops | **Paydirt**: timber-framed plaster, red shingle roofs |
| 2 | Goldenfield Pike | Golden grass, fenced wheat and stubble fields with round bales, a windmill | **Busted Flats**: plank barns and farmsteads |
| 3 | Frostpeak Pass | Snowfields, snow-laden pines, blue-gray granite | **Last Chance**: squat stone halls, iron braziers |
| 4 | The Redrock Badlands | Red strata, hoodoos, buttes, dead trees | **Snake Eyes**: log and plank outpost, palisades, hides |
| 5 | The Lost Wages Flats | An open sea of dunes, sandstone arches and buttes, palms, bleached bones | **Lost Wages**: adobe, vigas, canvas awnings, goblin brass |

| | |
|---|---|
| ![day 2, the fields](docs/screenshots/biome-fields.jpg) | ![day 3, the snow pass](docs/screenshots/biome-snow.jpg) |
| ![day 4, the badlands](docs/screenshots/biome-badlands.jpg) | ![day 5, the desert](docs/screenshots/biome-desert.jpg) |

**The look** is a 2004 hand-painted MMO zone: chunky low-poly models with
smooth shading under painted textures with the light baked in, warm and
slightly hazy. No image files ship with the game. Every texture (grass,
shingles, bark, faces, the pawn shop's sign) is painted on a canvas by code
when the game loads. Layers of blotches, strokes, lit edges and soft
shadows are built up the way a texture artist would paint them. The rules
are in **[docs/ART.md](docs/ART.md)**.

## Why this game, and not the last one

This repo's first attempt (THE SLOP PIT) was six two-minute homage minigames
on a 2D plane with one verb (dash). It wasn't fun, and **[docs/DESIGN.md](docs/DESIGN.md)**
explains why and what replaced it. The short version: every friendslop hit is
*one deep physics verb + proximity voice + shared stakes under a clock*, so
this game has one spine (the RV road trip) and steals one verb from each
classic:

| From | We took |
|---|---|
| **PEAK** | Climb any steep surface on stamina. Carried weight shrinks your bar. Lunge for holds. Knockouts, friends picking you up, campfire nights. |
| **R.V. There Yet?** | A shared physics vehicle you all ride inside. A front winch you carry to an anchor and reel in. |
| **Gamble With Your Friends** | One shared bank account, one debt, a nightly payment, physical casino games anyone can bet. |
| **We Were Here** | Information only one person has: the paper map, the gate code on the rim, the driver's blind spots. Walkie-talkies cost money. |
| **REPO / Lethal Company** | Fragile physics loot that loses value when it gets bumped. Haul it back to the vehicle. A quota collector. |

## Play it

**The desktop build (the one for Steam):**

```bash
npm install
npm run desktop    # with Steam running: friends join by trip code or Steam invite
```

One person clicks **Host Game** and reads out the 4-digit trip code at the top
right of their screen (it's on the `Esc` menu too). Friends type it under
**Join Game**, and their game finds the trip through Steam. Steam invites work
too: **Invite Friends** (press `Esc`), or **Join Game** on the host in the
Steam friends list. The host's PC runs the trip, and everyone talks to it over
Steam, so there is nothing to port-forward. Without Steam running it plays
solo. How the Steam build works, and how to ship it:
[docs/STEAM.md](docs/STEAM.md).

**The browser build (LAN and development):**

```bash
npm start          # → http://localhost:3000
```

One person clicks **Host Game** and sends the 4-digit trip code; everyone else
types it under **Join Game**. Click the window to grab the mouse; **F1** shows controls, `Esc`
frees the mouse and offers Leave Trip. To replay the same roads, put the same
number in "trip seed". A dropped connection gets its seat back if it returns
within 90 s.

**The first load takes a while.** Every texture is painted and every mesh is
built in your browser. Background workers paint what they can while the
loading bar is up, your browser keeps the painted textures (IndexedDB) so
the next visit decodes them instead, and the next day gets ready during the
night. On a machine with no GPU (software rendering on 4 CPU cores), from
"Host Game": the first visit draws its first frames after about 23 s, a
returning visit after about 22 s (its world is built in about 6 s), and a
later day takes 9–14 s. Most of the rest on that machine is the software
renderer drawing its first frames; a real graphics card does that much
faster, but we haven't measured it. Use a browser with hardware acceleration
on.

| | |
|---|---|
| `WASD` `Shift` `Space` `C` | walk · sprint · jump · crouch (in the RV: **brace**, a crash can't knock you out) |
| **hold `LMB`** | **GRAB**: loot, or any steep rock or wall to **climb** it (`Space` = lunge) |
| `RMB` · `Q` · wheel | throw (empty-handed: **shove**) · drop · hold distance |
| `E` | use: driver seat, door, winch, pawn bell, casino buttons, keypad, bunk. Hold it on a knocked-out friend to pick them up. |
| driving | `WASD` · `Space` brake · `R` reel the winch · `H` horn · `E` get up (the RV keeps rolling) |
| `MMB` · `1-6` | ping · emotes |
| `V` · `M` · `T` | push-to-talk · mute · walkie-talkie |

**A day:** each morning picks a driver and a navigator at random (whoever
has done a job less is likelier to get it), locked once the RV leaves camp
(if one drops out or goes AFK, anyone stands in till they're back) → leave
camp → follow the road (the driver can't see
the map: the navigator reads it out, matching the odometer to its 100 m
marks; alone, you drive without it) → deal with
what's broken (winch up the grade, push out of the mud, shove or winch the
boulder, crack the ranger gate) and with what lives there (see Wildlife below)
→ detour to stops for loot → town: pawn it,
gamble it, pay the Repo Man → campfire, store, everyone in a bunk → next day.
Five days, and the payment due at midnight grows each day ($1,000, $2,500,
$4,500, $7,500, then the $15,000 balloon). Pay the balloon on day 5 and you own
the RV. Come up short on any night and he takes the RV: the trip is over.

## Voice

Hit **JOIN VOICE**. It's **proximity chat**: each voice is Opus audio sent
over the game's own connection, and the host passes it only to the players who
can hear it, who hear it through a 3D HRTF panner at the speaker's head. It's at full volume within
4 m and gone by 25 m (everyone in the RV hears each other; across a stop or a town, nobody does), gets
muffled when terrain or the RV is between you, and sounds face-down when
someone's knocked out. **Walkie-talkies** ($150 each at the general store) reach
anyone else who owns one, at any range, through a crunchy radio filter. Hold
`T`. Play on the game's voice, not a call: who hears you is half the game.

Nothing is peer-to-peer, so nobody's router gets in the way and nobody sees
anyone's IP address. In a browser, mics need a secure context (https or
localhost): for LAN play put the server behind any TLS tunnel (Tailscale,
cloudflared, ngrok) or reverse proxy. The desktop build doesn't have this
problem.

## How it's built

```
shared/   world.js     seeded deterministic leg generator: biome, terrain, road, obstacles, stops,
                       town, decor, and every collider (trees, rocks, shelves, yard props)
          rv.js        the RV's collider layout (server body, client copy and renderer all use it)
          loot.js      loot catalog: mass, value, fragility, carry class
desktop/  main.cjs     the desktop app (Electron): the window, the game server in its own process,
                       Steam (lobbies, invites, rich presence); steam/: friends' traffic over Steam P2P
server/   host.js      every connection (the host's page, friends over Steam, browsers): rooms, kept
                       seats, rate limits, the voice relay; index.js runs it for the browser build
          sim.js       Rapier 3D physics: heightfield, RV on raycast wheels, loot, grab springs,
                       push intents, winch cable + anchors + reel, impact damage, run-over checks
          room.js      the run: days, clock, shared bank, pawn, casino, store, Repo Man, KO bills
          casino.js    body-vote blackjack + double-or-nothing
client/   player.js    first-person controller: walk/sprint/jump, stamina climbing, riding the
                       moving RV (RV-local coordinates), lurching when it brakes, knockouts
          phys.js      local Rapier world of kinematic copies, for the controller
          paint/       the texture painter: core.js (brushes, blotches, strokes, seamless blur)
                       plus one family per domain (terrain, nature, architecture, vehicle,
                       characters, props, roadside, ui)
          texprep.js · texcache.js · paint/worker.js   textures ready before a day builds: paint
                       workers, the browser's texture cache (IndexedDB), the night's prefetch
          gfx.js · atmosphere.js     lights, sky, fog, clouds, horizon rings, day/night per biome
          terrain3d.js               splatted painted ground, cliffs, ground clutter
          nature3d.js                oaks, pines, palms, hoodoos, buttes, arches, boulders, cacti
          town3d.js · town_build.js · town_kit.js · town_yard.js   five town styles, interiors, NPCs
          roadside3d.js              the stops, gates, camp, anchors, junk, the dino
          rv3d.js · props3d.js · people.js · labels.js   the RV, loot, characters, painted signs/HUD
          voice.js     Opus voice over the game connection + spatial audio · sfx.js: synthesized sound
tools/    docshots.mjs  the README screenshots · scene.mjs  named in-game viewpoints per day
          gallery.mjs   every texture, tiled to show seams · preview.mjs  single 3D assets
          drive-test.mjs  headless autopilot down a leg (RV handling)
          loadtime.mjs  load-time numbers · texhash.mjs · texgame.mjs · texfaults.mjs  the
                       texture cache and paint workers give the same pixels, under faults too
          joinrace.mjs  loot that breaks while a day loads: clients still match the server
          dayrace.mjs   a day that changes again mid-load: nothing of the old day leaks into
                       the new one (npm run test:race runs both)
```

- **Server-authoritative world, client-authoritative bodies.** The server
  simulates the RV, the loot and the winch at 60 Hz and snapshots at 20 Hz.
  Each client moves its own body through a local copy of the same seeded
  world with Rapier's character controller, so there's no input lag, and
  reports its pose. A grab is a spring force from your hand on the server, so
  two people carrying one safe just works.
- **Zero assets.** Every mesh, texture and sound is generated. The world is
  regenerated from a seed on every machine, so no geometry crosses the
  network. Trees, rocks and props are drawn from the colliders world gen
  made for them (an oak's bole, a hoodoo's column, a boulder's top), so the
  big things you see are the things you bump into.

## Tests

```bash
npm test
```

- `tools/namecheck.mjs` fails if another game's place names or a real brand
  get into the text players can see (the store and the Steam agreement need
  everything shipped to be ours).
- `test/logic.mjs` plays a whole run over real WebSockets with two fake
  players and real physics (60 checks). It drives, carries and throws a vase
  (it chips), cracks the ranger gate, winches the RV up the grade, pawns a
  TV, wins or loses blackjack by standing on a pad, flips double-or-nothing,
  buys a walkie, pays the Repo Man, sleeps into day 2, gets billed for a KO,
  gets revived for free, gets run over, misses a payment and is repo'd on the
  spot, starts over, and wins on day 5.
- `test/server.mjs` checks what keeps an evening going when connections
  misbehave: kept seats, malformed frames, floods, a different build, silent
  connections, the goodbye when the server shuts down.
- `test/steamnet.mjs` plays over a stand-in for Steam (`test/fakesteam/`):
  invites, the version check, a dropped link coming back to its seat, voice,
  packet loss, the host quitting or crashing.
- `test/smoke-browser.mjs` runs two real Chromium clients in one room. They
  join through the menu and see each other. One drives while the other rides
  inside, and the passenger stays glued in on both screens. They carry a TV,
  climb a canyon wall, read the map to the driver (only the day's navigator
  takes it, only while the driver drives, and the driver's screen never shows
  it), play blackjack by
  body-vote, talk over proximity voice, drop and get their seat back. The
  test fails on any page error.
- `npm run test:desktop` drives the real desktop app (needs a display, or
  `xvfb-run`): the locked-down shell, a trip, Quit, and two copies of the app
  joining each other over the stand-in Steam.
- After `npm run dist`, `node tools/depotcheck.mjs` checks the packaged
  folders before a Steam upload.

`FRIENDSLOP_FAST=1` speeds the clock up, and `FRIENDSLOP_TEST=1` enables test
levers (teleport the RV, set the clock). Don't set either in production.

The previous game, THE SLOP PIT, lives in git history at `a8cfdb1`.
