// Everything you can grab, haul, break, and pawn.
//
//   shape     collider: ['box', hx, hy, hz] | ['cyl', halfH, r] | ['ball', r]
//   mass      kg — one person lifts ~95 kg; heavier needs a friend
//   value     base $ (scaled per day and per spawn)
//   frag      how much a hard knock hurts its value (0 = indestructible)
//   cls       '1h' sprintable · '2h' slow and blocks your view · 'heavy' drag or co-carry
//   tough     g-force it shrugs off before it starts losing value

export const LOOT = {
  gnome:    { name: 'Garden Gnome',     shape: ['box', 0.14, 0.24, 0.14], mass: 4,   value: 70,   frag: 0.6, cls: '1h',    tough: 14 },
  lamp:     { name: 'Tiffany-ish Lamp', shape: ['cyl', 0.3, 0.17],        mass: 5,   value: 140,  frag: 1.3, cls: '1h',    tough: 10 },
  toaster:  { name: 'Chrome Toaster',   shape: ['box', 0.16, 0.12, 0.1],  mass: 3,   value: 45,   frag: 0.3, cls: '1h',    tough: 18 },
  register: { name: 'Cash Drawer',      shape: ['box', 0.22, 0.09, 0.2],  mass: 7,   value: 180,  frag: 0.2, cls: '1h',    tough: 22 },
  trophy:   { name: 'Bowling Trophy',   shape: ['cyl', 0.22, 0.09],       mass: 3,   value: 160,  frag: 0.5, cls: '1h',    tough: 16 },
  vase:     { name: 'Ming-ish Vase',    shape: ['cyl', 0.38, 0.2],        mass: 8,   value: 520,  frag: 2.4, cls: '2h',    tough: 8 },
  tv:       { name: 'CRT Television',   shape: ['box', 0.34, 0.3, 0.3],   mass: 22,  value: 260,  frag: 1.1, cls: '2h',    tough: 10 },
  neon:     { name: 'Neon "OPEN" Sign', shape: ['box', 0.5, 0.26, 0.05],  mass: 9,   value: 380,  frag: 2.0, cls: '2h',    tough: 8 },
  guitar:   { name: 'Signed Guitar',    shape: ['box', 0.18, 0.5, 0.06],  mass: 4,   value: 330,  frag: 0.9, cls: '2h',    tough: 12 },
  painting: { name: 'Velvet Elvis',     shape: ['box', 0.45, 0.36, 0.04], mass: 6,   value: 450,  frag: 1.2, cls: '2h',    tough: 10 },
  suitcase: { name: 'Mystery Suitcase', shape: ['box', 0.36, 0.25, 0.12], mass: 14,  value: 600,  frag: 0.25,cls: '2h',    tough: 20 },
  tire:     { name: 'Whitewall Tire',   shape: ['cyl', 0.13, 0.36],       mass: 16,  value: 60,   frag: 0.0, cls: '2h',    tough: 99 },
  slot:     { name: 'Slot Machine',     shape: ['box', 0.36, 0.7, 0.32],  mass: 85,  value: 950,  frag: 0.6, cls: 'heavy', tough: 12 },
  safe:     { name: 'Rusty Safe',       shape: ['box', 0.4, 0.42, 0.4],   mass: 150, value: 1300, frag: 0.1, cls: 'heavy', tough: 25 },
  dino:     { name: 'Fiberglass Dino Head', shape: ['box', 0.55, 0.45, 0.75], mass: 120, value: 1700, frag: 0.7, cls: 'heavy', tough: 10 },
  // not loot: tools
  map:      { name: 'Road Map',         shape: ['box', 0.2, 0.02, 0.14],  mass: 0.4, value: 0,    frag: 0,   cls: '1h',    tough: 99, tool: true },
  boulder:  { name: 'Boulder',          shape: ['box', 2.0, 1.3, 1.5],    mass: 2000,value: 0,    frag: 0,   cls: 'heavy', tough: 99, tool: true },
};

export const LOOT_KEYS = Object.keys(LOOT).filter(k => !LOOT[k].tool);

// What each kind of stop tends to have lying around.
export const POI_LOOT = {
  gas:   ['register', 'gnome', 'toaster', 'neon', 'tv', 'lamp', 'tire'],
  semi:  ['tv', 'tv', 'guitar', 'vase', 'painting', 'lamp', 'toaster'],
  yard:  ['gnome', 'gnome', 'lamp', 'toaster', 'painting', 'trophy', 'vase', 'guitar'],
  crash: ['suitcase', 'suitcase', 'safe', 'trophy'],
  junk:  ['tire', 'tire', 'slot', 'toaster', 'tv'],
  dino:  ['dino', 'gnome', 'trophy'],
};

export const fmt$ = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
