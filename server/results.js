// Shareable results: kept in memory and persisted to a small JSON file (bounded size).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class ResultStore {
  constructor(file, max = 2000) {
    this.file = file;
    this.max = max;
    this.map = new Map();
    this.saveTimer = null;
    if (file && existsSync(file)) {
      try {
        for (const r of JSON.parse(readFileSync(file, 'utf8'))) this.map.set(r.id, r);
      } catch (e) { console.warn('[results] could not read store:', e.message); }
    }
  }

  add(result) {
    let id;
    do { id = randomBytes(5).toString('base64url'); } while (this.map.has(id));
    const r = { id, at: Date.now(), ...result };
    this.map.set(id, r);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.scheduleSave();
    return r;
  }

  get(id) { return this.map.get(id) || null; }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify([...this.map.values()]));
      } catch (e) { console.warn('[results] save failed:', e.message); }
    }, 2000);
  }
}
