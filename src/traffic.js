// Simple ambient traffic that follows lanes on the highway and around city blocks.
import * as THREE from 'three';
import { buildCarModel } from './car.js';
import { VEHICLES, PAINTS } from './vehicles.js';
import { mulberry32, clamp, damp } from './util.js';

function rectLoop(x0, z0, x1, z1, r = 10) {
  // rounded rectangle, clockwise when viewed from above (+y)
  const pts = [];
  const corners = [[x1 - r, z0 + r, -Math.PI / 2], [x1 - r, z1 - r, 0], [x0 + r, z1 - r, Math.PI / 2], [x0 + r, z0 + r, Math.PI]];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= 6; k++) {
      const a = a0 + (k / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
    }
  }
  return pts;
}

function resampleClosed(pts, spacing) {
  const out = [];
  const list = [...pts, pts[0]];
  let carry = 0;
  out.push(list[0].clone());
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const len = a.distanceTo(b);
    let d = spacing - carry;
    while (d <= len) { out.push(a.clone().lerp(b, d / len)); d += spacing; }
    carry = len - (d - spacing);
  }
  out.pop();
  return out;
}

export class Traffic {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.cars = [];
    const rnd = mulberry32(99);
    const lanes = [];
    const hw = world.roads[0].pts;
    lanes.push({ pts: hw, offset: 4.5, dir: 1, speed: 30 });
    lanes.push({ pts: hw, offset: 4.5, dir: -1, speed: 28 });
    const city = [
      rectLoop(-75, -75, 75, 75), rectLoop(-225, -150, 225, 150), rectLoop(-300, -300, 0, 0), rectLoop(0, 0, 300, 300),
      rectLoop(-150, 75, 150, 225), rectLoop(75, -300, 225, -75),
    ];
    for (const c of city) {
      const pts = resampleClosed(c, 3);
      lanes.push({ pts, offset: 3, dir: 1, speed: 14 });
      lanes.push({ pts, offset: 3, dir: -1, speed: 13 });
    }
    for (const lane of lanes) {
      const n = lane.pts.length;
      const len = n * (lane.pts === hw ? 4 : 3);
      const count = lane.pts === hw ? 9 : 2;
      for (let k = 0; k < count; k++) {
        const def = VEHICLES[Math.floor(rnd() * 8)];
        const model = buildCarModel(def, PAINTS[Math.floor(rnd() * PAINTS.length)]);
        scene.add(model);
        this.cars.push({
          lane, model, def, s: ((k + rnd() * 0.5) / count) * n, speed: lane.speed, target: lane.speed * (0.85 + rnd() * 0.3),
          stopped: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, r: def.body.wid / 2,
          halfLen: def.body.len / 2, mass: def.mass, off: new THREE.Vector2(), offVel: new THREE.Vector2(), wobble: 0, wobbleVel: 0,
        });
      }
    }
    this._a = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  sample(lane, s, out) {
    const pts = lane.pts, n = pts.length;
    const i = Math.floor(s) % n, j = (i + 1) % n;
    const f = s - Math.floor(s);
    const a = pts[i], b = pts[j];
    const x = a.x + (b.x - a.x) * f, z = a.y + (b.y - a.y) * f;
    let tx = b.x - a.x, tz = b.y - a.y;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    if (lane.dir < 0) { tx = -tx; tz = -tz; }
    // right-hand traffic: offset to the right of the travel direction
    const rx = -tz, rz = tx;
    out.x = x + rx * lane.offset; out.z = z + rz * lane.offset;
    out.yaw = Math.atan2(tx, tz);
    out.seg = tl;
    return out;
  }

  update(dt, player, enabled = true) {
    const tmp = {};
    for (const c of this.cars) {
      c.model.visible = enabled;
      if (!enabled) continue;
      const dist = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
      // brake for the player when they're ahead in our path
      let want = c.target;
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
      const ahead = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
      if (ahead > 0 && ahead < 22 && side < 3.5) want = Math.min(want, Math.max(0, (ahead - 7) * 1.2));
      if (c.stopped > 0) { c.stopped -= dt; want = Math.min(want, 3); }
      c.speed = damp(c.speed, want, want < c.speed ? 2 : 0.8, dt);
      const spacing = c.lane.pts.length > 900 ? 4 : 3;
      c.s += (c.lane.dir * c.speed * dt) / spacing;
      const n = c.lane.pts.length;
      c.s = ((c.s % n) + n) % n;
      this.sample(c.lane, c.s, tmp);
      // knock-back from bumps: an offset from the lane that springs back, plus a yaw wobble
      c.offVel.x -= c.off.x * 3 * dt; c.offVel.y -= c.off.y * 3 * dt;
      const k = Math.exp(-2.5 * dt);
      c.offVel.multiplyScalar(k);
      c.off.addScaledVector(c.offVel, dt);
      if (c.off.lengthSq() > 64) c.off.setLength(8);
      c.wobbleVel = (c.wobbleVel - c.wobble * 6 * dt) * Math.exp(-3 * dt);
      c.wobble += c.wobbleVel * dt;
      const x = tmp.x + c.off.x, z = tmp.z + c.off.y;
      const y = this.world.heightAt(x, z);
      const prev = this._a.copy(c.pos);
      c.pos.set(x, y, z);
      c.vel.subVectors(c.pos, prev).divideScalar(Math.max(dt, 1e-3));
      if (c.vel.lengthSq() > 2500) c.vel.set(0, 0, 0); // teleport guard
      c.yaw = tmp.yaw + c.wobble;
      if (dist < 500) {
        c.model.visible = true;
        c.model.position.copy(c.pos);
        const nrm = this.world.normalAt(x, z);
        const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
        fwd.addScaledVector(nrm, -fwd.dot(nrm)).normalize();
        const right = new THREE.Vector3().crossVectors(nrm, fwd);
        this._m.makeBasis(right, nrm, fwd);
        c.model.quaternion.setFromRotationMatrix(this._m);
        for (const w of c.model.userData.wheels) w.spin.rotation.x += (c.speed / c.def.body.wheelR) * dt;
      } else c.model.visible = false;
      // bumper-car collisions with the player
      if (dist < 12) {
        const before = c.pos.clone();
        const res = player.bump(c);
        if (res && res.impact > 0) {
          // the positional push and the impulse both go into the knock offset; the part of the
          // impulse along the lane changes the car's cruising speed (rear-ending shoves it forward)
          c.off.x += c.pos.x - before.x; c.off.y += c.pos.z - before.z;
          const laneFx = Math.sin(tmp.yaw), laneFz = Math.cos(tmp.yaw);
          const along = res.dvB.x * laneFx + res.dvB.z * laneFz;
          c.speed = Math.max(0, c.speed + along);
          c.offVel.x += res.dvB.x - laneFx * along; c.offVel.y += res.dvB.z - laneFz * along;
          c.wobbleVel += res.kickB * 1.5;
          if (res.impact > 6) c.stopped = 1.2; // a big hit makes them dawdle for a moment
        }
      }
    }
  }
}
