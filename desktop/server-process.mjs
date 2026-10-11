// The desktop build's game server: an Electron utility process (never the main process, which is the
// browser's UI thread: a day change used to stall it 100-165 ms). It runs the same GameHost as npm start.
//
// The host's own page connects over a loopback WebSocket (127.0.0.1, a port the OS picks, only from the
// app's own origin). Friends over Steam arrive from the main process, which owns steamworks.js, through
// a MessagePort: one PortPeerConn per guest page connection, which GameHost.attach() can't tell from a
// WebSocket.
//
// From main: { t: 'start', origin } with the port; { t: 'end', msg } when the host goes back to the menu
//            (the trip is over for everyone); { t: 'shutdown', msg } at quit.
// To main:   { t: 'ready', wsPort, build } or { t: 'error', msg }.
import { EventEmitter } from 'node:events';
import { GameHost } from '../server/host.js';

const log = (...a) => console.log('[server]', ...a);
process.on('uncaughtException', e => console.error('[server] uncaught exception:', e));
process.on('unhandledRejection', e => console.error('[server] unhandled rejection:', e));

class PortPeerConn extends EventEmitter {
  constructor(peer, port) { super(); this.peer = peer; this.port = port; this.readyState = 1; this.bufferedAmount = 0; }
  send(data, opts) {
    if (this.readyState !== 1) return;
    this.port.postMessage({ t: 'send', peer: this.peer, data: typeof data === 'string' ? data : new Uint8Array(data), unreliable: !!opts?.unreliable, voice: !!opts?.voice });
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.port.postMessage({ t: 'close', peer: this.peer, code, reason: String(reason) });
    this._closed(code, reason);
  }
  terminate() { this.close(1006, 'terminated'); }
  _closed(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

let host = null;
const peers = new Map();
process.parentPort.on('message', async e => {
  const m = e.data;
  if (m.t === 'start' && !host) {
    try {
      host = await new GameHost({ singleRoom: true, log }).init();
      host.start();
      const wsPort = await host.listen({ port: 0, host: '127.0.0.1', origin: m.origin });
      const port = e.ports[0];
      if (port) {
        port.on('message', ({ data: pm }) => {
          if (pm.t === 'open') { const c = new PortPeerConn(pm.peer, port); peers.set(pm.peer, c); host.attach(c, { kind: 'steam', key: pm.key }); }
          else if (pm.t === 'msg') { const c = peers.get(pm.peer); if (c?.readyState === 1) c.emit('message', pm.bin ? Buffer.from(pm.data) : pm.data, !!pm.bin); }
          else if (pm.t === 'close') { const c = peers.get(pm.peer); peers.delete(pm.peer); c?._closed(pm.code ?? 1000, 'closed by main'); }
        });
        port.start();
      }
      log(`listening on 127.0.0.1:${wsPort} (build ${host.build})`);
      process.parentPort.postMessage({ t: 'ready', wsPort, build: host.build });
    } catch (err) {
      console.error('[server] could not start:', err);
      process.parentPort.postMessage({ t: 'error', msg: String(err?.message || err) });
    }
  } else if (m.t === 'end') {
    try { host?.endRooms(m.msg || 'The host ended the trip.'); } catch (err) { console.error('[server] end:', err); }
  } else if (m.t === 'shutdown') {
    // tell every crew the host left (the page shows why), then go
    try { host?.closeAll(m.msg || 'The host closed the game.'); } catch {}
    setTimeout(() => process.exit(0), 250);
  }
});
