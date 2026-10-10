// Every texture family registers itself on import. Import this, then use
// canvasFor(name) (2D) or tex()/painted() from gfx.js (3D).
import './terrain.js';
import './nature.js';
import './architecture.js';
import './roadside.js';
import './vehicle.js';
import './characters.js';
import './props.js';
import './ui.js';
export * from './core.js';
// the family modules above, by file name (= the family names they register under): the texture
// cache hashes their source (texcache.js)
export const FAMILIES = ['terrain', 'nature', 'architecture', 'roadside', 'vehicle', 'characters', 'props', 'ui'];
