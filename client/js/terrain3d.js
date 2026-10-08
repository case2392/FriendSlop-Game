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
// Ground on slopes is projected from the side too. Explicit texture gradients with a capped
// anisotropy keep grazing facets from washing out. Broad warm/cool and value fields and baked
// ambient occlusion sit on top; the snow glints in low direct sun. Beyond the playable heightfield
// an apron of unreachable hills carries the land out to the horizon; at both ends the road's valley
// bends away behind a shoulder and closes over a saddle. Instanced ground clutter grows in patches
// around the camera, never on the bare dirt of a clearing.
//
// Owned by the terrain/atmosphere art pass. API: buildTerrain(W) -> { group, update(dt, t, camPos), dispose() }
// The visible grid is exactly the physics heightfield (same vertices, same diagonal split).
import { THREE, tex, renderer } from './gfx.js';
import { canvasFor, has } from './paint/index.js';
import { atmo } from './atmosphere.js';
import { fbm, noise2 } from '/shared/rng.js';
import { BIOME_BY_DAY } from '/shared/world.js';

const CHUNK = 40;            // cells per terrain chunk side (100 m): few draw calls, still culls
const SHOULDER = 1.7;        // the road texture runs this far past the driven edge on each side
const MUD_TILE = 10;         // the mud texture spans 10 m across the road, like the road texture

// Per-biome look. scale: meters per tile [ground, ground2, dirt, cliff].
// clutter: cell size (m), slots per cell, patch noise scale (m), how sparse (density), cards [w, h, weight].
const CFG = {
  meadow: {
    hw: 3.0, scale: [7, 9, 6, 15], cliff: [0.34, 0.5], cliffN: [0.14, 0.04], g2: [0.56, 0.5], collar: [0.2, 0.11, 0.045], ledge: [0.95, 0.97, 0.9],
    ao: [0.5, 0.52, 0.7], tintA: [1.12, 1.04, 0.78], tintB: [0.82, 0.95, 1.0], macro: 0.4, macro2: 0.16, detail: [0.55, 0.32, 0.0],
    clutter: { cell: 2.2, slots: 4, radius: 23, patch: 9, density: 1.0, spread: 0.8, flowers: 0.16, flowerCards: [2, 3, 7],
      cards: [[0.85, 0.6, 0.34], [0.7, 0.45, 0.22], [0.65, 0.55, 0.08], [0.65, 0.55, 0.08], [0.75, 0.85, 0.08], [0.65, 0.42, 0.1], [0.8, 0.6, 0.2], [0.6, 0.38, 0.06]] },
  },
  fields: {
    hw: 3.0, scale: [7, 9, 6, 15], cliff: [0.34, 0.5], cliffN: [0.14, 0.04], g2: [0.6, 0.45], collar: [0.3, 0.2, 0.09], ledge: [0.95, 0.95, 0.9],
    ao: [0.55, 0.52, 0.66], tintA: [1.08, 1.0, 0.84], tintB: [0.9, 0.98, 1.0], macro: 0.36, detail: [0.5, 0.32, 0.0],
    clutter: { cell: 2.2, slots: 4, radius: 23, patch: 10, density: 0.95, spread: 0.85, flowers: 0.06, flowerCards: [4], wheat: 0.3, wheatCards: [[1, 0.95], [2, 0.72]],
      cards: [[0.85, 0.62, 0.36], [0.95, 0.95, 0.04], [0.85, 0.72, 0.04], [0.8, 0.58, 0.22], [0.65, 0.55, 0.05], [0.85, 0.72, 0.16], [0.8, 0.7, 0.08], [0.7, 0.32, 0.08]] },
  },
  snow: {
    hw: 3.0, scale: [8, 9, 6, 14], cliff: [0.34, 0.5], cliffN: [0.14, 0.04], g2: [0.67, 0.42], collar: [0.62, 0.68, 0.8], ledge: [1.0, 1.0, 1.0], snowRock: true, local: 0.02,
    ao: [0.6, 0.67, 0.86], tintA: [1.03, 1.01, 0.96], tintB: [0.9, 0.95, 1.06], macro: 0.2, macro2: 0.1, mudTex: 'slush', sparkle: true, detail: [0.0, 0.12, 0.3],
    clutter: { cell: 3.0, slots: 3, radius: 22, patch: 10, density: 0.5, spread: 1.0, flowers: 0,
      cards: [[0.8, 0.55, 0.38], [0.8, 0.6, 0.16], [0.7, 0.42, 0.04], [0.95, 0.75, 0.26], [1.1, 0.5, 0.14], [0.6, 0.38, 0.2], [0.85, 0.65, 0.08], [0.9, 0.4, 0.12]] },
  },
  badlands: {
    hw: 3.1, scale: [7, 8, 6, 17], cliff: [0.12, 0.24], cliffN: [0.12, 0.05], g2: [0.6, 0.35], collar: [0.36, 0.16, 0.08], ledge: [1, 1, 1], strata: true, mudTex: 'mud_badlands', local: 0.06,
    ao: [0.52, 0.42, 0.55], tintA: [1.07, 1.0, 0.9], tintB: [0.92, 0.95, 1.03], macro: 0.32, detail: [0.08, 0.45, 0.1],
    clutter: { cell: 3.2, slots: 3, radius: 22, patch: 12, density: 0.42, spread: 1.0, flowers: 0,
      cards: [[0.75, 0.5, 0.3], [0.8, 0.55, 0.12], [0.75, 0.5, 0.12], [0.7, 0.5, 0.12], [0.75, 0.5, 0.16], [0.85, 0.6, 0.06], [0.7, 0.45, 0.06], [0.5, 0.3, 0.14]] },
  },
  desert: {
    hw: 3.1, scale: [8, 8, 6, 16], cliff: [0.36, 0.52], cliffN: [0.14, 0.05], g2: [0.62, 0.3], collar: [0.5, 0.36, 0.2], ledge: [1, 1, 1], strata: true, dunes: true, mudTex: 'mud_desert', local: 0.02,
    ao: [0.6, 0.5, 0.58], tintA: [1.05, 1.0, 0.9], tintB: [0.94, 0.97, 1.03], macro: 0.3, detail: [0.0, 0.3, 0.38],
    clutter: { cell: 4.0, slots: 2, radius: 22, patch: 12, density: 0.3, spread: 1.0, flowers: 0,
      cards: [[0.7, 0.45, 0.34], [0.75, 0.5, 0.12], [0.7, 0.45, 0.12], [0.6, 0.45, 0.08], [0.8, 0.75, 0.12], [0.7, 0.45, 0.06], [0.6, 0.4, 0.06], [0.5, 0.3, 0.14]] },
  },
};

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
    uSpark: { value: 0 }, tSlope: { value: null }, uGrid: { value: new THREE.Vector4(0, 0, 1, 0) }, uGridN: { value: new THREE.Vector2(2, 2) }, tSlopeA: { value: null }, uGridA: { value: new THREE.Vector4(0, 0, 1, 0) }, uGridAN: { value: new THREE.Vector2(2, 2) }, uFire: { value: new THREE.Vector4(1e5, 1e5, 1e5, 1e5) }, uRoadSpan: { value: 2 * (cfg.hw + SHOULDER) },
    uScale: { value: new THREE.Vector4(...cfg.scale) }, uMisc: { value: new THREE.Vector4(MUD_TILE, 10, cfg.macro, cfg.macro2 ?? 0.12) },
    uCliff: { value: new THREE.Vector2(...cfg.cliff) }, uLocal: { value: cfg.local ?? -1 }, uCliffN: { value: new THREE.Vector2(...cfg.cliffN) }, uG2: { value: new THREE.Vector2(...cfg.g2) },
    uAO: { value: new THREE.Vector3(...cfg.ao) }, uCollar: { value: new THREE.Vector3(...cfg.collar) }, uLedge: { value: new THREE.Vector3(...cfg.ledge) }, uTintA: { value: new THREE.Vector3(...cfg.tintA) }, uTintB: { value: new THREE.Vector3(...cfg.tintB) },
  };
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.userData.U = U;
  m.defines = {};
  if (cfg.sparkle) m.defines.TERRAIN_SPARKLE = 1;
  if (cfg.strata) m.defines.TERRAIN_STRATA = 1;
  if (cfg.dunes) m.defines.TERRAIN_DUNES = 1;
  if (cfg.snowRock) m.defines.TERRAIN_SNOWROCK = 1;
  const key = 'terrain-splat-v15' + (cfg.sparkle ? 's' : '') + (cfg.strata ? 't' : '') + (cfg.dunes ? 'd' : '') + (cfg.snowRock ? 'r' : '');
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
        uniform vec4 uScale, uMisc, uFire; uniform vec2 uCliff, uCliffN, uG2; uniform vec3 uAO, uTintA, uTintB, uCollar, uLedge; uniform float uSpark, uRoadSpan, uLocal;
        varying vec4 vRoad; varying vec4 vSplat; varying vec3 vTPos; varying vec3 vTNrm; varying float vCv; varying vec2 vSlope;
        float tLum(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }
        float tHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
        // Cap the anisotropy of a pair of texture gradients at 3:1 by shortening the long one. On the
        // grazing facets of a steep zigzag wall the long gradient would otherwise pick a far blurrier
        // mip than the facets beside it, and the texture would wash out triangle by triangle.
        void tCap(inout vec2 dx, inout vec2 dy) {
          float lx = length(dx), ly = length(dy), lm = 3.0 * min(lx, ly) + 1e-6;
          if (lx > lm) dx *= lm / lx;
          if (ly > lm) dy *= lm / ly;
        }
        `)
      .replace('#include <map_fragment>', `
        float tSpark = 0.0;
        {
          // Each optional layer is fetched only where it can show, and every blend weight is
          // faded to zero at its branch boundary, so the fetches can use implicit derivatives.
          const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);       // a rotated frame breaks the tile grid
          vec3 wp = vTPos; vec3 nr = normalize(vTNrm);
          vec2 xz = wp.xz, xr = ROT * xz;
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
          // ground: two scales of the main ground, picked patch by patch so neither tile shows. Flat
          // ground is projected from above; on slopes (by a smoothed slope, so the grid never shows)
          // from the side, x- or z-facing, the switch dithered by noise. Every fetch is given the
          // derivatives of its own projection, so a switch never drops to a tiny mip along the seam.
          float distK = smoothstep(80.0, 260.0, distance(cameraPosition, wp));
          float gB = exp2(distK * 1.5);
          float sideW = smoothstep(0.24, 0.34, sl.y + (nE - 0.5) * 0.08 + (mB.r - 0.5) * 0.05);   // switch near 45 degrees, where both projections stretch alike
          vec2 sxz = vec2(wp.z, wp.y), szx = vec2(-wp.x, wp.y);
          vec2 an0 = pow(abs(hn) + 0.001, vec2(6.0));
          bool useX = an0.x / (an0.x + an0.y) + (nE - 0.5) * 0.6 > 0.5;
          vec2 sp = useX ? sxz : szx;
          vec2 dsx = useX ? dFdx(sxz) : dFdx(szx), dsy = useX ? dFdy(sxz) : dFdy(szx);
          bool side = sideW + (nE - 0.5) * 0.3 + (mB.g - 0.5) * 0.15 > 0.5;
          vec2 gp = side ? sp : xz, gpr = side ? vec2(sp.x * 0.8 - sp.y * 0.6, sp.x * 0.6 + sp.y * 0.8) : xr;
          vec2 gdx = side ? dsx : dFdx(xz), gdy = side ? dsy : dFdy(xz);
          tCap(gdx, gdy);
          vec2 gdxr = ROT * gdx, gdyr = ROT * gdy;
          if (side) { gdxr = vec2(dsx.x * 0.8 - dsx.y * 0.6, dsx.x * 0.6 + dsx.y * 0.8); gdyr = vec2(dsy.x * 0.8 - dsy.y * 0.6, dsy.x * 0.6 + dsy.y * 0.8); }
          float sBias = side ? 1.0 : exp2(smoothstep(0.12, 0.45, 1.0 - nr.y) * 2.0 * smoothstep(8.0, 30.0, distance(cameraPosition, wp)));   // (never blurred at your feet)
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
          // the road, in road space; the ground laps over its ragged edge. A second sample of the road
          // (mirrored, a 23 m period) takes over in big patches, so the 10 m tile never repeats.
          if (vRoad.y < 2.6) {
            vec2 ru = vec2(clamp(vRoad.x, 0.004, 0.996), wp.z / uMisc.y);
            vec3 rc = texture2D(tRoad, ru).rgb;
            float r2k = smoothstep(0.4, 0.6, mB.r * 0.75 + vRoad.w * 0.5 - 0.12);
            if (r2k > 0.01) rc = mix(rc, texture2D(tRoad, vec2(1.0 - ru.x, wp.z / 23.0 + 0.37)).rgb, r2k);
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
          if (uLocal >= 0.0) cB = max(cB, sl.y - uLocal + (nE - 0.5) * 0.1 + (mB.g - 0.5) * 0.06);
          if (cB > uCliff.x - 0.01) {
            vec2 cw = vec2(mB.g - 0.5, mB.r - 0.5) * vec2(0.3, 0.14);    // ledges wander along a wall instead of repeating
            float xb = smoothstep(0.3, 0.7, mB.r * 0.7 + vRoad.w * 0.6 - 0.15);
            float farK = smoothstep(28.0, 75.0, distance(cameraPosition, wp));   // far walls: the rock at 2.5x, bigger masses
            // side projection: x- or z-facing, from a sharpened normal blend dithered by noise
            vec2 an = pow(abs(hn) + 0.001, vec2(8.0));
            float sx = smoothstep(0.32, 0.68, an.x / (an.x + an.y) + (nE - 0.5) * 0.5);
            vec3 cc = vec3(0.0);
            if (sx > 0.01) {
              vec2 p = vec2(wp.z, wp.y) / uScale.w + cw;
              vec2 dx = dFdx(p), dy = dFdy(p); tCap(dx, dy);
              vec3 c1 = vec3(0.0);
              if (farK < 0.999) c1 = mix(textureGrad(tCliff, p, dx, dy).rgb, textureGrad(tCliff, vec2(p.x * 0.71 + 0.37, p.y * 0.83 + 0.21), dx * 0.77, dy * 0.77).rgb, xb);
              if (farK > 0.001) c1 = mix(c1, textureGrad(tCliff, p * 0.4 + vec2(0.13, 0.57), dx * 0.4, dy * 0.4).rgb, farK);
              cc += sx * c1;
            }
            if (sx < 0.99) {
              vec2 p = vec2(-wp.x, wp.y) / uScale.w + vec2(0.5, 0.0) + cw;
              vec2 dx = dFdx(p), dy = dFdy(p); tCap(dx, dy);
              vec3 c2 = vec3(0.0);
              if (farK < 0.999) c2 = mix(textureGrad(tCliff, p, dx, dy).rgb, textureGrad(tCliff, vec2(p.x * 0.71 + 0.61, p.y * 0.83 + 0.47), dx * 0.77, dy * 0.77).rgb, xb);
              if (farK > 0.001) c2 = mix(c2, textureGrad(tCliff, p * 0.4 + vec2(0.71, 0.29), dx * 0.4, dy * 0.4).rgb, farK);
              cc += (1.0 - sx) * c2;
            }
            #ifdef TERRAIN_STRATA
              // under strata, moderate slopes are loose scree, so bands only ever show on truly steep faces
              float topK = 1.0 - smoothstep(0.3, 0.5, max(slope, sl.y));
              cc = mix(cc, col * vec3(0.94, 0.9, 0.88), topK);
            #else
              // ledges and shelves inside the rock hold what the ground holds (grass, golden grass,
              // snow), so the foot and the lip of a wall turn into soft drifts, never a row of teeth
              float ledge = 1.0 - smoothstep(0.12, 0.26, sl.y + (nE - 0.5) * 0.16 + (mB.g - 0.5) * 0.1 + (vSplat.w - 0.5) * 0.08);
              cc = mix(cc, col * uLedge, ledge);
            #endif
            #ifdef TERRAIN_SNOWROCK
            {
              // granite never darker than its own palette (cool blue-gray, #6f7682 at the darkest),
              // and snow lies on every face that looks up, with a lumpy edge
              cc += max(vec3(0.0), vec3(0.159, 0.181, 0.223) * 0.9 - cc) * 0.65;
              float up = nr.y + (nE - 0.5) * 0.16 + (mB.g - 0.5) * 0.12 + (mB.r - 0.5) * 0.06;
              cc = mix(cc, col, smoothstep(0.55, 0.58, up));
            }
            #endif
            float wk = smoothstep(uCliff.x, uCliff.y, cB);
            // the lit, protruding parts of the rock break through first (a soft height blend); in the
            // snow a sharp reveal, so rock never shows as a soft partial smudge
            #ifdef TERRAIN_SNOWROCK
            wk = smoothstep(0.46, 0.54, wk + (min(tLum(cc), 0.7) - 0.4) * 0.5 * (1.0 - wk) + (nE - 0.5) * 0.14);
            #else
            wk = smoothstep(0.24, 0.76, wk + (min(tLum(cc), 0.7) - 0.4) * 0.5 * (1.0 - wk) + (nE - 0.5) * 0.1);
            #endif
            #ifdef TERRAIN_DUNES
              wk *= 1.0 - smoothstep(-0.05, 0.35, vCv);                // dune crests stay sand
            #endif
            // a thin collar of scree and dirt where the rock comes out of the ground
            float collar = clamp(wk * (1.0 - wk) * 4.0, 0.0, 1.0) * smoothstep(0.15, 0.55, nE + mB.g * 0.4);
            col = mix(col, uCollar * (0.65 + tLum(cc) * 1.1), collar * 0.5);
            col = mix(col, cc, wk);
            gW *= 1.0 - wk;
            rockW = wk;
          }
          // near-field detail at the camera's feet: blades on the grass, grit and pebbles on dirt and
          // road, fine ripples and crust on sand and snow (a 1.8 m tile, gone by 25 m)
          {
            float nearK = (1.0 - smoothstep(14.0, 25.0, distance(cameraPosition, wp))) * smoothstep(0.55, 0.85, nr.y) * (1.0 - rockW);
            if (nearK > 0.001) {
              vec3 dt = texture2D(tDetail, (ROT * xz) / 1.8 + vec2(0.17, 0.61)).rgb - 0.5;
              float d = dt.r * uDetail.x * gW + dt.g * uDetail.y + dt.b * uDetail.z * gW;
              col *= 1.0 + 2.0 * d * nearK;
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
      // mud
      let mud = 0;
      for (const m of W.mud) {
        const wz = sstep(m.z0 - 4, m.z0 + 5, z) * (1 - sstep(m.z1 - 5, m.z1 + 4, z));
        if (wz > 0 && Math.abs(d) < m.hw) mud = Math.max(mud, wz * (1 - 0.72 * sstep(5, 26, Math.abs(d))));
      }
      // clearings
      let clr = 0;
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
  const slopeTex = new THREE.DataTexture(tx, nx + 1, NZ1, THREE.RGBAFormat);
  slopeTex.colorSpace = THREE.NoColorSpace;
  slopeTex.magFilter = slopeTex.minFilter = THREE.LinearFilter;
  slopeTex.generateMipmaps = false;
  slopeTex.wrapS = slopeTex.wrapT = THREE.ClampToEdgeWrapping;
  slopeTex.needsUpdate = true;
  return { nrm, road, spl, cvA, slp, slopeTex };
}

function buildChunks(W, data, mat, group) {
  const { nx, nz, cell, X0, Z0, heights } = W;
  const NZ1 = nz + 1;
  for (let cx = 0; cx < nx; cx += CHUNK) {
    for (let cz = 0; cz < nz; cz += CHUNK) {
      const ex = Math.min(nx, cx + CHUNK), ez = Math.min(nz, cz + CHUNK);
      const vx = ex - cx + 1, vz = ez - cz + 1, n = vx * vz;
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), rd = new Float32Array(n * 4), sp = new Float32Array(n * 4), cv = new Float32Array(n), sl = new Float32Array(n * 2);
      for (let i = 0; i < vx; i++) for (let j = 0; j < vz; j++) {
        const lv = i * vz + j, ix = cx + i, iz = cz + j, gv = ix * NZ1 + iz;
        pos[lv * 3] = X0 + ix * cell; pos[lv * 3 + 1] = heights[gv]; pos[lv * 3 + 2] = Z0 + iz * cell;
        for (let k = 0; k < 3; k++) nor[lv * 3 + k] = data.nrm[gv * 3 + k];
        for (let k = 0; k < 4; k++) { sp[lv * 4 + k] = data.spl[gv * 4 + k]; rd[lv * 4 + k] = data.road[gv * 4 + k]; }
        cv[lv] = data.cvA[gv]; sl[lv * 2] = data.slp[gv * 2]; sl[lv * 2 + 1] = data.slp[gv * 2 + 1];
      }
      const idx = [];
      for (let i = 0; i < vx - 1; i++) for (let j = 0; j < vz - 1; j++) {
        const p00 = i * vz + j, p01 = i * vz + j + 1, p10 = (i + 1) * vz + j, p11 = (i + 1) * vz + j + 1;
        idx.push(p00, p01, p10, p10, p01, p11);    // Rapier's split: the (+x,-z)/(-x,+z) diagonal
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('aRoad', new THREE.BufferAttribute(rd, 4));
      geo.setAttribute('aSplat', new THREE.BufferAttribute(sp, 4));
      geo.setAttribute('aCv', new THREE.BufferAttribute(cv, 1));
      geo.setAttribute('aSlope', new THREE.BufferAttribute(sl, 2));
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
  const OUT = 340, STEP = 10;
  const xs = [], zs = [];
  for (let x = X0 - OUT; x <= X1 + OUT + 0.01; x += STEP) xs.push(x);
  for (let z = Z0 - OUT; z < Z0; z += STEP) zs.push(z);
  for (let z = Z0; z < Zend - 0.01; z += STEP) zs.push(z);
  for (let z = Zend; z <= Zend + OUT + 0.01; z += STEP) zs.push(z);
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
    const rise = dOut * (0.03 + 0.22 * f) + sstep(180, OUT, dOut) * 70 * (0.5 + 0.5 * f) + bumps;
    return base + rise;
  };
  // the apron's slopes on a uniform 10 m lattice (from the same height function), tent-smoothed and
  // stored as a texture the shader samples bilinearly, so no rock edge follows a 10 m triangle
  const LX = Math.round((X1 - X0 + 2 * OUT) / STEP) + 1, LZ = Math.round((Zend - Z0 + 2 * OUT) / STEP) + 1;
  const SG = new Float32Array(LX * LZ), SX = new Float32Array(LX * LZ), SZ = new Float32Array(LX * LZ);
  for (let i = 0; i < LX; i++) for (let j = 0; j < LZ; j++) {
    const x = X0 - OUT + i * STEP, z = Z0 - OUT + j * STEP, e = 2;
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
  const vert = (i, j) => {
    const k = i * NZ + j;
    if (vid[k] >= 0) return vid[k];
    const x = xs[i], z = zs[j], y = hA(x, z);
    const e = 1.5, hx = (hA(x + e, z) - hA(x - e, z)) / (2 * e), hz = (hA(x, z + e) - hA(x, z - e)) / (2 * e), l = Math.hypot(hx, 1, hz);
    const cz = Math.max(Z0, Math.min(W.Z1, z)), hwz = roadHW(W, cfg, cz), d = x - rxA(z);
    vid[k] = pos.length / 3;
    pos.push(x, y, z); nor.push(-hx / l, 1 / l, -hz / l);
    const [nt, nv, n2] = lowNoise(W, x, z);
    rd.push(d / (2 * (hwz + SHOULDER)) + 0.5, Math.abs(d) - hwz + sstep(50, 150, pastOf(z)) * 12, nt, nv);   // the track peters out up the saddle
    sp.push(0, 0, 1, n2);
    cvs.push(0);
    const sg = 1 - 1 / l; sls.push(sg, sg);
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
    if (!side) { tri(a, b, c); tri(c, b, d); continue; }
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
  return apronTex;
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
  m.customProgramCacheKey = () => 'terrain-clutter-v2';
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCard; uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float cd = distance(ip.xz, cameraPosition.xz);
          transformed *= 1.0 - smoothstep(aCard.z * 0.62, aCard.z, cd);   // shrink into the ground, no popping
          float sw = sin(uTime * 1.5 + ip.x * 0.37 + ip.z * 0.23) * 0.6 + sin(uTime * 2.6 + ip.z * 0.9 + ip.x * 0.2) * 0.3;
          float hy = position.y * position.y;
          transformed.x += sw * 0.07 * hy;
          transformed.z += sw * 0.035 * hy;
        }`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = vMapUv * vec2(0.25, 0.5) + aCard.xy;`);
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
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.sv = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
    patches.forEach((p, i) => this.set(i, p.x, p.y, p.z, p.ry, p.w, p.h, p.card, p.fade));
    this.ki = new Int32Array(this.N * this.N).fill(-2147483648);
    this.kj = new Int32Array(this.N * this.N).fill(-2147483648);
    for (let s = 0; s < near; s++) this.hide(this.base + s);
  }
  set(i, x, y, z, ry, w, h, card, fade) {
    this.q.setFromAxisAngle(this.up, ry);
    this.m4.compose(this.v.set(x, y, z), this.q, this.sv.set(w, h, w));
    this.mesh.setMatrixAt(i, this.m4);
    this.aCard[i * 3] = (card % 4) * 0.25; this.aCard[i * 3 + 1] = card < 4 ? 0.5 : 0; this.aCard[i * 3 + 2] = fade;
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
    const e = 0.7, gx = W.heightAt(x + e, z) - W.heightAt(x - e, z), gz = W.heightAt(x, z + e) - W.heightAt(x, z - e);
    if (Math.hypot(gx, gz) / (2 * e) > 0.8) return false;        // no tufts on cliff faces
    for (const m of W.mud) if (z > m.z0 - 2 && z < m.z1 + 2 && Math.abs(x - W.roadX(z)) < 22) return false;
    if (r) {                     // nothing on the dirt of a clearing; thinned to 30% in a ring round it
      const c = this.clearAt(x, z);
      if (c > 0.25 || (c > 0.04 && r() > 0.3)) return false;
    }
    return true;
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
    return out;
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
  return [`ground_${biome}`, `ground2_${biome}`, `dirt_${biome}`, `road_${biome}`, cfg?.mudTex || 'mud', `cliff_${biome}`, `clutter_${biome}`, `sky_mtn_${biome}`, `sky_clouds_${biome}`, 'terrain_detail']
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
  const data = vertexData(W, cfg, clearingsOf(W));
  const U = mat.userData.U;
  U.tSlope.value = data.slopeTex; U.uGrid.value.set(W.X0, W.Z0, W.cell, 0); U.uGridN.value.set(W.nx + 1, W.nz + 1);
  buildChunks(W, data, mat, group);
  const apronTex = buildApron(W, cfg, data, mat, group);
  const clutter = new Clutter(W, cfg, biome);
  group.add(clutter.mesh);
  for (const n of prewarmQueue(biome)) prewarmed.add(n);
  // tomorrow's textures are painted one at a time while the night lasts (no stall at dawn)
  const next = BIOME_BY_DAY[W.day] || null;
  let queue = next && next !== biome ? prewarmQueue(next) : [], idleAt = 0;
  return {
    group,
    update(dt, t, camPos) {
      if (cfg.sparkle) mat.userData.U.uSpark.value = atmo.sparkle;
      if (queue.length && atmo.night > 0.6 && t > idleAt && typeof requestIdleCallback === 'function') {
        idleAt = t + 1.5;
        requestIdleCallback(() => { const n = queue.shift(); if (n && !prewarmed.has(n)) { try { canvasFor(n); } catch {} prewarmed.add(n); } }, { timeout: 4000 });
      }
      if (!camPos) return;
      clutter.update(t, camPos);
    },
    dispose() { clutter.dispose(); data.slopeTex.dispose(); apronTex.dispose(); queue = []; },
  };
}
