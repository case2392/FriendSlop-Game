// The world, assembled: terrain (terrain3d.js), nature (nature3d.js), roadside
// stops/gates/anchors/camp (roadside3d.js) and the town (town3d.js).
// main.js talks to this file only.
import { THREE, canvasTex } from './gfx.js';
import { buildTerrain } from './terrain3d.js';
import { buildNature } from './nature3d.js';
import { buildRoadside } from './roadside3d.js';
import { buildStructures } from './town3d.js';

export function buildWorld(W) {
  const terrain = buildTerrain(W);
  const nature = buildNature(W);
  const roadside = buildRoadside(W);
  const town = buildStructures(W);
  const group = new THREE.Group();
  group.add(terrain.group, nature.group, roadside.group, town.group);
  for (const m of iceSheets(W)) group.add(m);
  return { ...town, group, terrain, nature, roadside, town, gates: roadside.gates, fires: nature.fires };
}

// the snow day's black ice (shared/world.js icePatches): a glassy sheet draped over the road and its shoulders,
// dark slate blue against the packed snow with the sun's shine on it, pale scratches along the way the tyres
// went, fading out at its ends and edges
let iceTex = null;
function iceCanvas() {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 512;
  const g = cv.getContext('2d');
  const across = g.createLinearGradient(0, 0, 128, 0);
  for (const [k, a] of [[0, 0], [0.1, 0.55], [0.26, 0.85], [0.74, 0.85], [0.9, 0.55], [1, 0]]) across.addColorStop(k, `rgba(92,132,170,${a})`);
  g.fillStyle = across; g.fillRect(0, 0, 128, 512);
  let sd = 9157; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 60; i++) {
    const x = 14 + rnd() * 100, y = rnd() * 512, l = 30 + rnd() * 120;
    g.strokeStyle = `rgba(230,244,255,${0.3 + rnd() * 0.45})`; g.lineWidth = 0.6 + rnd() * 1.4;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 6, y + l); g.stroke();
  }
  for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(60,96,132,${0.2 + rnd() * 0.25})`; g.beginPath(); g.ellipse(14 + rnd() * 100, rnd() * 512, 4 + rnd() * 10, 10 + rnd() * 30, 0, 0, Math.PI * 2); g.fill(); }
  // (its ends fade in and out along the road)
  g.globalCompositeOperation = 'destination-in';
  const along = g.createLinearGradient(0, 0, 0, 512);
  for (const [k, a] of [[0, 0], [0.08, 1], [0.92, 1], [1, 0]]) along.addColorStop(k, `rgba(0,0,0,${a})`);
  g.fillStyle = along; g.fillRect(0, 0, 128, 512);
  return cv;
}
function iceSheets(W) {
  if (!W.ice?.length || typeof document === 'undefined') return [];
  iceTex ??= canvasTex(iceCanvas());
  const mat = new THREE.MeshPhongMaterial({ map: iceTex, color: '#d8ecff', specular: '#ffffff', shininess: 110, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const HW = 5.4, COLS = 6, out = [];
  for (const m of W.ice) {
    const rows = Math.ceil((m.z1 - m.z0) / 1.5), pos = [], uv = [], idx = [];
    for (let r = 0; r <= rows; r++) {
      const z = m.z0 + (m.z1 - m.z0) * r / rows, cx = W.roadX(z);
      for (let c = 0; c <= COLS; c++) {
        const x = cx - HW + 2 * HW * c / COLS;
        pos.push(x, W.heightAt(x, z) + 0.04, z); uv.push(c / COLS, r / rows);
      }
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < COLS; c++) {
      const a = r * (COLS + 1) + c, b = a + COLS + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.renderOrder = 1;
    out.push(mesh);
  }
  return out;
}

export function updateWorld(w, dt, t, camPos) {
  w.terrain.update?.(dt, t, camPos);
  w.nature.update?.(dt, t, camPos);
  w.roadside.update?.(dt, t, camPos);
  w.town.update?.(dt, t, camPos);
}
