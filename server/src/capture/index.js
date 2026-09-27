'use strict';

const { EventEmitter } = require('events');
const logger = require('../logger');
const { PowerShellBackend } = require('./backends/powershell');
const { FfmpegBackend } = require('./backends/ffmpeg');
const { NutCaptureBackend } = require('./backends/nutjs');

const log = logger.make('capture');

/**
 * Chooses a capture backend, keeps exactly one running, and re-emits its frames
 * as a single 'frame' event. Capture is only started while a viewer is
 * connected, so an idle host costs nothing.
 */
class CaptureManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.backend = null;
    this.backendName = null;
    this.running = false;
    this.viewers = 0;
    this.displays = [];
    this.settings = {
      monitor: config.monitor,
      scale: config.scale,
      quality: config.quality,
      fps: config.fps,
    };
    this.stats = { frames: 0, bytes: 0, startedAt: 0, restarts: 0 };
  }

  async _pick() {
    const wanted = this.config.backend;
    const order =
      wanted === 'auto'
        ? [FfmpegBackend, PowerShellBackend, NutCaptureBackend]
        : wanted === 'ffmpeg'
          ? [FfmpegBackend]
          : wanted === 'powershell'
            ? [PowerShellBackend]
            : wanted === 'nutjs'
              ? [NutCaptureBackend]
              : null;

    if (!order) throw new Error(`Unknown capture backend "${wanted}". Use auto, ffmpeg, powershell, or nutjs.`);

    const tried = [];
    for (const Ctor of order) {
      const backend = new Ctor();
      try {
        if (await backend.available()) {
          this.backend = backend;
          this.backendName = backend.name;
          return;
        }
        tried.push(`${backend.name} (unavailable on this platform)`);
      } catch (err) {
        tried.push(`${backend.name} (${err.message})`);
      }
    }
    throw new Error(
      `No usable screen-capture backend found. Tried: ${tried.join('; ')}.\n` +
        `Install ffmpeg and put it on PATH, or run on a platform the built-in worker supports.`,
    );
  }

  async init() {
    await this._pick();
    log.info(`backend=${this.backendName}`);

    try {
      this.displays = await this.backend.probeDisplays();
    } catch (err) {
      log.warn(`display probe failed: ${err.message}`);
      this.displays = [];
    }

    if (this.settings.monitor < 0) {
      const primaryIndex = this.displays.findIndex((d) => d.primary);
      this.settings.monitor = primaryIndex >= 0 ? primaryIndex : 0;
      log.info(`monitor=${this.settings.monitor} (${this.displays[this.settings.monitor]?.name || 'primary'})`);
    }

    this.backend.on('frame', (frame) => this._onFrame(frame));
    this.backend.on('status', (msg) => log.debug(`[${this.backendName}] ${msg}`));
    this.backend.on('fatal', (err) => {
      log.error(`${this.backendName}: ${err.message}`);
      this.stats.restarts++;
      this.emit('error', err);
    });
  }

  _onFrame(frame) {
    this.stats.frames++;
    this.stats.bytes += frame.length;
    this.emit('frame', frame);
  }

  async start() {
    if (this.running) return;
    log.info(`starting ${this.backendName} @ ${this.settings.fps}fps ${this.settings.scale}% q=${this.settings.quality}`);
    await this.backend.start(this.settings);
    this.running = true;
    this.stats.startedAt = Date.now();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    await this.backend.stop();
    log.info('capture stopped');
  }

  addViewer() {
    this.viewers++;
    if (this.viewers === 1 && this.config.capture) this.start().catch((err) => this.emit('error', err));
  }

  removeViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) this.stop().catch(() => {});
  }

  setSettings(partial) {
    const before = { ...this.settings };
    this.settings = { ...this.settings, ...partial };
    this.backend.setSettings(this.settings);
    const needsRestart =
      (before.monitor !== this.settings.monitor && this.backendName === 'ffmpeg') ||
      (before.scale !== this.settings.scale && this.backendName === 'nutjs');
    if (needsRestart && this.running) {
      log.info('restarting capture to apply settings');
      this.stop()
        .then(() => this.start())
        .catch((err) => this.emit('error', err));
    }
    return this.settings;
  }

  statsSnapshot() {
    const elapsed = this.stats.startedAt ? (Date.now() - this.stats.startedAt) / 1000 : 0;
    return {
      backend: this.backendName,
      running: this.running,
      viewers: this.viewers,
      settings: this.settings,
      frames: this.stats.frames,
      fps: elapsed > 0 ? +(this.stats.frames / elapsed).toFixed(1) : 0,
      kbPerFrame: this.stats.frames ? Math.round(this.stats.bytes / this.stats.frames / 1024) : 0,
      kbps: elapsed > 0 ? Math.round((this.stats.bytes * 8) / elapsed / 1000) : 0,
      displays: this.displays,
    };
  }
}

module.exports = { CaptureManager };
