import { useEffect, useRef } from 'react';
import { haptic, TAP_SLOP, TAP_TIME, RIGHT_CLICK_TIME, LONG_PRESS_TIME, SECOND_FINGER_GRACE } from '../lib/input.js';

/**
 * Relative-pointer surface.
 *
 *   1 finger drag      move the cursor
 *   1 finger tap       left click
 *   1 finger long-press right click
 *   2 finger tap       right click
 *   2 finger drag      scroll
 *
 * The fiddly part is telling a one-finger tap apart from the first half of a
 * two-finger gesture, since the second finger lands ~50-150ms after the first.
 * A tap is therefore held back for a short grace window; if a second pointer
 * arrives the click is cancelled and the gesture is reinterpreted as a
 * two-finger one. The cost is a barely perceptible click delay, and the
 * alternative is a right-click that fires at the same moment as the left.
 */
export default function Touchpad({ conn, active, gain = 1, disabled = false }) {
  const surface = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef({
    kind: null,
    last: null,
    moved: 0,
    startedAt: 0,
    scrollY: 0,
    twoMoved: 0,
  });
  const pendingTap = useRef(null);
  const longPress = useRef(null);
  const activeRef = useRef(active);
  const gainRef = useRef(gain);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    activeRef.current = active;
    gainRef.current = gain;
    disabledRef.current = disabled;
  }, [active, gain, disabled]);

  useEffect(() => {
    const el = surface.current;
    if (!el) return undefined;

    const clearTimers = () => {
      clearTimeout(pendingTap.current);
      pendingTap.current = null;
      clearTimeout(longPress.current);
      longPress.current = null;
    };

    const cancelTap = () => {
      if (pendingTap.current) {
        clearTimeout(pendingTap.current);
        pendingTap.current = null;
        return true;
      }
      return false;
    };

    const centre = () => {
      let x = 0;
      let y = 0;
      for (const p of pointers.current.values()) {
        x += p.x;
        y += p.y;
      }
      const n = pointers.current.size || 1;
      return { x: x / n, y: y / n };
    };

    const onDown = (e) => {
      if (disabledRef.current || !activeRef.current) return;
      el.setPointerCapture?.(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.current.size === 1) {
        clearTimers();
        gesture.current = {
          kind: 'move',
          last: { x: e.clientX, y: e.clientY },
          moved: 0,
          startedAt: Date.now(),
          scrollY: 0,
          twoMoved: 0,
        };
        longPress.current = setTimeout(() => {
          if (gesture.current.kind === 'move' && gesture.current.moved < TAP_SLOP) {
            gesture.current.kind = 'consumed';
            conn.send({ t: 'click', button: 'right', action: 'click' });
            haptic(18);
          }
        }, LONG_PRESS_TIME);
      } else if (pointers.current.size === 2) {
        // A second finger converts this into a two-finger gesture; undo any tap
        // the first finger had already queued.
        const wasTap = cancelTap();
        clearTimeout(longPress.current);
        longPress.current = null;
        if (!wasTap) {
          // A real drag was in progress; undo the movement already applied so
          // the cursor does not jump when scrolling starts.
          gesture.current.last = null;
        }
        gesture.current.kind = 'scroll';
        gesture.current.startedAt = Date.now();
        gesture.current.scrollY = centre().y;
        gesture.current.twoMoved = 0;
      }
    };

    const onMove = (e) => {
      const p = pointers.current.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;

      const g = gesture.current;
      if (g.kind === 'move' && pointers.current.size === 1 && g.last) {
        const dx = e.clientX - g.last.x;
        const dy = e.clientY - g.last.y;
        g.moved += Math.abs(dx) + Math.abs(dy);
        g.last = { x: e.clientX, y: e.clientY };
        if (g.moved > TAP_SLOP) clearTimeout(longPress.current);
        if (dx || dy) conn.send({ t: 'move', dx: dx * gainRef.current, dy: dy * gainRef.current });
      } else if (g.kind === 'scroll' && pointers.current.size >= 2) {
        const c = centre();
        const dy = c.y - g.scrollY;
        g.scrollY = c.y;
        g.twoMoved += Math.abs(dy);
        if (dy) conn.send({ t: 'scroll', dx: 0, dy });
      }
    };

    const onUp = (e) => {
      pointers.current.delete(e.pointerId);
      el.releasePointerCapture?.(e.pointerId);
      const g = gesture.current;
      const held = Date.now() - g.startedAt;

      if (g.kind === 'move' && pointers.current.size === 0) {
        clearTimeout(longPress.current);
        if (g.moved < TAP_SLOP && held < TAP_TIME) {
          pendingTap.current = setTimeout(() => {
            pendingTap.current = null;
            conn.send({ t: 'click', button: 'left', action: 'click' });
            haptic(8);
          }, SECOND_FINGER_GRACE);
        }
        gesture.current.kind = null;
      } else if (g.kind === 'scroll' && pointers.current.size < 2) {
        if (g.twoMoved < TAP_SLOP && held < RIGHT_CLICK_TIME) {
          conn.send({ t: 'click', button: 'right', action: 'click' });
          haptic(18);
        }
        gesture.current.kind = null;
      }

      if (pointers.current.size === 0) {
        // Reset gesture state for the next touch, but leave `pendingTap` alone.
        // It is the tap that was just recognised and it fires a beat later;
        // calling clearTimers() here would cancel the left click in the same
        // tick it was scheduled, so a tap would never click anything at all.
        // A stale timer is still bounded: the next onDown calls clearTimers().
        clearTimeout(longPress.current);
        longPress.current = null;
        gesture.current.kind = null;
        gesture.current.last = null;
      }
    };

    const onCancel = (e) => {
      pointers.current.delete(e.pointerId);
      clearTimers();
      gesture.current.kind = null;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    // Stop the browser hijacking drags for scroll/zoom, which would otherwise
    // make the surface feel like it is fighting the page.
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      clearTimers();
    };
  }, [conn]);

  return (
    <div
      ref={surface}
      className={`touchpad${disabled ? ' is-disabled' : ''}`}
      role="application"
      aria-label="Touchpad: drag to move the pointer, tap to click"
    >
      <div className="touchpad-hint">
        <span>Drag to move</span>
        <span>Tap to click</span>
        <span>Hold or two fingers for right click</span>
      </div>
    </div>
  );
}
