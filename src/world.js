// Procedural open world: heightmap terrain with biomes, roads, city, props and colliders.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, fbm, mulberry32 } from './util.js';

export const WORLD_HALF = 1200;
const CELL = 4;
const N = WORLD_HALF * 2 / CELL + 1; // vertices per side
export const CITY_HALF = 306;
export const CITY_STEP = 75;
export const CITY_ROAD_W = 12;
export const LAKE = { x: -430, z: 520, r: 140 };
export const WATER_LEVEL = 0;

export const SURF = { GRASS: 0, ASPHALT: 1, DIRT: 2, SAND: 3, SNOW: 4, ROCK: 5, WATER: 6, CONCRETE: 7 };
export const SURF_NAMES = ['Grass', 'Asphalt', 'Dirt', 'Sand', 'Snow', 'Rock', 'Shallows', 'Concrete'];
// grip multiplier, rolling drag, "paved" flag (tires behave differently off paved surfaces), bumpiness
export const SURF_PROPS = [
  { grip: 0.78, drag: 0.22, paved: false, bump: 0.35, dust: [0.35, 0.5, 0.25] },
  { grip: 1.0, drag: 0.0, paved: true, bump: 0.0, dust: [0.5, 0.5, 0.5] },
  { grip: 0.82, drag: 0.12, paved: false, bump: 0.25, dust: [0.55, 0.42, 0.28] },
  { grip: 0.62, drag: 0.45, paved: false, bump: 0.2, dust: [0.86, 0.76, 0.52] },
  { grip: 0.52, drag: 0.25, paved: false, bump: 0.15, dust: [0.95, 0.97, 1.0] },
  { grip: 0.72, drag: 0.1, paved: false, bump: 0.5, dust: [0.5, 0.48, 0.46] },
  { grip: 0.5, drag: 1.4, paved: false, bump: 0.1, dust: [0.7, 0.85, 1.0] },
  { grip: 0.95, drag: 0.02, paved: true, bump: 0.0, dust: [0.6, 0.6, 0.6] },
];

function biomeWeights(x, z) {
  return {
    n: smoothstep(380, 650, -z),
    e: smoothstep(380, 650, x),
    w: smoothstep(380, 650, -x),
    s: smoothstep(380, 650, z),
  };
}

function rawHeight(x, z) {
  const b = biomeWeights(x, z);
  let h = 4 + fbm(x / 350, z / 350, 4) * 12;
  const ridge = 1 - Math.abs(fbm(x / 260 + 11, z / 260 - 7, 5));
  h += b.n * (ridge * ridge * 130 + 15);
  h += b.w * (fbm(x / 180 + 5, z / 180, 4) * 28 + 10);
  h += b.e * (Math.sin(x / 37 + fbm(x / 200, z / 200, 2) * 3) * 3.5 + fbm(x / 120, z / 120 + 3, 3) * 8 + 3);
  h += b.s * (fbm(x / 150 - 3, z / 150, 3) * 7);
  const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
  const lakeT = smoothstep(LAKE.r * 0.5, LAKE.r + 70, ld);
  h = lerp(-9, Math.max(h, 1.2), lakeT);
  const m = Math.max(Math.abs(x), Math.abs(z));
  const c = 1 - smoothstep(330, 430, m);
  h = lerp(h, 2, c);
  h += smoothstep(960, 1180, m) * (115 + fbm(x / 90, z / 90, 3) * 70);
  return h;
}

// --------------------------------------------------------------------------------------------
// Road network definition
function buildRoadPaths() {
  const roads = [];
  // Highway: superellipse loop with a gentle wobble.
  const hw = [];
  const steps = 1400;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    let r = 700 / Math.pow(Math.pow(Math.abs(c), 4) + Math.pow(Math.abs(s), 4), 0.25);
    r += Math.sin(t * 5) * 25 + Math.sin(t * 3 + 1) * 15;
    hw.push(new THREE.Vector2(c * r, s * r));
  }
  roads.push({ name: 'Ring Highway', pts: resample(hw, 4, true), closed: true, width: 18, type: SURF.ASPHALT, lanes: 2 });

  const hwPts = roads[0].pts;
  const nearestOnHw = (x, z) => {
    let best = null, bd = Infinity;
    for (const p of hwPts) {
      const d = (p.x - x) ** 2 + (p.y - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const connector = (name, sx, sz, dx, dz) => {
    const end = nearestOnHw(sx + dx * 800, sz + dz * 800);
    const pts = [];
    const ctrl = [new THREE.Vector2(sx, sz), new THREE.Vector2(sx + dx * 120, sz + dz * 120)];
    const mid = new THREE.Vector2((sx + end.x) / 2 + dz * 40, (sz + end.y) / 2 + dx * 40);
    ctrl.push(mid, new THREE.Vector2(end.x, end.y));
    const curve = new THREE.SplineCurve(ctrl);
    for (let i = 0; i <= 200; i++) pts.push(curve.getPoint(i / 200));
    return { name, pts: resample(pts, 4, false), closed: false, width: 14, type: SURF.ASPHALT, lanes: 1 };
  };
  roads.push(connector('North Road', 0, -290, 0, -1));
  roads.push(connector('South Road', 0, 290, 0, 1));
  roads.push(connector('East Road', 290, 0, 1, 0));
  roads.push(connector('West Road', -290, 0, -1, 0));

  // Desert rally dirt loop
  const rally = [];
  for (let i = 0; i < 300; i++) {
    const t = (i / 300) * Math.PI * 2;
    const r = 120 + Math.sin(t * 3) * 35 + Math.cos(t * 2) * 20;
    rally.push(new THREE.Vector2(540 + Math.cos(t) * r * 1.3, -250 + Math.sin(t) * r));
  }
  roads.push({ name: 'Dust Bowl Rally', pts: resample(rally, 4, true), closed: true, width: 11, type: SURF.DIRT, lanes: 1 });

  // Winding mountain pass in the snowy north
  const pass = [];
  for (let i = 0; i <= 160; i++) {
    const t = i / 160;
    pass.push(new THREE.Vector2(-320 + t * 620 + Math.sin(t * 9) * 40, -745 - Math.sin(t * Math.PI) * 200 + Math.cos(t * 7) * 25));
  }
  roads.push({ name: 'Frostbite Pass', pts: resample(pass, 4, false), closed: false, width: 12, type: SURF.ASPHALT, lanes: 1 });

  // Forest trail in the west
  const trail = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    trail.push(new THREE.Vector2(-560 + Math.sin(t * 8) * 70, -300 + t * 520));
  }
  roads.push({ name: 'Timberline Trail', pts: resample(trail, 4, false), closed: false, width: 10, type: SURF.DIRT, lanes: 1 });

  // Airfield runway in the south-east (great for top speed runs)
  const rw = [];
  for (let i = 0; i <= 100; i++) rw.push(new THREE.Vector2(280 + i * 3.6, 520));
  roads.push({ name: 'Airfield Runway', pts: resample(rw, 4, false), closed: false, width: 30, type: SURF.ASPHALT, lanes: 0, runway: true });
  return roads;
}

function resample(pts, spacing, closed) {
  const out = [];
  const list = closed ? [...pts, pts[0]] : pts;
  let carry = 0;
  out.push(list[0].clone());
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const len = a.distanceTo(b);
    let d = spacing - carry;
    while (d <= len) {
      out.push(a.clone().lerp(b, d / len));
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  if (closed) out.pop();
  else if (out[out.length - 1].distanceTo(list[list.length - 1]) > spacing * 0.3) out.push(list[list.length - 1].clone());
  return out;
}

// --------------------------------------------------------------------------------------------
export class World {
  constructor(scene) {
    this.scene = scene;
    this.rng = mulberry32(1337);
    this.H = new Float32Array(N * N);
    this.surf = new Uint8Array(N * N);
    this.ramps = [];
    this.boxes = [];
    this.circles = [];
    this.grid = new Map();
    this.props = [];
    this.lampPositions = [];
    this.buildingMats = [];
    this.nightMats = [];

    this.generateHeights();
    this.buildTerrainMesh();
    this.buildRoadMeshes();
    this.buildCity();
    this.buildWater();
    this.buildRamps();
    this.buildVegetation();
    this.buildProps();
    this.buildMapImage();
  }

  idx(i, j) { return j * N + i; }

  generateHeights() {
    const H = this.H;
    const blend = new Float32Array(N * N).fill(1);
    const roadH = new Float32Array(N * N);
    const roadType = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) {
      const z = -WORLD_HALF + j * CELL;
      for (let i = 0; i < N; i++) H[j * N + i] = rawHeight(-WORLD_HALF + i * CELL, z);
    }
    this.roads = buildRoadPaths();
    // Road heights: sample raw terrain, then smooth heavily for drivable grades.
    for (const road of this.roads) {
      const n = road.pts.length;
      let h = road.pts.map((p) => Math.max(this.sampleGrid(H, p.x, p.y), 1.6));
      if (road.runway) h = h.map(() => h.reduce((a, b) => a + b, 0) / n);
      const pinFor = (p) => {
        if (road.closed || road === this.roads[0]) return null;
        if (Math.max(Math.abs(p.x), Math.abs(p.y)) < 320) return 2;
        const hn = this.roadHeightNear(p.x, p.y);
        return hn.d < 45 ? hn.h : null;
      };
      const pinStart = pinFor(road.pts[0]);
      const pinEnd = pinFor(road.pts[n - 1]);
      for (let it = 0; it < 6; it++) {
        const nh = new Array(n);
        const R = 10;
        for (let k = 0; k < n; k++) {
          let s = 0, c = 0;
          for (let o = -R; o <= R; o++) {
            let q = k + o;
            if (road.closed) q = (q + n) % n;
            else q = clamp(q, 0, n - 1);
            s += h[q]; c++;
          }
          nh[k] = s / c;
        }
        h = nh.map((v) => Math.max(v, 1.6));
        if (pinStart !== null) h[0] = pinStart;
        if (pinEnd !== null) h[n - 1] = pinEnd;
      }
      // re-pin with a short blend
      if (pinStart !== null) for (let k = 0; k < Math.min(20, n); k++) h[k] = lerp(pinStart, h[k], k / 20);
      if (pinEnd !== null) for (let k = 0; k < Math.min(20, n); k++) h[n - 1 - k] = lerp(pinEnd, h[n - 1 - k], k / 20);
      road.h = h;
      // stamp
      const half = road.width / 2, fall = 22;
      const rad = half + fall;
      for (let k = 0; k < n - (road.closed ? 0 : 1); k++) {
        const a = road.pts[k], b = road.pts[(k + 1) % n];
        const ha = h[k], hb = h[(k + 1) % n];
        const minI = Math.max(0, Math.floor((Math.min(a.x, b.x) - rad + WORLD_HALF) / CELL));
        const maxI = Math.min(N - 1, Math.ceil((Math.max(a.x, b.x) + rad + WORLD_HALF) / CELL));
        const minJ = Math.max(0, Math.floor((Math.min(a.y, b.y) - rad + WORLD_HALF) / CELL));
        const maxJ = Math.min(N - 1, Math.ceil((Math.max(a.y, b.y) + rad + WORLD_HALF) / CELL));
        const abx = b.x - a.x, abz = b.y - a.y;
        const l2 = abx * abx + abz * abz;
        for (let j = minJ; j <= maxJ; j++) {
          const z = -WORLD_HALF + j * CELL;
          for (let i = minI; i <= maxI; i++) {
            const x = -WORLD_HALF + i * CELL;
            let t = ((x - a.x) * abx + (z - a.y) * abz) / l2;
            t = clamp(t, 0, 1);
            const d = Math.hypot(x - (a.x + abx * t), z - (a.y + abz * t));
            if (d > rad) continue;
            const bt = smoothstep(half + 1, rad, d);
            const id = j * N + i;
            if (bt < blend[id]) { blend[id] = bt; roadH[id] = lerp(ha, hb, t); roadType[id] = road.type; }
          }
        }
      }
    }
    // Apply blend and classify surfaces
    for (let j = 0; j < N; j++) {
      const z = -WORLD_HALF + j * CELL;
      for (let i = 0; i < N; i++) {
        const x = -WORLD_HALF + i * CELL;
        const id = j * N + i;
        if (blend[id] < 1) H[id] = lerp(roadH[id], H[id], blend[id]);
      }
    }
    for (let j = 0; j < N; j++) {
      const z = -WORLD_HALF + j * CELL;
      for (let i = 0; i < N; i++) {
        const x = -WORLD_HALF + i * CELL;
        const id = j * N + i;
        const h = H[id];
        let s;
        const slope = this.gridSlope(i, j);
        const b = biomeWeights(x, z);
        if (blend[id] < 0.12) s = roadType[id];
        else if (Math.abs(x) <= CITY_HALF + 8 && Math.abs(z) <= CITY_HALF + 8) s = SURF.CONCRETE;
        else if (h < 0.4) s = SURF.WATER;
        else if (h < 2.6 && Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 90) s = SURF.SAND;
        else if (slope > 0.85) s = SURF.ROCK;
        else if (b.n > 0.5 && h > 14) s = SURF.SNOW;
        else if (b.e > 0.55) s = SURF.SAND;
        else if (blend[id] < 0.3) s = SURF.DIRT;
        else s = SURF.GRASS;
        this.surf[id] = s;
      }
    }
    this.blend = blend;
  }

  roadHeightNear(x, z) {
    // height of the ring highway closest to (x,z)
    const hw = this.roads[0];
    let bi = 0, bd = Infinity;
    hw.pts.forEach((p, k) => {
      const d = (p.x - x) ** 2 + (p.y - z) ** 2;
      if (d < bd) { bd = d; bi = k; }
    });
    return { h: hw.h ? hw.h[bi] : 2, d: Math.sqrt(bd) };
  }

  gridSlope(i, j) {
    const H = this.H;
    const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1);
    const j0 = Math.max(0, j - 1), j1 = Math.min(N - 1, j + 1);
    const dx = (H[j * N + i1] - H[j * N + i0]) / ((i1 - i0) * CELL);
    const dz = (H[j1 * N + i] - H[j0 * N + i]) / ((j1 - j0) * CELL);
    return Math.hypot(dx, dz);
  }

  sampleGrid(arr, x, z) {
    const fx = clamp((x + WORLD_HALF) / CELL, 0, N - 1.001);
    const fz = clamp((z + WORLD_HALF) / CELL, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const a = arr[j * N + i], b = arr[j * N + i + 1], c = arr[(j + 1) * N + i], d = arr[(j + 1) * N + i + 1];
    // match the triangle split used by PlaneGeometry (diagonal from (i,j+1) to (i+1,j))
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  terrainHeight(x, z) { return this.sampleGrid(this.H, x, z); }

  heightAt(x, z) {
    let h = this.sampleGrid(this.H, x, z);
    for (let k = 0; k < this.ramps.length; k++) {
      const r = this.ramps[k];
      const dx = x - r.x, dz = z - r.z;
      if (dx * dx + dz * dz > r.bound2) continue;
      const lx = dx * r.cos - dz * r.sin;
      const lz = dx * r.sin + dz * r.cos;
      if (Math.abs(lx) > r.w / 2) continue;
      const rh = r.profile(lz);
      if (rh > 0) h = Math.max(h, r.y + rh);
    }
    return h;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.2;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  surfaceAt(x, z) {
    for (const r of this.ramps) {
      const dx = x - r.x, dz = z - r.z;
      if (dx * dx + dz * dz < r.bound2) {
        const lx = dx * r.cos - dz * r.sin, lz = dx * r.sin + dz * r.cos;
        if (Math.abs(lx) < r.w / 2 && r.profile(lz) > 0) return SURF.CONCRETE;
      }
    }
    if (Math.abs(x) <= CITY_HALF + 6 && Math.abs(z) <= CITY_HALF + 6) {
      const mx = Math.abs(x - Math.round(x / CITY_STEP) * CITY_STEP);
      const mz = Math.abs(z - Math.round(z / CITY_STEP) * CITY_STEP);
      if (mx < CITY_ROAD_W / 2 || mz < CITY_ROAD_W / 2) return SURF.ASPHALT;
    }
    const i = Math.round(clamp((x + WORLD_HALF) / CELL, 0, N - 1));
    const j = Math.round(clamp((z + WORLD_HALF) / CELL, 0, N - 1));
    return this.surf[j * N + i];
  }

  isRoadish(x, z) {
    const s = this.surfaceAt(x, z);
    return s === SURF.ASPHALT || s === SURF.DIRT || s === SURF.CONCRETE;
  }

  // ------------------------------------------------------------------------------------------
  buildTerrainMesh() {
    const geo = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, N - 1, N - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const tmpC = new THREE.Color();
    const palette = {
      [SURF.GRASS]: [0.36, 0.58, 0.27],
      [SURF.ASPHALT]: [0.42, 0.4, 0.38],
      [SURF.DIRT]: [0.55, 0.42, 0.28],
      [SURF.SAND]: [0.87, 0.77, 0.52],
      [SURF.SNOW]: [0.93, 0.95, 0.99],
      [SURF.ROCK]: [0.5, 0.48, 0.46],
      [SURF.WATER]: [0.56, 0.52, 0.38],
      [SURF.CONCRETE]: [0.62, 0.62, 0.6],
    };
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k);
      const i = Math.round((x + WORLD_HALF) / CELL), j = Math.round((z + WORLD_HALF) / CELL);
      const id = j * N + i;
      pos.setY(k, this.H[id]);
      const c = palette[this.surf[id]];
      const b = biomeWeights(x, z);
      const n = fbm(x / 23, z / 23, 2) * 0.08;
      let r = c[0] + n, g = c[1] + n, bl = c[2] + n;
      if (this.surf[id] === SURF.GRASS) {
        // forest is darker, south farmland is lighter / yellower
        r = lerp(r, 0.24, b.w * 0.6); g = lerp(g, 0.44, b.w * 0.6); bl = lerp(bl, 0.2, b.w * 0.6);
        r = lerp(r, 0.55, b.s * 0.35); g = lerp(g, 0.62, b.s * 0.35);
      }
      // high peaks get snow caps, very steep faces show rock
      const hgt = this.H[id];
      if (this.surf[id] !== SURF.ASPHALT && this.surf[id] !== SURF.DIRT) {
        const capT = clamp((hgt - 95) / 35, 0, 1) * (this.surf[id] === SURF.ROCK ? 0.6 : 1);
        r = lerp(r, 0.93, capT); g = lerp(g, 0.95, capT); bl = lerp(bl, 0.99, capT);
      }
      tmpC.setRGB(clamp(r, 0, 1), clamp(g, 0, 1), clamp(bl, 0, 1), THREE.SRGBColorSpace);
      colors[k * 3] = tmpC.r; colors[k * 3 + 1] = tmpC.g; colors[k * 3 + 2] = tmpC.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrain = mesh;
  }

  makeRoadTexture(type) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    const rnd = mulberry32(type * 99 + 7);
    if (type === SURF.DIRT) {
      g.fillStyle = '#8a6a45'; g.fillRect(0, 0, 128, 256);
      for (let i = 0; i < 1500; i++) {
        const v = 100 + rnd() * 70;
        g.fillStyle = `rgba(${v},${v * 0.78},${v * 0.55},0.5)`;
        g.fillRect(rnd() * 128, rnd() * 256, 2, 2);
      }
      g.fillStyle = 'rgba(60,45,30,0.35)';
      g.fillRect(30, 0, 14, 256); g.fillRect(84, 0, 14, 256);
    } else {
      g.fillStyle = '#3d3d40'; g.fillRect(0, 0, 128, 256);
      for (let i = 0; i < 2500; i++) {
        const v = 45 + rnd() * 40;
        g.fillStyle = `rgba(${v},${v},${v + 3},0.6)`;
        g.fillRect(rnd() * 128, rnd() * 256, 1.5, 1.5);
      }
      g.fillStyle = '#e8e8e8';
      g.fillRect(4, 0, 4, 256); g.fillRect(120, 0, 4, 256);
      g.fillStyle = '#f2c230';
      g.fillRect(61, 0, 6, 150);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildRoadMeshes() {
    const asphalt = new THREE.MeshLambertMaterial({ map: this.makeRoadTexture(SURF.ASPHALT), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const dirt = new THREE.MeshLambertMaterial({ map: this.makeRoadTexture(SURF.DIRT), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const road of this.roads) {
      const n = road.pts.length;
      const segs = road.closed ? n : n - 1;
      const verts = [], uvs = [], idx = [];
      let v = 0;
      for (let k = 0; k <= segs; k++) {
        const p = road.pts[k % n];
        const prev = road.pts[road.closed ? (k - 1 + n) % n : Math.max(0, k - 1)];
        const next = road.pts[road.closed ? (k + 1) % n : Math.min(n - 1, k + 1)];
        const tx = next.x - prev.x, tz = next.y - prev.y;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl, nz = tx / tl;
        const hw = road.width / 2;
        const h = road.h[k % n] + 0.12;
        verts.push(p.x + nx * hw, h, p.y + nz * hw, p.x - nx * hw, h, p.y - nz * hw);
        if (k > 0) v += road.pts[k % n].distanceTo(road.pts[(k - 1) % n]) / 10;
        uvs.push(0, v, 1, v);
        if (k < segs) {
          const a = k * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, road.type === SURF.DIRT ? dirt : asphalt);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      // Guard-rail posts on the highway's outer edge (visual only)
    }
  }

  // ------------------------------------------------------------------------------------------
  addBox(minX, maxX, minZ, maxZ, top, extra = {}) {
    const b = { minX, maxX, minZ, maxZ, top, ...extra };
    this.boxes.push(b);
    this.hashInsert(b, minX, maxX, minZ, maxZ);
    return b;
  }
  addCircle(x, z, r, top, extra = {}) {
    const c = { x, z, r, top, circle: true, ...extra };
    this.circles.push(c);
    this.hashInsert(c, x - r, x + r, z - r, z + r);
    return c;
  }
  hashInsert(obj, minX, maxX, minZ, maxZ) {
    const G = 40;
    for (let gx = Math.floor(minX / G); gx <= Math.floor(maxX / G); gx++)
      for (let gz = Math.floor(minZ / G); gz <= Math.floor(maxZ / G); gz++) {
        const k = gx * 10007 + gz;
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(obj);
      }
  }
  queryColliders(x, z, out) {
    const G = 40;
    out.length = 0;
    const gx = Math.floor(x / G), gz = Math.floor(z / G);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const arr = this.grid.get((gx + a) * 10007 + gz + b);
        if (arr) for (const o of arr) if (!out.includes(o)) out.push(o);
      }
    return out;
  }

  makeWindowTextures() {
    const mk = (lit) => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = lit ? '#000' : '#fff';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = lit ? '#ffd890' : '#5d7088';
      g.fillRect(12, 14, 40, 34);
      if (!lit) { g.fillStyle = '#8fa6c0'; g.fillRect(12, 14, 40, 6); }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    return { base: mk(false), lit: mk(true) };
  }

  buildCity() {
    const rnd = this.rng;
    // City ground: one big canvas-textured plane with roads, sidewalks and lane markings.
    const size = CITY_HALF * 2 + 16;
    const S = 2048;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const px = (m) => ((m + size / 2) / size) * S;
    const sc = S / size;
    g.fillStyle = '#7d7f7c'; g.fillRect(0, 0, S, S);
    // blocks: sidewalk border + interior
    for (let bx = -CITY_HALF + 0; bx < CITY_HALF; bx += CITY_STEP) {
      for (let bz = -CITY_HALF + 0; bz < CITY_HALF; bz += CITY_STEP) {
        g.fillStyle = '#a9a9a4';
        g.fillRect(px(bx + CITY_ROAD_W / 2), px(bz + CITY_ROAD_W / 2), (CITY_STEP - CITY_ROAD_W) * sc, (CITY_STEP - CITY_ROAD_W) * sc);
      }
    }
    for (let k = -4; k <= 4; k++) {
      const p = k * CITY_STEP;
      g.fillStyle = '#3e3e41';
      g.fillRect(px(p - CITY_ROAD_W / 2), 0, CITY_ROAD_W * sc, S);
      g.fillRect(0, px(p - CITY_ROAD_W / 2), S, CITY_ROAD_W * sc);
    }
    g.strokeStyle = '#f2c230'; g.lineWidth = 0.4 * sc; g.setLineDash([3 * sc, 3 * sc]);
    for (let k = -4; k <= 4; k++) {
      const p = k * CITY_STEP;
      for (let s = -4; s < 4; s++) {
        const a = s * CITY_STEP + CITY_ROAD_W / 2, b = (s + 1) * CITY_STEP - CITY_ROAD_W / 2;
        g.beginPath(); g.moveTo(px(p), px(a)); g.lineTo(px(p), px(b)); g.stroke();
        g.beginPath(); g.moveTo(px(a), px(p)); g.lineTo(px(b), px(p)); g.stroke();
      }
    }
    // crosswalks
    g.setLineDash([]); g.fillStyle = '#e8e8e8';
    for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) {
      const x = a * CITY_STEP, z = b * CITY_STEP;
      for (let s = -5; s <= 5; s += 1.5) {
        g.fillRect(px(x + s - 0.4), px(z - CITY_ROAD_W / 2 - 3), 0.8 * sc, 2.4 * sc);
        g.fillRect(px(x + s - 0.4), px(z + CITY_ROAD_W / 2 + 0.6), 0.8 * sc, 2.4 * sc);
        g.fillRect(px(x - CITY_ROAD_W / 2 - 3), px(z + s - 0.4), 2.4 * sc, 0.8 * sc);
        g.fillRect(px(x + CITY_ROAD_W / 2 + 0.6), px(z + s - 0.4), 2.4 * sc, 0.8 * sc);
      }
    }
    const blocks = [];
    for (let a = -4; a < 4; a++) for (let b = -4; b < 4; b++) {
      blocks.push({ x0: a * CITY_STEP + CITY_ROAD_W / 2 + 3, x1: (a + 1) * CITY_STEP - CITY_ROAD_W / 2 - 3, z0: b * CITY_STEP + CITY_ROAD_W / 2 + 3, z1: (b + 1) * CITY_STEP - CITY_ROAD_W / 2 - 3, a, b });
    }
    // Park blocks & plaza blocks drawn on the ground
    this.cityBlocks = blocks;
    for (const bl of blocks) {
      const r = rnd();
      bl.kind = r < 0.12 ? 'park' : r < 0.2 ? 'lot' : 'buildings';
      if ((bl.a === 0 && bl.b === -1) || (bl.a === -1 && bl.b === 0)) bl.kind = 'park';
      if (bl.a === 0 && bl.b === 0) bl.kind = 'lot'; // spawn / home garage block
      if (bl.kind === 'park') {
        g.fillStyle = '#5a8a3c';
        g.fillRect(px(bl.x0), px(bl.z0), (bl.x1 - bl.x0) * sc, (bl.z1 - bl.z0) * sc);
        g.fillStyle = '#c9b48a';
        g.fillRect(px((bl.x0 + bl.x1) / 2 - 2), px(bl.z0), 4 * sc, (bl.z1 - bl.z0) * sc);
      } else if (bl.kind === 'lot') {
        g.fillStyle = '#56565a';
        g.fillRect(px(bl.x0), px(bl.z0), (bl.x1 - bl.x0) * sc, (bl.z1 - bl.z0) * sc);
        g.fillStyle = '#ddd';
        for (let x = bl.x0 + 3; x < bl.x1 - 3; x += 3) {
          g.fillRect(px(x), px(bl.z0 + 2), 0.2 * sc, 5 * sc);
          g.fillRect(px(x), px(bl.z1 - 7), 0.2 * sc, 5 * sc);
        }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 2.05;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Buildings via one InstancedMesh with a window shader that scales UVs by instance size.
    const tx = this.makeWindowTextures();
    const mat = new THREE.MeshLambertMaterial({ map: tx.base, emissiveMap: tx.lit, emissive: new THREE.Color(1, 0.85, 0.55), emissiveIntensity: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_INSTANCING
          vec3 sc3 = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vec2 rep = abs(normal.x) > 0.5 ? vec2(sc3.z, sc3.y) : (abs(normal.z) > 0.5 ? vec2(sc3.x, sc3.y) : vec2(0.0));
          vec2 wuv = uv * rep / vec2(4.0, 3.6);
          vMapUv = wuv;
          vEmissiveMapUv = wuv + vec2(floor(instanceMatrix[3].x * 0.37), floor(instanceMatrix[3].z * 0.53)) * 0.0;
        #endif`);
    };
    this.buildingMat = mat;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    const specs = [];
    const palette = [0xd8d2c4, 0xb9c2c9, 0xc9a98a, 0x9aa7b4, 0xe2d9b8, 0xa58f7d, 0x8e9aa0, 0xd0c0d0, 0xbfb09b];
    for (const bl of blocks) {
      if (bl.kind !== 'buildings') continue;
      const cx = (bl.x0 + bl.x1) / 2, cz = (bl.z0 + bl.z1) / 2;
      const distC = Math.hypot(cx, cz);
      const tall = 1 - smoothstep(0, 330, distC);
      const split = rnd() < 0.5 ? 1 : 2;
      const splitZ = rnd() < 0.6 ? 2 : 1;
      const w = (bl.x1 - bl.x0) / split, d = (bl.z1 - bl.z0) / splitZ;
      for (let a = 0; a < split; a++) for (let b = 0; b < splitZ; b++) {
        const inset = 1 + rnd() * 3;
        const x0 = bl.x0 + a * w + inset, x1 = bl.x0 + (a + 1) * w - inset;
        const z0 = bl.z0 + b * d + inset, z1 = bl.z0 + (b + 1) * d - inset;
        const h = 8 + rnd() * 18 + tall * tall * (40 + rnd() * 90);
        specs.push({ x0, x1, z0, z1, h, color: palette[Math.floor(rnd() * palette.length)] });
      }
    }
    const im = new THREE.InstancedMesh(boxGeo, mat, specs.length + 40);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    let count = 0;
    const roofGeo = [];
    for (const s of specs) {
      m4.makeScale(s.x1 - s.x0, s.h, s.z1 - s.z0).setPosition((s.x0 + s.x1) / 2, 2, (s.z0 + s.z1) / 2);
      im.setMatrixAt(count, m4);
      im.setColorAt(count, col.setHex(s.color));
      count++;
      this.addBox(s.x0, s.x1, s.z0, s.z1, 2 + s.h, { building: true });
    }
    // Gas station / garage buildings are added later by Activities via addStructure().
    im.count = count;
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    this.scene.add(im);
    this.buildings = im;

    // Street lamps along city roads
    const lampPole = new THREE.CylinderGeometry(0.12, 0.15, 7, 6); lampPole.translate(0, 3.5, 0);
    const lampHead = new THREE.BoxGeometry(1.4, 0.25, 0.5); lampHead.translate(0.5, 7, 0);
    const lamps = [];
    for (let k = -4; k <= 4; k++) for (let s = -4; s < 4; s++) {
      for (const along of [0.3, 0.7]) {
        const p = k * CITY_STEP, q = (s + along) * CITY_STEP;
        lamps.push([p + CITY_ROAD_W / 2 + 1, q, Math.PI]);
        lamps.push([q, p - CITY_ROAD_W / 2 - 1, -Math.PI / 2]);
      }
    }
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x444a50 });
    const headMat = new THREE.MeshLambertMaterial({ color: 0x333333, emissive: 0xfff0c0, emissiveIntensity: 0 });
    this.nightMats.push(headMat);
    const poles = new THREE.InstancedMesh(lampPole, poleMat, lamps.length);
    const heads = new THREE.InstancedMesh(lampHead, headMat, lamps.length);
    const q = new THREE.Quaternion();
    lamps.forEach((l, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l[2]);
      m4.compose(new THREE.Vector3(l[0], 2, l[1]), q, new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, m4); heads.setMatrixAt(i, m4);
      this.addCircle(l[0], l[1], 0.25, 9);
      this.lampPositions.push(new THREE.Vector3(l[0], 9, l[1]));
    });
    poles.castShadow = true;
    this.scene.add(poles, heads);
  }

  // Add a simple structure (garage, gas station...) with a collider; returns the group.
  addStructure(x, z, w, d, h, color, yaw = 0, label = null) {
    const y = this.terrainHeight(x, z);
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    body.position.y = h / 2;
    body.castShadow = body.receiveShadow = true;
    grp.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.6, d + 1), new THREE.MeshLambertMaterial({ color: 0x333333 }));
    roof.position.y = h + 0.3;
    grp.add(roof);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, h * 0.6), new THREE.MeshLambertMaterial({ color: 0x777777 }));
    door.position.set(0, h * 0.3, d / 2 + 0.02);
    grp.add(door);
    if (label) {
      const c = document.createElement('canvas'); c.width = 256; c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#222'; g.fillRect(0, 0, 256, 64);
      g.fillStyle = '#ffcc33'; g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 128, 34);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.8, w * 0.2), new THREE.MeshBasicMaterial({ map: t }));
      sign.position.set(0, h * 0.8, d / 2 + 0.05);
      grp.add(sign);
    }
    grp.position.set(x, y, z);
    grp.rotation.y = yaw;
    this.scene.add(grp);
    // axis aligned collider approximating the rotated box
    const cs = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
    const hx = (w * cs + d * sn) / 2, hz = (w * sn + d * cs) / 2;
    this.addBox(x - hx, x + hx, z - hz, z + hz, y + h);
    return grp;
  }

  buildWater() {
    const geo = new THREE.CircleGeometry(LAKE.r + 120, 64);
    geo.rotateX(-Math.PI / 2);
    this.waterMat = new THREE.MeshPhongMaterial({ color: 0x2a6f9a, transparent: true, opacity: 0.78, shininess: 90, specular: 0x88aacc });
    const water = new THREE.Mesh(geo, this.waterMat);
    water.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
    this.scene.add(water);
    this.water = water;
  }

  buildRamps() {
    const defs = [
      // stunt park east of the city
      { x: 470, z: 180, yaw: Math.PI / 2, w: 8, len: 14, h: 4, kind: 'kicker' },
      { x: 520, z: 220, yaw: Math.PI / 2, w: 10, len: 40, h: 6, kind: 'table' },
      { x: 470, z: 260, yaw: -Math.PI / 2, w: 8, len: 18, h: 6, kind: 'kicker' },
      { x: 560, z: 140, yaw: 0, w: 8, len: 22, h: 8, kind: 'kicker' },
      { x: 600, z: 260, yaw: Math.PI, w: 12, len: 50, h: 9, kind: 'table' },
      { x: 430, z: 120, yaw: Math.PI / 4, w: 6, len: 10, h: 2.5, kind: 'kicker' },
      // city
      { x: 0, z: -110, yaw: Math.PI, w: 7, len: 12, h: 2.5, kind: 'kicker' },
      { x: -150, z: 40, yaw: Math.PI / 2, w: 7, len: 12, h: 2.5, kind: 'kicker' },
      { x: 225, z: 190, yaw: 0, w: 7, len: 30, h: 3, kind: 'table' },
      // countryside
      { x: -200, z: 520, yaw: 0.3, w: 10, len: 25, h: 7, kind: 'kicker' },
      { x: 150, z: 600, yaw: -0.2, w: 10, len: 60, h: 8, kind: 'table' },
      { x: -620, z: -120, yaw: 1.2, w: 9, len: 20, h: 6, kind: 'kicker' },
      { x: 780, z: -500, yaw: 2.2, w: 10, len: 26, h: 9, kind: 'kicker' },
      { x: 30, z: -880, yaw: 0.6, w: 10, len: 30, h: 10, kind: 'kicker' },
      // airfield end: big launch
      { x: 640, z: 520, yaw: Math.PI / 2, w: 14, len: 36, h: 12, kind: 'kicker' },
    ];
    const mat = new THREE.MeshLambertMaterial({ color: 0xd8b03a });
    const stripe = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
    for (const d of defs) {
      const L = d.len, H = d.h;
      let profile, shapePts;
      if (d.kind === 'kicker') {
        profile = (lz) => (lz < -L / 2 || lz > L / 2 ? 0 : H * Math.pow((lz + L / 2) / L, 1.25));
        shapePts = [];
        for (let i = 0; i <= 12; i++) {
          const lz = -L / 2 + (i / 12) * L;
          shapePts.push([lz, profile(lz)]);
        }
        shapePts.push([L / 2, 0]);
      } else {
        const up = L * 0.3, top = L * 0.4;
        profile = (lz) => {
          const t = lz + L / 2;
          if (t < 0 || t > L) return 0;
          if (t < up) return (H * t) / up;
          if (t < up + top) return H;
          return H * (1 - (t - up - top) / up);
        };
        shapePts = [[-L / 2, 0], [-L / 2 + up, H], [-L / 2 + up + top, H], [L / 2, 0]];
      }
      // Ramp base sits at the lowest terrain point under it
      let base = Infinity;
      const cs = Math.cos(d.yaw), sn = Math.sin(d.yaw);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const lx = (a * d.w) / 2, lz = (b * L) / 2;
        const wx = d.x + lx * cs + lz * sn, wz = d.z - lx * sn + lz * cs;
        base = Math.min(base, this.terrainHeight(wx, wz));
      }
      const shape = new THREE.Shape();
      shape.moveTo(shapePts[0][0], -0.5);
      for (const p of shapePts) shape.lineTo(p[0], p[1]);
      shape.lineTo(L / 2, -0.5);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: d.w, bevelEnabled: false });
      geo.translate(0, 0, -d.w / 2);
      geo.rotateY(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(d.x, base, d.z);
      mesh.rotation.y = d.yaw;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
      // chevron stripes on the side
      const sideGeo = new THREE.BoxGeometry(0.15, 0.4, L * 0.9);
      for (const s of [-1, 1]) {
        const sm = new THREE.Mesh(sideGeo, stripe);
        sm.position.set((s * d.w) / 2, 0.3, 0);
        mesh.add(sm);
      }
      // physics: local frame where lz is along ramp direction (forward = sin/cos yaw)
      this.ramps.push({
        x: d.x, z: d.z, y: base, w: d.w, len: L, h: H, profile, yaw: d.yaw,
        // lx = dx*cos - dz*sin ; lz = dx*sin + dz*cos
        cos: cs, sin: sn, bound2: (L / 2 + d.w) ** 2,
      });
    }
  }

  buildVegetation() {
    const rnd = mulberry32(4242);
    const pines = [], rounds = [], cacti = [], rocks = [];
    const tryPlace = (x, z) => {
      if (Math.abs(x) > 1080 || Math.abs(z) > 1080) return null;
      if (Math.abs(x) < CITY_HALF + 20 && Math.abs(z) < CITY_HALF + 20) return null;
      const i = Math.round((x + WORLD_HALF) / CELL), j = Math.round((z + WORLD_HALF) / CELL);
      const id = j * N + i;
      if (this.blend[id] < 0.95) return null;
      const s = this.surf[id];
      if (s === SURF.WATER || s === SURF.ASPHALT || s === SURF.DIRT) return null;
      for (const r of this.ramps) if (Math.hypot(x - r.x, z - r.z) < r.len) return null;
      if (Math.hypot(x - 520, z - 200) < 140) return null; // stunt park
      if (x > 260 && x < 680 && Math.abs(z - 520) < 40) return null; // airfield
      return { s, h: this.H[id] };
    };
    for (let k = 0; k < 9000; k++) {
      const x = (rnd() * 2 - 1) * 1100, z = (rnd() * 2 - 1) * 1100;
      const p = tryPlace(x, z);
      if (!p) continue;
      const b = biomeWeights(x, z);
      const density = b.w * 0.95 + b.n * 0.35 + b.s * 0.12 + 0.06;
      if (rnd() > density) continue;
      const sc = 0.7 + rnd() * 0.8;
      if (p.s === SURF.SAND && b.e > 0.5) { if (rnd() < 0.25) cacti.push([x, p.h, z, sc]); }
      else if (p.s === SURF.ROCK || (p.s === SURF.SNOW && rnd() < 0.15)) rocks.push([x, p.h, z, sc * 2]);
      else if (b.n > 0.3 || (b.w > 0.5 && rnd() < 0.6)) pines.push([x, p.h, z, sc]);
      else rounds.push([x, p.h, z, sc]);
    }
    // city park trees
    for (const bl of this.cityBlocks) {
      if (bl.kind !== 'park') continue;
      for (let k = 0; k < 14; k++) {
        const x = lerp(bl.x0 + 4, bl.x1 - 4, rnd()), z = lerp(bl.z0 + 4, bl.z1 - 4, rnd());
        if (Math.abs(x - (bl.x0 + bl.x1) / 2) < 4) continue;
        rounds.push([x, 2, z, 0.8 + rnd() * 0.4]);
      }
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    const inst = (geo, mat, list, sx = 1, collR = 0.6, collH = 6) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((t, i) => {
        q.setFromAxisAngle(v.set(0, 1, 0), (t[0] * 13.7) % 6.28);
        m4.compose(v.set(t[0], t[1] - 0.2, t[2]), q, s.set(t[3] * sx, t[3], t[3] * sx));
        im.setMatrixAt(i, m4);
      });
      im.castShadow = true;
      this.scene.add(im);
      return im;
    };
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 5); trunkGeo.translate(0, 1.5, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
    const pineGeo = new THREE.ConeGeometry(2.4, 8, 7); pineGeo.translate(0, 6.5, 0);
    const pineMat = new THREE.MeshLambertMaterial({ color: 0x2f5d34 });
    this.pineMat = pineMat;
    const roundGeo = new THREE.IcosahedronGeometry(2.8, 0); roundGeo.translate(0, 5, 0);
    const roundMat = new THREE.MeshLambertMaterial({ color: 0x4f8a3a, flatShading: true });
    const cactusGeo = new THREE.CylinderGeometry(0.45, 0.5, 4.5, 7); cactusGeo.translate(0, 2.25, 0);
    const cactusMat = new THREE.MeshLambertMaterial({ color: 0x4f7f3a });
    const rockGeo = new THREE.DodecahedronGeometry(1.4, 0);
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x7a7570, flatShading: true });
    inst(trunkGeo, trunkMat, pines); inst(pineGeo, pineMat, pines);
    inst(trunkGeo, trunkMat, rounds); inst(roundGeo, roundMat, rounds);
    inst(cactusGeo, cactusMat, cacti);
    inst(rockGeo, rockMat, rocks);
    for (const t of [...pines, ...rounds]) this.addCircle(t[0], t[2], 0.5 * t[3] + 0.1, t[1] + 8, { tree: true });
    for (const t of cacti) this.addCircle(t[0], t[2], 0.5 * t[3], t[1] + 4);
    for (const t of rocks) this.addCircle(t[0], t[2], 1.1 * t[3], t[1] + 1.2 * t[3]);
    this.treeCount = pines.length + rounds.length;
  }

  buildProps() {
    // Knockable props: traffic cones, barrels, crates, hay bales.
    const rnd = mulberry32(777);
    const types = {
      cone: { geo: new THREE.ConeGeometry(0.3, 0.8, 8).translate(0, 0.4, 0), mat: new THREE.MeshLambertMaterial({ color: 0xff6a1a }), r: 0.35, mass: 4, h: 0.8 },
      barrel: { geo: new THREE.CylinderGeometry(0.45, 0.45, 1.1, 10).translate(0, 0.55, 0), mat: new THREE.MeshLambertMaterial({ color: 0x2c6fbf }), r: 0.5, mass: 25, h: 1.1 },
      crate: { geo: new THREE.BoxGeometry(1.1, 1.1, 1.1).translate(0, 0.55, 0), mat: new THREE.MeshLambertMaterial({ color: 0xa87a45 }), r: 0.6, mass: 35, h: 1.1 },
      hay: { geo: new THREE.CylinderGeometry(0.8, 0.8, 1.2, 12).rotateZ(Math.PI / 2).translate(0, 0.8, 0), mat: new THREE.MeshLambertMaterial({ color: 0xd9bf5a }), r: 0.85, mass: 60, h: 1.6 },
    };
    const add = (type, x, z) => {
      const t = types[type];
      const mesh = new THREE.Mesh(t.geo, t.mat);
      mesh.castShadow = true;
      const y = this.heightAt(x, z);
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      this.props.push({ type, mesh, home: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), spin: new THREE.Vector3(), r: t.r, mass: t.mass, h: t.h, hit: false, timer: 0 });
    };
    // Cone slaloms in the city and stunt park
    for (let i = 0; i < 12; i++) add('cone', 37 + 1.5 * (i % 2 ? 1 : -1), -20 - i * 4);
    for (let i = 0; i < 10; i++) add('cone', -225 + (i % 2 ? 2 : -2), 60 + i * 5);
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2, r = 20 + rnd() * 110;
      const x = 520 + Math.cos(a) * r, z = 200 + Math.sin(a) * r;
      add(['cone', 'barrel', 'crate'][Math.floor(rnd() * 3)], x, z);
    }
    // Barrel pyramid & crate stacks for smashing fun
    for (let i = 0; i < 4; i++) for (let j = 0; j <= i; j++) add('barrel', 495 + j * 1.1 - i * 0.55, 310 + i * 1.1);
    for (let i = 0; i < 9; i++) add('crate', 150 + (i % 3) * 1.2, -150 + Math.floor(i / 3) * 1.2);
    // Farm hay bales in the south
    for (let k = 0; k < 40; k++) {
      const x = -150 + rnd() * 400, z = 420 + rnd() * 200;
      if (this.isRoadish(x, z) || this.heightAt(x, z) < 1) continue;
      add('hay', x, z);
    }
    // Barrels along highway shoulders occasionally
    const hw = this.roads[0];
    for (let k = 0; k < hw.pts.length; k += 70) {
      const p = hw.pts[k];
      add('barrel', p.x + 10.5, p.y);
    }
  }

  buildMapImage() {
    const S = 600;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const cols = {
      [SURF.GRASS]: [86, 140, 64], [SURF.ASPHALT]: [70, 70, 74], [SURF.DIRT]: [150, 112, 70], [SURF.SAND]: [222, 198, 136],
      [SURF.SNOW]: [236, 240, 248], [SURF.ROCK]: [128, 122, 118], [SURF.WATER]: [52, 120, 170], [SURF.CONCRETE]: [160, 160, 156],
    };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const wx = -WORLD_HALF + ((x + 0.5) / S) * WORLD_HALF * 2;
      const wz = -WORLD_HALF + ((y + 0.5) / S) * WORLD_HALF * 2;
      const h = this.terrainHeight(wx, wz);
      let col = cols[this.surfaceAt(wx, wz)];
      if (h < WATER_LEVEL) col = [52, 120, 170];
      const shade = clamp(0.75 + h / 300, 0.6, 1.2);
      const o = (y * S + x) * 4;
      img.data[o] = col[0] * shade; img.data[o + 1] = col[1] * shade; img.data[o + 2] = col[2] * shade; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const toMap = (v) => ((v + WORLD_HALF) / (WORLD_HALF * 2)) * S;
    for (const road of this.roads) {
      g.strokeStyle = road.type === SURF.DIRT ? '#a5784a' : '#2c2c30';
      g.lineWidth = Math.max(2, (road.width / (WORLD_HALF * 2)) * S * 1.6);
      g.beginPath();
      road.pts.forEach((p, i) => (i ? g.lineTo(toMap(p.x), toMap(p.y)) : g.moveTo(toMap(p.x), toMap(p.y))));
      if (road.closed) g.closePath();
      g.stroke();
    }
    g.fillStyle = '#6e6e72';
    for (const b of this.boxes) {
      if (!b.building) continue;
      g.fillRect(toMap(b.minX), toMap(b.minZ), Math.max(1, toMap(b.maxX) - toMap(b.minX)), Math.max(1, toMap(b.maxZ) - toMap(b.minZ)));
    }
    this.mapCanvas = c;
    this.mapToPx = toMap;
  }

  // ------------------------------------------------------------------------------------------
  updateProps(dt) {
    for (const p of this.props) {
      if (!p.hit) continue;
      p.timer += dt;
      const m = p.mesh;
      p.vel.y -= 20 * dt;
      m.position.addScaledVector(p.vel, dt);
      m.rotation.x += p.spin.x * dt;
      m.rotation.z += p.spin.z * dt;
      const gy = this.heightAt(m.position.x, m.position.z);
      if (m.position.y < gy) {
        m.position.y = gy;
        p.vel.y = Math.abs(p.vel.y) * 0.3;
        p.vel.x *= 0.7; p.vel.z *= 0.7;
        p.spin.multiplyScalar(0.7);
      }
      if (p.timer > 25) {
        // respawn quietly
        p.hit = false; p.timer = 0;
        m.position.copy(p.home); m.rotation.set(0, 0, 0);
        p.vel.set(0, 0, 0);
      }
    }
  }

  setNight(nf) {
    this.buildingMat.emissiveIntensity = nf * 1.1;
    for (const m of this.nightMats) m.emissiveIntensity = nf * 1.5;
  }
}
