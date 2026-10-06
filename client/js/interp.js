// Snapshot buffer + interpolation. We render the shared world a little in the
// past (INTERP_MS) so motion is smooth between 20 Hz snapshots.
import { INTERP_MS } from '/shared/constants.js';

const KEEP = 12;
const lerp = (a, b, t) => a + (b - a) * t;
function nlerpQ(a, b, t) {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1;
  const q = { x: lerp(a.x, b.x * s, t), y: lerp(a.y, b.y * s, t), z: lerp(a.z, b.z * s, t), w: lerp(a.w, b.w * s, t) };
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  q.x /= l; q.y /= l; q.z /= l; q.w /= l;
  return q;
}
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function bracket(buf, t) {
  if (!buf.length) return null;
  if (t <= buf[0].tm) return [buf[0], buf[0], 0];
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].tm <= t) {
      const a = buf[i], b = buf[i + 1];
      if (!b) return [a, a, 0];
      return [a, b, (t - a.tm) / Math.max(1, b.tm - a.tm)];
    }
  }
  return [buf[0], buf[0], 0];
}

export class Interp {
  constructor() { this.reset(); }

  reset() {
    this.offset = null;
    this.offs = [];
    this.rv = [];
    this.hook = [];
    this.props = new Map();
    this.players = new Map();
    this.lastTm = 0;
  }

  push(m, now) {
    const off = m.tm - now;
    this.offs.push(off);
    if (this.offs.length > 40) this.offs.shift();
    const best = Math.max(...this.offs);
    if (this.offset == null || Math.abs(best - this.offset) > 500 || m.tm < this.lastTm) {
      this.offset = best;
      if (m.tm < this.lastTm) { this.rv.length = 0; this.hook.length = 0; this.props.clear(); this.players.clear(); }
    } else this.offset += (best - this.offset) * 0.05;
    this.lastTm = m.tm;
    const tm = m.tm;
    const r = m.rv;
    this.rv.push({ tm, p: { x: r[0], y: r[1], z: r[2] }, q: { x: r[3], y: r[4], z: r[5], w: r[6] }, v: { x: r[7], y: r[8], z: r[9] }, steer: r[10], wheels: r.slice(11) });
    if (this.rv.length > KEEP) this.rv.shift();
    const h = m.hk;
    this.hook.push({ tm, state: h[0], x: h[1], y: h[2], z: h[3], len: h[4], reeling: h[5], holder: h[6] });
    if (this.hook.length > KEEP) this.hook.shift();
    for (const a of m.pr) {
      let buf = this.props.get(a[0]);
      if (!buf) { buf = []; this.props.set(a[0], buf); }
      buf.push({ tm, p: { x: a[1], y: a[2], z: a[3] }, q: { x: a[4], y: a[5], z: a[6], w: a[7] } });
      if (buf.length > KEEP) buf.shift();
    }
    for (const a of m.pl) {
      let buf = this.players.get(a[0]);
      if (!buf) { buf = []; this.players.set(a[0], buf); }
      buf.push({ tm, par: a[1], p: { x: a[2], y: a[3], z: a[4] }, yaw: a[5], pitch: a[6], mode: a[7], flags: a[8], seat: a[9] });
      if (buf.length > KEEP) buf.shift();
    }
  }

  // seed a prop's pose (spawned, or from a full list)
  seedProp(id, p, q) {
    this.props.set(id, [{ tm: -1e12, p, q }]);
  }
  dropProp(id) { this.props.delete(id); }
  dropPlayer(id) { this.players.delete(id); }

  time(now) { return this.offset == null ? null : now + this.offset - INTERP_MS; }

  sampleRV(t) {
    const b = bracket(this.rv, t);
    if (!b) return null;
    const [a, c, k] = b;
    const wheels = a.wheels.map((w, i) => (i % 2 === 1 ? c.wheels[i] : lerp(w, c.wheels[i], k)));
    return {
      p: { x: lerp(a.p.x, c.p.x, k), y: lerp(a.p.y, c.p.y, k), z: lerp(a.p.z, c.p.z, k) },
      q: nlerpQ(a.q, c.q, k),
      v: { x: lerp(a.v.x, c.v.x, k), y: lerp(a.v.y, c.v.y, k), z: lerp(a.v.z, c.v.z, k) },
      steer: lerp(a.steer, c.steer, k), wheels,
    };
  }

  sampleHook(t) {
    const b = bracket(this.hook, t);
    if (!b) return null;
    const [a, c, k] = b;
    if (a.state !== c.state) return c;
    return { ...c, x: lerp(a.x, c.x, k), y: lerp(a.y, c.y, k), z: lerp(a.z, c.z, k), len: lerp(a.len, c.len, k) };
  }

  sampleProp(id, t) {
    const buf = this.props.get(id);
    const b = buf && bracket(buf, t);
    if (!b) return null;
    const [a, c, k] = b;
    return { p: { x: lerp(a.p.x, c.p.x, k), y: lerp(a.p.y, c.p.y, k), z: lerp(a.p.z, c.p.z, k) }, q: nlerpQ(a.q, c.q, k) };
  }

  samplePlayer(id, t) {
    const buf = this.players.get(id);
    const b = buf && bracket(buf, t);
    if (!b) return null;
    const [a, c, k] = b;
    if (a.par !== c.par) return k < 0.5 ? a : c;
    return { ...c, p: { x: lerp(a.p.x, c.p.x, k), y: lerp(a.p.y, c.p.y, k), z: lerp(a.p.z, c.p.z, k) }, yaw: a.yaw + wrap(c.yaw - a.yaw) * k, pitch: lerp(a.pitch, c.pitch, k) };
  }
}
