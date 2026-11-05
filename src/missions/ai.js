// AI drivers for missions: route followers (fleeing suspects, tail targets) and pursuers (police).
// They drive real Car physics so they collide with buildings, props and the player.
import * as THREE from 'three';
import { Car } from '../car.js';
import { vehicleById, computeStats } from '../vehicles.js';
import { clamp, wrapAngle, damp } from '../util.js';
import { laneOffset } from './roadgraph.js';

export function addLightBar(model, kind = 'police') {
  const grp = new THREE.Group();
  const def = model.userData;
  const red = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1122, emissiveIntensity: 0 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x000055, emissive: kind === 'police' ? 0x2255ff : 0xff1122, emissiveIntensity: 0 });
  const a = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), red);
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), blue);
  a.position.x = -0.3; b.position.x = 0.3;
  grp.add(a, b);
  def.lightBar = { grp, red, blue };
  return grp;
}

export function flashLightBar(model, t) {
  const lb = model.userData.lightBar;
  if (!lb) return;
  const on = Math.floor(t * 6) % 2 === 0;
  lb.red.emissiveIntensity = on ? 4 : 0;
  lb.blue.emissiveIntensity = on ? 0 : 4;
}

export class AIDriver {
  // opts: { vehicle, paint, police, mode: 'wander'|'route'|'pursue', skill, speedMul }
  constructor(game, x, z, yaw, opts) {
    this.game = game;
    this.opts = opts;
    const def = vehicleById(opts.vehicle || 'sedan');
    const setup = { upgrades: { engine: opts.skill > 0.5 ? 2 : 1, gearbox: 1, brakes: 2 }, tires: 'sport', paint: opts.paint || def.color, finish: 'gloss' };
    const stats = computeStats(def, setup);
    stats.topSpeed *= opts.speedMul || 1;
    this.car = new Car(def, stats, setup, game.scene);
    if (opts.police || opts.siren) {
      const lb = addLightBar(this.car.model, opts.police ? 'police' : 'ambulance');
      lb.position.set(0, def.body.ride + def.body.hgt + def.body.cabH + 0.1, def.body.cabOff * def.body.len);
      this.car.model.userData.bodyGroup.add(lb);
    }
    this.car.place(x, z, yaw, game.world);
    this.queue = [];
    this.lastNode = null;
    this.nextNode = null;
    this.stuckT = 0;
    this.speedFactor = 1;
    this.replanT = 0;
    this.rnd = opts.rnd || Math.random;
    this.done = false;
    if (opts.mode !== 'pursue') this.startRoute();
  }

  dispose() {
    this.game.scene.remove(this.car.model);
  }

  startRoute() {
    if (this.opts.mode === 'track') {
      // follow a closed racing line, starting from the nearest point ahead of us
      const loop = this.opts.loop;
      let bi = 0, bd = Infinity;
      loop.forEach((q, i) => { const d = (q.x - this.car.pos.x) ** 2 + (q.z - this.car.pos.z) ** 2; if (d < bd) { bd = d; bi = i; } });
      this.queue = loop.slice(bi + 1).concat(loop);
      return;
    }
    const g = this.game.graph;
    const c = this.car.pos;
    // choose the node ahead of us to start from
    const fx = Math.sin(this.car.yaw), fz = Math.cos(this.car.yaw);
    let best = null, bs = -Infinity;
    for (const n of g.nodes) {
      const dx = n.x - c.x, dz = n.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > 220) continue;
      const score = (dx * fx + dz * fz) / (d + 1) * 60 - d * 0.3;
      if (score > bs) { bs = score; best = n; }
    }
    best = best || g.nearestNode(c.x, c.z);
    this.queue = [{ x: best.x, z: best.z }];
    this.nextNode = best;
    if (this.opts.mode === 'route' && this.opts.dest) {
      const dn = g.nearestNode(this.opts.dest.x, this.opts.dest.z);
      const p = g.path(best, dn);
      if (p) for (const e of p.edges) this.queue.push(...laneOffset(e.pts, e.lane).slice(1));
      this.queue.push({ x: this.opts.dest.x, z: this.opts.dest.z, end: true });
      this.nextNode = null;
    }
  }

  extendWander() {
    // random walk without U-turns; prefers continuing straight-ish
    const node = this.nextNode;
    if (!node) return;
    let options = node.edges.filter((e) => e.to !== this.lastNode);
    if (!options.length) options = node.edges;
    const weights = options.map((e) => {
      const away = Math.hypot(e.to.x - this.game.car.pos.x, e.to.z - this.game.car.pos.z);
      return 1 + (this.opts.flee ? away / 200 : 0) + (e.lane > 4 ? 0.6 : 0);
    });
    let r = this.rnd() * weights.reduce((a, b) => a + b, 0);
    let pick = options[0];
    for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r <= 0) { pick = options[i]; break; } }
    this.queue.push(...laneOffset(pick.pts, pick.lane).slice(1));
    this.lastNode = node;
    this.nextNode = pick.to;
  }

  planPursuit(target) {
    const g = this.game.graph;
    const c = this.car.pos;
    const a = g.nearestNode(c.x, c.z), b = g.nearestNode(target.x, target.z);
    const p = g.path(a, b);
    this.queue = [{ x: a.x, z: a.z }];
    if (p) for (const e of p.edges) this.queue.push(...laneOffset(e.pts, e.lane * 0.3).slice(1));
    this.queue.push({ x: target.x, z: target.z });
  }

  update(dt, desiredSpeed) {
    const car = this.car, world = this.game.world;
    const p = car.pos;
    let target;
    if (this.opts.mode === 'pursue') {
      const pl = this.opts.target ? this.opts.target(this) : this.game.car;
      if (!pl) { target = { x: p.x, z: p.z }; }
      const d = pl ? Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z) : 0;
      this.replanT -= dt;
      if (!pl) { /* idle */ } else if (d < 70 || this.opts.direct) {
        // direct chase with lead
        target = { x: pl.pos.x + pl.vel.x * 0.4, z: pl.pos.z + pl.vel.z * 0.4 };
        this.queue.length = 0;
      } else {
        if (this.replanT <= 0 || this.queue.length < 3) { this.planPursuit(pl.pos); this.replanT = 1.5; }
      }
    } else if (this.queue.length < 30 && this.opts.mode === 'wander') this.extendWander();
    else if (this.opts.mode === 'track' && this.queue.length < 60) this.queue.push(...this.opts.loop);

    let corner = 1;
    if (!target) {
      while (this.queue.length > 1) {
        const q = this.queue[0];
        const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
        const dx = q.x - p.x, dz = q.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 7 + car.speed * 0.25 || (d < 25 && dx * fx + dz * fz < 0)) this.queue.shift();
        else break;
      }
      const look = 6 + car.speed * 0.45;
      target = this.queue[0];
      let acc = 0;
      for (let i = 0; i < this.queue.length - 1; i++) {
        const a = this.queue[i], b = this.queue[i + 1];
        acc += Math.hypot(b.x - a.x, b.z - a.z);
        if (acc > look) break;
        target = b;
      }
      if (!target) { this.done = true; target = { x: p.x, z: p.z }; }
      if (this.queue.length === 1 && this.queue[0].end && Math.hypot(this.queue[0].x - p.x, this.queue[0].z - p.z) < 10) this.done = true;
      // look further ahead for corners
      const far = this.queue[Math.min(this.queue.length - 1, 8)];
      if (far && target) {
        const a1 = Math.atan2(target.x - p.x, target.z - p.z), a2 = Math.atan2(far.x - target.x, far.z - target.z);
        corner = 1 - Math.min(0.65, Math.abs(wrapAngle(a2 - a1)) * 0.5);
      }
    }
    const want = Math.atan2(target.x - p.x, target.z - p.z);
    const diff = wrapAngle(want - car.yaw);
    const steer = clamp(-diff * 2.4, -1, 1);
    const desired = (desiredSpeed ?? car.stats.topSpeed) * corner * (Math.abs(diff) > 1.2 ? 0.4 : 1);
    const sp = car.speed;
    const input = {
      steer,
      throttle: sp < desired ? 1 : 0,
      brake: sp > desired + 4 ? 0.7 : 0,
      handbrake: false,
      nitro: this.opts.nitro && sp < desired && sp > 10 && Math.abs(diff) < 0.2,
    };
    if (this.done) { input.throttle = 0; input.brake = 1; }
    car.update(dt, input, world, this.game.env);
    // AI doesn't care about stunt/drift events; handle water/stuck
    for (const e of car.events) if (e.type === 'drown') this.unstick();
    car.events.length = 0;
    if (!this.done && sp < 1.5 && input.throttle) { this.stuckT += dt; if (this.stuckT > 2.2) this.unstick(); } else this.stuckT = 0;
    if (car.model.userData.lightBar) flashLightBar(car.model, performance.now() / 1000);
  }

  // Reset onto the route a little ahead (rubber-band recovery).
  unstick() {
    this.stuckT = 0;
    const q = this.queue[Math.min(3, this.queue.length - 1)] || this.game.graph.nearestNode(this.car.pos.x, this.car.pos.z);
    const q2 = this.queue[Math.min(5, this.queue.length - 1)] || q;
    const yaw = q2 === q ? this.car.yaw : Math.atan2(q2.x - q.x, q2.z - q.z);
    this.car.place(q.x, q.z, yaw, this.game.world);
    this.queue.splice(0, 3);
    if (this.opts.mode === 'pursue') this.replanT = 0;
  }

  // bumper-car collisions between this AI car and the player; returns the impact speed
  collidePlayer() {
    const res = this.game.car.bump(this.car);
    if (!res || res.impact <= 0) return 0;
    this.car.vel.x += res.dvB.x; this.car.vel.z += res.dvB.z;
    this.car.yawRate += res.kickB;
    return res.impact;
  }
}
