import { useEffect, useRef, useState } from 'react';

export default function Pairing({ conn, error, onPaired }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!error) return;
    setBusy(false);
    setShake(true);
    setPin('');
    const t = setTimeout(() => setShake(false), 400);
    return () => clearTimeout(t);
  }, [error]);

  const submit = (value) => {
    if (value.length !== 6) return;
    setBusy(true);
    conn.pair(value);
  };

  const press = (d) => {
    if (pin.length >= 6) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 6) submit(next);
  };

  return (
    <div className="pair-screen">
      <div className="pair-card">
        <h1>Pair with this PC</h1>
        <p className="pair-sub">Enter the 6-digit code shown in the PC terminal.</p>

        <div className={`pin-dots${shake ? ' is-shake' : ''}`}>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={i < pin.length ? 'is-filled' : ''} />
          ))}
        </div>

        {error && <p className="pair-error">{error}</p>}

        <div className="keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" onClick={() => press(d)} disabled={busy}>
              {d}
            </button>
          ))}
          <button type="button" className="keypad-alt" onClick={() => setPin('')} disabled={busy}>
            clear
          </button>
          <button type="button" onClick={() => press('0')} disabled={busy}>
            0
          </button>
          <button type="button" className="keypad-alt" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>
            ⌫
          </button>
        </div>

        <input
          ref={inputRef}
          className="hidden-capture"
          type="tel"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={pin}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            setPin(v);
            if (v.length === 6) submit(v);
          }}
          aria-label="Pairing PIN"
        />
      </div>
    </div>
  );
}
