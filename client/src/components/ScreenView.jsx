import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic, LONG_PRESS_TIME, TAP_SLOP } from '../lib/input.js';

/**
 * Renders the JPEG stream and, in direct mode, turns touches into input.
 *
 * Sizing is the fiddly part. The wrapper is sized to the stream's own aspect
 * ratio rather than being handed whatever space is left over: a 16:9 desktop
 * dropped into a box that happens to be wider than 16:9 gets black bars down
 * each side, and the image never uses the full width of the phone. Measuring
 * the frame means the box and the image are the same shape, so the letterbox
 * collapses to nothing and a tap maps to exactly the pixel under the finger.
 *
 * Frames arrive faster than the browser can decode them, so decoding is
 * strictly "latest wins": each incoming frame overwrites a single pending slot
 * and at most one decode is ever in flight. Queuing instead would let the view
 * fall progressively further behind the live screen.
 */

const DRAG_INTERVAL = 25;

export default function ScreenView({ conn, mode, active, enabled = true }) {
  const viewportRef = useRef(null);
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const pending = useRef(null);
  const raf = useRef(0);
  const fit = useRef({ w: 0, h: 0 });
  const origin = useRef({ left: 0, top: 0 });
  const cursor = useRef(null);
  const press = useRef(null);

  const [hasFrame, setHasFrame] = useState(false);
  const [dims, setDims] = useState(null);

  const draw = useCallback(function draw() {
    raf.current = 0;
    const buffer = pending.current;
    if (!buffer) return;
    pending.current = null;

    const canvas = canvasRef.current;
    if (!canvas) return;

    createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }))
      .then((bitmap) => {
        const bw = bitmap.width;
        const bh = bitmap.height;
        if (!bw || !bh) {
          bitmap.close();
          return;
        }

        const box = measure(bw / bh);
        if (!box) {
          bitmap.close();
          return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pxW = Math.round(box.w * dpr);
        const pxH = Math.round(box.h * dpr);
        if (canvas.width !== pxW || canvas.height !== pxH) {
          canvas.width = pxW;
          canvas.height = pxH;
        }

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // The box is sized from the frame's aspect ratio, so this is an exact fit.
        // The guard is only here for the one frame drawn before a resize has
        // been measured.
        const scale = Math.min(box.w / bw, box.h / bh);
        const w = bw * scale;
        const h = bh * scale;
        const x = (box.w - w) / 2;
        const y = (box.h - h) / 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, box.w, box.h);
        ctx.drawImage(bitmap, x, y, w, h);
        bitmap.close();

        setHasFrame(true);
        setDims((prev) => (prev && prev.w === bw && prev.h === bh ? prev : { w: bw, h: bh }));
        drawCursor(ctx, x, y, w, h, scale);
      })
      .catch(() => {
        /* a corrupt frame is not worth surfacing; the next one will land */
      })
      .finally(() => {
        if (pending.current && !raf.current) raf.current = requestAnimationFrame(draw);
      });
  }, []);

  /** Largest box of the stream's aspect ratio that fits the viewport. */
  function measure(ar) {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const availW = viewport.clientWidth;
    const availH = viewport.clientHeight;
    if (!availW || !availH) return null;

    let w = availW;
    let h = w / ar;
    if (h > availH) {
      h = availH;
      w = h * ar;
    }
    w = Math.floor(w);
    h = Math.floor(h);

    if (fit.current.w !== w || fit.current.h !== h) {
      fit.current = { w, h };
      const wrap = wrapRef.current;
      if (wrap) {
        wrap.style.width = `${w}px`;
        wrap.style.height = `${h}px`;
      }
    }
    return fit.current;
  }

  function drawCursor(ctx, x, y, w, h, scale) {
    const c = cursor.current;
    if (!c) return;
    const px = x + c.nx * w;
    const py = y + c.ny * h;
    const r = Math.max(6, 8 * scale);
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.restore();
  }

  useEffect(() => {
    conn.onFrame = (buffer) => {
      pending.current = buffer;
      if (!raf.current) raf.current = requestAnimationFrame(draw);
    };
    return () => {
      conn.onFrame = null;
      cancelAnimationFrame(raf.current);
    };
  }, [conn, draw]);

  useEffect(() => {
    // The cursor is only painted as part of a frame draw. Repainting it on its
    // own would smear a trail of stale rings, and at the stream's frame rate
    // the indicator is already visually current.
    const onCursor = (e) => {
      cursor.current = e.detail;
    };
    conn.addEventListener('cursor', onCursor);
    return () => conn.removeEventListener('cursor', onCursor);
  }, [conn]);

  // Re-measure on rotate or resize so the box keeps the stream's shape.
  useEffect(() => {
    const onResize = () => {
      fit.current = { w: 0, h: 0 };
      if (pending.current) {
        pending.current = null;
        raf.current = requestAnimationFrame(draw);
      }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [draw]);

  /* ---------- direct-mode input ---------- */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;

    const syncOrigin = () => {
      const box = el.getBoundingClientRect();
      origin.current = { left: box.left, top: box.top };
    };

    const clearPress = () => {
      clearTimeout(press.current?.timer);
      press.current = null;
    };

    /** Client point -> normalised stream coordinates, clamped to the frame. */
    const toNorm = (clientX, clientY) => {
      const { left, top } = origin.current;
      const { w, h } = fit.current;
      if (!w || !h) return null;
      const nx = (clientX - left) / w;
      const ny = (clientY - top) / h;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
      return { nx, ny };
    };

    const onDown = (e) => {
      if (!active || !enabled || mode !== 'direct' || e.button > 2) return;
      syncOrigin();
      const p = toNorm(e.clientX, e.clientY);
      if (!p) return;

      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);

      // Move first, then press. Sending them in this order means a tap always
      // lands on what the finger covered rather than wherever the cursor was.
      conn.send({ t: 'abs', nx: p.nx, ny: p.ny });
      conn.send({ t: 'click', button: 'left', action: 'down' });

      press.current = {
        id: e.pointerId,
        moved: 0,
        lastSent: 0,
        down: true,
        timer: setTimeout(() => {
          const state = press.current;
          if (!state || state.moved > TAP_SLOP) return;
          // Held still long enough to mean "not a click": hand it over as a
          // right click instead.
          state.down = false;
          state.right = true;
          conn.send({ t: 'click', button: 'left', action: 'up' });
          conn.send({ t: 'click', button: 'right', action: 'click' });
          haptic(14);
        }, LONG_PRESS_TIME),
      };
    };

    const onMove = (e) => {
      const state = press.current;
      if (!state || e.pointerId !== state.id || state.right) return;
      state.moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      if (state.moved > TAP_SLOP) clearTimeout(state.timer);
      if (state.moved > TAP_SLOP) syncOrigin();

      // Coalesce to ~40Hz. Every absolute move is a native call on the host, and
      // a finger emits far more samples than the display can show.
      const now = performance.now();
      if (now - state.lastSent < DRAG_INTERVAL) return;
      state.lastSent = now;

      syncOrigin();
      const p = toNorm(e.clientX, e.clientY);
      if (p) conn.send({ t: 'abs', nx: p.nx, ny: p.ny });
    };

    const onUp = (e) => {
      const state = press.current;
      if (!state || e.pointerId !== state.id) return;
      clearPress();
      el.releasePointerCapture?.(e.pointerId);
      if (state.down) conn.send({ t: 'click', button: 'left', action: 'up' });
      if (!state.right && state.moved <= TAP_SLOP) haptic(6);
    };

    const onCancel = (e) => {
      const state = press.current;
      if (!state || e.pointerId !== state.id) return;
      clearPress();
      if (state.down) conn.send({ t: 'click', button: 'left', action: 'up' });
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Stop the browser claiming drags for pan/zoom, which would otherwise
    // cancel the gesture halfway through.
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      clearPress();
    };
  }, [conn, mode, active, enabled]);

  return (
    <div className="viewport" ref={viewportRef}>
      <div className={`screen-wrap${hasFrame ? ' is-live' : ''}`} ref={wrapRef}>
        <canvas ref={canvasRef} className="screen-canvas" />

        {!hasFrame && (
          <div className="screen-placeholder">
            <div className="spinner" />
            <p>Waiting for the first frame</p>
          </div>
        )}

        {hasFrame && dims && (
          <div className="screen-dims">
            {dims.w}×{dims.h}
          </div>
        )}

        {hasFrame && mode === 'direct' && !enabled && <div className="screen-note">View only</div>}
      </div>
    </div>
  );
}
