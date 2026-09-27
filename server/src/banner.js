'use strict';

const QRCode = require('qrcode');
const os = require('os');

const BOLD = (s) => `\u001b[1m${s}\u001b[0m`;
const DIM = (s) => `\u001b[90m${s}\u001b[0m`;
const CYAN = (s) => `\u001b[36m${s}\u001b[0m`;
const GREEN = (s) => `\u001b[32m${s}\u001b[0m`;
const YELLOW = (s) => `\u001b[33m${s}\u001b[0m`;

const RULE = '─'.repeat(58);

/**
 * Renders the QR from qrcode's raw bit matrix rather than QRCode.toString(),
 * because the latter refuses to run when stdout is not a TTY - which is exactly
 * when this output is most likely being piped to a file or a log.
 *
 * Modules are drawn dark-on-light with a white background, which is the
 * orientation phone cameras read most reliably.
 */
function renderQr(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const quiet = 4;
  const total = size + quiet * 2;
  const at = (row, col) => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= size || c >= size) return 0;
    return data[r * size + c] ? 1 : 0;
  };

  const lines = [];
  for (let row = 0; row < total; row += 2) {
    let line = '';
    for (let col = 0; col < total; col++) {
      line += at(row, col) ? '██' : '  ';
    }
    lines.push(line);
  }
  return lines;
}

function renderBanner({ version, host, url, pin, config, capture, auth, stateFile, captureError }) {
  const out = [];
  const nics = host.interfaces.map((i) => `${i.address}${i.name ? ` (${i.name})` : ''}`);

  out.push('');
  out.push(BOLD(`  Mouzer ${version}`) + DIM('  ·  control this PC from your phone'));
  out.push('');
  out.push(`  ${RULE}`);
  out.push('');
  out.push(`  ${BOLD('THIS PC')}`);
  // os.release() reports the kernel (10.0.x) even on Windows 11, so label it
  // honestly instead of letting it read as the wrong product name.
  out.push(`    OS        ${host.osName} ${DIM(`(build ${host.release}, ${host.arch})`)}`);
  out.push(`    CPU       ${os.cpus()[0]?.model?.trim() || 'unknown'}`);
  out.push(`    Network   ${host.primaryIPv4} ${CYAN('(open this one on the phone)')}`);
  if (nics.length > 1) {
    for (const nic of nics.filter((n) => !n.startsWith(host.primaryIPv4))) {
      out.push(DIM(`              also: ${nic}`));
    }
  }

  const display = capture.displays[capture.settings.monitor];
  out.push('');
  out.push(`  ${BOLD('SCREEN')}`);
  out.push(`    Stream    ${config.capture ? 'enabled' : YELLOW('disabled')}  via ${capture.backendName || 'n/a'}`);
  if (display) {
    out.push(`    Monitor   #${capture.settings.monitor} ${display.name}  ${display.width}x${display.height}${display.primary ? DIM('  (primary)') : ''}`);
  }
  out.push(
    `    Quality   ${capture.settings.fps} fps · ${capture.settings.scale}% scale · JPEG q${capture.settings.quality}`,
  );
  if (captureError) {
    out.push(`    ${YELLOW('ERROR')}     ${captureError.message.split('\n')[0]}`);
  }
  out.push(`    Control   ${config.input ? 'mouse + keyboard enabled' : YELLOW('view-only (--no-input)')}`);

  out.push('');
  out.push(`  ${BOLD('CONNECT FROM YOUR PHONE')}`);
  out.push('');
  out.push(`    ${BOLD(CYAN(url))}`);
  out.push('');
  out.push(`    pairing PIN   ${BOLD(GREEN(pin))}`);
  out.push(`    ${DIM(`valid until restart or PIN change · ${auth.ttlMs / 3600000 | 0}h sessions`)}`);

  try {
    const qr = renderQr(url);
    out.push('');
    out.push(`  ${'\u001b[47m\u001b[30m'}`);
    for (const line of qr) out.push('  ' + line);
    out.push(`  ${'\u001b[0m'}`);
    out.push(DIM('    scan with your phone camera, then enter the PIN above'));
  } catch {
    /* QR is a convenience; the URL above is authoritative */
  }

  out.push('');
  out.push(`  ${BOLD('ACCESS')}`);
  out.push(
    `    ${config.allowAny ? YELLOW('ANY address accepted (--allow-any)') : `local subnets only${config.subnets.length ? ` + ${config.subnets.join(', ')}` : ''}`}`,
  );
  out.push(DIM(`    state file: ${stateFile}`));
  out.push('');
  out.push(`  ${RULE}`);
  out.push('');
  return out.join('\n');
}

module.exports = { renderBanner };
