/**
 * Slim header: where you are, whether it is working, one way into settings.
 *
 * Stream statistics used to live here too, but they changed every second and
 * were the only thing on screen that a user could not act on. They now sit in
 * the settings sheet, where looking at them is a deliberate act.
 */
export default function StatusBar({ conn, status, server, onSettings, onReconnect }) {
  const live = status === 'ready';
  const tone = live ? 'ok' : status === 'error' || status === 'denied' ? 'warn' : 'busy';

  return (
    <header className="topbar">
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      <div className="topbar-id">
        <span className="topbar-host">{live && server ? server.host : 'Mouzer'}</span>
        <span className="topbar-state">{live ? 'Connected' : conn.statusText}</span>
      </div>

      <div className="spacer" />

      <button type="button" className="icon-btn" onClick={onSettings} aria-label="Settings" disabled={!live}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
        </svg>
      </button>
      <button type="button" className="icon-btn" onClick={onReconnect} aria-label="Reconnect">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" />
        </svg>
      </button>
    </header>
  );
}
