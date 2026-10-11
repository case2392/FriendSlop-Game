# NO MONEY DOWN on Steam

How the Steam build works, and the steps from this repo to friends playing it. The steps marked
**(you)** need your Steamworks account: everything else is already in the repo.

## How it works

- **One app, no servers to rent.** The desktop build (Electron) carries the whole game: the page, and
  the game server, which runs on the player's own PC in a background process (`desktop/main.cjs`,
  `desktop/server-process.mjs`). Whoever starts a trip *is* the server for it.
- **Friends join through Steam.** Starting a trip opens a friends-only Steam lobby. Friends join with
  **Invite Friends** (press Esc in the game), the Steam friends list's **Invite to Game**, or **Join
  Game** on the host in their own friends list. Their game talks to the host's over Steam's P2P
  network (`desktop/steam/`): no port forwarding, no IP addresses, Steam's relays handle the routers.
- **Voice chat** rides the same connection (Opus, 24 kbit/s): the host's game passes each voice on only
  to the players who can hear it (within earshot, or both holding walkies). Nothing peer-to-peer.
- **The same version on both ends.** Every build carries a fingerprint of the game code
  (`server/build.js`); a friend on a different version is told so, plainly, before anything loads.
  Steam updates everyone to the same build, so this only bites when one of you hasn't restarted Steam.
- **Dropped connections:** a friend whose connection drops gets their seat (and walkie, and color) back
  if they're back within 90 s. If the host quits, everyone is told the trip is over.
- **No Steam running:** the game still starts and plays solo, and the menu says why friends can't join.
- **The browser build** (`npm start`, then `http://localhost:3000`) still works for development and
  LAN play, with 4-letter trip codes.

## Try it before you have an App ID

The repo uses Valve's public test app, **Spacewar (480)**, until you put your own App ID in
`package.json` (`"steamAppId"`). With Steam running and logged in:

```bash
npm install
npm run desktop        # the desktop build, from the repo
```

Two PCs, two Steam accounts that are friends, both running `npm run desktop`: one starts a trip and
presses Esc, then **Invite Friends**. (Steam shows the game as "Spacewar" until you have your own App
ID. That's normal.)

Useful launch options, for `npm run desktop -- <option>` or Steam's Launch Options box:
`--windowed`, `--fullscreen`, `--no-steam` (solo, Steam ignored), `--devtools`.

The log of the last run is `main.log` in the game's folder in your user profile:
`%APPDATA%\NO MONEY DOWN\logs\` on Windows, `~/.config/NO MONEY DOWN/logs/` on Linux.

## 1. Steamworks (you, once)

1. Join [Steamworks](https://partner.steamgames.com) and pay the Steam Direct fee ($100 per game,
   paid back to you once the game earns $1,000). You get an **App ID**.
2. Put the App ID in `package.json`: `"steamAppId": 1234560`.
3. **SteamPipe > Depots**: one depot for Windows (Steam makes the first one for you: usually the App
   ID + 1). Set it to Windows. Note its ID.
4. **Installation > General**: a launch option: executable `NoMoneyDown.exe`, operating system Windows.
5. **Community > Rich Presence**: upload `steam/richpresence_english.vdf` (what friends see next to
   your name: "Day 2 of 5 · driving Goldenfield Pike").
6. **Steam Deck and Linux**: Proton runs the Windows build. Ask for a Deck compatibility review once
   the store page is up. A native Linux depot can come later (see the end of this page).

## 2. Build (you, each release)

```bash
npm install
npm test              # the game logic, the server, the Steam networking (with a stand-in Steam), the browser game
npm run dist:win      # -> dist/win-unpacked/ (NoMoneyDown.exe and its files)
```

This works on Windows, macOS or Linux (no code signing is needed for Steam). Bump `"version"` in
`package.json` for each release: the version is part of the build fingerprint.

## 3. Upload (you, each release)

1. Get [steamcmd](https://developer.valvesoftware.com/wiki/SteamCMD).
2. Put your App ID and depot ID in `steam/app_build.vdf` and `steam/depot_windows.vdf` (once).
3. Upload:

   ```bash
   steamcmd +login <your Steamworks account> +run_app_build "/full/path/to/steam/app_build.vdf" +quit
   ```

4. In Steamworks, **SteamPipe > Builds**: set the new build live on a **beta** branch first, play it
   with a friend (invite, join, a full day, quit), then set it live on **default**.

To let friends play before the store page is public: **Request Steam product keys** in Steamworks
and give them keys. They install it from Steam like any other game.

## 4. The store page (you)

Steam asks for these (sizes in pixels):

| Asset | Size |
|---|---|
| Header capsule | 920 × 430 |
| Small capsule | 462 × 174 |
| Main capsule | 1232 × 706 |
| Vertical capsule | 748 × 896 |
| Page background (optional) | 1438 × 810 |
| Library capsule | 600 × 900 |
| Library hero | 3840 × 1240 |
| Library logo (transparent PNG) | 1280 × 720 |
| Screenshots (at least 5) | 1920 × 1080 |

Real screenshots of the game are in `docs/screenshots/`; `node tools/docshots.mjs` makes them again.

- **Tags:** Co-op, Online Co-Op, Physics, Funny, Driving, First-Person, Proximity Voice Chat, Casual.
- **Content survey:** declare **simulated gambling** (the casino uses the crew's in-game money; no real
  money is ever involved), cartoon violence (getting knocked out), and **user-generated content: voice
  chat between players**.
- **System requirements (a starting point; measure on real machines):** Windows 10 64-bit, a GPU with
  WebGL 2 (any from the last ~8 years), 4 GB RAM, 600 MB of disk, a broadband connection for online play.
- **Privacy:** the game collects nothing. Voice goes between the players' own games over Steam and
  isn't recorded. Crash dumps and logs stay on the player's PC.

## 5. Before launch

- [ ] `npm test` passes, and a build on the beta branch was played by 2+ people on different internet
      connections, including someone joining mid-day and someone dropping and coming back
- [ ] The overlay invite dialog works (Shift+Tab also opens the overlay)
- [ ] Frame rate checked on a low-end laptop GPU and on a Steam Deck
- [ ] The App ID is in `package.json`, and `steam_appid.txt` is not in the depot (the depot file
      excludes it)
- [ ] Store page assets and the content survey done; build reviewed by Valve (a few days)

## Later: a native Linux depot

`npm run dist:linux` makes `dist/linux-unpacked/`. Before shipping it as its own depot:
the Steamworks launch option is `nomoneydown` with arguments `--no-sandbox` (a depot can't carry
Chromium's setuid sandbox helper), and the Steam library (`steamworks.js` 0.4.0) needs glibc 2.34 or
newer, which Steam's Linux runtime "sniper" (glibc 2.31) doesn't have: in it, the game runs but
without Steam features. Until that's solved, Proton running the Windows build is the better Linux path.

## Where things are

| | |
|---|---|
| `desktop/main.cjs` | the app: window, the game server process, Steam, the page's `window.desktop` |
| `desktop/steam/` | lobbies, P2P, the host side (`host.cjs`) and the guest's bridge (`guest.cjs`) |
| `desktop/electron-builder.cjs` | how `npm run dist` packages it |
| `server/host.js` | the game server (every connection: the host's own page, friends over Steam, browsers) |
| `steam/` | SteamPipe upload scripts and the rich presence file |
| `test/steamnet.mjs` | the Steam networking against a stand-in Steam (`test/fakesteam/`) |
| `test/desktop-smoke.mjs` | the real desktop app, two copies over the stand-in Steam |
