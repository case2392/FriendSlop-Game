// The town: every W.buildings entry (gas station, pawn shop, store, casino) drawn from its record
// by town_build.js in the day's style; every W.signs (painted wooden boards, a gilded casino board,
// roadside billboards, the code daubed on the rim); street lamps (W.decor 'lamp'); the town's
// furniture and interactables (pawn counter and bell, store goods and price boards, the blackjack
// table, hit/stand rugs, buttons, the double-or-nothing contraption, slot machines); interiors;
// the NPCs; and the Repo Man's steam tow wagon. Static geometry is merged per material.
// Roadside stuff (POI furniture, gates, anchors, camp) is in roadside3d.js.
// API: buildStructures(W) -> { group, near, npcs, pawnLabel, bjLabel, flipLabel,
//      cardGroup, coin, hitPad, standPad, update(dt, t, camPos) } and PREVIEW.
import { THREE, canvasTex, labelSprite, shadowy, tex, scene } from './gfx.js';
import { buildCharacter } from './people.js';
import { isRoadside } from './roadside3d.js';
import { canvasFor } from './paint/index.js';
import { signCanvas, muteColor } from './paint/architecture.js';
import { Batch, Kit, mat, matrix, sstep } from './town_kit.js';
import { buildBuilding, styleFor, STYLES, winMat, glassMat, lantern, barrel, crate, flames } from './town_build.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

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
  const pts = new THREE.Points(geo, m);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  pts.onBeforeRender = (r, s, cam) => { const h = r.getDrawingBufferSize(new THREE.Vector2()).y; m.uniforms.uScale.value = h / (2 * Math.tan((cam.fov || 60) * Math.PI / 360)); };
  return pts;
}

// ---- signs --------------------------------------------------------------------------------------

function signStyle(s, attached) {
  if (s.flat) return 'daub';
  if (s.billboard) return 'billboard';
  if (s.neon) return 'gilded';
  const { r, g, b } = new THREE.Color(s.bg && !s.bg.startsWith('rgba') ? s.bg : '#888');
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  return !attached && lum < 0.3 ? 'carved' : 'board';
}

// Pack sign faces into one canvas (shelf packing); returns { tex, rect(i) → [u0, v0, u1, v1] }.
function signAtlas(faces) {
  const W = 2048, pad = 8;
  let scale = 1;
  for (let tries = 0; tries < 6; tries++) {
    let x = pad, y = pad, rowH = 0;
    const rects = [];
    for (const f of faces) {
      const w = Math.round(f.px * scale), h = Math.round(f.px * scale * f.h / f.w);
      if (x + w + pad > W) { x = pad; y += rowH + pad; rowH = 0; }
      rects.push([x, y, w, h]); x += w + pad; rowH = Math.max(rowH, h);
    }
    const H = y + rowH + pad;
    if (H <= 2048) {
      const AH = Math.max(256, 1 << Math.ceil(Math.log2(H)));
      const cv = document.createElement('canvas'); cv.width = W; cv.height = AH;
      const g = cv.getContext('2d');
      g.fillStyle = '#3a2a20'; g.fillRect(0, 0, W, AH);
      faces.forEach((f, i) => {
        const [rx, ry, rw, rh] = rects[i];
        const sc = signCanvas(f.lines, { w: rw, h: rh, bg: f.bg, fg: f.fg, style: f.style, seed: f.seed });
        // bleed the edges into the padding so mips don't pick up neighbours
        g.drawImage(sc, rx - 3, ry - 3, rw + 6, rh + 6);
        g.drawImage(sc, rx, ry, rw, rh);
      });
      const t = canvasTex(cv);
      return { tex: t, rect: i => { const [rx, ry, rw, rh] = rects[i]; return [rx / W, 1 - (ry + rh) / AH, (rx + rw) / W, 1 - ry / AH]; } };
    }
    scale *= 0.8;
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

function buildSigns(W, batch, group, near, ctx) {
  const faces = [];
  const items = [];
  for (const s of W.signs) {
    if (s.flat) {
      // the code daubed in paint on the rim rock: only visible up close
      const px = 512, ph = Math.round(px * s.h / s.w);
      const cv = signCanvas(s.lines, { w: px, h: ph, fg: s.fg, style: 'daub' });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), new THREE.MeshLambertMaterial({ map: canvasTex(cv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
      m.rotation.order = 'YXZ';
      m.rotation.y = s.ry; m.rotation.x = -Math.PI / 2;
      m.position.set(s.x, s.y, s.z);
      m.visible = false;
      near.push({ mesh: m, x: s.x, y: s.y, z: s.z, r: s.near || 10 });
      group.add(m);
      continue;
    }
    const att = ctx.attached.get(s) || null;
    const style = signStyle(s, !!att);
    const px = Math.max(256, Math.min(1000, Math.round(s.w * (style === 'billboard' ? 120 : 112))));
    items.push({ s, att, style, fi: faces.length });
    faces.push({ lines: s.lines, w: s.w, h: s.h, px, bg: s.bg, fg: s.fg, style, seed: `${Math.round(s.x)},${Math.round(s.z)}` });
  }
  for (const t of ctx.tags) { t.fi = faces.length; faces.push({ lines: t.lines, w: t.w, h: t.h, px: 300, bg: '#e8d8b0', fg: '#2a1e18', style: 'board', seed: t.lines[0] }); }
  const atlas = faces.length ? signAtlas(faces) : null;
  if (!atlas) return;
  const faceMat = new THREE.MeshLambertMaterial({ map: atlas.tex, vertexColors: true });
  const wood = mat('timber_dark'), iron = mat('iron_wrought'), light = mat('wood_light');
  // price boards stand on the counter behind the goods, leaning back, facing the customer
  for (const t of ctx.tags) {
    const K = new Kit(batch, matrix(t.u.x, t.u.y - 0.1, t.u.z, ctx.tagRy || 0), () => 1);
    K.push(0, 0.2, -0.2, 0, -0.22);
    K.box(wood, t.w + 0.06, t.h + 0.06, 0.03, 0, 0, -0.016, { grain: 'x', seg: [1, 1, 1] });
    K.add(faceMat, remapUV(new THREE.PlaneGeometry(t.w, t.h), atlas.rect(t.fi)), { uv: 'keep', at: matrix(0, 0, 0.001), shade: false, cast: false });
    K.box(wood, 0.04, 0.24, 0.03, 0, -0.17, -0.03, { seg: [1, 1, 1] });
    K.pop();
  }
  const shadeSign = () => 1;
  for (const it of items) {
    const { s, att, style } = it;
    const uv = atlas.rect(it.fi);
    const face = (K, z, back = false) => K.add(faceMat, remapUV(new THREE.PlaneGeometry(s.w, s.h), uv), { uv: 'keep', at: matrix(0, 0, z, back ? Math.PI : 0), shade: false, cast: false });
    if (att) {
      // on the building's front, in front of its gable / false front / parapet
      const info = ctx.bInfo.get(att.b);
      const K = new Kit(batch, info.frame, shadeSign);
      const z = info.signZ;
      K.push(att.lx, att.ly, z);
      if (style === 'gilded') {
        K.box(mat('brass'), s.w + 0.36, s.h + 0.36, 0.16, 0, 0, -0.06, { tile: 1, seg: [1, 1, 1] });
        face(K, 0.025);
        // marquee bulbs round the border
        const bm = glassMat();
        const per = 2 * (s.w + s.h + 0.36), n = Math.round(per / 0.42);
        for (let k = 0; k < n; k++) {
          let d = k / n * per, x, y;
          const hw = s.w / 2 + 0.1, hh = s.h / 2 + 0.1;
          if (d < 2 * hw) { x = -hw + d; y = hh; } else if ((d -= 2 * hw) < 2 * hh) { x = hw; y = hh - d; } else if ((d -= 2 * hh) < 2 * hw) { x = hw - d; y = -hh; } else { d -= 2 * hw; x = -hw; y = -hh + d; }
          K.add(bm, new THREE.SphereGeometry(0.07, 8, 6), { uv: 'keep', at: matrix(x, y, 0.06), shade: false, cast: false });
          if (k % 2 === 0) ctx.glows.push({ p: V3(x, y, 0.1).applyMatrix4(K.m).applyMatrix4(K.root), s: 0.9, col: '#ffd890' });
        }
        // two lamps over the board on iron arms
        for (const sx of [-1, 1]) {
          const x = sx * s.w * 0.3;
          K.beam(iron, [x, s.h / 2 + 0.15, -0.05], [x, s.h / 2 + 0.55, 0.55], 0.04, 0.04);
          lantern({ glows: ctx.glows }, [x, s.h / 2 + 0.35, 0.6], 0.42, true, K);
        }
      } else {
        K.box(wood, s.w + 0.22, s.h + 0.22, 0.1, 0, 0, -0.03, { tile: 1.2, grain: 'x', seg: [1, 1, 1] });
        face(K, 0.025);
        // iron corner brackets holding it off the wall (never across the lettering)
        for (const sx of [-1, 1]) {
          const x = sx * (s.w / 2 + 0.06);
          K.box(iron, 0.06, s.h + 0.3, 0.05, x, 0, 0.04, { tile: 0.5 });
          for (const sy of [-1, 1]) {
            K.box(iron, 0.24, 0.05, 0.04, x - sx * 0.1, sy * (s.h / 2 + 0.1), 0.045, { tile: 0.5 });
            K.add(iron, new THREE.SphereGeometry(0.035, 6, 4), { uv: 'keep', at: matrix(x - sx * 0.18, sy * (s.h / 2 + 0.1), 0.07) });
          }
          K.box(iron, 0.06, 0.06, 0.3, x, s.h / 2 + 0.12, -0.12, { tile: 0.5 });
        }
      }
      K.pop();
      continue;
    }
    // free-standing: roadside boards and billboards on posts, painted both sides
    const lean = ((Math.sin(s.x * 12.9 + s.z * 78.2) * 43758.5) % 1) * 0.035;
    const K = new Kit(batch, matrix(s.x, s.y, s.z, s.ry, 0, lean), shadeSign);
    const hw = s.w / 2, hh = s.h / 2;
    const ground = lx => { const c = Math.cos(s.ry), sn = Math.sin(s.ry); return W.heightAt(s.x + c * lx, s.z - sn * lx) - s.y; };
    if (style === 'billboard') {
      K.box(light, s.w + 0.34, s.h + 0.34, 0.14, 0, 0, 0, { tile: 1.6, grain: 'x', tint: '#a08068', seg: [2, 1, 1] });
      face(K, 0.072); face(K, -0.072, true);
      for (const lx of [-hw * 0.7, hw * 0.7]) {
        const g0 = ground(lx) - 0.4;
        K.box(wood, 0.3, hh + 0.5 - g0, 0.3, lx, (g0 + hh + 0.5) / 2, -0.24, { tile: 1.2, seg: [1, 3, 1] });
        K.add(wood, new THREE.ConeGeometry(0.22, 0.36, 4), { uv: 'keep', at: matrix(lx, hh + 0.68, -0.24, Math.PI / 4) });
      }
      const g0 = Math.max(ground(-hw * 0.7), ground(hw * 0.7));
      K.beam(wood, [-hw * 0.7, g0 + 0.5, -0.3], [hw * 0.7, -hh, -0.3], 0.16, 0.12);
      K.beam(wood, [hw * 0.7, g0 + 0.5, -0.3], [-hw * 0.7, -hh, -0.3], 0.16, 0.12);
      // a little plank roof along the top
      K.box(mat(ctx.style.roof || 'shingles_wood'), s.w + 0.7, 0.1, 0.9, 0, hh + 0.32, 0, { tile: 2, rx: 0.0, seg: [3, 1, 1], warp: v => { v.y += (0.45 - Math.abs(v.z)) * 0.35; } });
      lantern({ glows: ctx.glows }, [0, hh + 0.05, 0.5], 0.4, true, K);
      K.beam(iron, [0, hh + 0.27, 0.0], [0, hh + 0.3, 0.5], 0.03, 0.03);
    } else {
      K.box(light, s.w + 0.16, s.h + 0.16, 0.1, 0, 0, 0, { tile: 1.6, grain: 'x', tint: '#a08068', seg: [1, 1, 1] });
      face(K, 0.052); face(K, -0.052, true);
      for (const lx of [-hw * 0.82, hw * 0.82]) {
        const g0 = ground(lx) - 0.3;
        K.box(wood, 0.16, hh + 0.28 - g0, 0.16, lx, (g0 + hh + 0.28) / 2, 0, { tile: 1.2, seg: [1, 2, 1] });
        K.add(wood, new THREE.ConeGeometry(0.12, 0.22, 4), { uv: 'keep', at: matrix(lx, hh + 0.39, 0, Math.PI / 4) });
      }
      if (s.w >= 4) K.box(mat(ctx.style.roof || 'shingles_wood'), s.w + 0.5, 0.08, 0.6, 0, hh + 0.22, 0, { tile: 2, seg: [3, 1, 1], warp: v => { v.y += (0.3 - Math.abs(v.z)) * 0.35; } });
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
    K.box(gm, 0.62, 1.3, 0.62, 0, 0.65, 0, { tile: 2.2, tint: '#c8ccd8' });
    K.box(gm, 0.8, 0.16, 0.8, 0, 1.38, 0, { tile: 2.2, tint: '#d4d8e2' });
    K.box(mat('snow_roof'), 0.84, 0.08, 0.84, 0, 1.49, 0, { tile: 2, seg: [2, 1, 2], warp: v => { v.y += 0.03 * Math.sin(v.x * 9 + v.z * 7); } });
    for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2; K.beam(iron, [Math.cos(a) * 0.3, 1.46, Math.sin(a) * 0.3], [Math.cos(a) * 0.45, 1.95, Math.sin(a) * 0.45], 0.04, 0.04); }
    K.add(iron, new THREE.CylinderGeometry(0.5, 0.26, 0.36, 10, 1, true), { uv: 'keep', uvScale: [4, 1], at: matrix(0, 1.78, 0) });
    K.add(iron, new THREE.CircleGeometry(0.26, 10), { uv: 'keep', at: matrix(0, 1.6, 0, 0, -Math.PI / 2) });
    K.add(mat('embers', { emissive: '#ff8030', emissiveIntensity: 1 }), new THREE.SphereGeometry(0.44, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 1.83, 0, 0, 0, 0, new THREE.Vector3(1, 0.4, 1)), shade: false, cast: false });
    flames(K, 0, 1.86, 0, 0.36);
    glows.push({ p: V3(0, 2.3, 0).applyMatrix4(K.root), s: 3.6, fire: true });
  } else if (style === 'frontier') {
    const wood = mat('wood_light');
    K.cyl(wood, [0, -0.2, 0], [0.12, 3.7, 0.05], 0.14, 0.1, { sides: 7, tint: '#9a7a58' });
    K.beam(wood, [-0.15, 3.35, 0], [1.0, 3.45, 0.02], 0.09, 0.09, { tint: '#9a7a58' });
    for (const y of [1.0, 3.3]) K.add(mat('hide_patch'), new THREE.TorusGeometry(0.15, 0.04, 5, 10), { uv: 'keep', at: matrix(0.02 + y * 0.03, y, 0.01, 0, Math.PI / 2), tint: '#c8a878' });
    K.box(mat('wood_light'), 0.02, 0.35, 0.02, 0.88, 3.25, 0, { tint: '#d8c098' });
    lantern(c, [0.88, 2.86, 0], 0.58, true, K);
    // a horned skull nailed to the pole
    K.add(mat('wood_light'), new THREE.SphereGeometry(0.13, 8, 6), { uv: 'keep', at: matrix(0.06, 2.4, 0.15, 0, 0, 0, new THREE.Vector3(1, 0.9, 1.25)), tint: '#f0e4cc' });
    for (const s of [-1, 1]) K.add(mat('wood_light'), new THREE.ConeGeometry(0.04, 0.32, 6), { uv: 'keep', at: matrix(0.06 + s * 0.17, 2.52, 0.12, 0, 0, s * -1.1), tint: '#e8dcc4' });
  } else {
    // goblin brass lamp: riveted base, pipe pole, glass globe in a brass cage, a gear
    K.box(mat('metal_red'), 0.55, 0.6, 0.55, 0, 0.3, 0, { uv: 'keep' });
    K.box(mat('brass'), 0.62, 0.08, 0.62, 0, 0.62, 0, { tile: 1 });
    const bm = mat('brass');
    K.cyl(bm, [0, 0.62, 0], [0, 3.3, 0], 0.08, 0.065, { sides: 8 });
    for (const y of [1.2, 2.4]) K.add(bm, new THREE.TorusGeometry(0.1, 0.03, 5, 10), { uv: 'keep', at: matrix(0, y, 0, 0, Math.PI / 2) });
    K.add(bm, new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12), { uv: 'keep', at: matrix(0.1, 1.8, 0, 0, 0, Math.PI / 2) });
    K.add(glassMat(), new THREE.SphereGeometry(0.26, 12, 10), { uv: 'keep', at: matrix(0, 3.6, 0), shade: false, cast: false });
    for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2; K.beam(bm, [Math.cos(a) * 0.1, 3.3, Math.sin(a) * 0.1], [Math.cos(a) * 0.27, 3.6, Math.sin(a) * 0.27], 0.025, 0.025); K.beam(bm, [Math.cos(a) * 0.27, 3.6, Math.sin(a) * 0.27], [0, 3.9, 0], 0.025, 0.025); }
    K.add(bm, new THREE.ConeGeometry(0.12, 0.22, 8), { uv: 'keep', at: matrix(0, 3.98, 0) });
    glows.push({ p: V3(0, 3.6, 0).applyMatrix4(K.root), s: 2.8 });
  }
}

// ---- furniture -----------------------------------------------------------------------------------

const furnShade = (x, y) => 0.7 + 0.3 * sstep(0, 1.1, y);

function furniture(s, batch, ctx) {
  const K = new Kit(batch, matrix(s.x, s.y - s.hy, s.z, s.ry), furnShade);
  const hx = s.hx, hy = s.hy, hz = s.hz, top = 2 * hy;
  if (s.part === 'counter') {
    const wl = mat('wood_light'), wd = mat('timber_dark'), pl = mat('planks_weathered');
    K.box(wd, 2 * hx - 0.2, 0.14, 2 * hz - 0.24, 0, 0.07, 0, { grain: 'x' });
    K.box(pl, 2 * hx - 0.1, top - 0.22, 2 * hz - 0.12, 0, 0.14 + (top - 0.22) / 2, 0, { tile: 2.4, tint: '#c8a080' });
    K.box(wl, 2 * hx + 0.14, 0.08, 2 * hz + 0.16, 0, top - 0.04, 0, { grain: 'x', tile: 1.6 });
    // framed front panels (customer side +z)
    const n = Math.max(2, Math.round(2 * hx / 0.95));
    for (let k = 0; k <= n; k++) K.box(wd, 0.1, top - 0.24, 0.05, -hx + 0.05 + (2 * hx - 0.1) * k / n, 0.14 + (top - 0.24) / 2, hz - 0.03, { tile: 1.2 });
    K.box(wd, 2 * hx, 0.09, 0.06, 0, 0.2, hz - 0.03, { grain: 'x' });
    K.box(wd, 2 * hx, 0.09, 0.06, 0, top - 0.14, hz - 0.03, { grain: 'x' });
    return;
  }
  if (s.part === 'bj_table') {
    const wl = mat('wood_light');
    K.box(wl, 2 * hx - 0.3, top - 0.25, 2 * hz - 0.3, 0, (top - 0.25) / 2 + 0.05, 0, { tint: '#9a5a44', grain: 'x' });
    K.box(mat('timber_dark'), 2 * hx - 0.5, 0.1, 2 * hz - 0.5, 0, 0.05, 0, { grain: 'x' });
    K.box(mat('brass'), 2 * hx - 0.22, 0.06, 2 * hz - 0.22, 0, top - 0.17, 0, { tile: 1 });
    K.box(wl, 2 * hx, 0.08, 2 * hz, 0, top - 0.07, 0, { tint: '#8a4a3a', grain: 'x' });
    K.add(mat('felt_table'), new THREE.PlaneGeometry(2 * hx - 0.16, 2 * hz - 0.16), { uv: 'keep', at: matrix(0, top + 0.002, 0, 0, -Math.PI / 2), shade: false, cast: false });
    // padded leather rail
    const lm = mat('hide_patch');
    const r = 0.075, y = top + 0.03;
    K.cyl(lm, [-hx, y, hz - 0.02], [hx, y, hz - 0.02], r, r, { sides: 8, tint: '#7a4a38' });
    K.cyl(lm, [-hx, y, -hz + 0.02], [hx, y, -hz + 0.02], r, r, { sides: 8, tint: '#7a4a38' });
    for (const sx of [-1, 1]) K.cyl(lm, [sx * (hx - 0.02), y, -hz], [sx * (hx - 0.02), y, hz], r, r, { sides: 8, tint: '#7a4a38' });
    // the dealer's chip rack
    const chipCols = ['#b83a2a', '#2e4a7a', '#3a7a44', '#e8dcc0', '#1e1a20'];
    chipCols.forEach((cc, k) => { for (let j = 0; j < 4; j++) K.add(mat('wood_light'), new THREE.CylinderGeometry(0.045, 0.045, 0.1, 10), { uv: 'keep', at: matrix(-0.4 + k * 0.12, top + 0.05, -hz + 0.22 + (j % 2) * 0.1, 0, 0, Math.PI / 2), tint: cc, shade: false }); });
    return;
  }
  if (s.part === 'flip_machine') {
    const red = mat('metal_red'), br = mat('brass');
    K.box(red, 2 * hx - 0.1, top - 0.2, 2 * hz - 0.1, 0, 0.1 + (top - 0.2) / 2, 0, { tile: 1.3 });
    K.box(br, 2 * hx + 0.04, 0.16, 2 * hz + 0.04, 0, 0.08, 0, { tile: 1 });
    K.box(br, 2 * hx + 0.16, 0.14, 2 * hz + 0.16, 0, top - 0.07, 0, { tile: 1 });
    K.add(mat('flip_face'), new THREE.PlaneGeometry(2 * hx - 0.2, top - 0.5), { uv: 'keep', at: matrix(0, top / 2, hz - 0.03), shade: false });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.cyl(br, [sx * hx, 0.1, sz * hz], [sx * hx, top - 0.1, sz * hz], 0.07, 0.07, { sides: 8 });
    // gears on the flanks
    for (const sx of [-1, 1]) {
      const gx = sx * (hx + 0.03);
      K.add(br, new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), { uv: 'keep', at: matrix(gx, top * 0.6, 0, 0, 0, Math.PI / 2) });
      for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; K.box(br, 0.06, 0.12, 0.12, gx, top * 0.6 + Math.sin(a) * 0.46, Math.cos(a) * 0.46, { rx: -a, tile: 1 }); }
      K.add(red, new THREE.CylinderGeometry(0.1, 0.1, 0.1, 10), { uv: 'keep', at: matrix(gx + sx * 0.04, top * 0.6, 0, 0, 0, Math.PI / 2) });
    }
    // pipes and a whistle
    K.cyl(br, [-hx + 0.25, top, -hz + 0.25], [-hx + 0.25, top + 0.9, -hz + 0.25], 0.07, 0.07, { sides: 8 });
    K.add(br, new THREE.ConeGeometry(0.12, 0.25, 8), { uv: 'keep', at: matrix(-hx + 0.25, top + 1.0, -hz + 0.25, 0, Math.PI) });
    // pedestal and the glass dome the coin spins in
    K.cyl(br, [0, top, 0], [0, top + 0.18, 0], 0.42, 0.36, { sides: 14 });
    ctx.domes.push(V3(0, top + 0.18, 0).applyMatrix4(K.root));
    return;
  }
  if (s.part === 'slot_bank') {
    const tint = ctx.slotTint(s);
    const red = mat('metal_red'), br = mat('brass');
    K.box(br, 2 * hx + 0.06, 0.14, 2 * hz + 0.06, 0, 0.07, 0, { tile: 1 });
    K.box(red, 2 * hx - 0.04, top - 0.14, 2 * hz - 0.06, 0, 0.14 + (top - 0.14) / 2, 0, { tile: 1.3, tint });
    K.add(mat('slot_face'), new THREE.PlaneGeometry(2 * hx - 0.08, top * 0.86), { uv: 'keep', at: matrix(0, 0.14 + top * 0.43, hz - 0.02), shade: false, tint: [1, 1, 1] });
    const arch = new THREE.CylinderGeometry(hx, hx, 2 * hz - 0.06, 14, 1, false, -Math.PI / 2, Math.PI);
    K.add(red, arch, { uv: 'keep', uvScale: [1, 1], at: matrix(0, top, 0, 0, -Math.PI / 2, 0), tint });
    K.add(glassMat(), new THREE.SphereGeometry(0.11, 10, 8), { uv: 'keep', at: matrix(0, top + hx + 0.06, 0), shade: false, cast: false, tint });
    ctx.glows.push({ p: V3(0, top + hx + 0.08, 0).applyMatrix4(K.root), s: 0.9, col: '#ffd890' });
    // the lever
    K.cyl(br, [hx + 0.02, top * 0.55, 0], [hx + 0.12, top * 0.55, 0], 0.06, 0.06, { sides: 8 });
    K.cyl(br, [hx + 0.12, top * 0.55, 0], [hx + 0.14, top * 0.55 + 0.5, 0.05], 0.025, 0.025, { sides: 6 });
    K.add(mat('wood_light'), new THREE.SphereGeometry(0.07, 8, 6), { uv: 'keep', at: matrix(hx + 0.14, top * 0.55 + 0.55, 0.05), tint: '#c03a2a' });
    return;
  }
  // anything else: a sturdy painted crate-box at the same footprint
  K.box(mat('crate'), 2 * hx, top, 2 * hz, 0, hy, 0, { uv: 'keep' });
}

// ---- the Repo Man's steam tow wagon --------------------------------------------------------------

function wheel(K, x, z, r, w) {
  const iron = mat('iron_wrought'), wood = mat('wood_light'), br = mat('brass');
  K.push(x, r, z, 0, 0, Math.PI / 2);
  K.add(iron, new THREE.TorusGeometry(r - 0.1, 0.13, 8, 22), { uv: 'keep', uvScale: [6, 1], at: matrix(0, 0, 0, 0, Math.PI / 2, 0, new THREE.Vector3(1, 1, w / 0.26)) });
  for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2; K.box(iron, 0.1, w + 0.06, 0.07, Math.cos(a) * (r + 0.01), 0, Math.sin(a) * (r + 0.01), { ry: Math.PI / 2 - a, tile: 0.5 }); }
  K.add(wood, new THREE.TorusGeometry(r - 0.2, 0.045, 6, 18), { uv: 'keep', uvScale: [6, 1], at: matrix(0, 0, 0, 0, Math.PI / 2), tint: '#a07050' });
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; K.beam(wood, [0, 0, 0], [Math.cos(a) * (r - 0.18), 0, Math.sin(a) * (r - 0.18)], 0.06, 0.05, { tint: '#a07050' }); }
  K.cyl(br, [0, -w / 2 - 0.06, 0], [0, w / 2 + 0.06, 0], 0.15, 0.15, { sides: 10 });
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; K.add(iron, new THREE.SphereGeometry(0.03, 5, 4), { uv: 'keep', at: matrix(Math.cos(a) * (r - 0.08), w / 2 + 0.02, Math.sin(a) * (r - 0.08)) }); }
  K.pop();
}

function towWagon(K, glows) {
  const iron = mat('iron_wrought'), green = mat('metal_green'), red = mat('metal_red'), br = mat('brass'), wood = mat('timber_dark'), wl = mat('wood_light');
  // chassis
  for (const sx of [-1, 1]) K.box(iron, 0.2, 0.26, 6.4, sx * 0.62, 0.86, -0.1, { grain: 'z', tile: 1, seg: [1, 1, 4] });
  K.cyl(iron, [-1.2, 0.75, -2.1], [1.2, 0.75, -2.1], 0.08, 0.08, { sides: 8 });
  K.cyl(iron, [-1.15, 0.6, 2.15], [1.15, 0.6, 2.15], 0.07, 0.07, { sides: 8 });
  for (const sx of [-1, 1]) { wheel(K, sx * 1.12, -2.1, 0.78, 0.3); wheel(K, sx * 1.1, 2.15, 0.6, 0.26); }
  // fenders
  for (const sx of [-1, 1]) {
    const f = new THREE.CylinderGeometry(0.92, 0.92, 0.42, 14, 1, true, Math.PI * 0.05, Math.PI * 0.9);
    K.add(red, f, { uv: 'keep', uvScale: [2, 1], at: matrix(sx * 1.12, 0.78, -2.1, 0, 0, Math.PI / 2), receive: true });
    const f2 = new THREE.CylinderGeometry(0.74, 0.74, 0.36, 12, 1, true, Math.PI * 0.05, Math.PI * 0.9);
    K.add(red, f2, { uv: 'keep', uvScale: [2, 1], at: matrix(sx * 1.1, 0.6, 2.15, 0, 0, Math.PI / 2), receive: true });
  }
  // cab: riveted lower body, open sides, a red plate roof on iron posts
  K.box(green, 2.0, 0.85, 2.0, 0, 1.38, 2.0, { tile: 1.3 });
  K.add(green, new THREE.BoxGeometry(1.8, 0.6, 0.7), { tile: 1.3, at: matrix(0, 1.5, 3.25), warp: v => { if (v.y > 0) v.z -= 0.25; } });
  K.box(br, 2.06, 0.08, 2.06, 0, 1.84, 2.0, { tile: 1 });
  for (const sx of [-1, 1]) for (const sz of [1.1, 2.9]) K.cyl(iron, [sx * 0.92, 1.8, sz], [sx * 0.9, 2.85, sz - 0.05], 0.045, 0.04, { sides: 6 });
  K.box(red, 2.3, 0.1, 2.3, 0, 2.9, 1.95, { tile: 1.3, seg: [4, 1, 1], warp: v => { v.y += (1.15 - Math.abs(v.x)) * 0.14; } });
  K.box(br, 1.8, 0.06, 0.06, 0, 2.2, 2.92, { tile: 1 });
  K.box(br, 0.06, 0.62, 0.06, -0.9, 2.5, 2.92, { tile: 1 }); K.box(br, 0.06, 0.62, 0.06, 0.9, 2.5, 2.92, { tile: 1 });
  K.box(wl, 1.5, 0.18, 0.6, 0, 1.9, 1.5, { tint: '#7a4a34' });
  K.box(wl, 1.5, 0.6, 0.14, 0, 2.15, 1.2, { tint: '#7a4a34' });
  K.add(iron, new THREE.TorusGeometry(0.22, 0.035, 5, 14), { uv: 'keep', at: matrix(-0.35, 2.2, 2.55, 0, -0.9) });
  K.cyl(iron, [-0.35, 1.8, 2.75], [-0.35, 2.18, 2.58], 0.03, 0.03, { sides: 5 });
  // front: grille, headlamps, bumper and a goblin cow-catcher
  K.box(br, 1.0, 0.5, 0.08, 0, 1.45, 3.62, { tile: 1 });
  for (let k = 0; k < 5; k++) K.box(iron, 0.05, 0.42, 0.04, -0.36 + k * 0.18, 1.45, 3.67, { tile: 0.5 });
  for (const sx of [-1, 1]) {
    K.add(br, new THREE.TorusGeometry(0.2, 0.05, 6, 14), { uv: 'keep', at: matrix(sx * 0.72, 1.55, 3.45) });
    K.add(glassMat(), new THREE.CircleGeometry(0.19, 14), { uv: 'keep', at: matrix(sx * 0.72, 1.55, 3.47), shade: false, cast: false });
    K.cyl(br, [sx * 0.72, 1.55, 3.1], [sx * 0.72, 1.55, 3.42], 0.17, 0.2, { sides: 10 });
    glows.push({ p: V3(sx * 0.72, 1.55, 3.6).applyMatrix4(K.m).applyMatrix4(K.root), s: 1.4 });
  }
  K.box(iron, 2.4, 0.18, 0.2, 0, 0.82, 3.6, { grain: 'x', tile: 1 });
  // a goblin cow-catcher: slanted iron bars
  for (let k = 0; k < 7; k++) { const x = -0.9 + k * 0.3; K.beam(iron, [x, 0.78, 3.66], [x * 0.55, 0.16, 4.25], 0.06, 0.06); }
  K.beam(iron, [-0.55, 0.18, 4.24], [0.55, 0.18, 4.24], 0.07, 0.07);
  K.beam(iron, [-0.8, 0.5, 3.95], [0.8, 0.5, 3.95], 0.05, 0.05);
  // REPO plates on the cab doors
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
  // the bed: planks, side rails, a barrel strapped on
  K.box(mat('floor_planks'), 2.1, 0.1, 2.7, 0, 1.05, -2.2, { tile: 2 });
  for (const sx of [-1, 1]) K.box(wood, 0.1, 0.3, 2.7, sx * 1.02, 1.25, -2.2, { grain: 'z' });
  barrel(K, -0.6, -3.1, 0.28, 0.8, 1.1);
  // the crane: A-frame, winch drum, angled boom, pulley, chain and hook
  for (const sx of [-1, 1]) K.beam(iron, [sx * 0.75, 1.1, -0.9], [sx * 0.12, 2.6, -1.5], 0.12, 0.12);
  K.cyl(iron, [-0.55, 1.45, -1.25], [0.55, 1.45, -1.25], 0.22, 0.22, { sides: 12 });
  for (const sx of [-0.4, 0, 0.4]) K.add(iron, new THREE.TorusGeometry(0.24, 0.035, 4, 12), { uv: 'keep', at: matrix(sx, 1.45, -1.25, Math.PI / 2) });
  for (const sx of [-1, 1]) K.beam(mat('metal_green'), [sx * 0.16, 2.55, -1.3], [sx * 0.12, 3.55, -4.0], 0.16, 0.2, { tile: 1.3 });
  for (let k = 0; k < 5; k++) { const t = k / 4, y = 2.55 + t, z = -1.3 - t * 2.7; K.box(iron, 0.36, 0.06, 0.06, 0, y + 0.02, z, { tile: 0.5 }); }
  K.add(br, new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12), { uv: 'keep', at: matrix(0, 3.55, -4.05, 0, 0, Math.PI / 2) });
  K.cyl(iron, [0, 3.35, -4.12], [0.02, 1.95, -4.12], 0.025, 0.025, { sides: 4 });
  for (let k = 0; k < 7; k++) K.add(iron, new THREE.TorusGeometry(0.06, 0.018, 4, 8), { uv: 'keep', at: matrix(0, 3.3 - k * 0.2, -4.12, k % 2 ? Math.PI / 2 : 0) });
  K.add(iron, new THREE.TorusGeometry(0.22, 0.06, 6, 14, Math.PI * 1.35), { uv: 'keep', at: matrix(0, 1.72, -4.12, Math.PI / 2, 0, Math.PI * 0.85) });
  // beacon lantern on the cab roof
  lantern({ glows }, [0.55, 3.15, 2.2], 0.45, false, K);
}

function towTruck(t, batch = null, glows = []) {
  const own = !batch;
  const B = batch || new Batch();
  const K = new Kit(B, matrix(t.x, t.y, t.z, t.ry, 0, 0, 1.28), (x, y) => 0.72 + 0.28 * sstep(0, 1.5, y));
  towWagon(K, glows);
  if (own) { const g = new THREE.Group(); B.build(g); return g; }
  return null;
}

// ---- interactables -------------------------------------------------------------------------------

function button(u, color, text, batch, glows) {
  const K = new Kit(batch, matrix(u.x, u.y - 0.04, u.z), () => 1);
  K.cyl(mat('brass'), [0, -0.05, 0], [0, 0.02, 0], 0.15, 0.13, { sides: 12 });
  K.add(mat('wood_light', { emissive: color, emissiveIntensity: 0.4 }), new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0.02, 0), tint: color, shade: false, cast: false });
  if (text) {
    const s = labelSprite(text, '#f4e6c0', 34);
    s.scale.set(0.9, 0.17, 1);
    s.position.set(u.x, u.y + 0.2, u.z);
    return s;
  }
  return null;
}

// ---- interiors -----------------------------------------------------------------------------------

function interiorKit(batch, b) {
  const ix = b.w / 2 - 0.15;
  return new Kit(batch, matrix(b.x, b.y, b.z, b.ry), (x, y, z, nx, ny) => { const k = 0.72 + 0.2 * sstep(0, 2.5, y) - (ny < -0.5 ? 0.1 : 0); return [k, k * 0.95, k * 0.88]; });
}

// a shelf unit w wide against a wall at (cx, cz), facing ry (0 = +z)
function shelves(K, cx, cz, w, h, goods, ry = 0) {
  K.push(cx, 0, cz, ry);
  const wd = mat('timber_dark');
  K.add(mat(goods), new THREE.PlaneGeometry(w, h), { uv: 'keep', uvScale: [w / (2 * h), 1], at: matrix(0, 0.15 + h / 2, 0.02), shade: (x, y) => 0.95 });
  for (const sx of [-1, 1]) K.box(wd, 0.12, h + 0.25, 0.3, sx * (w / 2 + 0.04), (h + 0.25) / 2, 0.15, { tile: 1.2 });
  K.box(wd, w + 0.3, 0.14, 0.34, 0, h + 0.3, 0.17, { grain: 'x' });
  K.box(wd, w + 0.2, 0.15, 0.3, 0, 0.075, 0.15, { grain: 'x' });
  K.pop();
}

function rug(K, w, d, x, z, ry = 0, y = 0.104) {
  K.add(mat('rug_red', { alphaTest: 0.5 }), new THREE.PlaneGeometry(w, d), { uv: 'keep', at: matrix(x, y, z, ry, -Math.PI / 2), cast: false, shade: () => 0.92 });
}

function chandelier(K, x, y, z, glows) {
  const iron = mat('iron_wrought');
  K.add(iron, new THREE.TorusGeometry(0.75, 0.05, 6, 18), { uv: 'keep', at: matrix(x, y, z, 0, Math.PI / 2) });
  for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2; K.beam(iron, [x + Math.cos(a) * 0.75, y, z + Math.sin(a) * 0.75], [x, y + 1.0, z], 0.025, 0.025); }
  K.box(iron, 0.03, 1.4, 0.03, x, y + 1.7, z, { tile: 0.5 });
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2, cx = x + Math.cos(a) * 0.75, cz = z + Math.sin(a) * 0.75;
    K.cyl(mat('wood_light'), [cx, y + 0.04, cz], [cx, y + 0.22, cz], 0.035, 0.03, { sides: 6, tint: '#f0e4cc' });
    K.add(glassMat(), new THREE.ConeGeometry(0.03, 0.09, 5), { uv: 'keep', at: matrix(cx, y + 0.27, cz), shade: false, cast: false });
    glows.push({ p: V3(cx, y + 0.28, cz).applyMatrix4(K.root), s: 0.7, col: '#ffd080' });
  }
}

function dressInteriors(W, batch, ctx) {
  for (const b of W.buildings) {
    const K = interiorKit(batch, b);
    const ix = b.w / 2 - 0.15, iz = b.dep / 2 - 0.15, H = b.h;
    if (b.kind === 'pawn') {
      shelves(K, 0, -iz + 0.02, 2 * ix - 0.8, 2.2, 'shelf_goods');
      rug(K, 3.4, 2.2, 0, 1.5);
      crate(K, -ix + 0.6, iz - 0.7, 0.7, 0.3); crate(K, -ix + 0.65, iz - 0.75, 0.5, 0.8, 0.7);
      barrel(K, ix - 0.6, iz - 1.6, 0.32, 0.9);
      lantern(ctx, [-ix * 0.5, H - 0.4, 0.4], 0.5, true, K); lantern(ctx, [ix * 0.5, H - 0.4, 0.4], 0.5, true, K);
    } else if (b.kind === 'store') {
      shelves(K, 0, -iz + 0.02, 2 * ix - 0.8, 2.2, 'store_goods');
      rug(K, 3.0, 2.0, 0, 1.3);
      barrel(K, ix - 0.6, iz - 0.7, 0.32, 0.9); barrel(K, ix - 1.3, iz - 0.6, 0.28, 0.8); crate(K, ix - 0.7, iz - 1.6, 0.66, 0.2);
      lantern(ctx, [0, H - 0.4, 1.2], 0.5, true, K);
    } else if (b.kind === 'casino') {
      // the carpet over a plank border, chandeliers, banners and sconces
      K.box(mat('carpet_casino'), 2 * ix - 1.2, 0.02, 2 * iz - 1.2, 0, 0.11, 0, { uvSpace: 'kit', tile: 3.2, seg: [1, 1, 1], cast: false, shade: () => 0.9 });
      for (const [x, z] of [[-ix * 0.45, -iz * 0.2], [ix * 0.45, -iz * 0.2], [0, iz * 0.45]]) chandelier(K, x, H - 1.6, z, ctx.glows);
      const bm = mat('banner_red', { alphaTest: 0.5, side: THREE.DoubleSide });
      for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) {
        const z = -iz + 2.5 + k * (2 * iz - 5) / 2;
        K.add(bm, new THREE.PlaneGeometry(1.1, 2.3), { uv: 'keep', at: matrix(sx * (ix - 0.05), H - 1.6, z, -sx * Math.PI / 2), shade: () => 0.9, cast: false });
        lantern(ctx, [sx * (ix - 0.35), 2.4, z + 1.6], 0.45, false, K);
        K.box(mat('iron_wrought'), 0.4, 0.05, 0.05, sx * (ix - 0.2), 2.1, z + 1.6, { tile: 0.5 });
      }
    }
  }
}

// ---- the town -------------------------------------------------------------------------------------

export function buildStructures(W) {
  const group = new THREE.Group();
  const near = [];
  const npcs = [];
  const batch = new Batch();
  const glows = [];
  const style = (W.buildings[0] && W.buildings[0].style) || (W.biome && { meadow: 'timber', fields: 'farm', snow: 'alpine', badlands: 'frontier', desert: 'adobe' }[W.biome]) || 'timber';
  const S = STYLES[style] || STYLES.timber;
  const T = W.town;

  // buildings, with their signs matched first (the front gable is sized to carry the sign)
  const attached = new Map(), bySign = new Map();
  for (const s of W.signs) { const m = matchSign(s, W.buildings); if (m) { attached.set(s, m); bySign.set(m.b, s); } }
  const bInfo = new Map();
  for (const b of W.buildings) {
    const s = bySign.get(b);
    const info = buildBuilding(batch, b, s ? { w: s.w, h: s.h, top: s.y + s.h / 2 - b.y, bottom: s.y - s.h / 2 - b.y } : null);
    bInfo.set(b, info);
    glows.push(...info.glows);
  }

  // town furniture and anything else not drawn elsewhere
  const slotCols = ['#e63946', '#f1c40f', '#2a9d8f', '#e76f51', '#8338ec'];
  let slotI = 0;
  const domes = [];
  const fctx = { glows, domes, slotTint: () => new THREE.Color('#ffffff').lerp(new THREE.Color(muteColor(slotCols[slotI++ % 5], { sMax: 0.5, lMin: 0.35, lMax: 0.6 })), 0.55).toArray() };
  for (const s of W.statics) {
    if (s.mat === 'invisible' || isRoadside(s) || s.bld !== undefined) continue;
    furniture(s, batch, fctx);
  }

  // price boards for the store's goods go into the sign atlas
  const tags = [];
  const store = W.buildings.find(b => b.kind === 'store');
  for (const u of W.uses) if (u.kind === 'buy') tags.push({ u, lines: [{ walkie: 'WALKIE', drink: 'ENERGY', bungee: 'BUNGEES' }[u.arg] || u.arg.toUpperCase(), { walkie: '$150', drink: '$40', bungee: '$90' }[u.arg] || ''], w: 0.46, h: 0.26 });
  buildSigns(W, batch, group, near, { attached, bInfo, glows, tags, style: S, tagRy: store ? store.ry : 0 });

  for (const d of W.decor) if (d.k === 'lamp') lampPost(batch, d, style, glows);

  dressInteriors(W, batch, { glows });

  // NPCs: Honest Ed, the clerk, the dealer, the Repo Man (people.js dresses them by color)
  const npc = (spot, color, opts, label) => {
    const ch = buildCharacter(color, opts);
    ch.root.position.set(spot.x, spot.y, spot.z);
    ch.root.rotation.y = spot.ry ?? 0;
    shadowy(ch.root);
    group.add(ch.root);
    if (label) {
      const s = labelSprite(label, '#ffe9a8', 30);
      s.position.set(spot.x, spot.y + 2.25 * (opts.scale || 1) + 0.1, spot.z);
      s.scale.set(1.9, 0.36, 1);
      group.add(s);
    }
    npcs.push(ch);
    return ch;
  };
  npc({ ...T.pawnKeeper, ry: T.pawnKeeper.ry }, '#c0392b', { hatIndex: 2, skinIndex: 3 }, 'HONEST ED');
  npc({ ...T.clerk, ry: T.clerk.ry }, '#2e86ab', { hatIndex: 0, skinIndex: 4 }, 'CLERK');
  npc({ ...T.bj.dealer, ry: T.bj.ry + Math.PI }, '#111111', { hatIndex: 1, skinIndex: 4, eyeColor: '#d62828' }, 'THE DEALER');
  const repoSpot = { x: T.repo.x - 2.4, y: T.repo.y, z: T.repo.z + 0.6, ry: -Math.PI / 2 };   // street side, facing you
  npc(repoSpot, '#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25 }, 'THE REPO MAN');   // people.js gives him brass aviators
  towTruck(T.repo, batch, glows);

  // pawn counter appraisal + casino furniture
  const pawnLabel = labelSprite('', '#7CFC00', 32);
  pawnLabel.position.set(T.pawn.x, T.pawn.y + 1.95, T.pawn.z);
  pawnLabel.scale.set(3.0, 0.56, 1);
  group.add(pawnLabel);

  const bj = T.bj;
  // hit / stand: round woven rugs that pulse (main.js drives emissiveIntensity)
  const pad = (z, name, color) => {
    const t = tex(name);
    const m = new THREE.MeshLambertMaterial({ map: t, emissive: new THREE.Color(color), emissiveMap: t, emissiveIntensity: 0.15, polygonOffset: true, polygonOffsetFactor: -4 });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(z.r, 32), m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    const holder = new THREE.Group();
    holder.position.set(z.x, T.y + 0.13, z.z);
    holder.rotation.y = bj.ry + Math.PI;
    holder.add(mesh);
    group.add(holder);
    return mesh;
  };
  const hitPad = pad(bj.hit, 'pad_hit', '#ffb070');
  const standPad = pad(bj.stand, 'pad_stand', '#a8c8ff');
  const cardGroup = new THREE.Group();
  group.add(cardGroup);
  const bjLabel = labelSprite('', '#fff', 32);
  bjLabel.position.set(bj.table.x, bj.table.y + 1.25, bj.table.z);
  bjLabel.scale.set(3.4, 0.64, 1);
  group.add(bjLabel);
  const flipLabel = labelSprite('', '#ffd166', 30);
  flipLabel.position.set(T.flip.x, T.flip.y + 3.55, T.flip.z);
  flipLabel.scale.set(3.4, 0.64, 1);
  group.add(flipLabel);
  // the coin, spinning in a glass dome on top of the machine
  const coinFace = new THREE.MeshLambertMaterial({ map: tex('coin_face'), emissive: new THREE.Color('#3a2a00'), emissiveMap: tex('coin_face'), emissiveIntensity: 0.6 });
  const coinEdge = new THREE.MeshLambertMaterial({ map: tex('brass'), emissive: new THREE.Color('#2a1a00') });
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.06, 24), [coinEdge, coinFace, coinFace]);
  coin.position.set(T.flip.x, T.flip.y + 2.78, T.flip.z);
  coin.rotation.x = Math.PI / 2;
  group.add(coin);
  const glassM = new THREE.MeshLambertMaterial({ color: '#cfe6f0', transparent: true, opacity: 0.22, depthWrite: false, emissive: new THREE.Color('#203040') });
  for (const p of domes) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), glassM);
    dome.position.copy(p).add(V3(0, 0.18, 0));
    dome.scale.set(1, 1.35, 1);
    dome.renderOrder = 3;
    group.add(dome);
  }

  // casino and pawn lights: warm lamplight
  const cl = new THREE.PointLight(0xffc078, 18, 22, 1.4); cl.position.set(T.casino.x, T.casino.y + 4.2, T.casino.z); group.add(cl);
  const cl2 = new THREE.PointLight(0xffe0a0, 14, 18, 1.4); cl2.position.set(T.bj.table.x, T.casino.y + 3.6, T.bj.table.z); group.add(cl2);
  const pl = new THREE.PointLight(0xffe2b0, 10, 14, 1.4); pl.position.set(T.pawn.x, T.y + 3.2, T.pawn.z); group.add(pl);

  // interactable bits
  const btnCol = { deal: '#4aa85a', all: '#c0402e', clear: '#8a8a94' };
  for (const u of W.uses) {
    if (u.kind === 'pawnBell') {
      const K = new Kit(batch, matrix(u.x, u.y - 0.08, u.z), () => 1);
      K.cyl(mat('timber_dark'), [0, -0.01, 0], [0, 0.03, 0], 0.16, 0.15, { sides: 12 });
      K.add(mat('brass'), new THREE.SphereGeometry(0.12, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0.03, 0) });
      K.cyl(mat('brass'), [0, 0.14, 0], [0, 0.2, 0], 0.02, 0.02, { sides: 6 });
      K.add(mat('brass'), new THREE.SphereGeometry(0.03, 8, 6), { uv: 'keep', at: matrix(0, 0.21, 0) });
    } else if (u.kind === 'bj') {
      const s = button(u, btnCol[u.arg] || '#d8a840', u.label.replace('Bet ', ''), batch, glows);
      if (s) group.add(s);
    } else if (u.kind === 'flip') {
      if (u.arg === 'pull') {
        const K = new Kit(batch, matrix(u.x, u.y - 0.3, u.z, T.flip.ry), () => 1);
        K.box(mat('brass'), 0.2, 0.3, 0.2, 0, -0.2, 0, { tile: 1 });
        K.cyl(mat('iron_wrought'), [0, 0, 0], [0, 0.8, 0.1], 0.035, 0.03, { sides: 6 });
        K.add(mat('wood_light'), new THREE.SphereGeometry(0.12, 10, 8), { uv: 'keep', at: matrix(0, 0.85, 0.11), tint: '#c03a2a' });
      } else { const s = button(u, u.arg === 'all' ? '#c0402e' : '#d8a840', u.label.replace('Stake ', ''), batch, glows); if (s) group.add(s); }
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

  // all the merged statics, the glow cloud
  batch.build(group);
  const gp = glows.length ? glowPoints(glows) : null;
  if (gp) group.add(gp);

  const winM = winMat(), glassM2 = glassMat();
  let lastNight = -1;
  return {
    group, near, npcs,
    update(dt, t, camPos) {
      for (const n of near) n.mesh.visible = Math.hypot(camPos.x - n.x, camPos.y - n.y, camPos.z - n.z) < n.r;
      // how dark is it? (the fog follows the sky)
      const fc = scene && scene.fog && scene.fog.color;
      const lum = fc ? 0.3 * fc.r + 0.59 * fc.g + 0.11 * fc.b : 0.8;
      const night = sstep(0.6, 0.28, lum);
      if (Math.abs(night - lastNight) > 0.01) {
        lastNight = night;
        winM.emissiveIntensity = 0.3 + 1.1 * night;
        glassM2.emissiveIntensity = 0.85 + 0.6 * night;
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
function previewTown(style, kinds) {
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
  const W = { buildings, signs, decor, statics: [], uses: [], heightAt: () => 0 };
  const batch = new Batch(), glows = [];
  const attached = new Map(), bySign = new Map();
  for (const s of signs) { const m = matchSign(s, buildings); if (m) { attached.set(s, m); bySign.set(m.b, s); } }
  const bInfo = new Map();
  for (const b of buildings) { const s = bySign.get(b); bInfo.set(b, buildBuilding(batch, b, s ? { w: s.w, h: s.h, top: s.y + s.h / 2, bottom: s.y - s.h / 2 } : null)); }
  buildSigns(W, batch, new THREE.Group(), [], { attached, bInfo, glows, tags: [], style: STYLES[style] });
  for (const d of decor) lampPost(batch, d, style, glows);
  const g = new THREE.Group();
  batch.build(g);
  return g;
}
function previewFurniture() {
  const batch = new Batch(), glows = [], domes = [];
  const ctx = { glows, domes, slotTint: () => [1, 0.85, 0.8] };
  furniture({ part: 'bj_table', x: 0, y: 0.45, z: 0, hx: 1.8, hy: 0.45, hz: 1.0, ry: 0 }, batch, ctx);
  furniture({ part: 'flip_machine', x: 4, y: 1.1, z: 0, hx: 1.0, hy: 1.1, hz: 0.6, ry: 0 }, batch, ctx);
  for (let i = 0; i < 2; i++) furniture({ part: 'slot_bank', x: 6.2 + i * 1.1, y: 1.0, z: 0, hx: 0.45, hy: 1.0, hz: 0.4, ry: 0 }, batch, { ...ctx, slotTint: () => (i ? [0.9, 1, 0.9] : [1, 0.85, 0.8]) });
  furniture({ part: 'counter', x: 10.5, y: 0.5, z: 0, hx: 2.0, hy: 0.5, hz: 0.55, ry: 0 }, batch, ctx);
  const g = new THREE.Group();
  batch.build(g);
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
  casino_furniture: () => previewFurniture(),
};
