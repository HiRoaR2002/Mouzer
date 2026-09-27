'use strict';

const { SUPPORTED_CODES, MODIFIER_CODES } = require('../input/keymap');

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 4096;
const MAX_DELTA = 4000;
const CODE_SET = new Set(SUPPORTED_CODES);

class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message);
}

function num(value, name, { min = -MAX_DELTA, max = MAX_DELTA, int = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  if (int && !Number.isInteger(value)) fail(`${name} must be an integer`);
  if (value < min || value > max) fail(`${name} out of range`);
  return value;
}

function oneOf(value, name, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${name} must be one of ${allowed.join('|')}`);
  return value;
}

function code(value) {
  if (typeof value !== 'string' || value.length > 24) fail('code must be a short string');
  // Allowlist rather than pattern-match: an unknown key name is a client bug or
  // an attempt to reach a key we never intended to expose.
  if (!CODE_SET.has(value)) fail(`unsupported key code "${value.slice(0, 24)}"`);
  return value;
}

function mods(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) fail('mods must be an array of at most 4 codes');
  return value.map((m) => {
    code(m);
    if (!MODIFIER_CODES.has(m)) fail(`"${m}" is not a modifier`);
    return m;
  });
}

function text(value) {
  if (typeof value !== 'string') fail('text must be a string');
  if (value.length > MAX_TEXT_CHARS) fail(`text exceeds ${MAX_TEXT_CHARS} characters`);
  // Keep tab/newline/carriage return (legitimate in a text field) but drop other
  // C0/C7F control characters, which have no meaning as typed text and could
  // confuse a terminal or shell on the host.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

const HANDLERS = {
  hello: (m) => ({ t: 'hello', token: typeof m.token === 'string' ? m.token.slice(0, 512) : null }),
  // The normalised message keeps the same `t` it arrived with: the dispatcher
  // switches on that, so rewriting it here would send events down a branch that
  // does not exist.
  ping: () => ({ t: 'ping' }),

  pair: (m) => {
    if (typeof m.pin !== 'string' || !/^\d{6}$/.test(m.pin)) fail('pin must be 6 digits');
    return { t: 'pair', pin: m.pin };
  },

  move: (m) => ({ t: 'move', dx: num(m.dx, 'dx'), dy: num(m.dy, 'dy') }),
  abs: (m) => ({ t: 'abs', nx: num(m.nx, 'nx', { min: 0, max: 1 }), ny: num(m.ny, 'ny', { min: 0, max: 1 }) }),
  scroll: (m) => ({ t: 'scroll', dx: num(m.dx, 'dx'), dy: num(m.dy, 'dy') }),

  click: (m) => ({
    t: 'click',
    button: oneOf(m.button, 'button', ['left', 'right', 'middle']),
    action: oneOf(m.action, 'action', ['click', 'down', 'up']),
    count: m.count === undefined ? 1 : num(m.count, 'count', { min: 1, max: 5, int: true }),
  }),

  kd: (m) => ({ t: 'kd', code: code(m.code), mods: mods(m.mods) }),
  ku: (m) => ({ t: 'ku', code: code(m.code) }),
  tap: (m) => ({ t: 'tap', code: code(m.code), mods: mods(m.mods) }),
  type: (m) => ({ t: 'type', text: text(m.text) }),
  release: () => ({ t: 'release' }),

  settings: (m) => {
    const out = { t: 'settings' };
    if (m.fps !== undefined) out.fps = num(m.fps, 'fps', { min: 1, max: 30, int: true });
    if (m.scale !== undefined) out.scale = num(m.scale, 'scale', { min: 10, max: 100, int: true });
    if (m.quality !== undefined) out.quality = num(m.quality, 'quality', { min: 10, max: 95, int: true });
    if (m.monitor !== undefined) out.monitor = num(m.monitor, 'monitor', { min: -1, max: 15, int: true });
    if (m.gain !== undefined) out.gain = num(m.gain, 'gain', { min: 0.1, max: 4 });
    if (m.mode !== undefined) out.mode = oneOf(m.mode, 'mode', ['trackpad', 'direct']);
    if (Object.keys(out).length === 1) fail('settings message set no recognised fields');
    return out;
  },
};

/**
 * Parses and validates one client frame. Returns a normalised object containing
 * only recognised fields - anything unexpected is discarded rather than passed
 * through to the OS layer.
 */
function validateMessage(raw) {
  if (typeof raw !== 'string') throw new ValidationError('expected a text frame');
  if (raw.length > MAX_MESSAGE_BYTES) throw new ValidationError(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('expected a JSON object');
  }
  const handler = HANDLERS[parsed.t];
  if (!handler) throw new ValidationError(`unknown message type "${String(parsed.t).slice(0, 24)}"`);
  return handler(parsed);
}

module.exports = { validateMessage, ValidationError, MAX_MESSAGE_BYTES, MAX_TEXT_CHARS };
