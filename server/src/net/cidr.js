'use strict';

/**
 * IPv4 / CIDR handling for the "local network only" access rule.
 *
 * Note on the threat model: this is a convenience boundary, not a security
 * boundary. Anyone on the same Wi-Fi can spoof a source address, and a hostile
 * network can route around it. Its job is to stop the host from being exposed to
 * the internet or to a guest network by accident. Real protection comes from the
 * pairing token.
 */

function parseIPv4(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function toInt32(ip) {
  const o = parseIPv4(ip);
  if (!o) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function parseCidr(cidr) {
  const [addr, bitsRaw] = String(cidr).trim().split('/');
  const base = toInt32(addr);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 24 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base, mask };
}

/** True when `ip` falls inside `cidr`. */
function inCidr(ip, cidr) {
  const needle = toInt32(ip);
  if (needle === null || !cidr) return false;
  return (needle & cidr.mask) >>> 0 === (cidr.base & cidr.mask) >>> 0;
}

/** Strips an IPv4-mapped IPv6 form (::ffff:192.168.1.5) down to plain IPv4. */
function normalizeAddress(raw) {
  if (!raw) return null;
  let ip = String(raw);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const pct = ip.indexOf('%');
  if (pct !== -1) ip = ip.slice(0, pct);
  return ip;
}

function isLoopback(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

class SubnetGuard {
  /**
   * @param allowAny   disable the check entirely (--allow-any)
   * @param extra      additional CIDRs from --subnet
   * @param hostIps    this machine's IPv4 addresses; a /24 around any of them is
   *                   allowed so a phone on the same LAN can connect even when
   *                   the phone's subnet is unusual (e.g. /16 carrier network)
   */
  constructor({ allowAny = false, extra = [], hostIps = [] } = {}) {
    this.allowAny = allowAny;
    this.extra = extra.map(parseCidr).filter(Boolean);
    this.local = hostIps.map((ip) => parseCidr(`${ip}/24`)).filter(Boolean);
    this.rejected = 0;
  }

  check(rawAddress) {
    if (this.allowAny) return { ok: true, reason: 'allow-any' };

    const ip = normalizeAddress(rawAddress);
    if (!ip) return this._deny(rawAddress, 'unparseable address');
    if (isLoopback(rawAddress)) return { ok: true, reason: 'loopback' };

    for (const cidr of this.extra) {
      if (inCidr(ip, cidr)) return { ok: true, reason: `explicit subnet ${cidr.base >>> 0}` };
    }
    for (const cidr of this.local) {
      if (inCidr(ip, cidr)) return { ok: true, reason: 'same subnet as host' };
    }
    return this._deny(ip, 'not on a local subnet');
  }

  _deny(address, reason) {
    this.rejected++;
    return { ok: false, address, reason };
  }
}

module.exports = { parseIPv4, toInt32, parseCidr, inCidr, normalizeAddress, isLoopback, SubnetGuard };
