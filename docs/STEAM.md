# Shipping FRIENDSLOP on Steam

This is the practical, start-to-finish path from this repo to a Steam store page.
Games built exactly this way (HTML5 + Electron) ship on Steam all the time —
Vampire Survivors launched like this.

## 0. The architecture you're shipping

- **Client + server in one app.** The Electron build (`electron/main.mjs`) runs the
  game server locally and opens the client against it. Solo-vs-bots works offline.
- **Playing with friends** needs one shared server so room codes work across the
  internet. Two options:
  1. **Host a public server** (recommended to start): deploy `server/index.js` to any
     $5 VPS / Fly.io / Railway box (`PORT=443` behind TLS), and point the client at it
     (change the WebSocket URL in `client/js/net.js` to your domain). Every copy of the
     game then shares one room-code space. This is the "friend slop" standard —
     nobody port-forwards.
  2. **Steam Datagram Relay / steamworks P2P** (later): swap the WebSocket transport
     for `steamworks.js` networking so Steam relays traffic. Bigger lift; do it after
     the game has legs.
- **Voice chat** is WebRTC peer-to-peer; the game server only relays the handshake.
  Two deployment notes:
  1. Browsers require a **secure context** (https or localhost) for mic access — so
     put the public server behind TLS (you're doing that anyway per option 1). The
     Electron build loads from localhost, which counts as secure: voice just works.
  2. Voice uses a public STUN server for NAT traversal. Friends behind brutal
     symmetric NATs may fail to connect P2P — if reports come in, add a cheap TURN
     server (coturn on the same VPS) to the `ICE` config in `client/js/voice.js`.

## 1. Steamworks setup (one-time, ~$100)

1. Create a [Steamworks partner account](https://partner.steamgames.com) and pay the
   $100 app fee (recouped at $1,000 revenue).
2. You'll get an **App ID**. Fill in the store page: name (FRIENDSLOP), capsule art,
   screenshots (there are real gameplay shots in `test/screenshots/` to start from),
   trailer, tags: *Multiplayer, Party Game, Casual, Funny, PvP*.
3. In **Steamworks → App → Installation**, define a launch option per OS pointing at
   the packaged binary (see step 2).
4. Store screenshots: real captures live in `docs/screenshots/` — the Den, all four
   chambers, the blackjack table, and the celebration.

## 2. Package the desktop build

```bash
npm install --save-dev electron electron-builder
npx electron-builder --win --linux --mac
```

Add this to `package.json` (already structured to make it drop-in):

```json
"build": {
  "appId": "com.yourstudio.friendslop",
  "productName": "FRIENDSLOP",
  "files": ["electron/**", "server/**", "client/**", "shared/**", "node_modules/ws/**"],
  "win": { "target": "dir" },
  "linux": { "target": "dir" },
  "mac": { "target": "dir" }
}
```

Use `dir` targets for Steam — Steam wants a raw folder, not an installer.

## 3. Steam integration (optional but worth it)

`npm install steamworks.js`, then in `electron/main.mjs`:

```js
import steamworks from 'steamworks.js';
const client = steamworks.init(YOUR_APP_ID);
// achievements: client.achievement.activate('FIRST_BLOOD')
// rich presence, overlay, friend invites → see steamworks.js docs
```

Good first achievements: *win a round while ALL IN*, *win the jackpot*,
*explode holding the tater 3 times in one match*, *win a match without winning
a single minigame (pure gambling)*.

Enable the Steam Overlay by launching with `--in-process-gpu` on Windows if it
doesn't hook automatically.

## 4. Upload to Steam

1. Install the Steamworks SDK, use `steamcmd` + the `app_build`/`depot_build` VDF
   scripts (SDK has templates — point `ContentRoot` at your `dist/` folder).
2. `steamcmd +login <user> +run_app_build app_build_XXXX.vdf`
3. Set the uploaded build live on the `default` branch in Steamworks.
4. Request store page review (takes a few days), pick a launch date, ship it.

## 5. Pre-launch checklist

- [ ] Public game server deployed + WebSocket URL updated (or SDR integrated)
- [ ] `FRIENDSLOP_FAST` **not** set in production
- [ ] Playtest with 8 real humans (the game supports it; the chaos scales)
- [ ] Store page assets: 6+ screenshots, a 30s trailer of the sumo ring shrinking
- [ ] Price point: friend-slop games live at $4.99 (or F2P + cosmetic DLC later)
- [ ] Steam Deck: it runs (WebGL canvas); add gamepad support — left stick →
      movement vector, right stick → camera yaw, A → dash (~40 lines in
      `client/js/main.js`, the input protocol already takes analog vectors)
