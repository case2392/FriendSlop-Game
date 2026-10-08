// Buildings, drawn from their records in W.buildings (shared/world.js building()):
//   b = { id, kind, x, y, z, ry, w, dep, h, door, style }
// Colliders: floor slab top at y + 0.1; walls 0.3 m thick centered on x = ±w/2 and z = ±dep/2;
// a door gap b.door wide at local x = 0 in the front wall (+z), under a lintel from h - 0.8 to h;
// a flat roof slab at y + h + 0.1. Walls, door gap and floor here sit exactly on those; upper
// storeys, roofs, eaves, gables, false fronts, chimneys, beams and foundations all go outside that
// volume (above the roof slab or outside the walls).
//
// One generator, five styles (one per day, docs/ART.md):
//   timber   Goldshire: cream plaster in planned half-timbering (studs, braces only at the corners and
//            beside the door), soft grime where the plaster meets the beams, a jettied upper storey,
//            steep red shingle roofs (the hall's as tall as its walls) with a front cross gable, a dormer,
//            chimneys and a bell cupola, stone plinth, flower boxes
//   farm     Westfall: weathered boards, thick thatch with a rolled eave and a straw fringe (houses), a
//            faded oxblood gambrel barn on a stone plinth with its frame showing (casino, gas), hay
//   alpine   Kharanos: squat granite halls, heavy timber, roofs coming down low over the walls under
//            thick lumpy snow, stone gable ends, round stone door arches, iron emblems, braziers
//   frontier canyon outpost: log walls, ragged board false fronts, dark hide shed roofs on poles,
//            porches on crooked posts lashed with rope, tusk gateways, hide banners on tall poles,
//            spiked barricades; the casino is a two-storey hall with wings
//   adobe    Gadgetzan: terracotta adobe with a mud splash band, lumpy parapets, stacked blocks, a
//            turret with a riveted spiked cap, vigas with lit end grain, big awnings on poles, goblin
//            tanks, pipes, riveted plates and gears
// Interiors are dressed per style too (floors, ceilings, hearths, rugs, shelves of goods drawn from a
// per-style pool, wall trophies, the casino hall), then relit: soft dark corners and junctions, warm
// pools round every lamp and fire, cooler light by the windows.
import { THREE } from './gfx.js';
import { Kit, mat, matrix, rng, sstep, gridGeo } from './town_kit.js';
import { LOG_ROWS, HOLE_CELLS } from './paint/architecture.js';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
// a deterministic 0..1 hash of a few numbers
const hsh = (x, y = 0, z = 0) => { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s); };

export const STYLES = {
  timber: {
    wall: 'plaster_cream', wallTile: 3.2, base: 'stone_found', baseTile: 2.2, baseH: 0.62, beam: 'timber_dark',
    roof: 'shingles_red', roofTile: 2.6, layout: 'gable', pitch: 46, maxRise: 5, eave: 0.6, gableOH: 0.5, thick: 0.22, barge: true,
    floor: 'floor_planks', inner: 'plaster_inner', wainscot: true, halfTimber: true, gableFill: 'plaster_cream', holes: 'plaster',
    chimney: 'stone_found', win: 'flower', winW: 0.95, winH: 1.3, winY: 1.05, lamp: 'lantern', ridge: 'tile', moss: true,
    upper: { h: 1.7, out: 0.34 }, dormer: true, banner: 'banner_red',
    hall: { maxRise: 9.5, thick: 0.3, chimneys: 2, cupola: true },
    int: {
      ceil: 'planks', hearth: 'stone', rug: 'rug_red', walls: ['shield', 'herbs', 'tapestry', 'pans'],
      shelf: { frame: 'oak', back: 'floor_planks', backTint: '#7a5e4c', wood: 'wood_light', woodTint: '#d8a878' },
      pool: { pawn: ['books', 'goblet', 'lute', 'helm', 'vase', 'crt', 'chest', 'candles', 'lamp', 'vase', 'books'], store: ['jar', 'sack', 'cheese', 'potion', 'bread', 'coil', 'candles', 'jar', 'potion'] },
      casino: { floor: 'carpet', rugs: [], chandelier: 'ring' },
    },
  },
  farm: {
    wall: 'planks_weathered', wallTile: 3, base: 'stone_found', baseTile: 2.2, baseH: 0.36, beam: 'timber_dark',
    roof: 'thatch', roofTile: 2.4, layout: 'gable', pitch: 50, maxRise: 5.2, eave: 0.6, gableOH: 0.55, thick: 0.45, barge: false,
    floor: 'floor_planks', inner: 'planks_weathered', gableFill: 'planks_weathered', cornerBoards: true,
    chimney: 'stone_found', win: 'shutter', shutter: 'planks_barnred', winW: 0.9, winH: 1.2, winY: 1.05, lamp: 'post', ridge: 'thatch', moss: true, banner: null,
    int: {
      ceil: 'joists', rug: 'rug_braid', walls: ['tools', 'herbs', 'shoes', 'pans'], hay: true,
      shelf: { frame: 'plank', back: 'planks_weathered', backTint: '#9a8470', wood: 'timber_dark' },
      pool: { pawn: ['jar', 'pumpkin', 'tool', 'crt', 'lamp', 'chest', 'sack', 'jar', 'shoe', 'pumpkin'], store: ['jar', 'pumpkin', 'sack', 'bread', 'cheese', 'coil', 'tool', 'jar'] },
      casino: { floor: 'planks', rugs: [['rug_braid', 4]], chandelier: 'wheel', hay: true },
    },
    barn: {
      kinds: ['casino', 'gas'], wall: 'planks_barnred', roof: 'shingles_wood', layout: 'gambrel', thick: 0.3, eave: 0.7, barge: true, gableFill: 'planks_barnred', ridge: 'tile', chimney: null,
      trim: 'wood_white', trimTint: '#a89884', cornerMat: 'wood_white', cornerTint: '#a89884', baseH: 0.7, barnFrame: true, extraWins: 2, roofTile: 2.2, win: 'barn',
    },
  },
  alpine: {
    wall: 'granite_block', wallTile: 3.4, base: 'granite_block', baseTile: 2.4, baseH: 0.75, baseTint: '#ccc6bc', beam: 'timber_dark',
    roof: 'slate_roof', roofTile: 2.6, layout: 'gable', pitch: 46, maxRise: 5.2, eave: 1.25, crossEave: 0.55, gableOH: 0.75, thick: 0.3, barge: true, crossCut: true, lowEaves: true,
    floor: 'flagstone', inner: 'granite_inner', gableFill: 'planks_weathered', gableTint: '#8a7464', gableStone: true, snow: true, quoins: true,
    chimney: 'granite_block', win: 'stone', winW: 0.8, winH: 1.0, winY: 1.2, lamp: 'brazier', ridge: 'snow', topBeams: true, emblem: true, arch: true,
    banner: 'banner_dwarf',
    int: {
      ceil: 'heavy', hearth: 'big', rug: 'rug_bear', walls: ['axes', 'ram', 'banner', 'pans'],
      shelf: { frame: 'dark', back: 'granite_inner', backTint: '#a8a29a', wood: 'timber_dark' },
      pool: { pawn: ['stein', 'axe', 'ore', 'dwarfhelm', 'crt', 'chest', 'ingots', 'goblet', 'stein', 'ore'], store: ['stein', 'ore', 'ingots', 'jar', 'sack', 'bread', 'cheese', 'stein'] },
      casino: { floor: 'stone', rugs: [['rug_bear', 2]], chandelier: 'brazier', forge: true },
    },
  },
  frontier: {
    wall: 'log_wall', wallTile: 3, base: null, beam: 'timber_dark', gableFill: 'planks_rough',
    roof: 'hide_patch', roofTile: 4.2, layout: 'frontier', pitch: 19, thick: 0.25,
    floor: 'floor_planks', inner: 'log_wall', logEnds: true,
    win: 'shutter', shutter: 'planks_rough', winW: 0.9, winH: 1.1, winY: 1.1, lamp: 'torch', banner: 'banner_hide',
    int: {
      ceil: 'hide', rug: 'rug_hide', walls: ['antlers', 'hide', 'bow', 'tusks'],
      shelf: { frame: 'poles', back: null, wood: 'board_rough' },
      pool: { pawn: ['skull', 'trap', 'bottle', 'rolledhide', 'crt', 'axe', 'chest', 'bottle', 'skull'], store: ['bottle', 'rolledhide', 'sack', 'coil', 'jar', 'skull', 'trap', 'bottle'] },
      casino: { floor: 'planks', rugs: [['rug_hide', 4]], chandelier: 'antler' },
    },
    saloon: { kinds: ['casino', 'gas'], wall: 'planks_rough', inner: 'planks_rough', logEnds: false },
  },
  adobe: {
    wall: 'adobe', wallTile: 3.2, base: null, beam: 'timber_dark', trim: 'brass', layout: 'flat', round: true, splash: [0.72, 0.64, 0.56], holes: 'adobe',
    floor: 'flagstone', inner: 'adobe_inner', wainscot: false, awnings: ['canvas_stripe', 'canvas_teal', 'canvas_mustard'],
    win: 'port', winW: 0.85, winH: 0.85, winY: 1.45, lamp: 'goblin', pipes: true, banner: 'banner_goblin',
    int: {
      ceil: 'vigas', kiva: true, rug: 'rug_desert', walls: ['pots', 'gearwall', 'rughang', 'pans'],
      shelf: { frame: 'niche' },
      pool: { pawn: ['gear', 'gadget', 'pot', 'rolledrug', 'crt', 'chest', 'lamp', 'gear', 'pot'], store: ['pot', 'jar', 'gadget', 'potion', 'sack', 'rolledrug', 'pot', 'jar'] },
      casino: { floor: 'tile', rugs: [['rug_desert', 2]], chandelier: 'goblin' },
    },
  },
};

export function styleFor(b) {
  const S0 = STYLES[b.style] || STYLES.timber;
  const v = S0.barn && S0.barn.kinds.includes(b.kind) ? S0.barn : S0.saloon && S0.saloon.kinds.includes(b.kind) ? S0.saloon : null;
  const hall = b.kind === 'casino' && S0.hall ? S0.hall : null;
  return { ...S0, ...(v || {}), ...(hall || {}), name: b.style };
}

// emissive materials whose glow follows the night (town3d.js update)
export const winMat = () => mat('window_lead', { emissive: '#ffc070', emissiveIntensity: 0.35 });
export const glassMat = () => mat('lantern_glass', { emissive: '#ffb050', emissiveIntensity: 0.9 });
const flowerMat = () => mat('flowerbox', { alphaTest: 0.5, side: THREE.DoubleSide });
export const bannerMat = name => mat(name || 'banner_red', { alphaTest: 0.5, side: THREE.DoubleSide });
const fireMat = () => glassMat();
const emberMat = () => mat('embers', { emissive: '#ff8030', emissiveIntensity: 1.0 });
function holeMat() {
  const m = mat('wall_holes', { transparent: true });
  m.depthWrite = false; m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  return m;
}

// vertex shading in a building's frame: grime near the ground (a darker mud splash band on adobe), shade
// under the eaves (warm on plaster) and under a jetty, darker undersides, darker parapet tops under the
// mud caps, soft ochre/rose clouds over adobe walls, and dim interiors (relit later)
function shader(b, S, RH) {
  const ix = b.w / 2 - 0.15, iz = b.dep / 2 - 0.15, H = b.h, sp = S.splash, adobe = !!S.round, timber = S.name === 'timber';
  return (x, y, z, nx, ny, nz) => {
    if (Math.abs(x) < ix - 0.002 && Math.abs(z) < iz - 0.002 && y < H - 0.001 && y > 0.05) {
      const k = 0.78 + 0.14 * sstep(0.1, H, y) - (ny < -0.5 ? 0.08 : 0);
      return [k, k * 0.95, k * 0.88];
    }
    let k = 0.62 + 0.38 * sstep(-0.3, 1.6, y);
    // a soft, uneven wash so long walls aren't one flat value
    k *= 0.95 + 0.05 * Math.sin(x * 0.83 + z * 0.61 + 1.3) * Math.sin(y * 0.9 + x * 0.27);
    let hue = 0;
    if (adobe) { k *= 1 + 0.08 * Math.sin(x * 0.37 + z * 0.29 + 0.7) * Math.sin(y * 0.45 + x * 0.13 - z * 0.21); hue = 0.05 * Math.sin(x * 0.23 - z * 0.31 + y * 0.2); }
    if (ny < -0.5) k *= 0.62;
    else if (Math.abs(ny) < 0.5) {
      if (!adobe && y < RH + 0.05) k *= 1 - 0.2 * sstep(RH - 1.1, RH, y);
      if (RH > H + 0.5 && y < H + 0.02) k *= 1 - 0.16 * sstep(H - 1.0, H, y);
      if (adobe && y > H - 0.01) k *= 1 - 0.1 * sstep(H, H + 0.7, y);
    }
    let r = k * (1 + hue), g = k * 0.98, bl = k * 0.95 * (1 - hue);
    if (timber && Math.abs(ny) < 0.5 && y > RH - 1.2 && y < RH + 0.05) { const t = sstep(RH - 1.2, RH, y); g *= 1 - 0.02 * t; bl *= 1 - 0.08 * t; }
    if (sp && y < 1.2) { const t = 1 - sstep(0.45, 0.95, y); r *= 1 - (1 - sp[0]) * t; g *= 1 - (1 - sp[1]) * t; bl *= 1 - (1 - sp[2]) * t; }
    return [r, g, bl];
  };
}

// ---- the generator ---------------------------------------------------------------------------

export function buildBuilding(batch, b, sign = null) {
  const S = styleFor(b);
  const up = S.upper ? { ...S.upper, h: S.upper.h * (b.h > 4.5 ? 1.12 : 1) } : null;
  const RH = b.h + (up ? up.h : 0);
  const K = new Kit(batch, matrix(b.x, b.y, b.z, b.ry), shader(b, S, RH));
  K.seed = 1 + b.id * 977;
  K.styleName = S.name;
  K.log = [];
  const R = rng(b.id * 31 + 7);
  const W = b.w, D = b.dep, H = b.h, dw = b.door / 2;
  const c = {
    K, S, b, R, W, D, H, dw, ox: W / 2 + 0.15, oz: D / 2 + 0.15, ix: W / 2 - 0.15, iz: D / 2 - 0.15, dh: H - 0.8,
    sign, glows: [], tall: H > 4.5, signZ: D / 2 + 0.3, up, RH,
  };
  c.Rox = c.ox + (up ? up.out : 0); c.Roz = c.oz + (up ? up.out : 0);
  c.ww = S.winW * (c.tall ? 1.15 : 1); c.wh = S.winH * (c.tall ? 1.45 : 1); c.winY = S.winY * (c.tall ? 1.2 : 1);
  if (S.layout === 'frontier' && b.kind === 'casino') c.leafMax = 3.2;
  c.world = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(K.root);
  c.wp = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(K.m).applyMatrix4(K.root);
  doorway(c); planWindows(c); walls(c); base(c); interior(c);
  for (const w of c.wins) onWall(c, w.side, () => windowAt(c, w.t, w.side));
  framing(c);
  if (up) upperStorey(c);
  if (S.layout === 'frontier') frontierRoof(c);
  else if (S.layout === 'flat') flatRoof(c);
  else pitchedRoof(c);
  extras(c);
  dress(c);
  relight(c);
  K.log = null;
  return { signZ: c.signZ, glows: c.glows, style: S, frame: K.root, apex: c.apex };
}

const FRAMES = (X, Z) => ({
  front: { at: [0, 0, Z], ry: 0, len: 2 * X },
  back: { at: [0, 0, -Z], ry: Math.PI, len: 2 * X },
  right: { at: [X, 0, 0], ry: Math.PI / 2, len: 2 * Z },
  left: { at: [-X, 0, 0], ry: -Math.PI / 2, len: 2 * Z },
});
// run fn in a wall's frame: its outer face is z = 0 facing +z, x runs to the right as seen from outside
function onWall(c, side, fn, X = c.ox, Z = c.oz) { const f = FRAMES(X, Z)[side]; c.K.push(f.at[0], 0, f.at[2], f.ry); fn(f); c.K.pop(); }
// the inner face of a wall at t (the same t as onWall), facing into the room (local +z)
function onInner(c, side, t, fn) {
  const { ix, iz } = c;
  const q = { front: [t, iz, Math.PI], back: [-t, -iz, 0], right: [ix, -t, -Math.PI / 2], left: [-ix, t, Math.PI / 2] }[side];
  c.K.push(q[0], 0, q[1], q[2]); fn(); c.K.pop();
}
// a stretch of wall w wide, clear of windows (and the door) and of `taken` spans, as near t0 as possible
function freeSpot(c, side, w, t0 = 0, taken = []) {
  const len = side === 'front' || side === 'back' ? 2 * c.ix : 2 * c.iz;
  const busy = c.wins.filter(x => x.side === side).map(x => [x.t - c.ww / 2 - 0.12, x.t + c.ww / 2 + 0.12]).concat(taken);
  if (side === 'front') busy.push([-c.dw - 0.4, c.dw + 0.4]);
  for (let k = 0; k < 80; k++) {
    const t = t0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.2;
    if (Math.abs(t) + w / 2 > len / 2 - 0.3) continue;
    if (busy.every(([a, bb]) => t + w / 2 < a || t - w / 2 > bb)) return t;
  }
  return null;
}

// ---- shell -------------------------------------------------------------------------------------

function walls(c) {
  const { K, S, H, ix, iz, dw, D, W, R } = c;
  const m = mat(S.wall), ny = Math.max(2, Math.ceil(H / 0.6)), sg = L => Math.max(1, Math.ceil(L / 1.6));
  // log walls keep v aligned so the 3D log ends match the painted courses
  const o = { uvSpace: 'kit', tile: S.wallTile, uvOff: [R(), S.logEnds ? 0 : R()], tint: S.wallTint };
  c.wallO = o;
  // plastered (half-timbered) walls get their outer face as a separate shaded grid (plasterFace), so the
  // body stops 8 mm short of the collider's outer face
  const face = !!S.halfTimber, e = face ? 0.008 : 0, th = 0.3 - e;
  const sl = S.round ? 2 * iz : D + 0.3 - 2 * e;
  K.box(m, 2 * ix, H, th, 0, H / 2, -D / 2 + e / 2, { ...o, seg: [sg(W), ny, 1] });
  K.box(m, th, H, sl, -W / 2 + e / 2, H / 2, 0, { ...o, seg: [1, ny, sg(D)] });
  K.box(m, th, H, sl, W / 2 - e / 2, H / 2, 0, { ...o, seg: [1, ny, sg(D)] });
  const segW = ix - dw;
  K.box(m, segW, H, th, -(dw + segW / 2), H / 2, D / 2 - e / 2, { ...o, seg: [sg(segW), ny, 1] });
  K.box(m, segW, H, th, dw + segW / 2, H / 2, D / 2 - e / 2, { ...o, seg: [sg(segW), ny, 1] });
  K.box(m, 2 * dw, 0.8, th, 0, H - 0.4, D / 2 - e / 2, { ...o, seg: [1, 2, 1] });
  // adobe: the corners are rounded (a quarter round exactly filling the collider's corner)
  if (S.round) for (const sx of [-1, 1]) for (const sz of [-1, 1]) quarter(c, m, sx, sz, 0, H, 0.3, o);
  if (face) {
    c.plans = {};
    const by = S.baseH || 0;
    for (const side of ['front', 'back', 'left', 'right']) onWall(c, side, f => {
      const ops = c.wins.filter(w => w.side === side).map(w => ({ a: w.t - c.ww / 2 - 0.15, b: w.t + c.ww / 2 + 0.15, top: c.winY + c.wh + 0.12, bot: c.winY - 0.12 }));
      if (side === 'front') ops.push({ a: -dw - 0.22, b: dw + 0.22, top: c.dh + 0.28, bot: 0, door: true });
      const plan = timberPlan(c, f.len, { y0: by, y1: H, rail: c.winY + c.wh + 0.12 + 0.125, ops });
      c.plans[side] = plan;
      plasterFace(c, m, f.len, by - 0.06, H, plan, side === 'front' ? { x0: -dw, x1: dw, y1: c.dh } : null, o);
      holes(c, plan.panels, Math.floor(R() * 3.2), S.holes);
    });
  } else if (S.holes) {
    // adobe: holes anywhere clear of the windows and the door
    for (const side of ['front', 'back', 'left', 'right']) onWall(c, side, f => {
      const busy = c.wins.filter(w => w.side === side).map(w => [w.t - c.ww / 2 - 0.5, w.t + c.ww / 2 + 0.5]);
      if (side === 'front') busy.push([-dw - 1.2, dw + 1.2]);
      const panels = [];
      for (let x = -f.len / 2 + 0.7; x < f.len / 2 - 1.6; x += 1.4) if (busy.every(([a, bb]) => x + 1.3 < a || x > bb)) panels.push({ x0: x, x1: x + 1.3, y0: 1.0, y1: Math.min(H - 0.5, 2.6) });
      holes(c, panels, Math.floor(R() * 2.6), S.holes);
    });
  }
}
function quarter(c, m, sx, sz, y0, y1, r, o, cx = c.ix, cz = c.iz) {
  const th0 = sx > 0 ? (sz > 0 ? 0 : Math.PI / 2) : (sz > 0 ? 1.5 * Math.PI : Math.PI);
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, 4, Math.max(1, Math.ceil((y1 - y0) / 0.7)), false, th0, Math.PI / 2);
  c.K.add(m, g, { ...o, at: matrix(sx * cx, (y0 + y1) / 2, sz * cz) });
}
// a box with rounded vertical edges (two boxes and four posts), standing on y
function roundedBox(c, m, x, y, z, w, h, d, r, o = {}) {
  const K = c.K, ny = Math.max(1, Math.ceil(h / 0.7));
  K.box(m, w - 2 * r, h, d, x, y + h / 2, z, { ...o, seg: [Math.max(1, Math.ceil(w / 1.6)), ny, 1] });
  K.box(m, w, h - 0.006, d - 2 * r, x, y + (h - 0.006) / 2, z, { ...o, seg: [1, ny, Math.max(1, Math.ceil(d / 1.6))] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.add(m, new THREE.CylinderGeometry(r, r, h - 0.004, 10, ny), { ...o, at: matrix(x + sx * (w / 2 - r), y + (h - 0.004) / 2, z + sz * (d / 2 - r)) });
}

// ---- half-timbering: plan, members, the plaster face and its holes --------------------------------

// Plan the half-timbering of one wall (wall frame: x along the wall, face at z = 0): a sill (broken at
// the door), the top plate, a rail at the window sills, posts at the ends and beside the openings, studs
// every 1.2-1.6 m, head beams over the openings, and braces only where a carpenter would put them: the
// end panels and the panels beside the door (and on a short wall now and then a chevron or a cross).
// Returns { members: [{ kind: 'h' | 'v' | 'd', a: [x, y], b: [x, y], w }], panels: [{ x0, x1, y0, y1 }] }.
function timberPlan(c, len, { y0, y1, rail = null, ops = [], mw = 0.25 }) {
  const R = c.R;
  const half = len / 2 - 0.24;
  const members = [], panels = [];
  const Hm = (x0, x1, y, w) => { if (x1 - x0 > 0.15) members.push({ kind: 'h', a: [x0, y], b: [x1, y], w }); };
  const Vm = (x, ya, yb, w) => { if (yb - ya > 0.15) members.push({ kind: 'v', a: [x, ya], b: [x, yb], w }); };
  const Dm = (xa, ya, xb, yb) => members.push({ kind: 'd', a: [xa, ya], b: [xb, yb], w: mw * 0.8 });
  const door = ops.find(o => o.door);
  const runs = door ? [[-half, door.a], [door.b, half]] : [[-half, half]];
  for (const [a, b] of runs) Hm(a, b, y0 + mw * 0.45, mw * 0.9);
  Hm(-half - 0.05, half + 0.05, y1 - mw / 2, mw);
  const bot0 = y0 + mw * 0.9, top0 = y1 - mw;
  if (rail !== null && !(rail - bot0 > 0.5 && top0 - rail > 0.55)) rail = null;
  if (rail !== null) for (const [a, b] of runs) Hm(a, b, rail, mw * 0.8);
  let xs = [-half + mw / 2, half - mw / 2];
  for (const o of ops) xs.push(o.a - mw / 2, o.b + mw / 2);
  xs = xs.filter(x => Math.abs(x) <= half).sort((a, b) => a - b);
  const posts = [];
  for (const x of xs) if (!posts.length || x - posts[posts.length - 1] > 0.45) posts.push(x);
  const top = y1 - mw, bot = y0 + mw * 0.9;
  for (const x of posts) Vm(x, bot, top, mw);
  const long = len > 10;
  const zones = rail !== null ? [[bot, rail - mw * 0.4], [rail + mw * 0.4, top]] : [[bot, top]];
  for (let i = 0; i < posts.length - 1; i++) {
    const a = posts[i] + mw / 2, b = posts[i + 1] - mw / 2, w = b - a;
    if (w < 0.3) continue;
    const mid = (a + b) / 2;
    const op = ops.find(o => mid > o.a && mid < o.b);
    if (op) {
      // over an opening: a head beam and a short stud; under a window: plain, a short stud if it's wide
      const hy = op.top + mw / 2;
      if (top - hy > 0.3) { Hm(a - mw / 2, b + mw / 2, hy, mw * 0.8); if (top - hy > 0.7 && w > 1.0) Vm(mid, hy + mw * 0.4, top, mw * 0.75); }
      if (!op.door) {
        if (rail === null && op.bot - bot > 0.4) Hm(a - mw / 2, b + mw / 2, op.bot - mw / 2, mw * 0.8);
        const yb = rail !== null ? rail - mw * 0.4 : op.bot - mw;
        if (yb - bot > 0.6 && w > 1.1) Vm(mid, bot, yb, mw * 0.7);
      }
      continue;
    }
    // a blank stretch: studs every ~1.35 m
    const n = Math.max(1, Math.round(w / 1.35));
    const studs = [a - mw / 2];
    for (let k = 1; k < n; k++) { const x = a + w * k / n + (R() - 0.5) * 0.12; Vm(x, bot, top, mw * 0.85); studs.push(x); }
    studs.push(b + mw / 2);
    const left = i === 0 || (door && Math.abs(posts[i] - (door.b + mw / 2)) < 0.05);
    const right = i === posts.length - 2 || (door && Math.abs(posts[i + 1] - (door.a - mw / 2)) < 0.05);
    const braced = new Set();
    const brace = (k, dir) => {
      const xa = studs[k] + mw * 0.45, xb = studs[k + 1] - mw * 0.45;
      if (xb - xa < 0.35 || braced.has(k)) return;
      const tall = zones.reduce((m, z) => (z[1] - z[0] > m[1] - m[0] ? z : m), zones[0]);
      const [za, zb] = tall;
      if (dir > 0) Dm(xa, za, xb, zb); else Dm(xb, za, xa, zb);
      braced.add(k);
    };
    if (left) brace(0, 1);
    if (right) brace(studs.length - 2, -1);
    if (!long && !left && !right && R() < 0.45 && studs.length > 2) {
      // a chevron in the tall zone of a middle panel
      const k = Math.floor(studs.length / 2) - 1, xa = studs[k] + mw * 0.45, xb = studs[k + 1] - mw * 0.45, [za, zb] = zones[0];
      if (xb - xa > 0.6 && zb - za > 0.8) { Dm(xa, za, (xa + xb) / 2, zb); Dm(xb, za, (xa + xb) / 2, zb); braced.add(k); }
    }
    for (let k = 0; k < studs.length - 1; k++) if (!braced.has(k)) for (const [za, zb] of zones) panels.push({ x0: studs[k] + mw * 0.45, x1: studs[k + 1] - mw * 0.45, y0: za, y1: zb });
  }
  return { members, panels };
}

// distance from (x, y) to a member's edge (0 inside it)
function memberDist(mb, x, y) {
  const [ax, ay] = mb.a, [bx, by] = mb.b;
  if (mb.kind !== 'd') {
    const cx = (ax + bx) / 2, cy = (ay + by) / 2, hx = Math.abs(bx - ax) / 2 + (mb.kind === 'v' ? mb.w / 2 : 0), hy = Math.abs(by - ay) / 2 + (mb.kind === 'h' ? mb.w / 2 : 0);
    const dx = Math.max(0, Math.abs(x - cx) - hx), dy = Math.max(0, Math.abs(y - cy) - hy);
    return Math.hypot(dx, dy);
  }
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2));
  return Math.max(0, Math.hypot(x - ax - vx * t, y - ay - vy * t) - mb.w / 2);
}

// build a plan's members in the current wall frame (posts at z, rails a hair in front, braces in front of both)
function buildMembers(c, plan, d = 0.15, z = 0.035) {
  const bm = mat(c.S.beam);
  let k = 0;
  for (const mb of plan.members) {
    const [ax, ay] = mb.a, [bx, by] = mb.b;
    if (mb.kind === 'h') c.K.box(bm, bx - ax, mb.w, d, (ax + bx) / 2, ay, z + 0.004, { tile: 1.2, grain: 'x', seg: [Math.max(1, Math.ceil((bx - ax) / 2)), 1, 1] });
    else if (mb.kind === 'v') c.K.box(bm, mb.w, by - ay, d, ax, (ay + by) / 2, z, { tile: 1.2, grain: 'y', seg: [1, 2, 1] });
    else { const zz = z + 0.008 + (k++ % 2) * 0.004; c.K.beam(bm, [ax, ay, zz], [bx, by, zz], mb.w, d); }
  }
}

// The outer face of a plastered wall as one grid (wall frame, face at z = 0), its lines broken at the
// timber members' edges and a hand's width off them, so the plaster darkens softly where it meets the
// beams (grime) and stays bright in the middle of each panel. hole = { x0, x1, y1 } leaves the door open.
function plasterFace(c, m, len, y0, y1, plan, hole, o) {
  const xs = new Set([-len / 2, len / 2]), ys = new Set([y0, y1]);
  const X = v => { if (v > -len / 2 + 0.01 && v < len / 2 - 0.01) xs.add(Math.round(v * 1000) / 1000); };
  const Y = v => { if (v > y0 + 0.01 && v < y1 - 0.01) ys.add(Math.round(v * 1000) / 1000); };
  for (const mb of plan.members) {
    const hw = mb.w / 2;
    if (mb.kind === 'v') for (const d of [-hw - 0.2, -hw, hw, hw + 0.2]) X(mb.a[0] + d);
    else if (mb.kind === 'h') for (const d of [-hw - 0.2, -hw, hw, hw + 0.2]) Y(mb.a[1] + d);
    else { const n = Math.ceil(Math.abs(mb.b[0] - mb.a[0]) / 0.3); for (let k = 1; k < n; k++) X(mb.a[0] + (mb.b[0] - mb.a[0]) * k / n); }
  }
  for (let x = -len / 2 + 0.9; x < len / 2; x += 1.8) X(x);
  if (hole) { X(hole.x0); X(hole.x1); Y(hole.y1); }
  const XS = [...xs].sort((a, b) => a - b), YS = [...ys].sort((a, b) => a - b);
  const g = gridGeo(XS, YS, 0, hole ? (a, b, ya, yb) => (a + b) / 2 > hole.x0 && (a + b) / 2 < hole.x1 && (ya + yb) / 2 < hole.y1 : null);
  const ao = (x, y) => {
    let d = 9;
    for (const mb of plan.members) { d = Math.min(d, memberDist(mb, x, y)); if (d === 0) break; }
    const k = 1 - 0.24 * (1 - sstep(0, 0.22, d));
    return [k, k * 0.985, k * 0.95];   // the grime is a warm brown, not grey
  };
  c.K.add(m, g, { ...o, ao });
}

// 0-n plaster holes (decals from the wall_holes atlas) in random panels of the current wall frame
function holes(c, panels, n, kind) {
  const cells = HOLE_CELLS[kind];
  if (!cells || !n) return;
  const hm = holeMat();
  const cand = panels.filter(p => p.x1 - p.x0 > 0.65 && p.y1 - p.y0 > 0.55);
  for (let k = 0; k < n && cand.length; k++) {
    const p = cand.splice(Math.floor(c.R() * cand.length), 1)[0];
    const sz = Math.min(1.3, (p.x1 - p.x0) * 1.15, (p.y1 - p.y0) * 1.6) * (0.75 + c.R() * 0.3);
    const x = p.x0 + (p.x1 - p.x0) * (0.3 + 0.4 * c.R()), y = p.y0 + (p.y1 - p.y0) * (0.3 + 0.4 * c.R());
    const cell = cells[Math.floor(c.R() * cells.length)];
    const u0 = (cell % 2) * 0.5, v0 = cell < 2 ? 0.5 : 0;
    const g = new THREE.PlaneGeometry(sz, sz * 0.62);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (0.08 + uv.getX(i) * 0.84) * 0.5, v0 + (0.19 + uv.getY(i) * 0.62) * 0.5);
    c.K.add(hm, g, { uv: 'keep', at: matrix(x, y, 0.014, 0, 0, (c.R() - 0.5) * 0.3), shade: () => 0.96, cast: false });
  }
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
      const ledge = (w, d, x, z) => K.box(sm, w, 0.1, d, x, sy, z, { tile: 2, warp: v => { v.y += 0.035 * Math.sin(v.x * 3.1 + v.z * 2.3); }, seg: [Math.ceil(w / 0.5), 1, 1] });
      ledge(2 * (ox + t), t + 0.02, 0, -oz - t / 2);
      ledge(t + 0.02, 2 * oz, -ox - t / 2, 0); ledge(t + 0.02, 2 * oz, ox + t / 2, 0);
      ledge(fx1 - fx0, t + 0.02, -(fx0 + fx1) / 2, oz + t / 2); ledge(fx1 - fx0, t + 0.02, (fx0 + fx1) / 2, oz + t / 2);
    }
  }
  // the threshold step under the door: its top is the floor across the whole door gap
  const sm = mat(S.base || S.floor);
  K.box(sm, 2 * dw + 0.36, 0.42, oz + 0.5 - iz, 0, -0.11, (iz + oz + 0.5) / 2, { tile: 2, seg: [1, 1, 1] });
}

// ---- interior shell ------------------------------------------------------------------------------

// a horizontal plane (subdivided for the relight pass) at y, facing up (down = true: facing down)
function hplane(c, m, w, d, x, y, z, o = {}, down = false, cell = 0.6) {
  const g = new THREE.PlaneGeometry(w, d, Math.max(1, Math.ceil(w / cell)), Math.max(1, Math.ceil(d / cell)));
  return c.K.add(m, g, { uvSpace: 'kit', ...o, at: matrix(x, y, z, 0, down ? Math.PI / 2 : -Math.PI / 2) });
}

function interior(c) {
  const { K, S, H, ix, iz, dw, b, R } = c;
  const I = S.int || {};
  const cf = b.kind === 'casino' && I.casino && I.casino.floor === 'tile' ? 'tile_goblin' : S.floor;
  hplane(c, mat(cf), 2 * ix, 2 * iz, 0, 0.1, 0, { tile: cf === 'tile_goblin' || cf === 'flagstone' ? 3.2 : 3, grain: 'z' });
  ceiling(c);
  // inner wall lining (+ wainscot), subdivided so the relight pass can darken the corners
  const im = mat(S.inner), y0 = S.wainscot ? 1.1 : 0.1, hh = H - y0, cy = y0 + hh / 2;
  const sy = Math.max(3, Math.ceil(hh / 0.45)), sl = L => Math.max(1, Math.ceil(L / 0.6));
  const o = { uvSpace: 'kit', tile: S.wallTile, uvOff: [R(), R()], cast: false, tint: S.innerTint };
  const t = 0.02, e = t / 2 + 0.002;
  K.box(im, 2 * ix, hh, t, 0, cy, -iz + e, { ...o, seg: [sl(2 * ix), sy, 1] });
  K.box(im, t, hh, 2 * iz, -ix + e, cy, 0, { ...o, seg: [1, sy, sl(2 * iz)] });
  K.box(im, t, hh, 2 * iz, ix - e, cy, 0, { ...o, seg: [1, sy, sl(2 * iz)] });
  const segW = ix - dw;
  K.box(im, segW, hh, t, -(dw + segW / 2), cy, iz - e, { ...o, seg: [sl(segW), sy, 1] });
  K.box(im, segW, hh, t, dw + segW / 2, cy, iz - e, { ...o, seg: [sl(segW), sy, 1] });
  if (S.wainscot) {
    const wm = mat('floor_planks'), wo = { uvSpace: 'kit', tile: 2.4, tint: '#c8a888', cast: false, grain: 'x' };
    const wy = 0.6, wh = 1.0;
    K.box(wm, 2 * ix, wh, t, 0, wy, -iz + e, { ...wo, seg: [sl(2 * ix), 2, 1] });
    K.box(wm, t, wh, 2 * iz, -ix + e, wy, 0, { ...wo, seg: [1, 2, sl(2 * iz)] });
    K.box(wm, t, wh, 2 * iz, ix - e, wy, 0, { ...wo, seg: [1, 2, sl(2 * iz)] });
    K.box(wm, segW, wh, t, -(dw + segW / 2), wy, iz - e, { ...wo, seg: [sl(segW), 2, 1] });
    K.box(wm, segW, wh, t, dw + segW / 2, wy, iz - e, { ...wo, seg: [sl(segW), 2, 1] });
    const bm = mat(S.beam);
    const rail = (w, d, x, z) => K.box(bm, w, 0.08, d, x, 1.12, z, { grain: w > d ? 'x' : 'z', cast: false, seg: [1, 1, 1] });
    rail(2 * ix, 0.07, 0, -iz + 0.035); rail(0.07, 2 * iz, -ix + 0.035, 0); rail(0.07, 2 * iz, ix - 0.035, 0);
    rail(segW, 0.07, -(dw + segW / 2), iz - 0.035); rail(segW, 0.07, dw + segW / 2, iz - 0.035);
  }
  c.taken = { left: [], right: [], back: [], front: [] };
  if (b.kind !== 'gas') {
    if (b.kind === 'casino' && I.casino && I.casino.forge) forge(c);
    else if (I.hearth) hearth(c);
    if (I.kiva) kiva(c);
  }
}

// ceilings: board ceiling + beams (timber), joists + tie beam (farm), massive beams on stone corbels
// (alpine), hides sagging between round rafters (frontier), latillas across round vigas (adobe)
function ceiling(c) {
  const { K, S, H, ix, iz, R } = c;
  const kind = (S.int || {}).ceil || 'planks';
  const bm = mat(S.beam), cm = mat('floor_planks'), wl = mat('wood_light');
  if (kind === 'hide') {
    const n = Math.max(3, Math.round(2 * ix / 1.25)), sp = 2 * ix / n;
    K.add(mat('hide_patch', { side: THREE.DoubleSide }), new THREE.PlaneGeometry(2 * ix, 2 * iz, n * 4, Math.ceil(2 * iz / 0.6)), {
      uv: 'keep', uvScale: [2 * ix / 3, 2 * iz / 3], at: matrix(0, H - 0.04, 0, 0, Math.PI / 2), cast: false,
      warp: v => { const f = ((v.x + ix) / sp) % 1; v.z += 0.14 * Math.sin(Math.PI * f); },
    });
    for (let k = 0; k <= n; k++) { const x = Math.max(-ix + 0.1, Math.min(ix - 0.1, -ix + k * sp)); K.cyl(wl, [x, H - 0.1, -iz - 0.1], [x + (R() - 0.5) * 0.1, H - 0.12, iz + 0.1], 0.09, 0.08, { sides: 7, tint: '#a8865e', cast: false }); }
    K.cyl(wl, [-ix - 0.1, H - 0.3, 0], [ix + 0.1, H - 0.28, (R() - 0.5) * 0.1], 0.13, 0.12, { sides: 8, tint: '#9a7a58', cast: false });
    return;
  }
  if (kind === 'vigas') {
    // the latillas tile is laid so its repeat equals the viga spacing, its edge hidden under a viga
    const n = Math.max(4, Math.round(2 * ix / 0.8)), sp = 2 * ix / n;
    K.add(mat('latillas'), new THREE.PlaneGeometry(2 * ix, 2 * iz, n, Math.ceil(2 * iz / 0.6)), { uv: 'keep', uvScale: [n, 2 * iz / 1.6], at: matrix(0, H - 0.03, 0, 0, Math.PI / 2), cast: false });
    for (let k = 0; k <= n; k++) { const x = Math.max(-ix + 0.06, Math.min(ix - 0.06, -ix + k * sp)) + (k > 0 && k < n ? (R() - 0.5) * 0.04 : 0); K.cyl(mat('wood_light'), [x, H - 0.17, -iz - 0.05], [x + (R() - 0.5) * 0.04, H - 0.18, iz + 0.05], 0.13, 0.12, { sides: 8, cast: false, tint: '#c8a888' }); }
    return;
  }
  hplane(c, cm, 2 * ix, 2 * iz, 0, H - 0.06, 0, { tile: 3, grain: 'x', tint: kind === 'joists' ? '#7a6a5c' : '#9a8478', cast: false }, true);
  if (kind === 'joists') {
    const n = Math.max(4, Math.round(2 * ix / 0.85));
    for (let k = 0; k < n; k++) { const x = -ix + 2 * ix * (k + 0.5) / n; K.box(bm, 0.14, 0.2, 2 * iz, x, H - 0.16, 0, { grain: 'z', tile: 1.2, seg: [1, 1, 3], cast: false }); }
    K.box(bm, 2 * ix, 0.3, 0.3, 0, H - 0.41, 0, { grain: 'x', tile: 1.2, seg: [4, 1, 1], cast: false });
    return;
  }
  const heavy = kind === 'heavy';
  const nb = Math.max(1, Math.round(2 * iz / (heavy ? 1.9 : 2.6)));
  for (let k = 0; k < nb; k++) {
    const z = -iz + 2 * iz * (k + 0.5) / nb;
    K.box(bm, 2 * ix, heavy ? 0.4 : 0.26, heavy ? 0.36 : 0.24, 0, H - (heavy ? 0.26 : 0.19), z, { grain: 'x', tile: 1.2, seg: [3, 1, 1], cast: false });
    if (heavy) for (const s of [-1, 1]) K.box(mat('granite_block'), 0.42, 0.34, 0.46, s * (ix - 0.21), H - 0.63, z, { tile: 2, tint: '#d4cec4', cast: false });
  }
}

// a fire: three logs, a bed of embers, tongues of flame and a glow (in the current frame)
function fire(c, x, y, z, r) {
  const { K } = c;
  for (let k = 0; k < 3; k++) { const a = k * 2.1 + 0.3; K.cyl(mat('wood_light'), [x - Math.cos(a) * r, y + 0.06, z - Math.sin(a) * r * 0.6], [x + Math.cos(a) * r, y + 0.1 + k * 0.03, z + Math.sin(a) * r * 0.6], 0.06, 0.055, { sides: 6, tint: '#6a4a34', cast: false }); }
  K.add(emberMat(), new THREE.SphereGeometry(r * 0.9, 10, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, y, z, 0, 0, 0, new THREE.Vector3(1, 0.3, 0.8)), shade: false, cast: false });
  flames(K, x, y + 0.05, z, r * 0.8);
  c.glows.push({ p: c.wp(x, y + r, z), s: 2.2 + r * 3, fire: true });
}

// a stone hearth on a side wall (timber: fieldstone; alpine: a big granite one)
function hearth(c) {
  const { S, b } = c;
  const big = S.int.hearth === 'big';
  const hw = big ? 1.22 : 1.0;
  const side = b.kind === 'casino' ? 'right' : 'left';
  const t = freeSpot(c, side, 2 * hw + 0.2, 0);
  if (t === null) return;
  c.taken[side].push([t - hw - 0.2, t + hw + 0.2]);
  onInner(c, side, t, () => {
    const K = c.K;
    const sm = mat(big ? 'granite_block' : 'stone_found'), bm = mat(S.beam), tint = big ? '#d4cec4' : null;
    const d = 0.32, oh = big ? 1.25 : 1.0, ow = big ? 1.5 : 1.05;
    for (const s of [-1, 1]) K.box(sm, hw - ow / 2, oh + 0.1, d, s * (ow / 2 + (hw - ow / 2) / 2), (oh + 0.1) / 2 + 0.1, d / 2, { tile: 1.6, tint, cast: false });
    K.box(bm, 2 * hw + 0.3, 0.22, d + 0.14, 0, oh + 0.21, (d + 0.14) / 2, { grain: 'x', cast: false });
    const top = c.H - 0.02;
    K.box(sm, 2 * hw - 0.3, top - oh - 0.32, d - 0.06, 0, (oh + 0.32 + top) / 2, (d - 0.06) / 2, { tile: 1.8, tint, cast: false, seg: [1, 2, 1] });
    K.quad(mat('iron_wrought'), ow, oh, 0, 0.1 + oh / 2, 0.012, { tint: '#3a3030', shade: false });
    K.box(sm, 2 * hw + 0.2, 0.08, 0.6, 0, 0.14, 0.3, { tile: 1.6, tint, cast: false });
    fire(c, 0, 0.18, d * 0.5, big ? 0.3 : 0.24);
    K.cyl(mat('iron_wrought'), [0, oh - 0.02, d * 0.5], [0, oh - 0.4, d * 0.5], 0.012, 0.012, { sides: 4, cast: false });
    K.add(mat('iron_wrought'), new THREE.SphereGeometry(0.13, 10, 6), { uv: 'keep', at: matrix(0, oh - 0.52, d * 0.5, 0, 0, 0, new THREE.Vector3(1, 0.8, 1)), cast: false });
    for (const s of [-1, 1]) { K.cyl(mat('brass'), [s * hw * 0.7, oh + 0.32, 0.22], [s * hw * 0.7, oh + 0.5, 0.22], 0.04, 0.03, { sides: 6, cast: false }); K.add(glassMat(), new THREE.ConeGeometry(0.025, 0.07, 5), { uv: 'keep', at: matrix(s * hw * 0.7, oh + 0.55, 0.22), shade: false, cast: false }); }
  });
}

// Kharanos hall: a great stone forge-hearth on the back wall, a hood up into the beams, an anvil on a stump
function forge(c) {
  const t = 0.6, hw = 1.7;
  c.taken.back.push([t - hw - 0.3, t + hw + 0.3]);
  onInner(c, 'back', t, () => {
    const K = c.K, gm = mat('granite_block'), tint = '#d0cac0', bm = mat(c.S.beam), iron = mat('iron_wrought');
    const oh = 1.5, ow = 2.0, d = 0.9, H = c.H;
    for (const s of [-1, 1]) K.box(gm, hw - ow / 2, oh + 0.2, d, s * (ow / 2 + (hw - ow / 2) / 2), (oh + 0.2) / 2 + 0.1, d / 2, { tile: 1.8, tint, cast: false });
    K.box(gm, 2 * hw + 0.2, 0.36, d + 0.2, 0, oh + 0.38, (d + 0.2) / 2, { tile: 1.8, tint: '#dcd6cc', cast: false });
    // the hood narrows up to the beams
    K.box(gm, 2 * hw, H - oh - 0.56, d - 0.1, 0, (oh + 0.56 + H) / 2, (d - 0.1) / 2, { tile: 1.8, tint, cast: false, seg: [2, 3, 1], warp: v => { const k = (v.y + (H - oh - 0.56) / 2) / (H - oh - 0.56); v.x *= 1 - 0.38 * k; v.z = v.z * (1 - 0.4 * k) - 0.15 * k; } });
    K.quad(iron, ow, oh, 0, 0.1 + oh / 2, 0.012, { tint: '#2a2424', shade: false });
    K.box(gm, 2 * hw + 0.4, 0.14, 1.0, 0, 0.17, 0.55, { tile: 1.6, tint, cast: false });
    fire(c, 0, 0.24, d * 0.45, 0.42);
    // a rune band carved over the opening (brass inlay) and two chains with pots
    K.box(mat('brass'), ow + 0.4, 0.1, 0.04, 0, oh + 0.55, d + 0.11, { grain: 'x', tile: 1, cast: false });
    // anvil on a stump, a hammer on it
    const az = 1.9;
    K.cyl(mat('wood_light'), [0.9, 0.1, az], [0.9, 0.62, az], 0.32, 0.3, { sides: 10, tint: '#8a6a4a', cast: false });
    K.add(mat('endgrain'), new THREE.CircleGeometry(0.3, 10), { uv: 'keep', at: matrix(0.9, 0.621, az, 0, -Math.PI / 2), cast: false });
    K.box(iron, 0.62, 0.16, 0.24, 0.9, 0.7, az, { tile: 0.5, cast: false });
    K.box(iron, 0.28, 0.2, 0.18, 0.9, 0.86, az, { tile: 0.5, cast: false });
    K.add(iron, new THREE.ConeGeometry(0.11, 0.36, 6), { uv: 'keep', at: matrix(1.38, 0.86, az, 0, 0, -Math.PI / 2), cast: false });
    K.box(iron, 0.58, 0.14, 0.22, 0.9, 1.03, az, { tile: 0.5, cast: false });
    K.cyl(mat('wood_light'), [0.7, 1.12, az + 0.04], [1.15, 1.12, az + 0.18], 0.025, 0.025, { sides: 5, cast: false });
    K.box(iron, 0.12, 0.1, 0.18, 0.68, 1.15, az + 0.03, { tile: 0.5, cast: false });
    for (const s of [-1, 1]) { K.box(bm, 0.12, 0.12, 0.6, s * (hw + 0.1), oh + 0.75, 0.3, { cast: false }); lantern(c, [s * (hw + 0.1), oh + 0.45, 0.58], 0.4, true); }
  });
}

// adobe: a beehive kiva fireplace in a corner
function kiva(c) {
  const { K, b, ix, iz } = c;
  const [sx, sz] = b.kind === 'casino' ? [1, -1] : [-1, 1];
  const qx = -sx, qz = -sz;
  const th0 = qx > 0 ? (qz > 0 ? 0 : Math.PI / 2) : (qz > 0 ? 1.5 * Math.PI : Math.PI);
  const am = mat('adobe_inner'), cx = sx * ix, cz = sz * iz;
  K.add(am, new THREE.CylinderGeometry(0.42, 0.95, 1.7, 8, 3, true, th0, Math.PI / 2), { uv: 'keep', uvScale: [0.5, 0.6], at: matrix(cx, 0.1 + 0.85, cz), cast: false, tint: '#f0dcc0' });
  K.add(am, new THREE.CylinderGeometry(0.3, 0.38, c.H - 1.8, 6, 2, true, th0, Math.PI / 2), { uv: 'keep', uvScale: [0.4, 1], at: matrix(cx, 1.8 + (c.H - 1.8) / 2, cz), cast: false, tint: '#f0dcc0' });
  const dx = qx / Math.SQRT2, dz = qz / Math.SQRT2, a = Math.atan2(dx, dz);
  const ox = cx + dx * 0.62, oz = cz + dz * 0.62;
  K.add(mat('iron_wrought'), new THREE.CircleGeometry(0.3, 10, 0, Math.PI), { uv: 'keep', at: matrix(ox, 0.62, oz, a), tint: '#2a2020', shade: false, cast: false });
  K.quad(mat('iron_wrought'), 0.6, 0.5, ox, 0.37, oz, { ry: a, tint: '#2a2020', shade: false, cast: false });
  fire(c, cx + dx * 0.78, 0.12, cz + dz * 0.78, 0.2);
  for (let k = 0; k < 2; k++) pot(c, cx + qx * (0.35 + k * 0.25), 1.72, cz + qz * (0.55 - k * 0.2), 0.6 + k * 0.15, k ? '#a86a48' : '#c88a60');
}

function pot(c, x, y, z, k = 1, tint = '#c88a60', K = c.K) {
  const pts = [[0, 0], [0.16, 0.02], [0.24, 0.18], [0.22, 0.38], [0.11, 0.52], [0.12, 0.6], [0, 0.6]].map(([r, h]) => new THREE.Vector2(r, h));
  K.add(mat('clay'), new THREE.LatheGeometry(pts, 10), { uv: 'keep', uvScale: [1, 0.5], at: matrix(x, y, z, x * 2, 0, 0, k), tint });
}

function doorway(c) {
  const { K, S, b, dw, dh, D, oz } = c;
  const stone = S.name === 'alpine';
  const fm = mat(stone ? 'granite_block' : S.beam);
  const jw = stone ? 0.4 : 0.2;
  if (S.arch) {
    // a round stone arch: jambs up to the springing line, nine voussoirs round a half circle, a proud
    // keystone (the arch fills only the door gap's top corners, above head height)
    const tint = '#d4cec4', r = dw + 0.02, ys = dh - r;
    for (const s of [-1, 1]) {
      K.box(fm, jw, ys + 0.02, 0.5, s * (dw + jw / 2), ys / 2, D / 2 + 0.02, { tile: 2, seg: [1, 3, 1], tint });
      K.box(fm, jw + 0.12, 0.2, 0.56, s * (dw + jw / 2), ys - 0.08, D / 2 + 0.02, { tile: 2, tint: '#e0dad0' });
    }
    const n = 9, ro = r + 0.44;
    for (let k = 0; k < n; k++) {
      const a0 = Math.PI * k / n + 0.012, a1 = Math.PI * (k + 1) / n - 0.012;
      const key = k === (n - 1) / 2, rr = key ? ro + 0.16 : ro + (k % 2 ? 0.07 : -0.03);
      const pts = [[Math.cos(a0) * r, Math.sin(a0) * r], [Math.cos(a0) * rr, Math.sin(a0) * rr], [Math.cos(a1) * rr, Math.sin(a1) * rr], [Math.cos(a1) * r, Math.sin(a1) * r]].map(([x, y]) => [x, y + ys]);
      K.prism(fm, pts, D / 2 - 0.23 + (key ? 0.04 : 0), 0.5 + (key ? 0.06 : 0), { tile: 2, tint: key ? '#e4ded4' : tint });
    }
  } else {
    for (const s of [-1, 1]) K.box(fm, jw, dh + 0.05, 0.46, s * (dw + jw / 2), dh / 2, D / 2, { tile: stone ? 2 : 1.2, seg: [1, 3, 1] });
    K.box(fm, 2 * dw + 2 * jw + 0.3, 0.28, 0.5, 0, dh + 0.14, D / 2, { grain: 'x', tile: 1.2, seg: [2, 1, 1] });
  }
  if (S.trim === 'brass') K.box(mat('brass'), 2 * dw + 0.7, 0.08, 0.54, 0, dh + 0.3, D / 2, { grain: 'x', tile: 1 });
  // door leaves, swung open flat against the facade
  const dm = mat('door_plank');
  const barn = S.layout === 'gambrel';
  const off = S.arch ? 0.45 : 0.02;
  const leaves = barn ? [] : b.kind === 'casino' ? [[-1, Math.min(1.2, dw + 0.3)], [1, Math.min(1.2, dw + 0.3)]] : [[1, Math.min(1.35, c.ix - dw - 0.5 - off)]];
  c.leafW = barn ? Math.min(2.0, c.ix - dw - 0.4) + 0.1 : (b.kind === 'casino' ? leaves[1][1] : leaves[0][1]) + off;
  c.leafWL = barn ? c.leafW : b.kind === 'casino' ? leaves[0][1] + off : 0;
  const lh = Math.min(dh - 0.06, 2.6 + (dh - 2.6) * 0.5, c.leafMax || 99);
  for (const [s, lw] of leaves) {
    if (lw < 0.5) continue;
    K.push(s * (dw + jw + off), 0, oz + 0.05, s * -0.14);
    K.box(dm, lw, lh, 0.07, s * lw / 2, lh / 2 + 0.05, 0.035, { uv: 'keep', seg: [1, 1, 1], flipU: s < 0 });
    K.pop();
  }
}

function planWindows(c) {
  const { ox, oz, ix, dw, W, R, b, S } = c;
  const ww = c.ww, wins = [];
  const jit = () => (R() - 0.5) * 0.25;
  // front: one each side of the door, clear of the door leaves
  const spans = [[-(ix - 0.3), -(dw + 0.5 + c.leafWL + 0.15)], [dw + 0.5 + c.leafW + 0.15, ix - 0.3]];
  for (const [a, z] of spans) if (z - a >= ww + 0.3) wins.push({ side: 'front', t: (a + z) / 2 });
  // sides and back, evenly spaced (barns get a couple more along their long walls)
  const n = Math.max(1, Math.round((2 * oz - 1.8) / 3.2) + (S.extraWins || 0));
  for (const side of ['left', 'right']) for (let k = 0; k < n; k++) {
    const L = 2 * oz - 1.8;
    wins.push({ side, t: -L / 2 + L * (k + 0.5) / n + jit() * (n > 5 ? 0.4 : 1) });
  }
  let nb = b.kind === 'pawn' || b.kind === 'store' ? 0 : W > 16 ? 3 : W > 8.5 ? 2 : 1;   // shops have shelves on the back wall
  const forgeHall = b.kind === 'casino' && S.int && S.int.casino && S.int.casino.forge;
  for (let k = 0; k < nb; k++) {
    const L = 2 * ox - 2.2, t = -L / 2 + L * (k + 0.5) / nb + jit();
    if (forgeHall && Math.abs(t - 0.6) < 2.6) continue;   // the forge stands there
    wins.push({ side: 'back', t });
  }
  c.wins = wins;
}

function windowAt(c, t, side) {
  const { K, S, b } = c;
  const ww = c.ww, wh = c.wh, y0 = c.winY, cy = y0 + wh / 2;
  const bm = mat(S.win === 'stone' ? 'granite_block' : S.beam);
  const wmat = winMat();
  const awn = S.awnings ? S.awnings[Math.abs(b.id * 7 + Math.round(t * 10)) % S.awnings.length] : null;
  if (S.win === 'port') {
    // goblin porthole: round glass in a riveted brass ring, under a big canvas awning on two poles
    const r = ww / 2;
    K.add(wmat, new THREE.CircleGeometry(r, 20), { uv: 'keep', at: matrix(t, cy, 0.02), shade: false });
    K.add(mat('brass'), new THREE.TorusGeometry(r + 0.05, 0.09, 6, 20), { uv: 'keep', uvScale: [3, 1], at: matrix(t, cy, 0.06) });
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; K.add(mat('iron_wrought'), new THREE.SphereGeometry(0.035, 5, 4), { uv: 'keep', at: matrix(t + Math.cos(a) * (r + 0.05), cy + Math.sin(a) * (r + 0.05), 0.14) }); }
    K.add(wmat, new THREE.CircleGeometry(r, 20), { uv: 'keep', at: matrix(t, cy, -0.336, Math.PI), shade: false });
    K.add(mat('brass'), new THREE.TorusGeometry(r + 0.04, 0.06, 6, 20), { uv: 'keep', at: matrix(t, cy, -0.35) });
    if (awn && side !== 'back' && (side === 'front' || (Math.round(t * 7) + b.id) % 3 === 0)) awning(c, t, cy + r + 0.42, Math.max(2.3, ww + 1.6), 1.2, awn, true);
    return;
  }
  K.quad(wmat, ww, wh, t, cy, 0.012, { shade: false });
  const stone = S.win === 'stone';
  const jw = stone ? 0.24 : 0.13, tint = stone ? '#d4cec4' : null;
  for (const s of [-1, 1]) K.box(bm, jw, wh + 0.12, stone ? 0.16 : 0.12, t + s * (ww / 2 + jw / 2 - 0.02), cy, 0.05, { tile: stone ? 2 : 1.2, tint });
  K.box(bm, ww + 2 * jw + 0.12, stone ? 0.26 : 0.17, stone ? 0.2 : 0.16, t, cy + wh / 2 + (stone ? 0.13 : 0.085), 0.07, { grain: 'x', tile: stone ? 2 : 1.2, tint });
  K.box(bm, ww + 2 * jw + 0.08, 0.1, 0.22, t, y0 - 0.05, 0.1, { grain: 'x', tile: stone ? 2 : 1.2, tint });
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
  if (S.layout === 'frontier' && (side === 'left' || side === 'right')) {
    // a hide flap rolled up over the window on a stick, tied with rope
    const y = cy + wh / 2 + 0.26;
    K.cyl(mat('hide_patch'), [t - ww / 2 - 0.2, y, 0.15], [t + ww / 2 + 0.2, y + 0.03, 0.15], 0.11, 0.12, { sides: 8, tint: '#d0a880' });
    K.quad(mat('hide_patch', { side: THREE.DoubleSide }), ww + 0.4, 0.3, t, y - 0.15, 0.06, { uv: 'keep', uvScale: [0.4, 0.15], tint: '#c8a07a' });
    K.cyl(mat('wood_light'), [t - ww / 2 - 0.4, y + 0.14, 0.07], [t + ww / 2 + 0.4, y + 0.15, 0.07], 0.035, 0.035, { sides: 5, tint: '#a8865e' });
    for (const s of [-1, 1]) K.add(mat('rope'), new THREE.TorusGeometry(0.13, 0.022, 4, 9), { uv: 'keep', uvScale: [3, 1], at: matrix(t + s * ww * 0.32, y, 0.15, Math.PI / 2) });
  }
  if (S.snow) {
    const sm = mat('snow_roof');
    K.box(sm, ww + 2 * jw + 0.1, 0.08, 0.24, t, y0 + 0.03, 0.1, { tile: 2, seg: [3, 1, 1], warp: v => { v.y += 0.03 * Math.sin(v.x * 7); } });
    K.box(sm, ww + 2 * jw + 0.16, 0.1, 0.22, t, cy + wh / 2 + 0.3, 0.07, { tile: 2, seg: [3, 1, 1], warp: v => { v.y += 0.035 * Math.sin(v.x * 5 + 1); } });
    for (let k = 0; k < 2; k++) K.box(mat('iron_wrought'), 0.035, wh, 0.035, t + (k - 0.5) * ww * 0.45, cy, 0.04, { tile: 0.5 });
  }
  // inside: the same window and a sill
  K.quad(wmat, ww, wh, t, cy, -0.336, { ry: Math.PI, shade: false });
  K.box(bm, ww + 0.25, 0.06, 0.16, t, y0 - 0.03, -0.38, { grain: 'x', cast: false, tint });
  for (const s of [-1, 1]) K.box(bm, 0.1, wh + 0.1, 0.06, t + s * (ww / 2 + 0.05), cy, -0.35, { cast: false, tint });
  K.box(bm, ww + 0.3, 0.1, 0.06, t, cy + wh / 2 + 0.05, -0.35, { grain: 'x', cast: false, tint });
}

// a slanted canvas awning in a wall frame (x along the wall, z out): on two struts from the wall, or
// (poles) on two poles down to the ground with a rope tie at each
function awning(c, x, y, w, depth, name = 'canvas_stripe', poles = false) {
  const { K } = c;
  const am = mat(name, { side: THREE.DoubleSide });
  const drop = depth * 0.42, L = Math.hypot(depth, drop), ang = Math.atan2(drop, depth);
  K.push(x, y, 0.02, 0, ang);
  K.quad(am, w, L, 0, 0, L / 2, { rx: -Math.PI / 2, uv: 'keep', uvScale: [w / 1.2, L / 1.2], sx: Math.ceil(w / 0.6), sy: 3, warp: v => { v.z -= 0.07 * Math.sin(Math.PI * (v.y / L + 0.5)) * (0.7 + 0.3 * Math.cos(v.x * 2.6)); } });
  K.pop();
  // a scalloped valance
  K.quad(am, w, 0.24, x, y - drop - 0.1, depth + 0.03, { uv: 'keep', uvScale: [w / 1.2, 0.2] });
  const ns = Math.round(w / 0.32);
  for (let k = 0; k < ns; k++) K.add(am, new THREE.CircleGeometry(0.16, 8, Math.PI, Math.PI), { uv: 'keep', uvScale: [0.25, 0.12], at: matrix(x - w / 2 + w * (k + 0.5) / ns, y - drop - 0.22, depth + 0.031) });
  const wm = mat(c.S.beam);
  if (poles) {
    for (const s of [-1, 1]) {
      const px = x + s * (w / 2 - 0.08);
      K.cyl(mat('wood_light'), [px, 0, depth + 0.02], [px, y - drop + 0.04, depth + 0.02], 0.06, 0.05, { sides: 7, tint: '#b08a68' });
      K.add(mat('brass'), new THREE.SphereGeometry(0.07, 8, 6), { uv: 'keep', at: matrix(px, y - drop + 0.08, depth + 0.02) });
      K.cyl(mat('rope'), [px, y - drop, depth + 0.02], [px + s * 0.5, 0.05, depth + 0.7], 0.012, 0.012, { sides: 4 });
    }
    K.cyl(mat('wood_light'), [x - w / 2, y - drop + 0.02, depth + 0.02], [x + w / 2, y - drop + 0.02, depth + 0.02], 0.04, 0.04, { sides: 6, tint: '#b08a68' });
  } else for (const s of [-1, 1]) K.beam(wm, [x + s * (w / 2 - 0.08), y - drop - 0.7, 0.02], [x + s * (w / 2 - 0.08), y - drop - 0.02, depth - 0.05], 0.06, 0.06);
}

// ---- framing: half-timber, barn frame, quoins, corner boards, log ends, adobe skirts --------------------

function framing(c) {
  const { K, S, H, ox, oz, dw, R } = c;
  const bm = mat(S.beam);
  const by = S.baseH || 0;
  if (S.halfTimber) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(bm, 0.34, H - by + 0.05, 0.34, sx * (ox - 0.11), by + (H - by) / 2, sz * (oz - 0.11), { tile: 1.2, seg: [1, 3, 1] });
    for (const side of ['front', 'back', 'left', 'right']) onWall(c, side, () => buildMembers(c, c.plans[side]));
  }
  if (S.barnFrame) {
    // the barn's frame shows over its boards: posts every ~3 m (clear of the windows), a girt at mid height,
    // knee braces at the corners, a plate under the eaves
    const tm = mat(S.trim || S.beam), tt = S.trimTint;
    for (const side of ['left', 'right', 'back']) onWall(c, side, f => {
      const half = f.len / 2 - 0.12, wins = c.wins.filter(w => w.side === side).map(w => w.t);
      const n = Math.max(2, Math.round(2 * half / 3));
      const posts = [];
      for (let k = 0; k <= n; k++) {
        let x = -half + 2 * half * k / n;
        const hit = wins.find(t => Math.abs(t - x) < c.ww / 2 + 0.25);
        if (hit !== undefined && k > 0 && k < n) x = hit + Math.sign(x - hit || 1) * (c.ww / 2 + 0.3);
        posts.push(x);
      }
      for (const x of posts) K.box(tm, 0.22, H - by, 0.1, x, by + (H - by) / 2, 0.05, { tile: 1.2, tint: tt, seg: [1, 3, 1] });
      for (let k = 0; k < posts.length - 1; k++) {
        const a = posts[k] + 0.11, b = posts[k + 1] - 0.11, gy = by + (H - by) * 0.42;
        if (!wins.some(t => t > a && t < b && Math.abs(gy - (c.winY + c.wh / 2)) < c.wh / 2 + 0.2)) K.box(tm, b - a, 0.18, 0.08, (a + b) / 2, gy, 0.05, { grain: 'x', tile: 1.2, tint: tt });
      }
      K.box(tm, 2 * half + 0.24, 0.24, 0.1, 0, H - 0.12, 0.055, { grain: 'x', tile: 1.2, tint: tt, seg: [4, 1, 1] });
      for (const s of [-1, 1]) { const x = s * half; K.beam(tm, [x - s * 0.1, H - 1.3, 0.06], [x - s * 1.25, H - 0.2, 0.06], 0.16, 0.08, { tint: tt }); }
    });
  }
  if (S.topBeams) {
    // heavy dwarven plates; their ends poke out at the corners, chamfered and lit on the bevel
    const cham = (L, ax) => v => { const e = ax === 'x' ? v.x : v.z; if (Math.abs(e) > L / 2 - 0.05) { const k = 0.82; v.y *= k; if (ax === 'x') v.z *= k; else v.x *= k; } };
    for (const sz of [-1, 1]) K.box(bm, 2 * ox + 0.8, 0.38, 0.36, 0, H - 0.19, sz * (oz - 0.08), { grain: 'x', tile: 1.4, seg: [6, 1, 1], warp: cham(2 * ox + 0.8, 'x') });
    for (const sx of [-1, 1]) K.box(bm, 0.36, 0.38, 2 * oz + 0.8, sx * (ox - 0.08), H - 0.52, 0, { grain: 'z', tile: 1.4, seg: [1, 1, 6], warp: cham(2 * oz + 0.8, 'z') });
  }
  if (S.quoins) {
    const qm = mat('granite_block'), n = Math.floor((H - (S.baseH || 0)) / 0.55);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < n; k++) {
      const y = (S.baseH || 0) + 0.3 + k * 0.55, long = ((k & 1) ? 0.85 : 0.5) + (R() - 0.5) * 0.12, o = R() * 0.03;
      K.box(qm, long, 0.5, 0.36 + o, sx * (ox - long / 2 + 0.06), y, sz * (oz - 0.11 + o / 2), { tile: 2.2, tint: '#dcd6cc', seg: [1, 1, 1] });
      const l2 = ((k & 1) ? 0.5 : 0.85) + (R() - 0.5) * 0.12;
      K.box(qm, 0.36 + o, 0.5, l2, sx * (ox - 0.11 + o / 2), y, sz * (oz - l2 / 2 + 0.06), { tile: 2.2, tint: '#dcd6cc', seg: [1, 1, 1] });
    }
  }
  if (S.cornerBoards) {
    const cm = mat(S.cornerMat || 'wood_light'), t = 0.22, ct = S.cornerTint || '#a08a70';
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(cm, t, H - by + 0.02, t, sx * (ox - t / 2 + 0.05), by + (H - by) / 2, sz * (oz - t / 2 + 0.05), { tile: 1.2, seg: [1, 3, 1], tint: ct });
    for (const sz of [-1, 1]) K.box(cm, 2 * ox + 0.1, 0.18, 0.08, 0, H - 0.25, sz * (oz + 0.03), { grain: 'x', tile: 1.2, seg: [3, 1, 1], tint: ct });
    for (const sx of [-1, 1]) K.box(cm, 0.08, 0.18, 2 * oz + 0.1, sx * (ox + 0.03), H - 0.25, 0, { grain: 'z', tile: 1.2, seg: [1, 1, 3], tint: ct });
  }
  if (S.logEnds && S.layout !== 'frontier') logEnds(c, H, H);
  if (S.round) {
    // a battered mud skirt along every wall (thick at the ground, gone by 1.35 m), and lumpy tapered piers
    // of different heights at the corners
    const am = mat('adobe_inner'), o = { uvSpace: 'kit', tile: S.wallTile };
    for (const side of ['front', 'back', 'left', 'right']) onWall(c, side, f => {
      const e = f.len / 2 - 0.3;
      const segs = side === 'front' ? [[-e, -dw - 0.3], [dw + 0.3, e]] : [[-e, e]];
      for (const [a, bb] of segs) if (bb - a > 0.3) K.box(mat(S.wall), bb - a, 1.5, 0.3, (a + bb) / 2, 0.6, 0.15, { ...o, seg: [Math.ceil((bb - a) / 1.2), 4, 1],
        warp: v => { if (v.z > 0) { const t = Math.min(1, Math.max(0, (v.y + 0.75) / 1.5)); v.z = -0.15 + 0.32 * Math.pow(1 - t, 1.5) + 0.006; } } });
    });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const h = H * 0.58 + (R() - 0.3) * 1.2, x = sx * (ox + 0.3), z = sz * (oz + 0.3), ph = R() * 9, r0 = 0.72 + R() * 0.16, r1 = r0 / (1.35 + R() * 0.15);
      const lean = [(R() - 0.5) * 0.08, (R() - 0.5) * 0.08];
      K.cyl(mat(S.wall), [x, -0.2, z], [x + lean[0], h, z + lean[1]], r0, r1, { sides: 12, hseg: 5, uvScale: [2, h / 3.2],
        warp: v => { const a = Math.atan2(v.z, v.x); const k = 1 + 0.09 * Math.sin(a * 3 + v.y * 2 + ph) + 0.06 * Math.sin(a * 5 - v.y * 3.1 + ph * 2); v.x *= k; v.z *= k; } });
      K.add(mat(S.wall), new THREE.SphereGeometry(r1 + 0.03, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [1, 0.4], at: matrix(x + lean[0], h - 0.03, z + lean[1], ph, 0, 0, new THREE.Vector3(1, 0.5 + R() * 0.3, 1)),
        warp: v => { v.y *= 1 + 0.25 * Math.sin(v.x * 9 + ph) * Math.sin(v.z * 7); } });
    }
  }
}

// crossed log ends at the corners, lined up with the painted log courses; corners may run higher at the back
function logEnds(c, yFront, yBack) {
  const { K, ox, oz, R } = c;
  const lm = mat('wood_light'), T = 3;   // the log wall's tile
  const ys = [];
  for (let base = 0; base < Math.max(yFront, yBack) + T; base += T) {
    let acc = 0;
    for (let i = LOG_ROWS.length - 1; i >= 0; i--) { const h = LOG_ROWS[i] * T; ys.push({ y: base + acc + h / 2, r: h * 0.5 }); acc += h; }
  }
  let k = 0;
  for (const { y, r: r0 } of ys) {
    k++;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (y > (sz > 0 ? yFront : yBack) - 0.15 || y < 0.05) continue;
      const r = r0 * (0.92 + R() * 0.12), stick = 0.3 + R() * 0.2;
      const alongX = k % 2 === 0;
      const a = alongX ? [sx * (ox - 0.3), y, sz * (oz - 0.15)] : [sx * (ox - 0.15), y, sz * (oz - 0.3)];
      const b = alongX ? [sx * (ox + stick), y + (R() - 0.5) * 0.04, sz * (oz - 0.15)] : [sx * (ox - 0.15), y + (R() - 0.5) * 0.04, sz * (oz + stick)];
      K.cyl(lm, a, b, r, r * 0.95, { sides: 8, tint: '#c09a70' });
      const n = alongX ? [sx, 0, 0] : [0, 0, sz];
      K.add(mat('endgrain'), new THREE.CircleGeometry(r * 0.95, 8), { uv: 'keep', at: matrix(b[0] + n[0] * 0.003, b[1], b[2] + n[2] * 0.003, alongX ? sx * Math.PI / 2 : (sz > 0 ? 0 : Math.PI), 0, R() * 3) });
    }
  }
}

// ---- timber: the jettied upper storey ------------------------------------------------------------

function upperStorey(c) {
  const { K, S, H, R, sign } = c;
  const out = c.up.out, X = c.Rox, Z = c.Roz, top = c.RH, y0 = H + 0.22;
  const m = mat(S.wall), bm = mat(S.beam);
  const o = { uvSpace: 'kit', tile: S.wallTile, uvOff: [R(), R()] };
  const t = 0.26, ny = 3, e = 0.008;
  // the floor frame it sits on, overhanging the walls below
  K.box(bm, 2 * X, 0.24, 2 * Z, 0, H + 0.1, 0, { tile: 1.2, grain: 'x', seg: [6, 1, 6] });
  // joist ends under the overhang, and a curved corbel brace under every few
  for (const side of ['front', 'left', 'right', 'back']) onWall(c, side, f => {
    let k = 0;
    for (let x = -f.len / 2 + 0.35; x < f.len / 2 - 0.25; x += 0.6, k++) {
      K.box(bm, 0.15, 0.17, out + 0.1, x, H - 0.06, out / 2 + 0.02, { grain: 'z', tile: 1.2, seg: [1, 1, 1], cast: false });
      if (k % 3 === 1 && Math.abs(x) > c.dw + 0.6) K.tube(bm, [[x, H - 0.85, 0.06], [x, H - 0.45, 0.1], [x, H - 0.2, out * 0.6], [x, H - 0.12, out - 0.02]], [0.08, 0.08, 0.075, 0.07], { sides: 4, tile: 1.2, cast: false });
    }
  });
  K.box(m, 2 * X - 2 * e, top - y0, t - e, 0, (y0 + top) / 2, Z - t / 2 - e / 2, { ...o, seg: [Math.ceil(X), ny, 1] });
  K.box(m, 2 * X - 2 * e, top - y0, t - e, 0, (y0 + top) / 2, -Z + t / 2 + e / 2, { ...o, seg: [Math.ceil(X), ny, 1] });
  for (const s of [-1, 1]) K.box(m, t - e, top - y0, 2 * Z - 2 * t, s * (X - t / 2 - e / 2), (y0 + top) / 2, 0, { ...o, seg: [1, ny, Math.ceil(Z)] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(bm, 0.3, top - y0 + 0.05, 0.3, sx * (X - 0.1), (y0 + top) / 2, sz * (Z - 0.1), { tile: 1.2, seg: [1, 2, 1] });
  // small leaded casements: beside the sign at the front, along the sides, one or two at the back
  const uw = 0.72, uh = Math.min(0.86, top - y0 - 0.55), uy = y0 + Math.max(0.28, (top - y0 - uh) * 0.45);
  const wins = [];
  const sw = sign ? sign.w / 2 : 1.0, ft = sw + 0.85;
  if (ft + uw / 2 < X - 0.45) wins.push(['front', -ft], ['front', ft]);
  if (X > 7 && ft + 3.2 < X - 0.6) wins.push(['front', -(ft + 2.6)], ['front', ft + 2.6]);
  const ns = Math.max(1, Math.round(2 * Z / 3.4));
  for (const side of ['left', 'right']) for (let k = 0; k < ns; k++) wins.push([side, -Z + 2 * Z * (k + 0.5) / ns]);
  if (X > 7) wins.push(['back', -X * 0.4], ['back', X * 0.4]); else wins.push(['back', 0]);
  for (const side of ['front', 'back', 'left', 'right']) onWall(c, side, f => {
    const mine = wins.filter(w => w[0] === side).map(w => w[1]);
    for (const tt of mine) upperWindow(c, tt, uy, uw, uh);
    const plan = timberPlan(c, f.len, { y0, y1: top, ops: mine.map(tt => ({ a: tt - uw / 2 - 0.12, b: tt + uw / 2 + 0.12, top: uy + uh + 0.1, bot: uy - 0.1 })), mw: 0.24 });
    plasterFace(c, m, f.len, y0, top, plan, null, o);
    buildMembers(c, plan);
    if (side !== 'front') holes(c, plan.panels, Math.floor(R() * 1.8), S.holes);
  }, X, Z);
}

function upperWindow(c, t, y, w, h) {
  const { K, S } = c;
  const bm = mat(S.beam);
  K.quad(winMat(), w, h, t, y + h / 2, 0.012, { shade: false });
  for (const s of [-1, 1]) K.box(bm, 0.12, h + 0.1, 0.1, t + s * (w / 2 + 0.05), y + h / 2, 0.05, { tile: 1.2 });
  K.box(bm, w + 0.34, 0.14, 0.14, t, y + h + 0.07, 0.07, { grain: 'x', tile: 1.2 });
  K.box(bm, w + 0.3, 0.09, 0.2, t, y - 0.04, 0.1, { grain: 'x', tile: 1.2 });
  if (S.win === 'flower') { K.box(mat('wood_light'), w + 0.1, 0.2, 0.22, t, y - 0.2, 0.14, { grain: 'x', tint: '#b89070' }); K.quad(flowerMat(), w + 0.24, 0.42, t, y + 0.02, 0.17, { shade: false }); }
}

// ---- roofs --------------------------------------------------------------------------------------

function profileOf(c, hs, kind, pitch, eave, base = c.RH) {
  const H = base;
  if (kind === 'gambrel') {
    const lowA = 62 * D2R, upA = 26 * D2R, hk = hs * 0.6;
    const yk = H + (hs - hk) * Math.tan(lowA), apex = yk + hk * Math.tan(upA), e = eave;
    // the eave kicks out flatter than the lower slope (a bellcast), so it overhangs the wall
    const ke = Math.tan(lowA) * 0.55;
    return { pts: [[-hs - e, H - e * ke], [-hk, yk], [0, apex], [hk, yk], [hs + e, H - e * ke]], under: [[-hs, H], [-hk, yk], [0, apex], [hk, yk], [hs, H]], apex, tp: ke, base: H };
  }
  const tp = Math.tan(pitch * D2R), apex = H + hs * tp;
  return { pts: [[-hs - eave, H - eave * tp], [0, apex], [hs + eave, H - eave * tp]], under: [[-hs, H], [0, apex], [hs, H]], apex, tp, base: H };
}

// roof vertex shading: the eave courses are darker (older, in the shade), moss creeps up from the eaves
// on wooden and thatch roofs, thatch greys toward the eave
function roofShader(c, P, roofMat) {
  const base = c.K.shadeFn, yE = Math.min(P.pts[0][1], P.pts[P.pts.length - 1][1]), span = Math.max(0.5, P.apex - yE);
  const thatch = roofMat === 'thatch', mossy = c.S.moss && roofMat !== 'hide_patch' && roofMat !== 'slate_roof';
  return (x, y, z, nx, ny, nz) => {
    const k0 = base(x, y, z, nx, ny, nz);
    const t = sstep(yE, yE + 0.3 * span, y), k = 0.76 + 0.24 * t;
    let r = k0[0] * k, g = k0[1] * k, b = k0[2] * k;
    if (thatch) { const gr = (1 - t) * 0.35; const l = (r + g + b) / 3; r += (l * 0.95 - r) * gr; g += (l * 0.95 - g) * gr; b += (l * 0.92 - b) * gr; }
    if (mossy && ny > 0.2) {
      const n = 0.5 + 0.5 * Math.sin(x * 1.3 + z * 0.9 + 0.4) * Math.sin(x * 0.7 - z * 1.9 + 1.7);
      const mo = (1 - sstep(yE, yE + 0.32 * span, y)) * sstep(0.45, 0.85, n) * 0.55;
      r *= 1 - 0.3 * mo; g *= 1 - 0.05 * mo; b *= 1 - 0.45 * mo;
    }
    return [r, g, b];
  };
}

// Roof slabs along a profile, extruded in the current frame from z = w0 to w1. cut = { slope, a, b, trim }
// shortens that slope's eave end by `trim` (along the slope) between w = a and b. hot = w positions
// (valleys, chimneys) where icicles cluster.
function roofSlabs(c, P, w0, w1, { roofMat, thick, barge = true, eaveBeams = true, hs = 0, ridge = true, ridgeFrom = null, cut = null, lips = true, hot = [] }) {
  const { K, S } = c;
  const H = P.base;
  const rm = mat(roofMat), bm = mat(S.trim && S.trim !== 'brass' ? S.trim : S.beam), th = thick, tt = S.trimTint;
  const n = P.pts.length, len = w1 - w0;
  const roofShade = roofShader(c, P, roofMat);
  const thatch = roofMat === 'thatch';
  const bargeEnds = !barge ? [] : ridgeFrom !== null ? [[w1, 1]] : [[w1, 1], [w0, -1]];
  const uv0 = [hsh(w0, len) * 3, hsh(len, w1) * 3];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = P.pts[i], [x1, y1] = P.pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx), up = dy > 0;
    const extHi = th * 0.95, extLo = (i === 0 || i === n - 2) ? 0 : th * 0.45;
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const eaveEnd = i === 0 || i === n - 2;
    const ranges = cut && cut.slope === i ? [[w0, cut.a, 0], [cut.a, cut.b, cut.trim], [cut.b, w1, 0]] : [[w0, w1, 0]];
    for (const [ra, rb, trim] of ranges) {
      if (rb - ra < 0.05) continue;
      const rlen = rb - ra, mid = (ra + rb) / 2;
      const Lt = L + extHi + extLo - trim, shift = (up ? 1 : -1) * (extHi - extLo + trim) / 2;
      const cx = (x0 + x1) / 2 + Math.cos(ang) * shift + nx * th / 2, cy = (y0 + y1) / 2 + Math.sin(ang) * shift + ny * th / 2;
      const sag = Math.min(0.09, len * 0.006);
      const warp = v => {
        const tz = (v.z + mid - w0) / len, tx = (v.x + Lt / 2) / Lt, low = up ? 1 - tx : tx;
        v.y -= sag * Math.sin(Math.PI * tz) * (0.4 + 0.6 * low);
        v.y += (hsh(Math.round((v.x + shift) * 4), Math.round((v.z + mid) * 4), i) - 0.5) * (thatch ? 0.08 : 0.035);
      };
      K.add(rm, new THREE.BoxGeometry(Lt, th, rlen, Math.max(4, Math.ceil(Lt / 0.5)), 1, Math.max(2, Math.ceil(rlen / 0.9))), { at: matrix(cx, cy, mid, 0, 0, ang), tile: S.roofTile, grain: 'x', flipV: !up, warp, shade: roofShade, uvOff: [uv0[0] + mid / S.roofTile, uv0[1] + (up ? 1 : -1) * shift / S.roofTile] });
      for (const [wz, s] of bargeEnds) if (Math.abs(wz - (s > 0 ? rb : ra)) < 1e-6) {
        K.add(bm, new THREE.BoxGeometry(Lt + 0.06, th + 0.24, 0.1, 2, 1, 1), { at: matrix(cx - nx * 0.08, cy - ny * 0.08, wz + s * 0.04, 0, 0, ang), tile: 1.2, grain: 'x', tint: tt });
      }
      if (S.snow) snowOnSlope(c, { x0, y0, x1, y1, ang, up, nx, ny, th, Lt, shift, ra, rb, eaveEnd: eaveEnd && !trim && lips, rakes: bargeEnds.filter(([wz, s]) => Math.abs(wz - (s > 0 ? rb : ra)) < 1e-6) });
      if (thatch && eaveEnd && !trim && lips) thatchEave(c, { x0, y0, x1, y1, up, nx, ny, th, ra, rb, shade: roofShade });
    }
  }
  // ridge cap
  const rk = S.ridge;
  if (ridgeFrom !== null) w0 = ridgeFrom;
  if (ridge) {
    if (rk === 'thatch') {
      // a lumpy rolled ridge, pinned with crossed spars
      const pts = []; for (let w = w0 - 0.15; w <= w1 + 0.1501; w += Math.max(0.3, (w1 - w0 + 0.3) / 24)) pts.push([0, P.apex + th * 0.62, w]);
      K.tube(rm, pts, (t, a, k) => 0.27 + 0.04 * Math.sin(k * 1.7 + a * 2) + 0.02 * Math.sin(k * 3.1), { sides: 10, tile: 1.4, uRep: 2, shade: roofShade });
      for (let w = w0 + 0.3; w < w1 - 0.2; w += 0.75) for (const s of [-1, 1]) K.cyl(mat('wood_light'), [-0.32, P.apex + th * 0.45, w - s * 0.2], [0.32, P.apex + th * 0.45, w + s * 0.2], 0.022, 0.022, { sides: 4, tint: '#b8a078' });
    } else if (rk === 'snow') {
      const pts = []; for (let w = w0 - 0.1; w <= w1 + 0.1001; w += Math.max(0.3, (w1 - w0 + 0.2) / 30)) pts.push([0, P.apex + th + 0.14 + 0.04 * Math.sin(w * 2.7), w]);
      K.tube(mat('snow_roof'), pts, (t, a, k) => 0.3 + 0.06 * Math.sin(k * 1.9 + a * 2), { sides: 8, tile: 1.6 });
    } else {
      // a rounded ridge-tile cap, a little darker than the roof
      K.add(rm, new THREE.CylinderGeometry(0.2, 0.2, len + 0.14, 10, Math.max(2, Math.ceil(len / 1.2)), false, Math.PI / 2, Math.PI), { uv: 'keep', uvScale: [1, len / 1.2], at: matrix(0, P.apex + th * 0.95, (w0 + w1) / 2, 0, Math.PI / 2), tint: '#b89c90' });
    }
  }
  // rafter tails under the eaves (not where the eave is cut back)
  if (eaveBeams && hs) {
    const e = Math.abs(P.pts[0][0]) - hs;
    const cutAt = (s, w) => cut && cut.slope === 0 && s < 0 && w > cut.a && w < cut.b;
    for (let w = w0 + 0.45; w < w1 - 0.3; w += 0.75) for (const s of [-1, 1]) {
      if (cutAt(s, w)) continue;
      K.beam(bm, [s * (hs - 0.05), H - 0.12, w], [s * (hs + e * 0.92), H - e * 0.92 * P.tp - 0.1, w], 0.1, 0.13, { cast: false, tint: tt });
    }
    if (c.S.snow) {
      // icicles: clustered (under valleys and chimneys, and in patches), lengths 0.1-0.7 m, about a third missing
      const im = mat('snow_roof');
      for (let w = w0 + 0.15; w < w1 - 0.1; w += 0.16 + hsh(w, 1, 2) * 0.2) for (const s of [-1, 1]) {
        if (cutAt(s, w)) continue;
        const near = hot.reduce((m, h) => Math.max(m, 1 - Math.abs(w - h) / 1.4), 0);
        const dens = 0.5 + 0.5 * Math.sin(w * 0.9 + s * 1.7) * Math.sin(w * 0.37 + 1 + s) + near;
        if (dens < 0.42 || hsh(w, s, 7) > 0.55 + dens * 0.5) continue;
        const l = 0.1 + 0.6 * Math.min(1, Math.pow(Math.max(0, dens), 1.4)) * (0.5 + 0.5 * hsh(w, s, 3));
        K.add(im, new THREE.ConeGeometry(0.035 + l * 0.05, l, 5), { uv: 'keep', at: matrix(s * (hs + e - 0.02), H - e * P.tp - l / 2 - 0.12, w, 0, Math.PI, 0), tint: '#d8e8ff', cast: false });
      }
    }
  }
}

// Westfall thatch eave: a fat rolled lip of straw along the eave and a ragged straw fringe hanging under it
function thatchEave(c, s) {
  const { K } = c;
  const { x0, y0, x1, y1, up, nx, ny, th, ra, rb, shade } = s;
  const lo = up ? [x0, y0] : [x1, y1], hi = up ? [x1, y1] : [x0, y0];
  const out = Math.sign(lo[0] - hi[0]);
  const Ex = lo[0] + nx * th * 0.5 + out * 0.04, Ey = lo[1] + ny * th * 0.5 - 0.02;
  const pts = [], step = Math.min(0.3, (rb - ra + 0.1) / 2);
  for (let w = ra - 0.05; w <= rb + 0.0501; w += step) pts.push([Ex + (hsh(w * 3.1, 5) - 0.5) * 0.05, Ey - 0.03 * hsh(w * 1.7, 2), w]);
  if (pts.length > 1) K.tube(mat('thatch'), pts, (t, a, k) => th * 0.62 + 0.04 * Math.sin(k * 2.3 + a * 2), { sides: 9, tile: 1.4, uRep: 2, shade });
  const fm = mat('straw_fringe', { alphaTest: 0.45, side: THREE.DoubleSide });
  const fh = 0.36, len = rb - ra + 0.1;
  K.add(fm, new THREE.PlaneGeometry(len, fh, Math.max(1, Math.ceil(len / 1.5)), 1), { uv: 'keep', uvScale: [len / 1.6, 1], at: matrix(Ex + out * th * 0.35, Ey - th * 0.45 - fh / 2 + 0.06, (ra + rb) / 2, out > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0), shade: () => 0.8, cast: false });
}

// Kharanos snow on one roof slope: a thick, lumpy blanket (sagging between the rafters, darker toward
// the eave), a rounded overhanging lip drooping over the eave, and rolls along the gable rakes.
function snowOnSlope(c, s) {
  const { K } = c;
  const sm = mat('snow_roof'), st = 0.3;
  const { x0, y0, x1, y1, ang, up, nx, ny, th, Lt, shift, ra, rb } = s;
  const rlen = rb - ra, mid = (ra + rb) / 2;
  const scx = (x0 + x1) / 2 + Math.cos(ang) * shift + nx * (th + st / 2 - 0.05), scy = (y0 + y1) / 2 + Math.sin(ang) * shift + ny * (th + st / 2 - 0.05);
  const yE = Math.min(y0, y1);
  const sshade = (x, y) => { const k = 0.86 + 0.14 * sstep(yE, yE + 1.8, y); return [k * 0.95, k * 0.97, k]; };
  K.add(sm, new THREE.BoxGeometry(Lt, st, rlen + 0.06, 6, 1, Math.max(3, Math.ceil(rlen / 0.4))), {
    at: matrix(scx, scy, mid, 0, 0, ang), tile: 2.2, grain: 'x', shade: sshade,
    warp: v => { const wz = v.z + mid, sx = v.x + shift; if (v.y > 0) v.y += 0.07 * Math.sin(sx * 2.3 + wz * 1.7) + 0.05 * Math.sin(wz * 4.1 + sx) - 0.04 * Math.abs(Math.sin(Math.PI * wz / 0.75)); else v.y += 0.03; },
  });
  if (s.eaveEnd) {
    const lo = up ? [x0, y0] : [x1, y1], hi = up ? [x1, y1] : [x0, y0];
    const out = Math.sign(lo[0] - hi[0]);
    const Ex = lo[0] + nx * th + out * 0.06, Ey = lo[1] + ny * th - 0.1;
    const pts = [], step = Math.min(0.25, (rb - ra + 0.1) / 2);
    for (let w = ra - 0.05; w <= rb + 0.0501; w += step) pts.push([Ex + (hsh(w * 3.1, 2) - 0.5) * 0.07, Ey - 0.05 * Math.abs(Math.sin(Math.PI * w / 0.75)) - 0.04 * hsh(w * 1.7), w]);
    if (pts.length > 1) K.tube(sm, pts, (t, a, k) => 0.2 + 0.06 * Math.sin(k * 2.1 + a * 2) * Math.sin(k * 0.7 + 1), { sides: 7, tile: 1.5, shade: () => [0.84, 0.88, 0.95] });
  }
  for (const [wz, sgn] of s.rakes) {
    const pts = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6, bx = x0 + (x1 - x0) * t, by = y0 + (y1 - y0) * t; pts.push([bx + nx * (th + st * 0.6), by + ny * (th + st * 0.6) - 0.03 * Math.sin(t * 9), wz + sgn * 0.04]); }
    K.tube(sm, pts, (t, a, k) => 0.14 + 0.04 * Math.sin(k * 2.7 + a), { sides: 6, shade: () => [0.9, 0.93, 0.98] });
  }
}

// the gable infill under a profile (in the current frame), outer face at z = wf (sgn = outward). Kharanos
// gables are stone up to the collar beam, with planks only in the apex.
function gableFill(c, P, wf, sgn, { emblem = false } = {}) {
  const { K, S, R } = c;
  const z0 = sgn > 0 ? wf - 0.3 : wf;
  const H = P.base, ap = P.apex, hs = P.under[P.under.length - 1][0];
  const y2 = H + (ap - H) * 0.48, w2 = hs * (1 - 0.48);
  if (S.gableStone) {
    K.prism(mat('granite_block'), [[-hs, H], [hs, H], [w2, y2], [-w2, y2]], z0, 0.3, { uvSpace: 'kit', tile: S.wallTile, tint: '#d8d2c8', uvOff: [R(), R()] });
    K.prism(mat(S.gableFill), [[-w2, y2], [w2, y2], [0, ap]], z0, 0.3, { uvSpace: 'kit', tile: S.wallTile, tint: S.gableTint, uvOff: [R(), R()] });
  } else K.prism(mat(S.gableFill), P.under, z0, 0.3, { uvSpace: 'kit', tile: S.wallTile, tint: S.gableTint, uvOff: [R(), R()] });
  const bm = mat(S.beam), z = wf + sgn * 0.04;
  if (S.halfTimber || S.name === 'alpine' || S.layout === 'gambrel') {
    const tm = S.layout === 'gambrel' ? mat(S.trim || S.beam) : bm, tt = S.layout === 'gambrel' ? S.trimTint : null;
    K.box(tm, 2 * hs + 0.1, 0.24, 0.14, 0, H + 0.1, z, { grain: 'x', tile: 1.2, seg: [3, 1, 1], tint: tt });
    if (S.layout !== 'gambrel') {
      K.box(bm, 2 * w2, 0.22, 0.14, 0, y2, z, { grain: 'x', tile: 1.2, seg: [2, 1, 1] });
      K.beam(bm, [0, y2 + 0.1, z], [0, ap - 0.15, z], 0.22, 0.14);
      if (S.halfTimber) for (const s of [-1, 1]) K.beam(bm, [s * hs * 0.62, H + 0.2, z], [s * 0.1, H + (ap - H) * 0.62, z], 0.2, 0.13);
      else for (const s of [-1, 1]) K.beam(bm, [s * w2 * 0.85, y2 + 0.1, z], [s * 0.1, y2 + (ap - y2) * 0.6, z], 0.2, 0.13);
    }
  }
  if (emblem && S.emblem) { const ey = S.gableStone ? (H + y2) / 2 + 0.1 : H + (ap - H) * 0.3; if (y2 - H > 1.3) dwarfEmblem(c, 0, ey, wf + sgn * 0.06, sgn, Math.min(0.62, (y2 - H) * 0.32)); }
}

// an iron shield with a brass rim and a war-hammer across it, on a gable (facing sgn along z)
function dwarfEmblem(c, x, y, z, sgn, r = 0.55) {
  const { K } = c;
  const iron = mat('iron_wrought'), br = mat('brass');
  K.push(x, y, z, sgn > 0 ? 0 : Math.PI);
  K.add(iron, new THREE.CylinderGeometry(r, r, 0.08, 16), { uv: 'keep', at: matrix(0, 0, 0.04, 0, Math.PI / 2), tint: '#8a8a96' });
  K.add(br, new THREE.TorusGeometry(r, 0.05, 6, 20), { uv: 'keep', uvScale: [4, 1], at: matrix(0, 0, 0.09) });
  K.add(br, new THREE.SphereGeometry(r * 0.22, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0, 0.08, 0, Math.PI / 2) });
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.add(br, new THREE.SphereGeometry(0.035, 5, 4), { uv: 'keep', at: matrix(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72, 0.1) }); }
  K.push(0, 0, 0.14, 0, 0, 0.7);
  K.box(mat('wood_light'), 0.07, r * 2.6, 0.06, 0, -r * 0.2, 0, { tint: '#8a6a4a' });
  K.box(iron, r * 0.95, r * 0.42, 0.16, 0, r * 1.05, 0, { tile: 0.5 });
  K.box(br, r * 0.98, 0.05, 0.17, 0, r * 0.84, 0, { tile: 1 });
  K.pop();
  K.pop();
}

function pitchedRoof(c) {
  const { K, S, b, sign, R } = c;
  const ox = c.Rox, oz = c.Roz, H = c.RH;
  const gOH = S.gableOH;
  let eave = S.eave;
  const kind = S.layout === 'gambrel' ? 'gambrel' : 'gable';
  // steep, but a deep shop doesn't get a roof three times its height (the hall's is as tall as its walls)
  const maxRise = (S.maxRise || 5) * (c.tall && !(b.kind === 'casino' && S.hall) ? 1.3 : 1);
  const pitch = Math.min(S.pitch, Math.atan(maxRise / oz) / D2R);
  const tp = Math.tan(pitch * D2R);
  // Kharanos: the eaves come down to about two thirds of the wall, however tall the hall
  if (S.lowEaves) eave = Math.max(S.eave, Math.min(2.4, 0.34 * c.H / tp));
  // the front gable must be wide enough to carry the sign
  let hsNeed = c.dw + 1.4;
  if (sign) hsNeed = Math.max(hsNeed, sign.w / 2 + 0.35 + Math.max(0, sign.top - H) / tp);
  const mainApex = H + oz * tp;
  const cross = kind === 'gable' && b.kind !== 'gas' && hsNeed < ox * 0.86 && H + hsNeed * tp < mainApex - 0.35;
  if (!cross) {
    // one roof, ridge running front to back: the whole front is a gable
    const P = profileOf(c, ox, kind, kind === 'gambrel' ? S.pitch : Math.min(S.pitch, Math.atan(maxRise * 1.15 / ox) / D2R), eave, H);
    roofSlabs(c, P, -oz - gOH, oz + gOH, { roofMat: S.roof, thick: S.thick, barge: S.barge, hs: ox });
    gableFill(c, P, oz, 1); gableFill(c, P, -oz, -1, { emblem: true });
    c.signZ = oz + 0.1;
    c.apex = P.apex;
    if (S.chimney) chimney(c, ox * 0.42 * (R() < 0.5 ? -1 : 1), -oz * 0.4, x => H + (ox - Math.abs(x)) * P.tp, P.apex);
    if (kind === 'gambrel') barnFront(c, P);
    return;
  }
  // main roof, ridge along the width, plus a cross gable over the door carrying the sign. With an upper
  // storey (or a Kharanos hall) the cross gable stands flush on the wall (the main eave is cut back in
  // front of it); otherwise it is jettied out over the eave on a beam and braces.
  const flush = !!c.up || !!S.crossCut;
  const P = profileOf(c, oz, kind, pitch, eave, H);
  const chx = ox * 0.55 * (R() < 0.5 ? -1 : 1);
  K.push(0, 0, 0, Math.PI / 2);
  roofSlabs(c, P, -ox - gOH, ox + gOH, { roofMat: S.roof, thick: S.thick, barge: S.barge, hs: oz, cut: flush ? { slope: 0, a: -hsNeed + 0.3, b: hsNeed - 0.3, trim: eave / Math.cos(pitch * D2R) + 0.02 } : null, hot: [hsNeed, -hsNeed, chx, -chx * 0.85] });
  gableFill(c, P, ox, 1, { emblem: true }); gableFill(c, P, -ox, -1, { emblem: true });
  K.pop();
  const j = flush ? 0.04 : eave + 0.12;
  const ce = Math.min(eave, S.crossEave || 0.45);
  const Pc = profileOf(c, hsNeed, kind, pitch, ce, H);
  const Pc0 = profileOf(c, hsNeed, kind, pitch, 0.02, H);
  roofSlabs(c, Pc0, 0, oz + 0.2, { roofMat: S.roof, thick: S.thick, barge: false, hs: 0, eaveBeams: false, ridge: false, lips: false });
  roofSlabs(c, Pc, oz + 0.2, oz + j + gOH, { roofMat: S.roof, thick: S.thick, barge: S.barge, hs: 0, eaveBeams: false, ridgeFrom: 0 });
  gableFill(c, Pc, oz + j, 1);
  const bm = mat(S.beam);
  if (!flush) {
    K.box(bm, 2 * hsNeed + 0.3, 0.3, j + 0.3, 0, H - 0.15, oz + j / 2 - 0.15, { grain: 'z', tile: 1.2, seg: [2, 1, 2] });
    for (const s of [-1, 1]) {
      K.beam(bm, [s * (hsNeed - 0.15), H - 1.25, oz + 0.08], [s * (hsNeed - 0.15), H - 0.25, oz + j - 0.1], 0.2, 0.2);
      for (let k = 0; k < 3; k++) K.box(bm, 0.16, 0.16, 0.5, s * (hsNeed - 0.6 - k * 0.7), H - 0.38, oz + 0.2, { grain: 'z', tile: 1.2 });
    }
    if (S.snow) K.box(mat('snow_roof'), 2 * hsNeed + 0.2, 0.12, 0.34, 0, H + 0.05, oz + j + 0.1, { tile: 2, seg: [4, 1, 1], warp: v => { v.y += 0.035 * Math.sin(v.x * 4); } });
  }
  c.signZ = oz + j + 0.1;
  c.apex = P.apex;
  // an emblem in the cross gable's apex, over the sign
  if (S.emblem && sign && Pc.apex - sign.top > 1.4) dwarfEmblem(c, 0, (sign.top + Pc.apex) / 2 - 0.15, oz + j + 0.08, 1, Math.min(0.55, (Pc.apex - sign.top) * 0.3));
  // snow drifted into the valleys between the cross gable and the main roof
  if (S.snow) for (const s of [-1, 1]) for (let k = 0; k < 5; k++) {
    const ax = hsNeed * (1 - (k + 0.5) / 5), z = oz - hsNeed + ax, y = H + (hsNeed - ax) * tp + S.thick + 0.12;
    K.add(mat('snow_roof'), new THREE.SphereGeometry(0.42, 8, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [1, 0.5], at: matrix(s * ax, y - 0.1, z, k, 0, 0, new THREE.Vector3(1.2, 0.5, 1)) });
  }
  const surf = (x, z) => H + (oz - Math.abs(z)) * tp;
  if (S.chimney) {
    chimney(c, chx, -oz * 0.42, surf, P.apex);
    if (S.chimneys > 1) chimney(c, -chx * 0.85, -oz * 0.3, surf, P.apex);
  }
  if (S.cupola) cupola(c, -chx * 0.25, P.apex, tp);
  if (S.dormer && c.up) {
    const dx = -Math.sign(chx) * (hsNeed + 1.45);
    if (hsNeed + 2.2 < ox - 0.5) dormer(c, dx, tp, oz, H);
    if (b.kind === 'casino' && hsNeed + 2.2 < ox - 0.5) dormer(c, -dx, tp, oz, H);
  }
}

// a small timber bell cupola astride the ridge: plaster and beams, louvred openings, a bell, a steep
// little shingle spire with an iron finial
function cupola(c, x, apex, tp) {
  const { K, S } = c;
  const w = 1.5, h = 1.5, y0 = apex - 0.25;
  const wm = mat(S.wall), bm = mat(S.beam);
  K.box(wm, w, h + 0.6, w, x, y0 - 0.3 + (h + 0.6) / 2, 0, { tile: S.wallTile, seg: [1, 2, 1] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(bm, 0.16, h + 0.6, 0.16, x + sx * (w / 2 - 0.05), y0 - 0.3 + (h + 0.6) / 2, sz * (w / 2 - 0.05), { tile: 1.2 });
  for (const [ry, dx, dz] of [[0, 0, 1], [Math.PI, 0, -1], [Math.PI / 2, 1, 0], [-Math.PI / 2, -1, 0]]) {
    K.push(x + dx * (w / 2 + 0.006), y0 + 0.75, dz * (w / 2 + 0.006), ry);
    K.quad(mat('iron_wrought'), 0.7, 0.9, 0, 0, 0, { tint: '#2a2224', shade: false });
    for (let k = 0; k < 4; k++) K.box(bm, 0.74, 0.06, 0.06, 0, -0.32 + k * 0.21, 0.04, { rx: 0.5, grain: 'x', tile: 1.2 });
    K.box(bm, 0.9, 0.1, 0.1, 0, 0.5, 0.04, { grain: 'x', tile: 1.2 });
    K.pop();
  }
  K.add(mat('brass'), new THREE.CylinderGeometry(0.12, 0.26, 0.38, 10, 1, true), { uv: 'keep', at: matrix(x, y0 + 0.82, 0), receive: true });
  K.box(bm, w + 0.36, 0.16, w + 0.36, x, y0 + h + 0.32, 0, { tile: 1.2 });
  K.add(mat(S.roof), new THREE.ConeGeometry((w + 0.5) * 0.74, 2.0, 4, 2), { uv: 'keep', uvScale: [2, 1.4], at: matrix(x, y0 + h + 1.4, 0, Math.PI / 4) });
  K.cyl(mat('iron_wrought'), [x, y0 + h + 2.3, 0], [x, y0 + h + 3.0, 0], 0.03, 0.02, { sides: 5 });
  K.add(mat('iron_wrought'), new THREE.SphereGeometry(0.07, 6, 5), { uv: 'keep', at: matrix(x, y0 + h + 2.5, 0) });
  K.box(mat('iron_wrought'), 0.45, 0.03, 0.03, x, y0 + h + 2.75, 0, { tile: 0.5 });
}

// a little gabled dormer with a leaded window on the front slope at x
function dormer(c, x, tp, oz, H) {
  const { K, S } = c;
  const w = 1.3, zf = oz - 0.4, yb = H + (oz - zf) * tp, y1 = yb + 1.05;
  const zb = oz - (y1 - H) / tp;
  const wm = mat(S.wall), bm = mat(S.beam), rm = mat(S.roof);
  const o = { uvSpace: 'kit', tile: S.wallTile };
  K.box(wm, w, y1 - yb + 0.3, 0.16, x, (yb - 0.3 + y1) / 2, zf - 0.08, { ...o, seg: [1, 2, 1] });
  for (const s of [-1, 1]) {
    K.push(x + s * (w / 2 - 0.06), 0, 0, Math.PI / 2);
    K.prism(wm, [[-zf, yb - 0.15], [-zf, y1], [-(zb - 0.05), y1]], -0.06, 0.12, o);
    K.pop();
    K.box(bm, 0.14, y1 - yb + 0.1, 0.14, x + s * (w / 2 - 0.05), (yb + y1) / 2, zf + 0.02, { tile: 1.2 });
  }
  K.box(bm, w + 0.1, 0.14, 0.14, x, y1 - 0.05, zf + 0.02, { grain: 'x', tile: 1.2 });
  K.quad(winMat(), 0.68, 0.6, x, (yb + y1) / 2 + 0.04, zf + 0.012, { shade: false });
  K.box(bm, 0.8, 0.08, 0.16, x, (yb + y1) / 2 - 0.28, zf + 0.06, { grain: 'x', tile: 1.2 });
  const hw = w / 2 + 0.2, apex = y1 - 0.2 + hw, zr = oz - (apex - H) / tp - 0.15, len = zf + 0.28 - zr;
  for (const s of [-1, 1]) {
    const L = hw * Math.SQRT2 + 0.12, th = -s * Math.PI / 4, n = [-Math.sin(th), Math.cos(th)];
    const cx = x + s * hw / 2, cy = y1 - 0.2 + hw / 2;
    K.add(rm, new THREE.BoxGeometry(L, 0.15, len, 2, 1, 2), { at: matrix(cx + n[0] * 0.075, cy + n[1] * 0.075, zr + len / 2, 0, 0, th), tile: S.roofTile, grain: 'x', flipV: s < 0 });
    K.add(bm, new THREE.BoxGeometry(L, 0.24, 0.08), { at: matrix(cx - n[0] * 0.02, cy - n[1] * 0.02, zf + 0.26, 0, 0, th), tile: 1.2, grain: 'x' });
  }
}

function chimney(c, x, z, surf, apex) {
  const { K, S } = c;
  const big = S.name === 'alpine' ? 1.25 : 1;
  const cm = mat(S.chimney), y0 = surf(x, z) - 0.6, y1 = apex + 0.9;
  K.box(cm, 0.95 * big, y1 - y0, 0.95 * big, x, (y0 + y1) / 2, z, { uvSpace: 'kit', tile: S.baseTile || 2.2, seg: [1, 3, 1], tint: S.baseTint, warp: v => { if (v.y > 0) { v.x *= 0.92; v.z *= 0.92; } } });
  K.box(cm, 1.15 * big, 0.18, 1.15 * big, x, y1 + 0.09, z, { tile: 2.2, tint: S.baseTint });
  K.box(mat('iron_wrought'), 0.6, 0.05, 0.6, x, y1 + 0.2, z, { tile: 1, tint: '#605860' });
  if (S.snow) {
    K.box(mat('snow_roof'), 1.22 * big, 0.16, 1.22 * big, x, y1 + 0.26, z, { tile: 2, seg: [3, 1, 3], warp: v => { v.y += 0.05 * Math.sin(v.x * 6 + v.z * 4); } });
    K.add(mat('snow_roof'), new THREE.SphereGeometry(0.85, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [1.5, 0.6], at: matrix(x, surf(x, z) + 0.15, z, 0.5, 0, 0, new THREE.Vector3(1.15, 0.55, 1.0)) });
  }
  c.smoke = c.world(x, y1 + 0.4, z);
}

// farm barns: big X-braced doors and trim in weathered grey-brown, a hay loft door with a hoist beam,
// spilled hay, a round vent
function barnFront(c, P) {
  const { K, S, oz, dw, dh, R } = c;
  const H = c.RH;
  const dm = mat('planks_barnred'), tm = mat(S.trim || 'wood_white'), tr = S.trimTint || '#ffffff';
  const lw = Math.min(2.0, c.ix - dw - 0.4), lh = Math.min(dh, 3.6);
  for (const s of [-1, 1]) {
    const x = s * (dw + 0.25 + lw / 2);
    K.box(dm, lw, lh, 0.08, x, lh / 2 + 0.05, oz + 0.06, { tile: 2.4, seg: [1, 1, 1] });
    K.box(tm, lw, 0.14, 0.05, x, 0.12, oz + 0.12, { grain: 'x', tint: tr }); K.box(tm, lw, 0.14, 0.05, x, lh - 0.02, oz + 0.12, { grain: 'x', tint: tr });
    K.box(tm, 0.14, lh, 0.05, x - lw / 2 + 0.07, lh / 2 + 0.05, oz + 0.12, { tint: tr }); K.box(tm, 0.14, lh, 0.05, x + lw / 2 - 0.07, lh / 2 + 0.05, oz + 0.12, { tint: tr });
    K.beam(tm, [x - lw / 2 + 0.1, 0.2, oz + 0.12], [x + lw / 2 - 0.1, lh - 0.1, oz + 0.12], 0.13, 0.05, { tint: tr });
    K.beam(tm, [x + lw / 2 - 0.1, 0.2, oz + 0.12], [x - lw / 2 + 0.1, lh - 0.1, oz + 0.12], 0.13, 0.05, { tint: tr });
    for (const y of [lh * 0.25, lh * 0.75]) K.box(mat('iron_wrought'), 0.42, 0.07, 0.03, x - s * (lw / 2 - 0.24), y, oz + 0.15, { tile: 0.5 });
  }
  K.box(mat('iron_wrought'), 2 * (dw + lw + 0.4), 0.08, 0.08, 0, lh + 0.12, oz + 0.1, { grain: 'x', tile: 1 });
  const U = P.under;
  for (let i = 0; i < U.length - 1; i++) K.beam(tm, [U[i][0], U[i][1], oz + 0.07], [U[i + 1][0], U[i + 1][1], oz + 0.07], 0.2, 0.06, { tint: tr, ext: 0.2 });
  K.box(tm, 2 * c.ox + 0.1, 0.2, 0.06, 0, H + 0.02, oz + 0.07, { grain: 'x', tint: tr, seg: [3, 1, 1] });
  const top = c.sign ? c.sign.top + 2.3 : H + 1.6;   // over the sign there's a cartwheel of lanterns first
  if (P.apex - top > 1.8) {
    const hh = Math.min(2.2, P.apex - top - 1.4), lw2 = Math.min(2.2, hh * 1.1);
    // the loft door stands open: a dark opening, one leaf swung back against the boards
    K.quad(mat('iron_wrought'), lw2, hh, 0, top + hh / 2, oz + 0.02, { tint: '#2a1e1a', shade: false });
    K.box(dm, lw2 * 0.5, hh, 0.08, -lw2 * 0.75 - 0.05, top + hh / 2, oz + 0.08, { tile: 2.4, seg: [1, 1, 1] });
    K.beam(tm, [-lw2 - 0.03, top + 0.05, oz + 0.13], [-lw2 / 2 - 0.08, top + hh - 0.05, oz + 0.13], 0.12, 0.05, { tint: tr });
    for (const [x0, y0, x1, y1] of [[-lw2 / 2, top, lw2 / 2, top], [-lw2 / 2, top + hh, lw2 / 2, top + hh], [-lw2 / 2, top, -lw2 / 2, top + hh], [lw2 / 2, top, lw2 / 2, top + hh]]) K.beam(tm, [x0, y0, oz + 0.13], [x1, y1, oz + 0.13], 0.16, 0.05, { tint: tr, ext: 0.16 });
    // hay spilling over the sill, more piled below
    const hay = mat('thatch');
    for (let k = 0; k < 4; k++) K.add(hay, new THREE.SphereGeometry(0.32, 8, 5), { uv: 'keep', uvScale: [1, 0.5], at: matrix(-lw2 * 0.35 + k * lw2 * 0.24, top + 0.12, oz + 0.12, k, 0, 0, new THREE.Vector3(1.2, 0.45, 0.7)), tint: '#d8c890' });
    K.add(hay, new THREE.SphereGeometry(1.0, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [3, 1], at: matrix(dw + lw + 0.9, 0, oz + 1.1, R(), 0, 0, new THREE.Vector3(1.1, 0.55, 0.8)), tint: '#d8c890' });
    K.box(mat(S.beam), 0.28, 0.28, 1.8, 0, top + hh + 0.35, oz + 0.7, { grain: 'z' });
    K.box(mat('iron_wrought'), 0.03, 1.5, 0.03, 0, top + hh - 0.45, oz + 1.45, { tile: 0.5 });
    K.add(mat('wood_light'), new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10), { uv: 'keep', at: matrix(0, top + hh + 0.18, oz + 1.45, 0, 0, Math.PI / 2) });
    K.box(mat('iron_wrought'), 0.22, 0.04, 0.04, 0, top + hh - 1.2, oz + 1.45, { tile: 0.5 });
    const vy = top + hh + 1.1;
    if (P.apex - vy > 0.9) {
      K.add(mat('planks_weathered'), new THREE.CircleGeometry(0.55, 16), { uv: 'keep', at: matrix(0, vy, oz + 0.08), tint: '#5a4a40' });
      K.add(tm, new THREE.TorusGeometry(0.58, 0.07, 6, 18), { uv: 'keep', uvScale: [4, 1], at: matrix(0, vy, oz + 0.1), tint: tr });
      for (let k = 0; k < 4; k++) K.box(tm, 1.1, 0.07, 0.04, 0, vy, oz + 0.1, { rz: k * Math.PI / 4, tint: tr });
    }
  }
}

// ---- frontier: ragged board false fronts, hide roofs on poles, porches, tusks, banners, barricades ------------

const BOARD_TINTS = ['#ffffff', '#f4e8dc', '#e8dccc', '#fff6ea', '#dccbb8', '#f0e0c8'];

// A hide roof sloping along +x of the current frame from (xl, yl) up to (xh, yh) (xh > xl), z from w0
// to w1: thick dark hides sagging between battens, ragged ends, hide flaps hanging off the low edge,
// battens on top, rafter poles under it sticking out.
function shedSlab(c, xl, yl, xh, yh, w0, w1, { th = 0.25, sp = 1.15, sag = 0.15, rag = 0.17, flaps = true } = {}) {
  const { K, R } = c;
  const dx = xh - xl, dy = yh - yl, L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx), len = w1 - w0;
  const nx = -Math.sin(ang), ny = Math.cos(ang), ca = Math.cos(ang), sa = Math.sin(ang);
  const nb = Math.max(2, Math.round(len / sp)), spc = len / nb;
  const cx = (xl + xh) / 2 + nx * th / 2, cy = (yl + yh) / 2 + ny * th / 2, cz = (w0 + w1) / 2;
  K.add(mat('hide_patch'), new THREE.BoxGeometry(L, th, len, 3, 1, nb * 4), {
    at: matrix(cx, cy, cz, 0, 0, ang), tile: 4.4, grain: 'x',
    warp: v => {
      const wz = v.z + len / 2, f = (wz / spc) % 1;
      v.y -= sag * Math.sin(Math.PI * f);
      if (Math.abs(v.x) > L / 2 - 0.01) v.x += Math.sign(v.x) * (hsh(Math.round(wz * 3), Math.sign(v.x) + 5) - 0.5) * 2 * rag;
    },
  });
  const wl = mat('wood_light');
  const at = (s, h) => [xl + ca * s + nx * h, yl + sa * s + ny * h];
  for (let k = 0; k <= nb; k++) {
    const w = w0 + k * spc + (k === 0 ? 0.08 : k === nb ? -0.08 : (R() - 0.5) * 0.12);
    const a = at(-0.15 - R() * 0.3, th + 0.04 - sag * 0.3), b2 = at(L + 0.15 + R() * 0.3, th + 0.04 - sag * 0.3);
    K.cyl(wl, [a[0], a[1], w], [b2[0], b2[1], w + (R() - 0.5) * 0.1], 0.06, 0.05, { sides: 6, tint: '#b09070' });
    const r0 = at(-0.25 - R() * 0.35, -0.1), r1 = at(L + 0.2 + R() * 0.35, -0.1);
    K.cyl(wl, [r0[0], r0[1], w], [r1[0], r1[1], w], 0.09, 0.08, { sides: 7, tint: '#a07c58' });
  }
  if (flaps) {
    const hm = mat('hide_patch', { side: THREE.DoubleSide });
    for (let w = w0 + 0.3; w < w1 - 0.3; w += 0.7 + R() * 0.6) {
      if (R() < 0.4) continue;
      const fw = 0.4 + R() * 0.4, fh = 0.25 + R() * 0.3, p = at(-0.06, th * 0.3);
      K.quad(hm, fw, fh, p[0] - 0.02, p[1] - fh / 2 + 0.04, w, { ry: -Math.PI / 2, rz: (R() - 0.5) * 0.2, uv: 'keep', uvScale: [fw / 4, fh / 4], sx: 2, sy: 2, tint: '#d8c0a8', warp: v => { v.z += 0.05 * Math.sin(v.x * 7 + w); } });
    }
  }
}

// a false front of rough vertical boards from x0 to x1 (building frame), face at z, bottoms at y0,
// tops at topAt(x) (ragged; a couple of boards missing)
function boardFront(c, x0, x1, z, y0, topAt, gaps = 2) {
  const { K, R } = c;
  const bm = mat('board_rough');
  const boards = [];
  let x = x0;
  while (x < x1 - 0.05) { const w = Math.min(x1 - x, 0.24 + R() * 0.14); boards.push([x, w]); x += w; }
  const miss = new Set();
  for (let k = 0; k < gaps && boards.length > 10; k++) miss.add(3 + Math.floor(R() * (boards.length - 6)));
  const base = c.K.shadeFn;
  const shade = (px, py, pz, a, b2, d) => { const k0 = base(px, py, pz, a, b2, d), k = 0.84 + 0.26 * sstep(y0, y0 + 2.6, py); return [k0[0] * k, k0[1] * k, k0[2] * k]; };
  boards.forEach(([bx, w], i) => {
    const xc = bx + w / 2;
    let top = topAt(xc) + (R() - 0.5) * 0.12;
    if (miss.has(i)) top = Math.min(top, y0 + 0.6 + R() * 0.4);
    const h = top - y0;
    K.box(bm, w - 0.014, h, 0.07, xc, y0 + h / 2, z - 0.035 - R() * 0.02, { tile: 1.6, grain: 'y', seg: [1, Math.max(1, Math.ceil(h / 1.2)), 1], tint: BOARD_TINTS[Math.floor(R() * BOARD_TINTS.length)], shade, rz: (R() - 0.5) * 0.03 });
  });
}

// a crown of sharpened stakes along the top of a false front (one missing)
function crownStakes(c, x0, x1, y, z) {
  const { K, R } = c;
  const lw = mat('wood_light');
  const skip = 1 + Math.floor(R() * 4);
  let i = 0;
  for (let x = x0; x <= x1 + 1e-6; x += 0.42 * (0.8 + R() * 0.4), i++) {
    if (i === skip) continue;
    const h = 0.45 + R() * 0.5, lean = (R() - 0.5) * 0.14;
    K.cyl(lw, [x, y - 0.4, z], [x + lean, y + h, z + (R() - 0.5) * 0.05], 0.1, 0.085, { sides: 6, tint: '#a8865e' });
    K.add(lw, new THREE.ConeGeometry(0.085, 0.3, 6), { uv: 'keep', at: matrix(x + lean * 1.06, y + h + 0.14, z, 0, 0, -lean * 0.4), tint: '#c8a478' });
  }
}

// leaning log posts at the four corners, capped just over the roof line (each a little different)
function cornerPosts(c, frontTop, backTop) {
  const { K, R, ox, oz } = c;
  const lw = mat('wood_light');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const top = (sz > 0 ? frontTop : backTop) + 0.25 + R() * 0.35;
    const lx = sx * (0.05 + R() * 0.1), lz = (R() - 0.5) * 0.12;
    const x = sx * (ox + 0.07), z = sz * (oz + 0.07);
    K.tube(lw, [[x, -0.3, z], [x + lx * 0.45, top * 0.5, z + lz * 0.4], [x + lx, top, z + lz]], [0.19, 0.17, 0.15], { sides: 8, tint: '#b08a64', tile: 1.6, uRep: 2 });
    K.add(lw, new THREE.ConeGeometry(0.15, 0.3, 8), { uv: 'keep', at: matrix(x + lx, top + 0.15, z + lz), tint: '#c8a478' });
    K.add(mat('rope'), new THREE.TorusGeometry(0.2, 0.03, 4, 10), { uv: 'keep', uvScale: [3, 1], at: matrix(x + lx * 0.3, top * 0.32, z, 0, Math.PI / 2) });
  }
}

// a porch roof of hides on crooked poles lashed with rope (front-wall frame: z = 0 at the wall)
function porch(c, x0, x1, y, depth, drop) {
  const { K, R } = c;
  const w = x1 - x0, xc = (x0 + x1) / 2;
  const L = Math.hypot(depth, drop), ang = Math.atan2(drop, depth);
  const nseg = Math.max(2, Math.round(w / 1.4));
  K.push(xc, y, 0.05, 0, ang);
  K.box(mat('hide_patch'), w, 0.12, L, 0, 0.06, L / 2, { uv: 'planar', tile: 3.8, grain: 'z', seg: [nseg * 3, 1, 3], tint: '#e8d4c0',
    warp: v => { const f = ((v.x + w / 2) / (w / nseg)) % 1; v.y -= 0.12 * Math.sin(Math.PI * f) * Math.sin(Math.PI * (v.z / L + 0.5)) + 0.02; } });
  K.pop();
  const wl = mat('wood_light'), yb = y - drop;
  const bpts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; bpts.push([x0 - 0.25 + (w + 0.5) * t, yb - 0.06 - 0.05 * Math.sin(Math.PI * t) + (R() - 0.5) * 0.04, depth + 0.04 + (R() - 0.5) * 0.06]); }
  K.tube(wl, bpts, 0.09, { sides: 7, tint: '#a8865e', tile: 1.6 });
  const xs = [x0 + 0.15, x1 - 0.15];
  for (let x = x0 + 2.6; x < x1 - 1.8; x += 2.6 + R() * 0.5) if (Math.abs(x) > c.dw + 0.55) xs.push(x);
  for (const x of xs) {
    const jx = (R() - 0.5) * 0.16, jz = (R() - 0.5) * 0.12;
    K.tube(wl, [[x + jx, -0.25, depth + jz], [x + jx * 0.3 + (R() - 0.5) * 0.06, yb * 0.5, depth + (R() - 0.5) * 0.06], [x, yb, depth + 0.02]], [0.11, 0.1, 0.09], { sides: 7, tint: '#9a7a56', tile: 1.6 });
    for (let k = 0; k < 3; k++) K.add(mat('rope'), new THREE.TorusGeometry(0.11, 0.024, 4, 9), { uv: 'keep', uvScale: [3, 1], at: matrix(x, yb - 0.14 - k * 0.055, depth + 0.02, k * 0.7, Math.PI / 2 + (R() - 0.5) * 0.25) });
  }
  for (let x = x0 + 0.5; x < x1 - 0.3; x += 1.4) K.cyl(wl, [x, y + 0.02, 0.04], [x + (R() - 0.5) * 0.1, yb + 0.02, depth + 0.1], 0.05, 0.045, { sides: 6, tint: '#a8865e' });
  K.cyl(wl, [x0, y + 0.06, 0.08], [x1, y + 0.06, 0.08], 0.07, 0.07, { sides: 7, tint: '#9a7a56' });
}

// rust-red hide banners hung on sticks against a false front
function hideBanners(c, xs, yTop, z) {
  const { K } = c;
  const m = bannerMat('banner_hide');
  for (const x of xs) {
    K.quad(m, 0.78, 1.4, x, yTop - 0.7, z, { shade: () => 0.95 });
    K.cyl(mat('wood_light'), [x - 0.5, yTop + 0.02, z + 0.02], [x + 0.5, yTop + 0.04, z + 0.02], 0.035, 0.035, { sides: 5, tint: '#a8865e' });
  }
}

// a tall banner pole (building frame): a crooked pole, a crossbar, a painted hide banner, feathers and a
// skull lashed on, a ring of stones at its foot
function bannerPole(c, x, z, h) {
  const { K, R } = c;
  const wl = mat('wood_light'), lean = [(R() - 0.5) * 0.25, (R() - 0.5) * 0.2];
  const top = [x + lean[0], h, z + lean[1]];
  K.tube(wl, [[x, -0.4, z], [x + lean[0] * 0.4, h * 0.5, z + lean[1] * 0.4], top], [0.13, 0.11, 0.08], { sides: 7, tint: '#9a7a56', tile: 1.6 });
  const by = h - 0.35;
  K.cyl(wl, [top[0] - 0.62, by, top[2]], [top[0] + 0.62, by + 0.04, top[2]], 0.045, 0.04, { sides: 6, tint: '#a8865e' });
  K.quad(bannerMat('banner_hide'), 1.0, 1.9, top[0], by - 0.95, top[2] + 0.06, { shade: () => 0.95, ry: (R() - 0.5) * 0.3 });
  K.add(mat('bone'), new THREE.SphereGeometry(0.15, 8, 6), { uv: 'keep', at: matrix(top[0], h + 0.05, top[2], 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)) });
  for (const s of [-1, 1]) K.add(mat('bone'), new THREE.ConeGeometry(0.05, 0.42, 6), { uv: 'keep', at: matrix(top[0] + s * 0.22, h + 0.18, top[2], 0, 0, s * -1.1) });
  for (let k = 0; k < 3; k++) K.add(mat('wood_light'), new THREE.ConeGeometry(0.05, 0.5, 4), { uv: 'keep', at: matrix(top[0] + 0.62 - k * 0.05, by - 0.3, top[2], 0, 0, 0.2 + k * 0.15), tint: ['#e8dcc8', '#a83a2a', '#2a2420'][k] });
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; K.add(mat('granite_block'), new THREE.DodecahedronGeometry(0.16 + R() * 0.08, 0), { uv: 'keep', uvScale: [0.3, 0.3], at: matrix(x + Math.cos(a) * 0.32, 0.05, z + Math.sin(a) * 0.32, a), tint: '#c08a6a' }); }
}

// a spiked log barricade (building frame) along the angle ry: two X-frames of sharpened logs on a rail,
// lashed with rope
function barricade(c, x, z, ry, len = 3) {
  const { K, R } = c;
  const wl = mat('wood_light');
  K.push(x, 0, z, ry);
  K.cyl(wl, [-len / 2, 0.75, 0], [len / 2, 0.78, 0], 0.13, 0.12, { sides: 8, tint: '#a07c58' });
  for (let k = 0; k <= 2; k++) {
    const px = -len / 2 + 0.2 + (len - 0.4) * k / 2;
    for (const s of [-1, 1]) {
      const a = [px + (R() - 0.5) * 0.1, -0.1, -s * 0.75], b = [px + (R() - 0.5) * 0.1, 1.75 + R() * 0.3, s * 0.75];
      K.cyl(wl, a, b, 0.1, 0.075, { sides: 7, tint: '#b08a64' });
      K.add(wl, new THREE.ConeGeometry(0.075, 0.3, 7), { uv: 'keep', at: matrix(b[0] + (b[0] - a[0]) * 0.08, b[1] + 0.11, b[2] + s * 0.11, 0, s * 0.72, 0), tint: '#c8a478' });
    }
    K.add(mat('rope'), new THREE.TorusGeometry(0.17, 0.03, 4, 10), { uv: 'keep', uvScale: [3, 1], at: matrix(px, 0.8, 0, Math.PI / 2, 0.4) });
  }
  K.pop();
}

// a gateway of two huge curved tusks (building frame), bases at x = ±span/2 on z, meeting over the path
function tuskArch(c, z, span, h) {
  const { K } = c;
  const bone = mat('bone');
  for (const s of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push([s * (span / 2 - span * 0.45 * Math.pow(t, 1.6)) + s * Math.sin(t * Math.PI) * 0.6, -0.3 + (h + 0.3) * Math.sin(t * Math.PI / 2), z + 0.25 * Math.sin(t * Math.PI)]); }
    K.tube(bone, pts, t => 0.32 * (1 - t * 0.85) + 0.03, { sides: 9, tile: 1.2, uRep: 2 });
    for (let k = 0; k < 3; k++) K.add(mat('rope'), new THREE.TorusGeometry(0.34, 0.04, 5, 12), { uv: 'keep', uvScale: [3, 1], at: matrix(s * span / 2 + s * 0.06 * k, 0.4 + k * 0.12, z, 0, Math.PI / 2, s * 0.2) });
    K.add(mat('granite_block'), new THREE.DodecahedronGeometry(0.5, 0), { uv: 'keep', uvScale: [0.6, 0.6], at: matrix(s * span / 2, 0.05, z, s, 0, 0, new THREE.Vector3(1.2, 0.6, 1)), tint: '#c08a6a' });
  }
  // a horned skull where they meet, a hide banner hanging from it
  K.add(bone, new THREE.SphereGeometry(0.3, 10, 8), { uv: 'keep', at: matrix(0, h + 0.1, z + 0.2, 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)) });
  K.add(bone, new THREE.BoxGeometry(0.28, 0.2, 0.3), { uv: 'keep', at: matrix(0, h - 0.12, z + 0.42) });
  for (const s of [-1, 1]) K.tube(bone, [[s * 0.22, h + 0.2, z + 0.15], [s * 0.6, h + 0.45, z + 0.1], [s * 0.75, h + 0.85, z]], [0.09, 0.06, 0.015], { sides: 6 });
  K.quad(bannerMat('banner_hide'), 0.9, 1.5, 0, h - 0.95, z + 0.36, { shade: () => 0.95 });
}

// a balcony deck on posts in front of the wall (front-wall frame), with a stick rail and two doors onto it
function balcony(c, x0, x1, y, depth) {
  const { K, R } = c;
  const fl = mat('floor_planks'), wl = mat('wood_light'), bm = mat(c.S.beam);
  const w = x1 - x0, xc = (x0 + x1) / 2;
  K.box(fl, w, 0.1, depth, xc, y, depth / 2, { tile: 2.4, grain: 'z' });
  for (let x = x0 + 0.3; x < x1; x += 0.9) K.box(bm, 0.12, 0.18, depth + 0.12, x, y - 0.14, depth / 2, { grain: 'z' });
  K.box(bm, w + 0.2, 0.22, 0.16, xc, y - 0.1, depth, { grain: 'x', seg: [4, 1, 1] });
  const posts = [x0 + 0.2, x1 - 0.2];
  if (w > 6) posts.push(-2.3, 2.3);
  for (const x of posts) {
    K.tube(wl, [[x + (R() - 0.5) * 0.1, -0.25, depth - 0.12], [x + (R() - 0.5) * 0.08, y * 0.5, depth - 0.1], [x, y - 0.2, depth - 0.1]], [0.12, 0.11, 0.1], { sides: 7, tint: '#9a7a56', tile: 1.6 });
    for (let k = 0; k < 3; k++) K.add(mat('rope'), new THREE.TorusGeometry(0.13, 0.025, 4, 9), { uv: 'keep', uvScale: [3, 1], at: matrix(x, y - 0.4 - k * 0.06, depth - 0.1, k, Math.PI / 2) });
  }
  const ry = y + 0.05, rz = depth - 0.07;
  K.cyl(wl, [x0, ry + 0.95, rz], [x1, ry + 0.95, rz], 0.05, 0.05, { sides: 6, tint: '#a8865e' });
  K.cyl(wl, [x0, ry + 0.15, rz], [x1, ry + 0.15, rz], 0.04, 0.04, { sides: 6, tint: '#a8865e' });
  for (const x of [x0 + 0.04, x1 - 0.04]) K.cyl(wl, [x, ry + 0.95, 0.08], [x, ry + 0.95, rz], 0.045, 0.045, { sides: 6, tint: '#a8865e' });
  for (let x = x0 + 0.05; x <= x1 - 0.04; x += 0.28) K.box(wl, 0.05, 0.86, 0.05, x + (R() - 0.5) * 0.04, ry + 0.52, rz, { tint: '#b89470', rz: (R() - 0.5) * 0.06, seg: [1, 1, 1] });
  for (const s of [-1, 1]) {
    K.quad(mat('door_plank'), 0.9, 1.5, s * 2.6, y + 0.06 + 0.75, 0.03, { uv: 'keep' });
    K.box(bm, 1.1, 0.14, 0.14, s * 2.6, y + 1.66, 0.06, { grain: 'x' });
  }
}

// a short palisade of sharpened stakes from (x0, z) to (x1, z): spacing, height and lean all jittered
function palisade(c, x0, x1, z) {
  const { K, R } = c;
  const lw = mat('wood_light'), s = Math.sign(x1 - x0) || 1;
  for (let x = x0; s * x <= s * x1; x += s * 0.36 * (0.75 + R() * 0.5)) {
    const h = 2.0 + (R() - 0.5) * 1.0 + 0.3, lean = (R() - 0.5) * 0.21, lz = (R() - 0.5) * 0.18;
    K.cyl(lw, [x, -0.2, z], [x + lean * h, h, z + lz], 0.12 + R() * 0.04, 0.11, { sides: 7, tint: R() < 0.3 ? '#9a7a56' : '#a88660' });
    K.add(lw, new THREE.ConeGeometry(0.12, 0.4, 7), { uv: 'keep', at: matrix(x + lean * h * 1.04, h + 0.2, z + lz, 0, 0, -lean), tint: '#c8a478' });
  }
  for (const y of [0.7, 1.55]) K.cyl(mat(c.S.beam), [x0 - s * 0.1, y, z + 0.16], [x1 + s * 0.1, y + (R() - 0.5) * 0.08, z + 0.16], 0.06, 0.06, { sides: 6 });
}

function frontierRoof(c) {
  if (c.b.kind === 'casino') frontierHall(c); else frontierShed(c);
}

// pawn, store, gas: a hide shed roof rising to the back behind a ragged plank false front
function frontierShed(c) {
  const { K, S, ox, oz, H, sign, b, dw } = c;
  const ta = Math.tan(S.pitch * D2R);
  const zLow = oz - 0.28, yLow = H + 0.3, zHigh = -oz - 0.75, yHigh = yLow + (zLow - zHigh) * ta;
  const yRoof = z => yLow + (zLow - z) * ta;
  K.push(0, 0, 0, Math.PI / 2);
  shedSlab(c, -zLow, yLow, -zHigh, yHigh, -ox - 0.6, ox + 0.6, { flaps: false });
  const wm = mat(S.wall), wo = { uvSpace: 'kit', tile: S.wallTile, uvOff: [c.wallO.uvOff[0], 0] };
  const tri = [[oz, H - 0.01], [-oz, H - 0.01], [-oz, yRoof(-oz) + 0.04], [oz, yRoof(oz) + 0.04]].map(([z, y]) => [-z, y]);
  K.prism(wm, tri, ox - 0.3, 0.3, wo);
  K.prism(wm, tri, -ox, 0.3, wo);
  K.pop();
  K.box(wm, 2 * ox, yRoof(-oz) - H + 0.04, 0.3, 0, (H + yRoof(-oz) + 0.04) / 2, -oz + 0.15, { ...wo, seg: [4, 3, 1] });
  if (S.logEnds) logEnds(c, H, yRoof(-oz));
  // the false front
  const T0 = Math.max(sign ? sign.top + 0.55 : H + 1.6, yLow + 1.3);
  const cw = sign ? sign.w / 2 + 0.45 : Math.max(1.6, ox * 0.42), step = Math.min(0.9, (T0 - yLow) * 0.45);
  const topAt = x => { const a = Math.abs(x); return a < cw ? T0 : a < cw + 0.9 ? T0 - step * 0.55 : T0 - step - (a > ox - 0.7 ? 0.3 : 0); };
  boardFront(c, -ox - 0.02, ox + 0.02, oz + 0.02, H - 0.35, topAt);
  const bm = mat(S.beam);
  for (const y of [H + 0.55, T0 - step - 0.45]) K.box(bm, 2 * ox, 0.14, 0.08, 0, y, oz - 0.1, { grain: 'x', tile: 1.2 });
  K.box(mat('board_rough'), 2 * cw + 0.1, 0.2, 0.06, 0, T0 - 0.32, oz + 0.05, { grain: 'x', tint: '#d8c8b0' });
  crownStakes(c, -cw + 0.2, cw - 0.2, T0 - 0.25, oz - 0.1);
  for (const s of [-1, 1]) for (const tilt of [-0.45, 0.45]) {
    const x = s * (cw + 0.25), y0 = T0 - step - 0.4;
    c.K.cyl(mat('wood_light'), [x - Math.sin(tilt) * 0.3, y0, oz + 0.12], [x + Math.sin(tilt) * 1.1, y0 + Math.cos(tilt) * 1.25, oz + 0.2], 0.07, 0.05, { sides: 6, tint: '#a8865e' });
  }
  c.signZ = oz + 0.06; c.apex = T0; c.frontTop = T0;
  cornerPosts(c, T0 - step - 0.3, yRoof(-oz) + 0.25);
  onWall(c, 'front', () => {
    if (b.kind === 'gas') porch(c, -(dw + 1.6), dw + 1.6, c.dh + 0.55, 1.6, 0.55);
    else porch(c, -c.ox + 0.35, c.ox - 0.35, Math.min(c.dh + 0.55, sign ? sign.bottom - 0.25 : H), 2.0, 0.6);
  });
  if (cw + 0.95 < ox - 0.3) hideBanners(c, [-(cw + 0.55), cw + 0.55], T0 - step * 0.55 - 0.25, oz + 0.07);
}

// the casino: a two-storey central hall behind a tall false front with a balcony, lean-to wings either side
function frontierHall(c) {
  const { K, S, ox, oz, H, sign, R } = c;
  const cw2 = Math.min(ox - 2.6, (sign ? sign.w / 2 : 3) + 0.8);
  const yC = H + 2.5;
  const wm = mat(S.wall), wo = { uvSpace: 'kit', tile: S.wallTile };
  for (const s of [-1, 1]) K.box(wm, 0.26, yC - H, 2 * oz - 0.3, s * (cw2 - 0.13), (H + yC) / 2, -0.15, { ...wo, seg: [1, 3, 6] });
  K.box(wm, 2 * cw2, yC - H, 0.3, 0, (H + yC) / 2, -oz + 0.15, { ...wo, seg: [4, 3, 1] });
  const P = profileOf(c, cw2, 'gable', 26, 0.55, yC);
  roofSlabs(c, P, -oz - 0.55, oz - 0.15, { roofMat: 'hide_patch', thick: 0.25, barge: false, hs: cw2 });
  gableFill(c, P, -oz, -1); gableFill(c, P, oz - 0.15, 1);
  const yHi = H + 1.9, yLo = H + 0.05, slope = (yHi - yLo) / (ox - cw2), yEnd = yLo - slope * 0.6;
  shedSlab(c, -(ox + 0.6), yEnd, -cw2, yHi, -oz - 0.6, oz - 0.2);
  K.push(0, 0, 0, Math.PI);
  shedSlab(c, -(ox + 0.6), yEnd, -cw2, yHi, -(oz - 0.2), oz + 0.6);
  K.pop();
  for (const s of [-1, 1]) K.prism(wm, [[cw2, H - 0.01], [ox, H - 0.01], [ox, yLo + 0.04], [cw2, yHi + 0.04]].map(([x, y]) => [s * x, y]), -oz, 0.3, wo);
  const T0 = Math.max(sign ? sign.top + 0.6 : yC + 1.2, yC + 0.9);
  const wingTop = x => { const t = (Math.abs(x) - cw2) / (ox - cw2); return t < 0.33 ? yHi + 0.55 : t < 0.7 ? yHi - 0.15 : yLo + 1.15; };
  const topAt = x => Math.abs(x) < cw2 - 0.5 ? T0 : Math.abs(x) < cw2 + 0.3 ? T0 - 0.55 : wingTop(x);
  boardFront(c, -ox - 0.02, ox + 0.02, oz + 0.02, H - 0.02, topAt, 3);
  const bm = mat(S.beam);
  for (const y of [H + 0.6, yHi - 0.3]) K.box(bm, 2 * ox, 0.14, 0.08, 0, y, oz - 0.1, { grain: 'x', tile: 1.2, seg: [6, 1, 1] });
  K.box(bm, 2 * cw2 - 0.8, 0.14, 0.08, 0, T0 - 0.6, oz - 0.1, { grain: 'x', tile: 1.2 });
  K.box(mat('board_rough'), 2 * cw2 - 0.9, 0.22, 0.06, 0, T0 - 0.34, oz + 0.05, { grain: 'x', tint: '#d8c8b0' });
  crownStakes(c, -cw2 + 0.7, cw2 - 0.7, T0 - 0.25, oz - 0.1);
  c.signZ = oz + 0.06; c.apex = P.apex; c.frontTop = T0;
  cornerPosts(c, wingTop(ox), yLo + 0.25);
  const lw = mat('wood_light');
  for (const s of [-1, 1]) {
    const x = s * (cw2 + 0.32), z = oz + 0.12, lx = s * (0.04 + R() * 0.06), top = T0 - 0.55 + 0.35 + R() * 0.3;
    K.tube(lw, [[x, -0.3, z], [x + lx * 0.5, top * 0.5, z], [x + lx, top, z]], [0.21, 0.19, 0.17], { sides: 8, tint: '#b08a64', tile: 1.6, uRep: 2 });
    K.add(lw, new THREE.ConeGeometry(0.17, 0.32, 8), { uv: 'keep', at: matrix(x + lx, top + 0.16, z), tint: '#c8a478' });
  }
  onWall(c, 'front', () => {
    balcony(c, -cw2 + 0.35, cw2 - 0.35, 3.5, 1.8);
    porch(c, -ox + 0.4, -cw2 - 0.25, 3.1, 1.8, 0.55);
    porch(c, cw2 + 0.25, ox - 0.4, 3.1, 1.8, 0.55);
  });
  const bx = sign ? sign.w / 2 + 0.5 : 3;
  if (bx + 0.4 < cw2 + 0.2) hideBanners(c, [-bx, bx], T0 - 0.65, oz + 0.07);
}

// ---- adobe: battered walls, lumpy parapets, stacked blocks, a turret, goblin tech ----------------------

// lumpy round mud caps along a path of points (building frame), with a knob at every joint
function mudCaps(c, m, path, r = 0.17) {
  const { K } = c;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], bb = path[i + 1];
    const L = Math.hypot(bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]);
    if (L < 0.02) continue;
    const n = Math.max(2, Math.ceil(L / 0.3)), pts = [];
    for (let k = 0; k <= n; k++) { const t = k / n; pts.push([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t]); }
    K.tube(m, pts, (t, ang, k) => r + 0.05 * Math.sin((k + i * 7) * 1.7 + ang * 2) * Math.sin((k + i * 3) * 0.61 + 1), { sides: 7, caps: false, tile: 1.2 });
    K.add(m, new THREE.SphereGeometry(r + 0.02, 8, 6), { uv: 'keep', at: matrix(bb[0], bb[1], bb[2]) });
  }
}

// a viga poking out of a wall (wall frame): a peeled round beam, its sawn end showing pale end grain
function viga(c, x, y, out, r) {
  const { K, R } = c;
  const tip = [x + (R() - 0.5) * 0.06, y + (R() - 0.5) * 0.06, out];
  K.cyl(mat('wood_light'), [x, y, -0.25], tip, r, r * 0.92, { sides: 8, tint: '#e8d0b0' });
  K.add(mat('endgrain'), new THREE.CircleGeometry(r * 0.94, 8), { uv: 'keep', at: matrix(tip[0], tip[1], tip[2] + 0.004, 0, 0, R() * 3) });
}

function flatRoof(c) {
  const { K, S, ox, oz, ix, iz, H, sign, b, R, D, W } = c;
  const am = mat(S.wall), pm = mat('adobe_inner'), o = { uvSpace: 'kit', tile: S.wallTile, seg: [1, 1, 1], uvOff: c.wallO.uvOff };
  K.box(pm, 2 * ix + 0.3, 0.2, 2 * iz + 0.3, 0, H + 0.1, 0, { tile: 3, tint: '#b89878', seg: [1, 1, 1] });
  const ph = 0.7, yp = H + ph;
  K.box(am, 2 * ix, ph, 0.3, 0, H + ph / 2, -D / 2, o);
  for (const s of [-1, 1]) K.box(am, 0.3, ph, 2 * iz, s * W / 2, H + ph / 2, 0, o);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) quarter(c, am, sx, sz, H, yp, 0.3, o);
  const top = Math.max(sign ? sign.top + 0.45 : H + 1.4, H + 1.2);
  const cw = Math.max(sign ? sign.w / 2 + 0.35 : 1.6, 1.4);
  const mid = yp + (top - yp) * 0.5;
  const pts = [[-ix, H - 0.01], [ix, H - 0.01], [ix, yp], [cw + 0.9, yp], [cw + 0.9, mid], [cw, mid], [cw, top], [-cw, top], [-cw, mid], [-cw - 0.9, mid], [-cw - 0.9, yp], [-ix, yp]];
  K.prism(am, pts, iz, 0.3, { uvSpace: 'kit', tile: S.wallTile });
  const r0 = 0.15, loop = [];
  const arc = (cx, cz, a0, a1) => { for (let k = 0; k <= 3; k++) { const a = a0 + (a1 - a0) * k / 3; loop.push([cx + Math.sin(a) * r0, yp, cz + Math.cos(a) * r0]); } };
  arc(-ix, iz, 0, -Math.PI / 2); arc(-ix, -iz, -Math.PI / 2, -Math.PI); arc(ix, -iz, Math.PI, Math.PI / 2); arc(ix, iz, Math.PI / 2, 0);
  mudCaps(c, pm, loop);
  const zf = iz + 0.15;
  mudCaps(c, pm, [[ix, yp, zf], [cw + 0.9, yp, zf], [cw + 0.9, mid, zf], [cw, mid, zf], [cw, top, zf], [-cw, top, zf], [-cw, mid, zf], [-cw - 0.9, mid, zf], [-cw - 0.9, yp, zf], [-ix, yp, zf]]);
  K.box(mat('brass'), 2 * cw + 0.2, 0.1, 0.36, 0, top - 0.34, oz - 0.12, { grain: 'x', tile: 1 });
  // vigas poking out of the walls under the parapet: thick, pale, unevenly spaced, some missing
  for (const side of ['front', 'left', 'right', 'back']) onWall(c, side, f => {
    let x = -f.len / 2 + 0.6 + R() * 0.3;
    while (x < f.len / 2 - 0.55) {
      if (!(side === 'front' && Math.abs(x) < cw + 0.4) && R() > 0.15) viga(c, x, H - 0.3, 0.6 + R() * 0.5, 0.15 + R() * 0.03);
      x += 1.0 * (0.75 + R() * 0.5);
    }
  });
  c.signZ = oz + 0.1;
  c.apex = top;
  // goblin plumbing on every roof: a water tank on legs, piped down the side wall
  const tx = b.kind === 'casino' ? -ix * 0.72 : b.kind === 'store' ? ix * 0.6 : ix * 0.5 * (b.id % 2 ? 1 : -1), tz = b.kind === 'casino' ? -iz * 0.6 : -iz * 0.45;
  waterTank(c, tx, tz, H + 0.2);
  tankPipe(c, tx, tz, H + 0.2, yp);
  if (b.kind === 'store' || b.kind === 'casino') {
    const bw = 2 * ix * 0.6, bd = 2 * iz * 0.56, bx = b.kind === 'casino' ? ix * 0.12 : -ix * 0.18, bz = -iz + bd / 2 + 0.25;
    const hb = b.kind === 'casino' ? 2.6 : 2.2;
    upperBlock(c, bx, bz, bw, bd, H + 0.2, hb);
    if (b.kind === 'casino') dome(c, bx, H + 0.2 + hb, bz, Math.min(bw, bd) * 0.36);
  }
  if (b.kind === 'casino') turret(c);
}

function upperBlock(c, bx, bz, bw, bd, y0, hb) {
  const { K, S, R } = c;
  const am = mat('adobe_inner'), o = { uvSpace: 'kit', tile: S.wallTile };
  roundedBox(c, am, bx, y0 - 0.1, bz, bw, hb + 0.1, bd, 0.45, o);
  const y1 = y0 + hb, r = 0.45, loop = [];
  const corners = [[bx - bw / 2 + r, bz + bd / 2 - r, 0, -Math.PI / 2], [bx - bw / 2 + r, bz - bd / 2 + r, -Math.PI / 2, -Math.PI], [bx + bw / 2 - r, bz - bd / 2 + r, Math.PI, Math.PI / 2], [bx + bw / 2 - r, bz + bd / 2 - r, Math.PI / 2, 0]];
  for (const [cx, cz, a0, a1] of corners) for (let k = 0; k <= 3; k++) { const a = a0 + (a1 - a0) * k / 3; loop.push([cx + Math.sin(a) * (r - 0.12), y1, cz + Math.cos(a) * (r - 0.12)]); }
  loop.push(loop[0]);
  mudCaps(c, am, loop, 0.16);
  const zf = bz + bd / 2;
  K.quad(mat('door_plank'), 0.95, 1.7, bx - bw * 0.2, y0 + 0.85, zf + 0.012, { uv: 'keep', tint: '#8a6a58' });
  K.box(mat('brass'), 1.15, 0.08, 0.12, bx - bw * 0.2, y0 + 1.76, zf + 0.04, { tile: 1 });
  K.add(winMat(), new THREE.CircleGeometry(0.34, 16), { uv: 'keep', at: matrix(bx + bw * 0.2, y0 + 1.2, zf + 0.012), shade: false });
  K.add(mat('brass'), new THREE.TorusGeometry(0.38, 0.07, 5, 16), { uv: 'keep', at: matrix(bx + bw * 0.2, y0 + 1.2, zf + 0.04) });
  K.push(0, 0, zf);
  for (let x = bx - bw / 2 + 0.6; x < bx + bw / 2 - 0.5; x += 0.9 + R() * 0.4) viga(c, x, y0 + hb - 0.3, 0.45 + R() * 0.35, 0.13);
  K.pop();
}

function dome(c, x, y, z, r) {
  const { K } = c;
  const am = mat('adobe_inner'), br = mat('brass');
  K.cyl(am, [x, y - 0.1, z], [x, y + 0.45, z], r + 0.15, r + 0.1, { sides: 16 });
  K.add(am, new THREE.SphereGeometry(r, 16, 8, 0, TAU, 0, Math.PI / 2), { uv: 'keep', uvScale: [4, 1.5], at: matrix(x, y + 0.4, z) });
  K.cyl(br, [x, y + 0.3 + r, z], [x, y + 0.3 + r + 1.6, z], 0.12, 0.03, { sides: 8 });
  K.add(br, new THREE.SphereGeometry(0.22, 10, 8), { uv: 'keep', at: matrix(x, y + r + 0.8, z) });
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.cyl(br, [x + Math.cos(a) * (r + 0.02), y + 0.45, z + Math.sin(a) * (r + 0.02)], [x + Math.cos(a) * 0.15, y + 0.4 + r, z + Math.sin(a) * 0.15], 0.04, 0.04, { sides: 5 }); }
}

// the casino's round corner tower: mud, brass bands, portholes, and a riveted red cone cap ringed with
// brass spikes, a gear and a lightning-rod spire on top
function turret(c) {
  const { K, ox, oz, H } = c;
  const am = mat('adobe_inner'), br = mat('brass'), red = mat('metal_red');
  const tx = -(ox - 1.05), tz = oz - 1.15, r = 1.45, y0 = H + 0.1, y1 = H + 4.4;
  K.cyl(am, [tx, y0, tz], [tx, y1, tz], r, r * 0.93, { sides: 16, hseg: 4, uvScale: [3, (y1 - y0) / 3.2],
    warp: v => { const k = 1 + 0.025 * Math.sin(Math.atan2(v.z, v.x) * 5 + v.y * 1.7); v.x *= k; v.z *= k; } });
  K.add(br, new THREE.TorusGeometry(r + 0.02, 0.08, 6, 24), { uv: 'keep', uvScale: [8, 1], at: matrix(tx, y0 + 0.15, tz, 0, Math.PI / 2) });
  K.add(br, new THREE.TorusGeometry(r * 0.94, 0.11, 6, 24), { uv: 'keep', uvScale: [8, 1], at: matrix(tx, y1 - 0.05, tz, 0, Math.PI / 2) });
  K.cyl(red, [tx, y1 - 0.1, tz], [tx, y1 + 2.4, tz], r * 1.08, 0.12, { sides: 16, hseg: 3, uvScale: [5, 2] });
  for (const k of [0.3, 0.62]) K.add(br, new THREE.TorusGeometry(r * 1.08 * (1 - k) + 0.12 * k + 0.02, 0.05, 5, 22), { uv: 'keep', uvScale: [6, 1], at: matrix(tx, y1 - 0.1 + 2.5 * k, tz, 0, Math.PI / 2) });
  for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; K.add(br, new THREE.ConeGeometry(0.07, 0.42, 6), { uv: 'keep', at: matrix(tx + Math.cos(a) * r * 1.06, y1 + 0.08, tz + Math.sin(a) * r * 1.06, -a, 0, -1.0) }); }
  K.cyl(br, [tx, y1 + 2.3, tz], [tx, y1 + 3.6, tz], 0.06, 0.02, { sides: 6 });
  K.add(br, new THREE.SphereGeometry(0.14, 10, 8), { uv: 'keep', at: matrix(tx, y1 + 2.7, tz) });
  gear(c, tx + 0.3, y1 + 1.1, tz + r * 0.62, 0.42, 0.55);
  for (const a of [0.45, -0.4, -1.25, 2.4]) {
    const rr = r * 0.97 + 0.02, px = tx + Math.sin(a) * rr, pz = tz + Math.cos(a) * rr, py = y0 + 2.3;
    K.add(winMat(), new THREE.CircleGeometry(0.32, 14), { uv: 'keep', at: matrix(px, py, pz, a), shade: false });
    K.add(br, new THREE.TorusGeometry(0.36, 0.06, 5, 16), { uv: 'keep', at: matrix(px, py, pz, a) });
  }
}

// a brass gear (current frame) at (x, y, z) facing +z turned by ry
function gear(c, x, y, z, r, ry = 0, teeth = 10) {
  const { K } = c;
  const br = mat('brass');
  K.push(x, y, z, ry);
  K.add(br, new THREE.CylinderGeometry(r, r, 0.08, 18), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2) });
  for (let k = 0; k < teeth; k++) { const a = k / teeth * TAU; K.box(br, r * 0.26, r * 0.26, 0.08, Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08, 0, { rz: a, tile: 1 }); }
  K.add(mat('iron_wrought'), new THREE.CylinderGeometry(r * 0.28, r * 0.28, 0.14, 10), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2) });
  K.pop();
}

function waterTank(c, x, z, y) {
  const { K } = c;
  const iron = mat('iron_wrought'), br = mat('brass'), red = mat('metal_red');
  for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + 0.4; K.beam(iron, [x + Math.cos(a) * 0.55, y, z + Math.sin(a) * 0.55], [x + Math.cos(a) * 0.45, y + 0.85, z + Math.sin(a) * 0.45], 0.07, 0.07); }
  K.cyl(red, [x, y + 0.85, z], [x, y + 2.0, z], 0.66, 0.66, { sides: 14, uvScale: [3, 1] });
  for (const yy of [y + 0.95, y + 1.45, y + 1.9]) K.add(br, new THREE.TorusGeometry(0.67, 0.035, 5, 18), { uv: 'keep', uvScale: [6, 1], at: matrix(x, yy, z, 0, Math.PI / 2) });
  K.add(br, new THREE.ConeGeometry(0.72, 0.5, 14), { uv: 'keep', uvScale: [3, 1], at: matrix(x, y + 2.25, z) });
  K.cyl(br, [x, y + 2.5, z], [x, y + 2.75, z], 0.05, 0.05, { sides: 6 });
  K.add(br, new THREE.CylinderGeometry(0.34, 0.34, 0.06, 14), { uv: 'keep', at: matrix(x - 0.69, y + 1.4, z, 0, 0, Math.PI / 2) });
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.box(br, 0.06, 0.1, 0.1, x - 0.69, y + 1.4 + Math.sin(a) * 0.37, z + Math.cos(a) * 0.37, { rx: -a, tile: 1 }); }
}

// a fat brass pipe from the tank, over the parapet and down the nearest side wall into a valve box
function tankPipe(c, x, z, y, yp) {
  const { K, ox } = c;
  const br = mat('brass');
  const s = x >= 0 ? 1 : -1, wx = s * (ox + 0.2), r = 0.12;
  const pts = [[x + s * 0.5, y + 0.95, z], [x + s * 0.9, y + 0.5, z], [s * (ox - 0.6), y + 0.5, z], [s * (ox - 0.2), yp + 0.35, z], [wx, yp + 0.2, z], [wx, yp - 0.3, z], [wx, 1.0, z], [wx, 0.55, z + 0.25]];
  K.tube(br, pts, r, { sides: 8, tile: 1.4 });
  for (let yy = 1.2; yy < yp - 0.4; yy += 0.9) K.add(br, new THREE.TorusGeometry(r + 0.03, 0.03, 5, 10), { uv: 'keep', at: matrix(wx, yy, z, 0, Math.PI / 2) });
  K.box(mat('metal_green'), 0.5, 0.55, 0.5, wx + s * 0.05, 0.3, z + 0.45, { uv: 'keep' });
  K.add(br, new THREE.TorusGeometry(0.16, 0.035, 5, 12), { uv: 'keep', at: matrix(wx + s * 0.32, 0.4, z + 0.45, Math.PI / 2) });
  K.cyl(mat('iron_wrought'), [wx + s * 0.28, 0.4, z + 0.45], [wx + s * 0.38, 0.4, z + 0.45], 0.03, 0.03, { sides: 5 });
}

// ---- dressing ------------------------------------------------------------------------------------

// a lantern hanging (or standing) at p in the current frame; size ~ s; adds a glow point
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
  const fm = fireMat();
  const offs = [[0, 0, 1], [0.45, 0.2, 0.7], [-0.4, 0.3, 0.75], [0.1, -0.45, 0.65], [-0.2, -0.2, 0.55]];
  offs.forEach(([dx, dz, k], i) => {
    const h = r * 2.2 * k;
    K.add(fm, new THREE.ConeGeometry(r * 0.38 * (0.7 + k * 0.4), h, 6), { uv: 'keep', at: matrix(x + dx * r, y + h / 2, z + dz * r, i, dx * 0.25, -dz * 0.25), shade: false, cast: false, tint: i ? '#ffd8a0' : '#fff0c8' });
  });
}

// a barrel at (x, z) in the current frame, standing on y
export function barrel(K, x, z, r = 0.32, h = 0.9, y = 0) {
  const g = new THREE.CylinderGeometry(r, r, h, 12, 4, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const t = p.getY(i) / h + 0.5; const k = 1 + 0.12 * Math.sin(Math.PI * t); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); }
  g.computeVertexNormals();
  K.add(mat('barrel'), g, { uv: 'keep', at: matrix(x, y + h / 2, z, x * 3.1) });
  K.add(mat('endgrain'), new THREE.CircleGeometry(r * 1.02, 12), { uv: 'keep', at: matrix(x, y + h - 0.02, z, 0, -Math.PI / 2), tint: '#c8a888' });
}
export function crate(K, x, z, s = 0.7, ry = 0, y = 0) {
  K.add(mat('crate'), new THREE.BoxGeometry(s, s, s), { uv: 'keep', at: matrix(x, y + s / 2, z, ry) });
}
export function sack(K, x, z, s = 1, y = 0, ry = 0) {
  const bm = mat('burlap');
  K.add(bm, new THREE.SphereGeometry(0.26 * s, 10, 8), { uv: 'keep', uvScale: [1.2, 1], tint: '#e0d0b0', at: matrix(x, y + 0.24 * s, z, ry, 0, 0, new THREE.Vector3(1, 1.15, 0.85)) });
  K.cyl(bm, [x, y + 0.48 * s, z], [x + 0.02, y + 0.62 * s, z], 0.06 * s, 0.1 * s, { sides: 7, tint: '#d8c8a8', uvScale: [0.6, 0.4] });
  K.add(mat('rope'), new THREE.TorusGeometry(0.07 * s, 0.018, 4, 8), { uv: 'keep', at: matrix(x, y + 0.5 * s, z, 0, Math.PI / 2) });
}

function extras(c) {
  const { K, S, b, ox, oz, dw, dh, H, R } = c;
  const nm = S.name;
  // a lantern on an iron bracket beside the door
  onWall(c, 'front', () => {
    const y = nm === 'frontier' ? 2.35 : Math.min(dh + 0.1, 2.75);
    const sides = b.kind === 'casino' ? [-1, 1] : [-1];
    for (const s of sides) {
      const x = s * (dw + (S.arch ? 1.05 : 0.75));
      K.box(mat('iron_wrought'), 0.05, 0.05, 0.62, x, y + 0.52, 0.3, { tile: 0.5 });
      K.beam(mat('iron_wrought'), [x, y + 0.1, 0.02], [x, y + 0.5, 0.5], 0.035, 0.035);
      lantern(c, [x, y + 0.12, 0.56], 0.5, true);
    }
  });
  // casino: the style's banners on the facade, clear of the windows
  if (b.kind === 'casino' && S.banner && nm !== 'frontier') {
    const fw = c.wins.filter(w => w.side === 'front').map(w => w.t);
    onWall(c, 'front', () => {
      for (const s of [-1, 1]) for (const k of [0, 1]) {
        const x = s * (dw + 2.3 + k * 3.6);
        if (Math.abs(x) > c.ox - 0.8 || fw.some(t => Math.abs(t - x) < c.ww / 2 + 0.65)) continue;
        K.quad(bannerMat(S.banner), 1.0, 2.1, x, H - 1.35, 0.1, { shade: false });
        K.cyl(mat('brass'), [x - 0.62, H - 0.28, 0.12], [x + 0.62, H - 0.28, 0.12], 0.035, 0.035, { sides: 6 });
      }
    });
  }
  // pawnbroker's three golden balls on a bracket
  if (b.kind === 'pawn') {
    onWall(c, 'front', () => {
      const x = dw + 1.5 + (S.arch ? 0.35 : 0), y = Math.min(H - 0.5, nm === 'frontier' ? 2.9 : 3.0);
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
  if (nm === 'timber' || nm === 'farm' || nm === 'frontier') {
    onWall(c, 'front', () => {
      const x = -(c.ox - 0.55);
      barrel(K, x, 0.45); if (R() < 0.7) barrel(K, x + 0.7, 0.4, 0.28, 0.8);
      crate(K, x + 0.1, 1.1, 0.62, 0.3);
      if (nm !== 'timber') sack(K, x + 0.85, 1.0, 1, 0, 0.4);
    });
  }
  if (nm === 'farm') {
    onWall(c, 'left', () => {
      const g = new THREE.TorusGeometry(0.62, 0.06, 6, 18);
      K.add(mat('wood_light'), g, { uv: 'keep', uvScale: [6, 1], at: matrix(0.6, 0.66, 0.12, 0, -0.18) });
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI; K.push(0.6, 0.66, 0.12, 0, -0.18); K.beam(mat('wood_light'), [Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0], [-Math.cos(a) * 0.6, -Math.sin(a) * 0.6, 0], 0.05, 0.05); K.pop(); }
      K.add(mat('wood_light'), new THREE.CylinderGeometry(0.12, 0.12, 0.2, 8), { uv: 'keep', at: matrix(0.6, 0.66, 0.12, 0, Math.PI / 2 - 0.18) });
      const hay = new THREE.SphereGeometry(0.9, 10, 6, 0, TAU, 0, Math.PI / 2);
      K.add(mat('thatch'), hay, { uv: 'keep', uvScale: [3, 1], at: matrix(-1.6, 0, 0.6, 0, 0, 0, new THREE.Vector3(1.3, 0.8, 0.8)), tint: '#d8c890' });
    });
  }
  if (nm === 'alpine') {
    onWall(c, 'front', () => {
      for (const s of [-1, 1]) {
        const x = s * (dw + 1.3), z = 0.7, im = mat('iron_wrought');
        for (let k = 0; k < 3; k++) { const a = k / 3 * TAU; K.beam(im, [x + Math.cos(a) * 0.32, 0, z + Math.sin(a) * 0.32], [x + Math.cos(a) * 0.12, 0.85, z + Math.sin(a) * 0.12], 0.05, 0.05); }
        K.add(im, new THREE.CylinderGeometry(0.42, 0.22, 0.32, 10, 1, true), { uv: 'keep', uvScale: [4, 1], at: matrix(x, 1.0, z), receive: true });
        K.add(emberMat(), new THREE.SphereGeometry(0.36, 10, 5, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(x, 1.03, z, 0, 0, 0, new THREE.Vector3(1, 0.35, 1)), shade: false, cast: false });
        flames(K, x, 1.05, z, 0.32);
        c.glows.push({ p: c.wp(x, 1.4, z), s: 2.6, fire: true });
      }
    });
    onWall(c, 'left', () => {
      const lm = mat('wood_light'), x0 = -0.6;
      for (let row = 0; row < 4; row++) for (let k = 0; k < 7 - row; k++) {
        const x = x0 + (k - (6 - row) / 2) * 0.27, y = 0.14 + row * 0.24;
        K.cyl(lm, [x, y, 0.08], [x + (R() - 0.5) * 0.04, y, 0.95], 0.13, 0.13, { sides: 7, tint: '#b89068' });
        K.add(mat('endgrain'), new THREE.CircleGeometry(0.125, 7), { uv: 'keep', at: matrix(x, y, 0.955, 0, 0, R() * 3) });
      }
      K.box(mat('snow_roof'), 1.5, 0.14, 0.95, x0, 1.13, 0.5, { tile: 2, seg: [3, 1, 2], warp: v => { v.y += 0.05 * Math.sin(v.x * 5) - Math.abs(v.x) * 0.08; } });
    });
  }
  if (nm === 'frontier') {
    // tusks crossed over the door, a horned skull between them
    onWall(c, 'front', () => {
      const y = b.kind === 'casino' ? 2.9 : c.dh + 0.06, bone = mat('bone');
      for (const s of [-1, 1]) K.tube(bone, [[s * 1.05, y, 0.1], [s * 0.7, y + 0.2, 0.2], [s * 0.2, y + 0.4, 0.26], [-s * 0.3, y + 0.5, 0.22]], [0.1, 0.085, 0.06, 0.02], { sides: 7, tile: 0.8 });
      const sy = y + 0.3;
      K.add(bone, new THREE.SphereGeometry(0.17, 10, 8), { uv: 'keep', at: matrix(0, sy, 0.2, 0, 0, 0, new THREE.Vector3(1, 0.85, 1.3)) });
      K.add(bone, new THREE.BoxGeometry(0.16, 0.12, 0.18), { uv: 'keep', at: matrix(0, sy - 0.13, 0.32) });
      for (const s of [-1, 1]) K.add(bone, new THREE.ConeGeometry(0.05, 0.45, 7), { uv: 'keep', at: matrix(s * 0.27, sy + 0.1, 0.18, 0, 0, s * -1.2) });
    });
    // a stretched hide drying on a frame against the side wall
    onWall(c, 'left', () => {
      const x = 0.4, wl = mat('wood_light');
      K.beam(wl, [x - 0.9, 0, 0.5], [x - 0.75, 2.4, 0.15], 0.1, 0.1);
      K.beam(wl, [x + 0.9, 0, 0.5], [x + 0.75, 2.4, 0.15], 0.1, 0.1);
      K.beam(wl, [x - 0.95, 2.2, 0.17], [x + 0.95, 2.2, 0.17], 0.08, 0.08);
      K.beam(wl, [x - 0.95, 0.5, 0.45], [x + 0.95, 0.5, 0.45], 0.08, 0.08);
      K.push(x, 1.35, 0.32, 0, -0.18); K.quad(mat('rug_hide', { alphaTest: 0.5, side: THREE.DoubleSide }), 1.6, 1.6, 0, 0, 0, { uv: 'keep' }); K.pop();
    });
    // the outpost: palisades off the back corners, banner poles out front, a spiked barricade, and a
    // gateway of huge tusks before the casino
    if (b.kind === 'pawn' || b.kind === 'store') for (const s of [-1, 1]) palisade(c, s * (ox + 0.5), s * (ox + 3.3), -oz + 0.35 + R() * 0.3);
    const side = (b.id % 2) ? 1 : -1;
    if (b.kind !== 'gas') bannerPole(c, side * (ox - 0.6), oz + 2.7 + R() * 0.5, 5.2 + R() * 0.8);
    if (b.kind === 'casino') { bannerPole(c, -side * (ox - 0.6), oz + 2.9, 6.0); tuskArch(c, oz + 2.5, 3.6, 4.9); }
    if (b.kind === 'pawn' || b.kind === 'casino') barricade(c, -side * (ox + 1.4), oz - 0.5 - R(), Math.PI / 2 + (R() - 0.5) * 0.4, 2.8);
  }
  if (nm === 'adobe') {
    onWall(c, 'right', () => {
      const ts = c.wins.filter(w => w.side === 'right').map(w => w.t).sort((a, b2) => a - b2);
      const lm = mat(S.beam), x = ts.length > 1 ? (ts[0] + ts[1]) / 2 : ts.length ? ts[0] + (ts[0] > 0 ? -1.5 : 1.5) : 0.6;
      for (const s of [-1, 1]) K.beam(lm, [x + s * 0.28, 0, 0.75], [x + s * 0.28, H + 1.1, 0.1], 0.08, 0.08);
      for (let k = 0; k < Math.floor((H + 0.9) / 0.42); k++) { const t = (k + 0.6) * 0.42 / (H + 1.1); K.box(lm, 0.62, 0.06, 0.06, x, t * (H + 1.1), 0.75 - t * 0.65, { grain: 'x', tile: 1.2 }); }
    });
    onWall(c, 'front', () => {
      for (const [x, z, k] of [[c.dw + 0.65, 0.35, 1], [c.dw + 1.05, 0.5, 0.8], [-(c.dw + 0.7), 0.4, 1.1]]) pot(c, x, 0, z, k);
    });
    if (S.pipes) {
      // goblin brass plumbing up a corner and over the parapet, riveted plates patching the mud, a gear
      const bm = mat('brass');
      const x = c.ox + 0.12, z = -c.oz + 1.25;
      K.cyl(bm, [x, 0, z], [x, H + 0.9, z], 0.1, 0.1, { sides: 8 });
      K.cyl(bm, [x, H + 0.9, z], [x - 0.6, H + 0.9, z], 0.1, 0.1, { sides: 8 });
      for (let y = 0.6; y < H + 0.8; y += 0.9) K.add(bm, new THREE.TorusGeometry(0.13, 0.03, 5, 10), { uv: 'keep', at: matrix(x, y, z, 0, Math.PI / 2) });
      K.add(mat('metal_red'), new THREE.BoxGeometry(0.5, 0.6, 0.4), { uv: 'keep', at: matrix(x + 0.12, 1.0, z + 0.5) });
      K.add(bm, new THREE.CylinderGeometry(0.16, 0.16, 0.06, 12), { uv: 'keep', at: matrix(x + 0.38, 1.1, z + 0.5, 0, 0, Math.PI / 2) });
      const plates = ['left', 'right', 'back'].filter(() => R() < 0.6).slice(0, 2);
      if (!plates.length) plates.push('left');
      for (const side of plates) onWall(c, side, f => {
        const busy = c.wins.filter(w => w.side === side).map(w => [w.t - c.ww / 2 - 0.4, w.t + c.ww / 2 + 0.4]);
        for (let tries = 0; tries < 8; tries++) {
          const pw = 1.0 + R() * 0.9, ph = 0.8 + R() * 0.7, t = (R() - 0.5) * (f.len - pw - 1.6);
          if (busy.some(([a, bb]) => t + pw / 2 > a && t - pw / 2 < bb)) continue;
          const y = 1.0 + R() * (H - 1.6 - ph) + ph / 2;
          K.box(mat(R() < 0.5 ? 'metal_red' : 'metal_green'), pw, ph, 0.05, t, y, 0.025, { tile: 1.3, rz: (R() - 0.5) * 0.12 });
          for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) K.add(bm, new THREE.SphereGeometry(0.04, 6, 4), { uv: 'keep', at: matrix(t + dx * (pw / 2 - 0.08), y + dy * (ph / 2 - 0.08), 0.06) });
          break;
        }
      });
      onWall(c, 'left', () => gear(c, 0.9, H - 0.6, 0.1, 0.5, 0.15));
      if (S.awnings) onWall(c, 'front', () => awning(c, 0, c.dh + 0.55, 2 * dw + 1.8, 1.6, S.awnings[(b.id + 1) % S.awnings.length], true));
    }
  }
}

// ---- interiors: shelves of goods, rugs, clutter, wall trophies, the casino hall ---------------------

const RUGS = { rug_red: [3.6, 2.3], rug_braid: [3.4, 2.4], rug_bear: [2.8, 2.8], rug_hide: [2.6, 2.6], rug_desert: [2.2, 3.4] };
function rugAt(c, name, x, z, ry = 0, k = 1, y = 0.104) {
  const [w, d] = RUGS[name] || [3, 2];
  c.K.add(mat(name, { alphaTest: 0.5, side: THREE.DoubleSide }), new THREE.PlaneGeometry(w * k, d * k, Math.ceil(w * k / 0.6), Math.ceil(d * k / 0.6)), { uv: 'keep', at: matrix(x, y, z, ry, -Math.PI / 2), cast: false, shade: () => 0.92 });
}

// Goods for the shelves: each draws itself standing at the origin of the current frame (x along the
// shelf, z out of the wall) and says how wide and tall it is. R: the building's rng.
const lathe = (pts, n = 10) => new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), n);
const pick = (R, a) => a[Math.floor(R() * a.length)];
const CLAY = ['#7a98c0', '#8aa878', '#c87a58', '#b898c0', '#d8c8a8', '#8a6a4a', '#a8b0a0'];
const ITEMS = {
  vase: { w: 0.24, h: 0.34, d: (K, R) => K.add(mat('clay'), lathe([[0, 0], [0.07, 0.01], [0.11, 0.08], [0.1, 0.2], [0.05, 0.27], [0.06, 0.33], [0, 0.33]]), { uv: 'keep', tint: pick(R, CLAY), cast: false }) },
  jar: { w: 0.2, h: 0.3, d: (K, R) => { K.cyl(mat('clay'), [0, 0, 0], [0, 0.24, 0], 0.09, 0.08, { sides: 10, tint: pick(R, ['#d8c8a8', '#a8b8b0', '#c8a888', '#b8a07a']), cast: false }); K.cyl(mat('wood_light'), [0, 0.24, 0], [0, 0.28, 0], 0.07, 0.07, { sides: 10, cast: false }); K.add(mat('burlap'), new THREE.SphereGeometry(0.075, 8, 4, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0.27, 0), cast: false }); } },
  pot: { w: 0.32, h: 0.34, d: (K, R) => K.add(mat('clay'), lathe([[0, 0], [0.1, 0.01], [0.15, 0.1], [0.14, 0.22], [0.08, 0.3], [0.09, 0.34], [0, 0.34]]), { uv: 'keep', tint: pick(R, ['#c88a60', '#a86a48', '#d8a070', '#b8784c']), cast: false }) },
  goblet: { w: 0.14, h: 0.2, d: K => K.add(mat('brass'), lathe([[0, 0], [0.06, 0], [0.02, 0.03], [0.015, 0.1], [0.06, 0.14], [0.065, 0.2], [0, 0.2]]), { uv: 'keep', cast: false }) },
  books: { w: 0.3, h: 0.3, d: (K, R) => { for (let k = 0; k < 4; k++) K.box(mat('clay'), 0.06, 0.24 + R() * 0.06, 0.18, -0.1 + k * 0.065, 0.13, -0.03, { tint: ['#8a2a22', '#2a4a7a', '#3a6a2a', '#7a5a2a', '#5a2a4a'][Math.floor(R() * 5)], rz: k === 3 ? 0.25 : 0, cast: false }); } },
  lute: { w: 0.3, h: 0.55, d: K => { K.add(mat('wood_light'), new THREE.SphereGeometry(0.14, 10, 8), { uv: 'keep', at: matrix(0, 0.14, -0.02, 0, -0.25, 0, new THREE.Vector3(1, 1.25, 0.55)), cast: false }); K.box(mat('timber_dark'), 0.05, 0.36, 0.03, 0, 0.42, -0.08, { rx: -0.25, cast: false }); } },
  helm: { w: 0.28, h: 0.26, d: K => { K.add(mat('iron_wrought'), new THREE.SphereGeometry(0.13, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0, 0, 0, 0, 0, new THREE.Vector3(1, 1.3, 1)), tint: '#c8c8d0', cast: false }); K.box(mat('brass'), 0.03, 0.08, 0.26, 0, 0.17, 0, { tile: 1, cast: false }); } },
  dwarfhelm: { w: 0.36, h: 0.3, d: K => { K.add(mat('iron_wrought'), new THREE.SphereGeometry(0.14, 10, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, 0, 0, 0, 0, 0, new THREE.Vector3(1, 1.1, 1)), tint: '#c8c8d0', cast: false }); K.add(mat('brass'), new THREE.TorusGeometry(0.14, 0.02, 4, 12), { uv: 'keep', at: matrix(0, 0.02, 0, 0, Math.PI / 2), cast: false }); for (const s of [-1, 1]) K.tube(mat('bone'), [[s * 0.12, 0.08, 0], [s * 0.22, 0.14, 0], [s * 0.25, 0.26, 0.02]], [0.035, 0.025, 0.008], { sides: 5, cast: false }); } },
  crt: { w: 0.46, h: 0.38, d: K => { K.box(mat('wood_light'), 0.44, 0.36, 0.34, 0, 0.18, 0, { tint: '#a07858', cast: false }); K.quad(mat('iron_wrought'), 0.28, 0.24, -0.04, 0.19, 0.172, { tint: '#7aa098', shade: false }); for (const k of [0, 1]) K.add(mat('brass'), new THREE.SphereGeometry(0.025, 6, 4), { uv: 'keep', at: matrix(0.16, 0.24 - k * 0.1, 0.175), cast: false }); } },
  chest: { w: 0.44, h: 0.34, d: K => { K.box(mat('crate'), 0.42, 0.2, 0.28, 0, 0.1, 0, { uv: 'keep', cast: false }); K.add(mat('crate'), new THREE.CylinderGeometry(0.14, 0.14, 0.42, 10, 1, false, 0, Math.PI), { uv: 'keep', at: matrix(0, 0.2, 0, 0, 0, Math.PI / 2), cast: false }); for (const s of [-1, 1]) K.box(mat('brass'), 0.04, 0.22, 0.3, s * 0.14, 0.11, 0, { tile: 1, cast: false }); } },
  candles: { w: 0.24, h: 0.22, d: (K, R) => { for (let k = 0; k < 3; k++) K.cyl(mat('clay'), [-0.07 + k * 0.07, 0, (k % 2) * 0.04], [-0.07 + k * 0.07, 0.12 + R() * 0.1, (k % 2) * 0.04], 0.025, 0.025, { sides: 6, tint: '#f0e8d0', cast: false }); } },
  lamp: { w: 0.26, h: 0.2, d: K => { K.add(mat('brass'), lathe([[0, 0], [0.07, 0], [0.05, 0.03], [0.1, 0.07], [0.04, 0.1], [0, 0.11]]), { uv: 'keep', at: matrix(0, 0, 0, 0, 0, 0, new THREE.Vector3(1, 1, 0.7)), cast: false }); K.cyl(mat('brass'), [0.09, 0.06, 0], [0.16, 0.12, 0], 0.012, 0.008, { sides: 5, cast: false }); K.add(mat('brass'), new THREE.TorusGeometry(0.035, 0.008, 4, 8), { uv: 'keep', at: matrix(-0.1, 0.07, 0), cast: false }); } },
  sack: { w: 0.4, h: 0.48, d: K => sack(K, 0, 0, 0.75, 0) },
  cheese: { w: 0.36, h: 0.14, d: K => { K.cyl(mat('clay'), [0, 0, 0], [0, 0.12, 0], 0.17, 0.17, { sides: 12, tint: '#f0c860', cast: false }); K.box(mat('clay'), 0.16, 0.12, 0.1, 0.12, 0.06, 0.12, { tint: '#f8e090', ry: 0.6, cast: false }); } },
  bread: { w: 0.3, h: 0.14, d: (K, R) => { for (let k = 0; k < 2; k++) K.add(mat('clay'), new THREE.SphereGeometry(0.1, 10, 6), { uv: 'keep', at: matrix(-0.06 + k * 0.13, 0.06, k * 0.04, R(), 0, 0, new THREE.Vector3(1.4, 0.7, 0.8)), tint: '#b87838', cast: false }); } },
  potion: { w: 0.16, h: 0.2, d: (K, R) => { const col = pick(R, ['#e05a3a', '#4a8ad0', '#5ac04a', '#c8a030']); K.add(glassMat(), new THREE.SphereGeometry(0.07, 10, 8), { uv: 'keep', at: matrix(0, 0.07, 0), tint: col, shade: false, cast: false }); K.cyl(mat('wood_light'), [0, 0.13, 0], [0, 0.18, 0], 0.025, 0.025, { sides: 6, cast: false }); } },
  coil: { w: 0.32, h: 0.16, d: K => { for (let k = 0; k < 3; k++) K.add(mat('rope'), new THREE.TorusGeometry(0.13, 0.03, 5, 12), { uv: 'keep', uvScale: [4, 1], at: matrix(0, 0.03 + k * 0.05, 0, 0, Math.PI / 2), cast: false }); } },
  pumpkin: { w: 0.36, h: 0.3, d: (K, R) => { K.add(mat('clay'), new THREE.SphereGeometry(0.16, 12, 8), { uv: 'keep', at: matrix(0, 0.13, 0, R(), 0, 0, new THREE.Vector3(1.1, 0.8, 1.1)), tint: pick(R, ['#d8782c', '#c86a28', '#e0a040']), cast: false, warp: v => { const a = Math.atan2(v.z, v.x); const k = 1 - 0.07 * Math.abs(Math.cos(a * 4)); v.x *= k; v.z *= k; } }); K.cyl(mat('wood_light'), [0, 0.24, 0], [0.02, 0.3, 0], 0.02, 0.015, { sides: 5, tint: '#5a6a2a', cast: false }); } },
  tool: { w: 0.4, h: 0.12, d: (K, R) => { K.push(0, 0.03, 0, (R() - 0.5) * 0.6, 0, Math.PI / 2); K.cyl(mat('wood_light'), [0, -0.18, 0], [0, 0.14, 0], 0.02, 0.02, { sides: 5, tint: '#b89470', cast: false }); K.box(mat('iron_wrought'), 0.12, 0.06, 0.05, 0, 0.16, 0, { cast: false }); K.pop(); } },
  shoe: { w: 0.24, h: 0.05, d: K => K.add(mat('iron_wrought'), new THREE.TorusGeometry(0.08, 0.018, 4, 10, Math.PI * 1.5), { uv: 'keep', at: matrix(0, 0.02, 0, 0, Math.PI / 2, 0.8), tint: '#9a9aa4', cast: false }) },
  stein: { w: 0.2, h: 0.24, d: (K, R) => { K.cyl(mat('clay'), [0, 0, 0], [0, 0.2, 0], 0.07, 0.065, { sides: 10, tint: pick(R, ['#a8a8a0', '#c8b898', '#8a7a68']), cast: false }); K.add(mat('iron_wrought'), new THREE.TorusGeometry(0.05, 0.012, 4, 8, Math.PI), { uv: 'keep', at: matrix(0.08, 0.1, 0, 0, 0, -Math.PI / 2), cast: false }); K.cyl(mat('iron_wrought'), [0, 0.2, 0], [0, 0.225, 0], 0.075, 0.06, { sides: 10, tint: '#c8c8d0', cast: false }); } },
  axe: { w: 0.5, h: 0.12, d: (K, R) => { K.push(0, 0.04, 0, (R() - 0.5) * 0.5, 0, Math.PI / 2); K.cyl(mat('wood_light'), [0, -0.22, 0], [0, 0.2, 0], 0.022, 0.022, { sides: 5, tint: '#8a6a4a', cast: false }); K.add(mat('iron_wrought'), new THREE.CylinderGeometry(0.12, 0.12, 0.025, 10, 1, false, 0, Math.PI), { uv: 'keep', at: matrix(0, 0.14, 0, 0, Math.PI / 2, 0), tint: '#c0c0c8', cast: false }); K.pop(); } },
  ore: { w: 0.3, h: 0.18, d: (K, R) => { for (let k = 0; k < 3; k++) K.add(mat('granite_inner'), new THREE.DodecahedronGeometry(0.07 + R() * 0.03, 0), { uv: 'keep', uvScale: [0.2, 0.2], at: matrix(-0.08 + k * 0.08, 0.06 + (k === 1 ? 0.06 : 0), (R() - 0.5) * 0.08, R() * 3, R() * 3), tint: pick(R, ['#c8a050', '#b8b8c0', '#c87a50']), cast: false }); } },
  ingots: { w: 0.3, h: 0.12, d: (K, R) => { const col = pick(R, ['#d8b060', '#c87a50', '#b8b8c0']); for (let k = 0; k < 3; k++) K.box(mat('brass'), 0.2, 0.05, 0.08, 0, 0.025 + (k === 2 ? 0.05 : 0), k === 2 ? 0 : (k - 0.5) * 0.09, { tile: 1, tint: col, ry: k === 2 ? 1.57 : 0, cast: false }); } },
  skull: { w: 0.24, h: 0.2, d: (K, R) => { K.add(mat('bone'), new THREE.SphereGeometry(0.09, 10, 8), { uv: 'keep', at: matrix(0, 0.09, 0, (R() - 0.5), 0, 0, new THREE.Vector3(1, 0.9, 1.25)), cast: false }); K.box(mat('bone'), 0.09, 0.06, 0.08, 0, 0.03, 0.08, { cast: false }); if (R() < 0.5) for (const s of [-1, 1]) K.add(mat('bone'), new THREE.ConeGeometry(0.025, 0.2, 5), { uv: 'keep', at: matrix(s * 0.12, 0.13, 0, 0, 0, s * -1.2), cast: false }); } },
  trap: { w: 0.36, h: 0.08, d: K => { K.box(mat('iron_wrought'), 0.12, 0.02, 0.12, 0, 0.01, 0, { cast: false }); for (const s of [-1, 1]) K.add(mat('iron_wrought'), new THREE.TorusGeometry(0.14, 0.012, 4, 12, Math.PI), { uv: 'keep', at: matrix(0, 0.02, s * 0.01, 0, -Math.PI / 2 + s * 0.4, 0), cast: false }); K.cyl(mat('iron_wrought'), [0.1, 0.01, 0], [0.3, 0.01, 0.06], 0.008, 0.008, { sides: 4, cast: false }); } },
  bottle: { w: 0.12, h: 0.3, d: (K, R) => { K.add(mat('clay'), lathe([[0, 0], [0.05, 0], [0.05, 0.16], [0.02, 0.21], [0.018, 0.28], [0, 0.28]]), { uv: 'keep', tint: pick(R, ['#5a7a3a', '#6a4a2a', '#3a5a4a']), cast: false }); K.cyl(mat('wood_light'), [0, 0.28, 0], [0, 0.31, 0], 0.016, 0.016, { sides: 5, cast: false }); } },
  rolledhide: { w: 0.5, h: 0.2, d: (K, R) => { K.cyl(mat('hide_patch'), [-0.24, 0.09, 0], [0.24, 0.09, 0.02], 0.09, 0.09, { sides: 9, uvScale: [1, 0.4], tint: '#e0c8a8', cast: false }); for (const s of [-1, 1]) K.add(mat('rope'), new THREE.TorusGeometry(0.095, 0.015, 4, 9), { uv: 'keep', at: matrix(s * 0.14, 0.09, 0.01, Math.PI / 2), cast: false }); } },
  gear: { w: 0.3, h: 0.3, d: (K, R) => { K.push(0, 0.14, -0.04, 0, -0.25); K.add(mat('brass'), new THREE.CylinderGeometry(0.11, 0.11, 0.03, 14), { uv: 'keep', at: matrix(0, 0, 0, 0, Math.PI / 2), cast: false }); for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; K.box(mat('brass'), 0.04, 0.04, 0.03, Math.cos(a) * 0.125, Math.sin(a) * 0.125, 0, { rz: a, tile: 1, cast: false }); } K.pop(); } },
  gadget: { w: 0.28, h: 0.3, d: (K, R) => { K.box(mat('brass'), 0.2, 0.14, 0.14, 0, 0.07, 0, { tile: 1, cast: false }); K.add(glassMat(), new THREE.SphereGeometry(0.06, 8, 6), { uv: 'keep', at: matrix(0.03, 0.2, 0), tint: pick(R, ['#80ff60', '#60c0ff', '#ffb040']), shade: false, cast: false }); K.cyl(mat('iron_wrought'), [-0.06, 0.14, 0], [-0.08, 0.28, 0], 0.01, 0.01, { sides: 4, cast: false }); K.add(mat('brass'), new THREE.CylinderGeometry(0.05, 0.05, 0.02, 10), { uv: 'keep', at: matrix(-0.1, 0.07, 0, 0, 0, Math.PI / 2), cast: false }); } },
  rolledrug: { w: 0.55, h: 0.18, d: (K, R) => { const col = pick(R, ['#b8603a', '#3a5a6a', '#8a2a20']); K.cyl(mat('clay'), [-0.26, 0.08, 0], [0.26, 0.08, 0], 0.08, 0.08, { sides: 9, tint: col, cast: false }); for (const s of [-1, 1]) K.add(mat('clay'), new THREE.TorusGeometry(0.08, 0.012, 4, 9), { uv: 'keep', at: matrix(s * 0.18, 0.08, 0, Math.PI / 2), tint: '#e0c890', cast: false }); } },
};
const STACKABLE = new Set(['chest', 'books', 'crt', 'cheese', 'ingots', 'bread', 'rolledhide', 'rolledrug', 'sack']);
const LAYABLE = new Set(['bottle', 'vase', 'jar', 'books', 'lute', 'stein', 'candles']);

// The back-wall shelves of the pawn shop or the store: a frame in the style's wood (or mud niches), and
// goods drawn from the style's pool: unevenly spaced, a quarter of the room left empty, some tilted,
// some stacked, one or two lying on their side.
function shopShelves(c) {
  const { K, S, b, ix, iz } = c;
  const I = S.int || {}, cfg = I.shelf || { frame: 'oak' }, pool = (I.pool || {})[b.kind === 'pawn' ? 'pawn' : 'store'] || ['jar'];
  const R = rng(b.id * 131 + (S.name.length * 977) + (b.kind === 'pawn' ? 7 : 3));
  const w = 2 * ix - 0.8, h = 2.2, y0 = 0.15;
  const nb = Math.max(3, Math.round(w / 2.4 + (R() - 0.5)));
  const levels = [0.22, 0.96, 1.69];
  K.push(0, 0, -iz + 0.02, 0);
  const wood = mat(cfg.wood || S.beam), wt = cfg.woodTint || null;
  let depth = 0.3;
  if (cfg.frame === 'niche') {
    // mud niches cut into a thick adobe shelf-wall: piers between bays, slabs, a rounded cap
    depth = 0.42;
    const am = mat('adobe_inner'), o = { tile: 2, tint: '#e8d0b0', cast: false };
    for (let k = 0; k <= nb; k++) K.box(am, k === 0 || k === nb ? 0.3 : 0.22, h + 0.35, depth, -w / 2 + w * k / nb, (h + 0.35) / 2, depth / 2, { ...o, seg: [1, 3, 1], warp: v => { v.x += 0.02 * Math.sin(v.y * 6 + k); } });
    for (const y of [...levels, h + 0.32]) K.box(am, w + 0.3, 0.12, depth, 0, y - 0.06, depth / 2, { ...o, seg: [Math.ceil(w), 1, 1], warp: v => { v.y += 0.015 * Math.sin(v.x * 3.3); } });
    K.box(am, w + 0.2, h + 0.2, 0.04, 0, (h + 0.2) / 2 + 0.05, 0.02, { ...o, tint: '#b89070' });
    for (let k = 0; k < nb; k++) { const x = -w / 2 + w * (k + 0.5) / nb; K.cyl(mat('wood_light'), [x - w / nb / 2 - 0.1, h + 0.12, depth + 0.02], [x + w / nb / 2 + 0.1, h + 0.12, depth + 0.02], 0.05, 0.05, { sides: 6, tint: '#e0c8a0', cast: false }); }
  } else {
    if (cfg.back) K.box(mat(cfg.back), w + 0.1, h + 0.2, 0.03, 0, (h + 0.2) / 2 + 0.05, 0.015, { uvSpace: 'kit', tile: 2.4, tint: cfg.backTint, cast: false, seg: [Math.ceil(w / 0.6), 4, 1] });
    for (let k = 0; k <= nb; k++) {
      const x = -w / 2 + w * k / nb;
      if (cfg.frame === 'poles') K.cyl(mat('wood_light'), [x + (R() - 0.5) * 0.06, 0, depth - 0.04], [x, h + 0.35, depth - 0.06], 0.07, 0.06, { sides: 7, tint: '#a8865e', cast: false });
      else K.box(wood, 0.1, h + 0.25, depth + 0.02, x, (h + 0.25) / 2, depth / 2, { tile: 1.2, tint: wt, cast: false });
      if (cfg.frame === 'dark') for (const y of [0.4, 1.3, 2.1]) K.box(mat('iron_wrought'), 0.12, 0.08, depth + 0.05, x, y, depth / 2, { tile: 0.5, cast: false });
      if (cfg.frame === 'poles') for (const y of levels) K.add(mat('rope'), new THREE.TorusGeometry(0.08, 0.02, 4, 8), { uv: 'keep', at: matrix(x, y - 0.06, depth - 0.05, 0, Math.PI / 2), cast: false });
    }
    for (const y of levels) K.box(wood, w + (cfg.frame === 'poles' ? 0.4 : 0.1), cfg.frame === 'dark' ? 0.07 : 0.05, depth, (cfg.frame === 'poles' ? (R() - 0.5) * 0.2 : 0), y - 0.025, depth / 2, { grain: 'x', tint: wt, cast: false, rz: cfg.frame === 'poles' ? (R() - 0.5) * 0.02 : 0 });
    K.box(wood, w + 0.3, 0.14, depth + 0.06, 0, h + 0.3, (depth + 0.06) / 2, { grain: 'x', tint: wt, cast: false });
  }
  // goods, a size up (chunky, like everything else), unevenly spaced
  const SC = 1.35;
  let laid = 0;
  for (const lv of levels) {
    let x = -w / 2 + 0.1 + R() * 0.15;
    while (x < w / 2 - 0.2) {
      // keep clear of the uprights / piers
      const bay = Math.floor((x + w / 2) / (w / nb)), bx0 = -w / 2 + bay * w / nb;
      if (x - bx0 < 0.1) { x = bx0 + 0.12; continue; }
      if (R() < 0.17) { x += 0.2 + R() * 0.35; continue; }
      const name = pick(R, pool), it = ITEMS[name];
      if (!it) { x += 0.2; continue; }
      const iw = it.w * SC;
      if (x + iw > bx0 + w / nb - 0.06 && iw < w / nb - 0.2) { x = bx0 + w / nb + 0.12; continue; }
      const cx = x + iw / 2, cz = depth * 0.5 + (R() - 0.5) * 0.06;
      const lay = LAYABLE.has(name) && laid < 2 && R() < 0.12;
      const tilt = !lay && R() < 0.15 ? (R() - 0.5) * 0.4 : 0;
      K.push(cx, lv + (lay ? 0.09 : 0), cz, (R() - 0.5) * 0.6, 0, lay ? Math.PI / 2 : tilt, SC);
      it.d(K, R);
      K.pop();
      if (lay) laid++;
      if (STACKABLE.has(name) && R() < 0.3) {
        const n2 = pick(R, pool), i2 = ITEMS[n2];
        if (i2 && i2.h * SC < 0.42) { K.push(cx + (R() - 0.5) * 0.06, lv + it.h * SC, cz, (R() - 0.5) * 0.8, 0, 0, SC); i2.d(K, R); K.pop(); }
      }
      x += iw + 0.01 + R() * 0.09;
    }
  }
  // a few big things on top of the shelves, a trophy or two on the wall above
  for (let k = 0; k < 2; k++) { const name = pick(R, pool), it = ITEMS[name]; if (it && it.h < 0.5) { K.push(-w / 2 + 0.4 + R() * (w - 0.8), h + 0.37, depth / 2, R(), 0, 0, SC); it.d(K, R); K.pop(); } }
  const above = c.H - (h + 0.37);
  if (above > 0.75) for (const fx of [-0.28, 0.28]) { K.push(fx * w, 0, 0.02, 0, 0, 0, Math.min(0.75, above / 1.5)); K.push(0, (h + 0.37 + above * 0.5) / Math.min(0.75, above / 1.5) - 2.0, 0); wallItem(c, (I.walls || ['shield'])[fx < 0 ? 0 : 1]); K.pop(); K.pop(); }
  K.pop();
}

// a trophy, a rack or some hangings on a wall (inner frame: local +z out of the wall)
function wallItem(c, kind) {
  const { K, S, R } = c;
  const wl = mat('wood_light'), iron = mat('iron_wrought'), br = mat('brass'), y = 2.0;
  if (kind === 'shield' || kind === 'axes') {
    K.add(kind === 'axes' ? iron : wl, new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), { uv: 'keep', at: matrix(0, y, 0.06, 0, Math.PI / 2), tint: kind === 'axes' ? null : '#8a3a2a', cast: false });
    K.add(br, new THREE.TorusGeometry(0.42, 0.035, 5, 18), { uv: 'keep', at: matrix(0, y, 0.09), cast: false });
    K.add(br, new THREE.SphereGeometry(0.1, 8, 6, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(0, y, 0.09, 0, Math.PI / 2), cast: false });
    for (const s of [-1, 1]) {
      K.beam(kind === 'axes' ? wl : iron, [s * 0.65, y - 0.65, 0.04], [-s * 0.5, y + 0.6, 0.04], 0.045, 0.03, { cast: false });
      if (kind === 'axes') K.add(iron, new THREE.CylinderGeometry(0.22, 0.22, 0.03, 10, 1, false, 0, Math.PI), { uv: 'keep', at: matrix(-s * 0.45, y + 0.52, 0.05, 0, Math.PI / 2, s * 0.85), cast: false });
      else K.box(br, 0.24, 0.05, 0.05, -s * 0.38, y + 0.36, 0.05, { rz: s * 0.85, cast: false });
    }
  } else if (kind === 'tools') {
    K.box(wl, 1.6, 0.1, 0.06, 0, y + 0.55, 0.04, { grain: 'x', tint: '#a08060', cast: false });
    for (const [x, len, head] of [[-0.6, 1.5, 'fork'], [-0.2, 1.35, 'rake'], [0.25, 1.55, 'scythe'], [0.6, 1.2, 'hoe']]) {
      K.cyl(wl, [x, y + 0.6, 0.08], [x + 0.04, y + 0.6 - len, 0.08], 0.025, 0.025, { sides: 5, tint: '#b89470', cast: false });
      const hy = y + 0.6 - len;
      if (head === 'fork' || head === 'rake') for (let k = -2; k <= 2; k++) K.box(iron, 0.02, 0.2, 0.02, x + k * 0.05, hy - 0.08, 0.08, { cast: false });
      if (head === 'scythe') K.add(iron, new THREE.TorusGeometry(0.3, 0.02, 3, 10, Math.PI * 0.6), { uv: 'keep', at: matrix(x + 0.3, y + 0.55, 0.09), cast: false });
      if (head === 'hoe') K.box(iron, 0.18, 0.12, 0.02, x + 0.04, hy, 0.09, { cast: false });
    }
  } else if (kind === 'antlers' || kind === 'ram') {
    const bone = mat('bone');
    K.box(mat(kind === 'ram' ? 'timber_dark' : 'board_rough'), 0.5, 0.6, 0.04, 0, y + 0.05, 0.02, { cast: false });
    K.add(kind === 'ram' ? mat('hide_patch') : bone, new THREE.SphereGeometry(0.2, 10, 8), { uv: 'keep', uvScale: [0.3, 0.3], at: matrix(0, y, 0.12, 0, 0, 0, new THREE.Vector3(1, 0.9, 1.3)), cast: false, tint: kind === 'ram' ? '#b09078' : null });
    K.add(bone, new THREE.BoxGeometry(0.18, 0.13, 0.2), { uv: 'keep', at: matrix(0, y - 0.15, 0.26), cast: false });
    for (const s of [-1, 1]) {
      if (kind === 'ram') {
        const pts = []; for (let k = 0; k <= 10; k++) { const a = k / 10 * Math.PI * 1.6; pts.push([s * (0.14 + 0.16 * Math.sin(a) + k * 0.012), y + 0.12 + 0.16 * Math.cos(a) - 0.04 * k / 10, 0.1 + 0.05 * Math.sin(a)]); }
        K.tube(bone, pts, t => 0.07 * (1 - t * 0.7), { sides: 6, cast: false, tint: '#c8b898' });
      } else {
        K.tube(bone, [[s * 0.12, y + 0.1, 0.1], [s * 0.45, y + 0.35, 0.12], [s * 0.6, y + 0.75, 0.1], [s * 0.5, y + 1.0, 0.08]], [0.05, 0.04, 0.03, 0.012], { sides: 6, cast: false });
        K.tube(bone, [[s * 0.42, y + 0.32, 0.12], [s * 0.3, y + 0.62, 0.12], [s * 0.32, y + 0.78, 0.1]], [0.03, 0.02, 0.01], { sides: 5, cast: false });
      }
    }
  } else if (kind === 'pots' || kind === 'pans') {
    // a rail of hooks with pots, pans and ladles (pots: a niche shelf of painted pots)
    if (kind === 'pots') {
      K.box(mat('timber_dark'), 1.6, 0.08, 0.3, 0, y - 0.2, 0.15, { grain: 'x', cast: false });
      for (let k = 0; k < 4; k++) pot(c, -0.55 + k * 0.37, y - 0.16, 0.15, 0.55 + (k % 2) * 0.15, ['#c88a60', '#a86a48', '#d8a070', '#8a5a3a'][k]);
    } else {
      K.box(mat(S.beam), 1.5, 0.08, 0.08, 0, y + 0.3, 0.06, { grain: 'x', cast: false });
      for (let k = 0; k < 4; k++) {
        const x = -0.55 + k * 0.37, r = 0.11 + R() * 0.06;
        K.cyl(iron, [x, y + 0.26, 0.08], [x, y + 0.12, 0.08], 0.01, 0.01, { sides: 4, cast: false });
        if (k % 2) K.add(iron, new THREE.CylinderGeometry(r, r * 0.85, 0.04, 12), { uv: 'keep', at: matrix(x, y - r + 0.1, 0.1, 0, Math.PI / 2), tint: '#7a7480', cast: false });
        else K.add(mat(S.name === 'alpine' ? 'iron_wrought' : 'brass'), new THREE.SphereGeometry(r, 10, 6, 0, TAU, Math.PI / 2, Math.PI / 2), { uv: 'keep', at: matrix(x, y + 0.08, 0.14), cast: false });
      }
    }
  } else if (kind === 'herbs') {
    K.box(mat('wood_light'), 1.4, 0.06, 0.06, 0, y + 0.4, 0.08, { grain: 'x', tint: '#a08060', cast: false });
    for (let k = 0; k < 6; k++) { const x = -0.55 + k * 0.22; K.add(mat('thatch'), new THREE.ConeGeometry(0.08, 0.42, 6), { uv: 'keep', uvScale: [0.5, 0.5], at: matrix(x, y + 0.15, 0.1, k, Math.PI), tint: ['#8aa860', '#a8a060', '#6a8a50', '#c8a868'][k % 4], cast: false }); K.add(mat('rope'), new THREE.TorusGeometry(0.03, 0.01, 3, 6), { uv: 'keep', at: matrix(x, y + 0.34, 0.1, 0, Math.PI / 2), cast: false }); }
  } else if (kind === 'shoes') {
    K.box(mat('wood_light'), 1.2, 0.5, 0.05, 0, y, 0.03, { tint: '#a08060', cast: false });
    for (let k = 0; k < 6; k++) K.add(iron, new THREE.TorusGeometry(0.09, 0.018, 4, 10, Math.PI * 1.5), { uv: 'keep', at: matrix(-0.45 + (k % 3) * 0.45, y + 0.12 - Math.floor(k / 3) * 0.24, 0.07, 0, 0, Math.PI * 0.75), tint: '#9a9aa4', cast: false });
  } else if (kind === 'hide' || kind === 'rughang') {
    K.cyl(mat('wood_light'), [-0.95, y + 0.85, 0.08], [0.95, y + 0.85, 0.08], 0.035, 0.035, { sides: 6, tint: '#a8865e', cast: false });
    K.add(mat(kind === 'hide' ? 'rug_hide' : 'rug_desert', { alphaTest: 0.5, side: THREE.DoubleSide }), new THREE.PlaneGeometry(1.6, 1.6), { uv: 'keep', at: matrix(0, y, 0.05, 0, 0, kind === 'rughang' ? Math.PI / 2 : 0), cast: false, shade: () => 0.92 });
  } else if (kind === 'bow') {
    K.add(wl, new THREE.TorusGeometry(0.7, 0.025, 5, 16, Math.PI * 0.8), { uv: 'keep', at: matrix(-0.1, y, 0.06, 0, 0, Math.PI * 0.6), tint: '#7a5a3a', cast: false });
    K.box(mat('rope'), 0.012, 1.25, 0.012, -0.32, y, 0.06, { cast: false });
    for (let k = 0; k < 3; k++) K.cyl(wl, [0.25 + k * 0.08, y - 0.5, 0.06], [0.3 + k * 0.08, y + 0.45, 0.06], 0.012, 0.012, { sides: 4, cast: false });
  } else if (kind === 'tusks') {
    for (const s of [-1, 1]) K.tube(mat('bone'), [[s * 0.1, y - 0.5, 0.08], [s * 0.45, y, 0.12], [s * 0.35, y + 0.55, 0.1], [s * 0.1, y + 0.75, 0.08]], [0.08, 0.06, 0.04, 0.01], { sides: 7, cast: false });
  } else if (kind === 'gearwall') {
    gear(c, -0.3, y + 0.2, 0.06, 0.4, 0, 10); gear(c, 0.32, y - 0.12, 0.08, 0.26, 0, 8);
    K.cyl(mat('brass'), [-0.8, y - 0.5, 0.1], [0.8, y - 0.5, 0.1], 0.05, 0.05, { sides: 6, cast: false });
  } else if (kind === 'banner' || kind === 'tapestry') tapestry(c);
}

function tapestry(c, w = 1.1, h = 2.2) {
  const { K, H, S } = c;
  K.add(bannerMat(S.banner || 'banner_red'), new THREE.PlaneGeometry(w, h), { uv: 'keep', at: matrix(0, H - 0.35 - h / 2, 0.05), shade: () => 0.9, cast: false });
  K.cyl(mat(S.layout === 'frontier' ? 'wood_light' : 'brass'), [-w / 2 - 0.12, H - 0.32, 0.07], [w / 2 + 0.12, H - 0.32, 0.07], 0.03, 0.03, { sides: 6, cast: false });
}

// a chandelier per style: a candle ring (timber), a cartwheel of lanterns (farm), an iron ring of fire
// bowls (alpine), a ring of antlers with candles (frontier), brass pipes, gears and glass bulbs (adobe)
function chandelier(c, x, y, z, kind) {
  const { K, R } = c;
  const iron = mat('iron_wrought'), br = mat('brass'), wl = mat('wood_light');
  const hang = (n, r, mt = iron) => {
    for (let k = 0; k < n; k++) { const a = k / n * TAU; K.beam(mt, [x + Math.cos(a) * r, y, z + Math.sin(a) * r], [x, y + 1.0, z], 0.025, 0.025, { cast: false }); }
    K.box(iron, 0.03, c.H - y - 1.0, 0.03, x, (c.H + y + 1.0) / 2, z, { tile: 0.5, cast: false });
  };
  if (kind === 'wheel') {
    K.add(wl, new THREE.TorusGeometry(0.85, 0.07, 6, 18), { uv: 'keep', uvScale: [6, 1], at: matrix(x, y, z, 0, Math.PI / 2), tint: '#a07050', cast: false });
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI; K.beam(wl, [x + Math.cos(a) * 0.82, y, z + Math.sin(a) * 0.82], [x - Math.cos(a) * 0.82, y, z - Math.sin(a) * 0.82], 0.05, 0.05, { tint: '#a07050', cast: false }); }
    K.add(wl, new THREE.CylinderGeometry(0.14, 0.14, 0.16, 10), { uv: 'keep', at: matrix(x, y, z), tint: '#8a6040', cast: false });
    hang(3, 0.85);
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + 0.4; K.box(iron, 0.02, 0.3, 0.02, x + Math.cos(a) * 0.85, y - 0.15, z + Math.sin(a) * 0.85, { cast: false }); lantern(c, [x + Math.cos(a) * 0.85, y - 0.45, z + Math.sin(a) * 0.85], 0.4, false); }
    return;
  }
  if (kind === 'brazier') {
    K.add(iron, new THREE.TorusGeometry(0.95, 0.06, 6, 20), { uv: 'keep', at: matrix(x, y, z, 0, Math.PI / 2), cast: false });
    hang(4, 0.95);
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * TAU + 0.785, px = x + Math.cos(a) * 0.95, pz = z + Math.sin(a) * 0.95;
      K.add(iron, new THREE.CylinderGeometry(0.2, 0.1, 0.16, 8, 1, true), { uv: 'keep', at: matrix(px, y + 0.06, pz), receive: true, cast: false });
      K.add(emberMat(), new THREE.SphereGeometry(0.17, 8, 4, 0, TAU, 0, Math.PI / 2), { uv: 'keep', at: matrix(px, y + 0.1, pz, 0, 0, 0, new THREE.Vector3(1, 0.35, 1)), shade: false, cast: false });
      flames(K, px, y + 0.12, pz, 0.14);
      c.glows.push({ p: c.wp(px, y + 0.3, pz), s: 1.6, fire: true });
    }
    return;
  }
  if (kind === 'antler') {
    const bone = mat('bone');
    K.add(wl, new THREE.CylinderGeometry(0.2, 0.16, 0.2, 10), { uv: 'keep', at: matrix(x, y, z), tint: '#7a5a3a', cast: false });
    hang(3, 0.2);
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * TAU + R() * 0.2, ca = Math.cos(a), sa = Math.sin(a);
      K.tube(bone, [[x + ca * 0.15, y, z + sa * 0.15], [x + ca * 0.5, y + 0.05, z + sa * 0.5], [x + ca * 0.8, y + 0.3, z + sa * 0.8], [x + ca * 0.85, y + 0.48, z + sa * 0.85]], [0.05, 0.04, 0.03, 0.02], { sides: 5, cast: false });
      K.tube(bone, [[x + ca * 0.5, y + 0.05, z + sa * 0.5], [x + ca * 0.6 - sa * 0.15, y + 0.3, z + sa * 0.6 + ca * 0.15]], [0.03, 0.012], { sides: 4, cast: false });
      const tx = x + ca * 0.85, tz = z + sa * 0.85;
      K.cyl(mat('clay'), [tx, y + 0.48, tz], [tx, y + 0.62, tz], 0.03, 0.028, { sides: 6, tint: '#f0e4cc', cast: false });
      K.add(glassMat(), new THREE.ConeGeometry(0.03, 0.09, 5), { uv: 'keep', at: matrix(tx, y + 0.67, tz), shade: false, cast: false });
      c.glows.push({ p: c.wp(tx, y + 0.68, tz), s: 0.8, col: '#ffd080' });
    }
    return;
  }
  if (kind === 'goblin') {
    K.add(br, new THREE.TorusGeometry(0.85, 0.06, 6, 20), { uv: 'keep', uvScale: [6, 1], at: matrix(x, y, z, 0, Math.PI / 2), cast: false });
    K.add(br, new THREE.TorusGeometry(0.45, 0.05, 6, 16), { uv: 'keep', uvScale: [4, 1], at: matrix(x, y + 0.2, z, 0, Math.PI / 2), cast: false });
    hang(3, 0.85, br);
    gear(c, x, y + 0.45, z, 0.32, R() * 3, 9);
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * TAU, px = x + Math.cos(a) * 0.85, pz = z + Math.sin(a) * 0.85;
      K.tube(br, [[x + Math.cos(a) * 0.45, y + 0.2, z + Math.sin(a) * 0.45], [x + Math.cos(a) * 0.7, y + 0.25, z + Math.sin(a) * 0.7], [px, y, pz]], 0.03, { sides: 5, cast: false });
      K.cyl(br, [px, y, pz], [px, y - 0.18, pz], 0.025, 0.025, { sides: 5, cast: false });
      K.add(glassMat(), new THREE.SphereGeometry(0.09, 10, 8), { uv: 'keep', at: matrix(px, y - 0.27, pz), shade: false, cast: false });
      c.glows.push({ p: c.wp(px, y - 0.27, pz), s: 1.0, col: '#ffd890' });
    }
    return;
  }
  // a ring of candles on an iron hoop
  K.add(iron, new THREE.TorusGeometry(0.75, 0.05, 6, 18), { uv: 'keep', at: matrix(x, y, z, 0, Math.PI / 2), cast: false });
  hang(3, 0.75);
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * TAU, cx = x + Math.cos(a) * 0.75, cz = z + Math.sin(a) * 0.75;
    K.cyl(mat('clay'), [cx, y + 0.04, cz], [cx, y + 0.22, cz], 0.035, 0.03, { sides: 6, tint: '#f0e4cc', cast: false });
    K.add(glassMat(), new THREE.ConeGeometry(0.03, 0.09, 5), { uv: 'keep', at: matrix(cx, y + 0.27, cz), shade: false, cast: false });
    c.glows.push({ p: c.wp(cx, y + 0.28, cz), s: 0.7, col: '#ffd080' });
  }
}

function dress(c) {
  const { K, S, b, ix, iz, H, R } = c;
  const I = S.int || {};
  const k = b.kind;
  const hang = (x, z) => lantern(c, [x + (R() - 0.5) * 0.6, H - 0.38 - R() * 0.18, z + (R() - 0.5) * 0.5], 0.5, true);
  if (k === 'pawn' || k === 'store') {
    shopShelves(c);
    rugAt(c, I.rug || 'rug_red', 0, k === 'pawn' ? 1.4 : 1.2, I.rug === 'rug_desert' ? Math.PI / 2 : 0);
    // clutter in the front corners (the kiva takes the front-left in adobe shops)
    const L = I.kiva ? 1 : -1;
    barrel(K, ix - 0.45, iz - 0.5); barrel(K, ix - 1.1, iz - 0.45, 0.28, 0.8);
    if (!I.hay) { crate(K, L * (ix - 0.5) + (I.kiva ? -0.8 : 0), iz - 1.25, 0.66, 0.3); crate(K, L * (ix - 0.55) + (I.kiva ? -0.8 : 0), iz - 1.3, 0.48, 0.8, 0.66); }
    sack(K, ix - 0.55, iz - 1.2); sack(K, ix - 0.5, iz - 1.75, 0.85, 0, 1.2);
    if (I.hay) { for (const [x, z, y] of [[-ix + 0.6, iz - 0.6, 0], [-ix + 0.6, iz - 1.45, 0], [-ix + 0.6, iz - 1.0, 0.5]]) K.box(mat('thatch'), 1.0, 0.5, 0.75, x, y + 0.25 + 0.1, z, { tile: 1.2, ry: Math.PI / 2, tint: '#d0c0a0', cast: false }); }
    // the side walls: a banner, then the style's trophies and racks every 3 m or so
    const items = (I.walls || ['shield']).slice();
    const tt = freeSpot(c, 'right', 1.4, 0, c.taken.right);
    if (tt !== null && S.banner) { c.taken.right.push([tt - 0.8, tt + 0.8]); onInner(c, 'right', tt, () => tapestry(c)); }
    let n = 0;
    for (const side of ['left', 'right']) {
      for (const t0 of [-c.iz * 0.55, c.iz * 0.1, c.iz * 0.6]) {
        const ti = freeSpot(c, side, 1.8, t0, c.taken[side]);
        if (ti === null) continue;
        c.taken[side].push([ti - 1.0, ti + 1.0]);
        onInner(c, side, ti, () => wallItem(c, items[n++ % items.length]));
      }
    }
    if (k === 'pawn') { hang(-ix * 0.5, 0.4); hang(ix * 0.45, 0.5); } else hang(0, 1.2);
  } else if (k === 'casino') casinoDress(c);
  else if (k === 'gas') { barrel(K, -ix + 0.45, -iz + 0.5); hang(0, -iz * 0.2); }
}

function casinoDress(c) {
  const { K, S, ix, iz, H, R } = c;
  const I = S.int || {}, C = I.casino || { floor: 'carpet', rugs: [], chandelier: 'ring' };
  if (C.floor === 'carpet') {
    // the carpet, framed by a border band, over the plank floor
    const cw = ix - 0.6, cd = iz - 0.6;
    hplane(c, mat('carpet_casino'), 2 * cw, 2 * cd, 0, 0.12, 0, { tile: 3.2, grain: 'z', cast: false, shade: () => [0.9, 0.9, 0.9] });
    const bdr = mat('carpet_border'), bw = 0.42;
    for (const s of [-1, 1]) {
      K.add(bdr, new THREE.PlaneGeometry(2 * cw + 2 * bw, bw, Math.ceil((2 * cw + 2 * bw) / 0.6), 1), { uv: 'keep', uvScale: [(2 * cw + 2 * bw) / 2.4, 1], at: matrix(0, 0.122, s * (cd + bw / 2), 0, -Math.PI / 2), cast: false, shade: () => 0.88 });
      K.add(bdr, new THREE.PlaneGeometry(2 * cd, bw, Math.ceil(2 * cd / 0.6), 1), { uv: 'keep', uvScale: [2 * cd / 2.4, 1], at: matrix(s * (cw + bw / 2), 0.122, 0, Math.PI / 2, -Math.PI / 2), cast: false, shade: () => 0.88 });
    }
  }
  // scattered rugs, clear of the table, the HIT/STAND rugs, the slots and the machine
  const spots = [[4.6, 2.4, 0.35], [-3.4, 6.1, -0.2], [6.4, 6.0, 0.15], [1.6, -3.3, 1.1], [-8.6, 4.8, 0.6]];
  let si = 0;
  for (const [name, n] of C.rugs || []) for (let k = 0; k < n && si < spots.length; k++, si++) { const [x, z, ry] = spots[si]; rugAt(c, name, x, z, ry + (R() - 0.5) * 0.4, 0.9 + R() * 0.2, 0.104 + k * 0.002); }
  for (const [x, z] of [[-ix * 0.45, -iz * 0.2], [ix * 0.45, -iz * 0.2], [0, iz * 0.45]]) chandelier(c, x, H - 1.6, z, C.chandelier);
  // the side walls between the windows: the style's banners and sconces (racks and lanterns on a farm)
  const walls = I.walls || ['shield'];
  for (const side of ['left', 'right']) {
    const ts = c.wins.filter(w => w.side === side).map(w => w.t).sort((a, b2) => a - b2);
    const L = iz - 0.6, mids = [];
    const pts = [-L, ...ts, L];
    for (let i = 0; i < pts.length - 1; i++) { const a = pts[i] + (i ? c.ww / 2 + 0.2 : 0), bb = pts[i + 1] - (i < pts.length - 2 ? c.ww / 2 + 0.2 : 0); if (bb - a > 1.4) mids.push((a + bb) / 2); }
    mids.forEach((t, i) => {
      if (c.taken[side].some(([a, bb]) => t > a - 0.8 && t < bb + 0.8)) return;
      onInner(c, side, t, () => {
        if (i % 2 === 0) { if (S.banner) tapestry(c, 1.1, 2.3); else wallItem(c, walls[(i / 2) % walls.length]); }
        else { lantern(c, [0, 2.4, 0.32], 0.45, false); K.box(mat('iron_wrought'), 0.05, 0.05, 0.4, 0, 2.1, 0.2, { tile: 0.5, cast: false }); }
      });
    });
  }
  // barrels in the front corners, hay bales on a farm
  barrel(K, -ix + 0.45, iz - 0.5); barrel(K, -ix + 1.1, iz - 0.45, 0.28, 0.8); barrel(K, ix - 0.45, iz - 0.5);
  if (C.hay) for (const [x, z, y, ry] of [[ix - 0.7, iz - 1.5, 0, 0], [ix - 0.7, iz - 2.4, 0, 0.1], [ix - 0.75, iz - 1.95, 0.5, -0.05], [-ix + 0.7, -iz + 1.0, 0, 1.5]]) K.box(mat('thatch'), 1.0, 0.5, 0.75, x, y + 0.35, z, { tile: 1.2, ry: Math.PI / 2 + ry, tint: '#d8c8a0', cast: false });
}

// ---- relight: the interior's own light ---------------------------------------------------------------

// Every vertex this building added inside its room gets: soft darkening where floor meets wall and wall
// meets ceiling (more in the corners), a warm pool round every lamp, candle and fire, a slightly cooler
// tint near the windows and the door, and gentle dimming away from any light.
function relight(c) {
  const { K, ix, iz, H } = c;
  const inv = K.root.clone().invert();
  const v = new THREE.Vector3();
  const lights = [];
  for (const g of c.glows) {
    v.copy(g.p).applyMatrix4(inv);
    if (Math.abs(v.x) < ix + 0.05 && Math.abs(v.z) < iz + 0.05 && v.y < H + 0.1) lights.push({ x: v.x, y: v.y, z: v.z, r: 1.6 + g.s * 0.9, k: Math.min(1, 0.35 + g.s * 0.25) });
  }
  const wins = c.wins.map(w => {
    const p = { front: [w.t, iz], back: [-w.t, -iz], right: [ix, -w.t], left: [-ix, w.t] }[w.side];
    return { x: p[0], y: c.winY + c.wh / 2, z: p[1] };
  });
  wins.push({ x: 0, y: 1.2, z: iz });
  for (const geo of K.log) {
    const p = geo.attributes.position, col = geo.attributes.color;
    if (!col) continue;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(inv);
      if (!(Math.abs(v.x) < ix + 0.012 && Math.abs(v.z) < iz + 0.012 && v.y > 0.06 && v.y < H + 0.012)) continue;
      const d = [v.y - 0.1, H - v.y, ix - Math.abs(v.x), iz - Math.abs(v.z)].map(q => Math.max(0, q)).sort((a, b) => a - b);
      let k = (1 - 0.26 * (1 - sstep(0, 0.6, d[1]))) * (1 - 0.12 * (1 - sstep(0, 0.9, d[2])));
      let w = 0;
      for (const L of lights) { const dd = Math.hypot(v.x - L.x, v.y - L.y, v.z - L.z); if (dd < L.r) w += L.k * (1 - dd / L.r) * (1 - dd / L.r); }
      w = Math.min(1, w);
      let cw = 0;
      for (const Wn of wins) { const dd = Math.hypot(v.x - Wn.x, v.y - Wn.y, v.z - Wn.z); if (dd < 2.2) cw += (1 - dd / 2.2) * (1 - dd / 2.2); }
      cw = Math.min(1, cw);
      k *= 0.86 + 0.14 * Math.min(1, w * 1.6 + cw);
      col.setXYZ(i, col.getX(i) * k * (1 + 0.24 * w) * (1 - 0.03 * cw), col.getY(i) * k * (1 + 0.1 * w) * (1 + 0.01 * cw), col.getZ(i) * k * (1 - 0.06 * w) * (1 + 0.07 * cw));
    }
  }
}
