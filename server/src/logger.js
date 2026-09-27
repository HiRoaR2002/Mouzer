'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

const COLORS = {
  debug: (s) => paint('90', s),
  info: (s) => paint('36', s),
  warn: (s) => paint('33', s),
  error: (s) => paint('31', s),
};

let threshold = LEVELS.info;

function setLevel(name) {
  if (name in LEVELS) threshold = LEVELS[name];
}

function emit(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const head = `${paint('90', ts)} ${COLORS[level](level.toUpperCase().padEnd(5))} ${paint('35', tag)}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${head} ${args.map(fmt).join(' ')}\n`);
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function make(tag) {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
    child: (sub) => make(`${tag}:${sub}`),
  };
}

module.exports = { make, setLevel, LEVELS };
