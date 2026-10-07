// Text on canvases: sign faces and floating name plates. Owned by the UI art pass.
import * as THREE from '/vendor/three.module.js';
import { canvasTex } from './gfx.js';

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
    let size = px;   // shrink long text to fit the canvas instead of clipping it
    g.font = `bold ${size}px 'Trebuchet MS', sans-serif`;
    while (g.measureText(t).width > 488 && size > 12) { size -= 2; g.font = `bold ${size}px 'Trebuchet MS', sans-serif`; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = 'rgba(20,16,31,0.85)'; g.strokeText(t, 256, 50);
    g.fillStyle = c; g.fillText(t, 256, 50);
    tex.needsUpdate = true;
  };
  sp.userData.set(text, color);
  return sp;
}

