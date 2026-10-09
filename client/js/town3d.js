// The town: every W.buildings entry (gas station, pawn shop, store, casino) drawn from its record
// by town_build.js in the day's style (interiors included); every W.signs (carved and painted wooden
// boards hung between posts, a gilded casino board, roadside billboards that face the drivers, the
// gate code brushed in house paint on a slab of rim rock with a rag-tied stake beside it); street lamps
// (W.decor 'lamp'); the yards (town_yard.js: door aprons and the yard_* props); the town's furniture and
// interactables (pawn counter and bell, Ed's chained placard, store goods and price boards, the blackjack
// table, hit/stand rugs, coloured glass buttons with engraved brass plaques, the double-or-nothing
// contraption, slot machines, the bar); the NPCs; the Repo Man's steam tow wagon; and the Westfall
// windmills (world gen's, beside the road on the fields day, and one out past the end of the farm town). Lamps, windows and signs glow with atmo.night.
// Static geometry is merged per material and per spatial cluster (the town, each roadside stop, each
// lone sign), so far clusters are culled. Roadside stuff (POI furniture, gates, anchors, camp) is in
// roadside3d.js.
// API: buildStructures(W) -> { group, near, npcs, pawnLabel, bjLabel, flipLabel,
//      cardGroup, coin, hitPad, standPad, update(dt, t, camPos) } and PREVIEW.
import { THREE, canvasTex, labelSprite, shadowy, tex } from './gfx.js';
import { atmo } from './atmosphere.js';
import { buildCharacter } from './people.js';
import { isRoadside } from './roadside3d.js';
import { signCanvas, muteColor } from './paint/architecture.js';
import { Batch, ClusterBatch, Kit, mat, matrix, rng, sstep } from './town_kit.js';
import { buildBuilding, STYLES, winMat, glassMat, lantern, barrel, flames, ITEMS } from './town_build.js';
import { buildAprons, yardProp, YARD_PARTS, cartwheel, hayBale, apronMat } from './town_yard.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;
const _v2 = new THREE.Vector2();
const sceneOf = o => { while (o.parent) o = o.parent; return o; };

// textures and materials made for one day (sign atlas, decals, label sprites...), freed on the next build
let owned = [];
const own = (...xs) => { owned.push(...xs); return xs[0]; };
function disposeOwned() { for (const o of owned) { try { o.dispose(); } catch { /* already gone */ } } owned = []; }

// ---- glow points (lamp halos, braziers, bulbs): one additive draw call --------------------------

function glowPoints(list) {
  const n = list.length;
  const pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3);
  list.forEach((g, i) => {
    pos.set([g.p.x, g.p.y, g.p.z], i * 3); size[i] = g.s;
    const c = new THREE.Color(g.fire ? '#ff9a48' : g.col || '#ffc878');
    col.set([c.r, c.g, c.b], i * 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('gcol', new THREE.BufferAttribute(col, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex('glow_soft') }, uScale: { value: 500 }, uOpacity: { value: 0.3 } },
    vertexShader: `attribute float size; attribute vec3 gcol; uniform float uScale; varying vec3 vC; varying float vA;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); float d = -mv.z;
        gl_PointSize = clamp(size * uScale / max(d, 0.5), 1.0, 512.0); gl_Position = projectionMatrix * mv;
        vC = gcol; vA = clamp(1.0 - (d - 90.0) / 140.0, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform float uOpacity; varying vec3 vC; varying float vA;
      void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.rgb, t.a * uOpacity * vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  own(m);
  const pts = new THREE.Points(geo, m);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  pts.onBeforeRender = (r, s, cam) => { const h = r.getDrawingBufferSize(_v2).y; m.uniforms.uScale.value = h / (2 * Math.tan((cam.fov || 60) * Math.PI / 360)); };
  return pts;
}

// ---- signs --------------------------------------------------------------------------------------

// the face style of a sign: the casino's board and the town's entry sign follow the town's style
const CASINO_FACE = { timber: 'oakgold', farm: 'barn', alpine: 'dwarf', frontier: 'hide', adobe: 'goblin' };
const ENTRY_FACE = { alpine: 'dwarf', frontier: 'hide', adobe: 'plaque' };
function signStyle(s, attached, ctx = {}) {
  if (s.flat) return 'daub';
  if (s.billboard) return 'billboard';
  if (s.neon) return CASINO_FACE[ctx.styleName] || 'oakgold';
  if (ctx.entry === s) return ENTRY_FACE[ctx.styleName] || 'carved';
  const { r, g, b } = new THREE.Color(s.bg && !s.bg.startsWith('rgba') ? s.bg : '#888');
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  return !attached && lum < 0.3 ? 'carved' : 'board';
}

// painted sign faces are cached across days (most signs come back)
const faceCache = new Map();
function faceCanvas(f, w, h) {
  const key = JSON.stringify([f.lines, w, h, f.bg, f.fg, f.style, f.seed]);
  if (!faceCache.has(key)) {
    if (faceCache.size > 80) faceCache.clear();
    faceCache.set(key, signCanvas(f.lines, { w, h, bg: f.bg, fg: f.fg, style: f.style, seed: f.seed }));
  }
  return faceCache.get(key);
}

// Pack sign faces into one canvas (shelf packing, at most 2048×1024, 32 px gutters with the edges
// extruded into them so low mips don't pull in the neighbours; transparent elsewhere, so a ragged hide
// face can be cut out with alphaTest); returns { tex, rect(i) → [u0, v0, u1, v1] }.
function signAtlas(faces) {
  const W = 2048, pad = 32, e = 14;
  let scale = 1;
  for (let tries = 0; tries < 12; tries++) {
    let x = pad, y = pad, rowH = 0;
    const rects = [];
    for (const f of faces) {
      const w = Math.round(f.px * scale), h = Math.round(f.px * scale * f.h / f.w);
      if (x + w + pad > W) { x = pad; y += rowH + pad; rowH = 0; }
      rects.push([x, y, w, h]); x += w + pad; rowH = Math.max(rowH, h);
    }
    const H = y + rowH + pad;
    if (H <= 1024) {
      const AH = Math.max(256, 1 << Math.ceil(Math.log2(H)));
      const cv = document.createElement('canvas'); cv.width = W; cv.height = AH;
      const g = cv.getContext('2d');
      faces.forEach((f, i) => {
        const [rx, ry, rw, rh] = rects[i];
        const sc = faceCanvas(f, rw, rh);
        g.drawImage(sc, 0, 0, rw, 1, rx, ry - e, rw, e);
        g.drawImage(sc, 0, rh - 1, rw, 1, rx, ry + rh, rw, e);
        g.drawImage(sc, 0, 0, 1, rh, rx - e, ry, e, rh);
        g.drawImage(sc, rw - 1, 0, 1, rh, rx + rw, ry, e, rh);
        for (const [sx, sy, dx, dy] of [[0, 0, rx - e, ry - e], [rw - 1, 0, rx + rw, ry - e], [0, rh - 1, rx - e, ry + rh], [rw - 1, rh - 1, rx + rw, ry + rh]]) g.drawImage(sc, sx, sy, 1, 1, dx, dy, e, e);
        g.drawImage(sc, rx, ry, rw, rh);
      });
      const t = own(canvasTex(cv));
      return { tex: t, rect: i => { const [rx, ry, rw, rh] = rects[i]; return [(rx + 0.5) / W, 1 - (ry + rh - 0.5) / AH, (rx + rw - 0.5) / W, 1 - (ry + 0.5) / AH]; } };
    }
    scale *= 0.86;
  }
  return null;
}

function remapUV(geo, [u0, v0, u1, v1]) {
  const a = geo.attributes.uv;
  for (let i = 0; i < a.count; i++) a.setXY(i, u0 + a.getX(i) * (u1 - u0), v0 + a.getY(i) * (v1 - v0));
  return geo;
}

// match building signs to their buildings (the sign hangs on the front, above the walls)
function matchSign(s, buildings) {
  if (s.post || s.billboard || s.flat) return null;
  for (const b of buildings) {
    const dx = s.x - b.x, dz = s.z - b.z, c = Math.cos(b.ry), sn = Math.sin(b.ry);
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    const da = Math.atan2(Math.sin(s.ry - b.ry), Math.cos(s.ry - b.ry));
    if (Math.abs(lx) < b.w / 2 + 0.5 && lz > b.dep / 2 - 0.8 && lz < b.dep / 2 + 1.8 && Math.abs(da) < 0.3) return { b, lx, ly: s.y - b.y };
  }
  return null;
}

// a brazier on a short iron bracket at (x, y, z) in the kit frame (out along +z)
function bracketBrazier(K, x, y, z, glows) {
  const im = mat('iron_wrought');
  K.box(im, 0.08, 0.08, 0.55, x, y - 0.25, z + 0.22, { tile: 0.5 });
  K.beam(im, [x, y - 0.75, z], [x, y - 0.28, z + 0.45], 0.05, 0.05);
  K.add(im, new THREE.CylinderGeometry(0.26, 0.12, 0.24, 9, 1, true), { uv: 'keep', at: matrix(x, y - 0.12, z + 0.45), receive: true });
  K.add(mat('embers', { emissive: '#ff8030', emissiveIntensity: 1 }), new THREE.SphereGeometry(0.22, 9, 4, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, y - 0.06, z + 0.45, 0, 0, 0, new THREE.Vector3(1, 0.35, 1)), shade: false, cast: false });
  flames(K, x, y - 0.04, z + 0.45, 0.2);
  glows.push({ p: V3(x, y + 0.25, z + 0.45).applyMatrix4(K.m).applyMatrix4(K.root), s: 2.2, fire: true });
}

// two mud pillars or stone cairns (kit frame), standing either side of a sign at ±px, up to top
function pillar(K, x, g0, top, kind, R) {
  if (kind === 'mud') {
    // a square mud-brick pier, tapering, its corners rounded off by the render (a squircle section, a
    // little lumpy), wrapped once round by the pier texture (fallen render, mud brick, drips under the
    // cap, splash at the foot); a mud cap on a timber lintel block, viga ends poking out front and back
    const h = top - g0, rb = 0.56, rt = 0.45;
    const sq = (v, lump) => { const a = Math.atan2(v.z, v.x), ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a)); const k = Math.pow(Math.pow(ca, 5) + Math.pow(sa, 5), -0.2) * (1 + lump * (0.03 * Math.sin(a * 3 + v.y * 2.1 + x) + 0.018 * Math.sin(v.y * 5.3 + a * 2))); v.x *= k; v.z *= k; };
    K.add(mat('adobe_pier'), new THREE.CylinderGeometry(rt, rb, h, 24, 6, true), { uv: 'keep', uvScale: [1, 1], uvOff: [x > 0 ? 0.37 : 0.04, 0], at: matrix(x, (g0 + top) / 2, 0), warp: v => sq(v, 1), ao: (vx, vy) => { const k = 0.7 + 0.2 * sstep(-h / 2, h / 2 - 0.3, vy); return [k, k * 0.96, k * 0.9]; } });
    const wl = mat('wood_light');
    K.add(mat('timber_dark'), new THREE.CylinderGeometry(rt + 0.06, rt + 0.05, 0.2, 24, 1), { uv: 'keep', uvScale: [4, 0.3], at: matrix(x, top + 0.08, 0), warp: v => sq(v, 0) });
    K.add(mat('adobe_inner'), new THREE.CylinderGeometry(rt + 0.02, rt + 0.08, 0.16, 24, 1), { uv: 'keep', uvScale: [2, 0.2], at: matrix(x, top + 0.26, 0), warp: v => sq(v, 1), tint: '#e8d4b8' });
    K.add(mat('adobe_inner'), new THREE.SphereGeometry(rt + 0.02, 24, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [2, 0.4], at: matrix(x, top + 0.33, 0, 0, 0, 0, new THREE.Vector3(1, 0.42, 1)), warp: v => { sq(v, 1); v.y *= 1 + 0.12 * Math.sin(v.x * 7 + x); }, tint: '#e8d4b8' });
    for (const dx of [-0.17, 0.17]) {
      const y = top - 0.28 + (dx > 0 ? 0.02 : -0.02), L = rb + 0.32;
      K.cyl(wl, [x + dx, y, -L], [x + dx + 0.01, y + 0.01, L], 0.085, 0.085, { sides: 8, tint: '#8a6448' });
      for (const s of [-1, 1]) K.add(mat('endgrain'), new THREE.CircleGeometry(0.083, 8), { uv: 'keep', at: matrix(x + dx + (s > 0 ? 0.01 : 0), y + (s > 0 ? 0.01 : 0), s * (L + 0.001), s > 0 ? 0 : Math.PI), tint: '#c8a888' });
    }
    return;
  }
  // a dressed granite pillar, tapering a little, a broad cap stone with snow on it, a cairn of rubble
  // piled round its foot
  const gm = mat('granite_block');
  K.box(gm, 0.6, top - g0, 0.6, x, (g0 + top) / 2, 0, { tile: 2, tint: '#d4cec4', seg: [1, 4, 1], warp: v => { const t = (v.y + (top - g0) / 2) / (top - g0); v.x *= 1 - 0.14 * t; v.z *= 1 - 0.14 * t; } });
  K.box(gm, 0.86, 0.26, 0.86, x, top + 0.1, 0, { tile: 2, tint: '#e0dad0' });
  K.add(gm, new THREE.ConeGeometry(0.5, 0.42, 4), { uv: 'keep', uvScale: [0.6, 0.4], at: matrix(x, top + 0.43, 0, Math.PI / 4), tint: '#e0dad0' });
  K.add(mat('snow_roof'), new THREE.SphereGeometry(0.5, 8, 4, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, top + 0.22, 0, 0, 0, 0, new THREE.Vector3(1, 0.35, 1)), cast: false });
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * TAU + R(), r = 0.28 + R() * 0.16, d = 0.5 + R() * 0.15;
    K.add(gm, new THREE.DodecahedronGeometry(r, 0), { uv: 'keep', uvScale: [0.5, 0.5], at: matrix(x + Math.cos(a) * d, g0 + 0.35 + r * 0.5, Math.sin(a) * d * 0.8, R() * 3, 0, 0, new THREE.Vector3(1.1, 0.7, 1)), tint: '#c8c2b8' });
  }
  K.add(mat('snow_roof'), new THREE.SphereGeometry(0.85, 10, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, g0 + 0.35, 0, 0, 0, 0, new THREE.Vector3(1, 0.3, 0.8)), cast: false });
}

// ---- the gate code on the rim ------------------------------------------------------------------

// The paint per biome (it must read against that day's rock, house paint over a primer wash of the
// opposite value), and the rock it is daubed on.
const RIM = {
  meadow: { paint: '#f2ead8', primer: '#2e2622', rock: 'rock_gray' },
  fields: { paint: '#7a2a1a', primer: '#efe4cc', rock: 'rock_warm' },
  snow: { paint: '#9a2a22', primer: '#ece4d6', edge: '#3a1a14', rock: 'rock_granite' },
  badlands: { paint: '#f4ecdc', primer: '#6a4622', rock: 'rock_red', top: 'rock_warm', topTint: [1.34, 0.88, 0.62], step: true },
  desert: { paint: '#7a2a1a', primer: '#efe4cc', rock: 'rock_sand' },
};

// The code daubed on a low, flat slab of rim rock (its top clears the grass, so nothing grows through
// the digits), with a stake beside it tied with a red rag that you can spot from the road. Only the paint
// is near-only (you have to climb up to read it); the slab and the stake are always there. The text reads
// the right way up for someone who climbed up from the road (its top points away from the road).
function rimCode(W, s, batch, group, near) {
  const P = RIM[W.biome] || RIM.meadow;
  const rx = W.roadX ? W.roadX(s.z) : 0;
  const yaw = Math.atan2(s.x - rx, 0) + Math.PI;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const toW = (lx, lz) => [s.x + lx * c + lz * sn, s.z - lx * sn + lz * c];
  const gy = (lx, lz) => { const [x, z] = toW(lx, lz); return W.heightAt(x, z); };
  const hx = s.w / 2 + 0.5, hz = s.h / 2 + 0.45;
  // a plane fitted to the ground under the slab (least squares on a symmetric grid), lifted clear of
  // every bump: the slab's top follows the slope but never dips into it
  const samp = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const lx = (i / 4 - 0.5) * 2.2 * hx, lz = (j / 4 - 0.5) * 2.2 * hz; samp.push([lx, lz, gy(lx, lz)]); }
  let sy = 0, sxy = 0, szy = 0, sxx = 0, szz = 0;
  for (const [lx, lz, y] of samp) { sy += y; sxy += lx * y; szy += lz * y; sxx += lx * lx; szz += lz * lz; }
  const a0 = sy / samp.length, bx = sxy / sxx, bz = szy / szz;
  // lifted clear of every bump under the paint (the slab's rim may sink into the ground on a curved rim:
  // it looks bedded in, and the painted middle stays clear of the grass)
  let lift = 0;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const lx = (i / 4 - 0.5) * (s.w + 0.3), lz = (j / 4 - 0.5) * (s.h + 0.3); lift = Math.max(lift, gy(lx, lz) - (a0 + bx * lx + bz * lz)); }
  const top0 = a0 + Math.min(lift, 0.6) + 0.24;
  const top = (lx, lz) => top0 + bx * lx + bz * lz;
  // the slab: a lumpy rounded-rectangle outline, a flat top, a broken bevelled lip, sides down into the ground
  const R = rng(Math.abs(Math.round(s.x * 7 + s.z * 13)) + 3);
  const n = 16, ring = [];
  for (let k = 0; k < n; k++) {
    const a = (k + (R() - 0.5) * 0.35) / n * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const r = 1 / Math.pow(Math.pow(Math.abs(ca), 4) + Math.pow(Math.abs(sa), 4), 0.25), j = 0.93 + R() * 0.12;
    ring.push([ca * r * hx * j, sa * r * hz * j]);
  }
  // UVs: the top projected straight down, the sides unrolled outward from the lip (no stretched bands)
  const pos = [], idx = [], uvs = [], T = 2.6;
  const vtx = (x, y, z, u = x, v = z) => { pos.push(x, y, z); uvs.push(u / T, v / T); return pos.length / 3 - 1; };
  const C0 = vtx(0, top(0, 0) - 0.004, 0);
  const inner = ring.map(([x, z]) => vtx(x * 0.86, top(x * 0.86, z * 0.86) - R() * 0.008, z * 0.86));
  const lipY = ring.map(([x, z]) => top(x, z) - 0.08 - R() * 0.07);
  // the profile down from the lip, ring by ring ({ s: scale of the outline, y }), the sides' UVs unrolled
  // outward along it. Most rims: one bed, its foot sunk 0.3 into the ground. The badlands: two beds, a
  // ledge between them, the lower one flaring out into the ground (a stepped ledge of strata, not a loaf).
  const prof = ring.map(([x, z], k) => {
    const r = Math.hypot(x, z) || 1, out = [{ s: 1, y: lipY[k] }];
    if (P.step) {
      const y1 = lipY[k] - 0.26 - R() * 0.06;
      out.push({ s: 1.03, y: y1 }, { s: 1.2 + R() * 0.04, y: y1 - 0.04 });
      const s2 = 1.34 + 0.25 * Math.min(1, Math.max(0, (y1 - gy(x * 1.34, z * 1.34) - 0.35) / 0.6));
      out.push({ s: s2, y: Math.min(gy(x * s2, z * s2), y1 - 0.2) - 0.35 });
    } else out.push({ s: 1.12, y: Math.min(gy(x * 1.12, z * 1.12), top(x, z) - 0.25) - 0.3 });
    let d = Math.hypot(x * 0.14, z * 0.14, 0.1);
    return out.map((q, i) => {
      if (i) d += Math.hypot(r * (q.s - out[i - 1].s), q.y - out[i - 1].y);
      const e = (0.86 * r + d) / (0.86 * r);
      return vtx(x * q.s, q.y, z * q.s, x * 0.86 * e, z * 0.86 * e);
    });
  });
  // the top (and its lip) and the sides as two index lists: on the badlands the sides show the strata and
  // the top is the plain sun-baked face of one bed
  const side = P.step ? [] : idx;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    idx.push(C0, inner[k2], inner[k]);
    idx.push(inner[k], prof[k2][0], prof[k][0], inner[k], inner[k2], prof[k2][0]);
    for (let i = 0; i < prof[k].length - 1; i++) { const a = prof[k][i], b = prof[k2][i], c = prof[k][i + 1], d = prof[k2][i + 1]; side.push(a, d, c, a, b, d); }
  }
  const mk = ix => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(ix); g.computeVertexNormals(); return g; };
  const K = new Kit(batch, matrix(s.x, 0, s.z, yaw), (x, y, z, nx, ny) => { const k = 0.6 + 0.4 * Math.max(0, ny); return [k * 0.94, k * 0.96, k]; });
  K.seed = 5 + (R() * 1000 | 0);
  if (P.step) { K.add(mat(P.top), mk(idx), { uv: 'keep', tint: P.topTint }); K.add(mat(P.rock), mk(side), { uv: 'keep' }); }
  else K.add(mat(P.rock), mk(idx), { uv: 'keep', tint: P.tint || null });
  if (W.biome === 'snow') {
    // snow drifted onto both ends of the slab (clear of the paint): soft overlapping heaps sunk into the
    // rock, spilling over the lip
    const sm = mat('snow_roof');
    for (const sgn of [-1, 1]) {
      // one long drift lying along the end, sunk ~45% into the rock and spilling over the lip, with two or
      // three smaller lumps beside it along the lip (soft shading, so they melt into one heap)
      const soft = (px, py, pz, nx, ny) => { const k = 0.92 + 0.08 * Math.max(0, ny); return [k * 0.93, k * 0.97, k]; };
      const r0 = 0.3 + R() * 0.05, cx = sgn * hx * (0.84 + R() * 0.04), cz = (R() - 0.5) * hz * 0.2;
      K.add(sm, new THREE.SphereGeometry(r0, 16, 10), { uv: 'keep', uvScale: [2, 0.8], at: matrix(cx, top(cx, cz) - r0 * 0.42 * 0.45, cz, (R() - 0.5) * 0.15, 0, 0, new THREE.Vector3(0.95, 0.42, hz * 0.68 / r0)), shade: soft, cast: false });
      for (let i = 0, m = 1 + Math.floor(R() * 2); i < m; i++) {
        // a lump slumping off the outer side of the drift, over the lip (low, never perched on top)
        const z = cz + (i % 2 ? 1 : -1) * hz * (0.15 + R() * 0.3), x = cx + sgn * r0 * (0.55 + R() * 0.25), r = 0.16 + R() * 0.06;
        K.add(sm, new THREE.SphereGeometry(r, 16, 10), { uv: 'keep', uvScale: [1, 0.6], at: matrix(x, top(x, z) - 0.06 - r * 0.35 * 0.4, z, (R() - 0.5) * 0.6, 0, 0, new THREE.Vector3(1.3, 0.35, 1.9)), shade: soft, cast: false });
      }
    }
  }
  // the stake: a crooked pole driven in by the slab's road-side corner (you can spot the rag from the
  // road below), a red rag knotted near its top
  const sx = hx + 0.25, sz = hz * 0.35, g0 = gy(sx, sz);
  const lean = [0.14, 0.06];
  const tipY = g0 + 2.4;
  K.tube(mat('wood_light'), [[sx, g0 - 0.3, sz], [sx + lean[0] * 0.5, g0 + 0.8, sz + lean[1] * 0.5], [sx + lean[0], tipY, sz + lean[1]]], [0.055, 0.048, 0.04], { sides: 6, tint: '#a8865e', tile: 1.6 });
  K.add(mat('wood_light'), new THREE.ConeGeometry(0.04, 0.14, 6), { uv: 'keep', at: matrix(sx + lean[0], tipY + 0.07, sz + lean[1]), tint: '#c8a478' });
  const rag = mat('arch_rag', { alphaTest: 0.5, side: THREE.DoubleSide });
  const ky = tipY - 0.2, kx = sx + lean[0] * 0.92, kz = sz + lean[1] * 0.92;
  K.add(rag, new THREE.TorusGeometry(0.06, 0.03, 5, 8), { uv: 'keep', uvScale: [0.6, 0.4], at: matrix(kx, ky, kz, 0, Math.PI / 2) });
  for (const [ry, L, w] of [[0.4, 0.85, 0.22], [-0.5, 0.6, 0.16]]) {
    K.push(kx, ky, kz, Math.PI / 2 + ry);
    K.add(rag, new THREE.PlaneGeometry(w, L, 1, 4), { uv: 'keep', at: matrix(0.06 + L * 0.25, -L * 0.4, 0, 0, 0, 0.9 + ry * 0.2), warp: v => { v.z += 0.05 * Math.sin(v.y * 9 + ry * 5); v.x += 0.03 * Math.sin(v.y * 6); }, shade: () => 0.95 });
    K.pop();
  }
  // the paint
  const px = 640, ph = Math.round(px * s.h / s.w);
  const cv = signCanvas(s.lines, { w: px, h: ph, style: 'daub', fg: P.paint, bg: P.primer, edge: P.edge || null, seed: String(s.lines[0]) });
  const t = own(canvasTex(cv));
  const dg = new THREE.PlaneGeometry(s.w, s.h, 6, 4);
  const pa = dg.attributes.position;
  for (let i = 0; i < pa.count; i++) { const lx = pa.getX(i), lz = -pa.getY(i); pa.setXYZ(i, lx, top(lx, lz) + 0.012, lz); }
  dg.computeVertexNormals();
  const m = new THREE.Mesh(dg, own(new THREE.MeshLambertMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
  m.position.set(s.x, 0, s.z);
  m.rotation.y = yaw;
  m.renderOrder = 2;
  m.receiveShadow = true;
  m.visible = false;
  near.push({ mesh: m, x: s.x, y: top0, z: s.z, r: s.near || 10 });
  group.add(m);
}

function buildSigns(W, batch, group, near, ctx) {
  const faces = [];
  const items = [];
  for (const s of W.signs) {
    if (s.flat) { rimCode(W, s, batch, group, near); continue; }
    const att = ctx.attached.get(s) || null, can = ctx.onCanopy && ctx.onCanopy.get(s);
    const style = signStyle(s, !!(att || can), ctx);
    const px = Math.max(256, Math.min(900, Math.round(s.w * (style === 'billboard' ? 112 : 104))));
    items.push({ s, att, style, fi: faces.length });
    faces.push({ lines: s.lines, w: s.w, h: s.h, px, bg: s.bg, fg: s.fg, style, seed: `${Math.round(s.x)},${Math.round(s.z)}` });
  }
  for (const t of ctx.tags) { t.fi = faces.length; faces.push({ lines: t.lines, w: t.w, h: t.h, px: 260, bg: '#e8d8b0', fg: '#2a1e18', style: 'board', seed: t.lines[0] }); }
  for (const t of ctx.plaques || []) { t.fi = faces.length; faces.push({ lines: t.lines, w: t.w, h: t.h, px: 200, bg: '#c8a050', fg: '#2e2008', style: 'plaque', seed: t.lines[0] }); }
  // painted pieces the buildings hang on their walls (the pawnbroker's map), from buildBuilding's faces
  const wallFaces = [...(ctx.bInfo ? ctx.bInfo.values() : [])].flatMap(i => i.faces || []);
  for (const t of wallFaces) { t.fi = faces.length; faces.push({ lines: [t.style], w: t.w, h: t.h, px: 240, style: t.style, seed: t.seed }); }
  const atlas = faces.length ? signAtlas(faces) : null;
  if (!atlas) return;
  // two face materials: lamp-lit boards (casino, billboards, the canopy sign) glow more at night
  const faceLit = own(new THREE.MeshLambertMaterial({ map: atlas.tex, emissiveMap: atlas.tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0, vertexColors: true, alphaTest: 0.5 }));
  const faceDim = own(new THREE.MeshLambertMaterial({ map: atlas.tex, emissiveMap: atlas.tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0, vertexColors: true, alphaTest: 0.5 }));
  ctx.faces = { lit: faceLit, dim: faceDim };
  const S = ctx.style, nm = S.name || ctx.styleName;
  const wood = mat('timber_dark'), iron = mat('iron_wrought'), br = mat('brass');
  const R = rng(17 + (W.seed || 0));
  // price boards stand on the counter behind the goods, leaning back, facing the customer
  for (const t of ctx.tags) {
    const K = new Kit(batch, matrix(t.u.x, t.u.y - 0.1, t.u.z, ctx.tagRy || 0), () => 1);
    K.push(0, 0.2, -0.2, 0, -0.22);
    K.box(wood, t.w + 0.06, t.h + 0.06, 0.03, 0, 0, -0.016, { grain: 'x', seg: [1, 1, 1] });
    K.add(faceDim, remapUV(new THREE.PlaneGeometry(t.w, t.h), atlas.rect(t.fi)), { uv: 'keep', at: matrix(0, 0, 0.001), shade: false, cast: false });
    K.box(wood, 0.04, 0.24, 0.03, 0, -0.17, -0.03, { seg: [1, 1, 1] });
    K.pop();
  }
  for (const t of ctx.plaques || []) {
    const K = new Kit(batch, matrix(t.u.x, t.u.y - 0.04 + t.lift, t.u.z, t.ry), () => 1);
    K.push(0, -t.drop, t.out, 0, -0.62);
    K.box(br, t.w + 0.05, t.h + 0.05, 0.025, 0, 0, -0.014, { tile: 1, seg: [1, 1, 1] });
    K.add(faceDim, remapUV(new THREE.PlaneGeometry(t.w, t.h), atlas.rect(t.fi)), { uv: 'keep', at: matrix(0, 0, 0.0005), shade: false, cast: false });
    for (const sx of [-1, 1]) K.add(br, new THREE.SphereGeometry(0.012, 5, 4), { uv: 'keep', at: matrix(sx * (t.w / 2 + 0.008), 0, 0.002) });
    K.pop();
    K.beam(br, [0, -t.drop - 0.02, t.out - 0.04], [0, -0.05, 0.06], 0.025, 0.02);
  }
  for (const t of wallFaces) new Kit(batch, t.m, () => 0.84).add(faceDim, remapUV(new THREE.PlaneGeometry(t.w, t.h), atlas.rect(t.fi)), { uv: 'keep', cast: false });
  const shadeSign = () => 1;
  for (const it of items) {
    const { s, att, style } = it;
    const uv = atlas.rect(it.fi);
    const lit = s.neon || style === 'billboard';
    const face = (K, z, back = false, m = lit ? faceLit : faceDim) => K.add(m, remapUV(new THREE.PlaneGeometry(s.w, s.h), uv), { uv: 'keep', at: matrix(0, 0, z, back ? Math.PI : 0), shade: false, cast: false });
    const can = ctx.onCanopy && ctx.onCanopy.get(s);
    if (can) {
      // standing on the ridge of the pump canopy on iron brackets, lanterns at its ends, painted both sides
      const K = new Kit(batch, matrix(can.x, can.y, can.z, can.ry), shadeSign);
      const yb = 1.02 + s.h / 2 + 0.11;
      K.push(0, yb, 0);
      K.box(wood, s.w + 0.22, s.h + 0.22, 0.1, 0, 0, 0, { tile: 1.2, grain: 'x', seg: [1, 1, 1] });
      face(K, 0.052, false, faceLit); face(K, -0.052, true, faceLit);
      for (const sx of [-1, 1]) {
        K.box(iron, 0.07, 0.34, 0.07, sx * s.w * 0.36, -s.h / 2 - 0.25, 0, { tile: 0.5 });
        K.box(iron, 0.3, 0.05, 0.22, sx * s.w * 0.36, -s.h / 2 - 0.4, 0, { tile: 0.5 });
        lantern({ glows: ctx.glows }, [sx * (s.w / 2 + 0.25), -s.h / 2 + 0.1, 0], 0.38, false, K);
      }
      K.pop();
      continue;
    }
    if (att) {
      // on the building's front, in front of its gable / false front / parapet
      const info = ctx.bInfo.get(att.b);
      const K = new Kit(batch, info.frame, shadeSign);
      K.push(att.lx, att.ly, info.signZ);
      const hw = s.w / 2, hh = s.h / 2;
      if (style === 'oakgold') {
        // Goldshire: a thick carved-oak board hung out from the gable on two wrought-iron scroll brackets
        // by short chains, a lantern on an arm at each end
        K.push(0, 0, 0.3);
        K.box(mat('wood_light'), s.w + 0.4, s.h + 0.4, 0.18, 0, 0, -0.08, { tile: 1.2, grain: 'x', tint: '#a07050', seg: [2, 1, 1] });
        face(K, 0.016);
        for (const sx of [-1, 1]) {
          const x = sx * (hw - 0.4);
          K.tube(iron, [[x, hh + 0.75, -0.45], [x, hh + 0.82, -0.1], [x, hh + 0.74, 0.12], [x, hh + 0.55, 0.16], [x, hh + 0.5, 0.02], [x, hh + 0.6, -0.05]], 0.035, { sides: 5, caps: false });
          K.beam(iron, [x, hh + 0.2, -0.45], [x, hh + 0.75, -0.45], 0.05, 0.05);
          for (let k = 0; k < 3; k++) K.add(iron, new THREE.TorusGeometry(0.04, 0.012, 4, 8), { uv: 'keep', at: matrix(x, hh + 0.27 + k * 0.08, 0.1, k % 2 ? Math.PI / 2 : 0) });
          K.beam(iron, [sx * (hw + 0.2), -hh * 0.3, -0.45], [sx * (hw + 0.62), -hh * 0.3 + 0.35, 0.05], 0.04, 0.04);
          lantern({ glows: ctx.glows }, [sx * (hw + 0.62), -hh * 0.3 + 0.05, 0.08], 0.48, true, K);
        }
        K.pop();
      } else if (style === 'barn') {
        // Westfall: the letters painted straight onto the barn's boards; a cartwheel above with four lanterns
        face(K, -0.06);
        const wy = hh + 1.0;
        cartwheel(K, 0, wy, 0.02, 0.85, R() * 3);
        for (const a of [-2.6, -1.95, -1.2, -0.55]) {
          const x = Math.cos(a) * 0.85, y = wy + Math.sin(a) * 0.85;
          K.beam(iron, [x, y, 0.05], [x * 1.25, y + 0.05, 0.5], 0.035, 0.035);
          lantern({ glows: ctx.glows }, [x * 1.25, y - 0.3, 0.5], 0.42, true, K);
        }
      } else if (style === 'dwarf') {
        // Kharanos: an iron-bound board under a heavy granite lintel, a brazier on a bracket each side
        K.box(wood, s.w + 0.3, s.h + 0.3, 0.16, 0, 0, -0.06, { tile: 1.2, grain: 'x', seg: [2, 1, 1] });
        face(K, 0.025);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          K.box(iron, 0.5, 0.1, 0.05, sx * (hw - 0.1), sy * (hh + 0.1), 0.04, { tile: 0.5 });
          K.box(iron, 0.1, 0.5, 0.05, sx * (hw + 0.1), sy * (hh - 0.1), 0.04, { tile: 0.5 });
          K.add(br, new THREE.SphereGeometry(0.05, 6, 4), { uv: 'keep', at: matrix(sx * (hw + 0.1), sy * (hh + 0.1), 0.07) });
        }
        K.box(mat('granite_block'), s.w + 1.0, 0.42, 0.62, 0, hh + 0.38, 0.08, { tile: 2, tint: '#d8d2c8', warp: v => { if (v.y > 0) v.z *= 0.9; } });
        K.box(mat('granite_block'), 0.6, 0.6, 0.7, 0, hh + 0.42, 0.1, { tile: 2, tint: '#e2dcd2' });
        K.box(mat('snow_roof'), s.w + 1.06, 0.12, 0.66, 0, hh + 0.64, 0.08, { tile: 2, seg: [6, 1, 2], warp: v => { v.y += 0.04 * Math.sin(v.x * 3.7); } });
        for (const sx of [-1, 1]) bracketBrazier(K, sx * (hw + 0.75), 0.1, -0.05, ctx.glows);
      } else if (style === 'hide') {
        // the canyon outpost: a hide stretched on a frame of poles with rope lacing, a horned skull on top
        const wl = mat('wood_light'), rope = mat('rope'), bone = mat('arch_bone');
        face(K, 0.02);
        const fx = hw + 0.28, fy = hh + 0.25;
        for (const sy of [-1, 1]) K.cyl(wl, [-fx - 0.25, sy * fy, 0.05], [fx + 0.25, sy * fy + (R() - 0.5) * 0.1, 0.05], 0.08, 0.075, { sides: 7, tint: '#9a7a56' });
        for (const sx of [-1, 1]) K.cyl(wl, [sx * fx, -fy - 0.4, 0.08], [sx * fx + (R() - 0.5) * 0.1, fy + 0.45, 0.08], 0.085, 0.075, { sides: 7, tint: '#a8865e' });
        for (let k = 0; k < 7; k++) { const t = (k + 0.5) / 7, x = -hw + s.w * t; for (const sy of [-1, 1]) K.cyl(rope, [x, sy * (hh - 0.06), 0.03], [x + (R() - 0.5) * 0.1, sy * fy, 0.06], 0.012, 0.012, { sides: 4 }); }
        for (let k = 0; k < 3; k++) { const y = -hh + s.h * (k + 0.5) / 3; for (const sx of [-1, 1]) K.cyl(rope, [sx * (hw - 0.06), y, 0.03], [sx * fx, y + (R() - 0.5) * 0.1, 0.08], 0.012, 0.012, { sides: 4 }); }
        K.add(bone, new THREE.SphereGeometry(0.28, 10, 8), { uv: 'keep', at: matrix(0, fy + 0.25, 0.12, 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)) });
        K.add(bone, new THREE.BoxGeometry(0.26, 0.18, 0.28), { uv: 'keep', at: matrix(0, fy + 0.04, 0.32) });
        for (const sx of [-1, 1]) K.tube(bone, [[sx * 0.22, fy + 0.35, 0.08], [sx * 0.6, fy + 0.55, 0.06], [sx * 0.85, fy + 0.95, 0], [sx * 0.75, fy + 1.15, -0.02]], [0.09, 0.07, 0.04, 0.012], { sides: 6 });
        for (const sx of [-1, 1]) { K.beam(iron, [sx * (fx + 0.1), 0.1, -0.05], [sx * (fx + 0.5), 0.35, 0.4], 0.04, 0.04); lantern({ glows: ctx.glows }, [sx * (fx + 0.5), 0.05, 0.42], 0.44, true, K); }
      } else if (style === 'goblin') {
        // Gadgetzan: a riveted brass marquee, a dozen bulbs, gears at its ends and a steam pipe along the top
        K.box(br, s.w + 0.36, s.h + 0.36, 0.2, 0, 0, -0.06, { tile: 1, seg: [2, 1, 1] });
        face(K, 0.045);
        const bm = glassMat();
        for (let k = 0; k < 12; k++) {
          const top = k < 6, t = ((k % 6) + 0.5) / 6, x = -hw + s.w * t, y = top ? hh + 0.12 : -hh - 0.12;
          K.add(bm, new THREE.SphereGeometry(0.09, 8, 6), { uv: 'keep', at: matrix(x, y, 0.1), shade: false, cast: false });
          K.add(br, new THREE.CylinderGeometry(0.06, 0.06, 0.06, 8), { uv: 'keep', at: matrix(x, y, 0.04, 0, Math.PI / 2) });
          if (k % 2 === 0) ctx.glows.push({ p: V3(x, y, 0.15).applyMatrix4(K.m).applyMatrix4(K.root), s: 1.0, col: '#ffd890' });
        }
        for (const sx of [-1, 1]) {
          const gx = sx * (hw + 0.38), gr = Math.min(0.55, hh + 0.05);
          K.push(gx, 0, 0.0, 0);
          K.add(br, new THREE.CylinderGeometry(gr, gr, 0.12, 18), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2) });
          for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; K.box(br, gr * 0.28, gr * 0.28, 0.12, Math.cos(a) * gr * 1.1, Math.sin(a) * gr * 1.1, 0, { rz: a, tile: 1 }); }
          K.add(mat('metal_red'), new THREE.CylinderGeometry(gr * 0.35, gr * 0.35, 0.18, 10), { uv: 'keep', at: matrix(0, 0, 0.02, 0, Math.PI / 2) });
          K.pop();
        }
        K.cyl(br, [-hw - 0.2, hh + 0.38, 0.05], [hw + 0.2, hh + 0.38, 0.05], 0.07, 0.07, { sides: 8 });
        K.cyl(br, [hw * 0.55, hh + 0.38, 0.05], [hw * 0.55, hh + 0.75, 0.05], 0.06, 0.06, { sides: 8 });
        K.add(br, new THREE.TorusGeometry(0.12, 0.03, 5, 10), { uv: 'keep', at: matrix(hw * 0.55, hh + 0.8, 0.05, 0, Math.PI / 2) });
      } else {
        K.box(wood, s.w + 0.22, s.h + 0.22, 0.1, 0, 0, -0.03, { tile: 1.2, grain: 'x', seg: [1, 1, 1] });
        face(K, 0.025);
        if (nm === 'adobe') {
          // goblin work: brass gears at the top corners, chains up to the parapet
          for (const sx of [-1, 1]) {
            const x = sx * (hw + 0.02);
            K.push(x, hh + 0.02, 0.06);
            K.add(br, new THREE.CylinderGeometry(0.2, 0.2, 0.06, 14), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2) });
            for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.box(br, 0.07, 0.07, 0.06, Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0, { rz: a, tile: 1 }); }
            K.pop();
            for (let k = 0; k < 4; k++) K.add(iron, new THREE.TorusGeometry(0.04, 0.012, 4, 8), { uv: 'keep', at: matrix(x * 0.96, hh + 0.28 + k * 0.08, 0.06, k % 2 ? Math.PI / 2 : 0) });
          }
        } else {
          // iron corner brackets holding it off the wall (never across the lettering)
          for (const sx of [-1, 1]) {
            const x = sx * (hw + 0.06);
            K.box(iron, 0.06, s.h + 0.3, 0.05, x, 0, 0.04, { tile: 0.5 });
            for (const sy of [-1, 1]) {
              K.box(iron, 0.24, 0.05, 0.04, x - sx * 0.1, sy * (hh + 0.1), 0.045, { tile: 0.5 });
              K.add(iron, new THREE.SphereGeometry(0.035, 6, 4), { uv: 'keep', at: matrix(x - sx * 0.18, sy * (hh + 0.1), 0.07) });
            }
            K.box(iron, 0.06, 0.06, 0.3, x, hh + 0.12, -0.12, { tile: 0.5 });
          }
        }
      }
      K.pop();
      continue;
    }
    // free-standing: roadside boards and billboards. Posts stand OUTSIDE the board, nothing crosses a face.
    const lean = ((Math.sin(s.x * 12.9 + s.z * 78.2) * 43758.5) % 1) * 0.03;
    const hw = s.w / 2, hh = s.h / 2;
    if (style === 'billboard') {
      // turned to face the drivers coming from camp; the lettering on that side only, bare boards and
      // bracing behind
      const yaw = Math.PI - s.ry;
      const K = new Kit(batch, matrix(s.x, s.y, s.z, yaw, 0, lean), shadeSign);
      const ground = lx => W.heightAt(s.x + Math.cos(yaw) * lx, s.z - Math.sin(yaw) * lx) - s.y;
      K.box(wood, s.w + 0.34, s.h + 0.34, 0.14, 0, 0, 0, { tile: 1.6, grain: 'x', tint: '#e8d0b8', seg: [2, 1, 1] });
      face(K, 0.072);
      K.quad(wood, s.w + 0.3, s.h + 0.3, 0, 0, -0.072, { ry: Math.PI, uv: 'keep', uvScale: [(s.w + 0.3) / 1.2, (s.h + 0.3) / 1.2], tint: '#f0dcc8' });
      for (let x = -hw + 0.4; x < hw - 0.2; x += 0.42) K.box(wood, 0.035, s.h + 0.3, 0.02, x, 0, -0.085, { tint: '#5a4840', seg: [1, 1, 1] });
      const px = hw + 0.17 + 0.17;
      let gmax = -99;
      for (const sx of [-1, 1]) {
        const g0 = ground(sx * px) - 0.4; gmax = Math.max(gmax, g0);
        K.box(wood, 0.32, hh + 0.65 - g0, 0.32, sx * px, (g0 + hh + 0.65) / 2, -0.05, { tile: 1.2, seg: [1, 3, 1] });
        K.add(wood, new THREE.ConeGeometry(0.24, 0.38, 4), { uv: 'keep', at: matrix(sx * px, hh + 0.84, -0.05, Math.PI / 4) });
        for (const sy of [-1, 1]) K.box(wood, 0.36, 0.08, 0.2, sx * (hw + 0.17), sy * hh * 0.6, -0.02, { tile: 0.5, tint: '#6a6060' });
      }
      K.beam(wood, [-px, -hh + 0.1, -0.3], [px, hh - 0.1, -0.3], 0.16, 0.12);
      K.beam(wood, [px, -hh + 0.1, -0.34], [-px, hh - 0.1, -0.34], 0.16, 0.12);
      K.box(wood, 2 * px, 0.16, 0.14, 0, -hh - 0.25, -0.05, { grain: 'x', tile: 1.2 });
      if (gmax + 0.6 < -hh - 0.4) { K.beam(wood, [-px, gmax + 0.6, -0.12], [px, -hh - 0.35, -0.12], 0.14, 0.1); K.beam(wood, [px, gmax + 0.6, -0.16], [-px, -hh - 0.35, -0.16], 0.14, 0.1); }
      K.box(wood, s.w + 0.9, 0.1, 0.95, 0, hh + 0.4, 0, { tile: 1.6, grain: 'z', tint: '#d8c0a8', seg: [3, 1, 1], warp: v => { v.y += (0.47 - Math.abs(v.z)) * 0.35; } });
      if (nm === 'alpine') K.box(mat('snow_roof'), s.w + 0.8, 0.12, 0.9, 0, hh + 0.58, 0, { tile: 2, seg: [4, 1, 2], warp: v => { v.y += (0.45 - Math.abs(v.z)) * 0.32 + 0.03 * Math.sin(v.x * 4); } });
      for (const sx of [-0.3, 0.3]) {
        K.beam(iron, [sx * s.w, hh + 0.3, 0.02], [sx * s.w, hh + 0.36, 0.62], 0.035, 0.035);
        lantern({ glows: ctx.glows }, [sx * s.w, hh + 0.1, 0.62], 0.4, true, K);
      }
      continue;
    }
    const K = new Kit(batch, matrix(s.x, s.y, s.z, s.ry, 0, lean), shadeSign);
    const ground = lx => W.heightAt(s.x + Math.cos(s.ry) * lx, s.z - Math.sin(s.ry) * lx) - s.y;
    const isEntry = ctx.entry === s;
    if (isEntry && style === 'hide') {
      // the outpost's name on a hide lashed between two sharpened stakes, a skull on each
      const wl = mat('wood_light'), rope = mat('rope'), bone = mat('arch_bone');
      face(K, 0.02); face(K, -0.02, true);
      const px = hw + 0.3;
      for (const sx of [-1, 1]) {
        const g0 = ground(sx * px) - 0.4, top = hh + 0.9 + R() * 0.3;
        K.tube(wl, [[sx * px, g0, 0], [sx * px + sx * 0.04, (g0 + top) / 2, 0.02], [sx * (px + 0.06), top, 0]], [0.14, 0.12, 0.1], { sides: 7, tint: '#9a7a56', tile: 1.6 });
        K.add(wl, new THREE.ConeGeometry(0.1, 0.3, 7), { uv: 'keep', at: matrix(sx * (px + 0.06), top + 0.15, 0), tint: '#c8a478' });
        K.add(bone, new THREE.SphereGeometry(0.17, 9, 7), { uv: 'keep', at: matrix(sx * (px + 0.06), top - 0.25, 0.12, 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)) });
        K.add(bone, new THREE.BoxGeometry(0.15, 0.11, 0.17), { uv: 'keep', at: matrix(sx * (px + 0.06), top - 0.38, 0.24) });
        for (let k = 0; k < 4; k++) { const y = -hh + s.h * (k + 0.5) / 4; K.cyl(rope, [sx * (hw - 0.06), y, 0], [sx * px, y + (R() - 0.5) * 0.1, 0], 0.014, 0.014, { sides: 4 }); }
      }
      continue;
    }
    if (isEntry && style === 'plaque') {
      // two lumpy mud pillars with a brass plaque between them on a beam, a gear on each pillar
      const px = hw + 0.74;
      K.box(wood, s.w + 0.25, s.h + 0.25, 0.12, 0, 0, 0, { tile: 1.6, grain: 'x', tint: '#c8a080' });
      for (const sx of [-1, 1]) K.box(wood, px - hw - 0.1, 0.16, 0.14, sx * (hw + (px - hw) / 2), hh * 0.5, 0, { grain: 'x', tint: '#c8a080' });
      face(K, 0.062); face(K, -0.062, true);
      for (const sx of [-1, 1]) {
        const g0 = ground(sx * px) - 0.4;
        pillar(K, sx * px, g0, hh + 0.75, 'mud', R);
        const fz = 0.56 - 0.11 * (hh * 0.2 - g0) / (hh + 0.75 - g0) + 0.03;
        K.push(sx * px, hh * 0.2, fz);
        K.add(br, new THREE.CylinderGeometry(0.22, 0.22, 0.06, 14), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2) });
        for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.box(br, 0.08, 0.08, 0.06, Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0, { rz: a, tile: 1 }); }
        K.pop();
      }
      // a round viga lintel across both piers, its ends standing well proud of them, dark drips under it
      const LL = px + 0.85;
      K.cyl(mat('wood_light'), [-LL, hh + 0.3, 0], [LL, hh + 0.34, 0.02], 0.14, 0.13, { sides: 10, tint: '#9a7454', uvScale: [1, 4] });
      for (const sx of [-1, 1]) K.add(mat('endgrain'), new THREE.CircleGeometry(0.135, 10), { uv: 'keep', at: matrix(sx * (LL + 0.002), hh + 0.32, 0.01, sx * Math.PI / 2), tint: '#d0b090' });
      continue;
    }
    if (isEntry && style === 'dwarf') {
      // a stone cairn either side, an iron-framed board between them under a little snow
      const px = hw + 0.5;
      K.box(wood, s.w + 0.16, s.h + 0.16, 0.12, 0, 0, 0, { tile: 1.6, grain: 'x', seg: [1, 1, 1] });
      face(K, 0.062); face(K, -0.062, true);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) K.box(iron, s.w * 0.5 + 0.1, 0.08, 0.16, sx * s.w * 0.25, sy * (hh + 0.08), 0, { tile: 0.5 });
      for (const sx of [-1, 1]) { K.box(iron, 0.08, s.h + 0.24, 0.16, sx * (hw + 0.08), 0, 0, { tile: 0.5 }); K.box(iron, 0.5, 0.1, 0.12, sx * (hw + 0.3), hh * 0.5, 0, { tile: 0.5 }); K.box(iron, 0.5, 0.1, 0.12, sx * (hw + 0.3), -hh * 0.5, 0, { tile: 0.5 }); pillar(K, sx * px, ground(sx * px) - 0.4, hh + 0.4, 'cairn', R); }
      K.box(mat('snow_roof'), s.w + 0.3, 0.1, 0.2, 0, hh + 0.16, 0, { tile: 2, seg: [4, 1, 1], warp: v => { v.y += 0.03 * Math.sin(v.x * 5); } });
      continue;
    }
    // a board hung between two sharpened posts under a crossbar, painted both sides
    const inTown = ctx.townZ !== undefined && s.z > ctx.townZ - 25;
    K.box(wood, s.w + 0.16, s.h + 0.16, 0.1, 0, 0, 0, { tile: 1.6, grain: 'x', tint: '#e8d0b8', seg: [1, 1, 1] });
    face(K, 0.052); face(K, -0.052, true);
    const px = hw + 0.08 + 0.14, topY = hh + 0.55;
    for (const sx of [-1, 1]) {
      const g0 = ground(sx * px) - 0.3;
      if (nm === 'frontier') {
        K.tube(wood, [[sx * px, g0, 0], [sx * px + sx * 0.03, (g0 + topY) / 2, 0.02], [sx * px, topY, 0]], [0.13, 0.12, 0.11], { sides: 7, tint: '#f0d8c0', tile: 1.6 });
        K.add(wood, new THREE.ConeGeometry(0.11, 0.3, 7), { uv: 'keep', at: matrix(sx * px, topY + 0.15, 0), tint: '#f8e4d0' });
      } else {
        K.box(wood, 0.2, topY - g0, 0.2, sx * px, (g0 + topY) / 2, 0, { tile: 1.2, seg: [1, 2, 1] });
        K.add(wood, new THREE.ConeGeometry(0.15, 0.26, 4), { uv: 'keep', at: matrix(sx * px, topY + 0.13, 0, Math.PI / 4) });
      }
      for (const sy of [-1, 1]) K.box(wood, 0.3, 0.06, 0.24, sx * (hw + 0.13), sy * hh * 0.55, 0, { tile: 0.5, tint: '#6a6060' });
    }
    K.box(wood, s.w + 0.8, 0.14, 0.16, 0, hh + 0.36, 0, { grain: 'x', tile: 1.2 });
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) K.add(wood, new THREE.TorusGeometry(0.035, 0.011, 4, 8), { uv: 'keep', at: matrix(sx * (hw - 0.35), hh + 0.13 + k * 0.06, 0, k % 2 ? Math.PI / 2 : 0), tint: '#605858' });
    if (s.w >= 4) {
      K.box(inTown && S.roof && S.roof !== 'thatch' && S.roof !== 'hide_patch' ? mat(S.roof) : wood, s.w + 1.0, 0.08, 0.62, 0, hh + 0.66, 0, { tile: 2, seg: [3, 1, 1], warp: v => { v.y += (0.31 - Math.abs(v.z)) * 0.4; } });
      if (nm === 'alpine') K.box(mat('snow_roof'), s.w + 0.9, 0.12, 0.6, 0, hh + 0.8, 0, { tile: 2, seg: [4, 1, 2], warp: v => { v.y += (0.3 - Math.abs(v.z)) * 0.35 + 0.03 * Math.sin(v.x * 4); } });
    } else if (nm === 'alpine') K.box(mat('snow_roof'), s.w + 0.7, 0.1, 0.24, 0, hh + 0.48, 0, { tile: 2, seg: [4, 1, 1], warp: v => { v.y += 0.03 * Math.sin(v.x * 5); } });
    if (isEntry && nm === 'farm') {
      // Westfall: a cartwheel leaning on a post, a hay bale at its foot
      const g0 = ground(px + 0.6);
      K.push(px + 0.35, 0, 0.25, 0, 0.18, 0);
      cartwheel(K, 0, g0 + 0.72, 0, 0.7, 0.4);
      K.pop();
      hayBale(K, -px - 0.5, 0.35, 0.3, ground(-px - 0.5));
      hayBale(K, -px - 0.45, -0.5, -0.2, ground(-px - 0.45));
    }
  }
}

// ---- street lamps, one design per style -----------------------------------------------------------

function lampPost(batch, d, style, glows) {
  const ry = d.x > 0 ? Math.PI : 0;     // the arm reaches toward the street
  const lean = ((Math.sin(d.x * 12.9 + d.z * 78.2) * 43758.5) % 1) * 0.04;
  const K = new Kit(batch, matrix(d.x, d.y, d.z, ry, lean * 0.5, lean), (x, y) => 0.7 + 0.3 * sstep(0, 1.5, y));
  const c = { glows };
  const iron = mat('iron_wrought');
  if (style === 'timber') {
    K.box(mat('stone_found'), 0.6, 0.55, 0.6, 0, 0.27, 0, { tile: 1.6 });
    K.box(mat('stone_found'), 0.7, 0.1, 0.7, 0, 0.58, 0, { tile: 1.6 });
    K.cyl(iron, [0, 0.6, 0], [0, 3.55, 0], 0.085, 0.06, { sides: 8 });
    for (const y of [0.75, 2.2, 3.45]) K.add(iron, new THREE.TorusGeometry(0.09, 0.03, 5, 10), { uv: 'keep', at: matrix(0, y, 0, 0, Math.PI / 2) });
    for (const a of [0, Math.PI]) K.beam(iron, [0, 3.3, 0], [Math.cos(a) * 0.28, 3.62, Math.sin(a) * 0.28], 0.03, 0.03);
    K.box(iron, 0.4, 0.04, 0.4, 0, 3.62, 0, { tile: 0.5 });
    lantern(c, [0, 3.93, 0], 0.78, false, K);
  } else if (style === 'farm') {
    const wood = mat('timber_dark');
    K.box(wood, 0.22, 3.4, 0.22, 0, 1.7, 0, { tile: 1.2, warp: v => { v.x *= 1 - (v.y + 1.7) / 3.4 * 0.2; v.z *= 1 - (v.y + 1.7) / 3.4 * 0.2; } });
    K.box(wood, 1.1, 0.14, 0.14, 0.5, 3.2, 0, { grain: 'x', tile: 1.2 });
    K.beam(wood, [0, 2.6, 0], [0.55, 3.15, 0], 0.1, 0.1);
    K.box(iron, 0.02, 0.32, 0.02, 0.92, 2.98, 0, { tile: 0.5 });
    lantern(c, [0.92, 2.6, 0], 0.6, true, K);
  } else if (style === 'alpine') {
    const gm = mat('granite_block');
    K.box(gm, 0.62, 1.3, 0.62, 0, 0.65, 0, { tile: 2.2, tint: '#d4cec4' });
    K.box(gm, 0.8, 0.16, 0.8, 0, 1.38, 0, { tile: 2.2, tint: '#e0dad0' });
    K.box(mat('snow_roof'), 0.84, 0.1, 0.84, 0, 1.5, 0, { tile: 2, seg: [2, 1, 2], warp: v => { v.y += 0.03 * Math.sin(v.x * 9 + v.z * 7); } });
    for (let k = 0; k < 3; k++) { const a = k / 3 * TAU; K.beam(iron, [Math.cos(a) * 0.3, 1.46, Math.sin(a) * 0.3], [Math.cos(a) * 0.45, 1.95, Math.sin(a) * 0.45], 0.04, 0.04); }
    K.add(iron, new THREE.CylinderGeometry(0.5, 0.26, 0.36, 10, 1, true), { uv: 'keep', uvScale: [4, 1], at: matrix(0, 1.78, 0) });
    K.add(iron, new THREE.CircleGeometry(0.26, 10), { uv: 'keep', at: matrix(0, 1.6, 0, 0, -Math.PI / 2) });
    K.add(mat('embers', { emissive: '#ff8030', emissiveIntensity: 1 }), new THREE.SphereGeometry(0.44, 10, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 1.83, 0, 0, 0, 0, new THREE.Vector3(1, 0.4, 1)), shade: false, cast: false });
    flames(K, 0, 1.86, 0, 0.36);
    glows.push({ p: V3(0, 2.3, 0).applyMatrix4(K.root), s: 3.6, fire: true });
  } else if (style === 'frontier') {
    const wood = mat('wood_light');
    K.tube(wood, [[0, -0.2, 0], [0.05, 1.8, 0.03], [0.12, 3.7, 0.05]], [0.14, 0.12, 0.1], { sides: 7, tint: '#9a7a58', tile: 1.6 });
    K.beam(wood, [-0.15, 3.35, 0], [1.0, 3.45, 0.02], 0.09, 0.09, { tint: '#9a7a58' });
    for (const y of [1.0, 3.3]) K.add(mat('rope'), new THREE.TorusGeometry(0.15, 0.035, 5, 10), { uv: 'keep', uvScale: [3, 1], at: matrix(0.02 + y * 0.03, y, 0.01, 0, Math.PI / 2) });
    K.box(mat('rope'), 0.03, 0.35, 0.03, 0.88, 3.25, 0, { tile: 0.5 });
    lantern(c, [0.88, 2.86, 0], 0.58, true, K);
    // a horned skull nailed to the pole
    K.add(mat('arch_bone'), new THREE.SphereGeometry(0.13, 8, 6), { uv: 'keep', at: matrix(0.06, 2.4, 0.15, 0, 0, 0, new THREE.Vector3(1, 0.9, 1.25)) });
    for (const s of [-1, 1]) K.add(mat('arch_bone'), new THREE.ConeGeometry(0.04, 0.32, 6), { uv: 'keep', at: matrix(0.06 + s * 0.17, 2.52, 0.12, 0, 0, s * -1.1) });
  } else {
    // goblin brass lamp: riveted base, pipe pole, glass globe in a brass cage, a gear
    K.box(mat('metal_red'), 0.55, 0.6, 0.55, 0, 0.3, 0, { uv: 'keep' });
    K.box(mat('brass'), 0.62, 0.08, 0.62, 0, 0.62, 0, { tile: 1 });
    const bm = mat('brass');
    K.cyl(bm, [0, 0.62, 0], [0, 3.3, 0], 0.08, 0.065, { sides: 8 });
    for (const y of [1.2, 2.4]) K.add(bm, new THREE.TorusGeometry(0.1, 0.03, 5, 10), { uv: 'keep', at: matrix(0, y, 0, 0, Math.PI / 2) });
    K.add(bm, new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12), { uv: 'keep', at: matrix(0.1, 1.8, 0, 0, 0, Math.PI / 2) });
    K.add(glassMat(), new THREE.SphereGeometry(0.26, 12, 10), { uv: 'keep', at: matrix(0, 3.6, 0), shade: false, cast: false });
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU; K.beam(bm, [Math.cos(a) * 0.1, 3.3, Math.sin(a) * 0.1], [Math.cos(a) * 0.27, 3.6, Math.sin(a) * 0.27], 0.025, 0.025); K.beam(bm, [Math.cos(a) * 0.27, 3.6, Math.sin(a) * 0.27], [0, 3.9, 0], 0.025, 0.025); }
    K.add(bm, new THREE.ConeGeometry(0.12, 0.22, 8), { uv: 'keep', at: matrix(0, 3.98, 0) });
    glows.push({ p: V3(0, 3.6, 0).applyMatrix4(K.root), s: 2.8 });
  }
}

// ---- furniture -----------------------------------------------------------------------------------

const furnShade = (x, y) => 0.7 + 0.3 * sstep(0, 1.1, y);

// the blackjack table's outline (shape coords: x, y = -z): a straight dealer side at -hz, a straight
// player edge at +hz (where the bet buttons stand) and rounded front corners; it fills the collider box
function dShape(hx, hz, rc = 0.45) {
  const sh = new THREE.Shape();
  sh.moveTo(-hx, hz);                       // dealer side (z = -hz) is shape y = +hz
  sh.lineTo(hx, hz);
  sh.lineTo(hx, -hz + rc);
  for (let i = 1; i <= 8; i++) { const a = i / 8 * Math.PI / 2; sh.lineTo(hx - rc + rc * Math.cos(a), -hz + rc - rc * Math.sin(a)); }
  sh.lineTo(-hx + rc, -hz);
  for (let i = 1; i <= 8; i++) { const a = Math.PI / 2 + i / 8 * Math.PI / 2; sh.lineTo(-hx + rc + rc * Math.cos(a), -hz + rc - rc * Math.sin(a)); }
  sh.closePath();
  return sh;
}
// the same outline as points in the table frame (x, z), from the dealer-side left corner round the front
function dPath(hx, hz, rc = 0.45, inset = 0) {
  const pts = [[-hx + inset, -hz + 0.1]];
  const X = hx - inset, Z = hz - inset, r = Math.max(0.05, rc - inset);
  pts.push([-X, Z - r]);
  for (let i = 1; i <= 6; i++) { const a = Math.PI + i / 6 * Math.PI / 2; pts.push([-X + r + r * Math.cos(a), Z - r - r * Math.sin(a)]); }
  pts.push([X - r, Z]);
  for (let i = 1; i <= 6; i++) { const a = Math.PI * 1.5 + i / 6 * Math.PI / 2; pts.push([X - r + r * Math.cos(a), Z - r - r * Math.sin(a)]); }
  pts.push([X, -hz + 0.1]);
  return pts;
}

// slot cabinets, one look per town (all share the painted reel front)
function slotCabinet(K, hx, hz, top, st, tint, glows) {
  const br = mat('brass'), iron = mat('iron_wrought');
  const face = () => K.add(mat('slot_face'), new THREE.PlaneGeometry(2 * hx - 0.12, top * 0.8), { uv: 'keep', at: matrix(0, 0.16 + top * 0.42, hz - 0.004), shade: false, tint: [1, 1, 1] });
  if (st === 'farm') {
    const bm = mat('planks_barnred');
    K.box(mat('stone_found'), 2 * hx + 0.06, 0.16, 2 * hz + 0.06, 0, 0.08, 0, { tile: 1.6 });
    K.box(bm, 2 * hx - 0.04, top - 0.16, 2 * hz - 0.06, 0, 0.16 + (top - 0.16) / 2, 0, { tile: 1.6 });
    face();
    K.add(bm, new THREE.CylinderGeometry(hx, hx, 2 * hz - 0.06, 3, 1, false, -Math.PI / 2, Math.PI), { uv: 'keep', at: matrix(0, top, 0, 0, -Math.PI / 2), warp: v => { v.y *= 0.8; } });
    for (const y of [0.4, top - 0.2]) K.box(iron, 2 * hx + 0.02, 0.06, 2 * hz + 0.02, 0, y, 0, { tile: 0.5 });
    lantern({ glows }, [0, top + hx * 0.75 + 0.18, 0], 0.36, false, K);
  } else if (st === 'alpine') {
    const wd = mat('timber_dark');
    K.box(mat('granite_block'), 2 * hx + 0.1, 0.24, 2 * hz + 0.1, 0, 0.12, 0, { tile: 2, tint: '#d0cac0' });
    K.box(wd, 2 * hx - 0.04, top - 0.24, 2 * hz - 0.06, 0, 0.24 + (top - 0.24) / 2, 0, { tile: 1.2 });
    face();
    K.add(wd, new THREE.CylinderGeometry(hx, hx, 2 * hz - 0.06, 14, 1, false, -Math.PI / 2, Math.PI), { uv: 'keep', at: matrix(0, top, 0, 0, -Math.PI / 2) });
    for (const y of [0.32, top * 0.5, top - 0.06]) K.box(iron, 2 * hx + 0.03, 0.08, 2 * hz + 0.03, 0, y, 0, { tile: 0.5 });
    for (const sx of [-1, 1]) for (const y of [0.32, top * 0.5, top - 0.06]) K.add(br, new THREE.SphereGeometry(0.025, 5, 4), { uv: 'keep', at: matrix(sx * (hx - 0.06), y, hz + 0.02) });
    K.add(glassMat(), new THREE.SphereGeometry(0.1, 10, 8), { uv: 'keep', at: matrix(0, top + hx + 0.04, 0), shade: false, cast: false, tint });
    glows.push({ p: V3(0, top + hx + 0.06, 0).applyMatrix4(K.root), s: 0.9, col: '#ffd890' });
  } else if (st === 'frontier') {
    const bm = mat('board_rough');
    K.box(bm, 2 * hx - 0.02, top - 0.05, 2 * hz - 0.04, 0, (top - 0.05) / 2 + 0.05, 0, { tile: 1.6 });
    face();
    for (const sx of [-1, 1]) K.cyl(mat('wood_light'), [sx * (hx - 0.02), 0, hz - 0.02], [sx * (hx - 0.03), top + 0.15, hz - 0.03], 0.05, 0.045, { sides: 6, tint: '#a8865e' });
    K.box(bm, 2 * hx + 0.1, 0.08, 2 * hz + 0.06, 0, top + 0.02, 0, { grain: 'x', tile: 1.6 });
    for (const y of [0.3, top - 0.25]) K.add(mat('rope'), new THREE.TorusGeometry(0.06, 0.018, 4, 8), { uv: 'keep', at: matrix(-hx + 0.02, y, hz - 0.02, 0, Math.PI / 2) });
    K.add(mat('arch_bone'), new THREE.SphereGeometry(0.12, 8, 6), { uv: 'keep', at: matrix(0, top + 0.16, 0.05, 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)) });
    for (const sx of [-1, 1]) K.add(mat('arch_bone'), new THREE.ConeGeometry(0.035, 0.3, 6), { uv: 'keep', at: matrix(sx * 0.16, top + 0.24, 0.02, 0, 0, sx * -1.1) });
  } else if (st === 'adobe') {
    K.box(br, 2 * hx + 0.06, 0.14, 2 * hz + 0.06, 0, 0.07, 0, { tile: 1 });
    K.box(mat('metal_green'), 2 * hx - 0.04, top - 0.14, 2 * hz - 0.06, 0, 0.14 + (top - 0.14) / 2, 0, { tile: 1.3 });
    face();
    K.add(br, new THREE.CylinderGeometry(hx, hx, 2 * hz - 0.06, 14, 1, false, -Math.PI / 2, Math.PI), { uv: 'keep', at: matrix(0, top, 0, 0, -Math.PI / 2) });
    K.add(br, new THREE.CylinderGeometry(0.16, 0.16, 0.05, 12), { uv: 'keep', at: matrix(hx + 0.02, top * 0.7, 0, 0, 0, Math.PI / 2) });
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.box(br, 0.04, 0.06, 0.06, hx + 0.02, top * 0.7 + Math.sin(a) * 0.18, Math.cos(a) * 0.18, { rx: -a, tile: 1 }); }
    K.add(glassMat(), new THREE.SphereGeometry(0.13, 10, 8), { uv: 'keep', at: matrix(0, top + hx + 0.08, 0), shade: false, cast: false, tint });
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + 0.4; K.beam(br, [Math.cos(a) * 0.05, top + hx - 0.02, Math.sin(a) * 0.05], [Math.cos(a) * 0.13, top + hx + 0.1, Math.sin(a) * 0.13], 0.02, 0.02); }
    glows.push({ p: V3(0, top + hx + 0.1, 0).applyMatrix4(K.root), s: 1.0, col: '#ffd890' });
  } else {
    // Goldshire: an oak cabinet with brass trim and a glass lamp on top
    const wl = mat('wood_light');
    K.box(br, 2 * hx + 0.06, 0.14, 2 * hz + 0.06, 0, 0.07, 0, { tile: 1 });
    K.box(wl, 2 * hx - 0.04, top - 0.14, 2 * hz - 0.06, 0, 0.14 + (top - 0.14) / 2, 0, { tile: 1.2, tint: '#b07a50' });
    face();
    K.add(wl, new THREE.CylinderGeometry(hx, hx, 2 * hz - 0.06, 14, 1, false, -Math.PI / 2, Math.PI), { uv: 'keep', at: matrix(0, top, 0, 0, -Math.PI / 2), tint: '#b07a50' });
    K.add(br, new THREE.TorusGeometry(hx, 0.025, 4, 14, Math.PI), { uv: 'keep', at: matrix(0, top, hz - 0.02) });
    K.add(glassMat(), new THREE.SphereGeometry(0.11, 10, 8), { uv: 'keep', at: matrix(0, top + hx + 0.06, 0), shade: false, cast: false, tint });
    glows.push({ p: V3(0, top + hx + 0.08, 0).applyMatrix4(K.root), s: 0.9, col: '#ffd890' });
  }
  // the pull handle on the right flank
  K.cyl(br, [hx + 0.02, top * 0.55, 0], [hx + 0.12, top * 0.55, 0], 0.06, 0.06, { sides: 8 });
  K.cyl(br, [hx + 0.12, top * 0.55, 0], [hx + 0.14, top * 0.55 + 0.5, 0.05], 0.025, 0.025, { sides: 6 });
  K.add(mat('wood_light'), new THREE.SphereGeometry(0.07, 8, 6), { uv: 'keep', at: matrix(hx + 0.14, top * 0.55 + 0.55, 0.05), tint: '#c03a2a' });
}

function furniture(s, batch, ctx) {
  const K = new Kit(batch, matrix(s.x, s.y - s.hy, s.z, s.ry), furnShade);
  const hx = s.hx, hy = s.hy, hz = s.hz, top = 2 * hy;
  const st = ctx.styleName;
  if (s.part === 'counter') {
    const wd = mat('timber_dark');
    if (st === 'alpine') {
      // a granite counter with a heavy timber top bound in iron, iron straps riveted flat to the stone
      K.box(mat('granite_block'), 2 * hx - 0.08, top - 0.16, 2 * hz - 0.08, 0, (top - 0.16) / 2, 0, { tile: 1.8, tint: '#d4cec4' });
      K.box(wd, 2 * hx + 0.2, 0.16, 2 * hz + 0.2, 0, top - 0.08, 0, { grain: 'x', tile: 1.2 });
      K.box(mat('iron_wrought'), 2 * hx + 0.22, 0.05, 2 * hz + 0.22, 0, top - 0.13, 0, { tile: 0.5 });
      for (const x of [-hx * 0.66, 0, hx * 0.66]) {
        K.box(mat('iron_wrought'), 0.14, top - 0.2, 0.025, x, (top - 0.2) / 2, hz - 0.04 + 0.0125, { tile: 0.5 });
        for (const y of [0.15, (top - 0.2) * 0.5, top - 0.3]) K.add(mat('brass'), new THREE.SphereGeometry(0.025, 5, 4), { uv: 'keep', at: matrix(x, y, hz - 0.01) });
      }
    } else if (st === 'frontier') {
      K.box(mat('planks_rough'), 2 * hx - 0.1, top - 0.14, 2 * hz - 0.16, 0, (top - 0.14) / 2, 0, { tile: 2.4 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.cyl(mat('wood_light'), [sx * (hx - 0.08), 0, sz * (hz - 0.08)], [sx * (hx - 0.08), top - 0.02, sz * (hz - 0.08)], 0.09, 0.08, { sides: 7, tint: '#a8865e' });
      K.box(mat('board_rough'), 2 * hx + 0.16, 0.08, 2 * hz + 0.12, 0, top - 0.04, 0, { grain: 'x', tile: 1.6 });
      K.add(mat('rug_hide', { alphaTest: 0.5, side: THREE.DoubleSide }), new THREE.PlaneGeometry(1.0, 1.2), { uv: 'keep', at: matrix(hx - 0.55, top + 0.005, 0.1, 0.3, -Math.PI / 2), cast: false });
    } else if (st === 'adobe') {
      K.box(mat('adobe_inner'), 2 * hx - 0.06, top - 0.1, 2 * hz - 0.06, 0, (top - 0.1) / 2, 0, { tile: 2.4, tint: '#e8d0b0' });
      K.box(mat('floor_flags'), 2 * hx + 0.14, 0.1, 2 * hz + 0.14, 0, top - 0.05, 0, { tile: 1.3 });
      K.cyl(mat('brass'), [-hx, 0.18, hz + 0.08], [hx, 0.18, hz + 0.08], 0.03, 0.03, { sides: 6 });
    } else {
      const wl = mat('wood_light'), pl = mat('planks_weathered');
      K.box(wd, 2 * hx - 0.2, 0.14, 2 * hz - 0.24, 0, 0.07, 0, { grain: 'x' });
      K.box(pl, 2 * hx - 0.1, top - 0.22, 2 * hz - 0.12, 0, 0.14 + (top - 0.22) / 2, 0, { tile: 2.4, tint: '#c8a080' });
      K.box(wl, 2 * hx + 0.14, 0.08, 2 * hz + 0.16, 0, top - 0.04, 0, { grain: 'x', tile: 1.6 });
      const n = Math.max(2, Math.round(2 * hx / 0.95));
      for (let k = 0; k <= n; k++) K.box(wd, 0.1, top - 0.24, 0.05, -hx + 0.05 + (2 * hx - 0.1) * k / n, 0.14 + (top - 0.24) / 2, hz - 0.03, { tile: 1.2 });
      K.box(wd, 2 * hx, 0.09, 0.06, 0, 0.2, hz - 0.03, { grain: 'x' });
      K.box(wd, 2 * hx, 0.09, 0.06, 0, top - 0.14, hz - 0.03, { grain: 'x' });
    }
    return;
  }
  if (s.part === 'bj_table') {
    // the table fills its collider: a straight dealer side, a straight player edge where the bet buttons
    // stand, rounded front corners; an apron on four turned legs, a padded leather rail round the player
    // side, green felt, the dealer's chip rack (clear of both card rows)
    const wl = mat('wood_light'), wd = mat('timber_dark');
    const ext = (shape, depth) => new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4, steps: 1 });
    K.add(wl, ext(dShape(hx - 0.12, hz - 0.12, 0.35), 0.24), { tile: 1.2, grain: 'x', at: matrix(0, top - 0.36, 0, 0, -Math.PI / 2), tint: '#8a4a34' });
    K.add(wd, ext(dShape(hx, hz), 0.1), { tile: 1.2, grain: 'x', at: matrix(0, top - 0.1, 0, 0, -Math.PI / 2) });
    const felt = new THREE.ShapeGeometry(dShape(hx - 0.06, hz - 0.06, 0.4), 4);
    const p = felt.attributes.position, uv = felt.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + hx) / (2 * hx), (p.getY(i) + hz) / (2 * hz));
    K.add(mat('felt_table'), felt, { uv: 'keep', at: matrix(0, top + 0.002, 0, 0, -Math.PI / 2), shade: false, cast: false });
    const rail = dPath(hx, hz, 0.45, 0.075).map(([x, z]) => [x, top + 0.02, z]);
    K.tube(mat('hide_patch'), rail, 0.08, { sides: 8, tile: 0.8, tint: '#6a3428' });
    const studs = dPath(hx, hz, 0.45, 0.01);
    for (let i = 0; i < studs.length - 1; i++) for (let k = 0; k < 3; k++) { const t = k / 3, x = studs[i][0] + (studs[i + 1][0] - studs[i][0]) * t, z = studs[i][1] + (studs[i + 1][1] - studs[i][1]) * t; K.add(mat('brass'), new THREE.SphereGeometry(0.018, 5, 4), { uv: 'keep', at: matrix(x, top - 0.05, z) }); }
    K.box(wd, 2 * hx, 0.1, 0.12, 0, top - 0.02, -hz + 0.06, { grain: 'x' });
    const leg = [[0, 0], [0.07, 0], [0.06, 0.08], [0.1, 0.2], [0.06, 0.32], [0.05, 0.44], [0.08, 0.5], [0.07, 0.56], [0, 0.56]].map(([r, h]) => new THREE.Vector2(r, h));
    for (const [x, z] of [[-hx + 0.3, -hz + 0.3], [hx - 0.3, -hz + 0.3], [-hx + 0.4, hz - 0.4], [hx - 0.4, hz - 0.4]]) K.add(wl, new THREE.LatheGeometry(leg, 10), { uv: 'keep', at: matrix(x, 0, z), tint: '#7a4030' });
    K.box(wd, 0.9, 0.05, 0.16, 0, top + 0.02, -hz + 0.14, { grain: 'x' });
    const chipCols = ['#b83a2a', '#2e4a7a', '#3a7a44', '#e8dcc0', '#1e1a20'];
    chipCols.forEach((cc, k) => { for (let j = 0; j < 2; j++) K.add(mat('wood_light'), new THREE.CylinderGeometry(0.045, 0.045, 0.12, 10), { uv: 'keep', at: matrix(-0.34 + k * 0.17, top + 0.07, -hz + 0.14, 0, 0, Math.PI / 2), tint: cc, shade: false }); });
    return;
  }
  if (s.part === 'flip_machine') {
    // a riveted goblin contraption, all inside its footprint: a tapered body in front, two banded boilers
    // at the back corners with pipes looping to the pedestal, gears on the flanks, a brass ledge for the
    // stake buttons, and the coin spinning under a glass dome on top (the dome itself is in buildStructures)
    const red = mat('metal_red'), br = mat('brass'), h = top - 0.3;
    const bz0 = -hz + 0.48, bz1 = hz - 0.04, bd = bz1 - bz0, bzc = (bz0 + bz1) / 2;
    K.box(red, 2 * hx - 0.1, h, bd, 0, 0.22 + h / 2, bzc, { tile: 1.3, seg: [1, 3, 1], warp: v => { const t = (v.y + h / 2) / h; v.x *= 1 - 0.1 * t; v.z = v.z * (1 - 0.1 * t); } });
    K.box(br, 2 * hx + 0.02, 0.12, 2 * hz + 0.02, 0, 0.22, 0, { tile: 1 });
    K.box(br, (2 * hx - 0.1) * 0.9 + 0.16, 0.12, bd * 0.9 + 0.16, 0, top - 0.06, bzc, { tile: 1 });
    K.add(mat('flip_face'), new THREE.PlaneGeometry(2 * hx * 0.84, h - 0.3), { uv: 'keep', at: matrix(0, 0.22 + h / 2, bzc + bd / 2 * 0.95 + 0.008, 0, -Math.atan(0.1 * bd / 2 / h)), shade: false });
    K.box(br, 2 * hx * 0.9, 0.06, 0.28, 0, 1.03, hz - 0.02, { tile: 1 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      K.add(br, new THREE.SphereGeometry(0.11, 8, 6), { uv: 'keep', at: matrix(sx * (hx - 0.1), 0.11, sz * (hz - 0.1)) });
      for (let k = -1; k <= 1; k++) K.add(br, new THREE.ConeGeometry(0.035, 0.14, 5), { uv: 'keep', at: matrix(sx * (hx - 0.1) + k * 0.06, 0.04, sz * (hz - 0.1) + sz * 0.06, 0, sz * 1.3, 0) });
    }
    for (const sx of [-1, 1]) {
      const gx = sx * (hx * 0.92 + 0.01);
      K.add(br, new THREE.CylinderGeometry(0.34, 0.34, 0.06, 16), { uv: 'keep', at: matrix(gx, top * 0.5, bzc, 0, 0, Math.PI / 2) });
      for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; K.box(br, 0.06, 0.1, 0.1, gx, top * 0.5 + Math.sin(a) * 0.38, bzc + Math.cos(a) * 0.38, { rx: -a, tile: 1 }); }
      K.add(red, new THREE.CylinderGeometry(0.09, 0.09, 0.1, 10), { uv: 'keep', at: matrix(gx + sx * 0.04, top * 0.5, bzc, 0, 0, Math.PI / 2) });
      // a banded boiler in the back corner, a gauge, a stack, a pipe looping over to the pedestal
      const bx = sx * (hx - 0.24), bz = -hz + 0.24;
      K.cyl(red, [bx, 0.05, bz], [bx, 2.0, bz], 0.22, 0.22, { sides: 12, uvScale: [2, 1.5] });
      K.add(br, new THREE.SphereGeometry(0.22, 12, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(bx, 2.0, bz) });
      for (const y of [0.35, 0.95, 1.6]) K.add(br, new THREE.TorusGeometry(0.23, 0.025, 5, 14), { uv: 'keep', at: matrix(bx, y, bz, 0, Math.PI / 2) });
      K.cyl(br, [bx, 2.15, bz], [bx, 2.55, bz], 0.05, 0.05, { sides: 6 });
      K.add(br, new THREE.ConeGeometry(0.08, 0.16, 8), { uv: 'keep', at: matrix(bx, 2.62, bz, 0, Math.PI) });
      K.tube(br, [[bx, 1.85, bz + 0.18], [bx - sx * 0.1, top + 0.45, bz + 0.25], [sx * 0.42, top + 0.38, -0.05], [sx * 0.3, top + 0.12, 0]], 0.045, { sides: 6 });
    }
    K.add(mat('iron_wrought'), new THREE.CircleGeometry(0.1, 12), { uv: 'keep', at: matrix(-(hx - 0.24), 1.25, -hz + 0.47), tint: '#f8f0e0', shade: false });
    // pedestal, brass ring and ribs round the glass dome the coin spins in
    K.cyl(br, [0, top, 0], [0, top + 0.18, 0], 0.42, 0.36, { sides: 14 });
    const dc = V3(0, top + 0.36, 0), r = 0.53;
    K.add(br, new THREE.TorusGeometry(r * Math.sin(0.6 * Math.PI), 0.04, 6, 24), { uv: 'keep', at: matrix(0, dc.y + r * Math.cos(0.6 * Math.PI) * 1.35, 0, 0, Math.PI / 2) });
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * TAU + Math.PI / 4, pts = [];
      for (let i = 0; i <= 8; i++) { const th = 0.6 * Math.PI * (1 - i / 8); pts.push([r * Math.sin(th) * Math.cos(a), dc.y + r * Math.cos(th) * 1.35, r * Math.sin(th) * Math.sin(a)]); }
      K.tube(br, pts, 0.022, { sides: 5 });
    }
    K.add(br, new THREE.SphereGeometry(0.06, 8, 6), { uv: 'keep', at: matrix(0, dc.y + r * 1.35 + 0.02, 0) });
    ctx.domes.push(V3(0, top + 0.18, 0).applyMatrix4(K.root));
    return;
  }
  if (s.part === 'slot_bank') {
    slotCabinet(K, hx, hz, top, st, ctx.slotTint(s), ctx.glows);
    return;
  }
  if (s.part === 'casino_bar') { casinoBar(K, s, ctx); return; }
  // anything else: a sturdy painted crate-box at the same footprint
  K.box(mat('crate'), 2 * hx, top, 2 * hz, 0, hy, 0, { uv: 'keep' });
}

// The casino's bar, filling its box (long along local x; the customers' side is -z, the wall behind +z):
// a panelled counter in the town's material under a thick dark top, a brass foot rail, stools tucked in,
// and against the wall behind a low back-bar with kegs in a cradle and rows of bottles (or steins, jars)
const BAR = {
  timber: { body: 'wood_light', tint: '#b07a50', item: 'stein' }, farm: { body: 'planks_weathered', tint: '#c8a888', item: 'jar' },
  alpine: { body: 'granite_block', tint: '#d4cec4', item: 'stein' }, frontier: { body: 'planks_rough', tint: null, item: 'bottle' },
  adobe: { body: 'adobe_inner', tint: '#e8d0b0', item: 'bottle' },
};
function casinoBar(K, s, ctx) {
  const st = ctx.styleName, B = BAR[st] || BAR.timber, hx = s.hx, hz = s.hz, top = 2 * s.hy;
  const R = rng(Math.abs(Math.round(s.x * 13 + s.z * 7)) + 5);
  const wd = mat('timber_dark'), br = mat('brass'), body = mat(B.body);
  // the wall behind: from the casino's record if we have it
  let wallZ = hz + 0.9;
  const cb = ctx.casino;
  if (cb) { const dx = s.x - cb.x, dz = s.z - cb.z, lx = dx * Math.cos(cb.ry) - dz * Math.sin(cb.ry); wallZ = Math.max(hz + 0.5, cb.w / 2 - 0.15 - Math.abs(lx)); }
  K.box(body, 2 * hx - 0.08, top - 0.12, 2 * hz - 0.1, 0, (top - 0.12) / 2, 0.02, { tile: 1.6, tint: B.tint, seg: [4, 2, 1] });
  K.box(wd, 2 * hx + 0.1, 0.1, 2 * hz + 0.22, 0, top - 0.05, -0.08, { grain: 'x', tile: 1.2, seg: [4, 1, 1] });
  const n = Math.max(3, Math.round(2 * hx / 0.85));
  for (let k = 0; k <= n; k++) K.box(wd, 0.1, top - 0.2, 0.06, -hx + 0.05 + (2 * hx - 0.1) * k / n, (top - 0.2) / 2 + 0.05, -hz + 0.02, { tile: 1.2 });
  K.box(wd, 2 * hx, 0.1, 0.07, 0, 0.12, -hz + 0.02, { grain: 'x' });
  K.cyl(br, [-hx + 0.1, 0.22, -hz - 0.14], [hx - 0.1, 0.22, -hz - 0.14], 0.03, 0.03, { sides: 6 });
  for (const x of [-hx + 0.15, 0, hx - 0.15]) K.cyl(br, [x, 0.06, -hz + 0.02], [x, 0.22, -hz - 0.14], 0.02, 0.02, { sides: 5 });
  // on the counter: a few steins and a bottle, a brass bell
  for (let k = 0; k < 4; k++) { const it = ITEMS[k === 3 ? 'bottle' : B.item]; if (!it) continue; K.push(-hx + 0.5 + R() * (2 * hx - 1), top, -0.05 + (R() - 0.5) * 0.2, R() * 3, 0, 0, 1.15); it.d(K, R); K.pop(); }
  K.add(br, new THREE.SphereGeometry(0.08, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(hx - 0.35, top, -0.1) });
  // stools tucked in on the customers' side
  for (let k = 0; k < 4; k++) {
    const x = -hx + 0.6 + (2 * hx - 1.2) * k / 3 + (R() - 0.5) * 0.15, z = -hz - 0.36;
    K.cyl(mat('wood_light'), [x, 0.68, z], [x, 0.74, z], 0.2, 0.19, { sides: 10, tint: '#9a6a48' });
    for (let j = 0; j < 3; j++) { const a = j / 3 * TAU + R(); K.beam(wd, [x + Math.cos(a) * 0.16, 0.0, z + Math.sin(a) * 0.16], [x + Math.cos(a) * 0.08, 0.68, z + Math.sin(a) * 0.08], 0.04, 0.04); }
    K.add(mat('iron_wrought'), new THREE.TorusGeometry(0.12, 0.012, 4, 10), { uv: 'keep', at: matrix(x, 0.3, z, 0, Math.PI / 2) });
  }
  // the back-bar against the wall: a low cabinet, kegs in a cradle, bottles in rows
  const bz = wallZ - 0.22, bh = 1.0;
  if (bz - 0.22 > hz + 0.3) {
    K.box(body, 2 * hx - 0.3, bh - 0.06, 0.4, 0, (bh - 0.06) / 2, bz, { tile: 1.6, tint: B.tint, seg: [3, 2, 1] });
    K.box(wd, 2 * hx - 0.2, 0.06, 0.46, 0, bh - 0.03, bz - 0.02, { grain: 'x', tile: 1.2 });
    for (const sx of [-1, 1]) {
      const kx = sx * (hx - 0.7);
      K.box(wd, 0.7, 0.1, 0.36, kx, bh + 0.05, bz, { grain: 'x', tile: 1.2 });
      K.add(mat('barrel'), new THREE.CylinderGeometry(0.24, 0.24, 0.52, 12, 2, true), { uv: 'keep', at: matrix(kx, bh + 0.32, bz, 0, Math.PI / 2), warp: v => { const k = 1 + 0.1 * Math.cos(Math.PI * v.y / 0.52); v.x *= k; v.z *= k; } });
      K.add(mat('endgrain'), new THREE.CircleGeometry(0.23, 12), { uv: 'keep', at: matrix(kx, bh + 0.32, bz - 0.262, Math.PI), tint: '#c8a888' });
      K.cyl(br, [kx, bh + 0.24, bz - 0.27], [kx, bh + 0.24, bz - 0.36], 0.025, 0.02, { sides: 6 });
    }
    for (let x = -0.9; x < 0.9; x += 0.16 + R() * 0.05) { if (R() < 0.12) continue; K.push(x, bh, bz + (R() - 0.5) * 0.12, R() * 3, 0, 0, 1.2); (ITEMS[R() < 0.6 ? 'bottle' : B.item] || ITEMS.bottle).d(K, R); K.pop(); }
  }
}

// ---- the Repo Man's steam tow wagon --------------------------------------------------------------

// a wagon wheel: wooden spokes and felloe, an iron tyre with a row of rivets and chunky grouser plates
function wheel(K, x, z, r, w) {
  const iron = mat('iron_wrought'), wood = mat('wood_light'), br = mat('brass');
  K.push(x, r, z, 0, 0, Math.PI / 2);
  K.add(wood, new THREE.TorusGeometry(r - 0.13, 0.09, 8, 22), { uv: 'keep', uvScale: [6, 1], at: matrix(0, 0, 0, 0, Math.PI / 2, 0, new THREE.Vector3(1, 1, w / 0.2)), tint: '#9a6a48' });
  K.add(iron, new THREE.CylinderGeometry(r - 0.02, r - 0.02, w + 0.04, 26, 1, true), { uv: 'keep', uvScale: [8, 1], tint: '#9a96a4' });
  for (const sy of [-1, 1]) K.add(iron, new THREE.RingGeometry(r - 0.06, r - 0.02, 26), { uv: 'keep', at: matrix(0, sy * (w / 2 + 0.02), 0, 0, sy * Math.PI / 2), tint: '#8a8694' });
  for (let k = 0; k < 11; k++) { const a = k / 11 * TAU; K.box(iron, 0.13, w + 0.02, 0.07, Math.cos(a) * (r + 0.02), 0, Math.sin(a) * (r + 0.02), { ry: Math.PI / 2 - a, tile: 0.5, tint: '#a8a4b0' }); }
  for (let k = 0; k < 22; k++) { const a = (k + 0.5) / 22 * TAU; for (const sy of [-1, 1]) K.add(br, new THREE.SphereGeometry(0.022, 5, 4), { uv: 'keep', at: matrix(Math.cos(a) * (r - 0.04), sy * (w / 2 + 0.03), Math.sin(a) * (r - 0.04)) }); }
  for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; K.beam(wood, [Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14], [Math.cos(a) * (r - 0.18), 0, Math.sin(a) * (r - 0.18)], 0.07, 0.05, { tint: '#a87a54' }); }
  K.cyl(br, [0, -w / 2 - 0.08, 0], [0, w / 2 + 0.08, 0], 0.16, 0.16, { sides: 10 });
  K.cyl(iron, [0, w / 2 + 0.08, 0], [0, w / 2 + 0.16, 0], 0.07, 0.05, { sides: 8 });
  K.pop();
}

function towWagon(K, glows) {
  const iron = mat('iron_wrought'), green = mat('metal_green'), red = mat('metal_red'), br = mat('brass'), wood = mat('timber_dark'), wl = mat('wood_light');
  // chassis
  for (const sx of [-1, 1]) K.box(iron, 0.2, 0.26, 6.4, sx * 0.62, 0.86, -0.1, { grain: 'z', tile: 1, seg: [1, 1, 4], tint: '#b0acb8' });
  K.cyl(iron, [-1.2, 0.75, -2.1], [1.2, 0.75, -2.1], 0.08, 0.08, { sides: 8 });
  K.cyl(iron, [-1.15, 0.6, 2.15], [1.15, 0.6, 2.15], 0.07, 0.07, { sides: 8 });
  for (const sx of [-1, 1]) { wheel(K, sx * 1.12, -2.1, 0.78, 0.3); wheel(K, sx * 1.1, 2.15, 0.6, 0.26); }
  for (const sx of [-1, 1]) {
    const f = new THREE.CylinderGeometry(0.92, 0.92, 0.42, 14, 1, true, Math.PI * 0.05, Math.PI * 0.9);
    K.add(red, f, { uv: 'keep', uvScale: [2, 1], at: matrix(sx * 1.12, 0.78, -2.1, 0, 0, Math.PI / 2), receive: true });
    const f2 = new THREE.CylinderGeometry(0.74, 0.74, 0.36, 12, 1, true, Math.PI * 0.05, Math.PI * 0.9);
    K.add(red, f2, { uv: 'keep', uvScale: [2, 1], at: matrix(sx * 1.1, 0.6, 2.15, 0, 0, Math.PI / 2), receive: true });
  }
  // cab: riveted lower body, open sides, an arched riveted red roof on iron posts
  K.box(green, 2.0, 0.85, 2.0, 0, 1.38, 2.0, { tile: 1.3 });
  K.add(green, new THREE.BoxGeometry(1.8, 0.6, 0.7), { tile: 1.3, at: matrix(0, 1.5, 3.25), warp: v => { if (v.y > 0) v.z -= 0.25; } });
  K.box(br, 2.06, 0.08, 2.06, 0, 1.84, 2.0, { tile: 1 });
  for (const sx of [-1, 1]) for (const sz of [1.1, 2.9]) K.cyl(iron, [sx * 0.92, 1.8, sz], [sx * 0.9, 2.82, sz - 0.05], 0.05, 0.045, { sides: 6 });
  K.box(red, 2.36, 0.08, 2.3, 0, 2.94, 1.95, { tile: 2.8, seg: [8, 1, 2], warp: v => { v.y -= v.x * v.x * 0.11; } });
  for (const z of [0.8, 3.1]) K.box(br, 2.4, 0.05, 0.06, 0, 2.99, z, { tile: 1, seg: [8, 1, 1], warp: v => { v.y -= v.x * v.x * 0.11; } });
  K.box(br, 1.8, 0.06, 0.06, 0, 2.2, 2.92, { tile: 1 });
  K.box(br, 0.06, 0.62, 0.06, -0.9, 2.5, 2.92, { tile: 1 }); K.box(br, 0.06, 0.62, 0.06, 0.9, 2.5, 2.92, { tile: 1 });
  K.box(wl, 1.5, 0.18, 0.6, 0, 1.9, 1.5, { tint: '#7a4a34' });
  K.box(wl, 1.5, 0.6, 0.14, 0, 2.15, 1.2, { tint: '#7a4a34' });
  K.add(iron, new THREE.TorusGeometry(0.22, 0.035, 5, 14), { uv: 'keep', at: matrix(-0.35, 2.2, 2.55, 0, -0.9) });
  K.cyl(iron, [-0.35, 1.8, 2.75], [-0.35, 2.18, 2.58], 0.03, 0.03, { sides: 5 });
  // front: grille, headlamps, bumper
  K.box(br, 1.0, 0.5, 0.08, 0, 1.45, 3.62, { tile: 1 });
  for (let k = 0; k < 5; k++) K.box(iron, 0.05, 0.42, 0.04, -0.36 + k * 0.18, 1.45, 3.67, { tile: 0.5 });
  for (const sx of [-1, 1]) {
    K.add(br, new THREE.TorusGeometry(0.2, 0.05, 6, 14), { uv: 'keep', at: matrix(sx * 0.72, 1.55, 3.45) });
    K.add(glassMat(), new THREE.CircleGeometry(0.19, 14), { uv: 'keep', at: matrix(sx * 0.72, 1.55, 3.47), shade: false, cast: false });
    K.cyl(br, [sx * 0.72, 1.55, 3.1], [sx * 0.72, 1.55, 3.42], 0.17, 0.2, { sides: 10 });
    glows.push({ p: V3(sx * 0.72, 1.55, 3.6).applyMatrix4(K.m).applyMatrix4(K.root), s: 1.4 });
  }
  K.box(red, 2.4, 0.2, 0.22, 0, 0.82, 3.6, { grain: 'x', tile: 1 });
  // the goblin cow-catcher: a V of bars from the bumper down to a nose a hand above the ground, its
  // lower edge a red rail, bolted back to the chassis by two struts
  const nose = [0, 0.15, 4.45], bot = x => [x * 0.95, 0.17 + Math.abs(x) * 0.04, nose[2] - Math.abs(x) * 0.62];
  for (const sx of [-1, 1]) {
    const pts = []; for (let k = 0; k <= 6; k++) { const x = sx * 1.1 * (1 - k / 6); pts.push(bot(x)); }
    K.tube(red, pts, 0.07, { sides: 7 });
    K.cyl(iron, [sx * 0.62, 0.78, 3.2], bot(sx * 0.55), 0.06, 0.06, { sides: 6 });
    K.add(br, new THREE.SphereGeometry(0.07, 6, 5), { uv: 'keep', at: matrix(...bot(sx * 0.55)) });
  }
  for (let k = 0; k < 7; k++) {
    const x = -0.96 + k * 0.32;
    K.cyl(iron, [x, 0.74, 3.7], bot(x), 0.045, 0.05, { sides: 6, tint: '#b0acb8' });
  }
  K.cyl(red, [-1.1, 0.74, 3.72], [1.1, 0.74, 3.72], 0.07, 0.07, { sides: 7 });
  K.add(br, new THREE.ConeGeometry(0.1, 0.24, 8), { uv: 'keep', at: matrix(nose[0], nose[1] + 0.02, nose[2] + 0.08, 0, Math.PI / 2) });
  for (const sx of [-1, 1]) K.add(mat('repo_plate'), new THREE.PlaneGeometry(1.5, 0.75), { uv: 'keep', at: matrix(sx * 1.012, 1.38, 2.0, sx * Math.PI / 2), shade: false });
  // the boiler and its stack
  K.cyl(red, [0, 1.55, -0.55], [0, 1.55, 1.0], 0.62, 0.62, { sides: 14 });
  for (const z of [-0.45, 0.2, 0.85]) K.add(br, new THREE.TorusGeometry(0.63, 0.04, 5, 18), { uv: 'keep', at: matrix(0, 1.55, z) });
  K.add(br, new THREE.CircleGeometry(0.6, 14), { uv: 'keep', at: matrix(0, 1.55, -0.56, Math.PI) });
  K.cyl(iron, [0.25, 2.1, 0.3], [0.3, 3.9, 0.3], 0.16, 0.14, { sides: 10 });
  K.add(iron, new THREE.CylinderGeometry(0.3, 0.14, 0.4, 10, 1, true), { uv: 'keep', at: matrix(0.3, 4.05, 0.3), receive: true });
  K.add(br, new THREE.TorusGeometry(0.3, 0.04, 5, 12), { uv: 'keep', at: matrix(0.3, 4.25, 0.3, 0, Math.PI / 2) });
  K.add(br, new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), { uv: 'keep', at: matrix(0.64, 1.75, 0.5, 0, 0, Math.PI / 2) });
  K.cyl(br, [-0.5, 2.05, 0.6], [-0.5, 2.45, 0.6], 0.05, 0.05, { sides: 6 });
  K.add(br, new THREE.ConeGeometry(0.09, 0.16, 8), { uv: 'keep', at: matrix(-0.5, 2.52, 0.6) });
  // the bed: planks, side rails, a barrel strapped on, REPO on the tailboard
  K.box(mat('floor_planks'), 2.1, 0.1, 2.7, 0, 1.05, -2.2, { tile: 2 });
  for (const sx of [-1, 1]) K.box(wood, 0.1, 0.3, 2.7, sx * 1.02, 1.25, -2.2, { grain: 'z' });
  K.box(wood, 2.1, 0.42, 0.1, 0, 1.28, -3.55, { grain: 'x' });
  K.add(mat('repo_plate'), new THREE.PlaneGeometry(1.1, 0.55), { uv: 'keep', at: matrix(0, 1.25, -3.61, Math.PI), shade: false });
  barrel(K, -0.6, -2.9, 0.28, 0.8, 1.1);
  // the crane: an A-frame, a winch drum, and a lattice boom: two side trusses (top and bottom chords,
  // zig-zag struts) tied across, a brass pulley at the tip, chain and a big hook
  for (const sx of [-1, 1]) K.beam(iron, [sx * 0.75, 1.1, -0.9], [sx * 0.16, 2.5, -1.45], 0.14, 0.14);
  K.cyl(iron, [-0.55, 1.45, -1.25], [0.55, 1.45, -1.25], 0.22, 0.22, { sides: 12 });
  for (const sx of [-0.4, 0, 0.4]) K.add(iron, new THREE.TorusGeometry(0.24, 0.035, 4, 12), { uv: 'keep', at: matrix(sx, 1.45, -1.25, Math.PI / 2) });
  const T0 = [2.95, -1.25], T1 = [3.75, -4.0], B0 = [2.35, -1.4], B1 = [3.45, -3.92];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const N = 7;
  for (const sx of [-1, 1]) {
    const xw = t => sx * (0.22 - 0.08 * t);
    K.beam(green, [xw(0), ...T0], [xw(1), ...T1], 0.12, 0.12, { tile: 1.3 });
    K.beam(green, [xw(0), ...B0], [xw(1), ...B1], 0.12, 0.12, { tile: 1.3 });
    for (let k = 0; k < N; k++) {
      const t0 = k / N, t1 = (k + 1) / N, a = k % 2 ? lerp(T0, T1, t0) : lerp(B0, B1, t0), b2 = k % 2 ? lerp(B0, B1, t1) : lerp(T0, T1, t1);
      K.beam(green, [xw(t0), ...a], [xw(t1), ...b2], 0.06, 0.06, { tile: 1.3 });
    }
  }
  for (let k = 0; k <= N; k += 2) { const t = k / N, a = lerp(T0, T1, t), b2 = lerp(B0, B1, t), w = 0.22 - 0.08 * t; K.box(iron, 2 * w, 0.05, 0.05, 0, a[0], a[1], { tile: 0.5 }); K.box(iron, 2 * w, 0.05, 0.05, 0, b2[0], b2[1], { tile: 0.5 }); }
  for (const sx of [-1, 1]) K.add(br, new THREE.CylinderGeometry(0.07, 0.07, 0.06, 8), { uv: 'keep', at: matrix(sx * 0.16, 3.6, -4.08, 0, 0, Math.PI / 2) });
  K.add(br, new THREE.CylinderGeometry(0.3, 0.3, 0.12, 16), { uv: 'keep', at: matrix(0, 3.6, -4.12, 0, 0, Math.PI / 2) });
  K.add(iron, new THREE.TorusGeometry(0.3, 0.035, 5, 16), { uv: 'keep', at: matrix(0, 3.6, -4.12, Math.PI / 2) });
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; K.box(br, 0.04, 0.5, 0.04, 0.065, 3.6, -4.12, { rx: a, tile: 1 }); }
  K.cyl(iron, [0, 3.3, -4.42], [0.02, 1.85, -4.42], 0.025, 0.025, { sides: 4 });
  for (let k = 0; k < 8; k++) K.add(iron, new THREE.TorusGeometry(0.07, 0.022, 4, 8), { uv: 'keep', at: matrix(0, 3.3 - k * 0.19, -4.42, k % 2 ? Math.PI / 2 : 0) });
  K.add(br, new THREE.BoxGeometry(0.2, 0.26, 0.14), { uv: 'keep', at: matrix(0, 1.78, -4.42) });
  K.add(iron, new THREE.TorusGeometry(0.34, 0.09, 6, 14, Math.PI * 1.35), { uv: 'keep', at: matrix(0, 1.38, -4.42, Math.PI / 2, 0, Math.PI * 0.85) });
  K.add(br, new THREE.ConeGeometry(0.08, 0.18, 6), { uv: 'keep', at: matrix(0.3, 1.56, -4.42, 0, 0, 0.6) });
  // a tow sling hanging off the tail: a crossbar on two chains
  K.cyl(iron, [-0.8, 0.62, -3.95], [0.8, 0.62, -3.95], 0.07, 0.07, { sides: 8 });
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 5; k++) K.add(iron, new THREE.TorusGeometry(0.05, 0.016, 4, 8), { uv: 'keep', at: matrix(sx * 0.6, 0.72 + k * 0.1, -3.85 + k * 0.06, k % 2 ? Math.PI / 2 : 0, 0.5) });
    K.box(mat('hide_patch'), 0.22, 0.28, 0.06, sx * 0.35, 0.5, -3.96, { tint: '#5a4038' });
  }
  lantern({ glows }, [0.55, 3.25, 2.2], 0.45, false, K);
}

function towTruck(t, batch = null, glows = []) {
  const standalone = !batch;
  const B = batch || new Batch();
  const K = new Kit(B, matrix(t.x, t.y, t.z, t.ry, 0, 0, 1.28), (x, y) => 0.72 + 0.28 * sstep(0, 1.5, y));
  towWagon(K, glows);
  if (standalone) { const g = new THREE.Group(); B.build(g); return g; }
  return null;
}

// ---- Westfall windmills -----------------------------------------------------------------------------
// A chunky smock mill: a fieldstone base, an octagonal smock of oxblood boards with dark corner posts and
// bands, a kicked witch-hat cap of cedar shakes with a deep eave, a hood over the windshaft, a fantail
// behind, and four big lattice sails of patched canvas (one furled) on a shaft tilted up so they clear the
// tower. The tower's faces stand just outside a cylinder of radius P.R from the ground to P.H (world gen's
// collider), so nothing solid is invisible and nothing visible is walked through; the cap starts at P.H.
// The sails go into sailsBatch in a frame centred on the hub (x across, y up the sail, z out along the
// shaft) for buildStructures to turn. Returns { hub (world), tilt }.
const MILL = { R: 2.7, H: 12, hubY: 13.0, hubZ: 4.3, tilt: 0.14, sail: 9.0, sailW: 2.1 };
function windmill(batch, x, y, z, ry, sailsBatch, o = {}) {
  const P = { ...MILL, ...o }, H = P.H;
  // grime and a cool cast at the foot, the smock's top in the eave's shade
  const shadeFn = (lx, ly) => {
    const g = sstep(-0.4, 2.6, ly), e = ly < H + 0.05 ? 1 - 0.22 * sstep(H - 2.4, H - 0.2, ly) : 1, k = (0.62 + 0.38 * g) * e;
    return [k * (0.94 + 0.06 * g), k * (0.96 + 0.04 * g), k * (1.06 - 0.06 * g)];
  };
  const K = new Kit(batch, matrix(x, y, z, ry), shadeFn);
  K.seed = 7 + Math.floor(Math.abs(x * 13 + z * 7)) % 1000;
  const st = mat('stone_found'), red = mat('planks_barnred'), wd = mat('timber_dark'), sh = mat('shingles_wood');
  const gy = o.ground || (() => 0);
  const baseIn = ly => P.R + 0.27 - 0.11 * ly / 3.1;                          // stone base: 2.97 at the ground, 2.86 at 3.1 m
  const smockIn = ly => P.R + 0.18 - 0.15 * (ly - 3.35) / (H - 0.3 - 3.35);   // smock: 2.88 → 2.73 under the cap
  // an n-sided ring with a face (not a corner) toward +z; radii are inradii; rep = [u repeats, v repeats];
  // around: the texture's v runs round the ring (wood grain along a band)
  const ring = (m, y0, y1, rin0, rin1, n, rep, ro = {}) => {
    const c = Math.cos(Math.PI / n), g = new THREE.CylinderGeometry(rin1 / c, rin0 / c, y1 - y0, n, ro.hseg || 1, !!ro.open);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i); if (ro.around) uv.setXY(i, v * rep[1], u * rep[0]); else uv.setXY(i, u * rep[0], v * rep[1]); }
    return K.add(m, g, { uv: 'keep', ...ro, at: matrix(0, (y0 + y1) / 2, 0, Math.PI / n) });
  };

  // fieldstone base (deep in the ground for slopes), a heavy timber sill, the oxblood smock
  ring(st, -3, 3.1, baseIn(-3), baseIn(3.1), 12, [8, 2.8], { open: true });
  ring(wd, 3.0, 3.42, 2.99, 2.97, 12, [10, 0.4], { around: true });
  ring(red, 3.35, H - 0.3, smockIn(3.35), smockIn(H - 0.3), 8, [8, 3.4], { open: true, hseg: 4 });
  // corner posts on the smock's eight arrises, and two bands round it
  const c8 = Math.cos(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + k * Math.PI / 4, r0 = smockIn(3.35) / c8 - 0.02, r1 = smockIn(H - 0.3) / c8 - 0.02;
    K.beam(wd, [Math.sin(a) * r0, 3.38, Math.cos(a) * r0], [Math.sin(a) * r1, H - 0.28, Math.cos(a) * r1], 0.26, 0.18, { roll: a, tile: 2.4 });
  }
  for (const yb of [7.35, H - 0.62]) ring(wd, yb - 0.13, yb + 0.13, smockIn(yb) + 0.06, smockIn(yb) + 0.06, 8, [8, 0.12], { around: true });
  // the curb the cap turns on, the eave's fascia and soffit, the kicked witch-hat cap, a finial
  ring(wd, H - 0.32, H + 0.04, 2.86, 2.86, 16, [12, 0.3], { around: true });
  K.add(wd, new THREE.CylinderGeometry(4.08, 4.1, 0.22, 16, 1, true), { uv: 'keep', uvScale: [12, 0.2], at: matrix(0, H - 0.15, 0) });
  K.add(wd, new THREE.RingGeometry(2.8, 4.1, 16, 1), { uv: 'keep', uvScale: [3, 3], at: matrix(0, H - 0.24, 0, 0, Math.PI / 2) });
  const prof = [[4.1, H - 0.06], [3.72, H + 0.16], [3.32, H + 0.46], [2.88, H + 1.02], [2.36, H + 1.78], [1.8, H + 2.62], [1.22, H + 3.48], [0.66, H + 4.3], [0.25, H + 4.92], [0.02, H + 5.22]];
  K.add(sh, new THREE.LatheGeometry(prof.map(([r, yy]) => new THREE.Vector2(r, yy)), 16), { uv: 'keep', uvScale: [11, 2.8], tint: '#e8d0b0' });
  K.add(wd, new THREE.SphereGeometry(0.22, 8, 6), { uv: 'keep', at: matrix(0, H + 5.27, 0) });
  K.add(wd, new THREE.ConeGeometry(0.07, 0.8, 6), { uv: 'keep', at: matrix(0, H + 5.8, 0) });
  // the hood over the windshaft, its little shake roof, and the shaft itself (tilted up out of the cap)
  const t = P.tilt, dir = V3(0, Math.sin(t), Math.cos(t)), hub = V3(0, P.hubY, P.hubZ);
  K.push(0, P.hubY - 0.08, 0);
  K.prism(red, [[-0.72, -0.62], [0.72, -0.62], [0.72, 0.18], [0, 0.74], [-0.72, 0.18]], 2.2, 1.7, { tile: 2.4 });
  for (const s of [-1, 1]) K.box(sh, 0.98, 0.08, 1.9, s * 0.37, 0.5, 2.2 + 0.9, { rz: -s * 0.64, grain: 'x', tile: 2.2 });
  K.box(wd, 1.6, 0.14, 0.14, 0, -0.62, 3.92, { grain: 'x' });
  K.pop();
  K.cyl(wd, hub.clone().addScaledVector(dir, -2.4).toArray(), hub.clone().addScaledVector(dir, -0.3).toArray(), 0.3, 0.28, { sides: 8 });
  // the fantail: a little spoked rotor on a frame behind the cap that keeps the sails in the wind
  const fy = H + 1.4, fz = -5.45;
  for (const s of [-1, 1]) K.beam(wd, [s * 0.95, H + 0.15, -3.3], [s * 0.2, fy - 0.1, fz + 0.1], 0.14, 0.14);
  K.beam(wd, [0, H + 2.4, -1.9], [0, fy + 0.15, fz + 0.05], 0.14, 0.14);
  K.cyl(wd, [-0.35, fy, fz], [0.35, fy, fz], 0.12, 0.12, { sides: 6 });
  for (let k = 0; k < 6; k++) { K.push(0, fy, fz, 0, k * Math.PI / 3); K.box(wd, 0.05, 0.95, 0.36, 0, 0.58, 0, { seg: [1, 1, 1], ry: 0.5 }); K.pop(); }
  // the door, framed in dark timber, at the ground in front; windows dotted up the smock (lit at night)
  // (boards and straps in the mill's own timber and iron, so the door costs no draw call of its own)
  const dy0 = gy(0, baseIn(0)) - 0.05, dIn = baseIn(dy0 + 1.05), ir = mat('iron_wrought');
  K.push(0, dy0 + 1.05, dIn + 0.02, 0, -0.035);
  for (let k = 0; k < 4; k++) K.box(wd, 0.265, 2.1 - (k % 2) * 0.03, 0.09, -0.41 + k * 0.275, -(k % 2) * 0.015, 0, { tint: ['#d8b898', '#c8a888', '#e0c0a0', '#c0a080'][k], tile: 1.6 });
  for (const sy of [-0.62, 0.66]) K.box(ir, 1.0, 0.09, 0.03, -0.04, sy, 0.06, { tile: 0.6, seg: [1, 1, 1] });
  K.add(ir, new THREE.TorusGeometry(0.07, 0.016, 4, 10), { uv: 'keep', at: matrix(0.36, -0.05, 0.07) });
  K.pop();
  for (const s of [-1, 1]) K.box(wd, 0.2, 2.4, 0.2, s * 0.66, dy0 + 1.2, dIn + 0.04, { rx: -0.035 });
  K.box(wd, 1.75, 0.28, 0.28, 0, dy0 + 2.42, baseIn(dy0 + 2.4) + 0.06, { grain: 'x' });
  for (const [k, wy] of [[0, 5.25], [2, 6.7], [6, 8.1], [3, 9.7], [5, 4.9], [0, 9.2]]) {
    const a = k * Math.PI / 4, r = smockIn(wy);
    K.push(0, wy, 0, a);
    K.box(wd, 0.8, 1.0, 0.08, 0, 0, r + 0.03, { seg: [1, 1, 1] });
    K.quad(winMat(), 0.56, 0.74, 0, 0, r + 0.075, { shade: false });
    K.box(wd, 0.96, 0.09, 0.2, 0, -0.53, r + 0.09, { grain: 'x', seg: [1, 1, 1] });
    K.pop();
  }
  // a lantern on an iron bracket beside the door (glass and iron the roadside signs already use)
  {
    const a = Math.PI / 6, r = baseIn(dy0 + 2.6);
    K.push(0, 0, 0, a);
    K.box(ir, 0.06, 0.06, 0.62, 0, dy0 + 2.62, r + 0.29, { tile: 0.5, seg: [1, 1, 1] });
    K.beam(ir, [0, dy0 + 2.2, r + 0.02], [0, dy0 + 2.6, r + 0.4], 0.04, 0.04, { tile: 0.5 });
    lantern({ glows: o.glows }, [0, dy0 + 2.3, r + 0.52], 0.48, true, K);
    K.pop();
  }
  // a trodden apron of flags and stepping stones out from the door, laid on the ground
  if (o.ground) {
    const L = 4.6, z0 = baseIn(0) - 0.12, g = new THREE.PlaneGeometry(3.0, L, 6, 10), p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { const lx = p.getX(i), lz = z0 + (L / 2 - p.getY(i)); p.setXYZ(i, lx, gy(lx, lz) + 0.03, lz); uv.setY(i, 1 - (1 - uv.getY(i)) * (L / 5)); }
    g.computeVertexNormals();
    K.add(apronMat('farm'), g, { uv: 'keep', cast: false, shade: () => 0.9 });
  }
  // a cart wheel leant against the stones beside the door
  {
    const a = -0.62, r = baseIn(0.6), wr = 0.58;
    K.push(Math.sin(a) * r, gy(Math.sin(a) * r, Math.cos(a) * r) + 0.6, Math.cos(a) * r + 0, a, -0.16);
    K.push(0, 0, 0.16, 0, 0, 0.3);
    K.add(wd, new THREE.TorusGeometry(wr, 0.075, 6, 18), { uv: 'keep', uvScale: [6, 1], tint: '#d0a888' });
    K.add(ir, new THREE.TorusGeometry(wr + 0.05, 0.03, 4, 18), { uv: 'keep', uvScale: [6, 1] });
    for (let k = 0; k < 5; k++) { const b = k / 5 * Math.PI; K.beam(wd, [Math.cos(b) * wr, Math.sin(b) * wr, 0], [-Math.cos(b) * wr, -Math.sin(b) * wr, 0], 0.055, 0.055, { tint: '#d0a888' }); }
    K.add(wd, new THREE.CylinderGeometry(0.14, 0.14, 0.24, 10), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2) });
    K.pop(); K.pop();
  }

  // the sails
  if (sailsBatch) windmillSails(new Kit(sailsBatch, new THREE.Matrix4(), (sx, sy) => 0.8 + 0.2 * sstep(0.2, 3, Math.hypot(sx, sy))), P);
  return { hub: hub.applyMatrix4(K.root), tilt: t };
}
function windmillSails(S, P) {
  const wd = mat('timber_dark'), sail = mat('sail_canvas', { alphaTest: 0.5, side: THREE.DoubleSide });
  const L = P.sail, w = P.sailW, d0 = 1.45, d1 = L;
  // the poll end the stocks pass through, and its boss
  S.box(wd, 0.72, 0.72, 0.56, 0, 0, -0.05, { seg: [1, 1, 1], tile: 0.8 });
  S.cyl(wd, [0, 0, 0.2], [0, 0, 0.55], 0.32, 0.2, { sides: 8 });
  S.cyl(wd, [0, 0, -0.55], [0, 0, -0.2], 0.42, 0.42, { sides: 10 });
  for (let k = 0; k < 4; k++) {
    const furl = k === 3, cl = furl ? (d1 - d0) * 0.42 : d1 - d0;
    S.push(0, 0, 0, 0, 0, k * Math.PI / 2);
    S.beam(wd, [0, 0.3, 0.02], [0, L + 0.3, 0.02], 0.28, 0.22, { tile: 2.4 });
    // canvas bowed behind the lattice (the furled one shows its lattice and a roll of cloth)
    S.add(sail, new THREE.PlaneGeometry(w, cl, 3, 8), { uv: 'keep', uvScale: [1, cl / (d1 - d0)], at: matrix(0.16 + w / 2, d0 + cl / 2, -0.07), tint: '#f4dcb2', warp: v => { v.z -= 0.14 * Math.cos(Math.PI * v.x / w) * Math.sin(Math.PI * (v.y / cl + 0.5)); } });
    const nb = Math.max(4, Math.round((d1 - d0) / 0.85));
    for (let j = 0; j <= nb; j++) S.box(wd, w + 0.2, 0.11, 0.1, 0.16 + w / 2, d0 + (d1 - d0) * j / nb, 0.1, { grain: 'x', seg: [1, 1, 1] });
    S.box(wd, 0.13, d1 - d0 + 0.14, 0.12, 0.18 + w, (d0 + d1) / 2, 0.1, { seg: [1, 2, 1] });
    S.box(wd, 0.36, d1 - d0 - 0.7, 0.06, -0.32, (d0 + d1) / 2 + 0.35, 0.0, { seg: [1, 2, 1] });
    if (furl) {
      const a = [0.42, d0 + cl + 0.05, 0.04], b = [0.3, d1 - 0.25, 0.04];
      S.cyl(sail, a, b, 0.2, 0.09, { sides: 7, uvScale: [0.5, 3], uvOff: [0.25, 0], tint: '#dcc49c', warp: v => { v.x *= 1 + 0.12 * Math.sin(v.y * 4.1); } });
      for (const f of [0.15, 0.45, 0.75]) S.box(wd, 0.46 - f * 0.2, 0.07, 0.36 - f * 0.18, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0.04, { seg: [1, 1, 1] });
    }
    S.pop();
  }
}

// ---- interactables -------------------------------------------------------------------------------

// a brass-collared glass dome; each colour is its own glowing glass (deal green, all-in red, clear grey,
// bet gold) so they read apart from the stool. labelUp staggers neighbouring hover labels.
// (BTN values index the four glasses painted side by side in arch_btn_glass: one material for them all)
const BTN = { bet: 0, all: 1, clear: 2, deal: 3 };
function button(u, color, text, batch, lift = 0, labelUp = 0) {
  const K = new Kit(batch, matrix(u.x, u.y - 0.04 + lift, u.z), () => 1);
  K.cyl(mat('brass'), [0, -0.05, 0], [0, 0.02, 0], 0.15, 0.13, { sides: 12 });
  const dome = new THREE.SphereGeometry(0.1, 12, 6, 0, TAU, 0, Math.PI / 2), duv = dome.attributes.uv;
  for (let i = 0; i < duv.count; i++) duv.setX(i, (color + 0.1 + duv.getX(i) * 0.8) / 4);
  K.add(mat('arch_btn_glass', { emissive: '#ffffff', emissiveIntensity: 0.5 }), dome, { uv: 'keep', at: matrix(0, 0.02, 0), shade: false, cast: false });
  if (text) {
    const s = labelSprite(text, '#f4e6c0', 34);
    own(s.material.map, s.material);
    s.scale.set(0.9, 0.17, 1);
    s.position.set(u.x, u.y + 0.22 + lift + labelUp, u.z);
    return s;
  }
  return null;
}
// the engraved brass plaques naming the buttons, on little brackets at the rail in front of each dome
// (their faces are in the sign atlas), tilted up toward whoever stands there
const PLAQUE = { '+100': '+100', '+500': '+500', all: 'ALL IN', clear: 'CLEAR', deal: 'DEAL' };
function plaqueSpots(W, T) {
  const out = [];
  for (const u of W.uses) {
    if (u.kind === 'bj' && PLAQUE[u.arg]) out.push({ u, lines: [PLAQUE[u.arg]], w: 0.34, h: 0.12, ry: T.bj.ry, lift: 0.08, out: 0.17, drop: 0.13 });
    else if (u.kind === 'flip' && u.arg !== 'pull' && PLAQUE[u.arg]) out.push({ u, lines: [PLAQUE[u.arg]], w: 0.3, h: 0.11, ry: T.flip.ry, lift: 0, out: 0.17, drop: 0.12 });
  }
  return out;
}

// ---- the town -------------------------------------------------------------------------------------

export function buildStructures(W) {
  disposeOwned();
  const group = new THREE.Group();
  const local = new THREE.Group();   // the town's own loose objects (NPCs, labels, rugs, the coin...)
  group.add(local);
  const near = [];
  const npcs = [];
  const T = W.town;
  // one batch per spatial cluster: the town, each roadside stop, each lone sign
  const pois = W.pois || [];
  const batch = new ClusterBatch((x, z) => {
    if (T && z > T.z - 25 && z < T.z + 205 && Math.abs(x) < 95) return 'town';
    for (const p of pois) if (Math.hypot(x - p.x, z - p.z) < 32) return 'poi' + p.id;
    return 'c' + Math.floor(z / 250);
  });
  const glows = [];
  const style = (W.buildings[0] && W.buildings[0].style) || (W.biome && { meadow: 'timber', fields: 'farm', snow: 'alpine', badlands: 'frontier', desert: 'adobe' }[W.biome]) || 'timber';
  const S = { ...(STYLES[style] || STYLES.timber), name: style };

  // buildings, with their signs matched first (the front gable is sized to carry the sign)
  const attached = new Map(), bySign = new Map(), onCanopy = new Map();
  for (const s of W.signs) {
    const m = matchSign(s, W.buildings);
    if (!m) continue;
    const cz = m.b.kind === 'gas' && W.decor.find(d => d.k === 'canopy' && Math.hypot(d.x - m.b.x, d.z - m.b.z) < 10);
    if (cz) onCanopy.set(s, cz); else { attached.set(s, m); bySign.set(m.b, s); }
  }
  const bInfo = new Map();
  for (const b of W.buildings) {
    const s = bySign.get(b), m = s && attached.get(s);
    const info = buildBuilding(batch, b, s ? { w: s.w, h: s.h, top: m.ly + s.h / 2, bottom: m.ly - s.h / 2 } : null);
    bInfo.set(b, info);
    glows.push(...info.glows);
  }
  buildAprons(W, batch, style);

  // town furniture and anything else not drawn elsewhere
  const slotCols = ['#e63946', '#f1c40f', '#2a9d8f', '#e76f51', '#8338ec'];
  let slotI = 0;
  const domes = [];
  const fctx = { glows, domes, styleName: style, casino: W.buildings.find(b => b.kind === 'casino'), slotTint: () => new THREE.Color('#ffffff').lerp(new THREE.Color(muteColor(slotCols[slotI++ % 5], { sMax: 0.5, lMin: 0.35, lMax: 0.6 })), 0.55).toArray() };
  for (const s of W.statics) {
    if (s.mat === 'invisible' || isRoadside(s) || s.bld !== undefined) continue;
    if (s.part === 'shop_shelf' || s.part === 'rim_slab' || s.part === 'rock_ledge') continue;   // colliders only: town_build's shopShelves and rimCode draw these
    if (YARD_PARTS.has(s.part)) yardProp(s, batch, style, glows);
    else furniture(s, batch, fctx);
  }

  // price boards for the store's goods go into the sign atlas
  const tags = [];
  const store = W.buildings.find(b => b.kind === 'store');
  for (const u of W.uses) if (u.kind === 'buy') tags.push({ u, lines: [{ walkie: 'WALKIE', drink: 'ENERGY', bungee: 'BUNGEES' }[u.arg] || u.arg.toUpperCase(), { walkie: '$150', drink: '$40', bungee: '$90' }[u.arg] || ''], w: 0.46, h: 0.26 });
  const entry = T && W.signs.find(s => s.post && Math.abs(s.z - (T.z + 6)) < 3 && Math.abs(s.x - 7.5) < 3);
  const sctx = { attached, onCanopy, bInfo, glows, tags, plaques: plaqueSpots(W, T), style: S, styleName: style, tagRy: store ? store.ry : 0, townZ: T.z, entry };
  buildSigns(W, batch, group, near, sctx);

  for (const d of W.decor) if (d.k === 'lamp') lampPost(batch, d, style, glows);

  // Westfall windmills: world gen's (W.decor 'windmill', solid: a cylinder r 2.7 m, 12 m tall, 19-25 m off
  // the road), fitted to its collider, its sails turned toward the road where the drivers come from and
  // shortened if the ground under them rises; and on a farm day one more out past the end of town, behind
  // the world's edge (no collider), standing over the RV lot. Each one's sails turn in their own group.
  const mills = [];
  const addMill = (x, y, z, ry, o, parent) => {
    const sb = new Batch(), P = { ...MILL, ...o };
    if (o.fit) {   // the sail tips (and the lattice's outer corners) keep 2.7 m over the ground all the way round
      const M = matrix(x, y, z, ry).multiply(matrix(0, P.hubY, P.hubZ, 0, -P.tilt)), v = new THREE.Vector3();
      const clear = L => { const R = Math.hypot(L + 0.3, P.sailW + 0.3); for (let a = 0; a < TAU; a += TAU / 60) for (const f of [0.55, 0.8, 1]) { v.set(Math.cos(a) * R * f, Math.sin(a) * R * f, 0).applyMatrix4(M); if (v.y - W.heightAt(v.x, v.z) < 2.7) return false; } return true; };
      while (P.sail > 6 && !clear(P.sail)) P.sail -= 0.25;
    }
    const c = Math.cos(ry), s = Math.sin(ry);
    const m = windmill(batch, x, y, z, ry, sb, { ...P, glows, ground: o.fit ? (lx, lz) => W.heightAt(x + lx * c + lz * s, z - lx * s + lz * c) - y : undefined });
    const g = new THREE.Group();
    for (const mesh of sb.build(g)) mesh.castShadow = mesh.material.userData.paint === 'sail_canvas';   // the cloth's shadow carries the shape
    g.position.copy(m.hub);
    g.rotation.order = 'YXZ';
    g.rotation.set(-m.tilt, ry, 0);
    parent.add(g);
    mills.push({ g, phase: mills.length * 0.9 + 0.3, c: V3(x, y + 9, z), town: parent === local });
  };
  for (const d of W.decor) if (d.k === 'windmill') {
    // d.ry faces the road square on; turn it up to 40 degrees toward the road 22 m back, so the drivers
    // coming up the valley see the sails' faces, not their edges
    const zb = d.z - 22, aim = W.roadX ? Math.atan2(W.roadX(zb) - d.x, zb - d.z) : d.ry;
    const dv = Math.atan2(Math.sin(aim - d.ry), Math.cos(aim - d.ry)), ry = d.ry + Math.max(-0.7, Math.min(0.7, dv));
    addMill(d.x, d.y, d.z, ry, { fit: true }, group);
  }
  if (style === 'farm' && W.Z1 !== undefined) {
    const side = (W.seed & 2) ? -1 : 1, z = W.Z1 + 15, x = W.roadX(W.Z1) + side * 27;
    addMill(x, W.heightAt(x, W.Z1 - 1) + 0.3, z, Math.atan2(-x, (T.z + 60) - z), {}, local);   // turned to face down the street
  }

  // NPCs: Honest Ed, the clerk, the dealer, the Repo Man (people.js dresses them by color)
  const npc = (spot, color, opts, label) => {
    const ch = buildCharacter(color, opts);
    ch.root.position.set(spot.x, spot.y, spot.z);
    ch.root.rotation.y = spot.ry ?? 0;
    shadowy(ch.root);
    local.add(ch.root);
    if (label) {
      const s = labelSprite(label, '#ffe9a8', 30);
      own(s.material.map, s.material);
      s.position.set(spot.x, spot.y + 2.25 * (opts.scale || 1) + 0.1, spot.z);
      s.scale.set(1.9, 0.36, 1);
      local.add(s);
    }
    npcs.push(ch);
    return ch;
  };
  npc({ ...T.pawnKeeper, y: T.pawnKeeper.y + 0.1, ry: T.pawnKeeper.ry }, '#c0392b', { hatIndex: 2, skinIndex: 3, outfit: 'ed' }, 'HONEST ED');
  npc({ ...T.clerk, y: T.clerk.y + 0.1, ry: T.clerk.ry }, '#2e86ab', { hatIndex: 0, skinIndex: 4, outfit: 'clerk' }, 'CLERK');
  // the dealer keeps his spot (world.js) and turns to the players' edge of the table, between HIT and STAND
  const dl = T.bj.dealer, tgt = { x: (T.bj.hit.x + T.bj.stand.x) / 2, z: (T.bj.hit.z + T.bj.stand.z) / 2 };
  npc({ ...dl, y: dl.y + (style === 'timber' ? 0.12 : 0.1), ry: Math.atan2(tgt.x - dl.x, tgt.z - dl.z) }, '#111111', { hatIndex: 1, skinIndex: 4, eyeColor: '#d62828', outfit: 'dealer' }, 'THE DEALER');
  const repoSpot = { x: T.repo.x - 2.4, y: T.repo.y, z: T.repo.z + 0.6, ry: -Math.PI / 2 };   // street side, facing you
  npc(repoSpot, '#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25, outfit: 'repo' }, 'THE REPO MAN');   // people.js gives him brass aviators
  towTruck(T.repo, batch, glows);

  // pawn counter appraisal + casino furniture
  // Ed's placard: the label's own canvas (main.js rewrites it) on a plank board hung over the counter from
  // the ceiling on two chains, facing the door (it doesn't turn to follow you; the sprite stays unparented)
  const pawnLabel = labelSprite('', '#7CFC00', 32);
  own(pawnLabel.material.map, pawnLabel.material);
  pawnLabel.position.set(T.pawn.x, T.pawn.y + 1.95, T.pawn.z);
  pawnLabel.scale.set(3.0, 0.56, 1);
  {
    const pb = W.buildings.find(b => b.kind === 'pawn');
    const ry = pb ? pb.ry : 0, y0 = T.pawn.y - 1.0, ceil = y0 + (pb ? pb.h : 3.6) - 0.04;
    const PW = 2.9, PH = PW * 96 / 512, by = Math.min(y0 + 2.82, ceil - 0.55);   // clear of Ed's nameplate
    const board = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), own(new THREE.MeshBasicMaterial({ map: pawnLabel.material.map, color: '#e4dccf', alphaTest: 0.4 })));
    board.position.set(T.pawn.x + Math.sin(ry) * 0.03, by, T.pawn.z + Math.cos(ry) * 0.03);
    board.rotation.y = ry;
    local.add(board);
    const K = new Kit(batch, matrix(T.pawn.x, by, T.pawn.z, ry), () => 0.9);
    const iron = mat('iron_wrought');
    K.box(mat('timber_dark'), PW - 0.08, 0.3, 0.05, 0, 0, -0.005, { grain: 'x', tile: 1.2, seg: [2, 1, 1] });
    for (const sx of [-1, 1]) {
      const x = sx * (PW / 2 - 0.3), y1 = ceil - by;
      K.add(iron, new THREE.TorusGeometry(0.045, 0.013, 4, 8), { uv: 'keep', at: matrix(x, 0.17, 0.0, Math.PI / 2) });
      for (let y = 0.24, k = 0; y < y1 - 0.02; y += 0.085, k++) K.add(iron, new THREE.TorusGeometry(0.035, 0.011, 4, 8), { uv: 'keep', at: matrix(x, y, 0, k % 2 ? Math.PI / 2 : 0, 0, Math.PI / 2) });
      K.box(iron, 0.12, 0.03, 0.12, x, y1 - 0.01, 0, { tile: 0.5 });
    }
  }

  const bj = T.bj;
  // hit / stand: round woven rugs that pulse (main.js drives emissiveIntensity)
  const pad = (z, name, color) => {
    const t = tex(name);
    const m = own(new THREE.MeshLambertMaterial({ map: t, emissive: new THREE.Color(color), emissiveMap: t, emissiveIntensity: 0.15, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -4 }));
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(z.r, 32), m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    const holder = new THREE.Group();
    holder.position.set(z.x, T.y + 0.13, z.z);
    holder.rotation.y = bj.ry;
    holder.add(mesh);
    local.add(holder);
    return mesh;
  };
  const hitPad = pad(bj.hit, 'pad_hit', '#ffb070');
  const standPad = pad(bj.stand, 'pad_stand', '#a8c8ff');
  const cardGroup = new THREE.Group();
  local.add(cardGroup);
  const bjLabel = labelSprite('', '#fff', 32);
  own(bjLabel.material.map, bjLabel.material);
  bjLabel.position.set(bj.table.x, bj.table.y + 1.25, bj.table.z);
  bjLabel.scale.set(3.4, 0.64, 1);
  local.add(bjLabel);
  const flipLabel = labelSprite('', '#ffd166', 30);
  own(flipLabel.material.map, flipLabel.material);
  flipLabel.position.set(T.flip.x, T.flip.y + 3.55, T.flip.z);
  flipLabel.scale.set(3.4, 0.64, 1);
  local.add(flipLabel);
  // the coin, spinning in a glass dome on top of the machine
  const coinFace = own(new THREE.MeshLambertMaterial({ map: tex('coin_face'), emissive: new THREE.Color('#3a2a00'), emissiveMap: tex('coin_face'), emissiveIntensity: 0.6 }));
  const coinEdge = own(new THREE.MeshLambertMaterial({ map: tex('brass'), emissive: new THREE.Color('#2a1a00') }));
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.06, 24), [coinEdge, coinFace, coinFace]);
  coin.position.set(T.flip.x, T.flip.y + 2.78, T.flip.z);
  coin.rotation.x = Math.PI / 2;
  local.add(coin);
  const glassM = own(new THREE.MeshLambertMaterial({ color: '#d8ecf4', transparent: true, opacity: 0.3, depthWrite: false, emissive: new THREE.Color('#304858') }));
  for (const p of domes) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 10, 0, TAU, 0, Math.PI * 0.6), glassM);
    dome.position.copy(p).add(V3(0, 0.18, 0));
    dome.scale.set(1, 1.35, 1);
    dome.renderOrder = 3;
    local.add(dome);
  }

  // casino and pawn lights: warm lamplight
  const cl = new THREE.PointLight(0xffc078, 18, 22, 1.4); cl.position.set(T.casino.x, T.casino.y + 4.2, T.casino.z); group.add(cl);
  const cl2 = new THREE.PointLight(0xffe0a0, 14, 18, 1.4); cl2.position.set(T.bj.table.x, T.casino.y + 3.6, T.bj.table.z); group.add(cl2);
  const pl = new THREE.PointLight(0xffe2b0, 10, 14, 1.4); pl.position.set(T.pawn.x, T.y + 3.2, T.pawn.z); group.add(pl);

  // interactable bits
  // bet / stake buttons: neighbours' hover labels alternate high and low so they never overlap
  const stagger = new Map();
  for (const kind of ['bj', 'flip']) {
    const us = W.uses.filter(u => u.kind === kind && u.arg !== 'pull');
    const a = kind === 'bj' ? T.bj.ry : T.flip.ry, ax = Math.cos(a), az = -Math.sin(a);
    us.sort((p, q) => (p.x * ax + p.z * az) - (q.x * ax + q.z * az)).forEach((u, i) => stagger.set(u, i % 2 ? 0.24 : 0));
  }
  for (const u of W.uses) {
    if (u.kind === 'pawnBell') {
      const K = new Kit(batch, matrix(u.x, u.y - 0.08, u.z), () => 1);
      K.cyl(mat('timber_dark'), [0, -0.01, 0], [0, 0.03, 0], 0.16, 0.15, { sides: 12 });
      K.add(mat('brass'), new THREE.SphereGeometry(0.12, 14, 8, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0.03, 0) });
      K.cyl(mat('brass'), [0, 0.14, 0], [0, 0.2, 0], 0.02, 0.02, { sides: 6 });
      K.add(mat('brass'), new THREE.SphereGeometry(0.03, 8, 6), { uv: 'keep', at: matrix(0, 0.21, 0) });
    } else if (u.kind === 'bj') {
      const s = button(u, BTN[u.arg] ?? BTN.bet, u.label.replace('Bet ', ''), batch, 0.08, stagger.get(u) || 0);
      if (s) local.add(s);
    } else if (u.kind === 'flip') {
      if (u.arg === 'pull') {
        // the crank lever on the contraption's flank
        const K = new Kit(batch, matrix(u.x, u.y - 0.3, u.z, T.flip.ry), () => 1);
        K.box(mat('brass'), 0.2, 0.3, 0.2, 0, -0.2, 0, { tile: 1 });
        K.add(mat('brass'), new THREE.CylinderGeometry(0.14, 0.14, 0.05, 12), { uv: 'keep', at: matrix(0, -0.05, 0) });
        K.cyl(mat('iron_wrought'), [0, 0, 0], [0, 0.8, 0.1], 0.035, 0.03, { sides: 6 });
        K.add(mat('wood_light'), new THREE.SphereGeometry(0.12, 10, 8), { uv: 'keep', at: matrix(0, 0.85, 0.11), tint: '#c03a2a' });
      } else { const s = button(u, u.arg === 'all' ? BTN.all : BTN.bet, u.label.replace('Stake ', ''), batch, 0, stagger.get(u) || 0); if (s) local.add(s); }
    } else if (u.kind === 'buy') {
      const ry = store ? store.ry : 0;
      const K = new Kit(batch, matrix(u.x, u.y - 0.1, u.z, ry), () => 1);
      if (u.arg === 'walkie') {
        K.box(mat('metal_green'), 0.13, 0.22, 0.08, 0, 0.11, 0, { uv: 'keep' });
        K.box(mat('brass'), 0.1, 0.06, 0.02, 0, 0.16, 0.045, { tile: 1 });
        K.cyl(mat('iron_wrought'), [0.04, 0.22, 0], [0.05, 0.44, 0], 0.012, 0.008, { sides: 5 });
        K.add(mat('brass'), new THREE.SphereGeometry(0.018, 6, 5), { uv: 'keep', at: matrix(0.05, 0.45, 0) });
      } else if (u.arg === 'drink') {
        const gm = mat('lantern_glass', { emissive: '#60ff40', emissiveIntensity: 0.5 });
        K.add(gm, new THREE.SphereGeometry(0.075, 12, 10), { uv: 'keep', at: matrix(0, 0.08, 0), tint: '#70e050', shade: false });
        K.cyl(gm, [0, 0.14, 0], [0, 0.22, 0], 0.025, 0.022, { sides: 8, tint: '#a8e898' });
        K.cyl(mat('wood_light'), [0, 0.22, 0], [0, 0.26, 0], 0.028, 0.028, { sides: 8 });
        glows.push({ p: V3(0, 0.08, 0).applyMatrix4(K.root), s: 0.5, col: '#80ff60' });
      } else {
        K.add(mat('wood_light'), new THREE.TorusGeometry(0.1, 0.035, 6, 14), { uv: 'keep', at: matrix(0, 0.04, 0, 0, Math.PI / 2), tint: '#d89040' });
        K.add(mat('wood_light'), new THREE.TorusGeometry(0.07, 0.03, 6, 12), { uv: 'keep', at: matrix(0.02, 0.09, 0, 0, Math.PI / 2 + 0.2), tint: '#c07838' });
        for (const s of [-1, 1]) K.add(mat('brass'), new THREE.TorusGeometry(0.03, 0.01, 4, 8, Math.PI * 1.4), { uv: 'keep', at: matrix(s * 0.12, 0.08, 0.05) });
      }
    }
  }

  // all the merged statics (one group per cluster), the glow cloud
  const clusters = batch.build(group);
  const townCluster = clusters.find(c => c.key === 'town');
  const gp = glows.length ? glowPoints(glows) : null;
  if (gp) group.add(gp);

  const winM = winMat(), glassM2 = glassMat(), faces = sctx.faces;
  let lastNight = -1;
  // Rooms: from inside a building the outside shows only through the door (the windows are opaque
  // glowing glass), so other clusters (roadside stops, lone signs) that can't be seen through the door
  // gap are skipped while the camera is indoors.
  const rooms = W.buildings.map(b => ({ x: b.x, y: b.y, z: b.z, c: Math.cos(b.ry), s: Math.sin(b.ry), hw: b.w / 2 - 0.2, hd: b.dep / 2 - 0.2, zf: b.dep / 2 + 0.15, h: b.h, dw: (b.door || 1.6) / 2, dh: b.h - 0.8 }));
  const roomOf = p => { for (const r of rooms) { const dx = p.x - r.x, dz = p.z - r.z, lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c; if (Math.abs(lx) < r.hw && Math.abs(lz) < r.hd && p.y > r.y && p.y < r.y + r.h) return r; } return null; };
  const throughDoor = (r, p, cl) => {
    const cx = cl.center.x - r.x, cz = cl.center.z - r.z, R = cl.radius;
    if (Math.hypot(cx, cz) < R + 1) return true;                       // the cluster this building is in
    const px = cx * r.c - cz * r.s, pz = cx * r.s + cz * r.c, py = cl.center.y - r.y;
    if (pz + R < r.zf) return false;                                   // wholly behind the front wall's plane
    if (pz - R <= r.zf) return true;                                   // straddles it: keep
    const ex = p.x - r.x, ez = p.z - r.z, qx0 = ex * r.c - ez * r.s, qz0 = ex * r.s + ez * r.c, qy0 = p.y - r.y;
    const t = (r.zf - qz0) / (pz - qz0), qx = qx0 + t * (px - qx0), qy = qy0 + t * (py - qy0);
    const cos = (pz - qz0) / Math.max(1e-3, Math.hypot(px - qx0, py - qy0, pz - qz0));
    const m = R * t * 1.3 / Math.max(0.2, cos) + 0.3;
    return Math.abs(qx) < r.dw + m && qy > -m && qy < r.dh + m;
  };
  return {
    group, near, npcs,
    update(dt, t, camPos) {
      for (const n of near) n.mesh.visible = Math.hypot(camPos.x - n.x, camPos.y - n.y, camPos.z - n.z) < n.r;
      // how dark is it? (0 by day .. 1 at full night, from the atmosphere)
      const night = Math.max(0, Math.min(1, atmo.night || 0));
      // clusters wholly inside the fog are not drawn at all (the town from camp, stops far down the road)
      const fog = group.parent && sceneOf(group).fog;
      const far = fog && fog.far ? fog.far + 40 : 1e9;
      const room = roomOf(camPos);
      for (const cl of clusters) cl.group.visible = camPos.distanceTo(cl.center) - cl.radius < far && (!room || throughDoor(room, camPos, cl));
      local.visible = !townCluster || townCluster.group.visible;
      if (Math.abs(night - lastNight) > 0.01) {
        lastNight = night;
        winM.emissiveIntensity = 0.3 + 1.1 * night;
        glassM2.emissiveIntensity = 0.85 + 0.6 * night;
        if (faces) { faces.lit.emissiveIntensity = 0.5 * night; faces.dim.emissiveIntensity = 0.2 * night; }
      }
      for (const m of mills) {
        m.g.visible = m.town ? local.visible : camPos.distanceTo(m.c) - 14 < far && (!room || throughDoor(room, camPos, { center: m.c, radius: 14 }));
        if (m.g.visible) m.g.rotation.z = t * 0.35 + m.phase;
      }
      if (gp) gp.material.uniforms.uOpacity.value = (0.16 + 0.84 * night) * (1 + 0.06 * Math.sin(t * 9.1) * Math.sin(t * 5.3));
    },
    pawnLabel, bjLabel, flipLabel, cardGroup, coin, hitPad, standPad,
  };
}

// ---- previews --------------------------------------------------------------------------------------

const PREVIEW_SIGNS = {
  pawn: ['HONEST ED\'S PAWN', 'WE BUY ANYTHING', '#f4d35e', '#2b2d42', 5, 1.3, 4.4],
  casino: ['LUCKY SLOP', 'CASINO · NO CLOCKS', '#ff2e88', '#fff9c4', 9, 2.4, 6.4],
  store: ['GENERAL STORE', 'OPEN 24/7 (NOT 7)', '#ffffff', '#1b4965', 4.4, 1.2, 4.2],
  gas: ['GAS · FOOD · REGRET', '', '#d64545', '#fff', 4.2, 0.9, 4.2],
};
const DIMS = { pawn: [12, 9, 3.6], store: [10, 8, 3.4], casino: [22, 18, 5.2], gas: [8, 6, 3.2] };
function previewTown(style, kinds, extraSigns = false) {
  const buildings = [], signs = [], decor = [];
  let x = 0;
  kinds.forEach((kind, i) => {
    const [w, dep, h] = DIMS[kind];
    const b = { id: i, kind, x: x + w / 2, y: 0, z: 0, ry: 0, w, dep, h, door: 1.6, style };
    buildings.push(b);
    const [l1, l2, bg, fg, sw, sh, sy] = PREVIEW_SIGNS[kind];
    signs.push({ x: b.x, y: sy, z: dep / 2 + 0.1, ry: 0, w: sw, h: sh, lines: l2 ? [l1, l2] : [l1], bg, fg, neon: kind === 'casino' });
    decor.push({ k: 'lamp', x: b.x - w / 2 - 1.5, y: 0, z: dep / 2 + 2.5 });
    x += w + 4;
  });
  if (extraSigns) {
    signs.push({ x: -4, y: 3, z: 9, ry: 0, w: 4.6, h: 1.8, lines: ['PAYDIRT', 'POP. 41 · EST. 1971'], bg: '#3a6b35', fg: '#fff', post: true });
    signs.push({ x: -12, y: 4.2, z: 6, ry: -0.35, w: 6.4, h: 2.6, lines: ['SLOPMASTER 9000', 'THE LAST RV YOU WILL EVER NEED'], bg: '#2e86ab', fg: '#fff', billboard: true });
  }
  const W = { buildings, signs, decor, statics: [], uses: [], heightAt: () => 0 };
  const batch = new Batch(), glows = [];
  const attached = new Map(), bySign = new Map();
  for (const s of signs) { const m = matchSign(s, buildings); if (m) { attached.set(s, m); bySign.set(m.b, s); } }
  const bInfo = new Map();
  for (const b of buildings) { const s = bySign.get(b); bInfo.set(b, buildBuilding(batch, b, s ? { w: s.w, h: s.h, top: s.y + s.h / 2, bottom: s.y - s.h / 2 } : null)); }
  buildSigns(W, batch, new THREE.Group(), [], { attached, bInfo, glows, tags: [], style: { ...STYLES[style], name: style }, styleName: style, entry: signs.find(s => s.post) });
  for (const d of decor) lampPost(batch, d, style, glows);
  const g = new THREE.Group();
  batch.build(g);
  return g;
}
function previewFurniture(style = 'timber') {
  const batch = new Batch(), glows = [], domes = [];
  const ctx = { glows, domes, styleName: style, slotTint: () => [1, 0.85, 0.8] };
  for (const [i, st] of ['timber', 'farm', 'alpine', 'frontier', 'adobe'].entries()) furniture({ part: 'slot_bank', x: 7.2 + i * 1.1, y: 1.0, z: 3, hx: 0.45, hy: 1.0, hz: 0.4, ry: 0 }, batch, { ...ctx, styleName: st });
  furniture({ part: 'bj_table', x: 0, y: 0.45, z: 0, hx: 1.8, hy: 0.45, hz: 1.0, ry: 0 }, batch, ctx);
  furniture({ part: 'flip_machine', x: 4.5, y: 1.1, z: 0, hx: 1.0, hy: 1.1, hz: 0.6, ry: 0 }, batch, ctx);
  for (let i = 0; i < 2; i++) furniture({ part: 'slot_bank', x: 7.2 + i * 1.1, y: 1.0, z: 0, hx: 0.45, hy: 1.0, hz: 0.4, ry: 0 }, batch, { ...ctx, slotTint: () => (i ? [0.9, 1, 0.9] : [1, 0.85, 0.8]) });
  furniture({ part: 'counter', x: 11.5, y: 0.5, z: 0, hx: 2.0, hy: 0.5, hz: 0.55, ry: 0 }, batch, ctx);
  const g = new THREE.Group();
  batch.build(g);
  const glassM = new THREE.MeshLambertMaterial({ color: '#d8ecf4', transparent: true, opacity: 0.3, depthWrite: false });
  for (const p of domes) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 10, 0, TAU, 0, Math.PI * 0.6), glassM); d.position.copy(p).add(V3(0, 0.18, 0)); d.scale.set(1, 1.35, 1); g.add(d); }
  return g;
}

export const PREVIEW = {
  towtruck: () => towTruck({ x: 0, y: 0, z: 0, ry: 1.25 }),
  town_timber: () => previewTown('timber', ['pawn', 'store']),
  town_farm: () => previewTown('farm', ['pawn', 'gas']),
  town_alpine: () => previewTown('alpine', ['pawn', 'store']),
  town_frontier: () => previewTown('frontier', ['pawn', 'gas']),
  town_adobe: () => previewTown('adobe', ['pawn', 'store']),
  casino_timber: () => previewTown('timber', ['casino']),
  casino_farm: () => previewTown('farm', ['casino']),
  casino_alpine: () => previewTown('alpine', ['casino']),
  casino_frontier: () => previewTown('frontier', ['casino']),
  casino_adobe: () => previewTown('adobe', ['casino']),
  signs_timber: () => previewTown('timber', ['store'], true),
  signs_alpine: () => previewTown('alpine', ['store'], true),
  signs_frontier: () => previewTown('frontier', ['store'], true),
  casino_furniture: () => previewFurniture(),
  bj_table: () => { const b = new Batch(), g = new THREE.Group(); furniture({ part: 'bj_table', x: 0, y: 0.45, z: 0, hx: 1.8, hy: 0.45, hz: 1.0, ry: 0 }, b, { glows: [], domes: [], styleName: 'timber' }); for (const [i, x] of [-1.6, -0.9, -0.2, 0.5, 1.5].entries()) button({ x, y: 1.0, z: 1.0 }, [BTN.bet, BTN.bet, BTN.all, BTN.clear, BTN.deal][i], null, b, 0.08); b.build(g); return g; },
  signs_farm: () => previewTown('farm', ['store'], true),
  signs_adobe: () => previewTown('adobe', ['store'], true),
  entry_signs_adobe: () => previewTown('adobe', [], true),
  counters: () => { const g = new THREE.Group(); ['timber', 'alpine', 'frontier', 'adobe'].forEach((st, i) => { const b = new Batch(); furniture({ part: 'counter', x: i * 5, y: 0.5, z: 0, hx: 2.0, hy: 0.5, hz: 0.55, ry: 0 }, b, { glows: [], domes: [], styleName: st }); b.build(g); }); return g; },
  windmill: () => { const b = new Batch(), sb = new Batch(); const m = windmill(b, 0, 0, 0, 0.5, sb); const g = new THREE.Group(); b.build(g); const sg = new THREE.Group(); sb.build(sg); sg.position.copy(m.hub); sg.rotation.order = 'YXZ'; sg.rotation.set(-m.tilt, 0.5, 0.4); g.add(sg); return g; },
};
