// Player / AI car: procedural model + arcade physics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp, lerp, damp, wrapAngle } from './util.js';
import { SURF, SURF_PROPS, WATER_LEVEL } from './world.js';
import { FINISHES } from './vehicles.js';
import { USE_KENNEY_CARS, KENNEY_FLIP } from './config.js';

const G = 22; // arcade gravity (a bit stronger than real for snappier jumps)
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _colliders = [];

// --------------------------------------------------------------------------------------------
// Model building
const gltfCache = new Map();
const loader = new GLTFLoader();
export function tryLoadKenney(name) {
  if (!name || !USE_KENNEY_CARS) return Promise.resolve(null);
  if (!gltfCache.has(name)) {
    gltfCache.set(name, new Promise((res) => {
      loader.load(`assets/kenney/car-kit/${name}.glb`, (g) => res(g.scene), undefined, () => res(null));
    }));
  }
  return gltfCache.get(name);
}

function taper(geo, sx, sz, frontBias = 0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * sx);
      p.setZ(i, p.getZ(i) * sz + frontBias);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildCarModel(def, paint = def.color, finishId = 'gloss') {
  const b = def.body;
  const grp = new THREE.Group();
  const bodyGroup = new THREE.Group(); // tilts with suspension
  grp.add(bodyGroup);
  const fin = FINISHES.find((f) => f.id === finishId) || FINISHES[0];
  const paintMat = new THREE.MeshStandardMaterial({ color: paint, roughness: fin.roughness, metalness: fin.metalness });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1b2633, roughness: 0.1, metalness: 0.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 0.4 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x990000, emissive: 0xff1100, emissiveIntensity: 0.3 });

  const L = b.len, W = b.wid, Hh = b.hgt;
  const baseY = b.ride;
  const procedural = new THREE.Group();
  bodyGroup.add(procedural);
  // lower body with slight front taper
  const lower = new THREE.Mesh(taper(new THREE.BoxGeometry(W * 0.92, Hh, L, 1, 1, 1), 0.96, 0.97), paintMat);
  lower.position.y = baseY + Hh / 2;
  procedural.add(lower);
  // cabin
  const cabL = L * b.cabLen;
  const cabGeo = taper(new THREE.BoxGeometry(W * 0.86, b.cabH, cabL), 0.82, b.style === 'van' ? 0.95 : 0.7, b.style === 'van' ? 0 : -cabL * 0.05);
  const cabin = new THREE.Mesh(cabGeo, glassMat);
  cabin.position.set(0, baseY + Hh + b.cabH / 2 - 0.02, b.cabOff * L);
  procedural.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.72, 0.06, cabL * (b.style === 'van' ? 0.95 : 0.66)), paintMat);
  roof.position.set(0, baseY + Hh + b.cabH - 0.01, b.cabOff * L - (b.style === 'van' ? 0 : cabL * 0.05));
  procedural.add(roof);
  if (b.style === 'pickup') {
    // truck bed walls
    const bedL = L * 0.38;
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, bedL), paintMat);
      wall.position.set(s * (W / 2 - 0.05), baseY + Hh + 0.2, -L / 2 + bedL / 2 + 0.05);
      procedural.add(wall);
    }
    const tail = new THREE.Mesh(new THREE.BoxGeometry(W, 0.4, 0.1), paintMat);
    tail.position.set(0, baseY + Hh + 0.2, -L / 2 + 0.05);
    procedural.add(tail);
  }
  if (b.spoiler) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.06, 0.35), darkMat);
    sp.position.set(0, baseY + Hh + 0.35, -L / 2 + 0.25);
    procedural.add(sp);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.35, 0.12), darkMat);
      post.position.set(s * W * 0.35, baseY + Hh + 0.17, -L / 2 + 0.25);
      procedural.add(post);
    }
  }
  // bumpers & lights
  const bump = new THREE.BoxGeometry(W * 1.01, 0.18, 0.18);
  const fb = new THREE.Mesh(bump, darkMat); fb.position.set(0, baseY + 0.12, L / 2); procedural.add(fb);
  const rb = new THREE.Mesh(bump, darkMat); rb.position.set(0, baseY + 0.12, -L / 2); procedural.add(rb);
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.05), lightMat);
    hl.position.set(s * W * 0.33, baseY + Hh * 0.7, L / 2 + 0.01);
    procedural.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.05), tailMat);
    tl.position.set(s * W * 0.33, baseY + Hh * 0.72, -L / 2 - 0.01);
    procedural.add(tl);
  }
  procedural.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });

  // wheels
  const wheels = [];
  const wr = b.wheelR;
  const wGeo = new THREE.CylinderGeometry(wr, wr, Math.max(0.24, wr * 0.65), 14);
  wGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(wr * 0.55, wr * 0.55, Math.max(0.25, wr * 0.66), 8);
  hubGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb0b4b8, roughness: 0.3, metalness: 0.8 });
  const axle = L / 2 - Math.max(wr * 1.25, L * 0.17);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * (W / 2 - Math.max(0.12, wr * 0.33) + 0.04), wr, sz * axle);
    const spin = new THREE.Group();
    const t = new THREE.Mesh(wGeo, tireMat); t.castShadow = true;
    const h = new THREE.Mesh(hubGeo, hubMat);
    spin.add(t, h);
    pivot.add(spin);
    grp.add(pivot);
    wheels.push({ pivot, spin, front: sz > 0, baseY: wr });
  }
  grp.userData = { wheels, paintMat, bodyGroup, procedural, tailMat, lightMat };

  // Optional Kenney GLB swap-in (keeps our wheels hidden if the GLB has its own)
  tryLoadKenney(def.kenney).then((scene) => {
    if (!scene) return;
    const m = scene.clone(true);
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    if (size.x > size.z) m.rotation.y = Math.PI / 2;
    const box2 = new THREE.Box3().setFromObject(m);
    const s2 = box2.getSize(new THREE.Vector3());
    const scale = L / s2.z;
    m.scale.multiplyScalar(scale);
    const box3 = new THREE.Box3().setFromObject(m);
    m.position.y -= box3.min.y;
    m.position.x -= (box3.min.x + box3.max.x) / 2;
    m.position.z -= (box3.min.z + box3.max.z) / 2;
    if (KENNEY_FLIP.has(def.kenney)) m.rotation.y += Math.PI;
    const kWheels = [];
    m.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        // tint the main body material with the chosen paint
        if (o.material && /body|paint|car|color/i.test(o.material.name || '')) {
          o.material = paintMat;
        }
      }
      if (/wheel/i.test(o.name)) kWheels.push(o);
    });
    procedural.visible = false;
    bodyGroup.add(m);
    if (kWheels.length) {
      for (const w of wheels) w.pivot.visible = false;
      grp.userData.kenneyWheels = kWheels;
    }
  });
  return grp;
}

// --------------------------------------------------------------------------------------------
export class Car {
  constructor(def, stats, setup, scene) {
    this.scene = scene;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.yawRate = 0;
    this.up = new THREE.Vector3(0, 1, 0);
    this.grounded = true;
    this.airTime = 0;
    this.airSpin = 0;
    this.airMaxH = 0;
    this.steer = 0;
    this.nitro = 0;
    this.nitroOn = false;
    this.drift = { active: false, score: 0, timer: 0, mult: 1 };
    this.wheelRot = 0;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.prevVf = 0;
    this.slip = 0;
    this.surface = SURF.ASPHALT;
    this.submerged = 0;
    this.lastSafe = { pos: new THREE.Vector3(), yaw: 0 };
    this.events = [];
    this.setVehicle(def, stats, setup);
  }

  setVehicle(def, stats, setup) {
    this.def = def;
    this.stats = stats;
    this.setup = setup;
    if (this.model) this.scene.remove(this.model);
    this.model = buildCarModel(def, setup.paint || def.color, setup.finish);
    this.scene.add(this.model);
    this.radius = def.body.wid / 2;
    this.halfLen = def.body.len / 2;
    this.nitro = stats.nitroCap;
    if (this.headlight) this.model.add(this.headlight, this.headlight.target);
  }

  addHeadlights() {
    const l = new THREE.SpotLight(0xfff2d0, 0, 70, 0.6, 0.5, 1.2);
    l.position.set(0, 1.0, this.halfLen);
    l.target.position.set(0, 0, this.halfLen + 20);
    this.headlight = l;
    this.model.add(l, l.target);
  }

  place(x, z, yaw, world) {
    this.pos.set(x, world.heightAt(x, z) + 0.05, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.yawRate = 0;
    this.grounded = true;
    this.airTime = 0;
    this.submerged = 0;
    this.up.set(0, 1, 0);
    this.lastSafe.pos.copy(this.pos);
    this.lastSafe.yaw = yaw;
    this.teleported = true;
    this.syncModel(0, world);
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get forward() { return _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  update(dt, input, world, env) {
    const steps = 3;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, input, world, env);
    this.syncModel(dt, world);
  }

  step(dt, input, world, env) {
    const s = this.stats;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -fz, rz = fx; // right vector (for camera looking down +fwd)
    let vf = this.vel.x * fx + this.vel.z * fz;
    let vl = this.vel.x * rx + this.vel.z * rz;
    const speed = Math.abs(vf);

    const gh = world.heightAt(this.pos.x, this.pos.z);
    this.surface = world.surfaceAt(this.pos.x, this.pos.z);
    const sp = SURF_PROPS[this.surface];
    const tire = s.tire;

    // Steering input smoothing (faster return to centre)
    const steerIn = input.steer;
    const steerRate = Math.abs(steerIn) > Math.abs(this.steer) ? 4.5 : 7;
    this.steer = damp(this.steer, steerIn, steerRate, dt);

    // Nitro
    this.nitroOn = input.nitro && this.nitro > 0.05 && input.throttle > 0;
    if (this.nitroOn) this.nitro = Math.max(0, this.nitro - dt);
    else this.nitro = Math.min(s.nitroCap, this.nitro + dt * 0.12);

    if (this.grounded) {
      // ---------------- grip model ----------------
      let tireMul = sp.paved ? tire.road : tire.off;
      if (this.surface === SURF.SNOW) tireMul = tire.snow;
      let grip = s.grip * sp.grip * tireMul;
      if (!sp.paved) grip *= lerp(1, s.offroad, 0.6);
      // weather
      const wet = env.wetness, snowy = env.snowiness;
      let weatherGrip = 1 - wet * 0.22 - snowy * 0.35;
      if (wet > 0 && tire.rainPenalty) weatherGrip *= lerp(1, tire.rainPenalty, wet);
      if (snowy > 0 && tire.id === 'winter') weatherGrip = lerp(weatherGrip, 1, 0.75);
      grip *= weatherGrip;
      this.grip = grip;

      // ---------------- longitudinal ----------------
      const top = s.topSpeed * (this.nitroOn ? 1.22 : 1);
      let a = 0;
      if (input.throttle > 0) {
        const ratio = clamp(vf / top, 0, 1.2);
        a += s.accel * input.throttle * Math.max(0, 1 - ratio * ratio) * Math.min(1.15, 0.45 + grip * 0.7);
        if (this.nitroOn) a += s.accel * 0.75 * s.nitroPower;
        if (vf < -0.5) a += 12 * input.throttle; // throttle while rolling backward brakes first
      }
      if (input.brake > 0) {
        if (vf > 0.6) a -= 16 * s.brake * input.brake * Math.min(1.2, grip);
        else {
          const rTop = 14;
          a -= s.accel * 0.7 * input.brake * Math.max(0, 1 - (-vf / rTop) ** 2);
        }
      }
      // rolling resistance, surface drag, aero
      const surfDrag = sp.drag / (sp.paved ? 1 : s.offroad);
      const roll = (0.25 + surfDrag * 5) * Math.sign(vf) * Math.min(1, speed);
      a -= roll + 0.0009 * vf * speed;
      if (input.throttle === 0 && input.brake === 0) a -= 0.6 * Math.sign(vf) * Math.min(1, speed);
      vf += a * dt;
      this.braking = input.brake > 0 && vf > 0.6;
      if (input.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);

      // ---------------- steering ----------------
      const wheelBase = this.halfLen * 1.4;
      const maxAngle = 0.62 / (1 + speed / 22);
      const angle = -this.steer * maxAngle * s.steer;
      let targetYawRate = (vf * Math.tan(angle)) / wheelBase;
      const latMax = 13 * grip * s.stability;
      if (speed > 1) targetYawRate = clamp(targetYawRate, -latMax / speed - 0.4, latMax / speed + 0.4);
      if (input.handbrake && speed > 6) targetYawRate *= 1.6;
      this.yawRate = damp(this.yawRate, targetYawRate, 9 * Math.min(1.3, grip), dt);
      this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

      // ---------------- lateral grip ----------------
      let latGrip = 9 * grip;
      if (input.handbrake) latGrip = 1.0;
      // loose cars (low grip vs power) slide more when flooring it
      if (input.throttle > 0 && speed > 8 && s.accel / grip > 18) latGrip *= 0.7;
      vl *= Math.exp(-latGrip * dt);
      this.slip = Math.abs(vl);

      // drift scoring
      if (this.slip > 3.5 && speed > 9) {
        this.drift.active = true;
        this.drift.timer = 0;
        this.drift.score += this.slip * speed * dt * 0.6 * this.drift.mult;
        this.drift.mult = Math.min(5, this.drift.mult + dt * 0.25);
      } else if (this.drift.active) {
        this.drift.timer += dt;
        if (this.drift.timer > 0.9) {
          if (this.drift.score > 50) this.emit('drift', { score: Math.round(this.drift.score) });
          this.drift.active = false; this.drift.score = 0; this.drift.mult = 1;
        }
      }

      // recompose with new heading
      const nfx = Math.sin(this.yaw), nfz = Math.cos(this.yaw);
      const nrx = -nfz, nrz = nfx;
      this.vel.x = nfx * vf + nrx * vl;
      this.vel.z = nfz * vf + nrz * vl;

      // gravity along slope
      world.normalAt(this.pos.x, this.pos.z, _n);
      this.vel.x += G * _n.y * _n.x * dt * 0.7;
      this.vel.z += G * _n.y * _n.z * dt * 0.7;
      // bumpy surfaces jiggle the body
      if (sp.bump > 0 && speed > 5) this.bodyPitch += (Math.random() - 0.5) * sp.bump * 0.02 * Math.min(1, speed / 20) / s.stability;
      this.prevVf = vf;
    } else {
      // ---------------- airborne ----------------
      this.airTime += dt;
      const spin = -input.steer * 2.6 * dt;
      this.yaw = wrapAngle(this.yaw + spin + this.yawRate * dt);
      this.yawRate *= Math.exp(-0.6 * dt);
      this.airSpin += spin + this.yawRate * dt;
      this.airMaxH = Math.max(this.airMaxH, this.pos.y - gh);
      // keep momentum direction loosely tied to the car heading so landings feel fair
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > 1) {
        const ang = Math.atan2(this.vel.x, this.vel.z);
        const diff = wrapAngle(this.yaw - ang);
        if (Math.abs(diff) < 1.2) {
          const na = ang + diff * Math.min(1, dt * 1.5);
          this.vel.x = Math.sin(na) * hs; this.vel.z = Math.cos(na) * hs;
        }
      }
      if (this.nitroOn) { this.vel.x += Math.sin(this.yaw) * s.accel * 0.5 * dt; this.vel.z += Math.cos(this.yaw) * s.accel * 0.5 * dt; }
      this.vel.multiplyScalar(Math.exp(-0.02 * dt));
    }

    // ---------------- integrate ----------------
    const ox = this.pos.x, oz = this.pos.z, oy = this.pos.y;
    this.vel.y -= G * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    let ngh = world.heightAt(this.pos.x, this.pos.z);

    // steep step (side of a ramp / cliff) -> treat like a wall
    if (this.grounded && ngh - oy > 1.1) {
      this.pos.x = ox; this.pos.z = oz;
      const impact = Math.hypot(this.vel.x, this.vel.z);
      this.vel.x *= -0.25; this.vel.z *= -0.25;
      if (impact > 4) this.emit('crash', { impact });
      ngh = world.heightAt(this.pos.x, this.pos.z);
    }

    if (this.pos.y <= ngh) {
      const groundVy = (ngh - gh) / dt;
      if (!this.grounded) {
        const impact = groundVy - this.vel.y;
        this.onLand(impact);
      }
      this.pos.y = ngh;
      // keep upward ground velocity so ramps launch the car
      this.vel.y = clamp(groundVy, -40, 40);
      this.grounded = true;
    } else if (this.pos.y > ngh + 0.25) {
      if (this.grounded) { this.airTime = 0; this.airSpin = 0; this.airMaxH = 0; this.takeoff = this.pos.clone(); }
      this.grounded = false;
    } else if (this.grounded) {
      // tiny gaps: stick to the ground
      this.pos.y = Math.max(ngh, this.pos.y - 3 * dt);
      if (this.pos.y - ngh < 0.05) this.vel.y = (ngh - gh) / dt;
    }

    this.collide(world);

    // water
    const depth = WATER_LEVEL - world.terrainHeight(this.pos.x, this.pos.z);
    if (depth > 0.2 && this.pos.y < WATER_LEVEL + 0.2) {
      const k = clamp(depth / 1.5, 0, 1);
      this.vel.x *= Math.exp(-2.5 * k * dt);
      this.vel.z *= Math.exp(-2.5 * k * dt);
      if (Math.random() < 0.3 && this.speed > 3) this.emit('splash', {});
      if (depth > 1.3) this.submerged += dt; else this.submerged = 0;
      if (this.submerged > 1.2) { this.emit('drown', {}); this.submerged = 0; }
    } else this.submerged = 0;

    // remember last safe spot on a road for resets
    if (this.grounded && world.isRoadish(this.pos.x, this.pos.z) && this.speed > 2) {
      this.lastSafe.pos.copy(this.pos);
      this.lastSafe.yaw = this.yaw;
    }

    // world bounds
    const lim = 1150;
    if (Math.abs(this.pos.x) > lim || Math.abs(this.pos.z) > lim) {
      this.pos.x = clamp(this.pos.x, -lim, lim); this.pos.z = clamp(this.pos.z, -lim, lim);
      this.vel.x *= -0.3; this.vel.z *= -0.3;
    }
  }

  onLand(impact) {
    const air = this.airTime;
    const spins = Math.abs(this.airSpin) / (Math.PI * 2);
    const distance = this.takeoff ? Math.hypot(this.pos.x - this.takeoff.x, this.pos.z - this.takeoff.z) : 0;
    if (air > 0.6) this.emit('jump', { air, spins, height: this.airMaxH, impact, distance });
    if (impact > 9) {
      const loss = clamp((impact - 9) * 0.02 / this.stats.landing, 0, 0.4);
      this.vel.x *= 1 - loss; this.vel.z *= 1 - loss;
      this.emit('land', { impact });
    }
    this.bodyPitch += clamp(impact * 0.01, 0, 0.12);
    this.airTime = 0; this.airSpin = 0; this.airMaxH = 0;
  }

  collide(world) {
    world.queryColliders(this.pos.x, this.pos.z, _colliders);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const r = this.radius;
    const offs = [this.halfLen - r, 0, -(this.halfLen - r)];
    for (const off of offs) {
      const cx = this.pos.x + fx * off, cz = this.pos.z + fz * off;
      for (const c of _colliders) {
        if (this.pos.y > c.top) continue;
        let nx, nz, pen;
        if (c.circle) {
          const dx = cx - c.x, dz = cz - c.z;
          const d = Math.hypot(dx, dz);
          if (d >= r + c.r || d === 0) continue;
          nx = dx / d; nz = dz / d; pen = r + c.r - d;
        } else {
          const px = clamp(cx, c.minX, c.maxX), pz = clamp(cz, c.minZ, c.maxZ);
          const dx = cx - px, dz = cz - pz;
          const d = Math.hypot(dx, dz);
          if (d >= r) continue;
          if (d > 1e-4) { nx = dx / d; nz = dz / d; pen = r - d; }
          else {
            // centre inside the box: push out along the shallowest axis
            const l = cx - c.minX, rr = c.maxX - cx, t = cz - c.minZ, b = c.maxZ - cz;
            const m = Math.min(l, rr, t, b);
            if (m === l) { nx = -1; nz = 0; } else if (m === rr) { nx = 1; nz = 0; } else if (m === t) { nx = 0; nz = -1; } else { nx = 0; nz = 1; }
            pen = m + r;
          }
        }
        this.resolveHit(nx, nz, pen, c.tree ? 0.15 : 0.3);
      }
    }
    // knockable props
    for (const p of world.props) {
      if (p.hit) continue;
      const pp = p.mesh.position;
      const dx = pp.x - this.pos.x, dz = pp.z - this.pos.z;
      if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
      if (Math.abs(pp.y - this.pos.y) > 3) continue;
      // distance from prop to the car's centre line segment
      const t = clamp(dx * fx + dz * fz, -this.halfLen, this.halfLen);
      const qx = this.pos.x + fx * t, qz = this.pos.z + fz * t;
      const d = Math.hypot(pp.x - qx, pp.z - qz);
      if (d < r + p.r) {
        const sp = this.speed;
        p.hit = true; p.timer = 0;
        const nx = (pp.x - qx) / (d || 1), nz = (pp.z - qz) / (d || 1);
        p.vel.set(this.vel.x * 1.15 + nx * 3, 3 + sp * 0.25 + Math.random() * 2, this.vel.z * 1.15 + nz * 3);
        p.spin.set((Math.random() - 0.5) * 12, 0, (Math.random() - 0.5) * 12);
        const slow = clamp((p.mass / this.stats.mass) * 2 / this.stats.smash, 0, 0.3);
        this.vel.x *= 1 - slow; this.vel.z *= 1 - slow;
        this.emit('smash', { prop: p.type, speed: sp });
      }
    }
  }

  resolveHit(nx, nz, pen, restitution) {
    this.pos.x += nx * pen;
    this.pos.z += nz * pen;
    const vn = this.vel.x * nx + this.vel.z * nz;
    if (vn < 0) {
      this.vel.x -= (1 + restitution) * vn * nx;
      this.vel.z -= (1 + restitution) * vn * nz;
      // scrub some tangential speed
      this.vel.x *= 0.92; this.vel.z *= 0.92;
      // glancing blows rotate the car a little
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const side = fx * nz - fz * nx;
      this.yawRate += side * Math.min(2, -vn * 0.08);
      if (-vn > 3) this.emit('crash', { impact: -vn });
    }
  }

  // Generic circle push used by traffic cars.
  collideCircle(x, z, r, otherVel) {
    const dx = this.pos.x - x, dz = this.pos.z - z;
    const d = Math.hypot(dx, dz);
    const R = this.radius + r + this.halfLen * 0.5;
    if (d >= R || d === 0) return false;
    const nx = dx / d, nz = dz / d;
    const rvx = this.vel.x - (otherVel ? otherVel.x : 0), rvz = this.vel.z - (otherVel ? otherVel.z : 0);
    this.pos.x += nx * (R - d);
    this.pos.z += nz * (R - d);
    const vn = rvx * nx + rvz * nz;
    if (vn < 0) {
      this.vel.x -= 1.4 * vn * nx;
      this.vel.z -= 1.4 * vn * nz;
      if (-vn > 3) this.emit('crash', { impact: -vn, traffic: true });
    }
    return -vn;
  }

  syncModel(dt, world) {
    const m = this.model;
    m.position.copy(this.pos);
    // ground-aligned up vector
    const target = this.grounded ? world.normalAt(this.pos.x, this.pos.z, _n) : _n.set(0, 1, 0);
    if (!this.grounded) {
      // tip the nose along the flight path a bit
      const hs = Math.max(4, this.speed);
      const pitch = clamp(Math.atan2(this.vel.y, hs) * 0.6, -0.6, 0.6);
      target.set(0, 1, 0).applyAxisAngle(_v.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), -pitch);
    }
    this.up.lerp(target, dt > 0 ? 1 - Math.exp(-10 * dt) : 1).normalize();
    const fwd = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    fwd.addScaledVector(this.up, -fwd.dot(this.up)).normalize();
    const right = new THREE.Vector3().crossVectors(this.up, fwd).normalize();
    _m.makeBasis(right, this.up, fwd);
    m.quaternion.setFromRotationMatrix(_m);

    // body lean from acceleration / cornering
    const ud = m.userData;
    const latAcc = this.yawRate * this.speed;
    this.bodyRoll = damp(this.bodyRoll, clamp(-latAcc * 0.006, -0.08, 0.08) / this.stats.stability, 6, dt || 0.016);
    this.bodyPitch = damp(this.bodyPitch, 0, 5, dt || 0.016);
    ud.bodyGroup.rotation.set(this.bodyPitch, 0, this.bodyRoll);

    // wheels
    const vf = this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
    this.wheelRot += (vf / this.def.body.wheelR) * (dt || 0);
    for (const w of ud.wheels) {
      w.spin.rotation.x = this.wheelRot;
      if (w.front) w.pivot.rotation.y = -this.steer * 0.45;
    }
    if (ud.kenneyWheels) for (const w of ud.kenneyWheels) w.rotation.x = this.wheelRot;
    ud.tailMat.emissiveIntensity = this.braking ? 2.0 : 0.3;
  }

  setPaint(color, finishId) {
    const fin = FINISHES.find((f) => f.id === finishId) || FINISHES[0];
    const pm = this.model.userData.paintMat;
    pm.color.set(color);
    pm.roughness = fin.roughness;
    pm.metalness = fin.metalness;
  }
}
