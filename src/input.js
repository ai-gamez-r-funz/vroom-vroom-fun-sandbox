// Keyboard, gamepad and touch input merged into one simple control state.
export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered this frame
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false };
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false, interact: false, cancel: false, reset: false };
    this.enabled = true;
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.padPrev = {};
  }

  bindTouch(root) {
    const bind = (sel, on, off) => {
      const el = root.querySelector(sel);
      if (!el) return;
      const start = (e) => { e.preventDefault(); on(); el.classList.add('down'); };
      const end = (e) => { e.preventDefault(); off(); el.classList.remove('down'); };
      el.addEventListener('touchstart', start, { passive: false });
      el.addEventListener('touchend', end, { passive: false });
      el.addEventListener('touchcancel', end, { passive: false });
    };
    const t = this.touch;
    bind('[data-t=left]', () => (t.steer = -1), () => (t.steer = 0));
    bind('[data-t=right]', () => (t.steer = 1), () => (t.steer = 0));
    bind('[data-t=gas]', () => (t.throttle = 1), () => (t.throttle = 0));
    bind('[data-t=brake]', () => (t.brake = 1), () => (t.brake = 0));
    bind('[data-t=hand]', () => (t.handbrake = true), () => (t.handbrake = false));
    bind('[data-t=nitro]', () => (t.nitro = true), () => (t.nitro = false));
    bind('[data-t=use]', () => this.pressed.add('KeyE'), () => {});
    bind('[data-t=jobs]', () => this.pressed.add('KeyJ'), () => {});
  }

  down(...codes) { return codes.some((c) => this.keys.has(c)); }
  hit(...codes) { return codes.some((c) => this.pressed.has(c)); }

  poll() {
    const s = this.state;
    const k = (...c) => (this.down(...c) ? 1 : 0);
    s.steer = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft') + this.touch.steer;
    s.throttle = Math.max(k('KeyW', 'ArrowUp'), this.touch.throttle);
    s.brake = Math.max(k('KeyS', 'ArrowDown'), this.touch.brake);
    s.handbrake = this.down('Space') || this.touch.handbrake;
    s.nitro = this.down('ShiftLeft', 'ShiftRight') || this.touch.nitro;
    s.interact = this.hit('KeyE', 'Enter');
    s.cancel = this.hit('Backspace');
    s.reset = this.hit('KeyR');
    s.camera = this.hit('KeyC');
    s.map = this.hit('KeyM');
    s.garage = this.hit('KeyG');
    s.pause = this.hit('Escape', 'KeyP');
    s.horn = this.hit('KeyH');
    s.lookBack = this.down('KeyB');
    s.help = this.hit('F1', 'Slash');
    s.accept = this.hit('KeyY');
    s.decline = this.hit('KeyN');
    s.jobs = this.hit('KeyJ');

    // Gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.12) s.steer += ax;
      const b = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      const edge = (i) => {
        const now = b(i) > 0.5;
        const was = this.padPrev[i];
        this.padPrev[i] = now;
        return now && !was;
      };
      s.throttle = Math.max(s.throttle, b(7), b(0) > 0.5 && false ? 1 : 0);
      s.brake = Math.max(s.brake, b(6));
      if (b(0) > 0.5) s.handbrake = true; // A / Cross
      if (b(5) > 0.5 || b(1) > 0.5) s.nitro = true; // RB / B
      if (edge(2)) s.interact = true; // X / Square
      if (edge(3)) s.camera = true; // Y / Triangle
      if (edge(8)) s.map = true; // Back / Select
      if (edge(9)) s.pause = true; // Start
      if (edge(4)) s.reset = true; // LB
      if (edge(12)) s.garage = true; // D-pad up
      if (edge(13)) s.cancel = true; // D-pad down
      if (edge(15)) s.accept = true; // D-pad right
      if (edge(14)) s.decline = true; // D-pad left
    }
    s.steer = Math.max(-1, Math.min(1, s.steer));
    this.pressed.clear();
    if (!this.enabled) {
      s.steer = 0; s.throttle = 0; s.brake = 1; s.handbrake = false; s.nitro = false;
    }
    return s;
  }
}
