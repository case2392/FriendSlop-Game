// The Garage: the lasting upgrades. Each is a kit card (shared/cards.js): one kept copy unlocks its level I, a
// second level II (the most). Perks are yours: three slots, and they change only you. An RV part is the
// crew's: everyone brings one, and when the RV leaves camp on day 1 it's fitted with the best of each kind
// among everyone aboard, for the whole trip. Pure: the save keeps the cards and the kit (shared/profile.js),
// the host's server clamps what a page says it has (clampKit) and turns it into numbers (kitMods, partMods).

import { CARD } from './cards.js';
import { PLAYER, STAMINA, GRAB, WINCH } from './constants.js';
import { RT, GH, RF } from './mobs.js';

// what each level does, as the Garage says it (the numbers are kitMods' and partMods')
export const PERKS = {
  gloves: { name: 'Work Gloves', lv: [
    'Your grip holds till the thing is 2.2 m past your reach (from 1.6), and a ringtail you hold alone bites after 3 s (from 2).',
    'And stronger hands: 1,045 N (from 950). You lift about 104 kg alone; the dino head and the safe still take two.'] },
  chalk: { name: 'Climbing Chalk', lv: [
    'Climbing costs 12% less stamina: 8.4 a second on the move (from 9.5), 3.1 hanging (from 3.5).',
    'Climbing costs 24% less: 7.2 and 2.7 a second, and a lunge costs 20 (from 24).'] },
  steady: { name: 'Steady Hands', lv: [
    'At the wheel: a creak and a dash lamp when the RV leans hard (past 0.6 g sideways), and reversing beeps that quicken as the back nears something.',
    'And stability control: at speed the wheel eases off before the RV is pulled sideways much past 0.8 g, even with it hard over. It only ever takes the turn away.'] },
  eye: { name: 'Keen Eye', lv: [
    'Loot glints reach you from 38 m (from 30).',
    'After 20:00, from 45 m; and the crosshair reads a thing\'s price from 4.5 m (from 3).'] },
  callsign: { name: 'Call Sign', lv: [
    'With a walkie: while you talk on it, everyone else with a walkie sees a radio marker over you, however far.',
    'And an arrow at the edge of their screen, with how far you are.'] },
  medic: { name: 'Medic Bag', lv: [
    'You pick a friend up in 1.6 s (from 2.2).',
    'They get up with 60 stamina (from 40).'] },
};
export const PARTS = {
  bullbar: { name: 'Bull Bar', lv: [
    'Front crashes and Grumphorn hits cost the RV 15% less. 150 kg on the nose: a little slower off the line.',
    '30% less. 250 kg on the nose.'] },
  winch: { name: 'Winch Motor', lv: [
    'The winch reels in at 2.0 m/s (from 1.6). The same 42 m cable.',
    'At 2.4 m/s.'] },
  horn: { name: 'Air Horn', lv: [
    'The horn carries 25% further: ringtails scatter from 25 m, loose rock comes down from 75 m, and a sleeping Grumphorn wakes from 50 m.',
    '50% further: 30, 90 and 60 m. It cuts both ways.'] },
  toolbox: { name: 'Toolbox', lv: [
    'The roadside fix takes three quarters of the time (6 s alone for the day\'s first breakdown). It still gets the RV to 20%.',
    'Half the time (4 s).'] },
};
export const PERK_IDS = Object.keys(PERKS);
export const PART_IDS = Object.keys(PARTS);
export const SLOTS = 3;               // perks you take on a trip
export const ROMAN = ['', 'I', 'II'];

// the level a save's copies of a kit card give: 1 copy I, 2 or more II
export const levelFrom = (cards, id) => (CARD[id]?.kind === 'kit' ? Math.max(0, Math.min(2, (cards?.[id] | 0))) : 0);

const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
const lvOk = v => v === 1 || v === 2;
const isPart = id => PART_IDS.includes(id);   // (never PARTS[id]: 'toString' is on every object)
// what the host's server takes from a page: known ids, levels 1 or 2, at most SLOTS perks (in the catalogue's
// order: an edited save can't claim more than a fully collected veteran has) and one part
export function clampKit(raw) {
  const kit = { perks: {}, part: null };
  if (!isObj(raw)) return kit;
  if (isObj(raw.perks)) for (const id of PERK_IDS) {
    if (Object.keys(kit.perks).length >= SLOTS) break;
    if (Object.prototype.hasOwnProperty.call(raw.perks, id) && lvOk(raw.perks[id])) kit.perks[id] = raw.perks[id];
  }
  const pt = raw.part;
  if (isObj(pt) && isPart(pt.id) && lvOk(pt.lv)) kit.part = { id: pt.id, lv: pt.lv };
  return kit;
}

// a player's numbers from their (clamped) kit
export function kitMods(kit) {
  const k = clampKit(kit), L = id => k.perks[id] || 0;
  const g = L('gloves'), c = L('chalk'), s = L('steady'), e = L('eye'), m = L('medic');
  return {
    slip: g ? 2.2 : 1.6,                               // m past your reach before a held thing gets away
    biteT: g ? 3 : RT.BITE_T,                          // s a ringtail you hold alone waits to bite
    fmax: g >= 2 ? Math.round(GRAB.FMAX * 1.1) : GRAB.FMAX,
    climbMul: c >= 2 ? 0.76 : c ? 0.88 : 1,           // the climb's stamina drain
    lunge: c >= 2 ? 20 : STAMINA.LUNGE,
    tipWarn: s >= 1, assist: s >= 2,
    far: e ? 38 : 30, farNight: e >= 2 ? 45 : e ? 38 : 30,
    labelReach: e >= 2 ? 4.5 : PLAYER.REACH,
    callsign: L('callsign'),
    holdT: m ? 1.6 : PLAYER.REVIVE_HOLD,
    stam: m >= 2 ? 60 : 40,
  };
}
export const STOCK = kitMods(null);

// the RV's numbers from the parts fitted ({ kind: level })
export function partMods(parts) {
  const L = id => (isObj(parts) && lvOk(parts[id]) ? parts[id] : 0);
  const b = L('bullbar'), w = L('winch'), h = L('horn'), t = L('toolbox');
  return {
    frontX: [1, 0.85, 0.7][b], bullKg: [0, 150, 250][b],
    reel: [WINCH.REEL_SPEED, 2.0, 2.4][w],
    hornK: [1, 1.25, 1.5][h],
    fixX: [1, 0.75, 0.5][t],                          // the roadside fix's time
  };
}

// the parts the RV is fitted with when it leaves camp on day 1: one each player brings (in the order given:
// the first to bring a level keeps it on a tie), the best level of each kind. The rest ride along as spares.
// players: [{ id, name, part: { id, lv } | null }]
export function fitParts(players) {
  const parts = {}, by = {}, spares = [];
  const list = (players || []).filter(p => p && isObj(p.part) && isPart(p.part.id) && lvOk(p.part.lv));
  for (const p of list) if (!parts[p.part.id] || p.part.lv > parts[p.part.id]) { parts[p.part.id] = p.part.lv; by[p.part.id] = p; }
  for (const p of list) if (by[p.part.id] !== p) spares.push({ id: p.part.id, lv: p.part.lv, name: p.name, over: by[p.part.id].name, overLv: parts[p.part.id] });
  return { parts, by: Object.fromEntries(Object.entries(by).map(([k, p]) => [k, p.name])), spares };
}
// "Bob's Winch Motor I is a spare: Ann's II is fitted"
export const spareLine = s => `${s.name}'s ${PARTS[s.id].name} ${ROMAN[s.lv]} is a spare: ${s.over}'s ${ROMAN[s.overLv]} is fitted`;
