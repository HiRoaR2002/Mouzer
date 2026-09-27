'use strict';

const { EventEmitter } = require('events');

/**
 * Last-resort portable capture. It exists so the app still shows *something*
 * on a machine with neither ffmpeg nor a supported PowerShell path, but it is
 * the weakest backend by a wide margin: it decodes into RGBA in JS and
 * re-encodes on the main thread, so expect a few frames per second and heavy
 * CPU. Prefer ffmpeg or the built-in worker.
 */
class NutCaptureBackend extends EventEmitter {
  constructor() {
    super();
    this.name = 'nutjs';
    this.settings = { monitor: 0, scale: 70, quality: 55, fps: 8 };
    this.running = false;
    this.region = null;
  }

  async available() {
    return process.platform === 'darwin' || process.platform === 'linux';
  }

  async probeDisplays() {
    const { screen } = require('@nut-tree-fork/nut-js');
    const w = await screen.width();
    const h = await screen.height();
    return [{ index: 0, name: 'primary', primary: true, x: 0, y: 0, width: w, height: h }];
  }

  async start(settings) {
    const { screen, Region } = require('@nut-tree-fork/nut-js');
    this.settings = { ...this.settings, ...settings };
    const full = await screen.width();
    const fullH = await screen.height();
    const w = Math.max(160, Math.round((full * this.settings.scale) / 100));
    const h = Math.max(120, Math.round((fullH * this.settings.scale) / 100));
    this.region = new Region(0, 0, w, h);
    this.running = true;
    void screen;
    this._loop();
  }

  async _loop() {
    const { screen } = require('@nut-tree-fork/nut-js');
    const interval = 1000 / this.settings.fps;
    while (this.running) {
      const started = Date.now();
      try {
        const img = await screen.captureRegion(this.region);
        const buf = await img.toBuffer('image/jpeg');
        if (this.running) this.emit('frame', Buffer.from(buf));
      } catch (err) {
        this.emit('status', `nut-js capture: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const wait = interval - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  setSettings(partial) {
    const resize = partial.scale !== undefined && partial.scale !== this.settings.scale;
    this.settings = { ...this.settings, ...partial };
    if (resize && this.running) {
      this.running = false;
      setTimeout(() => this.start(this.settings), 60).unref();
    }
  }

  async stop() {
    this.running = false;
  }
}

module.exports = { NutCaptureBackend };
