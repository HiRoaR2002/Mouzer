'use strict';

const os = require('os');
const dgram = require('dgram');

const VIRTUAL = /loopback|virtual|vmware|virtualbox|vethernet|hyper-v|docker|ws-?sl|bluetooth|tailscale|zerotier|npcap|hamachi|openvpn|pptp|l2tp|wireguard|utun|tun\d|tap\d/i;

/**
 * Ask the OS which local address it would use to reach the internet. Connecting
 * a UDP socket does not send any packets, but it still runs the routing lookup,
 * so this reliably picks the interface the phone can actually reach. Plain
 * enumeration cannot tell a Wi-Fi address from a hypervisor's, and guessing
 * there means printing a URL the phone cannot connect to.
 */
function detectOutboundIPv4() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    socket.on('error', () => done(null));
    // Port 9 (discard) is a blackhole; no payload is ever written to it.
    socket.connect(9, '1.1.1.1', () => {
      try {
        done(socket.address().address);
      } catch {
        done(null);
      }
    });
    setTimeout(() => done(null), 1200).unref();
  });
}

function isPrivateIPv4(ip) {
  if (ip.startsWith('127.')) return true;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  return false;
}

function listInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : `IPv${a.family}`;
      if (family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, private: isPrivateIPv4(a.address), virtual: VIRTUAL.test(name) });
    }
  }
  return out;
}

async function describeHost() {
  const platform = os.platform();
  const ifaces = listInterfaces();
  const outbound = await detectOutboundIPv4();

  // Prefer the routed address; fall back to any real-looking private adapter.
  const byPreference = (ip) => {
    const iface = ifaces.find((i) => i.address === ip);
    if (!iface) return 4;
    if (iface.virtual) return 3;
    if (!iface.private) return 1;
    return 0;
  };
  const candidates = [...new Set([outbound, ...ifaces.map((i) => i.address)].filter(Boolean))];
  candidates.sort((a, b) => byPreference(a) - byPreference(b));

  return {
    platform,
    osName: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || platform,
    arch: os.arch(),
    release: os.release(),
    primaryIPv4: candidates[0] || null,
    interfaces: ifaces,
  };
}

/**
 * Extra guidance for the OS features that silently break input injection and
 * screen capture. Reported at startup so failures are diagnosable up front.
 */
function permissionHints(platform) {
  if (platform === 'darwin') {
    return [
      'macOS needs two permissions under System Settings > Privacy & Security:',
      '  - Accessibility    (System Events) - required to move the mouse and type',
      '  - Screen Recording  - required to capture the screen',
      'Terminal must be restarted (or the app relaunched) after granting them.',
    ];
  }
  if (platform === 'linux') {
    return [
      'On X11 this works out of the box. On Wayland, synthetic input is normally',
      'blocked by the compositor: use XWayland apps, or the ydool/uinput backend',
      '(see README). Screen capture needs a compositor that allows gdigrab-equivalent grabs.',
    ];
  }
  if (platform === 'win32') {
    return [
      'Windows: no extra permissions required. Note that the secure desktop (UAC',
      'prompts, lock screen, Ctrl+Alt+Del) cannot be captured or controlled - that is',
      'a Windows security boundary, not a limitation of this app.',
    ];
  }
  return [];
}

module.exports = { describeHost, isPrivateIPv4, listInterfaces, detectOutboundIPv4, permissionHints };
