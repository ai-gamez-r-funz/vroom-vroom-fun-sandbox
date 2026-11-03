// Runs a mission spec stage by stage: objectives, timers, cargo/passenger condition,
// AI chase cars with the "rope" mechanic, markers and HUD.
import * as THREE from 'three';
import { AIDriver } from './ai.js';
import { clamp, formatTime, formatMoney, lerp } from '../util.js';

function makeBeam(color) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 60, 20, 1, true), mat);
  cyl.position.y = 30;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.04, 6, 32), new THREE.MeshBasicMaterial({ color, fog: false }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  grp.add(cyl, ring);
  return grp;
}

const PERSONA = {
  hurry: '⏰ In a hurry', nervous: '😰 Nervous', thrill: '🤘 Thrill-seeker', tourist: '🗺️ Tourist',
};

export class MissionRunner {
  constructor(game, spec) {
    this.game = game;
    this.spec = spec;
    this.stageIdx = -1;
    this.elapsed = 0;
    this.condition = 100; // cargo / patient condition, or passenger mood
    this.tips = 0;
    this.ais = [];
    this.beams = [];
    this.status = 'running';
    this.failReason = '';
    this.scene = game.scene;
    // the visual rope between player and chase target: 23 instanced cylinder segments
    const segGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 6, 1, true);
    segGeo.translate(0, 0.5, 0);
    segGeo.rotateX(Math.PI / 2); // segment points along +z
    this.ropeMat = new THREE.MeshBasicMaterial({ color: 0x44ff66, fog: false, transparent: true, opacity: 0.9 });
    this.rope = new THREE.InstancedMesh(segGeo, this.ropeMat, 23);
    this.rope.frustumCulled = false;
    this.rope.visible = false;
    this.rope.renderOrder = 15;
    this.ropePts = Array.from({ length: 24 }, () => new THREE.Vector3());
    this._m4 = new THREE.Matrix4();
    this._up = new THREE.Vector3(0, 1, 0);
    this.scene.add(this.rope);
    this.nextStage();
  }

  get stage() { return this.spec.stages[this.stageIdx]; }

  // ------------------------------------------------------------------ stage lifecycle
  nextStage() {
    this.cleanupStage();
    this.stageIdx++;
    if (this.stageIdx >= this.spec.stages.length) { this.succeed(); return; }
    const s = this.stage;
    const g = this.game;
    this.st = { stopT: 0, t: 0, lost: 0, bust: 0, susp: 0, engaged: false, score: 0, got: new Set(), hold: 0 };
    if (s.type === 'goto') this.addBeam(s.to.x, s.to.z, s.stop ? 0x3fff8a : 0xffd23f, s.radius);
    else if (s.type === 'collect') s.points.forEach((p, i) => this.addBeam(p.x, p.z, 0xff4fd8, s.radius || 7, i));
    else if (s.type === 'chase') {
      const ai = new AIDriver(g, s.spawn.x, s.spawn.z, s.spawn.yaw || 0, {
        vehicle: s.vehicle, paint: s.paint, mode: s.mode === 'tail' ? 'route' : 'wander', flee: s.mode === 'catch', dest: s.dest,
        skill: this.spec.difficulty, speedMul: 1.1, rnd: Math.random, nitro: s.mode === 'catch',
      });
      this.ais.push(ai);
      if (s.mode === 'tail' && s.dest) this.addBeam(s.dest.x, s.dest.z, 0x9fd4ff, 15);
    } else if (s.type === 'evade') {
      const car = g.car;
      for (let i = 0; i < s.pursuers; i++) {
        const back = 55 + i * 18;
        const side = (i - (s.pursuers - 1) / 2) * 7;
        const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
        let x = car.pos.x - fx * back - fz * side, z = car.pos.z - fz * back + fx * side;
        const n = g.graph.nearestNode(x, z);
        if (g.places.blocked(x, z)) { x = n.x; z = n.z; }
        this.ais.push(new AIDriver(g, x, z, car.yaw, { vehicle: s.vehicle, paint: s.paint, police: s.police, mode: 'pursue', skill: this.spec.difficulty, speedMul: 1.15 }));
      }
      g.audio.siren?.(!!s.police);
    } else if (s.type === 'duel') {
      const ai = new AIDriver(g, s.spawn.x, s.spawn.z, s.spawn.yaw, { vehicle: s.rival.vehicle, paint: s.rival.paint, mode: 'route', dest: s.to, skill: this.spec.difficulty, nitro: true });
      this.ais.push(ai);
      this.addBeam(s.to.x, s.to.z, 0xffd23f, 14);
      this.st.countdown = 3;
    } else if (s.type === 'stunt') {
      this.st.t = s.time;
      this.st.countdown = 3;
    }
    if (this.stageIdx > 0) g.audio.chime();
    g.ui.toast(`${this.spec.icon} ${s.text}`, 'info', 3);
  }

  addBeam(x, z, color, radius, idx) {
    const b = makeBeam(color);
    b.scale.set(radius, 1, radius);
    b.position.set(x, this.game.world.heightAt(x, z), z);
    b.userData.idx = idx;
    this.scene.add(b);
    this.beams.push(b);
  }

  cleanupStage() {
    for (const b of this.beams) this.scene.remove(b);
    this.beams = [];
    for (const a of this.ais) a.dispose();
    this.ais = [];
    this.rope.visible = false;
    this.game.audio.siren?.(false);
  }

  dispose() { this.cleanupStage(); this.scene.remove(this.rope); }

  // ------------------------------------------------------------------ events from the player's car
  onCarEvent(e) {
    const cargo = this.spec.cargo || {};
    // cargo/passengers are on board after the first (pickup) stage, or from the start for one-stage jobs
    const loaded = this.spec.stages.length === 1 || this.stageIdx >= 1;
    const frag = cargo.fragility || 1;
    if (!loaded || this.status !== 'running') { /* nothing on board yet */ }
    else if (cargo.kind === 'passenger') {
      const p = cargo.personality;
      if (e.type === 'crash') this.mood(-(e.impact - 3) * (p === 'nervous' ? 3 : 1.2));
      if (e.type === 'land') this.mood(p === 'thrill' ? 6 : p === 'nervous' ? -12 : -2);
      if (e.type === 'jump' && p === 'thrill') { this.mood(8); this.tips += Math.round(e.air * 40); }
      if (e.type === 'jump' && p === 'nervous') this.mood(-10);
      if (e.type === 'drift' && p === 'thrill') { this.mood(5); this.tips += Math.round(e.score / 20); }
    } else if (cargo.kind === 'patient' || cargo.kind === 'fragile' || cargo.kind === 'cargo') {
      if (e.type === 'crash') this.condition -= Math.max(0, e.impact - 4) * 1.5 * frag;
      if (e.type === 'land') this.condition -= Math.max(0, e.impact - 8) * 1.2 * frag;
      if (e.type === 'jump' && frag > 2) this.condition -= 4;
      this.condition = Math.max(0, this.condition);
      if (this.condition <= 0) this.fail(cargo.kind === 'patient' ? 'The patient could not take any more bumps.' : `The ${cargo.name.toLowerCase()} got destroyed!`);
    }
    // stunt stage scoring
    const s = this.stage;
    if (s && s.type === 'stunt' && !(this.st.countdown > 0)) {
      if (s.kind === 'air' && e.type === 'jump') this.st.score = Math.max(this.st.score, e.air);
      if (s.kind === 'jumpdist' && e.type === 'jump') this.st.score = Math.max(this.st.score, e.distance);
      if (s.kind === 'drift' && e.type === 'drift') this.st.score = Math.max(this.st.score, e.score);
      if (s.kind === 'smash' && e.type === 'smash') this.st.score += 1;
    }
  }

  mood(delta) {
    this.condition = clamp(this.condition + delta, 0, 100);
    if (this.condition <= 0) this.fail(`${this.spec.cargo.name} demanded to get out. Rating: ★☆☆☆☆`);
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    if (this.status !== 'running') return;
    const g = this.game, car = g.car, s = this.stage;
    this.elapsed += dt;
    const tl = this.spec.timeLimit;
    if (tl && this.elapsed > tl) { this.fail('Out of time!'); return; }
    // passenger mood drifts with driving style
    const cargo = this.spec.cargo || {};
    if (cargo.kind === 'passenger' && this.stageIdx >= 1) {
      const p = cargo.personality;
      if (p === 'nervous' && car.speed > 30) this.mood(-dt * 6);
      if (p === 'hurry' && car.speed < 3) this.mood(-dt * 3);
      if (p === 'thrill' && car.speed > 35) { this.mood(dt * 2); this.tips += dt * 8; }
      if (p === 'thrill' && car.speed < 8) this.mood(-dt * 1.5);
    }
    const t = performance.now() / 1000;
    for (const b of this.beams) b.children[0].material.opacity = 0.22 + Math.sin(t * 3) * 0.08;

    if (s.type === 'goto') this.updateGoto(dt, s);
    else if (s.type === 'collect') this.updateCollect(dt, s);
    else if (s.type === 'chase') this.updateChase(dt, s);
    else if (s.type === 'evade') this.updateEvade(dt, s);
    else if (s.type === 'duel') this.updateDuel(dt, s);
    else if (s.type === 'stunt') this.updateStunt(dt, s);
    if (this.status === 'running') this.hud();
  }

  updateGoto(dt, s) {
    const car = this.game.car;
    const d = Math.hypot(s.to.x - car.pos.x, s.to.z - car.pos.z);
    this.st.dist = d;
    if (d < s.radius + 2) {
      if (!s.stop) { this.game.audio.beep(880); this.nextStage(); return; }
      if (car.speed < 4) {
        this.st.stopT += dt;
        if (this.st.stopT >= (s.stopTime || 1)) { this.game.audio.beep(880); this.nextStage(); }
      } else this.st.stopT = 0;
    } else this.st.stopT = 0;
  }

  updateCollect(dt, s) {
    const car = this.game.car;
    let left = 0, nearest = Infinity;
    s.points.forEach((p, i) => {
      if (this.st.got.has(i)) return;
      const d = Math.hypot(p.x - car.pos.x, p.z - car.pos.z);
      if (d < (s.radius || 7) + 2) {
        this.st.got.add(i);
        this.game.audio.chime();
        const b = this.beams.find((x) => x.userData.idx === i);
        if (b) { this.scene.remove(b); this.beams.splice(this.beams.indexOf(b), 1); }
      } else { left++; nearest = Math.min(nearest, d); }
    });
    this.st.left = left;
    this.st.dist = nearest;
    if (left === 0) this.nextStage();
  }

  // The rope: distance between player and target. Rubber-banding keeps chases tense,
  // and the meters decide success (bust/arrive) or failure (lost/spotted).
  updateChase(dt, s) {
    const g = this.game, car = g.car, ai = this.ais[0];
    const d = Math.hypot(ai.car.pos.x - car.pos.x, ai.car.pos.z - car.pos.z);
    this.st.dist = d;
    const R = s.rope;
    if (!this.st.engaged) {
      this.st.t += dt;
      if (d < R.max * 0.7) { this.st.engaged = true; g.ui.toast(s.mode === 'tail' ? 'Target acquired. Keep your distance!' : 'Target in sight — get on them!', 'info'); }
      else if (this.st.t > (s.engageTime || 45)) { this.fail('You never caught up with the target.'); return; }
    }
    let speed = s.speed;
    if (s.mode === 'catch') {
      // rope slack: target eases off when far, panics when close
      const tension = d / R.max;
      speed *= tension > 0.7 ? lerp(1, 0.55, clamp((tension - 0.7) / 0.5, 0, 1)) : d < R.tag * 2.5 ? 1.12 : 1;
      if (!this.st.engaged) speed *= 0.6;
      ai.update(dt, speed);
      const ram = ai.collidePlayer();
      if (ram > 3) { this.st.bust += ram * 0.03; g.ui.showStunt(`RAM! <b>${Math.round(ram)}</b>`); }
      if (d < R.tag) this.st.bust += dt / s.tagTime;
      else this.st.bust = Math.max(0, this.st.bust - dt * 0.08);
      if (this.st.engaged && d > R.max) this.st.lost += dt / R.grace;
      else this.st.lost = Math.max(0, this.st.lost - dt * 0.25);
      if (this.st.bust >= 1) { this.bonusNote = 'Suspect busted!'; this.nextStage(); return; }
      if (this.st.lost >= 1) { this.fail('The suspect got away — the rope snapped.'); return; }
    } else {
      // tail: target drives its own route; rope has a minimum AND a maximum length
      if (!this.st.engaged) speed *= 0.5;
      ai.update(dt, speed * (d > R.max * 0.8 ? 0.75 : 1));
      if (ai.collidePlayer() > 2) { this.fail('You bumped into the target. Busted!'); return; }
      if (this.st.engaged) {
        if (d < R.min) this.st.susp += dt / 3.5; else this.st.susp = Math.max(0, this.st.susp - dt * 0.12);
        if (d > R.max) this.st.lost += dt / R.grace; else this.st.lost = Math.max(0, this.st.lost - dt * 0.25);
      }
      if (this.st.susp >= 1) { this.fail('The target spotted you!'); return; }
      if (this.st.lost >= 1) { this.fail('You lost the target.'); return; }
      if (ai.done && d < R.max) { this.bonusNote = 'Destination found!'; this.nextStage(); return; }
    }
    this.drawRope(ai.car.pos, d, s.mode === 'tail' ? R.min : 0, R.max);
  }

  updateEvade(dt, s) {
    const g = this.game, car = g.car;
    let nearest = Infinity;
    for (const ai of this.ais) {
      const d = Math.hypot(ai.car.pos.x - car.pos.x, ai.car.pos.z - car.pos.z);
      nearest = Math.min(nearest, d);
      // pursuers stretch the rope: they get a boost when falling behind (but not enough to be unfair)
      const pull = d > s.rope.max * 0.6 ? 1.12 : 1;
      ai.update(dt, Math.min(s.speed * pull, car.stats.topSpeed * 0.97));
      ai.collidePlayer();
    }
    this.st.dist = nearest;
    if (nearest < s.rope.tag && car.speed < 5) this.st.bust += dt / s.bustTime;
    else this.st.bust = Math.max(0, this.st.bust - dt * 0.4);
    if (nearest > s.rope.max) this.st.hold += dt; else this.st.hold = Math.max(0, this.st.hold - dt * 2);
    if (this.st.bust >= 1) { this.fail('Busted! They boxed you in.'); return; }
    if (this.st.hold >= s.holdTime) { this.bonusNote = 'You got away clean!'; this.nextStage(); return; }
    const near = this.ais.reduce((a, b) => (Math.hypot(a.car.pos.x - car.pos.x, a.car.pos.z - car.pos.z) < Math.hypot(b.car.pos.x - car.pos.x, b.car.pos.z - car.pos.z) ? a : b));
    this.drawRope(near.car.pos, nearest, 0, s.rope.max, true);
  }

  updateDuel(dt, s) {
    const g = this.game, car = g.car, ai = this.ais[0];
    if (this.st.countdown > 0) {
      const before = Math.ceil(this.st.countdown);
      this.st.countdown -= dt;
      const after = Math.ceil(this.st.countdown);
      if (after !== before) g.audio.beep(after > 0 ? 440 : 880);
      g.ui.setBanner(after > 0 ? String(after) : 'GO!');
      if (this.st.countdown <= 0) setTimeout(() => g.ui.setBanner(null), 600);
      car.vel.set(0, 0, 0);
      ai.car.vel.set(0, 0, 0);
      this.frozen = this.st.countdown > 0;
      return;
    }
    this.frozen = false;
    const dp = Math.hypot(s.to.x - car.pos.x, s.to.z - car.pos.z);
    const dr = Math.hypot(s.to.x - ai.car.pos.x, s.to.z - ai.car.pos.z);
    // light rubber band so the rival stays in the race
    const ahead = dr < dp;
    ai.update(dt, s.speed * (ahead ? 0.92 : 1.08));
    ai.collidePlayer();
    this.st.dist = dp;
    this.st.rival = dr;
    if (dp < 16) { this.bonusNote = `You beat ${s.rival.name}!`; this.nextStage(); return; }
    if (dr < 14 || ai.done) { this.fail(`${s.rival.name} got there first!`); return; }
  }

  updateStunt(dt, s) {
    const g = this.game;
    if (this.st.countdown > 0) {
      this.st.countdown -= dt;
      g.ui.setBanner(this.st.countdown > 0 ? '🎬 ' + Math.ceil(this.st.countdown) : 'ACTION!');
      if (this.st.countdown <= 0) setTimeout(() => g.ui.setBanner(null), 700);
      return;
    }
    this.st.t -= dt;
    if (s.kind === 'speed') this.st.score = Math.max(this.st.score, g.car.speed * 3.6);
    if (s.kind === 'drift' && g.car.drift.active) this.st.live = g.car.drift.score; else this.st.live = 0;
    if (this.st.score >= s.target) { this.bonusNote = 'That\'s a wrap!'; this.nextStage(); return; }
    if (this.st.t <= 0) this.fail('Cut! The director wasn\'t impressed.');
  }

  drawRope(tp, d, min, max, evade = false) {
    const car = this.game.car;
    const a = car.pos, b = tp;
    const tension = clamp(d / max, 0, 1.3);
    const sag = Math.max(0, 1 - tension) * Math.min(3, d * 0.06);
    const P = this.ropePts;
    const world = this.game.world;
    for (let i = 0; i < 24; i++) {
      const k = i / 23;
      const x = lerp(a.x, b.x, k), z = lerp(a.z, b.z, k);
      const y = lerp(a.y, b.y, k) + 1.8 - Math.sin(k * Math.PI) * sag;
      P[i].set(x, Math.max(y, world.heightAt(x, z) + 0.6), z);
    }
    const thick = 1 + Math.min(2, d / 60); // thicker when far so it stays visible
    for (let i = 0; i < 23; i++) {
      const len = P[i].distanceTo(P[i + 1]);
      this._m4.lookAt(P[i + 1], P[i], this._up); // +z from P[i] toward P[i+1]
      this._m4.scale(new THREE.Vector3(thick, thick, len));
      this._m4.setPosition(P[i]);
      this.rope.setMatrixAt(i, this._m4);
    }
    this.rope.instanceMatrix.needsUpdate = true;
    const c = this.ropeMat.color;
    if (min && d < min) c.setHex(0xff4fd8);
    else if (evade) c.setRGB(lerp(1, 0.3, tension), lerp(0.2, 1, tension), 0.3); // stretch it to escape
    else c.setRGB(clamp(tension * 1.6, 0, 1), clamp(1.8 - tension * 1.6, 0, 1), 0.25);
    this.rope.visible = true;
  }

  // ------------------------------------------------------------------ results
  computeReward() {
    const sp = this.spec, car = this.game.car;
    let money = sp.reward.money;
    const notes = [];
    if (sp.bonus && sp.bonus.classes.includes(car.def.cls)) { money *= sp.bonus.mult; notes.push(`${car.def.cls} bonus ×${sp.bonus.mult}`); }
    const cargo = sp.cargo || {};
    if (cargo.kind === 'passenger' || cargo.kind === 'patient' || cargo.kind === 'fragile' || cargo.kind === 'cargo') {
      const k = 0.4 + 0.6 * (this.condition / 100);
      money *= k;
      notes.push(`${cargo.kind === 'passenger' ? 'Mood' : 'Condition'} ${Math.round(this.condition)}%`);
    }
    let medal = null;
    if (sp.par) {
      const t = this.elapsed;
      medal = t <= sp.par ? 'gold' : t <= sp.par * 1.15 ? 'silver' : 'bronze';
      money *= { gold: 1.6, silver: 1.2, bronze: 1 }[medal];
    } else if (sp.timeLimit) {
      const spare = Math.max(0, sp.timeLimit - this.elapsed);
      if (spare > 0) { money += spare * 6; notes.push(`Time bonus ${formatMoney(spare * 6)}`); }
    }
    if (this.tips > 0) { money += this.tips; notes.push(`Tips ${formatMoney(this.tips)}`); }
    const streak = this.game.missions.streak;
    if (streak >= 2) { money *= 1 + Math.min(0.5, streak * 0.05); notes.push(`Streak ×${(1 + Math.min(0.5, streak * 0.05)).toFixed(2)}`); }
    money = Math.round(money / 5) * 5;
    return { money, xp: Math.round(sp.reward.xp * (money / sp.reward.money)), notes, medal };
  }

  succeed() {
    if (this.status !== 'running') return;
    this.status = 'won';
    this.cleanupStage();
    this.game.missions.onFinish(this, true);
  }

  fail(reason) {
    if (this.status !== 'running') return;
    this.status = 'failed';
    this.failReason = reason;
    this.cleanupStage();
    this.game.missions.onFinish(this, false);
  }

  // where the GPS / arrow should point
  target() {
    const s = this.stage;
    if (!s || this.status !== 'running') return null;
    const car = this.game.car;
    if (s.type === 'goto') return { x: s.to.x, z: s.to.z };
    if (s.type === 'duel') return { x: s.to.x, z: s.to.z };
    if (s.type === 'collect') {
      let best = null, bd = Infinity;
      s.points.forEach((p, i) => { if (!this.st.got.has(i)) { const d = Math.hypot(p.x - car.pos.x, p.z - car.pos.z); if (d < bd) { bd = d; best = p; } } });
      return best;
    }
    if (s.type === 'chase') return { x: this.ais[0].car.pos.x, z: this.ais[0].car.pos.z, live: true };
    return null;
  }

  // ------------------------------------------------------------------ HUD
  hud() {
    const sp = this.spec, s = this.stage, st = this.st;
    const bar = (label, v, cls) => `<div class="mbar ${cls}"><span>${label}</span><div><i style="width:${clamp(v, 0, 1) * 100}%"></i></div></div>`;
    let body = `<div class="act-title">${sp.icon} ${sp.title}</div><div class="obj">${s.text}</div>`;
    if (sp.timeLimit) {
      const left = sp.timeLimit - this.elapsed;
      body += `<div class="act-big ${left < 10 ? 'late' : ''}">${formatTime(Math.max(0, left))}</div>`;
    } else if (sp.par) body += `<div class="act-big">${formatTime(this.elapsed)}</div>`;
    else body += `<div class="act-big small">${formatTime(this.elapsed)}</div>`;
    if (sp.par) body += `<div class="act-medals"><span class="gold">${formatTime(sp.par)}</span><span class="silver">${formatTime(sp.par * 1.15)}</span><span class="bronze">${formatTime(sp.par * 1.35)}</span></div>`;
    if (s.type === 'goto' || s.type === 'collect') {
      let line = `${Math.round(st.dist ?? 0)} m`;
      if (s.type === 'collect') line = `${s.points.length - st.left}/${s.points.length} collected · nearest ${Math.round(st.dist)} m`;
      if (s.stop && st.dist < s.radius + 2) line = st.stopT > 0 ? 'Hold still…' : '<b>Stop here</b>';
      body += `<div>${line}</div>`;
      if (s.stop && st.stopT > 0) body += bar('', st.stopT / (s.stopTime || 1), 'good');
    } else if (s.type === 'chase') {
      body += `<div>Rope: <b>${Math.round(st.dist)} m</b>${st.engaged ? '' : ' — catch up!'}</div>`;
      if (s.mode === 'catch') body += bar('BUST', st.bust, 'good') + bar('LOST', st.lost, 'bad');
      else body += `<div class="act-hint">Keep between ${Math.round(s.rope.min)} m and ${Math.round(s.rope.max)} m</div>` + bar('SPOTTED', st.susp, 'warn') + bar('LOST', st.lost, 'bad');
    } else if (s.type === 'evade') {
      body += `<div>Nearest pursuer: <b>${Math.round(st.dist)} m</b> / ${Math.round(s.rope.max)} m</div>` + bar('ESCAPE', st.hold / s.holdTime, 'good') + bar('BUSTED', st.bust, 'bad');
    } else if (s.type === 'duel') {
      body += `<div>You: <b>${Math.round(st.dist ?? 0)} m</b> · ${s.rival.name}: <b>${Math.round(st.rival ?? 0)} m</b></div>`;
      if (st.rival !== undefined) body += `<div class="${st.dist < st.rival ? 'good' : 'late'}">${st.dist < st.rival ? 'You lead!' : 'Rival leads!'}</div>`;
    } else if (s.type === 'stunt') {
      const v = s.kind === 'drift' ? Math.max(st.score, st.live || 0) : st.score;
      const fmt = s.unit === 's' ? v.toFixed(1) : Math.round(v);
      body += `<div>${st.countdown > 0 ? '' : `Best: <b>${fmt} / ${s.target} ${s.unit}</b> · ${Math.ceil(Math.max(0, st.t))}s left`}</div>` + bar('', v / s.target, 'good');
    }
    const cargo = sp.cargo || {};
    if (cargo.kind === 'passenger' && this.stageIdx >= 1) body += bar(`${PERSONA[cargo.personality] || ''} mood`, this.condition / 100, 'good') + (this.tips ? `<div class="act-hint">Tips so far ${formatMoney(this.tips)}</div>` : '');
    else if (['patient', 'fragile', 'cargo'].includes(cargo.kind) && (this.stageIdx >= 1 || this.spec.stages.length === 1)) body += bar(cargo.kind === 'patient' ? 'Patient' : cargo.name, this.condition / 100, 'good');
    body += `<div class="act-hint"><kbd>Backspace</kbd> abandon</div>`;
    this.game.ui.setActivity(body);
  }
}
