'use strict';
// NO MONEY DOWN: the desktop build (the one on Steam). Electron's main process.
//
//   - The page is served from app://nmd: one fixed origin, so the settings (localStorage) and the texture
//     cache (IndexedDB) survive restarts.
//   - The game server runs in a utility process (server-process.mjs) on 127.0.0.1, on a port the OS
//     picks. Not here: this process is the browser's UI thread, and a 60 Hz physics sim stalled it for
//     100-165 ms at every day change.
//   - Steam (steamworks.js) lives here: the lobby friends join through, the P2P packets to and from
//     them, rich presence, the overlay (steam/). A friend's packets reach the game server through a
//     MessagePort, so the server can't tell a Steam friend from a WebSocket.
//   - With no Steam client running (or --no-steam) the game still runs: solo.
//
// Launch options (Steam's Launch Options box, or a shortcut): --windowed / --fullscreen, --no-steam,
// --devtools, --swiftshader (software GL: test machines only), --respect-gpu-blocklist,
// --multi-instance (a second copy on one PC, for testing). Steam itself adds +connect_lobby <id> when
// a friend's invite starts the game.

const { app, BrowserWindow, Menu, shell, session, utilityProcess, MessageChannelMain, dialog, crashReporter, ipcMain, nativeImage, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const PRODUCT = 'NO MONEY DOWN';
const ORIGIN = 'app://nmd';
const PKG = require('../package.json');

// ---- flags ---------------------------------------------------------------------------------------
const argv = process.argv.slice(1);
const has = name => argv.includes(`--${name}`);
const val = name => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const lobbyArg = a => { const i = a.indexOf('+connect_lobby'); return i >= 0 && /^\d{1,20}$/.test(a[i + 1] || '') ? a[i + 1] : null; };
const FLAGS = {
  windowed: has('windowed'), fullscreen: has('fullscreen'), devtools: has('devtools') || !app.isPackaged,
  steam: !has('no-steam'), appId: Number(val('steam-appid')) || null, multi: has('multi-instance'),
  swiftshader: has('swiftshader') || process.env.NMD_SWIFTSHADER === '1', lobby: lobbyArg(argv),
};

// one stable profile folder whatever the executable is called (Windows: %APPDATA%\NO MONEY DOWN)
app.setName(PRODUCT);
app.setPath('userData', process.env.NMD_USER_DATA || path.join(app.getPath('appData'), PRODUCT));

// ---- one copy at a time: a second launch (a Steam invite while the game runs, a double click) hands
// its argv over and quits. Before the log is touched: a second copy must not rotate the first's log.
if (!app.requestSingleInstanceLock({ argv })) {
  if (!FLAGS.multi) { process.stderr.write('NO MONEY DOWN is already running: handing over and quitting\n'); app.exit(0); return; }
  // --multi-instance (two players on one PC, for testing): a profile of its own. Two Chromiums on one
  // profile fight over its LevelDB locks (the texture cache, the settings).
  const base = app.getPath('userData');
  for (let n = 2; n < 10; n++) {
    app.setPath('userData', `${base} (${n})`);
    if (app.requestSingleInstanceLock({ argv })) break;
  }
}

// ---- the log: <userData>/logs/main.log (this run; the one before is main.old.log) ------------------
app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
const LOG = path.join(app.getPath('logs'), 'main.log');
try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.renameSync(LOG, LOG.replace(/\.log$/, '.old.log')); } catch {}
let logStream = null, logBytes = 0, stdoutOk = !!process.stdout?.writable;
const LOG_CAP = 8 << 20;                 // an error loop must not fill the player's disk
try { logStream = fs.createWriteStream(LOG, { flags: 'a' }); logStream.on('error', () => { logStream = null; }); } catch {}
// stdout can be a pipe nobody reads (a closed terminal, Steam on Linux): a failed write is an async
// 'error' event, and logging that from the uncaughtException handler would loop forever
process.stdout?.on?.('error', () => { stdoutOk = false; });
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map(x => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  if (stdoutOk) try { process.stdout.write(line); } catch { stdoutOk = false; }
  if (logStream && logBytes < LOG_CAP) { logBytes += line.length; try { logStream.write(logBytes < LOG_CAP ? line : '[the log is full]\n'); } catch {} }
}
process.on('uncaughtException', e => { if (e?.code === 'EPIPE') { stdoutOk = false; return; } log('[main] uncaught exception', e); });
process.on('unhandledRejection', e => log('[main] unhandled rejection', e));
log(`[main] ${PRODUCT} ${app.getVersion()}: electron ${process.versions.electron}, chrome ${process.versions.chrome}, ${process.platform}-${process.arch}, packaged ${app.isPackaged}`);
log('[main] argv', argv.join(' '));

// crash dumps stay on the player's PC: <userData>/Crashpad
crashReporter.start({ uploadToServer: false });

// ---- GPU and Chromium switches (before 'ready') --------------------------------------------------
if (FLAGS.swiftshader) {                 // software GL for headless test machines, never on players' PCs
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
// a GPU on Chromium's blocklist gets no WebGL at all, and the game can't run: try the GPU anyway
if (!has('respect-gpu-blocklist')) app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // menu sounds before a click
app.commandLine.appendSwitch('force_high_performance_gpu');                       // dual-GPU laptops: the real GPU

// the page's own scheme: standard (a real origin, so storage works), secure (so the mic works), fetch
// for ES modules, and V8's code cache
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

// ---- Steam (before 'ready': the overlay needs its switches set early) -----------------------------
// The App ID: Steam sets SteamAppId for a game it starts. Otherwise package.json's steamAppId (480 is
// Spacewar, Valve's public test app, until the real one is filled in) or --steam-appid=N.
const steam = require('./steam.cjs').start({
  enabled: FLAGS.steam, appId: FLAGS.appId ?? (Number(PKG.steamAppId) || 480), packaged: app.isPackaged, log,
});
if (steam.restarting) { app.exit(0); return; }

// ---- the game server ----------------------------------------------------------------------------------
let server = null, quitting = false, win = null;
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(path.join(__dirname, 'server-process.mjs'), [], { serviceName: `${PRODUCT} game server`, stdio: 'pipe' });
    const { port1, port2 } = new MessageChannelMain();
    let done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); if (err) reject(err); else resolve(v); };
    const timer = setTimeout(() => { finish(new Error('the game server took more than 30 s to start')); try { proc.kill(); } catch {} }, 30000);
    proc.stdout?.on('data', d => String(d).trimEnd().split('\n').forEach(l => log(l)));
    proc.stderr?.on('data', d => String(d).trimEnd().split('\n').forEach(l => log('[server:err]', l)));
    proc.on('message', m => {
      if (m?.t === 'ready') finish(null, { proc, link: new ServerLink(port2), wsPort: m.wsPort, build: m.build });
      else if (m?.t === 'error') finish(new Error(m.msg));
    });
    proc.on('exit', code => {
      finish(new Error(`the game server exited (code ${code})`));
      if (server?.proc !== proc) return;
      server = null;
      log(`[main] the game server exited with code ${code}`);
      if (!quitting) serverDied(code);
    });
    proc.postMessage({ t: 'start', origin: ORIGIN }, [port1]);
  });
}
// the server crashed: the trip is lost, but the game needn't be
async function serverDied(code) {
  leaveSteam('The host\'s game hit a problem. The trip is over.');
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, {
    type: 'error', title: PRODUCT, message: 'The game server stopped, and the trip with it.',
    detail: `Code ${code}. The log is in ${LOG}`, buttons: ['Back to the menu', 'Quit'], defaultId: 0, noLink: true,
  }) : { response: 1 };
  if (r.response !== 0 || quitting) { app.quit(); return; }
  try { server = await startServer(); win?.webContents.reload(); }
  catch (e) { log('[main] the server did not come back', e); dialog.showErrorBox(PRODUCT, `The game server would not start again: ${e.message}`); app.quit(); }
}
function stopServer(msg) {
  return new Promise(resolve => {
    const s = server;
    if (!s) return resolve();
    const t = setTimeout(() => { try { s.proc.kill(); } catch {} resolve(); }, 1500);
    s.proc.once('exit', () => { clearTimeout(t); resolve(); });
    s.proc.postMessage({ t: 'shutdown', msg });
  });
}

// Main's end of the MessagePort to the server process: a Steam friend's connection goes in as a peer
// (server-process.mjs turns each one into a ws-like PortPeerConn for GameHost.attach()).
class ServerLink {
  constructor(port) {
    this.port = port; this.n = 0; this.conns = new Map();
    port.on('message', e => this.onMessage(e.data));
    port.start();
  }
  attach(conn, info = {}) {
    const peer = ++this.n;
    this.conns.set(peer, conn);
    this.port.postMessage({ t: 'open', peer, key: info.key, kind: info.kind });
    conn.on('message', (data, bin) => { if (this.conns.get(peer) === conn) this.port.postMessage({ t: 'msg', peer, data: bin ? new Uint8Array(data) : String(data), bin: !!bin }); });
    conn.on('close', code => { if (this.conns.get(peer) === conn) { this.conns.delete(peer); this.port.postMessage({ t: 'close', peer, code }); } });
  }
  onMessage(m) {
    const conn = this.conns.get(m?.peer);
    if (!conn) return;
    if (m.t === 'send') conn.send(typeof m.data === 'string' ? m.data : Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength), { unreliable: m.unreliable, voice: m.voice });
    else if (m.t === 'close') { this.conns.delete(m.peer); conn.close(m.code, m.reason); }
  }
  end(msg) { server?.proc.postMessage({ t: 'end', msg }); }
}

// ---- the page's files, at app://nmd/ ------------------------------------------------------------------
// client/ at /, shared/ at /shared/, Rapier's ESM build at /vendor/rapier.mjs: the same layout as the
// browser build's server (server/host.js), with the same rule that a path stays inside its folder.
const RAPIER = path.join(path.dirname(require.resolve('@dimforge/rapier3d-compat')), 'rapier.mjs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain',
};
// What the page may do: its own files, WebAssembly (Rapier), sockets to this PC only (the game server
// and the Steam bridge both listen on 127.0.0.1). A name a friend picked can't become a script.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' blob: mediastream:",
  "connect-src 'self' ws://127.0.0.1:*", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');
function fileFor(urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/vendor/rapier.mjs') return RAPIER;
  const shared = urlPath.startsWith('/shared/');
  const base = path.join(ROOT, shared ? 'shared' : 'client');
  const file = path.normalize(path.join(base, shared ? urlPath.slice('/shared'.length) : urlPath));
  return file.startsWith(base + path.sep) ? file : null;
}
async function serveApp(req) {
  let u, file;
  try { u = new URL(req.url); file = u.host === 'nmd' ? fileFor(decodeURIComponent(u.pathname)) : null; } catch { file = null; }
  if (!file || file.includes('\0')) return new Response('forbidden', { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    return new Response(body, { headers: { 'content-type': type, ...(type.startsWith('text/html') && { 'content-security-policy': CSP }) } });
  } catch { return new Response('not found', { status: 404 }); }
}
const fromGame = url => { try { const u = new URL(url); return u.protocol === 'app:' && u.host === 'nmd'; } catch { return false; } };

// ---- the window --------------------------------------------------------------------------------------
const STATE = path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { return {}; } };
function saveState() {
  try { fs.writeFileSync(STATE, JSON.stringify({ fullscreen: win.isFullScreen(), maximized: win.isMaximized(), bounds: win.getNormalBounds() })); }
  catch (e) { log('[main] the window state was not saved:', e.message); }
}
function createWindow() {
  const st = readState();
  const bigScreen = process.env.SteamDeck === '1' || process.env.SteamTenfoot === '1';
  const fullscreen = FLAGS.windowed ? false : FLAGS.fullscreen || bigScreen ? true : st.fullscreen ?? true;
  const icon = path.join(__dirname, 'icon.png');
  win = new BrowserWindow({
    ...(st.bounds && st.bounds.width >= 960 && st.bounds.height >= 540 ? st.bounds : { width: 1600, height: 900 }),
    minWidth: 960, minHeight: 540, show: false, fullscreen, backgroundColor: '#14101f', title: PRODUCT,
    icon: fs.existsSync(icon) ? nativeImage.createFromPath(icon) : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false,          // alt-tabbed, the host's own page still sends its poses and voice
      spellcheck: false, devTools: FLAGS.devtools,
    },
  });
  if (st.maximized && !fullscreen) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveState);
  win.on('closed', () => { win = null; });
  const wc = win.webContents;
  // F11 and Alt+Enter: fullscreen. There is no app menu, so no Ctrl+W / Ctrl+R / Ctrl+Q accelerators
  // (crouch used to be Ctrl: Ctrl+W closed the window mid-run).
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (FLAGS.devtools && input.control && input.shift && input.key.toLowerCase() === 'i') { e.preventDefault(); wc.toggleDevTools(); }
  });
  // the page never leaves the game; a link opens in the player's browser
  wc.on('will-navigate', (e, url) => { if (!fromGame(url)) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') log(`[page:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`); });
  wc.on('render-process-gone', async (_e, d) => {
    log('[main] the page crashed', d);
    if (quitting || d.reason === 'clean-exit') return;
    leaveSteam('The host\'s game crashed. The trip is over.');
    server?.link.end('The host\'s game crashed. The trip is over.');
    const r = await dialog.showMessageBox(win, { type: 'error', title: PRODUCT, message: 'The game crashed.', detail: `${d.reason} (${d.exitCode}). The log is in ${LOG}`, buttons: ['Restart', 'Quit'], defaultId: 0, noLink: true });
    if (r.response === 0 && !quitting) wc.reload(); else app.quit();
  });
  wc.on('unresponsive', () => log('[main] the page stopped responding'));
  wc.on('responsive', () => log('[main] the page is responding again'));
  win.loadURL(`${ORIGIN}/`);
}

// ---- permissions: the mic (voice chat), pointer lock, fullscreen, the clipboard (no camera) -----------
const ALLOWED = new Set(['media', 'speaker-selection', 'pointerLock', 'fullscreen', 'clipboard-sanitized-write', 'keyboardLock']);
function lockDownSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok = ALLOWED.has(permission) && fromGame(details.requestingUrl) && !(details.mediaTypes || []).includes('video');
    if (!ok) log(`[main] denied ${permission} to ${details.requestingUrl}`);
    cb(ok);
  });
  // requestingOrigin is "app://nmd" (Node's URL has no origin for a custom scheme: compare its parts)
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ALLOWED.has(permission) && fromGame(requestingOrigin));
  ses.setDevicePermissionHandler(() => false);
}

// ---- friends over Steam (steam/): hosting a lobby, or joining a friend's ---------------------------------
// Host: the page starts a trip, then desktop.host(code): a friends-only lobby that friends join from
// an invite or with Join Game in their friends list; each friend's packets reach the server (SteamHost).
// Guest: an invite (or +connect_lobby) gives a lobby id; desktop.joinLobby(id) joins it and opens a
// bridge on 127.0.0.1 that the page connects to as if it were a server (GuestBridge).
let steamHost = null, bridge = null, pendingLobby = FLAGS.lobby, presence = null;
const steamNet = () => require('./steam/index.cjs');
async function hostLobby(code) {
  if (!steam.ok) return { ok: false, msg: steam.reason };
  if (steamHost && !steamHost.closed) { steamHost.setCode(code); return { ok: true, lobby: String(steamHost.lobby?.id ?? '') }; }
  if (bridge) { bridge.leave(); bridge = null; }
  steamHost = new (steamNet().SteamHost)({ steam: steam.client, link: server.link, build: server.build, code, log });
  const lobby = await steamHost.open();
  if (presence) steamHost.setPresence(presence);
  return { ok: true, lobby: String(lobby.id) };
}
async function joinLobby(id) {
  if (!steam.ok) return { ok: false, msg: steam.reason };
  if (!/^\d{1,20}$/.test(String(id))) return { ok: false, msg: 'That isn\'t a Steam lobby.' };
  leaveSteam();
  const b = new (steamNet().GuestBridge)({ steam: steam.client, build: server.build, origin: ORIGIN, log });
  bridge = b;
  b.on('ended', msg => log('[steam] the trip ended:', msg));
  try {
    const r = await b.joinLobby(id);
    const port = await b.listen();
    if (presence) b.setPresence(presence);
    return { ok: true, wsUrl: `ws://127.0.0.1:${port}`, code: r.code, hostName: r.hostName };
  } catch (e) {
    if (bridge === b) bridge = null;
    b.close();
    log('[steam] could not join lobby', id, e.message);
    return { ok: false, msg: e.message, code: e.code };
  }
}
// leaving the trip (back to the menu, a crash): guests hear why, the lobby goes
function leaveSteam(msg) {
  try { steamHost?.close(msg); } catch (e) { log('[steam] closing the lobby:', e.message); }
  try { bridge?.close(); } catch (e) { log('[steam] leaving the lobby:', e.message); }
  steamHost = null; bridge = null;
}
// a friend's invite accepted (or Join Game) while the game runs: the page decides what to do with it.
// It waits here until the page takes it: a push alone could land while the page is still loading.
function offerLobby(id) {
  pendingLobby = id;
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); win.webContents.send('desktop:event', { t: 'lobby', id }); }
}
steam.onJoin = id => offerLobby(id);
app.on('second-instance', (_e, argv2, _cwd, extra) => {
  const args = Array.isArray(extra?.argv) ? extra.argv : argv2;      // Chromium reorders argv2 and adds switches
  log('[main] a second launch:', args.join(' '));
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const id = lobbyArg(args);
  if (id) offerLobby(id);
});

// ---- what the page can ask for (preload.cjs: window.desktop) ------------------------------------------------
function handle(name, fn) {
  ipcMain.handle(name, async (e, ...a) => {
    if (!fromGame(e.senderFrame?.url)) return { ok: false, msg: 'not the game' };
    try { return await fn(...a); } catch (err) { log(`[main] ${name} failed:`, err); return { ok: false, msg: String(err?.message || err) }; }
  });
}
function on(name, fn) { ipcMain.on(name, (e, ...a) => { if (fromGame(e.senderFrame?.url)) try { fn(e, ...a); } catch (err) { log(`[main] ${name} failed:`, err); } }); }
// (synchronous: the preload needs it before the page's scripts run. Always answered: a sync call that
// never gets a returnValue would hang the page.)
ipcMain.on('desktop:boot', e => {
  e.returnValue = fromGame(e.senderFrame?.url) ? {
    version: app.getVersion(), build: server?.build ?? null, wsUrl: server ? `ws://127.0.0.1:${server.wsPort}` : null,
    platform: process.platform, steam: steam.info(), devtools: FLAGS.devtools,
  } : null;
});
on('desktop:log', (_e, ...a) => log('[page]', ...a.map(x => String(x).slice(0, 2000))));
on('desktop:fullscreen', (_e, v) => win?.setFullScreen(v == null ? !win.isFullScreen() : !!v));
on('desktop:quit', () => app.quit());
on('desktop:presence', (_e, p) => {
  presence = p && typeof p === 'object' ? { ph: String(p.ph || ''), day: Number(p.day) || 0, biome: String(p.biome || '') } : null;
  if (!steam.ok) return;
  if (steamHost) steamHost.setPresence(presence);
  else if (bridge) bridge.setPresence(presence);
  else steamNet().setPresence(steam.client, presence || { ph: 'menu' });
});
handle('desktop:host', code => hostLobby(String(code || '').slice(0, 8)));
handle('desktop:invite', () => {
  if (!steam.ok) return { ok: false, msg: steam.reason };
  const lobby = steamHost?.lobby || bridge?.lobby;
  if (!lobby) return { ok: false, msg: 'Start a trip first.' };
  steam.client.overlay.activateInviteDialog(lobby.id);
  return { ok: true };
});
handle('desktop:leave', () => {
  // the host going back to the menu ends the trip for everyone (their game IS the server)
  const msg = `${(steam.ok && steam.info().name) || 'The host'} ended the trip.`;
  if (!bridge) server?.link.end(msg);
  leaveSteam(msg);
  return { ok: true };
});
handle('desktop:take-lobby', () => { const id = pendingLobby; pendingLobby = null; return id; });
handle('desktop:join-lobby', id => joinLobby(String(id)));

// ---- start and stop --------------------------------------------------------------------------------------
Menu.setApplicationMenu(null);
// no spellchecker: else every launch fetches a Hunspell dictionary from Google's CDN
app.on('session-created', ses => {
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
});
app.whenReady().then(async () => {
  try {
    protocol.handle('app', serveApp);
    lockDownSession();
    app.getGPUInfo('basic').then(i => log('[main] gpu', (i.gpuDevice || []).map(d => `${d.active ? '*' : ''}${d.vendorId}:${d.deviceId} ${d.driverVersion || ''}`).join(', '), JSON.stringify(app.getGPUFeatureStatus())), () => {});
    await steam.ready;
    const t0 = Date.now();
    server = await startServer();
    log(`[main] the game server is up on 127.0.0.1:${server.wsPort} in ${Date.now() - t0} ms (build ${server.build}, pid ${server.proc.pid})`);
    createWindow();
  } catch (e) {
    log('[main] could not start', e);
    dialog.showErrorBox(PRODUCT, `The game could not start: ${e.message}\nThe log is in ${LOG}`);
    app.exit(1);
  }
});
app.on('child-process-gone', (_e, d) => log('[main] a child process is gone', d));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', e => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();                       // tell the crew first, then quit for real
  log('[main] quitting');
  const name = steam.ok ? steam.info().name || 'The host' : 'The host';
  leaveSteam(`${name} closed the game. The trip is over.`);
  setTimeout(() => stopServer(`${name} closed the game. The trip is over.`).then(() => { steam.shutdown(); app.quit(); }), steam.ok ? 250 : 0);
});
app.on('will-quit', () => log('[main] bye'));
