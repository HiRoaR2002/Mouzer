import { useState } from 'react';
import { haptic } from '../lib/input.js';

const MODIFIERS = [
  { code: 'ControlLeft', label: 'Ctrl' },
  { code: 'AltLeft', label: 'Alt' },
  { code: 'ShiftLeft', label: 'Shift' },
  { code: 'MetaLeft', label: isApple() ? 'Cmd' : 'Win' },
];

const PRIMARY = [
  { code: 'Escape', label: 'Esc' },
  { code: 'Tab', label: 'Tab' },
  { code: 'ArrowLeft', label: '←' },
  { code: 'ArrowUp', label: '↑' },
  { code: 'ArrowDown', label: '↓' },
  { code: 'ArrowRight', label: '→' },
  { code: 'Enter', label: '⏎' },
  { code: 'Backspace', label: '⌫' },
  { code: 'Space', label: 'Space', wide: true },
];

const EXTRA = [
  { code: 'Delete', label: 'Del' },
  { code: 'Home', label: 'Home' },
  { code: 'End', label: 'End' },
  { code: 'PageUp', label: 'PgUp' },
  { code: 'PageDown', label: 'PgDn' },
];

function isApple() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * Modifier keys latch rather than require a true press-and-hold. Holding a
 * button down on a touchscreen while reaching for another is genuinely painful
 * and unreliable - your finger covers the target - so tapping Ctrl arms it and
 * it stays armed until used or dismissed. That is how Ctrl+C, Ctrl+Tab and
 * Alt+Tab get done with one thumb.
 *
 * The less common keys sit behind a disclosure rather than filling two rows at
 * all times: a wall of identically weighted buttons makes the four that get
 * used constantly harder to find, not easier.
 */
export default function SpecialKeys({ conn, active }) {
  const [held, setHeld] = useState([]);
  const [expanded, setExpanded] = useState(false);

  const toggleModifier = (code) => {
    haptic(6);
    setHeld((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const press = (code) => {
    if (!active) return;
    haptic(6);
    conn.send({ t: 'tap', code, mods: held });
    // A modifier is consumed by the key it modifies, matching how a real
    // press-and-release of Ctrl+C behaves.
    if (held.length) setHeld([]);
  };

  const clear = () => {
    setHeld([]);
    conn.send({ t: 'release' });
  };

  const renderKey = (k) => (
    <button
      key={k.code}
      type="button"
      className={`key${k.wide ? ' key-wide' : ''}`}
      onClick={() => press(k.code)}
      disabled={!active}
    >
      {k.label}
    </button>
  );

  return (
    <div className="keys">
      {held.length > 0 && (
        <div className="armed">
          <span>
            {held.map((c) => MODIFIERS.find((m) => m.code === c)?.label).join(' + ')} armed
          </span>
          <button type="button" className="armed-clear" onClick={clear}>
            Clear
          </button>
        </div>
      )}

      <div className="key-row">
        {MODIFIERS.map((m) => (
          <button
            key={m.code}
            type="button"
            className={`key key-mod${held.includes(m.code) ? ' is-held' : ''}`}
            onClick={() => toggleModifier(m.code)}
            disabled={!active}
            aria-pressed={held.includes(m.code)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="key-row">
        {PRIMARY.map(renderKey)}
        <button
          type="button"
          className={`key key-more${expanded ? ' is-open' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide extra keys' : 'Show extra keys'}
        >
          {expanded ? '×' : '⋯'}
        </button>
      </div>

      {expanded && <div className="key-row">{EXTRA.map(renderKey)}</div>}
    </div>
  );
}
