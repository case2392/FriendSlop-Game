// Buildings, drawn from their records in W.buildings (shared/world.js building()):
//   b = { id, kind, x, y, z, ry, w, dep, h, door, style }
// Colliders: floor slab top at y + 0.1; walls 0.3 m thick centered on x = ±w/2 and z = ±dep/2;
// a door gap b.door wide at local x = 0 in the front wall (+z), under a lintel from h - 0.8 to h;
// a flat roof slab at y + h + 0.1. Walls, door gap and floor here sit exactly on those; roofs,
// eaves, gables, jetties, chimneys, beams and foundations all go outside that volume.
//
// One generator, five styles (one per day, docs/ART.md):
//   timber   Goldshire: cream plaster, dark half-timbering, steep red shingle roofs, stone base, chimneys
//   farm     Westfall: weathered boards, thatch (houses) or a gambrel barn (casino, gas), red shutters, hay
//   alpine   Kharanos: granite ashlar, heavy timber, steep slate roofs under thick snow, icicles, braziers
//   frontier Kargath outpost: log walls, plank false fronts, hide roofs, palisade stakes, crossed log ends
//   adobe    Gadgetzan: tan adobe, vigas, flat roofs behind stepped parapets, canvas awnings, goblin brass
import { THREE } from './gfx.js';
import { Kit, mat, matrix, rng, sstep } from './town_kit.js';

const D2R = Math.PI / 180;

export const STYLES = {
  timber: {
    wall: 'plaster_cream', wallTile: 3.2, base: 'stone_found', baseTile: 2.2, baseH: 0.62, beam: 'timber_dark',
    roof: 'shingles_red', roofTile: 2.6, layout: 'gable', pitch: 46, maxRise: 5, eave: 0.65, gableOH: 0.5, thick: 0.22, barge: true,
    floor: 'floor_planks', inner: 'plaster_inner', wainscot: true, halfTimber: true, gableFill: 'plaster_cream',
    chimney: 'stone_found', win: 'flower', winW: 0.95, winH: 1.3, winY: 1.05, lamp: 'lantern', ridge: 'shingle',
  },
  farm: {
    wall: 'planks_weathered', wallTile: 3, base: 'stone_found', baseTile: 2.2, baseH: 0.36, beam: 'timber_dark',
    roof: 'thatch', roofTile: 2.4, layout: 'gable', pitch: 50, maxRise: 5.2, eave: 0.6, gableOH: 0.55, thick: 0.42, barge: false,
    floor: 'floor_planks', inner: 'planks_weathered', gableFill: 'planks_weathered', cornerBoards: true,
    chimney: 'stone_found', win: 'shutter', shutter: 'planks_barnred', winW: 0.9, winH: 1.2, winY: 1.05, lamp: 'post', ridge: 'thatch',
    barn: { kinds: ['casino', 'gas'], wall: 'planks_barnred', roof: 'shingles_wood', layout: 'gambrel', thick: 0.2, barge: true, gableFill: 'planks_barnred', ridge: 'shingle', chimney: null, trim: 'wood_white', cornerMat: 'wood_white', cornerTint: '#ffffff' },
  },
  alpine: {
    wall: 'granite_block', wallTile: 3.4, base: 'granite_block', baseTile: 2.4, baseH: 0.75, baseTint: '#b8bcc8', beam: 'timber_dark',
    roof: 'slate_roof', roofTile: 2.6, layout: 'gable', pitch: 52, maxRise: 5.8, eave: 0.75, gableOH: 0.6, thick: 0.26, barge: true,
    floor: 'flagstone', inner: 'granite_inner', gableFill: 'planks_weathered', gableTint: '#8a7464', snow: true, quoins: true,
    chimney: 'granite_block', win: 'stone', winW: 0.8, winH: 1.0, winY: 1.25, lamp: 'brazier', ridge: 'snow', topBeams: true,
  },
  frontier: {
    wall: 'log_wall', wallTile: 3, base: null, beam: 'timber_dark', facade: 'planks_rough',
    roof: 'hide_patch', roofTile: 3, layout: 'shed', pitch: 9, thick: 0.18,
    floor: 'floor_planks', inner: 'log_wall', logEnds: true, palisade: true,
    win: 'shutter', shutter: 'planks_rough', winW: 0.9, winH: 1.1, winY: 1.1, lamp: 'torch',
    saloon: { kinds: ['casino', 'gas'], wall: 'planks_rough', inner: 'planks_rough', logEnds: false, cornerPosts: true },
  },
  adobe: {
    wall: 'adobe', wallTile: 3.2, base: null, beam: 'timber_dark', trim: 'brass', layout: 'flat',
    floor: 'flagstone', inner: 'adobe_inner', wainscot: false, vigas: true, buttress: true, awning: 'canvas_stripe',
    win: 'port', winW: 0.85, winH: 0.85, winY: 1.45, lamp: 'goblin', pipes: true,
  },
};

export function styleFor(b) {
  const S0 = STYLES[b.style] || STYLES.timber;
  const v = S0.barn && S0.barn.kinds.includes(b.kind) ? S0.barn : S0.saloon && S0.saloon.kinds.includes(b.kind) ? S0.saloon : null;
  return v ? { ...S0, ...v, name: b.style } : { ...S0, name: b.style };
}

// emissive materials whose glow follows the night (town3d.js update)
export const winMat = () => mat('window_lead', { emissive: '#ffc070', emissiveIntensity: 0.35 });
export const glassMat = () => mat('lantern_glass', { emissive: '#ffb050', emissiveIntensity: 0.9 });
const flowerMat = () => mat('flowerbox', { alphaTest: 0.5, side: THREE.DoubleSide });
const bannerMat = () => mat('banner_red', { alphaTest: 0.5, side: THREE.DoubleSide });

// vertex shading in a building's frame: grime near the ground, shade under the eaves, darker
// undersides, and warm, dim interiors
function shader(b) {
  const ix = b.w / 2 - 0.15, iz = b.dep / 2 - 0.15, H = b.h;
  return (x, y, z, nx, ny, nz) => {
    if (Math.abs(x) < ix - 0.002 && Math.abs(z) < iz - 0.002 && y < H - 0.001 && y > 0.05) {
      const k = 0.7 + 0.18 * sstep(0.1, H, y) - (ny < -0.5 ? 0.1 : 0);
      return [k, k * 0.94, k * 0.86];
    }
    let k = 0.62 + 0.38 * sstep(-0.3, 1.6, y);
    // a soft, uneven wash so long walls aren't one flat value
    k *= 0.95 + 0.05 * Math.sin(x * 0.83 + z * 0.61 + 1.3) * Math.sin(y * 0.9 + x * 0.27);
    if (ny < -0.5) k *= 0.62;
    else if (Math.abs(ny) < 0.5 && y < H + 0.05) k *= 1 - 0.2 * sstep(H - 1.1, H, y);
    return [k, k * 0.98, k * 0.95];
  };
}

// ---- the generator ---------------------------------------------------------------------------

export function buildBuilding(batch, b, sign = null) {
  const S = styleFor(b);
  const K = new Kit(batch, matrix(b.x, b.y, b.z, b.ry), shader(b));
  K.seed = 1 + b.id * 977;
  const R = rng(b.id * 31 + 7);
  const W = b.w, D = b.dep, H = b.h, dw = b.door / 2;
  const c = {
    K, S, b, R, W, D, H, dw, ox: W / 2 + 0.15, oz: D / 2 + 0.15, ix: W / 2 - 0.15, iz: D / 2 - 0.15, dh: H - 0.8,
    sign, glows: [], tall: H > 4.5, signZ: D / 2 + 0.3,
  };
  c.ww = S.winW * (c.tall ? 1.15 : 1); c.wh = S.winH * (c.tall ? 1.45 : 1); c.winY = S.winY * (c.tall ? 1.2 : 1);
  c.world = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(K.root);
  walls(c); base(c); interior(c); doorway(c); planWindows(c);
  for (const w of c.wins) onWall(c, w.side, () => windowAt(c, w.t, w.side));
  framing(c);
  if (S.layout === 'shed') shedRoof(c);
  else if (S.layout === 'flat') flatRoof(c);
  else pitchedRoof(c);
  extras(c);
  return { signZ: c.signZ, glows: c.glows, style: S, frame: K.root };
}

const FRAMES = c => ({
  front: { at: [0, 0, c.oz], ry: 0, len: 2 * c.ox },
  back: { at: [0, 0, -c.oz], ry: Math.PI, len: 2 * c.ox },
  right: { at: [c.ox, 0, 0], ry: Math.PI / 2, len: 2 * c.oz },
  left: { at: [-c.ox, 0, 0], ry: -Math.PI / 2, len: 2 * c.oz },
});
// run fn in a wall's frame: its outer face is z = 0 facing +z, x runs to the right as seen from outside
function onWall(c, side, fn) { const f = FRAMES(c)[side]; c.K.push(f.at[0], 0, f.at[2], f.ry); fn(f); c.K.pop(); }

// ---- shell -------------------------------------------------------------------------------------

function walls(c) {
  const { K, S, H, ix, dw, D, W, R } = c;
  const m = mat(S.wall), ny = Math.max(2, Math.ceil(H / 0.6)), sg = L => Math.max(1, Math.ceil(L / 1.6));
  const o = { uvSpace: 'kit', tile: S.wallTile, uvOff: [R(), R()], tint: S.wallTint };
  K.box(m, 2 * ix, H, 0.3, 0, H / 2, -D / 2, { ...o, seg: [sg(W), ny, 1] });
  K.box(m, 0.3, H, D + 0.3, -W / 2, H / 2, 0, { ...o, seg: [1, ny, sg(D)] });
  K.box(m, 0.3, H, D + 0.3, W / 2, H / 2, 0, { ...o, seg: [1, ny, sg(D)] });
  const segW = ix - dw;
  K.box(m, segW, H, 0.3, -(dw + segW / 2), H / 2, D / 2, { ...o, seg: [sg(segW), ny, 1] });
  K.box(m, segW, H, 0.3, dw + segW / 2, H / 2, D / 2, { ...o, seg: [sg(segW), ny, 1] });
  K.box(m, 2 * dw, 0.8, 0.3, 0, H - 0.4, D / 2, { ...o, seg: [1, 2, 1] });
}

function base(c) {
  const { K, S, ox, oz, dw, iz, R } = c;
  const t = 0.12;
  if (S.base) {
    const m = mat(S.base), bh = S.baseH, hh = bh + 0.6, cy = (bh - 0.6) / 2;
    const o = { uvSpace: 'kit', tile: S.baseTile, seg: [1, 2, 1], uvOff: [R(), R()], tint: S.baseTint };
    K.box(m, 2 * (ox + t), hh, 0.25 + t, 0, cy, -oz + (0.25 - t) / 2, o);
    K.box(m, 0.25 + t, hh, 2 * oz, -ox + (0.25 - t) / 2, cy, 0, o);
    K.box(m, 0.25 + t, hh, 2 * oz, ox - (0.25 - t) / 2, cy, 0, o);
    const fx0 = dw + 0.2, fx1 = ox + t;
    K.box(m, fx1 - fx0, hh, 0.25 + t, -(fx0 + fx1) / 2, cy, oz - (0.25 - t) / 2, o);
    K.box(m, fx1 - fx0, hh, 0.25 + t, (fx0 + fx1) / 2, cy, oz - (0.25 - t) / 2, o);
    if (S.snow) {
      const sm = mat('snow_roof'), sy = bh + 0.04;
      const ledge = (w, d, x, z) => K.box(sm, w, 0.09, d, x, sy, z, { tile: 2, warp: v => { v.y += 0.03 * Math.sin(v.x * 3.1 + v.z * 2.3); } , seg: [Math.ceil(w / 0.5), 1, 1] });
      ledge(2 * (ox + t), t + 0.02, 0, -oz - t / 2);
      ledge(t + 0.02, 2 * oz, -ox - t / 2, 0); ledge(t + 0.02, 2 * oz, ox + t / 2, 0);
      ledge(fx1 - fx0, t + 0.02, -(fx0 + fx1) / 2, oz + t / 2); ledge(fx1 - fx0, t + 0.02, (fx0 + fx1) / 2, oz + t / 2);
    }
  }
  // the threshold step under the door (top flush with the floor)
  const sm = mat(S.base || S.floor);
  K.box(sm, 2 * dw + 0.36, 0.42, oz + 0.5 - iz, 0, -0.11, (iz + oz + 0.5) / 2, { tile: 2, seg: [1, 1, 1] });
}

function interior(c) {
  const { K, S, H, ix, iz, dw, D, b, R } = c;
  // floor (casino gets its carpet in town3d.js, over a plank border)
  const fm = mat(S.floor);
  K.box(fm, 2 * ix, 0.06, 2 * iz, 0, 0.07, 0, { uvSpace: 'kit', tile: S.floor === 'flagstone' ? 3.2 : 3, seg: [1, 1, 1], receive: true, cast: false });
  K.box(fm, 2 * dw, 0.06, 0.3, 0, 0.07, D / 2, { uvSpace: 'kit', tile: 3, seg: [1, 1, 1], cast: false });
  // ceiling boards and beams
  const cm = mat('floor_planks'), bm = mat(S.beam);
  K.box(cm, 2 * ix, 0.06, 2 * iz, 0, H - 0.03, 0, { uvSpace: 'kit', tile: 3, seg: [1, 1, 1], tint: '#9a8478', cast: false });
  const nb = Math.max(1, Math.round(2 * iz / 2.6));
  for (let k = 0; k < nb; k++) {
    const z = -iz + 2 * iz * (k + 0.5) / nb;
    K.box(bm, 2 * ix, 0.26, 0.24, 0, H - 0.19, z, { grain: 'x', tile: 1.2, seg: [3, 1, 1], cast: false });
  }
  // inner wall lining (+ wainscot)
  const im = mat(S.inner), y0 = S.wainscot ? 1.1 : 0.1, hh = H - y0, cy = y0 + hh / 2;
  const o = { uvSpace: 'kit', tile: S.wallTile, seg: [1, 3, 1], uvOff: [R(), R()], cast: false, tint: S.innerTint };
  const t = 0.02, e = t / 2 + 0.002;
  K.box(im, 2 * ix, hh, t, 0, cy, -iz + e, o);
  K.box(im, t, hh, 2 * iz, -ix + e, cy, 0, o);
  K.box(im, t, hh, 2 * iz, ix - e, cy, 0, o);
  const segW = ix - dw;
  K.box(im, segW, hh, t, -(dw + segW / 2), cy, iz - e, o);
  K.box(im, segW, hh, t, dw + segW / 2, cy, iz - e, o);
  if (S.wainscot) {
    const wm = mat('planks_weathered'), wo = { uvSpace: 'kit', tile: 2.4, seg: [1, 1, 1], tint: '#b08a68', cast: false };
    const wy = 0.6, wh = 1.0;
    K.box(wm, 2 * ix, wh, t, 0, wy, -iz + e, wo);
    K.box(wm, t, wh, 2 * iz, -ix + e, wy, 0, wo);
    K.box(wm, t, wh, 2 * iz, ix - e, wy, 0, wo);
    K.box(wm, segW, wh, t, -(dw + segW / 2), wy, iz - e, wo);
    K.box(wm, segW, wh, t, dw + segW / 2, wy, iz - e, wo);
    const rail = (w, d, x, z) => K.box(bm, w, 0.08, d, x, 1.12, z, { grain: w > d ? 'x' : 'z', cast: false, seg: [1, 1, 1] });
    rail(2 * ix, 0.07, 0, -iz + 0.035); rail(0.07, 2 * iz, -ix + 0.035, 0); rail(0.07, 2 * iz, ix - 0.035, 0);
    rail(segW, 0.07, -(dw + segW / 2), iz - 0.035); rail(segW, 0.07, dw + segW / 2, iz - 0.035);
  }
  if (S.name !== 'adobe' && b.kind !== 'casino') {
    // a hanging lantern from the middle beam
    lantern(c, [0, H - 0.32, -iz * 0.25], 0.55, true);
  }
}

function doorway(c) {
  const { K, S, b, dw, dh, D, oz, H, R } = c;
  const stone = S.name === 'alpine';
  const fm = mat(stone ? 'granite_block' : S.trim === 'brass' ? S.beam : S.beam);
  const jw = stone ? 0.36 : 0.2;
  for (const s of [-1, 1]) K.box(fm, jw, dh + 0.05, 0.46, s * (dw + jw / 2), dh / 2, D / 2, { tile: stone ? 2 : 1.2, seg: [1, 3, 1], tint: stone ? '#c8ccd8' : null });
  K.box(fm, 2 * dw + 2 * jw + 0.3, stone ? 0.42 : 0.28, 0.5, 0, dh + (stone ? 0.21 : 0.14), D / 2, { grain: 'x', tile: stone ? 2 : 1.2, seg: [2, 1, 1], tint: stone ? '#c8ccd8' : null });
  if (stone) K.box(fm, 0.5, 0.56, 0.56, 0, dh + 0.3, D / 2, { tile: 2, tint: '#d4d8e2' });   // keystone
  if (S.trim === 'brass') K.box(mat('brass'), 2 * dw + 0.7, 0.08, 0.54, 0, dh + 0.3, D / 2, { grain: 'x', tile: 1 });
  // door leaves, swung open flat against the facade
  const dm = mat('door_plank');
  const barn = S.layout === 'gambrel';
  const leaves = barn ? [] : b.kind === 'casino' ? [[-1, Math.min(1.2, dw + 0.3)], [1, Math.min(1.2, dw + 0.3)]] : [[1, Math.min(1.35, c.ix - dw - 0.5)]];
  c.leafW = barn ? Math.min(2.0, c.ix - dw - 0.4) + 0.1 : b.kind === 'casino' ? leaves[1][1] : leaves[0][1];
  c.leafWL = barn ? c.leafW : b.kind === 'casino' ? leaves[0][1] : 0;
  const lh = Math.min(dh - 0.06, 2.6 + (dh - 2.6) * 0.5);
  for (const [s, lw] of leaves) {
    if (lw < 0.5) continue;
    K.push(s * (dw + jw + 0.02), 0, oz + 0.05, s * -0.14);
    K.box(dm, lw, lh, 0.07, s * lw / 2, lh / 2 + 0.05, 0.035, { uv: 'keep', seg: [1, 1, 1], flipU: s < 0 });
    K.pop();
  }
}

function planWindows(c) {
  const { S, ox, oz, ix, dw, W, D, R, b } = c;
  const ww = c.ww, wins = [];
  const jit = () => (R() - 0.5) * 0.25;
  // front: one each side of the door, clear of the door leaves
  const spans = [[-(ix - 0.3), -(dw + 0.5 + c.leafWL + 0.15)], [dw + 0.5 + c.leafW + 0.15, ix - 0.3]];
  for (const [a, z] of spans) if (z - a >= ww + 0.3) wins.push({ side: 'front', t: (a + z) / 2 });
  // sides and back, evenly spaced
  const n = Math.max(1, Math.round((2 * oz - 1.8) / 3.2));
  for (const side of ['left', 'right']) for (let k = 0; k < n; k++) {
    const L = 2 * oz - 1.8;
    wins.push({ side, t: -L / 2 + L * (k + 0.5) / n + jit() });
  }
  const nb = b.kind === 'pawn' || b.kind === 'store' ? 0 : W > 16 ? 3 : W > 8.5 ? 2 : 1;   // shops have shelves on the back wall
  for (let k = 0; k < nb; k++) { const L = 2 * ox - 2.2; wins.push({ side: 'back', t: -L / 2 + L * (k + 0.5) / nb + jit() }); }
  c.wins = wins;
}

function windowAt(c, t, side) {
  const { K, S, R } = c;
  const ww = c.ww, wh = c.wh, y0 = c.winY, cy = y0 + wh / 2;
  const bm = mat(S.win === 'stone' ? 'granite_block' : S.beam);
  const wmat = winMat();
  if (S.win === 'port') {
    // goblin porthole: round glass in a riveted brass ring
    const r = ww / 2;
    K.add(wmat, new THREE.CircleGeometry(r, 20), { uv: 'keep', at: matrix(t, cy, 0.02), shade: false });
    K.add(mat('brass'), new THREE.TorusGeometry(r + 0.04, 0.07, 6, 20), { uv: 'keep', uvScale: [3, 1], at: matrix(t, cy, 0.05) });
    K.add(wmat, new THREE.CircleGeometry(r, 20), { uv: 'keep', at: matrix(t, cy, -0.336, Math.PI), shade: false });
    K.add(mat('brass'), new THREE.TorusGeometry(r + 0.04, 0.06, 6, 20), { uv: 'keep', uvScale: [3, 1], at: matrix(t, cy, -0.35) });
    if (S.awning && side !== 'back') awning(c, t, cy + r + 0.3, ww + 0.6, 0.75);
    return;
  }
  K.quad(wmat, ww, wh, t, cy, 0.012, { shade: false });
  const stone = S.win === 'stone';
  const jw = stone ? 0.24 : 0.13, tint = stone ? '#c8ccd8' : null;
  for (const s of [-1, 1]) K.box(bm, jw, wh + 0.12, stone ? 0.16 : 0.12, t + s * (ww / 2 + jw / 2 - 0.02), cy, 0.05, { tile: stone ? 2 : 1.2, tint });
  K.box(bm, ww + 2 * jw + 0.12, stone ? 0.26 : 0.17, stone ? 0.2 : 0.16, t, cy + wh / 2 + (stone ? 0.13 : 0.085), 0.07, { grain: 'x', tile: stone ? 2 : 1.2, tint });
  K.box(bm, ww + 2 * jw + 0.08, 0.1, 0.22, t, y0 - 0.05, 0.1, { grain: 'x', tile: stone ? 2 : 1.2, tint });
  // mullion cross for big windows
  if (S.win === 'flower') {
    K.box(mat('wood_light'), ww + 0.14, 0.24, 0.26, t, y0 - 0.22, 0.15, { grain: 'x', tint: '#b89070' });
    K.quad(flowerMat(), ww + 0.3, 0.5, t, y0 + 0.05, 0.17, { shade: false });
    K.quad(flowerMat(), ww + 0.1, 0.42, t, y0 + 0.02, 0.2, { ry: 0.25, shade: false });
  }
  if (S.win === 'shutter') {
    const sm = mat(S.shutter);
    for (const s of [-1, 1]) K.box(sm, ww * 0.5, wh + 0.05, 0.05, t + s * (ww * 0.75 + jw + 0.04), cy, 0.035, { uvSpace: 'part', tile: 1.6, seg: [1, 1, 1], tint: '#d8c8b8' });
    for (const s of [-1, 1]) K.box(mat('iron_wrought'), 0.18, 0.04, 0.03, t + s * (ww / 2 + jw + 0.12), cy + wh * 0.3, 0.07, { tile: 0.5 });
  }
  if (S.snow) {
    const sm = mat('snow_roof');
    K.box(sm, ww + 2 * jw + 0.1, 0.07, 0.22, t, y0 + 0.03, 0.1, { tile: 2, seg: [3, 1, 1], warp: v => { v.y += 0.025 * Math.sin(v.x * 7); } });
    K.box(sm, ww + 2 * jw + 0.16, 0.08, 0.2, t, cy + wh / 2 + 0.3, 0.07, { tile: 2, seg: [3, 1, 1], warp: v => { v.y += 0.03 * Math.sin(v.x * 5 + 1); } });
    for (let k = 0; k < 2; k++) K.box(mat('iron_wrought'), 0.035, wh, 0.035, t + (k - 0.5) * ww * 0.45, cy, 0.04, { tile: 0.5 });
  }
  if (S.awning && side === 'front') awning(c, t, cy + wh / 2 + 0.35, ww + 0.6, 0.7);
  // inside: the same window and a sill
  K.quad(wmat, ww, wh, t, cy, -0.336, { ry: Math.PI, shade: false });
  K.box(bm, ww + 0.25, 0.06, 0.16, t, y0 - 0.03, -0.38, { grain: 'x', cast: false, tint });
  for (const s of [-1, 1]) K.box(bm, 0.1, wh + 0.1, 0.06, t + s * (ww / 2 + 0.05), cy, -0.35, { cast: false, tint });
  K.box(bm, ww + 0.3, 0.1, 0.06, t, cy + wh / 2 + 0.05, -0.35, { grain: 'x', cast: false, tint });
}

// a slanted canvas awning on two struts, in a wall frame (x along the wall, z out)
function awning(c, x, y, w, depth) {
  const { K, S } = c;
  const am = mat(S.awning, { side: THREE.DoubleSide });
  const drop = depth * 0.45, L = Math.hypot(depth, drop), ang = Math.atan2(drop, depth);
  K.push(x, y, 0.02, 0, ang);
  K.quad(am, w, L, 0, 0, L / 2, { rx: -Math.PI / 2, uv: 'keep', uvScale: [w / 1.2, L / 1.2], sy: 2 });
  K.pop();
  K.quad(am, w, 0.22, x, y - drop - 0.1, depth + 0.03, { uv: 'keep', uvScale: [w / 1.2, 0.2] });
  for (const s of [-1, 1]) K.beam(mat(c.S.beam), [x + s * (w / 2 - 0.08), y - drop - 0.7, 0.02], [x + s * (w / 2 - 0.08), y - drop - 0.02, depth - 0.05], 0.06, 0.06);
}

// ---- framing: half-timber, quoins, corner boards, log ends ----------------------------------------

function framing(c) {
  const { K, S, H, ox, oz, b, R } = c;
  const bm = mat(S.beam);
  const by = S.baseH || 0;
  if (S.halfTimber) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(bm, 0.34, H - by + 0.05, 0.34, sx * (ox - 0.11), by + (H - by) / 2, sz * (oz - 0.11), { tile: 1.2, seg: [1, 3, 1] });
    for (const side of ['front', 'back', 'left', 'right']) onWall(c, side, f => halfTimberWall(c, side, f.len));
  }
  if (S.topBeams) {
    // heavy dwarven plates with the beam ends poking out at the corners
    for (const sz of [-1, 1]) K.box(bm, 2 * ox + 0.7, 0.36, 0.34, 0, H - 0.18, sz * (oz - 0.08), { grain: 'x', tile: 1.4, seg: [4, 1, 1] });
    for (const sx of [-1, 1]) K.box(bm, 0.34, 0.36, 2 * oz + 0.7, sx * (ox - 0.08), H - 0.5, 0, { grain: 'z', tile: 1.4, seg: [1, 1, 4] });
  }
  if (S.quoins) {
    // big dressed corner stones, alternating long and short
    const qm = mat('granite_block'), n = Math.floor((H - (S.baseH || 0)) / 0.55);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < n; k++) {
      const y = (S.baseH || 0) + 0.3 + k * 0.55, long = (k & 1) ? 0.85 : 0.5;
      // (0.36 deep, so they stop 1 cm short of the inner wall face)
      K.box(qm, long, 0.5, 0.36, sx * (ox - long / 2 + 0.06), y, sz * (oz - 0.11), { tile: 2.2, tint: '#d0d4de', seg: [1, 1, 1] });
      K.box(qm, 0.36, 0.5, (k & 1) ? 0.5 : 0.85, sx * (ox - 0.11), y, sz * (oz - ((k & 1) ? 0.5 : 0.85) / 2 + 0.06), { tile: 2.2, tint: '#d0d4de', seg: [1, 1, 1] });
    }
  }
  if (S.cornerBoards || S.cornerPosts) {
    const cm = mat(S.cornerPosts ? S.beam : S.cornerMat || 'wood_light');
    const t = S.cornerPosts ? 0.32 : 0.22;
    const ct = S.cornerTint || '#a08a70';
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(cm, t, H - by + 0.02, t, sx * (ox - t / 2 + 0.05), by + (H - by) / 2, sz * (oz - t / 2 + 0.05), { tile: 1.2, seg: [1, 3, 1], tint: S.cornerPosts ? null : ct });
    if (S.cornerBoards) for (const sz of [-1, 1]) K.box(cm, 2 * ox + 0.1, 0.18, 0.08, 0, H - 0.25, sz * (oz + 0.03), { grain: 'x', tile: 1.2, seg: [3, 1, 1], tint: ct });
    if (S.cornerBoards) for (const sx of [-1, 1]) K.box(cm, 0.08, 0.18, 2 * oz + 0.1, sx * (ox + 0.03), H - 0.25, 0, { grain: 'z', tile: 1.2, seg: [1, 1, 3], tint: ct });
  }
  if (S.logEnds) {
    // crossed log ends at the corners (one course every 3/7 of a 3 m tile)
    const lm = mat('wood_light'), step = 3 / 7;
    for (let y = 0.2; y < H - 0.1; y += step) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const r = 0.19 + R() * 0.03, stick = 0.35 + R() * 0.15;
      const alongX = Math.round(y / step) % 2 === 0;
      if (alongX) K.cyl(lm, [sx * (ox - 0.3), y, sz * (oz - 0.15)], [sx * (ox + stick), y + (R() - 0.5) * 0.04, sz * (oz - 0.15)], r, r * 0.95, { sides: 8, tint: '#c09a70' });
      else K.cyl(lm, [sx * (ox - 0.15), y, sz * (oz - 0.3)], [sx * (ox - 0.15), y + (R() - 0.5) * 0.04, sz * (oz + stick)], r, r * 0.95, { sides: 8, tint: '#c09a70' });
    }
  }
  if (S.buttress) {
    // sloped mud buttresses hugging the corners
    const am = mat(S.wall);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const hgt = H * 0.75 + R() * 0.4;
      K.box(am, 0.9, hgt, 0.9, sx * (ox + 0.16), hgt / 2, sz * (oz + 0.16), {
        uvSpace: 'kit', tile: c.S.wallTile, seg: [2, 3, 2], warp: v => { const t = (v.y + hgt / 2) / hgt; const k = 1 - 0.55 * t * t; v.x = (v.x + sx * 0.45) * k - sx * 0.45; v.z = (v.z + sz * 0.45) * k - sz * 0.45; },
      });
    }
  }
}

// Half-timbering on one wall (wall frame): sill, top plate, a rail at the window sills, studs between
// the openings, and braces near the corners.
function halfTimberWall(c, side, len) {
  const { K, S, H, dw, dh, R } = c;
  const bm = mat(S.beam);
  const z = 0.035, d = 0.15, by = S.baseH;
  const half = len / 2 - 0.25;
  const o = { tile: 1.2, grain: 'x', seg: [Math.max(1, Math.ceil(len / 2)), 1, 1] };
  K.box(bm, len - 0.1, 0.22, d, 0, by + 0.11, z, o);
  K.box(bm, len - 0.1, 0.26, d, 0, H - 0.13, z, o);
  const railY = c.winY - 0.1;
  // the openings on this wall: windows (and the door at the front)
  const ops = c.wins.filter(w => w.side === side).map(w => [w.t - c.ww / 2 - 0.15, w.t + c.ww / 2 + 0.15]);
  if (side === 'front') ops.push([-dw - 0.25, dw + 0.25]);
  const clear = x => !ops.some(([a, b]) => x > a - 0.12 && x < b + 0.12);
  // rail, broken at the door
  const railSegs = side === 'front' ? [[-half, -dw - 0.25], [dw + 0.25, half]] : [[-half, half]];
  for (const [a, b] of railSegs) if (b - a > 0.3) K.box(bm, b - a, 0.18, d, (a + b) / 2, railY, z, { ...o, seg: [2, 1, 1] });
  // studs
  const studs = [];
  for (const [a, b] of ops) studs.push(a - 0.04, b + 0.04);
  for (let x = -half + 1.2; x < half - 0.6; x += 1.35 + R() * 0.3) if (clear(x)) studs.push(x);
  for (const x of studs) {
    if (Math.abs(x) > half) continue;
    const inDoor = side === 'front' && Math.abs(x) < dw + 0.3;
    const y0 = inDoor ? dh + 0.28 : by + 0.22;
    K.box(bm, 0.18, H - 0.26 - y0, d, x, (y0 + H - 0.26) / 2, z, { tile: 1.2, grain: 'y', seg: [1, 2, 1] });
  }
  // braces: from each corner down-in to the rail, and up-in to the top plate
  for (const s of [-1, 1]) {
    const x0 = s * half, x1 = s * (half - 1.1);
    if (clear(x1) && clear((x0 + x1) / 2)) {
      K.beam(bm, [x0, by + 0.22, z], [x1, railY - 0.09, z], 0.16, d);
      K.beam(bm, [x0, H - 0.26, z], [x1, railY + 0.09, z], 0.16, d);
    }
  }
  // over the windows: short crossed braces in the upper panel
  for (const w of c.wins.filter(w => w.side === side)) {
    const top = c.winY + c.wh + 0.2;
    if (H - 0.26 - top > 0.45) K.box(bm, c.ww + 0.4, 0.14, d, w.t, top, z, { ...o, seg: [1, 1, 1] });
  }
}

// ---- roofs --------------------------------------------------------------------------------------

function profileOf(c, hs, kind, pitch, eave) {
  const { H } = c;
  if (kind === 'gambrel') {
    const lowA = 64 * D2R, upA = 26 * D2R, hk = hs * 0.6;
    const yk = H + (hs - hk) * Math.tan(lowA), apex = yk + hk * Math.tan(upA), e = eave * 0.55;
    return { pts: [[-hs - e, H - e * Math.tan(lowA)], [-hk, yk], [0, apex], [hk, yk], [hs + e, H - e * Math.tan(lowA)]], under: [[-hs, H], [-hk, yk], [0, apex], [hk, yk], [hs, H]], apex, tp: Math.tan(lowA) };
  }
  const tp = Math.tan(pitch * D2R), apex = H + hs * tp;
  return { pts: [[-hs - eave, H - eave * tp], [0, apex], [hs + eave, H - eave * tp]], under: [[-hs, H], [0, apex], [hs, H]], apex, tp };
}

// roof slabs along the profile, extruded in the current frame from z = w0 to w1
function roofSlabs(c, P, w0, w1, { roofMat, thick, barge = true, eaveBeams = true, hs = 0, ridge = true, ridgeFrom = null }) {
  const { K, S, H } = c;
  const rm = mat(roofMat), bm = mat(S.trim && S.trim !== 'brass' ? S.trim : S.beam), th = thick;
  const n = P.pts.length, len = w1 - w0;
  const hsh = (x, y, z) => { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s) - 0.5; };
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = P.pts[i], [x1, y1] = P.pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx), up = dy > 0;
    const extHi = th * 0.95, extLo = (i === 0 || i === n - 2) ? 0 : th * 0.45;
    const Lt = L + extHi + extLo, shift = (up ? 1 : -1) * (extHi - extLo) / 2;
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const cx = (x0 + x1) / 2 + Math.cos(ang) * shift + nx * th / 2, cy = (y0 + y1) / 2 + Math.sin(ang) * shift + ny * th / 2;
    const sag = Math.min(0.09, len * 0.006);
    const warp = v => {
      const tz = (v.z + len / 2) / len, tx = (v.x + Lt / 2) / Lt;
      const low = up ? 1 - tx : tx;      // the eave end sags more than the ridge
      v.y -= sag * Math.sin(Math.PI * tz) * (0.4 + 0.6 * low);
      v.y += hsh(Math.round(v.x * 4), Math.round(v.z * 4), i) * 0.035 * (Math.abs(v.y) < th ? 1 : 0);
    };
    K.add(rm, new THREE.BoxGeometry(Lt, th, len, 3, 1, Math.max(2, Math.ceil(len / 1.4))), { at: matrix(cx, cy, (w0 + w1) / 2, 0, 0, ang), tile: S.roofTile, grain: 'x', flipV: !up, warp });
    if (barge) {
      for (const [wz, s] of (ridgeFrom !== null ? [[w1, 1]] : [[w1, 1], [w0, -1]])) {
        K.add(bm, new THREE.BoxGeometry(Lt + 0.06, th + 0.24, 0.1, 2, 1, 1), { at: matrix(cx - nx * 0.08, cy - ny * 0.08, wz + s * 0.04, 0, 0, ang), tile: 1.2, grain: 'x', tint: S.trimTint });
      }
    }
    if (c.S.snow) {
      const sm = mat('snow_roof'), st = 0.2;
      const inset = 0.22, Ls = Lt - inset, sshift = shift + (up ? 1 : -1) * inset / 2;
      const scx = (x0 + x1) / 2 + Math.cos(ang) * sshift + nx * (th + st / 2 - 0.03), scy = (y0 + y1) / 2 + Math.sin(ang) * sshift + ny * (th + st / 2 - 0.03);
      K.add(sm, new THREE.BoxGeometry(Ls, st, len + 0.04, 4, 1, Math.max(3, Math.ceil(len / 0.8))), {
        at: matrix(scx, scy, (w0 + w1) / 2, 0, 0, ang), tile: 2.2, grain: 'x',
        warp: v => { if (v.y > 0) v.y += 0.05 * Math.sin(v.x * 2.3 + v.z * 1.7) + 0.04 * Math.sin(v.z * 4.1); else v.y += 0.02; },
      });
    }
  }
  // ridge cap
  const rk = S.ridge;
  if (ridgeFrom !== null) w0 = ridgeFrom;
  if (!ridge) { /* the ridge is capped by the second half */ }
  else if (rk === 'thatch') K.cyl(rm, [0, P.apex + th * 0.75, w0 - 0.1], [0, P.apex + th * 0.75, w1 + 0.1], 0.32, 0.32, { sides: 10, uvScale: [2, len / 1.5] });
  else if (rk === 'snow') K.cyl(mat('snow_roof'), [0, P.apex + th + 0.12, w0 - 0.05], [0, P.apex + th + 0.12, w1 + 0.05], 0.24, 0.24, { sides: 10, uvScale: [1, len / 2] });
  else K.add(bm, new THREE.BoxGeometry(0.3, 0.3, len + 0.12, 1, 1, 2), { at: matrix(0, P.apex + th * 1.05, (w0 + w1) / 2, 0, 0, Math.PI / 4), grain: 'z', tile: 1.2 });
  // rafter tails under the eaves
  if (eaveBeams && hs) {
    const e = Math.abs(P.pts[0][0]) - hs;
    for (let w = w0 + 0.45; w < w1 - 0.3; w += 0.75) for (const s of [-1, 1]) {
      K.beam(bm, [s * (hs - 0.05), H - 0.12, w], [s * (hs + e * 0.92), H - e * 0.92 * P.tp - 0.1, w], 0.1, 0.13, { cast: false });
    }
    // icicles along the eave edges
    if (c.S.snow) {
      const im = mat('snow_roof');
      for (let w = w0 + 0.2; w < w1 - 0.1; w += 0.28 + Math.abs(hsh(w, 1, 2)) * 0.3) for (const s of [-1, 1]) {
        const l = 0.18 + Math.abs(hsh(w, s, 3)) * 0.6;
        K.add(im, new THREE.ConeGeometry(0.045 + l * 0.04, l, 5), { uv: 'keep', at: matrix(s * (hs + e - 0.06), H - e * P.tp - l / 2 + 0.04, w, 0, Math.PI, 0), tint: '#d8e8ff', cast: false });
      }
    }
  }
}

// the gable infill under a profile (in the current frame), outer face at z = wf (sgn = outward)
function gableFill(c, P, wf, sgn) {
  const { K, S, R } = c;
  const gm = mat(S.gableFill);
  const z0 = sgn > 0 ? wf - 0.3 : wf;
  K.prism(gm, P.under, z0, 0.3, { uvSpace: 'kit', tile: S.wallTile, tint: S.gableTint, uvOff: [R(), R()] });
  const bm = mat(S.beam), z = wf + sgn * 0.04, H = c.H, ap = P.apex, hs = P.under[P.under.length - 1][0];
  if (S.halfTimber || S.name === 'alpine' || S.layout === 'gambrel') {
    K.box(bm, 2 * hs + 0.1, 0.24, 0.14, 0, H + 0.1, z, { grain: 'x', tile: 1.2, seg: [3, 1, 1] });
    if (S.layout !== 'gambrel') {
      K.beam(bm, [0, H + 0.2, z], [0, ap - 0.15, z], 0.2, 0.14);
      for (const s of [-1, 1]) K.beam(bm, [s * hs * 0.62, H + 0.2, z], [s * 0.1, H + (ap - H) * 0.62, z], 0.17, 0.13);
      const y2 = H + (ap - H) * 0.45, w2 = hs * (1 - 0.45);
      K.box(bm, 2 * w2, 0.17, 0.13, 0, y2, z, { grain: 'x', tile: 1.2, seg: [2, 1, 1] });
    }
  }
}

function pitchedRoof(c) {
  const { K, S, b, ox, oz, H, sign, R } = c;
  const eave = S.eave, gOH = S.gableOH;
  const kind = S.layout === 'gambrel' ? 'gambrel' : 'gable';
  // steep, but a deep hall doesn't get a roof three times its height
  const maxRise = (S.maxRise || 5) * (c.tall ? 1.3 : 1);
  const pitch = Math.min(S.pitch, Math.atan(maxRise / oz) / D2R);
  const tp = Math.tan(pitch * D2R);
  // the front gable must be wide enough to carry the sign
  let hsNeed = c.dw + 1.4;
  if (sign) hsNeed = Math.max(hsNeed, sign.w / 2 + 0.35 + Math.max(0, sign.top - H) / tp);
  const mainApex = H + oz * tp;
  // (gas stations keep a plain front gable: the pump canopy hangs right in front of them)
  const cross = kind === 'gable' && b.kind !== 'gas' && hsNeed < ox * 0.86 && H + hsNeed * tp < mainApex - 0.35;
  if (!cross) {
    // one roof, ridge running front to back: the whole front is a gable
    const P = profileOf(c, ox, kind, kind === 'gambrel' ? S.pitch : Math.min(S.pitch, Math.atan(maxRise * 1.15 / ox) / D2R), eave);
    roofSlabs(c, P, -oz - gOH, oz + gOH, { roofMat: S.roof, thick: S.thick, barge: S.barge, hs: ox });
    gableFill(c, P, oz, 1); gableFill(c, P, -oz, -1);
    c.signZ = oz + 0.1;
    c.apex = P.apex;
    if (S.chimney) chimney(c, ox * 0.42 * (R() < 0.5 ? -1 : 1), -oz * 0.4, x => H + (ox - Math.abs(x)) * P.tp, P.apex);
    if (kind === 'gambrel') barnFront(c, P);
    return;
  }
  // main roof, ridge along the width, plus a jettied cross gable over the door carrying the sign
  const P = profileOf(c, oz, kind, pitch, eave);
  K.push(0, 0, 0, Math.PI / 2);
  roofSlabs(c, P, -ox - gOH, ox + gOH, { roofMat: S.roof, thick: S.thick, barge: S.barge, hs: oz });
  gableFill(c, P, ox, 1); gableFill(c, P, -ox, -1);
  K.pop();
  const j = eave + 0.12;
  const Pc = profileOf(c, hsNeed, kind, pitch, Math.min(eave, 0.45));
  const Pc0 = profileOf(c, hsNeed, kind, pitch, 0.02);
  roofSlabs(c, Pc0, 0, oz + 0.2, { roofMat: S.roof, thick: S.thick, barge: false, hs: 0, eaveBeams: false, ridge: false });
  roofSlabs(c, Pc, oz + 0.2, oz + j + gOH, { roofMat: S.roof, thick: S.thick, barge: S.barge, hs: 0, eaveBeams: false, ridgeFrom: 0 });
  gableFill(c, Pc, oz + j, 1);
  // the jetty: the gable sits out over the pent roof on a beam and two braces
  const bm = mat(S.beam);
  K.box(bm, 2 * hsNeed + 0.3, 0.3, j + 0.3, 0, H - 0.15, oz + j / 2 - 0.15, { grain: 'z', tile: 1.2, seg: [2, 1, 2] });
  for (const s of [-1, 1]) {
    K.beam(bm, [s * (hsNeed - 0.15), H - 1.25, oz + 0.08], [s * (hsNeed - 0.15), H - 0.25, oz + j - 0.1], 0.2, 0.2);
    for (let k = 0; k < 3; k++) K.box(bm, 0.16, 0.16, 0.5, s * (hsNeed - 0.6 - k * 0.7), H - 0.38, oz + 0.2, { grain: 'z', tile: 1.2 });
  }
  if (S.snow) K.box(mat('snow_roof'), 2 * hsNeed + 0.2, 0.1, 0.32, 0, H + 0.04, oz + j + 0.1, { tile: 2, seg: [4, 1, 1], warp: v => { v.y += 0.03 * Math.sin(v.x * 4); } });
  c.signZ = oz + j + 0.1;
  c.apex = P.apex;
  if (S.chimney) chimney(c, ox * 0.55 * (R() < 0.5 ? -1 : 1), -oz * 0.42, (x, z) => H + (oz - Math.abs(z)) * tp, P.apex);
}

function chimney(c, x, z, surf, apex) {
  const { K, S } = c;
  const cm = mat(S.chimney), y0 = surf(x, z) - 0.6, y1 = apex + 0.9;
  K.box(cm, 0.95, y1 - y0, 0.95, x, (y0 + y1) / 2, z, { uvSpace: 'kit', tile: S.baseTile || 2.2, seg: [1, 3, 1], tint: S.baseTint });
  K.box(cm, 1.15, 0.18, 1.15, x, y1 + 0.09, z, { tile: 2.2, tint: S.baseTint });
  K.box(mat('iron_wrought'), 0.6, 0.05, 0.6, x, y1 + 0.2, z, { tile: 1, tint: '#403840' });
  if (S.snow) K.box(mat('snow_roof'), 1.2, 0.12, 1.2, x, y1 + 0.24, z, { tile: 2, seg: [2, 1, 2], warp: v => { v.y += 0.04 * Math.sin(v.x * 6 + v.z * 4); } });
  c.smoke = c.world(x, y1 + 0.4, z);
}

// farm barns: big sliding doors, a hay loft door with a hoist beam
function barnFront(c, P) {
  const { K, S, oz, dw, dh, H } = c;
  const dm = mat('planks_barnred'), tm = mat('wood_white');
  const lw = Math.min(2.0, c.ix - dw - 0.4), lh = Math.min(dh, 3.6);
  for (const s of [-1, 1]) {
    const x = s * (dw + 0.25 + lw / 2);
    K.box(dm, lw, lh, 0.08, x, lh / 2 + 0.05, oz + 0.06, { tile: 2.4, seg: [1, 1, 1] });
    const tr = '#ffffff';
    K.box(tm, lw, 0.14, 0.05, x, 0.12, oz + 0.12, { grain: 'x', tint: tr }); K.box(tm, lw, 0.14, 0.05, x, lh - 0.02, oz + 0.12, { grain: 'x', tint: tr });
    K.box(tm, 0.14, lh, 0.05, x - lw / 2 + 0.07, lh / 2 + 0.05, oz + 0.12, { tint: tr }); K.box(tm, 0.14, lh, 0.05, x + lw / 2 - 0.07, lh / 2 + 0.05, oz + 0.12, { tint: tr });
    K.beam(tm, [x - lw / 2 + 0.1, 0.2, oz + 0.12], [x + lw / 2 - 0.1, lh - 0.1, oz + 0.12], 0.13, 0.05, { tint: tr });
    K.beam(tm, [x + lw / 2 - 0.1, 0.2, oz + 0.12], [x - lw / 2 + 0.1, lh - 0.1, oz + 0.12], 0.13, 0.05, { tint: tr });
  }
  K.box(mat('iron_wrought'), 2 * (dw + lw + 0.4), 0.08, 0.08, 0, lh + 0.12, oz + 0.1, { grain: 'x', tile: 1 });
  // cream trim along the gambrel edges and the eave line
  const tr = '#ffffff';
  const U = P.under;
  for (let i = 0; i < U.length - 1; i++) K.beam(tm, [U[i][0], U[i][1], oz + 0.07], [U[i + 1][0], U[i + 1][1], oz + 0.07], 0.2, 0.06, { tint: tr, ext: 0.2 });
  K.box(tm, 2 * c.ox + 0.1, 0.2, 0.06, 0, H + 0.02, oz + 0.07, { grain: 'x', tint: tr, seg: [3, 1, 1] });
  // loft door with a hoist beam and a round vent up in the gable (above the sign)
  const top = (c.sign ? c.sign.top : H + 1.2) + 0.4;
  if (P.apex - top > 1.8) {
    const hh = Math.min(2.2, P.apex - top - 1.4), lw2 = Math.min(2.2, hh * 1.1);
    K.box(dm, lw2, hh, 0.1, 0, top + hh / 2, oz + 0.06, { tile: 2.4, seg: [1, 1, 1] });
    for (const [a, bb] of [[[-lw2 / 2, top], [lw2 / 2, top + hh]], [[lw2 / 2, top], [-lw2 / 2, top + hh]]]) K.beam(tm, [a[0], a[1], oz + 0.12], [bb[0], bb[1], oz + 0.12], 0.14, 0.05, { tint: tr });
    for (const [x0, y0, x1, y1] of [[-lw2 / 2, top, lw2 / 2, top], [-lw2 / 2, top + hh, lw2 / 2, top + hh], [-lw2 / 2, top, -lw2 / 2, top + hh], [lw2 / 2, top, lw2 / 2, top + hh]]) K.beam(tm, [x0, y0, oz + 0.13], [x1, y1, oz + 0.13], 0.16, 0.05, { tint: tr, ext: 0.16 });
    K.box(mat(S.beam), 0.28, 0.28, 1.8, 0, top + hh + 0.35, oz + 0.7, { grain: 'z' });
    K.box(mat('iron_wrought'), 0.03, 1.5, 0.03, 0, top + hh - 0.45, oz + 1.45, { tile: 0.5 });
    K.add(mat('wood_light'), new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10), { uv: 'keep', at: matrix(0, top + hh + 0.18, oz + 1.45, 0, 0, Math.PI / 2) });
    const vy = top + hh + 1.1;
    if (P.apex - vy > 0.9) {
      K.add(mat('planks_weathered'), new THREE.CircleGeometry(0.55, 16), { uv: 'keep', at: matrix(0, vy, oz + 0.08), tint: '#5a4a40' });
      K.add(tm, new THREE.TorusGeometry(0.58, 0.07, 6, 18), { uv: 'keep', uvScale: [4, 1], at: matrix(0, vy, oz + 0.1), tint: tr });
      for (let k = 0; k < 4; k++) K.box(tm, 1.1, 0.07, 0.04, 0, vy, oz + 0.1, { rz: k * Math.PI / 4, tint: tr });
    }
  }
}

// frontier: a plank false front carrying the sign, a hide-covered shed roof behind it
function shedRoof(c) {
  const { K, S, ox, oz, H, D, sign, R } = c;
  const a = S.pitch * D2R, ta = Math.tan(a);
  const yBack = H - 0.1, zBack = -oz - 0.6, zFront = oz - 0.2;
  const yFront = yBack + (zFront - zBack) * ta;
  const th = S.thick, len = 2 * ox + 0.7;
  // roof slab (rises toward the front), in the frame where x runs back→front
  K.push(0, 0, 0, Math.PI / 2);
  const P = { pts: [[-(zFront), yFront], [-zBack, yBack]], under: [], apex: yFront, tp: ta };
  // (x' = -z in this frame)
  const L = Math.hypot(zFront - zBack, yFront - yBack), ang = Math.atan2(yBack - yFront, zFront - zBack);
  const cx = (-zFront - zBack) / 2 - Math.sin(ang) * th / 2, cy = (yFront + yBack) / 2 + Math.cos(ang) * th / 2;
  K.add(mat(S.roof), new THREE.BoxGeometry(L, th, len, 3, 1, 6), { at: matrix(cx, cy, 0, 0, 0, ang), tile: S.roofTile, grain: 'x', flipV: true,
    warp: v => { v.y -= 0.12 * Math.sin(Math.PI * (v.z / len + 0.5)) * (0.5 + 0.5 * Math.sin(v.x * 2)); } });
  // battens holding the hides down
  for (let k = 0; k < 5; k++) {
    const w = -len / 2 + 0.4 + (len - 0.8) * k / 4 + (R() - 0.5) * 0.4;
    K.add(mat('wood_light'), new THREE.BoxGeometry(L + 0.3, 0.1, 0.14), { at: matrix(cx - Math.sin(ang) * 0.1, cy + Math.cos(ang) * 0.1 - 0.05 * Math.sin(Math.PI * (w / len + 0.5)), w, R() * 0.05, 0, ang), grain: 'x', tint: '#a08060' });
  }
  K.pop();
  // the side infill under the slope (a trapezoid on each side wall)
  const wm = mat(S.wall);
  K.push(0, 0, 0, Math.PI / 2);
  const tri = [[oz, H - 0.01], [-oz, H - 0.01], [-oz, yBack + (-oz - zBack) * ta + 0.05], [oz, yBack + (oz - zBack) * ta + 0.05]].map(([z, y]) => [-z, y]);
  K.prism(wm, tri, ox - 0.3, 0.3, { uvSpace: 'kit', tile: S.wallTile });
  K.prism(wm, tri, -ox, 0.3, { uvSpace: 'kit', tile: S.wallTile });
  K.pop();
  // false front
  const top = Math.max(sign ? sign.top + 0.5 : H + 1.6, yFront + th + 0.7);
  const cw = Math.max(sign ? sign.w / 2 + 0.45 : 1.8, ox * 0.5);
  const step = Math.min(0.9, (top - yFront) * 0.5);
  const pts = [[-ox, H - 0.01], [ox, H - 0.01], [ox, top - step], [cw + 0.5, top - step], [cw, top], [-cw, top], [-cw - 0.5, top - step], [-ox, top - step]];
  K.prism(mat(S.facade), pts, oz - 0.22, 0.22, { uvSpace: 'kit', tile: 3 });
  const bm = mat(S.beam);
  // cap boards and posts
  K.box(bm, 2 * cw + 0.3, 0.16, 0.34, 0, top + 0.06, oz - 0.1, { grain: 'x', tile: 1.2 });
  for (const s of [-1, 1]) {
    K.box(bm, ox - cw - 0.3, 0.14, 0.3, s * (cw + 0.5 + (ox - cw - 0.5) / 2), top - step + 0.05, oz - 0.1, { grain: 'x', tile: 1.2 });
    // corner posts, sharpened
    K.cyl(mat('wood_light'), [s * (ox + 0.05), 0, oz + 0.08], [s * (ox + 0.05), top - step + 0.9, oz + 0.08], 0.17, 0.15, { sides: 8, tint: '#b08a64' });
    K.add(mat('wood_light'), new THREE.ConeGeometry(0.15, 0.45, 8), { uv: 'keep', at: matrix(s * (ox + 0.05), top - step + 1.12, oz + 0.08), tint: '#c8a478' });
  }
  c.signZ = oz + 0.1;
  c.apex = top;
  c.frontTop = top;
  // log pillars dividing the front into bays, and a crown of sharpened stakes along the top
  const lw = mat('wood_light');
  const nb = Math.max(2, Math.round(2 * ox / 4.2));
  for (let k = 1; k < nb; k++) {
    const x = -ox + 2 * ox * k / nb;
    if (Math.abs(x) < c.dw + 0.6 || (sign && Math.abs(x) < sign.w / 2 + 0.35)) continue;
    const yt = Math.abs(x) < cw ? top : top - step;
    K.cyl(lw, [x, 0, oz + 0.1], [x + (R() - 0.5) * 0.05, yt + 0.1, oz + 0.1], 0.16, 0.14, { sides: 8, tint: '#b08a64' });
  }
  for (let x = -cw + 0.15; x <= cw - 0.1; x += 0.42) {
    const h = 0.45 + R() * 0.35;
    K.cyl(lw, [x, top - 0.3, oz - 0.1], [x + (R() - 0.5) * 0.06, top + h, oz - 0.1], 0.1, 0.09, { sides: 6, tint: '#a8865e' });
    K.add(lw, new THREE.ConeGeometry(0.09, 0.3, 6), { uv: 'keep', at: matrix(x, top + h + 0.15, oz - 0.1), tint: '#c8a478' });
  }
  K.box(mat(S.beam), 2 * cw, 0.12, 0.12, 0, top + 0.25, oz + 0.0, { grain: 'x', tile: 1.2 });
  // crossed sharpened stakes over the false front's shoulders
  for (const s of [-1, 1]) for (const tilt of [-0.45, 0.45]) {
    const x = s * (cw + 0.25), y0 = top - step - 0.4;
    K.cyl(mat('wood_light'), [x - Math.sin(tilt) * 0.3, y0, oz + 0.12], [x + Math.sin(tilt) * 1.3, y0 + Math.cos(tilt) * 1.6, oz + 0.2], 0.07, 0.05, { sides: 6, tint: '#a8865e' });
  }
  // a hide awning over the door, hung on struts and rope
  onWall(c, 'front', () => {
    const w = Math.min(2 * c.ox - 1.2, 2 * c.dw + 3.2), y = c.dh + 0.55, depth = 1.7, drop = 0.6;
    const L = Math.hypot(depth, drop), ang = Math.atan2(drop, depth);
    K.push(0, y, 0.05, 0, ang);
    K.quad(mat('hide_patch', { side: THREE.DoubleSide }), w, L, 0, 0, L / 2, { rx: -Math.PI / 2, uv: 'keep', uvScale: [w / 2.5, L / 2.5], sx: 4, sy: 2,
      warp: v => { v.z -= 0.12 * Math.sin(Math.PI * (v.x / w + 0.5)) * Math.sin(Math.PI * (v.y / L + 0.5)); } });
    K.pop();
    const wl = mat('wood_light');
    K.cyl(wl, [-w / 2 - 0.1, y - drop - 0.02, depth + 0.05], [w / 2 + 0.1, y - drop - 0.02, depth + 0.05], 0.07, 0.07, { sides: 7, tint: '#a8865e' });
    for (const s of [-1, 1]) {
      K.beam(wl, [s * (w / 2 - 0.1), y - 1.2, 0.03], [s * (w / 2 - 0.1), y - drop - 0.05, depth], 0.09, 0.09, { tint: '#a8865e' });
      K.cyl(mat('hide_patch'), [s * (w / 2 - 0.1), y + 0.9, 0.03], [s * (w / 2 - 0.1), y - drop, depth + 0.05], 0.015, 0.015, { sides: 4, tint: '#d8c098' });
    }
    // a horned skull over the door
    const sy = c.dh + 0.35;
    K.add(mat('wood_light'), new THREE.SphereGeometry(0.2, 10, 8), { uv: 'keep', at: matrix(0, sy, 0.16, 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)), tint: '#f0e4cc' });
    K.add(mat('wood_light'), new THREE.BoxGeometry(0.2, 0.14, 0.2), { uv: 'keep', at: matrix(0, sy - 0.15, 0.3), tint: '#e8dcc4' });
    for (const s of [-1, 1]) K.add(mat('wood_light'), new THREE.ConeGeometry(0.06, 0.55, 7), { uv: 'keep', at: matrix(s * 0.32, sy + 0.12, 0.14, 0, 0, s * -1.2), tint: '#e8dcc4' });
  });
}

// adobe: a flat roof behind parapets, a stepped front parapet carrying the sign, vigas, a dome
function flatRoof(c) {
  const { K, S, ox, oz, H, sign, b, R } = c;
  const am = mat(S.wall), o = { uvSpace: 'kit', tile: S.wallTile, seg: [1, 1, 1] };
  K.box(mat('adobe'), 2 * ox - 0.3, 0.2, 2 * oz - 0.3, 0, H + 0.1, 0, { tile: 3, tint: '#a88866', seg: [1, 1, 1] });
  const ph = 0.65;
  K.box(am, 2 * ox, ph, 0.3, 0, H + ph / 2, -oz + 0.15, o);
  for (const s of [-1, 1]) K.box(am, 0.3, ph, 2 * oz, s * (ox - 0.15), H + ph / 2, 0, o);
  // rounded mud caps
  const cap = (a, bb) => K.cyl(am, a, bb, 0.17, 0.17, { sides: 8, uvScale: [1, 2] });
  cap([-ox, H + ph, -oz + 0.15], [ox, H + ph, -oz + 0.15]);
  for (const s of [-1, 1]) cap([s * (ox - 0.15), H + ph, -oz], [s * (ox - 0.15), H + ph, oz]);
  // stepped front parapet
  const top = Math.max(sign ? sign.top + 0.45 : H + 1.4, H + 1.2);
  const cw = Math.max(sign ? sign.w / 2 + 0.35 : 1.6, 1.4);
  const mid = H + ph + (top - H - ph) * 0.5;
  const pts = [[-ox, H - 0.01], [ox, H - 0.01], [ox, H + ph], [cw + 0.9, H + ph], [cw + 0.9, mid], [cw, mid], [cw, top], [-cw, top], [-cw, mid], [-cw - 0.9, mid], [-cw - 0.9, H + ph], [-ox, H + ph]];
  K.prism(am, pts, oz - 0.3, 0.3, { uvSpace: 'kit', tile: S.wallTile });
  cap([-cw, top, oz - 0.15], [cw, top, oz - 0.15]);
  for (const s of [-1, 1]) cap([s * cw, mid, oz - 0.15], [s * (cw + 0.9), mid, oz - 0.15]);
  K.box(mat('brass'), 2 * cw + 0.2, 0.1, 0.36, 0, top - 0.32, oz - 0.12, { grain: 'x', tile: 1 });
  // vigas: roof beams poking out of the walls
  const vm = mat(S.beam);
  for (const side of ['front', 'left', 'right', 'back']) onWall(c, side, f => {
    const n = Math.floor((f.len - 0.6) / 0.95);
    for (let k = 0; k < n; k++) {
      const x = -f.len / 2 + 0.3 + (f.len - 0.6) * (k + 0.5) / n;
      if (side === 'front' && Math.abs(x) < cw + 0.3) continue;
      const out = 0.45 + R() * 0.25;
      K.cyl(vm, [x, H - 0.28, -0.25], [x + (R() - 0.5) * 0.06, H - 0.28 + (R() - 0.5) * 0.06, out], 0.11, 0.1, { sides: 7 });
    }
  });
  c.signZ = oz + 0.1;
  c.apex = top;
  if (b.kind === 'casino') {
    // a big mud dome with a brass spire
    const r = Math.min(ox, oz) * 0.42;
    K.add(am, new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), { uv: 'keep', uvScale: [4, 1.5], at: matrix(0, H + 0.2, -oz * 0.25) });
    K.cyl(am, [0, H + 0.1, -oz * 0.25], [0, H + 0.6, -oz * 0.25], r + 0.15, r + 0.1, { sides: 16 });
    K.cyl(mat('brass'), [0, H + 0.2 + r - 0.1, -oz * 0.25], [0, H + 0.2 + r + 1.6, -oz * 0.25], 0.12, 0.03, { sides: 8 });
    K.add(mat('brass'), new THREE.SphereGeometry(0.22, 10, 8), { uv: 'keep', at: matrix(0, H + r + 0.7, -oz * 0.25) });
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; K.cyl(mat('brass'), [Math.cos(a) * (r + 0.02), H + 0.6, -oz * 0.25 + Math.sin(a) * (r + 0.02)], [Math.cos(a) * 0.15, H + 0.2 + r, -oz * 0.25 + Math.sin(a) * 0.15], 0.04, 0.04, { sides: 5 }); }
  }
}

// ---- dressing ------------------------------------------------------------------------------------

// a lantern hanging (or standing) at p in the building frame; size ~ s; adds a glow point
export function lantern(c, p, s = 0.5, hanging = false, K = c.K) {
  const [x, y, z] = p;
  const im = mat('iron_wrought'), gm = glassMat();
  const w = s * 0.42, h = s * 0.6;
  K.box(gm, w, h, w, x, y, z, { uv: 'keep', shade: false, seg: [1, 1, 1], cast: false });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(im, 0.03, h + 0.04, 0.03, x + sx * w / 2, y, z + sz * w / 2, { tile: 0.5 });
  K.box(im, w + 0.08, 0.05, w + 0.08, x, y - h / 2 - 0.02, z, { tile: 0.5 });
  K.add(im, new THREE.ConeGeometry(w * 0.85, s * 0.32, 4), { uv: 'keep', at: matrix(x, y + h / 2 + s * 0.16, z, Math.PI / 4) });
  K.add(im, new THREE.TorusGeometry(0.05, 0.015, 4, 8), { uv: 'keep', at: matrix(x, y + h / 2 + s * 0.36, z) });
  if (hanging) K.box(im, 0.02, 0.3, 0.02, x, y + h / 2 + s * 0.5, z, { tile: 0.5 });
  const wp = new THREE.Vector3(x, y, z).applyMatrix4(K.m).applyMatrix4(K.root);
  if (c && c.glows) c.glows.push({ p: wp, s: s * 3.2 });
  return wp;
}

// a few tongues of flame (emissive) over a fire bowl
export function flames(K, x, y, z, r) {
  const fm = mat('lantern_glass', { emissive: '#ff9a40', emissiveIntensity: 1.2 });
  const offs = [[0, 0, 1], [0.45, 0.2, 0.7], [-0.4, 0.3, 0.75], [0.1, -0.45, 0.65], [-0.2, -0.2, 0.55]];
  offs.forEach(([dx, dz, k], i) => {
    const h = r * 2.2 * k;
    K.add(fm, new THREE.ConeGeometry(r * 0.38 * (0.7 + k * 0.4), h, 6), { uv: 'keep', at: matrix(x + dx * r, y + h / 2, z + dz * r, i, (dx) * 0.25, -(dz) * 0.25), shade: false, cast: false, tint: i ? '#ffd8a0' : '#fff0c8' });
  });
}

// a barrel at (x, z) in the building frame, standing on y = 0
export function barrel(K, x, z, r = 0.32, h = 0.9, y = 0) {
  const g = new THREE.CylinderGeometry(r, r, h, 12, 4, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const t = p.getY(i) / h + 0.5; const k = 1 + 0.12 * Math.sin(Math.PI * t); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); }
  g.computeVertexNormals();
  K.add(mat('barrel'), g, { uv: 'keep', at: matrix(x, y + h / 2, z, x * 3.1) });
  K.add(mat('wood_light'), new THREE.CircleGeometry(r * 1.02, 12), { uv: 'keep', at: matrix(x, y + h - 0.02, z, 0, -Math.PI / 2), tint: '#c8a888' });
}
export function crate(K, x, z, s = 0.7, ry = 0, y = 0) {
  K.add(mat('crate'), new THREE.BoxGeometry(s, s, s), { uv: 'keep', at: matrix(x, y + s / 2, z, ry) });
}

function extras(c) {
  const { K, S, b, ox, oz, dw, dh, H, R } = c;
  // a lantern on an iron bracket beside the door
  onWall(c, 'front', () => {
    const lx = -(dw + 0.75);
    const y = Math.min(dh + 0.1, 2.75);
    K.box(mat('iron_wrought'), 0.05, 0.05, 0.62, lx, y + 0.52, 0.3, { tile: 0.5 });
    K.beam(mat('iron_wrought'), [lx, y + 0.1, 0.02], [lx, y + 0.5, 0.5], 0.035, 0.035);
    lantern(c, [lx, y + 0.12, 0.56], 0.5, true);
    if (b.kind === 'casino') {
      const rx = dw + 0.75;
      K.box(mat('iron_wrought'), 0.05, 0.05, 0.62, rx, y + 0.52, 0.3, { tile: 0.5 });
      K.beam(mat('iron_wrought'), [rx, y + 0.1, 0.02], [rx, y + 0.5, 0.5], 0.035, 0.035);
      lantern(c, [rx, y + 0.12, 0.56], 0.5, true);
    }
  });
  // casino: red-and-gold banners on the facade
  if (b.kind === 'casino') {
    onWall(c, 'front', () => {
      for (const s of [-1, 1]) for (const k of [0, 1]) {
        const x = s * (dw + 2.3 + k * 3.6);
        if (Math.abs(x) > c.ox - 0.8) continue;
        K.quad(bannerMat(), 1.0, 2.1, x, H - 1.35, 0.1, { shade: false });
        K.cyl(mat('brass'), [x - 0.62, H - 0.28, 0.12], [x + 0.62, H - 0.28, 0.12], 0.035, 0.035, { sides: 6 });
      }
    });
  }
  // pawnbroker's three golden balls on a bracket
  if (b.kind === 'pawn') {
    onWall(c, 'front', () => {
      const x = dw + 1.5 + c.leafW * 0.0, y = Math.min(H - 0.5, 3.0);
      K.box(mat('iron_wrought'), 0.06, 0.06, 1.1, x, y, 0.55, { tile: 0.5 });
      K.beam(mat('iron_wrought'), [x, y - 0.5, 0.02], [x, y - 0.02, 0.6], 0.04, 0.04);
      const bm = mat('brass');
      for (const [dx, dy] of [[-0.2, -0.45], [0.2, -0.45], [0, -0.8]]) {
        K.box(mat('iron_wrought'), 0.015, 0.4, 0.015, x + dx * 0.5, y - 0.2, 1.0, { tile: 0.5 });
        K.add(bm, new THREE.SphereGeometry(0.15, 12, 8), { uv: 'keep', at: matrix(x + dx, y + dy, 1.0) });
      }
    });
  }
  // style props hugging the walls
  const nm = S.name;
  if (nm === 'timber' || nm === 'farm' || nm === 'frontier') {
    onWall(c, 'front', () => {
      const x = -(c.ox - 0.55);
      barrel(K, x, 0.45); if (R() < 0.7) barrel(K, x + 0.7, 0.4, 0.28, 0.8);
      crate(K, x + 0.1, 1.1, 0.62, 0.3);
    });
  }
  if (nm === 'farm') {
    onWall(c, 'left', () => {
      // a wagon wheel leaning on the wall and a hay heap
      const g = new THREE.TorusGeometry(0.62, 0.06, 6, 18);
      K.add(mat('wood_light'), g, { uv: 'keep', uvScale: [6, 1], at: matrix(0.6, 0.66, 0.12, 0, -0.18) });
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI; K.push(0.6, 0.66, 0.12, 0, -0.18); K.beam(mat('wood_light'), [Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0], [-Math.cos(a) * 0.6, -Math.sin(a) * 0.6, 0], 0.05, 0.05); K.pop(); }
      K.add(mat('wood_light'), new THREE.CylinderGeometry(0.12, 0.12, 0.2, 8), { uv: 'keep', at: matrix(0.6, 0.66, 0.12, 0, Math.PI / 2 - 0.18) });
      const hay = new THREE.SphereGeometry(0.9, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      K.add(mat('thatch'), hay, { uv: 'keep', uvScale: [3, 1], at: matrix(-1.6, 0, 0.6, 0, 0, 0, new THREE.Vector3(1.3, 0.8, 0.8)) });
    });
  }
  if (nm === 'alpine') {
    // iron braziers flanking the door
    onWall(c, 'front', () => {
      for (const s of [-1, 1]) {
        const x = s * (dw + 0.95), z = 0.55, im = mat('iron_wrought');
        for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2; K.beam(im, [x + Math.cos(a) * 0.32, 0, z + Math.sin(a) * 0.32], [x + Math.cos(a) * 0.12, 0.85, z + Math.sin(a) * 0.12], 0.05, 0.05); }
        K.add(im, new THREE.CylinderGeometry(0.42, 0.22, 0.32, 10, 1, true), { uv: 'keep', uvScale: [4, 1], at: matrix(x, 1.0, z), receive: true });
        K.add(mat('embers', { emissive: '#ff8030', emissiveIntensity: 1.0 }), new THREE.SphereGeometry(0.36, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, 1.03, z, 0, 0, 0, new THREE.Vector3(1, 0.35, 1)), shade: false, cast: false });
        flames(K, x, 1.05, z, 0.32);
        c.glows.push({ p: c.world(...new THREE.Vector3(x, 1.4, z).applyMatrix4(K.m).toArray()), s: 2.6, fire: true });
      }
    });
  }
  if (nm === 'frontier') {
    // palisade stakes along the back and a stretched hide on a frame
    onWall(c, 'back', f => {
      for (let x = -f.len / 2 + 0.2; x < f.len / 2 - 0.1; x += 0.34 + R() * 0.06) {
        const h = 2.3 + R() * 1.1, lean = (R() - 0.5) * 0.08;
        K.cyl(mat('wood_light'), [x, -0.2, 0.32], [x + lean, h, 0.32 + 0.12], 0.13, 0.12, { sides: 7, tint: '#a88660' });
        K.add(mat('wood_light'), new THREE.ConeGeometry(0.12, 0.4, 7), { uv: 'keep', at: matrix(x + lean, h + 0.2, 0.44, 0, 0.05), tint: '#c8a478' });
      }
      K.box(mat(S.beam), f.len, 0.14, 0.14, 0, 1.6, 0.5, { grain: 'x', tile: 1.2 });
    });
    onWall(c, 'left', () => {
      const x = 0.4;
      K.beam(mat('wood_light'), [x - 0.9, 0, 0.5], [x - 0.75, 2.4, 0.15], 0.1, 0.1);
      K.beam(mat('wood_light'), [x + 0.9, 0, 0.5], [x + 0.75, 2.4, 0.15], 0.1, 0.1);
      K.beam(mat('wood_light'), [x - 0.95, 2.2, 0.17], [x + 0.95, 2.2, 0.17], 0.08, 0.08);
      K.beam(mat('wood_light'), [x - 0.95, 0.5, 0.45], [x + 0.95, 0.5, 0.45], 0.08, 0.08);
      K.push(x, 1.35, 0.32, 0, -0.18); K.quad(mat('hide_patch', { side: THREE.DoubleSide }), 1.5, 1.5, 0, 0, 0, { uv: 'keep', uvScale: [0.5, 0.5] }); K.pop();
    });
  }
  if (nm === 'alpine') {
    // a firewood stack against the side wall, snow on top
    onWall(c, 'left', () => {
      const lm = mat('wood_light'), x0 = -0.6;
      for (let row = 0; row < 4; row++) for (let k = 0; k < 7 - row; k++) {
        const x = x0 + (k - (6 - row) / 2) * 0.27, y = 0.14 + row * 0.24;
        K.cyl(lm, [x, y, 0.08], [x + (R() - 0.5) * 0.04, y, 0.95], 0.13, 0.13, { sides: 7, tint: '#b89068' });
        K.add(mat('wood_light'), new THREE.CircleGeometry(0.125, 7), { uv: 'keep', at: matrix(x, y, 0.955), tint: '#e0c090' });
      }
      K.box(mat('snow_roof'), 1.5, 0.12, 0.95, x0, 1.12, 0.5, { tile: 2, seg: [3, 1, 2], warp: v => { v.y += 0.05 * Math.sin(v.x * 5) - Math.abs(v.x) * 0.08; } });
    });
  }
  if (nm === 'adobe') {
    // a pueblo ladder up to the roof and clay pots by the door
    onWall(c, 'right', () => {
      const ts = c.wins.filter(w => w.side === 'right').map(w => w.t).sort((a, b) => a - b);
      const lm = mat(S.beam), x = ts.length > 1 ? (ts[0] + ts[1]) / 2 : ts.length ? ts[0] + (ts[0] > 0 ? -1.5 : 1.5) : 0.6;
      for (const s of [-1, 1]) K.beam(lm, [x + s * 0.28, 0, 0.75], [x + s * 0.28, H + 1.1, 0.1], 0.08, 0.08);
      for (let k = 0; k < Math.floor((H + 0.9) / 0.42); k++) { const t = (k + 0.6) * 0.42 / (H + 1.1); K.box(lm, 0.62, 0.06, 0.06, x, t * (H + 1.1), 0.75 - t * 0.65, { grain: 'x', tile: 1.2 }); }
    });
    onWall(c, 'front', () => {
      const pts = [[0, 0], [0.16, 0.02], [0.24, 0.18], [0.22, 0.38], [0.11, 0.52], [0.12, 0.6], [0, 0.6]].map(([r, y]) => new THREE.Vector2(r, y));
      for (const [x, z, k] of [[c.dw + 0.65, 0.35, 1], [c.dw + 1.05, 0.5, 0.8], [-(c.dw + 0.7), 0.4, 1.1]]) {
        const g = new THREE.LatheGeometry(pts, 10);
        K.add(mat('adobe'), g, { uv: 'keep', uvScale: [1, 0.5], at: matrix(x, 0, z, x * 2, 0, 0, k), tint: '#c88a60' });
      }
    });
  }
  if (nm === 'adobe' && S.pipes) {
    // goblin brass plumbing up a corner and over the parapet
    const bm = mat('brass');
    const x = c.ox + 0.12, z = -c.oz + 0.5;
    K.cyl(bm, [x, 0, z], [x, H + 0.9, z], 0.08, 0.08, { sides: 8 });
    K.cyl(bm, [x, H + 0.9, z], [x - 0.6, H + 0.9, z], 0.08, 0.08, { sides: 8 });
    for (let y = 0.6; y < H + 0.8; y += 0.9) K.add(bm, new THREE.TorusGeometry(0.1, 0.03, 5, 10), { uv: 'keep', at: matrix(x, y, z, 0, Math.PI / 2) });
    K.add(mat('metal_red'), new THREE.BoxGeometry(0.5, 0.6, 0.4), { uv: 'keep', at: matrix(x + 0.12, 1.0, z + 0.5) });
    K.add(bm, new THREE.CylinderGeometry(0.16, 0.16, 0.06, 12), { uv: 'keep', at: matrix(x + 0.38, 1.1, z + 0.5, 0, 0, Math.PI / 2) });
    if (S.awning) onWall(c, 'front', () => awning(c, 0, c.dh + 0.55, 2 * dw + 1.4, 1.5));
  }
}
