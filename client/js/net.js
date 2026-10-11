// Thin WebSocket wrapper with a message-type dispatcher.
//
// Where it connects: ?ws=<url> (tools), the desktop shell's window.desktop.wsUrl (the host's own game in
// a local process, or the bridge to a friend's game over Steam), or the page's own server (the browser
// build). Binary frames are proximity voice (voice_relay.js); everything else is JSON.

const handlers = {};
let ws = null;
let binary = null;
let lastMsg = 0;
let url = null;               // where the last connect() went: a reconnect goes back there

export function on(type, fn) { handlers[type] = fn; }
export function onBinary(fn) { binary = fn; }

export function socketUrl() {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  if (window.desktop?.wsUrl) return window.desktop.wsUrl;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

// connect(url): a friend's trip over Steam (the bridge's address); connect(): wherever the last one went
export function connect(to) {
  url = to || url || socketUrl();
  return new Promise((resolve, reject) => {
    let sock;
    try { sock = new WebSocket(url); } catch { reject(new Error('Could not reach the game.')); return; }
    sock.binaryType = 'arraybuffer';
    // one connection at a time: the one it replaces goes quietly, and nothing it still says is heard
    const old = ws;
    ws = sock;
    if (old) try { old.close(1000, 'replaced'); } catch {}
    let opened = false;
    sock.onopen = () => { opened = true; lastMsg = performance.now(); resolve(); };
    sock.onerror = () => { if (!opened) reject(new Error('Could not reach the game.')); };
    // only the socket in use reports its close (a replaced or deliberately closed one goes quietly)
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null;
      if (opened && handlers._close) handlers._close({ code: ev.code, reason: ev.reason });
    };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      lastMsg = performance.now();
      if (typeof ev.data !== 'string') { binary?.(ev.data); return; }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const h = handlers[m.t];
      if (h) h(m);
    };
  });
}

export function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
export function sendBinary(buf) {
  if (ws && ws.readyState === 1) ws.send(buf);
}

export function connected() { return !!ws && ws.readyState === 1; }
// where the connection in use goes (null: none)
export function at() { return ws ? url : null; }
// when the last message of any kind came in (the client's watchdog: snapshots arrive 20 times a second)
export function lastMessageAt() { return lastMsg; }

// tests: the connection just drops, as a pulled cable or a Wi-Fi blip would look to the game
export function drop() { try { ws?.close(4006, 'dropped'); } catch {} }

// close on purpose: no '_close' report (the caller already knows why)
export function close(code = 1000, reason = '') {
  const s = ws;
  ws = null;
  try { s?.close(code, reason); } catch {}
}
