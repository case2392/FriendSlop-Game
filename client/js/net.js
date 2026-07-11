// Thin WebSocket wrapper with a message-type dispatcher.

const handlers = {};
let ws = null;

export function on(type, fn) { handlers[type] = fn; }

export function connect() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Could not reach the slop server.'));
    ws.onclose = () => { if (handlers._close) handlers._close(); };
    ws.onmessage = ev => {
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

export function connected() { return ws && ws.readyState === 1; }
