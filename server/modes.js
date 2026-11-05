// Server-authoritative multiplayer events. All outcomes (laps, damage, tags, bomb passes,
// winners) are decided here from validated positions; clients only display them.
import { MODES, POWERUP_POOLS, TEAMS } from '../shared/protocol.js';
import { getLayout, gridSlot, makeTracker, updateTracker, trackerProgress, ARENA, MOTORPARK, motorparkMask } from '../shared/tracks.js';

const COUNTDOWN_MS = 4500;
const PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

class BaseEvent {
  constructor(room, participants, opts, mode) {
    this.room = room;
    this.mode = mode;
    this.opts = opts;
    this.parts = new Map();
    for (const p of participants) this.parts.set(p.id, { p, id: p.id, name: p.name, team: opts.teams ? p.team : null, left: false });
    this.phase = 'countdown';
    this.startAt = Date.now() + COUNTDOWN_MS;
    this.endAt = null;
    this.title = MODES[mode].name;
    this.lastInfo = 0;
  }

  has(p) { const e = this.parts.get(p.id); return !!e && !e.left; }
  get running() { return this.phase === 'running'; }
  active() { return [...this.parts.values()].filter((e) => !e.left); }

  info() {
    return { mode: this.mode, title: this.title, phase: this.phase, startAt: this.startAt, endAt: this.endAt, participants: [...this.parts.keys()], extra: this.extra() };
  }
  extra() { return {}; }
  ev(msg) { this.room.broadcast({ t: 'ev', ...msg }); }

  spawn(e, s) {
    e.spawn = s;
    this.room.warp(e.p, s.x, s.z, s.yaw, `${this.title} starting!`);
  }

  // During the countdown participants must stay on their spawn spot.
  allowMove(p, x, z, isTeleport = false) {
    const e = this.parts.get(p.id);
    if (!e || e.left || !e.spawn) return true;
    if (this.phase === 'countdown' && Math.hypot(x - e.spawn.x, z - e.spawn.z) > 10) {
      this.room.warp(p, e.spawn.x, e.spawn.z, e.spawn.yaw, 'Wait for the countdown!');
      return false;
    }
    return !isTeleport || this.phase !== 'countdown';
  }

  onState() {}
  onLeave(p) { const e = this.parts.get(p.id); if (e) e.left = true; }

  tick(now) {
    if (this.phase === 'countdown' && now >= this.startAt) {
      this.phase = 'running';
      this.onStart(now);
      this.room.broadcastRoom();
    }
    if (this.running) this.update(now);
  }
  onStart() {}
  update() {}

  finish(standings, extra = {}) {
    if (this.phase === 'done') return;
    this.phase = 'done';
    standings.forEach((s, i) => { s.place = i + 1; if (s.points === undefined) s.points = PLACE_POINTS[i] || 0; });
    let teams = null, winner = standings[0] ? standings[0].name : null;
    if (this.opts.teams) {
      teams = { red: 0, blue: 0 };
      for (const s of standings) if (s.team) teams[s.team] += s.points;
      winner = teams.red === teams.blue ? 'Draw' : (teams.red > teams.blue ? TEAMS.red.name : TEAMS.blue.name) + ' team';
    }
    if (extra.winner) winner = extra.winner;
    for (const [id, pu] of this.room.powerups) if (pu.event === this) this.room.powerups.delete(id);
    this.room.endEvent({ mode: this.mode, title: this.title, room: this.room.code, standings, teams, winner, ...extra.meta });
  }

  // crate pickup during events (items)
  spawnCrate(x, z) {
    const pool = POWERUP_POOLS[this.mode] || POWERUP_POOLS.race;
    const pu = this.room.spawnPowerup(x, z, pick(pool));
    pu.event = this;
    pu.respawn = () => pick(pool);
    return pu;
  }
  checkCrates(p) { if (this.room.powerups.size) this.room.checkPowerups(p, this.active().map((e) => e.p)); }
}

// ------------------------------------------------------------------ circuit race (and duels)
class RaceEvent extends BaseEvent {
  constructor(room, participants, opts) {
    super(room, participants, opts, 'race');
    this.L = getLayout(opts.layout || 'oval');
    this.laps = opts.laps || this.L.laps;
    this.title = opts.duel ? `Duel: ${participants.map((p) => p.name).join(' vs ')}` : `Circuit Race · ${this.L.name}`;
    this.finishOrder = [];
    this.lastProgress = 0;
    shuffle([...this.parts.values()]).forEach((e, i) => {
      const s = gridSlot(this.L, i);
      this.spawn(e, s);
      e.tr = makeTracker(this.L);
      let bi = 0, bd = Infinity;
      this.L.pts.forEach((q, k) => { const d = (q.x - s.x) ** 2 + (q.z - s.z) ** 2; if (d < bd) { bd = d; bi = k; } });
      e.tr.idx = bi;
      e.tr.lap = bi > this.L.n / 2 ? -1 : 0;
      e.bestLap = Infinity;
      e.lapStart = null;
    });
    this.limitAt = this.startAt + ((this.L.length * this.laps) / 9 + 60) * 1000;
    if (opts.items) {
      for (const f of [0.2, 0.45, 0.7, 0.92]) {
        const q = this.L.pts[Math.floor(f * this.L.n)];
        const nx = -Math.cos(q.yaw), nz = Math.sin(q.yaw);
        for (const s of [-3, 3]) this.spawnCrate(q.x + nx * s, q.z + nz * s);
      }
    }
  }

  extra() { return { layout: this.L.id, laps: this.laps, duel: !!this.opts.duel }; }

  onStart(now) { for (const e of this.parts.values()) e.lapStart = now; }

  onState(p) {
    const e = this.parts.get(p.id);
    if (!e || e.left || !this.running || e.done) return;
    const s = p.state;
    const lapped = updateTracker(e.tr, s.x, s.z, s.yaw);
    const now = Date.now();
    if (lapped && e.tr.lap > 0) { e.bestLap = Math.min(e.bestLap, (now - e.lapStart) / 1000); e.lapStart = now; }
    else if (lapped && e.tr.lap === 0) e.lapStart = now;
    if (e.tr.lap >= this.laps) {
      e.done = true;
      e.time = (now - this.startAt) / 1000;
      this.finishOrder.push(e);
      this.ev({ k: 'finished', id: e.id, name: e.name, place: this.finishOrder.length, time: e.time });
      if (this.finishOrder.length === 1) this.endAt = now + 30000; // others get 30 s to finish
      this.room.broadcastRoom();
    }
    if (this.opts.items) this.checkCrates(p);
  }

  update(now) {
    if (now - this.lastProgress > 250) {
      this.lastProgress = now;
      this.ev({ k: 'progress', list: this.active().map((e) => [e.id, e.tr.lap, e.tr.idx, e.done ? e.time : null]) });
    }
    const act = this.active();
    if (!act.length || act.every((e) => e.done) || (this.endAt && now > this.endAt) || now > this.limitAt) this.end();
  }

  end() {
    const all = [...this.parts.values()];
    all.sort((a, b) => {
      if (a.done && b.done) return a.time - b.time;
      if (a.done !== b.done) return a.done ? -1 : 1;
      if (a.left !== b.left) return a.left ? 1 : -1;
      return trackerProgress(b.tr) - trackerProgress(a.tr);
    });
    const standings = all.map((e) => ({ id: e.id, name: e.name, team: e.team, time: e.done ? e.time : null, bestLap: isFinite(e.bestLap) ? e.bestLap : null, note: e.done ? '' : e.left ? 'left' : 'DNF' }));
    this.finish(standings, { meta: { layout: this.L.id, layoutName: this.L.name, laps: this.laps, duel: !!this.opts.duel } });
  }

  onLeave(p) { super.onLeave(p); }
}

// ------------------------------------------------------------------ destruction derby
class DerbyEvent extends BaseEvent {
  constructor(room, participants, opts) {
    super(room, participants, opts, 'derby');
    this.limitAt = this.startAt + 180000;
    this.hitAt = new Map();
    const list = shuffle([...this.parts.values()]);
    list.forEach((e, i) => {
      const a = (i / list.length) * Math.PI * 2;
      this.spawn(e, { x: ARENA.x + Math.cos(a) * ARENA.r * 0.72, z: ARENA.z + Math.sin(a) * ARENA.r * 0.72, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) });
      e.hp = 100; e.dealt = 0; e.shieldUntil = 0; e.wreckedAt = null;
    });
    if (opts.items) for (const [dx, dz] of [[-18, 0], [18, 0], [0, -18], [0, 18]]) this.spawnCrate(ARENA.x + dx, ARENA.z + dz);
    this.lastHp = 0;
  }

  extra() { return { hp: Object.fromEntries([...this.parts.values()].map((e) => [e.id, Math.round(e.hp)])) }; }

  damage(e, amt, by) {
    if (e.hp <= 0 || Date.now() < e.shieldUntil) return 0;
    const d = Math.min(e.hp, amt);
    e.hp -= d;
    if (by) by.dealt += d;
    if (e.hp <= 0) { e.wreckedAt = Date.now(); this.ev({ k: 'wreck', id: e.id, by: by ? by.id : null, name: e.name, byName: by ? by.name : null }); }
    return d;
  }

  onPowerup(p, kind) {
    const e = this.parts.get(p.id);
    if (!e) return;
    if (kind === 'shield') e.shieldUntil = Date.now() + 10000;
    if (kind === 'repair') e.hp = Math.min(100, e.hp + 40);
  }

  onState(p) { if (this.running && this.has(p)) this.checkCrates(p); }

  update(now) {
    const alive = this.active().filter((e) => e.hp > 0 && e.p.state);
    const dt = 1 / 20;
    // pairwise collision checks on validated positions
    for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j], sa = a.p.state, sb = b.p.state;
      const dx = sa.x - sb.x, dz = sa.z - sb.z, d = Math.hypot(dx, dz);
      if (d > 5 || d < 1e-3) continue;
      const nx = dx / d, nz = dz / d; // from b to a
      const closing = -((sa.vx - sb.vx) * nx + (sa.vz - sb.vz) * nz);
      if (closing < 3) continue;
      const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      if (now - (this.hitAt.get(key) || 0) < 600) continue;
      this.hitAt.set(key, now);
      const aIn = Math.max(0, -(sa.vx * nx + sa.vz * nz)), bIn = Math.max(0, sb.vx * nx + sb.vz * nz);
      const total = aIn + bIn + 0.1;
      const k = Math.min(30, closing * 2.2);
      const da = this.damage(a, k * (0.25 + 0.75 * (bIn / total)), b);
      const db = this.damage(b, k * (0.25 + 0.75 * (aIn / total)), a);
      this.ev({ k: 'hit', a: a.id, b: b.id, da: Math.round(da), db: Math.round(db) });
    }
    // leaving the bowl hurts
    for (const e of alive) {
      const s = e.p.state;
      if (Math.hypot(s.x - ARENA.x, s.z - ARENA.z) > ARENA.r + 8) this.damage(e, 6 * dt, null);
    }
    if (now - this.lastHp > 500) { this.lastHp = now; this.ev({ k: 'hp', hp: this.extra().hp }); }
    const stillAlive = this.active().filter((e) => e.hp > 0);
    const teamsLeft = new Set(stillAlive.map((e) => e.team));
    if (stillAlive.length <= 1 || (this.opts.teams && teamsLeft.size <= 1) || now > this.limitAt) this.end();
  }

  end() {
    const score = (e) => e.dealt + e.hp * 0.5;
    const all = [...this.parts.values()].sort((a, b) => (b.hp > 0) - (a.hp > 0) || (a.hp > 0 ? score(b) - score(a) : (b.wreckedAt || 0) - (a.wreckedAt || 0)));
    this.finish(all.map((e) => ({ id: e.id, name: e.name, team: e.team, score: Math.round(score(e)), note: e.hp > 0 ? `${Math.round(e.hp)} hp left` : e.left ? 'left' : 'wrecked', stat: `${Math.round(e.dealt)} dmg dealt` })));
  }
}

// ------------------------------------------------------------------ cops & robbers
const CITY_SPOTS = [];
for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) CITY_SPOTS.push({ x: i * 75, z: j * 75 });

class PursuitEvent extends BaseEvent {
  constructor(room, participants, opts) {
    super(room, participants, opts, 'pursuit');
    this.limitAt = this.startAt + 240000;
    this.releaseAt = this.startAt + 10000;
    const list = shuffle([...this.parts.values()]);
    if (opts.teams) list.forEach((e) => { e.role = e.p.team === 'blue' ? 'cop' : 'robber'; });
    else list.forEach((e, i) => { e.role = i < Math.max(1, Math.ceil(list.length / 3)) ? 'cop' : 'robber'; });
    if (!list.some((e) => e.role === 'cop')) list[0].role = 'cop';
    if (!list.some((e) => e.role === 'robber')) list[list.length - 1].role = 'robber';
    const spots = shuffle([...CITY_SPOTS]);
    let ci = 0, ri = 0;
    for (const e of list) {
      e.tag = 0; e.score = 0; e.bustedAt = null; e.wasRobber = e.role === 'robber';
      if (e.role === 'cop') { this.spawn(e, { x: 150 + (ci % 2) * 6 - 3, z: 112 + Math.floor(ci / 2) * 9, yaw: Math.PI }); ci++; }
      else { const s = spots[ri++ % spots.length]; this.spawn(e, { x: s.x + 3, z: s.z + 12, yaw: Math.PI }); }
    }
    this.lastSurvive = 0;
  }

  extra() { return { roles: Object.fromEntries([...this.parts.values()].map((e) => [e.id, e.role])), releaseAt: this.releaseAt }; }

  allowMove(p, x, z, isTp) {
    const e = this.parts.get(p.id);
    // cops wait at the station for the robbers' head start
    if (e && e.role === 'cop' && e.spawn && Date.now() < this.releaseAt && Math.hypot(x - e.spawn.x, z - e.spawn.z) > 12) {
      this.room.warp(p, e.spawn.x, e.spawn.z, e.spawn.yaw, 'Cops are released after the robbers\' head start!');
      return false;
    }
    return super.allowMove(p, x, z, isTp);
  }

  onState(p) { if (this.running && this.has(p)) this.checkCrates(p); }

  update(now) {
    const dt = 1 / 20;
    const act = this.active().filter((e) => e.p.state);
    const cops = act.filter((e) => e.role === 'cop'), robbers = act.filter((e) => e.role === 'robber');
    if (now >= this.releaseAt) {
      for (const r of robbers) {
        let near = null;
        for (const c of cops) {
          const d = Math.hypot(c.p.state.x - r.p.state.x, c.p.state.z - r.p.state.z);
          if (d < 7.5) { near = c; break; }
        }
        if (near) r.tag += dt; else r.tag = Math.max(0, r.tag - dt * 0.5);
        if (r.tag >= 1.3) {
          r.role = 'cop'; r.bustedAt = now; near.score += 3;
          this.ev({ k: 'busted', id: r.id, by: near.id, name: r.name, byName: near.name });
          this.room.broadcastRoom();
        }
      }
    }
    if (now - this.lastSurvive > 10000 && now > this.startAt) {
      this.lastSurvive = now;
      for (const r of robbers) r.score += 1;
    }
    if (now - (this.lastTagInfo || 0) > 300) { this.lastTagInfo = now; this.ev({ k: 'tags', tags: Object.fromEntries(robbers.map((r) => [r.id, Math.round(r.tag * 100) / 100])) }); }
    const left = this.active().filter((e) => e.role === 'robber');
    if (!left.length || now > this.limitAt) this.end(left.length > 0);
  }

  end(robbersWon) {
    const all = [...this.parts.values()];
    for (const e of all) if (robbersWon && e.role === 'robber') e.score += 5; else if (!robbersWon && e.role === 'cop' && !e.wasRobber) e.score += 3;
    all.sort((a, b) => b.score - a.score);
    const standings = all.map((e) => ({ id: e.id, name: e.name, team: e.team, score: e.score, points: e.score, note: e.wasRobber ? (e.bustedAt ? 'robber — busted' : 'robber — escaped!') : 'cop' }));
    this.finish(standings, { winner: robbersWon ? 'Robbers' : 'Cops' });
  }
}

// ------------------------------------------------------------------ hot potato
class HotPotatoEvent extends BaseEvent {
  constructor(room, participants, opts) {
    super(room, participants, opts, 'hotpotato');
    const list = shuffle([...this.parts.values()]);
    list.forEach((e, i) => {
      const a = (i / list.length) * Math.PI * 2;
      this.spawn(e, { x: MOTORPARK.x + Math.cos(a) * 60, z: MOTORPARK.z + Math.sin(a) * 40, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) });
      e.out = false; e.outAt = null; e.held = 0;
    });
    this.holder = null; this.fuseAt = 0; this.passAt = 0; this.prevHolder = null;
    this.outOrder = [];
  }

  extra() { return { holder: this.holder, fuseAt: this.fuseAt, out: [...this.parts.values()].filter((e) => e.out).map((e) => e.id) }; }

  newRound(now) {
    const alive = this.active().filter((e) => !e.out);
    if (alive.length <= 1) return this.end();
    this.holder = pick(alive).id;
    this.fuseAt = now + (18 + Math.random() * 10) * 1000;
    this.passAt = now + 1500; this.prevHolder = null;
    this.ev({ k: 'bomb', id: this.holder, fuseAt: this.fuseAt });
    this.room.broadcastRoom();
  }

  onStart(now) { this.newRound(now); }

  allowMove(p, x, z, isTp) {
    const e = this.parts.get(p.id);
    if (e && this.running && !e.out && motorparkMask(x, z) < 0.2) {
      this.room.warp(p, MOTORPARK.x, MOTORPARK.z, 0, 'Stay in the Motorpark!');
      return false;
    }
    return super.allowMove(p, x, z, isTp);
  }

  onState(p) { if (this.running && this.has(p)) this.checkCrates(p); }

  update(now) {
    const h = this.parts.get(this.holder);
    if (!h || h.left || h.out) return this.newRound(now);
    h.held += 1 / 20;
    if (now >= this.fuseAt) {
      h.out = true; h.outAt = now; this.outOrder.push(h);
      this.ev({ k: 'boom', id: h.id, name: h.name });
      return this.newRound(now + 2500);
    }
    if (now < this.passAt || !h.p.state) return;
    for (const e of this.active()) {
      if (e === h || e.out || !e.p.state || (e.id === this.prevHolder && now < this.passAt + 1500)) continue;
      if (Math.hypot(e.p.state.x - h.p.state.x, e.p.state.z - h.p.state.z) < 5.8) {
        this.prevHolder = h.id;
        this.holder = e.id;
        this.passAt = now + 1000;
        this.ev({ k: 'bomb', id: e.id, from: h.id, fuseAt: this.fuseAt });
        return;
      }
    }
  }

  onLeave(p) {
    super.onLeave(p);
    if (this.holder === p.id && this.running) this.newRound(Date.now());
  }

  end() {
    const all = [...this.parts.values()];
    all.sort((a, b) => (a.out - b.out) || ((b.outAt || 0) - (a.outAt || 0)));
    this.finish(all.map((e) => ({ id: e.id, name: e.name, team: e.team, note: e.out ? 'boom!' : e.left ? 'left' : 'survivor', stat: `held the bomb ${e.held.toFixed(1)}s` })));
  }
}

const EVENTS = { race: RaceEvent, derby: DerbyEvent, pursuit: PursuitEvent, hotpotato: HotPotatoEvent };
export function createEvent(mode, room, participants, opts) {
  return new EVENTS[mode](room, participants, opts);
}
