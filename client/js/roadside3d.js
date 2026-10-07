// Roadside: everything along the road that isn't nature or a building. The
// stops' furniture (statics tagged s.poi: semi trailers, yard-sale tables, the
// crashed plane, junk piles, gas pumps and counter, the dino statue), the
// gas canopy, umbrella, plane and wheel decor, the ranger gates and keypads,
// the winch anchor posts, the camp's log seats and the parked RVs in town.
//
// The look is WoW Classic goblin/human junk: chunky chamfered shapes with smooth
// shading, every surface painted (paint/roadside.js: riveted painted steel, tin,
// planks, timber, iron, brass, canvas), AO and ground grime baked into vertex
// colours, and per-biome weather: snow caps, icicles and drifts in the pass, red
// dust in the badlands, sand in the desert (a world-space top-cover shader lays it
// on every up-facing surface).
//
// Geometry is generated into per-material buckets and merged: one mesh per
// (cluster, material), where a cluster is one stop / gate / anchor pair / camp /
// RV lot. Each cluster also has a one-draw-call far LOD (vertex colours = the
// painted texture's average) that takes over past ~100 m.
// API: buildRoadside(W) -> { group, gates, update(dt, t, camPos) }, isRoadside(s), PREVIEW.
import { THREE, tex } from './gfx.js';
import { canvasFor } from './paint/index.js';
import { generateLeg } from '/shared/world.js';

const ROADSIDE_PARTS = new Set(['log_seat', 'parked_rv', 'keypad_post']);
// statics this module draws (the rest are town3d's). Note: tags can be 0, so test with !== undefined.
export const isRoadside = s => (s.poi !== undefined && s.bld === undefined && s.town === undefined) || ROADSIDE_PARTS.has(s.part);

const TAU = Math.PI * 2;
const V3 = THREE.Vector3;
const V = (x, y, z) => new V3(x, y, z);

// ---- small math -----------------------------------------------------------------------------------

function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (x, z, k = 0) => (Math.imul(Math.round(x * 100) | 0, 73856093) ^ Math.imul(Math.round(z * 100) | 0, 19349663) ^ Math.imul(k + 1, 83492791)) >>> 0;
const range = (r, a, b) => a + (b - a) * r();
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new V3(), _s = new V3();
function M4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
}
function tintOf(hex, ref = '#e2d6bc') {
  const a = new THREE.Color(hex), b = new THREE.Color(ref);
  return [Math.min(1, a.r / b.r), Math.min(1, a.g / b.g), Math.min(1, a.b / b.b)];
}

// ---- textures & materials -------------------------------------------------------------------------

// meters per texture repeat (world-mapped UVs) and the textures that are fitted one-per-face
const DENS = {
  rs_tin: 2, rs_tin_red: 2, rs_planks: 1, rs_planks_gray: 1, rs_timber: 1.5, rs_iron: 0.5, rs_brass: 1, rs_scrap: 1.5, rs_stone: 1.6,
  rs_warn: 1.6, rs_wing: 1.6, rs_gingham: 0.6, rs_bark: 1.2, rs_rv: 3, rs_snow: 2, rs_dust: 2, rs_sand: 2, rs_dirt: 2, rs_tire: 0.6,
  rs_fascia: 2, rs_shingles: 1.2, rs_dino: 2.5, rs_canvas: 3, rs_canvas_blue: 3,
};
const FIT = new Set(['rs_hub', 'rs_hub_cream', 'rs_glass', 'rs_grille', 'rs_crate_a', 'rs_crate_b', 'rs_crate_c', 'rs_barrel', 'rs_barrel_lid', 'rs_drum',
  'rs_drum_red', 'rs_pump_face', 'rs_keypad', 'rs_logend', 'rs_rv_window', 'rs_boards', 'rs_headlamp', 'rs_ice', 'rs_decal_freight', 'rs_ranger_board',
  'rs_plaque', 'rs_roundel']);
// flags on a material name: ! no top cover, * glows, ~ double-sided, # alpha-tested decal (no shadow, no LOD)
const baseName = m => m.replace(/[!*~#]+$/, '');
const densOf = m => { const b = baseName(m); return b.startsWith('rs_steel_') ? 2 : (DENS[b] || 1); };
const NO_SHADOW = /^(rs_glass|rs_headlamp|rs_keypad|rs_decal_freight|rs_ice|rs_logend|rs_hub|rs_hub_cream|rs_pump_face|rs_rv_window|rs_boards|rs_plaque|rs_roundel|rs_grille|rs_ranger_board|rs_barrel_lid)$/;

// Per-biome: ground grime (vertex AO tint), drifts, the top cover, paint schemes.
const BIO = {
  meadow: { ao: [0.6, 0.6, 0.48], ground: 'rs_dirt!', drift: null, cover: null,
    semi: [['rs_steel_red', 'rs_steel_blue'], ['rs_steel_cream', 'rs_steel_green']], dino: [1, 1, 1] },
  fields: { ao: [0.74, 0.66, 0.5], ground: 'rs_dirt!', drift: null, cover: { tex: 'rs_cover_sand', lo: 0.72, hi: 0.98, noise: 0.8, scale: 0.4, amt: 0.35 },
    semi: [['rs_steel_red', 'rs_steel_mustard'], ['rs_steel_cream', 'rs_steel_green']], dino: [1, 0.97, 0.9] },
  snow: { ao: [0.68, 0.76, 0.92], ground: 'rs_snow!', drift: 'rs_snow!', cover: { tex: 'rs_cover_snow', lo: 0.4, hi: 0.64, noise: 1.0, scale: 0.45, amt: 1 },
    semi: [['rs_steel_blue', 'rs_steel_red'], ['rs_steel_cream', 'rs_steel_teal']], dino: [0.92, 0.96, 1] },
  badlands: { ao: [0.9, 0.56, 0.4], ground: 'rs_dust!', drift: 'rs_dust!', cover: { tex: 'rs_cover_dust', lo: 0.58, hi: 0.92, noise: 0.9, scale: 0.4, amt: 0.75 },
    semi: [['rs_steel_mustard', 'rs_steel_teal'], ['rs_steel_cream', 'rs_steel_red']], dino: [1, 0.94, 0.86] },
  desert: { ao: [0.98, 0.84, 0.6], ground: 'rs_sand!', drift: 'rs_sand!', cover: { tex: 'rs_cover_sand', lo: 0.55, hi: 0.9, noise: 0.9, scale: 0.35, amt: 0.85 },
    semi: [['rs_steel_teal', 'rs_steel_red'], ['rs_steel_mustard', 'rs_steel_blue']], dino: [1, 0.96, 0.88] },
};

const MATS = new Map();
function rsMat(name, ctx) {
  const C = ctx.cover;
  const base = baseName(name), flags = name.slice(base.length);
  const useCover = C && !/[!*#]/.test(flags);
  const key = name + '|' + (useCover ? ctx.biome : '');
  if (MATS.has(key)) return MATS.get(key);
  const m = new THREE.MeshLambertMaterial({
    map: tex(base), vertexColors: true,
    side: flags.includes('~') ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: flags.includes('#') ? 0.5 : 0,
  });
  if (flags.includes('*')) { m.emissive = new THREE.Color('#ffcf88'); m.emissiveMap = m.map; m.emissiveIntensity = 0.55; }
  if (useCover) {
    m.onBeforeCompile = sh => {
      sh.uniforms.uCoverMap = { value: tex(C.tex) };
      sh.uniforms.uCover = { value: new THREE.Vector4(C.lo, C.hi, C.noise, C.scale) };
      sh.uniforms.uCoverAmt = { value: C.amt };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRsW; varying vec3 vRsN;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vRsW = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vRsN = normalize(mat3(modelMatrix) * objectNormal);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRsW; varying vec3 vRsN; uniform sampler2D uCoverMap; uniform vec4 uCover; uniform float uCoverAmt;')
        .replace('#include <lights_lambert_fragment>', `{
          vec4 cv = texture2D(uCoverMap, vRsW.xz * uCover.w);
          float up = normalize(vRsN).y;
          float k = smoothstep(uCover.x, uCover.y, up + (cv.a - 0.6) * uCover.z) * uCoverAmt;
          diffuseColor.rgb = mix(diffuseColor.rgb, cv.rgb, k);
        }
        #include <lights_lambert_fragment>`);
    };
    m.customProgramCacheKey = () => 'rs-cover';
  }
  MATS.set(key, m);
  return m;
}
let FAR_MAT = null;
const farMat = () => FAR_MAT || (FAR_MAT = new THREE.MeshLambertMaterial({ vertexColors: true }));

// a texture's average colour (linear), for the far LOD
const AVG = new Map();
const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function avgLin(base) {
  if (AVG.has(base)) return AVG.get(base);
  let c = [0.5, 0.5, 0.5];
  try {
    const cv = canvasFor(base);
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 5) { if (d[i + 3] < 128) continue; r += lin(d[i]); g += lin(d[i + 1]); b += lin(d[i + 2]); n++; }
    if (n) c = [r / n, g / n, b / n];
  } catch { /* keep the gray */ }
  AVG.set(base, c);
  return c;
}

// ---- the builder: generates triangles straight into per-material buckets ----------------------------

const FACES = [
  ['px', [1, 0, 0], [0, 0, -1], [0, 1, 0]],
  ['nx', [-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  ['py', [0, 1, 0], [1, 0, 0], [0, 0, -1]],
  ['ny', [0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ['pz', [0, 0, 1], [1, 0, 0], [0, 1, 0]],
  ['nz', [0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
const axisOf = v => (v[0] ? 0 : v[1] ? 1 : 2);
const hash3 = (x, y, z) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); };

class Builder {
  constructor(ctx) {
    this.ctx = ctx;
    this.buckets = new Map();
    this.F = new THREE.Matrix4(); this.FR = new THREE.Matrix3();
    this.fx = 0; this.fy = 0; this.fz = 0; this.fry = 0;
    this.stack = [new THREE.Matrix4()];
  }
  // the frame: everything after this is placed in a local space whose origin sits on the ground
  frame(x, y, z, ry = 0) {
    this.F.makeRotationY(ry).setPosition(x, y, z); this.FR.setFromMatrix4(this.F);
    this.fx = x; this.fy = y; this.fz = z; this.fry = ry;
    this.stack = [new THREE.Matrix4()];
    return this;
  }
  world(lx, ly, lz) { return V(lx, ly, lz).applyMatrix4(this.F); }
  ground(lx, lz) { const p = this.world(lx, 0, lz); return this.ctx.H(p.x, p.z) - this.fy; }
  // a static (world box) in this frame's local coordinates
  loc(s) {
    const dx = s.x - this.fx, dz = s.z - this.fz, c = Math.cos(this.fry), sn = Math.sin(this.fry);
    return { ...s, x: dx * c - dz * sn, y: s.y - this.fy, z: dx * sn + dz * c, ry: (s.ry || 0) - this.fry };
  }
  push(m) { this.stack.push(this.M.clone().multiply(m)); return this; }
  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }
  get M() { return this.stack[this.stack.length - 1]; }
  bucket(mat) {
    let b = this.buckets.get(mat);
    if (!b) { b = { mat, p: [], n: [], uv: [], c: [] }; this.buckets.set(mat, b); }
    return b;
  }
  // T: flat triangle soup [{p:[x,y,z], n:[x,y,z], uv:[u,v]} * 3k] in shape space; M: shape → frame-local
  emit(mat, T, M, o = {}) {
    if (!T.length) return;
    const B = this.bucket(mat);
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const ao = this.ctx.ao, aoH = this.ctx.aoH, tint = o.tint;
    const pl = new V3(), nl = new V3(), pw = new V3(), nw = new V3();
    for (let i = 0; i < T.length; i += 3) {
      // orient each triangle so its winding agrees with its vertex normals
      const a = T[i], b0 = T[i + 1], c0 = T[i + 2];
      const ux = b0.p[0] - a.p[0], uy = b0.p[1] - a.p[1], uz = b0.p[2] - a.p[2];
      const vx = c0.p[0] - a.p[0], vy = c0.p[1] - a.p[1], vz = c0.p[2] - a.p[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const nx = a.n[0] + b0.n[0] + c0.n[0], ny = a.n[1] + b0.n[1] + c0.n[1], nz = a.n[2] + b0.n[2] + c0.n[2];
      const tri = cx * nx + cy * ny + cz * nz < 0 ? [a, c0, b0] : [a, b0, c0];
      for (const v of tri) {
        pl.set(v.p[0], v.p[1], v.p[2]).applyMatrix4(M);
        nl.set(v.n[0], v.n[1], v.n[2]).applyMatrix3(nm).normalize();
        const uv = o.uvFn ? o.uvFn(pl, nl, v) : v.uv;
        pw.copy(pl).applyMatrix4(this.F);
        nw.copy(nl).applyMatrix3(this.FR);
        const k = o.noAO ? 1 : smooth(-0.15, aoH, pl.y);
        const lift = o.noAO ? 1 : 0.8 + 0.2 * smooth(0, 3.6, pl.y);
        let r = (ao[0] + (1 - ao[0]) * k) * lift, g = (ao[1] + (1 - ao[1]) * k) * lift, bl = (ao[2] + (1 - ao[2]) * k) * lift;
        if (nl.y < -0.5) { r *= 0.82; g *= 0.82; bl *= 0.86; }      // undersides: a little cooler and darker
        const t = v.tint || tint;
        if (t) { r *= t[0]; g *= t[1]; bl *= t[2]; }
        B.p.push(pw.x, pw.y, pw.z); B.n.push(nw.x, nw.y, nw.z); B.uv.push(uv[0], uv[1]); B.c.push(r, g, bl);
      }
    }
  }
  place(x, y, z, o) { return this.M.clone().multiply(M4(x, y, z, o.rx || 0, o.ry || 0, o.rz || 0, ...(o.s || [1, 1, 1]))); }

  // A chamfered box (rounded edges with smooth normals), UVs per face: world-mapped (o.S meters per
  // repeat) or fitted (fit: true | 'u' | 'v'). o.faces: { px: 'mat' | { m, fit, rot, S, tint, skip } }.
  // o.taper scales the top in x/z; o.deform(p) bends the shape; o.jit roughens it.
  box(mat, w, h, d, x, y, z, o = {}) {
    const E = [w / 2, h / 2, d / 2];
    const r = Math.min(o.r ?? 0.02, E[0] * 0.45, E[1] * 0.45, E[2] * 0.45);
    const spec = k => { const f = o.faces?.[k]; if (!f) return { m: mat }; return typeof f === 'string' ? { m: f } : { m: f.m || mat, ...f }; };
    const specs = FACES.map(([k]) => spec(k));
    const off = o.off || [0, 0];
    const uvOf = (fi, p) => {
      const [, , u, v] = FACES[fi], sp = specs[fi];
      const ua = axisOf(u), va = axisOf(v);
      const U = p[0] * u[0] + p[1] * u[1] + p[2] * u[2], W = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
      const fit = sp.fit ?? o.fit ?? FIT.has(baseName(sp.m));
      const S = sp.S ?? o.S ?? densOf(sp.m);
      const rot = sp.rot ?? o.rot;
      const fitU = fit === true || fit === (rot ? 'v' : 'u'), fitV = fit === true || fit === (rot ? 'u' : 'v');
      let uu = fitU ? (U + E[ua]) / (2 * E[ua]) : U / S + off[0];
      let vv = fitV ? (W + E[va]) / (2 * E[va]) : W / S + off[1];
      if (rot) [uu, vv] = [vv, -uu];
      return [uu, vv];
    };
    const tl = o.taper ?? 1;
    const shape = q => {
      const p = [q[0], q[1], q[2]];
      if (tl !== 1) { const k = 1 + (tl - 1) * (p[1] + E[1]) / (2 * E[1]); p[0] *= k; p[2] *= k; }
      if (o.deform) o.deform(p);
      if (o.jit) { const j = o.jit; p[0] += (hash3(q[0], q[1], q[2]) - 0.5) * j; p[1] += (hash3(q[1], q[2], q[0]) - 0.5) * j; p[2] += (hash3(q[2], q[0], q[1]) - 0.5) * j; }
      return p;
    };
    const out = new Map();
    const put = (fi, pts, nrm) => {
      const sp = specs[fi];
      if (sp.skip) return;
      let T = out.get(sp.m); if (!T) { T = []; out.set(sp.m, T); }
      const tint = sp.tint;
      for (let i = 0; i < 3; i++) T.push({ p: shape(pts[i]), n: nrm[i], uv: uvOf(fi, pts[i]), tint });
    };
    const quad = (fi, a, b, c, dd, na, nb, nc, nd) => { put(fi, [a, b, c], [na, nb, nc]); put(fi, [a, c, dd], [na, nc, nd]); };
    // main faces
    FACES.forEach(([, n, u, v], fi) => {
      const na = axisOf(n), ua = axisOf(u), va = axisOf(v);
      const P = (su, sv) => { const p = [0, 0, 0]; p[na] = n[na] * E[na]; p[ua] = su * (E[ua] - r); p[va] = sv * (E[va] - r); return p; };
      quad(fi, P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), n, n, n, n);
    });
    if (r > 1e-4) {
      // edge strips
      for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
        const nA = FACES[a][1], nB = FACES[b][1], aA = axisOf(nA), aB = axisOf(nB);
        if (aA === aB) continue;
        const k = 3 - aA - aB;
        const owner = aA === 1 ? b : a;
        const pts = [];
        for (const t of [-1, 1]) {
          const pa = [0, 0, 0], pb = [0, 0, 0];
          pa[aA] = nA[aA] * E[aA]; pa[aB] = nB[aB] * (E[aB] - r); pa[k] = t * (E[k] - r);
          pb[aA] = nA[aA] * (E[aA] - r); pb[aB] = nB[aB] * E[aB]; pb[k] = t * (E[k] - r);
          pts.push(pa, pb);
        }
        quad(owner, pts[0], pts[2], pts[3], pts[1], nA, nA, nB, nB);
      }
      // corners
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const pX = [sx * E[0], sy * (E[1] - r), sz * (E[2] - r)], pY = [sx * (E[0] - r), sy * E[1], sz * (E[2] - r)], pZ = [sx * (E[0] - r), sy * (E[1] - r), sz * E[2]];
        put(sx > 0 ? 0 : 1, [pX, pY, pZ], [[sx, 0, 0], [0, sy, 0], [0, 0, sz]]);
      }
    }
    const M = this.place(x, y, z, o);
    for (const [m, T] of out) this.emit(m, T, M, o);
  }

  // A cylinder along y (rt top, rb bottom), optional bevelled rims and caps. u wraps around
  // (fit: uRep repeats; else world), v runs along y. o.arc = [start, length] for partial shells.
  cyl(mat, rt, rb, h, x, y, z, o = {}) {
    const seg = o.seg || 10, [a0, al] = o.arc || [0, TAU], full = al >= TAU - 1e-6;
    const fit = o.fit ?? FIT.has(baseName(mat)), S = o.S ?? densOf(mat), uRep = o.uRep || 1;
    const b = Math.min(o.bevel || 0, h * 0.3, Math.max(rt, rb) * 0.4);
    const slope = (rb - rt) / h;
    const rings = b > 0
      ? [[Math.max(0, rb - b), -h / 2, -1], [rb, -h / 2 + b, 0], [rt, h / 2 - b, 0], [Math.max(0, rt - b), h / 2, 1]]
      : [[rb, -h / 2, 0], [rt, h / 2, 0]];
    const circ = al * (rt + rb) / 2;
    const T = [];
    const vert = (ring, j) => {
      const [rr, yy, cap] = ring, th = a0 + al * j / seg, sx = Math.sin(th), cz = Math.cos(th);
      let n = [sx, slope, cz];
      if (cap) n = [sx * 0.55, cap * 0.85, cz * 0.55];
      const l = Math.hypot(...n);
      const u = fit ? uRep * j / seg : (j / seg) * circ / S;
      const v = fit ? (yy + h / 2) / h : (yy + h / 2) / S;
      return { p: [rr * sx, yy, rr * cz], n: [n[0] / l, n[1] / l, n[2] / l], uv: [u, v] };
    };
    for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < seg; j++) {
      const A = vert(rings[i], j), Bv = vert(rings[i], j + 1), C = vert(rings[i + 1], j + 1), D = vert(rings[i + 1], j);
      T.push(A, Bv, C, A, C, D);
    }
    const M = this.place(x, y, z, o);
    this.emit(mat, T, M, o);
    const capMat = o.caps === undefined ? mat : o.caps;
    if (capMat && full) {
      const capFit = o.capFit ?? FIT.has(baseName(capMat)), cS = densOf(capMat);
      const C = [];
      for (const [rr, yy, sg] of [[rings[0][0], -h / 2, -1], [rings[rings.length - 1][0], h / 2, 1]]) {
        if (rr <= 1e-4) continue;
        const ctr = { p: [0, yy, 0], n: [0, sg, 0], uv: capFit ? [0.5, 0.5] : [0, 0] };
        for (let j = 0; j < seg; j++) {
          const v = k => { const th = TAU * k / seg, px = rr * Math.sin(th), pz = rr * Math.cos(th);
            return { p: [px, yy, pz], n: [0, sg, 0], uv: capFit ? [0.5 + 0.5 * Math.sin(th) * sg, 0.5 + 0.5 * Math.cos(th)] : [px / cS, pz / cS] }; };
          C.push(ctr, v(j), v(j + 1));
        }
      }
      this.emit(capMat, C, M, o);
    }
  }

  // A surface of revolution around y from a profile [[r, y], ...] (bottom → top). o.caps closes the ends.
  lathe(mat, prof, x, y, z, o = {}) {
    const seg = o.seg || 12, fit = o.fit ?? FIT.has(baseName(mat)), S = o.S ?? densOf(mat), uRep = o.uRep || 1;
    const n = prof.length;
    const len = [0]; for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
    const avgR = prof.reduce((s, q) => s + q[0], 0) / n;
    const nrm2 = i => {
      const a = prof[Math.max(0, i - 1)], b = prof[Math.min(n - 1, i + 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
      return [ty / l, -tx / l];
    };
    const jit = o.jit || 0;
    const vert = (i, j) => {
      const th = TAU * (j % seg) / seg, [rr0, yy] = prof[i], [nr, ny] = nrm2(i);
      const rr = rr0 + (jit && rr0 > 0 ? (hash3(i * 1.7, j % seg, x + z) - 0.5) * jit : 0);
      return { p: [rr * Math.sin(th), yy, rr * Math.cos(th)], n: [nr * Math.sin(th), ny, nr * Math.cos(th)],
        uv: [fit ? uRep * j / seg : (j / seg) * TAU * avgR / S, fit ? len[i] / len[n - 1] : len[i] / S] };
    };
    const T = [];
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
      const A = vert(i, j), Bv = vert(i, j + 1), C = vert(i + 1, j + 1), D = vert(i + 1, j);
      if (prof[i][0] > 1e-5) T.push(A, Bv, C); if (prof[i + 1][0] > 1e-5) T.push(A, C, D);
      if (prof[i][0] <= 1e-5 && prof[i + 1][0] <= 1e-5) continue;
    }
    const M = this.place(x, y, z, o);
    this.emit(mat, T, M, o);
    if (o.caps) {
      const C = [];
      for (const [i, sg] of [[0, -1], [n - 1, 1]]) {
        const [rr, yy] = prof[i];
        if (rr <= 1e-4) continue;
        const ctr = { p: [0, yy, 0], n: [0, sg, 0], uv: [0.5, 0.5] };
        for (let j = 0; j < seg; j++) {
          const v = k => { const th = TAU * k / seg; return { p: [rr * Math.sin(th), yy, rr * Math.cos(th)], n: [0, sg, 0], uv: [0.5 + 0.5 * Math.sin(th) * sg, 0.5 + 0.5 * Math.cos(th)] }; };
          C.push(ctr, v(j), v(j + 1));
        }
      }
      this.emit(o.caps, C, M, o);
    }
  }
  // ellipsoid with radii (rx, ry, rz)
  ell(mat, rx, ry, rz, x, y, z, o = {}) {
    const rings = o.rings || 8, prof = [];
    for (let i = 0; i <= rings; i++) { const ph = -Math.PI / 2 + Math.PI * i / rings; prof.push([Math.cos(ph), Math.sin(ph)]); }
    prof[0][0] = 0; prof[rings][0] = 0;
    this.lathe(mat, prof, x, y, z, { ...o, s: [rx, ry, rz], seg: o.seg || 12 });
  }
  // a mound: the top half of an ellipsoid sitting at (x, y, z)
  mound(mat, rx, h, rz, x, y, z, o = {}) {
    const rings = o.rings || 5, prof = [[1.08, -0.15]];
    for (let i = 0; i <= rings; i++) { const ph = Math.PI / 2 * i / rings; prof.push([Math.cos(ph), Math.sin(ph)]); }
    prof[prof.length - 1][0] = 0;
    const S = densOf(mat);
    this.lathe(mat, prof, x, y, z, { seg: 12, ...o, s: [rx, h, rz], uvFn: o.uvFn || (pl => [pl.x / S, pl.z / S]) });
  }
  // a tube through points (V3) with per-point radii; o.capEnd closes the last end
  tube(mat, pts, radii, o = {}) {
    const seg = o.seg || 8, fit = o.fit ?? false, S = o.S ?? densOf(mat);
    const rad = i => (Array.isArray(radii) ? radii[i] : radii);
    const n = pts.length, T = [];
    const tans = pts.map((p, i) => pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
    let nrm = Math.abs(tans[0].y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
    nrm = nrm.sub(tans[0].clone().multiplyScalar(nrm.dot(tans[0]))).normalize();
    const frames = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) { nrm.sub(tans[i].clone().multiplyScalar(nrm.dot(tans[i]))).normalize(); }
      frames.push([nrm.clone(), tans[i].clone().cross(nrm).normalize()]);
    }
    const len = [0]; for (let i = 1; i < n; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const avgR = pts.reduce((s, p, i) => s + rad(i), 0) / n;
    const vert = (i, j) => {
      const th = TAU * j / seg, [N, Bn] = frames[i], c = Math.cos(th), s = Math.sin(th);
      const dir = N.clone().multiplyScalar(c).add(Bn.clone().multiplyScalar(s));
      const p = pts[i].clone().add(dir.clone().multiplyScalar(rad(i)));
      return { p: [p.x, p.y, p.z], n: [dir.x, dir.y, dir.z], uv: [fit ? j / seg : (j / seg) * TAU * avgR / S, len[i] / S] };
    };
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
      const A = vert(i, j), Bv = vert(i, j + 1), C = vert(i + 1, j + 1), D = vert(i + 1, j);
      T.push(A, Bv, C, A, C, D);
    }
    if (o.capEnd) {
      const e = pts[n - 1], t = tans[n - 1];
      const tip = { p: [e.x + t.x * rad(n - 1) * 0.6, e.y + t.y * rad(n - 1) * 0.6, e.z + t.z * rad(n - 1) * 0.6], n: [t.x, t.y, t.z], uv: [0, len[n - 1] / S] };
      for (let j = 0; j < seg; j++) { const A = vert(n - 1, j), Bv = vert(n - 1, j + 1); T.push(A, Bv, tip); }
    }
    this.emit(mat, T, this.M.clone(), o);
  }
  // a torus (ring) in the shape's xy-plane
  torus(mat, R, r, x, y, z, o = {}) {
    const g = new THREE.TorusGeometry(R, r, o.tseg || 6, o.seg || 14);
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, idx = g.index.array;
    const T = [];
    for (let i = 0; i < idx.length; i++) { const k = idx[i]; T.push({ p: [pos.getX(k), pos.getY(k), pos.getZ(k)], n: [nor.getX(k), nor.getY(k), nor.getZ(k)], uv: [uv.getX(k) * 4, uv.getY(k)] }); }
    g.dispose();
    this.emit(mat, T, this.place(x, y, z, o), o);
  }
  // a flat quad facing +z (decals, roundels)
  quad(mat, w, h, x, y, z, o = {}) {
    const a = { p: [-w / 2, -h / 2, 0], n: [0, 0, 1], uv: [0, 0] }, b = { p: [w / 2, -h / 2, 0], n: [0, 0, 1], uv: [1, 0] };
    const c = { p: [w / 2, h / 2, 0], n: [0, 0, 1], uv: [1, 1] }, d = { p: [-w / 2, h / 2, 0], n: [0, 0, 1], uv: [0, 1] };
    this.emit(mat, [a, b, c, a, c, d], this.place(x, y, z, o), { noAO: true, ...o });
  }
}

// ---- clusters: merged meshes + a far LOD ---------------------------------------------------------------

function finish(B, ctx, parent, clusters, track = null) {
  if (!B.buckets.size) return;
  const near = new THREE.Group();
  const fp = [], fn = [], fc = [];
  const box = new THREE.Box3(), tmp = new V3();
  const cov = ctx.cover ? avgLin(ctx.cover.tex) : null;
  for (const b of B.buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, rsMat(b.mat, ctx));
    const base = baseName(b.mat), flags = b.mat.slice(base.length);
    m.castShadow = !NO_SHADOW.test(base) && !flags.includes('#');
    m.receiveShadow = true;
    m.name = 'rs:' + b.mat;
    near.add(m);
    for (let i = 0; i < b.p.length; i += 3) box.expandByPoint(tmp.set(b.p[i], b.p[i + 1], b.p[i + 2]));
    if (flags.includes('#')) continue;
    const a = avgLin(base), glow = flags.includes('*') ? 1.6 : 1;
    const useCov = cov && !/[!*#]/.test(flags);
    for (let i = 0; i < b.p.length; i += 3) {
      fp.push(b.p[i], b.p[i + 1], b.p[i + 2]); fn.push(b.n[i], b.n[i + 1], b.n[i + 2]);
      let r = a[0] * glow, g2 = a[1] * glow, bl = a[2] * glow;
      if (useCov) { const k = smooth(ctx.cover.lo, ctx.cover.hi, b.n[i + 1]) * ctx.cover.amt; r += (cov[0] - r) * k; g2 += (cov[1] - g2) * k; bl += (cov[2] - bl) * k; }
      fc.push(r * b.c[i], g2 * b.c[i + 1], bl * b.c[i + 2]);
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  fg.setAttribute('normal', new THREE.Float32BufferAttribute(fn, 3));
  fg.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
  fg.computeBoundingSphere();
  const far = new THREE.Mesh(fg, farMat());
  far.visible = false; far.castShadow = false; far.receiveShadow = false; far.name = 'rs:far';
  parent.add(near, far);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  clusters.push({ near, far, center: sphere.center, radius: sphere.radius, track, lod: 75 + sphere.radius * 4 });
}

// ---- reusable pieces ---------------------------------------------------------------------------------

// a wheel with its axle along local x
function wheel(B, x, y, z, r, w, o = {}) {
  B.push(M4(x, y, z, 0, o.ry || 0, o.lean || 0));
  const squash = o.flat ? 0.86 : 1;
  B.cyl('rs_tire', r, r, w, 0, 0, 0, { rz: Math.PI / 2, s: [squash, 1, 1], seg: 14, caps: o.hub || 'rs_hub', bevel: w * 0.25, fit: true, uRep: 6 });
  B.pop();
}
// a wooden barrel (bulged staves, lids) or a steel drum, standing along local y
function barrel(B, kind, r, h, x, y, z, o = {}) {
  if (kind === 'rs_barrel') {
    const pr = [[r * 0.84, -h / 2], [r * 0.95, -h / 4], [r, 0], [r * 0.95, h / 4], [r * 0.84, h / 2]];
    B.lathe('rs_barrel', pr, x, y, z, { ...o, seg: 12, caps: 'rs_barrel_lid' });
  } else {
    B.cyl(kind, r, r, h, x, y, z, { ...o, seg: 12, caps: 'rs_iron', bevel: 0.025 });
  }
}
function snowCap(B, w, d, x, y, z, o = {}) {
  const t = o.t ?? 0.14;
  B.box('rs_snow!', w + 0.08, t, d + 0.08, x, y + t / 2 - 0.02, z, {
    r: t * 0.48, rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0, S: 2, noAO: true,
    deform: p => { if (p[1] > 0) p[1] += Math.sin(p[0] * 2.3 + p[2] * 1.7) * 0.03 + Math.sin(p[0] * 5.1) * 0.015; },
  });
}
function icicles(B, ax, az, bx, bz, y, rnd, o = {}) {
  const L = Math.hypot(bx - ax, bz - az);
  let t = rnd() * 0.25;
  while (t < L) {
    const k = t / L, len = range(rnd, 0.1, o.max || 0.45), r = range(rnd, 0.025, 0.05);
    B.cyl('rs_ice!', r, 0, len, ax + (bx - ax) * k, y - len / 2, az + (bz - az) * k, { seg: 5, caps: false, fit: true, noAO: true });
    t += range(rnd, 0.1, 0.42);
  }
}
function drift(B, ctx, x, z, rx, rz, h, ry = 0) {
  if (!ctx.driftMat) return;
  B.mound(ctx.driftMat, rx, h, rz, x, B.ground(x, z) - 0.1, z, { ry, jit: Math.min(0.12, h * 0.3), rings: 4 });
}
function lantern(B, x, y, z, chain = 0.4) {
  B.cyl('rs_iron', 0.015, 0.015, chain, x, y + 0.2 + chain / 2, z, { seg: 4, caps: false });
  B.cyl('rs_iron', 0.02, 0.15, 0.12, x, y + 0.22, z, { seg: 4, caps: 'rs_iron' });
  B.box('rs_headlamp*', 0.17, 0.24, 0.17, x, y, z, { r: 0.01, fit: true });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.box('rs_iron', 0.03, 0.3, 0.03, x + sx * 0.09, y, z + sz * 0.09, { r: 0.005 });
  B.box('rs_iron', 0.22, 0.04, 0.22, x, y - 0.15, z, { r: 0.01 });
}

// ---- the stops ---------------------------------------------------------------------------------------

function buildSemi(B, p, parts, ctx) {
  const t = p.trailer || { x: p.x, y: p.y, z: p.z, ry: p.ry || 0 };
  B.frame(t.x, t.y, t.z, t.ry);
  const L = parts.map(s => B.loc(s));
  const one = k => L.find(s => s.part === k);
  const rnd = rngOf(seedOf(p.x, p.z, 3));
  const [P, C] = ctx.bio.semi[p.id % 2];
  const fl = one('trailer_floor'), roof = one('trailer_roof'), front = one('trailer_front'), cab = one('cab'), ramp = one('ramp');
  const sides = L.filter(s => s.part === 'trailer_side');
  if (fl) {
    const zr = fl.z - fl.hz, zf = fl.z + fl.hz, hw = fl.hx;
    B.box('rs_iron', fl.hx * 2, fl.hy * 2, fl.hz * 2, fl.x, fl.y, fl.z, { r: 0.03, faces: { py: { m: 'rs_planks', rot: true } } });
    for (const sx of [-1, 1]) B.box('rs_iron', 0.16, 0.24, fl.hz * 2 - 0.4, fl.x + sx * 0.55, fl.y - fl.hy - 0.12, fl.z, { r: 0.03 });
    for (let k = 0; k < 5; k++) B.box('rs_iron', 1.3, 0.1, 0.12, fl.x, fl.y - fl.hy - 0.1, zr + 1 + k * 2.4, { r: 0.02 });
    // rear bumper bar, tandem wheels, axles, mud flaps
    B.box('rs_iron', 2.3, 0.13, 0.15, fl.x, 0.42, zr - 0.03, { r: 0.04 });
    for (const sx of [-1, 1]) B.box('rs_iron', 0.08, 0.32, 0.08, fl.x + sx * 0.8, 0.56, zr + 0.03);
    for (const wz of [zr + 1.45, zr + 2.45]) {
      B.cyl('rs_iron', 0.05, 0.05, 2.2, fl.x, 0.42, wz, { rz: Math.PI / 2, caps: false, seg: 6 });
      for (const sx of [-1, 1]) { const flat = rnd() < 0.3; wheel(B, fl.x + sx * (hw - 0.2), flat ? 0.37 : 0.42, wz, 0.42, 0.3, { flat }); }
    }
    for (const sx of [-1, 1]) B.box('rs_iron', 0.5, 0.48, 0.03, fl.x + sx * (hw - 0.2), 0.42, zr + 0.85, { r: 0.01, tint: [0.55, 0.5, 0.52], rx: 0.08 });
    // sides: painted steel outside, plank liner inside, ribs, rails, corner posts, the freight lettering
    for (const s of sides) {
      const sx = Math.sign(s.x) || 1, outer = sx > 0 ? 'px' : 'nx', inner = sx > 0 ? 'nx' : 'px';
      B.box('rs_iron', s.hx * 2, s.hy * 2, s.hz * 2, s.x, s.y, s.z, { r: 0.02, faces: { [outer]: { m: P, rot: false }, [inner]: 'rs_planks_gray' }, off: [rnd(), 0.13] });
      const nr = 8;
      for (let i = 0; i <= nr; i++) {
        const zz = zr + 0.35 + (zf - zr - 0.7) * i / nr;
        if (i === 3 || i === 4 || i === 5) continue;      // leave the lettering clear
        B.box(P, 0.05, s.hy * 2 - 0.32, 0.1, s.x + sx * (s.hx + 0.025), s.y + 0.02, zz, { r: 0.02, off: [i * 0.37, 0] });
      }
      B.box('rs_iron', 0.08, 0.16, s.hz * 2 + 0.1, s.x + sx * (s.hx + 0.04), s.y + s.hy - 0.08, s.z, { r: 0.03, rot: true });
      B.box('rs_iron', 0.1, 0.24, s.hz * 2 + 0.1, s.x + sx * (s.hx + 0.05), s.y - s.hy + 0.12, s.z, { r: 0.03, rot: true });
      B.box('rs_iron', 0.18, s.hy * 2 + 0.2, 0.18, s.x + sx * 0.03, s.y, zr - 0.04, { r: 0.04 });
      B.box('rs_iron', 0.16, s.hy * 2 + 0.2, 0.16, s.x + sx * 0.03, s.y, zf + 0.02, { r: 0.04 });
      B.quad('rs_decal_freight#', 5.0, 1.25, s.x + sx * (s.hx + 0.012), s.y + 0.2, s.z - 0.2, { ry: sx * Math.PI / 2 });
    }
    if (front) B.box('rs_iron', front.hx * 2, front.hy * 2, front.hz * 2, front.x, front.y, front.z, { r: 0.02, faces: { pz: P, nz: 'rs_planks_gray' } });
    if (roof) {
      B.box('rs_iron', roof.hx * 2, roof.hy * 2, roof.hz * 2, roof.x, roof.y, roof.z, { r: 0.03, faces: { py: { m: 'rs_tin', rot: true } } });
      for (const sx of [-1, 1]) for (const zz of [zf - 0.08, zr + 0.08]) B.box('rs_headlamp*', 0.12, 0.08, 0.07, roof.x + sx * (roof.hx - 0.12), roof.y - roof.hy - 0.05, zz, { tint: zz > 0 ? [1, 0.75, 0.45] : [1, 0.4, 0.32] });
      if (ctx.snow) {
        snowCap(B, roof.hx * 2, roof.hz * 2, roof.x, roof.y + roof.hy, roof.z, { t: 0.22 });
        for (const sx of [-1, 1]) icicles(B, roof.x + sx * (roof.hx + 0.03), zr, roof.x + sx * (roof.hx + 0.03), zf, roof.y - roof.hy, rnd);
      }
    }
    // the rear doors, swung open: one folded back against the side, one hanging out
    const s0 = sides[0];
    const dh = s0 ? s0.hy * 2 - 0.08 : 2.6, dy = s0 ? s0.y : 2.2;
    for (const [sx, d] of [[-1, [-0.25, 0.968]], [1, [0.6, 0.8]]]) {
      const len = hw, th = Math.atan2(-d[1], d[0]);
      const hx = fl.x + sx * (hw + 0.1), hz = zr - 0.06;
      B.push(M4(hx + d[0] * len / 2, dy, hz + d[1] * len / 2, 0, th, 0));
      B.box('rs_iron', len, dh, 0.05, 0, 0, 0, { r: 0.015, faces: { pz: P, nz: P }, off: [sx * 0.31, 0.2] });
      for (const lx of [-0.25, 0.25]) B.cyl('rs_iron', 0.025, 0.025, dh - 0.1, lx * len, 0, -0.05, { seg: 6, caps: 'rs_iron' });
      for (const yy of [-dh * 0.38, 0, dh * 0.38]) B.box('rs_iron', 0.34, 0.08, 0.02, -len / 2 + 0.17, yy, -0.035, { r: 0.005 });
      B.pop();
    }
    if (ramp) {
      B.box('rs_planks_gray', ramp.hx * 2, ramp.hy * 2, ramp.hz * 2, ramp.x, ramp.y, ramp.z, { r: 0.02, rot: true, ry: ramp.ry });
      for (let k = 0; k < 4; k++) B.box('rs_timber', ramp.hx * 2 - 0.12, 0.04, 0.07, ramp.x, ramp.y + ramp.hy + 0.02, ramp.z - ramp.hz + 0.3 + k * 0.65, { rot: true, r: 0.01 });
      for (const zz of [ramp.z - ramp.hz + 0.25, ramp.z + ramp.hz - 0.25]) {
        const gy = B.ground(ramp.x, zz), top = ramp.y - ramp.hy, hh = top - gy + 0.1;
        if (hh > 0.03) B.box('rs_timber', ramp.hx * 2 - 0.25, hh, 0.3, ramp.x, gy - 0.1 + hh / 2, zz, { rot: true, r: 0.02 });
      }
    }
    // weather on the ground
    if (ctx.driftMat) {
      drift(B, ctx, fl.x - hw - 0.05, fl.z + 1, 0.8, 4.2, ctx.snow ? 0.55 : 0.38, 0);
      drift(B, ctx, fl.x + hw + 0.05, fl.z - 2, 0.6, 2.4, 0.28, 0);
    }
  }
  if (cab) {
    const cx = cab.x, cz = cab.z, hx = cab.hx, hz = cab.hz, fz = cz + hz, bz = cz - hz, top = cab.y + cab.hy;
    B.box('rs_iron', 1.7, 0.26, hz * 2 + 0.2, cx, 0.58, cz, { r: 0.03 });
    for (const sx of [-1, 1]) wheel(B, cx + sx * (hx - 0.16), 0.5, cz - 0.1, 0.5, 0.34, {});
    const ly0 = 0.55, ly1 = 1.5;
    B.box(C, hx * 2, ly1 - ly0, hz * 2, cx, (ly0 + ly1) / 2, cz, { r: 0.08, faces: { ny: 'rs_iron' }, off: [0.2, 0.4] });
    B.box('rs_grille', 1.3, 0.74, 0.06, cx, 1.02, fz + 0.02, { r: 0.02 });
    for (const sx of [-1, 1]) B.cyl('rs_brass', 0.19, 0.19, 0.13, cx + sx * 0.86, 1.02, fz + 0.05, { rx: Math.PI / 2, caps: 'rs_headlamp*', seg: 12, bevel: 0.02 });
    // the upper cab: tapered, rounded, windshield, side windows
    const uh = top - ly1, TAP = 0.92;
    const inset = yy => 1 - (1 - TAP) * clamp01((yy - ly1) / uh);
    B.box(C, hx * 2, uh, hz * 2, cx, ly1 + uh / 2, cz, { r: 0.16, taper: TAP, off: [0.6, 0.1] });
    const tilt = Math.atan((1 - TAP) * hz / uh);
    for (const sx of [-1, 1]) B.box('rs_glass', 0.98, 0.72, 0.04, cx + sx * 0.52 * inset(2.45), 2.45, cz + hz * inset(2.45) + 0.005, { rx: -tilt, r: 0.01 });
    B.box(C, 0.08, 0.76, 0.06, cx, 2.45, cz + hz * inset(2.45) + 0.01, { rx: -tilt });
    for (const sx of [-1, 1]) {
      const xx = cx + sx * (hx * inset(2.5) + 0.005);
      B.box('rs_glass', 0.04, 0.62, 1.05, xx, 2.5, cz + 0.3, { rz: sx * tilt, r: 0.01 });
      B.box('rs_brass', 0.04, 0.05, 0.18, xx + sx * 0.02, 2.0, cz - 0.2);
      // mirror on an iron arm
      B.cyl('rs_iron', 0.025, 0.025, 0.36, cx + sx * (hx + 0.15), 2.35, fz - 0.35, { rz: Math.PI / 2, seg: 5, caps: false });
      B.box('rs_iron', 0.07, 0.4, 0.22, cx + sx * (hx + 0.34), 2.35, fz - 0.35, { r: 0.025 });
      B.box('rs_iron', 0.32, 0.06, 0.45, cx + sx * (hx + 0.12), 0.72, cz + 0.25, { r: 0.015 });
    }
    // visor with marker lamps, bumper, exhaust stack, air horn
    B.box('rs_brass', hx * 2 * TAP, 0.08, 0.16, cx, top - 0.1, cz + hz * TAP + 0.06, { r: 0.02 });
    for (const lx of [-0.5, 0, 0.5]) B.box('rs_headlamp*', 0.13, 0.08, 0.07, cx + lx, top - 0.02, cz + hz * TAP + 0.02, { tint: [1, 0.78, 0.45] });
    B.box('rs_iron', hx * 2 + 0.3, 0.27, 0.24, cx, 0.5, fz + 0.13, { r: 0.07 });
    const ex = cx + hx + 0.1, ez = bz + 0.2;
    B.cyl('rs_brass', 0.09, 0.09, 3.1, ex, 2.45, ez, { seg: 8, caps: 'rs_iron' });
    B.cyl('rs_iron', 0.125, 0.125, 0.95, ex, 2.2, ez, { seg: 8, caps: false });
    B.box('rs_iron', 0.2, 0.025, 0.2, ex, 4.03, ez + 0.05, { rx: -0.6 });
    B.cyl('rs_brass', 0.03, 0.12, 0.62, cx - 0.55, top + 0.1, cz - 0.1, { rx: Math.PI / 2, caps: false, seg: 8 });
    B.box('rs_brass', 0.08, 0.1, 0.08, cx - 0.55, top + 0.04, cz - 0.1);
    if (ctx.snow) {
      snowCap(B, hx * 2 * TAP - 0.1, hz * 2 * TAP - 0.1, cx, top, cz, { t: 0.2 });
      icicles(B, cx - hx * TAP, fz - 0.05, cx + hx * TAP, fz - 0.05, top - 0.05, rnd, { max: 0.3 });
    }
    // nose in the dirt
    B.mound(ctx.bio.ground, 1.5, 0.32, 0.6, cx, B.ground(cx, fz + 0.45) - 0.1, fz + 0.45, { jit: 0.05 });
  }
}

function buildYard(B, p, parts, ctx, decor) {
  B.frame(p.x, p.y, p.z, p.ry || 0);
  const L = parts.map(s => B.loc(s));
  const rnd = rngOf(seedOf(p.x, p.z, 5));
  for (const t of L.filter(s => s.part === 'table')) {
    B.push(M4(t.x, 0, t.z, 0, t.ry, 0));
    const top = t.y + t.hy;
    B.box('rs_planks', t.hx * 2, t.hy * 2 - 0.012, t.hz * 2, 0, t.y - 0.006, 0, { r: 0.015, off: [rnd(), rnd()] });
    B.box('rs_gingham', t.hx * 2 + 0.06, 0.012, t.hz * 2 + 0.06, 0, top + 0.004, 0, { r: 0.004 });
    for (const sz of [-1, 1]) {
      const ph = rnd() * 6;
      B.box('rs_gingham', t.hx * 2 + 0.06, 0.32, 0.014, 0, top - 0.155, sz * (t.hz + 0.032), { r: 0.004,
        deform: q => { q[2] += Math.sin(q[0] * 8 + ph) * 0.014 * (0.4 - q[1]); if (q[1] < 0) q[1] += Math.sin(q[0] * 5 + ph) * 0.02; } });
    }
    for (const sx of [-1, 1]) B.box('rs_gingham', 0.014, 0.16, t.hz * 2 + 0.06, sx * (t.hx + 0.032), top - 0.075, 0, { r: 0.004 });
    // trestles
    for (const sx of [-1, 1]) {
      const lx = sx * (t.hx - 0.24), y1 = t.y - t.hy;
      for (const sz of [-1, 1]) {
        const dz = 0.3, len = Math.hypot(dz, y1);
        B.box('rs_timber', 0.07, len, 0.07, lx, y1 / 2, sz * (0.12 + dz / 2), { rx: -sz * Math.atan2(dz, y1), r: 0.015 });
      }
      B.box('rs_timber', 0.06, 0.07, 0.62, lx, 0.3, 0, { rot: true, r: 0.015 });
      B.box('rs_timber', 0.09, 0.06, t.hz * 2 - 0.1, lx, y1 - 0.03, 0, { rot: true, r: 0.015 });
    }
    // something for sale under the table
    B.box(pick(rnd, ['rs_crate_a', 'rs_crate_b']), 0.5, 0.42, 0.42, (rnd() < 0.5 ? -1 : 1) * 0.42, 0.21, 0.02, { r: 0.03, ry: range(rnd, -0.2, 0.2) });
    B.pop();
  }
  for (const l of L.filter(s => s.part === 'table_legs')) B.box('rs_timber', l.hx * 2, 0.12, 0.06, l.x, 0.36, l.z, { rot: true, ry: l.ry, r: 0.015 });
  // the umbrella
  const d = decor.find(e => e.k === 'umbrella');
  if (d) {
    B.frame(d.x, d.y, d.z, d.ry || 0);
    barrel(B, 'rs_barrel', 0.27, 0.62, 0, 0.31, 0, {});
    B.push(M4(0, 0.55, 0, 0.03, 0, 0.06));
    B.cyl('rs_timber', 0.04, 0.045, 2.35, 0, 1.12, 0, { seg: 6, caps: false });
    const canvas = ctx.biome === 'snow' || ctx.biome === 'desert' ? 'rs_canvas_blue~' : 'rs_canvas~';
    B.lathe(canvas, [[1.6, 1.72], [1.25, 1.9], [0.75, 2.08], [0.28, 2.2], [0, 2.25]], 0, 0, 0, { seg: 8, fit: true });
    B.cyl(canvas, 1.6, 1.62, 0.2, 0, 1.63, 0, { seg: 8, caps: false, fit: true });
    for (let k = 0; k < 8; k++) {
      const a = TAU * k / 8;
      B.tube('rs_iron', [V(0, 1.95, 0), V(Math.sin(a) * 1.55, 1.7, Math.cos(a) * 1.55)], 0.012, { seg: 4 });
    }
    B.ell('rs_brass', 0.06, 0.08, 0.06, 0, 2.3, 0, { seg: 8, rings: 5 });
    if (ctx.snow) B.lathe('rs_snow!', [[1.45, 1.86], [1.1, 2.0], [0.6, 2.16], [0.2, 2.27], [0, 2.3]], 0, 0, 0, { seg: 8, S: 2, noAO: true });
    B.pop();
  }
}

function buildCrash(B, p, parts, ctx, decor) {
  const d = decor.find(e => e.k === 'plane') || { x: p.x, y: p.y, z: p.z, ry: (p.ry || 0) + 0.8 };
  B.frame(d.x, d.y, d.z, d.ry);
  const L = parts.map(s => B.loc(s));
  const fus = L.find(s => s.part === 'fuselage'), wing = L.find(s => s.part === 'wing');
  const rnd = rngOf(seedOf(p.x, p.z, 9));
  const RED = 'rs_steel_red';
  if (fus) {
    const fy = fus.y, fh = fus.hy, fz0 = fus.z, fhz = fus.hz, zN = fz0 + fhz;
    const taperK = zz => 1 - 0.3 * smooth(-0.6, -fhz, zz);
    const taper = q => { const zz = q[2] + fz0, k = taperK(zz); q[0] *= k; q[1] = q[1] * k + (1 - k) * fh * 0.6; };
    B.box(RED, fus.hx * 2, fh * 2, fhz * 2, fus.x, fy, fz0, { r: 0.3, faces: { ny: 'rs_iron' }, deform: taper, off: [0.3, 0.1] });
    for (const zz of [2.4, 1.0, -0.4]) B.box('rs_brass', fus.hx * 2 + 0.06, fh * 2 + 0.06, 0.14, fus.x, fy, fz0 + zz * fhz / 3.2, { r: 0.32 });
    // cockpit: brass coaming, dark well, leather seat back, windscreen
    const ct = fy + fh;
    B.box('rs_brass', 0.92, 0.06, 1.25, fus.x, ct + 0.02, fz0 + 0.75, { r: 0.025 });
    B.box('rs_iron', 0.72, 0.03, 1.02, fus.x, ct + 0.05, fz0 + 0.75, { tint: [0.32, 0.3, 0.34] });
    B.box('rs_timber', 0.55, 0.42, 0.1, fus.x, ct + 0.24, fz0 + 0.33, { tint: [0.85, 0.5, 0.4], r: 0.04 });
    B.box('rs_glass', 0.66, 0.34, 0.03, fus.x, ct + 0.22, fz0 + 1.42, { rx: -0.4, r: 0.01 });
    // the nose: crumpled brass cowling, a radial engine, a broken propeller
    B.lathe('rs_brass', [[0.62, 0], [0.7, 0.16], [0.68, 0.36], [0.52, 0.5], [0.24, 0.56]], fus.x, fy, zN - 0.08, { rx: Math.PI / 2, seg: 12, jit: 0.07 });
    B.cyl('rs_iron', 0.24, 0.24, 0.05, fus.x, fy, zN + 0.48, { rx: Math.PI / 2, seg: 10, tint: [0.5, 0.48, 0.5] });
    for (let k = 0; k < 7; k++) {
      const a = TAU * k / 7 + 0.2;
      B.cyl('rs_iron', 0.085, 0.1, 0.3, fus.x + Math.cos(a) * 0.74, fy + Math.sin(a) * 0.74, zN + 0.22, { rz: a - Math.PI / 2, seg: 8, caps: 'rs_iron', bevel: 0.02 });
    }
    B.cyl('rs_brass', 0, 0.17, 0.32, fus.x, fy, zN + 0.68, { rx: Math.PI / 2, seg: 10 });
    B.push(M4(fus.x, fy, zN + 0.62, 0, 0, 0.55));
    B.box('rs_timber', 0.2, 1.15, 0.06, 0, 0.62, 0, { r: 0.025, taper: 0.55, rx: 0.3, deform: q => { q[2] += q[1] * q[1] * 0.25; } });
    B.box('rs_timber', 0.2, 0.36, 0.06, 0, -0.22, 0, { r: 0.025, jit: 0.04 });
    B.pop();
    // tail: swept fin with a gnomish roundel, stabilizer
    const zt = fz0 - fhz + 0.5, k = taperK(zt - 0.2), finY = fy + fh * k + (1 - k) * fh * 0.6;
    B.box(RED, 0.09, 1.05, 0.95, fus.x, finY + 0.45, zt, { r: 0.03, taper: 0.6, deform: q => { q[2] -= (q[1] + 0.5) * 0.35; } });
    B.box('rs_brass', 0.11, 0.08, 0.6, fus.x, finY + 0.97, zt - 0.3, { r: 0.02 });
    for (const sx of [-1, 1]) B.quad('rs_roundel#', 0.5, 0.5, fus.x + sx * 0.052, finY + 0.4, zt - 0.1, { ry: sx * Math.PI / 2 });
    B.box('rs_wing', 2.8, 0.07, 0.72, fus.x, fy + 0.25, zt - 0.05, { r: 0.025, rz: 0.12 });
    // landing gear: one leg snapped out sideways, a wheel lying in the dirt
    B.tube('rs_iron', [V(fus.x + 0.4, 0.3, fz0 + 2.0), V(fus.x + 1.05, 0.22, fz0 + 2.3)], 0.045, { seg: 6 });
    wheel(B, fus.x + 1.15, 0.3, fz0 + 2.32, 0.3, 0.14, { ry: 0.4, lean: 0.35 });
    {
      const wx = fus.x - 2.7, wz = fz0 + 2.8, gy = B.ground(wx, wz);
      B.cyl('rs_tire', 0.3, 0.3, 0.14, wx, gy + 0.06, wz, { caps: 'rs_hub', fit: true, uRep: 6, bevel: 0.035, seg: 14, rx: 0.12 });
    }
    // furrow ploughed by the nose
    B.mound(ctx.bio.ground, 1.5, 0.48, 1.0, fus.x, B.ground(fus.x, zN + 0.7) - 0.12, zN + 0.7, { jit: 0.08 });
  }
  if (wing) {
    const droop = q => { const xx = q[0] + wing.x; if (xx > 2.6) { const k2 = xx - 2.6; q[1] -= k2 * k2 * 0.09; } };
    B.box('rs_wing', wing.hx * 2, wing.hy * 2, wing.hz * 2, wing.x, wing.y, wing.z, { r: 0.05, deform: droop, off: [0.2, 0.5] });
    B.cyl('rs_brass', 0.055, 0.055, 6.75, wing.x - 0.78, wing.y, wing.z + wing.hz, { rz: Math.PI / 2, seg: 6, caps: false });
    B.box(RED, 0.12, wing.hy * 2 + 0.06, wing.hz * 2 + 0.04, wing.x - wing.hx, wing.y, wing.z, { r: 0.04 });
    // the upper wing: left half still up on its struts, the right half snapped and hanging
    const uy = 2.05, uz = wing.z + 0.1;
    B.box('rs_wing', 6.4, 0.14, 1.5, wing.x - 1.0, uy, uz, { r: 0.05, off: [0.7, 0.2] });
    B.box(RED, 0.12, 0.2, 1.54, wing.x - 4.2, uy, uz, { r: 0.04 });
    B.push(M4(wing.x + 2.2, uy, uz, 0, 0.08, -0.62));
    B.box('rs_wing', 1.9, 0.13, 1.45, 0.95, 0, 0, { r: 0.05, jit: 0.04, off: [0.1, 0.9] });
    B.pop();
    for (const sx of [-3.0, -1.4, 1.4]) for (const dz of [-0.45, 0.5]) {
      B.cyl('rs_timber', 0.04, 0.04, uy - wing.y - 0.12, wing.x + sx, (uy + wing.y) / 2, uz + dz, { seg: 6, caps: false });
    }
    for (const sx of [-1, 1]) B.cyl('rs_iron', 0.03, 0.03, uy - 1.4, wing.x + sx * 0.38, (uy + 1.4) / 2, uz, { seg: 5, caps: false, rz: sx * 0.15 });
    B.cyl('rs_timber', 0.04, 0.04, 0.55, wing.x + 3.0, wing.y + 0.3, uz, { seg: 6, caps: false, rz: -0.5 });
    for (const [x0, x1] of [[-3.0, -1.4], [-1.4, 1.4]]) {
      B.tube('rs_iron', [V(wing.x + x0, wing.y + 0.08, uz), V(wing.x + x1, uy - 0.07, uz)], 0.01, { seg: 3 });
      B.tube('rs_iron', [V(wing.x + x1, wing.y + 0.08, uz), V(wing.x + x0, uy - 0.07, uz)], 0.01, { seg: 3 });
    }
    if (ctx.snow) {
      snowCap(B, 6.3, 1.45, wing.x - 1.0, uy + 0.07, uz, { t: 0.12 });
      icicles(B, wing.x - 4.1, uz + 0.75, wing.x + 2.1, uz + 0.75, uy - 0.07, rnd, { max: 0.3 });
    }
  }
  // debris scattered round the wreck (kept off the loot, which lies behind it)
  const debris = [RED, 'rs_wing', 'rs_brass', 'rs_iron', RED];
  for (let i = 0; i < 6; i++) {
    let x, z; do { const a = rnd() * TAU, rr = range(rnd, 2.6, 4.8); x = Math.cos(a) * rr; z = Math.sin(a) * rr; } while (z < -2.5 && Math.abs(x) < 3.5);
    B.box(debris[i % debris.length], range(rnd, 0.3, 0.7), 0.04, range(rnd, 0.25, 0.5), x, B.ground(x, z) + 0.04, z, { ry: rnd() * 3, rx: range(rnd, -0.25, 0.25), rz: range(rnd, -0.25, 0.25), jit: 0.05 });
  }
  B.box('rs_timber', 0.2, 0.85, 0.06, -1.8, B.ground(-1.8, 3.6) + 0.04, 3.6, { rx: -Math.PI / 2 + 0.05, ry: 0.7, taper: 0.6, r: 0.02 });
  if (ctx.driftMat && fus) drift(B, ctx, fus.x - fus.hx - 0.05, fus.z - 0.5, 0.55, 2.4, 0.32, 0);
}

function buildJunk(B, p, parts, ctx) {
  for (const s of parts) {
    const gy = ctx.H(s.x, s.z);
    B.frame(s.x, gy, s.z, s.ry || 0);
    const rnd = rngOf(seedOf(s.x, s.z, 7));
    const cy = s.y - gy, bot = cy - s.hy, top = cy + s.hy;
    if (s.part !== 'scrap' && bot > 0.06) B.mound('rs_scrap', s.hx * 1.25, bot + 0.12, s.hz * 1.25, 0, -0.08, 0, { jit: 0.12, seg: 10 });
    if (s.part === 'crate') {
      const nx = s.hx * 2 > 1.45 ? 2 : 1, nz = s.hz * 2 > 1.45 ? 2 : 1, ny = s.hy * 2 > 1.25 ? 2 : 1;
      const W = s.hx * 2 / nx, H = s.hy * 2 / ny, D = s.hz * 2 / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) for (let k = 0; k < ny; k++) {
        const v = pick(rnd, ['rs_crate_a', 'rs_crate_b', 'rs_crate_c', 'rs_crate_a', 'rs_crate_b']), sh = k > 0 ? 0.94 : 1;
        B.box(v, (W - 0.04) * sh, H - 0.02, (D - 0.04) * sh, -s.hx + W * (i + 0.5), bot + H * (k + 0.5), -s.hz + D * (j + 0.5), { r: 0.035, ry: k > 0 ? range(rnd, -0.06, 0.06) : 0 });
      }
    } else if (s.part === 'barrel') {
      const W2 = s.hx * 2, D2 = s.hz * 2, H2 = s.hy * 2, alongX = W2 >= D2, long = Math.max(W2, D2), short = Math.min(W2, D2);
      const kind = pick(rnd, ['rs_barrel', 'rs_drum', 'rs_drum_red', 'rs_barrel']);
      if (H2 >= short * 0.8 || H2 > 0.95) {
        const n = Math.max(1, Math.round(long / Math.min(short, H2 * 1.1)));
        const r = Math.min(short / 2, long / (2 * n)) * 0.96;
        const rows = Math.max(1, Math.floor(short / (2 * r) + 0.05));
        const stack = H2 > 1.7 ? 2 : 1, bh = H2 / stack;
        for (let i = 0; i < n; i++) for (let j = 0; j < rows; j++) for (let k = 0; k < stack; k++) {
          const a = -long / 2 + long * (i + 0.5) / n, b = -short / 2 + short * (j + 0.5) / rows;
          barrel(B, k ? pick(rnd, ['rs_barrel', 'rs_drum']) : kind, r, bh - 0.02, alongX ? a : b, bot + bh * (k + 0.5), alongX ? b : a, { ry: rnd() * TAU });
        }
      } else {
        const r = H2 / 2 * 0.98, m = Math.max(1, Math.round(long / 1.15)), len = long / m - 0.04;
        const rows = Math.max(1, Math.floor(short / (2 * r) + 0.05));
        for (let i = 0; i < m; i++) for (let j = 0; j < rows; j++) {
          const a = -long / 2 + long * (i + 0.5) / m, b = -short / 2 + short * (j + 0.5) / rows;
          barrel(B, kind, r, len, alongX ? a : b, bot + r, alongX ? b : a, alongX ? { rz: Math.PI / 2, ry: 0 } : { rx: Math.PI / 2 });
        }
      }
    } else {
      // scrap heap: a mound of rusted junk with plates, a pipe, a cog and a wheel sticking out
      const base = Math.min(0, bot) - 0.06, ht = top - base;
      B.mound('rs_scrap', s.hx * 1.05, ht, s.hz * 1.05, 0, base, 0, { jit: 0.14, seg: 10, rings: 4 });
      for (let k = 0; k < 3; k++) {
        const a = rnd() * TAU, px = Math.cos(a) * s.hx * 0.6, pz = Math.sin(a) * s.hz * 0.6;
        B.box(pick(rnd, ['rs_steel_red', 'rs_steel_blue', 'rs_tin', 'rs_steel_green', 'rs_tin_red']), range(rnd, 0.6, 1.05), 0.04, range(rnd, 0.4, 0.75),
          px, base + ht * range(rnd, 0.45, 0.75), pz, { ry: -a, rx: range(rnd, -0.9, -0.4), rz: range(rnd, -0.3, 0.3), r: 0.01, jit: 0.04 });
      }
      B.cyl('rs_iron', 0.06, 0.06, 1.3, s.hx * 0.3, base + ht * 0.7, -s.hz * 0.2, { rz: range(rnd, 0.6, 1.1), ry: rnd() * 3, caps: 'rs_iron', seg: 8 });
      B.push(M4(-s.hx * 0.35, base + ht * 0.75, s.hz * 0.25, Math.PI / 2 - 0.5, rnd() * 3, 0));
      B.cyl('rs_brass', 0.3, 0.3, 0.07, 0, 0, 0, { seg: 12, caps: 'rs_brass' });
      for (let t = 0; t < 10; t++) { const a = TAU * t / 10; B.box('rs_brass', 0.1, 0.07, 0.1, Math.sin(a) * 0.33, 0, Math.cos(a) * 0.33, { ry: a, r: 0.01 }); }
      B.pop();
      wheel(B, s.hx * 0.75, base + ht * 0.45, s.hz * 0.4, 0.36, 0.18, { ry: 1.1, lean: 0.45, hub: 'rs_hub_cream' });
    }
    if (ctx.snow && top > 0.3 && s.part === 'crate') snowCap(B, s.hx * 2 - 0.06, s.hz * 2 - 0.06, 0, top, 0, { t: 0.1 });
  }
  // stacked tyres beside the pile
  B.frame(p.x, p.y, p.z, p.ry || 0);
  const rnd = rngOf(seedOf(p.x, p.z, 8));
  for (const [x, z, n] of [[4.6, -1.2, 3], [-4.6, -1.6, 1]]) {
    const gy = B.ground(x, z);
    for (let k = 0; k < n; k++) B.cyl('rs_tire', 0.42, 0.42, 0.26, x + range(rnd, -0.06, 0.06), gy + 0.13 + k * 0.25, z + range(rnd, -0.06, 0.06), { caps: 'rs_hub', fit: true, uRep: 6, bevel: 0.07, seg: 14 });
  }
}

function buildGas(B, p, parts, ctx, decor) {
  B.frame(p.x, p.y, p.z, p.ry || 0);
  const L = parts.map(s => B.loc(s));
  const rnd = rngOf(seedOf(p.x, p.z, 11));
  const pumps = L.filter(s => s.part === 'pump');
  if (pumps.length) {
    const xs = pumps.map(u => u.x), zc = pumps.reduce((s, u) => s + u.z, 0) / pumps.length;
    B.box('rs_stone', Math.max(...xs) - Math.min(...xs) + 1.7, 0.12, 1.3, (Math.max(...xs) + Math.min(...xs)) / 2, 0.06, zc, { r: 0.04 });
  }
  for (const u of pumps) {
    B.push(M4(u.x, 0, u.z, 0, u.ry, 0));
    B.box('rs_iron', 0.76, 0.14, 0.56, 0, 0.19, 0, { r: 0.03 });
    B.box('rs_steel_red', 0.66, 1.12, 0.46, 0, 0.82, 0, { r: 0.06, faces: { pz: { m: 'rs_pump_face', fit: true }, nz: { m: 'rs_pump_face', fit: true } } });
    B.box('rs_brass', 0.72, 0.12, 0.52, 0, 1.44, 0, { r: 0.04 });
    B.cyl('rs_brass', 0.1, 0.13, 0.08, 0, 1.54, 0, { seg: 10 });
    B.ell('rs_headlamp*', 0.19, 0.2, 0.19, 0, 1.77, 0, { seg: 12, rings: 8 });
    B.cyl('rs_brass', 0.05, 0.07, 0.07, 0, 1.99, 0, { seg: 8 });
    const hx = 0.34;
    B.tube('rs_iron', [V(hx, 1.15, 0.05), V(hx + 0.12, 0.9, 0.12), V(hx + 0.16, 0.5, 0.15), V(hx + 0.1, 0.28, 0.12), V(hx + 0.03, 0.55, 0.1), V(hx + 0.03, 0.92, 0.14)], 0.032, { seg: 6, tint: [0.42, 0.38, 0.4] });
    B.box('rs_brass', 0.06, 0.22, 0.07, hx + 0.04, 1.02, 0.16, { rx: 0.3, r: 0.015 });
    B.box('rs_iron', 0.1, 0.03, 0.07, hx + 0.02, 1.13, 0.12);
    B.pop();
  }
  // the canopy, carried on two timber columns that rise out of the pump islands
  const cd = decor.find(e => e.k === 'canopy');
  if (cd) {
    const c = B.loc({ x: cd.x, y: cd.y, z: cd.z, ry: cd.ry });
    const top = c.y, ccx = c.x, ccz = c.z;
    for (const u of pumps) {
      const h = top - 0.25 - 1.5;
      B.box('rs_timber', 0.22, h, 0.22, u.x, 1.5 + h / 2, u.z - 0.12, { r: 0.03 });
      B.box('rs_iron', 0.27, 0.1, 0.27, u.x, 1.56, u.z - 0.12, { r: 0.02 });
      B.box('rs_iron', 0.27, 0.12, 0.27, u.x, top - 0.32, u.z - 0.12, { r: 0.02 });
      for (const sx of [-1, 1]) B.box('rs_timber', 0.1, 0.9, 0.1, u.x + sx * 0.33, top - 0.55, u.z - 0.12, { rz: -sx * 0.8, r: 0.015 });
    }
    B.box('rs_timber', 8.2, 0.3, 0.3, ccx, top - 0.1, ccz, { r: 0.04, rot: true });
    for (let k = 0; k < 5; k++) B.box('rs_timber', 0.16, 0.18, 4.5, ccx - 3.9 + k * 1.95, top + 0.14, ccz, { r: 0.02 });
    const run = 2.35, rise = 0.55, len = Math.hypot(run, rise), ang = Math.atan2(rise, run);
    for (const sz of [-1, 1]) {
      const cy = top + 0.25 + rise / 2 + 0.04, cz = ccz + sz * run / 2;
      B.box('rs_tin_red', 8.7, 0.07, len, ccx, cy, cz, { rx: sz * ang, faces: { ny: 'rs_planks_gray' }, r: 0.02 });
      B.box('rs_fascia', 8.8, 0.3, 0.06, ccx, top + 0.2, ccz + sz * (run + 0.02), { fit: 'v', r: 0.02 });
      for (const sx of [-1, 1]) B.box('rs_timber', 0.07, 0.16, len, ccx + sx * 4.36, cy, cz, { rx: sz * ang, r: 0.02 });
      if (ctx.snow) {
        snowCap(B, 8.6, len, ccx, cy + 0.03, cz, { t: 0.18, rx: sz * ang });
        icicles(B, ccx - 4.3, ccz + sz * (run + 0.05), ccx + 4.3, ccz + sz * (run + 0.05), top + 0.05, rnd);
      }
    }
    B.box('rs_iron', 8.8, 0.1, 0.24, ccx, top + 0.25 + rise + 0.07, ccz, { r: 0.03 });
    for (const sx of [-1, 1]) lantern(B, ccx + sx * 3.0, top - 0.6, ccz, 0.25);
  }
  const cnt = L.find(s => s.part === 'counter');
  if (cnt) {
    B.push(M4(cnt.x, 0, cnt.z, 0, cnt.ry, 0));
    const t = cnt.y + cnt.hy;
    B.box('rs_planks', cnt.hx * 2 + 0.12, 0.08, cnt.hz * 2 + 0.12, 0, t - 0.04, 0, { r: 0.02 });
    B.box('rs_planks_gray', cnt.hx * 2 - 0.06, cnt.hy * 2 - 0.16, cnt.hz * 2 - 0.06, 0, cnt.y - 0.04, 0, { rot: true, r: 0.02 });
    B.box('rs_timber', cnt.hx * 2, 0.1, cnt.hz * 2, 0, 0.05, 0, { rot: true, r: 0.02 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.cyl('rs_brass', 0.035, 0.035, cnt.hy * 2 - 0.1, sx * (cnt.hx - 0.03), cnt.y, sz * (cnt.hz - 0.03), { seg: 6, caps: false });
    B.pop();
  }
  // drums out by the corner of the building
  barrel(B, 'rs_drum_red', 0.3, 0.88, 3.55, B.ground(3.55, 3.6) + 0.44, 3.6, { ry: 0.6 });
  barrel(B, 'rs_drum', 0.3, 0.88, 4.0, B.ground(4.0, 3.15) + 0.44, 3.15, { ry: 2.1 });
}

function buildDino(B, p, parts, ctx) {
  const d = p.dino || { x: p.x, y: p.y, z: p.z, ry: p.ry || 0 };
  B.frame(d.x, d.y, d.z, d.ry);
  const L = parts.map(s => B.loc(s));
  const body = L.find(s => s.part === 'dino_body'), tail = L.find(s => s.part === 'dino_tail'), neck = L.find(s => s.part === 'dino_neck');
  const legs = L.filter(s => s.part === 'dino_leg');
  const tint = ctx.bio.dino;
  const uvFn = (pl, nl) => [(pl.z + pl.x * 0.35) / 2.5, 0.06 + 0.9 * (0.5 + 0.5 * nl.y)];
  const rnd = rngOf(seedOf(p.x, p.z, 13));
  if (body) {
    const bz = body.z;
    B.box('rs_stone', body.hx * 2 + 0.3, 1.0, body.hz * 2 + 0.5, body.x, 0.5, bz, { r: 0.06, jit: 0.03, S: 2.8 });
    B.box('rs_stone', body.hx * 2 + 0.5, 0.14, body.hz * 2 + 0.7, body.x, 1.04, bz, { r: 0.05, off: [0.3, 0.3], S: 2.8 });
    B.quad('rs_plaque', 1.5, 0.5, body.x, 0.52, bz + body.hz + 0.25 + 0.012, {});
    B.ell('rs_dino', body.hx, 1.42, body.hz * 1.02, body.x, 3.0, bz, { seg: 16, rings: 12, uvFn, tint,
      deform: null });
    // a ridge of plates along the spine
    for (let k = 0; k < 9; k++) {
      const zz = bz - body.hz * 0.85 + k * body.hz * 1.7 / 8, yy = 3.0 + 1.42 * Math.sqrt(Math.max(0, 1 - ((zz - bz) / (body.hz * 1.02)) ** 2));
      B.cyl('rs_dino', 0, 0.16, 0.3, body.x, yy + 0.08, zz, { seg: 5, caps: false, uvFn: () => [k * 0.1, 0.98], tint: [0.8, 0.85, 0.75] });
    }
  }
  for (const l of legs) {
    // a thick leg from the foot up into the hip, well inside the belly
    const bz0 = body ? body.z : l.z, hip = V(l.x * 0.55, 2.75, bz0 + (l.z - bz0) * 0.78);
    B.tube('rs_dino', [V(l.x, 1.12, l.z), V(l.x * 0.92, 1.8, l.z + (bz0 - l.z) * 0.05), hip], [0.5, 0.46, 0.5], { seg: 10, uvFn, tint });
    B.ell('rs_dino', 0.56, 0.26, 0.66, l.x, 1.12, l.z + 0.1, { seg: 10, rings: 6, uvFn, tint });
    for (const k of [-1, 0, 1]) B.ell('rs_dino', 0.11, 0.09, 0.13, l.x + k * 0.27, 1.13, l.z + 0.66, { seg: 6, rings: 4, uvFn: () => [0.3, 0.04], tint });
  }
  if (neck && body) {
    const nTop = neck.y + neck.hy;
    B.tube('rs_dino', [V(neck.x, 3.3, body.z + body.hz - 1.0), V(neck.x, 4.4, neck.z - 0.25), V(neck.x, 5.5, neck.z + 0.05), V(neck.x, nTop - 0.06, neck.z)], [0.98, 0.64, 0.5, 0.44], { seg: 12, uvFn, tint });
    // the head is gone: broken plaster, rebar
    B.cyl('rs_stone', 0.4, 0.45, 0.16, neck.x, nTop - 0.03, neck.z, { seg: 10, jit: 0.07, tint: [1.08, 1.05, 1], caps: 'rs_stone' });
    for (let k = 0; k < 3; k++) {
      const a = TAU * k / 3 + 0.4, bx = neck.x + Math.cos(a) * 0.18, bz = neck.z + Math.sin(a) * 0.18;
      B.tube('rs_iron', [V(bx, nTop - 0.1, bz), V(bx + Math.cos(a) * 0.05, nTop + 0.25, bz + Math.sin(a) * 0.05), V(bx + Math.cos(a) * range(rnd, 0.1, 0.3), nTop + range(rnd, 0.4, 0.6), bz + Math.sin(a) * 0.25)], 0.025, { seg: 4 });
    }
    if (ctx.snow) B.ell('rs_snow!', 0.36, 0.1, 0.36, neck.x, nTop + 0.05, neck.z, { seg: 10, rings: 4, noAO: true });
  }
  if (tail && body) {
    const sw = (p.id % 2 ? 1 : -1) * 0.32;
    B.tube('rs_dino', [V(tail.x, 3.15, body.z - body.hz + 0.9), V(tail.x + sw * 0.3, 3.4, tail.z + 1.3), V(tail.x + sw, 3.6, tail.z + 0.1), V(tail.x + sw * 0.6, 3.75, tail.z - 1.1), V(tail.x - sw * 0.2, 4.0, tail.z - tail.hz + 0.08)], [0.95, 0.55, 0.38, 0.24, 0.1], { seg: 10, uvFn, tint, capEnd: true });
  }
  if (ctx.driftMat && body) { drift(B, ctx, body.x - body.hx - 0.15, body.z, 0.7, 3.0, 0.42, 0); drift(B, ctx, body.x + body.hx + 0.15, body.z - 1.5, 0.5, 1.6, 0.28, 0); }
}

// ---- gates, keypads, anchors, camp, the RV lot ------------------------------------------------------------

function buildGateStatic(B, g, ctx) {
  const road = g.y - g.hy;
  B.frame(g.x, road, g.z, 0);
  const rnd = rngOf(seedOf(g.x, g.z, 21));
  const px = g.hx + 0.5, beamY = 5.45;
  for (const sx of [-1, 1]) {
    const gy = Math.min(B.ground(sx * px, -0.42), B.ground(sx * px, 0.42));
    const bot = Math.min(gy, 0) - 0.4, h = beamY + 0.25 - bot;
    for (const sz of [-1, 1]) B.box('rs_timber', 0.44, h, 0.44, sx * px, bot + h / 2, sz * 0.44, { r: 0.06, jit: 0.03, off: [sz * 0.3, sx * 0.2] });
    if (gy < 1.2) B.box('rs_stone', 1.15, 0.9, 1.65, sx * px, gy + 0.25, 0, { r: 0.12, jit: 0.05 });
    for (const yy of [3.5, 4.9]) B.box('rs_timber', 0.22, 0.28, 1.2, sx * px, yy, 0, { r: 0.04 });
    for (const yy of [1.4, 3.5]) for (const sz of [-1, 1]) B.box('rs_iron', 0.5, 0.16, 0.5, sx * px, yy - 0.3, sz * 0.44, { r: 0.02 });
    for (const sz of [-1, 1]) B.box('rs_timber', 0.18, 1.45, 0.18, sx * (px - 0.55), beamY - 0.62, sz * 0.44, { rz: sx * 0.8, r: 0.03 });
    if (ctx.driftMat) drift(B, ctx, sx * px, -0.7, 0.9, 0.8, ctx.snow ? 0.5 : 0.3, 0);
  }
  for (const sz of [-1, 1]) B.box('rs_timber', px * 2 + 1.3, 0.42, 0.32, 0, beamY, sz * 0.44, { r: 0.06, rot: true, jit: 0.03 });
  // a little shingled roof over the arch
  for (const sz of [-1, 1]) B.box('rs_shingles', px * 2 + 1.9, 0.08, 0.82, 0, beamY + 0.42, sz * 0.32, { rx: sz * 0.48, faces: { ny: 'rs_planks_gray' }, r: 0.02 });
  B.box('rs_timber', px * 2 + 2.0, 0.12, 0.16, 0, beamY + 0.62, 0, { r: 0.03, rot: true });
  if (ctx.snow) for (const sz of [-1, 1]) {
    snowCap(B, px * 2 + 1.9, 0.8, 0, beamY + 0.46 - 0.0, sz * 0.32, { t: 0.16, rx: sz * 0.48 });
    icicles(B, -px - 0.9, sz * 0.7, px + 0.9, sz * 0.7, beamY + 0.24, rnd);
  }
  // the station's carved board, hung on chains facing the road both ways
  B.box('rs_timber', 3.6, 0.95, 0.1, 0, 4.4, -0.44, { r: 0.03, faces: { nz: { m: 'rs_ranger_board', fit: true }, pz: { m: 'rs_ranger_board', fit: true } } });
  for (const sx of [-1, 1]) B.cyl('rs_iron', 0.015, 0.015, 0.4, sx * 1.4, 5.05, -0.44, { seg: 4, caps: false });
  lantern(B, -px + 0.35, 4.5, -0.75, 0.15);
  lantern(B, px - 0.35, 4.5, -0.75, 0.15);
}

function buildGateBars(B, g, ctx) {
  B.frame(0, -g.hy, 0, 0);
  const rnd = rngOf(seedOf(g.x, g.z, 23));
  const hx = g.hx, H = g.hy * 2, hz = g.hz;
  const railY = [0.3, 1.55, H - 0.17];
  B.box('rs_timber', hx * 2, 0.3, hz * 2 - 0.02, 0, railY[0], 0, { r: 0.05, rot: true, off: [0.1, 0] });
  B.box('rs_timber', hx * 2, 0.24, hz * 2 - 0.06, 0, railY[1], 0, { r: 0.04, rot: true, off: [0.5, 0] });
  B.box('rs_timber', hx * 2, 0.34, hz * 2, 0, railY[2], 0, { r: 0.05, rot: true, off: [0.8, 0] });
  const n = 8, xs = [];
  for (let i = 0; i <= n; i++) xs.push(-hx + 0.2 + (hx * 2 - 0.4) * i / n);
  xs.forEach((x, i) => {
    const w = i === 0 || i === n ? 0.4 : 0.26;
    B.box('rs_timber', w, H - 0.15, hz * 2 - 0.02, x, (H - 0.15) / 2 + 0.15, 0, { r: 0.04, off: [i * 0.13, 0] });
    B.cyl('rs_iron', 0.12, 0.12, 0.1, x, 0.12, 0, { rx: Math.PI / 2, caps: 'rs_iron', seg: 10 });
    for (const yy of railY) for (const sz of [-1, 1]) B.box('rs_iron', 0.5, 0.26, 0.02, x, yy, sz * (hz + 0.01), { r: 0.005 });
  });
  // gray boards in the lower bays with a Z-brace, red-and-cream warning planks across the upper bays
  B.box('rs_planks_gray', hx * 2 - 0.3, 1.0, 0.1, 0, (0.45 + 1.43) / 2, 0, { rot: true, r: 0.01 });
  B.box('rs_warn', hx * 2 - 0.3, 1.2, 0.16, 0, (1.67 + 2.86) / 2, 0, { r: 0.01 });
  for (let i = 0; i < n; i++) {
    const x0 = xs[i] + 0.14, x1 = xs[i + 1] - 0.14, dx = x1 - x0, dy = 0.9, len = Math.hypot(dx, dy), a = Math.atan2(dy, dx) * (i % 2 ? -1 : 1);
    for (const sz of [-1, 1]) B.box('rs_timber', len, 0.16, 0.05, (x0 + x1) / 2, 0.94, sz * 0.07, { rz: a, rot: true, r: 0.015 });
  }
  for (let x = -hx + 0.25; x < hx; x += 0.55) B.cyl('rs_iron', 0, 0.05, 0.3, x, H + 0.13, 0, { seg: 5, caps: false });
  // the hasp and padlock at the closing end
  B.box('rs_iron', 0.32, 0.4, 0.06, -hx + 0.2, 1.55, -hz - 0.04, { r: 0.015 });
  B.box('rs_brass', 0.17, 0.2, 0.08, -hx + 0.2, 1.38, -hz - 0.1, { r: 0.03 });
  B.torus('rs_iron', 0.06, 0.018, -hx + 0.2, 1.5, -hz - 0.1, { seg: 10, tseg: 5 });
  if (ctx.snow) {
    snowCap(B, hx * 2, hz * 2, 0, H, 0, { t: 0.14 });
    for (const sz of [-1, 1]) { icicles(B, -hx, sz * (hz + 0.02), hx, sz * (hz + 0.02), H - 0.34, rnd, { max: 0.35 }); icicles(B, -hx, sz * (hz - 0.01), hx, sz * (hz - 0.01), 1.43, rnd, { max: 0.22 }); }
  }
}

function buildKeypad(B, s, u, ctx) {
  const gy = ctx.H(s.x, s.z);
  B.frame(s.x, gy, s.z, 0);
  const top = s.y + s.hy - gy, h = top + 0.55;
  B.box('rs_timber', s.hx * 2, h, s.hz * 2, 0, h / 2 - 0.12, 0, { r: 0.03 });
  B.box('rs_stone', 0.52, 0.3, 0.52, 0, 0.06, 0, { r: 0.07, jit: 0.04 });
  B.cyl('rs_iron', 0.02, 0.17, 0.12, 0, h - 0.05, 0, { seg: 4, ry: Math.PI / 4 });
  for (const yy of [0.5, top - 0.1]) B.box('rs_iron', s.hx * 2 + 0.04, 0.07, s.hz * 2 + 0.04, 0, yy, 0, { r: 0.01 });
  if (u) {
    const kx = u.x - s.x, ky = u.y - gy, kz = u.z - s.z;
    B.box('rs_brass', 0.38, 0.48, 0.1, kx, ky, kz + 0.03, { r: 0.02, faces: { nz: { m: 'rs_keypad', fit: true } } });
    B.box('rs_brass', 0.46, 0.04, 0.22, kx, ky + 0.29, kz - 0.01, { rx: -0.35, r: 0.01 });
    B.cyl('rs_brass', 0.022, 0.022, ky - 0.1, s.hx + 0.03, (ky - 0.1) / 2, 0, { seg: 5, caps: false });
    B.box('rs_brass', 0.06, 0.06, 0.06, s.hx + 0.03, ky - 0.1, 0);
  }
  if (ctx.snow) snowCap(B, 0.36, 0.36, 0, h - 0.12, 0, { t: 0.08 });
}

function buildAnchor(B, c, anchor, ctx) {
  const base = c.y - c.hh;
  B.frame(c.x, base, c.z, (seedOf(c.x, c.z) % 628) / 100);
  const rnd = rngOf(seedOf(c.x, c.z, 31));
  const H = c.hh * 2, r = c.r;
  B.cyl('rs_timber', r, r * 1.08, H + 0.45, 0, (H + 0.45) / 2 - 0.3, 0, { seg: 8, bevel: 0.03, caps: 'rs_logend', jit: 0.01 });
  B.cyl('rs_iron', 0.04, r + 0.045, 0.16, 0, H + 0.23, 0, { seg: 8 });
  for (const yy of [0.32, H - 0.3]) B.cyl('rs_iron', r + 0.02, r + 0.02, 0.09, 0, yy, 0, { seg: 8, caps: false });
  B.cyl('rs_warn', r + 0.008, r + 0.008, 0.36, 0, 0.72, 0, { seg: 8, caps: false });
  const ay = anchor ? anchor.y - base : H - 0.15;
  B.torus('rs_iron', r + 0.06, 0.045, 0, ay, 0, { rx: Math.PI / 2, seg: 12 });
  // the shackle ring, on the side facing the road
  const roadX = ctx.W.roadX ? ctx.W.roadX(c.z) : c.x;
  const dirW = Math.sign(roadX - c.x) || 1;
  const lp = B.loc({ x: c.x + dirW, y: base, z: c.z });
  const a = Math.atan2(lp.x, lp.z);
  B.push(M4(0, ay - 0.02, 0, 0, a, 0));
  B.torus('rs_iron', 0.11, 0.03, 0, -0.08, r + 0.13, { ry: Math.PI / 2, seg: 12 });
  B.pop();
  for (let k = 0; k < 4; k++) {
    const t = TAU * k / 4 + rnd(), rr = r + 0.18;
    B.ell('rs_stone', range(rnd, 0.14, 0.22), range(rnd, 0.1, 0.16), range(rnd, 0.14, 0.2), Math.cos(t) * rr, 0.02, Math.sin(t) * rr, { seg: 7, rings: 4, ry: rnd() * 3, jit: 0.04 });
  }
  if (ctx.snow) snowCap(B, r * 2 + 0.06, r * 2 + 0.06, 0, H + 0.3, 0, { t: 0.08 });
  if (ctx.driftMat) drift(B, ctx, -0.12, 0, 0.45, 0.4, 0.2, 0);
}

function buildLog(B, s, ctx) {
  const gy = ctx.H(s.x, s.z);
  B.frame(s.x, gy, s.z, s.ry || 0);
  const rnd = rngOf(seedOf(s.x, s.z, 41));
  const r = s.hy;
  B.cyl('rs_bark', r, r * 1.06, s.hx * 2, 0, r, 0, { rz: Math.PI / 2, seg: 10, caps: 'rs_logend', bevel: 0.025, jit: 0.015 });
  B.cyl('rs_bark', 0.035, 0.055, 0.22, range(rnd, -0.3, 0.3), r * 1.7, 0.05, { rz: -0.6, rx: 0.3, caps: 'rs_logend', seg: 6 });
  if (ctx.snow) snowCap(B, s.hx * 2 - 0.1, 0.16, 0, r * 2 - 0.03, 0, { t: 0.08 });
}

function buildParkedRV(B, s, ctx) {
  const base = s.y - s.hy;
  B.frame(s.x, base, s.z, s.ry || 0);
  const rnd = rngOf(seedOf(s.x, s.z, 51));
  const tint = tintOf(s.col || '#e0d6c8');
  const hx = s.hx, hz = s.hz, H = s.hy * 2, by = 0.55, bh = H - by - 0.05, top = by + bh;
  B.box('rs_rv', hx * 2, bh, hz * 2, 0, by + bh / 2, 0, { r: 0.2, fit: 'v', tint, faces: { py: { m: 'rs_tin', rot: true, tint: null }, ny: { m: 'rs_iron', tint: null } }, off: [rnd(), 0] });
  // windows, one boarded up; the door and its step
  for (const sx of [-1, 1]) {
    for (const [zc, w, boarded] of [[1.9, 1.3, false], [-0.4, 1.0, sx < 0 && rnd() < 0.7], [-2.6, 1.1, false]]) {
      B.box(boarded ? 'rs_boards' : 'rs_rv_window', 0.03, 0.72, w, sx * (hx + 0.005), 2.05, zc, { r: 0.01 });
    }
  }
  B.box('rs_rv', 0.04, 1.85, 0.74, hx + 0.012, by + 0.97, 0.75, { fit: 'v', tint: tint.map(v => v * 0.9), r: 0.01 });
  B.box('rs_rv_window', 0.03, 0.4, 0.44, hx + 0.03, 2.05, 0.75, { r: 0.01 });
  B.box('rs_brass', 0.04, 0.05, 0.14, hx + 0.04, 1.4, 0.48);
  B.box('rs_iron', 0.36, 0.06, 0.62, hx + 0.2, 0.36, 0.75, { r: 0.015 });
  // front: windshield, cab-over window, grille, lamps, bumpers; back: window, tail lamps, ladder
  B.box('rs_glass', hx * 2 - 0.42, 0.72, 0.04, 0, 1.9, hz + 0.005, { r: 0.01 });
  B.box('rs_rv_window', 1.2, 0.34, 0.03, 0, 2.62, hz + 0.005, { r: 0.01 });
  B.box('rs_grille', 1.1, 0.42, 0.05, 0, 1.0, hz + 0.01, { r: 0.01 });
  for (const sx of [-1, 1]) B.cyl('rs_brass', 0.14, 0.14, 0.1, sx * 0.85, 1.0, hz + 0.03, { rx: Math.PI / 2, caps: 'rs_headlamp*', seg: 10 });
  for (const sz of [-1, 1]) B.box('rs_iron', hx * 2 + 0.2, 0.24, 0.2, 0, 0.6, sz * (hz + 0.1), { r: 0.05 });
  B.box('rs_rv_window', 1.0, 0.55, 0.03, 0, 2.2, -hz - 0.005, { r: 0.01 });
  for (const sx of [-1, 1]) B.box('rs_headlamp*', 0.13, 0.22, 0.04, sx * 0.95, 1.1, -hz - 0.01, { tint: [1, 0.38, 0.3] });
  for (const sx of [-1, 1]) B.cyl('rs_iron', 0.022, 0.022, top - 0.55, sx * 0.25, (top + 0.55) / 2, -hz - 0.07, { seg: 5, caps: false });
  for (let y = 0.75; y < top; y += 0.32) B.cyl('rs_iron', 0.018, 0.018, 0.5, 0, y, -hz - 0.07, { rz: Math.PI / 2, seg: 4, caps: false });
  // wheels on soft tyres
  for (const zz of [hz - 1.3, -hz + 1.5]) for (const sx of [-1, 1]) { const flat = rnd() < 0.5; wheel(B, sx * (hx - 0.2), flat ? 0.33 : 0.4, zz, 0.44, 0.3, { flat, hub: 'rs_hub_cream' }); }
  // roof: a tin air-cooler box, a spare tyre, a crate
  B.box('rs_steel_cream', 0.8, 0.32, 0.75, 0.25, top + 0.15, -0.9, { r: 0.06 });
  B.cyl('rs_tire', 0.4, 0.4, 0.2, -0.4, top + 0.1, 1.7, { caps: 'rs_hub_cream', fit: true, uRep: 6, bevel: 0.05, seg: 14 });
  B.box('rs_crate_a', 0.5, 0.42, 0.5, 0.5, top + 0.2, 2.4, { r: 0.03, ry: 0.3 });
  if (ctx.snow) {
    snowCap(B, hx * 2 - 0.2, hz * 2 - 0.2, 0, top, 0, { t: 0.2 });
    for (const sx of [-1, 1]) icicles(B, sx * (hx + 0.02), -hz, sx * (hx + 0.02), hz, top - 0.15, rnd);
  }
  if (ctx.driftMat) { drift(B, ctx, -hx - 0.05, 0.5, 0.6, 3.2, ctx.snow ? 0.5 : 0.36, 0); drift(B, ctx, hx + 0.05, -2.2, 0.45, 1.3, 0.26, 0); }
}

// ---- assembly ----------------------------------------------------------------------------------------------

function makeCtx(W) {
  const biome = BIO[W.biome] ? W.biome : 'meadow';
  const bio = BIO[biome];
  return {
    W, biome, bio, H: (x, z) => W.heightAt(x, z), ao: bio.ao, aoH: 0.9,
    snow: biome === 'snow', driftMat: bio.drift, cover: bio.cover,
  };
}

const POI_BUILDERS = { semi: buildSemi, yard: buildYard, crash: buildCrash, junk: buildJunk, gas: buildGas, dino: buildDino };

export function buildRoadside(W) {
  const group = new THREE.Group();
  group.name = 'roadside';
  const gates = new Map();
  const clusters = [];
  const ctx = makeCtx(W);

  // the stops: statics grouped by stop, decor matched to the nearest stop
  const byPoi = new Map(), loose = [];
  for (const s of W.statics) {
    if (!isRoadside(s)) continue;
    if (s.poi !== undefined && s.bld === undefined && s.town === undefined) {
      if (!byPoi.has(s.poi)) byPoi.set(s.poi, []);
      byPoi.get(s.poi).push(s);
    } else loose.push(s);
  }
  const DECOR_KINDS = new Set(['canopy', 'umbrella', 'plane', 'wheels']);
  const decorFor = p => (W.decor || []).filter(d => DECOR_KINDS.has(d.k) && Math.hypot(d.x - p.x, d.z - p.z) < 16);
  for (const [id, parts] of byPoi) {
    const p = (W.pois || []).find(q => q.id === id) || { id, type: parts[0].poiType, x: parts[0].x, y: parts[0].y - parts[0].hy, z: parts[0].z, ry: 0 };
    const fn = POI_BUILDERS[p.type || parts[0].poiType];
    if (!fn) continue;
    if (p.y === undefined) p.y = W.heightAt(p.x, p.z);
    const B = new Builder(ctx);
    try { fn(B, p, parts, ctx, decorFor(p)); } catch (e) { console.warn('roadside: stop failed', p.type, e); }
    finish(B, ctx, group, clusters);
  }

  // gates (static arch + sliding barrier) and their keypads
  const keypadPosts = loose.filter(s => s.part === 'keypad_post');
  const usedPosts = new Set();
  for (const g of W.gates || []) {
    const S = new Builder(ctx);
    buildGateStatic(S, g, ctx);
    for (const s of keypadPosts) {
      if (Math.hypot(s.x - g.x, s.z - g.z) > 16) continue;
      usedPosts.add(s);
      const u = (W.uses || []).find(q => q.kind === 'keypad' && Math.hypot(q.x - s.x, q.z - s.z) < 0.8);
      buildKeypad(S, s, u, ctx);
    }
    finish(S, ctx, group, clusters);
    const gg = new THREE.Group();
    gg.position.set(g.x, g.y, g.z);
    const bars = new THREE.Group();
    gg.add(bars);
    group.add(gg);
    const Bb = new Builder(ctx);
    buildGateBars(Bb, g, ctx);
    finish(Bb, ctx, bars, clusters, { base: gg.position, bars });
    gates.set(g.id, { bars, open: 0, target: 0, hx: g.hx });
  }
  for (const s of keypadPosts) {
    if (usedPosts.has(s)) continue;
    const B = new Builder(ctx);
    const u = (W.uses || []).find(q => q.kind === 'keypad' && Math.hypot(q.x - s.x, q.z - s.z) < 0.8);
    buildKeypad(B, s, u, ctx);
    finish(B, ctx, group, clusters);
  }

  // winch anchor posts, grouped in pairs
  const posts = (W.cyls || []).filter(c => c.mat === 'post');
  const done = new Set();
  for (const c of posts) {
    if (done.has(c)) continue;
    const B = new Builder(ctx);
    for (const c2 of posts) {
      if (done.has(c2) || Math.hypot(c2.x - c.x, c2.z - c.z) > 14) continue;
      done.add(c2);
      const a = (W.anchors || []).reduce((best, q) => { const d = Math.hypot(q.x - c2.x, q.z - c2.z); return d < 0.6 && (!best || d < best.d) ? { q, d } : best; }, null);
      buildAnchor(B, c2, a?.q, ctx);
    }
    finish(B, ctx, group, clusters);
  }

  // the camp's log seats, the parked RVs in town
  const logs = loose.filter(s => s.part === 'log_seat');
  if (logs.length) { const B = new Builder(ctx); for (const s of logs) buildLog(B, s, ctx); finish(B, ctx, group, clusters); }
  const rvs = loose.filter(s => s.part === 'parked_rv');
  if (rvs.length) { const B = new Builder(ctx); for (const s of rvs) buildParkedRV(B, s, ctx); finish(B, ctx, group, clusters); }

  const _c = new V3();
  return {
    group, gates,
    update(dt, t, camPos) {
      for (const g of gates.values()) {
        g.open += (g.target - g.open) * Math.min(1, dt * 1.5);
        g.bars.position.x = g.open * g.hx * 1.9;
      }
      if (!camPos) return;
      for (const c of clusters) {
        _c.copy(c.center);
        if (c.track) { _c.add(c.track.base); _c.x += c.track.bars.position.x; }
        const d = _c.distanceTo(camPos) - c.radius;
        const near = d < c.lod;
        c.near.visible = near;
        c.far.visible = !near && d < 1000;
      }
    },
  };
}

// ---- previews (rs_*): one stop of each kind, lifted out of a generated leg --------------------------------------

function findLeg(pred) {
  for (const seed of [777, 1234, 99, 4242, 31337]) for (let d = 1; d <= 5; d++) {
    const W = generateLeg(seed, d);
    const hit = pred(W);
    if (hit) return { W, hit };
  }
  return null;
}
function previewWorld(W, biome, keep) {
  return { ...W, biome, statics: W.statics.filter(keep.statics || (() => false)), cyls: (W.cyls || []).filter(keep.cyls || (() => false)),
    gates: (W.gates || []).filter(keep.gates || (() => false)), uses: W.uses, anchors: W.anchors,
    decor: (W.decor || []).filter(keep.decor || (() => false)), pois: W.pois };
}
function previewStop(type) {
  return ({ biome = 'meadow' } = {}) => {
    const f = findLeg(W => W.pois.find(p => p.type === type));
    if (!f) return null;
    const { W, hit: p } = f;
    const W2 = previewWorld(W, biome, { statics: s => s.poi === p.id && isRoadside(s), decor: d => Math.hypot(d.x - p.x, d.z - p.z) < 16 });
    const r = buildRoadside(W2);
    r.group.position.set(-p.x, -(p.y ?? W.heightAt(p.x, p.z)), -p.z);
    const g = new THREE.Group(); g.add(r.group);
    return g;
  };
}
export const PREVIEW = {
  rs_semi: previewStop('semi'), rs_yard: previewStop('yard'), rs_crash: previewStop('crash'),
  rs_junk: previewStop('junk'), rs_gas: previewStop('gas'), rs_dino: previewStop('dino'),
  rs_gate: ({ biome = 'meadow' } = {}) => {
    const f = findLeg(W => W.gates[0]);
    if (!f) return null;
    const { W, hit: g } = f;
    const W2 = previewWorld(W, biome, { gates: q => q === g, statics: s => s.part === 'keypad_post' && Math.hypot(s.x - g.x, s.z - g.z) < 16 });
    const r = buildRoadside(W2);
    r.group.position.set(-g.x, -(g.y - g.hy), -g.z);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
  rs_anchor: ({ biome = 'meadow' } = {}) => {
    const f = findLeg(W => W.cyls.find(c => c.mat === 'post'));
    const { W, hit: c } = f;
    const W2 = previewWorld(W, biome, { cyls: q => q === c });
    const r = buildRoadside(W2);
    r.group.position.set(-c.x, -(c.y - c.hh), -c.z);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
  rs_logs: ({ biome = 'meadow' } = {}) => {
    const { W } = findLeg(W => true);
    const W2 = previewWorld(W, biome, { statics: s => s.part === 'log_seat' });
    const r = buildRoadside(W2);
    const fx = W.camp.fire.x, fz = W.camp.fire.z;
    r.group.position.set(-fx, -W.heightAt(fx, fz), -fz);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
  rs_parkedrv: ({ biome = 'meadow' } = {}) => {
    const { W } = findLeg(W => true);
    const s0 = W.statics.find(s => s.part === 'parked_rv');
    const W2 = previewWorld(W, biome, { statics: s => s === s0 });
    const r = buildRoadside(W2);
    r.group.position.set(-s0.x, -(s0.y - s0.hy), -s0.z);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
};
