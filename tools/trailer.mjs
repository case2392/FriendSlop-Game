// The game's trailer, filmed by the game itself.
//
// Software GL draws a 1080p frame in about a second and a half here, so nothing is filmed in real time: the
// game's server runs inside this process and is ticked by hand, and the page's clock (performance.now and
// requestAnimationFrame) is virtual. Each video frame is exactly 1/30 s of game time: two server ticks, the
// snapshot for that moment, one page frame, and the canvas grabbed as a JPEG. The actors are bots on fake
// connections (they send a pose every tick, as a page would; a knock throws them through the air); the
// camera is the page's own player, whose eye is moved anywhere (in the world, or riding along with the RV).
// The HUD, the nameplates and the hands are left out; the words are set afterwards in the game's own type.
// Music and sound are the game's own synthesizers (client/js/music.js, sfx.js), rendered offline.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tools/trailer.mjs capture [--only a,b] [--w 1920 --h 1080]
//   node tools/trailer.mjs audio        the music beds and the sounds, as WAVs
//   node tools/trailer.mjs cards        the words, as transparent PNGs
//   node tools/trailer.mjs edit         cut it together: dist/trailer/trailer.mp4
// Everything goes in dist/trailer (not in git). Capture is the slow part (about an hour at 1080p); the others
// take a minute or two, so the cut can be changed without filming it again.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const STEP_CMD = argv[0] || 'capture';
const OUT = path.resolve(opt('--out', path.join(ROOT, 'dist/trailer')));
const VW = +opt('--w', 1920), VH = +opt('--h', 1080), FPS = 30;
const ONLY = opt('--only', null)?.split(',');
const SEED = 777;
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)} s]`, ...a);

// ================================================================================================
// CAPTURE
// ================================================================================================
let C, host, page, room, W, browser;
const bots = {};
let tickT = 0;          // server seconds since the capture began (lockstep)
let lastTm = null;      // the last snapshot's server time (the page waits for it before a frame)
let events = [];        // what the server told everyone during the take: [{ f, m }]
let frameNo = 0, recording = false;

// ---- the server: in this process, ticked by hand ---------------------------------------------------
let acc = 0, snapAcc = 0, lockstep = false;
function sendSnaps() {
  for (const r of host.rooms.values()) {
    if (r.closed) continue;
    const snap = r.snapshot(), s = JSON.stringify(snap);
    lastTm = snap.tm;
    for (const p of r.players.values()) { const c = p.conn; if (c && r.wantsSnapshots(p) && c.readyState === 1) c.send(s, { unreliable: true }); }
  }
}
// sec of game time: 1/60 s ticks, each one after the actors have moved; a snapshot every third
function stepServer(sec, act) {
  const STEP = 1 / C.SIM_HZ, SNAP = 1 / C.SNAP_HZ;
  acc += sec;
  while (acc >= STEP - 1e-9) {
    acc -= STEP;
    act?.(tickT);
    for (const b of Object.values(bots)) b.tick(STEP);
    for (const r of host.rooms.values()) if (!r.closed) r.tick(STEP);
    tickT += STEP;
    snapAcc += STEP;
    if (snapAcc >= SNAP - 1e-9) { snapAcc -= SNAP; sendSnaps(); }
  }
}

// ---- the actors: bots on fake connections --------------------------------------------------------
// A bot's pose is set by the shot (where it stands or walks, riding the RV or not); each tick it's sent as a
// page sends it. A knock from the server throws it (a page's own physics does that, so the bot does too).
class Bot {
  constructor(name) {
    this.name = name;
    const h = {};
    const self = this;
    this.conn = {
      readyState: 1, bufferedAmount: 0,
      send(d) {
        if (typeof d !== 'string') return;
        const m = JSON.parse(d);
        if (m.t === 'welcome') self.id = m.id;
        else if (m.t === 'knock') self.onKnock(m);
        else if (m.t === 'revived') self.downed = false;
        if (self.listen && (m.t === 'toast' || m.t === 'ev' || m.t === 'over' || m.t === 'receipt')) { if (recording) events.push({ f: frameNo, m }); }
      },
      on(ev, fn) { h[ev] = fn; }, close() {}, terminate() {},
    };
    host.attach(this.conn, { kind: 'local' });
    // (joined through the host like a page; after that straight to the room: the host's per-connection
    // rate limit runs on real time, and a pre-roll runs game seconds in a fraction of one)
    h.message(JSON.stringify({ t: 'join', name, room: room.code }), false);
    this.say = m => { const P = this.P; if (P) room.handle(P, m); };
    this.pos = { x: 0, y: 0, z: 0 }; this.yaw = 0; this.pitch = 0;
    this.par = 0; this.mode = C.MODE.WALK; this.flags = 0;
    this.fly = null; this.downed = false;
    this.last = null; this.extraFlags = 0;
  }
  get P() { return room.players.get(this.id); }
  // stand (or walk: the velocity is worked out from the last pose) at x, z on the ground, facing yaw
  at(x, z, yaw = this.yaw, { y = null, crouch = false, sprint = false, pitch = this.pitch } = {}) {
    if (this.fly || this.downed) return;
    this.par = 0; this.mode = C.MODE.WALK;
    this.pos = { x, y: y ?? W.heightAt(x, z) + 0.02, z }; this.yaw = yaw; this.pitch = pitch;
    this.flags = (crouch ? C.FLAG.CROUCH : 0) | (sprint ? C.FLAG.SPRINT : 0);
  }
  // riding: RV-local feet
  ride(x, z, yaw = 0, { y = 0.1, crouch = false, pitch = this.pitch } = {}) {
    if (this.fly || this.downed) return;
    this.par = 1; this.mode = C.MODE.WALK;
    this.pos = { x, y, z }; this.yaw = yaw; this.pitch = pitch; this.flags = crouch ? C.FLAG.CROUCH : 0;
  }
  eye() { const p = this.P?.pos || this.pos; return { x: p.x, y: p.y + C.PLAYER.EYE, z: p.z }; }
  seat() { this.par = 1; this.mode = C.MODE.SEAT; this.pos = { x: 0.62, y: 0.02, z: 2.72 }; this.yaw = 0; this.flags = 0; }
  onKnock(m) {
    if (this.mode === C.MODE.SEAT) return;
    // where it is now, in the world (riding: the RV's velocity comes along when the knock says so)
    const P = this.P, w = P?.pos || this.pos;
    const base = m.rel && this.par ? (() => { const v = room.sim.rv.linvel(); return { x: v.x, y: v.y, z: v.z }; })() : { x: 0, y: 0, z: 0 };
    this.par = 0;
    this.pos = { x: w.x, y: w.y, z: w.z };
    this.fly = { v: { x: base.x + m.v[0], y: base.y + m.v[1], z: base.z + m.v[2] } };
    this.mode = C.MODE.AIR;
    if (m.ko) { this.downed = true; this.say({ t: 'ko', why: m.why || 'fall' }); }
  }
  tick(dt) {
    if (this.fly) {
      const f = this.fly, g = 20;   // (the game's gravity: shared/constants.js PLAYER.GRAVITY)
      f.v.y -= g * dt;
      this.pos = { x: this.pos.x + f.v.x * dt, y: this.pos.y + f.v.y * dt, z: this.pos.z + f.v.z * dt };
      const gy = W.heightAt(this.pos.x, this.pos.z) + 0.02;
      if (this.pos.y <= gy && f.v.y < 0) {
        this.pos.y = gy;
        // a bounce, then a slide to a stop
        if (Math.abs(f.v.y) > 6) { f.v.y = -f.v.y * 0.25; f.v.x *= 0.6; f.v.z *= 0.6; }
        else { f.v.y = 0; const k = this.downed ? 0.949 : 0.85; f.v.x *= k; f.v.z *= k; if (Math.hypot(f.v.x, f.v.z) < 0.3) { this.fly = null; } }
      }
      this.mode = this.fly ? C.MODE.AIR : this.downed ? C.MODE.KO : C.MODE.WALK;
    }
    const v = this.last && this.par === this.last.par ? [(this.pos.x - this.last.x) / dt, (this.pos.y - this.last.y) / dt, (this.pos.z - this.last.z) / dt] : [0, 0, 0];
    this.last = { ...this.pos, par: this.par };
    this.say({ t: 'p', par: this.par, x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: this.pitch, m: this.downed && !this.fly ? C.MODE.KO : this.mode, f: this.flags | this.extraFlags, v });
  }
  wake() { if (this.downed) { this.downed = false; this.fly = null; this.mode = C.MODE.WALK; this.say({ t: 'wake' }); } }
}

// ---- driving: the driver bot's keys, from where the RV is ------------------------------------------
const rvPose = () => { const t = room.sim.rv.translation(), q = room.sim.rv.rotation(); return { t, q, yaw: Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)) }; };
const rvSpeed = () => { const v = room.sim.rv.linvel(); return Math.hypot(v.x, v.z); };
// follow the road (or a lateral offset from it) at up to vmax; brake to stop
function drive(b, { vmax = 12, off = 0, stop = false, look = 12 } = {}) {
  const { t, yaw } = rvPose(), z = t.z + look;
  const want = Math.atan2(W.roadX(z) + off - t.x, z - t.z);
  const e = Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw));
  const st = Math.max(-1, Math.min(1, e * 2.5));
  const v = rvSpeed();
  b.say({ t: 'drv', th: stop ? 0 : v < vmax - 0.3 ? 1 : v > vmax + 0.6 ? -0.4 : 0, st, hb: stop && v < 1.5 ? 1 : 0 });
}

// ---- the page --------------------------------------------------------------------------------------
// virtual time: performance.now and requestAnimationFrame stop and are stepped by hand in lockstep; back to
// real time (carrying on from where it stopped) for day changes and the like
const VT = `(() => {
  const realNow = performance.now.bind(performance), realRaf = window.requestAnimationFrame.bind(window);
  let manual = false, vnow = 0, off = 0, q = [];
  performance.now = () => manual ? vnow : realNow() + off;
  window.requestAnimationFrame = cb => { if (manual) { q.push(cb); return q.length; } return realRaf(() => cb(realNow() + off)); };
  window.__vt = {
    enable() { if (!manual) { vnow = realNow() + off; manual = true; } return vnow; },
    disable() { if (manual) { off = vnow - realNow(); manual = false; const run = q; q = []; for (const cb of run) realRaf(() => cb(realNow() + off)); } },
    step(ms) { vnow += ms; const run = q; q = []; for (const cb of run) cb(vnow); return run.length; },
  };
})();`;

// the camera: the page's eye goes where the shot says (window.__cam: { p, t } in the world, or { rel: true,
// p, t } riding with the RV), its field of view too; nameplates and (unless a shot wants them) the hands
// are left out of the picture
const CINE = () => {
  const S = window.__nmd, M = S.me;
  const rot = (q, v) => { const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x); return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) }; };
  const L = (rv, l) => { const r = rot(rv.q, l); return { x: rv.p.x + r.x, y: rv.p.y + r.y, z: rv.p.z + r.z }; };
  const cur = () => { const c = window.__cam; if (!c) return null; if (c.rel) return S.rv ? { p: L(S.rv, c.p), t: L(S.rv, c.t) } : null; return c; };
  M._eye = M.eye.bind(M); M._look = M.look.bind(M);
  M.eye = rv => cur()?.p ?? M._eye(rv);
  M.look = () => { const c = cur(); if (!c) return M._look(); const d = { x: c.t.x - c.p.x, y: c.t.y - c.p.y, z: c.t.z - c.p.z }, l = Math.hypot(d.x, d.y, d.z); return { x: d.x / l, y: d.y / l, z: d.z / l }; };
  window.__L = L;
  const R = S.renderer(), scene = S.rvView().g.parent;
  let cam = null; scene.traverse(o => { if (!cam && o.isPerspectiveCamera) cam = o; });
  const K = window.__cine = { hands: false, fov: null };
  const orig = R.render.bind(R);
  R.render = (sc, c) => {
    if (c !== cam) return orig(sc, c);
    for (const v of S.views.values()) if (v.label) v.label.visible = false;
    const hv = cam.children.map(h => h.visible);
    if (!K.hands) cam.children.forEach(h => { h.visible = false; });
    const fov = cam.fov;
    if (K.fov) { cam.fov = K.fov; cam.updateProjectionMatrix(); }
    orig(sc, c);
    cam.children.forEach((h, i) => { h.visible = hv[i]; });
    if (K.fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
  };
};

async function boot() {
  process.env.FRIENDSLOP_TEST = '1';
  process.env.FRIENDSLOP_NOMOBS = '1';   // (no wildlife but what a shot puts there)
  C = await import(path.join(ROOT, 'shared/constants.js'));
  const { GameHost } = await import(path.join(ROOT, 'server/host.js'));
  const { chromium } = await import('playwright-core');
  host = await new GameHost({ log: () => {} }).init();
  host.start();
  const port = await host.listen({ port: 0 });
  // headful under Xvfb: Chromium draws on Mesa's llvmpipe, several times quicker than SwiftShader
  const headful = !!process.env.DISPLAY;
  browser = await chromium.launch({
    headless: !headful, executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: headful ? ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  await ctx.addInitScript(VT);
  page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on('pageerror', e => log('page error:', e.message));
  await page.goto(`http://localhost:${port}/?quality=high`);
  await page.evaluate(() => { localStorage.setItem('nmdHelpSeen', '1'); localStorage.setItem('nmdVoiceAsked', '1'); window.__nmd?.setSetting?.('tutorial', false); });
  await page.fill('#nameInput', 'Cam');
  await page.fill('#seedInput', String(SEED));
  await page.click('#hostBtn');
  await page.waitForFunction(() => window.__nmd?.W && window.__nmd?.rv && (window.__nmd.frames || 0) > 10, null, { timeout: 600000 });
  const gpu = await page.evaluate(() => window.__nmd.gpu().name);
  log('page ready on', gpu.slice(0, 60));
  if (headful && !/llvmpipe/i.test(gpu)) log('!! not llvmpipe: this will be slow');
  room = host.rooms.get(await page.evaluate(() => window.__nmd.code));
  W = room.W;
  room.typedSeed = false;
  for (const n of ['Dave', 'Steve', 'Kyle']) bots[n] = new Bot(n);
  bots.Dave.listen = true;
  // the picture: no HUD (the vignette stays), the free camera
  await page.addStyleTag({ content: '#game > :not(canvas):not(#vignette), #clickToPlay { visibility: hidden !important; }' });
  await page.evaluate(CINE);
  await page.evaluate(() => { const S = window.__nmd; S.forceLock = true; });
  log('crew:', Object.values(bots).map(b => `${b.name} #${b.id}`).join(', '));
}

const dbg = m => room.debug(null, m);
const me = async () => page.evaluate(() => window.__nmd.selfId);
async function realtime() {
  if (!lockstep) return;
  host.start();
  await page.evaluate(() => window.__vt.disable());
  lockstep = false;
}
async function lock() {
  if (lockstep) return;
  host.stop();
  await page.evaluate(() => { window.__vt.enable(); window.__pinOff = null; const I = window.__nmd.interp; I.offs.length = 0; I.offset = null; });
  lockstep = true;
}
// a new day: real time while the page builds it
async function toDay(d) {
  if (room.day === d && W.day === d) return;
  await realtime();
  const built = await page.evaluate(() => window.__nmd.builtAt);
  dbg({ op: 'day', d });
  W = room.W;
  await page.waitForFunction(([dd, b]) => window.__nmd.W?.day === dd && window.__nmd.builtAt !== b, [d, built], { timeout: 600000 });
  await page.waitForFunction(() => window.__nmd.texCache?.idle?.() ?? true, null, { timeout: 600000 }).catch(() => {});
  await page.waitForTimeout(3000);
  log(`day ${d} built`);
}

// one video frame: the server moves 1/30 s (act each tick), the page waits for that snapshot and draws one
// frame; shoot: the canvas as a JPEG
async function frame(act, { shoot = true, cam = null, body = null, dir = null } = {}) {
  stepServer(1 / FPS, act);
  const r = await page.evaluate(([tm, dt, shoot, cam, body]) => new Promise(res => {
    const S = window.__nmd, w0 = Date.now();
    const go = () => {
      if (tm != null && S.interp.lastTm < tm && Date.now() - w0 < 5000) { setTimeout(go, 1); return; }
      const I = S.interp;
      if (window.__pinOff == null) window.__pinOff = I.offset;   // (one offset a take: drawn a fixed time behind)
      I.offset = window.__pinOff;
      if (cam !== undefined) window.__cam = cam;
      // the cameraman's body: near the shot (the sun's shadows and the world's detail follow it), out of it
      if (body) {
        const b = body.rel && S.rv ? window.__L(S.rv, body) : body;
        S.me.teleport(b.x, (body.y != null && !body.rel) ? b.y : S.W.heightAt(b.x, b.z) + 0.05, b.z);
      }
      S.noRender = !shoot;
      window.__vt.step(dt);
      res({ url: shoot ? S.renderer().domElement.toDataURL('image/jpeg', 0.95) : null });
    };
    go();
  }), [lastTm, 1000 / FPS, shoot, cam, body]);
  if (!shoot) await new Promise(r => setTimeout(r, 9));
  if (shoot && dir) {
    fs.writeFileSync(path.join(dir, `f${String(frameNo).padStart(4, '0')}.jpg`), Buffer.from(r.url.split(',')[1], 'base64'));
    frameNo++;
  }
}

// a take: `pre` seconds run without drawing (to get things moving), then `secs` filmed. tick(t) moves the
// actors (t: seconds since the take began, pre-roll included); cam(t) and body(t) place the camera
async function take(shot) {
  const dir = path.join(OUT, 'shots', shot.id);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  await lock();
  await page.evaluate(([fov, hands]) => { window.__cine.fov = fov; window.__cine.hands = hands; }, [shot.fov ?? 62, !!shot.hands]);
  const t0 = tickT, n = Math.round((shot.pre || 0) * FPS), m = Math.round(shot.secs * FPS);
  const act = tt => shot.tick?.(tt - t0);
  events = []; frameNo = 0;
  const started = Date.now();
  // (a few frames to settle the page's clock against the server's before the pre-roll)
  for (let i = 0; i < 4; i++) await frame(act, { shoot: false, cam: shot.cam?.(0) ?? null, body: shot.body?.(0) ?? null });
  const state = () => { const { t } = rvPose(); return `rv z ${t.z.toFixed(1)} x ${t.x.toFixed(1)} v ${rvSpeed().toFixed(1)} hp ${Math.round(room.rvc.hp)} seat0 ${[...room.players.values()].find(p => p.seat === 0)?.name ?? '-'} ${room.phase} ${room.clock.toFixed(2)}`; };
  if (process.env.TRAILER_DEBUG) log(`  ${shot.id} start: ${state()}`);
  // the pre-roll: `pre` s, or (startWhen) until the action is close, at most `preMax` s; the last two frames
  // drawn (the picture settles)
  const until = shot.startWhen ? Math.round((shot.preMax ?? 20) * FPS) : n;
  for (let i = 0; i < until; i++) {
    const t = tickT - t0;
    if (shot.preAct) await shot.preAct.call(shot, i);
    const ready = shot.startWhen ? shot.startWhen.call(shot, t) : i >= n - 2;
    await frame(act, { shoot: ready || i >= n - 2, cam: shot.cam?.(t) ?? null, body: shot.body?.(t) ?? null });
    if (process.env.TRAILER_DEBUG && i % 30 === 29) log(`  pre ${((i + 1) / FPS).toFixed(1)} s: ${state()}`);
    if (shot.startWhen && ready) break;
  }
  recording = true;
  for (let i = 0; i < m; i++) { const t = tickT - t0; await frame(act, { shoot: true, dir, cam: shot.cam?.(t) ?? null, body: shot.body?.(t) ?? null }); if (process.env.TRAILER_DEBUG && i % 30 === 29) log(`  rec ${((i + 1) / FPS).toFixed(1)} s: ${state()}`); }
  if (process.env.TRAILER_DEBUG) for (const e of events) if (e.m.t === 'toast') log(`  f${e.f} "${e.m.text}"`);
  recording = false;
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events.map(e => ({ f: e.f, ...e.m })), null, 0));
  log(`${shot.id}: ${m} frames in ${((Date.now() - started) / 1000).toFixed(0)} s (${((Date.now() - started) / Math.max(1, m + n)).toFixed(0)} ms a frame)`);
}

// ---- helpers for shots ---------------------------------------------------------------------------------
const H = (x, z) => W.heightAt(x, z);
const lerp = (a, b, u) => a + (b - a) * u;
const ease = u => u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u);
// true once every `period` s (from `phase`), for a tick at t (ticks are 1/60 s apart)
// (t sums 1/60 steps, so it lands a hair either side of a beat: the 1e-6 nudge makes every beat fire once)
const every = (t, period, phase = 0) => { const u = t - phase + 1e-6; return u >= 0 && u - Math.floor(u / period) * period < 1 / 60; };
const lerp3 = (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) });
const at = (x, z, dy) => ({ x, y: H(x, z) + dy, z });
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
// a point in the RV's frame, in the world (the server's RV, now)
function rvAt(l) {
  const { t, q } = rvPose();
  const tx = 2 * (q.y * l.z - q.z * l.y), ty = 2 * (q.z * l.x - q.x * l.z), tz = 2 * (q.x * l.y - q.y * l.x);
  return { x: t.x + l.x + q.w * tx + (q.y * tz - q.z * ty), y: t.y + l.y + q.w * ty + (q.z * tx - q.x * tz), z: t.z + l.z + q.w * tz + (q.x * ty - q.y * tx) };
}
// seat a bot at the wheel (the roles say who may)
function seatDriver(b, nav = bots.Steve.id) {
  dbg({ op: 'roles', drv: b.id, nav });
  for (const o of Object.values(bots)) if (o !== b && o.P?.seat === 0) { o.say({ t: 'use', kind: 'unseat' }); }
  b.wake();
  if (b.P?.seat !== 0) {
    b.mode = C.MODE.WALK; b.ride(0.25, 2.0);
    b.tick(1 / 60);
    room.tick(1 / 60);
    b.say({ t: 'use', kind: 'seat0' });
  }
  if (b.P?.seat !== 0) log(`!! ${b.name} didn't get the wheel (${JSON.stringify(b.P?.pos)})`);
  b.seat();
}
function unseat(b) { if (b.P?.seat != null) b.say({ t: 'use', kind: 'unseat' }); b.mode = C.MODE.WALK; }
function park(b, x, z) { b.wake(); b.at(x, z, 0); }
// everyone off stage, somewhere quiet (bots who aren't in a shot stand behind the camera)
function offstage(...bs) { let i = 0; for (const b of bs) { unseat(b); b.wake(); b.at(-40 - i * 2, -60, 0); i++; } }
const hyp = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
// a bot looks at a point (what it holds goes where it looks)
function lookAt(b, p) { const e = b.eye(); b.yaw = Math.atan2(p.x - e.x, p.z - e.z); b.pitch = -Math.atan2(p.y - e.y, Math.hypot(p.x - e.x, p.z - e.z)); }
// a bot grabs a prop (looking at it, from where it stands; up: aim that much over its middle)
function grab(b, prop, up = 0) {
  const w = prop.body.translation(), aim = { x: w.x, y: w.y + up, z: w.z };
  lookAt(b, aim); b.tick(1 / 60);
  const e = b.eye(), d = Math.hypot(w.x - e.x, w.y - e.y, w.z - e.z);
  b.say({ t: 'grab', kind: 'prop', id: prop.id, pt: [w.x, w.y, w.z], d });
  return room.sim.holds.get(b.id)?.id === prop.id;
}
function spawnProp(type, x, y, z, value = 100) {
  const pr = room.sim.addProp(type, { x, y, z }, { x: 0, y: 0, z: 0, w: 1 }, value, value);
  if (pr) room.broadcast({ t: 'ev', list: [{ k: 'spawn', p: room.sim.describe(pr) }] });
  return pr;
}
function spawnMob(type, x, z, opts = {}) { return room.sim.ensureMobs({ day: room.day, crew: room.liveCrew(), seed: room.seed }).spawn(type, x, z, opts); }

// ================================================================================================
// THE SHOTS (seed 777: every place below is where that seed puts it)
// ================================================================================================
const SHOTS = [];
const shot = s => SHOTS.push(s);

// ---- day 1 -----------------------------------------------------------------------------------------
// the crew at the campfire, not working: Steve spins, Kyle lies there, Dave cries
shot({
  id: 'campfire', day: 1, secs: 3.0, pre: 0.6, fov: 52,
  setup() {
    dbg({ op: 'phase', ph: 'camp' }); dbg({ op: 'clock', h: 7.0 }); dbg({ op: 'tpRV', x: 0, z: -42, yaw: 0 });
    offstage(bots.Dave, bots.Steve, bots.Kyle);
  },
  tick(t) {
    const { Dave, Steve, Kyle } = bots, C0 = { x: -11.2, z: -54.4 };
    // (placed in the camera's view: Steve spinning on the left, Kyle flat out in front, Dave crying on the right)
    Steve.at(-5.1, -50.0, 2.4 + t * 5);
    Kyle.at(-9.4, -49.6, yawTo({ x: -9.4, z: -49.6 }, C0));
    Dave.at(-8.4, -47.3, yawTo({ x: -8.4, z: -47.3 }, C0));
    if (every(t, 2.8)) { Steve.say({ t: 'emote', e: '🤡' }); Kyle.say({ t: 'emote', e: '💀' }); Dave.say({ t: 'emote', e: '😭' }); }
  },
  cam: t => ({ p: at(lerp(-11.4, -10.9, t / 3.6), lerp(-54.6, -54.0, t / 3.6), 1.5), t: at(-6.9, -49.0, 0.9) }),
  body: () => ({ x: -18, z: -60 }),
});

// the RV rolls out of the dawn camp past the DAY 1 post (chase, off its quarter)
shot({
  id: 'rollout', day: 1, secs: 2.6, pre: 2.5, fov: 60,
  setup() {
    dbg({ op: 'phase', ph: 'camp' }); dbg({ op: 'clock', h: 6.6 }); dbg({ op: 'tpRV', x: 0, z: -42, yaw: 0 });
    offstage(bots.Steve, bots.Kyle);
    seatDriver(bots.Dave);
  },
  tick() { bots.Dave.seat(); drive(bots.Dave, { vmax: 8 }); },
  cam: t => ({ rel: true, p: { x: lerp(6.5, 5.0, t / 5), y: 2.4, z: lerp(-9, -6, t / 5) }, t: { x: 0, y: 1.2, z: 2 } }),
  body: () => ({ rel: true, x: 14, y: 0, z: -4 }),
});

// riding in the RV: Dave at the wheel, Steve up front with the map, Kyle laughing at the dinette
shot({
  id: 'cab', day: 1, secs: 2.8, pre: 4.0, fov: 74,
  setup() {
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 8.4 });
    dbg({ op: 'tpRV', x: W.roadX(30), z: 30, yaw: Math.atan2(W.roadX(38) - W.roadX(30), 8) });
    seatDriver(bots.Dave);
    const { Steve } = bots;
    Steve.ride(-0.15, 2.0, 0.2); Steve.tick(1 / 60);
    const map = [...room.sim.props.values()].find(q => q.type === 'map');
    if (map) { this.map = grab(Steve, map); log(`  Steve has the map: ${this.map}`); }
    Steve.extraFlags = this.map ? C.FLAG.HOLDING | C.FLAG.MAP : 0;
  },
  tick(t) {
    const { Dave, Steve, Kyle } = bots;
    Dave.seat(); drive(Dave, { vmax: 9 });
    Steve.ride(-0.15, 2.0, 0.25, { pitch: 0.35 }); Kyle.ride(0.62, 0.75, -1.9);
    if (every(t, 2.8, 0.3)) Kyle.say({ t: 'emote', e: '😂' });
  },
  cam: () => ({ rel: true, p: { x: -0.35, y: 1.7, z: -1.6 }, t: { x: 0.25, y: 1.25, z: 4.0 } }),
  body: () => ({ rel: true, x: -12, y: 0, z: 0 }),
});

// the navigator's own view: the paper road map held up in the cab (the camera's player holds it)
shot({
  id: 'mapfp', day: 1, secs: 1.8, pre: 3.0, fov: null, hands: true,
  async setup() {
    dbg({ op: 'phase', ph: 'camp' }); dbg({ op: 'clock', h: 7.6 }); dbg({ op: 'tpRV', x: 0, z: -42, yaw: 0 });
    offstage(bots.Steve, bots.Kyle);
    seatDriver(bots.Dave, await me());
    // the map back on the dash, where the morning puts it (an earlier shot may have left it anywhere)
    const { RV_MAP_SPOT, toWorld: tw } = await import(path.join(ROOT, 'shared/rv.js'));
    const map = [...room.sim.props.values()].find(q => q.type === 'map');
    if (map) { const r = room.sim.rv; map.body.setTranslation(tw(r.translation(), r.rotation(), RV_MAP_SPOT), true); map.body.setRotation(r.rotation(), true); map.body.setLinvel({ x: 0, y: 0, z: 0 }, true); map.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
  },
  // (the camera's own player, in lockstep with the RV held still: in beside the driver, the map picked up)
  async preAct(i) {
    if (i === 20) await page.evaluate(() => { const S = window.__nmd, w = window.__L(S.rv, { x: -0.1, y: 0.1, z: 2.25 }); S.me.teleport(w.x, w.y + 0.05, w.z, Math.atan2(2 * (S.rv.q.w * S.rv.q.y + S.rv.q.x * S.rv.q.z), 1 - 2 * (S.rv.q.x * S.rv.q.x + S.rv.q.y * S.rv.q.y))); });
    if (i === 40) await page.evaluate(() => { const S = window.__nmd, map = [...S.props.values()].find(p => p.type === 'map'); const p = map?.pose?.p || map?.mesh?.position; if (p) S.aimAt(p.x, p.y, p.z); });
    if (i === 46) await page.evaluate(() => window.__nmd.press('grab'));
    if (i === 70) { const r = await page.evaluate(() => { const S = window.__nmd; S.me.pitch = 0.12; return S.me.holding?.ok ? 'holding' : `not holding (${S.target()?.label})`; }); log(`  the map: ${r}`); }
  },
  tick() { bots.Dave.seat(); drive(bots.Dave, { stop: true }); },
});

// the winch: the cable taut up the washed-out grade, the RV crawling up
shot({
  id: 'winch', day: 1, secs: 2.6, pre: 1.2, fov: 60,
  setup() {
    const g = W.obstacles.find(o => o.type === 'grade');
    this.rz = g.z0 - 7; this.rx = W.roadX(this.rz);
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 15.5 });
    dbg({ op: 'tpRV', x: this.rx, z: this.rz, yaw: 0 });
    offstage(bots.Kyle);
    seatDriver(bots.Dave);
    const { Steve, Dave } = bots, w = room.sim.winchWorld();
    Steve.at(w.x, w.z + 1.2, Math.PI); Steve.tick(1 / 60); room.tick(1 / 60);
    Steve.say({ t: 'use', kind: 'winch' });
    const anc = W.anchors[0];
    this.anc = anc;
    for (let i = 1; i <= 16; i++) { Steve.at(lerp(w.x, anc.x - 0.8, i / 16), lerp(w.z + 1.2, anc.z - 0.8, i / 16), 0); Steve.tick(1 / 60); for (let k = 0; k < 6; k++) room.tick(1 / 60); }
    Steve.say({ t: 'use', kind: 'hook' });
    Dave.say({ t: 'use', kind: 'reel' });
    log(`  hook ${room.sim.hook.state}, reeling ${room.sim.hook.reeling}`);
  },
  tick() { const { Dave, Steve } = bots; Dave.seat(); Steve.at(this.anc.x - 0.8, this.anc.z - 0.8, Math.PI); },
  cam() { const r = rvPose().t, x = this.rx - 6.8, z = this.rz + 4; return { p: { x, y: H(x, z) + 1.5, z }, t: { x: r.x, y: r.y + 0.9, z: r.z + 2.5 } }; },
  body() { return { x: this.rx - 10, z: this.rz + 2 }; },
});

// Honest Ed's counter: ED OFFERS, the bell, the loot gone in a sparkle (ka-ching)
shot({
  id: 'pawn', day: 1, secs: 3.0, pre: 0.8, fov: 58,
  setup() {
    const T = W.town;
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 18.3 });
    dbg({ op: 'tpRV', x: 0, z: W.LEN + 6, yaw: 0 });
    for (let k = 0; k < 10; k++) room.tick(1 / 60);
    spawnProp('vase', T.pawn.x, T.pawn.y + 0.45, T.pawn.z - 1.3, 520);
    spawnProp('neon', T.pawn.x, T.pawn.y + 0.45, T.pawn.z + 0.9, 380);
    spawnProp('painting', T.pawn.x, T.pawn.y + 0.45, T.pawn.z - 0.2, 450);
    this.bell = W.uses.findIndex(u => u.kind === 'pawnBell');
    offstage(bots.Dave, bots.Steve);
    this.rung = false;
  },
  tick(t) {
    const { Kyle } = bots, u = W.uses[this.bell];
    Kyle.at(u.x + 1.0, u.z + 1.2, yawTo({ x: u.x + 1.0, z: u.z + 1.2 }, u));
    if (!this.rung && t > 2.2) { this.rung = true; Kyle.say({ t: 'use', id: this.bell }); }
  },
  cam(t) { const P = W.town.pawn; return { p: { x: P.x + 3.6 - t * 0.12, y: P.y + 0.75, z: P.z + 0.4 }, t: { x: P.x - 1.2, y: P.y + 0.45, z: P.z - 0.2 } }; },
  body() { const P = W.town.pawn; return { x: P.x + 6, z: P.z + 3 }; },
});

// CRUNCH: Dave drives into the closed ranger gate (the riders lurch)
shot({
  id: 'gate', day: 1, secs: 3.0, pre: 1, fov: 62, preMax: 25,
  startWhen() { return rvPose().t.z > this.gz - 17; },
  setup() {
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 10.0 }); dbg({ op: 'rvhp', hp: 100 });
    this.gz = W.obstacles.find(o => o.type === 'gate').z;
    dbg({ op: 'tpRV', x: W.roadX(this.gz - 70), z: this.gz - 70, yaw: Math.atan2(W.roadX(this.gz - 62) - W.roadX(this.gz - 70), 8) });
    seatDriver(bots.Dave);
  },
  tick() {
    const { Dave, Steve, Kyle } = bots;
    Dave.seat(); drive(Dave, { vmax: 10 });
    Steve.ride(-0.3, -1.2, 0); Kyle.ride(0.3, 0.5, 0);
  },
  cam() { return { p: at(W.roadX(this.gz - 7) - 6.5, this.gz - 7, 1.6), t: at(W.roadX(this.gz - 1) + 1.0, this.gz - 1, 1.5) }; },
  body() { return { x: W.roadX(this.gz - 10) - 13, z: this.gz - 10 }; },
});

// Dave runs Steve over
shot({
  id: 'runover', day: 1, secs: 3.0, pre: 1, fov: 62, preMax: 25,
  startWhen() { return rvPose().t.z > 192 - 24; },
  setup() {
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 10.5 }); dbg({ op: 'rvhp', hp: 100 });
    dbg({ op: 'tpRV', x: W.roadX(110), z: 110, yaw: Math.atan2(W.roadX(118) - W.roadX(110), 8) });
    seatDriver(bots.Dave);
    offstage(bots.Kyle);
  },
  tick() {
    const { Dave, Steve } = bots;
    Dave.seat(); drive(Dave, { vmax: 11 });
    Steve.at(W.roadX(192) + 0.6, 192, -Math.PI / 2);
  },
  cam: () => ({ p: at(W.roadX(186) - 9, 186, 1.4), t: at(W.roadX(191) + 1, 191, 1.4) }),
  body: () => ({ x: W.roadX(180) - 14, z: 180 }),
});

// broken down at dusk: smoke from the hatch, the hazards blinking, three of them at the engine, it catches
shot({
  id: 'breakdown', day: 1, secs: 4.0, pre: 2.0, fov: 58,
  setup() {
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 20.55 });
    dbg({ op: 'tpRV', x: W.roadX(700), z: 700, yaw: Math.atan2(W.roadX(708) - W.roadX(700), 8) });
    for (const b of Object.values(bots)) unseat(b);
    dbg({ op: 'rvhp', hp: 0 });
    this.fixing = false;
  },
  tick(t) {
    const { Dave, Steve, Kyle } = bots, yaw = rvPose().yaw;
    [[Dave, -0.75], [Steve, 0], [Kyle, 0.75]].forEach(([b, x]) => { const w = rvAt({ x, y: 0, z: -5.05 }); b.at(w.x, w.z, yaw); });
    if (!this.fixing && t > 2.4) { this.fixing = true; for (const b of [Dave, Steve, Kyle]) b.say({ t: 'fix', on: 1 }); }
  },
  cam: () => ({ rel: true, p: { x: -4.6, y: 1.8, z: -11.5 }, t: { x: 0, y: 1.3, z: -3 } }),
  body: () => ({ rel: true, x: -14, y: 0, z: -12 }),
});

// the Lucky Slop's neon at night
shot({
  id: 'neon', day: 1, secs: 2.0, pre: 0.5, fov: 60,
  setup() {
    offstage(bots.Dave, bots.Steve, bots.Kyle);
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 21.4 });
    dbg({ op: 'tpRV', x: 0, z: W.town.lot.z, yaw: 0 });
  },
  cam: t => { const y = W.town.y; return { p: { x: 2, y: y + 1.7, z: W.town.z + 44 + t * 0.4 }, t: { x: 11.8, y: y + lerp(5.0, 6.6, ease(t / 2.6)), z: W.town.z + 58 } }; },
  body: () => ({ x: 3, z: W.town.z + 40 }),
});

// body-vote blackjack: the whole bank on the table, the three of them on the HIT pad
shot({
  id: 'blackjack', day: 1, secs: 2.0, pre: 0.5, fov: 58,
  setup() {
    const B = W.town.bj, all = W.uses.findIndex(u => u.kind === 'bj' && u.arg === 'all'), deal = W.uses.findIndex(u => u.kind === 'bj' && u.arg === 'deal');
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 21.6 }); dbg({ op: 'bank', v: 6000 });
    const { Kyle } = bots, u = W.uses[all];
    Kyle.at(u.x - 1.3, u.z, Math.PI / 2); Kyle.tick(1 / 60); room.tick(1 / 60);
    Kyle.say({ t: 'use', id: all }); Kyle.say({ t: 'use', id: deal });
    this.B = B;
  },
  tick() {
    const { Dave, Steve, Kyle } = bots, h = this.B.hit, f = yawTo(h, this.B.table);
    Dave.at(h.x, h.z, f); Steve.at(h.x - 0.45, h.z + 0.35, f); Kyle.at(h.x + 0.4, h.z - 0.35, f);
  },
  cam: t => { const B = SHOTS.find(s => s.id === 'blackjack').B; return { p: { x: B.table.x - 0.6 - t * 0.15, y: B.table.y + 0.95, z: B.table.z + 2.6 }, t: { x: B.hit.x, y: B.table.y + 0.05, z: B.hit.z + 0.2 } }; },
  body: () => ({ x: W.town.bj.table.x - 2, z: W.town.bj.table.z + 7 }),
});

// double or nothing: ALL IN, the lever, FLIPPING..., NOTHING (the machine is told to lose)
shot({
  id: 'coinflip', day: 1, secs: 3.4, pre: 0.4, fov: 62,
  setup() {
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 21.8 }); dbg({ op: 'bank', v: 4500 });
    this.all = W.uses.findIndex(u => u.kind === 'flip' && u.arg === 'all');
    this.pull = W.uses.findIndex(u => u.kind === 'flip' && u.arg === 'pull');
    room.flip.rng = () => 0.99;
    const { Kyle } = bots, F = W.town.flip;
    Kyle.at(F.x - 2.1, F.z + 0.7, Math.PI / 2); Kyle.tick(1 / 60); room.tick(1 / 60);
    Kyle.say({ t: 'use', id: this.all });
    this.pulled = false; this.sad = false;
  },
  tick(t) {
    const { Dave, Kyle, Steve } = bots, F = W.town.flip;
    Kyle.at(F.x - 2.1, F.z + 0.7, Math.PI / 2);
    Dave.at(F.x - 3.0, F.z - 1.3, Math.PI / 2 - 0.5);
    Steve.at(F.x - 3.3, F.z + 2.0, Math.PI / 2 + 0.6);
    if (!this.pulled && t > 0.5) { this.pulled = true; Kyle.say({ t: 'use', id: this.pull }); }
    if (!this.sad && t > 2.9) { this.sad = true; Kyle.say({ t: 'emote', e: '😭' }); Dave.say({ t: 'emote', e: '🤬' }); Steve.say({ t: 'emote', e: '💀' }); }
  },
  cam: () => { const F = W.town.flip; return { p: { x: F.x - 4.5, y: F.y + 1.65, z: F.z + 3.1 }, t: { x: F.x - 0.1, y: F.y + 1.35, z: F.z + 0.1 } }; },
  body: () => ({ x: W.town.flip.x - 6, z: W.town.flip.z + 5 }),
});

// the Repo Man by his tow truck, at night (a slow push in)
shot({
  id: 'repoman', day: 1, secs: 4.0, pre: 0.4, fov: 52,
  setup() {
    room.flip.rng = Math.random;
    offstage(bots.Dave, bots.Steve, bots.Kyle);
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 22.9 });
  },
  cam: t => { const R = W.town.repo; return { p: { x: lerp(R.x - 7.5, R.x - 5.6, ease(t / 3)), y: R.y + 1.6, z: lerp(R.z - 3.5, R.z - 2.8, ease(t / 3)) }, t: { x: R.x - 0.6, y: R.y + 1.5, z: R.z + 0.3 } }; },
  body: () => ({ x: W.town.repo.x - 10, z: W.town.repo.z - 6 }),
});

// the stinger: Kyle beans Steve with a garden gnome
shot({
  id: 'gnome', day: 1, secs: 3.0, pre: 0.5, fov: 56,
  setup() {
    dbg({ op: 'phase', ph: 'camp' }); dbg({ op: 'clock', h: 8.2 }); dbg({ op: 'tpRV', x: 0, z: -42, yaw: 0 });
    offstage(bots.Dave);
    const { Kyle, Steve } = bots;
    Steve.at(-3.0, -46.5, yawTo({ x: -3, z: -46.5 }, { x: -7.2, z: -48.8 })); Steve.tick(1 / 60);
    Kyle.at(-7.2, -48.8, yawTo({ x: -7.2, z: -48.8 }, { x: -3, z: -46.5 })); Kyle.tick(1 / 60); room.tick(1 / 60);
    const e = { x: Kyle.P.pos.x, y: Kyle.P.pos.y + C.PLAYER.EYE, z: Kyle.P.pos.z }, f = { x: Math.sin(Kyle.yaw), z: Math.cos(Kyle.yaw) };
    const g = spawnProp('gnome', e.x + f.x * 1.0, e.y - 0.3, e.z + f.z * 1.0, 70);
    for (let k = 0; k < 4; k++) room.tick(1 / 60);
    this.held = g && grab(Kyle, g);
    log(`  Kyle has the gnome: ${this.held}`);
    this.thrown = false;
  },
  tick(t) {
    const { Kyle, Steve } = bots;
    if (!Steve.fly && !Steve.downed) Steve.at(-3.0, -46.5, Steve.yaw);
    if (!this.thrown) {
      const s = { x: Steve.P.pos.x, y: Steve.P.pos.y + 1.45, z: Steve.P.pos.z };
      Kyle.at(-7.2, -48.8, Kyle.yaw); lookAt(Kyle, s);
      if (t > 0.9) { this.thrown = true; const e = Kyle.eye(), d = { x: s.x - e.x, y: s.y - e.y + 0.35, z: s.z - e.z }, l = Math.hypot(d.x, d.y, d.z); Kyle.say({ t: 'rel', thr: 1, dir: [d.x / l, d.y / l, d.z / l] }); }
    } else Kyle.at(-7.2, -48.8, Kyle.yaw);
  },
  cam: () => ({ p: at(-5.6, -53.0, 1.5), t: at(-5.0, -47.6, 1.2) }),
  body: () => ({ x: -10, z: -58 }),
});

// five days, five places: the RV on the road in each (chase shots, a different angle each)
const CHASE = {
  1: { z0: 28, from: 48, cam: { p: { x: 8.5, y: 1.6, z: 1.5 }, t: { x: 0, y: 1.2, z: 1.0 } }, clock: 10.5 },
  2: { z0: 108, from: 124, cam: { p: { x: -7.0, y: 3.2, z: -9.5 }, t: { x: 0, y: 1.3, z: 3 } }, clock: 10.5 },
  3: { z0: 140, from: 156, cam: { p: { x: 6.0, y: 2.0, z: 11.0 }, t: { x: 0, y: 1.4, z: -1 } }, clock: 11.0 },
  4: { z0: 108, from: 124, cam: { p: { x: -8.5, y: 1.7, z: 0.5 }, t: { x: 0, y: 1.3, z: 0 } }, clock: 10.5 },
  5: { z0: 150, from: 166, cam: { p: { x: 9.0, y: 6.5, z: -12 }, t: { x: 0, y: 1.0, z: 4 } }, clock: 16.6 },
};
for (const d of [1, 2, 3, 4, 5]) shot({
  id: `chase${d}`, day: d, secs: 1.8, pre: 1, fov: 60, preMax: 20,
  startWhen() { return rvPose().t.z > CHASE[d].from; },
  setup() {
    const c = CHASE[d];
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: c.clock }); dbg({ op: 'rvhp', hp: 100 });
    dbg({ op: 'tpRV', x: W.roadX(c.z0), z: c.z0, yaw: Math.atan2(W.roadX(c.z0 + 8) - W.roadX(c.z0), 8) });
    offstage(bots.Steve, bots.Kyle);
    seatDriver(bots.Dave);
  },
  tick() { bots.Dave.seat(); drive(bots.Dave, { vmax: 12 }); },
  cam: () => ({ rel: true, ...CHASE[d].cam }),
  body: () => ({ rel: true, x: 16, y: 0, z: 0 }),
});

// ---- day 2 -----------------------------------------------------------------------------------------
// the hook: the roadside ad, SLOPMASTER RVs / NO MONEY DOWN!!! (a push in)
shot({
  id: 'billboard', day: 2, secs: 2.0, pre: 0.4, fov: 84,
  setup() {
    offstage(bots.Dave, bots.Steve, bots.Kyle);
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 9.2 });
    dbg({ op: 'tpRV', x: W.roadX(60), z: 60, yaw: 0 });
    this.b = (W.landmarks || []).find(b => /SLOPMASTER/.test(b.label)) || { x: 28.2, z: 161.2 };
  },
  cam(t) { const b = this.b; return { p: { x: b.x - 0.8, y: 4.3, z: lerp(b.z - 3.4, b.z - 2.6, ease(t / 2.4)) }, t: { x: b.x, y: 4.35, z: b.z } }; },
  body() { return { x: 4, z: 140 }; },
});

// the Slopmaster blasts past a low camera, horn going
shot({
  id: 'blastpast', day: 2, secs: 1.6, pre: 1, fov: 70, preMax: 25,
  startWhen() { return rvPose().t.z > 158; },
  setup() {
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 9.4 }); dbg({ op: 'rvhp', hp: 100 });
    dbg({ op: 'tpRV', x: W.roadX(96), z: 96, yaw: Math.atan2(W.roadX(104) - W.roadX(96), 8) });
    offstage(bots.Steve, bots.Kyle);
    seatDriver(bots.Dave);
  },
  tick(t) { bots.Dave.seat(); drive(bots.Dave, { vmax: 13 }); if (rvPose().t.z > 150 && every(t, 0.3)) bots.Dave.say({ t: 'horn' }); },
  cam: () => ({ p: at(W.roadX(176) + 2.6, 176, 0.45), t: at(W.roadX(150), 150, 1.0) }),
  body: () => ({ x: W.roadX(182) + 6, z: 182 }),
});

// GRUMPHORN CROSSING / LET IT SLEEP, then the beast asleep on the road
shot({
  id: 'grumsign', day: 2, secs: 1.3, pre: 0.4, fov: 55,
  setup() {
    offstage(bots.Dave, bots.Steve, bots.Kyle);
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 10.0 });
    dbg({ op: 'tpRV', x: W.roadX(150), z: 150, yaw: 0 });
    dbg({ op: 'mobs', on: false });
    const bed = W.beds?.[0] || { x: 8.3, z: 331, ry: -1 };
    this.beast = spawnMob('grumphorn', bed.x, bed.z, { yaw: bed.ry, st: 0 });
    log(`  the grumphorn: #${this.beast?.id}`);
  },
  cam: t => ({ p: at(10.8, 244 + t * 0.3, 1.6), t: at(7.2, 251, 2.1) }),
  body: () => ({ x: 14, z: 236 }),
});
shot({
  id: 'grumsleep', day: 2, secs: 1.4, pre: 0.4, fov: 50,
  setup() { offstage(bots.Dave, bots.Steve, bots.Kyle); },
  cam: t => { const bed = W.beds?.[0] || { x: 8.3, z: 331 }; return { p: at(bed.x + 5.2 - t * 0.25, bed.z - 3.0, 0.9), t: at(bed.x, bed.z, 0.6) }; },
  body: () => { const bed = W.beds?.[0] || { x: 8.3, z: 331 }; return { x: bed.x + 14, z: bed.z - 12 }; },
});
// Steve walks up to it standing; it wakes, glares, charges, tosses him
shot({
  id: 'toss', day: 2, secs: 3.2, pre: 0.5, fov: 60, preMax: 12,
  startWhen() { const m = SHOTS.find(s => s.id === 'grumsign').beast; return m && (m.st === 2 || m.st === 3); },
  setup() {
    offstage(bots.Dave, bots.Kyle);
    const bed = W.beds?.[0] || { x: 8.3, z: 331, ry: -1 }, f = { x: Math.sin(bed.ry), z: Math.cos(bed.ry) };
    this.spot = { x: bed.x - f.x * 6, z: bed.z - f.z * 6 };
    this.yaw = Math.atan2(f.x, f.z);
    this.f = f; this.bed = bed;
    bots.Steve.wake();
  },
  tick(t) { const s = bots.Steve; if (!s.fly && !s.downed) s.at(this.spot.x + this.f.x * Math.min(t, 1.5) * 0.3, this.spot.z + this.f.z * Math.min(t, 1.5) * 0.3, this.yaw); },
  cam() { const b = this.bed, f = this.f, m = { x: b.x - f.x * 5, z: b.z - f.z * 5 }, n = { x: f.z, z: -f.x }; return { p: at(m.x + n.x * 9, m.z + n.z * 9, 1.7), t: at(m.x - f.x * 1.5, m.z - f.z * 1.5, 1.2) }; },
  body() { const b = this.bed, f = this.f, n = { x: f.z, z: -f.x }; return { x: b.x + n.x * 20, z: b.z + n.z * 20 }; },
});

// a ringtail sneaks up on the vase Steve set down, snatches it, and runs (STOLEN $520)
shot({
  id: 'ringtail', day: 2, secs: 2.8, pre: 0.5, fov: 58, preMax: 24,
  startWhen() { const m = this.coon, p = m && room.sim.props.get(m.id), v = this.vase && room.sim.props.get(this.vase.id); if (!p || !v) return false; const a = p.body.translation(), b = v.body.translation(); return (m.st & 31) >= 1 && Math.hypot(a.x - b.x, a.z - b.z) < 4.2; },
  setup() {
    dbg({ op: 'mobs', on: false });
    offstage(bots.Dave, bots.Kyle);
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 11.0 });
    dbg({ op: 'tpRV', x: W.roadX(150), z: 150, yaw: 0 });
    const { Steve } = bots, v = { x: 9.5, z: 220 };
    Steve.at(v.x - 1.2, v.z, Math.PI / 2, { pitch: 0.5 }); Steve.tick(1 / 60); room.tick(1 / 60);
    this.vase = spawnProp('vase', v.x, H(v.x, v.z) + 0.45, v.z, 520);
    for (let k = 0; k < 20; k++) room.tick(1 / 60);
    if (grab(Steve, this.vase)) { for (let k = 0; k < 10; k++) room.tick(1 / 60); Steve.say({ t: 'rel' }); }
    for (let k = 0; k < 30; k++) room.tick(1 / 60);
    this.v = v;
    this.coon = spawnMob('ringtail', 2, 214, { yaw: 0.8 });
  },
  tick(t) { const { Steve } = bots; Steve.at(this.v.x - 2.6, this.v.z + 2.6, -Math.PI / 4); },
  cam(t) {
    const p = this.coon && room.sim.props.get(this.coon.id), c = p ? p.body.translation() : { x: this.v.x, z: this.v.z };
    return { p: at(this.v.x + 3.2, this.v.z - 3.0, 0.55), t: { x: lerp(this.v.x, c.x, 0.5), y: H(c.x, c.z) + 0.3, z: lerp(this.v.z, c.z, 0.5) } };
  },
  body() { return { x: this.v.x + 11, z: this.v.z - 10 }; },
});

// ---- day 3 -----------------------------------------------------------------------------------------
// Steve and Kyle carry the giant fiberglass dino head off (DINO WORLD / HEAD MISSING — REWARD)
shot({
  id: 'dino', day: 3, secs: 2.4, pre: 0.8, fov: 58,
  setup() {
    dbg({ op: 'mobs', on: false });
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 11.0 });
    dbg({ op: 'tpRV', x: W.roadX(700), z: 700, yaw: 0 });
    offstage(bots.Dave);
    const poi = W.pois.find(p => p.type === 'dino') || { x: 36, z: 729.5 };
    let head = [...room.sim.props.values()].filter(p => p.type === 'dino').sort((a, b) => hyp(a.body.translation(), poi) - hyp(b.body.translation(), poi))[0];
    if (!head) head = spawnProp('dino', poi.x - 3, H(poi.x - 3, poi.z) + 0.6, poi.z + 1.5, 1700);
    this.head = head;
    const c = head.body.translation(), toRoad = Math.sign(W.roadX(c.z) - c.x) || -1;
    this.dir = toRoad;
    const { Steve, Kyle } = bots;
    Steve.at(c.x - toRoad * 1.3, c.z - 0.8, Math.atan2(toRoad, 0)); Kyle.at(c.x - toRoad * 1.3, c.z + 0.8, Math.atan2(toRoad, 0));
    Steve.tick(1 / 60); Kyle.tick(1 / 60); room.tick(1 / 60);
    this.a = grab(Steve, head, 0.35); this.b = grab(Kyle, head, 0.35);
    this.s0 = { s: { x: Steve.pos.x, z: Steve.pos.z }, k: { x: Kyle.pos.x, z: Kyle.pos.z }, c };
    log(`  dino head #${head.id}: ${this.a} ${this.b}`);
  },
  tick(t) {
    const { Steve, Kyle } = bots, u = Math.max(0, t - 0.3) * 1.1;
    const s = this.s0;
    const p = -Math.min(0.5, t * 0.6);
    Steve.at(s.s.x + this.dir * u, s.s.z, Steve.yaw, { pitch: p }); Kyle.at(s.k.x + this.dir * u, s.k.z, Kyle.yaw, { pitch: p });
  },
  cam() { const c = this.s0.c; return { p: at(c.x + this.dir * 4.2, c.z - 5.6, 1.5), t: at(c.x + this.dir * 0.6, c.z + 0.6, 1.2) }; },
  body() { const c = this.s0.c; return { x: c.x + this.dir * 8, z: c.z - 12 }; },
});

// ---- day 4 -----------------------------------------------------------------------------------------
// Kyle climbs a sheer red canyon wall
shot({
  id: 'climb', day: 4, secs: 2.4, pre: 0.4, fov: 60,
  setup() {
    dbg({ op: 'mobs', on: false });
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 10.5 });
    offstage(bots.Dave, bots.Steve);
    this.face = findFace();
    log(`  the wall: ${JSON.stringify(this.face)}`);
    dbg({ op: 'tpRV', x: W.roadX(this.face.z - 30), z: this.face.z - 30, yaw: 0 });
  },
  tick(t) {
    const f = this.face, y = Math.min(5.5, 0.4 + t * 1.15), x = faceX(f, f.h0 + y);
    const k = bots.Kyle;
    k.par = 0; k.mode = C.MODE.CLIMB; k.flags = 0; k.pos = { x: x + f.out * 0.42, y: f.h0 + y, z: f.z + Math.sin(t * 2.2) * 0.12 }; k.yaw = Math.atan2(-f.out, 0); k.pitch = -0.3;
  },
  cam(t) { const f = this.face, y = f.h0 + Math.min(5.5, 0.4 + t * 1.15); return { p: { x: f.x + f.out * 4.4, y: f.h0 + 1.2 + (y - f.h0) * 0.55, z: f.z - 3.4 }, t: { x: faceX(f, y) + f.out * 0.4, y: y + 0.9, z: f.z } }; },
  body() { const f = this.face; return { x: f.x + f.out * 12, z: f.z - 9 }; },
});

// ---- day 5 -----------------------------------------------------------------------------------------
// paid off: the crew in Lost Wages at sunset, arms up, the battered RV behind them
shot({
  id: 'payoff', day: 5, secs: 4.0, pre: 0.5, fov: 56,
  setup() {
    dbg({ op: 'mobs', on: false });
    dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'clock', h: 18.6 }); dbg({ op: 'rvhp', hp: 38 });
    for (const b of Object.values(bots)) unseat(b);
    dbg({ op: 'tpRV', x: -1.4, z: W.town.z + 2.5, yaw: 0.25 });
  },
  tick(t) {
    const { Dave, Steve, Kyle } = bots, z = W.town.z - 2.0, C0 = { x: 7.0, z: W.town.z - 9.5 };
    Dave.at(1.5, z, yawTo({ x: 1.5, z }, C0)); Steve.at(3.0, z + 0.9, yawTo({ x: 3.0, z: z + 0.9 }, C0)); Kyle.at(4.5, z - 0.3, yawTo({ x: 4.5, z: z - 0.3 }, C0));
    if (every(t, 2.8, 0.05)) for (const b of [Dave, Steve, Kyle]) b.say({ t: 'emote', e: '👑' });
  },
  cam: t => ({ p: { x: 7.0 - t * 0.2, y: H(7, W.town.z - 9.5) + 1.5, z: W.town.z - 9.5 + t * 0.2 }, t: { x: 2.6, y: H(2.6, W.town.z) + 1.4, z: W.town.z - 0.5 } }),
  body: () => ({ x: 13, z: W.town.z - 16 }),
});

const DAYS = [1, 2, 3, 4, 5];
async function capture() {
  await boot();
  const want = ONLY ? SHOTS.filter(s => ONLY.includes(s.id)) : SHOTS;
  for (const d of DAYS) {
    const todays = want.filter(s => s.day === d);
    if (!todays.length) continue;
    await toDay(d);
    for (const s of todays) {
      await realtime();
      for (const b of Object.values(bots)) { b.wake(); b.extraFlags = 0; b.say({ t: 'rel' }); }
      try { await s.setup?.call(s); } catch (e) { log(`!! ${s.id} setup: ${e.stack}`); continue; }
      for (const b of Object.values(bots)) b.tick(1 / 60);
      await page.waitForTimeout(400);
      await take(s);
    }
  }
  if (!ONLY || ONLY.includes('stills')) await stills();
  await browser.close();
  host.stop?.();
  log('capture done');
}

// the game's own panels, as stills (the HTML over the picture): the win, then (a new trip, day 4) the clock
// at a minute to midnight with the bank short, and the repossession
async function stills() {
  const dir = path.join(OUT, 'cards');
  fs.mkdirSync(dir, { recursive: true });
  await realtime();
  const show = async sel => { await page.addStyleTag({ content: `${sel} { visibility: visible !important; } ${sel} * { visibility: visible !important; }` }); };
  await page.evaluate(() => { const S = window.__nmd; window.__cam = null; S.noRender = false; });
  if (room.day !== 5) await toDay(5);
  dbg({ op: 'clock', h: 18.6 }); dbg({ op: 'phase', ph: 'road' });
  await page.evaluate(() => { const S = window.__nmd, T = S.W.town; S.me.teleport(7.0, T.y + 0.05, T.z - 9.5, 0); S.aimAt(2.6, T.y + 1.4, T.z - 0.5); });
  dbg({ op: 'win' });
  await page.waitForFunction(() => !document.getElementById('overScreen').classList.contains('hidden'), null, { timeout: 120000 });
  await show('#overScreen');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(dir, 'owned.png') });
  log('still: owned');
  // the next trip begins by itself (its own seed): day 4, $300, a minute to midnight
  await page.waitForFunction(() => document.getElementById('overScreen').classList.contains('hidden'), null, { timeout: 120000 });
  await page.addStyleTag({ content: '#overScreen { visibility: hidden !important; }' });
  room = host.rooms.get(await page.evaluate(() => window.__nmd.code)) || room;
  await toDay(4);
  dbg({ op: 'phase', ph: 'road' }); dbg({ op: 'bank', v: 300 });
  dbg({ op: 'tpRV', x: 0, z: W.town.z + 12, yaw: 0 });
  await page.evaluate(() => { const S = window.__nmd, T = S.W.town; S.me.teleport(2, T.y + 0.05, T.z + 4, 0); S.aimAt(7.5, T.y + 2.2, T.z + 24); S.setSetting('uiScale', 1.6); });
  await show('#hud');
  await page.addStyleTag({ content: '#hCode, #hCode *, #tracker, #tracker * { visibility: hidden !important; } #connBox { display: none !important; }' });
  await page.waitForTimeout(1000);
  dbg({ op: 'clock', h: 23.984 });
  await page.waitForTimeout(160);   // (a few snapshots with the new time, then the server held still at 11:59 PM)
  host.stop();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(dir, 'hud.png') });
  host.start();
  log('still: hud');
  await page.addStyleTag({ content: '#hud, #hud * { visibility: hidden !important; }' });
  await page.evaluate(() => window.__nmd.setSetting('uiScale', 1));
  await page.waitForFunction(() => !document.getElementById('overScreen').classList.contains('hidden'), null, { timeout: 120000 });
  await page.addStyleTag({ content: '#overScreen, #overScreen * { visibility: visible !important; }' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(dir, 'repod.png') });
  log('still: repod');
}

// a sheer wall beside the road (day 4's canyon): x of its foot, z, the ground there, which way is out
function findFace() {
  for (let z = 300; z < 520; z += 3) {
    const rx = W.roadX(z);
    for (const side of [-1, 1]) for (let x = rx + side * 5; Math.abs(x - rx) < 30; x += side * 0.5) {
      const h0 = H(x, z);
      if (H(x + side * 2, z) - h0 > 3.6 && H(x + side * 4, z) - h0 > 6.5 && Math.abs(H(x - side * 3, z) - h0) < 0.6) return { x, z, h0, out: -side };
    }
  }
  return { x: W.roadX(400) - 12, z: 400, h0: H(W.roadX(400) - 12, 400), out: 1 };
}
// where the wall reaches height y (between its foot and 8 m in)
function faceX(f, y) {
  let a = f.x, b = f.x - f.out * 8;
  for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (H(m, f.z) < y) a = m; else b = m; }
  return (a + b) / 2;
}

// ================================================================================================
// AUDIO: the game's own synthesizers, rendered offline (faster than real time) to WAVs in OUT/audio
// ================================================================================================
// the sounds, one every 2.5 s on a reel (the edit cuts them out by name: reel.json says where each starts)
const REEL = [
  ['horn'], ['horn'], ['engineStart'], ['crunch', 18], ['crunch', 30], ['shatter'], ['kaching'], ['bell'], ['bill'], ['ko'], ['knock'],
  ['bellow'], ['snort'], ['stampede'], ['clang'], ['snore'], ['chitter'], ['yoink'], ['squeal'], ['thunk', 1.4], ['whoosh'], ['throw'],
  ['bonk'], ['sputter'], ['ratchet'], ['crank'], ['stall'], ['coin'], ['win'], ['lose'], ['repo'], ['repoArrives'], ['day'], ['owned'],
  ['door'], ['brake', 1.5], ['hook'], ['gate'], ['grab'], ['rumble'], ['crack'], ['toast', 'bad'], ['toast', 'good'], ['land', 14],
];
const REEL_GAP = 2.5;
// the engine and the world's air, as beds: [name, secs, per-step settings at time t]
const BEDS = [
  ['engine', 14, t => ({ loops: { engineOn: true, rpm: Math.min(1.25, 0.25 + t * 0.12), near: 1, windAmt: 0.25, speed: Math.min(13, 2 + t), rv: { x: 0, y: 0, z: 0 } } })],
  ['cabin', 12, () => ({ loops: { engineOn: true, rpm: 0.85, near: 1, windAmt: 0.12, speed: 9, rv: { x: 0, y: 0, z: 0 } }, amb: { biome: 'meadow', night: false, inside: true } })],
  ['meadow', 12, () => ({ amb: { biome: 'meadow', night: false, inside: false } })],
  ['fields', 10, () => ({ amb: { biome: 'fields', night: false, inside: false } })],
  ['snow', 10, () => ({ amb: { biome: 'snow', night: false, inside: false } })],
  ['badlands', 10, () => ({ amb: { biome: 'badlands', night: false, inside: false } })],
  ['desert', 10, () => ({ amb: { biome: 'desert', night: false, inside: false } })],
  ['night', 10, () => ({ amb: { biome: 'fields', night: true, inside: false } })],
  ['campfire', 10, () => ({ amb: { biome: 'meadow', night: false, inside: false, fires: [{ x: 0, y: 0, z: 2 }] } })],
];
// the music: [name, station, seed, secs, first bar, tension from, tension to] (the menu theme is country on
// seed 7; the casino's lounge band; the last hour's midnight station, its tension rising)
const MUSIC = [
  ['country', 'country', 7, 100, 0, 0, 0],
  ['lounge', 'lounge', 4, 12, 0, 0, 0],
  ['midnight', 'midnight', 7, 14, 0, 0.5, 1],
];
const wavOf = (sr, ch) => {
  const n = ch[0].length, nc = ch.length, b = Buffer.alloc(44 + n * nc * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nc * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(nc, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * nc * 2, 28); b.writeUInt16LE(nc * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * nc * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch[c][i] * 32767))), 44 + (i * nc + c) * 2);
  return b;
};
async function audio() {
  const dir = path.join(OUT, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const { GameHost } = await import(path.join(ROOT, 'server/host.js'));
  const { chromium } = await import('playwright-core');
  const h = await new GameHost({ log: () => {} }).init();
  const port = await h.listen({ port: 0 });
  const br = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const pg = await br.newPage();
  pg.on('pageerror', e => log('page error:', e.message));
  pg.setDefaultTimeout(600000);
  const get = async (fn, arg) => { const r = await pg.evaluate(fn, arg); return r.map(a => Float32Array.from(a)); };
  // music: each station in its own offline context. The radio schedules a bar ahead from a 50 ms timer: its
  // timer is caught and run by hand at every 0.1 s of the render
  for (const [name, station, seed, secs, bar0, tension, tension1] of MUSIC) {
    await pg.goto(`http://localhost:${port}/__blank`);
    const ch = await get(async ([station, seed, secs, bar0, tension, tension1]) => {
      const ticks = [];
      window.setInterval = fn => { ticks.push(fn); return ticks.length; };
      window.clearInterval = () => {};
      const { createRadio } = await import('/js/music.js');
      const sr = 48000, ctx = new OfflineAudioContext(2, Math.round(sr * secs), sr);
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.25;
      const g = ctx.createGain(); g.gain.value = 0.42; g.connect(lim); lim.connect(ctx.destination);
      const r = createRadio(ctx, g, { seed, station });
      r.setTension(tension);
      // (start(s) begins with the bar after s: just short of the next bar line, it begins at once, on bar0)
      const { STATIONS } = await import('/js/music.js'), barLen = 240 / STATIONS[station].bpm;
      r.start((bar0 + 1) * barLen - 0.02);
      r.output.gain.cancelScheduledValues(0); r.output.gain.setValueAtTime(1, 0);
      for (let t = 0.1; t < secs; t += 0.1) ctx.suspend(t).then(() => { r.setTension(tension + (tension1 - tension) * t / secs); for (const f of ticks) f(); ctx.resume(); });
      const buf = await ctx.startRendering();
      return [Array.from(buf.getChannelData(0)), Array.from(buf.getChannelData(1))];
    }, [station, seed, secs, bar0, tension, tension1]);
    fs.writeFileSync(path.join(dir, `music-${name}.wav`), wavOf(48000, ch));
    log(`music ${name}: ${secs} s`);
  }
  // the sounds and the beds: sfx.js and ambience.js on one offline context (audio.js makes it: AudioContext is
  // swapped for an offline one before they're imported)
  await pg.goto(`http://localhost:${port}/__blank`);
  const reelSecs = REEL.length * REEL_GAP + 1, bedSecs = BEDS.reduce((a, b) => a + b[1] + 1, 0);
  const res = await pg.evaluate(async ([REEL, GAP, BEDS, reelSecs, bedSecs]) => {
    const sr = 48000, total = reelSecs + bedSecs;
    window.AudioContext = class extends OfflineAudioContext { constructor() { super(2, Math.round(sr * total), sr); } };
    const { initAudio, sfx, setLoops } = await import('/js/sfx.js');
    const { updateAmbience, quietAmbience } = await import('/js/ambience.js');
    initAudio();
    const ctx = window.__nmdAudio.ctx;
    const at = {};
    REEL.forEach(([n, ...a], i) => { const t = 0.25 + i * GAP; at[`${n}${a.length ? ':' + a.join(',') : ''}`] = t; ctx.suspend(t).then(() => { try { sfx[n](...a); } catch (e) { console.log('sfx', n, e.message); } ctx.resume(); }); });
    // the beds: the loops and the ambience updated every 0.05 s, as a page's frames would
    let t0 = reelSecs;
    const beds = {};
    for (const [name, secs, fnSrc] of BEDS) {
      const fn = eval(fnSrc), start = t0;
      beds[name] = start;
      for (let t = 0; t < secs; t += 0.05) ctx.suspend(start + t).then(() => {
        const s = fn(t);
        setLoops(s.loops || { engineOn: false, windAmt: 0 });
        if (s.amb) updateAmbience({ pos: { x: 0, y: 1.6, z: 0 }, fires: [], ...s.amb }, 0.05); else quietAmbience();
        ctx.resume();
      });
      ctx.suspend(start + secs).then(() => { setLoops({ engineOn: false, windAmt: 0 }); quietAmbience(); ctx.resume(); });
      t0 += secs + 1;
    }
    const buf = await ctx.startRendering();
    return { at, beds, ch: [Array.from(buf.getChannelData(0)), Array.from(buf.getChannelData(1))] };
  }, [REEL, REEL_GAP, BEDS.map(([n, s, f]) => [n, s, f.toString()]), reelSecs, bedSecs]);
  fs.writeFileSync(path.join(dir, 'reel.wav'), wavOf(48000, res.ch.map(a => Float32Array.from(a))));
  fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({ gap: REEL_GAP, at: res.at, beds: res.beds, bedLen: Object.fromEntries(BEDS.map(b => [b[0], b[1]])) }, null, 1));
  log(`sounds: ${REEL.length} on the reel, ${BEDS.length} beds`);
  await br.close();
}

// ================================================================================================
// CARDS: the words, in the game's own type (Cinzel for the title and the big lines, Marcellus for the toasts),
// as transparent 1920x1080 PNGs in OUT/cards; and the title painting with the game's logo, from its menu
// ================================================================================================
const GOLD = 'linear-gradient(180deg, #fff7d0 0%, #ffe07a 22%, #f2b632 46%, #b3721c 58%, #f6cf62 72%, #ffe9a0 86%, #a8661a 100%)';
const OUTLINE = '0 0 3px #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 0 4px 10px rgba(0,0,0,0.8)';
// kind: 'big' (a line of the pitch, low in the frame), 'toast' (the game telling you what happened, at the
// top, in its colour), 'zone' (a day's name and its payment), 'end' (under the logo)
const CARDS = {};
const card = (id, kind, text, extra = {}) => { CARDS[id] = { kind, text, ...extra }; };
card('c_bought', 'big', 'YOU AND THE BOYS<br>BOUGHT A $250,000 RV.');
card('c_payments', 'big', 'PAYMENTS ARE DUE EVERY NIGHT.');
card('c_jobs', 'big', 'NONE OF YOU HAVE JOBS.');
card('c_map', 'big', 'READ THE MAP.');
card('c_haul', 'big', 'HAUL THE JUNK.');
card('c_climb', 'big', 'CLIMB ANYTHING.');
card('c_winch', 'big', 'WINCH THE RV.');
card('c_pawn', 'big', 'PAWN IT ALL.');
card('c_bet', 'big', 'BET THE SHARED BANK.');
card('c_miss', 'big', 'MISS ONE PAYMENT…');
card('c_takes', 'big', '…AND HE TAKES THE RV.');
card('c_five', 'big', 'FIVE DAYS. FIVE PAYMENTS.');
card('c_balloon', 'big', 'PAY OFF THE $15,000 BALLOON.');
// the game's own toasts (as the server words them), in their colours
card('t_crunch', 'toast', 'CRUNCH. Dave put the RV into the ranger gate: -22%', { color: '#ff8a80' });
card('t_tossed', 'toast', 'Steve got tossed by the Grumphorn.', { color: '#ff8a80' });
card('t_ranover', 'toast', 'Dave ran over Steve. $500.', { color: '#ff8a80' });
card('t_fixed', 'toast', 'Dave, Steve and Kyle got it running with a coat hanger and a prayer.', { color: '#7CFC00' });
card('t_again', 'toast', 'A new RV. A new loan. The same idiots.', { color: '#ffd166' });
card('t_beaned', 'toast', 'Kyle beaned Steve with the Garden Gnome.', { color: '#ffb4a2' });
card('t_ko', 'ko', 'You have been knocked out.', { sub: 'Waking up alone costs $350.' });
card('c_repod', 'verdict', "REPO'D.", { sub: 'The Repo Man hooks the Slopmaster and drives off into the sunset without you.', color: 'red' });
card('c_owned', 'verdict', 'YOU OWN THE RV.', { sub: 'The Slopmaster 9000 is finally, legally, yours.' });
// the five days (the game's zone names, and what each one owes)
[['The Westmeadow Road', 1, '$1,000'], ['Goldenfield Pike', 2, '$2,500'], ['Frostpeak Pass', 3, '$4,500'], ['The Redrock Badlands', 4, '$7,500'], ['The Lost Wages Flats', 5, '$15,000']]
  .forEach(([name, d, due]) => card(`z${d}`, 'zone', name, { sub: `DAY ${d} · ${due} DUE AT MIDNIGHT`, size: 72, y: 110 }));
card('c_features', 'feat', '1–6 PLAYERS · ONLINE CO-OP · PROXIMITY VOICE CHAT');
card('c_wishlist', 'end', 'WISHLIST ON STEAM', { y: 140 });
function cardHtml(c, port) {
  const font = `@font-face { font-family: Cinzel; font-weight: 900; src: url(http://localhost:${port}/fonts/cinzel-latin-900.woff2); }
    @font-face { font-family: Cinzel; font-weight: 700; src: url(http://localhost:${port}/fonts/cinzel-latin-700.woff2); }
    @font-face { font-family: Marcellus; src: url(http://localhost:${port}/fonts/marcellus-latin-400.woff2); }
    @font-face { font-family: 'NMD UI'; src: url(http://localhost:${port}/fonts/marcellus-latin-400.woff2); }
    @font-face { font-family: 'NMD UI'; src: url(http://localhost:${port}/fonts/philosopher-latin-400.woff2); unicode-range: U+0030-0039; }`;
  const gold = `background: ${GOLD}; -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 1.5px rgba(255,244,200,0.55);
    filter: drop-shadow(0 3px 0 #3b1f06) drop-shadow(0 -2px 0 #3b1f06) drop-shadow(3px 0 0 #3b1f06) drop-shadow(-3px 0 0 #3b1f06) drop-shadow(0 10px 18px rgba(0,0,0,0.75));`;
  let body = '';
  if (c.kind === 'big') body = `<div style="position:absolute; left:0; right:0; bottom:${c.y ?? 130}px; text-align:center; font: 900 ${c.size ?? 92}px/1.05 Cinzel; letter-spacing: 3px; ${gold}">${c.text}</div>`;
  else if (c.kind === 'toast') body = `<div style="position:absolute; left:0; right:0; top:${c.y ?? 96}px; text-align:center;">
      <div style="display:inline-block; max-width: 1500px; padding: 10px 40px 14px; border-radius: 14px; background: radial-gradient(ellipse at center, rgba(8,5,3,0.62) 40%, rgba(8,5,3,0) 100%); font: ${c.size ?? 60}px/1.22 'NMD UI'; color:${c.color || '#ffe066'}; text-shadow:${OUTLINE}, 0 0 18px rgba(0,0,0,0.7); text-wrap: balance;">${c.text}</div></div>`;
  else if (c.kind === 'zone') body = `<div style="position:absolute; left:0; right:0; top:${c.y ?? 150}px; text-align:center;">
      <div style="font: 900 ${c.size ?? 84}px/1.1 Cinzel; letter-spacing: 2px; color:#ffd100; text-shadow:${OUTLINE}, 0 0 24px rgba(255,190,80,0.6);">${c.text}</div>
      ${c.sub ? `<div style="font: 700 40px/1.4 Cinzel; letter-spacing: 6px; color:#f0c75e; text-shadow:${OUTLINE}; margin-top: 6px;">${c.sub}</div>` : ''}</div>`;
  else if (c.kind === 'ko') body = `<div style="position:absolute; left:0; right:0; top:390px; text-align:center;">
      <div style="display:inline-block; padding: 34px 70px 30px; background: rgba(12,8,6,0.72); border: 3px solid #b8892e; border-radius: 6px; box-shadow: 0 0 0 2px #3b1f06, 0 12px 40px rgba(0,0,0,0.6);">
      <div style="font: 64px/1.2 'NMD UI'; color:#ff5a3a; text-shadow:${OUTLINE};">${c.text}</div>
      <div style="font: 38px/1.5 'NMD UI'; color:#f3e6c8; text-shadow:${OUTLINE}; margin-top: 8px;">${c.sub}</div></div></div>`;
  else if (c.kind === 'verdict') body = `<div style="position:absolute; left:0; right:0; top:330px; text-align:center;">
      <div style="font: 900 150px/1.05 Cinzel; letter-spacing: 4px; ${c.color === 'red' ? `color:#e8402a; text-shadow:${OUTLINE}, 0 0 40px rgba(160,20,0,0.7);` : gold}">${c.text}</div>
      <div style="display:inline-block; margin-top: 18px; padding: 6px 30px; font: 44px/1.35 'NMD UI'; color:#f3e6c8; text-shadow:${OUTLINE}; background: radial-gradient(ellipse at center, rgba(8,5,3,0.55) 40%, rgba(8,5,3,0) 100%);">${c.sub}</div></div>`;
  else if (c.kind === 'feat') body = `<div style="position:absolute; left:0; right:0; bottom:${c.y ?? 96}px; text-align:center; font: 44px/1.4 'NMD UI'; letter-spacing: 3px; color:#f3e6c8; text-shadow:${OUTLINE};">${c.text}</div>`;
  else if (c.kind === 'end') body = `<div style="position:absolute; left:0; right:0; bottom:${c.y ?? 120}px; text-align:center;">
      <div style="font: 900 ${c.size ?? 76}px/1.1 Cinzel; letter-spacing: 6px; ${gold}">${c.text}</div>
      ${c.sub ? `<div style="font: ${c.subSize ?? 34}px/1.5 'NMD UI'; color:#fff3da; text-shadow:${OUTLINE}; margin-top: 14px;">${c.sub}</div>` : ''}</div>`;
  return `<!doctype html><html><head><style>${font} html, body { margin:0; width:1920px; height:1080px; background: transparent; overflow:hidden; }</style></head><body>${body}</body></html>`;
}
async function cards() {
  const dir = path.join(OUT, 'cards');
  fs.mkdirSync(dir, { recursive: true });
  process.env.FRIENDSLOP_TEST = '1';
  const { GameHost } = await import(path.join(ROOT, 'server/host.js'));
  const { chromium } = await import('playwright-core');
  const h = await new GameHost({ log: () => {} }).init();
  const port = await h.listen({ port: 0 });
  const headful = !!process.env.DISPLAY;
  const br = await chromium.launch({ headless: !headful, executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: headful ? ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await br.newPage({ viewport: { width: 1920, height: 1080 } });
  pg.setDefaultTimeout(900000);
  await pg.goto(`http://localhost:${port}/__blank`);   // (the game's origin: its fonts load from there)
  for (const [id, c] of Object.entries(CARDS)) {
    await pg.setContent(cardHtml(c, port));
    await pg.evaluate(async () => { await Promise.all(['900 90px Cinzel', '700 40px Cinzel', "50px 'NMD UI'", '50px Marcellus'].map(f => document.fonts.load(f, 'A0'))); await document.fonts.ready; });
    await pg.screenshot({ path: path.join(dir, `${id}.png`), omitBackground: true });
  }
  log(`${Object.keys(CARDS).length} cards`);
  // the title painting (the menu's 2D vista with its 3D diorama, without the signpost's words), then the same
  // with the game's own logo over it, and the end card's line under the logo
  await pg.goto(`http://localhost:${port}/?titlesize=1920x1080&nosign`);
  await pg.waitForFunction(() => document.documentElement.dataset.menuArt);
  await pg.evaluate(() => document.fonts.ready);
  await pg.addStyleTag({ content: `#menu > :not(.title-wrap), .menu-card, #loading, .footer-note, .version, #versionLabel { display: none !important; }
    #menu { justify-content: flex-start !important; padding-top: 70px !important; }
    .kicker { font-size: 30px !important; letter-spacing: 12px !important; }
    .game-title { font-size: 190px !important; }
    .filigree { width: 900px !important; height: 74px !important; }
    .tagline { display: none !important; }` });
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: path.join(dir, 'title.png') });
  await pg.addStyleTag({ content: '.title-wrap { visibility: hidden !important; }' });
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(dir, 'title-art.png') });
  log('title art');
  await br.close();
}

// ================================================================================================
// EDIT: the cut (EDL), the words on it, the music and the sounds under it -> OUT/trailer.mp4
// ================================================================================================
// EDL entries: { shot (a folder in OUT/shots) | still (a PNG in OUT/cards), from (the first frame), secs,
//   card (a card's id) with cardIn/cardOut (s into the entry), gray (the knocked-out look), zoom (a still's
//   push-in, 1 -> zoom), fadeIn/fadeOut (from/to black, s) }
// SFX: [time in the trailer (s), reel name, gain]; MUSIC_CUES: [music bed, from (s into it), at (trailer s),
//   secs, gain, fadeIn, fadeOut]; BED_CUES: [bed, at, secs, gain]
// an event in a shot's log: a toast whose text matches, or an 'ev' of kind k
const toastIs = re => e => e.t === 'toast' && re.test(e.text);
const evIs = (k, more = () => true) => e => e.t === 'ev' && e.list?.some(x => x.k === k && more(x));
// The cut (60.0 s on the menu theme's half bars, 1.25 s). Per entry: cards [id, in, out] (s into the entry),
// sfx [[s into the entry, sound, gain]], cues [[event test, sound, gain, offset]] (placed where the shot's log has
// the event), align [event test, s into the entry] (the in-point chosen so that event lands there)
const EDL = [
  // the cold open: the ad, then the RV itself, horn going
  { shot: 'billboard', secs: 1.5, fadeIn: 0.25, sfx: [[0.9, 'horn', 0.5]] },
  { shot: 'blastpast', secs: 1.0, sfx: [[0.05, 'horn', 0.9], [0.4, 'whoosh', 1.2], [0.45, 'horn', 0.8]] },
  // the pitch
  { shot: 'cab', secs: 2.5, cards: [['c_bought', 0.25, 2.5]] },
  { shot: 'rollout', secs: 1.25, cards: [['c_payments', 0.05, 1.25]] },
  { shot: 'campfire', secs: 1.25, from: 12, cards: [['c_jobs', 0.05, 1.25]] },
  // the verbs
  { shot: 'mapfp', secs: 1.25, from: 10, cards: [['c_map', 0.05, 1.25]], sfx: [[0.05, 'grab', 0.8]] },
  { shot: 'dino', secs: 1.25, from: 18, cards: [['c_haul', 0.05, 1.25]], sfx: [[0.1, 'thunk:1.4', 0.8]] },
  { shot: 'climb', secs: 1.25, from: 10, cards: [['c_climb', 0.05, 1.25]] },
  { shot: 'winch', secs: 1.25, from: 12, cards: [['c_winch', 0.05, 1.25]], sfx: [[0.05, 'hook', 0.9]] },
  { shot: 'pawn', secs: 2.5, align: [evIs('sold'), 1.1], cards: [['c_pawn', 0.05, 2.5]], cues: [[evIs('sold'), 'bell', 0.9, -0.12], [evIs('sold'), 'kaching', 1.0, 0.08]] },
  // the chaos
  { shot: 'gate', secs: 2.5, align: [evIs('rvhit'), 1.0], cards: [['t_crunch', 1.1, 2.5]], cues: [[evIs('rvhit'), 'crunch:30', 1.2, -0.03], [evIs('door'), 'door', 0.8, 0.0], [evIs('rvhit'), 'toast:bad', 0.5, 0.1]] },
  { shot: 'grumsign', secs: 0.75, sfx: [[0.1, 'snore', 0.7]] },
  { shot: 'grumsleep', secs: 0.75, sfx: [[0.15, 'snore', 0.9]] },
  { shot: 'toss', secs: 2.5, from: 0, cards: [['t_tossed', 1.45, 2.5]], cues: [[toastIs(/tossed/), 'knock', 1.0, -0.1], [toastIs(/tossed/), 'toast:bad', 0.5, 0.0]], sfx: [[0.0, 'bellow', 1.0], [0.6, 'snort', 0.9], [0.9, 'stampede', 1.0], [1.05, 'clang', 0.6]] },
  { shot: 'toss', secs: 1.0, from: 'end', gray: true, cards: [['t_ko', 0.0, 1.0]], sfx: [[0.0, 'ko', 0.9], [0.35, 'bill', 0.8]] },
  { shot: 'ringtail', secs: 2.5, from: 6, sfx: [[0.2, 'chitter', 0.9], [1.0, 'chitter', 0.7]], cues: [[toastIs(/ran off with|YOINK|ringtail/i), 'yoink', 1.0, -0.05]] },
  { shot: 'runover', secs: 2.5, align: [toastIs(/ran over/), 1.3], cards: [['t_ranover', 1.35, 2.5]], cues: [[toastIs(/ran over/), 'thunk:1.4', 1.2, -0.08], [toastIs(/ran over/), 'bill', 0.8, 0.15]] },
  { shot: 'breakdown', secs: 2.5, align: [toastIs(/coat hanger/), 1.6], cards: [['t_fixed', 1.65, 2.5]], sfx: [[0.1, 'sputter', 0.8], [0.6, 'ratchet', 0.8], [1.0, 'ratchet', 0.8]], cues: [[toastIs(/coat hanger/), 'crank', 0.9, -0.3]] },
  // the stakes
  { shot: 'neon', secs: 1.25, cards: [['c_bet', 0.05, 1.25]] },
  { shot: 'blackjack', secs: 1.25, from: 8 },
  { shot: 'coinflip', secs: 2.5, from: 6, sfx: [[0.15, 'coin', 0.9]], cues: [[toastIs(/Double or Nothing/), 'lose', 1.0, 0.0]] },
  { still: 'hud.png', secs: 1.25, zoom: 1.06, crop: [0.06, 0, 0.74, 0.74], cards: [['c_miss', 0.05, 1.25]] },
  { shot: 'repoman', secs: 2.5, cards: [['c_takes', 0.1, 2.5]], sfx: [[0.1, 'repo', 1.0]] },
  { shot: 'repoman', secs: 1.25, from: 'end', dim: 0.35, cards: [['c_repod', 0.0, 1.25]], sfx: [[0.0, 'repoArrives', 1.0]] },
  // again
  { shot: 'campfire', secs: 1.25, from: 40, cards: [['t_again', 0.05, 1.25]], sfx: [[0.05, 'day', 0.9]] },
  { shot: 'chase1', secs: 1.25, cards: [['z1', 0.0, 1.25], ['c_five', 0.0, 2.5]] },
  { shot: 'chase2', secs: 1.25, cards: [['z2', 0.0, 1.25], ['c_five', 0.0, 1.25]] },
  { shot: 'chase3', secs: 1.25, cards: [['z3', 0.0, 1.25]] },
  { shot: 'chase4', secs: 1.25, cards: [['z4', 0.0, 1.25]] },
  { shot: 'chase5', secs: 1.25, cards: [['z5', 0.0, 1.25]], sfx: [[0.3, 'horn', 0.6]] },
  { shot: 'payoff', secs: 2.5, cards: [['c_balloon', 0.1, 2.5]] },
  { shot: 'payoff', secs: 1.25, from: 'end', dim: 0.25, cards: [['c_owned', 0.0, 1.25]], sfx: [[0.0, 'owned', 0.9]] },
  // the title, the stinger, the end card
  { still: 'title.png', secs: 3.75, zoom: 1.06, cards: [['c_features', 1.2, 3.75]] },
  { shot: 'gnome', secs: 2.5, from: 8, cards: [['t_beaned', 1.2, 2.5]], cues: [[toastIs(/beaned/), 'bonk', 1.0, -0.05]], sfx: [[0.75, 'throw', 0.9]] },
  { still: 'title.png', secs: 2.5, zoom: 1.02, cards: [['c_wishlist', 0.15, 2.5]], fadeOut: 0.6, sfx: [[0.25, 'horn', 0.7], [0.62, 'horn', 0.7]] },
];
// the music (bed, s into it, at, secs, gain, fade in, fade out); the engine and the air (bed, at, secs, gain)
const MUSIC_CUES = [
  ['country', 0, 2.5, 13.6, 0.8, 0.02, 0.06],          // in on the RV's pass; cut dead by the crunch
  ['country', 17.5, 17.5, 12.5, 0.75, 0.6, 0.2],      // back under the beast, on to the fix
  ['lounge', 0, 30.0, 4.4, 0.75, 0.02, 0.05],         // the casino's band; cut at NOTHING
  ['midnight', 0, 35.0, 3.75, 0.85, 0.02, 0.4],       // a minute to midnight
  ['country', 40.0, 41.25, 13.9, 0.85, 0.02, 0.7],    // again: five days, the payoff, the title
];
const BED_CUES = [
  ['fields', 0, 1.6, 0.9], ['engine', 0.6, 2.0, 0.9], ['cabin', 2.5, 2.5, 0.7], ['engine', 5.0, 1.25, 0.6], ['campfire', 6.25, 1.25, 0.8],
  ['snow', 8.75, 1.25, 0.6], ['badlands', 10.0, 1.25, 0.6], ['engine', 15.0, 1.2, 0.7], ['fields', 17.5, 4.0, 0.7], ['fields', 22.5, 2.5, 0.6],
  ['engine', 25.0, 1.6, 0.7], ['night', 27.5, 2.5, 0.6], ['night', 35.0, 6.25, 0.5], ['campfire', 40.0, 1.25, 0.6],
  ['engine', 41.25, 6.25, 0.55], ['desert', 47.5, 2.5, 0.5], ['meadow', 55.0, 2.5, 0.6],
];
const SFX = [];
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
async function edit() {
  const tmp = path.join(OUT, 'edit');
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const clips = [];
  let t = 0;
  let edge = 0;   // (cut points on the frame nearest each one's time: the cuts stay on the music's half bars)
  for (const [i, e] of EDL.entries()) {
    const n = Math.round((edge + e.secs) * FPS) - Math.round(edge * FPS), out = path.join(tmp, `c${String(i).padStart(3, '0')}.mp4`);
    edge += e.secs;
    const inputs = [], filt = [];
    if (e.shot) {
      const dir = path.join(OUT, 'shots', e.shot);
      const have = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
      const evs = fs.existsSync(path.join(dir, 'events.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')) : [];
      let want = e.from === 'end' ? have - n : e.from ?? 0;
      if (e.align) { const hit = evs.find(e.align[0]); if (hit) want = hit.f - Math.round(e.align[1] * FPS); else log(`!! ${e.shot}: the event to line up on isn't in its log`); }
      const from = Math.max(0, Math.min(want, have - n));
      for (const [test, sound, gain = 1, off = 0] of e.cues || []) {
        const hit = evs.find(x => test(x) && x.f >= from && x.f < from + n);
        if (hit) SFX.push([t + (hit.f - from) / FPS + off, sound, gain]); else log(`  (${e.shot}: no event for ${sound})`);
      }
      if (have < n) log(`!! ${e.shot}: ${have} frames, the cut wants ${n}`);
      inputs.push('-framerate', String(FPS), '-start_number', String(from), '-i', path.join(dir, 'f%04d.jpg'));
      filt.push(`[0:v]scale=1920:1080:flags=lanczos,setsar=1,trim=end_frame=${n},setpts=PTS-STARTPTS${e.speed ? `,setpts=${(1 / e.speed).toFixed(4)}*PTS` : ''}[v0]`);
    } else {
      let still = path.join(OUT, 'cards', e.still);
      if (!fs.existsSync(still)) { log(`!! no ${e.still} yet: the title art stands in`); still = path.join(OUT, 'cards', 'title-art.png'); }
      inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(e.secs + 0.1), '-i', still);
      const z = e.zoom ?? 1, cr = e.crop ? `crop=iw*${e.crop[2]}:ih*${e.crop[3]}:iw*${e.crop[0]}:ih*${e.crop[1]},` : '';
      filt.push(z === 1 ? `[0:v]${cr}scale=1920:1080,setsar=1,trim=end_frame=${n}[v0]`
        : `[0:v]${cr}scale=3840:2160,zoompan=z='1+(${z}-1)*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=${FPS},setsar=1,trim=end_frame=${n}[v0]`);
    }
    let v = 'v0';
    if (e.dim) { filt.push(`[${v}]eq=brightness=-${e.dim * 0.5}:saturation=${1 - e.dim * 0.6}[vd]`); v = 'vd'; }
    if (e.gray) { filt.push(`[${v}]hue=s=0,eq=contrast=1.15:brightness=-0.04,rotate=0.06*sin(2*PI*t/2.4):c=black:ow=iw:oh=ih,vignette=PI/3.2[vg]`); v = 'vg'; }
    for (const [k, c] of (e.cards || (e.card ? [[e.card, e.cardIn ?? 0.15, e.cardOut ?? e.secs]] : [])).entries()) {
      const [id, cin, cout] = c;
      inputs.push('-loop', '1', '-i', path.join(OUT, 'cards', `${id}.png`));
      // (a card that starts or ends on a cut cuts with the picture: one that runs on into the next shot carries on there)
      const fi = Math.max(0, cin), fo = Math.max(fi + 0.2, cout - 0.18);
      const fades = [fi > 0.01 ? `fade=t=in:st=${fi.toFixed(2)}:d=0.12:alpha=1` : null, cout < e.secs - 0.01 ? `fade=t=out:st=${fo.toFixed(2)}:d=0.15:alpha=1` : null].filter(Boolean);
      filt.push(`[${k + 1}:v]format=rgba${fades.length ? ',' + fades.join(',') : ''}[k${k}]`);
      filt.push(`[${v}][k${k}]overlay=0:0:shortest=0:enable='between(t,${fi.toFixed(2)},${cout.toFixed(2)})'[o${k}]`);
      v = `o${k}`;
    }
    if (e.fadeIn) { filt.push(`[${v}]fade=t=in:st=0:d=${e.fadeIn}[fi]`); v = 'fi'; }
    if (e.fadeOut) { filt.push(`[${v}]fade=t=out:st=${(e.secs - e.fadeOut).toFixed(3)}:d=${e.fadeOut}[fo]`); v = 'fo'; }
    ff(...inputs, '-filter_complex', filt.join(';'), '-map', `[${v}]`, '-frames:v', String(n), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', out);
    clips.push(out);
    for (const [at, sound, gain = 1] of e.sfx || []) SFX.push([t + at, sound, gain]);
    e.at = t; t += n / FPS;
  }
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, clips.map(c => `file '${c}'`).join('\n'));
  const video = path.join(tmp, 'video.mp4');
  ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video);
  log(`picture: ${EDL.length} cuts, ${t.toFixed(2)} s`);
  // the sound: the music beds, the engine and the air, and the sounds, each placed and mixed
  const A = path.join(OUT, 'audio'), reel = JSON.parse(fs.readFileSync(path.join(A, 'reel.json'), 'utf8'));
  const ins = [], parts = [];
  let k = 0;
  const add = (file, chain) => { ins.push('-i', file); parts.push(`[${k}:a]${chain}[a${k}]`); k++; };
  for (const [bed, from, at, secs, gain = 1, fin = 0.05, fout = 0.3] of MUSIC_CUES)
    add(path.join(A, `music-${bed}.wav`), `atrim=start=${from}:duration=${secs},asetpts=PTS-STARTPTS,afade=t=in:d=${fin},afade=t=out:st=${Math.max(0, secs - fout)}:d=${fout},volume=${gain},adelay=${Math.round(at * 1000)}:all=1`);
  for (const [bed, at, secs, gain = 1] of BED_CUES) {
    const from = reel.beds[bed] + 0.5;
    add(path.join(A, 'reel.wav'), `atrim=start=${from}:duration=${secs},asetpts=PTS-STARTPTS,afade=t=in:d=0.15,afade=t=out:st=${Math.max(0, secs - 0.25)}:d=0.25,volume=${gain},adelay=${Math.round(at * 1000)}:all=1`);
  }
  for (const [at, name, gain = 1, len = 2.3] of SFX) {
    const from = reel.at[name];
    if (from == null) { log(`!! no sound '${name}' on the reel`); continue; }
    add(path.join(A, 'reel.wav'), `atrim=start=${from}:duration=${len},asetpts=PTS-STARTPTS,volume=${gain},adelay=${Math.round(at * 1000)}:all=1`);
  }
  const mix = path.join(tmp, 'mix.wav');
  ff(...ins, '-filter_complex', `${parts.join(';')};${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${k}:normalize=0:duration=longest,atrim=duration=${t.toFixed(3)},alimiter=limit=0.89,loudnorm=I=-15:TP=-1.5:LRA=9[out]`, '-map', '[out]', '-ar', '48000', '-ac', '2', mix);
  const final = path.join(OUT, 'trailer.mp4');
  ff('-i', video, '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', final);
  log(`trailer: ${final} (${(fs.statSync(final).size / 1048576).toFixed(1)} MB, ${t.toFixed(2)} s)`);
}

// ================================================================================================
if (STEP_CMD === 'capture') { await capture(); process.exit(0); }
else if (STEP_CMD === 'audio') { await audio(); process.exit(0); }
else if (STEP_CMD === 'cards') { await cards(); process.exit(0); }
else if (STEP_CMD === 'edit') { await edit(); process.exit(0); }
else { console.error('usage: node tools/trailer.mjs capture|audio|cards|edit'); process.exit(2); }
