// Terrain: the painted ground. One splat shader (MeshLambertMaterial + onBeforeCompile, so
// lights, shadows and fog keep working) blends per biome: the main ground at two scales (picked
// patch by patch, so the tile never shows), a second ground in big blobs of noise, bare dirt in
// clearings (scorched and ashy round the fires), the dirt road by distance from its centerline
// (sampled in road space, a second sample at a 23 m period taking over in patches, with a ragged
// painterly edge), mud in the mud stretches (also in road space, its puddles lying along the wheel
// tracks), and rock by slope. The slope is SMOOTHED (averaged over 7 x 7 cells) and read from a
// bilinear data texture over the grid (and another over the apron), never interpolated per
// triangle, so no edge ever follows the heightfield's triangles. Rock is projected from the side
// (x or z picked from the smoothed facing, dithered), crossfaded at two scales so a long wall never
// repeats; ledges inside the rock hold the ground's grass or snow, and a thin scree collar rings it.
// In the snow, blue-gray granite shows on faces steeper than ~45 degrees (far mountains on gentler
// ones), and the snow on it is laid on whatever the PAINTED rock turns up to the sky and in its
// hollows (cliff_snow_form, a companion map of the texture's form), in long lumpy shelves, with
// every edge antialiased: gentle granite holds a lot of it, a sheer face only its ledges. On steep
// faces the edges are broken by a noise laid ON the face (the slope and macro noise are sampled by
// x and z, so up a face they would only run in vertical bands). A crash mesa is granite all round,
// projected square to each face, from a lumpy drift at its foot to a snow cap over its lip and a band
// on its bench, all set by HEIGHT, so no edge ever follows its triangles (its steep sliver facets,
// where the heightfield folds, take the projection their own facet faces). The valley walls' angular
// granite (cliff_snow) is crossfaded with a second sample turned 30 degrees and 1.6x larger (its form
// turned to match), and carries two or three snow-capped ledges at world heights; the mesas wear the
// same granite turned +30 / -24 degrees (diagonal fracture planes, no row of blocks), and terrain_talus.js
// breaks their silhouettes (shoulders, rim blocks, talus). Round each crash mesa the mesh is drawn 4x
// finer (terrain_mesa.js): smooth normals, heights within 0.35 m of the physics.
// Tanaris keeps its wind ripples to the dune floor (they smooth away from ~20 degrees and far off),
// streaks its sand slopes down their fall line and exposes its sandstone from ~35 degrees, its beds
// rising and falling along the valley; its crash mesa is a sandstone butte (rock all round under a sand
// cap, a lit ledge at its bench, a broken caprock and talus from terrain_talus.js). Westfall paints its
// cultivated plots (W.fields) into the splat: turned furrows lit by the real sun, cut stubble with raked
// windrows, standing wheat (a thicket of cards along every row), each inside a trodden headland and a
// wandering, ragged edge; rows finer than a few pixels melt into the plot's own average tone.
// Ground on slopes is projected from the side too. Explicit texture gradients with a capped
// anisotropy keep grazing facets from washing out. Broad warm/cool and value fields and baked
// ambient occlusion sit on top, a 1.8 m detail map crisps the ground at the camera's feet, and
// the snow glints in low direct sun. Beyond the playable heightfield an apron of unreachable hills
// (stitched to the grid's rim vertex for vertex, so no crack of sky) carries the land out to the
// horizon; at both ends the road's valley bends away behind a shoulder and closes over a saddle.
// (In the Badlands it steps up in benches: a 2.5 m lattice near the grid, each cell split along
// the diagonal nearer the contour, normals from 1-ring-smoothed heights, so a riser is one soft
// band and the painted strata carry the detail.) Far off in the snow the road's ruts darken.
// The terrain's skyline around the camera goes to the atmosphere, whose horizon rings haze up
// from it. Instanced ground clutter grows in patches around the camera, never on the bare dirt of
// a clearing, a building's lot, a cultivated plot (wheat stands there in rows, cut stubble in a few
// tufts) or a code painted on the ground. terrainTintAt() gives other
// modules the splat's tint and occlusion at a point.
//
// Owned by the terrain/atmosphere art pass. API: buildTerrain(W) -> { group, update(dt, t, camPos), dispose() },
// terrainTintAt(W, x, z) -> THREE.Color (see the comment above it).
// The visible grid is exactly the physics heightfield (same vertices, same diagonal split).
import { THREE, tex, renderer } from './gfx.js';
import { canvasFor, has } from './paint/index.js';
import { atmo, setSkyline } from './atmosphere.js';
import { fbm, noise2 } from '/shared/rng.js';
import { BIOME_BY_DAY } from '/shared/world.js';
import { mesaRefiner } from './terrain_mesa.js';
import { buildTalus } from './terrain_talus.js';

const CHUNK = 40;            // cells per terrain chunk side (100 m): few draw calls, still culls
const SHOULDER = 1.7;        // the road texture runs this far past the driven edge on each side
const MUD_TILE = 10;         // the mud texture spans 10 m across the road, like the road texture

// Per-biome look. scale: meters per tile [ground, ground2, dirt, cliff].
// clutter: cell size (m), slots per cell, patch noise scale (m), how sparse (density), cards [w, h, weight].
const CFG = {
  meadow: {
    hw: 3.0, scale: [7, 9, 6, 15], cliff: [0.34, 0.5], cliffN: [0.14, 0.04], g2: [0.56, 0.5], collar: [0.2, 0.11, 0.045], ledge: [0.95, 0.97, 0.9],
    ao: [0.5, 0.52, 0.7], tintA: [1.12, 1.04, 0.78], tintB: [0.82, 0.95, 1.0], macro: 0.4, macro2: 0.16, detail: [0.75, 0.32, 0.0],
    clutter: { cell: 2.2, slots: 4, radius: 23, patch: 9, density: 1.0, spread: 0.8, flowers: 0.16, flowerCards: [2, 3, 7],
      cards: [[0.85, 0.6, 0.34], [0.7, 0.45, 0.22], [0.65, 0.55, 0.08], [0.65, 0.55, 0.08], [0.75, 0.85, 0.08], [0.65, 0.42, 0.1], [0.8, 0.6, 0.2], [0.6, 0.38, 0.06]] },
  },
  fields: {
    hw: 3.0, scale: [7, 9, 6, 15], cliff: [0.34, 0.5], cliffN: [0.14, 0.04], g2: [0.6, 0.45], collar: [0.3, 0.2, 0.09], reveal: [0.38, 0.62, 0.85], ledge: [0.95, 0.95, 0.9], plots: true,
    ao: [0.55, 0.52, 0.66], tintA: [1.08, 1.0, 0.84], tintB: [0.9, 0.98, 1.0], macro: 0.36, detail: [0.7, 0.32, 0.0],
    clutter: { cell: 2.2, slots: 4, radius: 23, patch: 10, density: 0.95, spread: 0.85, flowers: 0.06, flowerCards: [4], wheat: 0.3, wheatCards: [[1, 0.95], [2, 0.72]],
      cards: [[0.85, 0.62, 0.36], [0.95, 0.95, 0.04], [0.85, 0.72, 0.04], [0.8, 0.58, 0.22], [0.65, 0.55, 0.05], [0.85, 0.72, 0.16], [0.8, 0.7, 0.08], [0.7, 0.32, 0.08]] },
  },
  snow: {
    hw: 3.0, scale: [8, 9, 6, 10.5], cliff: [0.27, 0.38], cliffN: [0.14, 0.04], g2: [0.62, 0.42], collar: [0.62, 0.68, 0.8], ledge: [1.0, 1.0, 1.0], snowRock: true, local: 0.02, mesaK: 0.32,
    ao: [0.6, 0.67, 0.86], tintA: [1.03, 1.01, 0.96], tintB: [0.88, 0.94, 1.06], macro: 0.26, macro2: 0.1, mudTex: 'slush', sparkle: true, detail: [0.0, 0.12, 0.3], rutFar: [0.4, 0.14],
    clutter: { cell: 3.0, slots: 3, radius: 22, patch: 10, density: 0.5, spread: 1.0, flowers: 0,
      cards: [[0.8, 0.55, 0.38], [0.8, 0.6, 0.16], [0.7, 0.42, 0.04], [0.95, 0.75, 0.26], [1.1, 0.5, 0.14], [0.6, 0.38, 0.2], [0.85, 0.65, 0.08], [0.9, 0.4, 0.12]] },
  },
  badlands: {
    hw: 3.1, scale: [7, 8, 6, 17], cliff: [0.12, 0.24], cliffN: [0.12, 0.05], g2: [0.6, 0.35], collar: [0.36, 0.16, 0.08], ledge: [1, 1, 1], strata: true, mudTex: 'mud_badlands', local: 0.06, mesaK: 0.05, terrace: [17, 0.5, 0.97],
    ao: [0.52, 0.42, 0.55], tintA: [1.07, 1.0, 0.9], tintB: [0.92, 0.95, 1.03], macro: 0.32, detail: [0.08, 0.45, 0.1],
    clutter: { cell: 3.2, slots: 3, radius: 22, patch: 12, density: 0.42, spread: 1.0, flowers: 0,
      cards: [[0.75, 0.5, 0.3], [0.8, 0.55, 0.12], [0.75, 0.5, 0.12], [0.7, 0.5, 0.12], [0.75, 0.5, 0.16], [0.85, 0.6, 0.06], [0.7, 0.45, 0.06], [0.5, 0.3, 0.14]] },
  },
  desert: {
    hw: 3.1, scale: [8, 8, 6, 16], cliff: [0.1, 0.2], cliffN: [0.1, 0.04], g2: [0.62, 0.3], collar: [0.5, 0.36, 0.2], ledge: [1, 1, 1], strata: true, dunes: true, mudTex: 'mud_desert', local: 0.02, mesaK: 0.2,
    scree: [0.12, 0.19, 0.12, 0.24], strataWarp: 3.5, farS: 0.5, rockDet: 0.5,
    ao: [0.6, 0.5, 0.58], tintA: [1.05, 1.0, 0.9], tintB: [0.94, 0.97, 1.03], macro: 0.3, detail: [0.0, 0.3, 0.38],
    clutter: { cell: 4.0, slots: 2, radius: 22, patch: 12, density: 0.3, spread: 1.0, flowers: 0,
      cards: [[0.7, 0.45, 0.34], [0.75, 0.5, 0.12], [0.7, 0.45, 0.12], [0.6, 0.45, 0.08], [0.8, 0.75, 0.12], [0.7, 0.45, 0.06], [0.6, 0.4, 0.06], [0.5, 0.3, 0.14]] },
  },
};

// Westfall's cultivated plots (W.fields), painted into the splat: at most MAX_PLOTS per leg. Their
// colours (sRGB): furrow trough, mid, lit ridge; stubble soil, straw, lit straw; wheat gap, body, lit heads.
const MAX_PLOTS = 10;
const PLOT_COLORS = ['#3e2b1e', '#6c4a32', '#a47a50', '#8a6c4a', '#cdb47e', '#e4d29e', '#5e4a22', '#c39a3c', '#efcd6c'];

// A plot edge's wander along its length and the rows' jittered spacing: the same functions as the
// splat's plotWarp() and rowJ(), so the wheat cards stand where the splat paints the crop.
const plotWarp = (s, ph) => 0.42 * Math.sin(s * 0.31 + ph * 2) + 0.24 * Math.sin(s * 0.83 + ph * 5) + 0.12 * Math.sin(s * 2.3 + ph * 7);
const rowJ = (x, pk) => 0.05 * Math.sin(x * 1.9 + pk) + 0.0125 * Math.sin(x * 4.3 + pk * 3);
// how far (u, v) in a plot's frame lies inside its wandering edge (m)
const plotM = (f, u, v) => { const pk = f.i * 1.37; return Math.min(f.hl - Math.abs(u) + plotWarp(v, pk + (u > 0 ? 0 : 3.1)), f.hd - Math.abs(v) + plotWarp(u, pk + (v > 0 ? 1.7 : 4.9))); };

const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Road half-width along the leg: the town's main street is wider.
const roadHW = (W, cfg, z) => cfg.hw + 1.8 * sstep(W.LEN + 2, W.LEN + 22, z);

// ---- the splat material --------------------------------------------------------------------

function rawTex(name, linear = false) {
  if (!linear) return tex(name);
  const t = new THREE.CanvasTexture(canvasFor(name));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
let macroTex = null, detailTex = null;

// SwiftShader (headless screenshots, software GPUs) gets less anisotropic filtering.
let cheapGPU = null;
function isCheapGPU() {
  if (cheapGPU != null) return cheapGPU;
  cheapGPU = false;
  try {
    const gl = renderer?.getContext();
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '');
    cheapGPU = /swiftshader|llvmpipe|software/i.test(String(name));
  } catch { cheapGPU = false; }
  return cheapGPU;
}

// One splat material per biome (its textures are cached anyway), so revisiting a biome reuses it.
const splatCache = new Map();
function splatMaterial(biome, cfg) {
  if (splatCache.has(biome)) return splatCache.get(biome);
  macroTex ||= rawTex('terrain_macro', true);
  if (!detailTex) { detailTex = rawTex('terrain_detail', true); detailTex.anisotropy = isCheapGPU() ? 2 : 8; }
  const cheap = isCheapGPU();
  const T = n => { const t = tex(n), a = cheap ? 2 : 8; if (t.anisotropy !== a) { t.anisotropy = a; t.needsUpdate = true; } return t; };
  const U = {
    tG1: { value: T(`ground_${biome}`) }, tG2: { value: T(`ground2_${biome}`) }, tDirt: { value: T(`dirt_${biome}`) },
    tRoad: { value: T(`road_${biome}`) }, tCliff: { value: T(`cliff_${biome}`) }, tMud: { value: T(cfg.mudTex || 'mud') }, tMacro: { value: macroTex }, tDetail: { value: detailTex }, uDetail: { value: new THREE.Vector3(...(cfg.detail || [0, 0, 0])) },
    uSpark: { value: 0 }, tSlope: { value: null }, tSlopeR: { value: null }, uGrid: { value: new THREE.Vector4(0, 0, 1, 0) }, uGridN: { value: new THREE.Vector2(2, 2) }, tSlopeA: { value: null }, uGridA: { value: new THREE.Vector4(0, 0, 1, 0) }, uGridAN: { value: new THREE.Vector2(2, 2) }, uFire: { value: new THREE.Vector4(1e5, 1e5, 1e5, 1e5) }, uRoadSpan: { value: 2 * (cfg.hw + SHOULDER) }, uRutFar: { value: new THREE.Vector2(...(cfg.rutFar || [0, 0])) },
    uScale: { value: new THREE.Vector4(...cfg.scale) }, uMisc: { value: new THREE.Vector4(MUD_TILE, 10, cfg.macro, cfg.macro2 ?? 0.12) },
    uCliff: { value: new THREE.Vector2(...cfg.cliff) }, uLocal: { value: cfg.local ?? -1 }, uCliffN: { value: new THREE.Vector2(...cfg.cliffN) }, uG2: { value: new THREE.Vector2(...cfg.g2) },
    uAO: { value: new THREE.Vector3(...cfg.ao) }, uCollar: { value: new THREE.Vector3(...cfg.collar) }, uRev: { value: new THREE.Vector3(...(cfg.reveal || [0.24, 0.76, 0.5])) },
    uPlot: { value: Array.from({ length: MAX_PLOTS }, () => new THREE.Vector4(1e5, 1e5, 0, 1)) }, uPlotB: { value: Array.from({ length: MAX_PLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uPlotC: { value: PLOT_COLORS.map(c => new THREE.Color(c)) },
    uSun: { value: new THREE.Vector3(0.57, 0.74, -0.36) },
    uScree: { value: new THREE.Vector4(...(cfg.scree || [0.3, 0.5, 0.3, 0.46])) }, uSWarp: { value: cfg.strataWarp ?? 0 }, uFarS: { value: cfg.farS ?? 0.4 }, uRockDet: { value: cfg.rockDet ?? 0 },
    uMesa: { value: Array.from({ length: 8 }, () => new THREE.Vector4(1e5, 1e5, 0, 0)) }, uMesaY: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) }, uMesaK: { value: cfg.mesaK ?? 0.12 }, uLedge: { value: new THREE.Vector3(...cfg.ledge) }, uTintA: { value: new THREE.Vector3(...cfg.tintA) }, uTintB: { value: new THREE.Vector3(...cfg.tintB) },
  };
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (cfg.snowRock) {
    // the angular granite's form (the valley walls and the crash mesas share the granite)
    const f = rawTex('cliff_snow_form', true); f.anisotropy = cheap ? 2 : 8; U.tForm = { value: f };
  }
  m.userData.U = U;
  m.defines = {};
  if (cfg.sparkle) m.defines.TERRAIN_SPARKLE = 1;
  if (cfg.strata) m.defines.TERRAIN_STRATA = 1;
  if (cfg.dunes) m.defines.TERRAIN_DUNES = 1;
  if (cfg.plots) m.defines.TERRAIN_PLOTS = 1;
  if (cfg.snowRock) m.defines.TERRAIN_SNOWROCK = 1;
  m.defines.TERRAIN_ANISO = cheap ? '2.0' : '3.0';
  m.defines.TERRAIN_NEARSHARP = cheap ? '0.62' : '0.82';
  const key = 'terrain-splat-v25' + (cfg.sparkle ? 's' : '') + (cfg.strata ? 't' : '') + (cfg.dunes ? 'd' : '') + (cfg.plots ? 'p' : '') + (cfg.snowRock ? 'r' : '') + (cheap ? 'c' : '');
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aRoad; attribute vec4 aSplat; attribute float aCv; attribute vec2 aSlope;
        varying vec4 vRoad; varying vec4 vSplat; varying vec3 vTPos; varying vec3 vTNrm; varying float vCv; varying vec2 vSlope;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoad = aRoad; vSplat = aSplat; vCv = aCv; vSlope = aSlope;
        vTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tG1, tG2, tDirt, tRoad, tCliff, tMud, tMacro, tSlope, tSlopeA, tDetail; uniform vec4 uGrid, uGridA; uniform vec2 uGridN, uGridAN; uniform vec3 uDetail;
        #ifdef TERRAIN_SNOWROCK
          uniform sampler2D tForm;
          // the walls' second granite sample: turned 30 degrees and 1.6x larger (its form turned to match)
          const mat2 SR = mat2(0.866, 0.5, -0.5, 0.866);
          const float SRS = 1.0 / 1.6;
          vec2 formTurn(vec3 f) { return vec2(0.5 + 0.5 * (0.866 * (f.r * 2.0 - 1.0) - 0.5 * (f.b * 2.0 - 1.0)), f.g); }
          // (a crash mesa wraps the granite round itself turned atan(1/2) = 26.6 degrees, 7.96 m a tile: once
          // round its 8.5 m cylinder is 3 sqrt(5) tiles along the turned axis, i.e. (6, 3) whole tiles, so
          // the wrap closes without a seam)
          const mat2 SRC = mat2(0.894427, 0.447214, -0.447214, 0.894427);
          const float SRCS = 0.125613;
          vec2 formTurnC(vec3 f) { return vec2(0.5 + 0.5 * (0.894427 * (f.r * 2.0 - 1.0) - 0.447214 * (f.b * 2.0 - 1.0)), f.g); }
        #endif
        // a crash mesa's rock is wrapped round a cylinder of this radius about its centre (m)
        #define MESA_RC 8.5
        #ifdef TERRAIN_STRATA
          uniform sampler2D tSlopeR;
        #endif
        #ifdef TERRAIN_PLOTS
          uniform vec4 uPlot[${MAX_PLOTS}], uPlotB[${MAX_PLOTS}]; uniform vec3 uPlotC[9];
          uniform vec3 uSun;
          // a plot edge's wander along its length (+-0.8 m over 3-20 m; plotWarp() in JS is the same)
          float plotWarp(float s, float ph) { return 0.42 * sin(s * 0.31 + ph * 2.0) + 0.24 * sin(s * 0.83 + ph * 5.0) + 0.12 * sin(s * 2.3 + ph * 7.0); }
          // the rows' spacing, jittered +-15% (a monotone warp; rowJ() in JS is the same)
          float rowJ(float x, float pk) { return 0.05 * sin(x * 1.9 + pk) + 0.0125 * sin(x * 4.3 + pk * 3.0); }
        #endif
        uniform vec4 uMesa[8], uMesaY[8]; uniform float uMesaK;
        uniform vec4 uScale, uMisc, uFire; uniform vec2 uCliff, uCliffN, uG2; uniform vec3 uAO, uTintA, uTintB, uCollar, uLedge, uRev; uniform float uSpark, uRoadSpan, uLocal, uSWarp, uFarS, uRockDet; uniform vec2 uRutFar; uniform vec4 uScree;
        varying vec4 vRoad; varying vec4 vSplat; varying vec3 vTPos; varying vec3 vTNrm; varying float vCv; varying vec2 vSlope;
        float tLum(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }
        float tHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
        // Cap the anisotropy of a pair of texture gradients at 3:1 by shortening the long one. On the
        // grazing facets of a steep zigzag wall the long gradient would otherwise pick a far blurrier
        // mip than the facets beside it, and the texture would wash out triangle by triangle.
        // (2:1 where the GPU filters no more than 2x anisotropically, e.g. SwiftShader: the texture
        // then resolves at its short-axis mip instead of smearing along the view)
        void tCapK(inout vec2 dx, inout vec2 dy, float k) {
          float lx = length(dx), ly = length(dy), lm = k * min(lx, ly) + 1e-6;
          if (lx > lm) dx *= lm / lx;
          if (ly > lm) dy *= lm / ly;
        }
        void tCap(inout vec2 dx, inout vec2 dy) { tCapK(dx, dy, TERRAIN_ANISO); }
        // the crash mesas' rock: the walls' own (in the snow it is turned, below)
        #define CLIFF_M tCliff
        // the rock's second sample (a long wall never repeats) and its far sample (bigger masses): a
        // 0.71 x 0.83 and a 0.4x scale; in the Tanaris sandstone both scale only along the wall, so its
        // beds stay at the same heights (a bed seen through two samples at two heights would ghost into
        // soft double lines)
        #ifdef TERRAIN_DUNES
          #define P2(p, ox, oy) vec2(p.x * 0.71 + ox, p.y)
          #define P2K vec2(0.71, 1.0)
          #define PF(p, ox, oy) vec2(p.x * uFarS + ox, p.y)
          #define PFK (vec2(uFarS, 1.0) * farMip)       // (and softer with distance: far off, only the big beds)
        #else
          #define PF(p, ox, oy) (p * uFarS + vec2(ox, oy))
          #define PFK uFarS
          #define P2(p, ox, oy) vec2(p.x * 0.71 + ox, p.y * 0.83 + oy)
          #define P2K 0.77
        #endif
        `)
      .replace('#include <map_fragment>', `
        float tSpark = 0.0;
        {
          // Each optional layer is fetched only where it can show, and every blend weight is
          // faded to zero at its branch boundary, so the fetches can use implicit derivatives.
          const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);       // a rotated frame breaks the tile grid
          vec3 wp = vTPos; vec3 nr = normalize(vTNrm);
          vec2 xz = wp.xz, xr = ROT * xz;
          vec3 wpX = dFdx(vTPos), wpY = dFdy(vTPos);     // (taken here, in uniform control flow)
          #ifdef TERRAIN_SNOWROCK
            vec3 fN = normalize(cross(wpX, wpY));     // the facet's own normal (a crash mesa's rock, below)
          #endif
          // large-scale noise comes per vertex (vRoad.zw, vSplat.w); one fetch gives the medium/fine noise
          vec4 mB = texture2D(tMacro, xr / 61.0 + vec2(0.31, 0.77));   // r: ~7-20 m, g: ~3-9 m, b: ~1-3 m
          float nE = mB.b;
          // the smoothed slope (x: 7 x 7 cells, y: 3 x 3), bilinear over the grid from a data texture
          // (a per-vertex value is linear within each triangle, so its threshold would follow the
          // triangle diagonals in a sawtooth; the bilinear one curves smoothly); the apron's own
          // (already smooth) value outside the grid
          vec2 sl, hn;     // hn: which way the slope faces (for the side projections)
          // (past the grid's edge the grid's own value, clamped at its rim, crossfades over 12 m into
          // the apron's, so rock never stops dead along the seam)
          vec2 gq = (wp.xz - uGrid.xy) / uGrid.z, gqc = clamp(gq, vec2(0.0), uGridN - 1.0);
          vec4 st = textureLod(tSlope, (gqc + 0.5) / uGridN, 0.0);
          float dOut = length(gq - gqc) * uGrid.z;
          if (dOut > 0.0) st = mix(st, textureLod(tSlopeA, ((wp.xz - uGridA.xy) / uGridA.z + 0.5) / uGridAN, 0.0), smoothstep(0.0, 12.0, dOut));   // the apron, on its own 10 m lattice
          sl = st.rg; hn = st.ba * 2.0 - 1.0;
          // the crash mesas: mY is the nearest one's foot, lip and bench heights and the bench's
          // bearing, mC its centre
          float mesaK = 0.0; vec4 mY = vec4(0.0); vec2 mC = vec2(0.0);
          for (int i = 0; i < 8; i++) {
            float w = 1.0 - smoothstep(uMesa[i].z, uMesa[i].z + 5.0, distance(wp.xz, uMesa[i].xy));
            if (w > mesaK) { mesaK = w; mY = uMesaY[i]; mC = uMesa[i].xy; }
          }
          #ifndef TERRAIN_SNOWROCK
            if (sl.y <= 0.1) mesaK = 0.0;          // (elsewhere only the flanks shift the rock)
          #endif
          #if defined(TERRAIN_SNOWROCK) || defined(TERRAIN_DUNES)
            // round a crash mesa everything is projected square to the face's own facing (the smoothed
            // facing averages over the whole small form, and its lobes and bench ends face sideways,
            // so either would project them edge-on, smeared into chevrons)
            if (mesaK > 0.0) hn = mix(hn, nr.xz / max(length(nr.xz), 1e-3), mesaK);
          #endif
          // ground: two scales of the main ground, picked patch by patch so neither tile shows. Flat
          // ground is projected from above; on slopes (by a smoothed slope, so the grid never shows)
          // from the side, x- or z-facing, the switch dithered by noise. Every fetch is given the
          // derivatives of its own projection, so a switch never drops to a tiny mip along the seam.
          float distK = smoothstep(80.0, 260.0, distance(cameraPosition, wp));
          float gB = exp2(distK * 1.5);
          float slG = sl.y;
          #ifdef TERRAIN_SNOWROCK
            slG = mix(sl.y, 1.0 - nr.y, mesaK);       // (a mesa's own slope: its foot is gentle, its flanks sheer)
          #endif
          float sideW = smoothstep(0.24, 0.34, slG + (nE - 0.5) * 0.08 + (mB.r - 0.5) * 0.05);   // switch near 45 degrees, where both projections stretch alike
          vec2 sxz = vec2(wp.z, wp.y), szx = vec2(-wp.x, wp.y);
          vec2 an0 = pow(abs(hn) + 0.001, vec2(6.0));
          bool useX = an0.x / (an0.x + an0.y) + (nE - 0.5) * 0.6 > 0.5;
          vec2 sp = useX ? sxz : szx;
          vec2 dsx = useX ? dFdx(sxz) : dFdx(szx), dsy = useX ? dFdy(sxz) : dFdy(szx);
          bool side = sideW + (nE - 0.5) * 0.3 + (mB.g - 0.5) * 0.15 > 0.5;
          vec2 gp = side ? sp : xz, gpr = side ? vec2(sp.x * 0.8 - sp.y * 0.6, sp.x * 0.6 + sp.y * 0.8) : xr;
          vec2 gdx = side ? dsx : dFdx(xz), gdy = side ? dsy : dFdy(xz);
          tCap(gdx, gdy);
          // a little sharper within ~15 m, where the painted blades would otherwise smear along the view
          float nSh = mix(TERRAIN_NEARSHARP, 1.0, smoothstep(5.0, 20.0, distance(cameraPosition, wp)));
          gdx *= nSh; gdy *= nSh;
          vec2 gdxr = ROT * gdx, gdyr = ROT * gdy;
          if (side) { gdxr = vec2(gdx.x * 0.8 - gdx.y * 0.6, gdx.x * 0.6 + gdx.y * 0.8); gdyr = vec2(gdy.x * 0.8 - gdy.y * 0.6, gdy.x * 0.6 + gdy.y * 0.8); }
          float sBias = side ? 1.0 : exp2(smoothstep(0.12, 0.45, 1.0 - nr.y) * 2.0 * smoothstep(8.0, 30.0, distance(cameraPosition, wp)));   // (never blurred at your feet)
          #ifdef TERRAIN_DUNES
            // (Tanaris) wind ripples lie only on the dune floor: from ~20 degrees they smooth away (the sand
            // fetched ~5 mips softer, its broad mottles kept) and by ~30 a slope is plain sand, streaked
            // down its fall line (below)
            // (and far off, where they would only alias into corduroy on the dunes and the walls)
            float rippleK = 1.0 - smoothstep(0.06, 0.13, sl.y + (nE - 0.5) * 0.04 + (mB.g - 0.5) * 0.03);
            sBias *= exp2(5.0 * (1.0 - rippleK * (1.0 - smoothstep(50.0, 140.0, distance(cameraPosition, wp)))));
          #endif
          vec3 g1 = textureGrad(tG1, gp / uScale.x, gdx / uScale.x * gB * sBias, gdy / uScale.x * gB * sBias).rgb;
          vec3 g1b = textureGrad(tG1, gpr / (uScale.x * 2.3) + 0.37, gdxr / (uScale.x * 2.3) * gB * sBias, gdyr / (uScale.x * 2.3) * gB * sBias).rgb;
          g1 = mix(g1, g1b, smoothstep(0.36, 0.64, mB.g + (nE - 0.5) * 0.4) * 0.85);
          vec3 col = g1;
          float gW = 1.0;              // how much of the plain ground is left (for the snow sparkle)
          // the second ground in big blobs of noise
          float n2 = vSplat.w + (mB.r - 0.5) * 0.28 + (nE - 0.5) * 0.1;
          if (n2 > uG2.x - 0.1 - 0.3 * uG2.y) {
            vec3 g2 = textureGrad(tG2, gpr / uScale.y, gdxr / uScale.y * gB * sBias, gdyr / uScale.y * gB * sBias).rgb;
            float w2 = smoothstep(uG2.x - 0.1, uG2.x + 0.1, n2 + clamp(tLum(g2) - tLum(g1), -0.3, 0.3) * uG2.y);
            col = mix(g1, g2, w2);
          }
          #ifdef TERRAIN_DUNES
          if (rippleK < 0.999) {
            // sand sliding down a slope: soft streaks along its fall line (across it ~0.4-1.2 m, down it several m)
            vec2 fall = normalize(hn + vec2(1e-4, 0.0));
            vec2 sc = vec2(dot(xz, vec2(-fall.y, fall.x)), dot(xz, fall) * 0.5 + wp.y);
            float stk = texture2D(tMacro, vec2(sc.x / 22.0, sc.y / 140.0) + vec2(0.17, 0.53)).b;
            float stk2 = texture2D(tDetail, vec2(sc.x / 1.3, sc.y / 7.0) + vec2(0.61, 0.23)).g;
            col *= mix(1.0, 0.9 + 0.2 * stk + (stk2 - 0.5) * 0.14, 1.0 - rippleK);
          }
          #endif
          // clearings: bare packed dirt; scorched and ashy round the fires
          if (vSplat.y > 0.005) {
            vec3 dt = texture2D(tDirt, xr / uScale.z).rgb;
            float w = smoothstep(0.3, 0.62, vSplat.y + (nE - 0.5) * 0.5 + (tLum(dt) - tLum(col)) * 0.6 + (mB.g - 0.5) * 0.3 - 0.1);
            col = mix(col, dt, w * smoothstep(0.005, 0.12, vSplat.y));
            gW *= 1.0 - 0.7 * w * smoothstep(0.005, 0.12, vSplat.y);
            float fd = min(distance(xz, uFire.xy), distance(xz, uFire.zw)) + (nE - 0.5) * 0.7;
            if (fd < 2.8) {
              // (linear colours: soot is very dark, ash a cool gray)
              col = mix(col, col * vec3(0.42, 0.42, 0.44) + vec3(0.035, 0.034, 0.034), (1.0 - smoothstep(1.5, 2.7, fd)) * 0.8);   // ash
              col = mix(col, vec3(0.022, 0.019, 0.017), (1.0 - smoothstep(0.85, 1.75, fd)) * 0.8);                                // soot
            }
          }
          #ifdef TERRAIN_PLOTS
          {
            // Westfall's cultivated plots: turned furrows, cut stubble or standing wheat, in rows that run
            // along or across the road, wander a little and are never evenly spaced (+-15%); a trodden
            // headland of packed dirt and flattened straw rings each one, and every edge wanders on its
            // own (+-0.8 m over 3-20 m, the same function the wheat cards are placed by) and is ragged
            // in the small. uPlot: centre, sin and cos of its bearing; uPlotB: half-length along the road,
            // half-depth across, kind (0 wheat, 1 stubble, 2 furrow), rows along the road (1) or not.
            // Furrows and windrows are lit by the real sun (their slope against uSun), so the lit flank
            // is the one facing it; rows finer than a few pixels (far off, or at a grazing angle) melt
            // into the plot's average tone instead of aliasing into bars.
            float pw = 0.0, pm = 0.0, pu = 0.0, pv = 0.0, pk = 0.0, pmr = 0.0; vec4 pB = vec4(0.0); vec2 pA = vec2(0.0, 1.0);
            for (int i = 0; i < ${MAX_PLOTS}; i++) {
              vec4 A = uPlot[i], Bq = uPlotB[i];
              vec2 d = xz - A.xy;
              float u = d.x * A.z + d.y * A.w, v = d.x * A.w - d.y * A.z;
              if (abs(u) > Bq.x + 1.6 || abs(v) > Bq.y + 1.6) continue;
              float sd = float(i) * 1.37;
              float m = min(Bq.x - abs(u) + plotWarp(v, sd + (u > 0.0 ? 0.0 : 3.1)), Bq.y - abs(v) + plotWarp(u, sd + (v > 0.0 ? 1.7 : 4.9)));
              float mr = m + (nE - 0.5) * 0.6 + (mB.g - 0.5) * 0.4;
              float wm = smoothstep(-0.25, 0.45, mr);
              if (wm > pm) {
                // (the crop's own edge is crisper and ragged in the small: tufts and gaps of ~0.2-0.5 m)
                float fe = mr < 3.2 ? texture2D(tMacro, xz / 9.0 + vec2(0.71, 0.37)).b : 0.5;
                pm = wm; pu = u; pv = v; pB = Bq; pk = sd; pA = A.zw; pmr = mr + (fe - 0.5) * 0.7;
              }
            }
            // (a stubble field's headland is a wider, darker trodden track, so the plot reads from the road)
            float stubK = pB.z > 0.5 && pB.z < 1.5 ? 1.0 : 0.0;
            float pe0 = mix(1.22, 2.25, stubK);
            pw = pm > 0.0 ? smoothstep(pe0, pe0 + 0.2, pmr) : 0.0;
            vec3 dt = vec3(0.5), dA = vec3(0.5);
            if (pm > 0.0) {
              dt = texture2D(tDirt, xr / uScale.z).rgb; dA = textureLod(tDirt, vec2(0.5), 12.0).rgb;
              // the headland: packed dirt half under flattened, sun-bleached straw
              float tr = smoothstep(0.38, 0.62, nE + (mB.g - 0.5) * 0.5 + (pm - 0.5) * 0.3);
              vec3 hc = mix(col * vec3(1.02, 0.94, 0.8), dt * vec3(0.92, 0.88, 0.84), tr * 0.8);
              // (round stubble: packed earth worn by the carts, two darker wheel tracks in it, loose straw at its edges)
              float hm = pmr - 1.15, wt = 1.0 - smoothstep(0.12, 0.3, abs(abs(hm) - 0.55) + (nE - 0.5) * 0.12);
              vec3 hs2 = mix(col * vec3(0.86, 0.78, 0.64), dt * vec3(0.8, 0.74, 0.68), 0.55 + 0.4 * tr) * (1.0 - 0.14 * wt * smoothstep(-0.2, 0.3, pmr));
              hc = mix(hc, hs2, stubK);
              col = mix(col, hc, pm * mix(0.9, 0.97, stubK));
              gW *= 1.0 - pm * 0.6;
            }
            if (pw > 0.0) {
              float al = pB.w, kind = pB.z;
              float a = mix(pu, pv, al), bq = mix(pv, pu, al);         // a: across the rows, bq: along them
              vec2 acr = al > 0.5 ? vec2(pA.y, -pA.x) : pA;            // the across-row direction, world xz
              a += sin(bq * 0.085 + pk * 5.0) * 0.55 + sin(bq * 0.31 + pk * 2.0) * 0.1;
              float per = kind < 0.5 ? 0.72 : kind < 1.5 ? 0.7 : 0.8;
              float q = (a + per * rowJ(a / per, pk)) / per, fq = fract(q);
              float fw = fwidth(q);
              float fade = smoothstep(0.07, 0.3, fw);                  // ~4 px a row and finer: the average tone
              float dist = distance(cameraPosition, wp);
              float rowN = textureLod(tMacro, vec2(bq / 11.0 + pk, floor(q) * 0.173 + pk * 0.31), 0.0).g;
              float cs = cos(fq * 6.2832), sn = sin(fq * 6.2832);
              float ridge = 0.5 - 0.5 * cs;                           // 0 down in a furrow, 1 on a crest
              // the sun on a slope across the rows: + on the flank that faces it, - on the other
              vec3 L = normalize(uSun);
              float sunA = dot(acr, L.xz), Ly = max(L.y, 0.2);
              vec3 dMod = clamp(dt / max(dA, vec3(0.01)), 0.75, 1.3);
              vec3 gMod = clamp(g1 / max(textureLod(tG1, vec2(0.5), 12.0).rgb, vec3(0.01)), 0.85, 1.18);
              vec3 pc, pa;
              float h1 = fract(pk * 0.618 + 0.13), h2 = fract(pk * 0.377 + 0.71);
              if (kind > 1.5) {
                // turned soil: rounded ridges (a warm lit crest, the far flank and the furrow cool and
                // shadowed), clods along them, rows that thicken and thin
                float s = 0.55 * sn * (0.8 + 0.4 * rowN);
                float lit = clamp((Ly - s * sunA) / sqrt(1.0 + s * s) / Ly - 1.0, -0.6, 0.4);
                float occ = smoothstep(0.45, 0.0, ridge);               // the furrow bottom: a soft cool shadow
                pc = mix(uPlotC[1], uPlotC[2], smoothstep(0.55, 1.0, ridge) * 0.55);
                pc = mix(pc, uPlotC[2] * vec3(1.08, 1.0, 0.86), max(lit, 0.0) * 1.6);
                pc = mix(pc, uPlotC[0], clamp(-lit * 1.2, 0.0, 0.75) + occ * 0.35);
                // clods and grit along the rows (gone by the time the rows themselves melt)
                float cl = texture2D(tDetail, vec2(dot(xz, acr), dot(xz, vec2(-acr.y, acr.x)) * 0.6) / 1.3 + vec2(0.41, 0.17)).g - 0.5;
                pc *= mix(vec3(1.0), dMod, 0.8 + 0.4 * ridge) * (1.0 + cl * 0.7 * (1.0 - smoothstep(10.0, 30.0, dist)));
                pa = mix(uPlotC[1], uPlotC[2], 0.22) * mix(vec3(1.0), dMod, 0.6);
              } else if (kind > 0.5) {
                // stubble: rows of pale cut stalks over darker soil with loose straw in it and, on most
                // plots, a raked windrow of straw every five rows (lit on its sunward side)
                // (each row a hatch of short cut stalks: a fine stroke texture laid in row space, the
                // stalks crowding on the row and thinning out into the soil between; loose straw there)
                vec3 hs = texture2D(tDetail, vec2(bq * 0.6, a * 1.6) / 0.9 + vec2(pk * 0.37, 0.19)).rgb;
                // each row breaks up along its length (1-3 m): where the cut stalks thin into gaps and where
                // they crowd into clumps (the same field stands the straw cards in plotRows)
                float brk = textureLod(tMacro, vec2(bq / 61.0 + pk * 0.13, floor(q) * 0.173 + pk * 0.31), 0.0).b;
                float dens = smoothstep(0.25, 0.62, brk + (rowN - 0.5) * 0.3 + (hs.g - 0.5) * 0.2);
                float stub = smoothstep(0.4, 0.62, hs.r * 0.9 + 0.05 + (ridge - 0.5) * 0.62 + (nE - 0.5) * 0.2) * (0.3 + 0.7 * dens);
                // warm gold straw (never a pale cream stripe) over straw-brown soil: about half the old contrast
                vec3 gold = mix(uPlotC[4], uPlotC[7], 0.55);
                vec3 soil = mix(uPlotC[3] * vec3(0.96, 0.9, 0.84), gold * 0.66, 0.42 + 0.25 * smoothstep(0.42, 0.75, nE + (mB.b - 0.5) * 0.3 + (hs.g - 0.5) * 0.6)) * dMod;
                vec3 straw = gold * gMod * (0.7 + 0.28 * hs.r + 0.14 * (dens - 0.5));
                straw = mix(straw, uPlotC[5] * vec3(0.86, 0.82, 0.72), smoothstep(0.62, 0.92, hs.b + ridge * 0.25) * 0.28);   // a few lit cut tops
                pc = mix(soil, straw, stub * 0.9);
                pa = mix(soil, straw, 0.5);
                if (h1 > 0.3) {
                  // (lumpy: the windrow swells, thins and breaks along its length; golden cut straw, a little
                  // darker than the stubble, lit along its sunward side, and its short shadow on the stubble)
                  float wl = textureLod(tMacro, vec2(bq / 9.0 + pk, floor(q / 5.0 + 0.1) * 0.29 + pk * 0.7), 0.0).b;
                  float ww = (0.055 + 0.04 * wl) * 5.0 * per;                              // its half-width, m
                  float wd = (fract(q / 5.0 + 0.1) - 0.5) * 5.0 * per;                    // m from its middle
                  float wx = wd / ww;
                  float wi = smoothstep(1.0, 0.65, abs(wx) + (nE - 0.5) * 0.6) * smoothstep(0.22, 0.5, wl + (mB.g - 0.5) * 0.5);
                  float s = -0.9 * sin(clamp(wx, -1.0, 1.0) * 1.5708) * wi;
                  float lit = clamp((Ly - s * sunA) / sqrt(1.0 + s * s) / Ly - 1.0, -0.6, 0.4);
                  vec3 wc = mix(uPlotC[4], uPlotC[7], 0.55) * 0.86 * gMod * (0.88 + 0.24 * nE);
                  wc = mix(wc, uPlotC[5] * vec3(1.0, 0.97, 0.88), max(lit, 0.0) * 1.1);
                  wc = mix(wc, uPlotC[6] * 1.1, clamp(-lit, 0.0, 0.6));
                  float sl0 = 0.32 * length(L.xz) / Ly;                                   // shadow length of a ~0.32 m windrow
                  float sh = -sign(sunA) * wd - ww;                                       // m beyond its shaded side
                  float wCast = smoothstep(-0.05, 0.08, sh) * (1.0 - smoothstep(sl0 * abs(sunA) * 0.6, sl0 * abs(sunA) + 0.05, sh)) * smoothstep(0.22, 0.5, wl + (mB.g - 0.5) * 0.5);
                  float wf = smoothstep(0.03, 0.12, fwidth(q / 5.0));
                  pc *= 1.0 - 0.35 * wCast * (1.0 - wf);
                  pc = mix(pc, wc, wi * (1.0 - wf * 0.6));
                  pa = mix(pa, mix(uPlotC[4], uPlotC[7], 0.4), 0.12);
                }
              } else {
                // standing wheat: the cards stand in the rows, so under them the ground is the crop's own
                // shade (dark straw, the rows faint); far off, where the cards shrink away, golden rows
                float rm = smoothstep(0.15, 0.6, ridge + (rowN - 0.5) * 0.3);
                vec3 under = mix(uPlotC[6], mix(uPlotC[6], uPlotC[7], 0.45), rm) * dMod;
                vec3 gold = mix(mix(uPlotC[6], uPlotC[7], 0.5), uPlotC[7], rm) * gMod;
                gold = mix(gold, uPlotC[8], smoothstep(0.7, 1.0, ridge) * 0.4);
                float farW = smoothstep(55.0, 105.0, dist);
                // (the crop's shade only where the stalks stand thick: along the thinning edge, tilled soil)
                under = mix(mix(uPlotC[3], uPlotC[1], 0.4) * dMod, under, smoothstep(1.4, 3.0, pmr));
                pc = mix(under, gold, farW);
                pa = mix(mix(uPlotC[6], uPlotC[7], 0.3), mix(uPlotC[6], uPlotC[7], 0.72), farW);
              }
              pc = mix(pc, pa, fade);
              // each plot its own tint (warmer or cooler, lighter or darker), broad patches in it, and
              // never brighter or more saturated than its palette
              pc *= mix(vec3(1.05, 1.0, 0.92), vec3(0.95, 0.99, 1.04), h1) * (0.93 + 0.12 * h2) * (0.94 + 0.12 * mB.r);
              pc *= min(1.0, 0.62 / max(tLum(pc), 1e-3));       // (a value cap: never a hot, saturated rim)
              col = mix(col, pc, pw);
              gW *= 1.0 - pw;
            }
          }
          #endif
          // the road, in road space; the ground laps over its ragged edge. A second sample of the road
          // (mirrored, a 23 m period) takes over in big patches, so the 10 m tile never repeats.
          if (vRoad.y < 2.6) {
            vec2 ru = vec2(clamp(vRoad.x, 0.004, 0.996), wp.z / uMisc.y);
            vec3 rc = texture2D(tRoad, ru).rgb;
            float r2k = smoothstep(0.4, 0.6, mB.r * 0.75 + vRoad.w * 0.5 - 0.12);
            if (r2k > 0.01) rc = mix(rc, texture2D(tRoad, vec2(1.0 - ru.x, wp.z / 23.0 + 0.37)).rgb, r2k);
            if (uRutFar.x + uRutFar.y > 0.0) {
              // (snow) far off, the painted ruts melt into the pale packed snow and the road would vanish
              // into the snowfield: there the wheel tracks darken (in bands widened to at least a pixel,
              // so they never break into dashes) and the whole track greys a little
              float fk = smoothstep(18.0, 70.0, distance(cameraPosition, wp));
              float rdm = (vRoad.x - 0.5) * uRoadSpan, fw = max(0.35, fwidth(rdm) * 1.2);
              float tr = 1.0 - smoothstep(0.0, fw, abs(abs(rdm) - 0.99) - 0.1);
              rc *= 1.0 - fk * (uRutFar.x * tr * min(1.0, 0.45 / fw) + uRutFar.y);
            }
            float edge = vRoad.y + (nE - 0.5) * 1.5 + (mB.g - 0.5) * 1.0;
            float rw = 1.0 - smoothstep(-0.35, 0.35, edge + clamp(tLum(col) - tLum(rc), -0.3, 0.3) * 1.6);
            col = mix(col, rc, rw);
            gW *= 1.0 - rw;
          }
          // mud, in road space too: its puddles lie along the ruts
          if (vSplat.x > 0.005) {
            vec3 md = texture2D(tMud, vec2((vRoad.x - 0.5) * uRoadSpan / uMisc.x + 0.5, wp.z / uMisc.x)).rgb;
            float w = smoothstep(0.32, 0.58, vSplat.x + (mB.g - 0.5) * 0.7 + (nE - 0.5) * 0.35);
            col = mix(col, md, w * smoothstep(0.005, 0.1, vSplat.x));
            gW *= 1.0 - w;
          }
          // rock, by the SMOOTHED slope (averaged per vertex over 7 x 7 cells, so the heightfield's
          // triangles never show) plus a 30 m noise; the edge dithered by 1-3 m noise into a ragged band
          float slope = 1.0 - nr.y, rockW = 0.0;
          float cB = sl.x + (vSplat.w - 0.5) * uCliffN.x + (mB.r - 0.5) * uCliffN.y + (mB.g - 0.5) * 0.12 + (nE - 0.5) * 0.16;
          // small steep forms (a crash mesa's flanks, a knoll) are lost in the wide average: the
          // 3 x 3 slope brings their rock out too (snow, badlands, desert)
          // (only where the 3 x 3 slope stands well above the wide one: a small form, not a long wall)
          float locK = smoothstep(0.08, 0.16, sl.y - sl.x);
          if (uLocal >= 0.0) cB = max(cB, mix(cB, sl.y - uLocal + (nE - 0.5) * 0.1 + (mB.g - 0.5) * 0.06, locK));
          #ifdef TERRAIN_DUNES
            // (Tanaris) the sandstone shows wherever the slope itself passes ~35 degrees (the 3 x 3 slope:
            // the wide average would keep a 9 m wall half sand, and the sand there would be rippled)
            cB = max(cB, sl.y - 0.03 + (nE - 0.5) * 0.06 + (mB.g - 0.5) * 0.05);
          #endif
          // (snow: far off the granite comes out on gentler slopes than near)
          // and the flanks of a crash mesa show their rock on gentler slopes than a valley wall
          float farA = 0.0, cShift = uMesaK * mesaK, mzk = 0.0;
          #ifdef TERRAIN_SNOWROCK
            farA = smoothstep(110.0, 300.0, distance(cameraPosition, wp));
            cShift += 0.2 * farA;
            mzk = mesaK;
          #endif
          if (cB + cShift > uCliff.x - 0.01) {
            vec2 cw = vec2(mB.g - 0.5, mB.r - 0.5) * vec2(0.3, 0.14);    // ledges wander along a wall instead of repeating
            // (strata) and the beds rise and fall along the valley by a few metres, over 30-80 m, so no
            // bed runs laser-level down a whole wall
            if (uSWarp > 0.0) cw.y += (texture2D(tMacro, wp.xz / 230.0 + vec2(0.71, 0.13)).r - 0.5) * uSWarp / uScale.w;
            float xb = smoothstep(0.3, 0.7, mB.r * 0.7 + vRoad.w * 0.6 - 0.15);
            float farK = smoothstep(28.0, 75.0, distance(cameraPosition, wp)) * (1.0 - mzk);   // far walls: the rock at 2.5x, bigger masses
            // (snow) a crash mesa's granite in smaller blocks, 1-2 m: a third sample at 1.75x, crossfaded
            // in (never a scale that varies across the face: on world coordinates hundreds of metres
            // out, that sweeps through the texture in streaks)
            const float MS = 1.75;
            // side projection: x- or z-facing, from a sharpened normal blend dithered by noise. On a
            // steep face every field sampled by x and z (the slope, the macro noise) is constant up
            // the face, so its thresholds would run in straight vertical bands: there the dither is
            // a noise laid ON the face (projected along the diagonal, so it holds on x- and z-facing
            // walls alike)
            vec3 wN = texture2D(tMacro, vec2((wp.x + wp.z) * 0.7071, wp.y) / 17.0 + vec2(0.29, 0.83)).rgb;
            float steepW = smoothstep(0.25, 0.5, sl.y);
            vec2 an = pow(abs(hn) + 0.001, vec2(8.0));
            float sx = smoothstep(0.32, 0.68, an.x / (an.x + an.y) + (mix(nE, wN.b, steepW) - 0.5) * 0.5 + (wN.g - 0.5) * 0.3 * steepW);
            #ifdef TERRAIN_SNOWROCK
              // round a crash mesa the heightfield folds into steep sliver facets (along its cut road-side
              // flank and the corners of its lobes) whose interpolated normal faces one way while the
              // facet itself faces the other: there the FACET picks the projection, never one that would
              // meet it edge-on and stretch the granite into glassy streaks
              if (mzk > 0.0) {
                float fs = smoothstep(0.3, 0.55, length(fN.xz)) * mzk;
                // (only facets the smooth choice would meet nearly edge-on switch, so few triangles do)
                float fx = abs(fN.x), fz = abs(fN.z);
                sx = mix(sx, 1.0, smoothstep(0.3, 0.15, fz) * smoothstep(0.0, 0.1, fx - fz) * fs);
                sx = mix(sx, 0.0, smoothstep(0.3, 0.15, fx) * smoothstep(0.0, 0.1, fz - fx) * fs);
              }
            #endif
            vec3 cc = vec3(0.0);
            #ifdef TERRAIN_DUNES
              // (the far sandstone a mip softer, and softer still across the valley, so its thin hard beds
              // never thin into ruled lines on the distant walls: only the broad beds' colours remain)
              float farMip = 2.0 * exp2(2.0 * smoothstep(100.0, 230.0, distance(cameraPosition, wp)));
            #endif
            vec2 sN = vec2(0.5);      // (snow) a noise on the face, stretched along it: r ~5-13 m by 1-3 m, g ~2-6 m by 0.5-1.3 m
            vec2 fm = vec2(0.5);      // (snow) the painted rock's form under cc: x which way it faces (> 0.5 up), y its height
            #ifdef TERRAIN_SNOWROCK
              sN = vec2(0.0); fm = vec2(0.0);
            #endif
            if (sx > 0.01) {
              vec2 p = vec2(wp.z, wp.y) / uScale.w + cw;
              vec2 dx = dFdx(p), dy = dFdy(p); tCapK(dx, dy, mix(TERRAIN_ANISO, 8.0, mzk));
              vec3 c1 = vec3(0.0);
              #ifdef TERRAIN_SNOWROCK
                vec2 pR = SR * p * SRS + vec2(0.37, 0.21), dxR = SR * dx * SRS, dyR = SR * dy * SRS;
                if (farK < 0.999 && mzk < 0.999) c1 = mix(textureGrad(tCliff, p, dx, dy).rgb, textureGrad(tCliff, pR, dxR, dyR).rgb, xb);
              #else
              if (farK < 0.999 && mzk < 0.999) c1 = mix(textureGrad(tCliff, p, dx, dy).rgb, textureGrad(tCliff, P2(p, 0.37, 0.21), dx * P2K, dy * P2K).rgb, xb);
              #endif
              if (farK > 0.001) c1 = mix(c1, textureGrad(tCliff, PF(p, 0.13, 0.57), dx * PFK, dy * PFK).rgb, farK);
              #ifdef TERRAIN_SNOWROCK
                // (a crash mesa: the walls' own angular granite, turned 30 degrees, so its fracture planes
                // run diagonally across the face and no row of blocks lines up)
                vec2 pM = SR * p * 1.1 + vec2(0.31, 0.11), dxM = SR * dx * 1.1, dyM = SR * dy * 1.1;
                if (mzk > 0.001) c1 = mix(c1, textureGrad(tCliff, pM, dxM, dyM).rgb, mzk);
              #else
              if (mzk > 0.001) c1 = mix(c1, textureGrad(CLIFF_M, p * MS + vec2(0.31, 0.11), dx * MS, dy * MS).rgb, mzk);
              #endif
              cc += sx * c1;
              #ifdef TERRAIN_SNOWROCK
                sN += sx * texture2D(tMacro, vec2(wp.z / 40.0, wp.y / 9.0) + vec2(0.11, 0.43)).rg;
                vec2 f1 = vec2(0.0);
                if (farK < 0.999 && mzk < 0.999) f1 = mix(textureGrad(tForm, p, dx, dy).rg, formTurn(textureGrad(tForm, pR, dxR, dyR).rgb), xb);
                if (farK > 0.001) f1 = mix(f1, textureGrad(tForm, p * 0.4 + vec2(0.13, 0.57), dx * 0.4, dy * 0.4).rg, farK);
                if (mzk > 0.001) f1 = mix(f1, formTurn(textureGrad(tForm, pM, dxM, dyM).rgb), mzk);
                fm += sx * f1;
              #endif
            }
            if (sx < 0.99) {
              vec2 p = vec2(-wp.x, wp.y) / uScale.w + vec2(0.5, 0.0) + cw;
              vec2 dx = dFdx(p), dy = dFdy(p); tCapK(dx, dy, mix(TERRAIN_ANISO, 8.0, mzk));
              vec3 c2 = vec3(0.0);
              #ifdef TERRAIN_SNOWROCK
                vec2 pR = SR * p * SRS + vec2(0.61, 0.47), dxR = SR * dx * SRS, dyR = SR * dy * SRS;
                if (farK < 0.999 && mzk < 0.999) c2 = mix(textureGrad(tCliff, p, dx, dy).rgb, textureGrad(tCliff, pR, dxR, dyR).rgb, xb);
              #else
              if (farK < 0.999 && mzk < 0.999) c2 = mix(textureGrad(tCliff, p, dx, dy).rgb, textureGrad(tCliff, P2(p, 0.61, 0.47), dx * P2K, dy * P2K).rgb, xb);
              #endif
              if (farK > 0.001) c2 = mix(c2, textureGrad(tCliff, PF(p, 0.71, 0.29), dx * PFK, dy * PFK).rgb, farK);
              #ifdef TERRAIN_SNOWROCK
                vec2 pM = SRM * p * 1.1 + vec2(0.83, 0.39), dxM = SRM * dx * 1.1, dyM = SRM * dy * 1.1;
                if (mzk > 0.001) c2 = mix(c2, textureGrad(tCliff, pM, dxM, dyM).rgb, mzk);
              #else
              if (mzk > 0.001) c2 = mix(c2, textureGrad(CLIFF_M, p * MS + vec2(0.83, 0.39), dx * MS, dy * MS).rgb, mzk);
              #endif
              cc += (1.0 - sx) * c2;
              #ifdef TERRAIN_SNOWROCK
                sN += (1.0 - sx) * texture2D(tMacro, vec2(-wp.x / 40.0, wp.y / 9.0) + vec2(0.61, 0.17)).rg;
                vec2 f2 = vec2(0.0);
                if (farK < 0.999 && mzk < 0.999) f2 = mix(textureGrad(tForm, p, dx, dy).rg, formTurn(textureGrad(tForm, pR, dxR, dyR).rgb), xb);
                if (farK > 0.001) f2 = mix(f2, textureGrad(tForm, p * 0.4 + vec2(0.71, 0.29), dx * 0.4, dy * 0.4).rg, farK);
                if (mzk > 0.001) f2 = mix(f2, formTurnM(textureGrad(tForm, pM, dxM, dyM).rgb), mzk);
                fm += (1.0 - sx) * f2;
              #endif
            }
            #ifdef TERRAIN_STRATA
              // under strata, moderate slopes are loose scree, so bands only ever show on truly steep faces.
              // Where a wall turns over its lip (convex) the vertex's own slope decides, bilinear, so the
              // lip shows the dust on top, never side-projected strata smeared across it (the smoothed
              // slope spreads a wall over two cells past its lip, and the face's own normal would cut
              // the edge into triangle teeth). At a foot (concave) the scree keeps to the smoothed
              // slope, as the grid zigzags there and the raw one would cut teeth into it.
              float rawS = mix(textureLod(tSlopeR, (gqc + 0.5) / uGridN, 0.0).r, sl.y, smoothstep(0.0, 12.0, dOut));
              float topR = 1.0 - smoothstep(uScree.z, uScree.w, max(rawS, sl.y - 0.16) + (wN.r - 0.5) * 0.1 + (nE - 0.5) * 0.06);
              float topK = mix(1.0 - smoothstep(uScree.x, uScree.y, max(slope, sl.y)), topR, smoothstep(-0.05, 0.2, vCv));
              #ifdef TERRAIN_DUNES
                topK *= 1.0 - mesaK;          // (a crash mesa sets its sand by height, below)
              #endif
              cc = mix(cc, col * vec3(0.94, 0.9, 0.88), topK);
            #else
              // ledges and shelves inside the rock hold what the ground holds (grass, golden grass,
              // snow), so the foot and the lip of a wall turn into soft drifts, never a row of teeth
              // (the face noise wanders the edge up and down the face by more than the heightfield's
              // zigzag at a lip, so the edge never lines up with the triangles there)
              // (the snow lays its own shelves, below)
              #ifndef TERRAIN_SNOWROCK
              float ledge = 1.0 - smoothstep(0.12, 0.26, sl.y + (nE - 0.5) * 0.16 + (mB.g - 0.5) * 0.1 + (vSplat.w - 0.5) * 0.08 + ((wN.r - 0.5) * 0.22 + (wN.g - 0.5) * 0.1) * steepW);
              cc = mix(cc, col * uLedge, ledge);
              #endif
            #endif
            float wk = smoothstep(uCliff.x, uCliff.y, cB + cShift), snowOn = 0.0;
            #ifdef TERRAIN_SNOWROCK
            {
              // Dun Morogh: blue-gray granite on every face steeper than ~45 degrees, at its full painted
              // value (lit cream tops, cool undersides, dark soft creases), with snow lying on whatever
              // the PAINTED rock turns up to the sky (tForm), gathered into long lumpy shelves by a noise
              // on the face. Gentle granite holds a lot of snow, a sheer face only its ledges. One field
              // S decides snow (> 0.5) or rock, so every edge (the zone's too) follows the painted forms;
              // the snow goes blue toward its edges and the rock darkens right under it.
              float cq = cB + cShift - uMesaK * mesaK;           // (a mesa is handled on its own, below)
              float wZ = texture2D(tMacro, vec2((wp.x + wp.z) * 0.7071, wp.y) / 70.0 + vec2(0.63, 0.11)).r;
              float zq = cq + (wZ - 0.5) * 0.12 + (wN.r - 0.5) * 0.06 + (mB.r - 0.5) * 0.04;
              float zone = smoothstep(uCliff.x + 0.01, uCliff.y, zq);
              float steepK = smoothstep(uCliff.y, uCliff.y + 0.28, zq);
              float shelf = (sN.x - 0.5) * 0.55 + (sN.y - 0.5) * 0.3;
              float keep = mix(0.74, 0.4, steepK) - farA * 0.1;
              // snow on what the painted granite turns up to the sky and in its hollows: the rock that
              // shows is the bosses that stand out, lit face and shaded face both (never only the dark
              // undersides, which would read as flat dark patches in the snow)
              float form = (fm.x - 0.55) * 1.9 - (fm.y - 0.5) * mix(0.85, 0.45, steepK);
              float rockS = keep + form + shelf;
              // a crash mesa: granite all round its flanks, from a lumpy drift at its foot to a snow cap
              // hanging over the lip, snow on anything that lies flat (its top, the bench); the edges
              // are set by HEIGHT (and a noise on the face), so they never follow the triangles
              // and two or three snow-capped ledges across a wall at world heights (every ~4.6 m, wandering
              // a couple of metres along the valley), each a lumpy band of snow hugging what the painted
              // rock turns up, coming and going along its length, the rock right under it in shadow
              float lh = wp.y + (texture2D(tMacro, wp.xz / 180.0 + vec2(0.23, 0.61)).g - 0.5) * 5.0 + (wN.g - 0.5) * 0.9;
              float lq = lh / 4.6, lz = fract(lq) * 4.6;
              float lpres = smoothstep(0.42, 0.6, textureLod(tMacro, vec2((wp.x + wp.z) / 52.0, floor(lq) * 0.37 + 0.11), 0.0).r) * zone * (1.0 - mzk);
              float lt = 0.35 + 0.45 * sN.y;
              float ledgeS = (1.0 - smoothstep(lt - 0.15, lt + 0.05, lz)) * lpres;
              float lpres2 = smoothstep(0.42, 0.6, textureLod(tMacro, vec2((wp.x + wp.z) / 52.0, (floor(lq) + 1.0) * 0.37 + 0.11), 0.0).r) * zone * (1.0 - mzk);
              float ledgeU = smoothstep(3.85, 4.55, lz) * (1.0 - smoothstep(4.55, 4.6, lz)) * lpres2;
              rockS = max(rockS, ledgeS * 0.85 + form * 0.5);
              float S = mix(1.25, rockS, zone);
              if (mzk > 0.0) {
                float hb = wp.y - mY.x, ht = mY.y - wp.y;
                float sk = 0.75 + (wN.g - 0.5) * 1.5 + (sN.y - 0.5) * 0.7;          // the drift's lumpy top, ~0.2-1.4 m up
                float cp = 0.5 + (wN.b - 0.5) * 1.1 + (sN.x - 0.5) * 0.4;           // how far the cap hangs down
                // (nothing here reads the face's own slope: the interpolated normal changes triangle
                // by triangle, and any edge drawn from it comes out as a row of white teeth)
                float mS = 0.44 + form + shelf * 0.6;
                mS = max(mS, 1.25 * (1.0 - smoothstep(sk - 0.12, sk + 0.12, hb)));
                mS = max(mS, 1.25 * (1.0 - smoothstep(cp - 0.1, cp + 0.1, ht)));
                // the bench: a snow band at its level on its side of the mesa
                vec2 rd = normalize(wp.xz - mC + 1e-4);
                float bS = smoothstep(0.45, 0.8, dot(rd, vec2(cos(mY.w), sin(mY.w))));
                float bh = wp.y - mY.z + (wN.g - 0.5) * 0.5;
                mS = max(mS, 1.25 * bS * (1.0 - smoothstep(0.15, 0.4, abs(bh + 0.1))));
                S = mix(S, mS, mzk);
              }
              float aa = clamp(fwidth(S) * 0.9, 0.025, 0.12);
              float sn = smoothstep(0.5 - aa, 0.5 + aa, S);
              // the granite: never darker than its own palette, a touch of cold light off the snow
              cc += max(vec3(0.0), vec3(0.11, 0.125, 0.165) - cc) * 0.6;
              cc *= vec3(1.06, 1.07, 1.1);
              // (far off, the rock fades toward the snow's value so the mountains stay snowy)
              cc = mix(cc, col * vec3(0.8, 0.85, 0.93), farA * 0.25);
              // the rock right under the snow lies in its shadow (and under a ledge, deeper)
              float under = max(smoothstep(0.18, 0.5, S), ledgeU) * (1.0 - sn);
              cc *= mix(vec3(1.0), vec3(0.7, 0.75, 0.88), under * 0.5);
              // the snow on the rock: blue toward its edge (a soft shadow falloff), its lit body the ground's own
              vec3 snc = col * mix(vec3(0.76, 0.83, 0.97), vec3(1.0), smoothstep(0.5, 0.82, S));
              cc = mix(cc, snc, sn);
              snowOn = sn;
              wk = smoothstep(uCliff.x - 0.01, uCliff.x + 0.04, cB + cShift);      // (the zone's start is all snow anyway)
            }
            #else
            // the lit, protruding parts of the rock break through first (a soft height blend)
            // (on a steep face the edge also wanders by the noise laid on the face, so it never runs
            // straight up a knoll or a mesa)
            wk = smoothstep(uRev.x, uRev.y, wk + (min(tLum(cc), 0.7) - 0.4) * 0.5 * (1.0 - wk) + (nE - 0.5) * 0.1 + ((wN.r - 0.5) * 0.3 + (wN.b - 0.5) * 0.15) * steepW * (1.0 - wk * wk));
            #endif
            #ifdef TERRAIN_DUNES
              // dune crests stay sand (but not a wall's steep convex shoulder: the sandstone runs up to
              // where its lip lies back under ~30 degrees, so a wall is rock under a sand cap, never one
              // thin band of rock between sand above and sand below)
              wk *= 1.0 - smoothstep(-0.05, 0.35, vCv) * (1.0 - mesaK) * (1.0 - smoothstep(0.19, 0.33, sl.y));
              if (mesaK > 0.0) {
                // a crash mesa is a sandstone butte: rock all round its flanks under a cap of drifted sand
                // hanging over its lip, above a drift at its foot, with sand lying on its bench and a lit
                // ledge (a hard bed) at the bench's level all the way round, a cool shadow under it.
                // Every edge is set by HEIGHT (and a noise on the face), never by the triangles.
                float hb = wp.y - mY.x, ht = mY.y - wp.y;
                float cp = 0.6 + (wN.b - 0.5) * 1.1 + (nE - 0.5) * 0.3;
                float sk = 0.9 + (wN.g - 0.5) * 1.4 + (nE - 0.5) * 0.3;
                float mR = smoothstep(cp - 0.12, cp + 0.12, ht) * smoothstep(sk - 0.15, sk + 0.15, hb);
                float bh = wp.y - mY.z + (wN.r - 0.5) * 0.45;
                vec2 rd = normalize(wp.xz - mC + 1e-4);
                float bS = smoothstep(0.4, 0.8, dot(rd, vec2(cos(mY.w), sin(mY.w))));
                mR *= 1.0 - bS * (1.0 - smoothstep(0.18, 0.42, abs(bh + 0.05)));
                mR *= smoothstep(0.06, 0.14, slope);                                  // (anything lying flat holds sand)
                float lip = smoothstep(-0.06, 0.04, bh) * (1.0 - smoothstep(0.22, 0.34, bh)), und = smoothstep(-0.85, -0.5, bh) * (1.0 - smoothstep(-0.12, 0.0, bh));
                cc = mix(cc, cc * vec3(0.66, 0.62, 0.7), und * 0.7 * mesaK);
                cc = mix(cc, mix(cc, vec3(0.86, 0.7, 0.48), 0.6), lip * 0.8 * mesaK);
                // the caprock: a thick pale hard bed right under the sand cap, lit along its top, and the
                // soft rock under it scooped back into a cool shadow (so the top reads as a cap that overhangs)
                float cq = ht - cp + (wN.g - 0.5) * 0.3;
                float capB = smoothstep(0.05, 0.15, cq) * (1.0 - smoothstep(0.95, 1.15, cq)), capU = smoothstep(1.05, 1.2, cq) * (1.0 - smoothstep(1.6, 2.1, cq));
                cc = mix(cc, vec3(0.8, 0.64, 0.42) * (0.82 + 0.4 * tLum(cc)) * mix(1.12, 0.92, smoothstep(0.1, 0.6, cq)), capB * 0.8 * mesaK);
                cc = mix(cc, cc * vec3(0.58, 0.54, 0.62), capU * 0.75 * mesaK);
                wk = mix(wk, mR, mesaK);
              }
            #endif
            // a thin collar of scree and dirt where the rock comes out of the ground
            float collar = clamp(wk * (1.0 - wk) * 4.0, 0.0, 1.0) * smoothstep(0.15, 0.55, nE + mB.g * 0.4);
            #ifndef TERRAIN_SNOWROCK
            col = mix(col, uCollar * (0.65 + tLum(cc) * 1.1), collar * uRev.z);
            #endif
            col = mix(col, cc, wk);
            rockW = wk * (1.0 - snowOn);
            gW *= 1.0 - rockW;
          }
          // near-field detail at the camera's feet: blades on the grass, grit and pebbles on dirt and
          // road, fine ripples and crust on sand and snow (a 1.8 m tile, gone by 25 m)
          {
            float nearK = (1.0 - smoothstep(14.0, 25.0, distance(cameraPosition, wp))) * smoothstep(0.55, 0.85, nr.y) * (1.0 - rockW);
            if (nearK > 0.001) {
              vec3 dt = texture2D(tDetail, (ROT * xz) / 1.8 + vec2(0.17, 0.61)).rgb - 0.5;
              // and within 15 m a second fetch at 0.9 m, turned 37 degrees, so the strokes cross
              float n2K = 1.0 - smoothstep(8.0, 15.0, distance(cameraPosition, wp));
              if (n2K > 0.001) dt = mix(dt, (dt + texture2D(tDetail, xz / 0.9 + vec2(0.53, 0.29)).rgb - 0.5) * 0.72, n2K);
              float d = dt.r * uDetail.x * gW + dt.g * uDetail.y + dt.b * uDetail.z * gW;
              col *= 1.0 + 2.0 * d * nearK;
            }
          }
          // (desert) up close the sandstone takes a fine grain too, laid on the face itself (its 16 m tile
          // is soft when it fills the screen)
          if (uRockDet > 0.0 && rockW > 0.01) {
            float nk = (1.0 - smoothstep(10.0, 22.0, distance(cameraPosition, wp))) * rockW;
            if (nk > 0.001) {
              vec2 dp = useX ? vec2(wp.z, wp.y) : vec2(-wp.x, wp.y);
              float gr = texture2D(tDetail, dp / 1.4 + vec2(0.31, 0.07)).g - 0.5;
              col *= 1.0 + 2.0 * gr * uRockDet * nk;
            }
          }
          // broad (40-80 m) warm and cool regions and value drift, then finer drift
          col *= mix(uTintA, uTintB, smoothstep(0.1, 0.9, vRoad.z * 1.3 + mB.r * 0.45 - 0.37));
          col *= 1.0 + (vRoad.w - 0.5) * uMisc.z + (mB.g - 0.5) * uMisc.w;
          // baked occlusion, cool in the crevices
          col *= mix(uAO, vec3(1.0), vSplat.z);
          diffuseColor.rgb *= col;
          #ifdef TERRAIN_SPARKLE
          {
            // glints in the snow: a sparse lattice of tiny facets that catch the light as the view moves
            vec3 q = vTPos * 3.0;
            vec3 ce = floor(q);
            float h1 = tHash(ce + 17.0);
            vec3 vd = normalize(cameraPosition - vTPos);
            float tw = fract(h1 * 23.0 + dot(vd, vec3(6.3, 3.7, 5.1)) * (1.5 + h1));
            vec2 fp = fract(q.xz) - 0.5 - (vec2(tHash(ce + 3.1), tHash(ce + 7.3)) - 0.5) * 0.6;
            float dist = distance(cameraPosition, vTPos);
            tSpark = step(0.86, h1) * smoothstep(0.82, 0.97, tw) * (1.0 - smoothstep(0.035, 0.07, length(fp)))
              * gW * (1.0 - smoothstep(14.0, 30.0, dist)) * smoothstep(0.6, 0.85, nr.y) * (0.5 + 0.5 * vSplat.z);
          }
          #endif
        }`)
      .replace('#include <opaque_fragment>', `
        #ifdef TERRAIN_SPARKLE
        {
          // only where the sun (or the moon) reaches: compare the direct light with the albedo
          float dl = dot(reflectedLight.directDiffuse, vec3(0.3, 0.55, 0.15)) / max(1e-3, dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15)));
          outgoingLight += vec3(1.0, 0.97, 0.9) * tSpark * uSpark * smoothstep(0.2, 0.42, dl);
        }
        #endif
        #include <opaque_fragment>`);
  };
  splatCache.set(biome, m);
  return m;
}

// ---- per-vertex data for the playable grid ---------------------------------------------------

// Low-frequency noise, per vertex: [warm/cool tint (~60 m), value drift (~45 m), second-ground mask (~30 m)], each 0..1.
const n01 = v => Math.max(0, Math.min(1, 0.5 + v * 0.85));
function lowNoise(W, x, z) {
  return [n01(fbm(x / 62, z / 62, W.seed + 401, 2)), n01(fbm(x / 45, z / 45, W.seed + 402, 2)), n01(fbm(x / 30, z / 30, W.seed + 403, 3))];
}

const AO_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const AO_STEPS = [1, 2, 4, 7, 12];
// Baked occlusion at grid vertex (ix, iz): 1 - (mean sine of the horizon angle over 8 directions),
// nudged by convexity (ridges catch a little extra light, hollows lose some). -> [ao, convexity]
function aoVertex(W, ix, iz) {
  const { nx, nz, cell, heights } = W, NZ1 = nz + 1;
  const Hc = (i, j) => heights[(i < 0 ? 0 : i > nx ? nx : i) * NZ1 + (j < 0 ? 0 : j > nz ? nz : j)];
  const h0 = Hc(ix, iz);
  let occ = 0;
  for (const [ax, az] of AO_DIRS) {
    const dl = Math.hypot(ax, az) * cell;
    let best = 0;
    for (const s of AO_STEPS) {
      const t = (Hc(ix + ax * s, iz + az * s) - h0) / (dl * s);
      if (t > best) best = t;
    }
    occ += best / Math.sqrt(1 + best * best);          // sin of the horizon angle
  }
  occ /= AO_DIRS.length;
  const cv = h0 - (Hc(ix + 2, iz) + Hc(ix - 2, iz) + Hc(ix, iz + 2) + Hc(ix, iz - 2)) / 4;
  return [Math.max(0.3, Math.min(1.08, 1 - occ * 0.95 + Math.max(-0.12, Math.min(0.08, cv * 0.06)))), cv];
}

function vertexData(W, cfg, clearings) {
  const { nx, nz, cell, X0, Z0, heights } = W;
  const NZ1 = nz + 1, NV = (nx + 1) * NZ1;
  const Hc = (ix, iz) => heights[(ix < 0 ? 0 : ix > nx ? nx : ix) * NZ1 + (iz < 0 ? 0 : iz > nz ? nz : iz)];
  const nrm = new Float32Array(NV * 3), road = new Float32Array(NV * 4), spl = new Float32Array(NV * 4), cvA = new Float32Array(NV), slp = new Float32Array(NV * 2);
  // the slope, smoothed: |grad h| per vertex, then tent-averaged over 7 x 7 (rock) and 3 x 3 (ground projection)
  const G = new Float32Array(NV);
  for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
    const dx = (Hc(ix + 1, iz) - Hc(ix - 1, iz)) / ((Math.min(ix + 1, nx) - Math.max(ix - 1, 0)) * cell);
    const dz = (Hc(ix, iz + 1) - Hc(ix, iz - 1)) / ((Math.min(iz + 1, nz) - Math.max(iz - 1, 0)) * cell);
    G[ix * NZ1 + iz] = Math.hypot(dx, dz);
  }
  const toS = g => 1 - 1 / Math.sqrt(1 + g * g);
  for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
    let a5 = 0, n5 = 0, a3 = 0, n3 = 0;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const x = ix + i, z = iz + j;
      if (x < 0 || z < 0 || x > nx || z > nz) continue;
      const g = G[x * NZ1 + z], w = (4 - Math.abs(i)) * (4 - Math.abs(j));
      a5 += g * w; n5 += w;
      if (Math.abs(i) < 2 && Math.abs(j) < 2) { const w3 = (2 - Math.abs(i)) * (2 - Math.abs(j)); a3 += g * w3; n3 += w3; }
    }
    const v = ix * NZ1 + iz;
    slp[v * 2] = toS(a5 / n5); slp[v * 2 + 1] = toS(a3 / n3);
  }
  for (let ix = 0; ix <= nx; ix++) {
    const x = X0 + ix * cell;
    for (let iz = 0; iz <= nz; iz++) {
      const v = ix * NZ1 + iz, z = Z0 + iz * cell;
      // smooth normal from central differences
      const dx = (Hc(ix + 1, iz) - Hc(ix - 1, iz)) / ((Math.min(ix + 1, nx) - Math.max(ix - 1, 0)) * cell);
      const dz = (Hc(ix, iz + 1) - Hc(ix, iz - 1)) / ((Math.min(iz + 1, nz) - Math.max(iz - 1, 0)) * cell);
      const l = Math.hypot(dx, 1, dz);
      nrm[v * 3] = -dx / l; nrm[v * 3 + 1] = 1 / l; nrm[v * 3 + 2] = -dz / l;
      // road space
      const hwz = roadHW(W, cfg, z), d = x - W.roadX(z);
      road[v * 4] = d / (2 * (hwz + SHOULDER)) + 0.5;
      road[v * 4 + 1] = Math.abs(d) - hwz;
      const [nt, nv, n2] = lowNoise(W, x, z);
      road[v * 4 + 2] = nt; road[v * 4 + 3] = nv;
      // mud: on the road and its shoulders only (the mud texture is in road space, 10 m across, and
      // its puddles would come round again every 10 m out on the slopes); the ground either side
      // of a mud stretch is churned into bare dirt instead, thinning out by 26 m
      let mud = 0, churn = 0;
      for (const m of W.mud) {
        const wz = sstep(m.z0 - 4, m.z0 + 5, z) * (1 - sstep(m.z1 - 5, m.z1 + 4, z));
        if (wz > 0 && Math.abs(d) < m.hw) {
          mud = Math.max(mud, wz * (1 - sstep(hwz + 0.4, hwz + 1.9, Math.abs(d))));
          churn = Math.max(churn, wz * 0.55 * (1 - sstep(9, 26, Math.abs(d))));
        }
      }
      // clearings
      let clr = churn;
      for (const c of clearings) {
        const dd = Math.hypot(x - c.x, z - c.z);
        if (dd < c.r1) clr = Math.max(clr, (1 - sstep(c.r0, c.r1, dd)) * c.k);
      }
      // ambient occlusion (how much of the sky the surrounding terrain hides) and convexity
      const [ao, cv] = aoVertex(W, ix, iz);
      cvA[v] = Math.max(-1, Math.min(1, cv * 0.5));
      spl[v * 4] = mud; spl[v * 4 + 1] = clr; spl[v * 4 + 2] = ao; spl[v * 4 + 3] = n2;
    }
  }
  // the same smoothed slopes as a texture over the grid (x along the width, z along the height)
  // B, A: the direction the slope faces, averaged over 5 x 5 (weighted by steepness), so the side
  // projection of the rock is chosen from a smooth field, not flipped triangle by triangle
  const tx = new Uint8Array((nx + 1) * NZ1 * 4);
  for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
    let ax = 0, az = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const x = ix + i, z = iz + j;
      if (x < 0 || z < 0 || x > nx || z > nz) continue;
      const w = (3 - Math.abs(i)) * (3 - Math.abs(j)), q = (x * NZ1 + z) * 3;
      ax += nrm[q] * w; az += nrm[q + 2] * w;
    }
    const l = Math.hypot(ax, az) || 1;
    const v = ix * NZ1 + iz, o = (iz * (nx + 1) + ix) * 4;
    tx[o] = Math.round(Math.min(1, slp[v * 2]) * 255); tx[o + 1] = Math.round(Math.min(1, slp[v * 2 + 1]) * 255);
    tx[o + 2] = Math.round((0.5 + 0.5 * ax / l) * 255); tx[o + 3] = Math.round((0.5 + 0.5 * az / l) * 255);
  }
  // and the slope at each vertex itself (central differences, unsmoothed), bilinear: where a wall
  // turns over its lip it falls to the plateau's within a cell, so the strata stop at the lip
  const rx = new Uint8Array((nx + 1) * NZ1 * 4);
  for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
    const o = (iz * (nx + 1) + ix) * 4, v = Math.round(Math.min(1, toS(G[ix * NZ1 + iz])) * 255);
    rx[o] = rx[o + 1] = rx[o + 2] = v; rx[o + 3] = 255;
  }
  const rawTex = new THREE.DataTexture(rx, nx + 1, NZ1, THREE.RGBAFormat);
  rawTex.colorSpace = THREE.NoColorSpace;
  rawTex.magFilter = rawTex.minFilter = THREE.LinearFilter;
  rawTex.generateMipmaps = false;
  rawTex.wrapS = rawTex.wrapT = THREE.ClampToEdgeWrapping;
  rawTex.needsUpdate = true;
  const slopeTex = new THREE.DataTexture(tx, nx + 1, NZ1, THREE.RGBAFormat);
  slopeTex.colorSpace = THREE.NoColorSpace;
  slopeTex.magFilter = slopeTex.minFilter = THREE.LinearFilter;
  slopeTex.generateMipmaps = false;
  slopeTex.wrapS = slopeTex.wrapT = THREE.ClampToEdgeWrapping;
  slopeTex.needsUpdate = true;
  return { nrm, road, spl, cvA, slp, slopeTex, rawTex };
}

// The playable grid in chunks of CHUNK x CHUNK cells, vertex for vertex the physics heightfield, split
// along Rapier's diagonal. Round each crash mesa (R: terrain_mesa.js) the cells are drawn S x S finer,
// with smooth normals and heights kept within 0.35 m of the physics; a coarse cell bordering a fine one
// splits whichever of its two triangles owns the shared edge into a fan round its centroid (which lies
// in the triangle's own plane), so every fine vertex on that edge is a vertex of the coarse side too.
function buildChunks(W, data, mat, group, R = null) {
  const { nx, nz, cell, X0, Z0, heights } = W;
  const NZ1 = nz + 1, S = R ? R.S : 1;
  const ref = (ix, iz) => !!R && R.refined(ix, iz);
  for (let cx = 0; cx < nx; cx += CHUNK) {
    for (let cz = 0; cz < nz; cz += CHUNK) {
      const ex = Math.min(nx, cx + CHUNK), ez = Math.min(nz, cz + CHUNK);
      const pos = [], nor = [], rd = [], sp = [], cv = [], sl = [], idx = [];
      const coarse = new Map(), fine = new Map();
      const push = (x, y, z, n, r4, s4, c, s2) => {
        pos.push(x, y, z); nor.push(n[0], n[1], n[2]);
        rd.push(r4[0], r4[1], r4[2], r4[3]); sp.push(s4[0], s4[1], s4[2], s4[3]); cv.push(c); sl.push(s2[0], s2[1]);
        return pos.length / 3 - 1;
      };
      const vC = (ix, iz) => {
        const gv = ix * NZ1 + iz;
        let id = coarse.get(gv);
        if (id === undefined) {
          id = push(X0 + ix * cell, heights[gv], Z0 + iz * cell, data.nrm.subarray(gv * 3, gv * 3 + 3), data.road.subarray(gv * 4, gv * 4 + 4), data.spl.subarray(gv * 4, gv * 4 + 4), data.cvA[gv], data.slp.subarray(gv * 2, gv * 2 + 2));
          coarse.set(gv, id);
        }
        return id;
      };
      // a fine vertex: its splat data bilinear from the coarse vertices round it, its normal eased from
      // theirs to the smooth surface's
      const vF = (gi, gj) => {
        const key = gi * (NZ1 * S + 1) + gj;
        let id = fine.get(key);
        if (id !== undefined) return id;
        const fx = gi / S, fz = gj / S, x = X0 + fx * cell, z = Z0 + fz * cell;
        const i0 = Math.min(nx - 1, Math.floor(fx)), j0 = Math.min(nz - 1, Math.floor(fz)), u = fx - i0, v = fz - j0;
        const g = [(i0) * NZ1 + j0, (i0 + 1) * NZ1 + j0, i0 * NZ1 + j0 + 1, (i0 + 1) * NZ1 + j0 + 1], wq = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
        const lerpA = (A, k) => { const out = new Array(k).fill(0); for (let q = 0; q < 4; q++) for (let c = 0; c < k; c++) out[c] += A[g[q] * k + c] * wq[q]; return out; };
        const corner = gi % S === 0 && gj % S === 0;
        const y = corner ? heights[(gi / S) * NZ1 + gj / S] : R.height(x, z);
        const nC = lerpA(data.nrm, 3), w = R.weight(x, z), [gx, gz] = R.gradient(x, z), gl = Math.hypot(gx, 1, gz);
        let n = [nC[0] + (-gx / gl - nC[0]) * w, nC[1] + (1 / gl - nC[1]) * w, nC[2] + (-gz / gl - nC[2]) * w];
        const nl = Math.hypot(n[0], n[1], n[2]) || 1; n = n.map(c => c / nl);
        id = push(x, y, z, n, lerpA(data.road, 4), lerpA(data.spl, 4), lerpA(data.cvA, 1)[0], lerpA(data.slp, 2));
        fine.set(key, id);
        return id;
      };
      // a triangle (wound a, b, c) whose edges may carry fine vertices: fanned round its centroid
      const fan = (ring) => {
        const C = ring.filter(r => r.corner).map(r => r.id);
        const avg = (A, k) => { const out = new Array(k).fill(0); for (const id of C) for (let c = 0; c < k; c++) out[c] += A[id * k + c] / C.length; return out; };
        const P = avg(pos, 3), nn = avg(nor, 3), nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        const c = push(P[0], P[1], P[2], nn.map(q => q / nl), avg(rd, 4), avg(sp, 4), avg(cv, 1)[0], avg(sl, 2));
        for (let k = 0; k < ring.length; k++) idx.push(c, ring[k].id, ring[(k + 1) % ring.length].id);
      };
      // the fine vertices strictly inside a coarse edge, from (gi0, gj0) towards (gi1, gj1)
      const edgeF = (gi0, gj0, gi1, gj1) => { const out = [], di = Math.sign(gi1 - gi0), dj = Math.sign(gj1 - gj0); for (let k = 1; k < S; k++) out.push({ id: vF(gi0 + di * k, gj0 + dj * k) }); return out; };
      for (let ix = cx; ix < ex; ix++) for (let iz = cz; iz < ez; iz++) {
        if (ref(ix, iz)) {
          for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
            const gi = ix * S + a, gj = iz * S + b;
            const q00 = vF(gi, gj), q01 = vF(gi, gj + 1), q10 = vF(gi + 1, gj), q11 = vF(gi + 1, gj + 1);
            idx.push(q00, q01, q10, q10, q01, q11);
          }
          continue;
        }
        const p00 = vC(ix, iz), p01 = vC(ix, iz + 1), p10 = vC(ix + 1, iz), p11 = vC(ix + 1, iz + 1);
        const L = ref(ix - 1, iz), Rt = ref(ix + 1, iz), Bt = ref(ix, iz - 1), Tp = ref(ix, iz + 1);
        const gi = ix * S, gj = iz * S;
        // T1 = (p00, p01, p10) owns the left (x = ix) and bottom (z = iz) edges
        if (!L && !Bt) idx.push(p00, p01, p10);
        else fan([{ id: p00, corner: true }, ...(L ? edgeF(gi, gj, gi, gj + S) : []), { id: p01, corner: true }, { id: p10, corner: true }, ...(Bt ? edgeF(gi + S, gj, gi, gj) : [])]);
        // T2 = (p10, p01, p11) owns the top (z = iz + 1) and right (x = ix + 1) edges
        if (!Rt && !Tp) idx.push(p10, p01, p11);
        else fan([{ id: p10, corner: true }, { id: p01, corner: true }, ...(Tp ? edgeF(gi, gj + S, gi + S, gj + S) : []), { id: p11, corner: true }, ...(Rt ? edgeF(gi + S, gj + S, gi + S, gj) : [])]);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(rd, 4));
      geo.setAttribute('aSplat', new THREE.Float32BufferAttribute(sp, 4));
      geo.setAttribute('aCv', new THREE.Float32BufferAttribute(cv, 1));
      geo.setAttribute('aSlope', new THREE.Float32BufferAttribute(sl, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.castShadow = true;
      group.add(m);
    }
  }
}

// ---- the apron: unreachable land past the edges, so the world never ends in a cliff ----------

function buildApron(W, cfg, data, mat, group) {
  const { nx, nz, cell, X0, Z0, heights } = W;
  const X1 = X0 + nx * cell, Zend = Z0 + nz * cell, NZ1 = nz + 1;
  const TR = cfg.terrace;
  // (terraced land: the slope texture on a 5 m lattice, the mesh on a 2.5 m one for the first
  // 80 m past the grid's edge (where the risers are seen up close) and 5 m beyond; elsewhere 10 m)
  const OUT = 340, STEP = TR ? 5 : 10, FINE = TR ? 2.5 : STEP, IN = TR ? 80 : 0;
  // one axis of the lattice: coarse far out, fine near the grid, fine across the grid (only the
  // bands past its ends use those), fine again past its far edge, coarse beyond; it always hits
  // the grid's edges exactly (they are the grid's own rim vertices)
  const axis = (a0, a1) => {
    const out = [];
    for (let k = 0; k < Math.round((OUT - IN) / STEP); k++) out.push(a0 - OUT + k * STEP);
    for (let k = 0; k < Math.round(IN / FINE); k++) out.push(a0 - IN + k * FINE);
    for (let k = 0; a0 + k * FINE < a1 - 0.01; k++) out.push(a0 + k * FINE);
    for (let k = 0; k <= Math.round(IN / FINE); k++) out.push(a1 + k * FINE);
    for (let k = 1; k <= Math.round((OUT - IN) / STEP); k++) out.push(a1 + IN + k * STEP);
    return out;
  };
  const xs = axis(X0, X1), zs = axis(Z0, Zend);
  const rx0 = W.roadX(Z0), rx1 = W.roadX(W.Z1);
  // past each end the road's valley bends away to one side behind a shoulder, then closes
  const bend0 = (W.seed & 1) ? 1 : -1, bend1 = (W.seed & 2) ? 1 : -1;
  const pastOf = z => (z > Zend ? z - Zend : z < Z0 ? Z0 - z : 0);
  const rxA = z => {
    const past = pastOf(z);
    if (past <= 0) return W.roadX(Math.max(Z0, Math.min(W.Z1, z)));
    const b = z > Zend ? bend1 : bend0, r0 = z > Zend ? rx1 : rx0;
    return r0 + b * (0.4 * Math.max(0, past - 30) + 34 * sstep(20, 150, past) * (0.7 + 0.5 * fbm(z / 90, 3.3, W.seed + 907, 2)));
  };
  const hA = (x, z) => {
    const cx = Math.max(X0, Math.min(X1, x)), cz = Math.max(Z0, Math.min(Zend, z));
    const base = W.heightAt(cx, cz);
    const dOut = Math.hypot(x - cx, z - cz);
    if (dOut <= 0) return base;
    const past = pastOf(z);
    let f = Math.abs(x) > X1 - 1 ? 1 : past > 0 ? sstep(12, 110, Math.abs(x - rxA(z))) : 1;   // the valley along the road...
    f = Math.max(f, sstep(110, 200, past));                                                      // ...closes over a saddle
    const bumps = fbm(x / 70, z / 70, W.seed + 901, 3) * 22 * sstep(0, 90, dOut);
    let rise = dOut * (0.03 + 0.22 * f) + sstep(180, OUT, dOut) * 70 * (0.5 + 0.5 * f) + bumps;
    if (TR) {
      // (Badlands) the far land steps up in flat-topped benches with broad risers, so it reads as
      // stepped mesas under strata, never as rolling dunes; each bench's level wanders, and each
      // riser's line wobbles a few metres (the phase, not the levels), so no edge is ruler-straight
      const [S, a, b] = TR, o = (fbm(x / 160, z / 160, W.seed + 913, 2) * 0.5 + 0.5) * S;
      const wob = fbm(x / 41, z / 41, W.seed + 917, 2) * 0.1 + fbm(x / 13, z / 13, W.seed + 919, 1) * 0.025;
      const q = (Math.max(0, rise) + o) / S + wob, fl = Math.floor(q);
      rise += (((fl + sstep(a, b, q - fl)) * S - o) - Math.max(0, rise)) * sstep(10, 45, dOut);
    }
    return base + rise;
  };
  // the apron's slopes on a uniform 10 m lattice (from the same height function), tent-smoothed and
  // stored as a texture the shader samples bilinearly, so no rock edge follows a 10 m triangle
  const LX = Math.round((X1 - X0 + 2 * OUT) / STEP) + 1, LZ = Math.round((Zend - Z0 + 2 * OUT) / STEP) + 1;
  const SG = new Float32Array(LX * LZ), SX = new Float32Array(LX * LZ), SZ = new Float32Array(LX * LZ), HL = new Float32Array(LX * LZ);
  for (let i = 0; i < LX; i++) for (let j = 0; j < LZ; j++) {
    const x = X0 - OUT + i * STEP, z = Z0 - OUT + j * STEP, e = 2;
    HL[i * LZ + j] = hA(x, z);
    const hx = (hA(x + e, z) - hA(x - e, z)) / (2 * e), hz = (hA(x, z + e) - hA(x, z - e)) / (2 * e), l = Math.hypot(hx, 1, hz);
    SG[i * LZ + j] = 1 - 1 / l; SX[i * LZ + j] = -hx / l; SZ[i * LZ + j] = -hz / l;
  }
  const atx = new Uint8Array(LX * LZ * 4);
  for (let i = 0; i < LX; i++) for (let j = 0; j < LZ; j++) {
    let a = 0, ax = 0, az = 0, n = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const ii = Math.max(0, Math.min(LX - 1, i + di)), jj = Math.max(0, Math.min(LZ - 1, j + dj)), w = (2 - Math.abs(di)) * (2 - Math.abs(dj)), k = ii * LZ + jj;
      a += SG[k] * w; ax += SX[k] * w; az += SZ[k] * w; n += w;
    }
    const l = Math.hypot(ax, az) || 1, o = (j * LX + i) * 4, sv = Math.round(Math.min(1, a / n) * 255);
    atx[o] = sv; atx[o + 1] = sv; atx[o + 2] = Math.round((0.5 + 0.5 * ax / l) * 255); atx[o + 3] = Math.round((0.5 + 0.5 * az / l) * 255);
  }
  const apronTex = new THREE.DataTexture(atx, LX, LZ, THREE.RGBAFormat);
  apronTex.colorSpace = THREE.NoColorSpace;
  apronTex.magFilter = apronTex.minFilter = THREE.LinearFilter;
  apronTex.generateMipmaps = false;
  apronTex.wrapS = apronTex.wrapT = THREE.ClampToEdgeWrapping;
  apronTex.needsUpdate = true;
  const U = mat.userData.U;
  U.tSlopeA.value = apronTex; U.uGridA.value.set(X0 - OUT, Z0 - OUT, STEP, 0); U.uGridAN.value.set(LX, LZ);
  const NX = xs.length, NZ = zs.length;
  const pos = [], nor = [], rd = [], sp = [], cvs = [], sls = [], idx = [];
  const vid = new Int32Array(NX * NZ).fill(-1);
  const inside = (x, z) => x > X0 && x < X1 && z > Z0 && z < Zend;
  // (terraced) every lattice height once, and the normals from those heights smoothed over the
  // 1-ring (a [1 2 1] tent, then central differences: ~4 m either way on the fine lattice; the
  // coarse one's plain central differences already span 5 m), so a riser shades as one soft lit or
  // shadowed band instead of triangle-by-triangle foil
  let YL = null, NL = null;
  if (TR) {
    YL = new Float32Array(NX * NZ);
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) YL[i * NZ + j] = hA(xs[i], zs[j]);
    const YS = new Float32Array(NX * NZ);
    const fine = (v, k) => (k > 0 && v[k] - v[k - 1] < FINE + 0.01) && (k < v.length - 1 && v[k + 1] - v[k] < FINE + 0.01);
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      if (!fine(xs, i) || !fine(zs, j)) { YS[i * NZ + j] = YL[i * NZ + j]; continue; }
      let a = 0, n = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) continue;
        const w = (2 - Math.abs(di)) * (2 - Math.abs(dj));
        a += YL[ii * NZ + jj] * w; n += w;
      }
      YS[i * NZ + j] = a / n;
    }
    NL = new Float32Array(NX * NZ * 3);
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(NX - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NZ - 1, j + 1);
      const hx = (YS[i1 * NZ + j] - YS[i0 * NZ + j]) / (xs[i1] - xs[i0]), hz = (YS[i * NZ + j1] - YS[i * NZ + j0]) / (zs[j1] - zs[j0]), l = Math.hypot(hx, 1, hz);
      const o = (i * NZ + j) * 3;
      NL[o] = -hx / l; NL[o + 1] = 1 / l; NL[o + 2] = -hz / l;
    }
  }
  const vert = (i, j) => {
    const k = i * NZ + j;
    if (vid[k] >= 0) return vid[k];
    const x = xs[i], z = zs[j];
    let y, nX, nY, nZ;
    if (TR) { y = YL[k]; nX = NL[k * 3]; nY = NL[k * 3 + 1]; nZ = NL[k * 3 + 2]; }
    else {
      y = hA(x, z);
      const e = 1.5, hx = (hA(x + e, z) - hA(x - e, z)) / (2 * e), hz = (hA(x, z + e) - hA(x, z - e)) / (2 * e), l = Math.hypot(hx, 1, hz);
      nX = -hx / l; nY = 1 / l; nZ = -hz / l;
    }
    const cz = Math.max(Z0, Math.min(W.Z1, z)), hwz = roadHW(W, cfg, cz), d = x - rxA(z);
    vid[k] = pos.length / 3;
    pos.push(x, y, z); nor.push(nX, nY, nZ);
    const [nt, nv, n2] = lowNoise(W, x, z);
    rd.push(d / (2 * (hwz + SHOULDER)) + 0.5, Math.abs(d) - hwz + sstep(50, 150, pastOf(z)) * 12, nt, nv);   // the track peters out up the saddle
    sp.push(0, 0, 1, n2);
    cvs.push(0);
    const sg = 1 - nY; sls.push(sg, sg);
    return vid[k];
  };
  // The apron is STITCHED to the grid: a lattice point on the grid's edge is the grid's own rim
  // vertex (same position, normal and splat data), and each apron cell along the edge fans out to
  // every 2.5 m rim vertex on its inner side, so there is no T-junction and no crack of sky.
  const rimId = new Map();
  const onEdge = (x, z) => {
    const ex = Math.abs(x - X0) < 1e-4 || Math.abs(x - X1) < 1e-4, ez = Math.abs(z - Z0) < 1e-4 || Math.abs(z - Zend) < 1e-4;
    return (ex && z > Z0 - 1e-4 && z < Zend + 1e-4) || (ez && x > X0 - 1e-4 && x < X1 + 1e-4);
  };
  const rimVert = (ix, iz) => {
    const key = ix * NZ1 + iz;
    if (rimId.has(key)) return rimId.get(key);
    const gv = key, id = pos.length / 3;
    pos.push(X0 + ix * cell, heights[gv], Z0 + iz * cell);
    nor.push(data.nrm[gv * 3], data.nrm[gv * 3 + 1], data.nrm[gv * 3 + 2]);
    for (let k = 0; k < 4; k++) { rd.push(data.road[gv * 4 + k]); sp.push(data.spl[gv * 4 + k]); }
    cvs.push(data.cvA[gv]); sls.push(data.slp[gv * 2], data.slp[gv * 2 + 1]);
    rimId.set(key, id);
    return id;
  };
  const gIx = x => Math.round((x - X0) / cell), gIz = z => Math.round((z - Z0) / cell);
  const vtx = (i, j) => (onEdge(xs[i], zs[j]) ? rimVert(gIx(xs[i]), gIz(zs[j])) : vert(i, j));
  // a triangle, wound to face up whatever order it is given in
  const tri = (p, q, r) => {
    const ax = pos[q * 3] - pos[p * 3], az = pos[q * 3 + 2] - pos[p * 3 + 2], bx = pos[r * 3] - pos[p * 3], bz = pos[r * 3 + 2] - pos[p * 3 + 2];
    if (az * bx - ax * bz > 0) idx.push(p, q, r); else idx.push(p, r, q);
  };
  // the rim vertices strictly between two lattice points on the grid's edge
  const rimBetween = (x0, z0, x1, z1) => {
    const out = [];
    if (Math.abs(x0 - x1) < 1e-4) { const ix = gIx(x0), a = gIz(z0), b = gIz(z1), d = b > a ? 1 : -1; for (let iz = a + d; iz !== b; iz += d) out.push(rimVert(ix, iz)); }
    else { const iz = gIz(z0), a = gIx(x0), b = gIx(x1), d = b > a ? 1 : -1; for (let ix = a + d; ix !== b; ix += d) out.push(rimVert(ix, iz)); }
    return out;
  };
  for (let i = 0; i < NX - 1; i++) for (let j = 0; j < NZ - 1; j++) {
    if (inside((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2)) continue;
    const a = vtx(i, j), b = vtx(i, j + 1), c = vtx(i + 1, j), d = vtx(i + 1, j + 1);
    // which side (if any) lies along the grid's edge: [inner0, inner1, outer0, outer1] with the
    // outer corners in the same order as the inner ones
    let side = null;
    if (onEdge(xs[i + 1], zs[j]) && onEdge(xs[i + 1], zs[j + 1]) && Math.abs(xs[i + 1] - X0) < 1e-4) side = [[i + 1, j], [i + 1, j + 1], a, b, c, d];
    else if (onEdge(xs[i], zs[j]) && onEdge(xs[i], zs[j + 1]) && Math.abs(xs[i] - X1) < 1e-4) side = [[i, j], [i, j + 1], c, d, a, b];
    else if (onEdge(xs[i], zs[j + 1]) && onEdge(xs[i + 1], zs[j + 1]) && Math.abs(zs[j + 1] - Z0) < 1e-4) side = [[i, j + 1], [i + 1, j + 1], a, c, b, d];
    else if (onEdge(xs[i], zs[j]) && onEdge(xs[i + 1], zs[j]) && Math.abs(zs[j] - Zend) < 1e-4) side = [[i, j], [i + 1, j], b, d, a, c];
    if (!side) {
      // (terraced) each cell split along whichever diagonal lies closer to the contour, so a riser's
      // edge runs along the triangles instead of cutting across them in teeth
      if (TR && Math.abs(pos[a * 3 + 1] - pos[d * 3 + 1]) < Math.abs(pos[b * 3 + 1] - pos[c * 3 + 1])) { tri(a, b, d); tri(a, d, c); }
      else { tri(a, b, c); tri(c, b, d); }
      continue;
    }
    const [[pi0, pj0], [pi1, pj1], q0, q1, p0, p1] = side;
    const P = [p0, ...rimBetween(xs[pi0], zs[pj0], xs[pi1], zs[pj1]), p1];
    const mid = P.length >> 1;
    for (let k = 0; k < mid; k++) tri(q0, P[k], P[k + 1]);
    tri(q0, P[mid], q1);
    for (let k = mid; k < P.length - 1; k++) tri(q1, P[k], P[k + 1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(rd, 4));
  geo.setAttribute('aSplat', new THREE.Float32BufferAttribute(sp, 4));
  geo.setAttribute('aCv', new THREE.Float32BufferAttribute(cvs, 1));
  geo.setAttribute('aSlope', new THREE.Float32BufferAttribute(sls, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  group.add(m);
  return { apronTex, lattice: { x0: X0 - OUT, z0: Z0 - OUT, step: STEP, LX, LZ, H: HL } };
}

// The terrain's skyline seen from the camera: for each of N azimuths, the highest elevation angle
// (radians) of any land out to the apron's far corner, marched over the 10 m height lattice
// (outermost row and column included; the step never longer than 15 m, so the apron's high far rim
// down a long valley is never skipped). The horizon rings take it so the land behind a ridge melts
// into the haze right at the ridge's top.
function skylineFrom(W, L, cam, out) {
  const N = out.length, { x0, z0, step, LX, LZ, H } = L, gx1 = W.X0 + W.nx * W.cell, gz1 = W.Z0 + W.nz * W.cell;
  const dMax = Math.hypot((LX - 1) * step, (LZ - 1) * step) + 10;
  for (let a = 0; a < N; a++) {
    const ang = ((a + 0.5) / N - 0.5) * Math.PI * 2, dx = Math.cos(ang), dz = Math.sin(ang);
    let best = -0.35;
    for (let d = 6; d < dMax; d += Math.min(d * 0.05, 15)) {
      const x = cam.x + dx * d, z = cam.z + dz * d, fi = (x - x0) / step, fj = (z - z0) / step;
      if (fi < 0 || fj < 0 || fi > LX - 1 || fj > LZ - 1) break;
      let h;
      if (x > W.X0 && x < gx1 && z > W.Z0 && z < gz1) h = W.heightAt(x, z);       // the playable grid, exactly
      else {
        const i = Math.min(LX - 2, Math.floor(fi)), j = Math.min(LZ - 2, Math.floor(fj)), u = fi - i, v = fj - j, k = i * LZ + j;
        h = (H[k] * (1 - u) + H[k + LZ] * u) * (1 - v) + (H[k + 1] * (1 - u) + H[k + LZ + 1] * u) * v;
      }
      const e = Math.atan2(h - cam.y, d);
      if (e > best) best = e;
    }
    out[a] = best;
  }
  return out;
}

// ---- ground clutter ----------------------------------------------------------------------------

// The clutter atlas as a DataTexture: transparent texels take their cell's average color so
// mipmaps don't grow dark fringes around the blades.
const clutterTexCache = new Map();
function clutterTex(biome) {
  if (clutterTexCache.has(biome)) return clutterTexCache.get(biome);
  const cv = canvasFor(`clutter_${biome}`);
  const w = cv.width, h = cv.height;
  const src = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  const avg = [], CX = Math.round(w / 256), CY = Math.round(h / 256);
  for (let cy = 0; cy < CY; cy++) for (let cx = 0; cx < CX; cx++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy * h / CY; y < (cy + 1) * h / CY; y++) for (let x = cx * w / CX; x < (cx + 1) * w / CX; x++) {
      const k = (y * w + x) * 4;
      if (src[k + 3] > 200) { r += src[k]; g += src[k + 1]; b += src[k + 2]; n++; }
    }
    avg.push(n ? [r / n, g / n, b / n] : [90, 110, 60]);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4;     // flip rows: canvas top → v = 1
    const a = src[k + 3];
    if (a < 24) { const c = avg[Math.floor(y / (h / CY)) * CX + Math.floor(x / (w / CX))]; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; }
    else { out[o] = src[k]; out[o + 1] = src[k + 1]; out[o + 2] = src[k + 2]; }
    out[o + 3] = a;
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  clutterTexCache.set(biome, t);
  return t;
}

// Three crossed quads, both windings, normals straight up so the cards light like the ground.
let cardGeo = null;
function cardGeometry() {
  const pos = [], uv = [], nor = [], idx = [];
  for (let q = 0; q < 3; q++) {
    const a = q * Math.PI / 3 + 0.2, c = Math.cos(a) * 0.5, s = Math.sin(a) * 0.5;
    const b = pos.length / 3;
    pos.push(-c, 0, -s, c, 0, s, c, 1, s, -c, 1, -s);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) nor.push(0, 1, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

const clutterMatCache = new Map();
function clutterMaterial(biome) {
  if (clutterMatCache.has(biome)) return clutterMatCache.get(biome);
  const U = { uTime: { value: 0 } };
  const m = new THREE.MeshLambertMaterial({ map: clutterTex(biome), alphaTest: 0.45, side: THREE.FrontSide });
  m.alphaToCoverage = true;
  m.userData.U = U;
  m.customProgramCacheKey = () => 'terrain-clutter-v3';
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCard; uniform float uTime; varying float vTone;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float cd = distance(ip.xz, cameraPosition.xz), fd = floor(aCard.z);
          vTone = fract(aCard.z);                                      // (the fraction: this card's tone)
          transformed *= 1.0 - smoothstep(fd * 0.62, fd, cd);          // shrink into the ground, no popping
          float sw = sin(uTime * 1.5 + ip.x * 0.37 + ip.z * 0.23) * 0.6 + sin(uTime * 2.6 + ip.z * 0.9 + ip.x * 0.2) * 0.3;
          float hy = position.y * position.y;
          transformed.x += sw * 0.07 * hy;
          transformed.z += sw * 0.035 * hy;
        }`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = vMapUv * vec2(0.25, 0.5) + aCard.xy;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTone;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 0.84 + 0.32 * vTone;`);
  };
  clutterMatCache.set(biome, m);
  return m;
}

// Small deterministic generator keyed on a grid cell.
function cellRng(i, j, seed) {
  let a = (Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1442695041)) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Where clutter must not grow: building floors, stalls, tables, trunks...
function exclusion(W) {
  const x0 = W.X0, z0 = W.Z0, NX = Math.ceil(W.nx * W.cell) + 1, NZ = Math.ceil(W.Z1 - W.Z0) + 2;
  const grid = new Uint8Array(NX * NZ);
  const mark = (cx, cz, hx, hz, ry, pad) => {
    const s = Math.sin(ry), c = Math.cos(ry), R = Math.hypot(hx, hz) + pad;
    const gx0 = Math.max(0, Math.floor(cx - R - x0)), gx1 = Math.min(NX - 1, Math.ceil(cx + R - x0));
    const gz0 = Math.max(0, Math.floor(cz - R - z0)), gz1 = Math.min(NZ - 1, Math.ceil(cz + R - z0));
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const px = x0 + gx + 0.5 - cx, pz = z0 + gz + 0.5 - cz;
      const lx = px * c - pz * s, lz = px * s + pz * c;
      if (Math.abs(lx) < hx + pad && Math.abs(lz) < hz + pad) grid[gx * NZ + gz] = 1;
    }
  };
  for (const st of W.statics) if (st.mat !== 'invisible' && st.hx < 40 && st.hz < 40) mark(st.x, st.z, st.hx, st.hz, st.ry || 0, 0.6);
  for (const c of W.cyls) mark(c.x, c.z, c.r, c.r, 0, 0.25);
  for (const d of W.decor) if (d.k === 'fire') mark(d.x, d.z, 1.6, 1.6, 0, 0.5);
  // whole building lots (+1.5 m: porches, steps, eaves) and painted codes on the ground (they must read)
  for (const b of W.buildings || []) mark(b.x, b.z, b.w / 2, b.dep / 2, b.ry || 0, 1.5);
  for (const sg of W.signs || []) if (sg.flat) mark(sg.x, sg.z, Math.max(3, sg.w / 2 + 1.2), Math.max(3, sg.w / 2 + 1.2), 0, 0);
  return (x, z) => {
    const gx = Math.floor(x - x0), gz = Math.floor(z - z0);
    if (gx < 0 || gz < 0 || gx >= NX || gz >= NZ) return true;
    return grid[gx * NZ + gz] === 1;
  };
}

// Clutter grows in patches: the ground is cut into cells around the camera, and a slow noise
// (6-12 m) decides how many tufts each cell holds (about 40% of cells none, about 20% a dense
// clump of three to five); a cell's tufts gather round one spot and mostly share one kind.
class Clutter {
  constructor(W, cfg, biome) {
    this.W = W; this.cfg = cfg; this.C = cfg.clutter;
    this.blocked = exclusion(W);
    // the cultivated plots (their own row clutter comes from patches(); nothing random grows inside)
    this.plots = cfg.plots ? (W.fields || []).slice(0, MAX_PLOTS).map((f, i) => ({ ...f, i, sn: Math.sin(f.ry), cs: Math.cos(f.ry) })) : [];
    // bare dirt clearings (camp, doorsteps, yards) stay bare; the wheat under a wheat patch is wanted
    this.clear = clearingsOf(W).filter(c => !c.wheat);
    this.cell = this.C.cell; this.K = this.C.slots;
    this.N = Math.ceil(2 * this.C.radius / this.cell) + 1;
    this.half = Math.floor(this.N / 2);
    this.wsum = this.C.cards.reduce((a, c) => a + c[2], 0);
    const patches = this.patches();
    const near = this.N * this.N * this.K;
    this.base = patches.length;
    this.count = patches.length + near;
    this.aCard = new Float32Array(this.count * 3);
    cardGeo ||= cardGeometry();
    const geo = new THREE.BufferGeometry();
    for (const n of ['position', 'uv', 'normal']) geo.setAttribute(n, cardGeo.attributes[n]);
    geo.setIndex(cardGeo.index);
    this.mesh = new THREE.InstancedMesh(geo, clutterMaterial(biome), this.count);
    this.U = this.mesh.material.userData.U;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('aCard', new THREE.InstancedBufferAttribute(this.aCard, 3));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.q2 = new THREE.Quaternion(); this.ax = new THREE.Vector3(); this.v = new THREE.Vector3(); this.sv = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
    patches.forEach((p, i) => this.set(i, p.x, p.y, p.z, p.ry, p.w, p.h, p.card, p.fade, p.lean, p.leanA, p.tone));
    this.ki = new Int32Array(this.N * this.N).fill(-2147483648);
    this.kj = new Int32Array(this.N * this.N).fill(-2147483648);
    for (let s = 0; s < near; s++) this.hide(this.base + s);
  }
  // (fade: the distance it shrinks away by; tone 0..1: darker or lighter, 0.5 as painted)
  set(i, x, y, z, ry, w, h, card, fade, lean = 0, leanA = 0, tone = 0.5) {
    this.q.setFromAxisAngle(this.up, ry);
    if (lean) this.q.premultiply(this.q2.setFromAxisAngle(this.ax.set(Math.cos(leanA), 0, Math.sin(leanA)), lean));
    this.m4.compose(this.v.set(x, y, z), this.q, this.sv.set(w, h, w));
    this.mesh.setMatrixAt(i, this.m4);
    this.aCard[i * 3] = (card % 4) * 0.25; this.aCard[i * 3 + 1] = card < 4 ? 0.5 : 0; this.aCard[i * 3 + 2] = Math.floor(fade) + Math.max(0, Math.min(0.99, tone));
  }
  hide(i) { this.m4.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m4); }
  // how bare the ground is here (the dirt of a clearing): 0..1
  clearAt(x, z) {
    let c = 0;
    for (const q of this.clear) { const d = Math.hypot(x - q.x, z - q.z); if (d < q.r1 + 1) c = Math.max(c, (1 - sstep(q.r0 + 1, q.r1 + 1, d)) * q.k); }
    return c;
  }
  okAt(x, z, roadPad, r = null) {
    const W = this.W;
    if (x < W.X0 + 2 || x > W.X0 + W.nx * W.cell - 2 || z < W.Z0 + 2 || z > W.Z1 - 2) return false;
    if (Math.abs(x - W.roadX(z)) < roadHW(W, this.cfg, z) + roadPad) return false;
    if (this.blocked(x, z)) return false;
    if (this.plots.length && this.plotDepth(x, z) > 0.3) return false;      // (the crop and its trodden headland)
    const e = 0.7, gx = W.heightAt(x + e, z) - W.heightAt(x - e, z), gz = W.heightAt(x, z + e) - W.heightAt(x, z - e);
    if (Math.hypot(gx, gz) / (2 * e) > 0.8) return false;        // no tufts on cliff faces
    for (const m of W.mud) if (z > m.z0 - 2 && z < m.z1 + 2 && Math.abs(x - W.roadX(z)) < 22) return false;
    if (r) {                     // nothing on the dirt of a clearing; thinned to 30% in a ring round it
      const c = this.clearAt(x, z);
      if (c > 0.25 || (c > 0.04 && r() > 0.3)) return false;
    }
    return true;
  }
  // how far inside a cultivated plot (m from its edge, which wanders as the splat's does; <= 0 outside every plot)
  plotDepth(x, z) {
    let best = -1e9;
    for (const f of this.plots) {
      const dx = x - f.x, dz = z - f.z, u = dx * f.sn + dz * f.cs, v = dx * f.cs - dz * f.sn;
      best = Math.max(best, plotM(f, u, v));
    }
    return best;
  }
  // Standing wheat along every row of a wheat plot (on the crests the splat paints: the same jittered
  // spacing and the same wander), a card every ~0.5 m, so a row is a continuous thicket; heights vary
  // in patches and stalks lean a little, most of them the same way (the wind). The crop's edge follows
  // the plot's wandering edge. A few cut-straw tufts on the stubble rows, nothing on the furrows.
  plotRows(out) {
    const W = this.W, WC = this.C.wheatCards;
    for (const f of this.plots) {
      if (f.kind === 'furrow') continue;
      const wheat = f.kind === 'wheat', per = wheat ? 0.72 : 0.7, pk = f.i * 1.37, al = f.along ? 1 : 0;
      const A = al ? f.hd : f.hl, Bm = al ? f.hl : f.hd;
      const r = cellRng(Math.round(f.x * 10), Math.round(f.z * 10), W.seed + 9);
      const windA = r() * 6.283;
      for (let k = Math.floor(-A / per - 3); k * per < A + 3; k++) {
        const step = wheat ? 0.5 : 0.9;
        for (let b = -Bm - 1 + r() * step; b < Bm + 1; b += step * (0.8 + r() * 0.4)) {
          const wan = Math.sin(b * 0.085 + pk * 5) * 0.55 + Math.sin(b * 0.31 + pk * 2) * 0.1;
          const a0 = (k + 0.5) * per;
          let aw = a0;
          for (let it = 0; it < 4; it++) aw = a0 - per * rowJ(aw / per, pk);
          const a = aw - wan + (r() - 0.5) * 0.12;
          const u = al ? b : a, v = al ? a : b;
          const m = plotM(f, u, v);
          const x = f.x + u * f.sn + v * f.cs, z = f.z + u * f.cs - v * f.sn;
          if (wheat) {
            // a few bent stragglers 0.3-1 m out past the crop's edge, leaning out over the headland
            if (m < 1.2) {
              if (m < 0.3 || r() > 0.09 || this.blocked(x, z)) continue;
              const [c, hh] = WC[r() < 0.5 ? 0 : 1];
              out.push({ x, y: W.heightAt(x, z) - 0.05, z, ry: r() * 6.283, w: 0.8 + r() * 0.3, h: hh * (0.7 + r() * 0.2), card: c, fade: 125,
                lean: 0.22 + r() * 0.25, leanA: windA + (r() - 0.5) * 2.4, tone: 0.35 + r() * 0.35 });
              continue;
            }
            if (m < 1.2 + r() * 0.2 || this.blocked(x, z)) continue;
            const ek = sstep(1.2, 3.2, m);                                     // 0 at the crop's edge, 1 well inside
            if (m < 3.2 && r() > 0.32 + 0.68 * ek) continue;                   // a ragged, thinning edge (1.2-3.2 m)
            const tall = r() < 0.8, [c, hh] = WC[tall ? 0 : 1];
            const n1 = noise2(x / 4.5, z / 4.5, W.seed + 71), n2 = noise2(x / 9, z / 9, W.seed + 75);
            // heights vary in patches (4-5 m and 6-10 m), with now and then a taller clump, so the crop's top
            // rolls instead of reading as a trimmed hedge
            const patch = 1 + 0.25 * n1 + 0.12 * noise2(x / 8, z / 8, W.seed + 77) + 0.06 * noise2(x / 1.7, z / 1.7, W.seed + 73)
              + 0.2 * sstep(0.42, 0.62, noise2(x / 2.3, z / 2.3, W.seed + 79));
            const edge = 0.78 + 0.22 * ek;                                     // shorter along the crop's edge
            out.push({ x, y: W.heightAt(x, z) - 0.05, z, ry: r() * 6.283, w: 0.95 + r() * 0.3, h: hh * (0.9 + r() * 0.22) * patch * edge * 1.08, card: c, fade: 125,
              lean: 0.05 + r() * 0.09 + (1 - ek) * r() * 0.16, leanA: windA + (r() - 0.5) * (1.6 + (1 - ek) * 1.6), tone: 0.5 + 0.3 * n2 + 0.18 * n1 + (r() - 0.5) * 0.2 });
          } else {
            // cut straw along every stubble row, thinning into the gaps the splat paints (its break field)
            if (m < 2.45 || this.blocked(x, z)) continue;
            const brk = macroAt(b / 61 + pk * 0.13, k * 0.173 + pk * 0.31)[2];
            if (r() > 0.18 + 0.82 * sstep(0.25, 0.62, brk)) continue;
            out.push({ x, y: W.heightAt(x, z) - 0.03, z, ry: r() * 6.283, w: 0.55 + r() * 0.3, h: 0.22 + r() * 0.12, card: 7, fade: 70, tone: 0.32 + r() * 0.3 });
          }
        }
      }
      // (stubble) the raked windrows the splat paints every fifth row (on most plots): a low, lumpy roll
      // of loose straw in 3D, swelling and breaking where the splat's does, so the plot reads from the road
      if (!wheat && (pk * 0.618 + 0.13) % 1 > 0.3) {
        for (let n = Math.floor(-A / (5 * per) - 1); n * 5 * per < A + 5; n++) {
          const q0 = 5 * n + 2, a0 = q0 * per;
          let aw = a0;
          for (let it = 0; it < 4; it++) aw = a0 - per * rowJ(aw / per, pk);
          for (let b = -Bm - 1 + r() * 0.45; b < Bm + 1; b += 0.38 + r() * 0.16) {
            const wl = macroAt(b / 9 + pk, n * 0.29 + pk * 0.7)[2];
            if (r() > sstep(0.3, 0.55, wl)) continue;
            const wan = Math.sin(b * 0.085 + pk * 5) * 0.55 + Math.sin(b * 0.31 + pk * 2) * 0.1;
            const a = aw - wan + (r() - 0.5) * 0.14;
            const u = al ? b : a, v = al ? a : b;
            if (plotM(f, u, v) < 2.6) continue;
            const x = f.x + u * f.sn + v * f.cs, z = f.z + u * f.cs - v * f.sn;
            if (this.blocked(x, z)) continue;
            const sw = 0.55 + 0.45 * sstep(0.3, 0.7, wl);
            if (r() < 0.6) out.push({ x, y: W.heightAt(x, z) - 0.04, z, ry: r() * 6.283, w: (0.85 + r() * 0.3) * sw + 0.2, h: (0.2 + r() * 0.1) * sw + 0.06, card: 0, fade: 80, tone: 0.3 + r() * 0.3 });
            else out.push({ x, y: W.heightAt(x, z) - 0.03, z, ry: r() * 6.283, w: 0.7 + r() * 0.3, h: 0.26 + r() * 0.1, card: 7, fade: 80, tone: 0.28 + r() * 0.25 });
          }
        }
      }
    }
    return out;
  }
  pickCard(r, flowerish) {
    const cards = this.C.cards;
    if (flowerish && this.C.flowers > 0 && r < 0.55) { const F = this.C.flowerCards; return F[Math.floor(r / 0.55 * F.length) % F.length]; }
    let t = r * this.wsum;
    for (let k = 0; k < cards.length; k++) { if ((t -= cards[k][2]) < 0) return k; }
    return 0;
  }
  // W.decor 'flowers' and 'wheat' become dense static patches.
  patches() {
    const W = this.W, out = [];
    for (const d of W.decor) {
      if (d.k !== 'flowers' && d.k !== 'wheat') continue;
      const wheat = d.k === 'wheat';
      const r = cellRng(Math.round(d.x * 10), Math.round(d.z * 10), W.seed + 5);
      const R = (wheat ? 2.2 : 1.3) * (d.s || 1) + 0.6;
      const n = Math.round((wheat ? 30 : 14) * (d.s || 1));
      if (wheat && this.C.wheatCards) {
        // (Westfall) a small sown patch: short rows along the road over the tilled ground, each a few
        // stalks wide, the patch's edge ragged, never a random scatter of tufts
        const tz = (W.roadX(d.z + 1) - W.roadX(d.z - 1)) / 2, tl = Math.hypot(tz, 1), ax = tz / tl, az = 1 / tl;   // along the road
        const RA = R * 1.1, RC = R * 0.75, WC = this.C.wheatCards;
        for (let c = -RC + 0.36; c < RC; c += 0.72) {
          for (let a = -RA + r() * 0.5; a < RA; a += 0.62 + r() * 0.16) {
            const e = (a / RA) * (a / RA) + (c / RC) * (c / RC);
            if (e > 0.85 + (r() - 0.5) * 0.3) continue;
            const x = d.x + ax * a + az * c + (r() - 0.5) * 0.12, z = d.z + az * a - ax * c + (r() - 0.5) * 0.12;
            if (!this.okAt(x, z, 0.8)) continue;
            const [card, hh] = WC[r() < 0.7 ? 0 : 1], edge = e > 0.55 ? 0.82 : 1;
            out.push({ x, y: W.heightAt(x, z) - 0.04, z, ry: r() * 6.283, w: 0.95 + r() * 0.3, h: hh * (0.9 + r() * 0.2) * edge, card, fade: 170 });
          }
        }
        continue;
      }
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * R;
        const x = d.x + Math.cos(a) * rr, z = d.z + Math.sin(a) * rr * (wheat ? 0.8 : 1);
        if (!this.okAt(x, z, 0.8)) continue;
        let card, w, h;
        const WC = this.C.wheatCards, FC = this.C.flowerCards;
        if (wheat) {
          if (WC) { const [c, hh] = WC[r() < 0.55 ? 0 : 1]; card = c; w = 0.95 + r() * 0.4; h = hh * (0.9 + r() * 0.25); }
          else { card = 0; w = 0.95 + r() * 0.45; h = 0.7 + r() * 0.3; }
          if (r() < 0.12) { card = 0; w = 0.85; h = 0.55; }
        } else {
          card = r() < 0.7 && FC ? FC[Math.floor(r() * FC.length)] : 0;
          w = 0.6 + r() * 0.25; h = 0.5 + r() * 0.25;
        }
        out.push({ x, y: W.heightAt(x, z) - 0.04, z, ry: r() * 6.283, w, h, card, fade: wheat ? 170 : 110 });
      }
    }
    return this.plotRows(out);
  }
  place(s, ci, cj) {
    const W = this.W, C = this.C, K = this.K, r = cellRng(ci, cj, W.seed);
    const cx = (ci + 0.5) * this.cell, cz = (cj + 0.5) * this.cell;
    // how many tufts this cell holds, from the patch noise
    const q = fbm(cx / C.patch, cz / C.patch, W.seed + 77, 2);
    let n = q < -0.06 ? 0 : q < 0.05 ? 1 : q < 0.13 ? 2 : q < 0.21 ? 3 : 4;
    n = Math.max(0, Math.min(K, Math.round(n * C.density * (K / 4) + (r() - 0.5) * 0.8)));
    const flowerish = noise2(cx / 7.5, cz / 7.5, W.seed + 31) > 0.42;
    // wild wheat only in drifts well off the road and out of the clearings
    const wheaty = C.wheat && noise2(cx / 11, cz / 11, W.seed + 53) > 1 - C.wheat * 2 && Math.abs(cx - W.roadX(cz)) > roadHW(W, this.cfg, cz) + 8 && this.clearAt(cx, cz) < 0.02;
    const main = wheaty ? (r() < 0.55 ? C.wheatCards[0][0] : C.wheatCards[1][0]) : this.pickCard(r(), flowerish);
    const px = (ci + 0.25 + r() * 0.5) * this.cell, pz = (cj + 0.25 + r() * 0.5) * this.cell;
    for (let k = 0; k < K; k++) {
      const i = this.base + s * K + k;
      if (k >= n) { this.hide(i); continue; }
      const a = r() * 6.283, rr = Math.sqrt(r()) * C.spread;
      const x = px + Math.cos(a) * rr, z = pz + Math.sin(a) * rr;
      if (!this.okAt(x, z, 0.35 + r() * 1.1, r)) { this.hide(i); continue; }
      const card = r() < 0.75 ? main : this.pickCard(r(), flowerish);
      const [cw, chh] = C.cards[card];
      const sc = 0.7 + r() * 0.7;
      this.set(i, x, W.heightAt(x, z) - 0.04, z, r() * 6.283, cw * sc, chh * sc, card, C.radius);
    }
  }
  update(t, cam) {
    this.U.uTime.value = t;
    const N = this.N, ci = Math.floor(cam.x / this.cell), cj = Math.floor(cam.z / this.cell);
    const i0 = ci - this.half, j0 = cj - this.half;
    let dirty = false;
    for (let a = 0; a < N; a++) {
      const i = i0 + ((a - i0) % N + N) % N;
      for (let b = 0; b < N; b++) {
        const j = j0 + ((b - j0) % N + N) % N;
        const s = a * N + b;
        if (this.ki[s] === i && this.kj[s] === j) continue;
        this.ki[s] = i; this.kj[s] = j;
        this.place(s, i, j);
        dirty = true;
      }
    }
    if (dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.geometry.attributes.aCard.needsUpdate = true; }
  }
  dispose() { this.mesh.dispose(); this.mesh.geometry.dispose(); }
}

// ---- prewarming: paint the next day's textures in idle time at night ---------------------------

const prewarmed = new Set();
function prewarmQueue(biome) {
  const cfg = CFG[biome];
  return [`ground_${biome}`, `ground2_${biome}`, `dirt_${biome}`, `road_${biome}`, cfg?.mudTex || 'mud', `cliff_${biome}`, cfg?.snowRock ? 'cliff_snow_form' : '', `clutter_${biome}`, `sky_mtn_${biome}`, `sky_clouds_${biome}`, 'terrain_detail']
    .filter(n => has(n) && !prewarmed.has(n));
}

// ---- assembly ----------------------------------------------------------------------------------

function clearingsOf(W) {
  const out = [];
  if (W.camp?.fire) out.push({ x: W.camp.fire.x, z: W.camp.fire.z, r0: 3.2, r1: 7.5, k: 1 });
  if (W.town?.fire) out.push({ x: W.town.fire.x, z: W.town.fire.z, r0: 3.0, r1: 7, k: 1 });
  for (const p of W.pois || []) if (p.type !== 'crash') out.push({ x: p.x, z: p.z, r0: 5.5, r1: 11, k: p.type === 'yard' ? 0.6 : 0.95 });
  for (const b of W.buildings || []) {
    const r = Math.max(b.w, b.dep) * 0.5;
    const dx = b.x + Math.sin(b.ry) * (b.dep * 0.5 + 1.5), dz = b.z + Math.cos(b.ry) * (b.dep * 0.5 + 1.5);
    out.push({ x: dx, z: dz, r0: 2.2, r1: Math.min(7, Math.max(4.5, r * 0.85)), k: 0.85 });   // the trodden doorstep
    // a trodden path from the door to the street
    const rx = W.roadX(dz), L = Math.abs(rx - dx);
    if (L > 3 && L < 28) for (let t = 3; t < L; t += 3) out.push({ x: dx + Math.sign(rx - dx) * t, z: dz + Math.sin(t * 0.7 + b.x) * 0.6, r0: 1.0, r1: 3.4, k: 0.7 });
  }
  for (const d of W.decor) if (d.k === 'wheat') out.push({ x: d.x, z: d.z, r0: 1.0, r1: 2.6 * (d.s || 1) + 0.8, k: 0.75, wheat: true });  // tilled under the wheat
  return out;
}

// ---- terrainTintAt ------------------------------------------------------------------------------
//
// terrainTintAt(W, x, z) -> THREE.Color
//   The multiplier the terrain splat lays over its painted textures at world (x, z): the broad
//   warm/cool tint, the value drift (both from the same low-frequency noise and macro texture the
//   shader reads) and the baked ambient occlusion, all in LINEAR colour, about 0.6..1.2 a channel.
//   Multiply a mesh's albedo (or vertex colour) by it so a mound, drift or patch laid on the ground
//   carries the same tint and darkening as the ground around it (no last colour step at its foot).
//   Pure CPU, deterministic, cheap (~50 height lookups): fine for a few hundred calls at build
//   time. Outside the playable grid the occlusion is 1. Works before or after buildTerrain(W).
let macroData = null;
function macroAt(u, v) {
  if (!macroData) {
    const cv = canvasFor('terrain_macro');
    macroData = { w: cv.width, h: cv.height, d: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data };
  }
  const { w, h, d } = macroData;
  const fx = (((u % 1) + 1) % 1) * w - 0.5, fy = (1 - (((v % 1) + 1) % 1)) * h - 0.5;     // flipY: v = 1 is the canvas top
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, out = [0, 0, 0];
  for (const [dx, dy, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const o = ((((y0 + dy) % h + h) % h) * w + (((x0 + dx) % w + w) % w)) * 4;
    for (let k = 0; k < 3; k++) out[k] += d[o + k] / 255 * wt;
  }
  return out;
}
export function terrainTintAt(W, x, z) {
  const cfg = CFG[W.biome] || CFG.meadow;
  const [nt, nv] = lowNoise(W, x, z);
  const mB = macroAt((0.8 * x + 0.6 * z) / 61 + 0.31, (-0.6 * x + 0.8 * z) / 61 + 0.77);
  const t = sstep(0.1, 0.9, nt * 1.3 + mB[0] * 0.45 - 0.37);
  const val = 1 + (nv - 0.5) * cfg.macro + (mB[1] - 0.5) * (cfg.macro2 ?? 0.12);
  let ao = 1;
  const fx = (x - W.X0) / W.cell, fz = (z - W.Z0) / W.cell;
  if (fx >= 0 && fz >= 0 && fx <= W.nx && fz <= W.nz) {
    const i0 = Math.min(W.nx - 1, Math.floor(fx)), j0 = Math.min(W.nz - 1, Math.floor(fz)), u = fx - i0, v = fz - j0;
    ao = aoVertex(W, i0, j0)[0] * (1 - u) * (1 - v) + aoVertex(W, i0 + 1, j0)[0] * u * (1 - v) + aoVertex(W, i0, j0 + 1)[0] * (1 - u) * v + aoVertex(W, i0 + 1, j0 + 1)[0] * u * v;
  }
  const A = cfg.tintA, B = cfg.tintB, O = cfg.ao, c = [0, 0, 0];
  for (let i = 0; i < 3; i++) c[i] = (A[i] + (B[i] - A[i]) * t) * val * (O[i] + (1 - O[i]) * ao);
  return new THREE.Color(c[0], c[1], c[2]);
}

export function buildTerrain(W) {
  const biome = CFG[W.biome] ? W.biome : 'meadow';
  const cfg = CFG[biome];
  const group = new THREE.Group();
  const mat = splatMaterial(biome, cfg);
  const fires = W.decor.filter(d => d.k === 'fire');
  mat.userData.U.uFire.value.set(fires[0]?.x ?? 1e5, fires[0]?.z ?? 1e5, fires[1]?.x ?? 1e5, fires[1]?.z ?? 1e5);
  mat.userData.U.uMesa.value.forEach((v, i) => { const p = (W.mesas || [])[i]; if (p?.mesa) v.set(p.x, p.z, p.mesa.r * 1.4 + 1, 0); else v.set(1e5, 1e5, 0, 0); });
  // each mesa's foot (the median ground height round it) and lip (its flat top)
  mat.userData.U.uMesaY.value.forEach((v, i) => {
    const p = (W.mesas || [])[i];
    if (!p?.mesa) { v.set(0, 0, 0, 0); return; }
    const R = p.mesa.r * 1.4 + 2.5, hs = [];
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; hs.push(W.heightAt(p.x + Math.cos(a) * R, p.z + Math.sin(a) * R)); }
    hs.sort((a, b) => a - b);
    v.set(hs[12], p.mesa.base + p.mesa.h, p.mesa.base + p.mesa.h * (p.mesa.benchK ?? 0.6), p.mesa.benchA ?? 0);
  });
  // the cultivated plots (Westfall)
  const KIND = { wheat: 0, stubble: 1, furrow: 2 };
  mat.userData.U.uPlot.value.forEach((v, i) => { const f = cfg.plots ? (W.fields || [])[i] : null; if (f) v.set(f.x, f.z, Math.sin(f.ry), Math.cos(f.ry)); else v.set(1e5, 1e5, 0, 1); });
  mat.userData.U.uPlotB.value.forEach((v, i) => { const f = cfg.plots ? (W.fields || [])[i] : null; if (f) v.set(f.hl, f.hd, KIND[f.kind] ?? 0, f.along ? 1 : 0); else v.set(0, 0, 0, 0); });
  const data = vertexData(W, cfg, clearingsOf(W));
  const U = mat.userData.U;
  U.tSlope.value = data.slopeTex; U.tSlopeR.value = data.rawTex; U.uGrid.value.set(W.X0, W.Z0, W.cell, 0); U.uGridN.value.set(W.nx + 1, W.nz + 1);
  buildChunks(W, data, mat, group, mesaRefiner(W, 4));
  const { apronTex, lattice } = buildApron(W, cfg, data, mat, group);
  const sky = new Float32Array(128), skyAt = new THREE.Vector3(1e9, 0, 0);
  let skyT = -1e9;
  const clutter = new Clutter(W, cfg, biome);
  group.add(clutter.mesh);
  // (Dun Morogh, Tanaris) the crash mesas' broken silhouettes: shoulders, rim blocks or caprock, talus (render only)
  const talus = cfg.snowRock || cfg.dunes ? buildTalus(W) : null;
  if (talus) group.add(talus);
  for (const n of prewarmQueue(biome)) prewarmed.add(n);
  // tomorrow's textures are painted one at a time while the night lasts (no stall at dawn)
  const next = BIOME_BY_DAY[W.day] || null;
  let queue = next && next !== biome ? prewarmQueue(next) : [], idleAt = 0;
  return {
    group,
    update(dt, t, camPos) {
      if (cfg.sparkle) mat.userData.U.uSpark.value = atmo.sparkle;
      if (cfg.plots && atmo.lightDir) mat.userData.U.uSun.value.copy(atmo.lightDir);
      if (queue.length && atmo.night > 0.6 && t > idleAt && typeof requestIdleCallback === 'function') {
        idleAt = t + 1.5;
        requestIdleCallback(() => { const n = queue.shift(); if (n && !prewarmed.has(n)) { try { canvasFor(n); } catch {} prewarmed.add(n); } }, { timeout: 4000 });
      }
      if (!camPos) return;
      // the skyline for the horizon rings, once the camera has moved 2 m (at most five times a second)
      if (camPos.distanceToSquared(skyAt) > 4 && (t - skyT > 0.2 || t < skyT)) { skyAt.copy(camPos); skyT = t; setSkyline(skylineFrom(W, lattice, camPos, sky)); }
      clutter.update(t, camPos);
    },
    dispose() { clutter.dispose(); talus?.geometry.dispose(); data.slopeTex.dispose(); data.rawTex.dispose(); apronTex.dispose(); queue = []; },
  };
}
