// Online multiplayer: connection + lobby UI, rooms, events HUD, power-ups, effects,
// chat/emotes, duels, warps and shareable results. The server is authoritative; this
// module renders what it says and streams the local car's state to it.
import * as THREE from 'three';
import { NetClient, defaultServerUrl, httpUrl } from './net.js';
import { Remotes } from './remotes.js';
import { addLightBar, flashLightBar } from '../missions/ai.js';
import { MODES, TEAMS, POWERUPS, EMOTES, FLAG, SEND_HZ, LIMITS } from '../../shared/protocol.js';
import { LAYOUTS, getLayout } from '../../shared/tracks.js';
import { formatTime } from '../util.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LIMIT_S = { derby: 180, pursuit: 240 };

export class Multiplayer {
  constructor(game) {
    this.game = game;
    this.net = new NetClient({ onMessage: (m) => this.onMessage(m), onStatus: (s, d) => this.onStatus(s, d) });
    this.remotes = new Remotes(game);
    this.room = null;
    this.myId = null;
    this.ev = null; // live event state
    this.chatLog = [];
    this.sendAcc = 0;
    this.crates = new Map();
    this.fx = { me: {}, remote: new Map() };
    this.serverUrl = defaultServerUrl();
    this.statusText = '';
    try { this.name = localStorage.getItem('vroom.mp.name') || ''; } catch { this.name = ''; }
    this.handleStartupLinks();
  }

  get connected() { return this.net.status === 'open'; }
  get inRoom() { return !!this.room && this.net.status !== 'closed'; }
  get myEvent() { return this.ev && this.ev.participants.includes(this.myId) ? this.ev : null; }
  get frozen() {
    const e = this.myEvent;
    if (!e) return false;
    const now = this.net.serverNow();
    if (e.phase === 'countdown') return true;
    if (e.mode === 'pursuit' && e.extra.roles?.[this.myId] === 'cop' && now < e.extra.releaseAt) return true;
    return false;
  }

  profile() {
    const g = this.game;
    return { name: this.name || 'Driver', car: { id: g.state.data.current, paint: g.state.setup.paint } };
  }

  // ------------------------------------------------------------------ links: ?room=CODE  ?result=ID
  handleStartupLinks() {
    const q = new URLSearchParams(location.search);
    this.pendingJoin = q.get('room');
    this.pendingResult = q.get('result');
  }

  afterBegin() {
    if (this.pendingResult) { this.showSharedResult(this.pendingResult); this.pendingResult = null; }
    else if (this.pendingJoin) this.open();
  }

  async showSharedResult(id) {
    const ui = this.game.ui;
    if (!this.serverUrl) return ui.toast('This result link has no server address.', 'bad');
    try {
      const r = await (await fetch(`${httpUrl(this.serverUrl)}/results/${encodeURIComponent(id)}`)).json();
      if (r.error) throw new Error(r.error);
      this.showResults(r, true);
    } catch (e) {
      ui.toast(`Could not load that result (${esc(e.message)}).`, 'bad');
    }
  }

  // ------------------------------------------------------------------ panel
  open() {
    this.game.ui.openModal('online', '<div class="mp-main"></div><div class="mp-chat"></div>');
    this.render();
  }

  get panelOpen() { return this.game.ui.openPanel === 'online'; }

  render() {
    if (!this.panelOpen) return;
    const panel = this.game.ui.modal.querySelector('.panel');
    const main = panel.querySelector('.mp-main');
    const chat = panel.querySelector('.mp-chat');
    const st = this.net.status;
    if (st !== 'open' && !(this.room && st === 'reconnecting')) {
      main.innerHTML = `<div class="garage-head"><h2>👥 Play online</h2><button data-act="close">✕</button></div>
        <p class="muted">Race, smash and goof around with friends. Rooms, quick-match, teams, duels and shareable results.</p>
        <label>Your name <input id="mp-name" maxlength="${LIMITS.nameLen}" value="${esc(this.name)}" placeholder="Driver"></label>
        <label>Server <input id="mp-server" value="${esc(this.serverUrl)}" placeholder="wss://your-server.example"></label>
        <div class="menu-buttons"><button class="primary big" data-act="mp-connect" ${st === 'connecting' ? 'disabled' : ''}>${st === 'connecting' ? 'Connecting…' : 'Connect'}</button></div>
        <p class="muted">${esc(this.statusText)}</p>
        <p class="muted">No server yet? See "Multiplayer" in the README to run one (it's a small Node app).</p>`;
      chat.innerHTML = '';
      return;
    }
    if (!this.room) {
      main.innerHTML = `<div class="garage-head"><h2>👥 Online lobby</h2><span class="muted">${st === 'open' ? `● ${this.net.rtt} ms` : esc(this.statusText)}</span><button data-act="close">✕</button></div>
        <h3>Quick play</h3><div class="mode-grid">${Object.entries(MODES).map(([id, m]) => `<button class="mode-btn" data-act="mp-quick" data-arg="${id}"><b>${m.icon} ${m.name}</b><small>${m.desc}</small></button>`).join('')}</div>
        <h3>Private room</h3><div class="row-buttons"><select id="mp-create-mode">${Object.entries(MODES).map(([id, m]) => `<option value="${id}">${m.icon} ${m.name}</option>`).join('')}</select>
          <button class="primary" data-act="mp-create" data-arg="private">Create private room</button><button data-act="mp-create" data-arg="public">Create public room</button></div>
        <h3>Join with a code</h3><div class="row-buttons"><input id="mp-code" maxlength="5" placeholder="ABCDE" style="text-transform:uppercase;width:110px"><button class="primary" data-act="mp-join">Join</button></div>
        <h3>Public rooms <button data-act="mp-list">↻</button></h3><div class="room-list">${(this.roomList || []).map((r) => `<div class="room-row"><span>${MODES[r.mode]?.icon || ''} <b>${esc(r.name)}</b> · ${r.players}/${r.max}${r.inEvent ? ' · in event' : ''}</span><button data-act="mp-join-code" data-arg="${esc(r.code)}">Join</button></div>`).join('') || '<p class="muted">No open rooms right now. Quick play creates one!</p>'}</div>
        <div class="menu-buttons"><button data-act="mp-disconnect">Disconnect</button></div>`;
      chat.innerHTML = '';
      return;
    }
    const R = this.room, me = R.players.find((p) => p.id === this.myId) || {};
    const isHost = R.host === this.myId;
    const mode = MODES[R.mode];
    const ev = R.event;
    const teamRule = mode.teams;
    const playerRow = (p) => `<div class="room-row ${p.id === this.myId ? 'me' : ''}">
      <span>${p.id === R.host ? '👑 ' : ''}${p.team ? `<span class="dot" style="background:${TEAMS[p.team].color}"></span>` : ''}<b>${esc(p.name)}</b>
        <small>${esc(p.car.id)}${p.connected ? '' : ' · reconnecting…'}${p.ready ? ' · ✅ ready' : ''}${p.score ? ` · ${p.score} pts` : ''}</small></span>
      <span>${p.id !== this.myId ? `<button data-act="mp-warp" data-arg="${p.id}" title="Warp next to them">🌀 Warp</button><button data-act="mp-duel" data-arg="${p.id}" title="Challenge to a 1v1 race">⚔️ Duel</button>${isHost ? `<button data-act="mp-kick" data-arg="${p.id}" title="Kick">✕</button>` : ''}` : ''}</span></div>`;
    const sel = (id, opts, cur, dis) => `<select data-set="${id}" ${dis ? 'disabled' : ''}>${opts.map(([v, n]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    const lock = !isHost || !!ev;
    main.innerHTML = `<div class="garage-head"><h2>${mode.icon} ${esc(R.name)}</h2><span class="muted">${st === 'open' ? `● ${this.net.rtt} ms` : '⚠ ' + esc(this.statusText)}</span><button data-act="close">✕</button></div>
      <div class="row-buttons"><span class="code">Room code <b>${esc(R.code)}</b></span><button data-act="mp-invite">🔗 Copy invite link</button>${R.public ? '<span class="muted">public</span>' : '<span class="muted">private</span>'}</div>
      ${ev ? `<p class="event-banner">▶ ${esc(ev.title)} — ${ev.phase}${ev.participants.includes(this.myId) ? '' : ' (spectating — keep cruising!)'} ${isHost ? '<button data-act="mp-end">End event</button>' : ''}</p>` : ''}
      <div class="mp-settings">
        <label>Mode ${sel('mode', Object.entries(MODES).map(([k, m]) => [k, `${m.icon} ${m.name}`]), R.mode, lock)}</label>
        ${R.mode === 'race' ? `<label>Track ${sel('layout', LAYOUTS.map((l) => [l.id, l.name]), R.settings.layout, lock)}</label><label>Laps ${sel('laps', [1, 2, 3, 5].map((n) => [n, n]), R.settings.laps, lock)}</label>` : ''}
        ${['race', 'derby', 'pursuit', 'hotpotato'].includes(R.mode) ? `<label>Items ${sel('items', [['true', 'On'], ['false', 'Off']], R.settings.items, lock)}</label>` : ''}
        ${teamRule === 'optional' ? `<label>Teams ${sel('teams', [['false', 'Free for all'], ['true', 'Red vs Blue']], R.settings.teams, lock)}</label>` : ''}
        ${isHost ? `<label>Visibility ${sel('public', [['true', 'Public'], ['false', 'Private']], R.public, !!ev)}</label>` : ''}
      </div>
      <p class="muted">${esc(mode.desc)}</p>
      <div class="room-list">${R.players.map(playerRow).join('')}</div>
      <div class="menu-buttons">
        ${R.mode !== 'cruise' && !ev ? `<button class="${me.ready ? 'sel' : ''}" data-act="mp-ready">${me.ready ? '✅ Ready' : 'Ready up'}</button>` : ''}
        ${R.settings.teams ? Object.entries(TEAMS).map(([k, t]) => `<button data-act="mp-team" data-arg="${k}" ${me.team === k ? 'class="sel"' : ''}><span class="dot" style="background:${t.color}"></span>${t.name}</button>`).join('') : ''}
        ${isHost && R.mode !== 'cruise' && !ev ? '<button class="primary" data-act="mp-start">▶ Start event</button>' : ''}
        <button data-act="mp-leave">Leave room</button>
      </div>`;
    main.querySelectorAll('select[data-set]').forEach((s) => s.addEventListener('change', () => {
      const k = s.dataset.set; let v = s.value;
      if (k === 'laps') v = +v; else if (['items', 'teams', 'public'].includes(k)) v = v === 'true';
      this.net.send({ t: 'settings', settings: { [k]: v } });
    }));
    if (!chat.firstChild) {
      chat.innerHTML = `<div class="mp-chat-log"></div><div class="row-buttons"><input id="mp-chat-input" maxlength="${LIMITS.chatLen}" placeholder="Say something… (Enter)"><button data-act="mp-say">Send</button></div>
        <div class="row-buttons emotes">${EMOTES.map((e) => `<button data-act="mp-emote" data-arg="${e}">${e}</button>`).join('')}</div>`;
      chat.querySelector('#mp-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); this.onAct('mp-say'); } });
    }
    this.renderChat();
  }

  renderChat() {
    if (!this.panelOpen) return;
    const log = this.game.ui.modal.querySelector('.mp-chat-log');
    if (!log) return;
    log.innerHTML = this.chatLog.slice(-40).map((c) => `<div><b style="color:${c.team ? TEAMS[c.team].color : c.id ? '#9dd1ff' : '#ffd23f'}">${esc(c.name)}:</b> ${esc(c.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  onAct(act, arg) {
    const ui = this.game.ui, panel = ui.modal.querySelector('.panel');
    const val = (sel) => panel?.querySelector(sel)?.value?.trim() || '';
    switch (act) {
      case 'mp-connect': {
        this.name = val('#mp-name').slice(0, LIMITS.nameLen) || `Driver${Math.floor(Math.random() * 900 + 100)}`;
        this.serverUrl = val('#mp-server');
        try { localStorage.setItem('vroom.mp.name', this.name); } catch { /* ignore */ }
        if (!/^wss?:\/\//.test(this.serverUrl)) { this.statusText = 'Server address must start with ws:// or wss://'; this.render(); return; }
        if (location.protocol === 'https:' && this.serverUrl.startsWith('ws://')) { this.statusText = 'This page is served over https, so the server must use wss://'; this.render(); return; }
        this.net.connect(this.serverUrl, this.profile());
        break;
      }
      case 'mp-disconnect': this.leave(true); break;
      case 'mp-quick': this.net.send({ t: 'quick', mode: arg }); break;
      case 'mp-create': this.net.send({ t: 'create', mode: val('#mp-create-mode') || 'cruise', public: arg === 'public', name: this.name }); break;
      case 'mp-join': this.net.send({ t: 'join', code: val('#mp-code').toUpperCase() }); break;
      case 'mp-join-code': this.net.send({ t: 'join', code: arg }); break;
      case 'mp-list': this.net.send({ t: 'list' }); break;
      case 'mp-leave': this.net.send({ t: 'leave' }); this.exitRoom(); this.render(); break;
      case 'mp-ready': { const me = this.room.players.find((p) => p.id === this.myId); this.net.send({ t: 'ready', ready: !me?.ready }); break; }
      case 'mp-team': this.net.send({ t: 'team', team: arg }); break;
      case 'mp-start': this.net.send({ t: 'start' }); break;
      case 'mp-end': this.net.send({ t: 'endEvent' }); break;
      case 'mp-kick': this.net.send({ t: 'kick', id: arg }); break;
      case 'mp-warp': this.net.send({ t: 'warp', to: arg }); break;
      case 'mp-duel': this.net.send({ t: 'duel', to: arg }); break;
      case 'mp-duel-yes': case 'mp-duel-no': this.net.send({ t: 'duelReply', from: arg, accept: act === 'mp-duel-yes' }); ui.closeModal(); break;
      case 'mp-say': { const input = panel.querySelector('#mp-chat-input'); const text = input?.value.trim(); if (text) { this.net.send({ t: 'chat', text }); input.value = ''; } break; }
      case 'mp-emote': this.net.send({ t: 'emote', e: arg }); break;
      case 'mp-invite': this.copy(this.inviteLink(), 'Invite link copied — send it to your friends!'); break;
      case 'mp-share': this.share(); break;
      case 'mp-copy-link': this.copy(this.shareInfo?.url, 'Result link copied'); break;
    }
  }

  inviteLink() {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('room', this.room.code);
    u.searchParams.set('server', this.serverUrl);
    return u.toString();
  }

  copy(text, msg) {
    if (!text) return;
    const ok = () => this.game.ui.toast(msg, 'good');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(ok, () => prompt('Copy this:', text));
    else prompt('Copy this:', text);
  }

  leave(forget) {
    this.exitRoom();
    this.net.disconnect(forget);
    this.render();
  }

  exitRoom() {
    this.room = null;
    this.ev = null;
    this.remotes.clear();
    this.setCrates([]);
    this.clearEffects();
    this.game.ui.setActivity(null);
    this.game.ui.setBanner(null);
    this.setCopLights(this.game.car.model, false);
    if (this.bomb) this.bomb.visible = false;
    this.game.setPaused(this.game.ui.isOpen);
  }

  // ------------------------------------------------------------------ network events
  onStatus(s, detail) {
    this.statusText = detail || { connecting: 'Connecting…', open: 'Connected', reconnecting: 'Connection lost — reconnecting…', closed: 'Disconnected', error: 'Could not connect' }[s] || s;
    if (s === 'reconnecting' && this.room) this.game.ui.toast('⚠ Connection lost — reconnecting…', 'bad');
    if (s === 'closed') this.exitRoom();
    this.render();
  }

  onMessage(m) {
    const g = this.game, ui = g.ui;
    switch (m.t) {
      case 'welcome':
        this.myId = m.id;
        if (m.resumed && m.room) ui.toast('✅ Reconnected — you kept your spot!', 'good');
        if (m.room) this.setRoom(m.room);
        else if (this.pendingJoin) { this.net.send({ t: 'join', code: this.pendingJoin }); this.pendingJoin = null; }
        else this.net.send({ t: 'list' });
        this.render();
        break;
      case 'rooms': this.roomList = m.rooms; this.render(); break;
      case 'room': this.setRoom(m.room); break;
      case 'left': this.exitRoom(); this.net.send({ t: 'list' }); this.render(); break;
      case 'kicked': ui.toast(esc(m.msg), 'bad'); this.exitRoom(); this.render(); break;
      case 'error': ui.toast(esc(m.msg), 'bad'); if (m.fatal) { this.statusText = m.msg; this.render(); } break;
      case 'info': ui.toast(esc(m.msg)); break;
      case 'snap': this.remotes.onSnap(m.ts, m.s); break;
      case 'warp':
        g.car.place(m.x, m.z, m.yaw, g.world);
        if (m.reason) ui.toast(`🌀 ${esc(m.reason)}`);
        this.sendState(true);
        break;
      case 'correct': g.car.place(m.x, m.z, m.yaw ?? g.car.yaw, g.world); this.sendState(true); break;
      case 'chat':
        this.chatLog.push(m);
        if (this.chatLog.length > 100) this.chatLog.shift();
        if (this.panelOpen) this.renderChat();
        else ui.toast(`<b>${esc(m.name)}:</b> ${esc(m.text)}`, m.id ? 'info' : 'good', 4);
        break;
      case 'emote': {
        const r = this.remotes.map.get(m.id);
        if (r) { r.emote = m.e; r.emoteUntil = performance.now() + 2500; }
        const who = m.id === this.myId ? 'You' : (this.room?.players.find((p) => p.id === m.id)?.name || '?');
        ui.toast(`${esc(who)} ${esc(m.e)}`, 'info', 2);
        break;
      }
      case 'duelInvite':
        ui.openModal('duel', `<div class="result"><h1>⚔️ Duel!</h1><p><b>${esc(m.name)}</b> challenges you to a 1-lap race on <b>${esc(getLayout(m.layout).name)}</b>.</p>
          <div class="menu-buttons" style="justify-content:center"><button class="primary" data-act="mp-duel-yes" data-arg="${esc(m.from)}">Accept</button><button data-act="mp-duel-no" data-arg="${esc(m.from)}">Decline</button></div></div>`);
        g.audio.chime();
        break;
      case 'pu': this.setCrates(m.list); break;
      case 'effect': this.applyEffect(m); break;
      case 'ev': this.onEvent(m); break;
      case 'results': this.showResults(m.result); break;
    }
  }

  setRoom(room) {
    const g = this.game;
    const wasEvent = this.ev && this.ev.phase;
    const prevRoom = this.room;
    this.room = room;
    this.remotes.sync(room.players, this.myId);
    this.setCrates(room.powerups || []);
    if (!prevRoom) {
      g.ui.toast(`Joined room <b>${esc(room.code)}</b> — ${MODES[room.mode].icon} ${MODES[room.mode].name}`, 'good');
      // cancel any solo activity: online play takes over
      if (g.activities.current) g.activities.end(false, null);
      if (g.missions.runner) g.missions.cancel();
      if (g.racing.active) g.racing.end();
      g.setPaused(g.ui.isOpen); // online the world keeps running even with the panel open
      this.sendState(true);
    }
    const e = room.event;
    if (e) {
      const prev = this.ev && this.ev.mode === e.mode ? this.ev : {};
      this.ev = { ...prev, ...e, extra: { ...(prev.extra || {}), ...e.extra } };
      if (e.mode === 'race' && e.extra.layout) g.motorpark.setLayout(e.extra.layout);
      if (wasEvent === 'countdown' && e.phase === 'running' && this.myEvent) { g.ui.setBanner('GO!'); g.audio.beep(880); setTimeout(() => g.ui.setBanner(null), 700); }
    } else if (this.ev) {
      this.ev = null;
      g.ui.setActivity(null);
      g.ui.setBanner(null);
    }
    this.render();
  }

  onEvent(m) {
    const g = this.game, ui = g.ui, ev = this.ev;
    if (!ev) return;
    const nameOf = (id) => (id === this.myId ? 'You' : this.room.players.find((p) => p.id === id)?.name || '?');
    switch (m.k) {
      case 'progress': ev.progress = m.list; break;
      case 'finished': ui.toast(`🏁 ${esc(m.id === this.myId ? 'You' : m.name)} finished ${ordinal(m.place)} (${formatTime(m.time)})`, m.id === this.myId ? 'good' : 'info'); if (m.id === this.myId) g.audio.chime(); break;
      case 'hp': ev.extra.hp = m.hp; break;
      case 'hit':
        if (m.a === this.myId || m.b === this.myId) {
          const mine = m.a === this.myId ? m.da : m.db, dealt = m.a === this.myId ? m.db : m.da;
          ui.showStunt(`CRUNCH! <b>-${mine}</b> · dealt ${dealt}`);
          g.shake = Math.max(g.shake, 0.4);
        }
        break;
      case 'wreck':
        ui.toast(`💥 ${esc(nameOf(m.id))} ${m.id === this.myId ? 'got' : 'is'} wrecked${m.byName ? ` by ${esc(m.by === this.myId ? 'you' : m.byName)}` : ''}!`, m.by === this.myId ? 'good' : 'info');
        this.boomAt(m.id);
        break;
      case 'busted': ui.toast(`🚓 ${esc(nameOf(m.id))} ${m.id === this.myId ? 'got' : 'was'} busted by ${esc(nameOf(m.by))}!`, m.by === this.myId ? 'good' : 'info'); g.audio.beep(330); break;
      case 'tags': ev.tags = m.tags; break;
      case 'bomb':
        ev.extra.holder = m.id; ev.extra.fuseAt = m.fuseAt;
        if (m.id === this.myId) { ui.setBanner('💣 YOU HAVE THE BOMB!'); setTimeout(() => ui.setBanner(null), 1200); g.audio.beep(220); }
        else if (m.from === this.myId) ui.showStunt('💣 PASSED IT!');
        break;
      case 'boom':
        ev.extra.out = [...(ev.extra.out || []), m.id];
        ui.toast(`💥 BOOM! ${esc(nameOf(m.id))} ${m.id === this.myId ? 'are' : 'is'} out!`, m.id === this.myId ? 'bad' : 'info');
        this.boomAt(m.id);
        break;
    }
  }

  boomAt(id) {
    const g = this.game;
    const pos = id === this.myId ? g.car.pos : this.remotes.map.get(id)?.pos;
    if (!pos) return;
    g.fx.burst('spark', pos.x, pos.y + 1, pos.z, 40, 9);
    g.fx.emit('flash', pos.x, pos.y + 1.5, pos.z);
    for (let i = 0; i < 12; i++) g.fx.emit('smoke', pos.x, pos.y + 1, pos.z, (Math.random() - 0.5) * 4, 2 + Math.random() * 2, (Math.random() - 0.5) * 4, [0.2, 0.2, 0.2]);
    g.audio.crash(25);
    if (id === this.myId) g.shake = 1;
  }

  // ------------------------------------------------------------------ power-up crates & effects
  setCrates(list) {
    const g = this.game, ids = new Set(list.map((c) => c.id));
    for (const [id, c] of this.crates) if (!ids.has(id)) { g.scene.remove(c); this.crates.delete(id); }
    for (const c of list) {
      if (this.crates.has(c.id)) continue;
      const grp = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xaa6600, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }));
      box.position.y = 1.4;
      grp.add(box);
      const cv = document.createElement('canvas'); cv.width = cv.height = 128;
      const ctx = cv.getContext('2d'); ctx.font = '96px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(POWERUPS[c.kind]?.icon || '?', 64, 70);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.scale.set(2, 2, 1); sp.position.y = 3.4; sp.renderOrder = 11;
      grp.add(sp);
      grp.position.set(c.x, g.world.heightAt(c.x, c.z), c.z);
      grp.userData = { box };
      g.scene.add(grp);
      this.crates.set(c.id, grp);
    }
  }

  applyEffect(m) {
    const g = this.game, def = POWERUPS[m.kind];
    if (!def) return;
    const until = performance.now() + (m.duration || 0) * 1000;
    const forMe = m.targets.includes(this.myId);
    g.ui.toast(`${def.icon} <b>${esc(m.by === this.myId ? 'You' : m.name)}</b> grabbed <b>${def.name}</b>!${forMe && m.by !== this.myId ? ' (that affects you!)' : ''}`, 'good', 3);
    g.fx.burst('confetti', g.car.pos.x, g.car.pos.y + 2, g.car.pos.z, forMe ? 30 : 8, 5);
    g.audio.chime();
    for (const id of m.targets) {
      const fx = id === this.myId ? this.fx.me : (this.fx.remote.get(id) || this.fx.remote.set(id, {}).get(id));
      if (['disco', 'giant', 'shield', 'moon', 'slowmo'].includes(m.kind)) fx[m.kind] = until;
    }
    if (!forMe) return;
    const car = g.car;
    if (m.kind === 'nitro') { car.nitro = car.stats.nitroCap; car.boostT = 3; }
    if (m.kind === 'boost') car.boostT = 3;
    if (m.kind === 'bounce') { car.vel.y = 15; car.pos.y += 0.5; car.grounded = false; }
  }

  clearEffects() {
    this.fx.me = {};
    this.fx.remote.clear();
    this.applyCarFx(this.game.car, {}, true);
  }

  // apply ongoing effects (scale, colour, gravity, speed) to a car-like object
  applyCarFx(obj, fx, isMe) {
    const now = performance.now();
    const model = obj.model;
    const giant = fx.giant > now;
    const s = giant ? 1.8 : 1;
    if (model.scale.x !== s) {
      model.scale.setScalar(s);
      if (isMe) {
        const car = obj;
        car.giantBase = car.giantBase || { r: car.radius, h: car.halfLen, mass: car.stats.mass, smash: car.stats.smash };
        car.radius = car.giantBase.r * s; car.halfLen = car.giantBase.h * s;
        car.stats.mass = car.giantBase.mass * (giant ? 3 : 1); car.stats.smash = car.giantBase.smash * (giant ? 3 : 1);
        if (!giant) car.giantBase = null;
      } else { obj.halfLen = obj.def.body.len / 2 * s; obj.r = obj.radius = obj.def.body.wid / 2 * s; obj.mass = obj.def.mass * (giant ? 3 : 1); }
    }
    const pm = model.userData.paintMat;
    if (fx.disco > now) { pm.color.setHSL(((now / 600) + (obj.id ? obj.id.length * 0.2 : 0)) % 1, 0.9, 0.55); fx.wasDisco = true; }
    else if (fx.wasDisco) { pm.color.set(isMe ? this.game.state.setup.paint : obj.paint); fx.wasDisco = false; }
    if (isMe) {
      obj.gravityScale = fx.moon > now ? 0.35 : 1;
      obj.speedMul = fx.slowmo > now ? 0.6 : 1;
    }
    // shield bubble
    const shield = fx.shield > now;
    if (shield && !obj.bubble) {
      obj.bubble = new THREE.Mesh(new THREE.SphereGeometry(3.4, 20, 14), new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.25, depthWrite: false }));
      this.game.scene.add(obj.bubble);
    }
    if (obj.bubble) {
      obj.bubble.visible = shield;
      obj.bubble.position.set(obj.pos.x, obj.pos.y + 1, obj.pos.z);
    }
  }

  setCopLights(model, on) {
    const ud = model.userData;
    if (on && !ud.lightBar) {
      const lb = addLightBar(model, 'police');
      lb.position.set(0, 2.1, 0);
      ud.bodyGroup.add(lb);
    }
    if (ud.lightBar) ud.lightBar.grp.visible = on;
  }

  // ------------------------------------------------------------------ per frame
  sendState(force) {
    const c = this.game.car;
    const fl = (c.drift.active || c.slip > 3 ? FLAG.drift : 0) | (c.nitroOn || c.boostT > 0 ? FLAG.nitro : 0) | (c.braking ? FLAG.brake : 0) | (c.grounded ? 0 : FLAG.air);
    const r = (v) => Math.round(v * 100) / 100;
    this.net.send({ t: 'state', p: [r(c.pos.x), r(c.pos.y), r(c.pos.z)], v: [r(c.vel.x), r(c.vel.y), r(c.vel.z)], yaw: r(c.yaw), fl });
    if (force) this.sendAcc = 0;
  }

  // called by the game after it teleports the player (reset, fast travel)
  afterTeleport(kind) {
    if (!this.inRoom) return;
    const c = this.game.car;
    this.net.send({ t: 'tp', x: c.pos.x, z: c.pos.z, yaw: c.yaw, kind });
    this.sendState(true);
  }

  update(dt) {
    if (!this.room) return;
    const g = this.game, now = this.net.serverNow(), t = performance.now();
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_HZ) { this.sendAcc -= 1 / SEND_HZ; if (this.sendAcc > 0.2) this.sendAcc = 0; this.sendState(); }
    const ev = this.ev;
    // remote cars: interpolate, decorate, bump
    this.remotes.update(dt, now, (r) => this.decorate(r));
    for (const r of this.remotes.bodies()) {
      if (Math.abs(r.pos.x - g.car.pos.x) > 12 || Math.abs(r.pos.z - g.car.pos.z) > 12 || r.connected === false) continue;
      g.car.bump(r);
    }
    // re-send our profile if the player changed car or paint in the garage
    const prof = JSON.stringify(this.profile());
    if (prof !== this.lastProfile) { this.lastProfile = prof; this.net.send({ t: 'profile', ...this.profile() }); }
    for (const r of this.remotes.map.values()) {
      if (r.visible && r.pos.distanceTo(g.car.pos) < 150) g.fx.updateCar(r, dt);
      this.applyCarFx(r, this.fx.remote.get(r.id) || {}, false);
      const cop = ev?.mode === 'pursuit' && ev.extra.roles?.[r.id] === 'cop';
      this.setCopLights(r.model, cop);
      if (cop) flashLightBar(r.model, t / 1000);
    }
    this.applyCarFx(g.car, this.fx.me, true);
    const meCop = ev?.mode === 'pursuit' && ev.extra.roles?.[this.myId] === 'cop';
    this.setCopLights(g.car.model, meCop);
    if (meCop) flashLightBar(g.car.model, t / 1000);
    // crates bob and spin
    for (const c of this.crates.values()) { c.userData.box.rotation.y = t / 500; c.userData.box.position.y = 1.4 + Math.sin(t / 300) * 0.25; }
    // bomb above the holder
    if (ev?.mode === 'hotpotato' && ev.extra.holder && ev.phase === 'running') {
      if (!this.bomb) {
        this.bomb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2200, emissiveIntensity: 0.3 }));
        g.scene.add(this.bomb);
      }
      const hp = ev.extra.holder === this.myId ? g.car.pos : this.remotes.map.get(ev.extra.holder)?.pos;
      this.bomb.visible = !!hp;
      if (hp) {
        this.bomb.position.set(hp.x, hp.y + 4 + Math.sin(t / 120) * 0.15, hp.z);
        const left = (ev.extra.fuseAt - now) / 1000;
        this.bomb.material.emissiveIntensity = left < 5 ? (Math.floor(t / 120) % 2 ? 1.5 : 0.2) : 0.3;
        if (Math.random() < 0.5) g.fx.emit('spark', hp.x, hp.y + 4.8, hp.z, (Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2);
      }
    } else if (this.bomb) this.bomb.visible = false;
    this.hud(now);
  }

  decorate(r) {
    const ev = this.ev;
    const now = performance.now();
    let sub = r.emoteUntil > now ? r.emote : '';
    if (ev && ev.participants.includes(r.id)) {
      if (ev.mode === 'derby') { const hp = ev.extra.hp?.[r.id]; if (hp !== undefined) sub = sub || (hp > 0 ? `❤ ${hp}` : '💀 wrecked'); }
      if (ev.mode === 'pursuit') sub = sub || (ev.extra.roles?.[r.id] === 'cop' ? '🚓 cop' : '💰 robber');
      if (ev.mode === 'hotpotato') sub = sub || ((ev.extra.out || []).includes(r.id) ? '💀 out' : ev.extra.holder === r.id ? '💣 HAS THE BOMB' : '');
      if (ev.mode === 'race' && ev.progress) { const pos = this.racePositions().indexOf(r.id) + 1; if (pos) sub = sub || `P${pos}`; }
    }
    return { sub };
  }

  racePositions() {
    const ev = this.ev, L = getLayout(ev.extra.layout);
    return [...(ev.progress || [])].sort((a, b) => {
      if (a[3] !== null && b[3] !== null) return a[3] - b[3];
      if ((a[3] !== null) !== (b[3] !== null)) return a[3] !== null ? -1 : 1;
      return (b[1] * L.n + b[2]) - (a[1] * L.n + a[2]);
    }).map((p) => p[0]);
  }

  hud(now) {
    const g = this.game, ui = g.ui, ev = this.ev;
    this.target = null;
    if (!ev) return;
    const mine = ev.participants.includes(this.myId);
    if (ev.phase === 'countdown') {
      const s = Math.ceil((ev.startAt - now) / 1000);
      if (mine) ui.setBanner(s > 0 ? String(s) : 'GO!');
      if (s !== this.lastBeep && s >= 0 && mine) { this.lastBeep = s; g.audio.beep(s > 0 ? 440 : 880); }
    }
    const nameOf = (id) => (id === this.myId ? '<b>You</b>' : esc(this.room.players.find((p) => p.id === id)?.name || '?'));
    let body = `<div class="act-title">${MODES[ev.mode].icon} ${esc(ev.title)}</div>`;
    if (!mine) body += '<div class="act-hint">Spectating — keep cruising, or watch the action!</div>';
    if (ev.mode === 'race') {
      const L = getLayout(ev.extra.layout), order = this.racePositions();
      const me = (ev.progress || []).find((p) => p[0] === this.myId);
      if (mine && me) body += `<div class="act-big">P${order.indexOf(this.myId) + 1}<small>/${order.length}</small> · Lap ${Math.min(ev.extra.laps, Math.max(1, me[1] + 1))}/${ev.extra.laps}</div>`;
      body += `<div class="act-hint">${order.slice(0, 5).map((id, i) => `${i + 1}. ${nameOf(id)}`).join(' · ')}</div>`;
      if (mine && ev.phase === 'running') { const p = L.pts[((me?.[2] ?? 0) + 12) % L.n]; this.target = { x: p.x, z: p.z }; }
    } else if (ev.mode === 'derby') {
      const hp = ev.extra.hp || {};
      const left = Math.max(0, (ev.startAt + LIMIT_S.derby * 1000 - now) / 1000);
      body += `<div class="act-big">${formatTime(left)}</div>`;
      if (mine) body += `<div class="mbar good"><span>Your car</span><div><i style="width:${hp[this.myId] ?? 100}%"></i></div></div>`;
      body += `<div class="act-hint">${Object.entries(hp).filter(([id]) => id !== this.myId).map(([id, h]) => `${nameOf(id)} ${h > 0 ? h : '💀'}`).join(' · ')}</div>`;
    } else if (ev.mode === 'pursuit') {
      const roles = ev.extra.roles || {};
      const role = roles[this.myId];
      const left = Math.max(0, (ev.startAt + LIMIT_S.pursuit * 1000 - now) / 1000);
      const release = (ev.extra.releaseAt - now) / 1000;
      body += `<div class="act-big">${formatTime(left)}</div>`;
      if (mine) body += `<div>${role === 'cop' ? '🚓 You are a <b>COP</b> — stay close to robbers to bust them' : '💰 You are a <b>ROBBER</b> — don\'t let the cops stick to you!'}</div>`;
      if (release > 0) body += `<div class="late">Cops released in ${Math.ceil(release)}s</div>`;
      const robbers = Object.entries(roles).filter(([, r]) => r === 'robber').length;
      body += `<div class="act-hint">${robbers} robber${robbers === 1 ? '' : 's'} still free</div>`;
      if (mine && role === 'robber') body += `<div class="mbar bad"><span>BUSTED</span><div><i style="width:${Math.min(100, ((ev.tags || {})[this.myId] || 0) / 1.3 * 100)}%"></i></div></div>`;
      if (mine && role === 'cop') {
        // GPS to the nearest robber
        let best = null, bd = Infinity;
        for (const [id, r] of Object.entries(roles)) { if (r !== 'robber') continue; const rr = this.remotes.map.get(id); if (rr) { const d = rr.pos.distanceTo(g.car.pos); if (d < bd) { bd = d; best = rr; } } }
        this.target = best ? { x: best.pos.x, z: best.pos.z } : null;
      }
    } else if (ev.mode === 'hotpotato') {
      const holder = ev.extra.holder;
      const fuse = Math.max(0, (ev.extra.fuseAt - now) / 1000);
      if (ev.phase === 'running' && holder) {
        body += `<div class="act-big ${fuse < 5 ? 'late' : ''}">💣 ${fuse.toFixed(1)}s</div><div>${holder === this.myId ? '<b class="late">YOU have the bomb — bump someone!</b>' : `${nameOf(holder)} has the bomb`}</div>`;
      }
      if ((ev.extra.out || []).includes(this.myId)) body += '<div class="act-hint">💀 You\'re out — enjoy the show</div>';
    }
    ui.setActivity(body, { quit: false }); // online events are run by the server; leave the room to quit
  }

  targetPoint() {
    if (!this.ev || !this.myEvent || this.ev.phase !== 'running') return null;
    return this.target || null;
  }

  dots() {
    if (!this.room) return [];
    return this.remotes.bodies().map((r) => ({ x: r.pos.x, z: r.pos.z, color: r.team ? TEAMS[r.team].color : '#ff7ad9' }));
  }

  // ------------------------------------------------------------------ results & sharing
  showResults(r, shared = false) {
    const ui = this.game.ui;
    const isMe = (s) => s.id === this.myId && !shared;
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    const rows = r.standings.map((s, i) => `<tr class="${isMe(s) ? 'me' : ''}"><td>${medal(i)}</td><td>${s.team ? `<span class="dot" style="background:${TEAMS[s.team].color}"></span>` : ''}${esc(s.name)}</td>
      <td>${s.time != null ? formatTime(s.time) : s.score != null ? `${s.score} pts` : ''}${s.bestLap ? ` <small>(lap ${formatTime(s.bestLap)})</small>` : ''}</td><td><small>${esc(s.note || '')} ${esc(s.stat || '')}</small></td></tr>`).join('');
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('result', r.id);
    if (this.serverUrl) url.searchParams.set('server', this.serverUrl);
    const lines = [`🏎️ Vroom Vroom — ${r.title}`];
    r.standings.slice(0, 5).forEach((s, i) => lines.push(`${medal(i)} ${s.name}${s.time != null ? ' ' + formatTime(s.time) : s.score != null ? ` ${s.score} pts` : ''}`));
    if (r.teams) lines.push(`🔴 ${r.teams.red} – ${r.teams.blue} 🔵`);
    this.shareInfo = { url: url.toString(), text: lines.join('\n'), title: `Vroom Vroom: ${r.title}` };
    const myPlace = r.standings.findIndex((s) => isMe(s));
    ui.openModal('result', `<div class="result ${myPlace === 0 ? 'gold' : myPlace === 1 ? 'silver' : myPlace === 2 ? 'bronze' : ''}">
      <h1>${shared ? '📣 Shared result' : myPlace === 0 ? 'WINNER!' : r.winner ? esc(r.winner) + ' wins!' : 'Results'}</h1>
       <p>${esc(r.title)}${r.layoutName && !r.title.includes(r.layoutName) ? ` · ${esc(r.layoutName)}` : ''} · ${new Date(r.at).toLocaleString()}</p>
      ${r.teams ? `<p class="teams-score"><span style="color:${TEAMS.red.color}">Red ${r.teams.red}</span> – <span style="color:${TEAMS.blue.color}">${r.teams.blue} Blue</span></p>` : ''}
      <table class="standings">${rows}</table>
      <div class="menu-buttons" style="justify-content:center"><button class="primary" data-act="mp-share">📤 Share result</button><button data-act="mp-copy-link">🔗 Copy link</button><button data-act="close">${shared ? 'Play!' : 'Continue'}</button></div></div>`);
    if (!shared) this.game.audio.chime();
  }

  async share() {
    const s = this.shareInfo;
    if (!s) return;
    if (navigator.share) { try { await navigator.share({ title: s.title, text: s.text, url: s.url }); return; } catch { /* cancelled */ } }
    this.copy(`${s.text}\n${s.url}`, 'Result copied — paste it anywhere!');
  }
}

function ordinal(n) { return n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'); }
