import * as C from '/shared/constants.js';
import { sfx } from './sfx.js';

let canvas, ctx;
let shake = 0;
let time = 0;
const particles = [];
const splats = [];       // persistent goo stains where blobs died
const floaters = [];     // emotes / +coin text above blobs
export const blobs = new Map(); // id -> {x,y,tx,ty,alive,score,dashCd,dashing}

export function initRender(cv) {
  canvas = cv;
  ctx = canvas.getContext('2d');
}

export function resetArena() {
  particles.length = 0;
  splats.length = 0;
  floaters.length = 0;
  blobs.clear();
}

export function addFloater(x, y, text, color = '#fff', size = 30) {
  floaters.push({ x, y, text, color, size, life: 1.6 });
}

export function emoteAt(id, e) {
  const b = blobs.get(id);
  if (b) addFloater(b.x, b.y - 55, e, '#fff', 44);
}

function burst(x, y, color, n, speed = 260, life = 0.7, size = 7) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random() * 0.7);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * (0.5 + Math.random() * 0.5), maxLife: life, color, size });
  }
}

// Apply a server snapshot: update blob targets and fire event feedback.
export function applySnapshot(snap, meta, selfId) {
  const seen = new Set();
  for (const [id, x, y, alive, score, dashCd, dashing, events] of snap.players) {
    seen.add(id);
    let b = blobs.get(id);
    const info = meta?.players.find(p => p.id === id);
    if (!b) {
      b = { id, x, y, tx: x, ty: y, alive: !!alive, score, dashCd, dashing, color: info?.color || '#fff', name: info?.name || '?', wasAlive: !!alive };
      blobs.set(id, b);
    }
    b.tx = x; b.ty = y;
    b.score = score; b.dashCd = dashCd; b.dashing = !!dashing;
    b.color = info?.color || b.color;
    b.name = info?.name || b.name;

    if (b.wasAlive && !alive) {
      splats.push({ x, y, color: b.color, r: 40 + Math.random() * 15, rot: Math.random() * Math.PI });
      burst(x, y, b.color, 26, 380, 0.9, 9);
      shake = Math.max(shake, 14);
    }
    b.wasAlive = b.alive = !!alive;

    for (const ev of events || []) {
      if (ev === 'dash') { burst(x, y, '#ffffff55', 6, 120, 0.3, 5); if (id === selfId) sfx.dash(); }
      else if (ev === 'bonk') { burst(x, y, '#fff', 8, 220, 0.4, 5); sfx.bonk(); }
      else if (ev === 'splat') { if (id === selfId) sfx.splat(); else sfx.splat(); }
      else if (ev === 'boom') { burst(x, y, '#ff9040', 40, 520, 1.1, 11); shake = Math.max(shake, 26); sfx.boom(); }
      else if (ev === 'coin') { addFloater(x, y - 40, '+', '#FFD84D', 22); if (id === selfId) sfx.coin(); }
      else if (ev === 'tater') { burst(x, y, '#ffb060', 12, 200, 0.5, 6); sfx.tater(); }
      else if (ev === 'robbed') { addFloater(x, y - 40, '💸', '#fff', 30); if (id === selfId) sfx.robbed(); }
      else if (ev === 'fall') { sfx.splat(); }
    }
  }
  for (const id of blobs.keys()) if (!seen.has(id)) blobs.delete(id);
}

// ---- drawing ---------------------------------------------------------------

function drawBlob(b, extra, meta) {
  const { x, y } = b;
  const r = C.PLAYER_RADIUS;
  const wob1 = Math.sin(time * 5 + b.id * 2.1) * 2.2;
  const wob2 = Math.cos(time * 4.2 + b.id * 1.3) * 2.2;
  const vx = b.tx - x, vy = b.ty - y;
  const sp = Math.hypot(vx, vy);

  ctx.save();
  ctx.translate(x, y);

  // shadow
  ctx.fillStyle = '#00000055';
  ctx.beginPath();
  ctx.ellipse(0, r * 0.75, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // dashing aura
  if (b.dashing) {
    ctx.fillStyle = b.color + '44';
    ctx.beginPath();
    ctx.arc(0, 0, r + 12, 0, Math.PI * 2);
    ctx.fill();
  }

  // squishy body: irregular rounded blob
  ctx.fillStyle = b.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, r + wob1, r + wob2, sp * 0.002, 0, Math.PI * 2);
  ctx.fill();
  // glossy highlight
  ctx.fillStyle = '#ffffff33';
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, -r * 0.35, r * 0.45, r * 0.3, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // eyes look where you're going
  const lx = sp > 2 ? (vx / sp) * 5 : 0;
  const ly = sp > 2 ? (vy / sp) * 5 : 0;
  for (const ex of [-9, 9]) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex, -6, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1426';
    ctx.beginPath(); ctx.arc(ex + lx, -6 + ly, 4, 0, Math.PI * 2); ctx.fill();
  }

  // hot tater!
  if (extra && extra.taterId === b.id) {
    const pulse = 1 + Math.sin(time * 10) * 0.12;
    ctx.font = `${Math.round(34 * pulse)}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText('🥔', 0, -r - 14);
    ctx.strokeStyle = `rgba(255,60,60,${0.5 + Math.sin(time * 12) * 0.4})`;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, r + 8, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();

  // name + score label
  ctx.font = 'bold 16px Trebuchet MS';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00000099';
  ctx.fillText(b.name, x + 1, y - r - 13);
  ctx.fillStyle = b.color;
  ctx.fillText(b.name, x, y - r - 14);
  if (b.score > 0) {
    ctx.fillStyle = '#FFD84D';
    ctx.fillText(`${b.score}`, x, y + r + 22);
  }
  // dash cooldown pip
  if (b.dashCd > 0) {
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + (1 - b.dashCd / C.DASH_CD) * Math.PI * 2);
    ctx.stroke();
  }
}

function drawArena(minigame, extra) {
  const W = C.ARENA_W, H = C.ARENA_H;

  if (minigame === 'sumo') {
    // lava
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#4a1206');
    g.addColorStop(1, '#7a2408');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 14; i++) {
      const bx = (i * 269) % W, by = (i * 173 + time * 30) % H;
      ctx.fillStyle = 'rgba(255,120,30,0.16)';
      ctx.beginPath(); ctx.arc(bx, by, 22 + (i % 5) * 8, 0, Math.PI * 2); ctx.fill();
    }
    // the shrinking slab
    const ring = extra?.ring || 400;
    const rg = ctx.createRadialGradient(W / 2, H / 2, ring * 0.2, W / 2, H / 2, ring);
    rg.addColorStop(0, '#3c3357');
    rg.addColorStop(1, '#2a2440');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, ring, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ff8a3c';
    ctx.lineWidth = 6;
    ctx.stroke();
  } else if (minigame === 'floor') {
    ctx.fillStyle = '#080614';
    ctx.fillRect(0, 0, W, H);
    if (extra?.tiles) {
      const { cols, tile, offsetY } = extra;
      for (let i = 0; i < extra.tiles.length; i++) {
        const s = extra.tiles[i];
        if (s === '2') continue; // the void
        const tx = (i % cols) * tile, ty = Math.floor(i / cols) * tile + offsetY;
        ctx.fillStyle = s === '0' ? (((i % cols) + Math.floor(i / cols)) % 2 ? '#3f9d4c' : '#379046') : '#6e5a2e';
        ctx.fillRect(tx + 2, ty + 2, tile - 4, tile - 4);
        if (s === '1') { // cracks
          ctx.strokeStyle = '#00000088';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tx + tile * 0.2, ty + tile * 0.3);
          ctx.lineTo(tx + tile * 0.55, ty + tile * 0.5);
          ctx.lineTo(tx + tile * 0.4, ty + tile * 0.8);
          ctx.moveTo(tx + tile * 0.55, ty + tile * 0.5);
          ctx.lineTo(tx + tile * 0.85, ty + tile * 0.35);
          ctx.stroke();
        }
      }
    }
  } else {
    // walled pit (tater, grab)
    const g = ctx.createRadialGradient(W / 2, H / 2, 100, W / 2, H / 2, 900);
    g.addColorStop(0, '#2c2447');
    g.addColorStop(1, '#191330');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#4a3d75';
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    // floor dots
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath(); ctx.arc((i * 397) % W, (i * 251) % H, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  if (minigame === 'grab' && extra?.coins) {
    for (const [, x, y, v] of extra.coins) {
      const golden = v >= 10;
      const r = golden ? 16 : 9 + v;
      const bob = Math.sin(time * 4 + x * 0.01) * 3;
      ctx.fillStyle = golden ? '#FFD84D' : '#e8b93c';
      ctx.beginPath(); ctx.arc(x, y + bob, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff8';
      ctx.beginPath(); ctx.arc(x - r * 0.3, y + bob - r * 0.3, r * 0.3, 0, Math.PI * 2); ctx.fill();
      if (golden) {
        ctx.font = '14px serif'; ctx.textAlign = 'center';
        ctx.fillStyle = '#7a5b00';
        ctx.fillText('10', x, y + bob + 5);
      }
    }
  }
}

export function frame(dt, S) {
  if (!ctx) return;
  time += dt;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 60);
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  }

  const extra = S.snap?.extra;
  drawArena(S.minigame, extra);

  // goo stains
  for (const s of splats) {
    ctx.fillStyle = s.color + '66';
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, s.r, s.r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // blobs (dead ones are stains only)
  const list = [...blobs.values()].filter(b => b.alive);
  for (const b of list) {
    const k = 1 - Math.pow(0.00002, dt); // aggressive lerp toward server pos
    b.x += (b.tx - b.x) * k;
    b.y += (b.ty - b.y) * k;
  }
  list.sort((a, b) => a.y - b.y);
  for (const b of list) drawBlob(b, extra, S.meta);

  // fuse readout for hot tater
  if (S.minigame === 'tater' && extra?.fuse !== undefined) {
    const holder = blobs.get(extra.taterId);
    if (holder && holder.alive) {
      ctx.font = 'bold 26px Trebuchet MS';
      ctx.textAlign = 'center';
      ctx.fillStyle = extra.fuse < 3 ? '#ff5252' : '#ffd84d';
      ctx.fillText(extra.fuse.toFixed(1), holder.x, holder.y - C.PLAYER_RADIUS - 46);
    }
  }

  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.96; p.vy *= 0.96;
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (p.life / p.maxLife), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // floaters
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    if (f.life <= 0) { floaters.splice(i, 1); continue; }
    f.y -= dt * 40;
    ctx.globalAlpha = Math.min(1, f.life);
    ctx.font = `bold ${f.size}px Trebuchet MS`;
    ctx.textAlign = 'center';
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

export function confetti() {
  for (let i = 0; i < 120; i++) {
    particles.push({
      x: Math.random() * C.ARENA_W,
      y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 100,
      vy: 150 + Math.random() * 250,
      life: 2 + Math.random() * 2,
      maxLife: 4,
      color: C.SLOP_COLORS[i % C.SLOP_COLORS.length],
      size: 6 + Math.random() * 5,
    });
  }
}
