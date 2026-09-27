'use strict';

const os = require('os');

const INT = /^-?\d+$/;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function pick(flags, env, name, fallback) {
  if (flags[name] !== undefined) return flags[name];
  if (env[`MOUZER_${name.toUpperCase()}`] !== undefined) return env[`MOUZER_${name.toUpperCase()}`];
  return fallback;
}

function toInt(value, fallback, lo, hi) {
  if (value === undefined || value === true) return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !INT.test(String(value).trim())) return fallback;
  return clamp(Math.round(n), lo, hi);
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function build(argv = process.argv.slice(2), env = process.env) {
  const flags = parseArgs(argv);

  if (toBool(flags.help, false) || toBool(flags.h, false)) {
    return { help: true };
  }

  return {
    help: false,
    port: toInt(pick(flags, env, 'port', 7331), 7331, 1, 65535),
    bind: String(pick(flags, env, 'bind', '0.0.0.0')),
    logLevel: String(pick(flags, env, 'log', 'info')),

    // Capture
    backend: String(pick(flags, env, 'backend', 'auto')),
    fps: toInt(pick(flags, env, 'fps', 12), 12, 1, 30),
    scale: toInt(pick(flags, env, 'scale', 70), 70, 10, 100),
    quality: toInt(pick(flags, env, 'quality', 55), 55, 10, 95),
    // -1 resolves to the OS primary display; the numbered index is otherwise
    // whatever order the capture backend enumerates displays in.
    monitor: toInt(pick(flags, env, 'monitor', -1), -1, -1, 15),
    capture: toBool(pick(flags, env, 'capture', true), true),
    input: toBool(pick(flags, env, 'input', true), true),

    // Security
    pin: pick(flags, env, 'pin', null) ? String(pick(flags, env, 'pin', '')) : null,
    allowAny: toBool(pick(flags, env, 'allow-any', false), false),
    subnets: String(pick(flags, env, 'subnet', ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    tokenTtlHours: toInt(pick(flags, env, 'token-ttl', 24 * 30), 24 * 30, 1, 24 * 365),
    stateFile: String(pick(flags, env, 'state-file', '') || ''),
    rotateSecret: toBool(pick(flags, env, 'rotate-secret', false), false),
  };
}

function describe(c) {
  const ffmpeg = c.backend === 'auto' ? 'auto (ffmpeg if present, else built-in)' : c.backend;
  return [
    `OS              ${os.platform()} ${os.release()} (${os.arch()})`,
    `Listen          http://${c.bind}:${c.port}`,
    `Capture         ${c.capture ? 'on' : 'OFF'}  backend=${ffmpeg}  monitor=${c.monitor < 0 ? 'primary' : c.monitor}  ${c.fps}fps  ${c.scale}%  q=${c.quality}`,
    `Input inject    ${c.input ? 'on' : 'OFF (view only)'}`,
    `Access control  ${c.allowAny ? 'ANY address (--allow-any)' : `local subnets only${c.subnets.length ? ` + ${c.subnets.join(',')}` : ''}`}`,
  ].join('\n');
}

module.exports = { build, describe, clamp, toInt, toBool, parseArgs };
