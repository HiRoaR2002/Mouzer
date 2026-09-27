'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { FrameReader } = require('../frames');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'capture.ps1');

function findShell() {
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

class PowerShellBackend extends EventEmitter {
  constructor() {
    super();
    this.name = 'powershell';
    this.proc = null;
    this.shell = null;
    this.shellMajor = 0;
    this.reader = new FrameReader('length');
    this.frames = 0;
    this.restarts = 0;
    this.settings = { monitor: 0, scale: 70, quality: 55, fps: 12 };
  }

  async available() {
    return process.platform === 'win32' && findShell() !== null;
  }

  async probeDisplays() {
    const shell = findShell();
    if (!shell) throw new Error('No PowerShell interpreter found on PATH.');
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Probe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1 << 20,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Display probe failed: ${(run.stderr || '').trim() || `exit ${run.status}`}`);
    try {
      return JSON.parse(run.stdout.trim()).displays || [];
    } catch (err) {
      throw new Error(`Could not parse display probe output: ${err.message}`);
    }
  }

  async start(settings) {
    this.shell = findShell();
    if (!this.shell) throw new Error('No PowerShell interpreter found on PATH.');
    this.settings = { ...this.settings, ...settings };
    this._spawn();
  }

  _spawn() {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Monitor',
      String(this.settings.monitor),
      '-Scale',
      String(this.settings.scale),
      '-Quality',
      String(this.settings.quality),
      '-Fps',
      String(this.settings.fps),
    ];

    this.proc = spawn(this.shell, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => {
      for (const frame of this.reader.push(chunk)) {
        this.frames++;
        this.emit('frame', frame);
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.emit('status', line.trim());
      }
    });

    this.proc.on('error', (err) => this.emit('fatal', err));
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this.stopping) return;
      this.restarts++;
      if (this.restarts > 5) {
        this.emit('fatal', new Error(`Capture worker exited repeatedly (code ${code}, signal ${signal}).`));
        return;
      }
      this.emit('status', `capture worker exited (code ${code}); restarting in 1s`);
      setTimeout(() => {
        if (!this.stopping) this._spawn();
      }, 1000).unref();
    });
  }

  setSettings(partial) {
    this.settings = { ...this.settings, ...partial };
    if (!this.proc || !this.proc.stdin.writable) return;
    const { fps, scale, quality, monitor } = this.settings;
    this.proc.stdin.write(`fps=${fps} scale=${scale} quality=${quality} monitor=${monitor}\n`);
  }

  stop() {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        done();
      }, 1500);
      timer.unref();
      proc.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      try {
        proc.stdin.write('stop=1\n');
        proc.stdin.end();
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
    });
  }
}

module.exports = { PowerShellBackend, findShell, SCRIPT };
