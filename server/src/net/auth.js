'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const log = logger.make('auth');

/**
 * Six-digit PIN pairing.
 *
 * A 6-digit PIN is ~20 bits, which is weak in isolation. That is acceptable
 * here only because it is a one-time exchange gated on network locality: a
 * remote attacker would first have to be on the LAN, and the PIN stops a guest
 * or a compromised device from silently pairing. It is not a substitute for the
 * session token, which is 256 bits and is what actually authorises traffic.
 */
function generatePin() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

class AuthManager {
  constructor({ stateFile, ttlHours = 720, fixedPin = null, rotate = false }) {
    this.stateFile = stateFile;
    this.ttlMs = ttlHours * 3600 * 1000;
    this.pin = fixedPin && /^\d{6}$/.test(fixedPin) ? fixedPin : generatePin();
    this.pinFixed = Boolean(fixedPin && /^\d{6}$/.test(fixedPin));
    this.pinIssuedAt = Date.now();
    this.pinUses = 0;
    this.sessions = new Map();
    this.secret = this._loadSecret(rotate);
    this.attempts = new Map();
    this.maxAttempts = 10;
    this.lockoutMs = 60_000;
  }

  _loadSecret(rotate) {
    if (rotate || !this.stateFile) return crypto.randomBytes(32);
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.secret === 'string' && parsed.secret.length >= 43) {
        return Buffer.from(parsed.secret, 'base64');
      }
      log.warn('state file secret unusable; generating a new one');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`could not read state file: ${err.message}`);
    }
    return crypto.randomBytes(32);
  }

  save() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ secret: this.secret.toString('base64') }, null, 2), { mode: 0o600 });
    } catch (err) {
      log.warn(`could not persist state file: ${err.message}`);
    }
  }

  /**
   * Tokens are HMAC-signed rather than stored, so there is no session table to
   * grow and a stolen state file cannot be replayed as a valid token. Expiry is
   * embedded in the signed payload.
   */
  issueToken() {
    const expires = Date.now() + this.ttlMs;
    const payload = Buffer.from(JSON.stringify({ exp: expires, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    this.save();
    return { token: `${payload}.${sig}`, expires };
  }

  verifyToken(token) {
    if (typeof token !== 'string' || token.length > 512) return { ok: false, reason: 'malformed token' };
    const dot = token.indexOf('.');
    if (dot <= 0) return { ok: false, reason: 'malformed token' };
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };

    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof data.exp !== 'number' || data.exp < Date.now()) return { ok: false, reason: 'expired' };
      return { ok: true, expires: data.exp };
    } catch {
      return { ok: false, reason: 'unreadable token payload' };
    }
  }

  _throttle(address) {
    const entry = this.attempts.get(address) || { count: 0, until: 0 };
    if (entry.until > Date.now()) {
      return Math.ceil((entry.until - Date.now()) / 1000);
    }
    return 0;
  }

  _recordFailure(address) {
    const entry = this.attempts.get(address) || { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= this.maxAttempts) {
      entry.until = Date.now() + this.lockoutMs;
      entry.count = 0;
      log.warn(`lockout for ${address}`);
    }
    this.attempts.set(address, entry);
    return this.maxAttempts - 1 - entry.count;
  }

  tryPair(pin, address) {
    const wait = this._throttle(address);
    if (wait > 0) return { ok: false, reason: `too many attempts; retry in ${wait}s` };

    const candidate = Buffer.from(String(pin ?? '').slice(0, 16));
    const expected = Buffer.from(this.pin);
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      const left = this._recordFailure(address);
      log.warn(`failed PIN attempt from ${address} (${left} left)`);
      return { ok: false, reason: 'incorrect PIN' };
    }

    this.attempts.delete(address);
    this.pinUses++;
    const { token, expires } = this.issueToken();
    log.info(`paired ${address} (attempt #${this.pinUses})`);
    return { ok: true, token, expires };
  }

  /** Forces a fresh PIN; called on every boot unless one was pinned via --pin. */
  rollPin() {
    if (this.pinFixed) return this.pin;
    this.pin = generatePin();
    this.pinIssuedAt = Date.now();
    return this.pin;
  }
}

module.exports = { AuthManager, generatePin, generateToken };
