// Road Cards: the collectibles. Thirty cards in five sets of six, one set a road. They turn up in tins at the
// dangerous places (the climb to a lookout, a ringtail den, a tipped-over Grumphorn's fur, the Hoard) and
// inside the safes and suitcases Ed pries open. A tin set down in the RV goes into the glovebox; pay the RV off
// on day 5 and everyone aboard keeps a copy of every card stowed while they were aboard. Miss a payment and the
// Repo Man drives off with the glovebox.
//
// Each set: 2 kit cards (the Garage's upgrades: one copy unlocks level I, two level II), 2 common, 1 uncommon,
// 1 rare (rares drop only on Bad Credit trips). Pure: the server rolls them, the pages draw them.

export const SETS = [
  { n: 1, name: 'The Westmeadow Road', emblem: 'oak' },
  { n: 2, name: 'Goldenfield Pike', emblem: 'wheat' },
  { n: 3, name: 'Frostpeak Pass', emblem: 'pine' },
  { n: 4, name: 'The Redrock Badlands', emblem: 'mesa' },
  { n: 5, name: 'The Lost Wages Flats', emblem: 'dune' },
];

// id, set, kind ('kit' | 'lore'), rarity ('kit' | 'common' | 'uncommon' | 'rare'), name, line, art (what's
// pictured: a prop, a critter, a person, the RV, or a drawn emblem)
export const CARDS = [
  // 1: the Westmeadow Road
  { id: 'gloves', set: 1, kind: 'kit', rarity: 'kit', name: 'Work Gloves', line: 'A grip that holds a little longer.', art: 'e:gloves' },
  { id: 'callsign', set: 1, kind: 'kit', rarity: 'kit', name: 'Call Sign', line: 'They always know where you are. On the walkie, anyway.', art: 'e:walkie' },
  { id: 'gnome', set: 1, kind: 'lore', rarity: 'common', name: 'Garden Gnome', line: "He's seen things.", art: 'p:gnome' },
  { id: 'toaster', set: 1, kind: 'lore', rarity: 'common', name: 'Chrome Toaster', line: 'Two slots. One works.', art: 'p:toaster' },
  { id: 'ed', set: 1, kind: 'lore', rarity: 'uncommon', name: 'Honest Ed', line: 'We buy anything. We pay for some of it.', art: 'n:ed' },
  { id: 'slopmaster', set: 1, kind: 'lore', rarity: 'rare', name: 'The Slopmaster 9000', line: '$250,000. No money down.', art: 'rv' },
  // 2: Goldenfield Pike
  { id: 'bullbar', set: 2, kind: 'kit', rarity: 'kit', name: 'Bull Bar', line: 'Iron on the nose. The front takes less of a knock.', art: 'e:bullbar' },
  { id: 'medic', set: 2, kind: 'kit', rarity: 'kit', name: 'Medic Bag', line: 'Up you get. Quicker than that.', art: 'e:medic' },
  { id: 'tire', set: 2, kind: 'lore', rarity: 'common', name: 'Whitewall Tire', line: '$60. Sixteen kilos. Your call.', art: 'p:tire' },
  { id: 'mudbog', set: 2, kind: 'lore', rarity: 'common', name: 'The Mud Bog', line: 'Soft shoulder, and road, and everything.', art: 'e:mud' },
  { id: 'grumphorn', set: 2, kind: 'lore', rarity: 'uncommon', name: 'Grumphorn, Asleep', line: 'Let it sleep.', art: 'm:grumphorn' },
  { id: 'cowbell', set: 2, kind: 'lore', rarity: 'rare', name: 'The Brass Cowbell', line: "What it leaves when it's had enough of you.", art: 'p:cowbell' },
  // 3: Frostpeak Pass
  { id: 'chalk', set: 3, kind: 'kit', rarity: 'kit', name: 'Climbing Chalk', line: 'Less sweat on the way up.', art: 'e:chalk' },
  { id: 'horn', set: 3, kind: 'kit', rarity: 'kit', name: 'Air Horn', line: 'Louder. Everything hears it. Everything.', art: 'e:horn' },
  { id: 'looserock', set: 3, kind: 'lore', rarity: 'common', name: 'Loose Rock', line: 'Honk first.', art: 'p:rock' },
  { id: 'vase', set: 3, kind: 'lore', rarity: 'common', name: 'Ming-ish Vase', line: "Goes in the shower stall. It won't.", art: 'p:vase' },
  { id: 'ringtail', set: 3, kind: 'lore', rarity: 'uncommon', name: 'The Ringtail', line: 'Masked. Not sorry.', art: 'm:ringtail' },
  { id: 'rockfall', set: 3, kind: 'lore', rarity: 'rare', name: 'The Rockfall', line: 'Keep moving.', art: 'e:rockfall' },
  // 4: the Redrock Badlands
  { id: 'winch', set: 4, kind: 'kit', rarity: 'kit', name: 'Winch Motor', line: 'Reels in faster. The cable is the same cable.', art: 'e:winch' },
  { id: 'eye', set: 4, kind: 'kit', rarity: 'kit', name: 'Keen Eye', line: "You'd spot a toaster in a snowstorm.", art: 'e:eye' },
  { id: 'safe', set: 4, kind: 'lore', rarity: 'common', name: 'Rusty Safe', line: 'Two people. One lets go.', art: 'p:safe' },
  { id: 'crash', set: 4, kind: 'lore', rarity: 'common', name: 'Crash Site', line: "Somebody else's bad day.", art: 'e:crash' },
  { id: 'dino', set: 4, kind: 'lore', rarity: 'uncommon', name: 'Dino World', line: 'Head missing. Reward.', art: 'p:dino' },
  { id: 'hoard', set: 4, kind: 'lore', rarity: 'rare', name: 'The Hoard', line: 'A week of your stuff.', art: 'e:hoard' },
  // 5: the Lost Wages Flats
  { id: 'steady', set: 5, kind: 'kit', rarity: 'kit', name: 'Steady Hands', line: 'The RV leans. You lean back.', art: 'e:wheel' },
  { id: 'toolbox', set: 5, kind: 'kit', rarity: 'kit', name: 'Toolbox', line: 'A coat hanger, a prayer, and a better wrench.', art: 'e:toolbox' },
  { id: 'casino', set: 5, kind: 'lore', rarity: 'common', name: 'Lucky Slop Casino', line: 'No clocks.', art: 'e:dice' },
  { id: 'double', set: 5, kind: 'lore', rarity: 'common', name: 'Double or Nothing', line: '48.5%. The house always wins.', art: 'e:coin' },
  { id: 'balloon', set: 5, kind: 'lore', rarity: 'uncommon', name: 'The Balloon Payment', line: 'Tonight. All of it.', art: 'e:balloon' },
  { id: 'repoman', set: 5, kind: 'lore', rarity: 'rare', name: 'The Repo Man', line: 'Midnight. Every night.', art: 'n:repoman' },
];
// (no prototype: a save naming 'constructor' or '__proto__' finds no card)
export const CARD = Object.assign(Object.create(null), Object.fromEntries(CARDS.map((c, i) => [c.id, { ...c, no: i + 1 }])));
export const CARD_IDS = CARDS.map(c => c.id);

// how likely each card in a set is, by kind (a rare only on Bad Credit trips)
export const WEIGHTS = { common: 3, uncommon: 2, kit: 2, rare: 1 };
export const CROSS = 0.15;                 // a card from an earlier day's set instead of today's
export const CONTAINER = { safe: 0.5, suitcase: 0.25 };   // the chance a thing Ed buys has a card inside
// the tins: how many cards each holds (the gold tin on the Hoard's pile: three, one of them a kit card)
export const TINS = { tin: 2, goldtin: 3 };
// most copies worth keeping: two of a kit card (levels I and II), one of the rest
export const maxCopies = id => (CARD[id]?.kind === 'kit' ? 2 : 1);
export const weight = (c, tier = 'std') => (c.rarity === 'rare' && tier !== 'bad' ? 0 : WEIGHTS[c.rarity]);

// one card for a find on `day` (rand: () => [0, 1)): today's set, or now and then an earlier day's
export function rollCard(day, tier = 'std', rand = Math.random, { kit = false } = {}) {
  let set = Math.max(1, Math.min(5, day | 0));
  if (set > 1 && rand() < CROSS) set = 1 + Math.floor(rand() * (set - 1));
  const pool = CARDS.filter(c => c.set === set && (!kit || c.kind === 'kit'));
  const total = pool.reduce((a, c) => a + weight(c, tier), 0);
  let r = rand() * total;
  for (const c of pool) { r -= weight(c, tier); if (r < 0) return c.id; }
  return pool[pool.length - 1].id;
}
// a tin's cards (a gold tin: its first card is a kit card)
export function rollTin(type, day, tier = 'std', rand = Math.random) {
  const n = TINS[type] || 2;
  return Array.from({ length: n }, (_, i) => rollCard(day, tier, rand, { kit: type === 'goldtin' && i === 0 }));
}
// the odds a set's cards drop, as shares (the Album shows them)
export function odds(tier = 'std') {
  const set = CARDS.filter(c => c.set === 1), total = set.reduce((a, c) => a + weight(c, tier), 0), out = {};
  for (const c of set) out[c.rarity] = (out[c.rarity] || 0) + weight(c, tier) / total;
  return out;
}
