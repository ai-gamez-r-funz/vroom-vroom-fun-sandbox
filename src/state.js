// Persistent player progress (localStorage).
import { VEHICLES } from './vehicles.js';

const KEY = 'vroomvroom.save.v1';

export function defaultSetup(def) {
  return { upgrades: {}, tires: 'street', paint: def.color, finish: 'gloss' };
}

function fresh() {
  return {
    money: 3000,
    xp: 0,
    current: 'hatch',
    garage: { hatch: defaultSetup(VEHICLES[0]) },
    properties: ['home'],
    best: {},
    medals: {},
    collected: [],
    speedTraps: {},
    stats: { distance: 0, smashed: 0, jumps: 0, deliveries: 0, bestDrift: 0, topSpeed: 0, bestJump: 0, bestAir: 0, earned: 0 },
    settings: { volume: 0.6, quality: 'high', traffic: true, units: 'kmh' },
    lastDay: 0,
  };
}

export class GameState {
  constructor() {
    this.data = fresh();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        const f = fresh();
        this.data = { ...f, ...d, stats: { ...f.stats, ...(d.stats || {}) }, settings: { ...f.settings, ...(d.settings || {}) } };
      }
    } catch (e) { /* storage blocked: play without saving */ }
    this.listeners = [];
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  }
  reset() {
    this.data = fresh();
    this.save();
  }
  onChange(fn) { this.listeners.push(fn); }
  changed() { this.listeners.forEach((f) => f(this.data)); this.save(); }

  get money() { return this.data.money; }
  addMoney(n) {
    this.data.money += n;
    if (n > 0) this.data.stats.earned += n;
    this.changed();
  }
  spend(n) {
    if (this.data.money < n) return false;
    this.data.money -= n;
    this.changed();
    return true;
  }
  addXp(n) {
    const before = this.level;
    this.data.xp += n;
    this.changed();
    return this.level > before;
  }
  static xpFor(level) { return 300 * (level - 1) * level; }
  get level() {
    let l = 1;
    while (this.data.xp >= GameState.xpFor(l + 1)) l++;
    return l;
  }
  get setup() { return this.data.garage[this.data.current]; }
}
