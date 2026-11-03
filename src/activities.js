// Races, challenges, delivery jobs, collectibles, speed traps and properties.
import * as THREE from 'three';
import { mulberry32, clamp, formatTime, formatMoney, wrapAngle } from './util.js';
import { CITY_HALF, LAKE, SURF } from './world.js';

const COLORS = { race: 0xffd23f, challenge: 0xff4fd8, delivery: 0x3fff8a, property: 0x3fa9ff, owned: 0x9fd4ff };

export const PROPERTIES = [
  { id: 'home', name: 'Downtown Garage', x: 40, z: 52, price: 0, income: 0, yaw: Math.PI, desc: 'Your first garage. Home sweet home.' },
  { id: 'farm', name: 'Sunny Acres Farmhouse', x: 140, z: 470, price: 25000, income: 1500, yaw: 0.4, desc: 'Countryside living with a barn full of hay bales.' },
  { id: 'lake', name: 'Lakeside Cabin', x: -270, z: 420, price: 35000, income: 2000, yaw: 2.2, desc: 'Quiet cabin by the lake. Great sunsets.' },
  { id: 'hangar', name: 'Airfield Hangar', x: 340, z: 568, price: 50000, income: 3000, yaw: 0, desc: 'Right next to the runway. Top speed heaven.' },
  { id: 'desert', name: 'Mesa Workshop', x: 610, z: 70, price: 40000, income: 2500, yaw: -1.2, desc: 'Desert garage beside the stunt park.' },
  { id: 'forest', name: 'Timber Lodge', x: -590, z: -335, price: 30000, income: 1800, yaw: 1.0, desc: 'Woodland retreat at the trailhead.' },
  { id: 'ski', name: 'Summit Chalet', x: 0, z: -905, price: 60000, income: 4000, yaw: 0, desc: 'Luxury chalet atop Frostbite Pass.' },
];

function makeMarker(color, radius = 6, height = 30) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 24, 1, true), mat);
  cyl.position.y = height / 2;
  grp.add(cyl);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.25, 6, 32), new THREE.MeshBasicMaterial({ color, fog: false }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.4;
  grp.add(ring);
  grp.userData.mat = mat;
  return grp;
}

function makeLabel(text, color = '#fff') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.strokeText(text, 256, 48);
  g.fillStyle = color;
  g.fillText(text, 256, 48);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, fog: false, transparent: true }));
  s.scale.set(20, 3.75, 1);
  s.renderOrder = 10;
  return s;
}

export class Activities {
  constructor(game) {
    this.game = game;
    const world = (this.world = game.world);
    this.scene = game.scene;
    this.list = [];
    this.current = null;
    this.prompt = null;
    this.collectibles = [];
    this.speedTraps = [];
    this.propertyObjs = {};

    const road = (name) => world.roads.find((r) => r.name === name);
    const take = (pts, step, from = 0, to = pts.length) => {
      const out = [];
      for (let i = from; i < to; i += step) out.push([pts[i].x, pts[i].y]);
      return out;
    };
    const hw = road('Ring Highway').pts;
    const rally = road('Dust Bowl Rally').pts;
    const pass = road('Frostbite Pass').pts;
    const trail = road('Timberline Trail').pts;
    const runway = road('Airfield Runway').pts;
    const south = road('South Road').pts, north = road('North Road').pts;

    // ---------------- races ----------------
    const races = [
      { id: 'city', name: 'Downtown Dash', ref: 21, start: [-225, 262], cps: [[-225, 150], [-225, -150], [-75, -150], [-75, -300], [150, -300], [150, -75], [300, -75], [300, 225], [75, 225], [75, 75]], desc: 'Tight street race through the city grid.' },
      { id: 'ring', name: 'Ring Highway GP', ref: 44, start: [hw[10].x, hw[10].y], cps: [...take(hw, 140, 140), [hw[4].x, hw[4].y]], desc: 'Flat-out lap of the ring highway.' },
      { id: 'rally', name: 'Dust Bowl Rally', ref: 21, start: [rally[4].x, rally[4].y], cps: [...take(rally, 30, 30), ...take(rally, 30, 0), [rally[2].x, rally[2].y]], desc: 'Two dirty laps in the desert. Off-road tires recommended.' },
      { id: 'pass', name: 'Frostbite Hillclimb', ref: 23, start: [pass[3].x, pass[3].y], cps: [...take(pass, 22, 22), [pass[pass.length - 1].x, pass[pass.length - 1].y]], desc: 'Climb the icy mountain pass. Watch the hairpins.' },
      { id: 'trail', name: 'Timberline Scramble', ref: 18, start: [trail[2].x, trail[2].y], cps: [...take(trail, 20, 20), [trail[trail.length - 1].x, trail[trail.length - 1].y]], desc: 'Forest dirt trail full of trees and bumps.' },
      { id: 'drag', name: 'Airfield Drag', ref: 46, start: [runway[1].x, runway[1].y], cps: [[runway[runway.length - 12].x, runway[runway.length - 12].y]], desc: 'Pure straight-line speed down the runway.' },
      { id: 'tour', name: 'Grand Tour', ref: 34, start: [0, -230], cps: [...take(north, 25, 10), ...take(hw, 70, Math.floor(hw.length * 0.76)).concat(take(hw, 70, 0, Math.floor(hw.length * 0.24))), ...take([...south].reverse(), 25, 10), [0, 150]], desc: 'Epic cross-country race: north, around the east side, and home.' },
    ];
    for (const r of races) {
      const startYaw = Math.atan2(r.cps[0][0] - r.start[0], r.cps[0][1] - r.start[1]);
      let len = 0, px = r.start[0], pz = r.start[1];
      for (const c of r.cps) { len += Math.hypot(c[0] - px, c[1] - pz); px = c[0]; pz = c[1]; }
      const gold = len / r.ref;
      this.add({ type: 'race', ...r, startYaw, length: len, medals: [gold, gold * 1.15, gold * 1.35], reward: Math.round(400 + len * 0.9), x: r.start[0], z: r.start[1] });
    }

    // ---------------- challenges ----------------
    this.add({ type: 'challenge', kind: 'air', id: 'bigair', name: 'Big Air', x: 440, z: 205, duration: 75, targets: [1.6, 2.4, 3.4], unit: 's', reward: 1500, desc: 'Longest single airtime in the stunt park. Use the ramps!' });
    this.add({ type: 'challenge', kind: 'jumpdist', id: 'megajump', name: 'Mega Ramp', x: 560, z: 520, startYaw: Math.PI / 2, duration: 45, targets: [50, 80, 115], unit: 'm', reward: 2500, desc: 'Launch off the giant airfield ramp. Distance counts.' });
    this.add({ type: 'challenge', kind: 'drift', id: 'citydrift', name: 'Downtown Drift', x: 37, z: -75, startYaw: Math.PI / 2, duration: 60, targets: [2500, 6000, 11000], unit: 'pts', reward: 2000, desc: 'Rack up drift points in 60 seconds. Use the handbrake (Space).' });
    this.add({ type: 'challenge', kind: 'drift', id: 'dunedrift', name: 'Dune Drift', x: rally[60].x, z: rally[60].y, duration: 60, targets: [3000, 7000, 12000], unit: 'pts', reward: 2200, desc: 'Slide around the desert in 60 seconds.' });
    this.add({ type: 'challenge', kind: 'smash', id: 'smash', name: 'Smash Fest', x: 510, z: 290, duration: 60, targets: [12, 22, 32], unit: 'props', reward: 1800, desc: 'Knock over as many cones, barrels and crates as possible.' });
    this.add({ type: 'challenge', kind: 'speed', id: 'topspeed', name: 'Speed Run', x: runway[3].x, z: runway[3].y, startYaw: Math.PI / 2, duration: 30, targets: [180, 230, 280], unit: 'km/h', reward: 2000, desc: 'Hit the highest top speed you can in 30 seconds.' });
    this.add({ type: 'challenge', kind: 'spins', id: 'spins', name: 'Spin Doctor', x: 590, z: 170, duration: 90, targets: [1, 2, 4], unit: 'spins', reward: 3000, desc: 'Total airborne spins (steer while in the air!).' });

    // ---------------- delivery depots ----------------
    const depots = [
      { name: 'City Depot', x: -37, z: -150 },
      { name: 'Farm Co-op', x: south[Math.floor(south.length * 0.6)].x, z: south[Math.floor(south.length * 0.6)].y },
      { name: 'Desert Mine', x: rally[150].x, z: rally[150].y },
      { name: 'Lumber Mill', x: trail[60].x, z: trail[60].y },
      { name: 'Ski Resort', x: pass[Math.floor(pass.length * 0.3)].x, z: pass[Math.floor(pass.length * 0.3)].y },
      { name: 'Harbour', x: hw[Math.floor(hw.length * 0.3)].x, z: hw[Math.floor(hw.length * 0.3)].y },
      { name: 'Airfield Cargo', x: runway[60].x, z: runway[60].y + 22 },
    ];
    this.depots = depots;
    for (const d of depots) this.add({ type: 'delivery', id: 'dep_' + d.name, name: d.name, x: d.x, z: d.z, desc: 'Pick up a delivery job. Trucks & vans earn more!' });

    // ---------------- properties ----------------
    for (const p of PROPERTIES) {
      const grp = world.addStructure(p.x, p.z, 14, 10, 6, p.id === 'home' ? 0xb34a3a : 0x8f7a63, p.yaw, p.name.split(' ')[0].toUpperCase());
      this.propertyObjs[p.id] = grp;
      // marker in front of the door
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      p.mx = p.x + fx * 11; p.mz = p.z + fz * 11;
      this.add({ type: 'property', id: 'prop_' + p.id, prop: p, name: p.name, x: p.mx, z: p.mz, desc: p.desc });
    }

    // ---------------- collectibles ----------------
    const rnd = mulberry32(2024);
    const wrenchGeo = new THREE.TorusGeometry(0.9, 0.3, 8, 16);
    const wrenchMat = new THREE.MeshStandardMaterial({ color: 0xffcc22, emissive: 0xaa7700, emissiveIntensity: 0.6, metalness: 0.9, roughness: 0.2 });
    const spots = [];
    // fun places
    for (const rp of world.ramps.filter((r) => r.len > 25)) spots.push([rp.x, rp.z]);
    spots.push([0, -905 + 20], [LAKE.x, LAKE.z - LAKE.r - 30], [700, 700], [-700, -700], [900, 900 - 50], [-900 + 50, 900 - 80]);
    while (spots.length < 40) {
      const x = (rnd() * 2 - 1) * 1000, z = (rnd() * 2 - 1) * 1000;
      if (Math.abs(x) < CITY_HALF && Math.abs(z) < CITY_HALF && rnd() < 0.6) continue;
      if (world.terrainHeight(x, z) < 1) continue;
      spots.push([x, z]);
    }
    spots.forEach(([x, z], i) => {
      const m = new THREE.Mesh(wrenchGeo, wrenchMat);
      const y = world.heightAt(x, z) + 1.6;
      m.position.set(x, y, z);
      m.castShadow = true;
      this.scene.add(m);
      const taken = game.state.data.collected.includes(i);
      m.visible = !taken;
      this.collectibles.push({ i, mesh: m, taken });
    });

    // ---------------- speed traps ----------------
    const trapIdx = [0.12, 0.37, 0.62, 0.88].map((f) => Math.floor(f * hw.length));
    trapIdx.forEach((k, i) => {
      const p = hw[k];
      const id = 'trap' + i;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 0.4), new THREE.MeshLambertMaterial({ color: 0x333333 }));
      const y = world.heightAt(p.x, p.y);
      const n = hw[(k + 1) % hw.length];
      const tx = n.x - p.x, tz = n.y - p.y, tl = Math.hypot(tx, tz);
      const ox = (-tz / tl) * 11, oz = (tx / tl) * 11;
      post.position.set(p.x + ox, y + 3, p.y + oz);
      const cam = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 0.8), new THREE.MeshLambertMaterial({ color: 0x2244aa, emissive: 0x112266 }));
      cam.position.set(0, 3.2, 0);
      post.add(cam);
      this.scene.add(post);
      this.speedTraps.push({ id, x: p.x, z: p.y, armed: true, name: `Speed Trap ${i + 1}` });
    });

    // Guidance objects: checkpoint ring + floating arrow over the car
    this.cpMesh = new THREE.Mesh(new THREE.TorusGeometry(9, 0.6, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, fog: false }));
    this.cpMesh.visible = false;
    this.cpNext = new THREE.Mesh(new THREE.TorusGeometry(9, 0.4, 6, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, fog: false }));
    this.cpNext.visible = false;
    this.scene.add(this.cpMesh, this.cpNext);
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 1.4); arrowShape.lineTo(0.9, 0); arrowShape.lineTo(0.35, 0); arrowShape.lineTo(0.35, -1); arrowShape.lineTo(-0.35, -1); arrowShape.lineTo(-0.35, 0); arrowShape.lineTo(-0.9, 0); arrowShape.lineTo(0, 1.4);
    const ag = new THREE.ExtrudeGeometry(arrowShape, { depth: 0.25, bevelEnabled: false });
    ag.rotateX(Math.PI / 2);
    this.arrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: 0xffd23f, fog: false, depthTest: false, transparent: true, opacity: 0.9 }));
    this.arrow.renderOrder = 20;
    this.arrow.visible = false;
    this.scene.add(this.arrow);
    this.refreshPropertyMarkers();
  }

  add(a) {
    const color = a.type === 'property' ? (this.game.state.data.properties.includes(a.prop.id) ? COLORS.owned : COLORS.property) : COLORS[a.type];
    const y = this.world.heightAt(a.x, a.z);
    a.marker = makeMarker(color, a.type === 'property' ? 5 : 6);
    a.marker.position.set(a.x, y, a.z);
    const icon = { race: '🏁', challenge: '★', delivery: '📦', property: '🏠' }[a.type];
    a.label = makeLabel(`${icon} ${a.name}`);
    a.label.position.set(a.x, y + 12, a.z);
    this.scene.add(a.marker, a.label);
    this.list.push(a);
  }

  refreshPropertyMarkers() {
    for (const a of this.list) {
      if (a.type !== 'property') continue;
      const owned = this.game.state.data.properties.includes(a.prop.id);
      const col = owned ? COLORS.owned : COLORS.property;
      a.marker.children.forEach((c) => c.material.color.setHex(col));
      a.owned = owned;
    }
  }

  // ------------------------------------------------------------------------------------------
  update(dt, car, input) {
    const g = this.game;
    const t = performance.now() / 1000;
    // spin collectibles & marker pulse
    for (const c of this.collectibles) {
      if (c.taken) continue;
      c.mesh.rotation.y = t * 2 + c.i;
      if (Math.abs(c.mesh.position.x - car.pos.x) < 5 && Math.abs(c.mesh.position.z - car.pos.z) < 5 && Math.abs(c.mesh.position.y - car.pos.y) < 4) {
        c.taken = true;
        c.mesh.visible = false;
        g.state.data.collected.push(c.i);
        const n = g.state.data.collected.length;
        g.reward(500, 100, `Golden Wrench ${n}/${this.collectibles.length}`);
        g.audio.chime();
        if (n === this.collectibles.length) g.reward(25000, 3000, 'ALL WRENCHES FOUND!');
      }
    }
    // speed traps (only outside events)
    for (const s of this.speedTraps) {
      const d = Math.hypot(s.x - car.pos.x, s.z - car.pos.z);
      if (d < 16 && s.armed) {
        s.armed = false;
        const kmh = Math.round(car.speed * 3.6);
        const best = g.state.data.speedTraps[s.id] || 0;
        let msg = `${s.name}: ${kmh} km/h`;
        if (kmh > best) {
          g.state.data.speedTraps[s.id] = kmh;
          const bonus = Math.max(0, Math.round((kmh - 100) * 8));
          if (bonus > 0) { g.reward(bonus, Math.round(bonus / 10), msg + ' — NEW RECORD!'); msg = null; }
        }
        if (msg) g.ui.toast(msg + ` (best ${best})`);
      } else if (d > 40) s.armed = true;
    }

    const yawToCam = g.camera.position;
    for (const a of this.list) {
      const d2 = (a.x - car.pos.x) ** 2 + (a.z - car.pos.z) ** 2;
      const near = d2 < 600 * 600;
      const hide = this.current && this.current.def !== a;
      a.marker.visible = near && !hide;
      a.label.visible = near && !hide && d2 < 250 * 250;
      if (a.marker.visible) a.marker.userData.mat.opacity = 0.22 + Math.sin(t * 3) * 0.06;
    }

    if (this.current) this.updateCurrent(dt, car, input);
    else this.updatePrompt(car, input);
    this.updateArrow(car, t);
  }

  updatePrompt(car, input) {
    let best = null, bd = Infinity;
    for (const a of this.list) {
      const d = Math.hypot(a.x - car.pos.x, a.z - car.pos.z);
      if (d < 9 && d < bd) { bd = d; best = a; }
    }
    this.prompt = best;
    const ui = this.game.ui;
    if (!best) { ui.setPrompt(null); return; }
    let text;
    if (best.type === 'race') text = `Race: <b>${best.name}</b> — ${(best.length / 1000).toFixed(1)} km · Gold ${formatTime(best.medals[0])}`;
    else if (best.type === 'challenge') text = `Challenge: <b>${best.name}</b> — ${best.desc}`;
    else if (best.type === 'delivery') text = `<b>${best.name}</b> — Start a delivery job`;
    else if (best.type === 'property') text = best.owned ? `<b>${best.name}</b> — Open garage` : `<b>${best.name}</b> — Buy for ${formatMoney(best.prop.price)} (+${formatMoney(best.prop.income)}/day)`;
    ui.setPrompt(`${text}<br><kbd>E</kbd> to ${best.type === 'property' ? (best.owned ? 'enter' : 'view') : 'start'}`);
    if (input.interact) this.activate(best);
  }

  activate(a) {
    const g = this.game;
    if (a.type === 'property') {
      if (a.owned) g.ui.openGarage();
      else g.ui.openProperty(a.prop);
      return;
    }
    g.ui.setPrompt(null);
    if (a.type === 'race') this.startRace(a);
    else if (a.type === 'challenge') this.startChallenge(a);
    else if (a.type === 'delivery') this.startDelivery(a);
  }

  buyProperty(p) {
    const g = this.game;
    if (!g.state.spend(p.price)) { g.ui.toast('Not enough money!', 'bad'); return false; }
    g.state.data.properties.push(p.id);
    g.state.changed();
    this.refreshPropertyMarkers();
    g.ui.toast(`You bought ${p.name}! Fast travel unlocked.`, 'good');
    g.audio.chime();
    return true;
  }

  // ------------------------------------------------------------------------------------------
  startRace(a) {
    const g = this.game;
    g.car.place(a.start[0], a.start[1], a.startYaw, this.world);
    this.current = { def: a, kind: 'race', cp: 0, time: 0, countdown: 3, cps: a.cps };
    g.audio.beep(440);
    this.showCheckpoint();
  }

  startChallenge(a) {
    const g = this.game;
    if (a.startYaw !== undefined) g.car.place(a.x, a.z, a.startYaw, this.world);
    this.current = { def: a, kind: a.kind, time: a.duration, score: 0, countdown: 3, start: g.car.pos.clone(), maxSpeed: 0 };
    if (a.kind === 'smash') this.world.props.forEach((p) => { if (p.hit && p.timer > 3) { p.timer = 100; } });
    g.audio.beep(440);
  }

  startDelivery(a) {
    const g = this.game;
    const options = this.depots.filter((d) => d.name !== a.name);
    const dest = options[Math.floor(Math.random() * options.length)];
    const dist = Math.hypot(dest.x - a.x, dest.z - a.z);
    const limit = Math.round(dist / 14 + 40);
    const cargo = ['Pizzas', 'Furniture', 'Fresh eggs', 'Fireworks', 'Lumber', 'Mail', 'Ice cream', 'Spare parts'][Math.floor(Math.random() * 8)];
    const pay = Math.round((300 + dist * 1.4) * g.car.stats.delivery);
    this.current = { def: a, kind: 'delivery', dest, time: limit, condition: 100, pay, cargo, countdown: 0 };
    this.cpMesh.position.set(dest.x, this.world.heightAt(dest.x, dest.z) + 5, dest.z);
    this.cpMesh.material.color.setHex(0x3fff8a);
    this.cpMesh.visible = true;
    this.cpMesh.rotation.set(0, 0, 0);
    g.ui.toast(`Deliver <b>${cargo}</b> to <b>${dest.name}</b> (${(dist / 1000).toFixed(1)} km) — pays ${formatMoney(pay)}`, 'info', 5);
    g.audio.beep(660);
  }

  showCheckpoint() {
    const c = this.current;
    const cps = c.cps;
    const p = cps[c.cp];
    const prev = c.cp === 0 ? c.def.start : cps[c.cp - 1];
    const y = this.world.heightAt(p[0], p[1]);
    this.cpMesh.position.set(p[0], y + 7, p[1]);
    this.cpMesh.rotation.set(0, Math.atan2(p[0] - prev[0], p[1] - prev[1]), 0);
    this.cpMesh.material.color.setHex(c.cp === cps.length - 1 ? 0x44ff66 : 0xffd23f);
    this.cpMesh.visible = true;
    if (c.cp + 1 < cps.length) {
      const q = cps[c.cp + 1];
      this.cpNext.position.set(q[0], this.world.heightAt(q[0], q[1]) + 7, q[1]);
      this.cpNext.rotation.set(0, Math.atan2(q[0] - p[0], q[1] - p[1]), 0);
      this.cpNext.visible = true;
    } else this.cpNext.visible = false;
  }

  get frozen() { return this.current && this.current.countdown > 0; }

  updateCurrent(dt, car, input) {
    const g = this.game, c = this.current, a = c.def;
    if (input.cancel) { this.end(false, 'Event abandoned'); return; }
    if (c.countdown > 0) {
      const before = Math.ceil(c.countdown);
      c.countdown -= dt;
      const after = Math.ceil(c.countdown);
      if (after !== before) g.audio.beep(after > 0 ? 440 : 880);
      g.ui.setBanner(after > 0 ? String(after) : 'GO!');
      if (c.countdown <= 0) setTimeout(() => g.ui.setBanner(null), 600);
      car.vel.set(0, 0, 0);
      return;
    }
    if (c.kind === 'race') {
      c.time += dt;
      const p = c.cps[c.cp];
      const rad = a.id === 'ring' || a.id === 'tour' ? 20 : 15;
      if (Math.hypot(p[0] - car.pos.x, p[1] - car.pos.z) < rad) {
        c.cp++;
        g.audio.beep(c.cp >= c.cps.length ? 990 : 720);
        if (c.cp >= c.cps.length) {
          this.finishRace();
          return;
        }
        this.showCheckpoint();
      }
      g.ui.setActivity(`<div class="act-title">🏁 ${a.name}</div><div class="act-big">${formatTime(c.time)}</div>
        <div>Checkpoint ${c.cp + 1}/${c.cps.length}</div>
        <div class="act-medals"><span class="gold">${formatTime(a.medals[0])}</span><span class="silver">${formatTime(a.medals[1])}</span><span class="bronze">${formatTime(a.medals[2])}</span></div>
        <div class="act-hint">Best: ${formatTime(g.state.data.best[a.id] ?? Infinity)} · <kbd>Backspace</kbd> quit</div>`);
    } else if (c.kind === 'delivery') {
      c.time -= dt;
      const d = Math.hypot(c.dest.x - car.pos.x, c.dest.z - car.pos.z);
      if (d < 12) {
        const pay = Math.round(c.pay * (0.3 + 0.7 * c.condition / 100) * (c.time > 0 ? 1 : 0.4));
        g.state.data.stats.deliveries++;
        this.end(true, null);
        g.reward(pay, Math.round(pay / 8), `Delivered ${c.cargo}! Condition ${Math.round(c.condition)}%`);
        return;
      }
      g.ui.setActivity(`<div class="act-title">📦 ${c.cargo} → ${c.dest.name}</div><div class="act-big ${c.time < 0 ? 'late' : ''}">${formatTime(Math.max(0, c.time))}</div>
        <div>${Math.round(d)} m to go · Cargo ${Math.round(c.condition)}%</div><div>Pay ${formatMoney(c.pay)}${c.time < 0 ? ' (late!)' : ''}</div><div class="act-hint"><kbd>Backspace</kbd> abandon</div>`);
    } else {
      // challenges
      c.time -= dt;
      let val = c.score;
      if (c.kind === 'speed') { c.maxSpeed = Math.max(c.maxSpeed, car.speed * 3.6); val = c.score = Math.round(c.maxSpeed); }
      if (c.kind === 'drift' && car.drift.active) val = c.score + Math.round(car.drift.score);
      const fmt = (v) => (a.unit === 's' ? v.toFixed(2) + ' s' : a.unit === 'm' ? Math.round(v) + ' m' : a.unit === 'spins' ? v.toFixed(1) : Math.round(v) + ' ' + a.unit);
      const medal = val >= a.targets[2] ? 'gold' : val >= a.targets[1] ? 'silver' : val >= a.targets[0] ? 'bronze' : '';
      g.ui.setActivity(`<div class="act-title">★ ${a.name}</div><div class="act-big">${fmt(val)}</div><div>${formatTime(Math.max(0, c.time))} left</div>
        <div class="act-medals"><span class="bronze">${fmt(a.targets[0])}</span><span class="silver">${fmt(a.targets[1])}</span><span class="gold">${fmt(a.targets[2])}</span></div>
        <div class="act-hint">${medal ? 'Current: ' + medal.toUpperCase() : a.desc}</div>`);
      if (c.time <= 0) {
        if (c.kind === 'drift' && car.drift.active) c.score += Math.round(car.drift.score);
        this.finishChallenge();
      }
    }
  }

  // events coming from the car's physics
  onCarEvent(e) {
    const c = this.current;
    if (!c || c.countdown > 0) return;
    if (c.kind === 'delivery' && (e.type === 'crash' || e.type === 'land')) {
      c.condition = Math.max(0, c.condition - (e.impact - 4) * 1.6);
    }
    if (c.kind === 'air' && e.type === 'jump') c.score = Math.max(c.score, e.air);
    if (c.kind === 'jumpdist' && e.type === 'jump') c.score = Math.max(c.score, e.distance || 0);
    if (c.kind === 'spins' && e.type === 'jump') c.score += Math.floor(e.spins * 2 + 0.25) / 2;
    if (c.kind === 'drift' && e.type === 'drift') c.score += e.score;
    if (c.kind === 'smash' && e.type === 'smash') c.score += 1;
  }

  finishRace() {
    const g = this.game, c = this.current, a = c.def;
    const t = c.time;
    const medal = t <= a.medals[0] ? 0 : t <= a.medals[1] ? 1 : t <= a.medals[2] ? 2 : 3;
    const names = ['GOLD', 'SILVER', 'BRONZE', 'FINISHED'];
    const mult = [1.6, 1.25, 1.0, 0.4][medal];
    const prevBest = g.state.data.best[a.id];
    const record = prevBest === undefined || t < prevBest;
    if (record) g.state.data.best[a.id] = t;
    const firstMedal = medal < 3 && (g.state.data.medals[a.id] === undefined || medal < g.state.data.medals[a.id]);
    if (firstMedal) g.state.data.medals[a.id] = medal;
    const money = Math.round(a.reward * mult * (firstMedal ? 1.5 : 1));
    this.end(true, null);
    g.reward(money, Math.round(money / 6), null);
    g.ui.showResult(`${names[medal]}`, `${a.name}<br>Time <b>${formatTime(t)}</b>${record ? ' — <span class="good">NEW BEST!</span>' : ` (best ${formatTime(prevBest)})`}<br>Reward ${formatMoney(money)}`, ['gold', 'silver', 'bronze', ''][medal]);
  }

  finishChallenge() {
    const g = this.game, c = this.current, a = c.def;
    const v = c.score;
    const medal = v >= a.targets[2] ? 0 : v >= a.targets[1] ? 1 : v >= a.targets[0] ? 2 : 3;
    const names = ['GOLD', 'SILVER', 'BRONZE', 'TRY AGAIN'];
    const mult = [2, 1.4, 1, 0.15][medal];
    const firstMedal = medal < 3 && (g.state.data.medals[a.id] === undefined || medal < g.state.data.medals[a.id]);
    if (firstMedal) g.state.data.medals[a.id] = medal;
    if (g.state.data.best[a.id] === undefined || v > g.state.data.best[a.id]) g.state.data.best[a.id] = v;
    const money = Math.round(a.reward * mult * (firstMedal ? 1.5 : 1));
    this.end(true, null);
    g.reward(money, Math.round(money / 6), null);
    const shown = a.unit === 's' ? v.toFixed(2) + ' s' : `${Math.round(v * 10) / 10} ${a.unit}`;
    g.ui.showResult(names[medal], `${a.name}<br>Score <b>${shown}</b><br>Reward ${formatMoney(money)}`, ['gold', 'silver', 'bronze', ''][medal]);
  }

  end(ok, msg) {
    this.current = null;
    this.cpMesh.visible = false;
    this.cpNext.visible = false;
    this.game.ui.setActivity(null);
    this.game.ui.setBanner(null);
    if (msg) this.game.ui.toast(msg, ok ? 'good' : 'bad');
  }

  targetPoint() {
    const c = this.current;
    if (!c) return null;
    if (c.kind === 'race') { const p = c.cps[c.cp]; return { x: p[0], z: p[1] }; }
    if (c.kind === 'delivery') return { x: c.dest.x, z: c.dest.z };
    return null;
  }

  updateArrow(car, t) {
    const tp = this.targetPoint();
    if (!tp || this.game.cameraMode === 2) { this.arrow.visible = false; return; }
    this.arrow.visible = true;
    this.arrow.position.set(car.pos.x, car.pos.y + 3.6 + Math.sin(t * 4) * 0.1, car.pos.z);
    const ang = Math.atan2(tp.x - car.pos.x, tp.z - car.pos.z);
    this.arrow.rotation.set(0, ang, 0);
  }
}
