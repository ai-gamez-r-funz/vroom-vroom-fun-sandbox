// End-to-end tests: real server + WebSocket bot clients.  Run: npm test (in server/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../index.js';
import { PROTOCOL_VERSION } from '../../shared/protocol.js';
import { getLayout, gridSlot, ARENA, MOTORPARK } from '../../shared/tracks.js';

let srv, base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name) { this.name = name; this.msgs = []; this.waiters = []; this.pos = { x: 0, y: 2, z: 40, yaw: 0 }; }
  async connect(token) {
    this.ws = new WebSocket(`ws://localhost:${srv.port}`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'warp' || m.t === 'correct') Object.assign(this.pos, { x: m.x, z: m.z, yaw: m.yaw ?? this.pos.yaw });
      if (m.t === 'room') this.room = m.room;
      if (m.t === 'welcome') { this.id = m.id; this.token = m.token; if (m.room) this.room = m.room; }
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    });
    await new Promise((r) => this.ws.on('open', r));
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, token, car: { id: 'sports', paint: '#ff0000' } });
    return this.wait((m) => m.t === 'welcome');
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 8000) {
    const hit = this.msgs.find(pred);
    if (hit) { this.msgs.splice(this.msgs.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { clearTimeout(w.timer); this.msgs.splice(this.msgs.indexOf(m), 1); resolve(m); } };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`${this.name}: timed out waiting`)); }, ms);
      this.waiters.push(w);
    });
  }
  clear() { this.msgs = []; }
  state(x, z, yaw = this.pos.yaw, v = [0, 0, 0]) { this.pos = { ...this.pos, x, z, yaw }; this.send({ t: 'state', p: [x, 2, z], v, yaw, fl: 0 }); }
  close() { this.ws.close(); }
}

before(async () => { srv = await createGameServer({ port: 0, resultsFile: null, log: () => {}, graceMs: 3000 }); base = `http://localhost:${srv.port}`; });
after(async () => { await srv.close(); });

async function pair(mode) {
  const a = new Bot('Alice'), b = new Bot('Bob');
  await a.connect(); await b.connect();
  a.send({ t: 'create', mode, public: false });
  const room = (await a.wait((m) => m.t === 'room')).room;
  b.send({ t: 'join', code: room.code });
  await b.wait((m) => m.t === 'room' && m.room.players.length === 2);
  a.state(0, 40); b.state(10, 40);
  await sleep(100);
  return { a, b, code: room.code, room: srv.lobby.rooms.get(room.code) };
}

async function startEvent(a, b, settings) {
  a.send({ t: 'settings', settings });
  await sleep(50);
  b.send({ t: 'ready', ready: true });
  await sleep(50);
  a.clear(); b.clear();
  a.send({ t: 'start' });
  await a.wait((m) => m.t === 'warp'); await b.wait((m) => m.t === 'warp');
  // confirm the warp by reporting the new position, then wait for the countdown
  a.state(a.pos.x, a.pos.z, a.pos.yaw); b.state(b.pos.x, b.pos.z, b.pos.yaw);
}

test('health endpoint and hello/welcome with a session token', async () => {
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.ok, true);
  const a = new Bot('Zed');
  const w = await a.connect();
  assert.ok(w.id && w.token.length === 32);
  a.close();
});

test('version mismatch is rejected', async () => {
  const ws = new WebSocket(`ws://localhost:${srv.port}`);
  await new Promise((r) => ws.on('open', r));
  const got = new Promise((r) => ws.on('message', (d) => r(JSON.parse(d))));
  ws.send(JSON.stringify({ t: 'hello', v: 999, name: 'x' }));
  const m = await got;
  assert.equal(m.t, 'error'); assert.equal(m.fatal, true);
  ws.close();
});

test('quick play matchmaking puts players in the same public room', async () => {
  const a = new Bot('Q1'), b = new Bot('Q2');
  await a.connect(); await b.connect();
  a.send({ t: 'quick', mode: 'hotpotato' });
  const ra = (await a.wait((m) => m.t === 'room')).room;
  b.send({ t: 'quick', mode: 'hotpotato' });
  const rb = (await b.wait((m) => m.t === 'room')).room;
  assert.equal(ra.code, rb.code);
  assert.equal(rb.mode, 'hotpotato');
  const list = await (await fetch(`${base}/rooms`)).json();
  assert.ok(list.some((r) => r.code === ra.code));
  a.close(); b.close();
});

test('host-only settings, teams and kick', async () => {
  const { a, b, room } = await pair('race');
  b.clear();
  b.send({ t: 'settings', settings: { layout: 'jumps' } });
  assert.match((await b.wait((m) => m.t === 'error')).msg, /host/);
  a.send({ t: 'settings', settings: { layout: 'jumps', laps: 3, teams: true } });
  const r = (await b.wait((m) => m.t === 'room' && m.room.settings.layout === 'jumps')).room;
  assert.equal(r.settings.laps, 3);
  assert.deepEqual(new Set(r.players.map((p) => p.team)), new Set(['red', 'blue']));
  b.send({ t: 'team', team: 'red' });
  await a.wait((m) => m.t === 'room' && m.room.players.every((p) => p.team === 'red'));
  a.send({ t: 'kick', id: b.id });
  await b.wait((m) => m.t === 'kicked');
  assert.equal(room.size, 1);
  a.close(); b.close();
});

test('movement validation: normal driving accepted, teleports corrected', async () => {
  const { a, b } = await pair('cruise');
  a.state(0, 42, 0, [0, 0, 20]);
  const snap = await b.wait((m) => m.t === 'snap' && m.s.some((s) => s[0] === a.id && Math.abs(s[3] - 42) < 0.1));
  assert.ok(snap);
  a.clear();
  a.state(800, 800); // impossible jump
  const c = await a.wait((m) => m.t === 'correct');
  assert.ok(Math.abs(c.x) < 1 && Math.abs(c.z - 42) < 1);
  // a short "reset" teleport is allowed through the tp message
  a.send({ t: 'tp', x: 30, z: 42, yaw: 0, kind: 'reset' });
  await sleep(30);
  a.clear();
  a.state(30, 42);
  await sleep(150);
  assert.ok(!a.msgs.some((m) => m.t === 'correct'));
  a.close(); b.close();
});

test('warp to a friend lands next to them', async () => {
  const { a, b } = await pair('cruise');
  b.state(10, 60, Math.PI / 2);
  await sleep(80);
  a.clear();
  a.send({ t: 'warp', to: b.id });
  const w = await a.wait((m) => m.t === 'warp');
  assert.ok(Math.hypot(w.x - 10, w.z - 60) < 7);
  a.send({ t: 'warp', to: b.id });
  assert.match((await a.wait((m) => m.t === 'error')).msg, /recharging/);
  a.close(); b.close();
});

test('circuit race: server tracks laps, decides the winner and stores a shareable result', async () => {
  const { a, b } = await pair('race');
  await startEvent(a, b, { layout: 'oval', laps: 1, items: false });
  const L = getLayout('oval');
  await a.wait((m) => m.t === 'room' && m.room.event && m.room.event.phase === 'running', 9000);
  // Alice drives the lap at ~100 m/s, Bob dawdles
  const n = L.n;
  let ia = (() => { let bi = 0, bd = 1e9; L.pts.forEach((p, i) => { const d = (p.x - a.pos.x) ** 2 + (p.z - a.pos.z) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; })();
  for (let step = 0; step < n + 20; step++) {
    ia = (ia + 1) % n;
    const p = L.pts[ia];
    a.state(p.x, p.z, p.yaw, [Math.sin(p.yaw) * 80, 0, Math.cos(p.yaw) * 80]);
    if (step % 10 === 0) b.state(b.pos.x, b.pos.z, b.pos.yaw);
    await sleep(45);
  }
  const fin = await b.wait((m) => m.t === 'ev' && m.k === 'finished');
  assert.equal(fin.id, a.id);
  // end the event early as host (Bob would get 30 s otherwise)
  a.send({ t: 'endEvent' });
  const res = (await b.wait((m) => m.t === 'results')).result;
  assert.equal(res.standings[0].name, 'Alice');
  assert.equal(res.standings[1].note, 'DNF');
  const fetched = await (await fetch(`${base}/results/${res.id}`)).json();
  assert.equal(fetched.title, res.title);
  a.close(); b.close();
});

test('race with items on: crates spawn on the track and can be picked up', async () => {
  const { a, b, room } = await pair('race');
  await startEvent(a, b, { layout: 'jumps', laps: 1, items: true });
  const r = (await a.wait((m) => m.t === 'room' && m.room.event && m.room.event.phase === 'running', 9000)).room;
  assert.ok(r.powerups.length >= 8, 'crates were spawned');
  assert.ok(r.powerups.every((p) => Object.keys(p).sort().join() === 'id,kind,x,z'), 'only public crate fields are sent');
  // nudge the first crate next to Alice (she can't legally teleport to it), then drive through it
  const c = [...room.powerups.values()][0];
  c.x = a.pos.x; c.z = a.pos.z + 6;
  a.state(a.pos.x, a.pos.z + 3); await sleep(60); a.state(a.pos.x, a.pos.z + 3);
  const eff = await b.wait((m) => m.t === 'effect');
  assert.equal(eff.by, a.id);
  await sleep(50);
  assert.ok(room.powerups.size < r.powerups.length);
  a.close(); b.close();
});

test('derby: collisions are detected server-side and deal damage', async () => {
  const { a, b, room } = await pair('derby');
  await startEvent(a, b, { items: false });
  await a.wait((m) => m.t === 'room' && m.room.event && m.room.event.phase === 'running', 9000);
  // drive Alice into Bob at 20 m/s
  const bx = ARENA.x, bz = ARENA.z + 20;
  b.state(bx, bz, 0); await sleep(60);
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    a.state(bx - 20 + t * 18, bz, Math.PI / 2, [20, 0, 0]);
    b.state(bx, bz, 0, [0, 0, 0]);
    await sleep(55);
  }
  const hit = await b.wait((m) => m.t === 'ev' && m.k === 'hit');
  assert.ok(hit.db > hit.da, 'the car that got hit takes more damage');
  const ev = room.event;
  assert.ok(ev.parts.get(b.id).hp < 100);
  a.close(); b.close();
});

test('hot potato: bomb passes on contact', async () => {
  const { a, b, room } = await pair('hotpotato');
  await startEvent(a, b, {});
  const bomb = await a.wait((m) => m.t === 'ev' && m.k === 'bomb', 9000);
  const [holder, other] = bomb.id === a.id ? [a, b] : [b, a];
  await sleep(1600); // pass cooldown
  const ox = MOTORPARK.x + 20, oz = MOTORPARK.z;
  other.state(ox, oz); holder.state(ox - 30, oz); await sleep(60);
  for (let i = 0; i < 8; i++) { holder.state(ox - 30 + (i + 1) * 3.6, oz, Math.PI / 2, [20, 0, 0]); other.state(ox, oz); await sleep(60); }
  const pass = await a.wait((m) => m.t === 'ev' && m.k === 'bomb' && m.from === holder.id);
  assert.equal(pass.id, other.id);
  assert.equal(room.event.holder, other.id);
  a.close(); b.close();
});

test('cops & robbers: lingering next to a robber busts them', async () => {
  const { a, b, room } = await pair('pursuit');
  await startEvent(a, b, {});
  await a.wait((m) => m.t === 'room' && m.room.event && m.room.event.phase === 'running', 9000);
  const ev = room.event;
  ev.releaseAt = Date.now(); // skip the robbers' head start for the test
  const roles = ev.extra().roles;
  const [cop, robber] = roles[a.id] === 'cop' ? [a, b] : [b, a];
  // robber parks; cop drives up next to them
  robber.state(robber.pos.x, robber.pos.z);
  const tx = robber.pos.x, tz = robber.pos.z;
  let cx = cop.pos.x, cz = cop.pos.z;
  for (let i = 0; i < 60; i++) {
    const d = Math.hypot(tx + 4 - cx, tz - cz);
    const step = Math.min(d, 4);
    if (d > 0.1) { cx += ((tx + 4 - cx) / d) * step; cz += ((tz - cz) / d) * step; }
    cop.state(cx, cz); robber.state(tx, tz);
    await sleep(50);
  }
  const busted = await a.wait((m) => m.t === 'ev' && m.k === 'busted', 4000);
  assert.equal(busted.id, robber.id);
  a.close(); b.close();
});

test('party cruise power-ups: pickup is decided by the server and broadcast as an effect', async () => {
  const { a, b, room } = await pair('cruise');
  room.spawnPowerup(0, 60, 'moon');
  a.state(0, 50); await sleep(60);
  a.state(0, 56); await sleep(60);
  a.state(0, 60);
  const eff = await b.wait((m) => m.t === 'effect');
  assert.equal(eff.kind, 'moon');
  assert.deepEqual(new Set(eff.targets), new Set([a.id, b.id]));
  a.close(); b.close();
});

test('duel: challenge, accept, and a 2-player race starts', async () => {
  const { a, b, room } = await pair('cruise');
  a.send({ t: 'duel', to: b.id });
  const inv = await b.wait((m) => m.t === 'duelInvite');
  b.send({ t: 'duelReply', from: inv.from, accept: true });
  await a.wait((m) => m.t === 'warp');
  assert.equal(room.event.mode, 'race');
  assert.equal(room.event.parts.size, 2);
  assert.match(room.event.title, /Duel/);
  a.close(); b.close();
});

test('reconnect within the grace period restores the room and slot', async () => {
  const { a, b, code } = await pair('cruise');
  const token = a.token;
  a.close();
  await b.wait((m) => m.t === 'room' && m.room.players.some((p) => p.id === a.id && !p.connected));
  const a2 = new Bot('Alice');
  const w = await a2.connect(token);
  assert.equal(w.resumed, true);
  assert.equal(w.id, a.id);
  assert.equal(w.room.code, code);
  await b.wait((m) => m.t === 'room' && m.room.players.find((p) => p.id === a.id)?.connected);
  a2.close(); b.close();
});

test('disconnected players are removed after the grace period and host migrates', async () => {
  const { a, b, room } = await pair('cruise');
  assert.equal(room.host, a.id);
  a.close();
  await b.wait((m) => m.t === 'room' && m.room.players.length === 1, 7000);
  assert.equal(room.host, b.id);
  b.close();
});

test('flooding the socket gets rate limited and eventually disconnected', async () => {
  const a = new Bot('Spammer');
  await a.connect();
  const closed = new Promise((r) => a.ws.on('close', r));
  for (let i = 0; i < 600; i++) a.send({ t: 'ping', c: i });
  await closed;
  const pongs = a.msgs.filter((m) => m.t === 'pong').length;
  assert.ok(pongs < 120, `only a limited number of messages were processed (${pongs})`);
});
