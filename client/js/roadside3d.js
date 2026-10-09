// Roadside: everything along the road that isn't nature or a building. The
// stops' furniture (statics tagged s.poi: semi trailers, yard-sale tables, the
// crashed plane, junk piles, gas pumps and counter, the dino statue), the
// gas canopy, umbrella, plane and wheel decor, the ranger gates and keypads,
// the winch anchor posts, the camp's log seats and the parked RVs in town.
//
// The look is WoW Classic goblin/human junk: chunky shapes with smooth shading
// (bulged, bowed, dented, tapered: nothing is a perfect box), every surface
// painted (paint/roadside.js), AO and ground grime baked into vertex colours.
// Each biome has its own construction kit (half-timber, red shingles and log
// palisades in Elwynn; barn boards and stepped thatch in Westfall; granite,
// slate, iron-banded beams and braziers in Dun Morogh; bleached stakes, rope,
// hides and bones in the Badlands; brass, striped canvas and adobe in Tanaris)
// plus its weather: snow caps, clustered icicles and drifts in the pass, red
// dust in the badlands, sand in the desert. A world-space top-cover shader lays
// that weather on up-facing surfaces, broken up by noise, tuned per material
// class (curved things only along the top, cloth keeps its pattern), and never
// on sheltered ones (inside the trailer, under the counter's roof). Mounds and
// drifts are draped on the ground in the terrain's own textures.
//
// Geometry is generated into per-material buckets and merged: one mesh per
// (cluster, material), where a cluster is one stop / gate / anchor pair / camp /
// RV lot. Label textures share atlases so they cost no extra draw calls. Each
// cluster also has a one-draw-call far LOD (vertex colours = the painted
// texture's average, small trim left out). The crash smoke is one billboarded,
// GPU-animated draw call per wreck.
// API: buildRoadside(W) -> { group, gates, update(dt, t, camPos) }, isRoadside(s), PREVIEW.
import { THREE, tex } from './gfx.js';
import { canvasFor, has } from './paint/index.js';
import { generateLeg } from '/shared/world.js';
import * as TERRAIN from './terrain3d.js';

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
  rs_fascia: 4, rs_shingles: 1.2, rs_slats: 2, rs_dino: 6, rs_canvas: 3, rs_canvas_blue: 3, rs_canvas_plain: 3, rs_slate: 1.4, rs_hide: 1.6,
  rs_adobe: 2, rs_burlap: 0.9, rs_plaid: 0.9, rs_rope: 0.4, rs_rock: 1.4, rs_hay: 1, rs_bone: 0.6,
  rs_bleach: 1.5, rs_plaster: 1.8, rs_shingles_red: 1.2, rs_thatch: 1.3, rs_rv_green: 3, rs_rv_rust: 3, rs_rv_blue: 3, rs_rv_skins: 3,
  ground_meadow: 7, ground_fields: 7, ground_snow: 8, ground_badlands: 7, ground_desert: 7, dirt_meadow: 6, dirt_fields: 6, dirt_snow: 6, dirt_badlands: 6, dirt_desert: 6,
};
const FIT = new Set(['rs_blanket', 'rs_hub', 'rs_hub_cream', 'rs_glass', 'rs_grille', 'rs_crate_a', 'rs_crate_b', 'rs_crate_c', 'rs_barrel', 'rs_barrel_lid', 'rs_drum',
  'rs_drum_red', 'rs_drum_lid', 'rs_pump_face', 'rs_keypad', 'rs_logend', 'rs_rv_window', 'rs_boards', 'rs_headlamp', 'rs_ice', 'rs_decal_freight', 'rs_ranger_board',
  'rs_plaque', 'rs_roundel', 'rs_warn', 'rs_stop', 'rs_chevband', 'rs_pennant', 'rs_gasboard', 'rs_bunting', 'rs_tuft', 'rs_tuft_dry', 'rs_scorch', 'rs_shield', 'rs_rune', 'rs_glow', 'rs_gatelabels',
  'rs_gasbag', 'rs_junkboard', 'rs_plane']);
// flags on a material name: ! no top cover, * glows, ~ double-sided, # alpha-tested decal (no shadow, no LOD),
// % soft transparent decal lying on the ground (no shadow, no LOD), ^ alpha-tested cut-out (keeps its shadow and LOD)
const baseName = m => m.replace(/[!*~#%^]+$/, '');
const densOf = m => { const b = baseName(m); return b.startsWith('rs_steel_') ? 2 : (DENS[b] || 1); };
const NO_SHADOW = /^(ground_\w+|dirt_\w+|rs_gatelabels|rs_glow|rs_tuft|rs_tuft_dry|rs_scorch|rs_bunting|rs_shield|rs_gasboard|rs_blanket|rs_glass|rs_headlamp|rs_keypad|rs_decal_freight|rs_ice|rs_logend|rs_hub|rs_hub_cream|rs_pump_face|rs_rv_window|rs_boards|rs_plaque|rs_roundel|rs_grille|rs_ranger_board|rs_barrel_lid|rs_drum_lid|rs_chevband|rs_rope|rs_bone|rs_pennant|rs_stop|rs_junkboard)$/;
// the most weather any one material takes (glass and wing fabric stay readable under the dust)
const COVER_CAP = { rs_dino: 0.3, rs_wing: 0.35, rs_plane: 0.5, rs_glass: 0.25, rs_rv_window: 0.25, rs_canvas: 0.5, rs_canvas_blue: 0.5, rs_canvas_plain: 0.5, rs_hide: 0.6, rs_gingham: 0.6, rs_burlap: 0.6, rs_gasbag: 0.5 };
// Material classes for the cover: curved things (logs, barrels, the dino) only take it right along the top;
// cloth keeps most of its pattern (the cover breaks up hard on it); stone stays stone under the sand.
const CURVED = new Set(['rs_bark', 'rs_barrel', 'rs_drum', 'rs_drum_red', 'rs_dino', 'rs_tire', 'rs_rope', 'rs_hay', 'rs_bone', 'rs_bleach', 'rs_plane']);
const CLOTH = new Set(['rs_gingham', 'rs_burlap', 'rs_plaid', 'rs_hide', 'rs_canvas', 'rs_canvas_blue', 'rs_canvas_plain', 'rs_blanket', 'rs_wing', 'rs_thatch', 'rs_gasbag']);
const MASONRY = new Set(['rs_stone', 'rs_adobe', 'rs_rock']);
function coverOf(base, ctx) {
  const C = ctx.cover;
  let { lo, hi, brk, low, amt } = C, cap = COVER_CAP[base] ?? 1;
  if (CURVED.has(base)) { lo = 0.72; hi = 0.9; cap = Math.min(cap, 0.45); }
  if (CLOTH.has(base)) { cap = Math.min(cap, ctx.snow ? 0.55 : 0.2); brk = 1.4; }
  if (MASONRY.has(base) && !ctx.snow) cap = Math.min(cap, 0.3);
  return { lo, hi, noise: C.noise, scale: C.scale, brk, low, amt: Math.min(amt, cap), cap, edge: C.edge || 0, rim: C.rim || 0 };
}

// Per-biome: ground grime (vertex AO tint), drifts, the top cover, paint schemes and the construction kit.
//   cover: lo/hi = up-facing threshold, noise = how much the breakup alpha moves it, scale = world → cover uv,
//          amt = the most it covers, brk = how much the breakup noise thins it out, low = extra cover on low tops,
//          edge = the cool shadow a thick layer casts just under where it ends on a curved surface, rim = blue on its rolled rim
const BIO = {
  meadow: { ao: [0.6, 0.6, 0.48], ground: 'dirt_meadow!', drift: null, tuft: 'rs_tuft#~', cover: null,
    semi: [['rs_steel_red', 'rs_steel_blue'], ['rs_steel_cream', 'rs_steel_green']], dino: [1, 1, 1],
    kit: 'timber', pump: 'rs_steel_red', canopy: 'rs_tin_red', cloth: 'rs_gingham~', umbrella: 'rs_canvas~', seat: 'log', bark: [1, 1, 1] },
  fields: { ao: [0.74, 0.66, 0.5], ground: 'dirt_fields!', drift: null, tuft: 'rs_tuft_dry#~', cover: { tex: 'rs_cover_sand', lo: 0.7, hi: 0.95, noise: 0.8, scale: 0.4, amt: 0.25, brk: 1, low: 0.2 },
    semi: [['rs_steel_red', 'rs_steel_mustard'], ['rs_steel_cream', 'rs_steel_green']], dino: [1, 0.97, 0.9],
    kit: 'barn', pump: 'rs_steel_green', canopy: 'rs_tin', cloth: 'rs_burlap~', umbrella: 'rs_canvas~', seat: 'hay', bark: [0.95, 0.92, 0.85] },
  snow: { ao: [0.68, 0.76, 0.92], ground: 'ground_snow!', drift: 'ground_snow!', tuft: null, cover: { tex: 'rs_cover_snow', lo: 0.42, hi: 0.66, noise: 1.0, scale: 0.45, amt: 1, brk: 0.25, low: 0, edge: 0.55, rim: 0.5 },
    semi: [['rs_steel_blue', 'rs_steel_red'], ['rs_steel_cream', 'rs_steel_teal']], dino: [0.92, 0.96, 1],
    kit: 'dwarf', pump: 'rs_steel_blue', canopy: 'rs_slate', cloth: 'rs_plaid~', umbrella: 'rs_canvas_blue~', seat: 'log', bark: [0.82, 0.82, 0.9] },
  badlands: { ao: [0.9, 0.56, 0.4], ground: 'ground_badlands!', drift: 'ground_badlands!', tuft: null, cover: { tex: 'rs_cover_dust', lo: 0.6, hi: 0.92, noise: 0.9, scale: 0.4, amt: 0.5, brk: 1, low: 0.2 },
    semi: [['rs_steel_mustard', 'rs_steel_teal'], ['rs_steel_cream', 'rs_steel_red']], dino: [1, 0.94, 0.86],
    kit: 'frontier', pump: 'rs_steel_mustard', canopy: 'rs_tin', cloth: 'rs_hide~', umbrella: 'rs_canvas~', seat: 'log', bark: [1.3, 1.18, 1.05] },
  desert: { ao: [0.98, 0.84, 0.6], ground: 'ground_desert!', drift: 'ground_desert!', tuft: null, cover: { tex: 'rs_cover_sand', lo: 0.6, hi: 0.92, noise: 0.9, scale: 0.35, amt: 0.5, brk: 1, low: 0.15 },
    semi: [['rs_steel_teal', 'rs_steel_red'], ['rs_steel_mustard', 'rs_steel_blue']], dino: [1, 0.96, 0.88],
    kit: 'goblin', pump: 'rs_steel_teal', canopy: 'rs_canvas_blue', cloth: 'rs_canvas_blue~', umbrella: 'rs_canvas~', seat: 'bench', bark: [1.1, 1.05, 0.95] },
};
// Ranger-gate / anchor / keypad construction per kit
const KIT = {
  timber: { wood: [1, 1, 1], woodMat: 'rs_timber', wall: 'rs_plaster', band: 'rs_iron', post: 'log', bars: 'logs', roof: 'rs_shingles_red', roofTint: null, ridge: 'rs_timber', light: 'lantern', foot: 'rs_stone', extra: null },
  barn: { wood: [0.9, 0.88, 0.9], woodMat: 'rs_timber', wall: 'rs_planks_gray', wallRot: true, band: 'rs_iron', post: 'square', bars: 'boards', roof: 'rs_thatch', thatch: true, roofTint: null, ridge: 'rs_timber', light: 'lantern', foot: 'rs_stone', extra: 'hay' },
  dwarf: { wood: [0.86, 0.85, 0.92], woodMat: 'rs_timber', wall: 'rs_stone', band: 'rs_iron', post: 'pier', bars: 'beams', roof: 'rs_slate', roofTint: null, ridge: 'rs_iron', light: 'brazier', foot: null, extra: null },
  frontier: { wood: [1, 1, 1], woodMat: 'rs_bleach', wall: 'rs_hide', band: 'rs_rope', post: 'bundle', bars: 'stakes', roof: 'rs_tin', roofTint: [1.12, 0.86, 0.7], ridge: 'rs_bleach', light: 'torch', foot: null, extra: 'bones' },
  goblin: { wood: [1.08, 0.98, 0.88], woodMat: 'rs_timber', wall: 'rs_adobe', band: 'rs_brass', post: 'brass', bars: 'plates', roof: 'rs_canvas', roofTint: null, ridge: 'rs_brass', light: 'lantern', foot: 'rs_adobe', extra: null },
};
const STONE_TINT = { dwarf: [0.8, 0.88, 1.02] };
// where each label sits in the rs_gatelabels atlas (uv rects)
const LBL = { ranger: [0, 2 / 3, 1, 1], warn0: [0, 0.5, 0.5, 2 / 3], warn1: [0, 1 / 3, 0.5, 0.5], stop: [0.5, 5 / 12, 1, 2 / 3], keypad: [0.5, 0, 0.75, 5 / 12] };
// The flying machine's airframe atlas (paint/roadside.js rs_plane, 512 x 512): rects in canvas px, y down (the barrel
// and trim rects are pulled in off their edges so mipmaps don't bleed the neighbours in). PLANE_JOINT is where the
// hull's canvas meets its metal nose (a fraction of its length); BAR_FIN0..1 is the finned stretch of a cylinder
// barrel (its radius along it), painted as seven fins on the barrel rect between y 14 and 119 of its 128.
const PL = 'rs_plane';
const PLR = { hull: [0, 0, 512, 248], cowl: [0, 256, 512, 376], barrel: [2, 384, 254, 512], face: [258, 386, 382, 510], trim: [390, 390, 506, 506] };
const PLANE_JOINT = 0.78, BAR_FIN0 = 0.33, BAR_FIN1 = 0.59;
const plUV = (R, u, vd) => [(R[0] + u * (R[2] - R[0])) / 512, 1 - (R[1] + vd * (R[3] - R[1])) / 512];
// a fitted face's uvRect: a sub-rect [u0, v0, u1, v1] (fractions of R, v down) of R
const plRect = (R, f = [0, 0, 1, 1]) => [(R[0] + f[0] * (R[2] - R[0])) / 512, 1 - (R[1] + f[3] * (R[3] - R[1])) / 512, (R[0] + f[2] * (R[2] - R[0])) / 512, 1 - (R[1] + f[1] * (R[3] - R[1])) / 512];

const MATS = new Map();
function rsMat(name, ctx) {
  const C = ctx.cover;
  const base = baseName(name), flags = name.slice(base.length);
  const useCover = C && !/[!*#%]/.test(flags);
  const key = name + '|' + (useCover ? ctx.biome : '');
  if (MATS.has(key)) return MATS.get(key);
  const m = new THREE.MeshLambertMaterial({
    map: tex(base), vertexColors: true,
    side: flags.includes('~') ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: flags.includes('#') || flags.includes('^') ? 0.5 : 0,
  });
  if (flags.includes('*')) { m.emissive = new THREE.Color('#ffcf88'); m.emissiveMap = m.map; m.emissiveIntensity = 0.55; }
  if (flags.includes('#') || flags.includes('%')) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4; }
  if (flags.includes('%')) { m.transparent = true; m.depthWrite = false; }
  if (useCover) {
    const P = coverOf(base, ctx);
    m.onBeforeCompile = sh => {
      sh.uniforms.uCoverMap = { value: tex(C.tex) };
      sh.uniforms.uCover = { value: new THREE.Vector4(P.lo, P.hi, P.noise, P.scale) };
      sh.uniforms.uCover2 = { value: new THREE.Vector4(P.brk, P.low, P.amt, P.cap) };
      sh.uniforms.uCover3 = { value: new THREE.Vector4(P.edge, P.rim, 0, 0) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 rsx; varying vec3 vRsW; varying vec3 vRsN; varying vec2 vRsX;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vRsW = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vRsN = normalize(mat3(modelMatrix) * objectNormal);
          vRsX = rsx;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRsW; varying vec3 vRsN; varying vec2 vRsX; uniform sampler2D uCoverMap; uniform vec4 uCover; uniform vec4 uCover2; uniform vec4 uCover3;')
        .replace('#include <lights_lambert_fragment>', `{
          vec4 cv = texture2D(uCoverMap, vRsW.xz * uCover.w);
          float up = normalize(vRsN).y;
          float kr = smoothstep(uCover.x, uCover.y, up + (cv.a - 0.6) * uCover.z);
          float amt = max(0.0, mix(1.0, smoothstep(0.35, 0.75, cv.a), uCover2.x));
          amt *= min(uCover2.w, uCover2.z + uCover2.y * (1.0 - smoothstep(0.4, 1.6, vRsX.x)));
          amt *= vRsX.y;
          float k = kr * amt;
          // snow lies thick: on a curved surface a cool shadow just under where it ends, and its rolled rim
          // (where the breakup thins it) a little blue
          float sh = smoothstep(uCover.x - 0.28, uCover.x, up) * (1.0 - smoothstep(uCover.x, uCover.y, up)) * amt * uCover3.x;
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.7, 0.76, 0.92), sh);
          vec3 cc = cv.rgb * mix(vec3(1.0), vec3(0.8, 0.86, 1.0), uCover3.y * 4.0 * kr * (1.0 - kr));
          diffuseColor.rgb = mix(diffuseColor.rgb, cc, k);
        }
        #include <lights_lambert_fragment>`);
    };
    m.customProgramCacheKey = () => 'rs-cover3';
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
  // a dome: the top half of an ellipsoid sitting at (x, y, z) (adobe bases)
  dome(mat, rx, h, rz, x, y, z, o = {}) {
    const rings = o.rings || 5, prof = [[1.08, -0.15]];
    for (let i = 0; i <= rings; i++) { const ph = Math.PI / 2 * i / rings; prof.push([Math.cos(ph), Math.sin(ph)]); }
    prof[prof.length - 1][0] = 0;
    const S = densOf(mat);
    this.lathe(mat, prof, x, y, z, { seg: 12, ...o, s: [rx, h, rz], uvFn: o.uvFn || (pl => [pl.x / S, pl.z / S]) });
  }
  // A mound draped on the ground at (x, z) (frame space): a feathered profile whose rim meets the ground at
  // under ten degrees, a lobed outline (never an ellipse), world-mapped like the terrain so a terrain
  // texture on it matches the ground round it.
  mound(mat, rx, h, rz, x, y, z, o = {}) {
    const prof = [[1.5, -0.12], [1.25, 0.02], [1.0, 0.12], [0.7, 0.55], [0.35, 0.88], [0, 1]];
    const seg = o.seg || 26, ry = o.ry || 0, c = Math.cos(ry), sn = Math.sin(ry), S = densOf(mat);
    const ph1 = hash3(x, z, 1.3) * TAU, ph2 = hash3(z, x, 2.7) * TAU, nl = 2 + Math.floor(hash3(x, 1.1, z) * 2);
    const n = prof.length - 1;
    // two rings per profile step on a Catmull-Rom curve through it, so a heap seen up close is a soft swell, not facets
    const cr = (i, t, q) => { const a = prof[Math.max(0, i - 1)][q], b = prof[i][q], c2 = prof[i + 1][q], d = prof[Math.min(n, i + 2)][q];
      return 0.5 * (2 * b + (c2 - a) * t + (2 * a - 5 * b + 4 * c2 - d) * t * t + (3 * b - a - 3 * c2 + d) * t * t * t); };
    this.grid(mat, seg, n * 2, (u, v) => {
      const th = u * TAU, k = v * n, i = Math.min(n - 1, Math.floor(k)), t = k - i;
      const pr = Math.max(0, cr(i, t, 0)), py = cr(i, t, 1);
      const lobe = 1 + 0.2 * (0.6 * Math.sin(nl * th + ph1) + 0.4 * Math.sin((nl + 1) * th + ph2));
      const lx = Math.sin(th) * rx * pr * lobe, lz = Math.cos(th) * rz * pr * lobe;
      const X = x + lx * c + lz * sn, Z = z - lx * sn + lz * c;
      return [X, (o.flat ? y : this.ground(X, Z)) + py * h, Z];
    }, { wrapU: true, noAO: true, tint: o.tint, lod0: o.lod0, uv: (u, v, P) => { const w = this.world(P[0], P[1], P[2]); return [w.x / S, w.z / S]; },
      // the terrain's own tint and occlusion at each vertex, so the mound's foot carries no colour step
      tintFn: this.ctx.groundTint ? (u, v, P) => { const w = this.world(P[0], P[1], P[2]), c = this.ctx.groundTint(w.x, w.z), t = o.tint || [1, 1, 1]; return [c[0] * t[0], c[1] * t[1], c[2] * t[2]]; } : undefined });
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
    const vt = (i, j) => { const k = j * (nu + 1) + i; return { p: P[k], n: N[k], uv: o.uv ? o.uv(i / nu, j / nv, P[k]) : [i / nu * (o.uR || 1), j / nv * (o.vR || 1)], tint: o.tintFn ? o.tintFn(i / nu, j / nv, P[k]) : undefined }; };
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
  const ranked = [...B.buckets.values()].filter(b => !NO_SHADOW.test(baseName(b.mat)) && !/[#!%]/.test(b.mat.slice(baseName(b.mat).length))).map(b => [b, areas.get(b)]).sort((a, b) => b[1] - a[1]);
  const cTotal = ranked.reduce((s, [, a]) => s + a, 0);
  for (const b of B.buckets.values()) for (let i = 0; i < b.p.length; i += 3) box.expandByPoint(tmp.set(b.p[i], b.p[i + 1], b.p[i + 2]));
  // small clusters (an anchor post, a keypad) cast with their one main material; bigger ones with up to three,
  // as long as each carries a real share of the surface
  const nCast = box.getBoundingSphere(new THREE.Sphere()).radius < 3 ? 1 : 3;
  const casters = new Set(ranked.filter(([, a], i) => (i < nCast && a > cTotal * 0.08) || a > cTotal * 0.25).map(([b]) => b));
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
    if (flags.includes('%')) m.renderOrder = 1;
    m.name = 'rs:' + b.mat;
    near.add(m);
    // the far LOD leaves out decals, near-only trim and materials that cover almost nothing
    if (flags.includes('#') || flags.includes('%') || areas.get(b) < total * 0.015) continue;
    const a = avgLin(base), glow = flags.includes('*') ? 1.6 : 1;
    const useCov = cov && !/[!*#%]/.test(flags), cp = useCov ? coverOf(base, ctx) : null, camt = useCov ? cp.amt * 0.75 : 0;
    for (let t = 0; t < b.f.length; t++) {
      if (b.f[t]) continue;
      for (let k = 0; k < 3; k++) {
        const i = (t * 3 + k) * 3, xi = (t * 3 + k) * 2;
        fp.push(b.p[i], b.p[i + 1], b.p[i + 2]); fn.push(b.n[i], b.n[i + 1], b.n[i + 2]);
        let r = a[0] * glow, g2 = a[1] * glow, bl = a[2] * glow;
        if (useCov) { const kk = smooth(cp.lo, cp.hi, b.n[i + 1]) * camt * b.x[xi + 1]; r += (cov[0] - r) * kk; g2 += (cov[1] - g2) * kk; bl += (cov[2] - bl) * kk; }
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
// A snow cap: a pillow of snow, wider than what it sits on, its crown lumpy, its edge rolled over in a bullnose
// that curls a few centimetres down over the eave and tucks under; the roll and the underside cool blue, so it reads
// as a soft thick layer rather than a slab. The plan is a rounded rectangle; each ring of the grid is that outline
// inset (corners tighten, the innermost ring is the middle line). o.dy(lx, lz) bends it to follow a bowed roof.
function snowCap(B, w, d, x, y, z, o = {}) {
  const t = o.t ?? 0.14, lip = o.lip ?? 0.07, ext = o.ext ?? 0.06;
  const hw = w / 2 + ext, hd = d / 2 + ext, R = Math.min(hw, hd), rc = Math.min(R * 0.7, 0.22);
  const Rh = Math.min(R * 0.8, Math.max(0.025, (t + lip) * 1.2));
  // rings: [inset, height above the support, blue]: under the rim, the curl, the bullnose up to the crown, then in
  const rings = [[Math.min(R * 0.9, 0.04 + lip * 0.5), -lip + 0.006, 1], [Math.min(R * 0.5, lip * 0.2), -lip, 1], [0, -lip * 0.45, 0.8]];
  const nb = R < 0.12 ? 2 : 3;
  for (let k = 1; k <= nb; k++) { const ph = k / nb * Math.PI / 2; rings.push([Rh * (1 - Math.cos(ph)), -lip * 0.45 + (t + lip * 0.45) * Math.sin(ph), 0.8 * (1 - k / nb) ** 1.5]); }
  const nIn = Math.max(1, Math.min(5, Math.round((R - Rh) / 0.18)));
  for (let k = 1; k <= nIn; k++) rings.push([Rh + (R - Rh) * k / nIn, t, 0]);
  // the outline, walked once round from the middle of the +z side: [kind, sx, sz, f or angle]
  const step = Math.max(0.2, 2 * (hw + hd) / 24), O = [];
  const nX = Math.max(1, Math.ceil((hw - rc) / step)), nZ = Math.max(1, Math.ceil(2 * (hd - rc) / step)), nC = R < 0.12 ? 2 : 3;
  for (let i = 0; i < nX; i++) O.push(['z', 0, 1, i / nX]);
  for (let i = 0; i < nC; i++) O.push(['c', 1, 1, Math.PI / 2 * (1 - i / nC)]);
  for (let i = 0; i < nZ; i++) O.push(['x', 1, 0, 1 - 2 * i / nZ]);
  for (let i = 0; i < nC; i++) O.push(['c', 1, -1, -Math.PI / 2 * i / nC]);
  for (let i = 0; i < 2 * nX; i++) O.push(['z', 0, -1, 1 - i / nX]);
  for (let i = 0; i < nC; i++) O.push(['c', -1, -1, -Math.PI / 2 - Math.PI / 2 * i / nC]);
  for (let i = 0; i < nZ; i++) O.push(['x', -1, 0, -1 + 2 * i / nZ]);
  for (let i = 0; i < nC; i++) O.push(['c', -1, 1, -Math.PI - Math.PI / 2 * i / nC]);
  for (let i = 0; i < nX; i++) O.push(['z', 0, 1, -1 + i / nX]);
  const at = (q, s) => {
    const A = hw - s, D = hd - s, r = Math.max(0, rc - s);
    if (q[0] === 'z') return [q[3] * (A - r), q[2] * D];
    if (q[0] === 'x') return [q[1] * A, q[3] * (D - r)];
    return [q[1] * (A - r) + r * Math.cos(q[3]), q[2] * (D - r) + r * Math.sin(q[3])];
  };
  const ph = x * 3.1 + z * 1.7, nu = O.length, nv = rings.length - 1, BLUE = [0.72, 0.8, 0.98];
  B.push(M4(x, y, z, o.rx || 0, o.ry || 0, o.rz || 0));
  B.grid('rs_snow!', nu, nv, (u, v) => {
    const q = O[Math.round(u * nu) % nu], [s, hh] = rings[Math.round(v * nv)], [px, pz] = at(q, s);
    const crown = smooth(Rh * 0.5, Rh * 1.6, s);
    let py = hh + (Math.sin(px * 2.3 + ph) * 0.5 + Math.sin(pz * 3.1 + px * 1.3 + ph) * 0.5) * t * 0.3 * crown;
    if (o.dy) py += o.dy(px, pz);
    return [px, py, pz];
  }, { wrapU: true, noAO: true, lod0: o.lod0, uv: (u, v, P) => [P[0] / 2 + x * 0.37, P[2] / 2 + z * 0.37],
    tintFn: (u, v) => { const b = rings[Math.round(v * nv)][2]; return [lerp(1, BLUE[0], b), lerp(1, BLUE[1], b), lerp(1, BLUE[2], b)]; } });
  B.pop();
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
// A drift banked against something: a draped feathered mound of the biome's own ground (snow, dust, sand).
// Skipped on steep slopes.
function drift(B, ctx, x, z, rx, rz, h, ry = 0) {
  if (!ctx.driftMat) return;
  const c = Math.cos(ry), s = Math.sin(ry);
  const gs = [[0, 0], [rx, 0], [-rx, 0], [0, rz], [0, -rz]].map(([a, b]) => B.ground(x + a * c + b * s, z - a * s + b * c));
  if (Math.max(...gs) - Math.min(...gs) > h * 1.6) return;
  B.mound(ctx.driftMat, rx, h * (ctx.snow ? 0.7 : 1), rz, x, 0, z, { ry, tint: ctx.moundTint });
}
// A heap of turned earth (a nose ploughed in, a furrow's lip), with grass tufts round its rim on grass.
function earth(B, ctx, x, z, rx, h, rz, ry = 0, tufts = 6) {
  B.mound(ctx.bio.ground, rx, h, rz, x, 0, z, { ry, tint: ctx.moundTint });
  if (!ctx.bio.tuft) return;
  const r = rngOf(seedOf(x, z, 61)), c = Math.cos(ry), s = Math.sin(ry);
  for (let i = 0; i < tufts; i++) {
    const a = r() * TAU, k = range(r, 1.0, 1.35), lx = Math.sin(a) * rx * k, lz = Math.cos(a) * rz * k;
    const X = x + lx * c + lz * s, Z = z - lx * s + lz * c, gy = B.ground(X, Z), w = range(r, 0.35, 0.6), hh = w * range(r, 0.8, 1.0), a0 = r() * Math.PI;
    for (const d of [0, Math.PI / 2]) B.quad(ctx.bio.tuft, w, hh, X, gy + hh / 2 - 0.04, Z, { ry: a0 + d, noAO: true });
  }
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
// A stretched pelt (the Badlands gate): a skin's outline as a polar grid in the shape's xy plane, facing +z, about
// w x h: four leg points, a neck at the top, a stub of tail, waisted and ragged between, sagging back into its
// middle and curling up at the edge, darker there. Its face comes from the gate label atlas (k 0: the cream
// flesh side with an ochre sun, 1: dark bison fur), its back is plain flesh side, so it costs no draw call.
// Placed at (x, y, z) with o.rx/ry/rz; returns the four leg tips in the caller's space, for lashings.
const PELT_UV = [[0.015, 0.01, 0.235, 0.323], [0.265, 0.01, 0.485, 0.323]];
function pelt(B, k, w, h, x, y, z, o = {}) {
  const NT = 44, NR = 5, ph = o.ph ?? (x * 1.7 + z * 2.3 + y), sag = o.sag ?? 0.15, R = PELT_UV[k];
  const legA = [0.72, Math.PI - 0.72, Math.PI + 0.78, -0.78];
  const dA = (a, b) => ((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const rAt = th => {
    let r = 0.82 + 0.04 * Math.sin(3 * th + ph) + 0.025 * Math.sin(7 * th + ph * 2) + 0.05 * (hash3(Math.round(th * 9), ph, 1.3) - 0.5);
    for (const a of legA) r += 0.36 * Math.exp(-((dA(th, a) / 0.12) ** 2));
    r += 0.2 * Math.exp(-((dA(th, Math.PI / 2) / 0.22) ** 2));       // the neck
    r += 0.16 * Math.exp(-((dA(th, -Math.PI / 2) / 0.07) ** 2));     // the tail
    r -= 0.1 * (Math.exp(-((dA(th, 0) / 0.3) ** 2)) + Math.exp(-((dA(th, Math.PI) / 0.3) ** 2)));   // waisted between the legs
    return r;
  };
  const sx = w / 2 / 1.18, sy = h / 2 / 1.18;
  const at = (th, rho) => {
    const r = rAt(th) * rho, px = Math.cos(th) * r * sx, py = Math.sin(th) * r * sy;
    const pz = -sag * (1 - rho * rho) + 0.015 * Math.sin(px * 7 + py * 3 + ph) * rho + 0.06 * smooth(0.8, 1, rho) * (0.6 + 0.4 * Math.sin(th * 5 + ph));
    return [px, py, pz];
  };
  const fn = (u, v) => at(u * TAU, 0.004 + 0.996 * v);
  const uvOf = (RR, sc) => (u, v, q) => [lerp(RR[0], RR[2], 0.5 + sc * q[0] / w), lerp(RR[1], RR[3], 0.5 + sc * q[1] / h)];
  const tn = o.tint || [1, 1, 1], edge = (u, v) => { const e = 1 - 0.35 * smooth(0.75, 1, v); return [e * tn[0], e * 0.97 * tn[1], e * 0.95 * tn[2]]; };
  const M = M4(x, y, z, o.rx || 0, o.ry || 0, o.rz || 0);
  B.push(M);
  B.grid('rs_gatelabels', NT, NR, fn, { wrapU: true, flip: true, noAO: true, uv: uvOf(R, 0.92), tintFn: edge });
  B.grid('rs_gatelabels', NT, NR, fn, { wrapU: true, noAO: true, uv: uvOf([0.024, 0.13, 0.058, 0.2], 0.9), tint: [1.08, 1.0, 0.88] });   // (a plain patch of the flesh side)
  B.pop();
  return legA.map(a => { const q = at(a, 1); return V(q[0], q[1], q[2]).applyMatrix4(M); });
}
// a rope from a to b with a little sag, a wrap round b
function lash(B, a, b, sag = 0.05, r = 0.025) {
  const m = a.clone().lerp(b, 0.5); m.y -= sag;
  B.tube('rs_rope', [a, m, b], r, { seg: 4, lod0: false });
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
      B.box('rs_iron', roof.hx * 2, roof.hy * 2, roof.hz * 2, roof.x, roof.y, roof.z, { r: 0.03, div: [2, 1, 14], smoothN: true, faces: { py: { m: 'rs_tin', rot: true }, ny: { m: 'rs_slats', rot: true, tint: [1.08, 1.02, 0.96] } }, deform: q => { q[1] += bow(q[2] + roof.z); } });
      // the ceiling inside: cross ribs at the side ribs' spacing, and a rust hole near the rear letting the
      // daylight in, a pale patch of it on the floor below
      B.shelter = true;
      for (const zz of kept) B.box('rs_iron', roof.hx * 2 - 0.16, 0.1, 0.08, roof.x, roof.y - roof.hy - 0.05 + bow(zz), zz, { r: 0.02 });
      const hz0 = zr + 1.1, hx0 = roof.x + 0.35, hy0 = roof.y - roof.hy + bow(hz0) - 0.006;
      B.cyl('rs_headlamp*', 0.15, 0.15, 0.01, hx0, hy0, hz0, { seg: 9, caps: 'rs_headlamp*', capFit: false, jit: 0.02, lod0: true, tint: [0.85, 0.95, 1.1] });
      B.torus('rs_iron', 0.16, 0.035, hx0, hy0 - 0.005, hz0, { rx: Math.PI / 2, seg: 9, tseg: 4, tint: [1.25, 0.8, 0.55], lod0: true });
      if (fl) B.quad('rs_glow*%', 0.9, 0.7, hx0 + 0.1, fl.y + fl.hy + 0.012, hz0 + 0.15, { rx: -Math.PI / 2, rz: 0.4, tint: [0.7, 0.66, 0.6] });
      B.shelter = false;
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
    earth(B, ctx, cx, fz + 0.5, 1.5, 0.34, 0.7, 0, 7);
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
    B.box('rs_crate_a', 0.5, 0.42, 0.42, (rnd() < 0.5 ? -1 : 1) * 0.42, 0.21, 0.1, { r: 0.03, ry: range(rnd, -0.2, 0.2) + (rnd() < 0.5 ? Math.PI / 2 : 0) });
    B.pop();
  }
  // a blanket spread out in front of the tables (the cheap stuff goes on the ground), one corner folded back
  {
    const bw = 4.4, bd = 2.6, bx0 = range(rnd, -0.3, 0.3), bz0 = 2.35, bry = range(rnd, -0.08, 0.08), c = Math.cos(bry), sn = Math.sin(bry), f = 0.75;
    const cs = rnd() < 0.5 ? -1 : 1;   // which front corner is folded
    B.grid('rs_blanket', 12, 8, (u, v) => {
      let lx = (u - 0.5) * bw, lz = (v - 0.5) * bd, lift = 0.03 + Math.sin(u * 13 + v * 7) * 0.008;
      // the corner (cs * bw / 2, bd / 2) folds back over the line lx * cs + lz = bw / 2 + bd / 2 - f
      const k = lx * cs + lz - (bw / 2 + bd / 2 - f);
      if (k > 0) { lx -= cs * k; lz -= k; lift += 0.035 + k * 0.03; }
      const X = bx0 + lx * c + lz * sn, Z = bz0 - lx * sn + lz * c;
      return [X, B.ground(X, Z) + lift, Z];
    }, { flip: true, noAO: true, uv: (u, v) => [u, v] });
  }
  // a hand-painted YARD SALE bunting strung between two poles behind the tables
  {
    const A = V(-4.5, 0, -1.15), Bp = V(3.7, 0, -1.35), hy = 2.6, sag = 0.4;
    for (const P of [A, Bp]) { const gy = B.ground(P.x, P.z); B.cyl('rs_timber', 0.045, 0.055, hy + 0.25 - gy, P.x, (hy + 0.25 + gy) / 2, P.z, { seg: 6, rz: range(rnd, -0.04, 0.04) }); B.tube('rs_rope', [V(P.x, hy + 0.1, P.z), V(P.x + (P.x < 0 ? -0.7 : 0.7), B.ground(P.x + (P.x < 0 ? -0.7 : 0.7), P.z), P.z)], 0.012, { seg: 4, lod0: true }); }
    const at = t => V(lerp(A.x, Bp.x, t), hy - sag * Math.sin(Math.PI * t), lerp(A.z, Bp.z, t));
    const line = []; for (let k = 0; k <= 16; k++) line.push(at(k / 16));
    B.tube('rs_rope', line, 0.012, { seg: 4, lod0: false });
    const letters = [0, 1, 2, 3, -1, 4, 5, 6, 7];
    letters.forEach((li, j) => {
      if (li < 0) return;
      const t = 0.12 + 0.76 * j / (letters.length - 1), q = at(t);
      B.quad('rs_bunting#~', 0.56, 0.7, q.x, q.y - 0.36, q.z, { uvRect: [li / 8, 0, (li + 1) / 8, 1], rz: range(rnd, -0.08, 0.08), ry: range(rnd, -0.15, 0.15) });
    });
  }
  // a clothes rack behind the tables, garments hanging off it in muted colours
  {
    const rx0 = range(rnd, -0.4, 0.2), rz0 = -1.7, rw = 2.2, rh = 1.65;
    for (const sx of [-1, 1]) {
      const x = rx0 + sx * rw / 2;
      for (const sz of [-1, 1]) B.box('rs_timber', 0.06, rh + 0.05, 0.06, x, rh / 2, rz0 + sz * 0.22, { rx: -sz * 0.14, r: 0.015 });
      B.box('rs_timber', 0.06, 0.06, 0.6, x, 0.25, rz0, { r: 0.015, rot: true });
    }
    B.cyl('rs_iron', 0.022, 0.022, rw + 0.16, rx0, rh, rz0, { rz: Math.PI / 2, seg: 6, caps: false });
    // (in the cloths already on the stop, so the rack costs no extra draw calls)
    const cloths = [[cloth, [0.9, 0.85, 0.82]], [cloth, [0.7, 0.78, 0.9]], [ctx.bio.umbrella, [0.85, 0.82, 0.78]], [cloth, [0.95, 0.85, 0.6]], [ctx.bio.umbrella, [0.75, 0.85, 0.75]]];
    const n = 4 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const x = rx0 - rw / 2 + 0.25 + (rw - 0.5) * (k + range(rnd, -0.2, 0.2)) / (n - 1), [m, tn] = pick(rnd, cloths), long = rnd() < 0.4;
      const gh = long ? range(rnd, 0.95, 1.15) : range(rnd, 0.6, 0.75), gw = range(rnd, 0.42, 0.55), ry2 = range(rnd, -0.5, 0.5);
      B.lod0 = true; B.tube('rs_iron', [V(x, rh + 0.06, rz0), V(x + 0.03, rh + 0.1, rz0), V(x, rh - 0.06, rz0)], 0.008, { seg: 3 }); B.lod0 = false;
      B.push(M4(x, rh - 0.08, rz0, 0, ry2, range(rnd, -0.04, 0.04)));
      B.box('rs_iron', gw, 0.03, 0.03, 0, 0, 0, { r: 0.01, lod0: true });
      B.box(m, gw, gh, 0.06, 0, -gh / 2 - 0.02, 0, { r: 0.025, taper: long ? 0.7 : 0.95, tint: tn, div: [2, 3, 1], deform: q => { q[2] += Math.sin(q[0] * 9 + k) * 0.015; if (!long) q[0] *= 1 + 0.05 * Math.sin(q[1] * 6); } });
      if (!long) for (const sx of [-1, 1]) B.box(m, 0.14, 0.42, 0.055, sx * (gw / 2 + 0.05), -0.25, 0, { rz: sx * 0.18, r: 0.02, tint: tn.map(c => c * 0.94) });
      B.pop();
    }
  }
  // a rocking chair out front, a stack of kitchen chairs (the top one upside down)
  {
    const cx2 = 3.3, cz2 = range(rnd, 0.6, 1.0), gy = B.ground(cx2, cz2);
    B.push(M4(cx2, gy, cz2, 0, range(rnd, -0.9, -0.5), 0));
    for (const sx of [-0.24, 0.24]) {
      const arc = []; for (let k = 0; k <= 8; k++) { const t = -0.55 + 1.1 * k / 8; arc.push(V(sx, 0.75 - Math.cos(t) * 0.72, Math.sin(t) * 0.72)); }
      B.tube('rs_timber', arc, 0.03, { seg: 5, lod0: false });
      for (const sz of [-0.2, 0.2]) B.box('rs_timber', 0.045, 0.42, 0.045, sx, 0.25, sz, { r: 0.01, lod0: false });
      B.box('rs_timber', 0.045, 0.85, 0.05, sx, 0.82, -0.24, { rx: -0.2, r: 0.012, lod0: false });
    }
    B.box('rs_planks', 0.56, 0.05, 0.5, 0, 0.47, 0, { r: 0.015 });
    for (let k = 0; k < 4; k++) B.box('rs_planks', 0.09, 0.62, 0.025, -0.18 + k * 0.12, 0.88, -0.27, { rx: -0.2, r: 0.01, lod0: true });
    B.box('rs_timber', 0.56, 0.07, 0.05, 0, 1.2, -0.34, { rx: -0.2, r: 0.015 });
    B.pop();
    const sxp = -3.7, szp = range(rnd, 0.4, 0.8), gy2 = B.ground(sxp, szp);
    const chair = (y, ry2, flip) => {
      B.push(M4(sxp, gy2 + y, szp, flip ? Math.PI : 0, ry2, 0));
      B.box('rs_planks', 0.44, 0.05, 0.42, 0, 0.45, 0, { r: 0.012, tint: [0.85, 0.82, 0.8] });
      for (const sx of [-0.18, 0.18]) for (const sz of [-0.17, 0.17]) B.box('rs_timber', 0.045, 0.45, 0.045, sx, 0.22, sz, { r: 0.01, lod0: true });
      for (const sx of [-0.18, 0.18]) B.box('rs_timber', 0.045, 0.5, 0.045, sx, 0.72, -0.19, { r: 0.01, lod0: true });
      B.box('rs_planks', 0.42, 0.14, 0.03, 0, 0.88, -0.19, { r: 0.01, tint: [0.85, 0.82, 0.8] });
      B.pop();
    };
    chair(0, range(rnd, -0.3, 0.3), false);
    chair(0.5, range(rnd, -0.4, 0.4), false);
    if (rnd() < 0.7) chair(1.43, range(rnd, -0.4, 0.4) + Math.PI, true);
  }
  // the umbrella on a crate base
  const d = decor.find(e => e.k === 'umbrella');
  if (d) {
    B.frame(d.x, d.y, d.z, d.ry || 0);
    B.box('rs_crate_a', 0.56, 0.52, 0.56, 0, 0.26, 0, { r: 0.03, ry: 0.4 });
    B.push(M4(0, 0.55, 0, 0.03, 0, 0.06));
    B.cyl('rs_timber', 0.04, 0.045, 2.35, 0, 1.12, 0, { seg: 6, caps: false });
    const canvas = ctx.bio.umbrella;
    // the canopy sags a few centimetres between its eight ribs
    const prof = [[0, 2.25], [0.28, 2.2], [0.75, 2.08], [1.25, 1.9], [1.6, 1.72]];
    const profAt = rr => { for (let i = 0; i < prof.length - 1; i++) if (rr <= prof[i + 1][0]) return lerp(prof[i][1], prof[i + 1][1], (rr - prof[i][0]) / (prof[i + 1][0] - prof[i][0])); return prof[prof.length - 1][1]; };
    B.grid(canvas, 32, 5, (u, v) => { const th = u * TAU, rr = 1.6 * (1 - v), sag = 0.05 * (rr / 1.6) * Math.abs(Math.sin(th * 4)); return [Math.sin(th) * rr, profAt(rr) - sag, Math.cos(th) * rr]; }, { wrapU: true, flip: true, uv: (u, v) => [u * 8, 1 - v] });
    B.quad(ctx.bio.cloth, 0.42, 0.34, Math.sin(0.4) * 0.95, profAt(0.95) + 0.03, Math.cos(0.4) * 0.95, { ry: 0.4, rx: -Math.PI / 2 + 0.3, lod0: true, noAO: true, uvRect: [0, 0, 0.7, 0.55] });
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
  const WING_RED = [0.78, 0.34, 0.27];
  // red-doped trim fitted to the atlas's trim rect (wing edge caps, debris)
  const TRIM = { fit: true, uvRect: plRect(PLR.trim) };
  if (fus) {
    const fy = fus.y, fh = fus.hy, fz0 = fus.z, fhz = fus.hz, zN = fz0 + fhz, zT = fz0 - fhz;
    // the whole airframe pitched seven degrees nose-down about the middle of its box: the nose dug in
    const PITCH = 0.12;
    B.push(new THREE.Matrix4().makeTranslation(fus.x, fy, fz0).multiply(new THREE.Matrix4().makeRotationX(PITCH)).multiply(new THREE.Matrix4().makeTranslation(-fus.x, -fy, -fz0)));
    // The hull: a loft of rounded sections (a round-shouldered turtle deck, flatter sides and belly) narrowing and
    // rising toward the tail and rounding off into the cowl at the nose, closed off behind the tail post. Skinned
    // with the atlas's hull (red-doped canvas over ribs, a riveted metal nose quarter), both sides the same image
    // folded at the deck and the belly.
    const zH = zN - 0.2, zJ = zT + PLANE_JOINT * (zH - zT);
    const sec = zz => {
      const k = 1 - 0.3 * smooth(fz0 - 0.6, zT, zz), nose = smooth(zH - 0.6, zH, zz);
      return { a: fus.hx * k, b: fh * k, yc: fy + (1 - k) * fh * 0.4, eT: lerp(2.5, 2.15, nose), eB: lerp(3.4, 2.15, nose) };
    };
    // a point on a section: phi from the top centre (0) round over the +x side (pi/2) to the belly (pi)
    const sePt = (phi, S) => { const sn = Math.sin(phi), cs = Math.cos(phi), e = lerp(S.eB, S.eT, smooth(-0.35, 0.35, cs)); return [S.a * sp(sn, e), S.b * sp(cs, e)]; };
    const topY = (lx, zz) => { const S = sec(zz), e = S.eT; return S.yc + S.b * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(lx - fus.x) / S.a), e)), 1 / e); };
    const ST = [[zT - 0.16, 0.03], [zT - 0.13, 0.5], [zT - 0.07, 0.84], [zT - 0.02, 0.97]];
    for (let i = 0; i <= 24; i++) ST.push([zT + (zH - zT) * i / 24, 1]);
    const NS = ST.length - 1, fold = u => (u <= 0.5 ? 2 * u : 2 - 2 * u), sAt = zz => clamp01((zz - zT) / (zH - zT));
    B.grid(PL, 28, NS, (u, v) => {
      const [zz, sc] = ST[Math.round(v * NS)], S = sec(zz), [x, y] = sePt(u * TAU, S);
      return [fus.x + x * sc, S.yc + y * sc, zz];
    }, { wrapU: true, flip: true, uv: (u, v) => plUV(PLR.hull, sAt(ST[Math.round(v * NS)][0]), fold(u)) });
    // brass bands: over the fabric's leading edge where the metal nose begins, and round the tail post
    const band = (zc, hw2, grow) => B.grid('rs_brass', 28, 3, (u, v) => {
      const j = Math.round(v * 3), zz = zc + (j / 3 * 2 - 1) * hw2, S = sec(zz), [x, y] = sePt(u * TAU, S), g = 1 + [0.25, 1, 1, 0.25][j] * grow / Math.max(S.a, S.b);
      return [fus.x + x * g, S.yc + y * g, zz];
    }, { wrapU: true, flip: true, uv: (u, v) => [u * 5, v * 0.13] });
    band(zJ, 0.065, 0.03); band(zT + 0.22, 0.05, 0.024);
    // the cockpit: a dark well laid on the deck's curve, a padded leather coaming round it, the seat back, the windscreen
    const zc = fz0 + 0.75, crx = 0.33, crz = 0.55;
    B.grid('rs_iron', 16, 2, (u, v) => { const a = u * TAU, X = fus.x + Math.sin(a) * crx * v, Z = zc + Math.cos(a) * crz * v; return [X, topY(X, Z) + 0.008, Z]; },
      { wrapU: true, flip: true, tint: [0.26, 0.24, 0.28], uv: (u, v, P) => [P[0] * 2, P[2] * 2] });
    const rim = []; for (let k = 0; k <= 20; k++) { const a = k / 20 * TAU, X = fus.x + Math.sin(a) * (crx + 0.035), Z = zc + Math.cos(a) * (crz + 0.035); rim.push(V(X, topY(X, Z) + 0.03, Z)); }
    B.tube('rs_timber', rim, 0.05, { seg: 6, tint: [0.62, 0.4, 0.3], lod0: false });
    B.box('rs_timber', 0.5, 0.42, 0.1, fus.x, topY(fus.x, zc - 0.42) + 0.17, zc - 0.42, { tint: [0.62, 0.4, 0.32], r: 0.045, rx: -0.15 });
    const ct = fy + fh;
    B.box('rs_glass', 0.66, 0.34, 0.03, fus.x, ct + 0.22, fz0 + 1.42, { rx: -0.4, r: 0.01, uvRect: [0.5, 0, 1, 1] });
    B.box('rs_brass', 0.7, 0.045, 0.06, fus.x, ct + 0.06, fz0 + 1.36, { r: 0.015 });
    // the filler cap on the nose deck, exhaust stubs either side just behind the cowl (soot painted behind them)
    B.cyl('rs_brass', 0.075, 0.085, 0.05, fus.x, topY(fus.x, zJ + 0.45) + 0.012, zJ + 0.45, { seg: 10, bevel: 0.012, lod0: true });
    for (const sx of [-1, 1]) for (const dz of [0, 0.3]) B.tube('rs_iron', [V(fus.x + sx * 0.66, fy + 0.1, zH - 0.3 - dz), V(fus.x + sx * 0.8, fy + 0.02, zH - 0.5 - dz), V(fus.x + sx * 0.84, fy - 0.06, zH - 0.68 - dz)], 0.045, { seg: 6, ends: true, lod0: true });
    // snow lying along the deck behind the cockpit and on the nose deck: a blanket draped on the hull's own section,
    // a hand thick down the middle, its edges rolling down steeply into the canvas (a rounded drift edge, cool blue
    // where it thins, so it reads as soft and thick rather than painted on)
    if (ctx.snow) {
      const PH = rnd() * 6;
      for (const [za, zb] of [[zT + 0.75, zc - crz - 0.1], [zJ + 0.14, zH - 0.12]]) {
        if (zb - za < 0.4) continue;
        const nv2 = Math.max(4, Math.round((zb - za) / 0.2));
        B.grid('rs_snow!', 12, nv2, (u, v) => {
          const zz = lerp(za, zb, v), S = sec(zz), ac = u * 2 - 1, phi = ac * (1 + 0.14 * Math.sin(zz * 3.3 + ac * 1.7 + PH) + 0.06 * Math.sin(zz * 7.1 - PH)), [x, y] = sePt(phi, S), [x2, y2] = sePt(phi + 0.01, S);
          let nx = y2 - y, ny = -(x2 - x); const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
          if (nx * x + ny * y < 0) { nx = -nx; ny = -ny; }
          const eA = Math.sqrt(Math.max(0, 1 - Math.abs(ac) ** 4)), eL = Math.sqrt(Math.max(0, 1 - Math.abs(v * 2 - 1) ** 5));
          const th = 0.1 * eA * eL * (0.8 + 0.3 * Math.sin(zz * 2.6 + x * 4 + PH)) - 0.015;
          return [fus.x + x + nx * th, S.yc + y + ny * th, zz];
        }, { flip: true, noAO: true, uv: (u, v, P) => [P[0] / 2, P[2] / 2],
          tintFn: (u, v) => { const e = Math.min(1 - Math.abs(u * 2 - 1), 1 - Math.abs(v * 2 - 1)), b = 1 - smooth(0, 0.35, e); return [lerp(1, 0.72, b), lerp(1, 0.8, b), lerp(1, 0.98, b)]; } });
      }
    }
    // ---- the engine: a brass nose bowl, a seven-cylinder radial with finned barrels, a dented Townend ring round
    // the heads torn open where the nose went in, the hub and spinner and a snapped prop ----
    const zB = zH - 0.12;
    B.lathe(PL, [[0.745, 0], [0.772, 0.09], [0.768, 0.19], [0.73, 0.28], [0.645, 0.35], [0.5, 0.395], [0.3, 0.41]], fus.x, fy, zB, { rx: Math.PI / 2, seg: 18, jit: 0.035, uvFn: (pl, nl, v) => plUV(PLR.cowl, v.uv[0], v.uv[1]) });
    const zK = zB + 0.35;
    B.lathe(PL, [[0.3, 0], [0.31, 0.03], [0.31, 0.2], [0.29, 0.26], [0.22, 0.305], [0.1, 0.33], [0, 0.335]], fus.x, fy, zK, { rx: Math.PI / 2, seg: 14, uvFn: (pl, nl, v) => plUV(PLR.face, 0.5 + v.p[0] / 0.64, 0.5 + v.p[2] / 0.64) });
    // a barrel: a flange, seven fins (a ridged profile whose crests and gaps line up with the painted fin bands),
    // the head joint; the atlas's v follows the barrel's length, not its arc
    const zCy = zK + 0.12, FP = (BAR_FIN1 - BAR_FIN0) / 7;
    const finR = yy => 0.095 + 0.02 * (0.5 + 0.5 * Math.cos(TAU * (((yy - BAR_FIN0) / FP) % 1 - 0.25)));
    const barProf = [[0.118, 0.28], [0.121, 0.3], [0.1, 0.315], [finR(BAR_FIN0), BAR_FIN0]];
    for (let y2 = BAR_FIN0 + FP / 4; y2 < BAR_FIN1 - 1e-6; y2 += FP / 4) barProf.push([finR(y2), y2]);
    barProf.push([finR(BAR_FIN1), BAR_FIN1], [0.104, 0.62]);
    const barV = yy => (yy < BAR_FIN0 ? lerp(0, 14 / 128, (yy - 0.28) / (BAR_FIN0 - 0.28)) : yy <= BAR_FIN1 ? lerp(14 / 128, 119 / 128, (yy - BAR_FIN0) / (BAR_FIN1 - BAR_FIN0)) : lerp(119 / 128, 1, (yy - BAR_FIN1) / (0.62 - BAR_FIN1)));
    for (let k = 0; k < 7; k++) {
      const a = TAU * k / 7 + 0.2;
      B.push(M4(fus.x, fy, zCy, 0, 0, a - Math.PI / 2));
      B.lathe(PL, barProf, 0, 0, 0, { seg: 9, uvFn: (pl, nl, v) => plUV(PLR.barrel, v.uv[0], barV(v.p[1])), lod0: false });
      // the head: a rounded iron block, a rocker box either side, the brass head bolt and its nut, the plug lead
      // (all kept clear of the weather cover: under it they'd read as blobs of snow)
      B.shelter = true;
      B.lathe('rs_iron', [[0.104, 0.615], [0.13, 0.63], [0.134, 0.68], [0.126, 0.73], [0.1, 0.77], [0.056, 0.79], [0, 0.795]], 0, 0, 0, { seg: 9, tint: [1.1, 1.02, 0.95], lod0: false });
      for (const sz of [-1, 1]) B.box('rs_iron', 0.075, 0.065, 0.09, 0, 0.762, sz * 0.078, { r: 0.016, rx: sz * 0.5, tint: [0.92, 0.88, 0.86], lod0: true });
      B.cyl('rs_brass', 0.03, 0.03, 0.065, 0, 0.82, 0, { seg: 8, bevel: 0.007, lod0: true });
      B.cyl('rs_brass', 0.046, 0.046, 0.024, 0, 0.795, 0, { seg: 6, lod0: true });
      B.tube('rs_brass', [V(0, 0.34, 0.17), V(0.02, 0.6, 0.17), V(0.07, 0.72, 0.08)], 0.008, { seg: 3, lod0: true });
      // pushrods back down to the crankcase, an intake pipe curling back into the bowl
      for (const sx of [-0.035, 0.035]) B.tube('rs_iron', [V(sx, 0.3, 0.13), V(sx * 1.3, 0.72, 0.1)], 0.011, { seg: 4, lod0: true });
      B.tube('rs_brass', [V(0, 0.66, -0.09), V(0, 0.6, -0.17), V(0, 0.48, -0.21)], 0.026, { seg: 6, lod0: true });
      B.shelter = false;
      B.pop();
    }
    B.torus('rs_brass', 0.34, 0.017, fus.x, fy, zCy + 0.17, { seg: 18, tseg: 4, lod0: true, shelter: true });
    {
      // painted like the cowl's back edge (the atlas's red band chipped to the brass, the cream pinstripe and the
      // rivet row round its outer face, bare brass inside)
      const a0 = -Math.PI / 2 + 0.78, al = TAU - 1.56, zr = zCy + 0.02, aL = al * 0.875 / 4.4;
      B.grid(PL, 8, 28, (u, v) => {
        const a = a0 + al * v, th = u * TAU, dent = 0.022 * Math.sin(a * 3 + 1.3) + 0.014 * Math.sin(a * 7 + 0.4);
        const r = 0.875 + dent + 0.028 * Math.cos(th) - 0.03 * Math.sin(th), zz = zr + 0.14 * Math.sin(th) + 0.03 * Math.sin(a * 2 + 0.7);
        return [fus.x + Math.cos(a) * r, fy + Math.sin(a) * r, zz];
      }, { wrapU: true, flip: true, uv: (u, v) => plUV(PLR.cowl, 0.03 + v * aL, 0.04 + 0.3 * (1 - Math.cos(u * TAU)) / 2), lod0: false });
    }
    const zP = zK + 0.335;
    B.cyl('rs_brass', 0.12, 0.13, 0.1, fus.x, fy, zP + 0.04, { rx: Math.PI / 2, seg: 10, bevel: 0.015 });
    B.lathe('rs_brass', [[0.165, 0], [0.16, 0.08], [0.13, 0.17], [0.07, 0.25], [0, 0.29]], fus.x, fy, zP + 0.1, { rx: Math.PI / 2, seg: 12, jit: 0.02 });
    // the prop: laminated honey wood, twisted, the long blade driven down into the dirt and bent back by it, its
    // brass tip sheath buried, the upper one snapped off short in splinters
    B.push(M4(fus.x, fy, zP + 0.1, 0, 0, Math.PI + 0.42));
    const HONEY = [1.18, 1.0, 0.78];
    B.box('rs_timber', 0.22, 1.2, 0.075, 0, 0.66, 0, { r: 0.03, taper: 0.6, div: [1, 5, 1], smoothN: true, tint: HONEY, deform: q => {
      const t = (q[1] + 0.6) / 1.2, c = Math.cos(0.5 * t), s2 = Math.sin(0.5 * t), x = q[0], z = q[2];
      q[0] = x * c - z * s2; q[2] = x * s2 + z * c - 0.3 * t * t;
    } });
    B.box('rs_brass', 0.15, 0.2, 0.085, 0, 1.18, -0.27, { r: 0.02, rx: -0.46, ry: 0.5, taper: 0.8 });
    B.box('rs_timber', 0.22, 0.34, 0.075, 0, -0.23, 0, { r: 0.025, jit: 0.035, tint: HONEY });
    for (const [ox, len, rz] of [[-0.06, 0.12, 0.2], [0.02, 0.17, -0.1], [0.07, 0.1, 0.35]]) B.box('rs_timber', 0.035, len, 0.03, ox, -0.4 - len / 2, 0, { rz, r: 0.008, tint: HONEY, lod0: true });
    B.pop();
    // the tail broke its back on landing: the boom snapped up at forty degrees, the fin standing high
    // over the wreck with the gnomish roundel on it (this is what you see from the road below the mesa)
    const pitch = 0.7, bl = 2.5, b0 = V(fus.x, fy + 0.15, zT + 0.35);
    const dir = V(0, Math.sin(pitch), -Math.cos(pitch)), b1 = b0.clone().add(dir.clone().multiplyScalar(bl));
    B.lathe(PL, [[0.6, -0.05], [0.66, 0.04], [0.63, 0.1], [0.56, 0.15], [0.5, 0.2]], b0.x, b0.y, b0.z, { rx: pitch - Math.PI / 2, seg: 12, jit: 0.06, uvFn: (pl, nl, v) => plUV(PLR.cowl, v.uv[0] * 0.85, 0.02 + 0.3 * v.uv[1]) });
    B.tube(PL, [b0, b0.clone().lerp(b1, 0.45), b1], [0.5, 0.4, 0.26], { seg: 12, fit: true, S: bl, uvFn: (pl, nl, v) => plUV(PLR.hull, 0.03 + v.uv[1] * 0.2, fold(v.uv[0])) });
    B.push(new THREE.Matrix4().compose(b1, new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * 0.8, 0, 0, 'YXZ')), new V3(1, 1, 1)));
    B.box(PL, 0.1, 1.6, 1.15, 0, 0.76, -0.15, { r: 0.04, taper: 0.62, div: [1, 2, 2], fit: true, uvRect: plRect(PLR.hull, [0.02, 0.5, 0.24, 0.96]), deform: q => { q[2] -= (q[1] + 0.8) * 0.3; } });
    B.box('rs_brass', 0.12, 0.08, 0.66, 0, 1.56, -0.62, { r: 0.025 });
    for (const sx of [-1, 1]) B.quad('rs_roundel#', 0.82, 0.82, sx * 0.058, 0.68, -0.28, { ry: sx * Math.PI / 2 });
    B.box('rs_wing', 2.6, 0.07, 0.72, 0, 0.02, -0.05, { r: 0.025, rz: 0.1, tint: WING_RED });
    B.box('rs_wing', 0.9, 0.06, 0.6, 1.1, 0.03, -0.1, { r: 0.02, rz: -0.35, ry: 0.3, jit: 0.04 });
    B.pop();
    B.pop();
    // landing gear: one leg snapped out sideways, a wheel lying in the dirt
    B.tube('rs_iron', [V(fus.x + 0.4, 0.3, fz0 + 2.0), V(fus.x + 1.05, 0.22, fz0 + 2.3)], 0.045, { seg: 6 });
    wheel(B, fus.x + 1.15, 0.3, fz0 + 2.32, 0.3, 0.14, { ry: 0.4, lean: 0.35 });
    {
      // the tail skid's spoked wheel, torn off and lying in the dirt: a brass rim, wire spokes, a hub
      const wx = fus.x - 2.7, wz = fz0 + 2.8, gy = B.ground(wx, wz);
      B.push(M4(wx, gy + 0.06, wz, Math.PI / 2 + 0.12, 0.5, 0));
      B.torus('rs_brass', 0.28, 0.04, 0, 0, 0, { seg: 16, tseg: 5, lod0: false });
      B.cyl('rs_iron', 0.06, 0.06, 0.12, 0, 0, 0, { rx: Math.PI / 2, seg: 8 });
      for (let k = 0; k < 8; k++) B.box('rs_iron', 0.018, 0.5, 0.018, 0, 0, 0, { rz: k * Math.PI / 8, r: 0.004, lod0: true });
      B.pop();
    }
    // a column of smoke rising off the engine marks the wreck from the road
    if (ctx.smokes) ctx.smokes.push(B.world(fus.x, fy + 0.05, zN - 0.2));
    // the earth heaped up in front of the nose, and the furrow it ploughed coming in: two ragged ridges of
    // turned earth either side of the fuselage, the ground between them scorched
    earth(B, ctx, fus.x, zN + 0.6, 1.4, 0.45, 0.9, 0, 7);
    const zBack = -Math.max(4, (p.mesa ? p.mesa.r : 7) - 1.3), flen = zN - zBack;
    for (const sx of [-1, 1]) earth(B, ctx, fus.x + sx * 1.18, (zN + zBack) / 2 - 0.2, 0.4, 0.24, flen * 0.4, sx * 0.03, 9);
    B.sheet('rs_scorch%', 3.2, flen + 1.6, fus.x, (zN + zBack) / 2 + 0.5, { nx: 4, nz: 10, lift: 0.05 });
  }
  if (wing) {
    const droop = q => { const xx = q[0] + wing.x; if (xx > 2.6) { const k2 = xx - 2.6; q[1] -= k2 * k2 * 0.02; } };
    B.box('rs_wing', wing.hx * 2, wing.hy * 2, wing.hz * 2, wing.x, wing.y, wing.z, { r: 0.05, div: [6, 1, 1], deform: droop, off: [0.2, 0.5] });
    // red-doped bands near the tips, the leading-edge spar, the wingtip bows
    for (const sx of [-1, 1]) B.box('rs_wing', 0.5, wing.hy * 2 + 0.02, wing.hz * 2 + 0.02, wing.x + sx * (wing.hx - 0.75), wing.y - (sx > 0 ? 0.02 : 0), wing.z, { r: 0.05, tint: WING_RED, rz: sx > 0 ? -0.04 : 0 });
    B.quad('rs_roundel#', 0.95, 0.95, wing.x - wing.hx + 1.6, wing.y + wing.hy + 0.02, wing.z, { rx: -Math.PI / 2 });
    B.cyl('rs_brass', 0.055, 0.055, 6.75, wing.x - 0.78, wing.y, wing.z + wing.hz, { rz: Math.PI / 2, seg: 6, caps: false });
    B.box(PL, 0.12, wing.hy * 2 + 0.06, wing.hz * 2 + 0.04, wing.x - wing.hx, wing.y, wing.z, { r: 0.04, ...TRIM });
    // the upper wing: left half still up on its struts; the right half snapped off its root and
    // flung up and outward, a bent strut still hanging off it trailing a tattered pennant
    const uy = 2.05, uz = wing.z + 0.1;
    B.box('rs_wing', 6.4, 0.14, 1.5, wing.x - 1.0, uy, uz, { r: 0.05, off: [0.7, 0.2], div: [6, 1, 1] });
    B.box('rs_wing', 0.6, 0.15, 1.52, wing.x - 3.75, uy, uz, { r: 0.05, tint: WING_RED });
    B.box(PL, 0.12, 0.2, 1.54, wing.x - 4.2, uy, uz, { r: 0.04, ...TRIM });
    B.quad('rs_roundel#', 1.0, 1.0, wing.x - 2.9, uy + 0.08, uz, { rx: -Math.PI / 2 });
    B.push(M4(wing.x + 2.25, uy - 0.05, uz, 0, -0.1, 0.72));
    B.box('rs_wing', 2.1, 0.13, 1.45, 1.05, 0, 0, { r: 0.05, jit: 0.04, off: [0.1, 0.9], div: [3, 1, 1] });
    B.box('rs_wing', 0.5, 0.14, 1.47, 1.8, 0, 0, { r: 0.05, tint: WING_RED, jit: 0.03 });
    B.box(PL, 0.12, 0.19, 1.5, 2.1, 0, 0, { r: 0.04, ...TRIM });
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
  const debris = [PL, 'rs_wing', 'rs_brass', 'rs_iron', PL, 'rs_timber'];
  for (let i = 0; i < 12; i++) {
    let x, z; do { const a = rnd() * TAU, rr = range(rnd, 2.6, 4.8); x = Math.cos(a) * rr; z = Math.sin(a) * rr; } while (z < -2.5 && Math.abs(x) < 3.5);
    const m = debris[i % debris.length];
    B.box(m, range(rnd, 0.3, 0.7), 0.04, range(rnd, 0.25, 0.5), x, B.ground(x, z) + 0.04, z, { ry: rnd() * 3, rx: range(rnd, -0.25, 0.25), rz: range(rnd, -0.25, 0.25), jit: 0.05, ...(m === PL ? TRIM : {}) });
  }
  B.box('rs_timber', 0.2, 0.85, 0.06, -1.8, B.ground(-1.8, 3.6) + 0.04, 3.6, { rx: -Math.PI / 2 + 0.05, ry: 0.7, taper: 0.6, r: 0.02 });
  // the big pieces: a crumpled cowling panel, a broken strut still trailing its fabric, the other prop blade
  {
    const spots = [[2.9, 2.2, 0.6], [-3.2, 1.2, 2.2], [3.4, -1.2, 4.0]];
    const [cx1, cz1, a1] = spots[0], gy1 = B.ground(cx1, cz1);
    B.box('rs_brass', 1.15, 0.05, 0.62, cx1, gy1 + 0.18, cz1, { ry: a1, rx: 0.25, rz: -0.18, r: 0.015, div: [4, 1, 2], smoothN: true, deform: q => { q[1] += 0.22 * (1 - (q[0] / 0.575) ** 2) - 0.05 * (q[2] / 0.31) ** 2; } });
    const [cx2, cz2, a2] = spots[1], gy2 = B.ground(cx2, cz2);
    B.push(M4(cx2, gy2 + 0.1, cz2, 0, a2, 0.12));
    B.cyl('rs_timber', 0.05, 0.05, 1.5, 0, 0, 0, { rz: Math.PI / 2, seg: 6, caps: false, lod0: false });
    B.box('rs_wing', 1.1, 0.03, 0.75, 0.15, 0.08, 0.36, { rx: -0.35, r: 0.01, div: [3, 1, 2], jit: 0.05, tint: [0.95, 0.9, 0.85] });
    B.box('rs_wing', 0.36, 0.035, 0.76, 0.52, 0.09, 0.36, { rx: -0.35, r: 0.01, tint: WING_RED });
    B.pop();
    const [cx3, cz3, a3] = spots[2], gy3 = B.ground(cx3, cz3);
    B.box('rs_timber', 0.2, 1.05, 0.06, cx3, gy3 + 0.05, cz3, { rx: -Math.PI / 2 + 0.06, ry: a3, taper: 0.55, r: 0.025 });
  }
  // the gas bag it carried, torn open and dragged over the rim: a muted oxblood envelope lying bunched on the
  // mesa top and hanging a metre and a half down the face, its hem torn into tongues, pinned at the lip by two
  // ropes to stakes, a strut of its frame poking out through it; beside it a snapped wing panel bent over the
  // rim and a coil of rope paying out down the cliff. Everything follows heightAt, so it drapes over whatever
  // shape the mesa has.
  if (p.mesa) {
    const side = p.side || 1, r0 = p.mesa.r;
    // local +z points at the road, turned up to forty degrees either way onto the straightest stretch of rim
    // in reach (a drape centred on a lobe's nose, or across a diagonal bit of rim, hangs down both sides and
    // stands up like a tent), keeping the cloth, the wing panel and the coil clear of the fuselage and the loot behind it
    // (the wreck's own wing stands well clear above them)
    const pc = Math.cos(d.ry), ps = Math.sin(d.ry);
    const clash = (lx, lz, pad) => {
      const w = B.world(lx, 0, lz), dx = w.x - d.x, dz = w.z - d.z, x = dx * pc - dz * ps, z = dx * ps + dz * pc;
      return (Math.abs(x) < 0.9 + pad && Math.abs(z) < 3.4 + pad) || (Math.abs(x) < 2.6 + pad && z < -2.9 + pad && z > -5.2 - pad);
    };
    let best = 0, bestK = Infinity;
    for (const da of [0, -0.23, 0.23, -0.46, 0.46, -0.7, 0.7]) {
      B.frame(p.x, d.y, p.z, -side * Math.PI / 2 + da);
      const xs = [-3, -2, -1, 0, 1, 2, 3], lips = [];
      for (const x of xs) {
        let z = Math.max(1, r0 * 0.3), y = B.ground(x, z);
        for (; z < r0 + 12; z += 0.1) { const y2 = B.ground(x, z + 0.1); if (y - y2 > 0.1) break; y = y2; }
        lips.push(z);
      }
      // spread of the lip across the cloth, a nose bulging out in the middle, and the turn away from the road
      const zL = lips[3], nose = Math.max(0, zL - (lips[0] + lips[6]) / 2);
      let k = (Math.max(...lips) - Math.min(...lips)) * 0.6 + nose * 3 + Math.abs(da) * (da * side > 0 ? 5 : 1.5);   // (rather toward the oncoming RV)
      for (const [lx, lz] of [[-3, lips[0] - 1.75], [3, lips[6] - 1.75], [0, zL - 1.75], [-4.8, zL - 0.6], [4.5, zL - 0.8]]) if (clash(lx, lz, 0.3)) k += 10;
      if (k < bestK) { bestK = k; best = da; }
    }
    B.frame(p.x, d.y, p.z, -side * Math.PI / 2 + best);
    const DZ = 0.04;
    // the ground's profile along local +z at local x: samples [z, y, s], the lip (where it first steepens past
    // forty-five degrees) and a lookup by arc length that also gives the outward normal
    const profile = x => {
      const P = []; let sl = 0, pz = 0, py = 0;
      for (let z = Math.max(1, r0 * 0.3); z <= r0 + 12; z += DZ) { const y = B.ground(x, z); if (P.length) sl += Math.hypot(z - pz, y - py); P.push([z, y, sl]); pz = z; py = y; }
      let iL = -1, fb = false;
      for (let i = 4; i < P.length - 1; i++) if ((P[i][1] - P[i + 1][1]) / DZ > 1.0) { iL = i; break; }
      if (iL < 0) { iL = 0; fb = true; while (iL < P.length - 2 && P[iL][0] < r0) iL++; }
      const at = sq => {
        let i = 0;
        while (i < P.length - 2 && P[i + 1][2] < sq) i++;
        const a = P[i], b = P[i + 1], k = Math.max(0, Math.min(1.5, (sq - a[2]) / Math.max(1e-6, b[2] - a[2])));
        const tz = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tz, ty) || 1;
        return { z: a[0] + tz * k, y: a[1] + ty * k, nz: -ty / tl, ny: tz / tl };
      };
      const sAtZ = z => { let i = 0; while (i < P.length - 2 && P[i + 1][0] < z) i++; return P[i][2]; };
      return { P, iL, fb, sL: P[iL][2], zL: P[iL][0], yL: P[iL][1], at, sAtZ };
    };
    const hw = range(rnd, 2.7, 3.1), ph = rnd() * 6, ph2 = rnd() * 6, NU = 20, NV = 32, TR = 0.26, LH = 3.3;
    const cols = [];
    for (let i = 0; i <= NU; i++) {
      const u = i / NU, x = (u - 0.5) * 2 * hw, pr = profile(x);
      const sT = pr.sAtZ(pr.zL - (1.45 + 0.3 * Math.sin(u * 4.3 + ph)));
      cols.push({ x, pr, sT });
    }
    // creases running diagonally down the cloth (x at the top edge, x at the hem)
    const creases = [[-hw * 0.55, hw * 0.05, 0.3], [hw * 0.7, hw * 0.2, 0.26]];
    const drapeAt = (i, t, extra = 0) => {
      const c = cols[i], { pr } = c, sq = t < TR ? lerp(c.sT, pr.sL, t / TR) : pr.sL + (t - TR) / (1 - TR) * LH;
      const q = pr.at(sq), hang = smooth(TR - 0.05, TR + 0.15, t), ds = sq - pr.sL;
      let lift = 0.05 + extra;
      // bunched low at the lip (lower still where there is no clear edge), so the cloth slumps over the rim
      // instead of tenting above the mesa's silhouette
      lift += (pr.fb ? 0.14 : 0.2) * Math.exp(-(((ds + 0.3) / 0.5) ** 2)) * (0.6 + 0.4 * Math.sin(c.x * 2.3 + ph));
      for (const [xa, xb, A] of creases) lift += A * lerp(0.3, 1, hang) * Math.exp(-(((c.x - lerp(xa, xb, t)) / 0.5) ** 2)) * smooth(0, 0.25, t);
      lift += 0.07 * (0.5 + 0.5 * Math.sin(c.x * 3.1 + ph + t * 2.5)) * (1 - hang);                     // loose folds on top
      // hanging folds: about a metre and a quarter apart, deepening toward the hem, a lit crest and a shadowed trough each
      lift += (0.07 + 0.15 * smooth(TR, 1, t)) * Math.pow(0.5 + 0.5 * Math.sin(c.x * 4.9 + ph2 + 0.8 * Math.sin(c.x * 1.6 + ph)), 1.4) * hang;
      return V(c.x, q.y + q.ny * lift, q.z + q.nz * lift);
    };
    // (on the snow day the cloth takes no top cover, which would only wash its red stripes pink: the snow lies on
    // it as drifts of its own instead)
    const BAG = ctx.snow ? 'rs_gasbag~^!' : 'rs_gasbag~^';
    B.grid(BAG, NU, NV, (u, v) => { const P2 = drapeAt(Math.round(u * NU), v); return [P2.x, P2.y, P2.z]; },
      { flip: true, noAO: true, uv: (u, v) => [lerp(0.006, 0.994, u), 1 - lerp(0.01, 0.99, v)] });
    if (ctx.snow) {
      // snow lying along the upper folds, in drifts that thin out to nothing (they dip under the cloth between
      // them), banked deepest against the bunch at the lip, none on the hanging part
      const sp1 = rnd() * 6, sp2 = rnd() * 6;
      B.grid('rs_snow!', NU, 9, (u, v) => {
        const i = Math.round(u * NU), t = v * (TR + 0.04), x = cols[i].x;
        const lump = (0.55 + 0.45 * Math.sin(x * 2.1 + sp1 + t * 6)) * (0.6 + 0.4 * Math.sin(x * 0.9 - t * 9 + sp2));
        const th = 0.085 * lump * smooth(0, 0.18, Math.min(u, 1 - u)) * (0.7 + 0.5 * smooth(TR * 0.4, TR, t)) * (1 - smooth(TR - 0.02, TR + 0.04, t)) - 0.03;
        const P2 = drapeAt(i, t, th + 0.012); return [P2.x, P2.y, P2.z];
      }, { flip: true, noAO: true, uv: (u, v, P) => [(P[0] + P[2]) / 2, P[1] / 2] });
    }
    // pinned at the lip: two ropes from grommets at its edges back to stakes driven in beside it
    for (const sx of [-1, 1]) {
      const i = sx < 0 ? 1 : NU - 1, g0 = drapeAt(i, TR - 0.04, 0.02);
      const kx = sx * (hw + 0.55), kp = profile(kx), kz = kp.zL - 1.0, ky = B.ground(kx, kz);
      B.cyl('rs_timber', 0.035, 0.06, 0.75, kx, ky + 0.2, kz, { seg: 6, rz: sx * 0.25, rx: -0.2, lod0: false });
      const top = V(kx - sx * 0.07, ky + 0.52, kz + 0.06), mid = g0.clone().lerp(top, 0.5); mid.y -= 0.06;
      B.tube('rs_rope', [g0, mid, top], 0.022, { seg: 6, lod0: false });
      B.torus('rs_rope', 0.065, 0.022, top.x, top.y - 0.02, top.z, { rx: Math.PI / 2, seg: 10, tseg: 6, lod0: true });
      B.torus('rs_brass', 0.05, 0.014, g0.x, g0.y + 0.01, g0.z, { rx: Math.PI / 2 - 0.3, seg: 8, tseg: 3, lod0: true });
    }
    // a strut of the bag's frame snapped and poking out through the hanging cloth just below the edge, out over
    // the face and a little down, so it never stands proud of the mesa's silhouette
    {
      const i = Math.round(NU * 0.64), b0 = drapeAt(i, TR + 0.05, -0.05), b1 = b0.clone().add(V(0.35, -0.12, 1.35)), bm = b0.clone().lerp(b1, 0.55); bm.y += 0.05;
      B.tube('rs_timber', [b0, bm, b1], [0.07, 0.065, 0.055], { seg: 7, lod0: false });
      const dir = b1.clone().sub(bm).normalize();
      B.tube('rs_timber', [b1, b1.clone().addScaledVector(dir, 0.22).add(V(0.04, -0.02, 0))], [0.05, 0.005], { seg: 5, lod0: true });
      const f = b0.clone().lerp(b1, 0.82);
      B.tube('rs_brass', [f.clone().addScaledVector(dir, -0.06), f.clone().addScaledVector(dir, 0.06)], 0.075, { seg: 7, ends: true });
      // the torn cloth bunched round it where it comes through
      const t0 = b0.clone().addScaledVector(dir, 0.12);
      B.push(M4(t0.x, t0.y, t0.z, 0, 0, 0));
      B.M.multiply(new THREE.Matrix4().lookAt(V(0, 0, 0), dir, V(0, 1, 0)));
      B.torus(BAG, 0.11, 0.05, 0, 0, 0, { seg: 9, tseg: 6, lod0: true, uRep: 1 });
      B.pop();
    }
    // a snapped wing panel bent over the rim: the inner half lying on the top, the outer half hanging down
    {
      const wx = -(hw + 1.9), wp = profile(wx), q = wp.at(wp.sL - 0.05), ry2 = range(rnd, -0.25, 0.1);
      B.push(M4(wx, q.y + 0.06, q.z, 0, ry2, range(rnd, -0.08, 0.08)));
      B.box('rs_wing', 1.3, 0.09, 1.2, 0, 0.03, -0.58, { r: 0.03, rx: -0.05, jit: 0.03, div: [2, 1, 2], off: [0.3, 0.1] });
      B.box('rs_wing', 0.08, 0.12, 1.25, 0.66, 0.03, -0.58, { r: 0.02, tint: [0.85, 0.8, 0.7] });
      B.push(M4(0, 0.02, 0.02, 1.15, 0, 0.06));
      B.box('rs_wing', 1.3, 0.09, 2.1, 0, 0.0, 1.06, { r: 0.03, jit: 0.04, div: [2, 1, 4], off: [0.7, 0.4] });
      B.box('rs_wing', 1.32, 0.095, 0.5, 0, 0.0, 1.9, { r: 0.03, tint: WING_RED });
      B.box(PL, 0.14, 0.12, 2.12, -0.66, 0.0, 1.06, { r: 0.03, ...TRIM });
      B.cyl('rs_brass', 0.05, 0.05, 2.15, 0.68, 0.0, 1.06, { rx: Math.PI / 2, seg: 6, caps: false });
      B.quad('rs_roundel#', 0.8, 0.8, 0.0, 0.05, 1.05, { rx: -Math.PI / 2, rz: 0.3 });
      B.pop();
      // the snapped spar and rib ends sticking out of the inner end
      for (const [ox, len, a] of [[0.66, 0.4, 0.2], [0.15, 0.25, -0.3], [-0.4, 0.32, 0.1]]) B.box('rs_timber', 0.05, 0.05, len, ox, 0.03, -1.18 - len / 2, { ry: a, r: 0.01, jit: 0.02, lod0: true });
      B.pop();
    }
    // a coil of rope lying on the top by the lip, one flat spiral seated on the ground, its free end paying out
    // over the edge in a single loose loop that hangs down the face and comes back up
    {
      const cx = hw + 1.5, cp = profile(cx), c0 = cp.at(cp.sL - 0.75), a0 = rnd() * TAU, NT = 2.5, NP = 44, coil = [];
      for (let k = NP; k >= 0; k--) {
        const t = k / NP, a = a0 + TAU * NT * t, R = lerp(0.3, 0.2, t), x = cx + Math.cos(a) * R, z = c0.z + Math.sin(a) * R;
        coil.push(V(x, B.ground(x, z) + 0.035 + 0.035 * NT * t, z));
      }
      B.tube('rs_rope', coil, 0.035, { seg: 6, lod0: false, ends: true });
      // the payout: from the coil's outer end over the lip, down about 1.2 m and back (traced on the face itself,
      // so no chord cuts through the rock)
      const end = coil[coil.length - 1];
      const ctl = [[end.x - cx, -0.75], [0.3, -0.45], [0.32, -0.1], [0.3, 0.35], [0.31, 0.85], [0.4, 1.15], [0.56, 1.24], [0.7, 1.12], [0.76, 0.8], [0.78, 0.35], [0.8, -0.05], [0.88, -0.4], [1.05, -0.62]];
      const c2 = new THREE.CatmullRomCurve3(ctl.map(([a, b]) => V(a, b, 0)), false, 'centripetal');
      const on = (xx, sq, off) => { const pp = profile(xx), q2 = pp.at(pp.sL + sq); return V(xx, q2.y + q2.ny * off, q2.z + q2.nz * off); };
      const pay = c2.getPoints(34).map((q, k) => k === 0 ? end.clone() : on(cx + q.x, q.y, q.y < -0.2 ? 0.045 : 0.08));
      B.tube('rs_rope', pay, 0.045, { seg: 6, lod0: false, capEnd: true });
    }
    // its rigging, still tied from the wreck to the top edge
    for (const u0 of [0.2, 0.5, 0.82]) {
      const a = V(range(rnd, -0.4, 0.4), 1.2, range(rnd, -0.3, 0.3)), b = drapeAt(Math.round(u0 * NU), 0.02, 0.02), m = a.clone().lerp(b, 0.5);
      m.y = Math.max(B.ground(m.x, m.z) + 0.05, m.y - 0.35);
      B.tube('rs_rope', [a, m, b], 0.032, { seg: 6, lod0: false });
    }
  }
  B.frame(d.x, d.y, d.z, d.ry);
  if (ctx.driftMat && fus) drift(B, ctx, fus.x - fus.hx - 0.1, fus.z - 0.5, 0.55, 2.4, 0.32, 0);
}

// The junk yard's shack, filling the junk_heap box: a lean-to patched together from corrugated tin and painted
// steel plates on a timber frame, a tin roof weighted with a drum and stones, a boarded door; on the roof a
// goblin derrick (its legs inside the footprint) carrying the SALVAGE board, a pulley and a boom with a
// crushed drum hanging off its hook. This is the stop's silhouette from the road.
function junkShack(B, s, ctx, rnd) {
  const hx = s.hx, hz = s.hz, top = s.y + s.hy - B.fy;
  const roofY = z => top + 0.05 - (z / hz) * 0.15;            // the roof falls toward the road
  // a dark core so no gap between the plates shows daylight
  B.box('rs_iron', hx * 2 - 0.1, top + 0.08, hz * 2 - 0.1, 0, (top + 0.08) / 2 - 0.1, 0, { r: 0.04, tint: [0.36, 0.33, 0.33] });
  // the frame: chunky corner posts (the back pair taller), a rail round the middle and the top
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const h = roofY(sz * hz) + 0.05;
    B.box('rs_timber', 0.2, h + 0.1, 0.2, sx * (hx - 0.06), (h + 0.1) / 2 - 0.1, sz * (hz - 0.06), { r: 0.04, jit: 0.02, rz: range(rnd, -0.02, 0.02), off: [rnd(), 0] });
  }
  const plates = [['rs_tin', null], ['rs_tin', [1.15, 0.74, 0.6]], ['rs_steel_red', null], ['rs_steel_teal', [0.92, 0.95, 1.0]], ['rs_steel_red', [1.2, 1.0, 0.62]], ['rs_planks_gray', null], ['rs_tin', [0.95, 0.9, 0.85]]];
  // the four walls, each a patchwork of plates lapped over each other, bowed a little, a few hanging crooked
  for (const [fx, fz, ry, half] of [[0, hz, 0, hx], [0, -hz, Math.PI, hx], [hx, 0, Math.PI / 2, hz], [-hx, 0, -Math.PI / 2, hz]]) {
    B.push(M4(fx, 0, fz, 0, ry, 0));
    const wallTop = fz > 0 ? roofY(hz) - 0.06 : fz < 0 ? roofY(-hz) - 0.06 : null;
    let k = 0;
    for (const [y0, y1] of [[-0.05, 1.45 + range(rnd, -0.15, 0.15)], [1.25, 9]]) {
      let x = -half - 0.05;
      while (x < half + 0.02) {
        const w = Math.min(range(rnd, 0.75, 1.25), half + 0.08 - x), [m, tn] = pick(rnd, plates), cx = x + w / 2;
        // the side walls follow the roof's fall
        const yt = wallTop ?? (roofY(ry > 0 ? -cx : cx) - 0.06);   // (a side wall's local x runs along the frame's z)
        const yy1 = Math.min(y1, yt), hh = yy1 - y0;
        if (hh > 0.1 && w > 0.12) {
          const bow = range(rnd, 0.01, 0.035);
          B.box(m, w + 0.06, hh, 0.035, cx, y0 + hh / 2, 0.03 + (k % 3) * 0.012, { r: 0.012, rz: range(rnd, -0.04, 0.04), off: [rnd() * 3, rnd()], tint: tn, div: [2, 2, 1], smoothN: true,
            deform: q => { q[2] += bow * (1 - (2 * q[0] / w) ** 2) * (1 - (2 * q[1] / hh) ** 2); } });
          // a nailed batten down the lap
          if (rnd() < 0.5) B.box('rs_timber', 0.08, hh * 0.9, 0.04, x + 0.04, y0 + hh / 2, 0.07 + (k % 3) * 0.012, { r: 0.015, lod0: true });
        }
        x += w - 0.06; k++;
      }
    }
    // mid and top rails
    if (fz !== 0) for (const yy of [1.3, (wallTop ?? top) - 0.12]) B.box('rs_timber', half * 2 + 0.1, 0.14, 0.1, 0, yy, 0.09, { r: 0.03, rz: range(rnd, -0.015, 0.015), off: [rnd(), 0] });
    B.pop();
  }
  // the boarded door on the road face, an old horseshoe of rims nailed over it
  {
    const dx = range(rnd, -0.45, 0.45), z = hz + 0.1;
    B.box('rs_planks_gray', 0.95, 1.95, 0.05, dx, 0.95, z, { r: 0.015, rot: true, tint: [0.62, 0.58, 0.58] });
    for (const sx of [-1, 1]) B.box('rs_timber', 0.12, 2.05, 0.08, dx + sx * 0.52, 1.0, z + 0.02, { r: 0.02 });
    B.box('rs_timber', 1.2, 0.12, 0.09, dx, 2.02, z + 0.02, { r: 0.02 });
    for (let k = 0; k < 3; k++) B.box('rs_planks_gray', 1.25, 0.16, 0.04, dx, 0.5 + k * 0.55 + range(rnd, -0.08, 0.08), z + 0.06, { r: 0.012, rz: range(rnd, -0.22, 0.22), jit: 0.01 });
    B.cyl('rs_brass', 0.04, 0.04, 0.1, dx + 0.32, 1.0, z + 0.08, { rx: Math.PI / 2, seg: 6, lod0: true });
  }
  // the roof: corrugated sheets lapped across, overhanging the road face, held down by a drum and stones
  const fall = Math.atan2(0.3, hz * 2), L = hz * 2 + 0.75, zc = 0.2;
  let x = -hx - 0.15, i = 0;
  while (x < hx + 0.1) {
    const w = Math.min(range(rnd, 0.95, 1.2), hx + 0.2 - x), cx = x + w / 2;
    B.box('rs_tin', w + 0.08, 0.045, L + range(rnd, -0.1, 0.1), cx, roofY(zc) + 0.035 + (i % 2) * 0.02, zc, { r: 0.012, rx: fall, rz: range(rnd, -0.025, 0.025), off: [rnd(), rnd()], tint: i % 2 ? [1.12, 0.78, 0.64] : null });
    x += w - 0.07; i++;
  }
  B.box('rs_timber', hx * 2 + 0.3, 0.12, 0.12, 0, roofY(hz + 0.3) - 0.05, hz + 0.3, { r: 0.03 });
  barrel(B, 'rs_drum', 0.28, 0.82, -hx * 0.45, roofY(-0.5) + 0.3, -0.5, { rz: Math.PI / 2, ry: 0.3 });
  for (const [sx2, sz2] of [[0.55, 0.6], [0.9, -0.7]]) B.box('rs_iron', 0.36, 0.2, 0.24, sx2 * hx, roofY(sz2 * hz) + 0.13, sz2 * hz, { r: 0.05, jit: 0.03, ry: rnd() * 3, tint: [0.9, 0.78, 0.68] });
  if (ctx.snow) {
    snowCap(B, hx * 2 + 0.25, L - 0.1, 0, roofY(zc) + 0.07, zc, { t: 0.2, rx: fall });
    icicles(B, -hx - 0.1, hz + 0.55, hx + 0.1, hz + 0.55, roofY(hz + 0.55) - 0.02, rnd, { max: 0.35 });
  }
  // the derrick: four timber legs from inside the roof's corners up to a small cap, iron-banded, braced in
  // rings and an X of rods on its face
  const bx0 = hx - 0.4, bz0 = hz - 0.35, H = 3.5, tw = 0.24, yb = roofY(0) + 0.02, yT = yb + H;
  const leg = (sx, sz, t) => V(lerp(sx * bx0, sx * tw, t), lerp(roofY(sz * bz0) + 0.02, yT, t), lerp(sz * bz0, sz * tw, t));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    B.tube('rs_timber', [leg(sx, sz, -0.02), leg(sx, sz, 0.5), leg(sx, sz, 1.03)], [0.085, 0.075, 0.06], { seg: 7, lod0: false });
    for (const t of [0.04, 0.5]) { const q = leg(sx, sz, t); B.cyl('rs_iron', 0.09, 0.09, 0.08, q.x, q.y, q.z, { seg: 7, caps: false, lod0: true }); }
  }
  for (const t of [0.34, 0.68]) for (const [a, b] of [[[-1, -1], [1, -1]], [[1, -1], [1, 1]], [[1, 1], [-1, 1]], [[-1, 1], [-1, -1]]]) B.tube('rs_timber', [leg(a[0], a[1], t), leg(b[0], b[1], t)], 0.045, { seg: 5, lod0: false });
  for (const [t0, t1] of [[0.0, 0.34], [0.34, 0.68]]) for (const sx of [-1, 1]) B.tube('rs_iron', [leg(sx, 1, t0), leg(-sx, 1, t1)], 0.016, { seg: 4, lod0: true });
  B.box('rs_timber', tw * 2 + 0.3, 0.14, tw * 2 + 0.3, 0, yT + 0.05, 0, { r: 0.03 });
  // the pulley on top, the boom out over the road face, its chain and hook with a crushed drum on it
  B.push(M4(0, yT + 0.4, 0, 0, Math.PI / 2, 0));
  B.torus('rs_brass', 0.26, 0.05, 0, 0, 0, { seg: 14, tseg: 5, lod0: false });
  B.cyl('rs_iron', 0.07, 0.07, 0.2, 0, 0, 0, { rx: Math.PI / 2, seg: 8 });
  for (let k = 0; k < 4; k++) B.box('rs_brass', 0.04, 0.48, 0.03, 0, 0, 0, { rz: k * Math.PI / 4, r: 0.01, lod0: true });
  B.pop();
  for (const sx of [-1, 1]) B.box('rs_timber', 0.06, 0.5, 0.12, sx * 0.13, yT + 0.3, 0, { r: 0.015 });
  const b0 = V(0, yT + 0.12, -tw), b1 = V(0, yT + 0.35, hz + 1.0);
  B.tube('rs_timber', [b0, b0.clone().lerp(b1, 0.5), b1], [0.09, 0.08, 0.065], { seg: 7, lod0: false });
  B.tube('rs_iron', [V(0, yT + 0.62, 0), b1.clone().add(V(0, 0.02, 0))], 0.014, { seg: 4, lod0: true });
  const hookY = top + 0.55;
  for (let y = b1.y - 0.06, k = 0; y > hookY + 0.1; y -= 0.1, k++) B.torus('rs_iron', 0.045, 0.014, b1.x, y, b1.z, { ry: k % 2 ? Math.PI / 2 : 0, rx: Math.PI / 2 * 0, seg: 6, tseg: 3, lod0: true, s: [1, 1.4, 1] });
  B.torus('rs_iron', 0.12, 0.03, b1.x, hookY, b1.z, { seg: 10, tseg: 4, lod0: false });
  B.push(M4(b1.x, hookY - 0.38, b1.z + 0.05, 0.1, 0.4, Math.PI / 2 + 0.15));
  B.cyl('rs_drum_red', 0.3, 0.3, 0.86, 0, 0, 0, { s: [1, 1, 0.6], seg: 12, caps: 'rs_drum_lid', jit: 0.07 });
  B.pop();
  // the SALVAGE board across the derrick's road face, leaning back with it
  {
    const t = 0.42, q = leg(1, 1, t), lean = Math.atan2(bz0 - tw, H);
    B.box('rs_timber', 2.3, 0.74, 0.08, 0, q.y, q.z + 0.12, { r: 0.025, rx: -lean, rz: range(rnd, -0.03, 0.03), faces: { pz: { m: 'rs_junkboard', fit: true }, nz: { m: 'rs_junkboard', fit: true } } });
    if (ctx.snow) snowCap(B, 2.3, 0.08, 0, q.y + 0.37, q.z + 0.12, { t: 0.07, lip: 0.02, ext: 0.03, lod0: true });
  }
  if (ctx.snow) snowCap(B, tw * 2 + 0.3, tw * 2 + 0.3, 0, yT + 0.12, 0, { t: 0.1, lod0: true });
  if (ctx.driftMat) { drift(B, ctx, -hx - 0.15, -0.2, 0.55, 1.4, ctx.snow ? 0.5 : 0.32, 0); drift(B, ctx, hx * 0.3, -hz - 0.15, 1.3, 0.5, 0.3, 0); }
}
// Yard clutter that is never loot: rusted rims nailed to a post, a crushed drum or two, a crate stack.
function junkDecor(B, ctx, rnd, x, z, kind) {
  const gy = B.ground(x, z);
  if (kind === 'rims') {
    B.cyl('rs_timber', 0.09, 0.12, 2.1, x, gy + 0.85, z, { seg: 8, rz: range(rnd, -0.04, 0.04), off: [rnd(), 0] });
    B.box('rs_timber', 0.5, 0.12, 0.1, x, gy + 1.82, z, { r: 0.02, rz: 0.1 });
    for (const [yy, ox] of [[0.62, 0.05], [1.12, -0.04], [1.55, 0.06]]) {
      B.push(M4(x + ox, gy + yy, z + 0.14, Math.PI / 2 + range(rnd, -0.15, 0.15), 0, range(rnd, -0.2, 0.2)));
      const r = range(rnd, 0.3, 0.36), tn = pick(rnd, [[1.0, 0.92, 0.85], [1.1, 0.8, 0.62], [0.85, 0.8, 0.8]]);
      B.lathe('rs_steel_red', [[r - 0.03, -0.08], [r, -0.065], [r - 0.035, -0.04], [r - 0.035, 0.04], [r, 0.065], [r - 0.03, 0.08]], 0, 0, 0, { seg: 14, tint: tn, S: 0.8 });
      B.cyl('rs_steel_red', r - 0.04, r - 0.04, 0.02, 0, 0.0, 0, { seg: 14, tint: tn.map(c => c * 0.8), S: 0.8 });
      B.cyl('rs_iron', 0.08, 0.08, 0.05, 0, 0.03, 0, { seg: 8, tint: [0.7, 0.6, 0.55], lod0: true });
      B.pop();
    }
    if (ctx.snow) B.ell('rs_snow!', 0.14, 0.06, 0.14, x, gy + 1.92, z, { seg: 8, rings: 4, noAO: true, lod0: true });
  } else {
    // two crushed drums on their sides, one stood up dented, a crate stack beside them
    for (const [dx, dz, ry, m] of [[0, 0, 0.3, 'rs_drum'], [0.15, 0.7, -0.2, 'rs_drum_red']]) {
      B.cyl(m, 0.3, 0.3, 0.86, x + dx, B.ground(x + dx, z + dz) + 0.18, z + dz, { rz: Math.PI / 2, ry, s: [0.62, 1, 1.05], seg: 12, caps: 'rs_drum_lid', jit: 0.06 });
    }
    B.cyl('rs_drum', 0.3, 0.3, 0.88, x - 0.7, B.ground(x - 0.7, z + 0.3) + 0.42, z + 0.3, { seg: 12, caps: 'rs_drum_lid', jit: 0.05, rx: 0.06, s: [1, 0.93, 0.9] });
    const cx = x - 0.4, cz = z - 0.8, cg = B.ground(cx, cz);
    B.box('rs_crate_b', 0.72, 0.62, 0.66, cx, cg + 0.31, cz, { r: 0.03, ry: range(rnd, -0.15, 0.15) });
    B.box('rs_crate_a', 0.58, 0.5, 0.56, cx + 0.05, cg + 0.87, cz + 0.02, { r: 0.03, ry: range(rnd, 0.3, 0.6) });
    if (ctx.snow) snowCap(B, 0.5, 0.48, cx + 0.05, cg + 1.12, cz + 0.02, { t: 0.08, lod0: true });
  }
}

// junk: stencilled crates stacked into their boxes, barrels in banded clusters on pallets, scrap heaps
// built from recognisable wreckage
function buildJunk(B, p, parts, ctx) {
  for (const s of parts) {
    const gy = ctx.H(s.x, s.z);
    B.frame(s.x, gy, s.z, s.ry || 0);
    const rnd = rngOf(seedOf(s.x, s.z, 7));
    if (s.part === 'junk_heap') { junkShack(B, s, ctx, rnd); continue; }
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
      // The scrap heap: a mound of junk soil whose plateau is the collider's top (about sixty percent of the
      // footprint), steep flanks flaring a little past the box, shingled with tilted plates of painted steel,
      // tin and doped canvas whose corners poke out of the silhouette, and two or three long things sticking
      // out over the top.
      const base = Math.min(0, bot) - 0.06, ph = rnd() * TAU;
      const rings = [[s.hx + 0.3, s.hz + 0.3, base], [s.hx + 0.1, s.hz + 0.1, base + (top - base) * 0.35], [s.hx * 0.82, s.hz * 0.82, top - 0.12], [s.hx * 0.66, s.hz * 0.66, top - 0.02], [0, 0, top + 0.05]];
      const shapeAt = (u, v) => {
        const th = u * TAU, k = v * 4, i = Math.min(3, Math.floor(k)), t = k - i, A = rings[i], Bq = rings[i + 1];
        const w = lerp(A[0], Bq[0], t), d = lerp(A[1], Bq[1], t), y = lerp(A[2], Bq[2], t);
        const lump = 1 + 0.08 * Math.sin(th * 3 + ph) + 0.06 * Math.sin(th * 5 + ph * 2) * (1 - v);
        const sx2 = Math.sin(th), cz = Math.cos(th), e = 0.7;   // a rounded box outline
        return [Math.sign(sx2) * Math.pow(Math.abs(sx2), e) * w * lump, y + (v > 0.6 ? 0.05 * Math.sin(th * 2 + ph) : 0), Math.sign(cz) * Math.pow(Math.abs(cz), e) * d * lump];
      };
      const perim = 2 * (s.hx + s.hz) * 2.1;
      B.grid('rs_scrap', 18, 4, shapeAt, { wrapU: true, tint: [1.12, 1.06, 1.0], uv: (u, v, P) => { const w = B.world(P[0], P[1], P[2]); return v >= 0.5 ? [w.x, w.z] : [u * perim, P[1]]; } });
      // four plate materials (the crash and the crates share most of them), varied by tint
      const steel = [['rs_steel_red', null], ['rs_steel_red', [1.2, 0.95, 0.6]], ['rs_steel_teal', null], ['rs_steel_teal', [0.85, 0.9, 1.15]], ['rs_tin', null], ['rs_tin', [1.1, 0.8, 0.65]], ['rs_wing', [0.9, 0.82, 0.72]]];
      // plates shingled in rows up the flanks and across the plateau, each row's lapping over the one below
      const rowsP = [[0.1, 0.62, 0.85], [0.3, 0.75, 0.75], [0.5, 0.95, 0.55], [0.74, 0.4, 0.3]];
      for (const [v0, aMin, aMax] of rowsP) {
        const n = Math.max(3, Math.round(perim * (v0 > 0.6 ? 0.45 : 1) / 0.62));
        const u0 = rnd();
        for (let k = 0; k < n; k++) {
          if (rnd() < 0.12) continue;
          const onTop = v0 > 0.6, u = u0 + (k + range(rnd, -0.25, 0.25)) / n, v = v0 + range(rnd, -0.06, 0.06);
          const P = shapeAt(((u % 1) + 1) % 1, v), th = u * TAU, a = range(rnd, aMin, aMax);
          const w = range(rnd, 0.5, 0.95), dd = range(rnd, 0.34, 0.66), bend = range(rnd, -0.12, 0.12), [m, mt] = pick(rnd, steel);
          B.push(M4(P[0] + Math.sin(th) * 0.06, P[1] + 0.03, P[2] + Math.cos(th) * 0.06, a, onTop ? rnd() * TAU : th + range(rnd, -0.45, 0.45), range(rnd, -0.3, 0.3)));
          B.box(m, w, 0.035, dd, 0, 0, 0, { r: 0.012, div: [3, 1, 2], smoothN: true, jit: 0.02, off: [rnd() * 3, rnd() * 3], tint: mt, deform: q => { q[1] += bend * (q[0] / w * 2) ** 2 - 0.04 * (q[2] / dd * 2) ** 2; } });
          B.pop();
        }
      }
      // long things over the top: a bent pipe, an axle with half a wheel, a goblin rocket fin, a ladder
      const longs = ['pipe', 'axle', 'fin', 'ladder', 'cog'];
      for (let i = longs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [longs[i], longs[j]] = [longs[j], longs[i]]; }
      for (let k = 0; k < 2 + (rnd() < 0.5 ? 1 : 0); k++) {
        const it = longs[k], a = rnd() * TAU, ox = Math.sin(a) * s.hx * 0.35, oz = Math.cos(a) * s.hz * 0.35, out = V(Math.sin(a), 0, Math.cos(a));
        if (it === 'pipe') {
          const p0 = V(ox, top - 0.25, oz), p1 = p0.clone().add(V(0, 0.55, 0)).addScaledVector(out, 0.15), p2 = p0.clone().add(V(0, 0.75, 0)).addScaledVector(out, 0.55), p3 = p0.clone().add(V(0, 0.55, 0)).addScaledVector(out, 1.0);
          B.tube('rs_iron', [p0, p1, p2, p3], 0.055, { seg: 7, lod0: false, tint: [1.1, 0.85, 0.7] });
          B.cyl('rs_brass', 0.09, 0.09, 0.05, p3.x, p3.y, p3.z, { seg: 8, rx: Math.PI / 2 - 0.6, ry: a, lod0: false });
        } else if (it === 'axle') {
          B.push(M4(ox, top + 0.1, oz, 0, a, 0.5));
          B.cyl('rs_iron', 0.05, 0.05, 1.3, 0, 0.3, 0, { seg: 7, lod0: false });
          B.push(M4(0, 0.85, 0, Math.PI / 2, 0, 0));
          const arc = []; for (let q = 0; q <= 8; q++) { const t = Math.PI * q / 8; arc.push(V(Math.cos(t) * 0.5, Math.sin(t) * 0.5, 0)); }
          B.tube('rs_timber', arc, 0.05, { seg: 6, lod0: false });
          for (let q = 1; q < 4; q++) { const t = Math.PI * q / 4; B.box('rs_timber', 0.05, 0.5, 0.04, Math.cos(t) * 0.25, Math.sin(t) * 0.25, 0, { rz: t - Math.PI / 2, r: 0.01, lod0: false }); }
          B.cyl('rs_iron', 0.1, 0.1, 0.16, 0, 0, 0, { rx: Math.PI / 2, seg: 8 });
          B.pop(); B.pop();
        } else if (it === 'fin') {
          B.push(M4(ox, top + 0.2, oz, range(rnd, -0.4, 0.4), a, range(rnd, 0.3, 0.6)));
          B.box('rs_wing', 0.06, 1.0, 0.7, 0, 0.3, 0, { r: 0.02, taper: 0.35, tint: [1.0, 0.95, 0.85], deform: q => { q[2] -= (q[1] + 0.5) * 0.35; } });
          B.box('rs_steel_red', 0.07, 0.18, 0.62, 0, 0.0, 0.03, { r: 0.02, taper: 0.9 });
          B.pop();
        } else if (it === 'ladder') {
          B.push(M4(ox, top - 0.1, oz, 0.55, a, range(rnd, -0.2, 0.2)));
          for (const sx2 of [-0.22, 0.22]) B.box('rs_timber', 0.06, 1.6, 0.06, sx2, 0.6, 0, { r: 0.015, lod0: false });
          for (let q = 0; q < 4; q++) if (q !== 2) B.box('rs_timber', 0.46, 0.05, 0.05, 0, 0.1 + q * 0.38, 0, { r: 0.01, rot: true, lod0: false, rz: q === 3 ? 0.15 : 0 });
          B.pop();
        } else {
          B.push(M4(ox, top + 0.08, oz, Math.PI / 2 - 0.7, a, 0));
          B.cyl('rs_brass', 0.34, 0.34, 0.08, 0, 0, 0, { seg: 14, caps: 'rs_brass' });
          for (let q = 0; q < 10; q++) { const t = TAU * q / 10; B.box('rs_brass', 0.11, 0.08, 0.1, Math.sin(t) * 0.38, 0, Math.cos(t) * 0.38, { ry: t, r: 0.012 }); }
          B.cyl('rs_iron', 0.08, 0.08, 0.12, 0, 0, 0, { seg: 8 });
          B.pop();
        }
      }
    }
  }
  // beside the shack: rims nailed to a post on one side, crushed drums and a crate stack on the other
  // (nothing that could be mistaken for loot: the loot tyres are whitewalls)
  B.frame(p.x, p.y, p.z, p.ry || 0);
  const rnd = rngOf(seedOf(p.x, p.z, 8)), sd = rnd() < 0.5 ? -1 : 1;
  junkDecor(B, ctx, rnd, sd * 2.75, -5.0, 'rims');
  junkDecor(B, ctx, rnd, -sd * 2.9, -5.3, 'drums');
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
    B.box(body, 0.68, 1.12, 0.48, 0, 0.86, 0, { r: 0.08, taper: 0.94, fit: 'v', faces: { pz: { m: 'rs_pump_face', fit: true }, nz: { m: 'rs_pump_face', fit: true } } });
    // a rounded crown: a brass band, then a domed cap in the body colour
    B.box('rs_brass', 0.68, 0.08, 0.48, 0, 1.44, 0, { r: 0.035 });
    B.box(body, 0.64, 0.2, 0.44, 0, 1.52, 0, { r: 0.09, div: [2, 1, 2], smoothN: true, fit: 'v', deform: q => { if (q[1] > 0) { const k = 1 - 0.35 * ((q[0] / 0.32) ** 2 + (q[2] / 0.22) ** 2) / 2; q[1] *= Math.max(0.3, k); } } });
    // the big brass dial bezels, the glass globe on its collar
    for (const sz of [-1, 1]) B.torus('rs_brass', 0.235, 0.032, 0, 1.16, sz * 0.245, { seg: 18, tseg: 5, lod0: false });
    B.cyl('rs_brass', 0.1, 0.14, 0.1, 0, 1.64, 0, { seg: 12 });
    B.ell('rs_headlamp*', 0.16, 0.17, 0.16, 0, 1.85, 0, { seg: 14, rings: 8 });
    B.cyl('rs_brass', 0.05, 0.08, 0.07, 0, 2.04, 0, { seg: 8 });
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
    for (let k = 0; k < 5; k++) B.box('rs_timber', 0.18, 0.2, 5.2, ccx - 3.9 + k * 1.95 + range(rnd, -0.15, 0.15), top + 0.15, ccz, { r: 0.03 });
    // a steep roof (about thirty degrees) with deep eaves and rafter tails, gable ends of boards
    const run = 2.35, rise = 1.3, eave = 0.6, ang = Math.atan2(rise, run), slen = (run + eave) / Math.cos(ang) + 0.08;
    const ry0 = top + 0.27, ridgeY = ry0 + rise, roofL = 9.2;
    const midH = (run + eave) / 2 - 0.02, midY = ridgeY - midH * Math.tan(ang) + 0.07;
    for (const sz of [-1, 1]) {
      const o = { rx: ang, ry: sz < 0 ? Math.PI : 0 };
      B.box(roofMat, roofL, 0.12, slen, ccx, midY, ccz + sz * midH, { ...o, faces: { ny: 'rs_planks_gray', py: { m: roofMat, rot: roofMat === 'rs_slate' } }, r: 0.03 });
      const eaveY = ridgeY - (run + eave) * Math.tan(ang);
      B.box('rs_fascia', roofL + 0.05, 0.45, 0.07, ccx, eaveY - 0.12, ccz + sz * (run + eave + 0.03), { fit: 'v', r: 0.02, ry: sz < 0 ? Math.PI : 0 });
      for (let x = ccx - roofL / 2 + 0.25; x < ccx + roofL / 2 - 0.2; x += range(rnd, 0.5, 0.65)) B.box('rs_timber', 0.09, 0.11, 0.42, x, eaveY + 0.12, ccz + sz * (run + eave - 0.25), { rx: sz * ang, r: 0.02, lod0: true });
      for (const sx of [-1, 1]) B.box('rs_timber', 0.08, 0.24, slen + 0.02, ccx + sx * (roofL / 2 + 0.02), midY - 0.05, ccz + sz * midH, { ...o, r: 0.02 });
      for (const sx of [-1, 1]) lantern(B, ccx + sx * 3.4, eaveY - 0.5, ccz + sz * (run + eave - 0.35), 0.15, ctx.bio.kit === 'goblin' ? 'rs_brass' : 'rs_iron');
      if (ctx.snow) {
        snowCap(B, roofL - 0.2, slen - 0.12, ccx, midY + 0.07, ccz + sz * midH, { t: 0.2, ...o });
        icicles(B, ccx - roofL / 2 + 0.2, ccz + sz * (run + eave + 0.08), ccx + roofL / 2 - 0.2, ccz + sz * (run + eave + 0.08), eaveY - 0.34, rnd, { max: 0.35 });
      }
    }
    B.box(ctx.bio.kit === 'goblin' ? 'rs_brass' : 'rs_iron', roofL + 0.1, 0.16, 0.34, ccx, ridgeY + 0.08, ccz, { r: 0.05 });
    for (const sx of [-1, 1]) B.box('rs_planks_gray', 0.08, rise, run * 2, ccx + sx * (roofL / 2 - 0.3), ry0 + rise / 2, ccz, { r: 0.015, rot: true, div: [1, 2, 2], deform: q => { q[2] *= Math.max(0.02, 0.5 - q[1] / rise); } });
    // the stop's name on a board standing on the ridge, facing the road (and the pumps' side)
    for (const sx of [-1, 1]) { B.box('rs_timber', 0.14, 1.25, 0.14, ccx + sx * 1.45, ridgeY + 0.5, ccz, { r: 0.03 }); B.box('rs_timber', 0.1, 0.75, 0.1, ccx + sx * 1.15, ridgeY + 0.3, ccz, { rz: sx * 0.7, r: 0.02 }); }
    B.box('rs_timber', 3.9, 0.95, 0.1, ccx, ridgeY + 0.85, ccz + 0.08, { r: 0.03, rz: range(rnd, -0.015, 0.015), faces: { pz: { m: 'rs_gasboard', fit: true }, nz: { m: 'rs_gasboard', fit: true } } });
    if (ctx.snow) snowCap(B, 3.9, 0.1, ccx, ridgeY + 1.32, ccz + 0.08, { t: 0.08, lip: 0.03, ext: 0.03 });
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

// The dino: a painted plaster sauropod on a stone plinth that fills its collider, read from the road by its
// silhouette: a pear-shaped body (narrow shoulders, full hips under a hump, the belly sagging between the legs),
// elephant legs with bulging thighs and cream toenails, a row of terracotta back plates running from the tail
// tip up the back and the neck, a heavy tail in a gentle S that droops at the tip, and a long swan neck that
// climbs out of the shoulders through its column and arches forward over the plinth toward the road, where it
// ends in a jagged break: a pale ring of snapped plaster round the dark hollow, rebar bent out of it (the head
// is loot, lying on the ground under the break). Snow day: a blanket of snow along the back, ridges on the
// neck's arch and the tail, icicles under the arch.
const DINO_NECK = [[3.2, -0.15, 0.8], [3.9, 0.75, 0.72], [4.7, 1.25, 0.6], [5.5, 1.42, 0.52], [6.2, 1.56, 0.47], [6.78, 1.92, 0.44], [7.02, 2.48, 0.41], [6.9, 3.02, 0.39]];
function buildDino(B, p, parts, ctx) {
  const d = p.dino || { x: p.x, y: p.y, z: p.z, ry: p.ry || 0 };
  B.frame(d.x, d.y, d.z, d.ry);
  const L = parts.map(s => B.loc(s));
  const body = L.find(s => s.part === 'dino_body'), torso = L.find(s => s.part === 'dino_torso'), tail = L.find(s => s.part === 'dino_tail'), neck = L.find(s => s.part === 'dino_neck');
  const legs = L.filter(s => s.part === 'dino_leg');
  const tint = ctx.bio.dino;
  if (!body) return;
  const S = 6;
  // u runs along the body (one tile per 6 m), v from belly (0) to back (1) by how the surface faces `up`
  const vOf = (nl, up, bias = 0) => { const dd = Math.max(-1, Math.min(1, nl.x * up[0] + nl.y * up[1] + nl.z * up[2] + bias)); return 0.5 + 0.46 * Math.sign(dd) * Math.pow(Math.abs(dd), 0.8); };
  const uvBody = (pl, nl) => [(pl.z + pl.x * 0.15) / S, vOf(nl, [0, 1, 0])];
  // (v0, v1 squeeze a tube's v into part of the band so it does not wrap the whole belly-to-spine stripe)
  const uvTube = (u0, du, up, bias = 0, v0 = 0, v1 = 1) => (pl, nl, v) => [u0 + du * v.uv[1], lerp(v0, v1, vOf(nl, up, bias))];
  const uvLeg = (u0, up) => (pl, nl, v) => [u0 + v.uv[0], lerp(0.42, 0.62, vOf(nl, up, 0.1))];
  const rnd = rngOf(seedOf(p.x, p.z, 13));
  const stoneT = STONE_TINT[ctx.bio.kit];
  const bz = body.z, bx = body.x, phx = body.hx - 0.02, phz = body.hz - 0.02, ptop = 1.1;
  const PLATE = tint.map((c, i) => c * [0.9, 0.55, 0.47][i]);     // terracotta: the belly's ochre, reddened
  // the plinth: base course, a recessed waist with the plaque, a cap, all inside the collider's footprint
  B.box('rs_stone', phx * 2, 0.6, phz * 2, bx, -0.1, bz, { r: 0.05, S: 2.8, tint: stoneT });
  B.box('rs_stone', (phx - 0.06) * 2, 0.62, (phz - 0.06) * 2, bx, 0.5, bz, { r: 0.04, S: 2.8, off: [0.3, 0.2], tint: stoneT });
  B.box('rs_stone', phx * 2, 0.2, phz * 2, bx, ptop - 0.1, bz, { r: 0.06, S: 2.8, off: [0.6, 0.1], tint: stoneT });
  B.quad('rs_plaque', 1.5, 0.5, bx, 0.52, bz + phz - 0.06 + 0.02, {});
  // painted rockwork under the belly
  B.box('rs_rock', 2.2, 0.8, 3.6, bx, ptop + 0.3, bz - 0.15, { r: 0.35, jit: 0.16, div: [3, 1, 4], smoothN: true, S: 1.4, tint: [0.66, 0.7, 0.56] });
  // the body fills the dino_torso box (its widest, longest and lowest points on the box's faces, the hump just
  // proud of its top), so you can neither see into the collider nor walk into the body
  const T = torso || { hx: body.hx - 0.06, hz: body.hz - 0.08, y: 2.92, hy: 1.24 };
  const ax = T.hx + 0.02, az = T.hz, yc = T.y - 0.02, ay = T.hy - 0.1, e = 2.2, ev = 2.0, evLow = 2.3, humpK = torso ? 0.16 : 0.35;
  const shape = (zn, yN) => {
    const narrow = 1 - 0.2 * smooth(0.15, 0.95, zn);                                     // narrow shoulders
    const hump = yN > 0 ? yN * yN * humpK * Math.exp(-(((zn + 0.5) / 0.45) ** 2)) : 0;   // over the hips
    const sag = yN < 0 ? -yN * 0.12 * Math.exp(-((zn / 0.45) ** 2)) : 0;               // between the legs
    const front = yN > 0 ? yN * 0.18 * smooth(0.4, 1, zn) : 0;                          // the shoulders lean into the neck
    return { narrow, dy: hump - sag + front };
  };
  const bodyAt = (u, v) => {
    const th = TAU * u, ph = -Math.PI / 2 + Math.PI * v;
    const ee = ph < 0 ? evLow : ev, r = sp(Math.cos(ph), ee), y = sp(Math.sin(ph), ee);
    const zn = r * sp(Math.cos(th), e), { narrow, dy } = shape(zn, y);
    return [bx + ax * narrow * r * sp(Math.sin(th), e), yc + ay * y + dy, bz + az * zn];
  };
  B.grid('rs_dino', 28, 16, bodyAt, { wrapU: true, uvFn: uvBody, tint });
  const topAt = zz => { const zn = clamp01(Math.abs((zz - bz) / az)) * Math.sign(zz - bz), c = Math.pow(Math.abs(zn), ev / 2), y = Math.pow(Math.max(0, 1 - c * c), 1 / ev); return yc + ay * y + shape(zn, y).dy; };
  // A back plate: a flattened rounded cone standing on the spine at `at`, its face across `up`, its length along `along`
  const plateProf = [[1, -0.2], [1, 0], [0.93, 0.28], [0.74, 0.56], [0.46, 0.8], [0.16, 0.96], [0, 1]];
  const plate = (at, up, along, h, len, k) => {
    const Y = up.clone().normalize(), Z = along.clone().sub(Y.clone().multiplyScalar(along.dot(Y))).normalize(), X = Y.clone().cross(Z);
    B.push(new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(at));
    B.lathe('rs_dino', plateProf, 0, 0, 0, { s: [0.065 + h * 0.06, h, len / 2], seg: 10, uvFn: (pl, nl) => [k * 0.17 + pl.z / S, lerp(0.06, 0.3, 0.5 + 0.5 * nl.y)], tint: PLATE });
    B.pop();
  };
  // the back: plates down the spine, the biggest over the hips, each standing square to the curve of the back
  for (let k = 0; k < 7; k++) {
    const zz = bz + az * 0.5 - k * 0.6, h = 0.33 + 0.24 * Math.exp(-(((k - 3.6) / 2.2) ** 2)), sl = (topAt(zz + 0.1) - topAt(zz - 0.1)) / 0.2;
    plate(V(bx, topAt(zz) - 0.07, zz), V(0, 1, -sl * 0.8), V(0, 0, 1), h, 0.5 + h * 0.3, k);
  }
  // elephant legs: a round foot with three cream toenails, a knee, a full thigh (bulging on the hind legs) that
  // runs up into a rounded haunch on the flank, so the leg grows out of the body instead of standing beside it;
  // the front legs set a few degrees forward
  for (const l of legs) {
    // each leg stands in its own collider box (the feet on the plinth, the knee at the box's top); the haunch
    // stays inside the torso box (its outer face on the box's side)
    const sx = Math.sign(l.x - bx) || 1, fo = torso ? Math.min(Math.abs(l.x - bx), 1.2) : ax - 0.62, fz = l.z, front = fz > bz;
    const at = k => bx + sx * fo * k;
    const lr = torso ? Math.min(0.5, l.hx + 0.06) : 0.58, lean = front ? 0.06 : -0.02, thigh = front ? lr + 0.04 : lr + 0.12, knee = torso ? l.y + l.hy : ptop + 0.72;
    // the thigh swells into a round haunch on the flank (its outer face on the torso box's side) and narrows
    // back into the body, its end capped well inside the flank
    const hip = Math.min(thigh * 0.95, T.hx - fo * 0.7 - 0.03);
    const pts = [V(at(1), ptop + 0.02, fz + lean), V(at(1), ptop + 0.3, fz + lean * 0.9), V(at(0.97), knee, fz + lean * 0.6), V(at(0.84), knee + 0.4, fz + lean * 0.3),
      V(at(0.7), yc - 0.2, fz + lean * 0.1), V(at(0.5), yc + 0.12, fz), V(at(0.35), yc + 0.3, fz)];
    B.tube('rs_dino', pts, [lr + 0.06, lr, lr - 0.02, thigh, hip, 0.36, 0.2], { seg: 14, uvFn: uvLeg(fz / S, [sx * 0.95, 0.3, 0]), tint, capEnd: true });
    for (const k of [-1, 0, 1]) B.ell('rs_dino', 0.13, 0.1, 0.13, at(1) + k * 0.3, ptop + 0.09, fz + lean + 0.56 - Math.abs(k) * 0.13, { seg: 8, rings: 4, uvFn: () => [0.3 + k * 0.1, 0.06], tint: tint.map(c => c * 1.12) });
  }
  // a tube's frames: tangents, the dorsal direction (the side of it the back plates and the snow sit on: up where
  // it runs level, back where it climbs) and the arc length at each point
  const framesOf = (pts, back) => {
    const tg = pts.map((q, i) => pts[Math.min(pts.length - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
    const dors = tg.map(t => { const u = back.clone(); return u.sub(t.clone().multiplyScalar(u.dot(t))).normalize(); });
    const len = [0]; for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const at = s => { let i = 0; while (i < pts.length - 2 && len[i + 1] < s) i++; const f = clamp01((s - len[i]) / Math.max(1e-6, len[i + 1] - len[i])); return { i, f, p: pts[i].clone().lerp(pts[i + 1], f), t: tg[i].clone().lerp(tg[i + 1], f).normalize(), d: dors[i].clone().lerp(dors[i + 1], f).normalize() }; };
    return { tg, dors, len, at };
  };
  // A ridge of snow lying along the top of a tube, deepest where the tube runs level, none where it climbs
  const snowRidge = (pts, radii, F, i0, i1, T0) => {
    const N = i1 - i0, A = 0.85;
    B.grid('rs_snow!', N, 6, (u, v) => {
      const i = i0 + Math.round(u * N), P = pts[i], tg = F.tg[i];
      // (the side picked so side x tangent points up: the grid's own normals then come out down, hence flip)
      const side = V(V(1, 0, 0).cross(tg).y < 0 ? -1 : 1, 0, 0), top = side.clone().cross(tg).normalize();
      const a = (v * 2 - 1) * A, flat = smooth(0.3, 0.85, top.y) * smooth(0, 0.15, Math.min(u, 1 - u) * N / Math.max(1, N) * 2);
      const th = T0 * flat * Math.pow(Math.cos(a / A * Math.PI / 2), 0.7) * (0.85 + 0.15 * Math.sin(i * 1.7 + a * 2)) - 0.02;
      const dd = top.clone().multiplyScalar(Math.cos(a)).add(side.clone().multiplyScalar(Math.sin(a)));
      const q = P.clone().addScaledVector(dd, radii[i] + th);
      return [q.x, q.y, q.z];
    }, { noAO: true, flip: true, uv: (u, v, P) => [(P[0] + P[2]) / 2, P[1] / 2] });
  };
  if (neck) {
    // the swan neck: out of the shoulders, up through its column, arching forward over the plinth to the break
    const nx = neck.x, curve = new THREE.CatmullRomCurve3(DINO_NECK.map(([y, z]) => V(nx, y, z)), false, 'centripetal');
    const n = 28, pts = [], radii = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, k = t * (DINO_NECK.length - 1), j = Math.min(DINO_NECK.length - 2, Math.floor(k));
      pts.push(curve.getPoint(t)); radii.push(lerp(DINO_NECK[j][2], DINO_NECK[j + 1][2], k - j));
    }
    // (u0 lands the texture's crack web on the neck's flank just short of the break)
    const F = framesOf(pts, V(0, 1, -0.9)), NL = F.len[n], U0 = 0.55 + (NL - 0.45) / S;
    B.tube('rs_dino', pts, radii, { seg: 16, tint, uvFn: (pl, nl, v) => { const q = F.at(v.uv[1] * S); return [U0 - v.uv[1], lerp(0.12, 0.84, vOf(nl, [q.d.x, q.d.y, q.d.z], 0.3))]; } });
    // skin folds across the throat where the neck bends up out of the shoulders
    for (const t of [0.12, 0.17, 0.22]) {
      const q = F.at(NL * t), r0 = lerp(radii[q.i], radii[q.i + 1], q.f) - 0.03;
      const sd = V(1, 0, 0), fw = sd.clone().cross(q.t).normalize().negate();
      if (fw.z < 0) fw.negate();
      const arc = [];
      for (let a = -1.25; a <= 1.25001; a += 0.25) arc.push(q.p.clone().add(fw.clone().multiplyScalar(Math.cos(a) * r0)).add(sd.clone().multiplyScalar(Math.sin(a) * r0)));
      B.tube('rs_dino', arc, arc.map((_, j) => 0.075 * Math.sin(Math.PI * j / (arc.length - 1)) + 0.005), { seg: 6, uvFn: (pl, nl) => [pl.x / S + t, 0.22], tint: tint.map(c => c * 0.97), lod0: false });
    }
    // plates up the back of the neck and along the top of its arch, shrinking toward the break
    for (let k = 0; k < 7; k++) {
      const q = F.at(0.95 + k * (NL - 1.95) / 6.4), r = lerp(radii[q.i], radii[q.i + 1], q.f), h = 0.3 - k * 0.022;
      plate(q.p.clone().addScaledVector(q.d, r - 0.06), q.d, q.t, h, 0.42 + h * 0.3, k + 7);
    }
    // the break, square across the end of the neck: the painted skin running on into jagged teeth, a pale lip of
    // snapped plaster, the dark hollow inside (closed well down), three bent rebar stubs
    const E = pts[n], Tn = F.tg[n], Yn = F.dors[n], Xn = Yn.clone().cross(Tn).normalize(), rE = radii[n], NJ = 22, ph = rnd() * TAU;
    const jag = []; for (let i = 0; i < NJ; i++) jag.push(0.03 + 0.05 * (0.5 + 0.5 * Math.sin(i / NJ * TAU * 2 + ph)) + (i % 3 === 1 ? range(rnd, 0.04, 0.1) : range(rnd, 0, 0.025)));
    const ring = (u, rr, h) => { const a = u * TAU, ii = Math.round(u * NJ) % NJ, hh = h === null ? 0 : h(jag[ii]); return E.clone().addScaledVector(Xn, Math.cos(a) * rr).addScaledVector(Yn, Math.sin(a) * rr).addScaledVector(Tn, hh); };
    const arr = q => [q.x, q.y, q.z];
    B.grid('rs_dino', NJ, 1, (u, v) => arr(ring(u, rE * (1 - 0.04 * v), j => v * j)), { wrapU: true, tint, uvFn: (pl, nl) => [U0 - NL / S, lerp(0.12, 0.84, vOf(nl, [Yn.x, Yn.y, Yn.z], 0.3))] });
    const lipR = [rE * 0.96, rE * 0.88, rE * 0.8], lipH = [0, 0.012, -0.025];
    B.grid('rs_stone', NJ, 2, (u, v) => { const k = Math.round(v * 2); return arr(ring(u, lipR[k], j => j + lipH[k])); }, { wrapU: true, tint: [1.3, 1.24, 1.1], noAO: true });
    const inR = [rE * 0.8, rE * 0.78, rE * 0.55, 0.02], inH = [-0.025, -0.32, -0.6, -0.68];
    B.grid('rs_iron', NJ, 3, (u, v) => { const k = Math.round(v * 3); return arr(ring(u, inR[k], k === 0 ? (j => j + inH[0]) : (() => inH[k]))); }, { wrapU: true, tint: [0.4, 0.34, 0.32], noAO: true, shelter: true });
    for (const [a, bend] of [[0.6, 0.35], [2.5, -0.3], [4.3, 0.2]]) {
      const o = E.clone().addScaledVector(Xn, Math.cos(a) * rE * 0.5).addScaledVector(Yn, Math.sin(a) * rE * 0.5);
      const radial = Xn.clone().multiplyScalar(Math.cos(a)).addScaledVector(Yn, Math.sin(a));
      B.tube('rs_iron', [o.clone().addScaledVector(Tn, -0.15), o.clone().addScaledVector(Tn, 0.14), o.clone().addScaledVector(Tn, 0.26).addScaledVector(radial, 0.08 + bend * 0.1), o.clone().addScaledVector(Tn, 0.32).addScaledVector(radial, 0.2 + bend * 0.2)],
        0.024, { seg: 5, lod0: false, tint: [0.9, 0.62, 0.48], shelter: true });
    }
    // two chunks of the neck lying on the plinth's front ledge under the break (painted skin on top, the pale
    // plaster showing at the broken sides)
    for (const [cx, cz, w, ry2] of [[-0.38, 1.2, 0.36, 0.5], [0.42, 1.28, 0.26, -0.4]]) {
      B.box('rs_dino', w, 0.13, w * 0.75, cx, ptop + 0.06, cz, { r: 0.04, jit: 0.07, ry: ry2, rz: 0.12, rx: -0.08, tint, uvFn: (pl, nl) => [pl.x / S, lerp(0.3, 0.8, 0.5 + 0.5 * nl.y)],
        faces: { px: { m: 'rs_stone', tint: [1.25, 1.2, 1.08] }, nx: { m: 'rs_stone', tint: [1.25, 1.2, 1.08] }, ny: { m: 'rs_stone', tint: [1.1, 1.05, 0.95] } } });
    }
    if (ctx.snow) {
      // snow along the top of the arch (none on the climb), icicles hanging under it
      snowRidge(pts, radii, F, Math.round(n * 0.55), n - 3, 0.09);
      for (let k = 0; k < 9; k++) {
        const q = F.at(NL * lerp(0.6, 0.8, k / 8) + range(rnd, -0.06, 0.06)), r = lerp(radii[q.i], radii[q.i + 1], q.f);
        if (q.d.y < 0.7) continue;
        const bot = q.p.clone().addScaledVector(q.d, -r * 0.96).add(V(range(rnd, -0.18, 0.18), 0, 0)), len = range(rnd, 0.12, 0.34) * (k % 3 === 1 ? 1.3 : 1);
        B.cyl('rs_ice!', range(rnd, 0.028, 0.04), 0, len, bot.x, bot.y - len / 2 + 0.03, bot.z, { seg: 5, caps: false, fit: true, noAO: true, lod0: true });
      }
    }
  }
  if (tail) {
    // a gentle S, held out level in its box, the tip flicked sideways and drooping just past the box's end
    const sw = p.id % 2 ? 1 : -1, tz0 = bz - az + 1.0, tz1 = tail.z - tail.hz + 0.12, ty = tail.y;
    const ctl = [V(tail.x, ty - 0.45, tz0), V(tail.x + sw * 0.14, ty - 0.12, lerp(tz0, tz1, 0.3)), V(tail.x + sw * 0.04, ty - 0.02, lerp(tz0, tz1, 0.56)), V(tail.x - sw * 0.18, ty - 0.1, lerp(tz0, tz1, 0.8)),
      V(tail.x + sw * 0.2, ty - 0.24, tz1), V(tail.x + sw * 0.4, ty - 0.62, tz1 - 0.42)];
    const curve = new THREE.CatmullRomCurve3(ctl, false, 'centripetal'), rr = [0.75, 0.55, 0.4, 0.28, 0.16, 0.07];
    const n = 20, pts = [], radii = [];
    for (let i = 0; i <= n; i++) { const t = i / n, k = t * (rr.length - 1), j = Math.min(rr.length - 2, Math.floor(k)); pts.push(curve.getPoint(t)); radii.push(lerp(rr[j], rr[j + 1], k - j)); }
    B.tube('rs_dino', pts, radii, { seg: 14, uvFn: uvTube(tz0 / S, -1, [0, 1, 0]), tint, capEnd: true });
    const F = framesOf(pts, V(0, 1, 0)), TL = F.len[n];
    for (let k = 0; k < 6; k++) {
      const q = F.at(TL * (0.1 + k * 0.14)), r = lerp(radii[q.i], radii[q.i + 1], q.f), h = 0.34 - k * 0.045;
      plate(q.p.clone().addScaledVector(q.d, r - 0.05), q.d, q.t.clone().negate(), h, 0.4 + h * 0.4, k + 14);
    }
    if (ctx.snow) snowRidge(pts, radii, F, 1, Math.round(n * 0.78), 0.1);
  }
  if (ctx.snow) {
    // a blanket of snow along the back, lumpy, its edge wandering down the flanks; the plates stand out of it
    const sr = rngOf(seedOf(p.x, p.z, 17)), ph1 = sr() * TAU, ph2 = sr() * TAU;
    B.grid('rs_snow!', 28, 6, (u, v) => {
      const th = TAU * u, vEdge = 0.74 + 0.035 * Math.sin(3 * th + ph1) + 0.02 * Math.sin(7 * th + ph2);
      const k = lerp(-0.012, 0.08, smooth(0, 0.45, v)) * (1 + 0.22 * Math.sin(5 * th + ph2 + v * 3)), q = bodyAt(u, lerp(vEdge, 1, v));
      return [bx + (q[0] - bx) * (1 + k), yc + (q[1] - yc) * (1 + k) + 0.012, bz + (q[2] - bz) * (1 + k * 0.4)];
    }, { wrapU: true, noAO: true, uv: (u, v, P) => [P[0] / 2, P[2] / 2] });
  }
  if (ctx.driftMat) { drift(B, ctx, bx - body.hx - 0.3, bz, 0.8, 3.0, 0.42, 0); drift(B, ctx, bx + body.hx + 0.3, bz - 1.5, 0.6, 1.6, 0.28, 0); }
}

// ---- gates, keypads, anchors, camp, the RV lot ------------------------------------------------------------

// The ranger gate. Two gatehouses stand at the feet of the canyon walls: a watch cabin up on four heavy legs
// under a steep gable roof, its gable end to the road, joined across the road by one heavy lintel with the
// station's carved board hanging off it on iron brackets. The barrier slides between them through a slot of
// guide posts. Every kit builds it in its own materials (see KIT).
const GATE = { floor: 3.95, wallTop: 5.35, plate: 5.5, hx: 1.15, hz: 1.0, eave: 0.5, pitch: Math.PI / 4, lintel: 5.0 };

// one leg / corner post of a gatehouse, in the kit's style
function gateLeg(B, ctx, K, x, z, bot, top, rnd) {
  const h = top - bot, W = K.woodMat, wood = K.wood, stoneT = STONE_TINT[ctx.bio.kit];
  if (K.post === 'log') {
    B.cyl(W, 0.22, 0.26, h, x, bot + h / 2, z, { seg: 9, caps: 'rs_logend', bevel: 0.03, off: [rnd(), rnd()], tint: wood });
    for (const yy of [bot + 1.25, GATE.floor - 0.35]) if (yy < top - 0.3) B.cyl('rs_iron', 0.27, 0.28, 0.12, x, yy, z, { seg: 9, caps: false, lod0: false });
  } else if (K.post === 'square') {
    B.box(W, 0.38, h, 0.38, x, bot + h / 2, z, { r: 0.05, jit: 0.03, taper: 0.95, tint: wood, off: [rnd(), 0] });
    B.box('rs_iron', 0.43, 0.09, 0.43, x, bot + 1.3, z, { r: 0.02, lod0: false });
  } else if (K.post === 'pier') {
    const t = Math.min(top, GATE.floor);
    B.box('rs_stone', 0.62, t - bot, 0.62, x, (t + bot) / 2, z, { r: 0.07, jit: 0.04, taper: 0.9, S: 1.2, tint: stoneT });
    B.box('rs_stone', 0.8, 0.32, 0.8, x, bot + 0.45, z, { r: 0.07, jit: 0.05, tint: stoneT });
    B.box('rs_iron', 0.66, 0.14, 0.66, x, t - 0.55, z, { r: 0.03, taper: 0.98, lod0: false });
  } else if (K.post === 'bundle') {
    for (let k = 0; k < 3; k++) {
      const a = TAU * k / 3 + 0.4, ox = Math.cos(a) * 0.11, oz = Math.sin(a) * 0.11, hh = h - k * 0.14;
      B.cyl(W, 0.1, 0.12, hh, x + ox, bot + hh / 2, z + oz, { seg: 7, caps: 'rs_logend', off: [rnd(), rnd()], rz: ox * 0.12 });
    }
    for (const yy of [bot + 0.9, GATE.floor - 0.4]) lashing(B, x, yy, z, 0.24);
  } else {
    B.box(W, 0.4, h, 0.4, x, bot + h / 2, z, { r: 0.05, tint: wood });
    for (const yy of [bot + 0.9, GATE.floor - 0.4]) B.box('rs_brass', 0.46, 0.14, 0.46, x, yy, z, { r: 0.03, lod0: false });
  }
}

function gatehouse(B, ctx, K, side, xc, rnd) {
  const { floor, wallTop, plate, hx, hz, eave, pitch } = GATE;
  const kit = ctx.bio.kit, W = K.woodMat, wood = K.wood, stoneT = STONE_TINT[kit];
  // legs: the outer pair stands on the canyon slope (or is buried in it)
  for (const lx of [-1, 1]) for (const lz of [-1, 1]) {
    const x = xc + lx * hx, z = lz * hz, gy = Math.min(B.ground(x, z), B.ground(x - 0.25, z), B.ground(x + 0.25, z));
    if (gy > floor - 0.5) continue;
    if (K.foot && K.post !== 'pier') B.box(K.foot, 0.62, 0.5, 0.62, x, gy + 0.08, z, { r: K.foot === 'rs_adobe' ? 0.16 : 0.07, jit: 0.05, tint: stoneT });
    gateLeg(B, ctx, K, x, z, gy - 0.3, K.post === 'pier' ? floor : plate, rnd);
    // knee braces up to the cabin's sill, along z
    if (K.post !== 'pier') B.box(W, 0.14, 1.05, 0.14, x, floor - 0.42, z - lz * 0.36, { rx: -lz * 0.78, r: 0.025, tint: wood });
    if (K.post !== 'pier') B.box(W, 0.14, 1.05, 0.14, x - lx * 0.36, floor - 0.42, z, { rz: lx * 0.78, r: 0.025, tint: wood });
  }
  if (K.post === 'pier') {
    // stone arches between the piers on the road faces
    for (const lz of [-1, 1]) B.box('rs_stone', hx * 2, 0.5, 0.5, xc, floor - 0.3, lz * hz, { r: 0.06, jit: 0.03, S: 1.2, tint: stoneT, div: [4, 1, 1], deform: q => { if (q[1] < 0) q[1] += 0.18 * (1 - (q[0] / hx) ** 2); } });
  }
  // the cabin: floor, walls, sill and top plate, the frame on its faces, a lit watch window
  const wallH = wallTop - floor - 0.22, wy = floor + 0.22 + wallH / 2, wallMat = K.wall;
  B.box(W, hx * 2 + 0.24, 0.24, hz * 2 + 0.24, xc, floor + 0.1, 0, { r: 0.04, rot: true, tint: wood.map(c => c * 0.9) });
  B.box(wallMat, hx * 2 - 0.06, wallH, hz * 2 - 0.06, xc, wy, 0, { r: 0.03, rot: !!K.wallRot, tint: K.wallTint || STONE_TINT[kit] && wallMat === 'rs_stone' ? STONE_TINT[kit] : null, S: wallMat === 'rs_stone' ? 1.3 : undefined });
  B.box(W, hx * 2 + 0.18, 0.18, hz * 2 + 0.18, xc, wallTop + 0.07, 0, { r: 0.04, rot: true, tint: wood });
  if (K.post === 'pier') for (const lx of [-1, 1]) for (const lz of [-1, 1]) B.box('rs_stone', 0.3, wallH + 0.1, 0.3, xc + lx * hx, wy, lz * hz, { r: 0.05, jit: 0.02, tint: stoneT });
  // half-timber frame on the plaster (Elwynn), battens on boards and hides, rivet bands on steel
  if (wallMat === 'rs_plaster') {
    for (const lz of [-1, 1]) {
      const zf = lz * (hz - 0.01);
      for (const mx of [-0.42, 0.42]) B.box(W, 0.14, wallH, 0.06, xc + mx, wy, zf, { r: 0.02, tint: wood });
      for (const sx2 of [-1, 1]) { const dx = hx - 0.42, len = Math.hypot(dx, wallH); B.box(W, 0.12, len, 0.06, xc + sx2 * (0.42 + dx / 2), wy, zf, { rz: -sx2 * Math.atan2(dx, wallH) * (lz > 0 ? 1 : -1) * -1, r: 0.02, tint: wood }); }
    }
    for (const lx of [-1, 1]) { const xf = xc + lx * (hx - 0.01); B.box(W, 0.06, wallH, 0.14, xf, wy, 0, { r: 0.02, tint: wood }); B.box(W, 0.06, 0.12, hz * 2, xf, wy + 0.1, 0, { r: 0.02, tint: wood }); }
  } else if (wallMat === 'rs_hide' || wallMat === 'rs_planks_gray') {
    for (const lz of [-1, 1]) for (const mx of [-0.55, 0, 0.55]) B.box(W, 0.1, wallH, 0.06, xc + mx + range(rnd, -0.05, 0.05), wy, lz * (hz - 0.01), { r: 0.02, tint: wood, rz: range(rnd, -0.03, 0.03) });
  } else if (wallMat.startsWith('rs_steel')) {
    for (const yy of [wy - wallH / 2 + 0.08, wy + wallH / 2 - 0.08]) B.box('rs_brass', hx * 2 + 0.02, 0.1, hz * 2 + 0.02, xc, yy, 0, { r: 0.02 });
  } else if (wallMat === 'rs_adobe') {
    // Gadgetzan: a riveted brass sill band, and dark vigas poking out of the plaster under the plate
    B.box('rs_brass', hx * 2 + 0.04, 0.12, hz * 2 + 0.04, xc, wy - wallH / 2 + 0.07, 0, { r: 0.02 });
    for (const lz of [-1, 1]) for (const mx of [-0.62, 0, 0.62]) B.box(W, 0.15, 0.15, 0.42, xc + mx + range(rnd, -0.04, 0.04), wallTop - 0.3, lz * (hz + 0.12), { r: 0.03, jit: 0.02, tint: wood.map(c => c * 0.8), rx: range(rnd, -0.04, 0.04) });
  }
  // a lit watch window on the approach face and the road face, a shutter hanging open beside each
  const win = (x, z, ry) => {
    B.push(M4(x, wy + 0.08, z, 0, ry, 0));
    B.box('rs_headlamp*', 0.52, 0.46, 0.04, 0, 0, 0, { tint: [0.62, 0.48, 0.36], lod0: false });
    B.box(W, 0.66, 0.08, 0.1, 0, -0.27, 0.03, { r: 0.02, tint: wood, lod0: false });
    B.box(W, 0.66, 0.07, 0.08, 0, 0.26, 0.02, { r: 0.02, tint: wood });
    for (const sx2 of [-1, 1]) B.box(W, 0.07, 0.5, 0.08, sx2 * 0.29, 0, 0.02, { r: 0.015, tint: wood });
    B.box(W, 0.04, 0.46, 0.05, 0, 0, 0.03, { tint: wood, lod0: true });
    B.box(W, 0.52, 0.04, 0.05, 0, 0.02, 0.03, { tint: wood, lod0: true });
    B.box(W, 0.3, 0.5, 0.04, -0.5, 0, 0.12, { ry: -0.5, r: 0.01, tint: kit === 'goblin' ? [0.85, 1.1, 1.05] : wood.map(c => c * 1.15), lod0: true });
    B.pop();
  };
  win(xc + side * 0.15, -hz - 0.02, Math.PI);
  win(xc - side * hx - side * 0.02, 0, -side * Math.PI / 2);
  // the roof (booth-local: the ridge along local x = world z, slopes falling to local ±z = world ±x)
  B.push(M4(xc, plate, 0, 0, Math.PI / 2, 0));
  const run = hx + eave, rise = hx * Math.tan(pitch), slen = run / Math.cos(pitch) + 0.06, L = hz * 2 + 0.9, roof = K.roof;
  const midZ = run / 2 - 0.02, midY = rise - (run / 2) * Math.tan(pitch) + 0.08;
  for (const sz of [-1, 1]) {
    const o = { rx: pitch, ry: sz < 0 ? Math.PI : 0, r: 0.04, tint: K.roofTint, faces: { ny: { m: W, tint: wood }, py: { m: roof, rot: !!K.roofRot } } };
    if (K.thatch) {
      // thatch in three stepped courses, each lower one kicking out a little, ragged along its lower edge
      for (let c = 0; c < 3; c++) {
        const f0 = c / 3, len = slen / 3 + 0.18, dd = (f0 + 1 / 6) * slen - slen / 2;
        const zz = sz * (midZ + Math.cos(pitch) * dd + Math.sin(pitch) * 0.05 * c), yy = midY - Math.sin(pitch) * dd + Math.cos(pitch) * 0.05 * c;
        B.box(roof, L + 0.1 * c, 0.22, len, 0, yy, zz, { ...o, rx: pitch + 0.05 * c, r: 0.08, jit: 0.07, div: [6, 1, 1], tint: [1 - c * 0.04, 1 - c * 0.05, 1 - c * 0.06] });
      }
    } else B.box(roof, L, 0.14, slen, 0, midY, sz * midZ, { ...o, jit: kit === 'frontier' ? 0.04 : 0 });
    // rafter tails under the eave
    for (let x = -L / 2 + 0.15; x < L / 2 - 0.1; x += range(rnd, 0.42, 0.55)) B.box(W, 0.09, 0.11, 0.4, x, -eave * Math.tan(pitch) + 0.08, sz * (run - 0.18), { rx: sz * pitch, r: 0.02, tint: wood, lod0: true });
    // barge boards down both gable edges
    for (const ex of [-1, 1]) B.box(W, 0.07, 0.26, slen + 0.04, ex * (L / 2 + 0.02), midY - 0.06, sz * midZ, { rx: pitch, ry: sz < 0 ? Math.PI : 0, r: 0.02, tint: wood });
    if (ctx.snow) {
      snowCap(B, L - 0.06, slen - 0.12, 0, midY + 0.09 + (K.thatch ? 0.08 : 0), sz * midZ, { t: 0.2, rx: pitch, ry: sz < 0 ? Math.PI : 0 });
      icicles(B, -L / 2 + 0.1, sz * (run + 0.03), L / 2 - 0.1, sz * (run + 0.03), -eave * Math.tan(pitch) - 0.02, rnd, { max: 0.4 });
    }
  }
  B.box(K.ridge, L + 0.12, 0.18, 0.3, 0, rise + 0.12, 0, { r: 0.06, rot: true, tint: K.ridge === W ? wood : null });
  // gable ends: the wall material in a triangle, a king post, a finial over each
  const gm = wallMat === 'rs_plaster' ? 'rs_plaster' : wallMat;
  for (const ex of [-1, 1]) {
    B.box(gm, 0.1, rise, hx * 2, ex * (hz - 0.03), rise / 2, 0, { r: 0.01, div: [1, 2, 2], rot: !!K.wallRot, tint: gm === 'rs_stone' ? stoneT : null, deform: q => { q[2] *= Math.max(0.03, 0.5 - q[1] / rise); } });
    B.box(W, 0.12, rise - 0.1, 0.13, ex * (hz + 0.02), rise / 2 - 0.02, 0, { r: 0.02, tint: wood });
    B.box(W, 0.14, 0.42, 0.14, ex * (L / 2 + 0.02), rise + 0.3, 0, { r: 0.03, tint: wood, taper: 0.5 });
  }
  if (K.extra === 'bones') skull(B, -(L / 2 + 0.12), rise - 0.35, 0, -Math.PI / 2, 1.15);
  if (kit === 'goblin') { B.cyl('rs_brass', 0.1, 0.12, 1.2, 0.4, rise + 0.2, side * 0.5, { seg: 8, caps: 'rs_iron' }); B.cyl('rs_brass', 0.2, 0.08, 0.16, 0.4, rise + 0.85, side * 0.5, { seg: 8 }); }
  B.pop();
}

function buildGateStatic(B, g, ctx) {
  const road = g.y - g.hy;
  B.frame(g.x, road, g.z, 0);
  const rnd = rngOf(seedOf(g.x, g.z, 21));
  const K = KIT[ctx.bio.kit] || KIT.timber, kit = ctx.bio.kit, W = K.woodMat, wood = K.wood, stoneT = STONE_TINT[kit];
  const { floor, hx, hz, lintel } = GATE;
  // the inner legs stand at the foot of each canyon wall, the booths reach back into it
  const footX = sx => { for (let x = g.hx + 0.5; x > 4; x -= 0.25) { const gy = Math.max(B.ground(sx * x, -1.1), B.ground(sx * x, 1.1), B.ground(sx * x, 0)); if (gy < 0.45) return x; } return 4; };
  // In a narrow canyon the slope climbs two metres a metre, so a booth standing at the wall's foot would have
  // its outer half (and the lintel's end) inside the rock: slide it out over the shoulder until its outer wall
  // clears the slope by its floor and its eave by the plate (never nearer the crown than 5.2 m).
  const slopeAt = (sx, x) => Math.max(B.ground(sx * x, -hz - 0.15), B.ground(sx * x, 0), B.ground(sx * x, hz + 0.15));
  const xIn = {};
  for (const sx of [-1, 1]) {
    let xi = Math.min(g.hx - 0.6, footX(sx) - 0.35);
    while (xi > 5.2 && (slopeAt(sx, xi + 2 * hx) > floor - 0.3 || slopeAt(sx, xi + 2 * hx + GATE.eave) > GATE.plate - 0.15)) xi -= 0.1;
    xIn[sx] = xi;
  }
  for (const side of [-1, 1]) {
    const xi = side * xIn[side], xc = xi + side * hx;
    gatehouse(B, ctx, K, side, xc, rnd);
    // the slot the barrier slides through: two guide posts tied back to the inner legs
    for (const sz of [-1, 1]) {
      const z = sz * 0.4, gy = B.ground(xi, z), h = floor - gy + 0.2;
      if (K.post === 'pier') B.box('rs_stone', 0.34, h, 0.3, xi, gy - 0.2 + h / 2, z, { r: 0.05, jit: 0.02, tint: stoneT });
      else B.box(W, 0.26, h, 0.24, xi, gy - 0.2 + h / 2, z, { r: 0.04, tint: wood, off: [rnd(), 0] });
      for (const yy of [gy + 0.45, floor - 0.5]) B.box(W, 0.16, 0.16, hz - 0.4, xi, yy, sz * (0.4 + (hz - 0.4) / 2), { r: 0.03, tint: wood, rot: true });
      B.cyl('rs_iron', 0.07, 0.07, 0.3, xi - side * 0.02, gy + 0.3, sz * 0.27, { seg: 8, lod0: true });
    }
    // lights
    if (K.light === 'lantern') {
      B.box('rs_iron', 0.06, 0.06, 0.5, xi, 3.45, -hz - 0.2, { r: 0.01 });
      lantern(B, xi, 3.05, -hz - 0.42, 0.18, kit === 'goblin' ? 'rs_brass' : 'rs_iron');
    } else if (K.light === 'brazier') {
      const bx = xi - side * 0.6, bz = -hz - 0.7, gy = B.ground(bx, bz);
      brazier(B, bx, gy + 0.72, bz, true);
    } else torch(B, xi - side * 0.05, 2.9, -hz - 0.22);
    if (K.extra === 'hay') { const hx2 = xi + side * 0.1, gy = B.ground(hx2, -hz - 1.0); if (gy < 0.6) haybale(B, hx2, gy - 0.05, -hz - 1.0, 1.05, 0.5, 0.48, { ry: range(rnd, -0.3, 0.3) }); }
    if (ctx.driftMat) { const dx = xi + side * 0.4, gy = B.ground(dx, -1.6); if (gy < 0.6) drift(B, ctx, dx, -1.6, 1.1, 0.8, ctx.snow ? 0.35 : 0.25, 0); }
  }
  // the lintel across the road, framed into both cabins, a lit cap board, iron bands and knee braces
  const xl = -xIn[-1] - 0.3, xr = xIn[1] + 0.3, cx = (xl + xr) / 2, span = xr - xl;
  if (K.post === 'pier') B.box('rs_stone', span, 0.6, 0.6, cx, lintel, 0, { r: 0.06, jit: 0.03, S: 1.3, tint: stoneT, div: [8, 1, 1] });
  else if (K.post === 'log' || K.post === 'bundle') B.cyl(W, 0.3, 0.32, span, cx, lintel, 0, { rz: Math.PI / 2, seg: 10, caps: 'rs_logend', tint: wood, off: [rnd(), 0], bevel: 0.03 });
  else B.box(W, span, 0.58, 0.52, cx, lintel, 0, { r: 0.06, rot: true, jit: 0.03, tint: wood });
  B.box(W, span - 0.4, 0.07, 0.42, cx, lintel + 0.32, 0, { r: 0.02, rot: true, tint: wood.map(c => c * 1.35) });
  for (let x = xl + 1.6; x < xr - 1.2; x += range(rnd, 2.6, 3.4)) {
    if (K.band === 'rs_rope') lashing(B, x, lintel - 0.12, 0, 0.32, 3);
    else B.box(K.band, 0.14, 0.66, 0.6, x, lintel, 0, { r: 0.03, lod0: false });
  }
  for (const sx of [-1, 1]) {
    const xw = sx > 0 ? xr - 0.3 : xl + 0.3, dx = 1.05, dy = lintel - 0.3 - (floor + 0.15), len = Math.hypot(dx, dy);
    B.box(W, 0.18, len, 0.18, xw - sx * dx / 2, (lintel - 0.3 + floor + 0.15) / 2, 0, { rz: sx * Math.atan2(dx, dy), r: 0.03, tint: wood });
  }
  if (K.extra === 'bones') {
    // a bison pelt hung off the lintel by its forelegs on two ropes, out over the ditch
    const hxp = Math.min(xr - 1.3, cx + 3.7), tips = pelt(B, 1, 2.05, 2.2, hxp, 3.68, -0.52, { ry: Math.PI, sag: 0.09, rz: range(rnd, -0.05, 0.05) });
    for (const t of tips.filter(q => q.y > 3.68)) {
      B.tube('rs_rope', [t, V(t.x, lintel - 0.18, -0.36), V(t.x, lintel + 0.31, -0.06), V(t.x, lintel + 0.27, 0.12)], 0.026, { seg: 5, lod0: false });
      B.torus('rs_rope', 0.335, 0.024, t.x + 0.03, lintel, 0, { ry: Math.PI / 2, seg: 10, tseg: 4, uRep: 6, lod0: true });
    }
    // and a cream hide painted with the sun, stretched on an X of bleached poles against the right-hand booth
    const xr0 = xIn[1] + hx + 0.1, zr0 = -hz - 0.85, gy = B.ground(xr0, zr0);
    if (gy < 1.4) {
      const poles = [[V(xr0 - 0.82, gy - 0.2, zr0 + 0.04), V(xr0 + 0.78, gy + 2.4, zr0 + 0.1)], [V(xr0 + 0.82, gy - 0.2, zr0 - 0.02), V(xr0 - 0.76, gy + 2.36, zr0 + 0.12)]];
      for (const [a, b] of poles) B.tube(W, [a, a.clone().lerp(b, 0.5), b], [0.065, 0.058, 0.048], { seg: 7, lod0: false });
      lashing(B, xr0, gy + 1.05, zr0 + 0.07, 0.07, 3);
      const tips2 = pelt(B, 1, 1.55, 1.75, xr0, gy + 1.15, zr0 - 0.14, { ry: Math.PI, sag: 0.1, tint: [1.4, 1.22, 1.05] });
      for (const t of tips2) {
        let best = null;
        for (const [a, b] of poles) { const ab = b.clone().sub(a), k = Math.max(0.05, Math.min(0.97, t.clone().sub(a).dot(ab) / ab.lengthSq())), q = a.clone().addScaledVector(ab, k); if (!best || q.distanceTo(t) < best.distanceTo(t)) best = q; }
        lash(B, t, best, 0.02);
      }
    }
  }
  if (ctx.snow) { snowCap(B, span - 0.6, 0.5, cx, lintel + 0.3, 0, { t: 0.16 }); icicles(B, xl + 0.6, -0.3, xr - 0.6, -0.3, lintel - 0.28, rnd, { max: 0.3 }); }
  // the station's carved board on iron brackets off the lintel's face, hung a little crooked
  const by = lintel - 0.82;
  for (const sx of [-1, 1]) {
    B.box('rs_iron', 0.06, 0.06, 0.32, cx + sx * 1.35, lintel - 0.27, -0.42, { r: 0.01 });
    B.lod0 = true;
    for (let k = 0; k < 2; k++) B.torus('rs_iron', 0.035, 0.01, cx + sx * 1.35, lintel - 0.33 - k * 0.07 - (sx > 0 ? 0.03 : 0), -0.57, { ry: k % 2 ? Math.PI / 2 : 0, seg: 6, tseg: 3 });
    B.lod0 = false;
  }
  B.box(W, 3.4, 0.9, 0.1, cx, by, -0.57, { r: 0.03, rz: 0.03, tint: wood, faces: { nz: { m: 'rs_gatelabels', fit: true, uvRect: LBL.ranger, tint: [1, 1, 1] }, pz: { m: 'rs_gatelabels', fit: true, uvRect: LBL.ranger, tint: [1, 1, 1] } } });
}

// The barrier. The warning boom is its face: a run of red-and-cream chevron planks the whole width at
// chest height, butt joints staggered, every plank pointing in at the carved STOP board in the middle.
// Behind it each kit builds its own wall: a log palisade with ragged tips (Elwynn), gray barn boards
// (Westfall), stacked squared beams banded in iron round a dwarven shield boss (Dun Morogh), ragged
// bleached stakes lashed with rope with a hide over one bay (Badlands), riveted goblin plates (Tanaris).
function buildGateBars(B, g, ctx) {
  B.frame(0, -g.hy, 0, 0);
  const rnd = rngOf(seedOf(g.x, g.z, 23));
  const K = KIT[ctx.bio.kit] || KIT.timber, W = K.woodMat;
  const hx = g.hx, H = g.hy * 2, hz = g.hz, wood = K.wood, style = K.bars;
  const ups = [-hx + 0.22];
  while (ups[ups.length - 1] < hx - 2.6) ups.push(ups[ups.length - 1] + 2.75 * range(rnd, 0.75, 1.25));
  ups.push(hx - 0.22);
  const BY = 1.62, BH = 0.66, bz = hz + 0.045;   // the boom: centre height, plank height, plank centre off the face
  let railY = [0.55, 2.62], rails = true;
  if (style === 'logs') {
    for (const u of ups) {
      B.cyl(W, 0.19, 0.2, H + 0.1, u, (H + 0.1) / 2, 0, { seg: 8, caps: false, tint: wood, off: [rnd(), rnd()] });
      B.cyl(W, 0, 0.19, 0.3, u, H + 0.25, 0, { seg: 8, caps: false, tint: wood });
    }
    for (let x = -hx + 0.03; x < hx - 0.1;) {
      const r = range(rnd, 0.125, 0.16), cxl = x + r;
      x += 2 * r + 0.01;
      if (ups.some(u => Math.abs(u - cxl) < 0.2 + r)) continue;
      const h = H + range(rnd, -0.25, 0.25), tip = range(rnd, 0.22, 0.32), lean = range(rnd, -0.012, 0.012);
      B.cyl(W, r * 0.96, r, h, cxl, h / 2, range(rnd, -0.015, 0.015), { seg: 7, caps: false, tint: wood.map(c => c * range(rnd, 0.9, 1.08)), off: [rnd(), rnd()], rz: lean });
      B.cyl(W, 0, r * 0.96, tip, cxl - Math.sin(lean) * (h + tip) / 2, h / 2 + Math.cos(lean) * (h + tip) / 2, 0, { seg: 7, caps: false, tint: wood, rz: lean });
    }
  } else if (style === 'stakes') {
    // ragged: three thicknesses, uneven heights, leaning every which way, one in eight snapped off short
    for (const u of ups) B.cyl(W, 0.17, 0.2, H + 0.5, u, (H + 0.5) / 2, 0, { seg: 8, caps: 'rs_logend', off: [rnd(), rnd()], rz: range(rnd, -0.04, 0.04) });
    let n = 0;
    for (let x = -hx + 0.05; x < hx - 0.1;) {
      const r = pick(rnd, [0.06, 0.1, 0.15, 0.1]), cxl = x + r;
      x += 2 * r + range(rnd, 0, 0.12);
      if (ups.some(u => Math.abs(u - cxl) < 0.22 + r)) continue;
      const snapped = (n++ % 8) === 3 + Math.floor(rnd() * 2);
      const h = snapped ? H * range(rnd, 0.45, 0.65) : H + range(rnd, -0.6, 0.45), lean = range(rnd, -0.12, 0.12), tip = snapped ? 0 : range(rnd, 0.2, 0.4);
      B.push(M4(cxl, 0, range(rnd, -0.03, 0.03), range(rnd, -0.04, 0.04), 0, lean));
      B.cyl(W, r * 0.9, r, h, 0, h / 2 - 0.1, 0, { seg: 6, caps: snapped ? 'rs_logend' : false, off: [rnd(), rnd()], jit: snapped ? 0.04 : 0 });
      if (tip) B.cyl(W, 0, r * 0.9, tip, 0, h - 0.1 + tip / 2, 0, { seg: 6, caps: false });
      B.pop();
    }
    // two bleached poles across both faces, rope lashed in an X at every few stakes
    rails = false;
    for (const sz of [-1, 1]) for (const yy of railY) {
      B.cyl(W, 0.07, 0.075, hx * 2 - 0.1, 0, yy + range(rnd, -0.06, 0.06), sz * (hz + 0.06), { rz: Math.PI / 2 + range(rnd, -0.01, 0.01), seg: 7, caps: 'rs_logend', off: [rnd(), 0] });
      for (let x = -hx + 0.6; x < hx - 0.4; x += range(rnd, 0.7, 1.2)) for (const a of [0.7, -0.7]) B.box('rs_rope', 0.03, 0.26, 0.03, x, yy, sz * (hz + 0.11), { rz: a, r: 0, lod0: true });
    }
    // a pelt stretched in one bay above the boom, its four legs lashed back to the uprights either side
    const bi = Math.max(0, Math.min(ups.length - 2, Math.floor(ups.length / 2) - 2));
    const ua = ups[bi], ub = ups[bi + 1], pcx = (ua + ub) / 2, pw = Math.min(ub - ua - 0.3, 2.5), pyc = 2.92;
    const tips = pelt(B, 0, pw, 1.95, pcx, pyc, -hz - 0.27, { ry: Math.PI, sag: 0.16 });
    for (const t of tips) {
      const ux = t.x < pcx ? ua + 0.16 : ub - 0.16, ay = t.y + (t.y > pyc ? 0.14 : -0.14);
      lash(B, t, V(ux, ay, -hz - 0.08), 0.02);
      lashing(B, t.x < pcx ? ua : ub, ay - 0.05, 0, 0.2, 2);
    }
  } else if (style === 'beams') {
    // squared beams stacked on edge with shadow gaps, banded with iron straps at every bay
    rails = false;
    const tint = [0.84, 0.86, 0.94];
    const joints = ups.filter((_, i) => i > 0 && i < ups.length - 1 && rnd() < 0.5);
    let y = 0.02;
    const tops = [];
    while (y < H - 0.25) {
      const bh = Math.min(range(rnd, 0.32, 0.38), H - y);
      const cuts = [-hx, ...joints.filter(() => rnd() < 0.6), hx].sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i] + 0.01, b = cuts[i + 1] - 0.01;
        B.box(W, b - a, bh, hz * 2 - range(rnd, 0, 0.03), (a + b) / 2, y + bh / 2, range(rnd, -0.01, 0.01), { r: 0.035, rot: true, tint: tint.map(c => c * range(rnd, 0.92, 1.06)), off: [rnd(), rnd()], rz: range(rnd, -0.004, 0.004), jit: 0.015 });
      }
      tops.push(y + bh);
      y += bh + 0.03;
    }
    for (const u of ups) for (const sz of [-1, 1]) {
      B.box('rs_iron', 0.15, H, 0.025, u, H / 2, sz * (hz + 0.012), { r: 0.006 });
      for (const t of tops) { if (Math.abs(t - BY) < BH / 2 + 0.1) continue; B.cyl('rs_iron', 0.035, 0.035, 0.03, u, t - 0.17, sz * (hz + 0.03), { rx: Math.PI / 2, seg: 6, lod0: true }); }
    }
    // the dwarven shield boss over the boom
    for (const sz of [-1, 1]) {
      B.cyl('rs_iron', 0.47, 0.47, 0.07, 0, BY + BH / 2 + 0.62, sz * (hz + 0.05), { rx: sz * Math.PI / 2, seg: 18, bevel: 0.025, caps: false });
      B.cyl('rs_iron', 0.45, 0.45, 0.06, 0, BY + BH / 2 + 0.62, sz * (hz + 0.06), { rx: sz * Math.PI / 2, seg: 18, caps: 'rs_shield', capFit: true });
    }
    if (ctx.snow) for (const t of tops) B.box('rs_snow!', hx * 2 - 0.1, 0.04, hz * 2 - 0.06, 0, t + 0.012, 0, { r: 0.01, noAO: true, lod0: true });
  } else if (style === 'boards') {
    for (const u of ups) B.box(W, 0.32, H + 0.12, hz * 2 + 0.04, u, (H + 0.12) / 2, 0, { r: 0.04, tint: wood, off: [rnd(), 0] });
    for (const sz of [-1, 1]) for (let x = -hx + 0.02; x < hx - 0.05;) {
      const w = range(rnd, 0.22, 0.34), cxl = x + w / 2;
      x += w + range(rnd, 0.005, 0.03);
      if (ups.some(u => Math.abs(u - cxl) < 0.16 + w / 2) || rnd() < 0.03) continue;
      const h = H - range(rnd, 0.02, 0.24);
      B.box('rs_planks_gray', w, h, 0.06, cxl, h / 2, sz * (hz - 0.06), { r: 0.012, rot: true, off: [rnd(), rnd()], tint: wood.map(c => c * range(rnd, 0.92, 1.06)), rz: range(rnd, -0.012, 0.012) });
    }
    B.box(W, hx * 2, H - 0.2, hz * 2 - 0.16, 0, (H - 0.2) / 2, 0, { r: 0.02, tint: [0.4, 0.38, 0.38] });
  } else {
    // goblin plating in a timber frame: dark riveted iron sheets with one plate in three of aged brass, lapped
    // in two courses and bulging a little between their rivets, a bright brass lip catching the light along the
    // top of every plate, verdigris-green caps as the only colour, spikes along the top, and a sun-bleached
    // plain canvas strip thrown over it and sagging between the uprights
    for (const u of ups) B.box(W, 0.32, H + 0.12, hz * 2 + 0.04, u, (H + 0.12) / 2, 0, { r: 0.04, tint: wood, off: [rnd(), 0] });
    const split = 1.25 + range(rnd, -0.1, 0.1);
    for (let i = 0; i < ups.length - 1; i++) {
      const x0 = ups[i] + 0.16, x1 = ups[i + 1] - 0.16, w = x1 - x0;
      for (const [y0, y1, row] of [[0.04, split + 0.04, 0], [split - 0.04, H - 0.06, 1]]) {
        const hh = y1 - y0, iron = (i + row * 2) % 3 !== 0, m = iron ? 'rs_iron' : 'rs_brass', tn = iron ? [0.7, 0.68, 0.72] : [0.62, 0.52, 0.36];
        const dz = row ? 0.012 : 0, fz = hz - 0.02 + dz;
        B.box(m, w + 0.04, hh, fz * 2, (x0 + x1) / 2, y0 + hh / 2, 0, { r: 0.025, S: iron ? 0.9 : 1.4, off: [rnd(), rnd()], tint: tn, div: [4, 2, 1], smoothN: true,
          deform: q => { q[2] += Math.sin(Math.PI * (q[0] / (w + 0.04) + 0.5)) * Math.sin(Math.PI * (q[1] / hh + 0.5)) * 0.022 * Math.sign(q[2]); } });
        // the lip: a bright rolled brass edge along the plate's top (on the lower course it stands proud of the
        // lap; on the upper one it runs just under the verdigris cap)
        const ly = row ? H - 0.105 : y1 - 0.02, lz = row ? fz + 0.02 : hz + 0.025;
        B.box('rs_brass', w + 0.06, 0.04, lz * 2, (x0 + x1) / 2, ly, 0, { r: 0.012, tint: [1.15, 1.0, 0.7] });
        // big rivet heads along the top and bottom edges of each plate, both faces
        B.lod0 = true;
        for (const yy of [y0 + 0.1, y1 - 0.12]) for (let x = x0 + 0.12; x < x1 - 0.06; x += 0.3) for (const sz of [-1, 1]) B.cyl(iron ? 'rs_brass' : 'rs_iron', 0.034, 0.04, 0.035, x, yy, sz * (fz + 0.025), { rx: sz * Math.PI / 2, seg: 6, caps: iron ? 'rs_brass' : 'rs_iron', tint: iron ? [1.05, 0.92, 0.66] : undefined });
        B.lod0 = false;
      }
      // a verdigris cap strip along the top of the bay
      B.box('rs_brass', w + 0.06, 0.1, hz * 2 + 0.06, (x0 + x1) / 2, H - 0.04, 0, { r: 0.025, tint: [0.62, 1.0, 0.92] });
    }
    for (let x = -hx + 0.3; x < hx - 0.2; x += range(rnd, 0.42, 0.62)) B.cyl('rs_iron', 0, 0.06, 0.34, x, H + 0.15, 0, { seg: 6, caps: false, lod0: false });
    // the bleached canvas strip, thrown over the top and hanging down the approach face in a sag between uprights
    const cs = Math.max(0, Math.floor(ups.length / 2) - 3), ce = Math.min(ups.length - 1, cs + 3);
    const xa = ups[cs] + 0.2, xb = ups[ce] - 0.2;
    B.grid('rs_canvas_plain', 24, 4, (u, v) => {
      const x = lerp(xa, xb, u), k = ((x - ups[cs]) / (ups[ce] - ups[cs])) * (ce - cs), bay = Math.sin(Math.PI * (k % 1));
      const tear = v > 0.75 ? 0.06 * Math.sin(x * 9.1) + 0.05 * Math.sin(x * 23.7) : 0;
      if (v < 0.3) { const t = v / 0.3; return [x, H + 0.06 + 0.04 * Math.sin(Math.PI * t), lerp(0.1, -hz - 0.05, t)]; }
      const t = (v - 0.3) / 0.7;
      return [x, H + 0.02 - t * (0.62 + 0.14 * bay) + tear, -hz - 0.06 - 0.05 * t - 0.03 * bay * t];
    }, { uv: (u, v) => [lerp(xa, xb, u) / 3, 0.98 - v * 0.96], tint: [1.1, 1.08, 1.0] });   // (the hem at the hanging edge)
  }
  // rails across both faces, strapped to the uprights
  if (rails) for (const sz of [-1, 1]) for (const yy of railY) {
    B.box(W, hx * 2 - 0.05, 0.22, 0.1, 0, yy + range(rnd, -0.03, 0.03), sz * (hz + 0.03), { r: 0.04, rot: true, tint: wood, off: [rnd(), 0], jit: 0.02 });
    for (const u of ups) { B.box(K.band, 0.4, 0.28, 0.025, u, yy, sz * (hz + 0.09), { r: 0.008 }); for (const ox of [-0.12, 0.12]) B.cyl(K.band, 0.03, 0.03, 0.03, u + ox, yy, sz * (hz + 0.11), { rx: Math.PI / 2, seg: 6, lod0: true }); }
  }
  // the warning boom: planks end to end across the whole barrier, joints staggered between the faces,
  // each pointing in at the middle, strapped at every bay
  for (const sz of [-1, 1]) {
    const x0 = range(rnd, -0.5, 0.5), face = sz < 0 ? 'nz' : 'pz';
    for (const dir of [-1, 1]) {
      let x = x0;
      while (dir > 0 ? x < hx - 0.05 : x > -hx + 0.05) {
        const len = Math.min(range(rnd, 2.3, 2.9), dir > 0 ? hx - x : x + hx), xc = x + dir * len / 2, ph = range(rnd, 0.62, 0.7);
        if (len > 0.3) {
          const [, v0, , v1] = rnd() < 0.5 ? LBL.warn0 : LBL.warn1;
          const flip = (sz < 0) === (xc < 0);   // the texture's chevrons point to +u; u runs -x on the near face
          const cu = Math.min(1, len / 2.6) * 0.5;   // a short plank shows only part of a board
          const rect = flip ? [cu, v0, 0, v1] : [0, v0, cu, v1];
          B.box(W, len - 0.02, ph, 0.07, xc, BY + range(rnd, -0.04, 0.04), sz * bz, { r: 0.014, rz: range(rnd, -0.02, 0.02), tint: wood, faces: { [face]: { m: 'rs_gatelabels', fit: true, uvRect: rect, tint: [1, 1, 1] } } });
        }
        x += dir * len;
      }
    }
    for (const u of ups) {
      if (K.band === 'rs_rope') { for (const a of [0.6, -0.6]) B.box('rs_rope', 0.04, BH + 0.2, 0.04, u, BY, sz * (bz + 0.05), { rz: a * 0.5, r: 0, lod0: true }); continue; }
      B.box(K.band, 0.16, BH + 0.14, 0.025, u, BY, sz * (bz + 0.05), { r: 0.006 });
      for (const oy of [-0.22, 0.22]) B.cyl(K.band, 0.035, 0.035, 0.03, u, BY + oy, sz * (bz + 0.07), { rx: Math.PI / 2, seg: 6, lod0: true });
    }
    // the STOP board, hung a little crooked over the boom, iron-cornered
    B.box(W, 1.9, 0.95, 0.08, range(rnd, -0.1, 0.1), BY + 0.04, sz * (bz + 0.1), { r: 0.02, rz: range(rnd, -0.05, 0.05), tint: wood, faces: { [face]: { m: 'rs_gatelabels', fit: true, uvRect: LBL.stop, tint: [1, 1, 1] } } });
    if (ctx.snow) {
      snowCap(B, hx * 2 - 0.2, 0.08, 0, BY + BH / 2, sz * bz, { t: 0.06, lip: 0.02, ext: 0.02, lod0: true });
      icicles(B, -hx + 0.3, sz * (bz + 0.04), hx - 0.3, sz * (bz + 0.04), BY - BH / 2, rnd, { max: 0.2 });
    }
  }
  // the hasp and padlock at the closing end
  B.box('rs_iron', 0.32, 0.4, 0.06, -hx + 0.22, 1.0, -hz - 0.1, { r: 0.015 });
  B.box(K.band === 'rs_brass' ? 'rs_brass' : 'rs_iron', 0.17, 0.2, 0.08, -hx + 0.22, 0.83, -hz - 0.16, { r: 0.03, tint: [1.3, 1.15, 0.8] });
  if (ctx.snow && rails) for (const sz of [-1, 1]) snowCap(B, hx * 2 - 0.1, 0.1, 0, railY[1] + 0.11, sz * (hz + 0.03), { t: 0.06, lip: 0.03, ext: 0.03, lod0: true });
}

function buildKeypad(B, s, u, ctx) {
  const gy = ctx.H(s.x, s.z);
  B.frame(s.x, gy, s.z, 0);
  const K = KIT[ctx.bio.kit] || KIT.timber, kit = ctx.bio.kit;
  const top = s.y + s.hy - gy, h = top + 0.55;
  if (K.post === 'pier') B.box('rs_stone', s.hx * 2 + 0.04, h, s.hz * 2 + 0.04, 0, h / 2 - 0.12, 0, { r: 0.04, jit: 0.02, tint: STONE_TINT[kit] });
  else B.box(K.woodMat, s.hx * 2, h, s.hz * 2, 0, h / 2 - 0.12, 0, { r: 0.03, tint: K.wood });
  const baseMat = K.foot || (K.post === 'pier' ? 'rs_stone' : 'rs_rock');
  B.box(baseMat, 0.54, 0.32, 0.54, 0, 0.06, 0, { r: 0.08, jit: 0.05, tint: STONE_TINT[kit] });
  B.cyl(K.band === 'rs_rope' ? 'rs_iron' : K.band, 0.02, 0.18, 0.12, 0, h - 0.06, 0, { seg: 4, ry: Math.PI / 4 });
  if (K.band === 'rs_rope') lashing(B, 0, 0.55, 0, 0.12, 2);
  else for (const yy of [0.5, top - 0.1]) B.box(K.band, s.hx * 2 + 0.04, 0.07, s.hz * 2 + 0.04, 0, yy, 0, { r: 0.01 });
  if (u) {
    const kx = u.x - s.x, ky = u.y - gy, kz = u.z - s.z;
    B.box('rs_brass', 0.38, 0.48, 0.1, kx, ky, kz + 0.03, { r: 0.02, faces: { nz: { m: 'rs_gatelabels', fit: true, uvRect: LBL.keypad } } });
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
    B.box(K.woodMat, r * 2, H + 0.4, r * 2, 0, (H + 0.4) / 2 - 0.35, 0, { r: 0.04, taper: 0.92, tint: K.wood, jit: 0.02 });
    B.box('rs_chevband', r * 2 + 0.012, 0.34, r * 2 + 0.012, 0, 0.72, 0, { r: 0.01, fit: true });
  } else if (K.post === 'pier') {
    // a dwarven bollard: octagonal, tapering, a carved rune band, a chamfered cap stone
    const rb = 0.25, rt = 0.18, h = H + 0.25;
    B.cyl('rs_stone', rt, rb, h, 0, h / 2 - 0.3, 0, { seg: 8, ry: Math.PI / 8, caps: false, S: 1.2, tint: STONE_TINT.dwarf });
    B.cyl('rs_stone', rb + 0.07, rb + 0.1, 0.3, 0, 0.0, 0, { seg: 8, ry: Math.PI / 8, bevel: 0.04, caps: 'rs_stone', S: 1.2, tint: STONE_TINT.dwarf, jit: 0.02 });
    const yb = 0.95, rr = lerp(rb, rt, (yb + 0.3) / h) + 0.012;
    B.cyl('rs_rune', rr, rr + 0.004, 0.24, 0, yb, 0, { seg: 8, ry: Math.PI / 8, caps: false, fit: true, uRep: 1 });
    B.cyl('rs_stone', rt + 0.06, rt + 0.06, 0.1, 0, h - 0.3 + 0.05, 0, { seg: 8, ry: Math.PI / 8, bevel: 0.03, caps: false, S: 1.2, tint: STONE_TINT.dwarf });
    B.cyl('rs_stone', 0.06, rt + 0.06, 0.16, 0, h - 0.3 + 0.18, 0, { seg: 8, ry: Math.PI / 8, caps: false, S: 1.2, tint: STONE_TINT.dwarf.map(c => c * 1.06) });
    B.cyl('rs_chevband', lerp(rb, rt, 0.55 / h) + 0.012, lerp(rb, rt, 0.85 / h) + 0.012, 0.3, 0, 0.55, 0, { seg: 8, ry: Math.PI / 8, caps: false, fit: true });
    capY = h - 0.3 + 0.24;
  } else {
    B.cyl(K.woodMat, r, r * 1.08, H + 0.45, 0, (H + 0.45) / 2 - 0.3, 0, { seg: 10, bevel: 0.03, caps: 'rs_logend', jit: 0.01, tint: K.wood });
    if (K.post !== 'bundle') B.cyl('rs_chevband', r + 0.008, r + 0.012, 0.34, 0, 0.72, 0, { seg: 10, caps: false, fit: true });
    capY = H + 0.15;
  }
  if (K.post === 'bundle') { lashing(B, 0, 0.5, 0, r, 3); lashing(B, 0, H - 0.45, 0, r, 2); skull(B, 0, H + 0.24, 0, rnd() * 3, 0.9); }
  else if (K.band === 'rs_brass') { for (const yy of [0.3, H - 0.25]) B.cyl('rs_brass', r + 0.025, r + 0.025, 0.1, 0, yy, 0, { seg: 10, caps: false }); B.cyl('rs_brass', r + 0.02, r * 0.7, 0.1, 0, H + 0.2, 0, { seg: 10 }); }
  else if (K.post !== 'pier' && K.post !== 'square') for (const yy of [0.32, H - 0.3]) B.cyl('rs_iron', r + 0.02, r + 0.02, 0.09, 0, yy, 0, { seg: 10, caps: false });
  if (K.foot === 'rs_adobe') B.dome('rs_adobe', r + 0.32, 0.3, r + 0.32, 0, -0.06, 0, { jit: 0.04, seg: 10, rings: 3 });
  const ay = anchor ? anchor.y - base : H - 0.15;
  B.torus('rs_iron', r + 0.06, 0.045, 0, ay, 0, { rx: Math.PI / 2, seg: 14, lod0: false });
  // the shackle ring, on the side facing the road
  const roadX = ctx.W.roadX ? ctx.W.roadX(c.z) : c.x;
  const dirW = Math.sign(roadX - c.x) || 1;
  const lp = B.loc({ x: c.x + dirW, y: base, z: c.z });
  const a = Math.atan2(lp.x, lp.z);
  // the mooring ring hangs flat against the post from an iron staple, facing the road
  const rr0 = K.post === 'pier' ? lerp(0.25, 0.18, (ay + 0.3) / (H + 0.25)) + 0.02 : r + 0.02;
  B.push(M4(0, ay - 0.02, 0, 0, a, 0));
  B.box('rs_iron', 0.16, 0.05, 0.08, 0, 0.02, rr0 + 0.03, { r: 0.015 });
  for (const sx of [-0.06, 0.06]) B.box('rs_iron', 0.03, 0.08, 0.06, sx, -0.02, rr0 + 0.02, { r: 0.01, lod0: true });
  B.torus('rs_iron', 0.13, 0.03, 0, -0.14, rr0 + 0.07, { rx: 0.12, seg: 14, lod0: false });
  B.pop();
  // two or three boulders of different sizes, sunk and tilted
  const sizes = [0.35, 0.22, 0.15].slice(0, 2 + (rnd() < 0.5 ? 1 : 0));
  let t0 = rnd() * TAU;
  for (const sz of sizes) {
    const t = t0 + range(rnd, 1.6, 2.6), rr = r + sz * 0.8;
    t0 = t;
    // chunky: a rounded block with a few flat planes, sunk and tilted
    const w = sz * range(rnd, 2.0, 2.5), h = sz * range(rnd, 1.3, 1.7), d = sz * range(rnd, 1.7, 2.1);
    B.box('rs_rock', w, h, d, Math.cos(t) * rr, h * 0.3, Math.sin(t) * rr, { r: Math.min(w, h, d) * 0.32, div: [2, 2, 2], jit: sz * 0.28, ry: rnd() * 3, rx: range(rnd, -0.3, 0.3), rz: range(rnd, -0.3, 0.3), S: 1.0, taper: range(rnd, 0.75, 0.9) });
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
  // the log: a bowed bark tube with its top adzed flat (a seat cut into it, about sixty percent of its width)
  const nA = 8, ph = rnd() * 6;
  const cAt = t => V(-Lg / 2 + Lg * t, r, bowZ * (1 - (2 * t - 1) ** 2) - bowZ * 0.5);
  const rAt = (t, th) => r * (1 + 0.08 * Math.sin(t * 5.3 + ph) - 0.04 * t + 0.03 * Math.sin(th * 5 + t * 9));
  const cut = 0.8;
  B.grid('rs_bark', 16, nA, (u, v) => {
    const t = v, th = u * TAU, c = cAt(t), R = rAt(t, th);
    return [c.x, c.y + Math.min(R * Math.cos(th), r * cut), c.z + R * Math.sin(th)];
  }, { wrapU: true, tint, uv: (u, v) => [u * TAU * r / 1.2 + 0.3, v * Lg / 1.2] });
  // the sawn ends
  for (const t of [0, 1]) {
    const c = cAt(t), C = [], n = 16, sg = t ? 1 : -1;
    for (let j = 0; j < n; j++) {
      const v = k => { const th = TAU * k / n, R = rAt(t, th); return { p: [c.x, c.y + Math.min(R * Math.cos(th), r * cut), c.z + R * Math.sin(th)], n: [sg, 0, 0], uv: [0.5 + 0.5 * Math.sin(th) * 0.95, 0.5 + 0.5 * Math.cos(th) * 0.95] }; };
      C.push({ p: [c.x, c.y, c.z], n: [sg, 0, 0], uv: [0.5, 0.5] }, v(j), v(j + 1));
    }
    B.emit('rs_logend', C, B.M.clone(), {});
  }
  // the split-wood face of the seat, a hair proud of the cut, its edges ragged where the adze bit
  const sw = Math.sqrt(1 - cut * cut) * r * 0.97;
  B.grid('rs_planks', 10, 2, (u, v) => { const c = cAt(0.02 + u * 0.96), w = sw * (1 - 0.12 * Math.abs(Math.sin(u * 23 + v * 3))); return [c.x, c.y + r * cut + 0.006, c.z + (v - 0.5) * 2 * w]; }, { flip: true, uv: (u, v, q) => [q[0] * 0.8, q[2] * 1.6 + 0.5], tint: [1.12, 1.05, 0.95] });
  for (let k = 0; k < 4; k++) { const t = range(rnd, 0.1, 0.9), c = cAt(t); B.box('rs_planks', 0.05, 0.014, sw * 1.7, c.x, c.y + r * cut + 0.003, c.z, { r: 0.004, ry: range(rnd, -0.2, 0.2), tint: [0.62, 0.55, 0.5], lod0: true }); }
  for (let k = 0; k < 2 + (rnd() < 0.5 ? 1 : 0); k++) {
    const t = range(rnd, 0.15, 0.85), q = cAt(t), a0 = range(rnd, 1.6, 2.4), a = rnd() < 0.5 ? a0 : -a0;
    B.cyl('rs_bark', 0.035, 0.06, 0.12, q.x, q.y + Math.cos(a) * r * 0.95, q.z + Math.sin(a) * r * 0.95, { rx: a, seg: 6, caps: 'rs_logend', tint });
  }
  if (ctx.snow) {
    // snow on the seat and in a ridge along the bark either side of it
    B.grid('rs_snow!', 10, 2, (u, v) => { const c = cAt(0.04 + u * 0.92), w = sw * 0.9; return [c.x, c.y + r * cut + 0.02 + 0.05 * Math.sin(Math.PI * v) * (0.6 + 0.4 * Math.sin(u * 11)), c.z + (v - 0.5) * 2 * w]; }, { flip: true, noAO: true, uv: (u, v, q) => [q[0] / 2, q[2] / 2] });
  }
}

// Parked RVs in the town lot: junked motorhomes in the SLOPMASTER's own painted language. A two-tone riveted
// skin over a darker skirt, timber corner posts, a cab-over bunk bulging out over a raked windshield, red
// wheel-arch flares, a rack on the roof with lashed crates and a rolled tarp, a brass stovepipe, a sagging
// awning on two poles by the door, one window boarded up crooked; each sits a few degrees off level on its
// flat tyre.
// the three skins live in one atlas (rs_rv_skins), a quarter of v each, their name boards in the last quarter
const RV_SKIN_V = [[0.75, 1], [0.5, 0.75], [0.25, 0.5]];
const RV_NAME = k => [0.01, 1 - (768 + 85 * k + 82) / 1024, 0.99, 1 - (768 + 85 * k + 3) / 1024];
function buildParkedRV(B, s, ctx, idx = 0) {
  const base = s.y - s.hy;
  B.frame(s.x, base, s.z, s.ry || 0);
  const rnd = rngOf(seedOf(s.x, s.z, 51));
  const skin = 'rs_rv_skins', [sv0, sv1] = RV_SKIN_V[idx % 3], SV = (a, b) => [0, lerp(sv0, sv1, a), 1, lerp(sv0, sv1, b)];
  const hx = s.hx, hz = s.hz, H = s.hy * 2, by = 0.55, top = H - 0.08;
  const flatSide = rnd() < 0.5 ? -1 : 1, roll = flatSide * range(rnd, 0.05, 0.09), pitch = range(rnd, -0.02, 0.02);
  B.push(M4(0, 0, 0, pitch, 0, -roll));
  // the body: tapering a little to the roof and to the rear
  const zf = hz - 0.5, zr = -hz + 0.05, bl = zf - zr, bcz = (zf + zr) / 2, bh = top - by, bcy = by + bh / 2;
  const taper = q => { const yN = (q[1] + bh / 2) / bh, zN = (q[2] + bl / 2) / bl; const k = 1 - 0.04 * yN - 0.04 * (1 - zN); q[0] *= k; q[1] -= 0.06 * (1 - zN) * yN; };
  B.box(skin, hx * 2 - 0.04, bh, bl, 0, bcy, bcz, { r: 0.28, div: [2, 3, 6], smoothN: true, fit: 'v', uvRect: SV(0.004, 0.996), S: 3, off: [rnd(), 0], deform: taper, faces: { py: { m: 'rs_tin', rot: true, fit: false, S: 2 }, ny: { m: 'rs_iron', fit: false } } });
  // the cab-over bunk, bulging forward over the windshield
  B.box(skin, hx * 2 - 0.16, 0.9, 0.95, 0, top - 0.48, zf + 0.04, { r: 0.38, div: [2, 2, 2], smoothN: true, fit: 'v', uvRect: SV(0.56, 0.97), deform: q => { if (q[2] > 0) q[1] -= 0.12 * (q[2] / 0.47) ** 2 * (q[1] < 0 ? 1 : 0.3); } });
  B.box('rs_rv_window', 1.1, 0.3, 0.03, 0, top - 0.5, zf + 0.53, { r: 0.01, rx: 0.25 });
  // the raked windshield and the nose under it: grille, brass headlamps
  B.box('rs_glass', hx * 2 - 0.5, 0.66, 0.05, 0, 1.62, zf + 0.06, { r: 0.012, rx: -0.26, uvRect: [0, 0, 0.5, 1] });
  B.box(skin, hx * 2 - 0.1, 0.72, 0.36, 0, 0.92, zf + 0.12, { r: 0.18, fit: 'v', uvRect: SV(0.1, 0.56), div: [2, 1, 1], smoothN: true, deform: q => { q[2] -= 0.04 * (q[0] / hx) ** 2; } });
  B.box('rs_grille', 1.0, 0.44, 0.06, 0, 0.92, zf + 0.31, { r: 0.015 });
  for (const sx of [-1, 1]) B.cyl('rs_brass', 0.15, 0.15, 0.1, sx * 0.82, 0.98, zf + 0.29, { rx: Math.PI / 2, caps: 'rs_headlamp*', seg: 12, bevel: 0.025 });
  // bumpers, tucked in
  B.box('rs_iron', hx * 2 + 0.04, 0.22, 0.16, 0, 0.5, zf + 0.36, { r: 0.06, div: [3, 1, 1], smoothN: true, deform: q => { q[2] -= 0.05 * (q[0] / hx) ** 2; } });
  B.box('rs_iron', hx * 2, 0.2, 0.14, 0, 0.5, zr - 0.08, { r: 0.05 });
  for (let k = 0; k < 5; k++) B.cyl('rs_brass', 0.03, 0.03, 0.04, -1.0 + k * 0.5, 0.5, zf + 0.45, { rx: Math.PI / 2, seg: 6, lod0: true });
  // timber corner posts, an iron chassis rail under the skirt
  for (const sx of [-1, 1]) for (const zz of [zf - 0.3, zr + 0.3]) B.box('rs_timber', 0.15, bh - 0.5, 0.15, sx * (hx - 0.05 - (zz < 0 ? 0.04 : 0)), bcy - 0.05, zz, { r: 0.04, tint: [0.95, 0.9, 0.85] });
  // brass trim strips proud of the skin along the belt and under the roof edge (the SLOPMASTER's), and the
  // motorhome's hand-painted name on a board nailed to the planks
  const nm = RV_NAME(idx % 3);
  for (const sx of [-1, 1]) {
    for (const [yy, k] of [[by + bh * 0.53, 0.985], [top - 0.2, 0.955]]) B.box('rs_brass', 0.04, 0.07, bl - 0.75, sx * (hx * k - 0.01), yy, bcz - 0.05, { r: 0.015, rot: true });
    B.box('rs_timber', 0.05, 0.38, 1.5, sx * (hx - 0.01), by + bh * 0.32, -1.65, { r: 0.015, rz: sx * range(rnd, -0.03, 0.03), faces: { [sx > 0 ? 'px' : 'nx']: { m: skin, fit: true, uvRect: nm } } });
  }
  // and its name again on a board up on the roof over the cab, on two brass posts
  for (const sx of [-0.6, 0.6]) B.cyl('rs_brass', 0.03, 0.03, 0.5, sx, top + 0.22, zf - 0.35, { seg: 6, caps: false });
  B.box('rs_timber', 1.75, 0.42, 0.07, 0, top + 0.52, zf - 0.33, { r: 0.02, rz: range(rnd, -0.03, 0.03), faces: { pz: { m: skin, fit: true, uvRect: nm }, nz: { m: skin, fit: true, uvRect: nm } } });
  if (ctx.snow) snowCap(B, 1.75, 0.07, 0, top + 0.73, zf - 0.33, { t: 0.08, lip: 0.02, ext: 0.03, lod0: true });
  for (const sx of [-1, 1]) B.box('rs_iron', 0.14, 0.2, bl - 0.6, sx * 0.62, 0.42, bcz, { r: 0.03 });
  // windows down both sides, one boarded up crooked; the door and its step on the +x side
  for (const sx of [-1, 1]) {
    const xs = sx * (hx - 0.04 - 0.02);
    for (const [zc, w] of [[1.7, 1.15], [-0.6, 0.95], [-2.6, 1.05]]) {
      const boarded = sx === flatSide && zc < 0 && zc > -1;
      B.box('rs_rv_window', 0.03, 0.68, w, xs + sx * 0.03, 2.0, zc, { r: 0.01 });
      B.box('rs_timber', 0.04, 0.08, w + 0.12, xs + sx * 0.05, 1.63, zc, { r: 0.015, rot: true, tint: [0.95, 0.9, 0.85] });
      if (boarded) for (let k = 0; k < 3; k++) B.box('rs_planks_gray', 0.03, 0.2, w + 0.3, xs + sx * 0.07 + sx * k * 0.005, 1.78 + k * 0.22, zc + range(rnd, -0.08, 0.08), { rx: range(rnd, -0.18, 0.18), r: 0.01, rot: false, jit: 0.01 });
    }
  }
  const dx = hx - 0.02;
  B.box(skin, 0.05, 1.9, 0.78, dx + 0.02, by + 1.0, 0.55, { fit: 'v', uvRect: SV(0.05, 0.92), r: 0.015, tint: [0.9, 0.9, 0.9] });
  B.box('rs_rv_window', 0.03, 0.4, 0.44, dx + 0.06, 2.1, 0.55, { r: 0.01 });
  B.box('rs_brass', 0.05, 0.05, 0.14, dx + 0.07, 1.45, 0.28);
  B.box('rs_planks_gray', 0.42, 0.07, 0.66, dx + 0.24, 0.32, 0.55, { r: 0.015 });
  // the awning: canvas off the roof edge, sagging between two poles
  {
    const z0 = -0.75, z1 = 1.85, out = 1.7, y0 = top - 0.2, y1 = 2.15, sag = 0.18;
    B.grid('rs_canvas~', 8, 4, (u, v) => {
      const zz = lerp(z0, z1, u), x = dx + 0.04 + out * v, edge = Math.min(u, 1 - u) < 0.12 ? 0 : 1;
      return [x, lerp(y0, y1, v) - sag * Math.sin(Math.PI * u) * Math.sin(Math.PI * v * 0.9) * (0.6 + 0.4 * v) * edge - 0.04 * Math.sin(u * 17) * v, zz];
    }, { uv: (u, v) => [u * (z1 - z0) / 3, v * 0.7] });
    for (const zz of [z0 + 0.1, z1 - 0.1]) { const px = dx + out + 0.02, gy = B.ground(px, zz); B.cyl('rs_timber', 0.035, 0.04, y1 - gy + 0.05, px, (y1 + gy) / 2, zz, { seg: 6, caps: false, rz: range(rnd, -0.05, 0.05) }); B.tube('rs_rope', [V(px, y1, zz), V(px + 0.5, gy, zz + 0.3)], 0.012, { seg: 4, lod0: true }); }
  }
  // the roof: a rack with lashed crates and a rolled tarp, the stovepipe, a vent
  const ry0 = top + 0.12;
  for (const sx of [-1, 1]) B.box('rs_iron', 0.05, 0.05, 3.6, sx * (hx - 0.3), ry0, -0.9, { r: 0.012 });
  for (let k = 0; k < 4; k++) B.box('rs_iron', hx * 2 - 0.55, 0.04, 0.05, 0, ry0 + 0.02, -2.5 + k * 1.05, { r: 0.01 });
  for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) B.cyl('rs_iron', 0.02, 0.02, 0.14, sx * (hx - 0.3), ry0 - 0.07, -2.5 + k * 1.6, { seg: 4, caps: false, lod0: true });
  B.box('rs_crate_a', 0.62, 0.48, 0.55, -0.32, ry0 + 0.26, -1.9, { r: 0.03, ry: range(rnd, -0.15, 0.15) });
  B.box('rs_crate_a', 0.5, 0.4, 0.5, 0.36, ry0 + 0.22, -1.3, { r: 0.03, ry: range(rnd, -0.2, 0.2) + 1.6 });
  B.box('rs_rope', 0.03, 0.03, 1.4, 0, ry0 + 0.49, -1.6, { r: 0, lod0: true });
  B.cyl('rs_canvas~', 0.2, 0.2, hx * 2 - 0.5, 0, ry0 + 0.2, -0.3, { rz: Math.PI / 2, seg: 10, caps: 'rs_canvas~', fit: false });
  for (const sx of [-0.6, 0.6]) B.torus('rs_rope', 0.205, 0.02, sx, ry0 + 0.2, -0.3, { ry: Math.PI / 2, seg: 10, tseg: 4, uRep: 6, lod0: true });
  B.cyl('rs_brass', 0.07, 0.08, 0.95, hx - 0.55, top + 0.4, -2.9, { seg: 8, caps: false });
  B.cyl('rs_brass', 0.02, 0.22, 0.16, hx - 0.55, top + 1.02, -2.9, { seg: 8, caps: 'rs_iron' });
  for (const a of [0, 2.1, 4.2]) B.cyl('rs_iron', 0.012, 0.012, 0.12, hx - 0.55 + Math.sin(a) * 0.06, top + 0.9, -2.9 + Math.cos(a) * 0.06, { seg: 4, caps: false, lod0: true });
  B.box('rs_tin', 0.7, 0.26, 0.62, -0.35, top + 0.1, 1.2, { r: 0.06, rot: true });
  // rear: window, tail lamps, a ladder, the spare
  B.box('rs_rv_window', 1.0, 0.55, 0.03, 0, 2.15, zr - 0.02, { r: 0.01 });
  for (const sx of [-1, 1]) B.box('rs_headlamp*', 0.13, 0.22, 0.04, sx * 0.95, 1.05, zr - 0.03, { tint: [1, 0.38, 0.3] });
  for (const sx of [-1, 1]) B.cyl('rs_iron', 0.022, 0.022, top - 0.55, 0.45 + sx * 0.22, (top + 0.55) / 2, zr - 0.07, { seg: 5, caps: false });
  for (let y = 0.75; y < top; y += 0.32) B.cyl('rs_iron', 0.018, 0.018, 0.44, 0.45, y, zr - 0.07, { rz: Math.PI / 2, seg: 4, caps: false });
  B.cyl('rs_tire', 0.42, 0.42, 0.22, -0.5, 1.3, zr - 0.18, { rx: Math.PI / 2, caps: 'rs_hub_cream', fit: true, uRep: 6, bevel: 0.05, seg: 14 });
  // wheels under red arch flares; the flat one on the low side
  for (const zz of [zf - 1.25, zr + 1.5]) for (const sx of [-1, 1]) {
    const flat = sx === flatSide && zz > 0;
    wheel(B, sx * (hx - 0.2), flat ? 0.36 : 0.44, zz, 0.46, 0.3, { flat, hub: 'rs_hub_cream' });
    B.push(M4(sx * (hx - 0.02), 0.5, zz, 0, 0, 0, 1, 1, 1));
    const pts = []; for (let k = 0; k <= 10; k++) { const a = -0.25 + (Math.PI + 0.5) * k / 10; pts.push(V(0, Math.sin(a) * 0.58, Math.cos(a) * 0.62)); }
    B.tube('rs_steel_red', pts, 0.08, { seg: 7, ends: true, S: 1 });
    B.pop();
  }
  if (ctx.snow) {
    snowCap(B, hx * 2 - 0.36, bl - 0.5, 0, top - 0.02, bcz, { t: 0.2 });
    snowCap(B, 0.5, 1.5, 0.3, ry0 + 0.32, -0.3, { t: 0.08, lod0: true });
    for (const sx of [-1, 1]) icicles(B, sx * (hx + 0.0), zr + 0.4, sx * (hx + 0.0), zf - 0.3, top - 0.16, rnd, { max: 0.3 });
  }
  B.pop();
  if (ctx.driftMat) { drift(B, ctx, -hx - 0.2, 0.5, 0.7, 3.2, ctx.snow ? 0.5 : 0.36, 0); drift(B, ctx, hx + 0.2, -2.2, 0.5, 1.3, 0.26, 0); }
}

// ---- assembly ----------------------------------------------------------------------------------------------

// mounds and drifts borrow the terrain's own ground textures; fall back to ours if one is ever renamed
const groundMat = (m, fb) => (m && has(baseName(m)) ? m : fb);
function makeCtx(W) {
  const biome = BIO[W.biome] ? W.biome : 'meadow';
  const b0 = BIO[biome];
  const bio = { ...b0, ground: groundMat(b0.ground, 'rs_dirt!'), drift: b0.drift && groundMat(b0.drift, biome === 'snow' ? 'rs_snow!' : biome === 'desert' ? 'rs_sand!' : 'rs_dust!') };
  // the terrain's tint at a ground point (terrain3d's terrainTintAt, when it has one), cached on a 0.5 m grid
  let groundTint = null;
  if (typeof TERRAIN.terrainTintAt === 'function' && W.heights) {
    const cache = new Map();
    groundTint = (x, z) => {
      const k = Math.round(x * 2) * 100003 + Math.round(z * 2);
      let c = cache.get(k);
      if (!c) { try { const t = TERRAIN.terrainTintAt(W, Math.round(x * 2) / 2, Math.round(z * 2) / 2); c = [t.r, t.g, t.b]; } catch { c = [1, 1, 1]; } cache.set(k, c); }
      return c;
    };
  }
  return {
    W, biome, bio, H: (x, z) => W.heightAt(x, z), ao: bio.ao, aoH: 0.9,
    snow: biome === 'snow', driftMat: bio.drift, cover: bio.cover, smokes: [], groundTint,
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
  if (rvs.length) { const B = new Builder(ctx); rvs.forEach((s, i) => buildParkedRV(B, s, ctx, i)); finish(B, ctx, group, clusters); }

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
