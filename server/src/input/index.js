'use strict';

const logger = require('../logger');
const { keyFor, isModifier, buttonFor } = require('./keymap');

const log = logger.make('input');

const QUEUE_WARN = 200;
const RESYNC_MS = 400;

/**
 * Owns every synthetic input event sent to the OS.
 *
 * Two things make this less trivial than calling nut-js directly:
 *
 * 1. Ordering. nut-js calls are async native round trips. Firing them
 *    concurrently lets a click land before the move that preceded it, so all
 *    work goes through one serialised chain.
 * 2. Backpressure. A touchpad emits pointermove at 60-120Hz while each
 *    setPosition costs a native call. Queueing every sample builds a backlog and
 *    the cursor ends up trailing the finger by a visible distance, so moves
 *    coalesce into a single pending delta and only the latest matters.
 */
class InputController {
  constructor({ enabled = true, gain = 1 } = {}) {
    this.enabled = enabled;
    this.gain = gain;
    this.chain = Promise.resolve();
    this.queueDepth = 0;
    this.pending = { dx: 0, dy: 0 };
    this.moveQueued = false;
    this.position = { x: 0, y: 0 };
    this.size = { width: 1920, height: 1080 };
    // Held keys are tracked per client: two phones can be connected at once and
    // one losing signal must not release a key the other is still holding down.
    this.held = new Map();
    this.lastResync = 0;
    this.counters = { moves: 0, clicks: 0, keys: 0, chars: 0, scrolls: 0, rejected: 0 };
  }

  _heldFor(clientId) {
    let set = this.held.get(clientId);
    if (!set) {
      set = new Set();
      this.held.set(clientId, set);
    }
    return set;
  }

  async init() {
    const nut = require('@nut-tree-fork/nut-js');
    this.nut = nut;
    this.size = { width: await nut.screen.width(), height: await nut.screen.height() };
    const pos = await nut.mouse.getPosition();
    this.position = { x: pos.x, y: pos.y };
    log.info(`ready; screen ${this.size.width}x${this.size.height}, cursor ${this.position.x},${this.position.y}`);
  }

  _run(task) {
    this.queueDepth++;
    if (this.queueDepth === QUEUE_WARN) log.warn('input queue is backing up; events may feel laggy');
    this.chain = this.chain.then(async () => {
      try {
        await task();
      } catch (err) {
        this.counters.rejected++;
        log.warn(`injection failed: ${err.message}`);
      } finally {
        this.queueDepth--;
      }
    });
    return this.chain;
  }

  _clamp(x, y) {
    return {
      x: Math.max(0, Math.min(this.size.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(this.size.height - 1, Math.round(y))),
    };
  }

  /** Re-read the real cursor position to undo drift from external movement. */
  async _resync(force = false) {
    const now = Date.now();
    if (!force && now - this.lastResync < RESYNC_MS) return;
    this.lastResync = now;
    try {
      const pos = await this.nut.mouse.getPosition();
      this.position = { x: pos.x, y: pos.y };
    } catch {
      /* keep the estimate */
    }
  }

  move(dx, dy) {
    this.pending.dx += dx * this.gain;
    this.pending.dy += dy * this.gain;
    if (this.moveQueued) return;
    this.moveQueued = true;
    this._run(() => this._flushMove());
  }

  async _flushMove() {
    this.moveQueued = false;
    const { dx, dy } = this.pending;
    this.pending.dx = 0;
    this.pending.dy = 0;
    if (dx === 0 && dy === 0) return;

    await this._resync();
    const next = this._clamp(this.position.x + dx, this.position.y + dy);
    // Skip no-op moves; at the screen edge the OS call would be wasted.
    if (next.x === this.position.x && next.y === this.position.y) return;
    await this.nut.mouse.move(new this.nut.Point(next.x, next.y));
    this.position = next;
    this.counters.moves++;
  }

  /**
   * nx/ny are normalised 0..1 so the client need not know the PC resolution.
   *
   * Unlike a relative move this is never coalesced away. Dropping it because a
   * delta happened to be in flight would silently discard a tap's "move the
   * cursor here" half, and the click that follows it would land wherever the
   * cursor happened to be - the single most confusing failure this app can have.
   */
  moveAbsolute(nx, ny) {
    this.pending.dx = 0;
    this.pending.dy = 0;
    const x = nx * (this.size.width - 1);
    const y = ny * (this.size.height - 1);
    this._run(async () => {
      const next = this._clamp(x, y);
      if (next.x === this.position.x && next.y === this.position.y) return;
      await this.nut.mouse.setPosition(new this.nut.Point(next.x, next.y));
      this.position = next;
      this.counters.moves++;
    });
  }

  click(clientId, buttonName, action = 'click', count = 1) {
    const button = buttonFor(buttonName);
    if (button === undefined) return this.counters.rejected++;
    const held = this._heldFor(clientId);
    this._run(async () => {
      await this._resync(true);
      if (action === 'down' || action === 'up') {
        if (action === 'down') {
          await this.nut.mouse.pressButton(button);
          held.add(`button:${buttonName}`);
        } else {
          await this.nut.mouse.releaseButton(button);
          held.delete(`button:${buttonName}`);
        }
        return;
      }
      const n = Math.max(1, Math.min(5, count | 0));
      if (button === 0) await this.nut.mouse.leftClick(n);
      else if (button === 1) {
        for (let i = 0; i < n; i++) {
          await this.nut.mouse.pressButton(1);
          await this.nut.mouse.releaseButton(1);
        }
      } else await this.nut.mouse.rightClick(n);
      this.counters.clicks++;
    });
    return undefined;
  }

  /**
   * dy is in "natural scroll" orientation: positive means the fingers moved up,
   * which should reveal content further down.
   */
  scroll(dx, dy) {
    this._run(async () => {
      const steps = (v) => Math.max(1, Math.min(60, Math.round(Math.abs(v) / 12)));
      if (dy !== 0) {
        if (dy > 0) await this.nut.mouse.scrollDown(steps(dy));
        else await this.nut.mouse.scrollUp(steps(dy));
      }
      if (dx !== 0) {
        if (dx > 0) await this.nut.mouse.scrollRight(steps(dx));
        else await this.nut.mouse.scrollLeft(steps(dx));
      }
      this.counters.scrolls++;
    });
  }

  _keysFor(code, mods) {
    const out = [];
    for (const m of mods || []) {
      if (!isModifier(m)) continue;
      const key = keyFor(m);
      if (key !== undefined) out.push(key);
    }
    const main = keyFor(code);
    if (main !== undefined) out.push(main);
    return out;
  }

  keyDown(clientId, code, mods) {
    const keys = this._keysFor(code, mods);
    if (!keys.length) return this.counters.rejected++;
    const held = this._heldFor(clientId);
    this._run(async () => {
      for (const k of keys) await this.nut.keyboard.pressKey(k);
      for (const m of mods || []) held.add(m);
      held.add(code);
      this.counters.keys++;
    });
    return undefined;
  }

  keyUp(clientId, code) {
    const key = keyFor(code);
    if (key === undefined) return this.counters.rejected++;
    const held = this._heldFor(clientId);
    this._run(async () => {
      await this.nut.keyboard.releaseKey(key);
      held.delete(code);
    });
    return undefined;
  }

  /** Atomic press+release, optionally wrapped in held modifiers (e.g. Ctrl+C). */
  tap(code, mods) {
    const keys = this._keysFor(code, mods);
    if (!keys.length) return this.counters.rejected++;
    this._run(async () => {
      for (const k of keys) await this.nut.keyboard.pressKey(k);
      for (let i = keys.length - 1; i >= 0; i--) await this.nut.keyboard.releaseKey(keys[i]);
      this.counters.keys++;
    });
    return undefined;
  }

  type(text) {
    this._run(async () => {
      await this.nut.keyboard.type(text);
      this.counters.chars += text.length;
    });
  }

  /**
   * Releases anything this client left held. Without this, a phone losing
   * signal mid-Ctrl+click would leave the PC's Ctrl key stuck down until reboot.
   */
  async releaseAll(clientId) {
    const held = this.held.get(clientId);
    this.held.delete(clientId);
    if (!held || !held.size || !this.enabled) return;
    const codes = [...held];
    log.info(`releasing ${codes.length} key(s) held by ${clientId}: ${codes.join(', ')}`);
    await this._run(async () => {
      for (const code of codes) {
        if (isModifier(code)) {
          const key = keyFor(code);
          if (key !== undefined) await this.nut.keyboard.releaseKey(key);
        } else if (code.startsWith('button:')) {
          const b = buttonFor(code.slice(7));
          if (b !== undefined) await this.nut.mouse.releaseButton(b);
        } else {
          const key = keyFor(code);
          if (key !== undefined) await this.nut.keyboard.releaseKey(key);
        }
      }
    });
  }

  /** Fresh cursor position, used by the on-screen cursor indicator. */
  async readPosition() {
    if (!this.nut) return { ...this.position };
    try {
      const pos = await this.nut.mouse.getPosition();
      this.position = { x: pos.x, y: pos.y };
      this.lastResync = Date.now();
    } catch {
      /* keep the estimate */
    }
    return this.position;
  }

  stats() {
    return {
      enabled: this.enabled,
      gain: this.gain,
      queueDepth: this.queueDepth,
      position: this.position,
      clients: [...this.held.entries()].filter(([, s]) => s.size).map(([id, s]) => ({ id, held: [...s] })),
      counters: this.counters,
    };
  }
}

module.exports = { InputController };
