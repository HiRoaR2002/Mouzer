'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const logger = require('./logger');
const { normalizeAddress } = require('./net/cidr');

const log = logger.make('http');

const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

function createApp({ config, auth, guard, capture, input, host, version }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Same locality check as the WebSocket upgrade. Applied to every request so
  // the page itself is not served to the open internet either.
  app.use((req, res, next) => {
    const address = normalizeAddress(req.socket.remoteAddress);
    const verdict = guard.check(req.socket.remoteAddress);
    if (!verdict.ok) {
      log.warn(`blocked ${req.method} ${req.path} from ${address}: ${verdict.reason}`);
      res.status(403).type('text/plain').send('403 Forbidden: Mouzer only accepts connections from your local network.');
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    // Nothing here embeds third-party content, so a strict policy costs nothing
    // and removes whole classes of injection risk on a device that is also a
    // remote-control surface.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self' ws: wss:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/info', (req, res) => {
    res.json({
      host: { name: host.osName, platform: host.platform, arch: host.arch, release: host.release },
      version,
      screen: input.size,
      capture: capture.statsSnapshot(),
      inputEnabled: config.input,
      access: { allowAny: guard.allowAny },
    });
  });

  app.get('/api/stats', (req, res) => {
    res.json({ capture: capture.statsSnapshot(), input: input.stats(), hub: req.app.locals.hub?.stats?.() ?? null });
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    app.use(express.static(CLIENT_DIST, { index: 'index.html', maxAge: '1h', etag: true }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res
        .status(503)
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Mouzer</title>
           <body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:38rem">
           <h1>Client not built</h1>
           <p>The server is running, but <code>client/dist</code> does not exist yet.</p>
           <pre style="background:#eee;padding:1rem;border-radius:6px">cd client
npm install
npm run build</pre>
           <p>Then reload this page. For live-reloading development run <code>npm run dev</code>
           in the client folder and open the Vite URL instead.</p>`,
        );
    });
  }

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error(err.stack || err.message);
    res.status(500).type('text/plain').send('Internal error');
  });

  return app;
}

module.exports = { createApp, CLIENT_DIST };
