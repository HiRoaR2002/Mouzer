'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const logger = require('../logger');
const { validateMessage, ValidationError } = require('./validate');
const { normalizeAddress } = require('./cidr');

const log = logger.make('ws');

const AUTH_TIMEOUT_MS = 45_000;
const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT = 600; // messages per second per connection
const CURSOR_MS = 160;

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_AUTH_TIMEOUT = 4408;
const CLOSE_RATE_LIMIT = 4429;

class Hub {
  constructor({ server, config, capture, input, auth, guard, host }) {
    this.config = config;
    this.capture = capture;
    this.input = input;
    this.auth = auth;
    this.guard = guard;
    this.host = host;
    this.clients = new Set();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
    this.droppedFrames = 0;
    this.sentFrames = 0;

    this._onFrame = (frame) => this._broadcastFrame(frame);
    this.capture.on('frame', this._onFrame);

    this._onUpgrade = (req, socket, head) => this._handleUpgrade(req, socket, head);
    server.on('upgrade', this._onUpgrade);

    this._heartbeat = setInterval(() => this._sweep(), HEARTBEAT_MS);
    this._heartbeat.unref();

    // Cursor position drives the on-screen indicator. It is sent at a modest
    // rate because it is only a hint - at 6Hz it stays under a frame of latency
    // without adding a native call per stream frame.
    this._cursorTimer = setInterval(() => this._broadcastCursor(), CURSOR_MS);
    this._cursorTimer.unref();
  }

  async _broadcastCursor() {
    if (!this.config.input) return;
    const authed = [...this.clients].filter((c) => c.authed);
    if (!authed.length) return;
    const { x, y } = await this.input.readPosition();
    const { width, height } = this.input.size;
    if (!width || !height) return;
    const payload = { t: 'cursor', x, y, nx: x / (width - 1), ny: y / (height - 1) };
    for (const c of authed) this._send(c.ws, payload);
  }

  _handleUpgrade(req, socket, head) {
    const address = normalizeAddress(req.socket.remoteAddress);
    const verdict = this.guard.check(req.socket.remoteAddress);

    if (!verdict.ok) {
      log.warn(`rejected ${address}: ${verdict.reason}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nForbidden: local network only\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws, req, address));
  }

  _onConnection(ws, req, address) {
    const client = {
      id: crypto.randomBytes(4).toString('hex'),
      ws,
      address,
      agent: req.headers['user-agent'] || 'unknown',
      authed: false,
      alive: true,
      windowStart: Date.now(),
      windowCount: 0,
      framesSent: 0,
      dropped: 0,
      authTimer: setTimeout(() => {
        if (!client.authed) {
          log.warn(`auth timeout for ${address}`);
          this._close(ws, CLOSE_AUTH_TIMEOUT, 'pairing timed out');
        }
      }, AUTH_TIMEOUT_MS),
    };
    client.authTimer.unref();
    this.clients.add(client);

    log.info(`${client.id} connected from ${address} (${this.clients.size} total)`);

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._close(ws, 1003, 'binary frames are server-to-client only');
        return;
      }
      this._onMessage(client, data);
    });

    ws.on('close', (code) => {
      this._teardown(client, code);
    });

    ws.on('error', (err) => {
      log.debug(`${client.id} socket error: ${err.message}`);
    });

    this._send(ws, { t: 'hello_required', server: this.serverInfo() });
  }

  _teardown(client, code) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    clearTimeout(client.authTimer);
    if (client.authed) {
      this.capture.removeViewer();
      this.input.releaseAll(client.id);
    }
    log.info(`${client.id} disconnected (${this.clients.size} remaining, code ${code})`);
  }

  serverInfo() {
    return {
      host: this.host.osName,
      version: require('../../package.json').version,
      screen: this.input.size,
      capture: this.capture.statsSnapshot(),
      inputEnabled: this.config.input,
    };
  }

  _send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log.debug(`send failed: ${err.message}`);
      return false;
    }
  }

  _broadcastFrame(frame) {
    this.sentFrames++;
    for (const client of this.clients) {
      if (!client.authed) continue;
      // Skip rather than queue: a phone on a weak link that cannot keep up
      // should see a lower frame rate, never a growing backlog of stale frames.
      if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.dropped++;
        this.droppedFrames++;
        continue;
      }
      if (client.ws.readyState === client.ws.OPEN) {
        try {
          client.ws.send(frame, { binary: true });
          client.framesSent++;
        } catch {
          /* socket will close on its own */
        }
      }
    }
  }

  _rateLimited(client) {
    const now = Date.now();
    if (now - client.windowStart > 1000) {
      client.windowStart = now;
      client.windowCount = 0;
    }
    return ++client.windowCount > RATE_LIMIT;
  }

  _onMessage(client, data) {
    if (this._rateLimited(client)) {
      this._close(client.ws, CLOSE_RATE_LIMIT, 'rate limit exceeded');
      return;
    }

    let message;
    try {
      message = validateMessage(data.toString('utf8'));
    } catch (err) {
      const reason = err instanceof ValidationError ? err.message : 'could not parse message';
      log.warn(`${client.id}: rejected (${reason})`);
      this._send(client.ws, { t: 'error', scope: 'validation', message: reason });
      return;
    }

    if (message.t === 'pair' || message.t === 'hello') {
      this._handleAuth(client, message);
      return;
    }

    if (!client.authed) {
      this._send(client.ws, { t: 'error', scope: 'auth', message: 'pair first' });
      this._close(client.ws, CLOSE_UNAUTHORIZED, 'not authenticated');
      return;
    }

    this._dispatch(client, message);
  }

  _handleAuth(client, message) {
    if (message.t === 'hello' && message.token) {
      const verdict = this.auth.verifyToken(message.token);
      if (!verdict.ok) {
        log.info(`${client.id}: token rejected (${verdict.reason})`);
        this._send(client.ws, { t: 'auth_failed', message: verdict.reason });
        return;
      }
      this._authenticate(client, message.token, verdict.expires);
      return;
    }

    if (message.t === 'pair') {
      const result = this.auth.tryPair(message.pin, client.address);
      if (!result.ok) {
        this._send(client.ws, { t: 'pair_failed', message: result.reason });
        return;
      }
      this._authenticate(client, result.token, result.expires);
      return;
    }

    this._send(client.ws, { t: 'error', scope: 'auth', message: 'expected "hello" or "pair"' });
  }

  _authenticate(client, token, expires) {
    clearTimeout(client.authTimer);
    client.authed = true;
    this.capture.addViewer();
    this._send(client.ws, { t: 'auth_ok', token, expires, server: this.serverInfo() });
    log.info(`${client.id} authenticated`);
  }

  _dispatch(client, m) {
    const input = this.input;
    switch (m.t) {
      case 'ping':
        this._send(client.ws, { t: 'pong' });
        break;
      case 'move':
        if (this.config.input) input.move(m.dx, m.dy);
        break;
      case 'abs':
        if (this.config.input) input.moveAbsolute(m.nx, m.ny);
        break;
      case 'scroll':
        if (this.config.input) input.scroll(m.dx, m.dy);
        break;
      case 'click':
        if (this.config.input) input.click(client.id, m.button, m.action, m.count);
        break;
      case 'kd':
        if (this.config.input) input.keyDown(client.id, m.code, m.mods);
        break;
      case 'ku':
        if (this.config.input) input.keyUp(client.id, m.code);
        break;
      case 'tap':
        if (this.config.input) input.tap(m.code, m.mods);
        break;
      case 'type':
        if (this.config.input) input.type(m.text);
        break;
      case 'release':
        input.releaseAll(client.id);
        break;
      case 'settings': {
        const applied = this.capture.setSettings(m);
        if (m.gain !== undefined) input.gain = m.gain;
        this._send(client.ws, { t: 'settings_applied', settings: { ...applied, gain: input.gain } });
        break;
      }
      default:
        this._send(client.ws, { t: 'error', scope: 'dispatch', message: `unhandled type ${m.t}` });
    }
  }

  _close(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
  }

  _sweep() {
    for (const client of this.clients) {
      if (!client.alive) {
        log.info(`${client.id} missed heartbeat; terminating`);
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  stats() {
    return {
      clients: [...this.clients].map((c) => ({
        id: c.id,
        address: c.address,
        authed: c.authed,
        framesSent: c.framesSent,
        dropped: c.dropped,
      })),
      framesSent: this.sentFrames,
      droppedFrames: this.droppedFrames,
    };
  }

  close() {
    clearInterval(this._heartbeat);
    clearInterval(this._cursorTimer);
    this.capture.off('frame', this._onFrame);
    for (const client of this.clients) {
      clearTimeout(client.authTimer);
      this._close(client.ws, 1001, 'server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }
}

module.exports = { Hub };
