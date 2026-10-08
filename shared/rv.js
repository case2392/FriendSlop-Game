// The Slopmaster 9000. One layout, used three ways: the server's dynamic
// physics body, every client's kinematic copy (so you can walk around inside
// it), and the renderer.
//
// Local frame: origin at the center of the floor's top surface, +Z is forward
// (the windshield), +Y up. Facing forward, +X is the driver's (left) side and
// -X is the door (right) side — US-style.

export const RV_DIM = {
  HALF_W: 1.25,
  HALF_L: 4.0,
  WALL_H: 2.3,
  ROOF_Y: 2.4,           // walkable roof surface
  DOOR_Z: 0.35,          // door center along the right (-X) wall
  DOOR_HALF: 0.5,
};

// Every collider: [name, hx, hy, hz, cx, cy, cz, opts]
//   opts.mass   — kg contribution (the chassis carries almost all of it)
//   opts.part   — removable by the Repo Man ('doors', 'roof')
//   opts.use    — what pressing E on it does
//   opts.toggle — door: present only while closed
const D = RV_DIM;
const H = D.WALL_H / 2;
const dz0 = D.DOOR_Z - D.DOOR_HALF, dz1 = D.DOOR_Z + D.DOOR_HALF;
const rearSegHalf = (dz0 + D.HALF_L) / 2, rearSegC = (dz0 - D.HALF_L) / 2;
const frontSegHalf = (D.HALF_L - dz1) / 2, frontSegC = (D.HALF_L + dz1) / 2;

export const RV_PARTS = [
  ['chassis',   1.22, 0.3, 3.95,   0, -0.3, 0,        { mass: 2650 }],
  ['wallL',     0.05, H, D.HALF_L,  1.2, H, 0,          { mass: 60 }],
  ['wallR_rear',0.05, H, rearSegHalf,  -1.2, H, rearSegC,  { mass: 30 }],
  ['wallR_front',0.05, H, frontSegHalf, -1.2, H, frontSegC, { mass: 30 }],
  ['doorHeader',0.05, 0.16, D.DOOR_HALF, -1.2, D.WALL_H - 0.16, D.DOOR_Z, { mass: 2 }],
  ['door',      0.04, 1.02, D.DOOR_HALF - 0.02, -1.2, 1.04, D.DOOR_Z, { mass: 0, part: 'doors', toggle: true, use: 'door' }],
  ['wallRear',  1.25, H, 0.05,      0, H, -3.95,      { mass: 40, part: 'doors' }],
  ['windshield',1.25, H, 0.05,      0, H, 3.95,       { mass: 40 }],
  ['roof',      1.25, 0.05, D.HALF_L, 0, D.ROOF_Y - 0.05, 0, { mass: 80, part: 'roof' }],
  // the cockpit
  ['dash',      1.15, 0.28, 0.28,   0, 0.62, 3.62,    { mass: 20 }],
  ['seatDriver',0.28, 0.24, 0.28,   0.62, 0.24, 2.85, { mass: 10, use: 'seat0' }],
  ['seatPass',  0.28, 0.24, 0.28,  -0.62, 0.24, 2.85, { mass: 10, use: 'seat1' }],
  // the living room
  ['table',     0.42, 0.04, 0.38,   0.78, 0.74, 1.15, { mass: 5 }],
  ['tableLeg',  0.05, 0.35, 0.05,   0.78, 0.35, 1.15, { mass: 2 }],
  ['bench0',    0.42, 0.22, 0.2,    0.78, 0.22, 0.5,  { mass: 6 }],
  ['bench1',    0.42, 0.22, 0.2,    0.78, 0.22, 1.8,  { mass: 6 }],
  ['counter',   0.3, 0.46, 0.62,   -0.9, 0.46, 1.95,  { mass: 15 }],
  // the shower stall: where the vase goes. (it won't.)
  ['showerF',   0.4, 1.1, 0.03,    -0.8, 1.1, -1.75,  { mass: 3 }],
  ['showerB',   0.4, 1.1, 0.03,    -0.8, 1.1, -2.75,  { mass: 3 }],
  ['showerLip', 0.03, 0.09, 0.5,   -0.4, 0.09, -2.25, { mass: 1 }],
  ['icebox',    0.21, 0.35, 0.4,    0.94, 0.35, -1.0, { mass: 8 }],
  // the bunks
  ['bed',       1.2, 0.28, 0.48,    0, 0.28, -3.42,   { mass: 20, use: 'bunk' }],
  ['bunkUp',    1.2, 0.05, 0.48,    0, 1.45, -3.42,   { mass: 8, use: 'bunk' }],
  // getting in: two steps under the door
  ['step0',     0.2, 0.04, 0.46,   -1.42, -0.46, D.DOOR_Z, { mass: 2 }],
  ['step1',     0.2, 0.04, 0.46,   -1.64, -0.89, D.DOOR_Z, { mass: 2 }],
  // up top: the cab-over brow and the roof cargo (they go with the roof when the Repo Man takes it)
  ['brow',      1.15, 0.04, 0.27,   0, 2.43, 4.27,    { mass: 5, part: 'roof' }],
  ['rackLoad',  0.5, 0.2, 0.7,      0.05, 2.6, 3.15,  { mass: 5, part: 'roof' }],
  ['cooler',    0.36, 0.13, 0.36,  -0.38, 2.53, -1.0, { mass: 3, part: 'roof' }],
  // business end
  ['bumperF',   1.3, 0.18, 0.14,    0, -0.42, 4.08,   { mass: 30, use: 'winch' }],
  ['bumperR',   1.3, 0.16, 0.12,    0, -0.42, -4.06,  { mass: 25 }],
];

// Seats: where your eye goes (local).
export const RV_SEATS = [
  { x: 0.62, y: 1.32, z: 2.82, driver: true },
  { x: -0.62, y: 1.32, z: 2.82, driver: false },
];

// Where you stand up when you leave a seat (local floor point).
export const RV_SEAT_EXIT = [
  { x: 0.25, y: 0, z: 2.1 },
  { x: -0.35, y: 0, z: 2.1 },
];

export const RV_WINCH = { x: 0, y: -0.42, z: 4.26 };
export const RV_MAP_SPOT = { x: -0.45, y: 0.95, z: 3.55 };   // on the dash, passenger side

export const RV_WHEELS = [
  // [x, y(connection), z, steer, drive]
  [ 1.08, -0.38,  2.65, true,  false],
  [-1.08, -0.38,  2.65, true,  false],
  [ 1.08, -0.38, -2.6, false, true],
  [-1.08, -0.38, -2.6, false, true],
];
export const WHEEL_R = 0.5;
export const SUSP_REST = 0.48;

// Bounding box for "am I inside the RV" and loot carry-over between days.
export function insideRV(lx, ly, lz, pad = 0) {
  return Math.abs(lx) < D.HALF_W + pad && Math.abs(lz) < D.HALF_L + pad && ly > -0.6 - pad && ly < D.ROOF_Y + 0.4 + pad;
}

// Quaternion helpers usable on both sides without three.js.
export function qRotate(q, v) {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const ix = qw * v.x + qy * v.z - qz * v.y;
  const iy = qw * v.y + qz * v.x - qx * v.z;
  const iz = qw * v.z + qx * v.y - qy * v.x;
  const iw = -qx * v.x - qy * v.y - qz * v.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}
export const qConj = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export function toWorld(pos, q, l) {
  const r = qRotate(q, l);
  return { x: pos.x + r.x, y: pos.y + r.y, z: pos.z + r.z };
}
export function toLocal(pos, q, w) {
  return qRotate(qConj(q), { x: w.x - pos.x, y: w.y - pos.y, z: w.z - pos.z });
}
// yaw (about +Y) of a quaternion's forward (+Z) axis, in the same convention as
// the player's yaw: yaw 0 looks toward +Z, increasing yaw turns toward +X.
export function qYaw(q) {
  const f = qRotate(q, { x: 0, y: 0, z: 1 });
  return Math.atan2(f.x, f.z);
}
