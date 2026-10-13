// The server world's collision groups: (membership << 16) | filter. The client's are its own (client/js/phys.js).
export const G_WORLD = 1, G_RV = 2, G_PROP = 4, G_HOOK = 8, G_MOB = 16;
export const grp = (m, f) => ((m << 16) | f) >>> 0;
export const GROUPS = {
  world: grp(G_WORLD, 0xffff),
  rv: grp(G_RV, G_WORLD | G_RV | G_PROP | G_MOB),
  rvStep: grp(G_RV, G_PROP | G_MOB),         // the door steps hang 7 cm off the road: they'd snag the ground
  prop: grp(G_PROP, 0xffff),
  carried: grp(G_PROP, 0xffff & ~G_MOB),     // loot in a critter's jaws: it never snags on the thief (or its pals)
  mob: grp(G_MOB, 0xffff),
  hook: grp(G_HOOK, G_WORLD | G_PROP),
  flimsy: grp(G_WORLD, G_PROP | G_HOOK | G_MOB),   // cacti: they stop people and critters, not a 3-ton RV
  // queries: the solid world (the ground, walls, buildings, rocks) and the RV
  solid: grp(0xffff, G_WORLD | G_RV),
  ground: grp(0xffff, G_WORLD),
};
