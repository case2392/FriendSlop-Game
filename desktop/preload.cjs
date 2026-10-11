'use strict';
// The page's only door to the desktop shell: window.desktop (a sandboxed preload, context isolation on).
// The client checks for window.desktop to show the desktop's own things (Quit, Invite friends).
const { contextBridge, ipcRenderer } = require('electron');

// what the page needs before its first line runs: the build it must match, where its game server is,
// and whether Steam is up (main.cjs 'desktop:boot')
const boot = ipcRenderer.sendSync('desktop:boot') || {};
const listeners = new Set();
ipcRenderer.on('desktop:event', (_e, ev) => { for (const fn of listeners) { try { fn(ev); } catch (err) { console.error(err); } } });

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  version: boot.version ?? null,
  build: boot.build ?? null,                    // the host turns away a friend on a different build
  wsUrl: boot.wsUrl ?? null,                    // this PC's own game server
  platform: boot.platform ?? null,
  steam: Object.freeze({ ...(boot.steam || { ok: false }) }),   // { ok, name, ... } or { ok: false, reason }
  log: (...a) => ipcRenderer.send('desktop:log', ...a.map(x => String(x))),
  quit: () => ipcRenderer.send('desktop:quit'),
  setFullscreen: on => ipcRenderer.send('desktop:fullscreen', on),
  pickCode: () => ipcRenderer.invoke('desktop:pick-code'),                 // -> { ok, code }: a trip code free on Steam
  host: code => ipcRenderer.invoke('desktop:host', String(code)),         // -> { ok, lobby, code } friends can now join
  invite: () => ipcRenderer.invoke('desktop:invite'),                      // the Steam overlay's invite dialog
  leave: () => ipcRenderer.invoke('desktop:leave'),                        // the trip is over for this PC
  presence: p => ipcRenderer.send('desktop:presence', p),                  // { ph, day, biome } for the friends list
  takeLobby: () => ipcRenderer.invoke('desktop:take-lobby'),               // a friend's trip waiting to be joined?
  joinLobby: id => ipcRenderer.invoke('desktop:join-lobby', String(id)),   // -> { ok, wsUrl, code, hostName, lobby } or { ok: false, msg }
  joinCode: code => ipcRenderer.invoke('desktop:join-code', String(code)), // the same, found by trip code on Steam
  onEvent: fn => { if (typeof fn === 'function') listeners.add(fn); },     // { t: 'lobby', id }: an invite accepted mid-game
});
