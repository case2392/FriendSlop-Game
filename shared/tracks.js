// Side roads off the day's road (W.tracks, planned last in shared/world.js): a dirt track is a polyline in
// (x, z), every TRACK.STEP metres, lying at the canyon floor's height (roadY of each point's z), with the
// ground cut down to that floor along it and round the clearing at its end. Pure geometry: world gen, the
// terrain painter, the map, the server's tow and the tests all read tracks through these.
//   { id, kind: 'spur' | 'loop', side, pts: [{x, z}], s: [arc length at each point], hw, ch, bank,
//     dest: { x, z, r, padY, type, name } | null, sign, bx0, bx1, bz0, bz1 }

// hw: the track's half width (the RV is 2.5 m wide); ch: the cut's flat floor either side of its line;
// bank: how far the cut's banks run from the floor's edge up to the ground it was cut from; clear: the
// clearing round a spur's stop
export const TRACK = { HW: 2.6, CH: 8, BANK: 11, CLEAR: 21, STEP: 2 };

// Catmull-Rom through the control points, resampled every `step` metres along its length -> [{x, z}]
export function spline(ctl, step = TRACK.STEP) {
  const dense = [];
  for (let i = 0; i < ctl.length - 1; i++) {
    const p0 = ctl[Math.max(0, i - 1)], p1 = ctl[i], p2 = ctl[i + 1], p3 = ctl[Math.min(ctl.length - 1, i + 2)];
    const n = Math.max(4, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / 0.5));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      dense.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  dense.push({ x: ctl[ctl.length - 1].x, z: ctl[ctl.length - 1].z });
  const out = [{ ...dense[0] }];
  let need = step;
  for (let i = 1; i < dense.length; i++) {
    let a = dense[i - 1];
    const b = dense[i];
    let seg = Math.hypot(b.x - a.x, b.z - a.z);
    while (seg >= need) {
      const t = need / seg;
      a = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      out.push(a);
      seg -= need; need = step;
    }
    need -= seg;
  }
  const last = dense[dense.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.3) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

// a track's arc lengths and bounding box (call once its points are set)
export function finishTrack(T) {
  T.s = [0];
  for (let i = 1; i < T.pts.length; i++) T.s.push(T.s[i - 1] + Math.hypot(T.pts[i].x - T.pts[i - 1].x, T.pts[i].z - T.pts[i - 1].z));
  T.len = T.s[T.s.length - 1];
  T.bx0 = Math.min(...T.pts.map(p => p.x)); T.bx1 = Math.max(...T.pts.map(p => p.x));
  T.bz0 = Math.min(...T.pts.map(p => p.z)); T.bz1 = Math.max(...T.pts.map(p => p.z));
  if (T.dest) {
    T.bx0 = Math.min(T.bx0, T.dest.x - T.dest.r); T.bx1 = Math.max(T.bx1, T.dest.x + T.dest.r);
    T.bz0 = Math.min(T.bz0, T.dest.z - T.dest.r); T.bz1 = Math.max(T.bz1, T.dest.z + T.dest.r);
  }
  return T;
}

// the nearest point of a track's line to (x, z) -> { d: how far, s: how far along, x, z, tx, tz: its heading }
export function nearTrack(T, x, z) {
  let best = Infinity, bi = 0, bt = 0;
  const P = T.pts;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2));
    const dx = x - (a.x + ex * t), dz = z - (a.z + ez * t), d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  const a = P[bi], b = P[Math.min(P.length - 1, bi + 1)], ex = b.x - a.x, ez = b.z - a.z, el = Math.hypot(ex, ez) || 1;
  return { d: Math.sqrt(best), s: T.s[bi] + bt * el, x: a.x + ex * bt, z: a.z + ez * bt, tx: ex / el, tz: ez / el };
}

// is (x, z) within `m` metres of a track's box (cheap test before nearTrack)
export const nearBox = (T, x, z, m) => x > T.bx0 - m && x < T.bx1 + m && z > T.bz0 - m && z < T.bz1 + m;

// how far (x, z) is from the nearest track's line (or its stop's clearing edge, if nearer), within `max`
// metres (Infinity past it) -> { d, T, near } (d < hw: on the track itself)
export function trackAt(tracks, x, z, max = 30) {
  let out = { d: Infinity, T: null, near: null };
  for (const T of tracks || []) {
    if (!nearBox(T, x, z, max)) continue;
    const n = nearTrack(T, x, z);
    if (n.d < out.d) out = { d: n.d, T, near: n };
  }
  return out;
}
