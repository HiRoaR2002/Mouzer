const TOKEN_KEY = 'mouzer.token';
const SETTINGS_KEY = 'mouzer.settings';

// Bump when a default changes in a way that should not silently override a
// deliberate choice, but should still reach people who never touched the
// setting. Stored settings from an older version are discarded on load.
const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS = {
  fps: 12,
  scale: 70,
  quality: 55,
  gain: 1,
  // Tapping the screen should click the thing you tapped. That is the
  // behaviour people expect from a remote desktop, so it is the default; the
  // relative touchpad stays one tap away in the mode switch.
  mode: 'direct',
  monitor: -1,
};

/**
 * Owns the single WebSocket to the host.
 *
 * Kept as a plain class rather than React state: frames arrive ~12x/second and
 * routing each one through a reducer would re-render the whole tree for no
 * benefit. Components subscribe to the slices they need.
 */
export class Connection extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.status = 'idle';
    this.server = null;
    this.authed = false;
    this.token = null;
    this.settings = { ...DEFAULT_SETTINGS, ...readSettings() };
    this.lastError = null;
    this.framesReceived = 0;
    this.bytesReceived = 0;
    this.stats = { out: 0 };
    this.attempt = 0;
    this.reconnectTimer = null;
    this.closedByUser = false;
    this.onFrame = null;
  }

  get statusText() {
    switch (this.status) {
      case 'idle':
        return 'Not connected';
      case 'connecting':
        return this.attempt > 1 ? `Reconnecting (${this.attempt})` : 'Connecting';
      case 'pairing':
        return 'Enter pairing PIN';
      case 'ready':
        return 'Connected';
      case 'denied':
        return this.lastError || 'Access denied';
      case 'error':
        return this.lastError || 'Connection error';
      default:
        return this.status;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setStatus(status, error) {
    this.status = status;
    if (error !== undefined) this.lastError = error;
    this._emit('status', { status, error: this.lastError });
  }

  loadToken() {
    try {
      this.token = localStorage.getItem(TOKEN_KEY);
    } catch {
      this.token = null;
    }
    return this.token;
  }

  saveToken(token) {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private browsing; the session simply won't persist */
    }
  }

  connect() {
    this.closedByUser = false;
    clearTimeout(this.reconnectTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this._setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch (err) {
      this._setStatus('error', err.message);
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      const token = this.token;
      ws.send(JSON.stringify(token ? { t: 'hello', token } : { t: 'hello' }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.framesReceived++;
        this.bytesReceived += event.data.byteLength;
        if (this.onFrame) this.onFrame(event.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this._handle(msg);
    };

    ws.onclose = (event) => {
      this.ws = null;
      this.authed = false;
      const denied = event.code === 4403 || event.code === 4401;
      if (denied) {
        this._setStatus('denied', this.lastError || 'Access denied by host');
        this._emit('denied', { code: event.code });
        return;
      }
      if (event.code === 4408) {
        this._setStatus('pairing', 'Pairing timed out — enter the PIN');
        return;
      }
      if (this.closedByUser) {
        this._setStatus('idle');
        return;
      }
      this._setStatus('error', this.lastError || `Disconnected (${event.code})`);
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows, so reconnection is handled there.
    };
  }

  _handle(msg) {
    switch (msg.t) {
      case 'hello_required':
        this.server = msg.server;
        this._emit('server', msg.server);
        if (msg.server && msg.server.inputEnabled === false) {
          this._emit('viewonly', true);
        }
        this._setStatus('pairing');
        break;

      case 'auth_ok':
        this.authed = true;
        this.saveToken(msg.token);
        this.server = msg.server;
        this._setStatus('ready');
        this.pushSettings();
        break;

      case 'auth_failed':
      case 'pair_failed':
        // A stale token must not trap the user on a reconnect loop: drop it so
        // the next attempt lands on the PIN screen.
        this.saveToken(null);
        this._setStatus('pairing', msg.message);
        break;

      case 'error':
        this._emit('notice', { scope: msg.scope, message: msg.message });
        break;

      case 'settings_applied':
        this._emit('settings', msg.settings);
        break;

      case 'denied':
        this._setStatus('denied', msg.message);
        break;

      default:
        break;
    }
  }

  _scheduleReconnect() {
    this.attempt++;
    // Exponential backoff with a ceiling: a phone that wakes from sleep should
    // not hammer the host, but recovery should still feel prompt.
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 5), 15000);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authed) return false;
    this.ws.send(JSON.stringify(payload));
    this.stats.out++;
    return true;
  }

  /** Stream cost, measured from what actually arrived rather than reported. */
  get meta() {
    if (!this.framesReceived) return null;
    return {
      kbPerFrame: Math.round(this.bytesReceived / this.framesReceived / 1024),
      kbps: Math.round((this.bytesReceived * 8) / 5 / 1000),
    };
  }

  pair(pin) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: 'pair', pin: String(pin) }));
    return true;
  }

  resetPairing() {
    this.saveToken(null);
    this._setStatus('pairing');
    this.connect();
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ v: SETTINGS_VERSION, ...this.settings }));
    } catch {
      /* ignore */
    }
    this.pushSettings();
  }

  pushSettings() {
    this.send({ t: 'settings', ...this.settings });
  }

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.send({ t: 'release' });
      this.ws.close();
      this.ws = null;
    }
    this.authed = false;
    this._setStatus('idle');
  }
}

function readSettings() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
  if (!stored || typeof stored !== 'object' || stored.v !== SETTINGS_VERSION) return {};
  const { v, ...rest } = stored;
  return rest;
}
