// Other players' cars: interpolated from server snapshots, with name tags, effects and
// local bumper-car collisions (each client resolves its own half of a bump).
import * as THREE from 'three';
import { buildCarModel } from '../car.js';
import { vehicleById } from '../vehicles.js';
import { FLAG, TEAMS } from '../../shared/protocol.js';
import { wrapAngle } from '../util.js';

const INTERP_DELAY = 120; // ms behind the newest snapshot
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();

function makeLabel() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 72;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false }));
  s.scale.set(5, 1.4, 1);
  s.renderOrder = 12;
  s.userData = { canvas: c, tex, text: '' };
  return s;
}

function drawLabel(s, text, color, sub) {
  const key = text + color + sub;
  if (s.userData.text === key) return;
  s.userData.text = key;
  const g = s.userData.canvas.getContext('2d');
  g.clearRect(0, 0, 256, 72);
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text, 128, 24); g.fillStyle = color; g.fillText(text, 128, 24);
  if (sub) { g.font = 'bold 24px system-ui, sans-serif'; g.strokeText(sub, 128, 56); g.fillStyle = '#fff'; g.fillText(sub, 128, 56); }
  s.userData.tex.needsUpdate = true;
}

export class Remotes {
  constructor(game) {
    this.game = game;
    this.map = new Map();
    this.myId = null;
  }

  // keep remote cars in sync with the room's player list
  sync(players, myId) {
    this.myId = myId;
    const seen = new Set();
    for (const p of players) {
      if (p.id === myId) continue;
      seen.add(p.id);
      let r = this.map.get(p.id);
      const carKey = p.car.id + p.car.paint;
      if (r && r.carKey !== carKey) { this.removeOne(r); r = null; }
      if (!r) {
        const def = vehicleById(p.car.id);
        const model = buildCarModel(def, p.car.paint);
        this.game.scene.add(model);
        const label = makeLabel();
        this.game.scene.add(label);
        r = {
          id: p.id, carKey, def, model, label, buf: [], paint: p.car.paint,
          pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, halfLen: def.body.len / 2, r: def.body.wid / 2, mass: def.mass,
          fl: 0, speed: 0, grounded: true, slip: 0, surface: 1, nitroOn: false, braking: false, throttle: 0, wheelRot: 0, visible: false,
        };
        r.radius = r.r;
        this.map.set(p.id, r);
      }
      r.name = p.name; r.team = p.team; r.connected = p.connected;
    }
    for (const [id, r] of this.map) if (!seen.has(id)) this.removeOne(r);
  }

  removeOne(r) {
    this.game.scene.remove(r.model, r.label);
    if (r.bubble) this.game.scene.remove(r.bubble);
    this.map.delete(r.id);
  }

  clear() { for (const r of [...this.map.values()]) this.removeOne(r); }

  onSnap(ts, list) {
    for (const s of list) {
      const r = this.map.get(s[0]);
      if (!r) continue;
      const last = r.buf[r.buf.length - 1];
      if (last && last.ts >= ts) continue;
      r.buf.push({ ts, x: s[1], y: s[2], z: s[3], vx: s[4], vy: s[5], vz: s[6], yaw: s[7], fl: s[8], conn: s[9] });
      if (r.buf.length > 30) r.buf.shift();
    }
  }

  // Returns remote body to use with Car.bump()
  bodies() { return [...this.map.values()].filter((r) => r.visible); }

  update(dt, serverNow, decorate) {
    const t = serverNow - INTERP_DELAY;
    const world = this.game.world;
    for (const r of this.map.values()) {
      const b = r.buf;
      if (!b.length) { r.model.visible = r.label.visible = r.visible = false; continue; }
      const oldest = b[0], newest = b[b.length - 1];
      if (t >= newest.ts) {
        // extrapolate a little past the newest snapshot
        const ex = Math.min(0.3, (t - newest.ts) / 1000);
        r.pos.set(newest.x + newest.vx * ex, newest.y, newest.z + newest.vz * ex);
        r.yaw = newest.yaw;
      } else if (t <= oldest.ts) {
        r.pos.set(oldest.x, oldest.y, oldest.z);
        r.yaw = oldest.yaw;
      } else {
        let i = b.length - 2;
        while (i > 0 && b[i].ts > t) i--;
        const a = b[i], c = b[i + 1];
        const k = (t - a.ts) / Math.max(1, c.ts - a.ts);
        r.pos.set(a.x + (c.x - a.x) * k, a.y + (c.y - a.y) * k, a.z + (c.z - a.z) * k);
        r.yaw = a.yaw + wrapAngle(c.yaw - a.yaw) * k;
      }
      const latest = b[b.length - 1];
      r.vel.set(latest.vx, latest.vy, latest.vz);
      r.fl = latest.fl;
      r.speed = Math.hypot(latest.vx, latest.vz);
      r.grounded = !(r.fl & FLAG.air);
      r.slip = r.fl & FLAG.drift ? 5 : 0;
      r.nitroOn = !!(r.fl & FLAG.nitro);
      r.braking = !!(r.fl & FLAG.brake);
      r.surface = world.surfaceAt(r.pos.x, r.pos.z);
      // pose: follow the ground when driving, flat when airborne
      const m = r.model;
      m.visible = r.visible = true;
      const gy = world.heightAt(r.pos.x, r.pos.z);
      if (r.grounded && Math.abs(r.pos.y - gy) < 1.5) r.pos.y = gy;
      m.position.copy(r.pos);
      const up = r.grounded ? world.normalAt(r.pos.x, r.pos.z, _n) : _n.set(0, 1, 0);
      const fwd = new THREE.Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      _m.makeBasis(new THREE.Vector3().crossVectors(up, fwd).normalize(), up, fwd);
      m.quaternion.setFromRotationMatrix(_m);
      r.wheelRot += (r.speed / r.def.body.wheelR) * dt;
      for (const w of m.userData.wheels) w.spin.rotation.x = r.wheelRot;
      m.userData.tailMat.emissiveIntensity = r.braking ? 2 : 0.3;
      // label: name, team colour, status line supplied by the game mode
      const extra = decorate ? decorate(r) : {};
      const color = r.team ? TEAMS[r.team].color : '#ffffff';
      drawLabel(r.label, r.name + (r.connected === false ? ' ⏳' : ''), extra.color || color, extra.sub || '');
      r.label.visible = true;
      r.label.position.set(r.pos.x, r.pos.y + 3.4 * (m.scale.x || 1), r.pos.z);
      // greyed-out ghost while reconnecting
      m.userData.paintMat.transparent = r.connected === false;
      m.userData.paintMat.opacity = r.connected === false ? 0.4 : 1;
    }
  }
}
