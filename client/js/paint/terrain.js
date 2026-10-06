// Texture family: terrain. See docs/ART.md for the style rules.
// Textures this family is expected to provide (register them by these names):
//   ground_<biome>, ground2_<biome>, road_<biome>, cliff_<biome>   for biome in meadow|fields|badlands|desert
//   mud, cobble, clutter_grass_<biome>(alpha), clutter_flowers(alpha)
import { register, fill, mottle, blade, pebbles, cracks, glaze, blurTile, range, pick, wrap, blob } from './core.js';

// ---- quality anchor: painted meadow grass (Elwynn) ----------------------------------------
register('ground_meadow', {
  family: 'terrain', size: 512, note: 'anchor: Elwynn grass',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#557f2e');
    // big soft color fields
    mottle(g, s, rnd, { colors: ['#466f27', '#68973a', '#7ba43f', '#517a2b', '#8c9c3c'], count: 46, rmin: 50, rmax: 150, alpha: 0.38, hard: 0.08 });
    // clumps
    mottle(g, s, rnd, { colors: ['#3c6522', '#74a43c', '#5d8a30'], count: 140, rmin: 10, rmax: 34, alpha: 0.3, hard: 0.3, stretch: 1.3 });
    // blades: dark underlayer, mid, then lit tips
    const pass = (n, cols, lmin, lmax, wmin, wmax, a) => {
      for (let i = 0; i < n; i++) {
        const x = rnd() * s, y = rnd() * s, len = range(rnd, lmin, lmax);
        const ang = range(rnd, -0.45, 0.55), w = range(rnd, wmin, wmax), c = pick(rnd, cols);
        wrap(s, x, y, len + 2, (xx, yy) => blade(g, xx, yy, len, ang, w, c, a, range(rnd, -0.3, 0.4)));
      }
    };
    pass(1400, ['#2f5419', '#3a611f'], 7, 15, 1.6, 2.6, 0.55);
    pass(1500, ['#5b8c2f', '#66983a', '#527f2b'], 7, 14, 1.4, 2.4, 0.6);
    pass(700, ['#9cbf55', '#b2cc63', '#8db24a'], 5, 10, 1.1, 1.8, 0.55);
    // a few tiny wildflowers
    for (let i = 0; i < 28; i++) {
      const x = rnd() * s, y = rnd() * s, c = pick(rnd, ['#f4e7a1', '#fffbe6', '#e7c2e8']);
      wrap(s, x, y, 4, (xx, yy) => { blob(g, xx, yy, 2.6, 2.2, 0, c, 0.9, 0.6); blob(g, xx - 0.6, yy - 0.6, 1.2, 1, 0, '#ffffff', 0.7, 0.5); });
    }
    glaze(g, s, s, '#ffe7a0', 0.1, 'soft-light');
    blurTile(cv, 0.35);
  },
});

// ---- quality anchor: packed dirt road with lit pebbles ---------------------------------------
register('road_meadow', {
  family: 'terrain', size: 512, note: 'anchor: Elwynn dirt road',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#86663f');
    mottle(g, s, rnd, { colors: ['#755636', '#987650', '#a48459', '#6a4e32', '#8f7448'], count: 60, rmin: 40, rmax: 130, alpha: 0.36, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#5f4530', '#b0926a'], count: 160, rmin: 6, rmax: 22, alpha: 0.22, hard: 0.35, stretch: 1.6 });
    pebbles(g, s, rnd, { colors: ['#b39a77', '#9c8466', '#c7b394', '#80695a', '#a89a88'], count: 300, rmin: 1.5, rmax: 4.5 });
    pebbles(g, s, rnd, { colors: ['#a8957c', '#8c7a66'], count: 40, rmin: 5, rmax: 9 });
    cracks(g, s, rnd, { color: '#4a3424', count: 5, len: [18, 46], width: [0.8, 1.6], alpha: 0.45 });
    glaze(g, s, s, '#ffdca0', 0.08, 'soft-light');
    blurTile(cv, 0.3);
  },
});
