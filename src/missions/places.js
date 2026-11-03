// Named places the Mission Forge can send players to: landmarks, city addresses,
// roadside spots and off-road locations, all guaranteed to be reachable by car.
import { CITY_STEP, CITY_HALF, LAKE, WATER_LEVEL } from '../world.js';
import { PROPERTIES } from '../activities.js';

const AVENUES = ['Piston Ave', 'Gasket Ave', 'Clutch Ave', 'Throttle Ave', 'Main St', 'Crank Ave', 'Spark Ave', 'Axle Ave', 'Chassis Ave'];
const STREETS = ['Oak St', 'Maple St', 'Pine St', 'Elm St', 'Market St', 'Cedar St', 'Birch St', 'Ash St', 'Willow St'];

export function regionName(x, z) {
  if (Math.abs(x) < CITY_HALF + 10 && Math.abs(z) < CITY_HALF + 10) {
    if (Math.abs(x) < 120 && Math.abs(z) < 120) return 'Downtown';
    if (z < -120) return x < 0 ? 'Old Town' : 'Uptown';
    if (z > 120) return x < 0 ? 'Harbourside' : 'Southgate';
    return x < 0 ? 'Westend' : 'Eastgate';
  }
  if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 120) return 'Lake Glimmer';
  if (x > 260 && x < 700 && Math.abs(z - 520) < 80) return 'Airfield';
  if (-z > 480) return 'Frostpeak Mountains';
  if (x > 430) return 'Sunscorch Desert';
  if (-x > 430) return 'Whispering Woods';
  if (z > 430) return 'Meadowlands';
  return 'City Outskirts';
}

export const LANDMARKS = [
  { name: 'St. Piston General Hospital', tag: 'hospital', x: -150, z: -112 },
  { name: 'Mercy Clinic', tag: 'hospital', x: 225, z: 140 },
  { name: 'Police HQ', tag: 'police', x: 150, z: 112 },
  { name: 'Fire Station 9', tag: 'fire', x: -37, z: 225 },
  { name: 'Big Wheel Diner', tag: 'shop', x: 75, z: -190 },
  { name: 'Torque Tower Plaza', tag: 'shop', x: 0, z: -37 },
  { name: 'Grand Central Station', tag: 'shop', x: -262, z: 0 },
  { name: 'City Stadium', tag: 'shop', x: 262, z: -150 },
  { name: 'Stunt Park', tag: 'landmark', x: 470, z: 205 },
  { name: 'Lake Glimmer Beach', tag: 'landmark', x: -290, z: 470 },
  { name: 'Airfield Control Tower', tag: 'landmark', x: 330, z: 545 },
  { name: 'Frostbite Summit', tag: 'viewpoint', x: 0, z: -935 },
  { name: 'Dune Overlook', tag: 'viewpoint', x: 700, z: -300 },
  { name: 'Old Lumber Mill', tag: 'landmark', x: -560, z: -60 },
  { name: 'Sunny Acres Barn', tag: 'farm', x: 110, z: 450 },
];

export class Places {
  constructor(world, graph) {
    this.world = world;
    this.graph = graph;
    this.landmarks = LANDMARKS.map((l) => ({ ...l, region: regionName(l.x, l.z) }));
    // Snap out-of-town landmarks onto the nearest road so they are always reachable.
    const allRoadPts = world.roads.flatMap((r) => r.pts);
    for (const l of this.landmarks) {
      if (Math.abs(l.x) < CITY_HALF && Math.abs(l.z) < CITY_HALF) continue;
      let best = null, bd = Infinity;
      for (const p of allRoadPts) { const d = (p.x - l.x) ** 2 + (p.y - l.z) ** 2; if (d < bd) { bd = d; best = p; } }
      if (best && bd < 140 * 140) { l.x = best.x; l.z = best.y; }
    }
    for (const p of PROPERTIES) this.landmarks.push({ name: p.name, tag: 'property', x: p.x + Math.sin(p.yaw) * 11, z: p.z + Math.cos(p.yaw) * 11, region: regionName(p.x, p.z) });
    // Roadside spots outside the city: sample every road
    this.roadside = [];
    world.roads.forEach((r) => {
      for (let i = 5; i < r.pts.length - 5; i += 9) {
        const p = r.pts[i];
        if (Math.abs(p.x) < CITY_HALF + 20 && Math.abs(p.y) < CITY_HALF + 20) continue;
        this.roadside.push({ name: `${r.name}`, x: p.x, z: p.y, region: regionName(p.x, p.y), offroad: r.type === 2 });
      }
    });
  }

  byTag(tag) { return this.landmarks.filter((l) => l.tag === tag); }

  // Mid-block kerbside address in the city grid.
  cityAddress(rnd) {
    const vertical = rnd() < 0.5;
    const line = Math.floor(rnd() * 9) - 4;
    const block = Math.floor(rnd() * 8) - 4;
    const along = (block + 0.25 + rnd() * 0.5) * CITY_STEP;
    const side = rnd() < 0.5 ? -1 : 1;
    const x = vertical ? line * CITY_STEP + side * 3.5 : along;
    const z = vertical ? along : line * CITY_STEP + side * 3.5;
    const num = 10 + Math.floor(Math.abs(along + 300) * 1.7) * 2 + (side > 0 ? 1 : 0);
    const name = `${num} ${vertical ? AVENUES[line + 4] : STREETS[line + 4]}`;
    return { name, x, z, region: regionName(x, z) };
  }

  roadsideSpot(rnd, filter) {
    const list = filter ? this.roadside.filter(filter) : this.roadside;
    const p = list[Math.floor(rnd() * list.length)];
    return { ...p, name: `${p.name}, ${p.region}` };
  }

  // A drivable off-road spot in a given region (or anywhere outside the city).
  offroadSpot(rnd, region) {
    for (let tries = 0; tries < 300; tries++) {
      const x = (rnd() * 2 - 1) * 950, z = (rnd() * 2 - 1) * 950;
      if (Math.abs(x) < CITY_HALF + 40 && Math.abs(z) < CITY_HALF + 40) continue;
      const r = regionName(x, z);
      if (region && r !== region) continue;
      const h = this.world.terrainHeight(x, z);
      if (h < WATER_LEVEL + 1) continue;
      const n = this.world.normalAt(x, z);
      if (n.y < 0.9) continue;
      if (this.blocked(x, z)) continue;
      const flavour = ['clearing', 'hilltop', 'trailhead', 'campsite', 'old shed', 'lookout', 'crash site'][Math.floor(rnd() * 7)];
      return { name: `${r} ${flavour}`, x, z, region: r, offroad: true };
    }
    return this.roadsideSpot(rnd);
  }

  blocked(x, z) {
    const near = this.world.queryColliders(x, z, []);
    for (const c of near) {
      if (c.circle) { if (Math.hypot(c.x - x, c.z - z) < c.r + 4) return true; }
      else if (x > c.minX - 4 && x < c.maxX + 4 && z > c.minZ - 4 && z < c.maxZ + 4) return true;
    }
    return false;
  }

  // Pick any place with a distance from `origin` in [minD, maxD].
  pick(rnd, origin, minD, maxD, kinds = ['city', 'road', 'landmark']) {
    for (let tries = 0; tries < 120; tries++) {
      const kind = kinds[Math.floor(rnd() * kinds.length)];
      let p;
      if (kind === 'city') p = this.cityAddress(rnd);
      else if (kind === 'road') p = this.roadsideSpot(rnd);
      else if (kind === 'offroad') p = this.offroadSpot(rnd);
      else if (kind === 'landmark') p = this.landmarks[Math.floor(rnd() * this.landmarks.length)];
      else p = this.byTag(kind)[Math.floor(rnd() * this.byTag(kind).length)];
      if (!p) continue;
      const d = Math.hypot(p.x - origin.x, p.z - origin.z);
      if (d >= minD && d <= maxD) return { ...p };
    }
    // fall back to the closest-fitting landmark
    return { ...this.landmarks[Math.floor(rnd() * this.landmarks.length)] };
  }
}
