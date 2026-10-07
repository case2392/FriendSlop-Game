// Roadside: everything along the road that isn't nature or a building. The
// stops' furniture (statics tagged s.poi: semi trailers, yard-sale tables, the
// crashed plane, junk piles, gas pumps and counter, the dino statue), the
// gas canopy, umbrella, plane and wheel decor, the ranger gates and keypads,
// the winch anchor posts, the camp's log seats and the parked RVs in town.
//
// The look is WoW Classic goblin/human junk: chunky shapes with smooth shading
// (bulged, bowed, dented, tapered: nothing is a perfect box), every surface
// painted (paint/roadside.js), AO and ground grime baked into vertex colours.
// Each biome has its own construction kit (timber and red shingles in Elwynn,
// gray barn wood and hay in Westfall, granite piers, slate and braziers in Dun
// Morogh, lashed logs, hides and bones in the Badlands, brass, canvas and adobe
// in Tanaris) plus its weather: snow caps, clustered icicles and drifts in the
// pass, red dust in the badlands, sand in the desert. A world-space top-cover
// shader lays that weather on up-facing surfaces, broken up by noise, and never
// on sheltered ones (inside the trailer, under the counter's roof).
//
// Geometry is generated into per-material buckets and merged: one mesh per
// (cluster, material), where a cluster is one stop / gate / anchor pair / camp /
// RV lot. Each cluster also has a one-draw-call far LOD (vertex colours = the
// painted texture's average, small trim left out). The crash smoke is one
// billboarded, GPU-animated draw call per wreck.
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
const lerp = (a, b, t) => a + (b - a) * t;
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new V3(), _s = new V3();
function M4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
}
function tintOf(hex, ref = '#e2d6bc') {
  const a = new THREE.Color(hex), b = new THREE.Color(ref);
  return [Math.min(1, a.r / b.r), Math.min(1, a.g / b.g), Math.min(1, a.b / b.b)];
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = a => Math.hypot(a[0], a[1], a[2]);
const sp = (c, e) => Math.sign(c) * Math.pow(Math.abs(c), 2 / e);   // superellipse power

// ---- textures & materials -------------------------------------------------------------------------

// meters per texture repeat (world-mapped UVs) and the textures that are fitted one-per-face
const DENS = {
  rs_tin: 2, rs_tin_red: 2, rs_planks: 1, rs_planks_gray: 1, rs_timber: 1.5, rs_iron: 0.5, rs_brass: 1, rs_scrap: 1.5, rs_stone: 1.6,
  rs_wing: 1.6, rs_gingham: 0.6, rs_bark: 1.2, rs_rv: 3, rs_snow: 2, rs_dust: 2, rs_sand: 2, rs_dirt: 2, rs_tire: 0.6,
  rs_fascia: 2, rs_shingles: 1.2, rs_slats: 2, rs_dino: 2.5, rs_canvas: 3, rs_canvas_blue: 3, rs_slate: 1.4, rs_hide: 1.6,
  rs_adobe: 2, rs_burlap: 0.9, rs_plaid: 0.9, rs_rope: 0.4, rs_rock: 1.4, rs_hay: 1, rs_bone: 0.6,
};
const FIT = new Set(['rs_blanket', 'rs_hub', 'rs_hub_cream', 'rs_glass', 'rs_grille', 'rs_crate_a', 'rs_crate_b', 'rs_crate_c', 'rs_barrel', 'rs_barrel_lid', 'rs_drum',
  'rs_drum_red', 'rs_drum_lid', 'rs_pump_face', 'rs_keypad', 'rs_logend', 'rs_rv_window', 'rs_boards', 'rs_headlamp', 'rs_ice', 'rs_decal_freight', 'rs_ranger_board',
  'rs_plaque', 'rs_roundel', 'rs_warn', 'rs_stop', 'rs_chevband', 'rs_pennant']);
// flags on a material name: ! no top cover, * glows, ~ double-sided, # alpha-tested decal (no shadow, no LOD)
const baseName = m => m.replace(/[!*~#]+$/, '');
const densOf = m => { const b = baseName(m); return b.startsWith('rs_steel_') ? 2 : (DENS[b] || 1); };
const NO_SHADOW = /^(rs_blanket|rs_glass|rs_headlamp|rs_keypad|rs_decal_freight|rs_ice|rs_logend|rs_hub|rs_hub_cream|rs_pump_face|rs_rv_window|rs_boards|rs_plaque|rs_roundel|rs_grille|rs_ranger_board|rs_barrel_lid|rs_drum_lid|rs_chevband|rs_rope|rs_bone|rs_pennant|rs_stop)$/;
// the most weather any one material takes (glass and wing fabric stay readable under the dust)
const COVER_CAP = { rs_wing: 0.35, rs_glass: 0.25, rs_rv_window: 0.25, rs_canvas: 0.5, rs_canvas_blue: 0.5, rs_hide: 0.6, rs_gingham: 0.6, rs_burlap: 0.6 };

// Per-biome: ground grime (vertex AO tint), drifts, the top cover, paint schemes and the construction kit.
//   cover: lo/hi = up-facing threshold, noise = how much the breakup alpha moves it, scale = world → cover uv,
//          amt = the most it covers, brk = how much the breakup noise thins it out, low = extra cover on low tops
const BIO = {
  meadow: { ao: [0.6, 0.6, 0.48], ground: 'rs_dirt!', drift: null, cover: null,
    semi: [['rs_steel_red', 'rs_steel_blue'], ['rs_steel_cream', 'rs_steel_green']], dino: [1, 1, 1],
    kit: 'timber', pump: 'rs_steel_red', canopy: 'rs_tin_red', cloth: 'rs_gingham~', umbrella: 'rs_canvas~', seat: 'log', bark: [1, 1, 1] },
  fields: { ao: [0.74, 0.66, 0.5], ground: 'rs_dirt!', drift: null, cover: { tex: 'rs_cover_sand', lo: 0.7, hi: 0.95, noise: 0.8, scale: 0.4, amt: 0.25, brk: 1, low: 0.2 },
    semi: [['rs_steel_red', 'rs_steel_mustard'], ['rs_steel_cream', 'rs_steel_green']], dino: [1, 0.97, 0.9],
    kit: 'barn', pump: 'rs_steel_green', canopy: 'rs_tin', cloth: 'rs_burlap~', umbrella: 'rs_canvas~', seat: 'hay', bark: [0.95, 0.92, 0.85] },
  snow: { ao: [0.68, 0.76, 0.92], ground: 'rs_snow!', drift: 'rs_snow!', cover: { tex: 'rs_cover_snow', lo: 0.42, hi: 0.66, noise: 1.0, scale: 0.45, amt: 1, brk: 0.25, low: 0 },
    semi: [['rs_steel_blue', 'rs_steel_red'], ['rs_steel_cream', 'rs_steel_teal']], dino: [0.92, 0.96, 1],
    kit: 'dwarf', pump: 'rs_steel_blue', canopy: 'rs_slate', cloth: 'rs_plaid~', umbrella: 'rs_canvas_blue~', seat: 'log', bark: [0.82, 0.82, 0.9] },
  badlands: { ao: [0.9, 0.56, 0.4], ground: 'rs_dust!', drift: 'rs_dust!', cover: { tex: 'rs_cover_dust', lo: 0.6, hi: 0.92, noise: 0.9, scale: 0.4, amt: 0.5, brk: 1, low: 0.45 },
    semi: [['rs_steel_mustard', 'rs_steel_teal'], ['rs_steel_cream', 'rs_steel_red']], dino: [1, 0.94, 0.86],
    kit: 'frontier', pump: 'rs_steel_mustard', canopy: 'rs_tin', cloth: 'rs_hide~', umbrella: 'rs_canvas~', seat: 'log', bark: [1.3, 1.18, 1.05] },
  desert: { ao: [0.98, 0.84, 0.6], ground: 'rs_sand!', drift: 'rs_sand!', cover: { tex: 'rs_cover_sand', lo: 0.6, hi: 0.92, noise: 0.9, scale: 0.35, amt: 0.5, brk: 1, low: 0.45 },
    semi: [['rs_steel_teal', 'rs_steel_red'], ['rs_steel_mustard', 'rs_steel_blue']], dino: [1, 0.96, 0.88],
    kit: 'goblin', pump: 'rs_steel_teal', canopy: 'rs_canvas_blue', cloth: 'rs_canvas_blue~', umbrella: 'rs_canvas~', seat: 'bench', bark: [1.1, 1.05, 0.95] },
};
// Ranger-gate / anchor / keypad construction per kit
const KIT = {
  timber: { wood: [1.08, 0.98, 0.86], band: 'rs_iron', post: 'log', bars: 'logs', roof: 'rs_shingles', roofTint: null, ridge: 'rs_timber', light: 'lantern', foot: 'rs_stone', extra: null },
  barn: { wood: [0.86, 0.86, 0.9], band: 'rs_iron', post: 'square', bars: 'boards', roof: 'rs_hay', roofRot: true, roofTint: [0.78, 0.7, 0.58], ridge: 'rs_timber', light: 'lantern', foot: 'rs_stone', extra: 'hay' },
  dwarf: { wood: [0.84, 0.82, 0.86], band: 'rs_iron', post: 'pier', bars: 'logs', roof: 'rs_slate', roofTint: null, ridge: 'rs_iron', light: 'brazier', foot: null, extra: null },
  frontier: { wood: [1.5, 1.28, 1.06], band: 'rs_rope', post: 'bundle', bars: 'stakes', roof: 'rs_tin', roofTint: [1.12, 0.86, 0.7], ridge: 'rs_timber', light: 'torch', foot: null, extra: 'bones' },
  goblin: { wood: [1.1, 0.98, 0.88], band: 'rs_brass', post: 'brass', bars: 'plates', roof: 'rs_canvas', roofTint: null, ridge: 'rs_brass', light: 'lantern', foot: 'rs_adobe', extra: null },
};
const STONE_TINT = { dwarf: [0.8, 0.88, 1.02] };

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
  if (flags.includes('#')) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4; }
  if (useCover) {
    const cap = COVER_CAP[base] ?? 1, amt = Math.min(C.amt, cap);
    m.onBeforeCompile = sh => {
      sh.uniforms.uCoverMap = { value: tex(C.tex) };
      sh.uniforms.uCover = { value: new THREE.Vector4(C.lo, C.hi, C.noise, C.scale) };
      sh.uniforms.uCover2 = { value: new THREE.Vector4(C.brk, C.low, amt, cap) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 rsx; varying vec3 vRsW; varying vec3 vRsN; varying vec2 vRsX;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vRsW = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vRsN = normalize(mat3(modelMatrix) * objectNormal);
          vRsX = rsx;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRsW; varying vec3 vRsN; varying vec2 vRsX; uniform sampler2D uCoverMap; uniform vec4 uCover; uniform vec4 uCover2;')
        .replace('#include <lights_lambert_fragment>', `{
          vec4 cv = texture2D(uCoverMap, vRsW.xz * uCover.w);
          float up = normalize(vRsN).y;
          float k = smoothstep(uCover.x, uCover.y, up + (cv.a - 0.6) * uCover.z);
          k *= mix(1.0, smoothstep(0.35, 0.75, cv.a), uCover2.x);
          k *= min(uCover2.w, uCover2.z + uCover2.y * (1.0 - smoothstep(0.4, 1.6, vRsX.x)));
          k *= vRsX.y;
          diffuseColor.rgb = mix(diffuseColor.rgb, cv.rgb, k);
        }
        #include <lights_lambert_fragment>`);
    };
    m.customProgramCacheKey = () => 'rs-cover2';
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
    this.lod0 = false;      // while set, everything emitted is near-only (left out of the far LOD)
    this.shelter = false;   // while set, everything emitted is sheltered from the weather cover
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
    if (!b) { b = { mat, p: [], n: [], uv: [], c: [], x: [], f: [] }; this.buckets.set(mat, b); }
    return b;
  }
  // T: flat triangle soup [{p:[x,y,z], n:[x,y,z], uv:[u,v]} * 3k] in shape space; M: shape → frame-local
  emit(mat, T, M, o = {}) {
    if (!T.length) return;
    const B = this.bucket(mat);
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const ao = this.ctx.ao, aoH = this.ctx.aoH, tint = o.tint;
    const near = o.lod0 || this.lod0 ? 1 : 0, expo = o.shelter || this.shelter ? 0 : 1;
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
        B.p.push(pw.x, pw.y, pw.z); B.n.push(nw.x, nw.y, nw.z); B.uv.push(uv[0], uv[1]); B.c.push(r, g, bl); B.x.push(pl.y, expo);
      }
      B.f.push(near);
    }
  }
  place(x, y, z, o) { return this.M.clone().multiply(M4(x, y, z, o.rx || 0, o.ry || 0, o.rz || 0, ...(o.s || [1, 1, 1]))); }

  // A chamfered box (rounded edges), UVs per face: world-mapped (o.S meters per repeat) or fitted
  // (fit: true | 'u' | 'v'; uvRect [u0, v0, u1, v1] picks part of a fitted image). o.faces: { px: 'mat' |
  // { m, fit, rot, S, tint, skip, uvRect } }. o.taper scales the top in x/z; o.deform(p) bends the shape
  // (o.div subdivides it so the bend shows; o.smoothN re-derives the face normals from the bent shape);
  // o.jit roughens it.
  box(mat, w, h, d, x, y, z, o = {}) {
    const E = [w / 2, h / 2, d / 2];
    const r = Math.min(o.r ?? 0.02, E[0] * 0.45, E[1] * 0.45, E[2] * 0.45);
    const div = o.div || [1, 1, 1];
    const spec = k => { const f = o.faces?.[k]; if (!f) return { m: mat }; return typeof f === 'string' ? { m: f } : { m: f.m || mat, ...f }; };
    const specs = FACES.map(([k]) => spec(k));
    const off = o.off || [0, 0];
    const uvOf = (fi, p) => {
      const [, , u, v] = FACES[fi], sp2 = specs[fi];
      const ua = axisOf(u), va = axisOf(v);
      const U = p[0] * u[0] + p[1] * u[1] + p[2] * u[2], W = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
      const fit = sp2.fit ?? o.fit ?? FIT.has(baseName(sp2.m));
      const S = sp2.S ?? o.S ?? densOf(sp2.m);
      const rot = sp2.rot ?? o.rot;
      const fitU = fit === true || fit === (rot ? 'v' : 'u'), fitV = fit === true || fit === (rot ? 'u' : 'v');
      let uu = fitU ? (U + E[ua]) / (2 * E[ua]) : U / S + off[0];
      let vv = fitV ? (W + E[va]) / (2 * E[va]) : W / S + off[1];
      const R = sp2.uvRect ?? o.uvRect;
      if (R && fitU) uu = R[0] + uu * (R[2] - R[0]);
      if (R && fitV) vv = R[1] + vv * (R[3] - R[1]);
      if (rot) [uu, vv] = [vv, -uu];
      return [uu, vv];
    };
    const tl = o.taper ?? 1;
    const bent = q => {
      const p = [q[0], q[1], q[2]];
      if (tl !== 1) { const k = 1 + (tl - 1) * (p[1] + E[1]) / (2 * E[1]); p[0] *= k; p[2] *= k; }
      if (o.deform) o.deform(p);
      return p;
    };
    const shape = q => {
      const p = bent(q);
      if (o.jit) { const j = o.jit; p[0] += (hash3(q[0], q[1], q[2]) - 0.5) * j; p[1] += (hash3(q[1], q[2], q[0]) - 0.5) * j; p[2] += (hash3(q[2], q[0], q[1]) - 0.5) * j; }
      return p;
    };
    const smoothN = !!o.smoothN && (!!o.deform || tl !== 1);
    const faceN = (fi, q, n) => {
      const [, , u, v] = FACES[fi], e = 2e-3;
      const at = (a, s) => bent([q[0] + a[0] * s, q[1] + a[1] * s, q[2] + a[2] * s]);
      let nn = cross3(sub3(at(u, e), at(u, -e)), sub3(at(v, e), at(v, -e)));
      const l = len3(nn);
      if (l < 1e-12) return n;
      if (nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] < 0) nn = nn.map(c => -c);
      return nn.map(c => c / l);
    };
    const out = new Map();
    const put = (fi, pts, nrm, main) => {
      const sp2 = specs[fi];
      if (sp2.skip) return;
      let T = out.get(sp2.m); if (!T) { T = []; out.set(sp2.m, T); }
      const tint = sp2.tint;
      for (let i = 0; i < 3; i++) T.push({ p: shape(pts[i]), n: main && smoothN ? faceN(fi, pts[i], nrm[i]) : nrm[i], uv: uvOf(fi, pts[i]), tint });
    };
    const quad = (fi, a, b, c, dd, na, nb, nc, nd, main) => { put(fi, [a, b, c], [na, nb, nc], main); put(fi, [a, c, dd], [na, nc, nd], main); };
    FACES.forEach(([, n, u, v], fi) => {
      const na = axisOf(n), ua = axisOf(u), va = axisOf(v), nu = div[ua], nv = div[va];
      const P = (su, sv) => { const p = [0, 0, 0]; p[na] = n[na] * E[na]; p[ua] = su * (E[ua] - r); p[va] = sv * (E[va] - r); return p; };
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const s0 = -1 + 2 * i / nu, s1 = -1 + 2 * (i + 1) / nu, t0 = -1 + 2 * j / nv, t1 = -1 + 2 * (j + 1) / nv;
        quad(fi, P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1), n, n, n, n, true);
      }
    });
    if (r > 1e-4) {
      for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
        const nA = FACES[a][1], nB = FACES[b][1], aA = axisOf(nA), aB = axisOf(nB);
        if (aA === aB) continue;
        const k = 3 - aA - aB, nk = div[k];
        const owner = aA === 1 ? b : a;
        const PA = t => { const p = [0, 0, 0]; p[aA] = nA[aA] * E[aA]; p[aB] = nB[aB] * (E[aB] - r); p[k] = t * (E[k] - r); return p; };
        const PB = t => { const p = [0, 0, 0]; p[aA] = nA[aA] * (E[aA] - r); p[aB] = nB[aB] * E[aB]; p[k] = t * (E[k] - r); return p; };
        for (let s = 0; s < nk; s++) {
          const t0 = -1 + 2 * s / nk, t1 = -1 + 2 * (s + 1) / nk;
          quad(owner, PA(t0), PA(t1), PB(t1), PB(t0), nA, nA, nB, nB, false);
        }
      }
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const pX = [sx * E[0], sy * (E[1] - r), sz * (E[2] - r)], pY = [sx * (E[0] - r), sy * E[1], sz * (E[2] - r)], pZ = [sx * (E[0] - r), sy * (E[1] - r), sz * E[2]];
        put(sx > 0 ? 0 : 1, [pX, pY, pZ], [[sx, 0, 0], [0, sy, 0], [0, 0, sz]], false);
      }
    }
    const M = this.place(x, y, z, o);
    const small = 2 * (w * h + h * d + w * d) < 0.25;
    for (const [m, T] of out) this.emit(m, T, M, small && o.lod0 === undefined ? { ...o, lod0: true } : o);
  }

  // A cylinder along y (rt top, rb bottom), optional bevelled rims and caps. u wraps around
  // (fit: uRep repeats; else world), v runs along y. o.arc = [start, length] for partial shells.
  cyl(mat, rt, rb, h, x, y, z, o = {}) {
    const seg = o.seg || 10, [a0, al] = o.arc || [0, TAU], full = al >= TAU - 1e-6;
    const fit = o.fit ?? FIT.has(baseName(mat)), S = o.S ?? densOf(mat), uRep = o.uRep || 1, off = o.off || [0, 0];
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
      const u = fit ? uRep * j / seg : (j / seg) * circ / S + off[0];
      const v = fit ? (yy + h / 2) / h : (yy + h / 2) / S + off[1];
      return { p: [rr * sx, yy, rr * cz], n: [n[0] / l, n[1] / l, n[2] / l], uv: [u, v] };
    };
    for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < seg; j++) {
      const A = vert(rings[i], j), Bv = vert(rings[i], j + 1), C = vert(rings[i + 1], j + 1), D = vert(rings[i + 1], j);
      T.push(A, Bv, C, A, C, D);
    }
    const M = this.place(x, y, z, o);
    const small = Math.max(rt, rb) < 0.1 && TAU * Math.max(rt, rb) * h < 0.25;
    const eo = small && o.lod0 === undefined ? { ...o, lod0: true } : o;
    this.emit(mat, T, M, eo);
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
      this.emit(capMat, C, M, eo);
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
      if (prof[i][0] > 1e-5) T.push(A, Bv, C);
      if (prof[i + 1][0] > 1e-5) T.push(A, C, D);
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
  // a tube through points (V3) with per-point radii; o.capEnd closes the last end with a point,
  // o.ends (material or true) closes both ends flat (fitted discs: log ends)
  tube(mat, pts, radii, o = {}) {
    const seg = o.seg || 8, fit = o.fit ?? false, S = o.S ?? densOf(mat), off = o.off || [0, 0];
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
      return { p: [p.x, p.y, p.z], n: [dir.x, dir.y, dir.z], uv: [(fit ? j / seg : (j / seg) * TAU * avgR / S) + off[0], len[i] / S + off[1]] };
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
    const small = Math.max(rad(0), rad(n - 1)) < 0.03;
    const eo = small && o.lod0 === undefined ? { ...o, lod0: true } : o;
    this.emit(mat, T, this.M.clone(), eo);
    if (o.ends) {
      const C = [];
      for (const [i, sg] of [[0, -1], [n - 1, 1]]) {
        const c = pts[i], t = tans[i], nn = [t.x * sg, t.y * sg, t.z * sg];
        const ctr = { p: [c.x, c.y, c.z], n: nn, uv: [0.5, 0.5] };
        for (let j = 0; j < seg; j++) {
          const a = vert(i, j), b = vert(i, j + 1);
          C.push(ctr, { p: a.p, n: nn, uv: [0.5 + 0.5 * Math.cos(TAU * j / seg), 0.5 + 0.5 * Math.sin(TAU * j / seg)] },
            { p: b.p, n: nn, uv: [0.5 + 0.5 * Math.cos(TAU * (j + 1) / seg), 0.5 + 0.5 * Math.sin(TAU * (j + 1) / seg)] });
        }
      }
      this.emit(o.ends === true ? mat : o.ends, C, this.M.clone(), eo);
    }
  }
  // a torus (ring) in the shape's xy-plane
  torus(mat, R, r, x, y, z, o = {}) {
    const g = new THREE.TorusGeometry(R, r, o.tseg || 6, o.seg || 14);
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, idx = g.index.array;
    const T = [];
    for (let i = 0; i < idx.length; i++) { const k = idx[i]; T.push({ p: [pos.getX(k), pos.getY(k), pos.getZ(k)], n: [nor.getX(k), nor.getY(k), nor.getZ(k)], uv: [uv.getX(k) * (o.uRep || 4), uv.getY(k)] }); }
    g.dispose();
    const small = R * r * 40 < 0.25;
    this.emit(mat, T, this.place(x, y, z, o), small && o.lod0 === undefined ? { ...o, lod0: true } : o);
  }
  // A parametric surface: fn(u, v) → [x, y, z] in the current space for u, v in [0, 1]; normals come from
  // the surface itself (outward for a u-around / v-up parametrisation; o.flip turns them over).
  grid(mat, nu, nv, fn, o = {}) {
    const P = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) P.push(fn(i / nu, j / nv));
    const at = (i, j) => {
      i = o.wrapU ? ((i % nu) + nu) % nu : Math.max(0, Math.min(nu, i));
      j = Math.max(0, Math.min(nv, j));
      return P[j * (nu + 1) + i];
    };
    const N = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      let n = cross3(sub3(at(i + 1, j), at(i - 1, j)), sub3(at(i, j + 1), at(i, j - 1)));
      let l = len3(n);
      if (l < 1e-10) { n = [0, j < nv / 2 ? -1 : 1, 0]; l = 1; }
      n = n.map(c => (o.flip ? -c : c) / l);
      N.push(n);
    }
    const vt = (i, j) => { const k = j * (nu + 1) + i; return { p: P[k], n: N[k], uv: o.uv ? o.uv(i / nu, j / nv, P[k]) : [i / nu * (o.uR || 1), j / nv * (o.vR || 1)] }; };
    const T = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) T.push(vt(i, j), vt(i + 1, j), vt(i + 1, j + 1), vt(i, j), vt(i + 1, j + 1), vt(i, j + 1));
    this.emit(mat, T, this.M.clone(), o);
  }
  // a cloth sheet lying on the ground (rugs): a grid draped over the terrain, fitted UVs
  sheet(mat, w, d, x, z, o = {}) {
    const nx = o.nx || 6, nz = o.nz || 4, ry = o.ry || 0, c = Math.cos(ry), sn = Math.sin(ry), lift = o.lift ?? 0.03;
    const P = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / nz, lx = (u - 0.5) * w, lz = (v - 0.5) * d;
      const px = x + lx * c + lz * sn, pz = z - lx * sn + lz * c;
      const wob = Math.sin(i * 2.1 + j * 1.3) * 0.012;
      P.push({ p: [px, this.ground(px, pz) + lift + wob, pz], n: [0, 1, 0], uv: [u, v] });
    }
    const T = [], at = (i, j) => P[j * (nx + 1) + i];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) T.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    this.emit(mat, T, new THREE.Matrix4(), { noAO: true, ...o });
  }
  // a flat quad facing +z (decals, roundels, pennants)
  quad(mat, w, h, x, y, z, o = {}) {
    const R = o.uvRect || [0, 0, 1, 1];
    const a = { p: [-w / 2, -h / 2, 0], n: [0, 0, 1], uv: [R[0], R[1]] }, b = { p: [w / 2, -h / 2, 0], n: [0, 0, 1], uv: [R[2], R[1]] };
    const c = { p: [w / 2, h / 2, 0], n: [0, 0, 1], uv: [R[2], R[3]] }, d = { p: [-w / 2, h / 2, 0], n: [0, 0, 1], uv: [R[0], R[3]] };
    this.emit(mat, [a, b, c, a, c, d], this.place(x, y, z, o), { noAO: true, lod0: true, ...o });
  }
}

// ---- clusters: merged meshes + a far LOD ---------------------------------------------------------------

const triArea = (P, i) => { const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2], vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2]; return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2; };
function finish(B, ctx, parent, clusters, track = null) {
  if (!B.buckets.size) return;
  const near = new THREE.Group();
  const fp = [], fn = [], fc = [];
  const box = new THREE.Box3(), tmp = new V3();
  const cov = ctx.cover ? avgLin(ctx.cover.tex) : null;
  const area = b => { let a = 0; for (let i = 0; i < b.p.length; i += 9) a += triArea(b.p, i); return a; };
  const areas = new Map([...B.buckets.values()].map(b => [b, area(b)]));
  const total = [...areas.values()].reduce((s, a) => s + a, 0) || 1;
  // only the few materials that carry most of the surface cast shadows: the trim adds nothing
  // to the shadow's shape but would cost a shadow-pass draw call each
  const ranked = [...B.buckets.values()].filter(b => !NO_SHADOW.test(baseName(b.mat)) && !/[#!]/.test(b.mat.slice(baseName(b.mat).length))).map(b => [b, areas.get(b)]).sort((a, b) => b[1] - a[1]);
  const cTotal = ranked.reduce((s, [, a]) => s + a, 0);
  const casters = new Set(ranked.filter(([, a], i) => i < 3 || a > cTotal * 0.2).map(([b]) => b));
  for (const b of B.buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
    g.setAttribute('rsx', new THREE.Float32BufferAttribute(b.x, 2));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, rsMat(b.mat, ctx));
    const base = baseName(b.mat), flags = b.mat.slice(base.length);
    m.castShadow = casters.has(b);
    m.receiveShadow = true;
    m.name = 'rs:' + b.mat;
    near.add(m);
    for (let i = 0; i < b.p.length; i += 3) box.expandByPoint(tmp.set(b.p[i], b.p[i + 1], b.p[i + 2]));
    // the far LOD leaves out decals, near-only trim and materials that cover almost nothing
    if (flags.includes('#') || areas.get(b) < total * 0.015) continue;
    const a = avgLin(base), glow = flags.includes('*') ? 1.6 : 1;
    const useCov = cov && !/[!*#]/.test(flags), camt = useCov ? Math.min(ctx.cover.amt, COVER_CAP[base] ?? 1) * 0.75 : 0;
    for (let t = 0; t < b.f.length; t++) {
      if (b.f[t]) continue;
      for (let k = 0; k < 3; k++) {
        const i = (t * 3 + k) * 3, xi = (t * 3 + k) * 2;
        fp.push(b.p[i], b.p[i + 1], b.p[i + 2]); fn.push(b.n[i], b.n[i + 1], b.n[i + 2]);
        let r = a[0] * glow, g2 = a[1] * glow, bl = a[2] * glow;
        if (useCov) { const kk = smooth(ctx.cover.lo, ctx.cover.hi, b.n[i + 1]) * camt * b.x[xi + 1]; r += (cov[0] - r) * kk; g2 += (cov[1] - g2) * kk; bl += (cov[2] - bl) * kk; }
        fc.push(r * b.c[i], g2 * b.c[i + 1], bl * b.c[i + 2]);
      }
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
  B.cyl('rs_tire', r, r, w, 0, 0, 0, { rz: Math.PI / 2, s: [squash, 1, 1], seg: 16, caps: o.hub || 'rs_hub', bevel: w * 0.28, fit: true, uRep: Math.max(4, Math.round(r * 9)), lod0: false });
  B.pop();
}
// a wooden barrel (bulged staves, lids) or a steel drum, standing along local y
function barrel(B, kind, r, h, x, y, z, o = {}) {
  const seg = r > 0.2 ? 14 : 10;
  if (kind === 'rs_barrel') {
    const pr = [[r * 0.84, -h / 2], [r * 0.95, -h / 4], [r, 0], [r * 0.95, h / 4], [r * 0.84, h / 2]];
    B.lathe('rs_barrel', pr, x, y, z, { ...o, seg, caps: 'rs_barrel_lid' });
  } else {
    B.cyl(kind, r, r, h, x, y, z, { ...o, seg, caps: 'rs_drum_lid', bevel: 0.03 });
  }
}
// A snow cap: a lumpy slab, wider than what it sits on, its rim hanging a few centimetres over the eave.
// o.dy(lx, lz) bends it to follow a bowed roof.
function snowCap(B, w, d, x, y, z, o = {}) {
  const t = o.t ?? 0.14, lip = o.lip ?? 0.07, ext = o.ext ?? 0.06;
  const W = w + ext * 2, D = d + ext * 2, H = t + lip;
  const nx = Math.max(1, Math.min(10, Math.round(W / 0.5))), nz = Math.max(1, Math.min(10, Math.round(D / 0.5)));
  const ph = x * 3.1 + z * 1.7;
  B.box('rs_snow!', W, H, D, x, y + H / 2 - lip, z, {
    r: Math.min(t * 0.48 + lip * 0.4, 0.12), rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0, S: 2, noAO: true, div: [nx, 1, nz], smoothN: true, lod0: o.lod0,
    deform: p => {
      if (p[1] > 0) p[1] += (Math.sin(p[0] * 2.3 + ph) * 0.5 + Math.sin(p[2] * 3.1 + p[0] * 1.3 + ph) * 0.5) * t * 0.3;
      if (o.dy) p[1] += o.dy(p[0], p[2]);
    },
  });
}
// Icicles in clusters of 3-6 (the long one in the middle), with gaps between clusters. o.skip(x, z) keeps
// them off something (the trailer's lettering).
function icicles(B, ax, az, bx, bz, y, rnd, o = {}) {
  const L = Math.hypot(bx - ax, bz - az), max = o.max ?? 0.3;
  let t = range(rnd, 0.1, 0.9);
  while (t < L - 0.1) {
    const n = 3 + Math.floor(rnd() * 4), mid = (n - 1) / 2, sp2 = range(rnd, 0.06, 0.1);
    for (let i = 0; i < n && t < L - 0.05; i++) {
      const k = t / L, px = ax + (bx - ax) * k, pz = az + (bz - az) * k;
      if (!o.skip || !o.skip(px, pz)) {
        const len = max * (0.3 + 0.7 * (1 - Math.abs(i - mid) / (mid + 1))) * range(rnd, 0.8, 1.05), r = range(rnd, 0.022, 0.034) * (0.7 + 0.5 * len / max);
        B.cyl('rs_ice!', r, 0, len, px, y - len / 2, pz, { seg: 5, caps: false, fit: true, noAO: true, lod0: true });
      }
      t += sp2;
    }
    t += range(rnd, 0.6, 1.5);
  }
}
// A drift banked against something. Sits on the lowest ground under it; skipped on steep slopes.
function drift(B, ctx, x, z, rx, rz, h, ry = 0) {
  if (!ctx.driftMat) return;
  const c = Math.cos(ry), s = Math.sin(ry);
  const gs = [[0, 0], [rx, 0], [-rx, 0], [0, rz], [0, -rz]].map(([a, b]) => B.ground(x + a * c + b * s, z - a * s + b * c));
  const lo = Math.min(...gs), hi = Math.max(...gs);
  if (hi - lo > h * 1.2) return;
  B.mound(ctx.driftMat, rx, h, rz, x, lo - 0.05, z, { ry, jit: Math.min(0.12, h * 0.3), rings: 4 });
}
function lantern(B, x, y, z, chain = 0.4, metal = 'rs_iron') {
  B.lod0 = true;
  B.cyl('rs_iron', 0.015, 0.015, chain, x, y + 0.2 + chain / 2, z, { seg: 4, caps: false });
  B.cyl(metal, 0.02, 0.15, 0.12, x, y + 0.22, z, { seg: 6, caps: metal });
  B.box('rs_headlamp*', 0.17, 0.24, 0.17, x, y, z, { r: 0.01, fit: true });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.box(metal, 0.03, 0.3, 0.03, x + sx * 0.09, y, z + sz * 0.09, { r: 0.005 });
  B.box(metal, 0.22, 0.04, 0.22, x, y - 0.15, z, { r: 0.01 });
  B.lod0 = false;
}
// an iron brazier on a bracket: a bowl of glowing coals
function brazier(B, x, y, z, legs = true) {
  B.lathe('rs_iron', [[0.12, -0.12], [0.24, -0.04], [0.3, 0.1], [0.27, 0.12]], x, y, z, { seg: 10 });
  B.ell('rs_headlamp*', 0.25, 0.08, 0.25, x, y + 0.08, z, { seg: 10, rings: 4, lod0: true });
  if (legs) for (let k = 0; k < 3; k++) { const a = TAU * k / 3; B.tube('rs_iron', [V(x + Math.sin(a) * 0.14, y - 0.08, z + Math.cos(a) * 0.14), V(x + Math.sin(a) * 0.3, y - 0.7, z + Math.cos(a) * 0.3)], 0.025, { seg: 4 }); }
}
// a pitch torch on a post
function torch(B, x, y, z) {
  B.cyl('rs_timber', 0.035, 0.045, 0.6, x, y, z, { seg: 6, caps: false, lod0: true });
  B.cyl('rs_rope', 0.06, 0.06, 0.12, x, y + 0.26, z, { seg: 6, caps: 'rs_rope', lod0: true });
  B.ell('rs_headlamp*', 0.08, 0.16, 0.08, x, y + 0.42, z, { seg: 8, rings: 5, lod0: true });
}
// a hay bale (Westfall), with twine
function haybale(B, x, y, z, w, h, d, o = {}) {
  B.box('rs_hay', w, h, d, x, y + h / 2, z, { r: Math.min(0.1, h * 0.3), jit: 0.04, ry: o.ry || 0, div: [3, 2, 2] });
  B.push(M4(x, y + h / 2, z, 0, o.ry || 0, 0));
  for (const k of [-0.28, 0.28]) B.box('rs_rope', 0.03, h + 0.01, d + 0.01, k * w, 0, 0, { r: 0.01, lod0: true });
  B.pop();
}
// a bull skull (Badlands posts)
function skull(B, x, y, z, ry = 0, s = 1) {
  B.push(M4(x, y, z, 0, ry, 0, s));
  B.ell('rs_bone', 0.12, 0.1, 0.14, 0, 0, 0, { seg: 8, rings: 5 });
  B.box('rs_bone', 0.11, 0.09, 0.2, 0, -0.04, 0.14, { r: 0.04, taper: 0.8 });
  for (const sx of [-1, 1]) B.tube('rs_bone', [V(sx * 0.08, 0.03, 0), V(sx * 0.22, 0.06, -0.02), V(sx * 0.3, 0.16, 0.02), V(sx * 0.31, 0.26, 0.05)], [0.04, 0.035, 0.025, 0.01], { seg: 6, capEnd: true, lod0: false });
  B.pop();
}
// rope lashing round a post
function lashing(B, x, y, z, r, n = 3) {
  for (let k = 0; k < n; k++) B.torus('rs_rope', r + 0.02, 0.022, x, y + k * 0.05, z, { rx: Math.PI / 2, seg: 10, tseg: 4, uRep: 6, lod0: true });
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
  const zr = fl ? fl.z - fl.hz : -6, zf = fl ? fl.z + fl.hz : 6, hw = fl ? fl.hx : 1.3, cxT = fl ? fl.x : 0;
  const fb = fl ? fl.y - fl.hy : 0.63;
  // the roof bows up in the middle and sags at the rear; ribs are jittered; the lettering's panel stays flat
  const bow = zz => 0.08 * Math.sin(Math.PI * clamp01((zz - zr) / (zf - zr))) - 0.05 * smooth(zr + 3, zr, zz);
  const decZ0 = (fl ? fl.z : 0) - 2.75, decZ1 = (fl ? fl.z : 0) + 2.35;
  const ribs = [zr + 0.3];
  { const n = 8, ws = []; for (let i = 0; i < n; i++) ws.push(range(rnd, 0.8, 1.2)); const k = (zf - zr - 0.6) / ws.reduce((a, b) => a + b, 0); for (const w of ws) ribs.push(ribs[ribs.length - 1] + w * k); }
  const kept = ribs.filter(zz => zz < decZ0 - 0.1 || zz > decZ1 + 0.1);
  const bays = [];
  for (let i = 0; i < kept.length - 1; i++) { const a = kept[i], b = kept[i + 1], dec = a < decZ1 && b > decZ0; bays.push([a, b, dec ? -0.012 : (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.03, 0.05)]); }
  const dentAt = (zz, yN) => { for (const [a, b, A] of bays) if (zz >= a && zz <= b) return A * Math.sin(Math.PI * (zz - a) / (b - a)) * Math.sin(Math.PI * clamp01(yN)); return 0; };
  if (fl) {
    // the floor: the open rear catches a little weather, the rest is under the roof
    const rear = 1.4;
    for (const [z0, z1, shelter] of [[zr, zr + rear, false], [zr + rear, zf, true]]) {
      const cz = (z0 + z1) / 2;
      B.box('rs_iron', hw * 2, fl.hy * 2, z1 - z0, cxT, fl.y, cz, { r: 0.03, shelter, off: [0, -cz / 2], faces: { py: { m: 'rs_slats', rot: true } } });
    }
    for (const sx of [-1, 1]) B.box('rs_iron', 0.16, 0.22, zf - zr - 0.4, cxT + sx * 0.55, fb - 0.11, (zr + zf) / 2, { r: 0.03 });
    for (let cz0 = zr + 0.7; cz0 < zf - 0.5; cz0 += range(rnd, 1.6, 2.8)) B.box('rs_iron', 1.3, 0.09, 0.11, cxT, fb - 0.07, cz0, { r: 0.02 });
    // rear bumper bar on hangers, tail lamps
    B.box('rs_iron', 2.3, 0.14, 0.16, cxT, 0.4, zr - 0.04, { r: 0.04 });
    for (const sx of [-1, 1]) B.box('rs_iron', 0.09, 0.3, 0.09, cxT + sx * 0.8, 0.55, zr + 0.02);
    for (const sx of [-1, 1]) B.cyl('rs_brass', 0.09, 0.09, 0.08, cxT + sx * (hw - 0.25), fb + 0.1, zr - 0.03, { rx: -Math.PI / 2, caps: 'rs_headlamp*', seg: 10 });
    // tandem wheels on big soft tyres, sunk in the dirt, mud flaps behind them
    for (const wz of [zr + 1.5, zr + 2.62]) {
      B.cyl('rs_iron', 0.06, 0.06, 2.3, cxT, 0.22, wz, { rz: Math.PI / 2, caps: false, seg: 6 });
      for (const sx of [-1, 1]) {
        B.box('rs_iron', 0.1, fb - 0.2, 0.16, cxT + sx * 0.55, (fb + 0.2) / 2, wz, { r: 0.02 });
        const flat = rnd() < 0.35; wheel(B, cxT + sx * (hw - 0.22), flat ? 0.15 : 0.21, wz, 0.5, 0.34, { flat });
      }
    }
    for (const sx of [-1, 1]) B.box('rs_iron', 0.5, 0.5, 0.03, cxT + sx * (hw - 0.22), 0.38, zr + 0.82, { r: 0.012, tint: [0.62, 0.56, 0.56], rx: 0.1, lod0: false });
    // landing gear: two jack legs with sand shoes, a cross brace, the crank
    const lz = zf - 1.4;
    for (const sx of [-1, 1]) {
      const lx = cxT + sx * 0.82, gy = B.ground(lx, lz), len = fb - gy;
      B.box('rs_iron', 0.14, len * 0.6, 0.14, lx, fb - len * 0.3, lz, { r: 0.025 });
      B.box('rs_iron', 0.1, len * 0.5, 0.1, lx, gy + len * 0.25, lz, { r: 0.02 });
      B.box('rs_iron', 0.34, 0.06, 0.4, lx, gy + 0.03, lz, { r: 0.02 });
      B.tube('rs_iron', [V(lx, fb - len * 0.45, lz), V(lx, fb - 0.05, lz - 0.7)], 0.03, { seg: 5 });
    }
    B.box('rs_iron', 1.64, 0.07, 0.07, cxT, fb - 0.32, lz, { r: 0.02 });
    B.box('rs_iron', 0.18, 0.2, 0.18, cxT + 1.0, fb - 0.22, lz, { r: 0.03 });
    B.cyl('rs_iron', 0.02, 0.02, 0.3, cxT + 1.22, fb - 0.22, lz, { rz: Math.PI / 2, seg: 5, caps: false });
    B.cyl('rs_brass', 0.028, 0.028, 0.14, cxT + 1.36, fb - 0.3, lz, { seg: 6 });
    // sides: painted steel outside (one panel image per 4 m), plank liner inside, dented between the ribs
    for (const s of sides) {
      const sx = Math.sign(s.x) || 1, outer = sx > 0 ? 'px' : 'nx', inner = sx > 0 ? 'nx' : 'px';
      B.box('rs_iron', s.hx * 2, s.hy * 2, s.hz * 2, s.x, s.y, s.z, {
        r: 0.02, div: [1, 4, 18], smoothN: true, off: [rnd(), 0],
        faces: { [outer]: { m: P, fit: 'v', S: 4 }, [inner]: 'rs_slats' },
        deform: q => { const zz = q[2] + s.z, yN = (q[1] + s.hy) / (2 * s.hy); q[0] += sx * dentAt(zz, yN); q[1] += bow(zz) * yN; },
      });
      for (const zz of kept) B.box(P, 0.06, s.hy * 2 - 0.34, 0.11, s.x + sx * (s.hx + 0.03), s.y - 0.02, zz, { r: 0.025, fit: 'v', off: [zz * 0.37, 0] });
      B.box('rs_iron', 0.09, 0.16, s.hz * 2 + 0.1, s.x + sx * (s.hx + 0.045), s.y + s.hy - 0.08, s.z, { r: 0.035, rot: true, div: [1, 1, 10], deform: q => { q[1] += bow(q[2] + s.z); } });
      B.box('rs_slats', 0.07, 0.36, zf - (zr + hw + 0.3) - 0.1, s.x + sx * (s.hx + 0.075), s.y - s.hy + 0.42, (zr + hw + 0.3 + zf - 0.1) / 2, { r: 0.02, rot: false, off: [0.4, 0.3], jit: 0.02 });
      B.box('rs_iron', 0.2, s.hy * 2 + 0.2, 0.2, s.x + sx * 0.04, s.y, zr - 0.05, { r: 0.05 });
      B.box('rs_iron', 0.18, s.hy * 2 + 0.2, 0.18, s.x + sx * 0.04, s.y, zf + 0.03, { r: 0.05 });
      B.quad('rs_decal_freight#', 5.0, 1.25, s.x + sx * (s.hx + 0.03), s.y + 0.2, s.z - 0.2, { ry: sx * Math.PI / 2 });
    }
    // the rear doors, swung all the way round and folded back flat against the sides
    const s0 = sides[0];
    const dh = s0 ? s0.hy * 2 - 0.1 : 2.6, dy = s0 ? s0.y : 2.2;
    for (const sx of [-1, 1]) {
      const len = hw * 0.98, dx = cxT + sx * (hw + 0.06 + 0.075), dz = zr + len / 2 + 0.06;
      B.box(P, 0.05, dh, len, dx, dy, dz, { r: 0.018, fit: 'v', S: 4, off: [sx * 0.31, 0] });
      B.lod0 = true;
      for (const lz2 of [-0.27, 0.27]) B.cyl('rs_iron', 0.025, 0.025, dh - 0.12, dx + sx * 0.05, dy, dz + lz2 * len, { seg: 6, caps: 'rs_iron' });
      for (const yy of [-dh * 0.4, dh * 0.4]) B.box('rs_iron', 0.03, 0.08, 0.34, dx + sx * 0.035, dy + yy, dz - len / 2 + 0.17, { r: 0.005 });
      B.box('rs_brass', 0.05, 0.16, 0.06, dx + sx * 0.06, dy - 0.2, dz + len * 0.27, { r: 0.01 });
      B.lod0 = false;
    }
    if (front) {
      B.box('rs_iron', front.hx * 2, front.hy * 2, front.hz * 2, front.x, front.y, front.z, { r: 0.02, faces: { pz: { m: P, fit: 'v', S: 4 }, nz: 'rs_slats' } });
      // a goblin "cold box" up on the nose, a brass fan in its grille
      const fz = front.z + front.hz;
      B.box('rs_brass', 1.3, 0.66, 0.26, front.x, front.y + front.hy - 0.45, fz + 0.13, { r: 0.06, faces: { pz: { m: 'rs_grille', fit: true } } });
      B.torus('rs_brass', 0.2, 0.035, front.x + 0.3, front.y + front.hy - 0.45, fz + 0.27, { seg: 14, lod0: true });
      for (let k = 0; k < 3; k++) B.box('rs_iron', 0.06, 0.3, 0.02, front.x + 0.3, front.y + front.hy - 0.45, fz + 0.28, { rz: k * TAU / 6 + 0.3, r: 0.008 });
      // coiled red and blue air lines across the gap to the cab, on brass glad-hands
      const cb = cab ? cab.z - cab.hz : fz + 0.35;
      B.lod0 = true;
      for (const [sx, col] of [[-1, P], [1, C]]) {
        const a = V(front.x + sx * 0.32, 1.35, fz + 0.03), b = V(front.x + sx * 0.22, 1.55, cb - 0.02), pts = [];
        for (let k = 0; k <= 36; k++) {
          const u = k / 36, ang = u * TAU * 5 + (sx > 0 ? 1 : 0);
          const base = a.clone().lerp(b, u); base.y -= Math.sin(Math.PI * u) * 0.22;
          pts.push(base.add(V(Math.cos(ang) * 0.055, Math.sin(ang) * 0.055, 0)));
        }
        B.tube(col, pts, 0.016, { seg: 5 });
        B.box('rs_brass', 0.09, 0.07, 0.06, a.x, a.y, a.z, { r: 0.01 });
      }
      B.lod0 = false;
    }
    if (roof) {
      B.box('rs_iron', roof.hx * 2, roof.hy * 2, roof.hz * 2, roof.x, roof.y, roof.z, { r: 0.03, div: [2, 1, 14], smoothN: true, faces: { py: { m: 'rs_tin', rot: true } }, deform: q => { q[1] += bow(q[2] + roof.z); } });
      for (const sx of [-1, 1]) for (const zz of [zf - 0.08, zr + 0.08]) B.box('rs_headlamp*', 0.12, 0.08, 0.07, roof.x + sx * (roof.hx - 0.12), roof.y - roof.hy - 0.05, zz, { tint: zz > 0 ? [1, 0.75, 0.45] : [1, 0.4, 0.32] });
      if (ctx.snow) {
        snowCap(B, roof.hx * 2, roof.hz * 2, roof.x, roof.y + roof.hy, roof.z, { t: 0.2, dy: (lx, lz) => bow(lz + roof.z) });
        for (const sx of [-1, 1]) icicles(B, roof.x + sx * (roof.hx + 0.05), zr + 0.2, roof.x + sx * (roof.hx + 0.05), zf - 0.2, roof.y - roof.hy + 0.02, rnd, { max: 0.25, skip: (x, z) => z > decZ0 && z < decZ1 });
      }
    }
    if (ramp) {
      B.box('rs_slats', ramp.hx * 2, ramp.hy * 2, ramp.hz * 2, ramp.x, ramp.y, ramp.z, { r: 0.02, rot: true, ry: ramp.ry, jit: 0.015 });
      for (let k = 0; k < 4; k++) B.box('rs_iron', ramp.hx * 2 - 0.12, 0.04, 0.07, ramp.x, ramp.y + ramp.hy + 0.02, ramp.z - ramp.hz + 0.3 + k * range(rnd, 0.55, 0.75), { r: 0.012, tint: [0.75, 0.6, 0.5] });
      for (const zz of [ramp.z - ramp.hz + 0.25, ramp.z + ramp.hz - 0.25]) {
        const gy = B.ground(ramp.x, zz), top = ramp.y - ramp.hy, hh = top - gy + 0.1;
        if (hh > 0.03) B.box('rs_slats', ramp.hx * 2 - 0.25, hh, 0.3, ramp.x, gy - 0.1 + hh / 2, zz, { r: 0.02, tint: [0.8, 0.72, 0.65] });
      }
    }
    if (ctx.driftMat) {
      drift(B, ctx, cxT - hw - 0.1, fl.z + 1, 0.8, 4.2, ctx.snow ? 0.55 : 0.38, 0);
      drift(B, ctx, cxT + hw + 0.1, fl.z - 2, 0.6, 2.4, 0.28, 0);
    }
  }
  if (cab) {
    const cx = cab.x, cz = cab.z, hx = cab.hx, hz = cab.hz, fz = cz + hz, bz = cz - hz, top = cab.y + cab.hy;
    const by = 1.02, bh = top - by, bcy = by + bh / 2;
    // one rounded cab-over: tapered, the top leaning back, the front bulging out
    const cabShape = q => {
      const yN = (q[1] + bh / 2) / bh, k = 1 - 0.07 * yN;
      q[0] *= k; q[2] *= k;
      if (q[2] > 0) { const ex = Math.max(0, 1 - (q[0] / hx) ** 2), ey = Math.max(0, 1 - ((yN - 0.4) / 0.62) ** 2); q[2] += 0.09 * ex * ey * clamp01(q[2] / (hz * k)); }
      q[2] -= 0.1 * yN;
    };
    const frontAt = (lx, ly) => { const q = [lx, ly - bcy, hz]; cabShape(q); return q[2] + cz; };
    const sideAt = (ly, sx) => { const q = [sx * hx, ly - bcy, 0]; cabShape(q); return cx + q[0]; };
    B.box(C, hx * 2, bh, hz * 2, cx, bcy, cz, { r: 0.36, div: [4, 5, 4], smoothN: true, fit: 'v', S: 2.4, off: [0.2, 0], faces: { ny: 'rs_iron' }, deform: cabShape });
    // chassis rails back under the trailer's nose, the fifth wheel
    for (const sx of [-1, 1]) B.box('rs_iron', 0.16, 0.26, fz - (zf - 0.75), cx + sx * 0.5, 0.5, (fz + zf - 0.75) / 2, { r: 0.03 });
    B.cyl('rs_iron', 0.62, 0.62, 0.08, cx, 0.57, zf - 0.1, { seg: 16, bevel: 0.02 });
    // big wheels under big round fenders
    for (const sx of [-1, 1]) {
      const wx = cx + sx * (hx + 0.04), wz = cz + 0.02;
      wheel(B, wx, 0.64, wz, 0.7, 0.44, {});
      B.push(M4(wx, 0.64, wz, 0, 0, 0, 2.7, 1, 1));
      const pts = []; for (let k = 0; k <= 12; k++) { const a = -0.3 + (Math.PI + 0.6) * k / 12; pts.push(V(0, Math.sin(a) * 0.86, Math.cos(a) * 0.86)); }
      B.tube(C, pts, 0.1, { seg: 8, ends: true });
      B.pop();
      // steps, a door seam and handle, the side window
      B.box('rs_iron', 0.34, 0.06, 0.5, cx + sx * (hx + 0.1), 0.5, cz - 0.95, { r: 0.015 });
      const wy = 2.48, xx = sideAt(wy, sx);
      B.box('rs_glass', 0.04, 0.6, 0.95, xx + sx * 0.01, wy, cz + 0.05, { rz: sx * Math.atan(0.07 * hx / bh), r: 0.01, uvRect: [0, 0, 0.5, 1] });
      B.box('rs_brass', 0.04, 0.05, 0.2, sideAt(1.75, sx) + sx * 0.02, 1.75, cz - 0.3, { r: 0.01 });
      B.cyl('rs_iron', 0.025, 0.025, 0.4, cx + sx * (hx + 0.16), 2.42, fz - 0.45, { rz: Math.PI / 2, seg: 5, caps: false });
      B.box('rs_iron', 0.08, 0.42, 0.24, cx + sx * (hx + 0.36), 2.42, fz - 0.45, { r: 0.03 });
    }
    // the face: grille, round headlamps in brass bezels, two windshield panes with different cracks
    const gy = 1.55, gz = frontAt(0, gy);
    B.box('rs_grille', 1.25, 0.82, 0.08, cx, gy, gz + 0.02, { r: 0.03, rx: -0.02 });
    for (const sx of [-1, 1]) B.cyl('rs_brass', 0.2, 0.2, 0.14, cx + sx * 0.84, 1.45, frontAt(sx * 0.84, 1.45) + 0.03, { rx: Math.PI / 2, caps: 'rs_headlamp*', seg: 14, bevel: 0.03 });
    for (const sx of [-1, 1]) {
      const lx = sx * 0.5, y0 = 2.18, y1 = 2.86, z0 = frontAt(lx, y0), z1 = frontAt(lx, y1), za = frontAt(sx * 0.06, 2.52), zb = frontAt(sx * 0.94, 2.52);
      B.box('rs_glass', 0.9, 0.68, 0.04, cx + lx, (y0 + y1) / 2, (z0 + z1) / 2 + 0.012, { rx: Math.atan2(z1 - z0, y1 - y0), ry: sx * Math.atan2(za - zb, 0.88), r: 0.012, uvRect: sx < 0 ? [0, 0, 0.5, 1] : [0.5, 0, 1, 1] });
    }
    B.box(C, 0.1, 0.74, 0.08, cx, 2.52, frontAt(0, 2.52) + 0.02, { rx: -0.1 });
    // visor with marker lamps, bolted bumper, exhaust stack, air horn
    const vz = frontAt(0, top - 0.14);
    B.box('rs_brass', hx * 2 * 0.86, 0.08, 0.2, cx, top - 0.12, vz + 0.06, { r: 0.03, rx: 0.15 });
    for (const lx of [-0.5, 0, 0.5]) B.box('rs_headlamp*', 0.13, 0.08, 0.07, cx + lx, top - 0.04, vz + 0.02, { tint: [1, 0.78, 0.45] });
    B.box('rs_iron', hx * 2 + 0.36, 0.3, 0.26, cx, 0.62, fz + 0.12, { r: 0.08, div: [3, 1, 1], smoothN: true, deform: q => { q[2] -= 0.05 * (q[0] / hx) ** 2; } });
    for (let k = 0; k < 6; k++) { const lx = -1.15 + k * 0.46; B.cyl('rs_brass', 0.035, 0.035, 0.05, cx + lx, 0.62 + (k % 2 ? 0.07 : -0.07), fz + 0.25 - 0.05 * (lx / hx) ** 2, { rx: Math.PI / 2, seg: 6 }); }
    const ex = cx + hx + 0.08, ez = bz + 0.25;
    B.cyl('rs_brass', 0.09, 0.09, 3.2, ex, 2.4, ez, { seg: 10, caps: 'rs_iron' });
    B.cyl('rs_iron', 0.13, 0.13, 0.9, ex, 2.1, ez, { seg: 10, caps: false });
    B.box('rs_iron', 0.2, 0.025, 0.2, ex, 4.02, ez + 0.05, { rx: -0.6 });
    B.cyl('rs_brass', 0.03, 0.12, 0.62, cx - 0.55, top + 0.08, cz - 0.15, { rx: Math.PI / 2, caps: false, seg: 8 });
    B.box('rs_brass', 0.08, 0.1, 0.08, cx - 0.55, top + 0.02, cz - 0.15);
    if (ctx.snow) {
      snowCap(B, (hx * 0.93 - 0.32) * 2, (hz * 0.93 - 0.32) * 2, cx, top, cz - 0.1, { t: 0.18 });
      icicles(B, cx - hx * 0.8, vz + 0.12, cx + hx * 0.8, vz + 0.12, top - 0.16, rnd, { max: 0.22 });
    }
    // nose in the dirt
    B.mound(ctx.bio.ground, 1.6, 0.36, 0.7, cx, B.ground(cx, fz + 0.5) - 0.1, fz + 0.5, { jit: 0.05 });
  }
}

function buildYard(B, p, parts, ctx, decor) {
  B.frame(p.x, p.y, p.z, p.ry || 0);
  const L = parts.map(s => B.loc(s));
  const rnd = rngOf(seedOf(p.x, p.z, 5));
  const cloth = ctx.bio.cloth, cS = densOf(cloth);
  for (const t of L.filter(s => s.part === 'table')) {
    B.push(M4(t.x, 0, t.z, 0, t.ry, 0));
    const top = t.y + t.hy, hx = t.hx, hz = t.hz;
    B.box('rs_planks', hx * 2, 0.06, hz * 2, 0, top - 0.03, 0, { r: 0.014, off: [rnd(), rnd()] });
    for (const sx of [-1, 1]) B.box('rs_timber', 0.09, 0.07, hz * 2 - 0.08, sx * (hx - 0.14), top - 0.095, 0, { r: 0.015, rot: true });
    // the cloth: a sheet over most of the top, hanging over the long edges in a sagging, uneven hem;
    // one end of the boards left bare
    const bare = rnd() < 0.5 ? -1 : 1, x0 = bare < 0 ? -hx + 0.22 : -hx - 0.02, x1 = bare < 0 ? hx + 0.02 : hx - 0.22;
    const Lh = range(rnd, 0.17, 0.24), ph = rnd() * 6, ph2 = rnd() * 6;
    B.grid(cloth, 12, 14, (u, v) => {
      const x = lerp(x0, x1, u), jv = v * 14;
      if (jv > 3 && jv < 11) return [x, top + 0.007 + Math.sin(x * 7 + jv + ph) * 0.002, -hz + 2 * hz * (jv - 3) / 8];
      const sg = jv <= 3 ? -1 : 1, tt = jv <= 3 ? (3 - jv) / 3 : (jv - 11) / 3;
      const hang = Lh * (0.8 + 0.2 * Math.sin(x * 5.3 + ph2 + sg * 1.7)) * tt;
      const fold = Math.sin(x * 9 + ph + sg * 2) * 0.02 * Math.min(1, tt * 2);
      return [x, top + 0.007 - hang, sg * (hz + 0.016 * Math.min(1, tt * 4) + fold + 0.025 * tt)];
    }, { flip: true, uv: (u, v, q) => [q[0] / cS, (v * (2 * hz + 2 * Lh)) / cS] });
    // trestles: two A-frames, a cross bar each, a long stretcher between them
    for (const sx of [-1, 1]) {
      const lx = sx * (hx - 0.34), y1 = top - 0.13;
      for (const sz of [-1, 1]) { const dz = 0.32, len = Math.hypot(dz, y1); B.box('rs_timber', 0.1, len, 0.08, lx, y1 / 2, sz * (0.09 + dz / 2), { rx: -sz * Math.atan2(dz, y1), r: 0.02 }); }
      B.box('rs_timber', 0.08, 0.08, 0.78, lx, 0.26, 0, { rot: true, r: 0.02 });
      B.box('rs_timber', 0.12, 0.08, hz * 2 - 0.16, lx, y1 + 0.04, 0, { rot: true, r: 0.02 });
    }
    B.box('rs_timber', hx * 2 - 0.6, 0.1, 0.08, 0, 0.36, 0, { r: 0.02 });
    // something for sale under the table
    B.box(pick(rnd, ['rs_crate_a', 'rs_crate_b']), 0.5, 0.42, 0.42, (rnd() < 0.5 ? -1 : 1) * 0.42, 0.21, 0.1, { r: 0.03, ry: range(rnd, -0.2, 0.2) });
    B.pop();
  }
  // a blanket spread out in front of the tables: the cheap stuff goes on the ground
  B.sheet('rs_blanket', 4.4, 2.6, range(rnd, -0.3, 0.3), 2.35, { ry: range(rnd, -0.08, 0.08) });
  // the umbrella on a crate base
  const d = decor.find(e => e.k === 'umbrella');
  if (d) {
    B.frame(d.x, d.y, d.z, d.ry || 0);
    B.box('rs_crate_a', 0.56, 0.52, 0.56, 0, 0.26, 0, { r: 0.03, ry: 0.4 });
    B.push(M4(0, 0.55, 0, 0.03, 0, 0.06));
    B.cyl('rs_timber', 0.04, 0.045, 2.35, 0, 1.12, 0, { seg: 6, caps: false });
    const canvas = ctx.bio.umbrella;
    B.lathe(canvas, [[1.6, 1.72], [1.25, 1.9], [0.75, 2.08], [0.28, 2.2], [0, 2.25]], 0, 0, 0, { seg: 8, fit: true });
    B.cyl(canvas, 1.6, 1.62, 0.2, 0, 1.63, 0, { seg: 8, caps: false, fit: true });
    for (let k = 0; k < 8; k++) {
      const a = TAU * k / 8;
      B.tube('rs_iron', [V(0, 1.95, 0), V(Math.sin(a) * 1.55, 1.7, Math.cos(a) * 1.55)], 0.012, { seg: 4 });
    }
    B.ell('rs_iron', 0.06, 0.08, 0.06, 0, 2.3, 0, { seg: 8, rings: 5 });
    if (ctx.snow) B.lathe('rs_snow!', [[1.5, 1.84], [1.1, 2.0], [0.6, 2.16], [0.2, 2.27], [0, 2.3]], 0, 0, 0, { seg: 8, S: 2, noAO: true });
    B.pop();
  }
}

function buildCrash(B, p, parts, ctx, decor) {
  const d = decor.find(e => e.k === 'plane') || { x: p.x, y: p.y, z: p.z, ry: (p.ry || 0) + 0.8 };
  B.frame(d.x, d.y, d.z, d.ry);
  const L = parts.map(s => B.loc(s));
  const fus = L.find(s => s.part === 'fuselage'), wing = L.find(s => s.part === 'wing');
  const rnd = rngOf(seedOf(p.x, p.z, 9));
  const RED = 'rs_steel_red', WING_RED = [0.78, 0.34, 0.27];
  if (fus) {
    const fy = fus.y, fh = fus.hy, fz0 = fus.z, fhz = fus.hz, zN = fz0 + fhz, zT = fz0 - fhz;
    // the fuselage: a rounded riveted hull, tapering a little toward the broken tail
    const taperK = zz => 1 - 0.14 * smooth(-0.8, -fhz, zz);
    B.box(RED, fus.hx * 2, fh * 2, fhz * 2, fus.x, fy, fz0, { r: 0.32, div: [2, 2, 5], smoothN: true, fit: 'v', S: 2.5, faces: { ny: 'rs_iron' }, off: [0.3, 0.1],
      deform: q => { const k = taperK(q[2] + fz0); q[0] *= k; q[1] = q[1] * k + (1 - k) * fh * 0.4; } });
    for (const zz of [2.3, 0.9, -0.6]) B.box('rs_brass', fus.hx * 2 + 0.06, fh * 2 + 0.06, 0.14, fus.x, fy, fz0 + zz * fhz / 3.2, { r: 0.33 });
    // cockpit: brass coaming, dark well, leather seat back, windscreen
    const ct = fy + fh;
    B.box('rs_brass', 0.92, 0.06, 1.25, fus.x, ct + 0.02, fz0 + 0.75, { r: 0.025 });
    B.box('rs_iron', 0.72, 0.03, 1.02, fus.x, ct + 0.05, fz0 + 0.75, { tint: [0.32, 0.3, 0.34] });
    B.box('rs_timber', 0.55, 0.42, 0.1, fus.x, ct + 0.24, fz0 + 0.33, { tint: [0.85, 0.5, 0.4], r: 0.04 });
    B.box('rs_glass', 0.66, 0.34, 0.03, fus.x, ct + 0.22, fz0 + 1.42, { rx: -0.4, r: 0.01, uvRect: [0.5, 0, 1, 1] });
    // the nose: crumpled brass cowling, a radial engine, a snapped propeller
    B.lathe('rs_brass', [[0.62, 0], [0.7, 0.16], [0.68, 0.36], [0.52, 0.5], [0.24, 0.56]], fus.x, fy, zN - 0.08, { rx: Math.PI / 2, seg: 12, jit: 0.07 });
    B.cyl('rs_iron', 0.24, 0.24, 0.05, fus.x, fy, zN + 0.48, { rx: Math.PI / 2, seg: 10, tint: [0.5, 0.48, 0.5] });
    for (let k = 0; k < 7; k++) {
      const a = TAU * k / 7 + 0.2;
      B.cyl('rs_iron', 0.085, 0.1, 0.3, fus.x + Math.cos(a) * 0.74, fy + Math.sin(a) * 0.74, zN + 0.22, { rz: a - Math.PI / 2, seg: 8, caps: 'rs_iron', bevel: 0.02, lod0: false });
    }
    B.cyl('rs_brass', 0, 0.17, 0.32, fus.x, fy, zN + 0.68, { rx: Math.PI / 2, seg: 10 });
    B.push(M4(fus.x, fy, zN + 0.62, 0, 0, 0.55));
    B.box('rs_timber', 0.2, 1.15, 0.06, 0, 0.62, 0, { r: 0.025, taper: 0.55, rx: 0.3, deform: q => { q[2] += q[1] * q[1] * 0.25; } });
    B.box('rs_timber', 0.2, 0.36, 0.06, 0, -0.22, 0, { r: 0.025, jit: 0.04 });
    B.pop();
    // the tail broke its back on landing: the boom snapped up at forty degrees, the fin standing high
    // over the wreck with the gnomish roundel on it (this is what you see from the road below the mesa)
    const pitch = 0.7, bl = 2.5, b0 = V(fus.x, fy + 0.15, zT + 0.35);
    const dir = V(0, Math.sin(pitch), -Math.cos(pitch)), b1 = b0.clone().add(dir.clone().multiplyScalar(bl));
    B.lathe('rs_brass', [[0.6, -0.05], [0.66, 0.04], [0.56, 0.14], [0.5, 0.2]], b0.x, b0.y, b0.z, { rx: pitch - Math.PI / 2, seg: 10, jit: 0.12 });
    B.tube(RED, [b0, b0.clone().lerp(b1, 0.45), b1], [0.5, 0.4, 0.26], { seg: 10, off: [0.2, 0] });
    B.push(new THREE.Matrix4().compose(b1, new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * 0.8, 0, 0, 'YXZ')), new V3(1, 1, 1)));
    B.box(RED, 0.1, 1.6, 1.15, 0, 0.76, -0.15, { r: 0.04, taper: 0.62, div: [1, 2, 2], fit: 'v', deform: q => { q[2] -= (q[1] + 0.8) * 0.3; } });
    B.box('rs_brass', 0.12, 0.08, 0.66, 0, 1.56, -0.62, { r: 0.025 });
    for (const sx of [-1, 1]) B.quad('rs_roundel#', 0.82, 0.82, sx * 0.058, 0.68, -0.28, { ry: sx * Math.PI / 2 });
    B.box('rs_wing', 2.6, 0.07, 0.72, 0, 0.02, -0.05, { r: 0.025, rz: 0.1, tint: WING_RED });
    B.box('rs_wing', 0.9, 0.06, 0.6, 1.1, 0.03, -0.1, { r: 0.02, rz: -0.35, ry: 0.3, jit: 0.04 });
    B.pop();
    // landing gear: one leg snapped out sideways, a wheel lying in the dirt
    B.tube('rs_iron', [V(fus.x + 0.4, 0.3, fz0 + 2.0), V(fus.x + 1.05, 0.22, fz0 + 2.3)], 0.045, { seg: 6 });
    wheel(B, fus.x + 1.15, 0.3, fz0 + 2.32, 0.3, 0.14, { ry: 0.4, lean: 0.35 });
    {
      const wx = fus.x - 2.7, wz = fz0 + 2.8, gy = B.ground(wx, wz);
      B.cyl('rs_tire', 0.3, 0.3, 0.14, wx, gy + 0.06, wz, { caps: 'rs_hub', fit: true, uRep: 6, bevel: 0.035, seg: 14, rx: 0.12 });
    }
    // a column of smoke rising off the engine marks the wreck from the road
    if (ctx.smokes) ctx.smokes.push(B.world(fus.x, fy + 0.4, zN - 0.2));
    // furrow ploughed by the nose
    B.mound(ctx.bio.ground, 1.5, 0.48, 1.0, fus.x, B.ground(fus.x, zN + 0.7) - 0.12, zN + 0.7, { jit: 0.08 });
  }
  if (wing) {
    const droop = q => { const xx = q[0] + wing.x; if (xx > 2.6) { const k2 = xx - 2.6; q[1] -= k2 * k2 * 0.02; } };
    B.box('rs_wing', wing.hx * 2, wing.hy * 2, wing.hz * 2, wing.x, wing.y, wing.z, { r: 0.05, div: [6, 1, 1], deform: droop, off: [0.2, 0.5] });
    // red-doped bands near the tips, the leading-edge spar, the wingtip bows
    for (const sx of [-1, 1]) B.box('rs_wing', 0.5, wing.hy * 2 + 0.02, wing.hz * 2 + 0.02, wing.x + sx * (wing.hx - 0.75), wing.y - (sx > 0 ? 0.02 : 0), wing.z, { r: 0.05, tint: WING_RED, rz: sx > 0 ? -0.04 : 0 });
    B.quad('rs_roundel#', 0.95, 0.95, wing.x - wing.hx + 1.6, wing.y + wing.hy + 0.02, wing.z, { rx: -Math.PI / 2 });
    B.cyl('rs_brass', 0.055, 0.055, 6.75, wing.x - 0.78, wing.y, wing.z + wing.hz, { rz: Math.PI / 2, seg: 6, caps: false });
    B.box(RED, 0.12, wing.hy * 2 + 0.06, wing.hz * 2 + 0.04, wing.x - wing.hx, wing.y, wing.z, { r: 0.04 });
    // the upper wing: left half still up on its struts; the right half snapped off its root and
    // flung up and outward, a bent strut still hanging off it trailing a tattered pennant
    const uy = 2.05, uz = wing.z + 0.1;
    B.box('rs_wing', 6.4, 0.14, 1.5, wing.x - 1.0, uy, uz, { r: 0.05, off: [0.7, 0.2], div: [6, 1, 1] });
    B.box('rs_wing', 0.6, 0.15, 1.52, wing.x - 3.75, uy, uz, { r: 0.05, tint: WING_RED });
    B.box(RED, 0.12, 0.2, 1.54, wing.x - 4.2, uy, uz, { r: 0.04 });
    B.quad('rs_roundel#', 1.0, 1.0, wing.x - 2.9, uy + 0.08, uz, { rx: -Math.PI / 2 });
    B.push(M4(wing.x + 2.25, uy - 0.05, uz, 0, -0.1, 0.72));
    B.box('rs_wing', 2.1, 0.13, 1.45, 1.05, 0, 0, { r: 0.05, jit: 0.04, off: [0.1, 0.9], div: [3, 1, 1] });
    B.box('rs_wing', 0.5, 0.14, 1.47, 1.8, 0, 0, { r: 0.05, tint: WING_RED, jit: 0.03 });
    B.box(RED, 0.12, 0.19, 1.5, 2.1, 0, 0, { r: 0.04 });
    // the bent strut and the pennant
    const s0 = V(1.6, -0.1, 0.4), s1 = V(1.75, -0.75, 0.48), s2 = V(2.1, -1.2, 0.46);
    B.tube('rs_timber', [s0, s1, s2], 0.045, { seg: 6, lod0: false });
    B.pop();
    // a tall bent pole jammed in the left wingtip carrying a pennant: one more thing that shows over the rim
    const px = wing.x - 3.4, pz = uz + 0.45;
    B.tube('rs_timber', [V(px, uy + 0.05, pz), V(px + 0.05, uy + 0.9, pz + 0.02), V(px + 0.22, uy + 1.7, pz - 0.05)], [0.05, 0.045, 0.035], { seg: 6, lod0: false });
    B.quad('rs_pennant#~', 1.0, 0.5, px + 0.68, uy + 1.45, pz - 0.03, { rz: -0.22, ry: 0.15 });
    for (const sx of [-3.0, -1.4, 1.4]) for (const dz of [-0.45, 0.5]) {
      B.cyl('rs_timber', 0.045, 0.045, uy - wing.y - 0.12, wing.x + sx, (uy + wing.y) / 2, uz + dz, { seg: 6, caps: false, lod0: false });
    }
    for (const sx of [-1, 1]) B.cyl('rs_iron', 0.03, 0.03, uy - 1.4, wing.x + sx * 0.38, (uy + 1.4) / 2, uz, { seg: 5, caps: false, rz: sx * 0.15 });
    B.cyl('rs_timber', 0.045, 0.045, 0.55, wing.x + 3.0, wing.y + 0.3, uz, { seg: 6, caps: false, rz: -0.5 });
    for (const [x0, x1] of [[-3.0, -1.4], [-1.4, 1.4]]) {
      B.tube('rs_iron', [V(wing.x + x0, wing.y + 0.08, uz), V(wing.x + x1, uy - 0.07, uz)], 0.01, { seg: 3 });
      B.tube('rs_iron', [V(wing.x + x1, wing.y + 0.08, uz), V(wing.x + x0, uy - 0.07, uz)], 0.01, { seg: 3 });
    }
    if (ctx.snow) {
      snowCap(B, 6.2, 1.45, wing.x - 1.0, uy + 0.07, uz, { t: 0.12 });
      icicles(B, wing.x - 4.1, uz + 0.75, wing.x + 2.1, uz + 0.75, uy - 0.07, rnd, { max: 0.25 });
    }
  }
  // debris scattered round the wreck (kept off the loot, which lies behind it)
  const debris = [RED, 'rs_wing', 'rs_brass', 'rs_iron', RED];
  for (let i = 0; i < 6; i++) {
    let x, z; do { const a = rnd() * TAU, rr = range(rnd, 2.6, 4.8); x = Math.cos(a) * rr; z = Math.sin(a) * rr; } while (z < -2.5 && Math.abs(x) < 3.5);
    B.box(debris[i % debris.length], range(rnd, 0.3, 0.7), 0.04, range(rnd, 0.25, 0.5), x, B.ground(x, z) + 0.04, z, { ry: rnd() * 3, rx: range(rnd, -0.25, 0.25), rz: range(rnd, -0.25, 0.25), jit: 0.05 });
  }
  B.box('rs_timber', 0.2, 0.85, 0.06, -1.8, B.ground(-1.8, 3.6) + 0.04, 3.6, { rx: -Math.PI / 2 + 0.05, ry: 0.7, taper: 0.6, r: 0.02 });
  if (ctx.driftMat && fus) drift(B, ctx, fus.x - fus.hx - 0.1, fus.z - 0.5, 0.55, 2.4, 0.32, 0);
}

// junk: stencilled crates stacked into their boxes, barrels in banded clusters on pallets, scrap heaps
// built from recognisable wreckage
function buildJunk(B, p, parts, ctx) {
  for (const s of parts) {
    const gy = ctx.H(s.x, s.z);
    B.frame(s.x, gy, s.z, s.ry || 0);
    const rnd = rngOf(seedOf(s.x, s.z, 7));
    const cy = s.y - gy, bot = cy - s.hy, top = cy + s.hy;
    const W2 = s.hx * 2, D2 = s.hz * 2;
    if (s.part !== 'scrap' && bot > 0.06) {
      // the box floats: a pallet under it on a heap of scrap
      B.box('rs_planks_gray', W2 - 0.02, 0.12, D2 - 0.02, 0, bot - 0.06, 0, { r: 0.02, off: [rnd(), 0] });
      const hh = bot - 0.12 + 0.2;
      if (hh > 0.05) B.box('rs_scrap', W2 - 0.16, hh, D2 - 0.16, 0, hh / 2 - 0.2, 0, { r: Math.min(0.15, hh * 0.45), jit: 0.08, div: [2, 1, 2] });
    }
    const b0 = Math.max(0, bot);
    if (s.part === 'crate') {
      const nx = W2 > 1.45 ? 2 : 1, nz = D2 > 1.45 ? 2 : 1, ny = top - b0 > 1.25 ? 2 : 1;
      const Wc = W2 / nx, Hc = (top - b0) / ny, Dc = D2 / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) for (let k = 0; k < ny; k++) {
        const v = pick(rnd, ['rs_crate_a', 'rs_crate_b', 'rs_crate_c', 'rs_crate_a', 'rs_crate_b']), sh = k > 0 ? 0.93 : 1;
        B.box(v, (Wc - 0.04) * sh, Hc - 0.02, (Dc - 0.04) * sh, -s.hx + Wc * (i + 0.5) + (k ? range(rnd, -0.04, 0.04) : 0), b0 + Hc * (k + 0.5), -s.hz + Dc * (j + 0.5), { r: 0.035, ry: k > 0 ? range(rnd, -0.08, 0.08) : range(rnd, -0.02, 0.02) });
      }
      if (ctx.snow && top > 0.3) snowCap(B, W2 - 0.1, D2 - 0.1, 0, top, 0, { t: 0.1 });
    } else if (s.part === 'barrel') {
      // barrels and drums in a cluster, jittered and leaning, on a pallet; one laid across the top or a
      // plank lid so the top of the box is something to stand on
      const H = top - b0, kinds = ['rs_barrel', 'rs_drum', 'rs_drum_red', 'rs_barrel'];
      if (H < 0.8) {
        const r = Math.min(0.36, H / 2), long = Math.max(W2, D2), short = Math.min(W2, D2), alongX = W2 >= D2;
        const rows = Math.max(1, Math.floor(short / (2 * r + 0.04))), m = Math.max(1, Math.round(long / 1.0)), len = Math.min(0.92, long / m - 0.06);
        for (let i = 0; i < m; i++) for (let j = 0; j < rows; j++) {
          const a = -long / 2 + long * (i + 0.5) / m, b = -short / 2 + short * (j + 0.5) / rows;
          barrel(B, pick(rnd, kinds), r, len, alongX ? a : b, b0 + r, alongX ? b : a, alongX ? { rz: Math.PI / 2, ry: range(rnd, -0.06, 0.06) } : { rx: Math.PI / 2, ry: range(rnd, -0.06, 0.06) });
        }
      } else {
        B.box('rs_planks_gray', W2 - 0.02, 0.12, D2 - 0.02, 0, b0 + 0.06, 0, { r: 0.02, off: [rnd(), rnd()] });
        const rem0 = H - 0.12, layTop = rem0 > 1.32, hb = layTop ? Math.min(0.95, Math.max(0.85, rem0 - 0.6)) : Math.min(0.95, rem0 - 0.06);
        const r = 0.34, nx = Math.max(1, Math.round(W2 / 0.74)), nz = Math.max(1, Math.round(D2 / 0.74));
        for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
          const x = -s.hx + W2 * (i + 0.5) / nx + range(rnd, -0.05, 0.05), z = -s.hz + D2 * (j + 0.5) / nz + range(rnd, -0.05, 0.05);
          barrel(B, pick(rnd, kinds), Math.min(r, W2 / nx / 2 - 0.02, D2 / nz / 2 - 0.02), hb, x, b0 + 0.12 + hb / 2, z, { ry: rnd() * TAU, rx: range(rnd, -0.07, 0.07), rz: range(rnd, -0.07, 0.07) });
        }
        const above = top - (b0 + 0.12 + hb);
        if (layTop && above > 0.3) {
          const rr = Math.min(0.34, above / 2), along = W2 >= D2, long = Math.max(W2, D2), short = Math.min(W2, D2);
          const nrow = Math.max(1, Math.floor(short / (2 * rr + 0.03)));
          const m = Math.max(1, Math.round(long / 1.0)), bl = Math.min(0.95, long / m - 0.06);
          for (let q = 0; q < nrow; q++) for (let i = 0; i < m; i++) {
            const o = -short / 2 + short * (q + 0.5) / nrow + range(rnd, -0.03, 0.03), a = -long / 2 + long * (i + 0.5) / m + range(rnd, -0.04, 0.04);
            barrel(B, pick(rnd, kinds), rr, bl, along ? a : o, top - rr, along ? o : a, along ? { rz: Math.PI / 2, ry: range(rnd, -0.08, 0.08) } : { rx: Math.PI / 2, ry: range(rnd, -0.08, 0.08) });
          }
          B.box('rs_planks_gray', W2 - 0.1, 0.05, D2 - 0.1, 0, b0 + 0.12 + hb + 0.03, 0, { r: 0.01, rot: true, ry: range(rnd, -0.05, 0.05) });
        } else {
          B.box('rs_planks_gray', W2 - 0.06, 0.05, D2 - 0.06, 0, top - 0.025, 0, { r: 0.012, rot: true, ry: range(rnd, -0.05, 0.05), rz: range(rnd, -0.02, 0.02) });
          if (rnd() < 0.6) B.box(pick(rnd, ['rs_crate_a', 'rs_crate_c']), 0.42, 0.34, 0.42, range(rnd, -0.2, 0.2) * W2, top + 0.17, range(rnd, -0.2, 0.2) * D2, { r: 0.03, ry: rnd() * 3 });
        }
      }
      if (ctx.snow) snowCap(B, W2 - 0.1, D2 - 0.1, 0, top, 0, { t: 0.08, lod0: true });
    } else {
      // the scrap heap: a lumpy mound filling the box, wreckage stuck in it
      const base = Math.min(0, bot) - 0.1, ht = top - base, ph = rnd() * 6;
      B.box('rs_scrap', W2 - 0.04, ht, D2 - 0.04, 0, base + ht / 2, 0, { r: Math.min(0.18, ht * 0.3), div: [3, 2, 3], smoothN: true, jit: 0.1,
        deform: q => { if (q[1] > 0) q[1] += Math.sin(q[0] * 3.1 + q[2] * 2.3 + ph) * 0.06 - 0.04; } });
      const items = ['door', 'grille', 'tin', 'wheel', 'cog', 'coil'];
      for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      const n = 3 + (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const it = items[k], side = k % 2 ? 1 : -1, ax = side * s.hx * range(rnd, 0.2, 0.55), az = s.hz * range(rnd, -0.5, 0.5);
        if (it === 'door') {
          // a bent truck door, leaning against the heap
          B.box('rs_steel_red', 0.06, 0.95, 0.75, side * (s.hx + 0.02), 0.5, az, { r: 0.03, fit: 'v', rz: -side * 0.32, ry: range(rnd, -0.3, 0.3), div: [1, 3, 3], smoothN: true, deform: q => { q[0] += 0.08 * (q[2] / 0.375) ** 2 - 0.05 * (q[1] / 0.47) ** 2; } });
        } else if (it === 'grille') {
          B.box('rs_grille', 0.75, 0.55, 0.1, ax, top + 0.05, az, { rx: -0.9, ry: rnd() * 3, r: 0.02 });
        } else if (it === 'tin') {
          for (let q = 0; q < 3; q++) B.box('rs_tin', 0.95, 0.03, 0.62, ax + range(rnd, -0.15, 0.15), top - 0.02 + q * 0.05, az + range(rnd, -0.1, 0.1), { ry: rnd() * 3, rx: range(rnd, -0.18, 0.18), rz: range(rnd, -0.18, 0.18), r: 0.01, jit: 0.03 });
        } else if (it === 'wheel') {
          // a wagon wheel propped against the heap
          B.push(M4(side * (s.hx + 0.05), 0.5, az, 0, Math.PI / 2 + range(rnd, -0.3, 0.3), side * 0.25));
          B.torus('rs_timber', 0.45, 0.05, 0, 0, 0, { seg: 16, tseg: 5, uRep: 3, lod0: false });
          for (let q = 0; q < 4; q++) B.box('rs_timber', 0.05, 0.88, 0.04, 0, 0, 0, { rz: q * Math.PI / 4, r: 0.01, lod0: false });
          B.cyl('rs_iron', 0.09, 0.09, 0.14, 0, 0, 0, { rx: Math.PI / 2, seg: 8 });
          B.pop();
        } else if (it === 'cog') {
          B.push(M4(ax, top + 0.05, az, Math.PI / 2 - 0.6, rnd() * 3, 0));
          B.cyl('rs_brass', 0.34, 0.34, 0.08, 0, 0, 0, { seg: 14, caps: 'rs_brass' });
          for (let q = 0; q < 10; q++) { const a = TAU * q / 10; B.box('rs_brass', 0.11, 0.08, 0.1, Math.sin(a) * 0.38, 0, Math.cos(a) * 0.38, { ry: a, r: 0.012 }); }
          B.cyl('rs_iron', 0.08, 0.08, 0.12, 0, 0, 0, { seg: 8 });
          B.pop();
        } else {
          // a coil of old pipe
          const pts = [];
          for (let q = 0; q <= 40; q++) { const a = q / 40 * TAU * 2.5; pts.push(V(ax + Math.cos(a) * 0.26, top + 0.06 + q * 0.004, az + Math.sin(a) * 0.26)); }
          B.tube('rs_iron', pts, 0.035, { seg: 6, lod0: false });
        }
      }
      if (ctx.snow) snowCap(B, W2 - 0.4, D2 - 0.4, 0, top - 0.06, 0, { t: 0.1 });
    }
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
  const body = ctx.bio.pump;
  if (pumps.length) {
    const xs = pumps.map(u => u.x), zc = pumps.reduce((s, u) => s + u.z, 0) / pumps.length;
    B.box('rs_stone', Math.max(...xs) - Math.min(...xs) + 1.8, 0.14, 1.5, (Math.max(...xs) + Math.min(...xs)) / 2, 0.07, zc - 0.1, { r: 0.05 });
  }
  for (const u of pumps) {
    B.push(M4(u.x, 0, u.z, 0, u.ry, 0));
    B.box('rs_iron', 0.74, 0.16, 0.54, 0, 0.22, 0, { r: 0.03 });
    B.box(body, 0.68, 1.12, 0.48, 0, 0.86, 0, { r: 0.08, fit: 'v', faces: { pz: { m: 'rs_pump_face', fit: true }, nz: { m: 'rs_pump_face', fit: true } } });
    B.box('rs_brass', 0.72, 0.1, 0.52, 0, 1.45, 0, { r: 0.04 });
    // the big brass dial bezels, the glass globe on its collar
    for (const sz of [-1, 1]) B.torus('rs_brass', 0.235, 0.032, 0, 1.16, sz * 0.245, { seg: 18, tseg: 5, lod0: false });
    B.cyl('rs_brass', 0.1, 0.14, 0.1, 0, 1.55, 0, { seg: 12 });
    B.ell('rs_headlamp*', 0.16, 0.17, 0.16, 0, 1.76, 0, { seg: 14, rings: 8 });
    B.cyl('rs_brass', 0.05, 0.08, 0.07, 0, 1.95, 0, { seg: 8 });
    // a crank wheel on one side, the hose looped on a hook on the other
    B.push(M4(0.4, 0.95, 0, 0, Math.PI / 2, 0));
    B.torus('rs_iron', 0.17, 0.024, 0, 0, 0, { seg: 14, tseg: 4, lod0: false });
    for (let k = 0; k < 4; k++) B.box('rs_iron', 0.02, 0.32, 0.02, 0, 0, 0, { rz: k * Math.PI / 4, r: 0.005 });
    B.cyl('rs_brass', 0.025, 0.025, 0.12, 0.13, 0.08, 0.06, { rx: Math.PI / 2, seg: 5 });
    B.pop();
    B.box('rs_iron', 0.06, 0.04, 0.12, -0.36, 1.12, 0.12, { r: 0.01 });
    B.tube('rs_iron', [V(-0.34, 0.6, 0.05), V(-0.46, 0.45, 0.12), V(-0.5, 0.25, 0.16), V(-0.44, 0.15, 0.2), V(-0.4, 0.4, 0.2), V(-0.4, 0.85, 0.16), V(-0.39, 1.1, 0.13)], 0.032, { seg: 6, tint: [0.45, 0.4, 0.42], lod0: false });
    B.box('rs_brass', 0.07, 0.24, 0.08, -0.4, 1.0, 0.18, { rx: 0.2, r: 0.015 });
    B.pop();
  }
  // the canopy, carried on chunky timber columns standing behind the pumps on stone plinths
  const cd = decor.find(e => e.k === 'canopy');
  if (cd) {
    const c = B.loc({ x: cd.x, y: cd.y, z: cd.z, ry: cd.ry });
    const top = c.y, ccx = c.x, ccz = c.z, roofMat = ctx.bio.canopy;
    const colZ = pumps.length ? pumps[0].z - 0.62 : ccz - 0.6;
    for (const u of pumps) {
      const h = top - 0.25 - 0.6;
      B.box('rs_stone', 0.56, 0.6, 0.56, u.x, 0.3, colZ, { r: 0.06, jit: 0.03, tint: STONE_TINT[ctx.bio.kit] });
      B.box('rs_timber', 0.36, h, 0.36, u.x, 0.6 + h / 2, colZ, { r: 0.06, taper: 0.94 });
      B.box('rs_iron', 0.42, 0.12, 0.42, u.x, 0.66, colZ, { r: 0.03 });
      for (const sx of [-1, 1]) B.box('rs_timber', 0.16, 1.05, 0.16, u.x + sx * 0.4, top - 0.62, colZ, { rz: -sx * 0.78, r: 0.03 });
      for (const sz of [-1, 1]) B.box('rs_timber', 0.16, 0.9, 0.16, u.x, top - 0.6, colZ + sz * 0.34, { rx: sz * 0.78, r: 0.03 });
    }
    B.box('rs_timber', 8.4, 0.34, 0.34, ccx, top - 0.12, colZ, { r: 0.05, rot: true, jit: 0.02 });
    for (let k = 0; k < 5; k++) B.box('rs_timber', 0.18, 0.2, 4.6, ccx - 3.9 + k * 1.95 + range(rnd, -0.15, 0.15), top + 0.15, ccz, { r: 0.03 });
    const run = 2.35, rise = 0.6, ang = Math.atan2(rise, run), len = Math.hypot(run, rise) + 0.42;
    for (const sz of [-1, 1]) {
      const cy = top + 0.27 + rise / 2 - Math.sin(ang) * 0.21 + 0.02, cz = ccz + sz * (run / 2 + Math.cos(ang) * 0.21);
      B.box(roofMat, 9.2, 0.12, len, ccx, cy, cz, { rx: ang, ry: sz < 0 ? Math.PI : 0, faces: { ny: 'rs_planks_gray' }, r: 0.03 });
      B.box('rs_fascia', 9.25, 0.45, 0.07, ccx, top + 0.07, ccz + sz * (run + 0.43), { fit: 'v', r: 0.02, ry: sz < 0 ? Math.PI : 0 });
      for (const sx of [-1, 1]) B.box('rs_timber', 0.08, 0.2, len, ccx + sx * 4.6, cy, cz, { rx: ang, ry: sz < 0 ? Math.PI : 0, r: 0.02 });
      for (const sx of [-1, 1]) lantern(B, ccx + sx * 3.4, top - 0.35, ccz + sz * (run + 0.25), 0.15, ctx.bio.kit === 'goblin' ? 'rs_brass' : 'rs_iron');
      if (ctx.snow) {
        snowCap(B, 9.0, len - 0.1, ccx, cy + 0.06, cz, { t: 0.18, rx: ang, ry: sz < 0 ? Math.PI : 0 });
        icicles(B, ccx - 4.5, ccz + sz * (run + 0.48), ccx + 4.5, ccz + sz * (run + 0.48), top - 0.16, rnd, { max: 0.35 });
      }
    }
    B.box('rs_iron', 9.3, 0.14, 0.32, ccx, top + 0.27 + rise + 0.1, ccz, { r: 0.05 });
  }
  const cnt = L.find(s => s.part === 'counter');
  if (cnt) {
    // inside the building: no weather on it
    B.shelter = true;
    B.push(M4(cnt.x, 0, cnt.z, 0, cnt.ry, 0));
    const t = cnt.y + cnt.hy;
    B.box('rs_planks', cnt.hx * 2 + 0.12, 0.08, cnt.hz * 2 + 0.12, 0, t - 0.04, 0, { r: 0.02 });
    B.box('rs_planks_gray', cnt.hx * 2 - 0.06, cnt.hy * 2 - 0.16, cnt.hz * 2 - 0.06, 0, cnt.y - 0.04, 0, { rot: true, r: 0.02 });
    B.box('rs_timber', cnt.hx * 2, 0.1, cnt.hz * 2, 0, 0.05, 0, { rot: true, r: 0.02 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.cyl('rs_brass', 0.035, 0.035, cnt.hy * 2 - 0.1, sx * (cnt.hx - 0.03), cnt.y, sz * (cnt.hz - 0.03), { seg: 6, caps: false });
    B.pop();
    B.shelter = false;
  }
  // drums out by the corner of the building
  barrel(B, 'rs_drum_red', 0.3, 0.88, 3.55, B.ground(3.55, 3.6) + 0.44, 3.6, { ry: 0.6 });
  barrel(B, 'rs_drum', 0.3, 0.88, 4.0, B.ground(4.0, 3.15) + 0.44, 3.15, { ry: 2.1 });
}

// The dino: a painted plaster sauropod on a stone plinth that fills its collider: a full, round-topped
// body with a hump over the hips, elephant legs with toenails, a thick neck snapped off at the top
// (the head is loot), a heavy tail held out level.
function buildDino(B, p, parts, ctx) {
  const d = p.dino || { x: p.x, y: p.y, z: p.z, ry: p.ry || 0 };
  B.frame(d.x, d.y, d.z, d.ry);
  const L = parts.map(s => B.loc(s));
  const body = L.find(s => s.part === 'dino_body'), tail = L.find(s => s.part === 'dino_tail'), neck = L.find(s => s.part === 'dino_neck');
  const legs = L.filter(s => s.part === 'dino_leg');
  const tint = ctx.bio.dino;
  const uvFn = (pl, nl) => [(pl.z + pl.x * 0.35) / 2.5, 0.5 + 0.46 * Math.sign(nl.y) * Math.pow(Math.abs(nl.y), 0.8)];
  const rnd = rngOf(seedOf(p.x, p.z, 13));
  const stoneT = STONE_TINT[ctx.bio.kit];
  if (!body) return;
  const bz = body.z, bx = body.x, phx = body.hx - 0.02, phz = body.hz - 0.02, ptop = 1.1;
  // the plinth: base course, a recessed waist with the plaque, a cap, all inside the collider's footprint
  B.box('rs_stone', phx * 2, 0.6, phz * 2, bx, -0.1, bz, { r: 0.05, S: 2.8, tint: stoneT });
  B.box('rs_stone', (phx - 0.06) * 2, 0.62, (phz - 0.06) * 2, bx, 0.5, bz, { r: 0.04, S: 2.8, off: [0.3, 0.2], tint: stoneT });
  B.box('rs_stone', phx * 2, 0.2, phz * 2, bx, ptop - 0.1, bz, { r: 0.06, S: 2.8, off: [0.6, 0.1], tint: stoneT });
  B.quad('rs_plaque', 1.5, 0.5, bx, 0.52, bz + phz - 0.06 + 0.02, {});
  // painted rockwork under the belly
  B.box('rs_rock', 2.6, 0.95, 5.0, bx, ptop + 0.36, bz - 0.05, { r: 0.4, jit: 0.16, div: [3, 1, 5], smoothN: true, S: 1.4, tint: [0.66, 0.7, 0.56] });
  // the body
  const ax = body.hx - 0.05, az = body.hz - 0.05, yc = 2.98, ay = 1.42, e = 2.7, ev = 2.3, evLow = 3.2;
  const hump = (zn, y) => (y > 0 ? y * (0.2 * Math.exp(-(((zn + 0.35) / 0.42) ** 2)) - 0.18 * smooth(0.25, 1, zn)) : 0);
  B.grid('rs_dino', 26, 14, (u, v) => {
    const th = TAU * u, ph = -Math.PI / 2 + Math.PI * v;
    const ee = ph < 0 ? evLow : ev, r = sp(Math.cos(ph), ee), y = sp(Math.sin(ph), ee);
    const x = ax * r * sp(Math.sin(th), e), z = az * r * sp(Math.cos(th), e);
    return [bx + x, yc + ay * y + hump(z / az, y), bz + z];
  }, { wrapU: true, uvFn, tint });
  const topAt = zz => { const zn = clamp01(Math.abs((zz - bz) / az)); const c = Math.pow(zn, ev / 2), y = Math.pow(Math.max(0, 1 - c * c), 1 / ev); return yc + ay * y + hump((zz - bz) / az, y); };
  // rounded spine bumps, biggest over the hips
  for (let k = 0; k < 7; k++) {
    const zz = bz + az * (0.62 - k * 0.24), s = 0.75 + 0.35 * Math.exp(-(((k - 3.5) / 2) ** 2));
    B.ell('rs_dino', 0.13 * s, 0.17 * s, 0.22 * s, bx, topAt(zz) - 0.02, zz, { seg: 8, rings: 5, uvFn: () => [k * 0.13, 0.97], tint: tint.map(c => c * 0.88) });
  }
  // elephant legs: thick at the hip, a knee, flaring to a round foot with three cream toenails
  for (const l of legs) {
    const fx = Math.sign(l.x) * Math.min(Math.abs(l.x), ax - 0.62), fz = l.z, front = fz > bz;
    const pts = [V(fx, ptop + 0.02, fz), V(fx, ptop + 0.35, fz), V(fx * 0.98, ptop + 0.95, fz + (front ? 0.08 : -0.04)), V(fx * 0.92, ptop + 1.5, fz), V(fx * 0.8, 3.1, fz + (bz - fz) * 0.15)];
    B.tube('rs_dino', pts, [0.66, 0.54, 0.5, 0.58, 0.62], { seg: 12, uvFn, tint });
    const tz = fz + 0.6;
    for (const k of [-1, 0, 1]) B.ell('rs_dino', 0.12, 0.1, 0.12, fx + k * 0.27, ptop + 0.09, tz - Math.abs(k) * 0.12, { seg: 8, rings: 4, uvFn: () => [0.3 + k * 0.1, 0.07], tint: tint.map(c => c * 1.12) });
  }
  if (neck) {
    const nTop = neck.y + neck.hy;
    const pts = [V(neck.x, 3.3, bz + az - 1.1), V(neck.x, 4.4, neck.z - 0.25), V(neck.x, 5.45, neck.z + 0.05), V(neck.x, nTop - 0.1, neck.z)];
    B.tube('rs_dino', pts, [1.02, 0.8, 0.58, 0.44], { seg: 14, uvFn, tint });
    // the head is gone: a jagged ring of broken plaster, two bent rebar stubs
    B.lathe('rs_stone', [[0.43, -0.12], [0.45, 0.02], [0.38, 0.1], [0.26, 0.06], [0.12, 0.03], [0, 0.02]], neck.x, nTop - 0.1, neck.z, { seg: 12, jit: 0.1, tint: [1.2, 1.15, 1.05] });
    for (const [a, bend] of [[0.5, 0.25], [2.6, -0.2]]) {
      const ox = neck.x + Math.cos(a) * 0.16, oz = neck.z + Math.sin(a) * 0.16;
      B.tube('rs_iron', [V(ox, nTop - 0.1, oz), V(ox, nTop + 0.06, oz), V(ox + Math.cos(a) * 0.13, nTop + 0.12, oz + bend * 0.5)], 0.032, { seg: 5, lod0: false, tint: [0.9, 0.62, 0.48] });
    }
    if (ctx.snow) B.ell('rs_snow!', 0.4, 0.12, 0.4, neck.x, nTop - 0.02, neck.z, { seg: 12, rings: 4, noAO: true });
  }
  if (tail) {
    // a heavy tail held out level, filling its box out to near the end
    const sw = (p.id % 2 ? 1 : -1) * 0.1, tz0 = bz - az + 0.4, tz1 = tail.z - tail.hz;
    const pts = [V(tail.x, 3.45, tz0), V(tail.x + sw * 0.5, 3.55, lerp(tz0, tz1, 0.3)), V(tail.x + sw, 3.6, lerp(tz0, tz1, 0.6)), V(tail.x + sw * 0.6, 3.55, lerp(tz0, tz1, 0.85)), V(tail.x, 3.48, tz1 + 0.12)];
    B.tube('rs_dino', pts, [0.7, 0.52, 0.45, 0.36, 0.2], { seg: 12, uvFn, tint, capEnd: true });
  }
  if (ctx.driftMat) { drift(B, ctx, bx - body.hx - 0.2, bz, 0.7, 3.0, 0.42, 0); drift(B, ctx, bx + body.hx + 0.2, bz - 1.5, 0.5, 1.6, 0.28, 0); }
}

// ---- gates, keypads, anchors, camp, the RV lot ------------------------------------------------------------

function buildGateStatic(B, g, ctx) {
  const road = g.y - g.hy;
  B.frame(g.x, road, g.z, 0);
  const rnd = rngOf(seedOf(g.x, g.z, 21));
  const K = KIT[ctx.bio.kit] || KIT.timber, kit = ctx.bio.kit;
  // the posts stand at the foot of the canyon walls, not in them
  const footX = sx => { for (let x = g.hx + 0.5; x > 4; x -= 0.25) { const gy = Math.max(B.ground(sx * x, -0.8), B.ground(sx * x, 0.8), B.ground(sx * x, 0)); if (gy < 0.45) return x; } return 4; };
  const PX = { [-1]: Math.min(g.hx + 0.5, footX(-1) - 0.3), [1]: Math.min(g.hx + 0.5, footX(1) - 0.3) };
  const beamY = 5.0, pz = 0.56, xl = -PX[-1], xr = PX[1], cx = (xl + xr) / 2, span = xr - xl;
  const wood = K.wood, stoneT = STONE_TINT[kit];
  for (const sx of [-1, 1]) {
    const x = sx * PX[sx];
    const gy = Math.min(B.ground(x, -pz), B.ground(x, pz), B.ground(x, 0));
    const bot = gy - 0.35, ptop = beamY + 0.3, h = ptop - bot;
    if (K.foot && gy < 0.5) B.box(K.foot, 1.15, 0.75, 1.95, x, gy + 0.2, 0, { r: K.foot === 'rs_adobe' ? 0.22 : 0.1, jit: 0.05, div: K.foot === 'rs_adobe' ? [2, 1, 2] : [1, 1, 1], tint: stoneT });
    for (const sz of [-1, 1]) {
      const z = sz * pz;
      if (K.post === 'log') {
        B.cyl('rs_timber', 0.27, 0.31, h, x, bot + h / 2, z, { seg: 10, caps: 'rs_logend', bevel: 0.04, off: [rnd(), rnd()], tint: wood });
        for (const yy of [gy + 1.1, beamY - 0.55]) B.cyl('rs_iron', 0.32, 0.33, 0.12, x, yy, z, { seg: 10, caps: false, lod0: false });
      } else if (K.post === 'square') {
        B.box('rs_timber', 0.5, h, 0.5, x, bot + h / 2, z, { r: 0.06, jit: 0.03, taper: 0.94, tint: wood, off: [rnd(), 0] });
        B.box('rs_iron', 0.56, 0.1, 0.56, x, gy + 1.2, z, { r: 0.02, lod0: false });
      } else if (K.post === 'pier') {
        B.box('rs_stone', 0.66, h, 0.66, x, bot + h / 2, z, { r: 0.08, jit: 0.04, taper: 0.9, S: 1.2, tint: stoneT });
        for (const yy of [gy + 1.4, beamY - 0.7]) B.box('rs_iron', 0.72, 0.14, 0.72, x, yy, z, { r: 0.03, taper: 0.98, lod0: false });
        B.box('rs_stone', 0.86, 0.3, 0.86, x, gy + 0.1, z, { r: 0.08, jit: 0.05, tint: stoneT });
      } else if (K.post === 'bundle') {
        for (let k = 0; k < 3; k++) { const a = TAU * k / 3 + 0.4, ox = Math.cos(a) * 0.14, oz = Math.sin(a) * 0.14, hh = h - k * 0.18; B.cyl('rs_timber', 0.13, 0.15, hh, x + ox, bot + hh / 2, z + oz, { seg: 8, caps: 'rs_logend', tint: wood, off: [rnd(), rnd()], rz: ox * 0.15 }); }
        for (const yy of [gy + 0.9, gy + 2.6, beamY - 0.6]) lashing(B, x, yy, z, 0.3);
      } else {
        B.box('rs_timber', 0.46, h, 0.46, x, bot + h / 2, z, { r: 0.05, tint: wood });
        for (const yy of [gy + 0.9, gy + 2.4, beamY - 0.5]) B.box('rs_brass', 0.52, 0.16, 0.52, x, yy, z, { r: 0.03, lod0: false });
        for (const ox of [-1, 1]) for (const oz of [-1, 1]) B.box('rs_brass', 0.06, h - 0.6, 0.06, x + ox * 0.22, bot + h / 2 + 0.3, z + oz * 0.22, { r: 0.02, lod0: false });
      }
      // knee braces out toward the road
      B.box('rs_timber', 0.18, 1.5, 0.18, x - sx * 0.62, beamY - 0.6, z, { rz: sx * 0.8, r: 0.03, tint: wood });
    }
    // lights, extras
    if (K.light === 'lantern') lantern(B, x - sx * 0.95, beamY - 0.75, -pz - 0.02, 0.2, kit === 'goblin' ? 'rs_brass' : 'rs_iron');
    else if (K.light === 'brazier') { B.box('rs_iron', 0.08, 0.08, 0.6, x - sx * 0.1, 3.0, -pz - 0.3, { r: 0.02 }); brazier(B, x - sx * 0.1, 3.12, -pz - 0.62, false); }
    else torch(B, x - sx * 0.18, 3.3, -pz - 0.2);
    if (K.extra === 'hay' && gy < 0.5) haybale(B, x - sx * 1.0, gy - 0.05, -pz - 0.8, 1.05, 0.5, 0.48, { ry: range(rnd, -0.3, 0.3) });
    if (K.extra === 'bones') skull(B, x, beamY - 1.35, -pz - 0.36, 0, 1.3);
    if (ctx.driftMat && gy < 0.5) drift(B, ctx, x - sx * 0.4, -1.0, 0.9, 0.8, ctx.snow ? 0.5 : 0.3, 0);
  }
  // two heavy beams over the post pairs
  for (const sz of [-1, 1]) {
    if (K.post === 'log' || K.post === 'bundle') B.cyl('rs_timber', 0.25, 0.25, span + 1.3, cx, beamY + 0.02, sz * pz, { rz: Math.PI / 2, seg: 10, caps: 'rs_logend', bevel: 0.04, tint: wood, off: [rnd(), 0] });
    else B.box('rs_timber', span + 1.3, 0.46, 0.4, cx, beamY + 0.02, sz * pz, { r: 0.06, rot: true, jit: 0.03, tint: wood });
  }
  // a real gable roof over the arch: 2.2 m deep, about thirty-five degrees, rafter tails and a ridge cap
  const run = 1.12, ang = 35 * Math.PI / 180, rise = run * Math.tan(ang), slen = run / Math.cos(ang) + 0.3, rb = beamY + 0.02, rlen = span + 1.9;
  for (const sz of [-1, 1]) {
    const midZ = sz * (run / 2 + 0.12), midY = rb + rise / 2 - 0.1;
    B.box(K.roof, rlen, 0.14, slen, cx, midY, midZ, { rx: ang, ry: sz < 0 ? Math.PI : 0, r: 0.04, tint: K.roofTint, jit: K.bars === 'stakes' ? 0.04 : 0, faces: { ny: { m: 'rs_timber', tint: wood }, py: { m: K.roof, rot: !!K.roofRot } } });
    // rafter tails poking out under the eave, jittered
    for (let x = xl - 0.75; x < xr + 0.8; x += range(rnd, 0.55, 0.8)) B.box('rs_timber', 0.1, 0.12, 0.42, x, rb - 0.13, sz * (run + 0.02), { rx: sz * ang, r: 0.02, tint: wood, lod0: true });
    if (ctx.snow) {
      snowCap(B, rlen - 0.1, slen - 0.1, cx, midY + 0.07, midZ, { t: 0.18, rx: ang, ry: sz < 0 ? Math.PI : 0 });
      icicles(B, xl - 0.85, sz * (run + 0.26), xr + 0.85, sz * (run + 0.26), rb - 0.16, rnd, { max: 0.35 });
    }
  }
  B.box(K.ridge, rlen + 0.1, 0.16, 0.26, cx, rb + rise + 0.05, 0, { r: 0.05, rot: true, tint: K.ridge === 'rs_timber' ? wood : null });
  // gable ends: triangles of boards
  for (const sx of [-1, 1]) B.box('rs_timber', 0.08, rise, run * 2, cx + sx * (rlen / 2 - 0.35), rb + rise / 2, 0, { r: 0.015, tint: wood, div: [1, 2, 2], deform: q => { q[2] *= Math.max(0.02, 0.5 - q[1] / rise); } });
  if (K.extra === 'bones') {
    // a hide banner hung under the beam on the left
    B.box('rs_hide', 1.1, 1.5, 0.04, xl + 1.5, beamY - 0.95, -pz - 0.22, { r: 0.01, rz: 0.04, div: [2, 3, 1], deform: q => { q[2] += Math.sin(q[1] * 4) * 0.03; if (q[1] < -0.6) q[1] += Math.abs(q[0]) * 0.25; } });
  }
  // the station's carved board, hung slightly crooked on chains facing the road both ways
  B.box('rs_timber', 3.6, 0.95, 0.1, cx, beamY - 0.9, -pz - 0.06, { r: 0.03, rz: 0.035, faces: { nz: { m: 'rs_ranger_board', fit: true }, pz: { m: 'rs_ranger_board', fit: true } } });
  B.lod0 = true;
  for (const [sx, l] of [[-1, 0.5], [1, 0.43]]) for (let k = 0; k < 4; k++) B.torus('rs_iron', 0.035, 0.01, cx + sx * 1.4, beamY - 0.2 - k * l / 4, -pz - 0.06, { ry: k % 2 ? Math.PI / 2 : 0, seg: 6, tseg: 3 });
  B.lod0 = false;
}

function buildGateBars(B, g, ctx) {
  B.frame(0, -g.hy, 0, 0);
  const rnd = rngOf(seedOf(g.x, g.z, 23));
  const K = KIT[ctx.bio.kit] || KIT.timber;
  const hx = g.hx, H = g.hy * 2, hz = g.hz, wood = K.wood;
  // bay uprights at uneven spacing; between them a log palisade (Elwynn, Dun Morogh), ragged leaning stakes
  // (Badlands), gray barn boards (Westfall) or goblin riveted plates (Tanaris)
  const ups = [-hx + 0.22];
  while (ups[ups.length - 1] < hx - 2.6) ups.push(ups[ups.length - 1] + 2.75 * range(rnd, 0.75, 1.25));
  ups.push(hx - 0.22);
  const style = K.bars;
  for (const u of ups) {
    if (style === 'boards' || style === 'plates') B.box('rs_timber', 0.32, H + 0.12, hz * 2 + 0.04, u, (H + 0.12) / 2, 0, { r: 0.04, tint: wood, off: [rnd(), 0] });
    else {
      B.cyl('rs_timber', 0.19, 0.2, H + 0.1, u, (H + 0.1) / 2, 0, { seg: 9, caps: false, tint: wood, off: [rnd(), rnd()] });
      B.cyl('rs_timber', 0, 0.19, 0.32, u, H + 0.26, 0, { seg: 9, caps: false, tint: wood });
    }
  }
  if (style === 'logs' || style === 'stakes') {
    const rag = style === 'stakes';
    for (let x = -hx + 0.03; x < hx - 0.1;) {
      const dd = range(rnd, rag ? 0.2 : 0.25, rag ? 0.3 : 0.32), r = dd / 2, cxl = x + r;
      x += dd + (rag ? range(rnd, 0, 0.03) : 0.01);
      if (ups.some(u => Math.abs(u - cxl) < 0.2 + r)) continue;
      const h = H - range(rnd, rag ? -0.2 : 0, rag ? 0.35 : 0.18), tip = range(rnd, 0.22, 0.38), lean = range(rnd, -0.012, 0.012) * (rag ? 3 : 1);
      B.cyl('rs_timber', r * 0.96, r, h, cxl, h / 2, range(rnd, -0.015, 0.015), { seg: 7, caps: false, tint: wood.map(c => c * range(rnd, 0.9, 1.08)), off: [rnd(), rnd()], rz: lean });
      B.cyl('rs_timber', 0, r * 0.96, tip, cxl - Math.sin(lean) * (h + tip) / 2, h / 2 + Math.cos(lean) * (h + tip) / 2, 0, { seg: 7, caps: false, tint: wood, rz: lean });
    }
  } else if (style === 'boards') {
    // vertical barn boards on both faces, uneven tops, a few gaps and a missing one
    for (const sz of [-1, 1]) for (let x = -hx + 0.02; x < hx - 0.05;) {
      const w = range(rnd, 0.22, 0.34), cxl = x + w / 2;
      x += w + range(rnd, 0.005, 0.03);
      if (ups.some(u => Math.abs(u - cxl) < 0.16 + w / 2) || rnd() < 0.03) continue;
      const h = H - range(rnd, 0.02, 0.2);
      B.box('rs_planks_gray', w, h, 0.06, cxl, h / 2, sz * (hz - 0.06), { r: 0.012, rot: true, off: [rnd(), rnd()], tint: wood.map(c => c * range(rnd, 0.92, 1.06)), rz: range(rnd, -0.01, 0.01) });
    }
    B.box('rs_timber', hx * 2, H - 0.2, hz * 2 - 0.16, 0, (H - 0.2) / 2, 0, { r: 0.02, tint: [0.4, 0.38, 0.38] });
  } else {
    // riveted goblin plates in a timber frame, spikes along the top
    for (let i = 0; i < ups.length - 1; i++) {
      const x0 = ups[i] + 0.16, x1 = ups[i + 1] - 0.16, w = x1 - x0;
      B.box(i % 2 ? 'rs_steel_teal' : 'rs_steel_mustard', w, H - 0.1, hz * 2 - 0.04, (x0 + x1) / 2, (H - 0.1) / 2, 0, { r: 0.03, fit: 'v', S: 2, off: [rnd(), 0], div: [4, 2, 1], smoothN: true, deform: q => { q[2] += Math.sin(Math.PI * (q[0] / w + 0.5)) * Math.sin(Math.PI * (q[1] / (H - 0.1) + 0.5)) * 0.02 * Math.sign(q[2]); } });
    }
    for (let x = -hx + 0.3; x < hx - 0.2; x += range(rnd, 0.42, 0.62)) B.cyl('rs_iron', 0, 0.06, 0.34, x, H + 0.1, 0, { seg: 6, caps: false, lod0: false });
  }
  // rails across both faces, strapped to the uprights
  const railY = [0.55, 2.55];
  for (const sz of [-1, 1]) for (const yy of railY) {
    B.box('rs_timber', hx * 2 - 0.05, 0.24, 0.1, 0, yy + range(rnd, -0.03, 0.03), sz * (hz + 0.03), { r: 0.04, rot: true, tint: wood, off: [rnd(), 0], jit: 0.02 });
    for (const u of ups) {
      if (K.band === 'rs_rope') B.box('rs_rope', 0.2, 0.32, 0.06, u, yy, sz * (hz + 0.09), { r: 0.02, lod0: true });
      else { B.box(K.band, 0.42, 0.3, 0.025, u, yy, sz * (hz + 0.09), { r: 0.008 }); for (const ox of [-0.13, 0.13]) B.cyl(K.band, 0.03, 0.03, 0.03, u + ox, yy, sz * (hz + 0.11), { rx: Math.PI / 2, seg: 6 }); }
    }
  }
  // Z-braces in some bays on the far face
  for (let i = 0; i < ups.length - 1; i++) {
    if (rnd() < 0.4) continue;
    const x0 = ups[i] + 0.22, x1 = ups[i + 1] - 0.22, dx = x1 - x0, dy = railY[1] - railY[0] - 0.2, len = Math.hypot(dx, dy), a = Math.atan2(dy, dx) * (i % 2 ? -1 : 1);
    B.box('rs_timber', len, 0.18, 0.07, (x0 + x1) / 2, (railY[0] + railY[1]) / 2, hz + 0.04, { rz: a, rot: true, r: 0.02, tint: wood });
  }
  // separate warning boards nailed on, chevrons pointing in at the carved STOP board in the middle
  const boardY = 1.62;
  B.box('rs_timber', 1.5, 0.62, 0.06, 0, boardY, -hz - 0.05, { r: 0.015, rz: range(rnd, -0.03, 0.03), faces: { nz: { m: 'rs_stop', fit: true } } });
  B.box('rs_timber', 1.5, 0.62, 0.06, 0, boardY, hz + 0.05, { r: 0.015, rz: range(rnd, -0.03, 0.03), faces: { pz: { m: 'rs_stop', fit: true } } });
  for (const sz of [-1, 1]) for (const side of [-1, 1]) {
    let x = side * 1.0;
    const n = sz < 0 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const w = range(rnd, 1.6, 2.4), xc = x + side * (w / 2 + range(rnd, 0.3, 1.6));
      if (Math.abs(xc) + w / 2 > hx - 0.3) break;
      const layout = rnd() < 0.5 ? 0 : 1, v0 = layout ? 0 : 0.5, v1 = layout ? 0.5 : 1;
      // which way the chevrons run depends on the face: point them at the middle
      const towardMinusX = side > 0, faceU = sz < 0 ? -1 : 1, flip = (towardMinusX ? -1 : 1) !== faceU;
      const rect = flip ? [1, v0, 0, v1] : [0, v0, 1, v1];
      B.box('rs_timber', w, 0.52, 0.05, xc, boardY + range(rnd, -0.12, 0.12), sz * (hz + 0.045), { r: 0.012, rz: range(rnd, -0.05, 0.05), tint: wood, faces: { [sz < 0 ? 'nz' : 'pz']: { m: 'rs_warn', fit: true, uvRect: rect, tint: [1, 1, 1] } } });
      x = xc + side * w / 2;
    }
  }
  // the hasp and padlock at the closing end
  B.box('rs_iron', 0.32, 0.4, 0.06, -hx + 0.22, 1.55, -hz - 0.1, { r: 0.015 });
  B.box(K.band === 'rs_brass' ? 'rs_brass' : 'rs_iron', 0.17, 0.2, 0.08, -hx + 0.22, 1.38, -hz - 0.16, { r: 0.03, tint: [1.3, 1.15, 0.8] });
  B.torus('rs_iron', 0.06, 0.018, -hx + 0.22, 1.5, -hz - 0.16, { seg: 10, tseg: 5 });
  if (ctx.snow) {
    for (const sz of [-1, 1]) {
      snowCap(B, hx * 2 - 0.1, 0.1, 0, railY[1] + 0.12, sz * (hz + 0.03), { t: 0.07, lip: 0.03, ext: 0.03, lod0: true });
      icicles(B, -hx + 0.3, sz * (hz + 0.08), hx - 0.3, sz * (hz + 0.08), railY[1] - 0.12, rnd, { max: 0.22 });
    }
  }
}

function buildKeypad(B, s, u, ctx) {
  const gy = ctx.H(s.x, s.z);
  B.frame(s.x, gy, s.z, 0);
  const K = KIT[ctx.bio.kit] || KIT.timber, kit = ctx.bio.kit;
  const top = s.y + s.hy - gy, h = top + 0.55;
  if (K.post === 'pier') B.box('rs_stone', s.hx * 2 + 0.04, h, s.hz * 2 + 0.04, 0, h / 2 - 0.12, 0, { r: 0.04, jit: 0.02, tint: STONE_TINT[kit] });
  else B.box('rs_timber', s.hx * 2, h, s.hz * 2, 0, h / 2 - 0.12, 0, { r: 0.03, tint: K.wood });
  const baseMat = K.foot || (K.post === 'pier' ? 'rs_stone' : 'rs_rock');
  B.box(baseMat, 0.54, 0.32, 0.54, 0, 0.06, 0, { r: 0.08, jit: 0.05, tint: STONE_TINT[kit] });
  B.cyl(K.band === 'rs_rope' ? 'rs_iron' : K.band, 0.02, 0.18, 0.12, 0, h - 0.06, 0, { seg: 4, ry: Math.PI / 4 });
  if (K.band === 'rs_rope') lashing(B, 0, 0.55, 0, 0.12, 2);
  else for (const yy of [0.5, top - 0.1]) B.box(K.band, s.hx * 2 + 0.04, 0.07, s.hz * 2 + 0.04, 0, yy, 0, { r: 0.01 });
  if (u) {
    const kx = u.x - s.x, ky = u.y - gy, kz = u.z - s.z;
    B.box('rs_brass', 0.38, 0.48, 0.1, kx, ky, kz + 0.03, { r: 0.02, faces: { nz: { m: 'rs_keypad', fit: true } } });
    B.box('rs_brass', 0.46, 0.04, 0.22, kx, ky + 0.29, kz - 0.01, { rx: -0.35, r: 0.01 });
    B.cyl('rs_brass', 0.022, 0.022, ky - 0.1, s.hx + 0.03, (ky - 0.1) / 2, 0, { seg: 5, caps: false });
    B.box('rs_brass', 0.06, 0.06, 0.06, s.hx + 0.03, ky - 0.1, 0);
  }
  if (ctx.snow) B.ell('rs_snow!', 0.2, 0.08, 0.2, 0, h - 0.04, 0, { seg: 8, rings: 4, noAO: true });
}

// winch anchor posts: thick posts with an iron collar and a shackle ring facing the road, boulders round the foot
function buildAnchor(B, c, anchor, ctx) {
  const base = c.y - c.hh;
  B.frame(c.x, base, c.z, (seedOf(c.x, c.z) % 628) / 100);
  const rnd = rngOf(seedOf(c.x, c.z, 31));
  const K = KIT[ctx.bio.kit] || KIT.timber, kit = ctx.bio.kit;
  const H = c.hh * 2, r = c.r;
  let capY = H + 0.05;
  if (K.post === 'square') {
    B.box('rs_timber', r * 2, H + 0.4, r * 2, 0, (H + 0.4) / 2 - 0.35, 0, { r: 0.04, taper: 0.92, tint: K.wood, jit: 0.02 });
    B.box('rs_chevband', r * 2 + 0.012, 0.34, r * 2 + 0.012, 0, 0.72, 0, { r: 0.01, fit: true });
  } else if (K.post === 'pier') {
    B.cyl('rs_stone', r * 1.05, r * 1.18, H + 0.3, 0, (H + 0.3) / 2 - 0.3, 0, { seg: 10, bevel: 0.03, caps: 'rs_stone', S: 1.2, tint: STONE_TINT.dwarf, jit: 0.01 });
    B.lathe('rs_iron', [[r * 1.12, 0], [r * 1.15, 0.06], [r * 0.9, 0.16], [0.05, 0.22], [0, 0.22]], 0, H - 0.25, 0, { seg: 10 });
    capY = H - 0.05;
    B.cyl('rs_chevband', r * 1.12, r * 1.12, 0.3, 0, 0.72, 0, { seg: 10, caps: false, fit: true });
  } else {
    B.cyl('rs_timber', r, r * 1.08, H + 0.45, 0, (H + 0.45) / 2 - 0.3, 0, { seg: 10, bevel: 0.03, caps: 'rs_logend', jit: 0.01, tint: K.wood });
    if (K.post !== 'bundle') B.cyl('rs_chevband', r + 0.008, r + 0.012, 0.34, 0, 0.72, 0, { seg: 10, caps: false, fit: true });
    capY = H + 0.15;
  }
  if (K.post === 'bundle') { lashing(B, 0, 0.5, 0, r, 3); lashing(B, 0, H - 0.45, 0, r, 2); skull(B, 0, H + 0.24, 0, rnd() * 3, 0.9); }
  else if (K.band === 'rs_brass') { for (const yy of [0.3, H - 0.25]) B.cyl('rs_brass', r + 0.025, r + 0.025, 0.1, 0, yy, 0, { seg: 10, caps: false }); B.cyl('rs_brass', r + 0.02, r * 0.7, 0.1, 0, H + 0.2, 0, { seg: 10 }); }
  else if (K.post !== 'pier' && K.post !== 'square') for (const yy of [0.32, H - 0.3]) B.cyl('rs_iron', r + 0.02, r + 0.02, 0.09, 0, yy, 0, { seg: 10, caps: false });
  if (K.foot === 'rs_adobe') B.mound('rs_adobe', r + 0.32, 0.3, r + 0.32, 0, -0.06, 0, { jit: 0.04, seg: 10, rings: 3 });
  const ay = anchor ? anchor.y - base : H - 0.15;
  B.torus('rs_iron', r + 0.06, 0.045, 0, ay, 0, { rx: Math.PI / 2, seg: 14, lod0: false });
  // the shackle ring, on the side facing the road
  const roadX = ctx.W.roadX ? ctx.W.roadX(c.z) : c.x;
  const dirW = Math.sign(roadX - c.x) || 1;
  const lp = B.loc({ x: c.x + dirW, y: base, z: c.z });
  const a = Math.atan2(lp.x, lp.z);
  B.push(M4(0, ay - 0.02, 0, 0, a, 0));
  B.box('rs_iron', 0.1, 0.12, 0.1, 0, 0, r + 0.07, { r: 0.02 });
  B.torus('rs_iron', 0.12, 0.032, 0, -0.1, r + 0.15, { ry: Math.PI / 2, seg: 14, lod0: false });
  B.pop();
  // two or three boulders of different sizes, sunk and tilted
  const sizes = [0.35, 0.22, 0.15].slice(0, 2 + (rnd() < 0.5 ? 1 : 0));
  let t0 = rnd() * TAU;
  for (const sz of sizes) {
    const t = t0 + range(rnd, 1.6, 2.6), rr = r + sz * 0.75;
    t0 = t;
    B.ell('rs_rock', sz * range(rnd, 1.0, 1.25), sz * range(rnd, 0.7, 0.9), sz, Math.cos(t) * rr, sz * 0.25, Math.sin(t) * rr, { seg: 10, rings: 6, ry: rnd() * 3, rx: range(rnd, -0.3, 0.3), rz: range(rnd, -0.3, 0.3), jit: 0.08 });
  }
  if (ctx.snow) B.ell('rs_snow!', r * 1.1, 0.12, r * 1.1, 0, capY, 0, { seg: 10, rings: 4, noAO: true });
  if (ctx.driftMat) drift(B, ctx, -0.12, 0, 0.45, 0.4, 0.2, 0);
}

// camp seats: bowed bark logs with an adzed seat (hay bales in Westfall, a plank bench on crates in Tanaris)
function buildLog(B, s, ctx) {
  const gy = ctx.H(s.x, s.z);
  B.frame(s.x, gy, s.z, s.ry || 0);
  const rnd = rngOf(seedOf(s.x, s.z, 41));
  const seat = ctx.bio.seat;
  if (seat === 'hay') { haybale(B, 0, -0.04, 0, s.hx * 2, s.hy * 2 + 0.04, s.hz * 2 + 0.02); return; }
  if (seat === 'bench') {
    for (const sx of [-1, 1]) B.box(pick(rnd, ['rs_crate_a', 'rs_crate_b']), 0.36, s.hy * 2 - 0.08, s.hz * 2, sx * (s.hx - 0.2), (s.hy * 2 - 0.08) / 2, 0, { r: 0.03, ry: range(rnd, -0.08, 0.08) });
    B.box('rs_planks', s.hx * 2, 0.08, s.hz * 2, 0, s.hy * 2 - 0.04, 0, { r: 0.015, rot: false, off: [rnd(), 0] });
    for (const sx of [-1, 1]) B.box('rs_rope', 0.05, 0.1, s.hz * 2 + 0.02, sx * (s.hx - 0.2), s.hy * 2 - 0.04, 0, { r: 0.02 });
    return;
  }
  const r = Math.min(s.hy, s.hz + 0.02), Lg = s.hx * 2, bowZ = range(rnd, 0.08, 0.12) * (rnd() < 0.5 ? -1 : 1), tint = ctx.bio.bark;
  const pts = [], radii = [];
  for (let k = 0; k <= 8; k++) { const u = k / 8, x = -Lg / 2 + Lg * u; pts.push(V(x, r, bowZ * (1 - (2 * u - 1) ** 2) - bowZ * 0.5)); radii.push(r * (1 + 0.1 * Math.sin(u * 5.3 + rnd() * 0.5) - 0.04 * u)); }
  B.tube('rs_bark', pts, radii, { seg: 12, ends: 'rs_logend', tint, off: [rnd(), rnd()] });
  // the adzed seat along the top, knot stubs, a broken branch
  B.grid('rs_planks', 8, 1, (u, v) => { const k = Math.min(8, Math.floor(u * 8)), q = pts[k].clone().lerp(pts[Math.min(8, k + 1)], u * 8 - k); return [q.x * 0.82, r * 1.84 + 0.005, q.z * 0.82 + (v - 0.5) * r * 1.0]; }, { flip: true, uv: (u, v, q) => [q[0], q[2] * 2], noAO: false });
  for (let k = 0; k < 2 + (rnd() < 0.5 ? 1 : 0); k++) {
    const u = range(rnd, 0.15, 0.85), q = pts[Math.round(u * 8)], a0 = range(rnd, 0.35, 1.1), a = rnd() < 0.5 ? a0 : Math.PI - a0;
    B.cyl('rs_bark', 0.035, 0.06, 0.12, q.x, q.y + Math.sin(a) * r * 0.95, q.z + Math.cos(a) * r * 0.95, { rx: Math.PI / 2 - a, seg: 6, caps: 'rs_logend', tint });
  }
  if (ctx.snow) { B.push(M4(0, 0, 0, 0, 0, 0, 1, 0.45, 1)); B.tube('rs_snow!', pts.map(q => V(q.x * 0.9, (r * 1.95 + 0.03) / 0.45, q.z)), 0.11, { seg: 8, noAO: true }); B.pop(); }
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
  B.box('rs_glass', hx * 2 - 0.42, 0.72, 0.04, 0, 1.9, hz + 0.005, { r: 0.01, uvRect: [0, 0, 0.5, 1] });
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
    snowCap(B, hx * 2 - 0.3, hz * 2 - 0.3, 0, top - 0.02, 0, { t: 0.2 });
    for (const sx of [-1, 1]) icicles(B, sx * (hx + 0.03), -hz + 0.3, sx * (hx + 0.03), hz - 0.3, top - 0.08, rnd, { max: 0.3 });
  }
  if (ctx.driftMat) { drift(B, ctx, -hx - 0.1, 0.5, 0.6, 3.2, ctx.snow ? 0.5 : 0.36, 0); drift(B, ctx, hx + 0.1, -2.2, 0.45, 1.3, 0.26, 0); }
}

// ---- assembly ----------------------------------------------------------------------------------------------

function makeCtx(W) {
  const biome = BIO[W.biome] ? W.biome : 'meadow';
  const bio = BIO[biome];
  return {
    W, biome, bio, H: (x, z) => W.heightAt(x, z), ao: bio.ao, aoH: 0.9,
    snow: biome === 'snow', driftMat: bio.drift, cover: bio.cover, smokes: [],
  };
}

// Cartoon smoke: soft painted puff billboards that rise, swell, drift downwind and fade, animated on the GPU:
// one draw call per wreck, nothing to update per frame but the clock.
const PUFFS = 20;
const SMOKE_T = { value: 0 };
let SMOKE_MAT = null;
function smokeMat() {
  if (SMOKE_MAT) return SMOKE_MAT;
  const m = new THREE.MeshLambertMaterial({ map: tex('rs_puff'), transparent: true, depthWrite: false, emissive: new THREE.Color('#5a5660') });
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = SMOKE_T;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aPuff; attribute vec3 aOrigin; uniform float uTime; varying float vPuffK;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n transformedNormal = normalize(mat3(viewMatrix) * vec3(0.0, 0.75, 0.0) + vec3(0.0, 0.0, 0.6));')
      .replace('#include <project_vertex>', `
        float pk = fract(uTime * 0.075 + aPuff.x);
        vec3 pc = aOrigin + vec3(aPuff.z * pk * pk * 3.5 + sin(aPuff.x * 40.0 + uTime * 0.7) * 0.15, pk * 9.0, aPuff.w * pk * pk * 3.5 + cos(aPuff.x * 31.0 + uTime * 0.6) * 0.15);
        float psc = mix(0.6, 2.6, sqrt(pk));
        float prot = aPuff.y + uTime * 0.25 * (fract(aPuff.x * 7.0) - 0.5);
        vec2 pq = mat2(cos(prot), sin(prot), -sin(prot), cos(prot)) * position.xy * psc;
        vec4 mvPosition = modelViewMatrix * vec4(pc, 1.0);
        mvPosition.xy += pq;
        gl_Position = projectionMatrix * mvPosition;
        vPuffK = pk;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPuffK;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= mix(vec3(0.34, 0.32, 0.33), vec3(1.0, 0.98, 0.95), smoothstep(0.02, 0.4, vPuffK));
        diffuseColor.a *= 0.7 * smoothstep(0.0, 0.06, vPuffK) * (1.0 - smoothstep(0.75, 1.0, vPuffK));`);
  };
  m.customProgramCacheKey = () => 'rs-smoke';
  return SMOKE_MAT = m;
}
function makeSmoke(at, seed) {
  const pg = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = pg.index;
  for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, pg.attributes[k]);
  const r = rngOf(seed), wind = r() * TAU, puff = new Float32Array(PUFFS * 4), org = new Float32Array(PUFFS * 3);
  for (let i = 0; i < PUFFS; i++) {
    puff.set([i / PUFFS + range(r, -0.02, 0.02), r() * TAU, Math.cos(wind), Math.sin(wind)], i * 4);
    org.set([at.x + range(r, -0.12, 0.12), at.y, at.z + range(r, -0.12, 0.12)], i * 3);
  }
  g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puff, 4));
  g.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(org, 3));
  g.instanceCount = PUFFS;
  g.boundingSphere = new THREE.Sphere(V(at.x + Math.cos(wind) * 1.8, at.y + 5, at.z + Math.sin(wind) * 1.8), 7.5);
  g.boundingBox = new THREE.Box3(V(at.x - 1.5, at.y, at.z - 1.5), V(at.x + 1.5, at.y + 3, at.z + 1.5));
  const m = new THREE.Mesh(g, smokeMat());
  m.castShadow = false; m.receiveShadow = false; m.renderOrder = 2; m.name = 'rs:smoke';
  return { mesh: m, at };
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
    B.lod0 = false; B.shelter = false;
    finish(B, ctx, group, clusters);
  }

  // gates (static arch + sliding barrier) and their keypads
  const keypadPosts = loose.filter(s => s.part === 'keypad_post');
  const usedPosts = new Set();
  for (const g of W.gates || []) {
    const S = new Builder(ctx);
    try { buildGateStatic(S, g, ctx); } catch (e) { console.warn('roadside: gate failed', e); }
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
    try { buildGateBars(Bb, g, ctx); } catch (e) { console.warn('roadside: gate bars failed', e); }
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

  const smokes = ctx.smokes.map((at, i) => makeSmoke(at, seedOf(at.x, at.z, i)));
  for (const s of smokes) group.add(s.mesh);

  const _c = new V3();
  return {
    group, gates,
    update(dt, t, camPos) {
      SMOKE_T.value = t || 0;
      for (const s of smokes) s.mesh.visible = camPos ? s.at.distanceTo(camPos) < 1000 : true;
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
// the stop is turned so its own frame faces the preview camera (local +z toward yaw 0); rot turns it further
function previewStop(type, rot = 0, only = null) {
  return ({ biome = 'meadow' } = {}) => {
    const f = findLeg(W => W.pois.find(p => p.type === type));
    if (!f) return null;
    const { W, hit: p } = f;
    const W2 = previewWorld(W, biome, { statics: s => s.poi === p.id && isRoadside(s) && (!only || only(s)), decor: d => Math.hypot(d.x - p.x, d.z - p.z) < 16 && (!only || only(d)) });
    const r = buildRoadside(W2);
    r.update(0, 6, null);
    const fr = p.trailer || p.dino || (W2.decor.find(d => d.k === 'plane')) || p;
    r.group.position.set(-fr.x, -(p.y ?? W.heightAt(p.x, p.z)), -fr.z);
    const g = new THREE.Group(); g.add(r.group);
    g.rotation.y = -(fr.ry || 0) + rot;
    const out = new THREE.Group(); out.add(g);
    return out;
  };
}
export const PREVIEW = {
  rs_semi: previewStop('semi'), rs_yard: previewStop('yard'), rs_crash: previewStop('crash'),
  rs_junk: previewStop('junk'), rs_gas: previewStop('gas'), rs_dino: previewStop('dino'),
  rs_cab: previewStop('semi', 0, s => s.part === 'cab' || s.part === 'trailer_front'), rs_pumps: previewStop('gas', 0, s => s.part === 'pump'), rs_hitch: previewStop('semi', Math.PI / 2, s => s.part === 'cab' || s.part === 'trailer_front' || s.part === 'trailer_floor'),
  rs_semi_side: previewStop('semi', Math.PI / 2), rs_semi_rear: previewStop('semi', Math.PI), rs_crash_side: previewStop('crash', Math.PI / 2),
  rs_dino_side: previewStop('dino', -Math.PI / 2), rs_gas_side: previewStop('gas', Math.PI / 2), rs_yard_side: previewStop('yard', Math.PI / 2),
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
    if (!f) return null;
    const { W, hit: c } = f;
    const W2 = previewWorld(W, biome, { cyls: q => q === c });
    const r = buildRoadside(W2);
    r.group.position.set(-c.x, -(c.y - c.hh), -c.z);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
  rs_logs: ({ biome = 'meadow' } = {}) => {
    const f = findLeg(() => true);
    if (!f) return null;
    const { W } = f;
    const W2 = previewWorld(W, biome, { statics: s => s.part === 'log_seat' });
    const r = buildRoadside(W2);
    const fx = W.camp.fire.x, fz = W.camp.fire.z;
    r.group.position.set(-fx, -W.heightAt(fx, fz), -fz);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
  rs_parkedrv: ({ biome = 'meadow' } = {}) => {
    const f = findLeg(() => true);
    if (!f) return null;
    const s0 = f.W.statics.find(s => s.part === 'parked_rv');
    if (!s0) return null;
    const W2 = previewWorld(f.W, biome, { statics: s => s === s0 });
    const r = buildRoadside(W2);
    r.group.position.set(-s0.x, -(s0.y - s0.hy), -s0.z);
    const out = new THREE.Group(); out.add(r.group);
    return out;
  },
};
