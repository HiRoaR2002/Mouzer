/** Gesture tuning, in one place so the feel can be adjusted without hunting. */
export const TAP_SLOP = 10; // px of movement still counted as a tap
export const TAP_TIME = 350; // ms
export const RIGHT_CLICK_TIME = 260; // ms for a two-finger tap
export const LONG_PRESS_TIME = 550; // ms hold to right-click
export const SECOND_FINGER_GRACE = 220; // ms to wait for a 2nd finger after tap 1

export function haptic(pattern = 8) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* unsupported or blocked by the user agent */
  }
}

export function isTouchCapable() {
  return (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0)
  );
}
