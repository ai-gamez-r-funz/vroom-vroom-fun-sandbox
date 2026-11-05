// Visual effects: tyre smoke, surface dust, water splashes, crash sparks, nitro flames,
// leaves and confetti (GPU point sprites), plus fading skid-mark decals.
import * as THREE from 'three';
import { SURF, SURF_PROPS, WATER_LEVEL } from './world.js';

const TYPES = {
  smoke: { glow: false, life: [1.2, 2.0], size: [1.4, 5], alpha: 0.42, drag: 1.6, grav: 0.9, color: [0.82, 0.82, 0.84] },
  dust: { glow: false, life: [0.8, 1.4], size: [1.0, 3.6], alpha: 0.5, drag: 2.2, grav: 0.4 },
  splash: { glow: false, life: [0.5, 0.9], size: [0.5, 1.2], alpha: 0.75, drag: 0.6, grav: -12, color: [0.8, 0.9, 1.0] },
  debris: { glow: false, life: [0.8, 1.6], size: [0.35, 0.3], alpha: 1, drag: 0.4, grav: -14, color: [0.45, 0.35, 0.25] },
  leaf: { glow: false, life: [1.5, 2.6], size: [0.35, 0.35], alpha: 1, drag: 1.2, grav: -2.5, color: [0.25, 0.5, 0.18] },
  confetti: { glow: false, life: [2.0, 3.2], size: [0.32, 0.32], alpha: 1, drag: 1.4, grav: -3, color: null },
  spark: { glow: true, life: [0.25, 0.55], size: [0.28, 0.08], alpha: 1, drag: 0.8, grav: -16, color: [1.0, 0.65, 0.2] },
  flame: { glow: true, life: [0.08, 0.18], size: [0.7, 0.15], alpha: 0.9, drag: 4, grav: 0, color: [0.35, 0.55, 1.0] },
  flash: { glow: true, life: [0.12, 0.2], size: [3, 6], alpha: 0.8, drag: 0, grav: 0, color: [1.0, 0.85, 0.5] },
};

class ParticlePool {
  constructor(scene, max, additive) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.type = new Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { scale: { value: 600 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC;
        uniform float scale;
        void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
          float a = vA * smoothstep(0.5, 0.15, r); gl_FragColor = vec4(vC, a); }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.geo = g;
  }

  spawn(t, x, y, z, vx, vy, vz, color) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    const c = color || t.color || [1, 1, 1];
    this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
    const life = t.life[0] + Math.random() * (t.life[1] - t.life[0]);
    this.life[i] = life; this.maxLife[i] = life;
    this.type[i] = t;
    this.size[i] = t.size[0];
    this.alpha[i] = t.alpha;
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove with the last live particle
        const j = --this.n;
        if (i !== j) {
          for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[j * 3 + k]; this.vel[i * 3 + k] = this.vel[j * 3 + k]; this.col[i * 3 + k] = this.col[j * 3 + k]; }
          this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.type[i] = this.type[j];
          this.size[i] = this.size[j]; this.alpha[i] = this.alpha[j];
        }
        continue;
      }
      const t = this.type[i];
      const k = 1 - this.life[i] / this.maxLife[i]; // 0 -> 1 over lifetime
      const drag = Math.exp(-t.drag * dt);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 2] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag + t.grav * dt;
      if (t === TYPES.confetti || t === TYPES.leaf) this.vel[i * 3] += Math.sin((this.life[i] + i) * 9) * dt * 3;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = t.size[0] + (t.size[1] - t.size[0]) * k;
      this.alpha[i] = t.alpha * (k < 0.1 ? k * 10 : 1 - (k - 0.1) / 0.9);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const a of ['position', 'color', 'size', 'alpha']) this.geo.attributes[a].needsUpdate = true;
  }
}

// Skid marks: a ring buffer of quads. Each quad remembers its birth time and fades in the shader.
class SkidMarks {
  constructor(scene, max = 2400) {
    this.max = max;
    this.next = 0;
    this.pos = new Float32Array(max * 4 * 3);
    this.birth = new Float32Array(max * 4).fill(-1e6);
    this.strength = new Float32Array(max * 4);
    const idx = [];
    for (let q = 0; q < max; q++) { const v = q * 4; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('birth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('strength', new THREE.BufferAttribute(this.strength, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.uniforms = { time: { value: 0 }, fade: { value: 40 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: `attribute float birth; attribute float strength; uniform float time; uniform float fade; varying float vA;
        void main(){ float age = time - birth; vA = strength * clamp(1.0 - age / fade, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(0.06, 0.06, 0.07, vA * 0.55); }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.geo = g;
    this.dirty = false;
  }

  // add a quad from point a to b (both {x,y,z}) with half-width w
  add(a, b, w, strength, time) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.05 || l > 6) return;
    const nx = (-dz / l) * w, nz = (dx / l) * w;
    const q = this.next;
    this.next = (this.next + 1) % this.max;
    const P = this.pos, o = q * 12;
    P[o] = a.x + nx; P[o + 1] = a.y; P[o + 2] = a.z + nz;
    P[o + 3] = a.x - nx; P[o + 4] = a.y; P[o + 5] = a.z - nz;
    P[o + 6] = b.x + nx; P[o + 7] = b.y; P[o + 8] = b.z + nz;
    P[o + 9] = b.x - nx; P[o + 10] = b.y; P[o + 11] = b.z - nz;
    for (let k = 0; k < 4; k++) { this.birth[q * 4 + k] = time; this.strength[q * 4 + k] = strength; }
    this.dirty = true;
  }

  update(time) {
    this.uniforms.time.value = time;
    if (this.dirty) {
      for (const a of ['position', 'birth', 'strength']) this.geo.attributes[a].needsUpdate = true;
      this.dirty = false;
    }
  }
}

const _w = new THREE.Vector3();

export class FX {
  constructor(scene, world, camera, renderer) {
    this.world = world;
    this.camera = camera;
    this.renderer = renderer;
    this.soft = new ParticlePool(scene, 2600, false);
    this.glow = new ParticlePool(scene, 900, true);
    this.skids = new SkidMarks(scene);
    this.time = 0;
    this.tracks = new WeakMap(); // per-car last wheel positions for skid marks
    this.quality = 1;
  }

  setQuality(q) { this.quality = q === 'low' ? 0.35 : q === 'medium' ? 0.65 : 1; }

  emit(type, x, y, z, vx = 0, vy = 0, vz = 0, color, spread = 0) {
    const t = TYPES[type];
    const pool = t.glow ? this.glow : this.soft;
    pool.spawn(t, x + (Math.random() - 0.5) * spread, y, z + (Math.random() - 0.5) * spread, vx, vy, vz, color);
  }

  burst(type, x, y, z, count, speed = 4, color) {
    count = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random();
      const c = type === 'confetti' ? [Math.random(), Math.random(), Math.random()] : color;
      this.emit(type, x, y, z, Math.cos(a) * speed * u, speed * (0.4 + Math.random() * 0.8), Math.sin(a) * speed * u, c, 0.4);
    }
  }

  // Per-frame effects for one vehicle. `car` is a Car (or anything with the same fields).
  updateCar(car, dt) {
    const ud = car.model.userData;
    if (!ud || !ud.wheels) return;
    const sp = car.speed;
    const surf = car.surface;
    const props = SURF_PROPS[surf] || SURF_PROPS[0];
    const q = this.quality;
    let tr = this.tracks.get(car);
    if (!tr) { tr = ud.wheels.map(() => null); this.tracks.set(car, tr); }
    const depth = WATER_LEVEL - this.world.terrainHeight(car.pos.x, car.pos.z);
    const slipping = car.grounded && car.slip > 2.4 && sp > 3;
    const braking = car.grounded && car.braking && sp > 9;
    const burnout = car.grounded && (car.throttle || 0) > 0.5 && sp < 7 && sp > 0.3 && car.slip < 1;
    ud.wheels.forEach((w, i) => {
      w.pivot.getWorldPosition(_w);
      const gy = this.world.heightAt(_w.x, _w.z);
      const ground = { x: _w.x, y: gy + 0.16, z: _w.z };
      const rear = !w.front;
      const marking = (slipping && (rear || car.slip > 5)) || braking || (burnout && rear);
      if (marking && depth < 0.1) {
        const prev = tr[i];
        const strength = Math.min(1, (slipping ? car.slip / 7 : 0.6)) * (props.paved ? 1 : 0.6);
        if (prev) this.skids.add(prev, ground, 0.16, strength, this.time);
        tr[i] = ground;
      } else tr[i] = null;
      if (!car.grounded) return;
      // particles
      if (depth > 0.15 && sp > 2) {
        if (Math.random() < q * Math.min(1, sp / 12)) this.emit('splash', _w.x, WATER_LEVEL + 0.2, _w.z, car.vel.x * 0.3 + (Math.random() - 0.5) * 3, 2 + Math.random() * 3 * Math.min(1, sp / 15), car.vel.z * 0.3 + (Math.random() - 0.5) * 3);
        return;
      }
      if (props.paved) {
        if ((slipping && rear) || (burnout && rear) || (braking && Math.random() < 0.15)) {
          const rate = burnout ? 0.7 : Math.min(1, (car.slip - 2) / 5);
          if (Math.random() < rate * q) this.emit('smoke', _w.x, gy + 0.4, _w.z, car.vel.x * 0.15 + (Math.random() - 0.5), 0.5 + Math.random() * 0.6, car.vel.z * 0.15 + (Math.random() - 0.5), null, 0.3);
        }
      } else {
        const rate = Math.min(1, sp / 25) * 0.45 + (slipping ? 0.4 : 0);
        if (sp > 4 && Math.random() < rate * q) {
          const c = props.dust;
          this.emit('dust', _w.x, gy + 0.3, _w.z, -car.vel.x * 0.1 + (Math.random() - 0.5) * 2, 0.6 + Math.random(), -car.vel.z * 0.1 + (Math.random() - 0.5) * 2, c, 0.3);
        }
      }
    });
    // nitro exhaust flames
    if (car.nitroOn) {
      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
      const b = car.def.body;
      for (let k = 0; k < 2; k++) {
        const side = (k ? 1 : -1) * b.wid * 0.25;
        const ex = car.pos.x - fx * (car.halfLen + 0.2) - fz * side, ez = car.pos.z - fz * (car.halfLen + 0.2) + fx * side;
        if (Math.random() < 0.9) this.emit('flame', ex, car.pos.y + b.ride + 0.25, ez, -fx * 6 + car.vel.x, 0.2, -fz * 6 + car.vel.z, Math.random() < 0.3 ? [1, 0.5, 0.15] : null);
      }
    }
  }

  // React to physics events from a car.
  onCarEvent(car, e) {
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const front = { x: car.pos.x + fx * car.halfLen, y: car.pos.y + 0.6, z: car.pos.z + fz * car.halfLen };
    if (e.type === 'crash') {
      const n = Math.min(40, e.impact * 2.5);
      this.burst('spark', front.x, front.y, front.z, n, 3 + e.impact * 0.4);
      if (e.impact > 10) this.emit('flash', front.x, front.y, front.z);
    } else if (e.type === 'bump') this.burst('spark', front.x, front.y, front.z, 6, 3);
    else if (e.type === 'smash') {
      if (e.prop === 'tree') { this.burst('leaf', front.x, car.pos.y + 3, front.z, 26, 5); this.burst('debris', front.x, front.y, front.z, 8, 4); }
      else if (e.prop === 'lamp') { this.burst('spark', front.x, car.pos.y + 1.5, front.z, 24, 6); this.emit('flash', front.x, car.pos.y + 3, front.z); }
      else if (e.prop === 'cactus') this.burst('leaf', front.x, car.pos.y + 1.5, front.z, 14, 4, [0.3, 0.5, 0.25]);
      else this.burst('debris', front.x, front.y, front.z, 10, 4, e.prop === 'cone' ? [1, 0.45, 0.1] : e.prop === 'hay' ? [0.85, 0.75, 0.35] : [0.45, 0.4, 0.35]);
    } else if (e.type === 'land' && car.grounded) {
      const surf = SURF_PROPS[car.surface] || SURF_PROPS[0];
      const c = surf.paved ? [0.75, 0.75, 0.75] : surf.dust;
      for (let i = 0; i < Math.min(30, e.impact * 1.2) * this.quality; i++) {
        const a = Math.random() * Math.PI * 2;
        this.emit('dust', car.pos.x + Math.cos(a) * 1.5, car.pos.y + 0.3, car.pos.z + Math.sin(a) * 1.5, Math.cos(a) * 4, 0.5 + Math.random(), Math.sin(a) * 4, c);
      }
      if (e.impact > 14) this.burst('spark', car.pos.x, car.pos.y + 0.2, car.pos.z, 12, 4);
    } else if (e.type === 'splash' && Math.random() < 0.2) {
      this.burst('splash', car.pos.x, WATER_LEVEL + 0.3, car.pos.z, 6, 4);
    }
  }

  update(dt) {
    this.time += dt;
    // keep point sizes in world units regardless of screen size / FOV
    const h = this.renderer.domElement.height;
    const scale = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.soft.uniforms.scale.value = scale;
    this.glow.uniforms.scale.value = scale;
    this.soft.update(dt);
    this.glow.update(dt);
    this.skids.update(this.time);
  }
}
