# NO MONEY DOWN on Steam

How the Steam build works, and the steps from this repo to friends playing it. The steps marked
**(you)** need your Steamworks account: everything else is already in the repo.

## How it works

- **One app, no servers to rent.** The desktop build (Electron) carries the whole game: the page, and
  the game server, which runs on the player's own PC in a background process (`desktop/main.cjs`,
  `desktop/server-process.mjs`). Whoever starts a trip *is* the server for it.
- **Friends join with a 4-digit trip code.** **Host Game** gives the host a trip code (it's at the top
  right of the screen and on the Esc menu). Friends type it under **Join Game**: their game asks Steam
  for the lobby with that code, anywhere in the world, and joins it. Steam invites work too: **Invite
  Friends** (press Esc in the game), the friends list's **Invite to Game**, or **Join Game** on the
  host in their own friends list. Either way, their game talks to the host's over Steam's P2P network
  (`desktop/steam/`): no port forwarding, no IP addresses, Steam's relays handle the routers.
- **How the code finds the trip.** The host's Steam lobby is Public (Steam's searches only list Public
  lobbies) and carries the code. steamworks.js can't filter a lobby search, so the game sets Steam's
  own search filters (this code, worldwide) through Steam's flat API with koffi, right before the
  search (`desktop/steam/lobbysearch.cjs`). Before hosting, the game checks that no open trip already
  has the code it drew. If the filters can't be set (koffi or Steam's library didn't load), Steam only
  lists lobbies nearby: the game says its search only looked nearby, and a Steam invite still works.
- **The trip code is not a password.** With 9,000 possible codes, anyone who has it, guesses it, or
  lists the game's lobbies can join, and a mistyped code can land a player in a stranger's trip (the
  menu says whose trip it's joining). Fine for friends; there's no kick button yet. The browser build's
  server slows guessing down: ten wrong codes close the connection, and then that address gets one more
  try every 30 s.
- **Voice chat** rides the same connection (Opus, 24 kbit/s): the host's game passes each voice on only
  to the players who can hear it (within earshot, or both holding walkies). Nothing peer-to-peer.
- **The same version on both ends.** Every build carries a fingerprint of the game code
  (`server/build.js`); a friend on a different version is told so, plainly, before anything loads.
  Steam updates everyone to the same build, so this only bites when one of you hasn't restarted Steam.
- **Dropped connections:** a friend whose connection drops gets their seat (and walkie, and color) back
  if they're back within 90 s. If the host quits, everyone is told the trip is over.
- **No Steam running:** the game still starts and plays solo, and the menu says why friends can't join.
- **The browser build** (`npm start`, then `http://localhost:3000`) still works for development and
  LAN play, with the same 4-digit trip codes (its server hands them out).

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

## 1. Steamworks (you, once): start here, today

Valve's paperwork and waiting periods are the slow part, and no amount of work on the game makes them
faster. Start them first.

1. Join [Steamworks](https://partner.steamgames.com) as yourself (or as your company, if you have one):
   sign the agreements, then Valve checks your identity, tax form and bank details (2-7 business days).
   The store page's **Developer** and **Publisher** must be that same person or company.
2. Pay the Steam Direct fee ($100 per game, paid back to you once the game earns $1,000). You get an
   **App ID**. Steam won't let the game go on sale until **21 days after the fee is paid** (some older
   Valve pages say 30).
3. Put the App ID in `package.json`: `"steamAppId": 1234560`.
4. **SteamPipe > Depots**: one depot for Windows (Steam makes the first one for you: usually the App
   ID + 1). Set it to Windows. Note its ID.
5. **Installation > General**: a launch option: executable `NoMoneyDown.exe`, operating system Windows.
6. **Community > Rich Presence**: upload `steam/richpresence_english.vdf` (what friends see next to
   your name: "Day 2 of 5 · driving Goldenfield Pike").
7. **Steam Deck and Linux**: Proton runs the Windows build. Ask for a Deck compatibility review once
   the store page is up. A native Linux depot can come later (see the end of this page).
8. **Steam Input** (controllers, the Steam Deck): the game itself reads only the keyboard and mouse.
   In Steamworks' Steam Input settings, make Valve's **Keyboard (WASD) and Mouse** template the
   default controller configuration (or publish your own), so a controller or a Deck plays it out of
   the box. Keys are read by position, so WASD also works on AZERTY and QWERTZ keyboards (the help
   page shows each player's own key names).

The earliest a first release can happen (Valve's pages as of 2026; they change, so check them):

| Step | How long |
|---|---|
| Identity, tax and bank checks | 2-7 business days |
| The wait after paying the fee | 21 days (older pages: 30) |
| Store page review (send it in 7+ business days before you want it up) | 3-5 business days |
| The "Coming Soon" page public before release | at least 2 weeks |
| Build review (after the store page passes) | 3-5 business days; plan for 7 |

So plan on releasing about 4-5 weeks after paying the fee. Friends can play long before that with
Steam keys (section 3).

The game names its maker in two places, `"author"` in `package.json` and `copyright` in
`desktop/electron-builder.cjs`: both say "the NO MONEY DOWN developers" for now (never a company that
doesn't exist). Put the name you use in Steamworks in both if you want them to match.

## 2. Build (you, each release)

```bash
npm install
npm test              # the game logic, the server, the Steam networking (with a stand-in Steam), the browser game
npm run dist:win      # -> dist/win-unpacked/ (NoMoneyDown.exe and its files)
```

This works on Windows, macOS or Linux (no code signing is needed for Steam). Bump `"version"` in
`package.json` for each release: the version is part of the build fingerprint.

Then `node tools/depotcheck.mjs`: it checks the built folders before you upload them (the executable,
the licence files next to it, nothing of the repo's tests, tools or docs inside, and no other game's
names in the text players see).

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

### Pictures

`node tools/storeart.mjs` makes every image Steam asks for, at exactly the right size, from the game's
own title painting (rendered at 4K, without the signpost, so there are no words in the art) and its
lettering. They land in `dist/store/`, with `contact_sheet.jpg` to look them over. They're a decent
start; art made by an artist sells a game better. (The hero still shows the RV's own painted
lettering, SLOPMASTER 9000. That's part of the scene, not a logo, but if Valve's review objects, move
the crop in `tools/storeart.mjs` or ask for an RV without paint.)

| File | Steamworks slot | Size |
|---|---|---|
| `header_capsule.png` | Header capsule | 920 × 430 |
| `small_capsule.png` | Small capsule | 462 × 174 |
| `main_capsule.png` | Main capsule | 1232 × 706 |
| `vertical_capsule.png` | Vertical capsule | 748 × 896 |
| `page_background.jpg` | Page background (optional) | 1438 × 810 |
| `library_capsule.png` | Library capsule | 600 × 900 |
| `library_header.png` | Library header | 920 × 430 |
| `library_hero.png` | Library hero (must have no words at all) | 3840 × 1240 |
| `library_logo.png` | Library logo (transparent PNG) | 1280 wide |
| `community_icon.jpg` | Community icon | 184 × 184 |
| `shortcut_icon.png` | Client icon (or `desktop/build/icon.ico`) | 256 × 256 |

**Screenshots:** at least 5, 1920 × 1080, real play with nothing written on them, and at least 4 marked
as suitable for all ages. `tools/scene.mjs` takes them at that size:

```bash
SCENE_W=1920 SCENE_H=1080 node tools/scene.mjs camp,crew,road dist/store/screenshots 1      # the meadow
SCENE_W=1920 SCENE_H=1080 node tools/scene.mjs fields,town dist/store/screenshots 2         # the fields
SCENE_W=1920 SCENE_H=1080 node tools/scene.mjs vista,town dist/store/screenshots 3          # the snow
SCENE_W=1920 SCENE_H=1080 node tools/scene.mjs mesa,crash dist/store/screenshots 4          # the badlands
SCENE_W=1920 SCENE_H=1080 node tools/scene.mjs casinoin,night dist/store/screenshots 5      # the desert
```

(The pictures in `docs/screenshots/` are 1280 × 720, too small for Steam: they're for the README.)

### The trailer

`tools/trailer.mjs` films a 60-second trailer from the game itself, 1920 × 1080 at 30 fps, H.264 and
AAC: the store page's video slot (Steamworks > Store Page Admin > Trailers) takes the MP4 as it is.

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" node tools/trailer.mjs capture   # the shots (about an hour)
node tools/trailer.mjs audio                                              # the sounds and the air
node tools/trailer.mjs score                                              # the music, scored to the cut
xvfb-run -a -s "-screen 0 1920x1080x24" node tools/trailer.mjs cards     # the words and the title
node tools/trailer.mjs edit                                               # dist/trailer/trailer.mp4
```

- **The picture** is the game, not a mock-up. Software GL can't draw it in real time, so the capture
  runs the game's server in-process and ticks it by hand, with the page's clock made virtual: every
  video frame is exactly 1/30 s of game time. The crew (Dave, Steve, Kyle) are bots; the camera is
  the page's own player. Seed 777, so every take is the same road. No HUD in the picture; the lines
  on it are set afterwards in the game's own type (Cinzel, Marcellus) and its toasts' words.
- **The music** is a score written for the cut (`tools/trailer-score.js`): a country-rock theme at
  96 bpm, so every cut lands on a half bar, with its gags on the picture's events (the band stops dead
  on the gate's crunch, the tape winds down when the RV breaks down, the casino gets a swing version,
  midnight's ticking build lands on REPO'D, the payoff goes up a step). Every instrument is synthesized
  there (plucked strings, drums, a fiddle, a vibraphone): no samples, nothing to license. `node
  tools/trailer.mjs plan` prints the cut's timing to score against; `score --solo <group>` renders one
  group of instruments, to check the balance.
- **The sound** is the game's own: its sound effects and its ambience, rendered offline. The music
  ducks a little under the big ones (the crunch, the till, the bonk).
- **The cut** is the `EDL` in the tool: the hook (the SLOPMASTER RVs / NO MONEY DOWN!!! billboard),
  the pitch, the verbs (map, haul, climb, winch, pawn), the chaos (the ranger gate, the Grumphorn,
  a ringtail, the RV running Steve over, a breakdown), the stakes (the casino, a minute to
  midnight, the Repo Man), the five days, the payoff, the title, a stinger and WISHLIST ON STEAM.
  Change a line or a cut and run `edit` again (a minute or two); `capture --only <shot>` films one
  shot again.
- Steam's rules for it: no other game's footage or name, nothing promised that isn't in the game.
  The casino lines are the in-game bank's money.

### Words

Steam's rule: the page must not name other games, or their worlds and characters. Describe the look
as "a hand-painted early-2000s MMO look" and leave it there.

- **Short description** (271 characters; Steam allows about 300):
  > You and up to five friends bought a $250,000 RV with no money down. Drive it across five days of
  > hand-painted road, haul fragile junk to the pawn shop, bet the shared bank at the casino, and pay
  > the Repo Man by midnight, every night. Miss one payment and he takes the RV.
- **Features:** online co-op for 1-6 players; proximity voice chat (a microphone is optional);
  keyboard and mouse (a controller through Steam Input's template only, so don't tick full controller
  support); English.
- **Tags:** Co-op, Online Co-Op, Physics, Funny, Driving, First-Person, Proximity Voice Chat, Casual.
- Don't promise money: no "win cash" or anything like it. The casino's money is the game's.

### Content survey and disclosures

Answer these in Steamworks before the store page goes to review:

- **Simulated gambling: yes.** Developer's content description: *"Contains simulated gambling (blackjack
  and a double-or-nothing coin flip) played only with the crew's in-game money. There is no real-money
  wagering and nothing to buy."*
- **Violence:** mild cartoon slapstick (players get knocked out, and run over by the RV); no blood.
- **User-generated content:** voice chat between players, and the names players type.
- **AI-generated content** (Valve's form asks about AI-made content players see or hear): the honest
  answer is yes. A suggested disclosure: *"This game's code was written with the help of an AI model
  (Claude, by Anthropic) under the developer's direction. That includes the code that paints every
  texture and builds every model, song and sound when the game runs, and the in-game text. No AI model
  runs while you play."* Edit it as you like, but disclose it: the project's public history shows it.
- Ratings outside Steam: games with casino play get adults-only ratings in some places (PEGI 18,
  Australia R18+). Steam doesn't need those ratings on PC; they matter only for consoles.

### System requirements and privacy

- **System requirements (a starting point; measure on real machines):** Windows 10 64-bit, a GPU with
  WebGL 2 (any from the last ~8 years), 4 GB RAM, 600 MB of disk, a broadband connection for online
  play. The game has only ever run on software rendering here, so try it on a low-end laptop GPU (an
  Intel UHD 620, say) before filling in the minimums.
- **Privacy:** the game collects nothing and has no analytics. Voice goes from each player's game to
  the host's game over Steam and on to the players in earshot: no peer-to-peer connections, so nobody
  sees anybody's IP address, and nothing is recorded. Logs stay on the player's PC. A three-line note
  saying so on the store page is enough.

## 5. Before launch

- [ ] **Make the GitHub repository private** (on GitHub: Settings > General > Danger Zone > Change
      visibility). While it's public anyone can download and play the whole game for free, and its
      history still holds other games' footage that was used as art reference (taken out of the
      current files, but still in old commits).
- [ ] Search the Steam store, SteamDB and the trademark registers (USPTO, EUIPO) for "No Money Down",
      so the name isn't already someone else's
- [ ] `npm test` passes (it also checks that no other game's place names or real brands crept into
      the text players see: `tools/namecheck.mjs`)
- [ ] A build on the beta branch was played by 2+ people on different internet
      connections, including someone joining mid-day and someone dropping and coming back
- [ ] Join by trip code works between two real Steam accounts, ideally far apart (say, the US and
      Europe): the search's filters are set through Steam's flat API, which only a real Steam client
      can prove (the tests use a stand-in)
- [ ] The overlay invite dialog works (Shift+Tab also opens the overlay)
- [ ] Frame rate checked on a low-end laptop GPU and on a Steam Deck
- [ ] The App ID is in `package.json`, and `steam_appid.txt` is not in the depot (the depot file
      excludes it)
- [ ] Store pictures (`tools/storeart.mjs`), 5+ screenshots, the trailer (`tools/trailer.mjs`), the content survey and the AI disclosure
      done; the store page passed review and was "Coming Soon" for 2+ weeks; the build passed review

## Steam Cloud for the save (optional, once the real App ID exists)

Nothing is needed for saves to work: each player's save lives on their own PC, in the game's folder
(`%APPDATA%\NO MONEY DOWN\save` on Windows, `~/.config/NO MONEY DOWN/save` on Linux and the Steam
Deck): `profile.json`, and `profile.bak.json` (the one before it). Steam Cloud only carries it between
a player's machines. Turn it on after the real App ID is in `package.json`, never under 480 (Valve's
shared test app: everyone's files would mix).

1. On partner.steamgames.com, open the app, then **Application > Steam Cloud**. Set the byte quota per
   user to 1048576 (1 MB) and the number of files per user to 8. Save.
2. On the same page, under **Auto-Cloud**, add a root path: root `WinAppDataRoaming`, subdirectory
   `NO MONEY DOWN/save`, pattern `profile*.json`, OS Windows, not recursive. That syncs the save and its
   backup and nothing else (not `save/corrupt`, not the logs).
3. Add a root override for Linux (the Steam Deck too): original root `WinAppDataRoaming`, OS Linux, new
   root `LinuxHome`, path `.config/` (the folder becomes `~/.config/NO MONEY DOWN/save`). Check the exact
   field names, and whether Valve offers an XDG config root by now, against Valve's Steam Cloud
   documentation while doing it.
4. Tick **Enable cloud support for developers only** and publish. Test: finish a trip on PC A and quit
   (Steam syncs on exit), start on PC B: the Garage's Logbook has it. Then play offline on both and
   reconnect: Steam's own conflict dialog should come up.
5. Untick "developers only" and publish.

The browser build keeps its save in the browser (per browser and per address); the Garage's Save tab
has Export and Import to move it.

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
| `desktop/save.cjs` | the player's save files (`<userData>/save`): atomic writes, the backup, bad files kept aside |
| `steam/` | SteamPipe upload scripts and the rich presence file |
| `test/steamnet.mjs` | the Steam networking against a stand-in Steam (`test/fakesteam/`) |
| `test/desktop-smoke.mjs` | the real desktop app, two copies over the stand-in Steam |
| `tools/storeart.mjs` | the store and library pictures, from the game's title art (`dist/store/`) |
| `tools/trailer.mjs` | the 60-second trailer, filmed by the game itself (`dist/trailer/trailer.mp4`) |
| `tools/namecheck.mjs` | fails `npm test` if another game's place names or real brands get into the text players see |
| `tools/notices.mjs` | writes `desktop/THIRD_PARTY_NOTICES.txt`, the licences shipped next to the executable |
