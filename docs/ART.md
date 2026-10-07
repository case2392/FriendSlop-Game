# NO MONEY DOWN — art bible

**Target: World of Warcraft Classic (2004), with Old School RuneScape's chunky
silhouettes.** Hand-painted textures on chunky low-poly models with smooth
shading. It should look like a 2004 MMO zone, painted by hand, and *not* like
procedural or AI-generated "low poly indie" art.

Reference frames from the clip the user supplied (Elwynn Forest / Goldshire)
are in `docs/reference/frames/`, so look at them. The zones we borrow from:

| Day | Biome | WoW zone it should feel like | Town style |
|---|---|---|---|
| 1 | `meadow` | Elwynn Forest: lush green, huge gnarled oaks, gray rock outcrops, dirt roads | `timber`: Goldshire. Timber-framed cream plaster, dark beams, steep red shingle roofs, chimneys, stone bases |
| 2 | `fields` | Westfall: golden grass and wheat, haybales, scarecrows, rail fences, dusty roads | `farm`: Westfall farmsteads. Weathered plank barns, thatch or gambrel roofs, a windmill, wagon wheels, hay |
| 3 | `snow` | Dun Morogh: snowfields, snow-laden pines, blue-gray granite with snow on every ledge, icy blue shadows, frozen streams | `alpine`: Kharanos. Squat dwarven stone halls, massive timber, steep roofs heavy with snow, iron braziers, warm windows |
| 4 | `badlands` | The Badlands / Thousand Needles: red-orange canyon rock with horizontal strata, dead trees, ochre dust | `frontier`: Kargath / a canyon outpost. Rough log and plank, palisade stakes, hides and canvas, rope, ramshackle roofs |
| 5 | `desert` | Tanaris / Gadgetzan: pale sand, dunes, palms, sun-bleached bones | `adobe`: Gadgetzan. Tan adobe walls, dark wood beams poking out, flat roofs, canvas awnings, goblin brass and rivets |

All five days must look clearly different: ground, sky, fog, rocks, plants
and towns. Nobody should ever confuse one day's screenshot for another's.

## Banned: what makes the current build look like AI slop

- **Flat shading or faceted geometry.** No `flatShading: true`, ever. Use
  smooth normals.
- **Per-pixel random noise as "texture."** Detail must look *painted*: shapes,
  strokes and blotches, never TV static.
- **Solid-color untextured boxes.** Every visible surface gets a painted
  texture, or at least painted vertex-color gradients.
- **Perfect regularity.** No identical tiles, mirror-symmetric everything, or
  evenly spaced anything. Jitter, vary and wear it.
- **Pure saturated primaries** (`#ff0000`, `#00ff00`, neon pink). Classic
  WoW is warm and slightly muted, with colorful accents.
- **Toy and googly-eye proportions** on people: no giant cartoon eyes, no
  top hats on egg bodies. People are stylized *humans*.
- **Hard black outlines and plastic specular shine.**
- **ACES / high-contrast "cinematic" grading.** Classic WoW is bright, soft
  and hazy.
- **Text-wall signs with neon glow everywhere.** Signs are carved, painted
  wooden boards with short words.

## Required: what makes it WoW Classic

1. **Hand-painted diffuse textures with the lighting baked in.** Light comes
   from the upper left. Highlights are warm (yellow-cream), shadows are cool
   (blue-purple-brown) and soft. Every stone, plank and shingle has a lit
   edge and a shadowed edge painted in. Crevices and grout are dark and
   soft-edged, never pure black.
2. **Painterly color variation.** A mid-tone base, then large soft blotches
   in 2–3 related hues, then medium shapes (clumps, stones, planks), then
   small details (blades, pebbles, grain, cracks), then highlights and
   shadows, then a subtle unifying glaze.
3. **Chunky, low-poly silhouettes with smooth shading.** Exaggerated
   proportions: big hands, big feet, broad shoulders, thick tree trunks,
   heavy roofs with deep overhangs, beefy door frames. Taper things and lean
   them slightly. Nothing is a perfect box.
4. **Terrain is a painted ground, not geometry color.** Grass, dirt, rock
   and accent textures are blended softly (splatting) by slope, height, road
   distance and noise. Cliffs get vertical streaks and strata. Road edges
   fade into grass with ragged painterly borders.
5. **Atmosphere.** Fog whose color matches the sky's horizon; distant
   mountain silhouettes and painted clouds; blob shadows under characters
   and props; ground clutter (grass tufts, flowers) near the camera; dust
   motes and fireflies at dusk.
6. **Readable at a distance.** Big shapes and clear values first, detail
   second.

## Palettes (starting points, not law)

| Biome | Grass / ground | Dirt / road | Rock | Sky top → horizon | Fog |
|---|---|---|---|---|---|
| meadow | `#4f7d2a` `#6f9c34` `#9cb447` (lit tips) | `#7c5b3a` `#9a7650` | `#77746e` `#97918a` mossy `#6d7a4a` | `#5d9fd8` → `#cfe6e2` | `#a8c8c4` |
| fields | `#a99a45` `#c9ac52` `#e2c56a` wheat | `#94704a` `#b18c5c` | `#8a8170` | `#7fb6e6` → `#efe2b8` | `#dccfa4` |
| snow | snow `#e8eef4` `#cfdbe6` (blue shadow) `#f7f4ec` (sunlit) | slush/gravel `#8a8478` `#a39d90` | granite `#6f7682` `#8e96a3` | `#5f9edc` → `#e4eef4` | `#d6e2ec` |
| badlands | dust `#b98457` `#cf9a62` | `#a77650` | strata `#8e3e22` `#b4552f` `#cf7a45` `#e3a066` | `#6aa2d8` → `#f0c9a0` | `#d9a982` |
| desert | sand `#d9b87f` `#e8cc96` `#c79c62` | `#bf9a68` | `#b7895e` `#d4ab7c` | `#78b6e8` → `#f6e3b8` | `#efd8aa` |

## Technical conventions

- **Textures** are painted procedurally on `<canvas>` with the toolkit in
  `client/js/paint/core.js`, and registered by name in family files under
  `client/js/paint/`. Size: 512 for terrain and architecture, 256 for props,
  characters and small things. **Everything that tiles must tile
  seamlessly** (use `wrap()` for any mark near an edge). Paint functions are
  deterministic: use the `rnd` you're given, never `Math.random`.
- **Materials:** use `painted(name, { repeat, tint, alphaTest, side })` from
  `client/js/gfx.js`. It returns a smooth `MeshLambertMaterial` with the
  painted texture. Metals may use `MeshPhongMaterial` with shininess ≤ 25.
  No `MeshStandardMaterial` roughness/metalness look.
- **Geometry:** indexed geometry with `computeVertexNormals()`; cylinders
  8–12 sides; spheres 10–16 segments. Chamfer or bevel box edges where it's
  cheap. Merge static geometry per material where you can (draw calls
  matter).
- **Lighting** (in `gfx.js`): hemisphere light (sky/ground colors per biome)
  plus a warm directional sun with soft, low-intensity shadows. No tone
  mapping (classic look); sRGB output; fog per biome and time of day.
- **Scale:** 1 unit = 1 m. Characters are about 1.8 m. The RV is 8 m × 2.5 m
  × 2.4 m.

## How to check your work

```bash
node tools/gallery.mjs [family] [out.png]           # every registered texture, tiled 2×2 to show seams
node tools/preview.mjs name1,name2 [out.png] [biome] # 3D assets on a ground patch with game lighting
ONLY=camp,riding node tools/docshots.mjs            # real in-game screenshots → docs/screenshots/
```

Read the PNG and look at it critically, *next to the reference frames*.
Ask: "Would this pass as a 2004 Blizzard texture or model? Or would someone
say 'AI made this'?"
