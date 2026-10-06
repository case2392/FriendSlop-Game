// Terrain: the painted ground (splatting), the road, mud, ground clutter.
// Owned by the terrain/atmosphere art pass. API: buildTerrain(W) -> { group, update(dt, t, camPos) }
import { THREE, canvasTex, flat, shadowy } from './gfx.js';
import { fbm } from '/shared/rng.js';
import { inMud } from '/shared/world.js';

const CHUNK = 24;
const STRATA = ['#b9573a', '#cc6d45', '#a64a33', '#d88252', '#b65f3d'];
const col = c => new THREE.Color(c);

function terrainColor(W, x, y, z, ny, seed) {
  const n = fbm(x / 9, z / 9, seed + 77, 2);
  if (inMud(W, x, z)) return col('#5b4331').lerp(col('#3f2c1f'), 0.5 + n * 0.5);
  const dRoad = Math.abs(x - W.roadX(z));
  const inTown = z > W.LEN - 10 || z < 2;
  if (ny < 0.8) {
    const band = Math.floor((y + n * 0.7 + 50) / 1.7) % STRATA.length;
    const c = col(STRATA[band]);
    return ny < 0.45 ? c : c.lerp(col('#c98a5a'), (ny - 0.45) / 0.35 * 0.5);
  }
  if (dRoad < 7.5 && !inTown) return col('#c4a37f').lerp(col('#b08f6c'), 0.5 + n * 0.5);
  const base = inTown ? col('#e2c08f') : col('#e3b06e');
  base.lerp(col('#d39457'), 0.5 + n * 0.5);
  const hi = y - W.roadY(z);
  if (hi > 6 && ny > 0.9) base.lerp(col('#b7a467'), 0.35);   // scrubby mesa tops
  return base;
}

function buildTerrainMesh(W, group) {
  const { nx, nz, cell, X0, Z0, heights } = W;
  const H = (ix, iz) => heights[ix * (nz + 1) + iz];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let cx = 0; cx < nx; cx += CHUNK) {
    for (let cz = 0; cz < nz; cz += CHUNK) {
      const ex = Math.min(nx, cx + CHUNK), ez = Math.min(nz, cz + CHUNK);
      const pos = [], cols = [];
      const tri = (p0, p1, p2) => {
        a.set(...p0); b.set(...p1); c.set(...p2);
        ab.subVectors(b, a); ac.subVectors(c, a);
        const nrm = ab.cross(ac).normalize();
        const mx = (a.x + b.x + c.x) / 3, my = (a.y + b.y + c.y) / 3, mz = (a.z + b.z + c.z) / 3;
        const k = terrainColor(W, mx, my, mz, nrm.y, W.seed);
        pos.push(...p0, ...p1, ...p2);
        for (let i = 0; i < 3; i++) cols.push(k.r, k.g, k.b);
      };
      for (let ix = cx; ix < ex; ix++) {
        for (let iz = cz; iz < ez; iz++) {
          const x0 = X0 + ix * cell, z0 = Z0 + iz * cell, x1 = x0 + cell, z1 = z0 + cell;
          const p00 = [x0, H(ix, iz), z0], p10 = [x1, H(ix + 1, iz), z0], p01 = [x0, H(ix, iz + 1), z1], p11 = [x1, H(ix + 1, iz + 1), z1];
          tri(p00, p01, p10);
          tri(p10, p01, p11);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.castShadow = true;
      group.add(m);
    }
  }
}

function roadTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#4a4648'; g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 2600; i++) {
    const v = 50 + Math.random() * 40;
    g.fillStyle = `rgb(${v},${v - 2},${v + 2})`;
    g.fillRect(Math.random() * 256, Math.random() * 512, 2, 2);
  }
  for (let i = 0; i < 7; i++) { g.strokeStyle = 'rgba(25,22,24,0.6)'; g.lineWidth = 2; g.beginPath(); let x = Math.random() * 256, y = Math.random() * 512; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 40; y += Math.random() * 30; g.lineTo(x, y); } g.stroke(); }
  g.fillStyle = '#f2c14e';
  g.fillRect(121, 0, 6, 200); g.fillRect(129, 0, 6, 200);
  g.fillStyle = '#e8e4da';
  g.fillRect(10, 0, 6, 512); g.fillRect(240, 0, 6, 512);
  return canvasTex(cv, { repeat: [1, 1] });
}

function buildRoad(W, group) {
  const pos = [], uv = [], cols = [], idx = [];
  const ACROSS = [-3.7, -1.8, 0, 1.8, 3.7];
  let row = 0;
  for (let z = W.Z0 + 2; z <= W.Z1 - 2; z += 1.5) {
    const x = W.roadX(z);
    const dx = (W.roadX(z + 0.5) - W.roadX(z - 0.5));
    const nl = Math.hypot(dx, 1);
    const px = 1 / nl, pz = -dx / nl;            // perpendicular
    const mud = inMud(W, x, z);
    ACROSS.forEach((o, i) => {
      const vx = x + px * o, vz = z + pz * o;
      pos.push(vx, W.heightAt(vx, vz) + 0.06, vz);
      uv.push(i / (ACROSS.length - 1), z / 9);
      const k = mud ? [0.45, 0.33, 0.24] : [1, 1, 1];
      cols.push(...k);
    });
    if (row > 0) {
      const b0 = (row - 1) * ACROSS.length, b1 = row * ACROSS.length;
      for (let i = 0; i < ACROSS.length - 1; i++) idx.push(b0 + i, b1 + i, b0 + i + 1, b0 + i + 1, b1 + i, b1 + i + 1);
    }
    row++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: roadTexture(), vertexColors: true, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.receiveShadow = true;
  group.add(m);
}

export function buildTerrain(W) {
  const group = new THREE.Group();
  buildTerrainMesh(W, group);
  buildRoad(W, group);
  return { group, update(dt, t, camPos) {} };
}
