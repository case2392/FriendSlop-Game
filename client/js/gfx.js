// Renderer, camera, sky, sun, fog, and shared helpers. Toy-diorama look:
// flat-shaded facets, saturated desert palette, strong sun, ACES.
import * as THREE from '/vendor/three.module.js';

export { THREE };
export let renderer, scene, camera;
let sky, skyMat, sun, hemi, sunDisk;

export function canvasTex(cv, { repeat = null, nearest = false } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  if (nearest) { t.magFilter = THREE.NearestFilter; }
  return t;
}

const matCache = new Map();
export function flat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...opts }));
  }
  return matCache.get(key);
}

export function initGfx(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 0.05, 1400);
  scene.add(camera);
  scene.fog = new THREE.Fog(0xf0c89a, 120, 620);

  hemi = new THREE.HemisphereLight(0xbfe3ff, 0xc9905a, 0.85);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 260;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(sun.target);

  // gradient sky dome
  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3d8ee8) },
      mid: { value: new THREE.Color(0xa7d3f5) },
      bot: { value: new THREE.Color(0xf7d9a8) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunCol: { value: new THREE.Color(0xfff2cc) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, pow(clamp(h*1.6,0.0,1.0),0.8)) : mix(mid, bot, clamp(-h*5.0,0.0,1.0));
        c = mix(c, bot, smoothstep(0.18, -0.02, h) * 0.6);
        float s = max(dot(normalize(vP), sunDir), 0.0); c += sunCol * (pow(s, 600.0) * 2.5 + pow(s, 12.0) * 0.25);
        gl_FragColor = vec4(c, 1.0); }`,
  });
  sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  window.addEventListener('resize', resize);
  resize();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const lerpC = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);
// key colors through the day: [hour, top, mid, bottom, sunColor, sunIntensity, hemiIntensity, fog]
const KEYS = [
  [3.5, 0x1b2247, 0x4b4f86, 0xd98a6a, 0xff9a62, 0.4, 0.35, 0x6d5d7d],
  [5.6, 0x4a86d4, 0xf4c7a1, 0xf7b27a, 0xffc890, 1.9, 0.75, 0xf2c39a],
  [7.5, 0x3b84dc, 0xbfdcf2, 0xf5cf9c, 0xffe2b8, 2.4, 0.85, 0xf0cba2],
  [10, 0x2f7fe0, 0x9fd0f6, 0xf3dcb0, 0xfff1d6, 2.7, 0.9, 0xeed2ad],
  [15, 0x2b78da, 0xa6d2f4, 0xf3d8a8, 0xfff0d0, 2.7, 0.9, 0xeccfa6],
  [18.3, 0x3c5fb0, 0xf6b48a, 0xff8d5c, 0xff9c5a, 2.0, 0.65, 0xeca27e],
  [19.6, 0x2a2f6e, 0xb2618a, 0xff7a52, 0xff6e4a, 1.0, 0.45, 0x9a6278],
  [21, 0x0b1030, 0x1f2a5a, 0x3b2f55, 0x9fb4ff, 0.42, 0.32, 0x22263f],
  [24.5, 0x060a1f, 0x131b3e, 0x21203a, 0x8ea6ff, 0.34, 0.28, 0x161a2e],
];

export function setTimeOfDay(hour, night = false) {
  if (night) hour = 22.5;
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) if (hour >= KEYS[i][0] && hour <= KEYS[i + 1][0]) { a = KEYS[i]; b = KEYS[i + 1]; break; }
  const t = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (hour - a[0]) / (b[0] - a[0])));
  skyMat.uniforms.top.value.copy(lerpC(a[1], b[1], t));
  skyMat.uniforms.mid.value.copy(lerpC(a[2], b[2], t));
  skyMat.uniforms.bot.value.copy(lerpC(a[3], b[3], t));
  sun.color.copy(lerpC(a[4], b[4], t));
  sun.intensity = a[5] + (b[5] - a[5]) * t;
  hemi.intensity = a[6] + (b[6] - a[6]) * t;
  scene.fog.color.copy(lerpC(a[7], b[7], t));
  renderer.toneMappingExposure = hour > 20 || hour < 6 ? 1.25 : 1.05;
  // sun arc: rises east (+x), sets west (-x), slightly south
  const ang = ((Math.min(Math.max(hour, 4.2), 20.6) - 4.0) / 17) * Math.PI;
  const dir = new THREE.Vector3(Math.cos(ang), Math.max(0.12, Math.sin(ang)), -0.35).normalize();
  if (hour > 20.5 || hour < 5) dir.set(-0.3, 0.8, 0.4).normalize(); // moonlight
  skyMat.uniforms.sunDir.value.copy(dir);
  skyMat.uniforms.sunCol.value.copy(sun.color);
  sun.userData.dir = dir;
}

export function updateSun(focus) {
  const d = sun.userData.dir || new THREE.Vector3(0.3, 1, -0.3);
  sun.position.set(focus.x + d.x * 120, focus.y + d.y * 120, focus.z + d.z * 120);
  sun.target.position.set(focus.x, focus.y, focus.z);
  sky.position.copy(camera.position);
}

export function render() { renderer.render(scene, camera); }

// ---- text ---------------------------------------------------------------------------

export function textCanvas(lines, { w = 512, h = 256, bg = '#fff', fg = '#111', font = 'Trebuchet MS', bold = true, border = null, neon = false, painted = false } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  if (bg && bg !== 'rgba(0,0,0,0)') { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  if (border) { g.strokeStyle = border; g.lineWidth = 14; g.strokeRect(7, 7, w - 14, h - 14); }
  const n = lines.length;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((ln, i) => {
    let size = Math.floor(h / (n + 0.6) * (i === 0 ? 0.92 : 0.66));
    g.font = `${bold ? 'bold ' : ''}${size}px '${font}', sans-serif`;
    while (g.measureText(ln).width > w * 0.92 && size > 8) { size -= 2; g.font = `${bold ? 'bold ' : ''}${size}px '${font}', sans-serif`; }
    const y = h * (i + 0.8) / (n + 0.6);
    if (neon) { g.shadowColor = fg; g.shadowBlur = 18; }
    if (painted) {
      g.globalAlpha = 0.9;
      g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.25)'; g.strokeText(ln, w / 2 + 3, y + 3);
    }
    g.fillStyle = fg;
    g.fillText(ln, w / 2, y);
    g.shadowBlur = 0; g.globalAlpha = 1;
  });
  return cv;
}

export function labelSprite(text, color = '#fff', px = 40) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 96;
  const tex = canvasTex(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.45, 1);
  sp.userData.set = (t, c = color) => {
    if (sp.userData.t === t && sp.userData.c === c) return;
    sp.userData.t = t; sp.userData.c = c;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 512, 96);
    g.font = `bold ${px}px 'Trebuchet MS', sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = 'rgba(20,16,31,0.85)'; g.strokeText(t, 256, 50);
    g.fillStyle = c; g.fillText(t, 256, 50);
    tex.needsUpdate = true;
  };
  sp.userData.set(text, color);
  return sp;
}

// jiggle vertices for a hand-made faceted look
export function roughen(geo, amp, seed = 1) {
  const p = geo.attributes.position;
  let s = seed * 9301;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, [rnd() * amp, rnd() * amp, rnd() * amp]);
    const d = seen.get(k);
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

export function shadowy(obj, cast = true, receive = true) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}
