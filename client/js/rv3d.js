// The Slopmaster 9000, as seen from outside and in.
import { THREE, flat, canvasTex, textCanvas, shadowy } from './gfx.js';
import { RV_DIM, RV_WHEELS, WHEEL_R, SUSP_REST, RV_WINCH, RV_SEATS } from '/shared/rv.js';

const D = RV_DIM;
const CREAM = '#f3ead8', BROWN = '#7a4a2a', ORANGE = '#e8772e', GOLD = '#f2b134';

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof mat === 'string' ? flat(mat) : mat);
  m.position.set(x, y, z);
  return m;
}

export class RVView {
  constructor(scene) {
    this.g = new THREE.Group();
    scene.add(this.g);
    const g = this.g;
    const glass = new THREE.MeshStandardMaterial({ color: 0x8fc9e8, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.32 });
    const darkGlass = new THREE.MeshStandardMaterial({ color: 0x2b3b52, roughness: 0.15, metalness: 0.3 });
    this.parts = { doors: [], roof: [] };

    // chassis skirt + floor
    g.add(box(2.5, 0.62, 8.0, CREAM, 0, -0.31, 0));
    g.add(box(2.52, 0.12, 8.02, BROWN, 0, -0.55, 0));
    const floorTex = canvasTex(planks(), { repeat: [2, 6] });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2.36, 7.86), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.005;
    g.add(floor);

    // walls (outer shell)
    const H = D.WALL_H;
    const wallL = box(0.1, H, 8.0, CREAM, 1.2, H / 2, 0);
    g.add(wallL);
    const dz0 = D.DOOR_Z - D.DOOR_HALF, dz1 = D.DOOR_Z + D.DOOR_HALF;
    g.add(box(0.1, H, dz0 + 4.0, CREAM, -1.2, H / 2, (dz0 - 4.0) / 2));
    g.add(box(0.1, H, 4.0 - dz1, CREAM, -1.2, H / 2, (4.0 + dz1) / 2));
    g.add(box(0.1, 0.32, D.DOOR_HALF * 2, CREAM, -1.2, H - 0.16, D.DOOR_Z));
    // side stripes (the swoosh)
    for (const sx of [1.26, -1.26]) {
      g.add(box(0.02, 0.16, 7.6, ORANGE, sx, 0.75, 0.1));
      g.add(box(0.02, 0.1, 7.6, BROWN, sx, 0.55, 0.1));
      g.add(box(0.02, 0.07, 7.6, GOLD, sx, 0.92, 0.1));
    }
    // windows along the sides
    for (const [sx, zs] of [[1.255, [-2.6, -0.9, 0.9]], [-1.255, [-2.6, 1.9]]]) {
      for (const z of zs) g.add(box(0.03, 0.62, 1.1, darkGlass, sx, 1.55, z));
    }
    // brand decal
    for (const sx of [1.262, -1.262]) {
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.42), new THREE.MeshBasicMaterial({ map: canvasTex(textCanvas(['SLOPMASTER 9000'], { w: 512, h: 84, bg: 'rgba(0,0,0,0)', fg: '#7a4a2a', font: 'Georgia' })), transparent: true }));
      decal.position.set(sx, 1.05, -1.6);
      decal.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
      g.add(decal);
    }

    // rear wall (a "door" as far as the Repo Man is concerned)
    const rear = new THREE.Group();
    rear.add(box(2.5, H, 0.1, CREAM, 0, H / 2, -3.95));
    rear.add(box(1.3, 0.55, 0.03, darkGlass, 0, 1.6, -4.01));
    for (const sx of [-1.0, 1.0]) rear.add(box(0.25, 0.4, 0.04, new THREE.MeshStandardMaterial({ color: 0xc0392b, emissive: 0x5a0d0d }), sx, 0.45, -4.02));
    // ladder
    for (let y = 0.2; y < 2.3; y += 0.32) rear.add(box(0.5, 0.04, 0.04, '#9aa0a6', 0.75, y, -4.05));
    rear.add(box(0.04, 2.4, 0.04, '#9aa0a6', 0.5, 1.15, -4.05));
    rear.add(box(0.04, 2.4, 0.04, '#9aa0a6', 1.0, 1.15, -4.05));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshBasicMaterial({ map: canvasTex(textCanvas(['SLOP 9K'], { w: 256, h: 128, bg: '#f1f1f1', fg: '#16325c', border: '#16325c' })) }));
    plate.position.set(0, -0.2, -4.02); plate.rotation.y = Math.PI;
    rear.add(plate);
    g.add(rear);
    this.parts.doors.push(rear);

    // front: windshield, dash, grille, lights
    g.add(box(2.5, 0.95, 0.1, CREAM, 0, 0.47, 3.95));
    g.add(box(2.4, 1.2, 0.04, glass, 0, 1.55, 3.98));
    g.add(box(2.5, 0.2, 0.1, CREAM, 0, H - 0.1, 3.95));
    g.add(box(1.4, 0.38, 0.05, '#2a2a30', 0, 0.35, 4.02));
    this.headlights = [];
    for (const sx of [-0.9, 0.9]) {
      const hl = box(0.36, 0.22, 0.05, new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0x000000 }), sx, 0.4, 4.03);
      g.add(hl);
      this.headlights.push(hl);
    }
    this.beam = new THREE.SpotLight(0xfff1c8, 0, 60, 0.5, 0.6, 1.2);
    this.beam.position.set(0, 0.5, 4.1);
    this.beam.target.position.set(0, -1, 14);
    g.add(this.beam, this.beam.target);
    g.add(box(2.6, 0.36, 0.28, '#b8bcc2', 0, -0.42, 4.08));                 // bumper
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.6, 12), flat('#f2c14e'));
    drum.rotation.z = Math.PI / 2; drum.position.set(0, -0.32, 4.26);
    g.add(drum);
    g.add(box(2.6, 0.32, 0.24, '#b8bcc2', 0, -0.42, -4.06));                 // rear bumper

    // roof
    const roof = new THREE.Group();
    roof.add(box(2.5, 0.1, 8.0, '#f7f3ea', 0, D.ROOF_Y - 0.05, 0));
    roof.add(box(0.9, 0.3, 0.9, '#d8d8d8', 0, D.ROOF_Y + 0.15, -1.2));     // AC unit
    roof.add(box(0.5, 0.12, 0.5, '#bbbbbb', 0, D.ROOF_Y + 0.06, 1.6));
    roof.add(box(2.5, 0.12, 0.08, BROWN, 0, D.ROOF_Y + 0.02, 3.98));
    g.add(roof);
    this.parts.roof.push(roof);

    // door (hinged at its rear edge)
    this.doorPivot = new THREE.Group();
    this.doorPivot.position.set(-1.2, 0, dz0);
    const door = new THREE.Group();
    door.add(box(0.06, 2.04, D.DOOR_HALF * 2 - 0.04, CREAM, 0, 1.04, D.DOOR_HALF));
    door.add(box(0.07, 0.45, 0.5, darkGlass, 0, 1.6, D.DOOR_HALF));
    door.add(box(0.08, 0.06, 0.18, '#c0c0c0', -0.04, 1.0, D.DOOR_HALF * 2 - 0.15));
    this.doorPivot.add(door);
    g.add(this.doorPivot);
    this.parts.doors.push(this.doorPivot);
    this.doorAng = 0;

    // steps
    g.add(box(0.4, 0.08, 0.92, '#8d8d8d', -1.42, -0.46, D.DOOR_Z));
    g.add(box(0.4, 0.08, 0.92, '#8d8d8d', -1.64, -0.89, D.DOOR_Z));

    // ---- interior ----
    const seatMat = flat('#6b3e26');
    for (const s of RV_SEATS) {
      g.add(box(0.56, 0.48, 0.56, seatMat, s.x, 0.24, 2.85));
      g.add(box(0.56, 0.7, 0.12, seatMat, s.x, 0.82, 2.6));
    }
    g.add(box(2.3, 0.56, 0.56, '#3a3a42', 0, 0.62, 3.62));                  // dash
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 6, 16), flat('#1f1f24'));
    wheel.position.set(0.62, 1.0, 3.25); wheel.rotation.x = -0.9;
    g.add(wheel);
    this.steeringWheel = wheel;
    // odometer / clock on the dash
    this.odoCv = document.createElement('canvas'); this.odoCv.width = 256; this.odoCv.height = 96;
    this.odoTex = canvasTex(this.odoCv);
    const odo = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.16), new THREE.MeshBasicMaterial({ map: this.odoTex, toneMapped: false }));
    odo.position.set(0.62, 0.93, 3.36); odo.rotation.x = -0.7;
    g.add(odo);
    this.odoLast = '';
    // CB radio
    g.add(box(0.26, 0.08, 0.18, '#222', 0.0, 0.94, 3.42));
    // dinette
    g.add(box(0.84, 0.06, 0.76, '#f4efe4', 0.78, 0.74, 1.15));
    g.add(box(0.08, 0.7, 0.08, '#999', 0.78, 0.36, 1.15));
    for (const z of [0.5, 1.8]) {
      g.add(box(0.84, 0.44, 0.4, '#2f5d8a', 0.78, 0.22, z));
      g.add(box(0.84, 0.5, 0.08, '#2f5d8a', 0.78, 0.66, z + (z < 1 ? -0.17 : 0.17)));
    }
    // kitchenette
    g.add(box(0.6, 0.92, 1.24, '#c9a26b', -0.9, 0.46, 1.95));
    g.add(box(0.62, 0.04, 1.26, '#e9e3d6', -0.9, 0.94, 1.95));
    g.add(box(0.3, 0.02, 0.3, '#a9b2b8', -0.9, 0.965, 2.2));
    g.add(box(0.5, 1.6, 0.5, '#e8e8e8', 0.95, 0.8, -1.0));                   // fridge
    // shower stall
    const tile = flat('#e8f1f5');
    g.add(box(0.8, 2.2, 0.06, tile, -0.8, 1.1, -1.75));
    g.add(box(0.8, 2.2, 0.06, tile, -0.8, 1.1, -2.75));
    g.add(box(0.06, 0.18, 1.0, tile, -0.4, 0.09, -2.25));
    g.add(box(0.06, 0.04, 1.0, '#9aa0a6', -0.4, 2.0, -2.25));
    // bunks
    g.add(box(2.4, 0.56, 0.96, '#8b5e3c', 0, 0.28, -3.42));
    g.add(box(2.3, 0.14, 0.9, '#c0392b', 0, 0.62, -3.42));
    g.add(box(2.4, 0.1, 0.96, '#8b5e3c', 0, 1.45, -3.42));
    g.add(box(2.3, 0.12, 0.9, '#2980b9', 0, 1.56, -3.42));
    g.add(box(0.5, 0.12, 0.3, '#f4f1ea', -0.7, 0.75, -3.6));                 // pillow

    this.light = new THREE.PointLight(0xffe2b0, 3, 7, 1.5);
    this.light.position.set(0, 2.0, 0);
    g.add(this.light);

    // wheels
    this.wheels = RV_WHEELS.map(([x, y, z, steer]) => {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.36, 14), flat('#1c1c1c'));
      tire.rotation.z = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.38, 8), flat('#d8d8d8', { metalness: 0.6, roughness: 0.3 }));
      hub.rotation.z = Math.PI / 2;
      const nub = box(0.4, 0.1, 0.1, '#888', 0, 0, 0);
      spin.add(tire, hub, nub);
      pivot.add(spin);
      pivot.position.set(x, y - SUSP_REST, z);
      g.add(pivot);
      return { pivot, spin, x, y, z, steer };
    });

    shadowy(g);
    floor.castShadow = false;

    // the winch hook + cable (world space)
    this.hook = new THREE.Group();
    const hk = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 6, 10, Math.PI * 1.5), flat('#d62828', { metalness: 0.4 }));
    const blk = box(0.12, 0.16, 0.12, '#333', 0, 0.14, 0);
    this.hook.add(hk, blk);
    scene.add(this.hook);
    this.cablePts = Array.from({ length: 16 }, () => new THREE.Vector3());
    this.cableGeo = new THREE.BufferGeometry().setFromPoints(this.cablePts);
    this.cable = new THREE.Line(this.cableGeo, new THREE.LineBasicMaterial({ color: 0x222222 }));
    this.cable.frustumCulled = false;
    scene.add(this.cable);
  }

  setParts(parts) {
    for (const p of this.parts.doors) p.visible = parts.doors !== false;
    for (const p of this.parts.roof) p.visible = parts.roof !== false;
  }

  update(dt, rv, door, night, hook, odo, clockStr) {
    if (!rv) return;
    this.g.position.set(rv.p.x, rv.p.y, rv.p.z);
    this.g.quaternion.set(rv.q.x, rv.q.y, rv.q.z, rv.q.w);
    const target = door ? -1.75 : 0;
    this.doorAng += (target - this.doorAng) * Math.min(1, dt * 6);
    this.doorPivot.rotation.y = this.doorAng;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const susp = rv.wheels?.[i * 2] ?? SUSP_REST;
      const rot = rv.wheels?.[i * 2 + 1] ?? 0;
      w.pivot.position.y = w.y - susp;
      w.pivot.rotation.y = w.steer ? rv.steer : 0;
      w.spin.rotation.x = rot;
    }
    this.steeringWheel.rotation.z = rv.steer * 2.2;
    for (const h of this.headlights) h.material.emissive.setHex(night ? 0xfff2c0 : 0x000000);
    this.beam.intensity = night ? 40 : 0;
    this.light.intensity = night ? 6 : 1.5;
    // dash readout
    const s = `${String(Math.max(0, Math.round(odo))).padStart(4, '0')} m  ${clockStr}`;
    if (s !== this.odoLast) {
      this.odoLast = s;
      const g = this.odoCv.getContext('2d');
      g.fillStyle = '#0d1b0d'; g.fillRect(0, 0, 256, 96);
      g.fillStyle = '#7CFC00'; g.font = 'bold 30px monospace'; g.textAlign = 'center';
      g.fillText(`ODO ${String(Math.max(0, Math.round(odo))).padStart(4, '0')} m`, 128, 40);
      g.font = 'bold 26px monospace'; g.fillText(clockStr, 128, 78);
      this.odoTex.needsUpdate = true;
    }
    // winch cable: winch → hook with a lazy sag
    const wp = new THREE.Vector3(RV_WINCH.x, RV_WINCH.y + 0.1, RV_WINCH.z).applyQuaternion(this.g.quaternion).add(this.g.position);
    if (!hook || hook.state === 0) {
      this.hook.position.copy(wp);
      this.cable.visible = false;
    } else {
      this.hook.position.set(hook.x, hook.y, hook.z);
      const d = wp.distanceTo(this.hook.position);
      const slack = Math.max(0, hook.len - d);
      const sag = Math.min(3, slack * 0.5 + 0.05 * d);
      for (let i = 0; i < this.cablePts.length; i++) {
        const t = i / (this.cablePts.length - 1);
        this.cablePts[i].lerpVectors(wp, this.hook.position, t);
        this.cablePts[i].y -= Math.sin(t * Math.PI) * sag;
      }
      this.cableGeo.setFromPoints(this.cablePts);
      this.cable.visible = true;
    }
    this.hook.visible = true;
  }
}

function planks() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  for (let i = 0; i < 4; i++) {
    g.fillStyle = ['#a8763e', '#9c6b36', '#b07f45', '#a06f3a'][i];
    g.fillRect(i * 32, 0, 32, 128);
    g.fillStyle = 'rgba(60,35,15,0.5)';
    g.fillRect(i * 32, 0, 2, 128);
    g.fillRect(i * 32, (i * 37) % 128, 32, 2);
  }
  return cv;
}
