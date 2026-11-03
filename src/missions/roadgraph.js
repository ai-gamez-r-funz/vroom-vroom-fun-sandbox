// Road network graph used for GPS routes, par times and AI drivers.
// Nodes: city grid intersections, highway junction/waypoint nodes and connector ends.
// Edges: polylines of {x, z} points, stored once per direction.
import { CITY_STEP } from '../world.js';

export class RoadGraph {
  constructor(world) {
    this.world = world;
    this.nodes = [];
    const nodeAt = (x, z, kind) => {
      const n = { id: this.nodes.length, x, z, kind, edges: [] };
      this.nodes.push(n);
      return n;
    };
    const link = (a, b, pts, lane) => {
      const len = polyLen(pts);
      a.edges.push({ from: a, to: b, pts, len, lane });
      b.edges.push({ from: b, to: a, pts: [...pts].reverse(), len, lane });
    };

    // City grid
    const grid = new Map();
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) grid.set(`${i},${j}`, nodeAt(i * CITY_STEP, j * CITY_STEP, 'city'));
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
      const a = grid.get(`${i},${j}`);
      if (i < 4) link(a, grid.get(`${i + 1},${j}`), straight(a, grid.get(`${i + 1},${j}`), 6), 2.8);
      if (j < 4) link(a, grid.get(`${i},${j + 1}`), straight(a, grid.get(`${i},${j + 1}`), 6), 2.8);
    }
    this.cityNode = (i, j) => grid.get(`${i},${j}`);

    // Highway nodes: every ~120 points plus junctions where other roads meet it
    const hwRoad = world.roads[0];
    const hw = hwRoad.pts;
    const n = hw.length;
    const nearestHw = (x, z) => {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < n; k++) { const d = (hw[k].x - x) ** 2 + (hw[k].y - z) ** 2; if (d < bd) { bd = d; bi = k; } }
      return { k: bi, d: Math.sqrt(bd) };
    };
    const hwIdx = new Set();
    for (let k = 0; k < n; k += 120) hwIdx.add(k);
    const joins = [];
    for (const road of world.roads.slice(1)) {
      if (road.closed || road.runway) continue;
      const s = road.pts[0], e = road.pts[road.pts.length - 1];
      const js = nearestHw(s.x, s.y), je = nearestHw(e.x, e.y);
      joins.push({ road, js, je });
      if (js.d < 50) hwIdx.add(js.k);
      if (je.d < 50) hwIdx.add(je.k);
    }
    const sorted = [...hwIdx].sort((a, b) => a - b);
    const hwNodes = new Map();
    for (const k of sorted) hwNodes.set(k, nodeAt(hw[k].x, hw[k].y, 'highway'));
    for (let q = 0; q < sorted.length; q++) {
      const ka = sorted[q], kb = sorted[(q + 1) % sorted.length];
      const pts = [];
      for (let k = ka; ; k = (k + 1) % n) {
        pts.push({ x: hw[k].x, z: hw[k].y });
        if (k === kb) break;
      }
      link(hwNodes.get(ka), hwNodes.get(kb), thin(pts, 2), 4.5);
    }
    // Connector & side roads
    const endNode = (p, j) => {
      if (j.d < 50) return hwNodes.get(j.k);
      if (Math.max(Math.abs(p.x), Math.abs(p.y)) < 320) {
        const i = Math.round(p.x / CITY_STEP), jj = Math.round(p.y / CITY_STEP);
        const c = grid.get(`${Math.max(-4, Math.min(4, i))},${Math.max(-4, Math.min(4, jj))}`);
        if (Math.hypot(c.x - p.x, c.z - p.y) < 40) return c;
      }
      return nodeAt(p.x, p.y, 'end');
    };
    for (const { road, js, je } of joins) {
      const a = endNode(road.pts[0], js), b = endNode(road.pts[road.pts.length - 1], je);
      const pts = thin(road.pts.map((p) => ({ x: p.x, z: p.y })), 2);
      pts.unshift({ x: a.x, z: a.z });
      pts.push({ x: b.x, z: b.z });
      link(a, b, pts, road.width > 13 ? 3.5 : 2.6);
    }
    this.markMain();
  }

  // Flag nodes in the main connected network (isolated trails are excluded from spawns).
  markMain() {
    const stack = [this.nodes[0]];
    this.nodes[0].main = true;
    while (stack.length) for (const e of stack.pop().edges) if (!e.to.main) { e.to.main = true; stack.push(e.to); }
  }

  nearestNode(x, z, filter) {
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      if (filter && !filter(n)) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // Dijkstra; returns { edges, length } or null.
  path(from, to) {
    if (from === to) return { edges: [], length: 0 };
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const open = new Set([from]);
    while (open.size) {
      let u = null, ud = Infinity;
      for (const o of open) { const d = dist.get(o); if (d < ud) { ud = d; u = o; } }
      open.delete(u);
      if (u === to) break;
      for (const e of u.edges) {
        const nd = ud + e.len;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, e); open.add(e.to); }
      }
    }
    if (!prev.has(to)) return null;
    const edges = [];
    for (let v = to; v !== from; v = prev.get(v).from) edges.unshift(prev.get(v));
    return { edges, length: dist.get(to) };
  }

  // Driving distance between two arbitrary points (via nearest nodes).
  routeLength(ax, az, bx, bz) {
    const a = this.nearestNode(ax, az), b = this.nearestNode(bx, bz);
    const p = this.path(a, b);
    const direct = Math.hypot(bx - ax, bz - az);
    if (!p) return direct * 1.4;
    return Math.max(direct, p.length + Math.hypot(a.x - ax, a.z - az) + Math.hypot(b.x - bx, b.z - bz));
  }

  // GPS polyline (array of {x,z}) from a position to a target.
  gpsLine(ax, az, bx, bz) {
    const a = this.nearestNode(ax, az), b = this.nearestNode(bx, bz);
    const direct = Math.hypot(bx - ax, bz - az);
    if (direct < 120) return [{ x: ax, z: az }, { x: bx, z: bz }];
    const p = this.path(a, b);
    const line = [{ x: ax, z: az }];
    if (p) for (const e of p.edges) line.push(...e.pts);
    line.push({ x: bx, z: bz });
    return line;
  }
}

export function polyLen(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

function straight(a, b, step) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.round(len / step));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n });
  return pts;
}

function thin(pts, every) {
  const out = pts.filter((_, i) => i % every === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

// Offset a point list to the right-hand lane for the travel direction.
export function laneOffset(pts, lane) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    // right of travel (matches the car's right vector convention: (-fz, fx))
    out.push({ x: pts[i].x - tz * lane, z: pts[i].z + tx * lane });
  }
  return out;
}
