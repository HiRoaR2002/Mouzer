import { useEffect, useMemo, useState } from 'react';
import { useConnection } from './lib/useConnection.js';
import ScreenView from './components/ScreenView.jsx';
import Touchpad from './components/Touchpad.jsx';
import SpecialKeys from './components/SpecialKeys.jsx';
import KeyboardDock from './components/KeyboardDock.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import ModeSwitch from './components/ModeSwitch.jsx';
import Pairing from './components/Pairing.jsx';
import StatusBar from './components/StatusBar.jsx';
import './styles.css';

export default function App() {
  const { conn, status, server, notice } = useConnection();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noticeText, setNoticeText] = useState(null);
  const [pairError, setPairError] = useState(null);

  const ready = status === 'ready';
  const mode = conn.settings.mode;
  const inputAllowed = server?.inputEnabled !== false;

  const displays = useMemo(() => server?.capture?.displays ?? [], [server]);

  // Keep the phone awake: a screen that sleeps mid-session is unusable, and the
  // wake lock is released automatically when the tab is hidden.
  useEffect(() => {
    let lock = null;
    const request = async () => {
      if (!('wakeLock' in navigator) || !ready) return;
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* denied or unsupported; not fatal */
      }
    };
    request();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !lock) request();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release?.().catch(() => {});
    };
  }, [ready]);

  useEffect(() => {
    if (status === 'pairing') setPairError(conn.lastError);
    if (status === 'ready') setPairError(null);
  }, [status, conn.lastError]);

  useEffect(() => {
    if (!notice) return;
    setNoticeText(notice.message);
    const t = setTimeout(() => setNoticeText(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (status === 'denied') {
    return (
      <div className="pair-screen">
        <div className="pair-card">
          <h1>Access denied</h1>
          <p className="pair-sub">{conn.lastError}</p>
          <p className="pair-sub">
            The host only accepts devices on its local network. Make sure your phone is on the same Wi-Fi, or start
            the server with <code>--allow-any</code> if you know what you are doing.
          </p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <>
        <Pairing conn={conn} error={pairError} />
        {status !== 'pairing' && (
          <div className="overlay-note">
            <div className="spinner" />
            <p>{conn.statusText}</p>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app">
      <StatusBar
        conn={conn}
        status={status}
        server={server}
        onSettings={() => setSettingsOpen(true)}
        onReconnect={() => conn.connect()}
      />

      <main className="stage">
        <ScreenView conn={conn} mode={mode} active={ready} enabled={inputAllowed} />

        {mode === 'trackpad' && (
          <Touchpad conn={conn} active={ready && inputAllowed} gain={conn.settings.gain} disabled={!inputAllowed} />
        )}

        <ModeSwitch mode={mode} onChange={(m) => conn.updateSettings({ mode: m })} disabled={!inputAllowed} />
      </main>

      <SpecialKeys conn={conn} active={ready && inputAllowed} />

      <div className="bar">
        <KeyboardDock conn={conn} active={ready && inputAllowed} />
        <span className="bar-hint">
          {mode === 'direct' ? 'Tap the screen to interact' : 'Drag the pad above to move the pointer'}
        </span>
      </div>

      {noticeText && <div className="toast">{noticeText}</div>}

      <SettingsPanel
        conn={conn}
        settings={conn.settings}
        displays={displays}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        viewOnly={!inputAllowed}
      />
    </div>
  );
}
