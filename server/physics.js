import * as C from '../shared/constants.js';

// Advance one player's movement for dt seconds. Consumes edge-triggered dash input.
export function stepMovement(p, dt) {
  let mx = Number(p.input.mx) || 0;
  let my = Number(p.input.my) || 0;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  if (p.freeze) { mx = 0; my = 0; }

  p.vx += mx * C.ACCEL * dt;
  p.vy += my * C.ACCEL * dt;

  p.dashCd = Math.max(0, p.dashCd - dt);
  p.dashTime = Math.max(0, p.dashTime - dt);
  if (p.input.dash) {
    p.input.dash = false;
    if (p.dashCd === 0 && !p.freeze) {
      const dir = (mx || my) ? { x: mx, y: my } : { x: Math.cos(p.face), y: Math.sin(p.face) };
      p.vx = dir.x * C.DASH_SPEED;
      p.vy = dir.y * C.DASH_SPEED;
      p.dashCd = C.DASH_CD;
      p.dashTime = C.DASH_TIME;
      p.events.push('dash');
    }
  }

  const max = p.dashTime > 0 ? C.DASH_SPEED : C.MAX_SPEED * (p.speedMult || 1);
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }

  const f = Math.pow(C.FRICTION, dt * 60);
  p.vx *= f; p.vy *= f;
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  if (mx || my) p.face = Math.atan2(my, mx);
}

// Resolve pairwise circle collisions among alive players.
// onHit(a, b) is called once per colliding pair after separation/impulse.
export function collidePlayers(players, onHit) {
  const list = players.filter(p => p.alive);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = C.PLAYER_RADIUS * 2;
      if (dist >= minDist || dist === 0) continue;
      const nx = dx / dist, ny = dy / dist;
      const overlap = minDist - dist;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2; b.y += ny * overlap / 2;

      // Exchange velocity along the normal (equal mass, restitution).
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const relN = rvx * nx + rvy * ny;
      if (relN < 0) {
        const restitution = 0.85;
        const imp = -(1 + restitution) * relN / 2;
        a.vx -= imp * nx; a.vy -= imp * ny;
        b.vx += imp * nx; b.vy += imp * ny;
      }

      // Dashing blobs hit like trucks.
      if (a.dashTime > 0 && b.dashTime <= 0) { b.vx += nx * 420; b.vy += ny * 420; b.events.push('bonk'); }
      if (b.dashTime > 0 && a.dashTime <= 0) { a.vx -= nx * 420; a.vy -= ny * 420; a.events.push('bonk'); }

      if (onHit) onHit(a, b);
    }
  }
}

// Keep player inside a rectangle, bouncing off walls.
export function boundRect(p, w, h) {
  const r = C.PLAYER_RADIUS;
  if (p.x < r) { p.x = r; p.vx = Math.abs(p.vx) * C.WALL_BOUNCE; }
  if (p.x > w - r) { p.x = w - r; p.vx = -Math.abs(p.vx) * C.WALL_BOUNCE; }
  if (p.y < r) { p.y = r; p.vy = Math.abs(p.vy) * C.WALL_BOUNCE; }
  if (p.y > h - r) { p.y = h - r; p.vy = -Math.abs(p.vy) * C.WALL_BOUNCE; }
}

// The chain. Consecutive blobs are tethered: when a link stretches past
// maxLen, both ends get yanked together — positions corrected, momentum
// shared so a dashing friend drags the whole squad.
export function applyChain(chain, maxLen, iters = 3) {
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i], b = chain[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.001;
      if (d <= maxLen) continue;
      const pull = (d - maxLen) / d * 0.5;
      a.x += dx * pull; a.y += dy * pull;
      b.x -= dx * pull; b.y -= dy * pull;
      if (k === 0) {
        const mvx = (a.vx + b.vx) / 2, mvy = (a.vy + b.vy) / 2;
        a.vx = a.vx * 0.65 + mvx * 0.35; a.vy = a.vy * 0.65 + mvy * 0.35;
        b.vx = b.vx * 0.65 + mvx * 0.35; b.vy = b.vy * 0.65 + mvy * 0.35;
      }
    }
  }
}

// Evenly space players in a circle around a point.
export function spawnInCircle(players, cx, cy, radius) {
  const n = players.length;
  players.forEach((p, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    p.x = cx + Math.cos(ang) * radius;
    p.y = cy + Math.sin(ang) * radius;
    p.vx = 0; p.vy = 0;
    p.face = Math.atan2(cy - p.y, cx - p.x);
  });
}
