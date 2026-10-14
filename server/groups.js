// The server world's collision groups: (membership << 16) | filter. The client's are its own (client/js/phys.js).
import { LOOT } from '../shared/loot.js';
export const G_WORLD = 1, G_RV = 2, G_PROP = 4, G_HOOK = 8, G_MOB = 16, G_LOOT = 32, G_FENCE = 64;
export const grp = (m, f) => ((m << 16) | f) >>> 0;
export const GROUPS = {
  world: grp(G_WORLD, 0xffff),
  rv: grp(G_RV, G_WORLD | G_RV | G_PROP | G_MOB),
  rvStep: grp(G_RV, G_PROP | G_MOB),         // the door steps hang 7 cm off the road: they'd snag the ground
  rvLoot: grp(G_RV, G_LOOT | G_MOB),         // the RV's parts that stop only loot and critters (not stones, the boulder, people)
  prop: grp(G_PROP, 0xffff),
  loot: grp(G_PROP | G_LOOT, 0xffff),        // a thing with a price (the rest of the props are stones, the boulder, the map...)
  carried: grp(G_PROP, 0xffff & ~G_MOB & ~G_FENCE),   // loot in a critter's jaws: it never snags on the thief (or its pals), or the fence it ducks under
  riding: grp(G_PROP | G_LOOT, 0xffff & ~G_RV & ~G_FENCE),   // loot riding the RV (Sim.rideStep): it goes where the RV goes, touching none of it (nor the fences it drives through)
  mob: grp(G_MOB, 0xffff),
  hook: grp(G_HOOK, G_WORLD | G_PROP),
  flimsy: grp(G_WORLD, G_PROP | G_HOOK | G_MOB),   // cacti: they stop people and critters, not a 3-ton RV
  fence: grp(G_FENCE, G_PROP),                    // fences: they stop people (the pages' own physics) and loot; the RV breaks through, critters squeeze under
  // queries: the solid world (the ground, walls, buildings, rocks) and the RV
  solid: grp(0xffff, G_WORLD | G_RV),
  ground: grp(0xffff, G_WORLD),
};
// a prop's group when it's loose: loot (with a price) or the rest
export const looseGroup = type => (LOOT[type] && !LOOT[type].tool ? GROUPS.loot : GROUPS.prop);
