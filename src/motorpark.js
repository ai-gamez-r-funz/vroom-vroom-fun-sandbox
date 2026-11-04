// The Vroom Ring Motorpark: a flat pad outside the city with swappable track layouts
// (kerbed tarmac ribbon, tyre walls, ramps, obstacles) and the Crunch Bowl derby arena.
import * as THREE from 'three';
import { MOTORPARK, ARENA, TRACK_WIDTH, getLayout, motorparkMask } from '../shared/tracks.js';
import { mulberry32 } from './util.js';

const Y = MOTORPARK.height;

function kerbTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#38383b'; g.fillRect(0, 0, 128, 256);
  const rnd = mulberry32(5);
  for (let i = 0; i < 2000; i++) { const v = 40 + rnd() * 35; g.fillStyle = `rgba(${v},${v},${v + 3},0.6)`; g.fillRect(rnd() * 128, rnd() * 256, 1.5, 1.5); }
  // red/white kerbs on both edges
  for (let y = 0; y < 256; y += 32) {
    g.fillStyle = (y / 32) % 2 ? '#e8e8e8' : '#d22b2b';
    g.fillRect(0, y, 10, 32); g.fillRect(118, y, 10, 32);
  }
  g.fillStyle = '#f2f2f2'; g.fillRect(12, 0, 3, 256); g.fillRect(113, 0, 3, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 8, y * 8, 8, 8); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bannerTexture(text, bg = '#c81e1e') {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 128);
  g.fillStyle = '#fff'; g.font = 'italic 900 78px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Motorpark {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.scene = game.scene;
    this.layoutId = null;
    this.layoutObjs = null;
    this.kerbTex = kerbTexture();
    this.trackMat = new THREE.MeshLambertMaterial({ map: this.kerbTex, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.checkerMat = new THREE.MeshLambertMaterial({ map: checkerTexture(), polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
    this.tyreGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.3, 10).translate(0, 0.65, 0);
    this.tyreMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.buildStatic();
    this.setLayout('oval');
  }

  // ------------------------------------------------------------------ permanent scenery
  buildStatic() {
    const w = this.world;
    const standMat = new THREE.MeshLambertMaterial({ color: 0x8a9099 });
    const seatMats = [0xd22b2b, 0x2b6fd2, 0xf2c230].map((c) => new THREE.MeshLambertMaterial({ color: c }));
    // grandstands along the north edge, leaving a gap for the access road
    const zEdge = MOTORPARK.z - MOTORPARK.halfD;
    for (const [x0, x1] of [[-390, -40], [40, 390]]) {
      for (let x = x0; x < x1; x += 50) {
        const grp = new THREE.Group();
        for (let k = 0; k < 4; k++) {
          const step = new THREE.Mesh(new THREE.BoxGeometry(46, 1.6, 2.2), k % 2 ? standMat : seatMats[(x / 50 + 9) % 3 | 0]);
          step.position.set(0, 0.8 + k * 1.6, -k * 2.2);
          step.castShadow = step.receiveShadow = true;
          grp.add(step);
        }
        const back = new THREE.Mesh(new THREE.BoxGeometry(46, 8, 1), standMat);
        back.position.set(0, 4, -8.2);
        grp.add(back);
        grp.position.set(x + 23, Y, zEdge - 2);
        this.scene.add(grp);
        w.addBox(x, x + 46, zEdge - 11, zEdge - 0.5, Y + 8);
      }
    }
    // entrance arch over the access road
    const arch = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1), postMat);
      post.position.set(s * 11, 4.5, 0);
      arch.add(post);
      w.addCircle(MOTORPARK.x + s * 11, zEdge - 8, 0.8, Y + 9);
    }
    const sign = new THREE.Mesh(new THREE.BoxGeometry(24, 2.4, 0.4), [postMat, postMat, postMat, postMat, new THREE.MeshBasicMaterial({ map: bannerTexture('VROOM RING MOTORPARK') }), new THREE.MeshBasicMaterial({ map: bannerTexture('VROOM RING MOTORPARK') })]);
    sign.position.y = 9;
    arch.add(sign);
    arch.position.set(MOTORPARK.x, Y, zEdge - 8);
    this.scene.add(arch);

    // Crunch Bowl derby arena: tyre-wall ring, concrete pillars and a centre table-top
    const ring = [];
    const N = Math.round((Math.PI * 2 * ARENA.r) / 2.2);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = ARENA.x + Math.cos(a) * ARENA.r, z = ARENA.z + Math.sin(a) * ARENA.r;
      // leave the gateway to the Motorpark open (west side)
      if (Math.cos(a) < -0.97) continue;
      ring.push([x, z, i % 2]);
      w.addCircle(x, z, 0.75, Y + 1.4, { tyreWall: true });
    }
    this.addTyres(ring);
    const pillarMat = new THREE.MeshLambertMaterial({ color: 0x9a9a96 });
    for (const [dx, dz] of [[-28, -20], [28, -20], [-28, 20], [28, 20], [0, -38], [0, 38]]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 4), pillarMat);
      p.position.set(ARENA.x + dx, Y + 1.5, ARENA.z + dz);
      p.castShadow = true;
      this.scene.add(p);
      w.addBox(ARENA.x + dx - 2, ARENA.x + dx + 2, ARENA.z + dz - 2, ARENA.z + dz + 2, Y + 3);
    }
    w.addRamp({ x: ARENA.x, z: ARENA.z, yaw: Math.PI / 2, w: 10, len: 24, h: 2.6, kind: 'table' });
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(30, 4), new THREE.MeshBasicMaterial({ map: bannerTexture('CRUNCH BOWL', '#1e4fc8'), side: THREE.DoubleSide }));
    banner.position.set(ARENA.x + ARENA.r + 4, Y + 6, ARENA.z);
    banner.rotation.y = -Math.PI / 2;
    this.scene.add(banner);
  }

  addTyres(list) {
    const im = new THREE.InstancedMesh(this.tyreGeo, this.tyreMat, list.length);
    const m4 = new THREE.Matrix4();
    const red = new THREE.Color(0xd22b2b), black = new THREE.Color(0x1d1d1f), white = new THREE.Color(0xeeeeee);
    list.forEach(([x, z, k], i) => {
      m4.makeTranslation(x, Y, z);
      im.setMatrixAt(i, m4);
      im.setColorAt(i, k === 2 ? white : k ? red : black);
    });
    im.castShadow = true;
    this.scene.add(im);
    return im;
  }

  // ------------------------------------------------------------------ swappable layouts
  setLayout(id) {
    if (this.layoutId === id) return getLayout(id);
    this.clearLayout();
    const L = getLayout(id);
    this.layoutId = id;
    const w = this.world;
    const objs = { meshes: [], colliders: [], ramps: [], props: [] };
    const n = L.n;
    const half = TRACK_WIDTH / 2;
    // tarmac ribbon with kerbs
    const verts = [], uvs = [], idx = [];
    for (let k = 0; k <= n; k++) {
      const p = L.pts[k % n];
      const prev = L.pts[(k - 1 + n) % n], next = L.pts[(k + 1) % n];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      verts.push(p.x - tz * half, Y + 0.1, p.z + tx * half, p.x + tz * half, Y + 0.1, p.z - tx * half);
      const v = (k === n ? L.length : p.d) / 8;
      uvs.push(0, v, 1, v);
      if (k < n) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ribbon = new THREE.Mesh(geo, this.trackMat);
    ribbon.receiveShadow = true;
    objs.meshes.push(ribbon);
    // start/finish line + gantry
    const p0 = L.pts[0];
    const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_WIDTH, 2.5), this.checkerMat);
    line.rotation.x = -Math.PI / 2; // lies flat, spanning across the track
    const lineGrp = new THREE.Group();
    lineGrp.add(line);
    lineGrp.position.set(p0.x, Y + 0.13, p0.z);
    lineGrp.rotation.y = p0.yaw;
    objs.meshes.push(lineGrp);
    const gantry = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), postMat);
      post.position.set(s * (half + 2), 3.5, 0);
      gantry.add(post);
      const fx = Math.sin(p0.yaw), fz = Math.cos(p0.yaw);
      objs.colliders.push(w.addCircle(p0.x - fz * s * (half + 2), p0.z + fx * s * (half + 2), 0.6, Y + 7));
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(TRACK_WIDTH + 5, 1.6, 0.3), [postMat, postMat, postMat, postMat, new THREE.MeshBasicMaterial({ map: bannerTexture(L.name.toUpperCase()) }), new THREE.MeshBasicMaterial({ map: bannerTexture(L.name.toUpperCase()) })]);
    banner.position.y = 7;
    gantry.add(banner);
    gantry.position.set(p0.x, Y, p0.z);
    gantry.rotation.y = p0.yaw;
    objs.meshes.push(gantry);

    // tyre walls along both edges, skipped where the track crosses itself or near ramps
    const tyres = [];
    const off = half + 2.6;
    const clearOfTrack = (x, z, selfK) => {
      for (let j = 0; j < n; j += 2) {
        let dk = Math.abs(j - selfK); dk = Math.min(dk, n - dk);
        if (dk < 6) continue;
        const q = L.pts[j];
        if ((q.x - x) ** 2 + (q.z - z) ** 2 < (half + 2) ** 2) return false;
      }
      return true;
    };
    for (let k = 0; k < n; k++) {
      const p = L.pts[k], q = L.pts[(k + 1) % n];
      let tx = q.x - p.x, tz = q.z - p.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      for (const s of [-1, 1]) {
        for (const f of [0, 0.5]) {
          const x = p.x + tx * tl * f - tz * off * s, z = p.z + tz * tl * f + tx * off * s;
          if (motorparkMask(x, z) < 0.95) continue;
          if (!clearOfTrack(x, z, k)) continue;
          if (Math.hypot(x - p0.x, z - p0.z) < 6) continue; // gantry posts already there
          tyres.push([x, z, (k + (f ? 1 : 0)) % 4 === 0 ? 2 : (k % 2)]);
          objs.colliders.push(w.addCircle(x, z, 0.7, Y + 1.3, { tyreWall: true }));
        }
      }
    }
    objs.meshes.push(this.addTyres(tyres));
    // ramps and obstacles
    for (const r of L.ramps) objs.ramps.push(w.addRamp({ ...r }));
    for (const o of L.obstacles) {
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
      const at = (along, side) => [o.x + fx * along - fz * side, o.z + fz * along + fx * side];
      if (o.kind === 'cones') for (let i = 0; i < 7; i++) objs.props.push(w.addProp('cone', ...at(i * 6 - 18, i % 2 ? 2.8 : -2.8)));
      else if (o.kind === 'barrels') for (let i = 0; i < 5; i++) objs.props.push(w.addProp('barrel', ...at((i % 3) * 1.1, o.side * (3 + Math.floor(i / 3) * 1.1))));
      else if (o.kind === 'tires') for (let i = 0; i < 6; i++) objs.props.push(w.addProp('tires', ...at((i % 3) * 1.25 - 1.25, o.side * (2.5 + Math.floor(i / 3) * 1.25))));
    }
    for (const m of objs.meshes) if (!m.parent) this.scene.add(m);
    this.layoutObjs = objs;
    return L;
  }

  clearLayout() {
    const o = this.layoutObjs;
    if (!o) return;
    for (const m of o.meshes) { this.scene.remove(m); if (m.geometry && m.geometry !== this.tyreGeo) m.geometry.dispose(); }
    this.world.removeColliders(o.colliders);
    for (const r of o.ramps) this.world.removeRamp(r);
    for (const p of o.props) this.world.removeProp(p);
    this.layoutObjs = null;
    this.layoutId = null;
  }

  get layout() { return this.layoutId ? getLayout(this.layoutId) : null; }

  // nearest point on the active layout, for resets during races
  nearestOnTrack(x, z) {
    const L = this.layout;
    if (!L) return null;
    let best = 0, bd = Infinity;
    L.pts.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = i; } });
    return { ...L.pts[best], i: best };
  }

  drawMinimap(g, toScreen) {
    const L = this.layout;
    if (!L) return;
    g.strokeStyle = 'rgba(40,40,44,0.95)';
    g.lineWidth = 5;
    g.beginPath();
    L.pts.forEach((p, i) => { const [sx, sy] = toScreen(p.x, p.z); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
    g.closePath();
    g.stroke();
  }
}
