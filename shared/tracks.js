// Motorpark track layouts and arena geometry. Pure math (no three.js, no DOM) so the
// browser client and the multiplayer server share exactly the same tracks and checkpoints.

export const MOTORPARK = { x: 0, z: 862, halfW: 425, halfD: 98, height: 3, name: 'Vroom Ring Motorpark' };
export const ARENA = { x: 575, z: 850, r: 60, name: 'Crunch Bowl Derby Arena' };
export const TRACK_WIDTH = 14;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 0..1 flatten mask for the Motorpark pad, the derby arena and the link road between them.
export function motorparkMask(x, z) {
  const M = MOTORPARK;
  const dx = Math.abs(x - M.x) - M.halfW, dz = Math.abs(z - M.z) - M.halfD;
  const rect = Math.max(dx, dz);
  const arena = Math.hypot(x - ARENA.x, z - ARENA.z) - (ARENA.r + 12);
  const link = Math.max(Math.abs(z - ARENA.z) - 14, x < M.x + M.halfW - 20 || x > ARENA.x ? 999 : -1);
  const d = Math.min(rect, arena, link);
  return 1 - smooth(0, 30, d);
}
export function inMotorpark(x, z, margin = 0) { return motorparkMask(x, z) > 0.5 - margin; }

// Closed centreline generators in local units, scaled into the pad. Each returns [{x, z}] ~ every 4 m.
function sample(fn, n = 900) {
  const raw = [];
  for (let i = 0; i < n; i++) raw.push(fn((i / n) * Math.PI * 2));
  // resample to ~4 m spacing
  const out = [raw[0]];
  let carry = 0;
  for (let i = 1; i <= n; i++) {
    const a = raw[i - 1], b = raw[i % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let d = 4 - carry;
    while (d <= len) { out.push({ x: a.x + ((b.x - a.x) * d) / len, z: a.z + ((b.z - a.z) * d) / len }); d += 4; }
    carry = len - (d - 4);
  }
  if (Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].z - out[0].z) < 2) out.pop();
  return out;
}
const C = MOTORPARK;
const sgnPow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

// ramps/obstacles are placed at a fraction `f` (0..1) of the lap distance
export const LAYOUTS = [
  {
    id: 'oval', name: 'Speedway Oval', laps: 3, start: 0.25, desc: 'Flat-out stadium oval. Slipstream, bump, repeat.',
    gen: () => sample((t) => ({ x: C.x + 360 * sgnPow(Math.cos(t), 0.4), z: C.z + 70 * sgnPow(Math.sin(t), 0.4) })),
    ramps: [], obstacles: [],
  },
  {
    id: 'figure8', name: 'Crossover Eight', laps: 3, start: 0.1, desc: 'Figure-eight with a crossroads in the middle. Look both ways!',
    gen: () => sample((t) => ({ x: C.x + 370 * Math.sin(t), z: C.z + 155 * Math.sin(t) * Math.cos(t) })),
    ramps: [], obstacles: [{ f: 0.12, kind: 'cones', side: 0 }, { f: 0.62, kind: 'cones', side: 0 }],
  },
  {
    id: 'jumps', name: 'Jump Jungle', laps: 2, start: 0.25, desc: 'Big air on every straight. Land it straight or eat the tyre wall.',
    gen: () => sample((t) => ({ x: C.x + 350 * Math.cos(t), z: C.z + 62 * Math.sin(t) + 16 * Math.sin(3 * t) })),
    ramps: [
      { f: 0.06, len: 26, h: 5, w: 12, kind: 'table' },
      { f: 0.42, len: 20, h: 4.5, w: 12, kind: 'kicker' },
      { f: 0.56, len: 26, h: 5, w: 12, kind: 'table' },
      { f: 0.92, len: 20, h: 4.5, w: 12, kind: 'kicker' },
    ],
    obstacles: [{ f: 0.17, kind: 'tires', side: -1 }, { f: 0.68, kind: 'tires', side: 1 }],
  },
  {
    id: 'twister', name: 'Hairpin Twister', laps: 2, start: 0.25, desc: 'Tight technical lap with chicanes and cone slaloms. Handbrake heaven.',
    gen: () => sample((t) => ({ x: C.x + 330 * Math.cos(t) + 30 * Math.cos(3 * t), z: C.z + 62 * Math.sin(t) + 10 * Math.sin(4 * t) })),
    ramps: [{ f: 0.62, len: 16, h: 2.5, w: 12, kind: 'table' }],
    obstacles: [{ f: 0.2, kind: 'cones', side: 0 }, { f: 0.33, kind: 'barrels', side: 1 }, { f: 0.7, kind: 'cones', side: 0 }, { f: 0.85, kind: 'barrels', side: -1 }],
  },
  {
    id: 'serpent', name: 'Serpent Sprint', laps: 2, start: 0.85, desc: 'Long snaking loop using the whole park, with a monster kicker on the back straight.',
    gen: () => sample((t) => ({ x: C.x + 395 * Math.cos(t), z: C.z + 50 * Math.sin(t) + 30 * Math.sin(5 * t) * (Math.sin(t) > 0 ? 1 : 0.3) })),
    ramps: [{ f: 0.65, len: 30, h: 7, w: 12, kind: 'kicker' }],
    obstacles: [{ f: 0.3, kind: 'tires', side: 1 }, { f: 0.4, kind: 'cones', side: 0 }],
  },
];

const cache = new Map();
// Fully built layout: points, cumulative distances, tangent yaw, and placed ramps/obstacles.
export function getLayout(id) {
  if (cache.has(id)) return cache.get(id);
  const def = LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
  const raw = def.gen();
  const n = raw.length;
  const at = (f) => raw[Math.floor((((f % 1) + 1) % 1) * n)];
  const yawAt = (f) => { const i = Math.floor((((f % 1) + 1) % 1) * n); const a = raw[i], b = raw[(i + 1) % n]; return Math.atan2(b.x - a.x, b.z - a.z); };
  const ramps = def.ramps.map((r) => { const p = at(r.f); return { ...r, x: p.x, z: p.z, yaw: yawAt(r.f) }; });
  const obstacles = def.obstacles.map((o) => { const p = at(o.f); return { ...o, x: p.x, z: p.z, yaw: yawAt(o.f) }; });
  // rotate so the start/finish line sits on a straight
  const s0 = Math.floor((def.start || 0) * n);
  const pts = raw.slice(s0).concat(raw.slice(0, s0)).map((p) => ({ ...p }));
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    a.d = acc;
    acc += Math.hypot(b.x - a.x, b.z - a.z);
    a.yaw = Math.atan2(b.x - a.x, b.z - a.z);
  }
  // checkpoints every ~40 m for progress tracking / validation
  const cpEvery = 10;
  const checkpoints = [];
  for (let i = 0; i < n; i += cpEvery) checkpoints.push({ i, x: pts[i].x, z: pts[i].z });
  const built = { ...def, pts, length: acc, ramps, obstacles, checkpoints, n };
  cache.set(id, built);
  return built;
}

// Starting grid: two columns behind the start line, 8 m apart.
export function gridSlot(layout, slot) {
  const L = typeof layout === 'string' ? getLayout(layout) : layout;
  const p0 = L.pts[0];
  const fx = Math.sin(p0.yaw), fz = Math.cos(p0.yaw);
  const row = Math.floor(slot / 2), col = slot % 2 ? 1 : -1;
  const back = 10 + row * 8, side = col * 3.5;
  return { x: p0.x - fx * back - fz * side, z: p0.z - fz * back + fx * side, yaw: p0.yaw };
}

// Progress tracker: nearest track point searched in a forward window so shortcuts don't count.
export function makeTracker(layout) {
  const L = typeof layout === 'string' ? getLayout(layout) : layout;
  return { idx: 0, lap: 0, layout: L, wrong: 0, best: Infinity, lapStart: 0 };
}
export function updateTracker(tr, x, z, yaw = null) {
  const L = tr.layout, n = L.n;
  let best = tr.idx, bd = Infinity;
  for (let o = -4; o <= 14; o++) {
    const k = (tr.idx + o + n) % n;
    const p = L.pts[k];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  let lapped = false;
  if (Math.sqrt(bd) < TRACK_WIDTH * 1.6) {
    if (tr.idx > n - 15 && best < 15) { tr.lap++; lapped = true; }
    else if (tr.idx < 15 && best > n - 15) tr.lap--;
    tr.idx = best;
  }
  if (yaw !== null) {
    let dy = yaw - L.pts[tr.idx].yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    tr.wrong = Math.abs(dy) > 2.2 ? tr.wrong + 1 : 0;
  }
  return lapped;
}
export const trackerProgress = (tr) => tr.lap * tr.layout.n + tr.idx;
