// Entry point: wires world, car, environment, activities, UI and audio into the game loop.
import * as THREE from 'three';
import { World, SURF } from './world.js';
import { Car } from './car.js';
import { Environment } from './environment.js';
import { Traffic } from './traffic.js';
import { Activities } from './activities.js';
import { RoadGraph } from './missions/roadgraph.js';
import { Places } from './missions/places.js';
import { MissionManager } from './missions/manager.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { GameState } from './state.js';
import { vehicleById, computeStats } from './vehicles.js';
import { clamp, damp, lerp, formatMoney } from './util.js';

const SPAWN = { x: 0, z: 40, yaw: Math.PI };

class Game {
  constructor() {
    this.state = new GameState();
    const canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.3, 4000);
    this.cameraMode = 0;
    this.camYawOffset = 0;
    this.shake = 0;
    this.paused = true;
    this.started = false;
    this.waypoint = null;
    this.smashCombo = { n: 0, t: 0 };

    this.input = new Input();
    this.input.bindTouch(document.getElementById('touch'));
    this.audio = new Audio();
    this.audio.setVolume(this.state.data.settings.volume);

    this.world = new World(this.scene);
    this.graph = new RoadGraph(this.world);
    this.places = new Places(this.world, this.graph);
    this.env = new Environment(this.scene, this.renderer);
    this.env.onThunder = () => setTimeout(() => this.audio.thunder(), 400 + Math.random() * 1500);
    const def = vehicleById(this.state.data.current);
    this.car = new Car(def, computeStats(def, this.state.setup), this.state.setup, this.scene);
    this.car.addHeadlights();
    this.car.place(SPAWN.x, SPAWN.z, SPAWN.yaw, this.world);
    this.traffic = new Traffic(this.scene, this.world);
    this.ui = new UI(this);
    this.activities = new Activities(this);
    this.missions = new MissionManager(this);
    this.applyQuality();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.setupMouseOrbit(canvas);
    this.camera.position.set(SPAWN.x + 10, 12, SPAWN.z + 20);
    this.clock = new THREE.Clock();
    this.lastDay = this.env.dayCount;
    this.ui.openTitle();
    document.getElementById('loading').remove();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  begin() {
    this.started = true;
    this.audio.start();
    if (!this.state.data.seenHelp) {
      this.state.data.seenHelp = true;
      this.state.save();
      setTimeout(() => this.ui.toast('Welcome! Drive into the glowing beams to start races, challenges and jobs. Press <kbd>G</kbd> for the garage, <kbd>M</kbd> for the map.', 'info', 8), 800);
    }
  }

  setPaused(p) {
    this.paused = p;
    this.input.enabled = !p;
  }

  applyQuality() {
    const q = this.state.data.settings.quality;
    const pr = Math.min(window.devicePixelRatio, q === 'high' ? 2 : q === 'medium' ? 1.25 : 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = q !== 'low';
    this.env.sun.castShadow = q !== 'low';
    const size = q === 'high' ? 2048 : 1024;
    if (this.env.sun.shadow.mapSize.x !== size) {
      this.env.sun.shadow.mapSize.set(size, size);
      if (this.env.sun.shadow.map) { this.env.sun.shadow.map.dispose(); this.env.sun.shadow.map = null; }
    }
    this.camera.far = q === 'low' ? 1500 : 4000;
    this.camera.updateProjectionMatrix();
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }

  applyVehicle(keepPos = true) {
    const def = vehicleById(this.state.data.current);
    const setup = this.state.setup;
    const stats = computeStats(def, setup);
    if (this.car.def.id !== def.id) {
      this.car.setVehicle(def, stats, setup);
      if (keepPos) this.car.place(this.car.pos.x, this.car.pos.z, this.car.yaw, this.world);
    } else {
      this.car.stats = stats;
      this.car.setup = setup;
      this.car.nitro = Math.min(this.car.nitro, stats.nitroCap);
    }
  }

  reward(money, xp, msg) {
    if (money) this.state.addMoney(money);
    const up = xp ? this.state.addXp(xp) : false;
    if (msg) this.ui.toast(`${msg} <b>+${formatMoney(money)}</b>`, 'good');
    if (money) this.audio.cash();
    if (up) {
      this.ui.toast(`<b>LEVEL UP!</b> You are now level ${this.state.level}. New cars may be available.`, 'level', 5);
      this.audio.chime();
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setupMouseOrbit(canvas) {
    let drag = false, lx = 0;
    canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; this.orbitHold = 1.5; });
    window.addEventListener('pointerup', () => (drag = false));
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.camYawOffset -= (e.clientX - lx) * 0.008;
      lx = e.clientX;
      this.orbitHold = 1.5;
    });
  }

  handleCarEvents() {
    const car = this.car, st = this.state.data.stats;
    for (const e of car.events) {
      this.activities.onCarEvent(e);
      this.missions.onCarEvent(e);
      switch (e.type) {
        case 'crash':
          this.audio.crash(e.impact);
          this.shake = Math.max(this.shake, Math.min(1, e.impact / 25));
          break;
        case 'land':
          this.audio.crash(e.impact * 0.5);
          this.shake = Math.max(this.shake, Math.min(0.6, e.impact / 40));
          break;
        case 'bump':
          this.audio.crash(Math.min(4, e.impact * 0.5));
          break;
        case 'smash': {
          st.smashed++;
          const big = e.prop === 'tree' || e.prop === 'lamp';
          this.audio.crash(big ? 9 : 4);
          if (big) this.shake = Math.max(this.shake, Math.min(0.6, (e.impact || 4) / 25 + 0.15));
          this.smashCombo.n++; this.smashCombo.t = 2.5;
          const cash = 10 * Math.min(this.smashCombo.n, 10);
          this.state.data.money += cash; st.earned += cash;
          this.ui.showStunt(`SMASH x${this.smashCombo.n} <b>+$${cash}</b>`);
          this.ui.updateTop();
          break;
        }
        case 'jump': {
          st.jumps++;
          st.bestAir = Math.max(st.bestAir, e.air);
          st.bestJump = Math.max(st.bestJump, e.distance);
          const spins = Math.floor(e.spins * 2 + 0.25) / 2;
          const cash = Math.round(e.air * 60 + spins * 300 + e.distance * 2);
          const xp = Math.round(cash / 4);
          this.state.addMoney(cash);
          this.state.addXp(xp);
          this.ui.showStunt(`${spins >= 1 ? spins + ' SPIN ' : ''}JUMP ${Math.round(e.distance)}m · ${e.air.toFixed(1)}s <b>+$${cash}</b>`);
          this.audio.cash();
          break;
        }
        case 'drift': {
          st.bestDrift = Math.max(st.bestDrift, e.score);
          const cash = Math.round(e.score / 25);
          this.state.addMoney(cash);
          this.state.addXp(Math.round(cash / 3));
          this.ui.showStunt(`DRIFT ${e.score} <b>+$${cash}</b>`);
          break;
        }
        case 'splash':
          if (Math.random() < 0.1) this.audio.splash();
          break;
        case 'drown':
          this.ui.toast('Splash! Your car was fished out of the water.', 'bad');
          this.resetCar();
          break;
      }
    }
    car.events.length = 0;
  }

  // Where the GPS arrow and minimap route should point (event > mission > waypoint).
  currentTarget() {
    return this.activities.targetPoint() || this.missions.targetPoint() || this.waypoint;
  }

  resetCar() {
    const s = this.car.lastSafe;
    this.car.place(s.pos.x, s.pos.z, s.yaw, this.world);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 1 / 30);
    const inp = this.input.poll();
    const ui = this.ui;

    // menu hotkeys
    if (this.started) {
      if (inp.pause) { if (ui.isOpen) ui.closeModal(); else ui.openPause(); }
      else if (inp.garage) { if (ui.openPanel === 'garage') ui.closeModal(); else if (!ui.isOpen) ui.openGarage(); }
      else if (inp.map) { if (ui.openPanel === 'map') ui.closeModal(); else if (!ui.isOpen) ui.openMap(); }
      else if (inp.help && !ui.isOpen) ui.openHelp();
      else if (inp.jobs) { if (ui.openPanel === 'jobs') ui.closeModal(); else if (!ui.isOpen) { ui.openModal('jobs', ''); this.missions.renderBoard(); } }
    }

    const car = this.car;
    if (!this.paused) {
      if (inp.camera) this.cameraMode = (this.cameraMode + 1) % 3;
      if (inp.reset) this.resetCar();
      if (inp.horn) this.audio.horn();
      const frozen = this.activities.frozen || this.missions.frozen;
      const ci = frozen ? { steer: 0, throttle: 0, brake: 1, handbrake: false, nitro: false } : inp;
      car.throttle = ci.throttle;
      // regional snow: the north is always snowy-ish
      const regionSnow = clamp((-car.pos.z - 450) / 250, 0, 1);
      car.update(dt, ci, this.world, this.env);
      // storm wind nudges the car
      if (this.env.cur.wind > 0.3 && car.grounded) {
        const w = (this.env.cur.wind - 0.3) * 1.6 * (0.6 + 0.4 * Math.sin(performance.now() / 900));
        car.vel.x += this.env.windDir.x * w * dt;
        car.vel.z += this.env.windDir.y * w * dt;
      }
      this.handleCarEvents();
      this.traffic.update(dt, car, this.state.data.settings.traffic);
      this.handleCarEvents();
      this.world.updateProps(dt);
      this.world.updateBreakables(dt, car.pos);
      this.activities.update(dt, car, inp);
      this.missions.update(dt, inp);
      this.gpsTimer = (this.gpsTimer || 0) - dt;
      if (this.gpsTimer <= 0) {
        this.gpsTimer = 1.2;
        const tp = this.currentTarget();
        this.gps = tp ? this.graph.gpsLine(car.pos.x, car.pos.z, tp.x, tp.z) : null;
      }
      this.env.update(dt, car.pos, this.camera, regionSnow);
      this.world.setNight(this.env.nightFactor);
      car.headlight.intensity = this.env.nightFactor > 0.3 || this.env.cur.fog > 0.004 ? 80 : 0;
      car.model.userData.lightMat.emissiveIntensity = car.headlight.intensity > 0 ? 3 : 0.4;

      // stats
      const st = this.state.data.stats;
      st.distance += car.speed * dt;
      st.topSpeed = Math.max(st.topSpeed, car.speed * 3.6);
      if (this.smashCombo.t > 0) { this.smashCombo.t -= dt; if (this.smashCombo.t <= 0) this.smashCombo.n = 0; }
      // daily property income
      if (this.env.dayCount !== this.lastDay) {
        this.lastDay = this.env.dayCount;
        const props = this.activities.list.filter((a) => a.type === 'property' && a.owned);
        const income = props.reduce((s, a) => s + a.prop.income, 0);
        if (income > 0) this.reward(income, 0, `New day! Property income from ${props.length} properties`);
      }
      this.saveTimer = (this.saveTimer || 0) + dt;
      if (this.saveTimer > 10) { this.saveTimer = 0; this.state.save(); }
      // waypoint arrival
      if (this.waypoint && Math.hypot(this.waypoint.x - car.pos.x, this.waypoint.z - car.pos.z) < 25) { this.waypoint = null; ui.toast('Waypoint reached'); }
    } else {
      this.env.update(0, car.pos, this.camera, 0);
    }

    this.updateCamera(dt, inp);
    this.audio.update(car, this.env, this.paused);
    ui.updateHud(car, this.env, this.world);
    ui.tick(dt);
    this.mmFrame = ((this.mmFrame || 0) + 1) % 2;
    if (this.mmFrame === 0) ui.drawMinimap(car, this.activities);
    this.renderer.render(this.scene, this.camera);
  }

  updateCamera(dt, inp) {
    const car = this.car, cam = this.camera;
    const sp = car.speed;
    const fwd = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    if (this.paused && !this.started) {
      // title screen orbit
      const t = performance.now() / 6000;
      cam.position.set(car.pos.x + Math.sin(t) * 9, car.pos.y + 3, car.pos.z + Math.cos(t) * 9);
      cam.lookAt(car.pos.x, car.pos.y + 1, car.pos.z);
      return;
    }
    if (this.orbitHold > 0) this.orbitHold -= dt;
    else this.camYawOffset = damp(this.camYawOffset, 0, 2.5, dt);
    if (this.cameraMode === 2) {
      // hood cam
      const up = car.up;
      const p = car.pos.clone().addScaledVector(up, car.def.body.ride + car.def.body.hgt + 0.55).addScaledVector(fwd, car.halfLen * 0.2);
      cam.position.copy(p);
      const look = p.clone().addScaledVector(fwd, inp.lookBack ? -10 : 10);
      cam.up.copy(up);
      cam.lookAt(look);
      cam.up.set(0, 1, 0);
    } else {
      const far = this.cameraMode === 1;
      const size = car.halfLen / 2.2;
      const dist = (far ? 11 : 7) * size + Math.min(sp, 60) * 0.05;
      const height = (far ? 4.2 : 2.6) * size;
      // follow the velocity direction a bit when drifting so you can see where you're going
      let yaw = car.yaw + this.camYawOffset + (inp.lookBack ? Math.PI : 0);
      if (sp > 5 && car.grounded) {
        const vyaw = Math.atan2(car.vel.x, car.vel.z);
        let d = vyaw - car.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) < 1.5) yaw += d * 0.35;
      }
      this.camYawSmooth = this.camYawSmooth === undefined ? yaw : this.camYawSmooth;
      let dy = yaw - this.camYawSmooth;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.camYawSmooth += dy * (inp.lookBack ? 1 : 1 - Math.exp(-6 * dt));
      const cy = this.camYawSmooth;
      const target = new THREE.Vector3(car.pos.x - Math.sin(cy) * dist, car.pos.y + height, car.pos.z - Math.cos(cy) * dist);
      const ground = this.world.heightAt(target.x, target.z) + 1.0;
      if (target.y < ground) target.y = ground;
      if (car.teleported) { this.camYawSmooth = yaw; target.set(car.pos.x - Math.sin(yaw) * dist, car.pos.y + height, car.pos.z - Math.cos(yaw) * dist); cam.position.copy(target); car.teleported = false; }
      cam.position.lerp(target, 1 - Math.exp(-12 * dt));
      if (cam.position.y < ground) cam.position.y = ground;
      const look = car.pos.clone().add(new THREE.Vector3(0, 1.2 * size, 0)).addScaledVector(fwd, inp.lookBack ? -3 : 3);
      cam.lookAt(look);
    }
    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.6;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    const fovT = 62 + Math.min(sp, 80) * 0.18 + (car.nitroOn ? 8 : 0);
    cam.fov = damp(cam.fov, fovT, 4, dt);
    cam.updateProjectionMatrix();
  }
}

// Let the loading screen paint before the (synchronous) world generation starts.
requestAnimationFrame(() => setTimeout(() => {
  try {
    window.game = new Game();
  } catch (err) {
    console.error(err);
    document.getElementById('loading').innerHTML = `<p>Something went wrong starting the game.</p><pre>${err.stack || err}</pre>`;
  }
}, 30));
