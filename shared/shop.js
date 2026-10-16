// The town's shops: what each one sells, and what it does. Pure: the server (server/room.js shopBuy) checks
// who's asking, where they stand and what the crew can pay, the pages draw the catalogue (client/js/shop.js).
//
// Gus fits RV upgrades at his garage by the RV lot, at night once the day's payment is made (the RV is parked
// at the lot then, and the payment can't be what pays for them). They're the crew's, bought from the shared
// bank, for the rest of the trip: a new trip starts with a new RV. They sit on top of the Garage's parts
// (shared/garage.js), which come from Road Cards and last for good.

import { RV, WINCH } from './constants.js';
import { partMods } from './garage.js';

export const HEAVY = { CABLE: 60, PULL: 1.5 };              // the Heavy-Duty Winch: its cable (m), x the pull
export const UPGRADES = {
  frame:  { name: 'Reinforced Frame', price: 450,
    line: 'Crashes, Grumphorn hits and falling rock cost the RV 30% less.' },
  winch:  { name: 'Heavy-Duty Winch', price: 350,
    line: `A ${HEAVY.CABLE} m cable (from ${WINCH.MAX_LEN}) and half again the pull.` },
  engine: { name: 'Big-Block V8', price: 600,
    line: 'A quarter more pull up the grades, and a top end of 45 mph (from 38).' },
  tires:  { name: 'Mud Tires', price: 250,
    line: 'Twice the grip in mud, and half the drag.' },
  snow:   { name: 'Snow Tires', price: 300,
    line: 'For Frostpeak Pass (day 3): no ploughing through its snow (on the stock tyres the RV takes about a quarter longer up there), and full grip on its black ice, where they slide and spin.' },
  lock:   { name: 'Locker Padlock', price: 150,
    line: 'Ringtails can\'t pry the RV\'s locker open. (What lies loose in the RV is still fair game.)' },
  nitro:  { name: 'Nitrous Kit', price: 400,
    line: 'N at the wheel: 4 s of a hard shove and 9 mph more top end. Three shots a day.' },
};
export const UPGRADE_IDS = Object.keys(UPGRADES);
export const NITRO = { SHOTS: 3, T: 4, PUSH: 1.7, TOP: 4 };   // shots a day, s a shot, x the engine, +m/s top end

// The general store's hardware (shared/dig.js): gear, a real thing set down by the rack out front, any time
// the store's open (it always is); buy two shovels if you like. Worth nothing to Ed, and gone if it's left
// behind: what rides in the RV comes along to the next day
export const GEAR = {
  detector: { name: 'Metal Detector', price: 250,
    line: 'Hold it and it beeps over buried metal, faster the closer it gets. Then somebody digs.' },
  shovel:   { name: 'Shovel', price: 100,
    line: 'Hold it and LMB digs where you look (hold LMB to keep digging). At the bottom of a cache: a chest to pull up and open.' },
  dynamite: { name: 'Dynamite', price: 60,
    line: 'One stick. Hold it and LMB lights a 4-second fuse, RMB throws it. Blows a seamed rock (or the boulder) apart, and anyone too close off their feet.' },
};
export const GEAR_IDS = Object.keys(GEAR);

// the vendors: where they stand (a W.town key), how close you must be to buy (m), what they sell, and from
// which list (gear: things to carry; else Gus's upgrades)
export const VENDORS = {
  gus: { name: 'Gus\'s Garage', who: 'Gus', at: 'gus', r: 4.5, goods: UPGRADE_IDS },
  store: { name: 'Hardware', who: 'The clerk', at: 'hardware', r: 4, goods: GEAR_IDS, gear: true },
  // the general store's clothes rail (shared/looks.js): hats, outfits and dyes, bought and changed only here
  tailor: { name: 'Clothes Rail', who: 'The clerk', at: 'tailor', r: 4, goods: [], looks: ['hat', 'kit', 'dye'] },
};
export const goodsOf = v => (VENDORS[v]?.gear ? GEAR : UPGRADES);

const has = (upg, id) => !!upg && Object.prototype.hasOwnProperty.call(upg, id) && UPGRADES[id] && !!upg[id];
// the RV's numbers from the Garage's parts and the trip's upgrades together
export function rvMods(parts, upg) {
  const m = partMods(parts), H = id => has(upg, id);
  return {
    ...m,
    hitX: H('frame') ? 0.7 : 1,                                   // crash, beast and rock damage
    cable: H('winch') ? HEAVY.CABLE : WINCH.MAX_LEN,
    pull: H('winch') ? WINCH.FORCE * HEAVY.PULL : WINCH.FORCE,
    engineX: H('engine') ? 1.25 : 1,
    topX: H('engine') ? 20 / RV.TOP_SPEED : 1,
    mudSlip: H('tires') ? RV.MUD_SLIP * 2 : RV.MUD_SLIP,
    mudDragX: H('tires') ? 0.5 : 1,
    iceSlip: H('snow') ? RV.FRICTION_SLIP : RV.ICE_SLIP,
    snowDragX: H('snow') ? 0 : 1,
    padlock: H('lock'),
    nitro: H('nitro'),
  };
}
// the ids a page or a test says the crew has, cleaned
export const cleanUpg = list => Object.fromEntries((Array.isArray(list) ? list : []).filter(id => UPGRADE_IDS.includes(id)).map(id => [id, 1]));
