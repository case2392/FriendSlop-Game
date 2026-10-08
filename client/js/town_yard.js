// The town's yards (town3d.js): a paved apron at every door with stepping stones out to the street,
// laid on the ground and fading into it; and the freestanding yard props world gen places in front of
// the buildings (W.statics with part 'yard_*'), each drawn to exactly fill its collider box:
//   yard_well (Goldshire)  yard_trough, yard_cart (Westfall)  yard_brazier (Kharanos)
//   yard_hitch, yard_tower (the canyon outpost)  yard_pots (Gadgetzan)  yard_barrels (every town, per style)
// Everything merges into the town's batch with the materials the buildings already use (the aprons add
// one transparent material per town).
import { THREE } from './gfx.js';
import { Kit, mat, matrix, rng, sstep } from './town_kit.js';
import { lantern, flames, barrel, crate, sack, pot, emberMat } from './town_build.js';

const TAU = Math.PI * 2;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ---- door aprons -----------------------------------------------------------------------------------

function apronMat(style) {
  const m = mat('arch_apron_' + style, { transparent: true });
  m.depthWrite = false; m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  return m;
}

// A 3 m × L m grid laid on the ground in front of building b's door (its texture: the paving 2.2-2.5 m
// deep, then stepping stones), each vertex a hair over heightAt. The gas stations get the paving only.
export function buildAprons(W, batch, style) {
  const m = apronMat(style);
  for (const b of W.buildings) {
    const L = b.kind === 'gas' ? 2.6 : 5.0, wd = 3.0;
    const z0 = b.dep / 2 + 0.15 + 0.42;   // just under the threshold step's lip
    const c = Math.cos(b.ry), s = Math.sin(b.ry);
    const K = new Kit(batch, matrix(b.x, 0, b.z, b.ry), (x, y, z) => 0.82 + 0.18 * sstep(z0, z0 + 1.6, z));
    const nx = 6, nz = Math.ceil(L / 0.45);
    const g = new THREE.PlaneGeometry(wd, L, nx, nz);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const lx = p.getX(i), lz = z0 + (L / 2 - p.getY(i));   // plane +y → toward the door
      const wx = b.x + lx * c + lz * s, wz = b.z - lx * s + lz * c;
      const y = Math.max(W.heightAt(wx, wz), b.y - 0.3) + 0.03;
      p.setXYZ(i, lx, y, lz);   // (x, y) → (x, -y): a proper turn, so the face points up
      // texture: canvas top (v = 1) at the door; a short apron uses the paving end only
      uv.setY(i, 1 - (1 - uv.getY(i)) * (L / 5));
    }
    g.computeVertexNormals();
    K.add(m, g, { uv: 'keep', cast: false });
  }
}

// ---- small shared pieces -----------------------------------------------------------------------------

// a cartwheel (current kit frame) at (x, y, z) facing +z, radius r
export function cartwheel(K, x, y, z, r, rz = 0) {
  const wl = mat('wood_light');
  K.push(x, y, z, 0, 0, rz);
  K.add(wl, new THREE.TorusGeometry(r, 0.07, 6, 18), { uv: 'keep', uvScale: [6, 1], tint: '#a07050' });
  K.add(mat('iron_wrought'), new THREE.TorusGeometry(r + 0.05, 0.03, 4, 18), { uv: 'keep', uvScale: [6, 1] });
  for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI; K.beam(wl, [Math.cos(a) * r, Math.sin(a) * r, 0], [-Math.cos(a) * r, -Math.sin(a) * r, 0], 0.05, 0.05, { tint: '#a07050' }); }
  K.add(wl, new THREE.CylinderGeometry(0.13, 0.13, 0.2, 10), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2), tint: '#8a6040' });
  K.pop();
}

// a hay bale (current kit frame), standing on y
export function hayBale(K, x, z, ry = 0, y = 0) {
  K.box(mat('thatch'), 1.0, 0.5, 0.7, x, y + 0.25, z, { tile: 1.2, ry, tint: '#d8c890', seg: [2, 1, 2], warp: v => { v.y += 0.03 * Math.cos(v.x * 3) * (v.y > 0 ? 1 : 0); } });
  for (const dx of [-0.25, 0.25]) K.box(mat('rope'), 0.03, 0.52, 0.72, x + Math.cos(ry) * dx, y + 0.25, z - Math.sin(ry) * dx, { ry, tile: 0.5 });
}

// a lumpy snow cap on top of something round at (x, y, z), radius r
function snowCap(K, x, y, z, r, R) {
  K.add(mat('snow_roof'), new THREE.SphereGeometry(r, 10, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, y - 0.02, z, R() * 3, 0, 0, V3(1, 0.32, 1)), warp: v => { v.y *= 1 + 0.25 * Math.sin(v.x * 11 + v.z * 7); }, shade: () => [0.92, 0.95, 1], cast: false });
}

// ---- the yard props ------------------------------------------------------------------------------------

const yShade = (x, y) => 0.7 + 0.3 * sstep(0, 1.1, y);

// draw W.statics s (part 'yard_*') filling its box; style = the town's style. Returns false if unknown.
export function yardProp(s, batch, style, glows) {
  const K = new Kit(batch, matrix(s.x, s.y - s.hy, s.z, s.ry), yShade);
  const R = rng(Math.abs(Math.round(s.x * 31 + s.z * 17)) + 11);
  K.seed = 1 + (R() * 9999 | 0);
  const hx = s.hx, hz = s.hz, h = 2 * s.hy;
  const fn = PROPS[s.part];
  if (!fn) return false;
  fn(K, { hx, hz, h, R, style, glows });
  return true;
}

const PROPS = {
  // Goldshire well: a fieldstone ring with a capstone lip, two posts with a winch and crank, a little
  // shingled roof, a bucket on its rope
  yard_well(K, { hx, hz, h, R, style }) {
    const r = Math.min(hx, hz) - 0.02, st = mat(style === 'alpine' ? 'granite_block' : 'stone_found');
    K.cyl(st, [0, 0, 0], [0, h - 0.12, 0], r, r * 0.97, { sides: 14, hseg: 2, uvScale: [5, 1], open: true });
    K.cyl(st, [0, 0.1, 0], [0, h - 0.12, 0], r - 0.2, r - 0.2, { sides: 12, uvScale: [4, 1], open: true, shade: () => 0.55 });
    K.add(st, new THREE.TorusGeometry(r - 0.1, 0.14, 6, 16), { uv: 'keep', uvScale: [5, 1], at: matrix(0, h - 0.1, 0, 0, Math.PI / 2, 0, V3(1, 1, 0.75)) });
    K.add(mat('iron_wrought'), new THREE.CircleGeometry(r - 0.2, 14), { uv: 'keep', at: matrix(0, 0.45, 0, 0, -Math.PI / 2), tint: '#3a5058', shade: false, cast: false });
    const wd = mat('timber_dark'), top = h + 1.25;
    for (const sx of [-1, 1]) K.box(wd, 0.16, top, 0.16, sx * (r - 0.06), top / 2, 0, { tile: 1.2, seg: [1, 3, 1] });
    K.cyl(mat('wood_light'), [-(r - 0.02), h + 0.55, 0], [r - 0.02, h + 0.55, 0], 0.09, 0.09, { sides: 8, tint: '#a07a56' });
    K.add(mat('rope'), new THREE.TorusGeometry(0.1, 0.035, 5, 10), { uv: 'keep', uvScale: [3, 1], at: matrix(0, h + 0.55, 0, Math.PI / 2) });
    // the crank
    K.cyl(mat('iron_wrought'), [r - 0.02, h + 0.55, 0], [r + 0.12, h + 0.55, 0], 0.025, 0.025, { sides: 5 });
    K.cyl(mat('iron_wrought'), [r + 0.12, h + 0.55, 0], [r + 0.12, h + 0.3, 0.05], 0.02, 0.02, { sides: 5 });
    // rope and bucket, hanging just inside the ring
    K.box(mat('rope'), 0.025, 0.55, 0.025, 0.15, h + 0.25, 0, { tile: 0.5 });
    K.cyl(mat('barrel'), [0.15, h - 0.22, 0], [0.15, h - 0.0, 0], 0.13, 0.15, { sides: 10, uvScale: [1, 0.4] });
    K.add(mat('iron_wrought'), new THREE.TorusGeometry(0.15, 0.012, 4, 10, Math.PI), { uv: 'keep', at: matrix(0.15, h - 0.02, 0) });
    // a steep little gable roof
    const roof = mat(style === 'farm' ? 'thatch' : style === 'alpine' ? 'slate_roof' : 'shingles_red'), ph = 0.6, pw = r + 0.35;
    for (const sz of [-1, 1]) K.box(roof, 2 * r + 0.5, 0.08, Math.hypot(pw * 0.7, ph), 0, top + ph / 2 - 0.02, sz * pw * 0.35, { rx: sz * Math.atan2(ph, pw * 0.7), tile: 1.6, grain: 'z' });
    K.box(wd, 2 * r + 0.3, 0.14, 0.14, 0, top, 0, { grain: 'x', tile: 1.2 });
    K.box(wd, 2 * r + 0.56, 0.1, 0.12, 0, top + ph + 0.02, 0, { grain: 'x', tile: 1.2 });
  },

  // Westfall trough: a long plank box on stubby legs, iron bands, water, straw in it
  yard_trough(K, { hx, hz, h, R }) {
    const pl = mat('planks_weathered'), iron = mat('iron_wrought');
    const L = 2 * hx, D = 2 * hz, H = h;
    for (const sz of [-1, 1]) K.box(pl, L - 0.06, H - 0.12, 0.07, 0, 0.12 + (H - 0.12) / 2, sz * (hz - 0.06), { grain: 'x', tile: 1.6, rx: sz * 0.08 });
    for (const sx of [-1, 1]) K.box(pl, 0.08, H - 0.1, D - 0.06, sx * (hx - 0.05), 0.12 + (H - 0.12) / 2, 0, { tile: 1.6 });
    K.box(pl, L - 0.1, 0.06, D - 0.18, 0, 0.15, 0, { grain: 'x', tile: 1.6 });
    for (const sx of [-0.7, 0.7]) for (const sz of [-1, 1]) K.box(mat('timber_dark'), 0.1, 0.16, 0.1, sx * hx, 0.08, sz * (hz - 0.08), { tile: 1.2 });
    for (const x of [-hx * 0.55, hx * 0.55]) K.box(iron, 0.05, H - 0.08, D + 0.02, x, 0.12 + (H - 0.14) / 2, 0, { tile: 0.5 });
    K.add(iron, new THREE.PlaneGeometry(L - 0.18, D - 0.2), { uv: 'keep', uvScale: [2, 0.6], at: matrix(0, H - 0.08, 0, 0, -Math.PI / 2), tint: '#40606a', shade: false, cast: false });
    for (let k = 0; k < 8; k++) { const x = (R() - 0.5) * L * 0.8; K.cyl(mat('thatch'), [x, H - 0.07, (R() - 0.5) * D * 0.5], [x + 0.2, H - 0.07, (R() - 0.5) * D * 0.5], 0.008, 0.008, { sides: 3, tint: '#e8d080', cast: false }); }
  },

  // a Westfall hay cart: a plank bed on two big wheels, the shafts down on the ground, hay heaped in it
  yard_cart(K, { hx, hz, h, R }) {
    const pl = mat('planks_weathered'), wd = mat('timber_dark'), hay = mat('thatch');
    const bx0 = -hx + 0.55, bx1 = hx - 0.05, bl = bx1 - bx0, bc = (bx0 + bx1) / 2, bw = 2 * hz - 0.34, by = 0.62;
    K.push(0, 0, 0, 0, 0, 0.06);   // tipped forward a little onto its shafts
    K.box(pl, bl, 0.08, bw, bc, by, 0, { grain: 'x', tile: 1.6 });
    for (const sz of [-1, 1]) K.box(pl, bl, 0.36, 0.06, bc, by + 0.22, sz * (bw / 2 - 0.03), { grain: 'x', tile: 1.6 });
    K.box(pl, 0.06, 0.36, bw, bx1 - 0.03, by + 0.22, 0, { tile: 1.6 });
    for (const x of [bx0 + 0.1, bc, bx1 - 0.1]) for (const sz of [-1, 1]) K.box(wd, 0.07, 0.46, 0.07, x, by + 0.17, sz * (bw / 2 + 0.01), { tile: 1.2 });
    K.add(hay, new THREE.SphereGeometry(0.75, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [3, 1], at: matrix(bc + 0.1, by + 0.05, 0, R(), 0, 0, V3(bl * 0.62, 0.62, bw * 0.62 / 0.75 * 0.75)), tint: '#d8c890', warp: v => { v.y *= 1 + 0.12 * Math.sin(v.x * 7 + v.z * 5); } });
    K.pop();
    for (const sz of [-1, 1]) cartwheel(K, bc + 0.15, 0.6, sz * (hz - 0.1), 0.58, R() * 3);
    K.cyl(mat('iron_wrought'), [bc + 0.15, 0.6, -hz + 0.05], [bc + 0.15, 0.6, hz - 0.05], 0.05, 0.05, { sides: 6 });
    for (const sz of [-0.32, 0.32]) K.cyl(wd, [bx0 + 0.2, by - 0.05, sz], [-hx + 0.05, 0.06, sz * 0.8], 0.05, 0.045, { sides: 6 });
    K.box(wd, 0.08, 0.08, 0.6, -hx + 0.25, 0.1, 0, { tile: 1.2 });
  },

  // the outpost's hitching rail: two crooked log posts, a rail lashed on, a coil of rope, a skull on top
  yard_hitch(K, { hx, hz, h, R }) {
    const wl = mat('wood_light'), rope = mat('rope');
    for (const sx of [-1, 1]) {
      const x = sx * (hx - 0.12);
      K.tube(wl, [[x, -0.2, 0], [x + (R() - 0.5) * 0.06, h * 0.5, 0], [x + (R() - 0.5) * 0.08, h + 0.12, 0]], [0.11, 0.1, 0.09], { sides: 7, tint: '#a8865e', tile: 1.6 });
      K.add(wl, new THREE.ConeGeometry(0.09, 0.2, 7), { uv: 'keep', at: matrix(x, h + 0.22, 0), tint: '#c8a478' });
      for (let k = 0; k < 3; k++) K.add(rope, new THREE.TorusGeometry(0.12, 0.022, 4, 9), { uv: 'keep', uvScale: [3, 1], at: matrix(x, h - 0.12 - k * 0.05, 0, k * 0.6, Math.PI / 2) });
    }
    K.cyl(wl, [-hx, h - 0.1, 0], [hx, h - 0.06, 0], 0.07, 0.065, { sides: 7, tint: '#9a7a56' });
    K.add(rope, new THREE.TorusGeometry(0.14, 0.03, 5, 12), { uv: 'keep', uvScale: [3, 1], at: matrix(hx * 0.35, h - 0.25, 0.04, 0, 0, 0.3) });
    K.cyl(rope, [hx * 0.35, h - 0.12, 0.04], [hx * 0.35 + 0.05, 0.4, 0.06], 0.016, 0.016, { sides: 4 });
    const bone = mat('arch_bone'), x = -(hx - 0.12);
    K.add(bone, new THREE.SphereGeometry(0.12, 9, 7), { uv: 'keep', at: matrix(x, h + 0.38, 0.03, 0, 0, 0, V3(1, 0.85, 1.25)) });
    for (const s of [-1, 1]) K.add(bone, new THREE.ConeGeometry(0.035, 0.3, 6), { uv: 'keep', at: matrix(x + s * 0.15, h + 0.46, 0.02, 0, 0, s * -1.15) });
    // a water bucket by a post
    K.cyl(mat('barrel'), [hx * 0.6, 0, 0.18], [hx * 0.6, 0.32, 0.18], 0.16, 0.18, { sides: 10, uvScale: [1, 0.4] });
  },

  // the outpost's lookout: a log palisade skirt (the box is solid), four leaning legs with X bracing, a
  // plank platform with a stake rail, a hide roof on poles, a ladder, a banner
  yard_tower(K, { hx, hz, h, R, glows }) {
    const wl = mat('wood_light'), rope = mat('rope'), hide = mat('hide_patch', { side: THREE.DoubleSide });
    const ph = h - 0.6, ex = hx - 0.15, ez = hz - 0.15;
    // the skirt of sharpened logs, all round
    for (const [ax, az, len, rx] of [[0, ez, 2 * ex, 0], [0, -ez, 2 * ex, 0], [ex, 0, 2 * ez, 1], [-ex, 0, 2 * ez, 1]]) {
      const n = Math.round(len / 0.24);
      for (let k = 0; k <= n; k++) {
        const t = -len / 2 + len * k / n, x = rx ? ax : t, z = rx ? t : az, top = 1.5 + R() * 0.35;
        K.cyl(wl, [x, -0.2, z], [x + (R() - 0.5) * 0.05, top, z + (R() - 0.5) * 0.05], 0.12, 0.11, { sides: 6, tint: R() < 0.3 ? '#9a7a56' : '#a88660' });
        K.add(wl, new THREE.ConeGeometry(0.11, 0.26, 6), { uv: 'keep', at: matrix(x, top + 0.13, z), tint: '#c8a478' });
      }
    }
    for (const y of [0.55, 1.15]) for (const sz of [-1, 1]) K.cyl(wl, [-ex, y, sz * (ez + 0.12)], [ex, y + 0.03, sz * (ez + 0.12)], 0.06, 0.06, { sides: 6, tint: '#8a6a4a' });
    // legs, braces, platform
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sz] of legs) K.tube(wl, [[sx * ex, 0, sz * ez], [sx * ex * 0.94, ph * 0.5, sz * ez * 0.94], [sx * ex * 0.86, ph + 1.4, sz * ez * 0.86]], [0.15, 0.13, 0.11], { sides: 7, tint: '#a07c58', tile: 1.6 });
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
      K.cyl(wl, [ax * ex * 0.96, 1.7, az * ez * 0.96], [bx * ex * 0.9, ph - 0.1, bz * ez * 0.9], 0.06, 0.06, { sides: 6, tint: '#9a7a56' });
      K.cyl(wl, [bx * ex * 0.96, 1.7, bz * ez * 0.96], [ax * ex * 0.9, ph - 0.1, az * ez * 0.9], 0.06, 0.06, { sides: 6, tint: '#9a7a56' });
    }
    K.box(mat('floor_planks'), 2 * hx + 0.1, 0.12, 2 * hz + 0.1, 0, ph, 0, { tile: 2, grain: 'x' });
    for (const sz of [-1, 1]) K.box(mat('timber_dark'), 2 * hx + 0.2, 0.16, 0.16, 0, ph - 0.14, sz * hz, { grain: 'x', tile: 1.2 });
    // stake rail round the platform
    for (let k = 0; k < 4; k++) {
      const [ax, az] = legs[k], [bx, bz] = legs[(k + 1) % 4];
      for (let j = 0; j < 5; j++) { const t = (j + 0.5) / 5, x = (ax + (bx - ax) * t) * (hx - 0.05), z = (az + (bz - az) * t) * (hz - 0.05); K.cyl(wl, [x, ph, z], [x, ph + 0.8 + R() * 0.15, z], 0.05, 0.045, { sides: 5, tint: '#a8865e' }); }
      K.cyl(wl, [ax * (hx - 0.05), ph + 0.75, az * (hz - 0.05)], [bx * (hx - 0.05), ph + 0.75, bz * (hz - 0.05)], 0.05, 0.05, { sides: 5, tint: '#9a7a56' });
    }
    // hide roof sloping back, on the legs' tops
    const ry0 = ph + 1.4;
    K.add(hide, new THREE.PlaneGeometry(2 * hx + 0.7, 2 * hz + 0.8, 6, 4), { uv: 'keep', uvScale: [1.2, 1.2], at: matrix(0, ry0 + 0.3, 0, 0, -Math.PI / 2 + 0.28), warp: v => { v.z -= 0.1 * Math.sin(Math.PI * (v.x / (2 * hx + 0.7) + 0.5)); }, tint: '#d8c0a8' });
    // ladder up the front
    const lz = hz + 0.12;
    for (const sx of [-0.25, 0.25]) K.cyl(wl, [sx, 0, lz + 0.35], [sx, ph + 0.2, lz], 0.04, 0.04, { sides: 5, tint: '#b09070' });
    for (let y = 0.35; y < ph; y += 0.38) { const t = y / (ph + 0.2); K.cyl(wl, [-0.27, y, lz + 0.35 * (1 - t)], [0.27, y, lz + 0.35 * (1 - t)], 0.025, 0.025, { sides: 4, tint: '#c0a080' }); }
    // a banner hanging off the rail, a lantern under the roof
    K.add(mat('banner_hide', { alphaTest: 0.5, side: THREE.DoubleSide }), new THREE.PlaneGeometry(0.7, 1.3), { uv: 'keep', at: matrix(-hx * 0.4, ph - 0.7, hz + 0.06), shade: () => 0.95 });
    lantern({ glows }, [0, ry0 - 0.15, 0], 0.4, true, K);
  },

  // Kharanos: an iron fire bowl on a squat granite plinth, embers and flames, snow on the plinth
  yard_brazier(K, { hx, hz, h, R, glows }) {
    const gm = mat('granite_block'), iron = mat('iron_wrought');
    const pw = Math.min(hx, hz) * 2 - 0.06, py = h - 0.36;
    K.box(gm, pw, py, pw, 0, py / 2, 0, { tile: 2, tint: '#d4cec4', seg: [1, 2, 1], warp: v => { if (v.y > 0) { v.x *= 0.88; v.z *= 0.88; } } });
    K.box(gm, pw + 0.06, 0.1, pw + 0.06, 0, py, 0, { tile: 2, tint: '#e0dad0' });
    const br = Math.min(hx, hz) + 0.04;
    K.add(iron, new THREE.CylinderGeometry(br, br * 0.55, 0.3, 10, 1, true), { uv: 'keep', uvScale: [4, 1], at: matrix(0, py + 0.2, 0), receive: true });
    K.add(iron, new THREE.TorusGeometry(br, 0.03, 5, 12), { uv: 'keep', at: matrix(0, py + 0.35, 0, 0, Math.PI / 2) });
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + 0.4; K.beam(iron, [Math.cos(a) * br * 0.5, py + 0.05, Math.sin(a) * br * 0.5], [Math.cos(a) * (br + 0.06), py + 0.42, Math.sin(a) * (br + 0.06)], 0.035, 0.035); }
    K.add(emberMat(), new THREE.SphereGeometry(br * 0.85, 10, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, py + 0.3, 0, 0, 0, 0, V3(1, 0.35, 1)), shade: false, cast: false });
    flames(K, 0, py + 0.32, 0, br * 0.8);
    glows.push({ p: V3(0, py + 0.8, 0).applyMatrix4(K.root), s: 2.6, fire: true });
    for (const [x, z] of [[-1, -1], [1, 1], [1, -1]]) if (R() < 0.75) snowCap(K, x * pw * 0.32, py + 0.06, z * pw * 0.32, 0.16, R);
    snowCap(K, 0, 0.02, 0, pw * 0.75, R);
  },

  // Gadgetzan: a cluster of big clay pots, one tipped over, a brass-banded one with a lid
  yard_pots(K, { hx, hz, h, R }) {
    const spots = [[-0.28, -0.22, 1.05], [0.26, -0.18, 0.9], [-0.05, 0.28, 0.8], [0.34, 0.32, 0.6]];
    spots.forEach(([x, z, k], i) => pot(null, x * hx / 0.6, 0, z * hz / 0.6, k * h / 0.66, ['#c88a60', '#a86a48', '#d8a070', '#b8784c'][i], K));
    K.add(mat('brass'), new THREE.TorusGeometry(0.23, 0.02, 4, 12), { uv: 'keep', at: matrix(0.26 * hx / 0.6, 0.18 * h, -0.18 * hz / 0.6, 0, Math.PI / 2) });
    K.add(mat('clay'), new THREE.CylinderGeometry(0.13, 0.15, 0.04, 10), { uv: 'keep', at: matrix(0.26 * hx / 0.6, 0.9 * h * 0.6 / 0.66 + 0.02, -0.18 * hz / 0.6), tint: '#b8784c' });
    // the tipped one, on its side, a spill of sand
    K.push(-0.4 * hx / 0.6, 0.15, 0.42 * hz / 0.6, R() * 2, 0, Math.PI / 2 - 0.15);
    pot(null, 0, -0.2, 0, 0.55, '#c08058', K);
    K.pop();
  },

  // barrels in a huddle (and the style's bits: a crate on top, snow caps, brass bands, a skull)
  yard_barrels(K, { hx, hz, h, R, style }) {
    const r = Math.min(hx, hz) * 0.5, bh = h - 0.04;
    barrel(K, -hx * 0.48, -hz * 0.4, r, bh);
    barrel(K, hx * 0.48, -hz * 0.36, r * 0.94, bh * 0.92);
    if (style === 'farm' || style === 'timber') { crate(K, -hx * 0.05, hz * 0.45, Math.min(0.55, hz * 0.9), R() * 0.6); if (style === 'farm') sack(K, hx * 0.55, hz * 0.5, 0.8, 0, R()); }
    else barrel(K, hx * 0.05, hz * 0.48, r * 0.86, bh * 0.8);
    if (style === 'alpine') for (const [x, z, k] of [[-hx * 0.48, -hz * 0.4, 1], [hx * 0.48, -hz * 0.36, 0.92], [hx * 0.05, hz * 0.48, 0.8]]) snowCap(K, x, bh * k + 0.02, z, r * 1.02, R);
    if (style === 'adobe') for (const [x, z, k] of [[-hx * 0.48, -hz * 0.4, 1], [hx * 0.48, -hz * 0.36, 0.92]]) for (const y of [0.2, 0.75]) K.add(mat('brass'), new THREE.TorusGeometry(r * 1.06, 0.022, 4, 14), { uv: 'keep', at: matrix(x, bh * k * y, z, 0, Math.PI / 2) });
    if (style === 'frontier') {
      const bone = mat('arch_bone');
      K.add(bone, new THREE.SphereGeometry(0.11, 9, 7), { uv: 'keep', at: matrix(-hx * 0.48, bh + 0.08, -hz * 0.4, 0.7, 0, 0, V3(1, 0.85, 1.25)) });
      K.box(bone, 0.1, 0.07, 0.11, -hx * 0.48 + 0.06, bh + 0.03, -hz * 0.4 + 0.08, { ry: 0.7 });
    }
  },
};

export const YARD_PARTS = new Set(Object.keys(PROPS));
