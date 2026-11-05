// Rooms: membership, host, teams, settings, movement validation, warps, chat,
// party-cruise power-ups and the currently running event.
import { LIMITS, MODES, TEAMS, POWERUPS, POWERUP_POOLS, EVENT_MODES, CODE_CHARS, TICK_HZ } from '../shared/protocol.js';
import { LAYOUTS } from '../shared/tracks.js';
import { createEvent } from './modes.js';

const r2 = (v) => Math.round(v * 100) / 100;

export class Room {
  constructor(lobby, code, opts = {}) {
    this.lobby = lobby;
    this.code = code;
    this.name = opts.name || `${MODES[opts.mode || 'cruise'].name} ${code}`;
    this.public = opts.public !== false;
    this.mode = MODES[opts.mode] ? opts.mode : 'cruise';
    this.settings = {
      layout: 'oval', laps: 2, items: true, teams: MODES[this.mode].teams === 'always',
      maxPlayers: Math.min(LIMITS.maxPlayers, Math.max(2, opts.maxPlayers || LIMITS.maxPlayers)),
    };
    this.members = new Map();
    this.host = null;
    this.event = null;
    this.powerups = new Map();
    this.puSeq = 0;
    this.nextPowerupAt = Date.now() + 8000;
    this.emptySince = Date.now();
    this.createdAt = Date.now();
    this.pendingDuels = new Map(); // targetId -> { from, until }
  }

  get size() { return this.members.size; }
  get connectedCount() { let n = 0; for (const p of this.members.values()) if (p.connected) n++; return n; }
  get full() { return this.members.size >= this.settings.maxPlayers; }

  // ------------------------------------------------------------------ membership
  add(p) {
    this.members.set(p.id, p);
    p.room = this;
    p.ready = false;
    p.team = this.settings.teams ? this.balancedTeam() : null;
    if (!this.host || !this.members.has(this.host)) this.host = p.id;
    this.emptySince = null;
    this.broadcastRoom();
    this.system(`${p.name} joined`);
  }

  remove(p, reason = 'left') {
    if (!this.members.has(p.id)) return;
    this.members.delete(p.id);
    p.room = null;
    if (this.event) this.event.onLeave(p);
    if (this.host === p.id) {
      const next = [...this.members.values()].find((m) => m.connected) || this.members.values().next().value;
      this.host = next ? next.id : null;
    }
    if (!this.members.size) this.emptySince = Date.now();
    this.broadcastRoom();
    this.system(`${p.name} ${reason}`);
  }

  balancedTeam() {
    let red = 0, blue = 0;
    for (const m of this.members.values()) { if (m.team === 'red') red++; else if (m.team === 'blue') blue++; }
    return red <= blue ? 'red' : 'blue';
  }

  // ------------------------------------------------------------------ messaging
  send(p, msg) { this.lobby.send(p, msg); }
  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const p of this.members.values()) if (p !== except && p.connected) this.lobby.sendRaw(p, data);
  }
  system(text) { this.broadcast({ t: 'chat', id: null, name: 'Server', text }); }

  info() {
    return {
      code: this.code, name: this.name, public: this.public, mode: this.mode, host: this.host, settings: this.settings,
      players: [...this.members.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, ready: p.ready, car: p.car, connected: p.connected, score: p.score })),
      event: this.event ? this.event.info() : null,
      powerups: this.powerupList(),
    };
  }
  broadcastRoom() { this.broadcast({ t: 'room', room: this.info() }); }

  listing() {
    return { code: this.code, name: this.name, mode: this.mode, players: this.members.size, max: this.settings.maxPlayers, inEvent: !!this.event, layout: this.settings.layout };
  }

  // ------------------------------------------------------------------ host controls
  updateSettings(p, s) {
    if (p.id !== this.host) return this.send(p, { t: 'error', msg: 'Only the host can change settings.' });
    if (this.event) return this.send(p, { t: 'error', msg: 'Wait for the current event to finish.' });
    if (typeof s.mode === 'string' && MODES[s.mode]) this.mode = s.mode;
    if (typeof s.layout === 'string' && LAYOUTS.some((l) => l.id === s.layout)) this.settings.layout = s.layout;
    if (Number.isInteger(s.laps)) this.settings.laps = Math.min(5, Math.max(1, s.laps));
    if (typeof s.items === 'boolean') this.settings.items = s.items;
    if (typeof s.public === 'boolean') this.public = s.public;
    const teamRule = MODES[this.mode].teams;
    const wantTeams = teamRule === 'always' ? true : teamRule === 'never' ? false : (typeof s.teams === 'boolean' ? s.teams : this.settings.teams);
    if (wantTeams !== this.settings.teams) {
      this.settings.teams = wantTeams;
      for (const m of this.members.values()) m.team = null;
      if (wantTeams) for (const m of this.members.values()) m.team = this.balancedTeam();
    }
    this.broadcastRoom();
  }

  setTeam(p, team) {
    if (!this.settings.teams || !TEAMS[team] || this.event) return;
    p.team = team;
    this.broadcastRoom();
  }

  setReady(p, ready) {
    p.ready = !!ready;
    this.broadcastRoom();
  }

  kick(p, id) {
    if (p.id !== this.host || id === p.id) return;
    const target = this.members.get(id);
    if (!target) return;
    this.send(target, { t: 'kicked', msg: 'The host removed you from the room.' });
    this.remove(target, 'was kicked');
  }

  startEvent(p) {
    if (p.id !== this.host) return this.send(p, { t: 'error', msg: 'Only the host can start.' });
    if (this.event) return this.send(p, { t: 'error', msg: 'An event is already running.' });
    if (!EVENT_MODES.includes(this.mode)) return this.send(p, { t: 'error', msg: 'Pick an event mode first (race, derby, pursuit or hot potato).' });
    const parts = [...this.members.values()].filter((m) => m.connected && (m.ready || m.id === this.host));
    const min = this.mode === 'pursuit' || this.mode === 'hotpotato' ? 2 : 1;
    if (parts.length < min) return this.send(p, { t: 'error', msg: `Need at least ${min} ready players.` });
    this.beginEvent(this.mode, parts, { layout: this.settings.layout, laps: this.settings.laps, items: this.settings.items, teams: this.settings.teams });
  }

  beginEvent(mode, participants, opts) {
    this.clearPowerups();
    this.event = createEvent(mode, this, participants, opts);
    for (const m of this.members.values()) m.ready = false;
    this.broadcastRoom();
  }

  endEvent(result) {
    this.event = null;
    if (result) {
      const stored = this.lobby.results.add(result);
      this.broadcast({ t: 'results', result: stored });
      for (const s of result.standings) { const m = [...this.members.values()].find((x) => x.id === s.id); if (m) m.score += s.points || 0; }
    }
    this.nextPowerupAt = Date.now() + 6000;
    this.broadcastRoom();
  }

  // ------------------------------------------------------------------ duels
  duelRequest(p, targetId) {
    const t = this.members.get(targetId);
    if (!t || t === p || !t.connected) return;
    if (this.event) return this.send(p, { t: 'error', msg: 'Wait for the current event to finish.' });
    this.pendingDuels.set(t.id, { from: p.id, until: Date.now() + 20000 });
    this.send(t, { t: 'duelInvite', from: p.id, name: p.name, layout: this.settings.layout });
    this.send(p, { t: 'info', msg: `Duel challenge sent to ${t.name}.` });
  }

  duelReply(p, fromId, accept) {
    const d = this.pendingDuels.get(p.id);
    this.pendingDuels.delete(p.id);
    const from = this.members.get(fromId);
    if (!d || d.from !== fromId || d.until < Date.now() || !from || !from.connected) return this.send(p, { t: 'error', msg: 'That challenge expired.' });
    if (!accept) return this.send(from, { t: 'info', msg: `${p.name} declined your duel.` });
    if (this.event) return this.send(p, { t: 'error', msg: 'Wait for the current event to finish.' });
    this.beginEvent('race', [from, p], { layout: this.settings.layout, laps: 1, items: false, teams: false, duel: true });
  }

  // ------------------------------------------------------------------ movement validation
  onState(p, m) {
    const now = Date.now();
    const dt = Math.min(2, Math.max(0.02, (now - (p.lastStateAt || now)) / 1000));
    const x = m.p[0], y = m.p[1], z = m.p[2];
    if (p.warpPending) {
      const w = p.warpPending;
      if (Math.hypot(x - w.x, z - w.z) < 30) p.warpPending = null; // client has applied the warp
      else if (now < w.until) return; // stale state from before the warp; ignore quietly
      else { p.warpPending = null; return this.correct(p); }
    } else if (p.lastValid) {
      const d = Math.hypot(x - p.lastValid.x, z - p.lastValid.z);
      if (d > LIMITS.maxSpeed * dt + 12) {
        p.violations++;
        return this.correct(p);
      }
    }
    if (this.event && !this.event.allowMove(p, x, z)) return;
    p.state = { x, y, z, vx: m.v[0], vy: m.v[1], vz: m.v[2], yaw: m.yaw, fl: m.fl | 0, hp: p.state?.hp };
    p.lastValid = { x, y, z, yaw: m.yaw };
    p.lastStateAt = now;
    if (this.event) this.event.onState(p);
    else this.checkPowerups(p);
  }

  correct(p) {
    if (!p.lastValid) return;
    this.send(p, { t: 'correct', x: p.lastValid.x, y: p.lastValid.y, z: p.lastValid.z, yaw: p.lastValid.yaw });
  }

  // Server-granted teleport (event starts, friend warps, power-ups, resets).
  warp(p, x, z, yaw, reason) {
    p.warpPending = { x, z, until: Date.now() + 4000 };
    p.lastValid = { x, y: p.lastValid?.y ?? 0, z, yaw };
    this.send(p, { t: 'warp', x, z, yaw, reason });
  }

  // client-requested teleports: car resets (short range) and free-roam fast travel
  teleport(p, x, z, yaw, kind) {
    const now = Date.now();
    if (!p.lastValid) return;
    const d = Math.hypot(x - p.lastValid.x, z - p.lastValid.z);
    const okReset = kind === 'reset' && d < 220 && now - (p.lastTpAt || 0) > 1500;
    const okTravel = kind === 'travel' && (!this.event || !this.event.has(p)) && now - (p.lastTpAt || 0) > 5000;
    if (!okReset && !okTravel) return this.correct(p);
    if (this.event && this.event.has(p) && !this.event.allowMove(p, x, z, true)) return this.correct(p);
    p.lastTpAt = now;
    p.warpPending = { x, z, until: now + 4000 };
  }

  warpTo(p, targetId) {
    const t = this.members.get(targetId);
    const now = Date.now();
    if (!t || t === p || !t.state) return;
    if (this.event && (this.event.has(p) || this.event.has(t))) return this.send(p, { t: 'error', msg: "Can't warp during an event." });
    if (now < (p.warpCooldownUntil || 0)) return this.send(p, { t: 'error', msg: `Warp recharging (${Math.ceil(((p.warpCooldownUntil || 0) - now) / 1000)}s).` });
    p.warpCooldownUntil = now + LIMITS.warpCooldown * 1000;
    const s = t.state;
    // park alongside, on the target's right
    const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw);
    this.warp(p, s.x + rx * 5, s.z + rz * 5, s.yaw, `Warped to ${t.name}`);
  }

  // ------------------------------------------------------------------ tick
  tick(now, dt) {
    if (this.event) this.event.tick(now, dt);
    else this.tickCruise(now);
    // snapshot of everyone's validated state
    const s = [];
    for (const p of this.members.values()) {
      if (!p.state) continue;
      const st = p.state;
      s.push([p.id, r2(st.x), r2(st.y), r2(st.z), r2(st.vx), r2(st.vy), r2(st.vz), r2(st.yaw), st.fl | 0, p.connected ? 1 : 0]);
    }
    if (s.length) this.broadcast({ t: 'snap', ts: now, s });
  }

  // ------------------------------------------------------------------ party cruise power-ups
  // public view of crates (event crates carry internal back-references we must not serialise)
  powerupList() { return [...this.powerups.values()].map(({ id, kind, x, z }) => ({ id, kind, x, z })); }

  clearPowerups() {
    if (this.powerups.size) { this.powerups.clear(); this.broadcast({ t: 'pu', list: [] }); }
  }

  spawnPowerup(x, z, kind) {
    const id = ++this.puSeq;
    const pu = { id, kind, x: r2(x), z: r2(z) };
    this.powerups.set(id, pu);
    this.broadcast({ t: 'pu', list: this.powerupList() });
    return pu;
  }

  tickCruise(now) {
    if (now < this.nextPowerupAt) return;
    this.nextPowerupAt = now + 9000 + Math.random() * 6000;
    const players = [...this.members.values()].filter((p) => p.connected && p.state);
    if (!players.length || this.powerups.size >= Math.max(3, players.length * 2)) return;
    // drop one ahead of a random player, so it lands on the road they're driving
    const p = players[Math.floor(Math.random() * players.length)];
    const s = p.state;
    const ahead = 70 + Math.random() * 60, side = (Math.random() - 0.5) * 6;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const pool = POWERUP_POOLS.cruise;
    this.spawnPowerup(s.x + fx * ahead - fz * side, s.z + fz * ahead + fx * side, pool[Math.floor(Math.random() * pool.length)]);
    // old ones expire
    for (const [id, pu] of this.powerups) if (Math.hypot(pu.x - s.x, pu.z - s.z) > 900) this.powerups.delete(id);
  }

  checkPowerups(p, scopePlayers) {
    if (!this.powerups.size || !p.state) return;
    for (const [id, pu] of this.powerups) {
      if (Math.hypot(pu.x - p.state.x, pu.z - p.state.z) < 4.5) {
        this.powerups.delete(id);
        this.broadcast({ t: 'pu', list: this.powerupList() });
        this.applyPowerup(p, pu.kind, scopePlayers);
        if (pu.respawn) setTimeout(() => { if (this.event === pu.event) this.spawnPowerup(pu.x, pu.z, pu.respawn()); }, 8000);
        return pu;
      }
    }
    return null;
  }

  applyPowerup(p, kind, scopePlayers) {
    const def = POWERUPS[kind];
    const all = (scopePlayers || [...this.members.values()]).filter((m) => m.connected && m.state);
    let targets = [p];
    if (def.scope === 'all') targets = all;
    else if (def.scope === 'others') targets = all.filter((m) => m !== p);
    if (kind === 'magnet') {
      // everyone else warps around the picker
      const s = p.state;
      all.filter((m) => m !== p).forEach((m, i) => {
        const a = s.yaw + Math.PI + (i - (all.length - 2) / 2) * 0.5;
        this.warp(m, s.x + Math.sin(a) * 10, s.z + Math.cos(a) * 10, s.yaw, `${p.name} used the Rally Magnet!`);
      });
    } else if (kind === 'swap') {
      const others = all.filter((m) => m !== p);
      if (others.length) {
        const o = others[Math.floor(Math.random() * others.length)];
        const a = { ...p.state }, b = { ...o.state };
        this.warp(p, b.x, b.z, b.yaw, `Swapped with ${o.name}!`);
        this.warp(o, a.x, a.z, a.yaw, `${p.name} swapped places with you!`);
        targets = [p, o];
      }
    }
    if (this.event) this.event.onPowerup?.(p, kind, targets);
    this.broadcast({ t: 'effect', kind, by: p.id, name: p.name, targets: targets.map((m) => m.id), duration: def.duration });
  }
}

export function makeCode(existing) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (existing.has(code));
  return code;
}

export { TICK_HZ };
