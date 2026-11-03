// Fully synthesized audio (no sound files needed): engine, tyre squeal, wind, rain, impacts, UI blips.
export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = 0.6;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // engine: two detuned oscillators through a low-pass filter
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 800;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    this.osc1.connect(this.engFilter); this.osc2.connect(g2); g2.connect(this.engFilter);
    this.engFilter.connect(this.engGain); this.engGain.connect(this.master);
    this.osc1.start(); this.osc2.start();

    // noise source shared by skid / wind / rain
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const mkNoise = (type, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master); src.start();
      return { g, f };
    };
    this.skid = mkNoise('bandpass', 1800, 3);
    this.wind = mkNoise('lowpass', 500, 0.5);
    this.rain = mkNoise('highpass', 3000, 0.3);
    this.offroad = mkNoise('lowpass', 250, 1);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  update(car, env, paused) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const sp = car.speed;
    const ratio = sp / car.stats.topSpeed;
    // fake gearbox
    const gears = [0, 0.18, 0.34, 0.52, 0.7, 0.86, 1.3];
    let gi = 1;
    while (gi < gears.length - 1 && ratio > gears[gi]) gi++;
    const lo = gears[gi - 1], hi = gears[gi];
    const rpm = 0.25 + 0.75 * Math.min(1, (ratio - lo) / (hi - lo));
    car.gear = gi;
    car.rpm = rpm;
    const base = 45 + rpm * 120 + (car.def.mass > 2000 ? -10 : 0);
    const k = paused ? 0 : 1;
    this.osc1.frequency.setTargetAtTime(base, t, 0.05);
    this.osc2.frequency.setTargetAtTime(base * 0.5 + 1.5, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(500 + rpm * 1800 + (car.nitroOn ? 900 : 0), t, 0.05);
    this.engGain.gain.setTargetAtTime(k * (0.07 + rpm * 0.06 + (car.throttle || 0) * 0.04), t, 0.05);
    const skid = car.grounded && car.slip > 3 && sp > 6 ? Math.min(1, (car.slip - 3) / 6) : 0;
    const paved = car.surface === 1 || car.surface === 7;
    this.skid.g.gain.setTargetAtTime(k * skid * (paved ? 0.18 : 0.05), t, 0.05);
    this.offroad.g.gain.setTargetAtTime(k * (!paved && car.grounded ? Math.min(0.25, sp / 80) : 0), t, 0.08);
    this.wind.g.gain.setTargetAtTime(k * Math.min(0.2, (sp / 70) ** 2 * 0.2 + env.cur.wind * 0.06), t, 0.1);
    this.rain.g.gain.setTargetAtTime(k * env.cur.rain * (1 - (env.snowMix || 0)) * 0.08, t, 0.3);
  }

  burst(dur = 0.25, freq = 400, gain = 0.4) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); src.stop(ctx.currentTime + dur);
  }
  crash(impact) { this.burst(0.3 + Math.min(0.4, impact / 40), 300 + impact * 40, Math.min(0.8, 0.15 + impact / 30)); }
  thunder() { this.burst(2.5, 160, 0.9); }
  splash() { this.burst(0.25, 1500, 0.08); }

  tone(freq, dur = 0.12, type = 'square', gain = 0.12, when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + when;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  beep(f) { this.tone(f, 0.15, 'square', 0.1); }
  chime() { [880, 1108, 1320].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.15, i * 0.07)); }
  cash() { [1320, 1760].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.12, i * 0.06)); }
  horn() { this.tone(370, 0.35, 'sawtooth', 0.12); this.tone(466, 0.35, 'sawtooth', 0.1); }
}
