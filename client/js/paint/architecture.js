// Texture family: architecture. See docs/ART.md for the style rules.
// Textures this family is expected to provide (register them by these names):
//   plaster_white plaster_tan timber_beam wood_planks wood_planks_weathered shingles_red shingles_blue roof_clay
//   stone_wall flagstone door_wood window_lit window_dark sign_board carpet_casino felt_green metal_riveted brass canvas_awning
import { register, fill, rowLayout, paintRects, mottle, cracks, glaze, blurTile, blob, range } from './core.js';

// ---- quality anchor: Goldshire bridge flagstones ------------------------------------------
register('flagstone', {
  family: 'architecture', size: 512, note: 'anchor: painted flagstones',
  paint(g, s, rnd, h, cv) {
    const rects = rowLayout(s, rnd, { rows: 5, minW: 80, maxW: 190, rowJitter: 0.3 });
    paintRects(g, s, rects, rnd, {
      colors: ['#a59c8d', '#958d80', '#b4aa98', '#9c9387', '#ada392'],
      gap: 5, gapColor: '#4c4348', radius: 8, bevel: 6, light: 0.45, varAmt: 0.09,
      inner(gg, X, Y, w, hh, c, r) {
        for (let i = 0; i < 6; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 14, 46), range(r, 10, 30), r() * 3, r() < 0.5 ? '#c8bfae' : '#857c72', 0.22, 0.15);
        for (let i = 0; i < 3; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 3, 7), range(r, 2, 5), r() * 3, '#6f675f', 0.35, 0.4);
      },
    });
    cracks(g, s, rnd, { color: '#3a3238', count: 7, len: [16, 50], width: [0.8, 1.5], alpha: 0.5 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 14, rmin: 8, rmax: 26, alpha: 0.18, hard: 0.2 });  // a little moss
    glaze(g, s, s, '#ffe2b0', 0.1, 'soft-light');
    blurTile(cv, 0.3);
  },
});
