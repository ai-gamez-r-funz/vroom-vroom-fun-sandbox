// Mission manager: offers jobs while you drive (accept or ignore), the Job Board,
// the Forge designer tab, story missions, rewards and persistence.
import { MissionForge, TEMPLATES, DIRECTOR_RULES, MISSION_SCHEMA } from './forge.js';
import { MissionRunner } from './engine.js';
import { AUTHORED } from './authored.js';
import { formatMoney, formatTime } from '../util.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class MissionManager {
  constructor(game) {
    this.game = game;
    this.forge = new MissionForge(game);
    this.runner = null;
    this.offer = null;
    this.offerTimer = 20; // first offer comes fairly soon
    this.recent = [];
    this.board = [];
    this.boardTime = -1e9;
    this.tab = 'board';
    this.forgeSpec = null;
    this.forgeType = 'taxi';
    this.forgeDiff = 0.4;
    const d = game.state.data;
    d.missions = d.missions || { done: {}, failed: 0, streak: 0, bestStreak: 0, story: [] };
    this.offerEl = document.getElementById('offer');
    this.offerEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-offer]');
      if (b) b.dataset.offer === 'yes' ? this.acceptOffer() : this.declineOffer();
    });
  }

  get data() { return this.game.state.data.missions; }
  get streak() { return this.data.streak; }
  get active() { return !!this.runner; }
  get frozen() { return !!(this.runner && this.runner.frozen); }
  targetPoint() { return this.runner ? this.runner.target() : null; }

  // ------------------------------------------------------------------ spec preparation
  resolvePoint(p) {
    if (p && p.place) {
      const lm = this.game.places.landmarks.find((l) => l.name === p.place);
      if (!lm) throw new Error(`Unknown place "${p.place}"`);
      return { ...lm, ...p, x: lm.x, z: lm.z, name: p.name || lm.name };
    }
    return p;
  }

  prepare(raw) {
    const spec = JSON.parse(JSON.stringify(raw));
    const car = this.game.car;
    spec.start = spec.start || { x: car.pos.x, z: car.pos.z, yaw: car.yaw };
    spec.reward = spec.reward || { money: 1000, xp: 150 };
    spec.difficulty = spec.difficulty ?? 0.4;
    spec.icon = spec.icon || TEMPLATES[spec.type]?.icon || '★';
    const ctx = this.forge.context(spec.seed || 1, { origin: spec.start });
    for (const s of spec.stages) {
      if (s.to) s.to = this.resolvePoint(s.to);
      if (s.dest) s.dest = this.resolvePoint(s.dest);
      if (s.points) s.points = s.points.map((p) => this.resolvePoint(p));
      if (s.spawn === 'near') { const n = ctx.nodeAround(spec.start, 120, 250); s.spawn = { x: n.x, z: n.z, yaw: 0 }; }
      if (s.spawn === 'beside') s.spawn = { x: spec.start.x + Math.cos(spec.start.yaw) * 5, z: spec.start.z - Math.sin(spec.start.yaw) * 5, yaw: spec.start.yaw };
      if (s.type === 'goto') { s.radius = s.radius || 10; }
    }
    return spec;
  }

  start(raw, { teleport = false } = {}) {
    const g = this.game;
    if (this.runner) this.runner.dispose();
    if (g.activities.current) g.activities.end(false, null);
    let spec;
    try { spec = this.prepare(raw); } catch (e) { g.ui.toast(`Mission error: ${esc(e.message)}`, 'bad'); return false; }
    if (teleport && spec.start) g.car.place(spec.start.x, spec.start.z, spec.start.yaw || 0, g.world);
    this.offer = null;
    this.renderOffer();
    this.lastSpec = spec;
    this.runner = new MissionRunner(g, spec);
    this.recent = [spec.type, ...this.recent].slice(0, 2);
    g.audio.beep(660);
    return true;
  }

  cancel() {
    if (this.runner) this.runner.fail('Mission abandoned.');
  }

  onFinish(runner, ok) {
    const g = this.game, sp = runner.spec, d = this.data;
    this.runner.dispose();
    this.runner = null;
    g.ui.setActivity(null);
    g.ui.setBanner(null);
    this.offerTimer = DIRECTOR_RULES.offerEvery[0];
    if (ok) {
      d.streak++;
      d.bestStreak = Math.max(d.bestStreak, d.streak);
      d.done[sp.type] = (d.done[sp.type] || 0) + 1;
      if (sp.id && sp.id.startsWith('story-') && !d.story.includes(sp.id)) d.story.push(sp.id);
      const r = runner.computeReward();
      g.reward(r.money, r.xp, null);
      g.ui.showResult(r.medal ? r.medal.toUpperCase() : 'COMPLETE!', `${sp.icon} ${esc(sp.title)}${runner.bonusNote ? `<br><span class="good">${esc(runner.bonusNote)}</span>` : ''}
        <br>Time <b>${formatTime(runner.elapsed)}</b><br>${r.notes.map(esc).join(' · ')}<br>Reward <b>${formatMoney(r.money)}</b> · ${r.xp} XP
        ${d.streak >= 2 ? `<br>🔥 Job streak: ${d.streak}` : ''}`, r.medal || 'gold');
    } else {
      d.failed++;
      d.streak = 0;
      g.state.changed();
      g.ui.openModal('result', `<div class="result"><h1 style="color:#ff5a5a">FAILED</h1><p>${sp.icon} ${esc(sp.title)}<br>${esc(runner.failReason)}</p>
        <div class="menu-buttons" style="justify-content:center"><button class="primary" data-act="m-retry">Retry</button><button data-act="close">Continue</button></div></div>`);
    }
    this.board = []; // fresh jobs after each mission
  }

  onCarEvent(e) { if (this.runner) this.runner.onCarEvent(e); }

  // ------------------------------------------------------------------ per frame
  update(dt, input) {
    const g = this.game;
    if (this.runner) {
      if (input.cancel) { this.cancel(); return; }
      this.runner.update(dt);
      return;
    }
    // Offers only during free roam
    if (g.activities.current) { if (this.offer) { this.offer = null; this.renderOffer(); } return; }
    if (this.offer) {
      this.offer.t -= dt;
      if (input.accept) { this.acceptOffer(); return; }
      if (input.decline || this.offer.t <= 0) { this.declineOffer(); return; }
      this.renderOfferTimer();
    } else if (g.state.data.settings.offers !== false) {
      this.offerTimer -= dt * (g.car.speed > 3 ? 1 : 0.4);
      if (this.offerTimer <= 0) this.makeOffer();
    }
  }

  makeOffer() {
    const [a, b] = DIRECTOR_RULES.offerEvery;
    this.offerTimer = a + Math.random() * (b - a);
    const { type, reasons } = this.forge.pickType(this.recent);
    let spec;
    try { spec = this.forge.generate(type); } catch (e) { console.warn('forge failed', e); return; }
    this.offer = { spec, reasons, t: DIRECTOR_RULES.offerLifetime };
    this.game.audio.tone(988, 0.12, 'sine', 0.12); this.game.audio.tone(1318, 0.18, 'sine', 0.12, 0.14);
    this.renderOffer();
  }

  acceptOffer() {
    if (!this.offer) return;
    const spec = this.offer.spec;
    spec.start = { x: this.game.car.pos.x, z: this.game.car.pos.z, yaw: this.game.car.yaw };
    this.start(spec);
  }

  declineOffer() {
    this.offer = null;
    this.renderOffer();
  }

  renderOffer() {
    const o = this.offer, el = this.offerEl;
    if (!o) { el.style.display = 'none'; el.innerHTML = ''; return; }
    const s = o.spec;
    el.innerHTML = `<div class="offer-head">📞 Incoming job · <b>${esc(s.giver)}</b></div>
      <div class="offer-title">${s.icon} ${esc(s.title)}</div>
      <div class="offer-desc">${esc(s.desc)}</div>
      <div class="offer-meta">${formatMoney(s.reward.money)}+ · ${s.timeLimit ? formatTime(s.timeLimit) + ' limit' : 'untimed'} · ${'★'.repeat(1 + Math.round(s.difficulty * 4))}${o.reasons.length ? ` · <i>${esc(o.reasons.join(', '))}</i>` : ''}</div>
      <div class="offer-btns"><button data-offer="yes" class="primary"><kbd>Y</kbd> Accept</button><button data-offer="no"><kbd>N</kbd> Ignore</button></div>
      <div class="offer-timer"><i></i></div>`;
    el.style.display = 'block';
    this.renderOfferTimer();
  }

  renderOfferTimer() {
    const i = this.offerEl.querySelector('.offer-timer i');
    if (i && this.offer) i.style.width = `${(this.offer.t / DIRECTOR_RULES.offerLifetime) * 100}%`;
  }

  // ------------------------------------------------------------------ Job board / Forge UI
  refreshBoard(force = false) {
    if (!force && this.board.length && performance.now() - this.boardTime < 120000) return;
    this.boardTime = performance.now();
    this.board = [];
    const used = [];
    for (let i = 0; i < DIRECTOR_RULES.boardSize; i++) {
      const { type, reasons } = this.forge.pickType(this.recent, used);
      used.push(type);
      try { this.board.push({ spec: this.forge.generate(type), reasons }); } catch (e) { console.warn(e); }
    }
  }

  renderBoard() {
    const g = this.game, ui = g.ui;
    const panel = ui.modal.querySelector('.panel');
    if (!panel) return;
    const tabs = [['board', 'Job Board'], ['story', 'Story Jobs'], ['forge', 'Mission Forge'], ['rules', 'Director Rules']];
    let body = '';
    const card = (s, extra, act, arg) => `<div class="card mcard"><div class="cls">${s.icon} ${esc(TEMPLATES[s.type]?.name || s.type)} · ${'★'.repeat(1 + Math.round((s.difficulty ?? 0.4) * 4))}</div>
      <h3>${esc(s.title)}</h3><div class="specs">From ${esc(s.giver)}</div><p>${esc(s.desc)}</p>
      <div class="specs">${formatMoney(s.reward.money)}+ · ${s.timeLimit ? formatTime(s.timeLimit) + ' limit' : s.par ? 'gold ' + formatTime(s.par) : 'untimed'}${extra || ''}</div>
      <button class="primary" data-act="${act}" data-arg="${arg}">Start</button></div>`;
    if (this.tab === 'board') {
      this.refreshBoard();
      body = `<p class="muted">Jobs picked for you by the Director based on where you are, what you drive, the weather and time of day.</p>
        <div class="cards">${this.board.map((b, i) => card(b.spec, b.reasons.length ? `<br><i>${esc(b.reasons.join(', '))}</i>` : '', 'm-board', i)).join('')}</div>
        <div class="menu-buttons"><button data-act="m-reroll">🎲 New jobs</button>
        <button data-act="m-offers">Random offers while driving: ${g.state.data.settings.offers === false ? 'Off' : 'On'}</button></div>
        <p class="muted">Jobs completed: ${Object.values(this.data.done).reduce((a, b) => a + b, 0)} · Streak ${this.data.streak} (best ${this.data.bestStreak})</p>`;
    } else if (this.tab === 'story') {
      body = `<div class="cards">${AUTHORED.map((s) => {
        const done = this.data.story.includes(s.id);
        const lock = g.state.level < (s.minLevel || 1);
        return lock ? `<div class="card mcard"><div class="cls">${s.icon} Story</div><h3>${esc(s.title)}</h3><p>Reach level ${s.minLevel} to unlock.</p><button disabled>🔒</button></div>`
          : card(s, done ? ' · ✅ done' : '', 'm-story', s.id);
      }).join('')}</div>`;
    } else if (this.tab === 'forge') {
      const s = this.forgeSpec;
      body = `<div class="forge">
        <div class="forge-controls">
          <label>Type <select id="forge-type">${Object.entries(TEMPLATES).map(([id, t]) => `<option value="${id}" ${id === this.forgeType ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('')}</select></label>
          <label>Difficulty <input id="forge-diff" type="range" min="0" max="1" step="0.05" value="${this.forgeDiff}"></label>
          <label>Seed <input id="forge-seed" type="number" value="${s ? s.seed : Math.floor(Math.random() * 1e6)}" style="width:110px"></label>
          <button data-act="m-forge-gen" class="primary">⚒ Forge</button><button data-act="m-forge-rand">🎲 Random seed</button>
        </div>
        <p class="muted">${esc(TEMPLATES[this.forgeType].blurb)} Missions are generated from your current position, so the same seed in the same spot gives the same job.</p>
        ${s ? `<div class="forge-preview"><h3>${s.icon} ${esc(s.title)}</h3><p>${esc(s.desc)}</p>
          <ol>${s.stages.map((st) => `<li><b>${st.type}</b> — ${esc(st.text)}</li>`).join('')}</ol>
          <div class="specs">${formatMoney(s.reward.money)} · ${s.timeLimit ? formatTime(s.timeLimit) : 'untimed'} · difficulty ${s.difficulty}</div></div>` : ''}
        <textarea id="forge-json" spellcheck="false" placeholder="Forge a mission, or paste mission JSON here">${s ? esc(JSON.stringify(s, null, 2)) : ''}</textarea>
        <div class="menu-buttons"><button class="primary" data-act="m-forge-start">▶ Play this JSON</button><button data-act="m-forge-copy">📋 Copy JSON</button><button data-act="m-forge-schema">Show schema</button></div>
      </div>`;
    } else if (this.tab === 'rules') {
      const { w, ctx } = this.forge.weights(this.recent);
      const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
      body = `<p class="muted">The Director offers a job every ${DIRECTOR_RULES.offerEvery[0]}–${DIRECTOR_RULES.offerEvery[1]} s of free driving; offers expire after ${DIRECTOR_RULES.offerLifetime} s.
        Each rule that matches multiplies the chance of some job types. Edit <code>DIRECTOR_RULES</code> in <code>src/missions/forge.js</code> to tune it.</p>
        <div class="split"><div><h3>Rules</h3>${DIRECTOR_RULES.rules.map((r) => {
          const on = r.when(ctx);
          const boost = typeof r.boost === 'function' ? r.boost(ctx) : r.boost;
          return `<div class="rule ${on ? 'on' : ''}"><b>${on ? '●' : '○'} ${esc(r.name)}</b> <small>${Object.entries(boost).map(([k, v]) => `${k}×${v}`).join(' ') || '—'}</small></div>`;
        }).join('')}</div>
        <div><h3>Right now</h3><div class="specs">${esc(ctx.region)} · ${esc(ctx.cls)} · ${ctx.night ? 'night' : 'day'} · ${esc(ctx.weather)} · level ${ctx.level}</div>
        <div class="bars">${Object.entries(w).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="bar"><span>${TEMPLATES[k].icon} ${k}</span><div class="track"><div class="fill" style="width:${(v / total) * 100}%"></div></div></div>`).join('')}</div></div></div>`;
    }
    panel.innerHTML = `<div class="garage-head"><h2>Jobs</h2><div class="money">${formatMoney(g.state.money)}</div><button data-act="close">✕</button></div>
      <div class="tabs">${tabs.map(([id, n]) => `<button class="${this.tab === id ? 'sel' : ''}" data-act="m-tab" data-arg="${id}">${n}</button>`).join('')}</div>
      <div class="garage-body">${body}</div>`;
    const ft = panel.querySelector('#forge-type');
    if (ft) ft.addEventListener('change', () => { this.forgeType = ft.value; this.renderBoard(); });
    const fd = panel.querySelector('#forge-diff');
    if (fd) fd.addEventListener('input', () => { this.forgeDiff = +fd.value; });
  }

  onAct(act, arg) {
    const g = this.game, ui = g.ui;
    const panel = ui.modal.querySelector('.panel');
    switch (act) {
      case 'm-tab': this.tab = arg; this.renderBoard(); break;
      case 'm-board': { const b = this.board[+arg]; if (b) { ui.closeModal(); b.spec.start = null; this.start(b.spec); } break; }
      case 'm-reroll': this.refreshBoard(true); this.renderBoard(); break;
      case 'm-offers': g.state.data.settings.offers = g.state.data.settings.offers === false; g.state.changed(); this.renderBoard(); break;
      case 'm-story': { const s = AUTHORED.find((x) => x.id === arg); ui.closeModal(); this.start(s); break; }
      case 'm-retry': ui.closeModal(); if (this.lastSpec) this.start(this.lastSpec, { teleport: true }); break;
      case 'm-forge-rand': panel.querySelector('#forge-seed').value = Math.floor(Math.random() * 1e6); // fallthrough
      // eslint-disable-next-line no-fallthrough
      case 'm-forge-gen': {
        const seed = +panel.querySelector('#forge-seed').value || 1;
        try { this.forgeSpec = this.forge.generate(this.forgeType, { seed, difficulty: this.forgeDiff }); } catch (e) { ui.toast('Forge error: ' + esc(e.message), 'bad'); }
        this.renderBoard();
        break;
      }
      case 'm-forge-start': {
        const txt = panel.querySelector('#forge-json').value;
        let spec;
        try { spec = JSON.parse(txt); } catch (e) { ui.toast('That JSON does not parse: ' + esc(e.message), 'bad'); break; }
        if (!spec.stages || !spec.stages.length) { ui.toast('Mission needs at least one stage', 'bad'); break; }
        ui.closeModal();
        this.start(spec);
        break;
      }
      case 'm-forge-copy': {
        const txt = panel.querySelector('#forge-json').value;
        navigator.clipboard?.writeText(txt).then(() => ui.toast('Mission JSON copied'), () => ui.toast('Copy failed — select the text manually', 'bad'));
        break;
      }
      case 'm-forge-schema': panel.querySelector('#forge-json').value = MISSION_SCHEMA; break;
    }
  }
}
