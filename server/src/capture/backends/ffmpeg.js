'use strict';

const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { FrameReader } = require('../frames');

/**
 * ffmpeg is the preferred backend once it is installed: hardware encoders
 * (NVENC/QSV/AMF) make 1080p60 essentially free, and it is the only route to
 * the low-latency WebRTC upgrade path later. When present we still emit JPEG
 * over the same transport so the client does not need to change.
 */
function grabberArgs(platform, opts) {
  const { width, height, x, y } = opts;
  if (platform === 'win32') {
    return ['-f', 'gdigrab', '-framerate', String(opts.fps), '-offset_x', String(x), '-offset_y', String(y), '-video_size', `${width}x${height}`, '-draw_mouse', '1', '-i', 'desktop'];
  }
  if (platform === 'darwin') {
    return ['-f', 'avfoundation', '-framerate', String(opts.fps), '-i', `${opts.monitor + 1}:none`];
  }
  return ['-f', 'x11grab', '-framerate', String(opts.fps), '-video_size', `${width}x${height}`, '-i', `:0.${opts.monitor}`];
}

class FfmpegBackend extends EventEmitter {
  constructor() {
    super();
    this.name = 'ffmpeg';
    this.binary = null;
    this.proc = null;
    this.reader = new FrameReader('mjpeg');
    this.encoder = null;
  }

  async available() {
    this.binary = this._find();
    return this.binary !== null;
  }

  _find() {
    for (const candidate of ['ffmpeg', 'ffmpeg.exe']) {
      const probe = spawnSync(candidate, ['-hide_banner', '-version'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
  }

  _encoder() {
    if (this.encoder) return this.encoder;
    this.encoder = 'mjpeg';
    return this.encoder;
  }

  async probeDisplays() {
    // Display geometry is an OS question, not an ffmpeg question, so this reuses
    // the built-in worker's probe wherever that platform is supported.
    if (process.platform === 'win32') {
      const { PowerShellBackend } = require('./powershell');
      try {
        return await new PowerShellBackend().probeDisplays();
      } catch {
        /* fall through to nut-js */
      }
    }
    const { screen } = require('@nut-tree-fork/nut-js');
    const w = await screen.width();
    const h = await screen.height();
    return [{ index: 0, name: 'primary', primary: true, x: 0, y: 0, width: w, height: h }];
  }

  async start(settings) {
    if (!this.binary) this.binary = this._find();
    if (!this.binary) throw new Error('ffmpeg not found on PATH.');
    this.settings = { ...settings };
    this._spawn();
  }

  _spawn() {
    const s = this.settings;
    const vf = s.scale === 100 ? 'null' : `scale=iw*${s.scale / 100}:ih*${s.scale / 100}`;

    // We always emit MJPEG regardless of hardware encoders available: the
    // transport is JPEG frames today, and NVENC/QSV only become relevant once
    // this moves to WebRTC (see README "Upgrading to WebRTC").
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-an',
      ...grabberArgs(process.platform, s),
      '-vf', vf,
      '-r', String(s.fps),
      '-c:v', 'mjpeg',
      '-q:v', String(31 - Math.round((s.quality / 95) * 20)),
      '-f', 'image2pipe',
      'pipe:1',
    ];

    this.proc = spawn(this.binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (chunk) => {
      for (const frame of this.reader.push(chunk)) this.emit('frame', frame);
    });
    this.proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.emit('status', line.trim());
      }
    });
    this.proc.on('error', (err) => this.emit('fatal', err));
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      this.emit('fatal', new Error(`ffmpeg exited (code ${code}). Falling back is handled by the manager.`));
    });
  }

  setSettings() {
    // ffmpeg's grabber inputs cannot be retuned in place; the manager restarts
    // the backend instead, which is imperceptible at these frame sizes.
  }

  async stop() {
    this.stopping = true;
    if (!this.proc) return;
    const proc = this.proc;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref();
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { FfmpegBackend };
