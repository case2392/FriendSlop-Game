// Atmosphere: the sky dome (per-biome gradient, sun and moon, stars, a band of painted clouds
// that is different for every biome), three rings of painted distant land tinted into a heavy
// haze, fog that matches the horizon, a hemisphere light with a per-biome ground bounce, a warm
// sun with soft shadows (snapped to its shadow-map texels so edges never crawl), and drifting
// motes (dust by day, fireflies at dusk, snowflakes in the mountains). No tone mapping.
// Owned by the terrain/atmosphere art pass (see docs/ART.md).
//
// API: initAtmosphere(scene, camera, renderer) once; setBiome(b) before each day's world;
// setTimeOfDay(hour, night) and updateSun(focus) every frame. `atmo` exposes a few live values
// (the snow sparkle strength) to the terrain.
import * as THREE from '/vendor/three.module.js';
import { canvasFor, has } from './paint/index.js';

let scene, camera, renderer;
let sky, skyMat, sun, hemi, rings = [], motes, motesMat;
let biome = 'meadow';
let lastNow = 0, clock = 0;
const cur = {};              // the current interpolated palette (THREE.Color / numbers)
export const atmo = { sparkle: 0, biome: 'meadow', night: 0 };   // night: 0 day .. 1 full night (lamps, lit windows)

// ---- palettes ---------------------------------------------------------------------------------
// One "day" palette per biome (docs/ART.md table), plus how dawn, golden hour, sunset, dusk and
// night bend it. Keys: top (zenith), hor (just above the horizon), fog (= the horizon itself),
// sun color, hemi sky/ground, light (scales sun + hemi: snow is bright, so its lights are lower),
// clouds (coverage: 0 = the full painted band, higher = only the dense cores), near/far fog,
// and the night's own colors (snow nights are brighter: moonlight on snow).
const DAY = {
  meadow: { top: '#4686d4', hor: '#c6dfea', fog: '#a9c6d6', hSky: '#d6e8f2', hGnd: '#6a7a42', sun: '#fff0cc', near: 40, far: 560, light: 1, clouds: 0.04,
    night: { top: '#0a1432', hor: '#22385e', fog: '#1c2c4c', hSky: '#5c74b0', hGnd: '#1e2638', hemiI: 1.45, sun: '#a6b8e8' } },
  fields: { top: '#5a9ee2', hor: '#eae4cc', fog: '#d4cfb4', hSky: '#ece8dc', hGnd: '#a08c50', sun: '#fff0c4', near: 50, far: 680, light: 1, clouds: 0.04,
    night: { top: '#0e1430', hor: '#2c3456', fog: '#242a44', hSky: '#6670a6', hGnd: '#2a2830', hemiI: 1.45, sun: '#b0b8e0' } },
  snow: { top: '#4e94dc', hor: '#e2edf4', fog: '#d2e0ec', hSky: '#e4eef8', hGnd: '#97a6bc', sun: '#fff2dc', near: 35, far: 520, light: 0.8, clouds: 0.0,
    night: { top: '#0c1a3c', hor: '#2c4874', fog: '#24385c', hSky: '#7090cc', hGnd: '#3a4a6c', hemiI: 1.55, sun: '#b4caf4' } },
  badlands: { top: '#5492d4', hor: '#f0cfb0', fog: '#dcb69c', hSky: '#ece4e0', hGnd: '#a8603a', sun: '#fff0d0', near: 50, far: 680, light: 1, clouds: 0.02,
    night: { top: '#120f2e', hor: '#3c2c50', fog: '#2c2236', hSky: '#7466a0', hGnd: '#2e2224', hemiI: 1.4, sun: '#b8b0e0' } },
  desert: { top: '#5aa4e8', hor: '#f6e2ba', fog: '#ecd6ae', hSky: '#f0ece4', hGnd: '#c89c68', sun: '#fff4d8', near: 50, far: 650, light: 0.95, clouds: 0.0,
    night: { top: '#0c1232', hor: '#30365c', fog: '#262a44', hSky: '#7078ac', hGnd: '#3a3230', hemiI: 1.45, sun: '#b0b8e4' } },
};
const MOTE = { meadow: '#fff6d0', fields: '#fff0b8', snow: '#ffffff', badlands: '#f4c89a', desert: '#f6e0b0' };
const PHASE = { meadow: 0.0, fields: 0.31, snow: 0.57, badlands: 0.12, desert: 0.79 };   // each biome's clouds start elsewhere

const C = c => new THREE.Color(c);
const mixHex = (a, b, t) => '#' + C(a).lerp(C(b), t).getHexString();

function keysFor(b) {
  const D = DAY[b], N = D.night, K = D.light;
  const day = { top: D.top, hor: D.hor, fog: D.fog, sun: D.sun, sunI: 2.15 * K, hSky: D.hSky, hGnd: D.hGnd, hemiI: 2.05 * K, shadow: 0.62,
    cLit: '#fffaf2', cShade: '#a4b0cc', cA: 1, cCov: D.clouds, mtn: 1, star: 0, mote: MOTE[b], moteA: 0.45, fire: 0, spark: 0.55, near: D.near, far: D.far };
  const golden = { ...day, top: mixHex(D.top, '#5a78c0', 0.3), hor: mixHex(D.hor, '#f8d29a', 0.5), fog: mixHex(D.fog, '#e8c08c', 0.4),
    sun: '#ffd49a', sunI: 1.95 * K, hSky: mixHex(D.hSky, '#f0dcc0', 0.5), hemiI: 1.85 * K, cLit: '#fff0d0', cShade: '#b0a0b8', moteA: 0.6, spark: 1.3 };
  const sunset = { ...day, top: '#3e5aa6', hor: '#f7b583', fog: mixHex(D.fog, '#e89c7c', 0.55), sun: '#ff9c5c', sunI: 1.45 * K,
    hSky: '#e2b6a8', hGnd: mixHex(D.hGnd, '#6a4a5a', 0.4), hemiI: 1.6 * K, shadow: 0.55, cLit: '#ffc890', cShade: '#9a7896', mtn: 0.82, moteA: 0.5, fire: 0.5, spark: 1.1,
    near: D.near * 0.85, far: D.far * 0.9 };
  const dusk = { ...day, top: '#262e68', hor: '#c06a7a', fog: mixHex('#7a5a7a', D.fog, 0.15), sun: '#ff7a58', sunI: 0.7 * K,
    hSky: '#8a7aa0', hGnd: mixHex('#3a3040', N.hGnd, 0.5), hemiI: 1.25, shadow: 0.45, cLit: '#e88a7a', cShade: '#4a3c64', cA: 0.9, mtn: 0.55, star: 0.25, moteA: 0, fire: 1, spark: 0.4,
    near: D.near * 0.6, far: D.far * 0.7 };
  const night = { ...day, top: N.top, hor: N.hor, fog: N.fog, sun: N.sun, sunI: 0.8, hSky: N.hSky, hGnd: N.hGnd, hemiI: N.hemiI, shadow: 0.4,
    cLit: '#5a6a96', cShade: '#1c2440', cA: 0.75, mtn: 0.34, star: 1, moteA: 0, fire: 1, spark: 0.35, near: 14, far: 380 };
  const dawn = { ...sunset, top: '#4a6ab4', hor: '#f2b496', fog: mixHex(D.fog, '#d8a8a0', 0.45), sun: '#ffb088', sunI: 1.2 * K, hSky: '#d0b8c0', hemiI: 1.5 * K,
    cLit: '#ffd0b0', cShade: '#8a84a8', star: 0.15, fire: 0.3, spark: 1.6 };
  if (b === 'snow') {        // cold, crisp light in the pass: warm-lit snow against blue shadows, pinker dawn
    dawn.hor = '#f6c0b0'; dawn.hSky = '#d8c4d8'; golden.hSky = mixHex(D.hSky, '#f4dcc8', 0.4);
    golden.sun = '#ffc890'; golden.hGnd = '#8290b0';
    sunset.sun = '#ffb27a'; sunset.hSky = '#c8b8d0'; sunset.hGnd = '#7a86a8'; sunset.sunI = 1.6 * K; sunset.hemiI = 1.45 * K;
  }
  return [
    [0, night], [4.6, night], [5.7, dawn], [7.2, golden], [9.0, day], [15.8, day], [17.6, golden], [18.8, sunset], [19.8, dusk], [20.9, night], [24, night],
  ];
}
const KEYS = {};
for (const b of Object.keys(DAY)) KEYS[b] = keysFor(b).map(([h, k]) => {
  const o = { h };
  for (const [n, v] of Object.entries(k)) o[n] = typeof v === 'string' ? C(v) : v;
  return o;
});
const KEYN = Object.keys(KEYS.meadow[0]).filter(n => n !== 'h');     // the keys, once (no per-frame garbage)
const COLN = KEYN.filter(n => KEYS.meadow[0][n].isColor);
const MOTEC = Object.fromEntries(Object.entries(MOTE).map(([b, c]) => [b, C(c)]));
const FIREFLY = C('#c8ff70');

// ---- shaders ---------------------------------------------------------------------------------

const SKY_VS = `varying vec3 vP;
void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }`;
const SKY_FS = `uniform vec3 top, hor, fogC, sunDir, sunCol, moonDir, cLit, cShade;
uniform float cA, cCov, star, cloudU, sunVis;
uniform sampler2D tClouds;
varying vec3 vP;
float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
void main(){
  vec3 d = normalize(vP);
  float e = d.y;
  // gradient: fog at the horizon itself, the pale horizon band just above, the zenith above that
  vec3 c = mix(hor, top, pow(smoothstep(0.0, 1.0, e), 0.55));
  c = mix(c, fogC, 1.0 - smoothstep(-0.02, 0.07, e));
  // sun glow, wide and warm along the horizon at golden hour and sunset
  float s = max(dot(d, sunDir), 0.0);
  vec2 hz = normalize(d.xz + 1e-5), sz = normalize(sunDir.xz + 1e-5);
  float az = max(dot(hz, sz), 0.0);
  float low = 1.0 - smoothstep(0.05, 0.55, sunDir.y);
  c += sunCol * (pow(s, 6.0) * 0.14 + pow(s, 48.0) * 0.3) * sunVis;
  c = mix(c, sunCol * 1.05, pow(az, 3.0) * exp(-max(e, 0.0) * 7.0) * low * 0.55 * sunVis);
  // stars
  if (star > 0.0 && e > 0.0) {
    vec3 sp = d * 220.0; vec3 ce = floor(sp); float h = h31(ce);
    if (h > 0.985) { vec3 o = vec3(h31(ce + 3.1), h31(ce + 7.7), h31(ce + 1.3)); float dd = length(sp - ce - o * 0.6 - 0.2);
      c += vec3(0.9, 0.92, 1.0) * smoothstep(0.32, 0.0, dd) * star * smoothstep(0.0, 0.25, e) * (0.4 + 0.6 * h31(ce + 9.0)); }
  }
  // the moon
  float m = dot(d, moonDir);
  c += vec3(0.85, 0.9, 1.0) * (smoothstep(0.99935, 0.99955, m) * 0.9 + pow(max(m, 0.0), 160.0) * 0.12) * star;
  // the sun disk
  c += sunCol * smoothstep(0.99955, 0.9998, s) * 1.6 * sunVis;
  // painted cumulus band: x = azimuth, y = elevation (0 at the horizon)
  float u = atan(d.z, d.x) / 6.2831853 + 0.5 + cloudU;
  float v = (e + 0.02) / 0.62;
  if (v > 0.0 && v < 1.0) {
    vec4 cl = texture2D(tClouds, vec2(u, v));
    float L = dot(cl.rgb, vec3(0.3, 0.55, 0.15));
    vec3 cc = mix(cShade, cLit, smoothstep(0.45, 0.95, L));
    cc += sunCol * pow(az, 6.0) * low * 0.35 * sunVis * (1.0 - smoothstep(0.6, 0.95, L));   // lit rims toward a low sun
    cc = mix(cc, fogC, (1.0 - smoothstep(0.0, 0.25, v)) * 0.55);                              // far clouds sink into the haze
    float a = clamp((cl.a - cCov) / max(0.05, 1.0 - cCov), 0.0, 1.0) * cA * (1.0 - smoothstep(0.8, 1.0, v));
    c = mix(c, cc, a);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const RING_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FS = `uniform sampler2D map; uniform float row, fogK, light, reps, offs; uniform vec3 fogC, hemi;
varying vec2 vUv;
void main(){
  vec2 uv = vec2(vUv.x * reps + offs, (2.0 - row + clamp(vUv.y, 0.004, 0.996)) / 3.0);
  vec4 t = texture2D(map, uv);
  if (t.a < 0.01) discard;
  vec3 c = t.rgb * hemi * light;
  float k = fogK + (1.0 - fogK) * 0.45 * (1.0 - smoothstep(0.0, 0.25, vUv.y));   // denser haze at the very foot (behind the hills), so nothing floats
  c = mix(c, fogC, clamp(k, 0.0, 1.0));
  gl_FragColor = vec4(c, t.a);
  #include <colorspace_fragment>
}`;

const MOTE_VS = `uniform float uTime, uSize, uFall; uniform vec3 uCam; attribute float aSeed; varying float vA;
void main(){
  vec3 box = vec3(44.0, 9.0, 44.0);
  vec3 p = position;
  float drift = 1.0 - uFall * 0.6;
  p.x += sin(uTime * 0.31 + aSeed * 6.0) * 1.6 + uTime * 0.35 * drift + uTime * uFall * 0.5;
  p.y += sin(uTime * 0.53 + aSeed * 11.0) * 0.7 * drift;
  p.z += cos(uTime * 0.27 + aSeed * 4.0) * 1.6 + uTime * 0.12;
  p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
  // snow falls (and wraps around the camera); dust and fireflies hover
  p.y = uCam.y - 1.6 + mod(position.y + sin(uTime * 0.4 + aSeed * 3.0) - uTime * uFall * (0.9 + aSeed * 0.6), 7.5);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  vA = (1.0 - smoothstep(12.0, 22.0, dist)) * smoothstep(0.6, 2.0, dist) * mix(0.55 + 0.45 * sin(uTime * (1.3 + aSeed) + aSeed * 40.0), 0.9, uFall);
  gl_PointSize = uSize * (0.6 + aSeed * 0.6) * 300.0 / max(dist, 0.5);
  gl_Position = projectionMatrix * mv;
}`;
const MOTE_FS = `uniform vec3 uCol; uniform float uAlpha; varying float vA;
void main(){ vec2 q = gl_PointCoord - 0.5; float r = length(q); float a = smoothstep(0.5, 0.0, r); a = a * a;
  gl_FragColor = vec4(uCol, a * vA * uAlpha);
  #include <colorspace_fragment>
}`;

// ---- setup ---------------------------------------------------------------------------------

function canvasTexture(name, { repeatU = true, mips = true } = {}) {
  const t = new THREE.CanvasTexture(canvasFor(name));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = repeatU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  if (!mips) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }   // the band is magnified; mips would seam at u = 0
  return t;
}
const cloudTex = new Map();
function clouds(b) {
  const name = has(`sky_clouds_${b}`) ? `sky_clouds_${b}` : 'sky_clouds';
  if (!cloudTex.has(name)) cloudTex.set(name, canvasTexture(name, { mips: false }));
  return cloudTex.get(name);
}
const mtnTex = new Map();
function mountains(b) {
  const name = has(`sky_mtn_${b}`) ? `sky_mtn_${b}` : 'sky_mtn_meadow';
  if (!mtnTex.has(name)) mtnTex.set(name, canvasTexture(name));
  return mtnTex.get(name);
}

export function initAtmosphere(_scene, _camera, _renderer) {
  scene = _scene; camera = _camera; renderer = _renderer;
  scene.fog = new THREE.Fog(0xb6d0e4, 60, 860);
  hemi = new THREE.HemisphereLight(0xd6e8f2, 0x6a7a42, 2.0);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff0cc, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 260;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  if ('intensity' in sun.shadow) sun.shadow.intensity = 0.62;
  scene.add(sun);
  scene.add(sun.target);

  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, fogC: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, moonDir: { value: new THREE.Vector3(0.55, 0.42, 0.72).normalize() },
      cLit: { value: new THREE.Color() }, cShade: { value: new THREE.Color() }, cA: { value: 1 }, cCov: { value: 0 }, star: { value: 0 }, cloudU: { value: 0 }, sunVis: { value: 1 },
      tClouds: { value: clouds(biome) },
    },
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
  });
  sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

  // three rings of distant ranges: drawn right after the sky, before anything else, without
  // writing depth, so the real terrain always paints over them (they are scenery, not geometry)
  // (never less hazed than the fogged hills in front of them; the near row's hero shapes sit at
  // u = 0.71, the mid row's at 0.37 / 0.87 and the far row's at 0 / 0.5: straight down the road)
  const LAYERS = [
    { row: 0, R: 1050, lo: -0.07, hi: 0.23, fogK: 0.62, light: 0.95, reps: 1, offs: 0.0 },
    { row: 1, R: 820, lo: -0.06, hi: 0.15, fogK: 0.52, light: 0.92, reps: 1, offs: 0.37 },
    { row: 2, R: 620, lo: -0.05, hi: 0.1, fogK: 0.42, light: 0.9, reps: 2, offs: 0.71 },
  ];
  rings = LAYERS.map((L, i) => {
    const h = (L.hi - L.lo) * L.R;
    const geo = new THREE.CylinderGeometry(L.R, L.R, h, 96, 1, true);
    geo.translate(0, L.lo * L.R + h / 2, 0);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, transparent: false,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { map: { value: mountains(biome) }, row: { value: L.row }, fogK: { value: L.fogK }, light: { value: L.light }, reps: { value: L.reps }, offs: { value: L.offs },
        fogC: { value: new THREE.Color() }, hemi: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: RING_VS, fragmentShader: RING_FS,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = -9 + i;
    m.frustumCulled = false;
    m.userData.L = L;
    scene.add(m);
    return m;
  });

  // motes: dust by day, fireflies at dusk, snowflakes in the pass
  const N = 160;
  const pos = new Float32Array(N * 3), seed = new Float32Array(N);
  let s = 12345;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < N; i++) { pos[i * 3] = r() * 44; pos[i * 3 + 1] = r() * 7.5; pos[i * 3 + 2] = r() * 44; seed[i] = r(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  motesMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: { value: 0 }, uSize: { value: 0.06 }, uFall: { value: 0 }, uCam: { value: new THREE.Vector3() }, uCol: { value: new THREE.Color() }, uAlpha: { value: 0 } },
    vertexShader: MOTE_VS, fragmentShader: MOTE_FS,
  });
  motes = new THREE.Points(g, motesMat);
  motes.frustumCulled = false;
  motes.renderOrder = 5;
  scene.add(motes);

  setTimeOfDay(10);
}

export function setBiome(b) {
  biome = KEYS[b] ? b : 'meadow';
  atmo.biome = biome;
  if (rings.length) { const t = mountains(biome); for (const m of rings) m.material.uniforms.map.value = t; }
  if (skyMat) skyMat.uniforms.tClouds.value = clouds(biome);
  if (skyMat) setTimeOfDay(lastHour, lastNight);
}

// ---- time of day ---------------------------------------------------------------------------

let lastHour = 10, lastNight = false;
const tmpA = new THREE.Color(), tmpB = new THREE.Color();
const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(0.55, 0.42, 0.72).normalize(), lightDir = new THREE.Vector3();

for (const n of COLN) cur[n] = new THREE.Color();
function lerpKey(a, b, t) {
  for (let i = 0; i < KEYN.length; i++) {
    const n = KEYN[i], va = a[n], vb = b[n];
    if (va.isColor) cur[n].copy(va).lerp(vb, t);
    else cur[n] = va + (vb - va) * t;
  }
}

export function setTimeOfDay(hour, night = false) {
  lastHour = hour; lastNight = night;
  if (night) hour = 22.5;
  hour = ((hour % 24) + 24) % 24;
  const K = KEYS[biome];
  let i = 0;
  while (i < K.length - 2 && hour > K[i + 1].h) i++;
  const a = K[i], b = K[i + 1];
  const t = b.h === a.h ? 0 : Math.min(1, Math.max(0, (hour - a.h) / (b.h - a.h)));
  lerpKey(a, b, t);

  // the sun's arc: up in the east (+x) at 6, down in the west (-x) just before 20
  const ang = (hour - 6.0) / 13.8 * Math.PI;
  sunDir.set(Math.cos(ang), Math.sin(ang), -0.38).normalize();
  // lights come from the sun by day and the moon by night, crossfading in the twilight
  const toMoon = Math.max(1 - smooth(4.6, 5.9, hour), smooth(19.7, 20.9, hour));
  lightDir.copy(sunDir);
  if (lightDir.y < 0.16) { lightDir.y = 0.16; lightDir.normalize(); }
  lightDir.lerp(moonDir, toMoon).normalize();

  sun.color.copy(cur.sun);
  sun.intensity = cur.sunI;
  if ('intensity' in sun.shadow) sun.shadow.intensity = cur.shadow;
  hemi.color.copy(cur.hSky);
  hemi.groundColor.copy(cur.hGnd);
  hemi.intensity = cur.hemiI;
  scene.fog.color.copy(cur.fog);
  scene.fog.near = cur.near;
  scene.fog.far = cur.far;
  sun.userData.dir = lightDir;
  atmo.sparkle = biome === 'snow' ? cur.spark : 0;
  atmo.night = Math.max(0, Math.min(1, cur.fire));

  const U = skyMat.uniforms;
  U.top.value.copy(cur.top); U.hor.value.copy(cur.hor); U.fogC.value.copy(cur.fog);
  U.sunDir.value.copy(sunDir); U.sunCol.value.copy(cur.sun);
  U.sunVis.value = smooth(-0.12, 0.02, sunDir.y);
  U.cLit.value.copy(cur.cLit); U.cShade.value.copy(cur.cShade); U.cA.value = cur.cA; U.cCov.value = cur.cCov; U.star.value = cur.star;

  // mountains take the haze color and a light level from the hemisphere sky
  tmpA.copy(cur.hSky).multiplyScalar(Math.min(1.15, cur.hemiI / 2.05) * cur.mtn);
  for (const m of rings) { m.material.uniforms.fogC.value.copy(cur.fog); m.material.uniforms.hemi.value.copy(tmpA); }

  // motes: warm dust in the day, fireflies once the light goes; snowflakes all day in the pass
  if (motesMat) {
    const U2 = motesMat.uniforms;
    if (biome === 'snow') {
      U2.uFall.value = 1;
      U2.uCol.value.copy(MOTEC.snow).lerp(cur.hSky, 0.25);
      U2.uAlpha.value = 0.55 + 0.25 * cur.star;
      U2.uSize.value = 0.075;
    } else {
      const ff = cur.fire * (biome === 'meadow' || biome === 'fields' ? 1 : 0.25);
      tmpB.copy(MOTEC[biome]).lerp(FIREFLY, Math.min(1, ff));
      U2.uFall.value = 0;
      U2.uCol.value.copy(tmpB);
      U2.uAlpha.value = Math.max(cur.moteA * (biome === 'meadow' ? 0.6 : 1), ff * 1.4);
      U2.uSize.value = ff > 0.3 ? 0.11 : 0.055;
    }
  }
}
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const sR = new THREE.Vector3(), sUp = new THREE.Vector3(), sF = new THREE.Vector3(), Y_UP = new THREE.Vector3(0, 1, 0);
export function updateSun(focus) {
  const now = performance.now() / 1000;
  const dt = lastNow ? Math.min(0.1, now - lastNow) : 0;
  lastNow = now; clock += dt;
  const d = sun.userData.dir || lightDir;
  // snap the shadow box to its own texel grid, seen from the light, so shadow edges never crawl
  sR.crossVectors(Y_UP, d).normalize(); sUp.crossVectors(d, sR);
  const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
  const fx = focus.x * sR.x + focus.y * sR.y + focus.z * sR.z, fy = focus.x * sUp.x + focus.y * sUp.y + focus.z * sUp.z;
  sF.set(focus.x, focus.y, focus.z).addScaledVector(sR, Math.round(fx / texel) * texel - fx).addScaledVector(sUp, Math.round(fy / texel) * texel - fy);
  sun.position.set(sF.x + d.x * 120, sF.y + d.y * 120, sF.z + d.z * 120);
  sun.target.position.copy(sF);
  sky.position.copy(camera.position);
  for (const m of rings) m.position.copy(camera.position);
  skyMat.uniforms.cloudU.value = (clock * 0.0009 + PHASE[biome]) % 1;
  if (motesMat) { motesMat.uniforms.uTime.value = clock; motesMat.uniforms.uCam.value.copy(camera.position); }
}
