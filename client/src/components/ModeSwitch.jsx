import { haptic } from '../lib/input.js';

const MODES = [
  { id: 'direct', label: 'Tap', hint: 'Tap the screen to click, drag to select, hold for right click' },
  { id: 'trackpad', label: 'Pad', hint: 'Drag the pad below to move the pointer' },
];

/**
 * Pointer mode lives here rather than in settings.
 *
 * It is the one control whose effect is not visible in the layout it sits next
 * to - in Pad mode the touch surface appears, in Tap mode it does not - so
 * burying it meant people would tap a dead screen and conclude the app was
 * broken. Two segments and a one-line explanation is the whole of it.
 */
export default function ModeSwitch({ mode, onChange, disabled = false }) {
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];

  return (
    <div className="modeswitch">
      <div className="seg" role="group" aria-label="Pointer mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={mode === m.id ? 'is-active' : ''}
            aria-pressed={mode === m.id}
            disabled={disabled}
            onClick={() => {
              if (mode === m.id) return;
              haptic(6);
              onChange(m.id);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="modeswitch-hint">{active.hint}</p>
    </div>
  );
}
