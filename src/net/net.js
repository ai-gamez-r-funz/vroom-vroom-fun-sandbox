// WebSocket client with automatic reconnect (exponential backoff), session-token resume,
// ping/RTT and server clock-offset estimation.
import { PROTOCOL_VERSION } from '../../shared/protocol.js';
import { MP_SERVER_URL } from '../config.js';

const TOKEN_KEY = 'vroom.mp.token';
const SERVER_KEY = 'vroom.mp.server';
const BACKOFF = [1000, 2000, 4000, 8000, 15000];

const store = {
  get(k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
  set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* storage blocked */ } },
  del(k, session) { try { (session ? sessionStorage : localStorage).removeItem(k); } catch { /* ignore */ } },
};

export function defaultServerUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const saved = store.get(SERVER_KEY);
  if (saved) return saved;
  if (MP_SERVER_URL) return MP_SERVER_URL;
  if (['localhost', '127.0.0.1', ''].includes(location.hostname)) return `ws://${location.hostname || 'localhost'}:8787`;
  return '';
}

export function httpUrl(wsUrl) {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
}

export class NetClient {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.status = 'idle';
    this.ws = null;
    this.wanted = false;
    this.attempt = 0;
    this.rtt = 0;
    this.offset = 0; // serverTime - localTime
    // a per-tab token so two tabs are two players, while reloading a tab resumes the session
    this.token = store.get(TOKEN_KEY, true);
  }

  serverNow() { return Date.now() + this.offset; }

  connect(url, profile) {
    this.url = url;
    this.profile = profile;
    this.wanted = true;
    this.attempt = 0;
    store.set(SERVER_KEY, url);
    this.open();
  }

  open() {
    clearTimeout(this.retryTimer);
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.setStatus('error', e.message); this.wanted = false; return; }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.send({ t: 'hello', v: PROTOCOL_VERSION, token: this.token, name: this.profile.name, car: this.profile.car });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 2000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') {
        this.token = m.token;
        store.set(TOKEN_KEY, m.token, true);
        this.offset = m.serverTime - Date.now();
        this.setStatus('open');
      } else if (m.t === 'pong') {
        const now = Date.now();
        this.rtt = now - m.c;
        const off = m.s - (m.c + this.rtt / 2);
        this.offset = this.offset ? this.offset * 0.8 + off * 0.2 : off;
      } else if (m.t === 'error' && m.fatal) {
        this.wanted = false;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.wanted) { this.setStatus('closed'); return; }
      const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.attempt++;
      this.setStatus('reconnecting', `Reconnecting in ${Math.round(delay / 1000)}s…`);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  send(m) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; }
    return false;
  }

  disconnect(forget = false) {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) { const w = this.ws; this.ws = null; w.close(); }
    if (forget) { this.token = null; store.del(TOKEN_KEY, true); }
    this.setStatus('closed');
  }

  setStatus(s, detail) {
    this.status = s;
    this.onStatus?.(s, detail);
  }
}
