'use strict';

const { Key } = require('@nut-tree-fork/nut-js');

/**
 * Maps a DOM `KeyboardEvent.code` (what the phone's browser reports) onto the
 * nut-js key enum (which follows macOS virtual keycodes).
 *
 * `code` rather than `key` is deliberate: `key` carries the *character* under
 * the phone's own layout, so a French AZERTY phone would send "q" where the PC
 * expects "a". `code` is a physical-position identifier and is layout stable.
 */
const CODES = {
  Escape: Key.Escape,
  Tab: Key.Tab,
  Enter: Key.Enter,
  NumpadEnter: Key.Enter,
  Backspace: Key.Backspace,
  Delete: Key.Delete,
  Space: Key.Space,
  Insert: Key.Insert,
  Home: Key.Home,
  End: Key.End,
  PageUp: Key.PageUp,
  PageDown: Key.PageDown,
  PrintScreen: Key.Print,
  ScrollLock: Key.ScrollLock,
  Pause: Key.Pause,
  CapsLock: Key.CapsLock,
  ContextMenu: Key.Menu,
  NumLock: Key.NumLock,

  ArrowLeft: Key.Left,
  ArrowRight: Key.Right,
  ArrowUp: Key.Up,
  ArrowDown: Key.Down,

  ControlLeft: Key.LeftControl,
  ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt,
  AltRight: Key.RightAlt,
  ShiftLeft: Key.LeftShift,
  ShiftRight: Key.RightShift,
  MetaLeft: Key.LeftSuper,
  MetaRight: Key.RightSuper,
  OSLeft: Key.LeftSuper,
  OSRight: Key.RightSuper,

  Minus: Key.Minus,
  Equal: Key.Equal,
  BracketLeft: Key.LeftBracket,
  BracketRight: Key.RightBracket,
  Backslash: Key.Backslash,
  Semicolon: Key.Semicolon,
  Quote: Key.Quote,
  Backquote: Key.Grave,
  Comma: Key.Comma,
  Period: Key.Period,
  Slash: Key.Slash,

  NumpadAdd: Key.Add,
  NumpadSubtract: Key.Subtract,
  NumpadMultiply: Key.Multiply,
  NumpadDivide: Key.Divide,
  NumpadDecimal: Key.Decimal,
  NumpadEqual: Key.NumPadEqual,
};

for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i);
  CODES[`Key${letter}`] = Key[letter];
}
for (let i = 0; i <= 9; i++) {
  CODES[`Digit${i}`] = Key[`Num${i}`];
  CODES[`Numpad${i}`] = Key[`NumPad${i}`];
}
for (let i = 1; i <= 12; i++) {
  CODES[`F${i}`] = Key[`F${i}`];
}

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);

const BUTTONS = { left: 0, middle: 1, right: 2 };

function keyFor(code) {
  if (typeof code !== 'string') return undefined;
  return CODES[code];
}

function isModifier(code) {
  return MODIFIER_CODES.has(code);
}

function buttonFor(name) {
  if (typeof name !== 'string') return undefined;
  return BUTTONS[name.toLowerCase()];
}

const SUPPORTED_CODES = Object.keys(CODES).sort();

module.exports = { CODES, keyFor, isModifier, buttonFor, MODIFIER_CODES, SUPPORTED_CODES, BUTTONS };
