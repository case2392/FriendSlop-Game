# 🫠 FRIENDSLOP

> six levels down. every one a classic. don't bust.

A 2–8 player **3D co-op party game**. You and the boys are little slop-people
(chunky ragdolly humanoids in dumb hats) escaping a living dungeon called the
Slop Pit — **six chambers, each one an homage to a friendslop classic**.
Between chambers you hang out in **The Den**, a walkable casino-carpet hub:
no menus, no buttons — walk the squad into the glowing gate to start the next
level.

| | |
|---|---|
| ![are we slop yet](docs/screenshots/v5-rv.png) | ![the chameleon](docs/screenshots/v5-cham.png) |
| ![the casino](docs/screenshots/v5-casino.png) | ![the peak](docs/screenshots/v5-peak.png) |

## The expedition

Six chambers, in order, all co-op. Clear one and the gate to the next opens.
Clear all six and the boys escape. Fail and you run it back — the pit collapses
after 20 attempts, so every retry counts.

1. ⛏️ **THE DIG SITE** — *an homage to Keep Digging.* Start on the sunny green
   grass of **SLOPSHIRE** (a certain vanilla village, inn and all). Dash the
   ground to crack it, drop through, repeat — and as you dig, the world and
   YOUR CHARACTER de-make era by era, until you splash down blocky and
   flat-shaded into **THE GRAND SLOPCHANGE** (a certain grand marketplace,
   merchants yelling "buying gf 10k" included). Everyone to the bottom.
2. 🚐 **ARE WE SLOP YET?** — *R.V. There Yet?* The RV doesn't drive. PUSH IT
   across the pit — through mud, past gremlins shoving it backwards.
3. 🦎 **THE CHAMELEON** — *Mecha Chameleon.* One statue is alive and wearing a
   friend's face. Watch for the twitch, dash the real one. Wrong smashes cost
   shared lives. Three catches to clear.
4. 🎩 **THE BOSS'S CASINO** — *Gamble With Friends.* The Pit Boss deals
   blackjack to the whole squad. Vote with your BODY — stand in the HIT or
   STAND floor zone. Majority rules, ties hit. Win 2 hands before busting out.
5. ⛓️ **CHAINED TOGETHER** — *Chained Together.* A torch-lit cavern climb: the
   pit chains the squad, the glowing slop tide rises below, and one slip drags
   everyone. The only chained level — by design.
6. 🏔️ **THE PEAK** — *PEAK.* The finale free solo at alpine dawn: no chain,
   snow-capped ledges, drifting clouds, falling slop, a distant mountain range.
   Every climber to the summit and the Slop Pit is history.

Money flows on every clear (+MVP and unused-life bonuses) — richest slop at
the end gets bragging rights, but escape is the win.

## Play it right now

```bash
npm install
npm start          # → http://localhost:3000
```

One person **HOSTS**, sends the 4-letter room code to the boys, everyone else
**JOINS** — you all drop straight into the Den. Short on friends? The host can
add **bots**: they dig, push, pounce, climb single-file, and vote at the
casino with their own bodies.

**Controls:** click the world to mouse-look · WASD to walk (camera-relative) ·
SPACE/SHIFT to dash · 1–6 emotes (they play on your body — try 💀) ·
M mute mic · V push-to-talk

## Voice chat

No text box — the boys **talk**. Hit **🎙 JOIN VOICE** (bottom-left) and
you're in: audio is **peer-to-peer WebRTC** between players, the game server
only relays the handshake. A 🔊 pops over whoever's talking.

The ⚙️ settings panel has everything you'd expect:

- **Mic picker** — choose any input device, hot-swappable mid-game
- **Open mic / Push-to-talk** — PTT is hold-**V**; **M** toggles mute in either mode
- **Master volume** plus a **per-player volume slider and mute** (for that one loud friend)

One rule from the browser, not from us: microphones only work on **HTTPS or
localhost**. Playing on your LAN via plain `http://192.168.x.x:3000` won't get
mic access — put the server behind a tunnel (Tailscale, cloudflared, ngrok) or
any https reverse proxy and voice lights up. The Electron/Steam build doesn't
have this problem.

To play over the internet, run the server on any $5 VPS / Fly.io / Railway box
and share the URL — it's a single Node process.

## What's in the box

```
server/            authoritative game server (Node + ws, 30Hz sim, 20Hz snapshots)
  room.js          the Den + expedition state machine
  blackjack.js     the Boss's deck (pure logic, unit-tested)
  minigames/       one file per chamber — same interface, easy to add more
  bots.js          squad AI for every chamber + hub life
client/            Three.js 3D client — no build step, no assets, all procedural
  js/render.js     the world: Den, six chambers, ragdoll characters, cards
  js/sfx.js        WebAudio-synthesized sound (zero audio files)
shared/            constants shared by both sides
electron/          desktop shell for the Steam build
docs/GAME_DESIGN.md  design doc · docs/STEAM.md  step-by-step Steam shipping guide
test/              full-expedition integration test + Chromium smoke test
```

## Tests

```bash
npm test
```

- `test/logic.mjs` — unit-tests the blackjack engine (3000 hands), then plays a
  full expedition over real WebSockets: walks blobs into gates, digs, pushes,
  body-votes at the casino, climbs, reaches the podium, handles disconnects.
- `test/smoke-browser.mjs` — real Chromium pages host/join via the UI and walk
  the entire expedition on autopilot; fails on any console error.

`FRIENDSLOP_FAST=1` shrinks every timer so a full expedition runs in ~30s.

## Steam

See **[docs/STEAM.md](docs/STEAM.md)** — Electron packaging, Steamworks setup,
achievements, depot upload, launch checklist.
