// DOM-based HUD, minimap, garage, world map and menus.
import { VEHICLES, UPGRADES, TIRES, PAINTS, FINISHES, computeStats, ratings, vehicleById } from './vehicles.js';
import { PROPERTIES } from './activities.js';
import { WEATHERS } from './environment.js';
import { SURF_NAMES, WORLD_HALF } from './world.js';
import { GameState } from './state.js';
import { defaultSetup } from './state.js';
import { formatMoney, formatTime } from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function unlockLevel(def) { return Math.floor(def.price / 12000) + 1; }

export class UI {
  constructor(game) {
    this.game = game;
    this.root = $('#ui');
    this.hud = $('#hud');
    this.toasts = $('#toasts');
    this.prompt = $('#prompt');
    this.activity = $('#activity');
    this.banner = $('#banner');
    this.stunt = $('#stunt');
    this.modal = $('#modal');
    this.minimap = $('#minimap');
    this.mctx = this.minimap.getContext('2d');
    this.garageTab = 'cars';
    this.openPanel = null;
    this.stuntTimer = 0;
    game.state.onChange(() => this.updateTop());
    this.updateTop();
    this.modal.addEventListener('click', (e) => this.onModalClick(e));
    // Any element with data-key acts like pressing that key (touch menu bar, Quit buttons...)
    document.addEventListener('click', (e) => {
      const k = e.target.closest('[data-key]');
      if (k) { e.preventDefault(); game.input.pressed.add(k.dataset.key); }
      const d = e.target.closest('[data-dismiss]');
      if (d) d.parentElement.remove();
    });
    // Activity panel: tap the title to collapse it on small screens
    this.activity.addEventListener('click', (e) => {
      if (!e.target.closest('.act-quit')) this.activity.classList.toggle('mini');
    });
    this.modal.addEventListener('input', (e) => this.onModalInput(e));
  }

  // ---------------------------------------------------------------- HUD
  updateTop() {
    const s = this.game.state;
    const lvl = s.level;
    const a = GameState.xpFor(lvl), b = GameState.xpFor(lvl + 1);
    $('#money').textContent = formatMoney(s.money);
    $('#level').textContent = `LVL ${lvl}`;
    $('#xpbar').style.width = `${((s.data.xp - a) / (b - a)) * 100}%`;
  }

  updateHud(car, env, world) {
    const kmh = Math.round(car.speed * 3.6);
    $('#speed').textContent = kmh;
    $('#gear').textContent = car.vel.x * Math.sin(car.yaw) + car.vel.z * Math.cos(car.yaw) < -0.5 ? 'R' : car.speed < 0.5 ? 'N' : car.gear || 1;
    $('#rpmbar').style.width = `${(car.rpm || 0) * 100}%`;
    $('#nitrobar').style.width = `${(car.nitro / car.stats.nitroCap) * 100}%`;
    $('#nitrobar').classList.toggle('on', car.nitroOn);
    $('#clock').textContent = env.timeString();
    $('#weather').textContent = WEATHERS[env.weatherId].name + (env.snowMix > 0.5 && env.weatherId !== 'snow' && env.cur.rain > 0.05 ? ' (snow)' : '');
    $('#surface').textContent = car.grounded ? SURF_NAMES[car.surface] : 'Airborne!';
    // stunt popups (drift in progress)
    if (car.drift.active && car.drift.score > 20) {
      this.stunt.innerHTML = `DRIFT <b>${Math.round(car.drift.score)}</b> <small>x${car.drift.mult.toFixed(1)}</small>`;
      this.stunt.classList.add('show');
      this.stuntTimer = 1.2;
    } else if (!car.grounded && car.airTime > 0.5) {
      this.stunt.innerHTML = `AIR <b>${car.airTime.toFixed(1)}s</b>`;
      this.stunt.classList.add('show');
      this.stuntTimer = 1.2;
    }
  }

  tick(dt) {
    if (this.stuntTimer > 0) {
      this.stuntTimer -= dt;
      if (this.stuntTimer <= 0) this.stunt.classList.remove('show');
    }
  }

  showStunt(html) {
    this.stunt.innerHTML = html;
    this.stunt.classList.add('show');
    this.stuntTimer = 2;
  }

  toast(html, kind = 'info', secs = 3.5) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    this.toasts.appendChild(el);
    setTimeout(() => el.classList.add('out'), secs * 1000);
    setTimeout(() => el.remove(), secs * 1000 + 600);
    while (this.toasts.children.length > 5) this.toasts.firstChild.remove();
  }

  setPrompt(html) {
    if (html === this._prompt) return;
    this._prompt = html;
    this.prompt.innerHTML = html || '';
    this.prompt.style.display = html ? 'block' : 'none';
  }
  setActivity(html) {
    // Only the body is re-rendered each frame; the Quit button stays put so taps on it register.
    if (!this.actBody) {
      this.activity.innerHTML = '<div class="act-body"></div><button class="act-quit" data-key="Backspace">✕ Quit</button>';
      this.actBody = this.activity.firstChild;
    }
    if (html && html !== this._actHtml) this.actBody.innerHTML = html;
    this._actHtml = html;
    this.activity.style.display = html ? 'block' : 'none';
  }
  setBanner(text) {
    this.banner.textContent = text || '';
    this.banner.style.display = text ? 'block' : 'none';
  }

  showResult(title, body, medal) {
    this.openModal('result', `<div class="result ${medal}"><h1>${title}</h1><p>${body}</p><button data-act="close" class="primary">Continue</button></div>`);
  }

  // ---------------------------------------------------------------- minimap
  drawMinimap(car, activities) {
    const g = this.mctx, W = this.minimap.width;
    const world = this.game.world;
    const mapC = world.mapCanvas;
    const scale = mapC.width / (WORLD_HALF * 2); // px per metre in map canvas
    const viewR = 160 + Math.min(200, car.speed * 3); // metres
    g.save();
    g.clearRect(0, 0, W, W);
    g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#223'; g.fillRect(0, 0, W, W);
    g.translate(W / 2, W / 2);
    g.rotate(Math.PI + car.yaw);
    const k = W / 2 / viewR;
    g.scale(k / scale, k / scale);
    const cx = (car.pos.x + WORLD_HALF) * scale, cz = (car.pos.z + WORLD_HALF) * scale;
    g.drawImage(mapC, -cx, -cz);
    g.restore();
    // markers (in rotated space)
    const toScreen = (x, z) => {
      const dx = x - car.pos.x, dz = z - car.pos.z;
      const a = Math.PI + car.yaw;
      const rx = dx * Math.cos(a) - dz * Math.sin(a);
      const rz = dx * Math.sin(a) + dz * Math.cos(a);
      return [W / 2 + rx * k, W / 2 + rz * k];
    };
    const dot = (x, z, color, r = 4, clampEdge = false) => {
      let [sx, sy] = toScreen(x, z);
      const dx = sx - W / 2, dy = sy - W / 2, d = Math.hypot(dx, dy);
      if (d > W / 2 - 8) { if (!clampEdge) return; sx = W / 2 + (dx / d) * (W / 2 - 8); sy = W / 2 + (dy / d) * (W / 2 - 8); }
      g.fillStyle = color; g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill(); g.stroke();
    };
    if (Math.hypot(car.pos.x - 0, car.pos.z - 860) < viewR + 500) this.game.motorpark.drawMinimap(g, toScreen);
    const gps = this.game.gps;
    if (gps && gps.length > 1) {
      g.strokeStyle = 'rgba(80,200,255,0.9)'; g.lineWidth = 4; g.lineJoin = 'round';
      g.beginPath();
      gps.forEach((p, i) => { const [sx, sy] = toScreen(p.x, p.z); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
      g.stroke();
    }
    const cols = { race: '#ffd23f', challenge: '#ff4fd8', delivery: '#3fff8a', property: '#3fa9ff', motorpark: '#ff3b3b', arena: '#ff8a00' };
    for (const a of activities.list) dot(a.x, a.z, a.type === 'property' && a.owned ? '#9fd4ff' : cols[a.type]);
    for (const d of this.game.extraDots()) dot(d.x, d.z, d.color, 4);
    const tp = this.game.currentTarget();
    if (tp) dot(tp.x, tp.z, '#fff', 6, true);
    // player arrow
    g.fillStyle = '#fff'; g.strokeStyle = '#000';
    g.beginPath(); g.moveTo(W / 2, W / 2 - 9); g.lineTo(W / 2 + 6, W / 2 + 7); g.lineTo(W / 2, W / 2 + 3); g.lineTo(W / 2 - 6, W / 2 + 7); g.closePath(); g.fill(); g.stroke();
    // north indicator
    const [nx, ny] = toScreen(car.pos.x, car.pos.z - viewR * 0.85);
    g.fillStyle = '#fff'; g.font = 'bold 13px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', nx, ny);
  }

  // ---------------------------------------------------------------- modal framework
  get isOpen() { return !!this.openPanel; }

  openModal(name, html) {
    this.openPanel = name;
    this.modal.innerHTML = `<div class="panel ${name}">${html}</div>`;
    this.modal.style.display = 'flex';
    document.body.classList.add('modal-open');
    this.game.setPaused(true);
  }

  closeModal() {
    this.openPanel = null;
    this.modal.style.display = 'none';
    document.body.classList.remove('modal-open');
    this.modal.innerHTML = '';
    this.game.setPaused(false);
  }

  onModalInput(e) {
    const t = e.target;
    if (t.dataset.set === 'volume') { this.game.state.data.settings.volume = +t.value; this.game.audio.setVolume(+t.value); this.game.state.save(); }
  }

  onModalClick(e) {
    const el = e.target.closest('[data-act]');
    if (e.target === this.modal && this.openPanel !== 'title') { this.closeModal(); return; }
    if (!el) return;
    const g = this.game, st = g.state;
    const act = el.dataset.act, arg = el.dataset.arg;
    switch (act) {
      case 'close': this.closeModal(); break;
      case 'start': this.closeModal(); g.begin(); break;
      case 'tab': this.garageTab = arg; this.renderGarage(); break;
      case 'buycar': {
        const def = vehicleById(arg);
        if (st.level < unlockLevel(def)) { this.toast(`Reach level ${unlockLevel(def)} first`, 'bad'); break; }
        if (!st.spend(def.price)) { this.toast('Not enough money!', 'bad'); break; }
        st.data.garage[def.id] = defaultSetup(def);
        st.data.current = def.id;
        st.changed();
        g.applyVehicle();
        g.audio.cash();
        this.toast(`Bought the ${def.name}!`, 'good');
        this.renderGarage();
        break;
      }
      case 'drive': st.data.current = arg; st.changed(); g.applyVehicle(); this.renderGarage(); break;
      case 'upgrade': {
        const setup = st.setup;
        const lvl = setup.upgrades[arg] || 0;
        const next = UPGRADES[arg].levels[lvl + 1];
        if (!next) break;
        if (!st.spend(next.cost)) { this.toast('Not enough money!', 'bad'); break; }
        setup.upgrades[arg] = lvl + 1;
        st.changed(); g.applyVehicle(true); g.audio.cash();
        this.renderGarage();
        break;
      }
      case 'downgrade': {
        const setup = st.setup;
        const lvl = setup.upgrades[arg] || 0;
        if (lvl > 0) { setup.upgrades[arg] = lvl - 1; st.changed(); g.applyVehicle(true); this.renderGarage(); }
        break;
      }
      case 'tires': {
        const setup = st.setup;
        const tire = TIRES.find((t) => t.id === arg);
        setup.ownedTires = setup.ownedTires || ['street'];
        if (!setup.ownedTires.includes(arg)) {
          if (!st.spend(tire.cost)) { this.toast('Not enough money!', 'bad'); break; }
          setup.ownedTires.push(arg);
          g.audio.cash();
        }
        setup.tires = arg; st.changed(); g.applyVehicle(true); this.renderGarage();
        break;
      }
      case 'paint': st.setup.paint = arg; st.changed(); g.car.setPaint(arg, st.setup.finish); this.renderGarage(); break;
      case 'finish': {
        const setup = st.setup;
        const f = FINISHES.find((x) => x.id === arg);
        setup.ownedFinishes = setup.ownedFinishes || ['gloss'];
        if (!setup.ownedFinishes.includes(arg)) {
          if (!st.spend(f.cost)) { this.toast('Not enough money!', 'bad'); break; }
          setup.ownedFinishes.push(arg);
        }
        setup.finish = arg; st.changed(); g.car.setPaint(setup.paint, arg); this.renderGarage();
        break;
      }
      case 'buyprop': {
        const p = PROPERTIES.find((x) => x.id === arg);
        if (g.activities.buyProperty(p)) { if (this.openPanel === 'garage') this.renderGarage(); else this.closeModal(); }
        break;
      }
      case 'travel': {
        const p = PROPERTIES.find((x) => x.id === arg);
        g.activities.current && g.activities.end(false, 'Event abandoned');
        g.car.place(p.mx + Math.sin(p.yaw) * 6, p.mz + Math.cos(p.yaw) * 6, p.yaw, g.world);
        this.closeModal();
        this.toast(`Travelled to ${p.name}`);
        break;
      }
      case 'weather': g.env.setWeather(arg === 'auto' ? g.env.weatherId : arg, arg === 'auto'); this.renderSettings(); break;
      case 'time': g.env.time = +arg; break;
      case 'traffic': st.data.settings.traffic = !st.data.settings.traffic; st.changed(); this.renderSettings(); break;
      case 'quality': st.data.settings.quality = arg; st.changed(); g.applyQuality(); this.renderSettings(); break;
      case 'resetsave': if (confirm('Erase all progress?')) { st.reset(); location.reload(); } break;
      case 'garage': this.openGarage(); break;
      case 'settings': this.openSettings(); break;
      case 'help': this.openHelp(); break;
      case 'map': this.openMap(); break;
      case 'clearwp': g.waypoint = null; this.renderMap(); break;
      case 'jobs': this.openModal('jobs', ''); g.missions.renderBoard(); break;
      default:
        if (act.startsWith('m-')) g.missions.onAct(act, arg, el);
        else if (act.startsWith('r-') || act.startsWith('d-')) g.racing.onAct(act, arg, el);
    }
  }

  // ---------------------------------------------------------------- title / pause / help
  openTitle() {
    const hasSave = this.game.state.data.stats.distance > 10;
    this.openModal('title', `
      <div class="title-logo">VROOM<span>VROOM</span></div>
      <p class="subtitle">Open-world arcade driving · races · stunts · deliveries</p>
      <button class="primary big" data-act="start">${hasSave ? 'Continue' : 'Start driving'}</button>
      <div class="title-help">${this.controlsHtml()}</div>`);
  }

  controlsHtml() {
    return `<table class="controls">
      <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows</td><td>Drive &amp; steer (S = brake / reverse)</td></tr>
      <tr><td><kbd>Space</kbd></td><td>Handbrake / drift</td></tr>
      <tr><td><kbd>Shift</kbd></td><td>Nitro</td></tr>
      <tr><td><kbd>E</kbd></td><td>Start event / enter garage at markers</td></tr>
      <tr><td><kbd>G</kbd></td><td>Garage (buy cars, upgrades, paint)</td></tr>
      <tr><td><kbd>J</kbd></td><td>Job board, story jobs &amp; Mission Forge</td></tr>
      <tr><td><kbd>Y</kbd> / <kbd>N</kbd></td><td>Accept / ignore a job offer that pops up while driving</td></tr>
      <tr><td><kbd>M</kbd></td><td>World map, waypoints &amp; fast travel</td></tr>
      <tr><td><kbd>C</kbd> / <kbd>B</kbd></td><td>Change camera / look back</td></tr>
      <tr><td><kbd>R</kbd></td><td>Reset car to road</td></tr>
      <tr><td><kbd>Backspace</kbd></td><td>Quit current event</td></tr>
      <tr><td><kbd>H</kbd></td><td>Horn</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Pause / settings</td></tr>
      <tr><td>Gamepad</td><td>RT/LT drive, stick steer, A handbrake, B nitro, X interact, Y camera</td></tr>
    </table>`;
  }

  openHelp() {
    this.openModal('help', `<h2>How to play</h2>
      <p>Explore the island freely. Coloured beams mark things to do:
      <span class="chip race">Races</span> <span class="chip challenge">Challenges</span>
      <span class="chip delivery">Deliveries</span> <span class="chip property">Properties</span>.
      Drift, jump, smash props and pass speed traps to earn cash anywhere. Find 40 hidden golden wrenches.</p>
      <p>Spend money on new cars, upgrades and tires. Buy properties for daily income and fast travel.</p>
      <p>Terrain and weather matter: rain and snow reduce grip, sand and grass slow you down, off-road tires help away from tarmac.</p>
      ${this.controlsHtml()}
      <button data-act="close" class="primary">Back to driving</button>`);
  }

  openPause() {
    const s = this.game.state.data.stats;
    this.openModal('pause', `<h2>Paused</h2>
      <div class="menu-buttons">
        <button class="primary" data-act="close">Resume</button>
        <button data-act="jobs">Jobs &amp; Mission Forge</button>
        <button data-act="garage">Garage</button>
        <button data-act="map">Map</button>
        <button data-act="settings">Settings</button>
        <button data-act="help">Help &amp; controls</button>
      </div>
      <h3>Career</h3>
      <div class="statgrid">
        <div>Distance driven<b>${(s.distance / 1000).toFixed(1)} km</b></div>
        <div>Total earned<b>${formatMoney(s.earned)}</b></div>
        <div>Top speed<b>${Math.round(s.topSpeed)} km/h</b></div>
        <div>Longest jump<b>${Math.round(s.bestJump)} m</b></div>
        <div>Best airtime<b>${s.bestAir.toFixed(2)} s</b></div>
        <div>Best drift<b>${Math.round(s.bestDrift)}</b></div>
        <div>Props smashed<b>${s.smashed}</b></div>
        <div>Deliveries<b>${s.deliveries}</b></div>
        <div>Wrenches<b>${this.game.state.data.collected.length}/${this.game.activities.collectibles.length}</b></div>
        <div>Properties<b>${this.game.state.data.properties.length}/${PROPERTIES.length}</b></div>
      </div>`);
  }

  openSettings() { this.openModal('settings', ''); this.renderSettings(); }
  renderSettings() {
    const g = this.game, st = g.state.data.settings;
    const panel = $('.panel', this.modal);
    const wbtn = (id, name) => `<button class="${(id === 'auto' ? g.env.autoWeather : !g.env.autoWeather && g.env.weatherId === id) ? 'sel' : ''}" data-act="weather" data-arg="${id}">${name}</button>`;
    panel.innerHTML = `<h2>Settings</h2>
      <label>Volume <input type="range" min="0" max="1" step="0.05" value="${st.volume}" data-set="volume"></label>
      <h3>Weather</h3><div class="row-buttons">${wbtn('auto', 'Auto cycle')}${Object.entries(WEATHERS).map(([k, w]) => wbtn(k, w.name)).join('')}</div>
      <h3>Time of day</h3><div class="row-buttons">${[[7, 'Morning'], [12, 'Noon'], [18.3, 'Sunset'], [23, 'Night']].map(([t, n]) => `<button data-act="time" data-arg="${t}">${n}</button>`).join('')}</div>
      <h3>Graphics</h3><div class="row-buttons">${['low', 'medium', 'high'].map((q) => `<button class="${st.quality === q ? 'sel' : ''}" data-act="quality" data-arg="${q}">${q}</button>`).join('')}</div>
      <h3>World</h3><div class="row-buttons"><button class="${st.traffic ? 'sel' : ''}" data-act="traffic">Traffic: ${st.traffic ? 'On' : 'Off'}</button></div>
      <h3>Save</h3><div class="row-buttons"><button class="danger" data-act="resetsave">Reset progress</button></div>
      <button class="primary" data-act="close">Done</button>`;
  }

  openProperty(p) {
    this.openModal('property', `<h2>${p.name}</h2><p>${p.desc}</p>
      <div class="statgrid"><div>Price<b>${formatMoney(p.price)}</b></div><div>Income<b>${formatMoney(p.income)} / day</b></div></div>
      <p>Owning a property gives you a garage, a fast-travel point and daily income.</p>
      <div class="menu-buttons"><button class="primary" data-act="buyprop" data-arg="${p.id}" ${this.game.state.money < p.price ? 'disabled' : ''}>Buy</button><button data-act="close">Not now</button></div>`);
  }

  // ---------------------------------------------------------------- garage
  openGarage() { this.openModal('garage', ''); this.renderGarage(); }

  statBars(stats, compare) {
    const r = ratings(stats);
    const c = compare ? ratings(compare) : null;
    return `<div class="bars">${Object.entries(r).map(([k, v]) => {
      const cv = c ? c[k] : v;
      return `<div class="bar"><span>${k}</span><div class="track"><div class="fill" style="width:${Math.max(3, v * 100)}%"></div>${c && cv > v ? `<div class="fill up" style="left:${v * 100}%;width:${(cv - v) * 100}%"></div>` : ''}</div></div>`;
    }).join('')}</div>`;
  }

  renderGarage() {
    const g = this.game, st = g.state;
    const panel = $('.panel', this.modal);
    const tabs = [['cars', 'Vehicles'], ['upgrades', 'Performance'], ['tires', 'Tires'], ['paint', 'Paint'], ['props', 'Properties']];
    let body = '';
    const cur = vehicleById(st.data.current);
    const setup = st.setup;
    const stats = computeStats(cur, setup);
    if (this.garageTab === 'cars') {
      body = `<div class="cards">${VEHICLES.map((v) => {
        const owned = !!st.data.garage[v.id];
        const s = computeStats(v, owned ? st.data.garage[v.id] : {});
        const lock = !owned && st.level < unlockLevel(v);
        const btn = owned ? (st.data.current === v.id ? '<button disabled>Driving</button>' : `<button class="primary" data-act="drive" data-arg="${v.id}">Drive</button>`)
          : lock ? `<button disabled>🔒 Level ${unlockLevel(v)}</button>` : `<button class="primary" data-act="buycar" data-arg="${v.id}" ${st.money < v.price ? 'disabled' : ''}>Buy ${formatMoney(v.price)}</button>`;
        return `<div class="card ${st.data.current === v.id ? 'current' : ''}">
          <div class="swatch" style="background:${owned ? st.data.garage[v.id].paint : v.color}"></div>
          <h3>${v.name}</h3><div class="cls">${v.cls}</div><p>${v.desc}</p>
          ${this.statBars(s)}
          <div class="specs">${Math.round(s.topSpeed * 3.6)} km/h · ${Math.round(s.mass)} kg</div>${btn}</div>`;
      }).join('')}</div>`;
    } else if (this.garageTab === 'upgrades') {
      body = `<div class="split"><div>${Object.entries(UPGRADES).map(([k, u]) => {
        const lvl = setup.upgrades[k] || 0;
        const next = u.levels[lvl + 1];
        const preview = computeStats(cur, { ...setup, upgrades: { ...setup.upgrades, [k]: lvl + 1 } });
        return `<div class="upg"><div><b>${u.name}</b> <span class="pips">${u.levels.slice(1).map((_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</span><br><small>${u.desc} Now: ${u.levels[lvl].name}</small></div>
          <div class="upg-btns">${lvl > 0 ? `<button data-act="downgrade" data-arg="${k}" title="Uninstall (no refund)">−</button>` : ''}
          ${next ? `<button class="primary" data-act="upgrade" data-arg="${k}" ${st.money < next.cost ? 'disabled' : ''} title="Top speed ${Math.round(preview.topSpeed * 3.6)} km/h">${next.name} ${formatMoney(next.cost)}</button>` : '<button disabled>MAXED</button>'}</div></div>`;
      }).join('')}</div><div><h3>${cur.name}</h3>${this.statBars(stats)}
      <div class="specs">Top speed ${Math.round(stats.topSpeed * 3.6)} km/h<br>0-100 approx ${(27.8 / (stats.accel * 0.8)).toFixed(1)} s<br>Mass ${Math.round(stats.mass)} kg<br>Nitro ${stats.nitroCap.toFixed(1)} s</div></div></div>`;
    } else if (this.garageTab === 'tires') {
      const owned = setup.ownedTires || ['street'];
      body = `<div class="cards">${TIRES.map((t) => {
        const prev = computeStats(cur, { ...setup, tires: t.id });
        const isCur = setup.tires === t.id || (!setup.tires && t.id === 'street');
        return `<div class="card ${isCur ? 'current' : ''}"><h3>${t.name}</h3><p>${t.desc}</p>
          <div class="specs">Tarmac ×${t.road} · Off-road ×${t.off} · Snow ×${t.snow}</div>${this.statBars(prev)}
          ${isCur ? '<button disabled>Fitted</button>' : `<button class="primary" data-act="tires" data-arg="${t.id}" ${!owned.includes(t.id) && st.money < t.cost ? 'disabled' : ''}>${owned.includes(t.id) || !t.cost ? 'Fit' : 'Buy ' + formatMoney(t.cost)}</button>`}</div>`;
      }).join('')}</div>`;
    } else if (this.garageTab === 'paint') {
      const fo = setup.ownedFinishes || ['gloss'];
      body = `<h3>Colour (free)</h3><div class="paints">${PAINTS.map((p) => `<button class="paint ${setup.paint === p ? 'sel' : ''}" style="background:${p}" data-act="paint" data-arg="${p}"></button>`).join('')}
        <label class="custom">Custom <input type="color" value="${setup.paint}" id="custompaint"></label></div>
        <h3>Finish</h3><div class="row-buttons">${FINISHES.map((f) => `<button class="${(setup.finish || 'gloss') === f.id ? 'sel' : ''}" data-act="finish" data-arg="${f.id}">${f.name}${fo.includes(f.id) || !f.cost ? '' : ' ' + formatMoney(f.cost)}</button>`).join('')}</div>`;
    } else if (this.garageTab === 'props') {
      body = `<div class="cards">${PROPERTIES.map((p) => {
        const owned = st.data.properties.includes(p.id);
        return `<div class="card ${owned ? 'current' : ''}"><h3>${p.name}</h3><p>${p.desc}</p>
          <div class="specs">${owned ? 'Owned' : formatMoney(p.price)} · ${formatMoney(p.income)}/day</div>
          ${owned ? `<button class="primary" data-act="travel" data-arg="${p.id}">Fast travel</button>` : `<button class="primary" data-act="buyprop" data-arg="${p.id}" ${st.money < p.price ? 'disabled' : ''}>Buy</button>`}</div>`;
      }).join('')}</div>`;
    }
    panel.innerHTML = `<div class="garage-head"><h2>Garage</h2><div class="money">${formatMoney(st.money)}</div><button data-act="close">✕</button></div>
      <div class="tabs">${tabs.map(([id, n]) => `<button class="${this.garageTab === id ? 'sel' : ''}" data-act="tab" data-arg="${id}">${n}</button>`).join('')}</div>
      <div class="garage-body">${body}</div>`;
    const cp = $('#custompaint', panel);
    if (cp) cp.addEventListener('change', () => { setup.paint = cp.value; st.changed(); g.car.setPaint(cp.value, setup.finish); this.renderGarage(); });
  }

  // ---------------------------------------------------------------- world map
  openMap() { this.openModal('map', ''); this.renderMap(); }
  renderMap() {
    const g = this.game;
    const panel = $('.panel', this.modal);
    const owned = PROPERTIES.filter((p) => g.state.data.properties.includes(p.id));
    panel.innerHTML = `<div class="garage-head"><h2>World Map</h2><button data-act="close">✕</button></div>
      <div class="map-wrap"><canvas id="bigmap" width="900" height="900"></canvas>
      <div class="map-side"><p>Click the map to set a GPS waypoint.</p>${g.waypoint ? '<button data-act="clearwp">Clear waypoint</button>' : ''}
      <h3>Fast travel</h3>${owned.map((p) => `<button data-act="travel" data-arg="${p.id}">${p.name}</button>`).join('')}
      <h3>Legend</h3><div class="legend"><span class="chip race">Race</span><span class="chip challenge">Challenge</span><span class="chip delivery">Delivery</span><span class="chip property">Property</span><span class="chip you">You</span></div>
      <p>Wrenches found: ${g.state.data.collected.length}/${g.activities.collectibles.length}</p></div></div>`;
    const c = $('#bigmap', panel);
    const ctx = c.getContext('2d');
    const S = c.width;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(g.world.mapCanvas, 0, 0, S, S);
    const tm = (v) => ((v + WORLD_HALF) / (WORLD_HALF * 2)) * S;
    const cols = { race: '#ffd23f', challenge: '#ff4fd8', delivery: '#3fff8a', property: '#3fa9ff', motorpark: '#ff3b3b', arena: '#ff8a00' };
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    for (const a of g.activities.list) {
      ctx.fillStyle = cols[a.type]; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tm(a.x), tm(a.z), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
      ctx.strokeText(a.name, tm(a.x), tm(a.z) - 10); ctx.fillText(a.name, tm(a.x), tm(a.z) - 10);
    }
    if (g.waypoint) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(tm(g.waypoint.x), tm(g.waypoint.z), 8, 0, Math.PI * 2); ctx.fill(); }
    const car = g.car;
    ctx.save(); ctx.translate(tm(car.pos.x), tm(car.pos.z)); ctx.rotate(-car.yaw + Math.PI);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e33'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    c.addEventListener('click', (e) => {
      const r = c.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * WORLD_HALF * 2 - WORLD_HALF;
      const z = ((e.clientY - r.top) / r.height) * WORLD_HALF * 2 - WORLD_HALF;
      g.waypoint = { x, z };
      this.renderMap();
    });
  }
}
