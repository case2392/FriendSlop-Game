'use strict';
// The desktop build's save files, in <userData>/save (main.cjs; the page's side is client/js/profile.js):
//   profile.json       the save
//   profile.bak.json   the one before it (each write moves the old file here first)
//   corrupt/           saves that couldn't be read, kept aside (the last 3)
// A write goes to profile.json.tmp, flushed to the disk, and is renamed over profile.json, so a crash, a power
// cut or a full disk mid-write leaves the old save whole. Plain Node (no Electron), so the tests can run it.
const fs = require('node:fs');
const path = require('node:path');

const MAX = 64 * 1024;          // the most a save may take (shared/profile.js MAX_BYTES)
const KEEP_CORRUPT = 3;

const files = dir => ({ main: path.join(dir, 'profile.json'), bak: path.join(dir, 'profile.bak.json'), tmp: path.join(dir, 'profile.json.tmp'), corrupt: path.join(dir, 'corrupt') });
const readSmall = f => {
  try {
    if (fs.statSync(f).size > MAX) return '\u0000too big';   // (not ours: the page finds it unreadable and keeps it aside)
    return fs.readFileSync(f, 'utf8');
  } catch { return null; }
};

// what the page gets in its boot answer: { text, bak } (null where there's no file)
function readSave(dir) {
  const f = files(dir);
  return { text: readSmall(f.main), bak: readSmall(f.bak) };
}

// -> { ok } or { ok: false, msg }
function writeSave(dir, text) {
  if (typeof text !== 'string' || !text.length) return { ok: false, msg: 'nothing to save' };
  if (Buffer.byteLength(text, 'utf8') > MAX) return { ok: false, msg: 'the save is too big' };
  const f = files(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f.tmp, text, { encoding: 'utf8', flush: true });   // (on the disk before it replaces anything)
  // the old save becomes the backup (renamed: its data is on the disk already), if it reads: one that doesn't
  // isn't worth more than the backup it would push out
  if (fs.existsSync(f.main) && readsAsJson(f.main)) renameRetry(f.main, f.bak);
  renameRetry(f.tmp, f.main);
  return { ok: true };
}
const readsAsJson = file => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; } };
// Windows: a virus scanner or the search indexer holding the file a moment makes a rename fail; try again
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
}

// profile.json couldn't be read: into corrupt/ (named by when), keeping the last few
function quarantineSave(dir, now = Date.now()) {
  const f = files(dir);
  if (!fs.existsSync(f.main)) return { ok: true };
  fs.mkdirSync(f.corrupt, { recursive: true });
  fs.renameSync(f.main, path.join(f.corrupt, `profile-${now}.json`));
  const old = fs.readdirSync(f.corrupt).filter(n => /^profile-\d+\.json$/.test(n)).sort((a, b) => Number(a.slice(8, -5)) - Number(b.slice(8, -5)));
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_CORRUPT))) { try { fs.unlinkSync(path.join(f.corrupt, n)); } catch {} }
  return { ok: true };
}

// The game server's environment: a player's copy (packaged) never takes the test switches (a fast clock,
// test levers, the wildlife off) from wherever it was started, so no trip of theirs is quietly practice
function serverEnv(env, packaged) {
  if (!packaged) return { ...env };
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^FRIENDSLOP_/i.test(k)));   // (Windows: any case)
}

module.exports = { readSave, writeSave, quarantineSave, serverEnv, SAVE_MAX: MAX };
