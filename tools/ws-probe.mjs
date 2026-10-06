import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:' + (process.argv[2] || 3311));
const seen = {};
ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'Probe', seed: 4242 })));
ws.on('message', d => {
  const m = JSON.parse(d);
  seen[m.t] = (seen[m.t] || 0) + 1;
  if (m.t === 'props') console.log('props', m.list.length);
  if (m.t === 'world') console.log('world', JSON.stringify(m));
  if (m.t === 'tp') { console.log('tp', JSON.stringify(m)); ws.send(JSON.stringify({ t: 'p', par: 0, x: m.x, y: m.y, z: m.z, yaw: 0, pitch: 0, m: 0, f: 0, v: [0, 0, 0] })); }
  if (m.t === 's' && seen.s === 30) { console.log('snap bytes', d.length, 'rv', m.rv.slice(0, 3), 'props in snap', m.pr.length, 'pl', JSON.stringify(m.pl), 'g', JSON.stringify(m.g).slice(0, 200)); }
});
setTimeout(() => { console.log('seen', JSON.stringify(seen)); process.exit(0); }, 2500);
