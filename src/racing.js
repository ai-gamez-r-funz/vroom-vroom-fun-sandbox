// Motorpark circuit races against AI opponents, and single-player demolition derby in the arena.
import { AIDriver } from './missions/ai.js';
import { bumpCars } from './car.js';
import { VEHICLES, computeStats } from './vehicles.js';
import { LAYOUTS, getLayout, gridSlot, makeTracker, updateTracker, trackerProgress, ARENA, TRACK_WIDTH } from '../shared/tracks.js';
import { formatTime, formatMoney, clamp } from './util.js';
import { laneOffset } from './missions/roadgraph.js';

const DIFFS = {
  rookie: { name: 'Rookie', speed: 0.86, reward: 0.8 },
  pro: { name: 'Pro', speed: 0.97, reward: 1.2 },
  legend: { name: 'Legend', speed: 1.06, reward: 1.8 },
};
const RIVALS = ['Vinnie Valvez', 'Kat Kerbs', 'Duke Dustcloud', 'Bubbles McGee', 'Nitro Nan', 'Captain Clutch', 'Sally Slipstream', 'Torque Tom'];
const COLORS = ['#ff4fa3', '#1fb5c9', '#f2b705', '#8a2be2', '#22c46e', '#ff7f11', '#ffffff', '#111111'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Racing {
  constructor(game) {
    this.game = game;
    this.cur = null; // active race or derby
    this.cfg = { layout: 'oval', opponents: 5, difficulty: 'pro', laps: 0 };
    this.derbyCfg = { opponents: 5, difficulty: 'pro' };
  }

  get active() { return !!this.cur; }
  get frozen() { return !!(this.cur && this.cur.countdown > 0); }

  // ------------------------------------------------------------------ setup screens
  openSetup() {
    const g = this.game;
    g.ui.openModal('racesetup', '');
    this.renderSetup();
  }

  renderSetup() {
    const g = this.game, c = this.cfg, best = g.state.data.best;
    const panel = g.ui.modal.querySelector('.panel');
    const L = getLayout(c.layout);
    panel.innerHTML = `<div class="garage-head"><h2>🏁 Vroom Ring Motorpark</h2><button data-act="close">✕</button></div>
      <p class="muted">Pick a layout and race the AI. Laps, rivals and difficulty change the payout.</p>
      <div class="cards">${LAYOUTS.map((l) => {
        const B = getLayout(l.id);
        return `<div class="card ${c.layout === l.id ? 'current' : ''}" data-act="r-layout" data-arg="${l.id}" style="cursor:pointer">
          <h3>${l.name}</h3><p>${l.desc}</p>
          <div class="specs">${(B.length / 1000).toFixed(2)} km · ${B.ramps.length} jumps<br>Best lap ${formatTime(best['lap_' + l.id] ?? Infinity)} · Best race ${formatTime(best['track_' + l.id] ?? Infinity)}</div></div>`;
      }).join('')}</div>
      <h3>Rivals</h3><div class="row-buttons">${[0, 1, 3, 5, 7].map((n) => `<button class="${c.opponents === n ? 'sel' : ''}" data-act="r-opp" data-arg="${n}">${n === 0 ? 'Time trial' : n}</button>`).join('')}</div>
      <h3>Difficulty</h3><div class="row-buttons">${Object.entries(DIFFS).map(([k, d]) => `<button class="${c.difficulty === k ? 'sel' : ''}" data-act="r-diff" data-arg="${k}">${d.name}</button>`).join('')}</div>
      <h3>Laps</h3><div class="row-buttons">${[1, 2, 3, 5].map((n) => `<button class="${(c.laps || L.laps) === n ? 'sel' : ''}" data-act="r-laps" data-arg="${n}">${n}</button>`).join('')}</div>
      <div class="menu-buttons"><button class="primary big" data-act="r-start">Start race</button></div>`;
  }

  openDerbySetup() {
    const g = this.game, c = this.derbyCfg;
    g.ui.openModal('racesetup', '');
    const panel = g.ui.modal.querySelector('.panel');
    const render = () => {
      panel.innerHTML = `<div class="garage-head"><h2>💥 Crunch Bowl Derby</h2><button data-act="close">✕</button></div>
        <p>Smash the other cars until yours is the last one running. Head-on and side hits hurt the car that gets hit more than the one doing the hitting. The tyre walls don't damage you.</p>
        <p class="muted">Tip: heavy vehicles (SUV, pickup, Big Stomp) are derby kings.</p>
        <h3>Opponents</h3><div class="row-buttons">${[2, 4, 5, 7].map((n) => `<button class="${c.opponents === n ? 'sel' : ''}" data-act="d-opp" data-arg="${n}">${n}</button>`).join('')}</div>
        <h3>Difficulty</h3><div class="row-buttons">${Object.entries(DIFFS).map(([k, d]) => `<button class="${c.difficulty === k ? 'sel' : ''}" data-act="d-diff" data-arg="${k}">${d.name}</button>`).join('')}</div>
        <div class="menu-buttons"><button class="primary big" data-act="d-start">Start derby</button></div>`;
    };
    this.renderDerby = render;
    render();
  }

  onAct(act, arg) {
    const c = this.cfg;
    switch (act) {
      case 'r-layout': c.layout = arg; c.laps = 0; this.renderSetup(); break;
      case 'r-opp': c.opponents = +arg; this.renderSetup(); break;
      case 'r-diff': c.difficulty = arg; this.renderSetup(); break;
      case 'r-laps': c.laps = +arg; this.renderSetup(); break;
      case 'r-start': this.game.ui.closeModal(); this.startRace({ ...c }); break;
      case 'd-opp': this.derbyCfg.opponents = +arg; this.renderDerby(); break;
      case 'd-diff': this.derbyCfg.difficulty = arg; this.renderDerby(); break;
      case 'd-start': this.game.ui.closeModal(); this.startDerby({ ...this.derbyCfg }); break;
      case 'r-again': this.game.ui.closeModal(); if (this.last) this.last.kind === 'race' ? this.startRace(this.last.cfg) : this.startDerby(this.last.cfg); break;
    }
  }

  // ------------------------------------------------------------------ common
  stopOthers() {
    const g = this.game;
    if (g.activities.current) g.activities.end(false, null);
    if (g.missions.runner) g.missions.cancel();
    g.ui.closeModal();
    g.setPaused(false);
  }

  pickRivalCars(n) {
    // rivals drive cars around the player's performance level
    const mine = this.game.car.stats.topSpeed;
    const pool = VEHICLES.filter((v) => v.id !== 'van').map((v) => ({ v, d: Math.abs(computeStats(v, {}).topSpeed - mine) }));
    pool.sort((a, b) => a.d - b.d);
    return Array.from({ length: n }, (_, i) => pool[i % Math.min(pool.length, 4)].v);
  }

  makeAI(def, slot, opts) {
    const g = this.game;
    const ai = new AIDriver(g, slot.x, slot.z, slot.yaw, { vehicle: def.id, paint: COLORS[opts.i % COLORS.length], skill: 0.8, speedMul: opts.speedMul, nitro: true, ...opts });
    // AI cars are a match for the player's upgrades, scaled by difficulty
    ai.car.stats.topSpeed = Math.max(ai.car.stats.topSpeed, g.car.stats.topSpeed * 0.92 * opts.speedMul);
    ai.car.stats.accel = Math.max(ai.car.stats.accel, g.car.stats.accel * 0.9 * opts.speedMul);
    ai.car.stats.grip *= 1.05;
    return ai;
  }

  end(showMsg) {
    const c = this.cur;
    if (!c) return;
    for (const r of c.racers) if (r.ai) r.ai.dispose();
    this.cur = null;
    this.game.ui.setActivity(null);
    this.game.ui.setBanner(null);
    if (showMsg) this.game.ui.toast(showMsg, 'bad');
  }

  // ------------------------------------------------------------------ circuit race
  startRace(cfg) {
    const g = this.game;
    this.stopOthers();
    const L = g.motorpark.setLayout(cfg.layout);
    const laps = cfg.laps || L.laps;
    const D = DIFFS[cfg.difficulty];
    const racers = [];
    const defs = this.pickRivalCars(cfg.opponents);
    defs.forEach((def, i) => {
      const slot = gridSlot(L, i);
      const line = laneOffset(L.pts.map((p) => ({ x: p.x, z: p.z })), (i % 3 - 1) * 2.2);
      const ai = this.makeAI(def, slot, { mode: 'track', loop: line, speedMul: D.speed * (0.96 + Math.random() * 0.08), i });
      racers.push({ name: RIVALS[i % RIVALS.length], ai, car: ai.car, tr: makeTracker(L), color: COLORS[i % COLORS.length] });
    });
    const ps = gridSlot(L, cfg.opponents);
    g.car.place(ps.x, ps.z, ps.yaw, g.world);
    const me = { name: 'You', me: true, car: g.car, tr: makeTracker(L), color: '#ffffff' };
    racers.push(me);
    // everyone starts behind the line, so they begin on "lap -1" and crossing the line starts lap 0
    for (const r of racers) {
      let bi = 0, bd = Infinity;
      L.pts.forEach((p, i) => { const d = (p.x - r.car.pos.x) ** 2 + (p.z - r.car.pos.z) ** 2; if (d < bd) { bd = d; bi = i; } });
      r.tr.idx = bi;
      r.tr.lap = bi > L.n / 2 ? -1 : 0;
    }
    this.cur = { kind: 'race', cfg: { ...cfg, laps }, L, laps, racers, me, time: 0, countdown: 3.5, lapStart: 0, lapTimes: [], finishOrder: [], doneT: 0, diff: D };
    this.last = { kind: 'race', cfg: { ...cfg } };
    g.audio.beep(440);
  }

  // ------------------------------------------------------------------ derby
  startDerby(cfg) {
    const g = this.game;
    this.stopOthers();
    const D = DIFFS[cfg.difficulty];
    const racers = [];
    const n = cfg.opponents + 1;
    const spot = (i) => {
      const a = (i / n) * Math.PI * 2;
      return { x: ARENA.x + Math.cos(a) * ARENA.r * 0.7, z: ARENA.z + Math.sin(a) * ARENA.r * 0.7, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) };
    };
    const heavy = VEHICLES.filter((v) => ['sedan', 'suv', 'pickup', 'muscle', 'rally', 'hatch'].includes(v.id));
    const derby = { kind: 'derby', cfg, racers, time: 0, countdown: 3.5, limit: 180, diff: D };
    for (let i = 0; i < cfg.opponents; i++) {
      const def = heavy[i % heavy.length];
      const s = spot(i + 1);
      const r = { name: RIVALS[i % RIVALS.length], hp: 100, dealt: 0, color: COLORS[i % COLORS.length] };
      r.ai = this.makeAI(def, s, { mode: 'pursue', direct: true, speedMul: D.speed * 0.85, i, target: (self) => this.derbyTarget(self) });
      r.car = r.ai.car;
      racers.push(r);
    }
    const s0 = spot(0);
    g.car.place(s0.x, s0.z, s0.yaw, g.world);
    derby.me = { name: 'You', me: true, car: g.car, hp: 100, dealt: 0, color: '#ffffff' };
    racers.push(derby.me);
    this.cur = derby;
    this.last = { kind: 'derby', cfg: { ...cfg } };
    g.audio.beep(440);
  }

  // each AI picks the nearest living car, with a bias towards the player so it stays exciting
  derbyTarget(self) {
    const c = this.cur;
    if (!c) return null;
    let best = null, bd = Infinity;
    // half the field has a grudge against the player, the rest go for whoever is closest
    const grudge = (self.opts.i % 2 === 0) ? 0.55 : 1.3;
    for (const r of c.racers) {
      if (r.car === self.car || r.hp <= 0) continue;
      const d = Math.hypot(r.car.pos.x - self.car.pos.x, r.car.pos.z - self.car.pos.z) * (r.me ? grudge : 1);
      if (d < bd) { bd = d; best = r.car; }
    }
    return best;
  }

  damage(r, amount, by) {
    if (r.hp <= 0) return;
    r.hp = Math.max(0, r.hp - amount);
    if (by) by.dealt += amount;
    if (r.hp <= 0) {
      r.wreckedAt = this.cur.time;
      this.game.fx.burst('spark', r.car.pos.x, r.car.pos.y + 1, r.car.pos.z, 30, 7);
      this.game.fx.emit('flash', r.car.pos.x, r.car.pos.y + 1, r.car.pos.z);
      this.game.audio.crash(20);
      if (r.me) this.game.ui.toast('💥 You got wrecked!', 'bad');
      else { this.game.ui.toast(`💥 ${esc(r.name)} is wrecked!${by && by.me ? ' <b>+$300</b>' : ''}`, 'good'); if (by && by.me) this.game.reward(300, 60, null); }
      if (r.ai) r.car.model.userData.paintMat.color.multiplyScalar(0.35);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt, input) {
    const c = this.cur;
    if (!c) return;
    const g = this.game;
    if (input.cancel) { this.end(c.kind === 'race' ? 'Race abandoned' : 'Derby abandoned'); return; }
    if (c.countdown > 0) {
      const before = Math.ceil(c.countdown - 0.5);
      c.countdown -= dt;
      const after = Math.ceil(c.countdown - 0.5);
      if (after !== before && after >= 0) g.audio.beep(after > 0 ? 440 : 880);
      g.ui.setBanner(c.countdown > 0.5 ? String(after) : 'GO!');
      if (c.countdown <= 0) setTimeout(() => g.ui.setBanner(null), 600);
      for (const r of c.racers) if (r.ai) { r.car.vel.set(0, 0, 0); r.ai.car.update(dt, { steer: 0, throttle: 0, brake: 0, handbrake: true, nitro: false }, g.world, g.env); }
      this.hud();
      return;
    }
    c.time += dt;
    if (c.kind === 'race') this.updateRace(dt);
    else this.updateDerby(dt);
    if (this.cur) this.hud();
  }

  collideAll(onHit) {
    const rs = this.cur.racers;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.me || b.me) {
        const me = a.me ? a : b, o = a.me ? b : a;
        const res = this.game.car.bump(o.car);
        if (res && res.impact > 0) { o.car.vel.x += res.dvB.x; o.car.vel.z += res.dvB.z; o.car.yawRate += res.kickB; onHit?.(me, o, res); }
      } else {
        const res = bumpCars(a.car, b.car, 0.5);
        if (res && res.impact > 0) {
          a.car.vel.x += res.dvA.x; a.car.vel.z += res.dvA.z; a.car.yawRate += res.kickA;
          b.car.vel.x += res.dvB.x; b.car.vel.z += res.dvB.z; b.car.yawRate += res.kickB;
          onHit?.(a, b, res);
        }
      }
    }
  }

  updateRace(dt) {
    const c = this.cur, g = this.game, L = c.L;
    const myProg = trackerProgress(c.me.tr);
    for (const r of c.racers) {
      if (r.ai) {
        // light rubber band keeps the pack together
        const gap = (trackerProgress(r.tr) - myProg) * 4; // metres
        const band = r.done ? 0.5 : gap > 120 ? 0.9 : gap < -120 ? 1.08 : 1;
        r.ai.update(dt, r.car.stats.topSpeed * band);
      }
      const lapped = updateTracker(r.tr, r.car.pos.x, r.car.pos.z, r.car.yaw);
      if (lapped && r.me && r.tr.lap === 0) c.lapStart = c.time;
      if (lapped && r.me && !r.done && r.tr.lap > 0) {
        const lt = c.time - c.lapStart;
        c.lapTimes.push(lt);
        c.lapStart = c.time;
        const bk = 'lap_' + L.id;
        if (!(g.state.data.best[bk] <= lt)) { g.state.data.best[bk] = lt; if (c.lapTimes.length) g.ui.toast(`⚡ New best lap: ${formatTime(lt)}`, 'good'); }
        if (r.tr.lap < c.laps) { g.audio.beep(990); g.ui.showStunt(`LAP ${r.tr.lap + 1}/${c.laps} <b>${formatTime(lt)}</b>`); }
      }
      if (!r.done && r.tr.lap >= c.laps) {
        r.done = true; r.time = c.time;
        c.finishOrder.push(r);
        if (r.me) { g.audio.chime(); c.doneT = 0.01; }
      }
    }
    this.collideAll();
    // positions
    c.order = [...c.racers].sort((a, b) => {
      if (a.done && b.done) return a.time - b.time;
      if (a.done !== b.done) return a.done ? -1 : 1;
      return trackerProgress(b.tr) - trackerProgress(a.tr);
    });
    if (c.doneT > 0) {
      c.doneT += dt;
      if (c.doneT > 6 || c.racers.every((r) => r.done)) this.finishRace();
    }
  }

  finishRace() {
    const c = this.cur, g = this.game, L = c.L;
    const order = c.order;
    const place = order.indexOf(c.me) + 1;
    const n = order.length;
    const t = c.me.time;
    const bk = 'track_' + L.id + '_' + c.laps;
    const record = !(g.state.data.best[bk] <= t);
    if (record) g.state.data.best[bk] = t;
    if (c.laps === L.laps && !(g.state.data.best['track_' + L.id] <= t)) g.state.data.best['track_' + L.id] = t;
    const placeMult = n === 1 ? 1 : [1.6, 1.2, 1.0, 0.8, 0.65, 0.5, 0.4, 0.35][place - 1] ?? 0.3;
    const money = Math.round((L.length * c.laps * 0.35 * c.diff.reward * (0.5 + n * 0.15) * placeMult) / 10) * 10;
    g.reward(money, Math.round(money / 5), null);
    const rows = order.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td>${i + 1}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</td><td>${r.done ? formatTime(r.time) : 'DNF'}</td></tr>`).join('');
    const best = Math.min(...c.lapTimes);
    const title = n === 1 ? 'FINISHED' : place === 1 ? '1ST PLACE!' : place === 2 ? '2ND PLACE' : place === 3 ? '3RD PLACE' : `${place}TH PLACE`;
    this.end();
    g.ui.openModal('result', `<div class="result ${place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : ''}"><h1>${title}</h1>
      <p>${esc(L.name)} · ${c.laps} lap${c.laps > 1 ? 's' : ''} · ${c.diff.name}<br>Time <b>${formatTime(t)}</b>${record ? ' <span class="good">NEW BEST!</span>' : ''} · Best lap ${formatTime(best)}<br>Reward <b>${formatMoney(money)}</b></p>
      <table class="standings">${rows}</table>
      <div class="menu-buttons" style="justify-content:center"><button class="primary" data-act="r-again">Race again</button><button data-act="close">Continue</button></div></div>`);
  }

  updateDerby(dt) {
    const c = this.cur, g = this.game;
    for (const r of c.racers) {
      if (!r.ai) continue;
      if (r.hp > 0) r.ai.update(dt, Math.min(30, r.car.stats.topSpeed * 0.8));
      else { r.car.update(dt, { steer: 0, throttle: 0, brake: 1, handbrake: false, nitro: false }, g.world, g.env); if (Math.random() < 0.3) g.fx.emit('smoke', r.car.pos.x, r.car.pos.y + 1.2, r.car.pos.z, 0, 1.5, 0, [0.25, 0.25, 0.25]); }
    }
    if (c.me.hp <= 0 && Math.random() < 0.3) g.fx.emit('smoke', g.car.pos.x, g.car.pos.y + 1.2, g.car.pos.z, 0, 1.5, 0, [0.25, 0.25, 0.25]);
    this.collideAll((a, b, res) => {
      if (res.impact < 3 || a.hp <= 0 || b.hp <= 0) return;
      // one damage hit per pair every 0.6 s (a long shove shouldn't count as many crashes)
      const key = a.name + '|' + b.name;
      c.hitAt = c.hitAt || {};
      if (c.time - (c.hitAt[key] ?? -9) < 0.6) return;
      c.hitAt[key] = c.time;
      // who was doing the hitting? compare each car's velocity towards the other
      const nx = res.nx, nz = res.nz; // from b to a
      const aIn = Math.max(0, -(a.car.vel.x * nx + a.car.vel.z * nz)), bIn = Math.max(0, b.car.vel.x * nx + b.car.vel.z * nz);
      const total = aIn + bIn + 0.1;
      const k = Math.min(30, res.impact * 2.2);
      const toA = k * (0.25 + 0.75 * (bIn / total)), toB = k * (0.25 + 0.75 * (aIn / total));
      this.damage(a, toA, b);
      this.damage(b, toB, a);
      if (a.me || b.me) g.ui.showStunt(`CRUNCH! <b>-${Math.round(a.me ? toA : toB)}</b> / dealt ${Math.round(a.me ? toB : toA)}`);
    });
    const alive = c.racers.filter((r) => r.hp > 0);
    if (c.me.hp <= 0 || alive.length <= 1 || c.time >= c.limit) this.finishDerby();
    // keep wrecked player in place
    if (c.me.hp <= 0) g.car.vel.multiplyScalar(0.9);
  }

  finishDerby() {
    const c = this.cur, g = this.game;
    const alive = c.racers.filter((r) => r.hp > 0);
    // ranking: survivors by hp, then wrecked by how late they died
    // survivors rank by score (damage dealt + half their remaining health), wrecked cars by how long they lasted
    const score = (r) => r.dealt + r.hp * 0.5;
    const order = [...c.racers].sort((a, b) => (b.hp > 0) - (a.hp > 0) || (a.hp > 0 ? score(b) - score(a) : (b.wreckedAt || 0) - (a.wreckedAt || 0)));
    const place = order.indexOf(c.me) + 1;
    const won = c.me.hp > 0 && alive.length === 1;
    const money = Math.round(((won ? 2500 : 0) + c.me.dealt * 12 * c.diff.reward + (c.me.hp > 0 ? c.me.hp * 10 : 0)) / 10) * 10;
    g.reward(money, Math.round(money / 5), null);
    const rows = order.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td>${i + 1}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</td><td>${r.hp > 0 ? Math.round(r.hp) + ' hp' : 'wrecked'}</td><td>${Math.round(r.dealt)} dmg</td></tr>`).join('');
    this.end();
    g.ui.openModal('result', `<div class="result ${won ? 'gold' : place <= 3 ? 'silver' : ''}"><h1>${won ? 'LAST CAR STANDING!' : c.me.hp > 0 ? 'TIME!' : 'WRECKED'}</h1>
      <p>Crunch Bowl Derby · ${formatTime(c.time)}<br>Damage dealt <b>${Math.round(c.me.dealt)}</b> · Reward <b>${formatMoney(money)}</b></p>
      <table class="standings">${rows}</table>
      <div class="menu-buttons" style="justify-content:center"><button class="primary" data-act="r-again">Go again</button><button data-act="close">Continue</button></div></div>`);
  }

  // ------------------------------------------------------------------ HUD, minimap, resets
  hud() {
    const c = this.cur, g = this.game;
    if (c.kind === 'race') {
      const order = c.order || c.racers;
      const pos = order.indexOf(c.me) + 1;
      const lap = Math.min(c.laps, Math.max(1, c.me.tr.lap + 1));
      const wrong = c.me.tr.wrong > 30 && g.car.speed > 5;
      const best = c.lapTimes.length ? Math.min(...c.lapTimes) : Infinity;
      g.ui.setActivity(`<div class="act-title">🏁 ${esc(c.L.name)}</div>
        <div class="act-big">${c.racers.length > 1 ? `P${pos}<small>/${c.racers.length}</small> · ` : ''}Lap ${lap}/${c.laps}</div>
        <div>${formatTime(c.time - c.lapStart)} · best ${formatTime(best)}</div>
        ${wrong ? '<div class="late"><b>WRONG WAY!</b></div>' : ''}
        <div class="act-hint">${order.slice(0, 4).map((r, i) => `${i + 1}. ${r.me ? '<b>You</b>' : esc(r.name)}`).join(' · ')}</div>`);
    } else {
      const alive = c.racers.filter((r) => r.hp > 0).length;
      g.ui.setActivity(`<div class="act-title">💥 Crunch Bowl Derby</div>
        <div class="act-big">${formatTime(Math.max(0, c.limit - c.time))}</div>
        <div>${alive} cars left · dealt ${Math.round(c.me.dealt)}</div>
        <div class="mbar good"><span>Your car</span><div><i style="width:${c.me.hp}%"></i></div></div>`);
    }
  }

  dots() {
    const c = this.cur;
    if (!c) return [];
    return c.racers.filter((r) => !r.me).map((r) => ({ x: r.car.pos.x, z: r.car.pos.z, color: r.hp === 0 ? '#555' : r.color }));
  }

  targetPoint() {
    const c = this.cur;
    if (!c || c.kind !== 'race') return null;
    const p = c.L.pts[(c.me.tr.idx + 12) % c.L.n];
    return { x: p.x, z: p.z };
  }

  // R during a race puts you back on the racing line facing the right way
  reset() {
    const c = this.cur, g = this.game;
    if (!c) return false;
    if (c.kind === 'race') {
      const p = c.L.pts[c.me.tr.idx];
      g.car.place(p.x, p.z, p.yaw, g.world);
    } else {
      const a = Math.atan2(g.car.pos.z - ARENA.z, g.car.pos.x - ARENA.x);
      g.car.place(ARENA.x + Math.cos(a) * ARENA.r * 0.8, ARENA.z + Math.sin(a) * ARENA.r * 0.8, Math.atan2(-Math.cos(a), -Math.sin(a)), g.world);
    }
    return true;
  }
}

export { TRACK_WIDTH, clamp };
