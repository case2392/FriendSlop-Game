// Pit gremlins: chainless AI shovers that harass the squad.
// Shaped like players so the shared physics treats them identically.

let nextGremlinId = 1;

export function makeGremlin(x, y) {
  return {
    id: 'g' + nextGremlinId++,
    isGremlin: true,
    x, y, vx: 0, vy: 0, face: 0,
    input: { mx: 0, my: 0, dash: false },
    dashCd: 0, dashTime: 0, speedMult: 0.85,
    alive: true, freeze: false, score: 0,
    events: [],
    aiT: 0,
  };
}

export function driveGremlin(g, targets, dt) {
  g.aiT -= dt;
  if (g.aiT > 0) return;
  g.aiT = 0.15 + Math.random() * 0.1;

  let best = null, bd = Infinity;
  for (const p of targets) {
    if (!p.alive) continue;
    const d = Math.hypot(p.x - g.x, p.y - g.y);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) return;
  const d = bd || 1;
  g.input.mx = (best.x - g.x) / d;
  g.input.my = (best.y - g.y) / d;
  if (bd < 230 && g.dashCd === 0 && Math.random() < 0.7) g.input.dash = true;
}
