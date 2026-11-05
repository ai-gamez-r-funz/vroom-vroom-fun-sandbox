// Vroom Vroom multiplayer server: HTTP (health, room list, shareable results) + WebSocket game protocol.
//   PORT=8787 node index.js
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, TICK_HZ, LIMITS, MODES, EMOTES, TEAMS } from '../shared/protocol.js';
import { Room, makeCode } from './room.js';
import { ResultStore } from './results.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createGameServer({ port = 8787, resultsFile = join(here, 'data', 'results.json'), log = console.log, graceMs = LIMITS.reconnectGrace * 1000 } = {}) {
  const lobby = {
    rooms: new Map(),
    sessions: new Map(), // token -> player
    results: new ResultStore(resultsFile),
    send(p, msg) { if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); },
    sendRaw(p, data) { if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(data); },
  };
  let nextId = 1;

  // ------------------------------------------------------------------ HTTP
  const http = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') { res.writeHead(405); return res.end('{}'); }
    if (url.pathname === '/health') {
      let players = 0;
      for (const p of lobby.sessions.values()) if (p.connected) players++;
      return res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, rooms: lobby.rooms.size, players, uptime: Math.round(process.uptime()) }));
    }
    if (url.pathname === '/rooms') return res.end(JSON.stringify(publicRooms()));
    const m = url.pathname.match(/^\/results\/([A-Za-z0-9_-]{4,20})$/);
    if (m) {
      const r = lobby.results.get(m[1]);
      if (!r) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
      return res.end(JSON.stringify(r));
    }
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/plain'); return res.end('Vroom Vroom multiplayer server. Connect with WebSocket.'); }
    res.writeHead(404);
    res.end('{}');
  });

  const publicRooms = () => [...lobby.rooms.values()].filter((r) => r.public && r.size > 0 && !r.full).map((r) => r.listing());

  // ------------------------------------------------------------------ WebSocket
  const wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const conn = { ws, player: null, tokens: 40, last: Date.now(), floods: 0 };
    ws.on('message', (data) => {
      // token-bucket rate limit: 40 msgs/s sustained
      const now = Date.now();
      conn.tokens = Math.min(40, conn.tokens + ((now - conn.last) / 1000) * 40);
      conn.last = now;
      if (conn.tokens < 1) { if (++conn.floods > 200) ws.close(1008, 'rate limit'); return; }
      conn.tokens--;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { handle(conn, msg); } catch (e) { log('[server] handler error', e); }
    });
    ws.on('close', () => { if (conn.player && conn.player.ws === ws) disconnect(conn.player); });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  // ------------------------------------------------------------------ sessions
  const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, LIMITS.nameLen) || `Driver${Math.floor(Math.random() * 900 + 100)}`;
  const cleanCar = (c) => ({ id: typeof c?.id === 'string' ? c.id.slice(0, 20) : 'hatch', paint: /^#[0-9a-fA-F]{6}$/.test(c?.paint) ? c.paint : '#e8463a' });

  function hello(conn, msg) {
    if (msg.v !== PROTOCOL_VERSION) return conn.ws.send(JSON.stringify({ t: 'error', fatal: true, msg: 'Game version mismatch. Please refresh the page.' }));
    let p = typeof msg.token === 'string' ? lobby.sessions.get(msg.token) : null;
    let resumed = false;
    if (p) {
      // reconnect: take over the session (and kick a stale socket if any)
      if (p.ws && p.ws !== conn.ws && p.ws.readyState === 1) p.ws.close(4000, 'replaced');
      p.ws = conn.ws;
      p.connected = true;
      p.disconnectedAt = null;
      resumed = true;
    } else {
      const token = randomBytes(16).toString('hex');
      p = { id: (nextId++).toString(36), token, ws: conn.ws, connected: true, room: null, team: null, ready: false, score: 0, violations: 0, state: null, lastValid: null };
      lobby.sessions.set(token, p);
    }
    p.name = cleanName(msg.name ?? p.name);
    p.car = cleanCar(msg.car ?? p.car);
    conn.player = p;
    lobby.send(p, { t: 'welcome', id: p.id, token: p.token, resumed, serverTime: Date.now(), room: p.room ? p.room.info() : null });
    if (resumed && p.room) {
      p.room.system(`${p.name} reconnected`);
      p.room.broadcastRoom();
      if (p.lastValid) p.room.warp(p, p.lastValid.x, p.lastValid.z, p.lastValid.yaw, 'Reconnected');
    }
  }

  function disconnect(p) {
    p.connected = false;
    p.disconnectedAt = Date.now();
    if (p.room) { p.room.system(`${p.name} lost connection…`); p.room.broadcastRoom(); }
  }

  function joinRoom(p, room) {
    if (p.room === room) return;
    if (p.room) p.room.remove(p);
    if (room.full) return lobby.send(p, { t: 'error', msg: 'That room is full.' });
    p.lastValid = null; // the client will report its new position
    room.add(p);
  }

  function createRoom(p, opts) {
    const code = makeCode(lobby.rooms);
    const room = new Room(lobby, code, opts);
    lobby.rooms.set(code, room);
    joinRoom(p, room);
    return room;
  }

  // Matchmaking: join the fullest open public room in the requested mode, else make one.
  function quickPlay(p, mode) {
    const want = MODES[mode] ? mode : null;
    const candidates = [...lobby.rooms.values()].filter((r) => r.public && !r.full && r.connectedCount > 0 && r !== p.room && (!want || r.mode === want));
    candidates.sort((a, b) => (a.event ? 1 : 0) - (b.event ? 1 : 0) || b.size - a.size);
    if (candidates.length) return joinRoom(p, candidates[0]);
    createRoom(p, { mode: want || 'cruise', public: true });
  }

  // ------------------------------------------------------------------ message handling
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(num);

  function handle(conn, m) {
    if (m.t === 'hello') return hello(conn, m);
    const p = conn.player;
    if (!p) return;
    const room = p.room;
    switch (m.t) {
      case 'ping': return lobby.send(p, { t: 'pong', c: m.c, s: Date.now() });
      case 'list': return lobby.send(p, { t: 'rooms', rooms: publicRooms() });
      case 'quick': return quickPlay(p, m.mode);
      case 'create': return createRoom(p, { mode: m.mode, public: m.public !== false, name: typeof m.name === 'string' ? cleanName(m.name) + "'s room" : undefined, maxPlayers: m.maxPlayers });
      case 'join': {
        const r = lobby.rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return lobby.send(p, { t: 'error', msg: 'No room with that code.' });
        return joinRoom(p, r);
      }
      case 'leave': if (room) { room.remove(p); lobby.send(p, { t: 'left' }); } return;
      case 'profile': p.name = cleanName(m.name); p.car = cleanCar(m.car); if (room) room.broadcastRoom(); return;
    }
    if (!room) return;
    switch (m.t) {
      case 'state':
        if (!vec3(m.p) || !vec3(m.v) || !num(m.yaw)) return;
        if (Math.abs(m.p[0]) > LIMITS.worldHalf + 50 || Math.abs(m.p[2]) > LIMITS.worldHalf + 50) return room.correct(p);
        if (Math.hypot(m.v[0], m.v[2]) > LIMITS.maxSpeed) return room.correct(p);
        return room.onState(p, m);
      case 'tp':
        if (!num(m.x) || !num(m.z) || !num(m.yaw)) return;
        return room.teleport(p, m.x, m.z, m.yaw, m.kind === 'travel' ? 'travel' : 'reset');
      case 'ready': return room.setReady(p, !!m.ready);
      case 'team': return room.setTeam(p, m.team);
      case 'settings': return room.updateSettings(p, m.settings || {});
      case 'start': return room.startEvent(p);
      case 'kick': return room.kick(p, m.id);
      case 'warp': return room.warpTo(p, m.to);
      case 'duel': return room.duelRequest(p, m.to);
      case 'duelReply': return room.duelReply(p, m.from, !!m.accept);
      case 'chat': {
        const now = Date.now();
        if (now - (p.chatAt || 0) < 900) return;
        p.chatAt = now;
        const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, LIMITS.chatLen);
        if (text) room.broadcast({ t: 'chat', id: p.id, name: p.name, team: p.team, text });
        return;
      }
      case 'emote': {
        const now = Date.now();
        if (!EMOTES.includes(m.e) || now - (p.emoteAt || 0) < 700) return;
        p.emoteAt = now;
        return room.broadcast({ t: 'emote', id: p.id, e: m.e });
      }
      case 'endEvent': // host can abort a stuck event
        if (p.id === room.host && room.event) room.event.end ? room.event.end() : room.endEvent(null);
        return;
    }
  }

  // ------------------------------------------------------------------ game loop & housekeeping
  let lastTick = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    for (const room of lobby.rooms.values()) {
      // one misbehaving room must never take the whole server down
      try { room.tick(now, dt); } catch (e) { log('[server] room tick error', room.code, e); try { room.event = null; room.broadcastRoom(); } catch { /* ignore */ } }
    }
  }, 1000 / TICK_HZ);

  const janitor = setInterval(() => {
    const now = Date.now();
    for (const p of lobby.sessions.values()) {
      if (!p.connected && now - p.disconnectedAt > graceMs) {
        if (p.room) p.room.remove(p, 'timed out');
        lobby.sessions.delete(p.token);
      }
    }
    for (const [code, r] of lobby.rooms) if (r.size === 0 && r.emptySince && now - r.emptySince > 30000) lobby.rooms.delete(code);
  }, 1000);

  return new Promise((resolve) => {
    http.listen(port, () => {
      const actual = http.address().port;
      log(`[server] Vroom Vroom server listening on :${actual}`);
      resolve({
        port: actual, lobby,
        close: () => new Promise((r) => { clearInterval(loop); clearInterval(janitor); clearInterval(heartbeat); for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
      });
    });
  });
}

// run directly: node index.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createGameServer({ port: Number(process.env.PORT) || 8787, resultsFile: process.env.RESULTS_FILE || join(here, 'data', 'results.json') });
}

export { TEAMS };
