import { PRESETS } from '../lib/presets.js';

function Slider({ label, value, min, max, step = 1, suffix, onChange, format }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        <b>
          {format ? format(value) : value}
          {suffix}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/**
 * One scrolling sheet, no tabs.
 *
 * Tabs hid three of the eight controls behind an extra tap to reach settings
 * that most people open once. Everything is here, grouped by what it affects,
 * and the stream controls lead because they are the ones that get revisited.
 */
export default function SettingsPanel({ conn, settings, displays, open, onClose, viewOnly }) {
  if (!open) return null;

  const set = (patch) => conn.updateSettings(patch);
  const activePreset = PRESETS.find(
    (p) => p.fps === settings.fps && p.scale === settings.scale && p.quality === settings.quality,
  );
  const meta = conn.meta;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="sheet-head">
          <h2>Settings</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close settings">
            Done
          </button>
        </div>

        <p className="section">Stream</p>
        <div className="preset-row">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`preset${activePreset?.label === p.label ? ' is-active' : ''}`}
              onClick={() => set({ fps: p.fps, scale: p.scale, quality: p.quality })}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Slider label="Frame rate" value={settings.fps} min={1} max={30} suffix=" fps" onChange={(v) => set({ fps: v })} />
        <Slider
          label="Resolution"
          value={settings.scale}
          min={10}
          max={100}
          step={5}
          suffix="%"
          onChange={(v) => set({ scale: v })}
        />
        <Slider
          label="JPEG quality"
          value={settings.quality}
          min={10}
          max={95}
          step={5}
          onChange={(v) => set({ quality: v })}
        />

        {displays.length > 1 && (
          <label className="field">
            <span className="field-label">Display</span>
            <select value={settings.monitor} onChange={(e) => set({ monitor: Number(e.target.value) })}>
              {displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.name.replace('\\\\.\\', '')} · {d.width}×{d.height}
                  {d.primary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <p className="section">Pointer</p>
        <Slider
          label="Pointer speed"
          value={settings.gain}
          min={0.2}
          max={3}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(v) => set({ gain: v })}
        />
        <p className="note">Pointer speed applies to Pad mode. Lower it if the cursor outruns your finger.</p>

        {viewOnly && <p className="note note-warn">The host is running in view-only mode, so input is ignored.</p>}

        <p className="section">Connection</p>
        <div className="readout">
          <div>
            <span>Stream</span>
            <b>{meta ? `${meta.kbPerFrame} KB/frame` : '—'}</b>
          </div>
          <div>
            <span>Bandwidth</span>
            <b>{meta ? `${meta.kbps} kbps` : '—'}</b>
          </div>
          <div>
            <span>Frames</span>
            <b>{conn.framesReceived}</b>
          </div>
          <div>
            <span>Sent</span>
            <b>{conn.stats?.out || 0}</b>
          </div>
        </div>

        <p className="note">
          Restart the host with <b>--rotate-secret</b> to sign out every paired device.
        </p>
      </div>
    </div>
  );
}
