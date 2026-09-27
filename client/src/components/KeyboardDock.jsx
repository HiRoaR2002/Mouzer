import { useEffect, useRef, useState } from 'react';
import { haptic } from '../lib/input.js';

/**
 * Bridges the phone's own keyboard to the PC.
 *
 * A real keyboard is the one input a phone cannot usefully imitate on screen,
 * so this surfaces the OS keyboard and forwards keystrokes. The split of
 * responsibility matters:
 *
 *   printable, unmodified  -> let the field insert it, then send the literal
 *                             characters. This is what makes autocorrect,
 *                             swiping and emoji behave natively.
 *   non-printable or
 *   Ctrl/Alt/Cmd modified  -> intercept and send a key event with modifiers,
 *                             because there is no character to insert.
 *
 * Key *codes* rather than characters are used for the second case, so a phone
 * on AZERTY still produces Ctrl+C rather than whatever "c" means locally.
 */
export default function KeyboardDock({ conn, active }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const valueRef = useRef('');
  const composing = useRef(false);

  useEffect(() => {
    if (open) {
      // Focusing must happen inside the gesture that opened it, otherwise iOS
      // refuses to raise the keyboard.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    inputRef.current?.blur();
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) {
      valueRef.current = '';
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [open]);

  const sendKey = (e) => {
    const modified = e.ctrlKey || e.altKey || e.metaKey;
    const named = e.key.length > 1; // Enter, Tab, ArrowUp, F5, ...
    if (!modified && !named) return; // let it become text instead

    e.preventDefault();
    const mods = [];
    if (e.ctrlKey) mods.push('ControlLeft');
    if (e.altKey) mods.push('AltLeft');
    if (e.shiftKey) mods.push('ShiftLeft');
    if (e.metaKey) mods.push('MetaLeft');

    if (!active) return;
    haptic(6);
    conn.send({ t: 'tap', code: e.code, mods });
  };

  const sendText = (e) => {
    if (composing.current) return;
    const next = e.target.value;
    const prev = valueRef.current;
    if (!next) {
      valueRef.current = '';
      return;
    }
    // Whatever appeared at the end of the field is the text to forward; the
    // field is then emptied so the next edit diffs cleanly.
    let i = 0;
    while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
    const inserted = next.slice(i);
    valueRef.current = '';
    e.target.value = '';
    if (inserted && active) {
      haptic(4);
      conn.send({ t: 'type', text: inserted });
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className="hidden-capture"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label="Keyboard input forwarded to the PC"
        onChange={sendText}
        onKeyDown={sendKey}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          const text = e.target.value || '';
          valueRef.current = '';
          e.target.value = '';
          if (text && active) conn.send({ t: 'type', text });
        }}
      />

      <button
        type="button"
        className={`bar-btn${open ? ' is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={!active}
        aria-pressed={open}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
        </svg>
        <span>Keys</span>
      </button>
    </>
  );
}
