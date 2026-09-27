'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const configModule = require('./config');
const logger = require('./logger');
const { describeHost, permissionHints } = require('./host');
const { CaptureManager } = require('./capture');
const { InputController } = require('./input');
const { AuthManager } = require('./net/auth');
const { SubnetGuard } = require('./net/cidr');
const { Hub } = require('./net/hub');
const { createApp } = require('./http');
const { renderBanner } = require('./banner');

const version = require('../package.json').version;

const HELP = `
Mouzer ${version} - control this PC from a phone on the same network.

Usage: npm start -- [options]

  --port=<n>          Listen port (default 7331)
  --bind=<addr>       Interface to bind (default 0.0.0.0)
  --monitor=<n>       Display index (default: OS primary)
  --fps=<1-30>        Capture frame rate (default 12)
  --scale=<10-100>    Capture scale percent (default 70)
  --quality=<10-95>   JPEG quality (default 55)
  --backend=<name>    auto | ffmpeg | powershell | nutjs (default auto)
  --pin=<6 digits>    Fix the pairing PIN instead of generating one
  --subnet=<cidr>     Extra allowed CIDR, comma separated
  --allow-any         Disable the local-subnet check (dangerous)
  --rotate-secret     Invalidate all previously issued tokens
  --no-capture        Start with screen streaming disabled
  --no-input          View-only mode; ignore all input injection
  --log=<level>       debug | info | warn | error (default info)
  --help              Show this message
`;

async function main() {
  const config = configModule.build();
  if (config.help) {
    process.stdout.write(HELP);
    return;
  }
  logger.setLevel(config.logLevel);

  const host = await describeHost();
  const primary = host.primaryIPv4;
  if (!primary) {
    logger.make('boot').error('No usable network interface found. Connect to Wi-Fi and restart.');
    process.exitCode = 1;
    return;
  }

  const stateFile = config.stateFile || path.join(__dirname, '..', '.mouzer-state.json');
  const auth = new AuthManager({
    stateFile,
    ttlHours: config.tokenTtlHours,
    fixedPin: config.pin,
    rotate: config.rotateSecret,
  });
  const pin = auth.rollPin();

  const guard = new SubnetGuard({
    allowAny: config.allowAny,
    extra: config.subnets,
    hostIps: host.interfaces.map((i) => i.address),
  });

  const capture = new CaptureManager(config);
  let captureError = null;
  if (config.capture) {
    try {
      await capture.init();
    } catch (err) {
      captureError = err;
    }
  }

  const input = new InputController({ enabled: config.input, gain: 1 });
  if (config.input) {
    try {
      await input.init();
    } catch (err) {
      logger.make('boot').error(`Input injection unavailable: ${err.message}`);
    }
  } else {
    input.size = { width: 1920, height: 1080 };
    if (capture.displays[0]) {
      input.size = { width: capture.displays[0].width, height: capture.displays[0].height };
    }
  }

  const app = createApp({ config, auth, guard, capture, input, host, version });
  const server = http.createServer(app);
  const hub = new Hub({ server, config, capture, input, auth, guard, host });
  app.locals.hub = hub;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, resolve);
  });

  const url = `http://${primary}:${config.port}`;
  process.stdout.write(
    renderBanner({
      version,
      host,
      url,
      pin,
      config,
      capture,
      auth,
      stateFile,
      captureError,
    }),
  );
  for (const hint of permissionHints(host.platform)) {
    process.stdout.write(`  ${hint}\n`);
  }

  if (captureError) {
    process.stdout.write(`\n  !! Screen streaming is DISABLED: ${captureError.message}\n`);
    if (/ffmpeg/i.test(captureError.message)) {
      process.stdout.write('  !! Install ffmpeg and ensure it is on PATH, then restart.\n');
    }
  }
  process.stdout.write('\n  Ctrl+C to stop.\n\n');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n  ${signal} received, shutting down...\n`);
    const timer = setTimeout(() => process.exit(0), 4000);
    timer.unref();
    try {
      hub.close();
      await capture.stop();
      await new Promise((resolve) => server.close(resolve));
    } catch {
      /* best effort */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.make('boot').error(`uncaught exception: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.make('boot').error(`unhandled rejection: ${reason?.stack || reason}`);
  });
}

main().catch((err) => {
  process.stderr.write(`\nFatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
