'use strict';

// Verifies the capture backend produces real, decodable JPEGs at a usable rate,
// independently of the HTTP/WebSocket layer.

const { CaptureManager } = require('../src/capture');

function looksLikeJpeg(buf) {
  return buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

(async () => {
  const manager = new CaptureManager({
    backend: process.argv[2] || 'auto',
    monitor: -1,
    scale: Number(process.argv[3] || 60),
    quality: 55,
    fps: 12,
    capture: true,
  });

  await manager.init();
  console.log('backend   :', manager.backendName);
  console.log('displays  :', JSON.stringify(manager.displays));
  console.log('monitor   :', manager.settings.monitor, manager.displays[manager.settings.monitor]?.name || '');

  let frames = 0;
  let bad = 0;
  let bytes = 0;
  let first = null;

  manager.on('frame', (f) => {
    frames++;
    bytes += f.length;
    if (!looksLikeJpeg(f)) bad++;
    if (!first) first = f;
  });

  await manager.start();

  const DURATION = 4000;
  await new Promise((r) => setTimeout(r, DURATION));
  await manager.stop();

  const fps = frames / (DURATION / 1000);
  console.log('\n--- results ---');
  console.log('frames    :', frames);
  console.log('bad frames:', bad);
  console.log('avg size  :', frames ? Math.round(bytes / frames / 1024) + ' KB' : 'n/a');
  console.log('actual fps:', fps.toFixed(1));

  let decoded = null;
  if (first) {
    try {
      require('fs').writeFileSync(require('path').join(__dirname, 'selftest-frame.jpg'), first);
      console.log('wrote selftest-frame.jpg (' + first.length + ' bytes)');
    } catch (e) {
      console.log('write failed:', e.message);
    }
  }

  const ok = frames > 5 && bad === 0 && decoded !== false;
  console.log(ok ? '\nPASS' : '\nFAIL');
  process.exitCode = ok ? 0 : 1;
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
