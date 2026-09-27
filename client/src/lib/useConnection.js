import { useEffect, useRef, useState } from 'react';
import { Connection } from './connection.js';

export function useConnection() {
  const ref = useRef(null);
  if (!ref.current) ref.current = new Connection();
  const conn = ref.current;

  const [status, setStatus] = useState(conn.status);
  const [server, setServer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    const onStatus = (e) => setStatus(e.detail.status);
    const onServer = (e) => setServer(e.detail);
    const onNotice = (e) => setNotice(e.detail);
    conn.addEventListener('status', onStatus);
    conn.addEventListener('server', onServer);
    conn.addEventListener('notice', onNotice);

    conn.loadToken();
    conn.connect();

    // A coarse fps readout is enough for the status bar, and sampling the frame
    // counter keeps it off the hot path that does the actual decoding.
    const timer = setInterval(() => setFrames(conn.framesReceived), 1000);
    return () => {
      clearInterval(timer);
      conn.removeEventListener('status', onStatus);
      conn.removeEventListener('server', onServer);
      conn.removeEventListener('notice', onNotice);
      conn.disconnect();
    };
  }, [conn]);

  return { conn, status, server, notice, frames };
}
