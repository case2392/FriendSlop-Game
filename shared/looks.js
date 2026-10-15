// Looks: what you wear and what the RV is painted. Unlocked for good (each player's save keeps the ones they've
// had: shared/profile.js looks), shared by the crew (anything anyone aboard has unlocked, anyone can wear), and
// bought or changed only in town: clothes at the general store's clothes rail, paint at Gus's. Pure: the server
// (server/room.js) checks every buy and change, the pages draw them (client/js/people.js, rv3d.js).
//
// A player's look: { hat, kit, dye } (each null = what they were issued: the hat and kit picked by their seat,
// the tabard dyed their own colour). The RV's paint: an id, or null for the stock cream.

// hats (people.js hatParts draws each)
export const HAT_LOOKS = {
  none:    { name: 'Bare Head', price: 40 },
  brim:    { name: 'Trail Hat', price: 120 },
  straw:   { name: 'Straw Hat', price: 80 },
  cap:     { name: 'Ball Cap', price: 60 },
  bandana: { name: 'Bandana', price: 60 },
  hood:    { name: 'Ranger Hood', price: 100 },
  beanie:  { name: 'Repo Beanie', price: 120 },
  visor:   { name: 'Dealer\'s Visor', price: 150 },
  helm:    { name: 'Horned Helm', price: 220 },
};
// outfits: the six kits (paint/characters.js KITS: shoulders, the tabard's emblem, the belt, bracers)
export const KIT_LOOKS = {
  0: { name: 'Wheelwright (leather pauldrons, the wheel)', price: 150 },
  1: { name: 'Moneyman (plated pauldrons, the coin)', price: 150 },
  2: { name: 'Mechanic (iron pauldrons, crossed wrenches)', price: 180 },
  3: { name: 'Wanderer (a capelet, the horseshoe)', price: 150 },
  4: { name: 'Trapper (a fur mantle, the boot)', price: 180 },
  5: { name: 'Lionheart (iron pauldrons, the lion)', price: 220 },
};
// tabard dyes (the name labels and the party frames keep your own colour: it's how the crew tells you apart)
export const DYE_LOOKS = {
  crimson:  { name: 'Crimson', price: 90, col: '#b0302a' },
  navy:     { name: 'Navy', price: 90, col: '#2a3d7a' },
  forest:   { name: 'Forest', price: 90, col: '#2f6a32' },
  mustard:  { name: 'Mustard', price: 90, col: '#d2a12e' },
  plum:     { name: 'Plum', price: 110, col: '#6a2f6e' },
  coal:     { name: 'Coal', price: 110, col: '#3a3436' },
  bone:     { name: 'Bone', price: 110, col: '#e6dcc4' },
  rust:     { name: 'Rust', price: 90, col: '#b0582a' },
};
// the RV's paint: a tint over its cream panels (and through its trim)
export const RV_PAINTS = {
  rose:     { name: 'Desert Rose', price: 250, col: '#f2b0a8' },
  sky:      { name: 'Sky Blue', price: 250, col: '#acd0f6' },
  mint:     { name: 'Mint', price: 250, col: '#b6ecc4' },
  canary:   { name: 'Canary', price: 250, col: '#f8e070' },
  midnight: { name: 'Midnight', price: 350, col: '#7880a8' },
  flame:    { name: 'Hot Rod Flame', price: 350, col: '#ffa070' },
};

// every unlockable as one id: 'hat:brim', 'kit:3', 'dye:navy', 'rv:sky'
const KINDS = { hat: HAT_LOOKS, kit: KIT_LOOKS, dye: DYE_LOOKS, rv: RV_PAINTS };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const LOOK_IDS = Object.entries(KINDS).flatMap(([k, o]) => Object.keys(o).map(id => `${k}:${id}`));
export const lookOf = id => { const [k, v] = String(id).split(':'); return KINDS[k] && has(KINDS[k], v) ? { kind: k, id: v, ...KINDS[k][v] } : null; };
export const isLook = id => typeof id === 'string' && !!lookOf(id);
// a list of unlock ids from a save or a page: known ones, once each, at most all of them
export const cleanOwns = list => [...new Set((Array.isArray(list) ? list : []).filter(isLook))].slice(0, LOOK_IDS.length);
// what a player wears, from a save or a page: each part one they could have, or null (issued)
export function cleanWear(w) {
  const o = w && typeof w === 'object' ? w : {};
  return {
    hat: typeof o.hat === 'string' && has(HAT_LOOKS, o.hat) ? o.hat : null,
    kit: Number.isInteger(o.kit) && has(KIT_LOOKS, o.kit) ? o.kit : null,
    dye: typeof o.dye === 'string' && has(DYE_LOOKS, o.dye) ? o.dye : null,
  };
}
// the same look, worn only as far as the crew's unlocks allow (the rest back to issued)
export function allowedWear(w, owns) {
  const c = cleanWear(w), s = owns instanceof Set ? owns : new Set(owns || []);
  return { hat: c.hat != null && s.has(`hat:${c.hat}`) ? c.hat : null, kit: c.kit != null && s.has(`kit:${c.kit}`) ? c.kit : null, dye: c.dye != null && s.has(`dye:${c.dye}`) ? c.dye : null };
}
export const cleanPaint = (id, owns) => (typeof id === 'string' && has(RV_PAINTS, id) && (!owns || (owns instanceof Set ? owns : new Set(owns)).has(`rv:${id}`)) ? id : null);
// a look as the character builder takes it (client/js/people.js): the dye as its colour
export const wearOf = l => (l ? { hat: l.hat ?? null, kit: l.kit ?? null, dye: (l.dye && DYE_LOOKS[l.dye]?.col) || null } : null);
