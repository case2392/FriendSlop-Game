// Render-only dressing round the crash mesas of Dun Morogh and Tanaris (part of the terrain art pass).
//
// A crash mesa is part of the physics heightfield: a lobed drum with steep flanks, a bench on one side
// and a flat top. Painted alone it reads as a built tower or a sand cone (a level rim, an even flank, a
// clean foot). Here it gets the broken silhouette of a butte, all of it outside the walkable surface:
//   - (snow) one or two SHOULDERS: wide, flat granite ledge slabs sunk deep into a flank at mid height,
//     stepping out a metre or so, on the sides seen in profile from the road (never the bench or the
//     road side), and two or three RIM blocks hanging over the lip, so the rim is never level;
//   - (desert) a CAPROCK: overlapping flat sandstone slabs right round the rim (a gap or two where one has
//     fallen, none over the bench, where the climb comes up), overhanging the flank, so the top reads as
//     the thick hard bed that keeps a butte standing, square-shouldered over its walls;
//   - a TALUS apron: fallen blocks half buried round the foot (not on the road side); on the desert more
//     of them, tabular slabs of the banded rock tipped every way.
// Every block is an icosphere cut by a few random planes (flat fractured faces, creased normals), its
// top flattened; all of them are one merged mesh with one material: the valley walls' rock (cliff_snow's
// granite at the mesa flank's own scale and 26.6-degree turn, cliff_desert's sandstone beds) projected on
// three axes, snow or sand on whatever faces up (in the snow also on what the painted granite turns to
// the light), cool where buried. Clear of the wreck and the loot; no colliders: the blocks lie outside the walkable
// top and stand on the flanks and the foot.
//
//   buildTalus(W) -> THREE.Mesh | null    (null unless a snow or desert day has crash mesas)
import { THREE, tex } from './gfx.js';
import { mergeVertices, toCreasedNormals, mergeGeometries } from '/vendor/BufferGeometryUtils.js';

const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One angular block, unit-ish size, in its own frame (y up). sink: how far (in block units) below its
// origin it reaches, so the shader can darken the buried part.
function blockGeo(r, cuts = 5) {
  let g = new THREE.IcosahedronGeometry(1, 1);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position, v = new THREE.Vector3(), n = new THREE.Vector3();
  // lumpy first (each vertex in or out a little), then the fracture planes
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); v.multiplyScalar(0.9 + r() * 0.22); P.setXYZ(i, v.x, v.y, v.z); }
  const planes = [];
  planes.push([new THREE.Vector3((r() - 0.5) * 0.25, 1, (r() - 0.5) * 0.25).normalize(), 0.5 + r() * 0.15]);     // the flat top
  for (let k = 0; k < cuts; k++) {
    const a = r() * Math.PI * 2, e = (r() - 0.35) * 1.1;
    planes.push([new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)), 0.55 + r() * 0.3]);
  }
  for (const [pn, d] of planes) for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const t = v.dot(pn);
    if (t > d) { v.addScaledVector(pn, d - t); P.setXYZ(i, v.x, v.y, v.z); }
  }
  g.computeVertexNormals();
  return g;
}

const STYLE = {
  // (snow: the granite at the mesa flank's own scale and turn, 7.96 m a tile turned 26.6 degrees, so a shoulder
  // reads as an outcrop of the same rock; snow on every top and ledge; undersides in the flank's cool blue)
  snow: { rock: 'cliff_snow', cover: 'ground_snow', rs: 7.96, turn: true, tint: [1.06, 1.07, 1.1], up: [0.22, 0.42], coverMax: 1.0, lumUp: 0.7, under: [0.84, 0.88, 0.98], buried: [0.8, 0.85, 0.96], drift: [0.9, 0.94, 1.02] },
  desert: { rock: 'cliff_desert', cover: 'ground2_desert', rs: 8.0, capC: [0.78, 0.62, 0.42], tint: [1.0, 1.0, 1.0], up: [0.8, 0.95], coverMax: 0.6, lumUp: 0, under: [0.8, 0.74, 0.78], buried: [0.72, 0.64, 0.62], drift: [1.0, 0.98, 0.95] },
};
const mats = new Map();
function talusMaterial(biome) {
  if (mats.has(biome)) return mats.get(biome);
  const S = STYLE[biome], f = v => v.map(x => x.toFixed(3)).join(', ');
  const U = { tRock: { value: tex(S.rock) }, tSnow: { value: tex(S.cover) } };
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mats.set(biome, mat);
  mat.customProgramCacheKey = () => 'terrain-talus-v5-' + biome;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSink; varying vec3 vTW; varying vec3 vTN; varying float vSink;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTW = (modelMatrix * vec4(transformed, 1.0)).xyz; vTN = normalize(mat3(modelMatrix) * objectNormal); vSink = aSink;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tRock, tSnow; varying vec3 vTW; varying vec3 vTN; varying float vSink;`)
      .replace('#include <map_fragment>', `
        {
          // the walls' rock on three axes (its beds level on the sides), snow or sand on what faces up
          vec3 n = normalize(vTN), b = pow(abs(n), vec3(4.0)); b /= b.x + b.y + b.z;
          ${S.turn ? 'const mat2 TR = mat2(0.894427, 0.447214, -0.447214, 0.894427);' : 'const mat2 TR = mat2(1.0, 0.0, 0.0, 1.0);'}
          vec3 rk = texture2D(tRock, TR * vec2(vTW.z, vTW.y) / ${S.rs.toFixed(2)} + 0.31).rgb * b.x + texture2D(tRock, vTW.xz / ${S.rs.toFixed(2)} + 0.57).rgb * b.y + texture2D(tRock, TR * vec2(-vTW.x, vTW.y) / ${S.rs.toFixed(2)} + 0.13).rgb * b.z;
          rk *= vec3(${f(S.tint)});
          vec3 sn = texture2D(tSnow, vTW.xz / 8.0).rgb;
          float nz = texture2D(tSnow, vTW.xz / 2.3 + vec2(0.4, 0.7)).g - 0.5;
          // (snow: also on whatever the painted granite turns up to the light, as on the flank)
          float s = smoothstep(${f(S.up)}, n.y + nz * 0.5 + (dot(rk, vec3(0.3, 0.55, 0.15)) - 0.42) * ${S.lumUp.toFixed(2)} * smoothstep(-0.2, 0.2, n.y)) * ${S.coverMax.toFixed(2)};
          vec3 c = mix(rk * mix(vec3(1.0), vec3(${f(S.under)}), smoothstep(${(S.up[1] - 0.04).toFixed(2)}, ${(S.up[0] - 0.08).toFixed(2)}, n.y + nz * 0.5) * smoothstep(0.25, 0.45, n.y)), sn, s);
          // (a caprock slab: the pale hard bed that keeps a butte standing)
          float cap = step(5.0, vSink), sk = vSink - cap * 10.0;
          ${S.capC ? `c = mix(c, vec3(${f(S.capC)}) * (0.75 + 0.5 * dot(rk, vec3(0.3, 0.55, 0.15))), cap * (1.0 - s) * 0.7);` : ''}
          // buried: dark low down, then the drift's own snow or sand over the very foot
          c *= mix(vec3(${f(S.buried)}), vec3(1.0), smoothstep(-0.05, 0.35, sk));
          c = mix(c, sn * vec3(${f(S.drift)}), smoothstep(0.08, -0.06, sk));
          diffuseColor.rgb *= c;
        }`);
  };
  return mat;
}

export function buildTalus(W) {
  if (!STYLE[W.biome]) return null;
  const desert = W.biome === 'desert';
  const mesas = (W.mesas || []).filter(p => p.mesa);
  if (!mesas.length) return null;
  const parts = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), tp = new THREE.Vector3();
  const add = (r, x, y, z, s, yaw, tilt, cuts, cap = 0) => {
    let g = blockGeo(r, cuts);
    // the sink attribute: block-local height (0 at the ground line given by y, 1 at its top)
    const P = g.attributes.position, sink = new Float32Array(P.count);
    e.set(tilt[0], yaw, tilt[1]); q.setFromEuler(e); m4.compose(tp.set(x, y, z), q, sc.set(s[0], s[1], s[2]));
    g.applyMatrix4(m4);
    for (let i = 0; i < P.count; i++) {
      const gy = W.heightAt(P.getX(i), P.getZ(i));
      sink[i] = (P.getY(i) - gy) / Math.max(0.5, s[1]) + cap * 10;
    }
    g.setAttribute('aSink', new THREE.BufferAttribute(sink, 1));
    g = toCreasedNormals(g, 0.75);
    parts.push(g);
  };
  for (const p of mesas) {
    const M = p.mesa, top = M.base + M.h, r = rng32(Math.round(p.z * 977) ^ 0x2545F491);
    // its foot: the median ground height on a ring round it (as the splat takes it)
    const ring = []; for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2, R = M.r * 1.4 + 2.5; ring.push(W.heightAt(p.x + Math.cos(a) * R, p.z + Math.sin(a) * R)); }
    ring.sort((a, b) => a - b);
    const foot = ring[12];
    // the radius along bearing a where the ground first falls below height y, searching outward
    const surfR = (a, y) => { for (let d = 1; d < M.r * 1.6 + 8; d += 0.08) if (W.heightAt(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d) < y) return d; return null; };
    const roadA = p.side > 0 ? Math.PI : 0;                 // the road lies toward -side
    const ang = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const stat = (W.statics || []).filter(s => s.poi === p.id);
    const props = (W.props || []).filter(o => Math.hypot(o.x - p.x, o.z - p.z) < M.r * 1.6 + 4);
    const clear = (x, z, pad) => !stat.some(s => { const dx = x - s.x, dz = z - s.z, c = Math.cos(s.ry || 0), sn = Math.sin(s.ry || 0); return Math.abs(dx * c - dz * sn) < s.hx + pad && Math.abs(dx * sn + dz * c) < s.hz + pad; })
      && !props.some(o => Math.hypot(o.x - x, o.z - z) < pad + 0.6);
    // shoulders: on the two sides seen in profile from the road (bearing ~90 degrees from it)
    const nSh = desert ? 0 : 2, side0 = r() < 0.5 ? 1 : -1;
    for (let k = 0; k < nSh; k++) {
      for (let t = 0; t < 8; t++) {
        const a = roadA + (k ? -side0 : side0) * (Math.PI / 2 + (r() - 0.5) * 0.9);
        if (ang(a, M.benchA ?? 0) < 0.9) continue;
        const y = M.base + M.h * (0.38 + r() * 0.25), d = surfR(a, y);
        if (d == null) continue;
        // (a ledge slab: wide along the flank, flat, sunk well into it, so it reads as the rock stepping out)
        const s = [1.8 + r() * 0.5, 0.95 + r() * 0.3, 2.3 + r() * 0.8];
        add(r, p.x + Math.cos(a) * (d - 0.75), y - s[1] * 0.2, p.z + Math.sin(a) * (d - 0.75), s, -a + (r() - 0.5) * 0.35, [(r() - 0.5) * 0.14, (r() - 0.5) * 0.14], 6);
        // a smaller block wedged under it
        const a2 = a + (r() - 0.5) * 0.35, y2 = y - s[1] * 0.9, d2 = surfR(a2, y2);
        if (d2 != null) add(r, p.x + Math.cos(a2) * (d2 - 0.35), y2 - 0.3, p.z + Math.sin(a2) * (d2 - 0.35), [0.9 + r() * 0.4, 0.6 + r() * 0.2, 1.1 + r() * 0.4], -a2 + (r() - 0.5) * 0.5, [(r() - 0.5) * 0.25, (r() - 0.5) * 0.25], 5);
        break;
      }
    }
    // (desert) the caprock: flat slabs round the rim, overhanging the flank, gaps between them
    if (desert) {
      // (the slabs overlap into one thick hard bed round the rim, so the top reads square-shouldered over the
      // flank; one or two gaps where a slab has fallen; none over the bench, where the climb comes up)
      const nC = 12 + Math.floor(r() * 3), a0 = r() * Math.PI * 2;
      for (let k = 0; k < nC; k++) {
        const a = a0 + (k + (r() - 0.5) * 0.25) / nC * Math.PI * 2;
        if (ang(a, M.benchA ?? 0) < 0.6) continue;
        if (r() < 0.1) continue;
        const d = surfR(a, top - 0.3);
        if (d == null) continue;
        const x = p.x + Math.cos(a) * (d + 0.15), z = p.z + Math.sin(a) * (d + 0.15);
        if (!clear(x, z, 1.2)) continue;
        const s = [1.6 + r() * 0.5, 0.95 + r() * 0.15, 1.15 + r() * 0.25];
        add(r, x, top - 0.82 - r() * 0.1, z, s, -a + Math.PI / 2 + (r() - 0.5) * 0.25, [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08], 9, 1);
      }
    }
    // rim blocks: hanging over the lip, so the skyline of the top is never level
    const nRim = desert ? 0 : 3 + (r() < 0.5 ? 1 : 0), hiA = r() * Math.PI * 2;      // (bigger toward one side: the top seems to lean)
    for (let k = 0, t = 0; k < nRim && t < 30; t++) {
      const a = r() * Math.PI * 2;
      if (ang(a, roadA) < 0.7) continue;
      const d = surfR(a, top - 0.3);
      if (d == null) continue;
      const x = p.x + Math.cos(a) * (d + 0.25), z = p.z + Math.sin(a) * (d + 0.25);
      if (!clear(x, z, 1.4)) continue;
      const hk = 0.75 + 0.5 * (0.5 + 0.5 * Math.cos(a - hiA));
      const s = [(1.0 + r() * 0.6) * hk, (0.85 + r() * 0.5) * hk, (0.95 + r() * 0.5) * hk];
      add(r, x, top - 0.55 + s[1] * 0.35, z, s, -a + (r() - 0.5) * 0.8, [(r() - 0.5) * 0.5, (r() - 0.5) * 0.5], 5);
      k++;
    }
    // the talus: fallen blocks half buried round the foot
    const nT = desert ? 13 + Math.floor(r() * 4) : 7 + Math.floor(r() * 4);
    for (let k = 0; k < nT; k++) {
      const a = (k + r() * 0.8) / nT * Math.PI * 2;
      if (ang(a, roadA) < 0.8) continue;
      const d = surfR(a, foot + 0.9);
      if (d == null) continue;
      const dd = d + 0.2 + r() * (desert ? 2.4 : 1.6), x = p.x + Math.cos(a) * dd, z = p.z + Math.sin(a) * dd;
      if (!clear(x, z, 0.6) || Math.abs(x - W.roadX(z)) < 6.5) continue;      // (never on the road or its shoulder)
      const big = r() < (desert ? 0.55 : 0.35), k0 = big ? (desert ? 1.15 + r() * 0.6 : 1.0 + r() * 0.6) : 0.45 + r() * 0.4;
      // (Tanaris: tabular slabs, fallen from the beds and the caprock, tipped every way)
      const s = desert ? [k0 * (1.0 + r() * 0.4), k0 * (0.42 + r() * 0.25), k0 * (0.8 + r() * 0.35)] : [k0 * (0.9 + r() * 0.4), k0 * (0.6 + r() * 0.3), k0 * (0.9 + r() * 0.4)];
      add(r, x, W.heightAt(x, z) + s[1] * 0.1, z, s, r() * 6.28, [(r() - 0.5) * (desert ? 0.8 : 0.5), (r() - 0.5) * (desert ? 0.8 : 0.5)], desert ? 8 : 5);
    }
  }
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, talusMaterial(W.biome));
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
