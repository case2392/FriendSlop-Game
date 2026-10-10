// Render-only refinement of the crash mesas (part of the terrain art pass; pure maths, no THREE).
//
// The mesas are part of the physics heightfield, whose cells are 2.5 m: drawn as is, a mesa's outline is
// a ring of big triangle facets and its steep triangles show crease lines. Inside each mesa's footprint
// the terrain mesh is drawn S x S finer instead. Its NORMALS come from a smooth surface through every
// physics vertex (a tensor-product monotone cubic: Fritsch-Carlson tangents along x, then along z, so the
// top never bulges and the foot never dips), so the shading shows the mesa's form, not the triangles. Its
// HEIGHTS cannot follow that surface: where a flank cell folds along Rapier's fixed diagonal the physics
// triangles lie up to 3-4 m off any smooth surface, and people stand on and climb the physics one. So the
// heights are the physics triangles low-passed (a 5 x 5 Gaussian over +-1 m, only where the ground within
// it spans more than half a metre, so the flat top stays exactly flat), the change soft-clamped to
// +-0.35 m: creases and the lip's corners round off, nobody floats or sinks. Both are eased in over a
// ring round the footprint, so the refined patch meets the coarse grid on its own edges (where the
// coarse cells fan out to the fine vertices: no T-junction, no crack).
//
//   mesaRefiner(W, S) -> null (no mesas) or {
//     S,                       fine cells per coarse cell side
//     refined(ix, iz) -> bool  is coarse cell (ix, iz) drawn fine
//     height(x, z) -> m        the drawn height (the physics triangles outside the footprint)
//     weight(x, z) -> 0..1     how much of the refinement is in it (0 on the patch's rim)
//     gradient(x, z) -> [dh/dx, dh/dz] of the smooth surface (for normals)
//     tri(x, z), smooth(x, z)  the physics surface, the smooth one
//   }
// Measured on days 3-5 (seeds 777, 4242, 12345): drawn minus physics on the flanks max 0.350 m, mean
// 0.079 m; on the flat top (1.25 m in from its edge) max 0.19 cm.

const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Fritsch-Carlson limited tangent at p1 of the run p0, p1, p2 (no overshoot between samples)
function tangent(p0, p1, p2) {
  const a = p1 - p0, b = p2 - p1;
  if (a * b <= 0) return 0;
  const m = (a + b) / 2, lim = 3 * Math.min(Math.abs(a), Math.abs(b));
  return Math.sign(m) * Math.min(Math.abs(m), lim);
}
// cubic Hermite on [p1, p2] at t with limited tangents; returns [value, d/dt]
function hermite(p0, p1, p2, p3, t) {
  const m1 = tangent(p0, p1, p2), m2 = tangent(p1, p2, p3);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const v = h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
  const d = (6 * t2 - 6 * t) * p1 + (3 * t2 - 4 * t + 1) * m1 + (-6 * t2 + 6 * t) * p2 + (3 * t2 - 2 * t) * m2;
  return [v, d];
}

const BLUR = 0.5, LIM = 0.35, KW = [];
for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) KW.push(Math.exp(-(i * i + j * j) / 2.6));

export function mesaRefiner(W, S = 4) {
  const M = (W.mesas || []).filter(p => p.mesa).map(p => {
    const Rin = p.mesa.r * 1.25 + 4.5;               // the whole mesa (lobes, bench, flanks) lies inside
    return { x: p.x, z: p.z, Rin, Rout: Rin + 3 };
  });
  if (!M.length) return null;
  const { nx, nz, cell, X0, Z0, heights } = W, NZ1 = nz + 1;
  const Hc = (i, j) => heights[(i < 0 ? 0 : i > nx ? nx : i) * NZ1 + (j < 0 ? 0 : j > nz ? nz : j)];
  // a coarse cell is drawn fine when its centre lies within Rout + 1.8 m of a mesa (half a cell's
  // diagonal is 1.77 m), so every edge it shares with a coarse cell lies outside Rout, where weight = 0
  const ref = new Uint8Array(nx * nz);
  for (const m of M) {
    const R = m.Rout + 1.8;
    const i0 = Math.max(0, Math.floor((m.x - R - X0) / cell)), i1 = Math.min(nx - 1, Math.ceil((m.x + R - X0) / cell));
    const j0 = Math.max(0, Math.floor((m.z - R - Z0) / cell)), j1 = Math.min(nz - 1, Math.ceil((m.z + R - Z0) / cell));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const cx = X0 + (i + 0.5) * cell, cz = Z0 + (j + 0.5) * cell;
      if (Math.hypot(cx - m.x, cz - m.z) < R) ref[i * nz + j] = 1;
    }
  }
  const weight = (x, z) => {
    let w = 0;
    for (const m of M) w = Math.max(w, sstep(m.Rout, m.Rin, Math.hypot(x - m.x, z - m.z)));
    return w;
  };
  // the physics surface (Rapier's split: the (+x,-z)/(-x,+z) diagonal)
  const tri = (x, z) => {
    const fx = Math.max(0, Math.min(nx - 1e-6, (x - X0) / cell)), fz = Math.max(0, Math.min(nz - 1e-6, (z - Z0) / cell));
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const h00 = Hc(ix, iz), h10 = Hc(ix + 1, iz), h01 = Hc(ix, iz + 1), h11 = Hc(ix + 1, iz + 1);
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  };
  // the smooth surface and its gradient (per metre)
  const smooth = (x, z) => {
    const fx = Math.max(0, Math.min(nx - 1e-6, (x - X0) / cell)), fz = Math.max(0, Math.min(nz - 1e-6, (z - Z0) / cell));
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const rows = [], drows = [];
    for (let j = -1; j <= 2; j++) {
      const [val, d] = hermite(Hc(ix - 1, iz + j), Hc(ix, iz + j), Hc(ix + 1, iz + j), Hc(ix + 2, iz + j), u);
      rows.push(val); drows.push(d);
    }
    const [h, dv] = hermite(rows[0], rows[1], rows[2], rows[3], v);
    const [du] = hermite(drows[0], drows[1], drows[2], drows[3], v);
    return [h, du / cell, dv / cell];
  };
  return {
    S,
    refined: (ix, iz) => ix >= 0 && iz >= 0 && ix < nx && iz < nz && ref[ix * nz + iz] === 1,
    weight,
    height(x, z) {
      const w = weight(x, z), t = tri(x, z);
      if (w <= 0) return t;
      let a = 0, sw = 0, lo = Infinity, hi = -Infinity;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const h = tri(x + i * BLUR, z + j * BLUR), k = KW[(i + 2) * 5 + j + 2];
        a += h * k; sw += k; if (h < lo) lo = h; if (h > hi) hi = h;
      }
      const d = (a / sw - t) * sstep(0.5, 1.2, hi - lo);
      return t + LIM * Math.tanh(d / LIM) * w;
    },
    smooth: (x, z) => smooth(x, z)[0],
    tri,
    gradient(x, z) { const s = smooth(x, z); return [s[1], s[2]]; },
  };
}
