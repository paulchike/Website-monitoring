const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const SERVER_PORT = Number(process.env.PORT) || 3000;

/**
 * Checks whether an IPv4 address is in a private, loopback, link-local,
 * cloud metadata, or reserved range.
 */
function isPrivateOrReservedIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IP is unsafe
  }

  const [a, b, c] = parts;

  // 0.0.0.0/8 Current network
  if (a === 0) return true;

  // 10.0.0.0/8 Private network
  if (a === 10) return true;

  // 100.64.0.0/10 Shared address space (Carrier-Grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 127.0.0.0/8 Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 Link-local & Cloud Metadata (169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 Private network
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.0.0.0/24 IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 Documentation (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;

  // 192.168.0.0/16 Private network
  if (a === 192 && b === 168) return true;

  // 198.18.0.0/15 Network benchmark tests
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 Documentation (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 Documentation (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 Multicast
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 Reserved for future use & 255.255.255.255 Broadcast
  if (a >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is in a loopback, link-local,
 * unique local (ULA), cloud metadata, or reserved range.
 */
function isPrivateOrReservedIPv6(ip) {
  const lower = ip.toLowerCase().trim();

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (lower.startsWith('::ffff:')) {
    const v4Part = lower.slice(7);
    if (net.isIPv4(v4Part)) {
      return isPrivateOrReservedIPv4(v4Part);
    }
  }

  // Loopback (::1) & Unspecified (::)
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // Link-Local: fe80::/10 (fe80 - febf)
  if (/^fe[89ab][0-9a-f]/i.test(lower)) {
    return true;
  }

  // Unique Local Address (ULA): fc00::/7 (fc00 - fdff), includes AWS metadata fd00:ec2::254
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) {
    return true;
  }

  // Multicast: ff00::/8
  if (lower.startsWith('ff')) {
    return true;
  }

  return false;
}

/**
 * Evaluates whether an IP address is considered private/reserved.
 */
function isRestrictedIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateOrReservedIPv4(ip);
  }
  if (family === 6) {
    return isPrivateOrReservedIPv6(ip);
  }
  return true; // Not a valid IP
}

/**
 * Known cloud metadata and sensitive hostnames.
 */
const CLOUD_METADATA_HOSTNAMES = new Set([
  '169.254.169.254',
  '169.254.169.250',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata',
  'instance-data'
]);

/**
 * Validates a target URL against SSRF rules.
 * Allows local self-monitoring on the server's own port (e.g. http://localhost:3000/health)
 * but strictly blocks cloud metadata and any unauthorized internal IP access.
 *
 * @param {string} urlString
 * @returns {Promise<{ safe: boolean, error?: string, parsedUrl?: URL, resolvedIps?: string[] }>}
 */
async function validateUrlForSSRF(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (e) {
    return { safe: false, error: 'Invalid URL format' };
  }

  // Protocol check: strictly http: or https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, error: 'Prohibited protocol: Only http: and https: are permitted' };
  }

  const hostname = parsed.hostname.toLowerCase().trim();
  const cleanHostname = hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);

  // 1. Explicit cloud metadata hostname check
  if (CLOUD_METADATA_HOSTNAMES.has(cleanHostname) || cleanHostname.endsWith('.google.internal')) {
    return { safe: false, error: 'Access to Cloud Instance Metadata Services is strictly prohibited' };
  }

  // 2. Check for local self-monitoring exception
  const isLoopbackHost = cleanHostname === 'localhost' || cleanHostname === '127.0.0.1' || cleanHostname === '::1';
  if (isLoopbackHost) {
    // Only permit loopback access to NOC monitor's own port for self-health probe
    const isSelfPort = port === SERVER_PORT;
    const isAllowedPath = parsed.pathname === '/health' || parsed.pathname.startsWith('/api/mock/');
    if (isSelfPort && isAllowedPath) {
      return { safe: true, parsedUrl: parsed, resolvedIps: ['127.0.0.1'] };
    }
    return { safe: false, error: `Loopback access restricted: Probing internal port ${port} is prohibited by SSRF security policy` };
  }

  // 3. If hostname is directly an IP literal
  if (net.isIP(cleanHostname)) {
    if (isRestrictedIP(cleanHostname)) {
      return { safe: false, error: `Direct access to private or reserved IP address (${cleanHostname}) is prohibited` };
    }
    return { safe: true, parsedUrl: parsed, resolvedIps: [cleanHostname] };
  }

  // 4. DNS Resolution Check to prevent DNS Rebinding to private/metadata IPs
  try {
    const addresses = await dns.lookup(cleanHostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { safe: false, error: 'DNS resolution failed: Host does not resolve' };
    }

    const resolvedIps = addresses.map(a => a.address);

    for (const addr of addresses) {
      if (isRestrictedIP(addr.address)) {
        return {
          safe: false,
          error: `DNS resolution security block: Host "${cleanHostname}" resolves to restricted IP ${addr.address}`,
          resolvedIps
        };
      }
    }

    return { safe: true, parsedUrl: parsed, resolvedIps };
  } catch (dnsErr) {
    // If DNS lookup fails, return safe: false
    return { safe: false, error: `DNS resolution error: ${dnsErr.message}` };
  }
}

/**
 * Creates a DNS lookup hook for http/https request options that enforces
 * SSRF verification on every connection attempt (defeating time-of-check to time-of-use rebinding).
 */
function createSafeLookup() {
  return function safeLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' ? options : {};

    const cleanHost = hostname.replace(/^\[|\]$/g, '').toLowerCase().trim();

    if (CLOUD_METADATA_HOSTNAMES.has(cleanHost) || cleanHost.endsWith('.google.internal')) {
      return cb(new Error(`SSRF Blocked: Prohibited metadata host "${hostname}"`));
    }

    if (net.isIP(cleanHost) && isRestrictedIP(cleanHost)) {
      const isLoopback = cleanHost === '127.0.0.1' || cleanHost === '::1';
      if (!isLoopback) {
        return cb(new Error(`SSRF Blocked: Direct connection to restricted IP ${cleanHost} prohibited`));
      }
    }

    require('dns').lookup(cleanHost, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      if (!addresses || addresses.length === 0) {
        return cb(new Error('DNS lookup returned no addresses'));
      }

      // Allow self-health check on localhost
      const isLoopbackHost = cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1';
      if (!isLoopbackHost) {
        for (const item of addresses) {
          if (isRestrictedIP(item.address)) {
            return cb(new Error(`SSRF Blocked: Host "${hostname}" resolved to restricted IP ${item.address}`));
          }
        }
      }

      if (opts.all) {
        cb(null, addresses);
      } else {
        const first = addresses[0];
        cb(null, first.address, first.family);
      }
    });
  };
}

module.exports = {
  isPrivateOrReservedIPv4,
  isPrivateOrReservedIPv6,
  isRestrictedIP,
  validateUrlForSSRF,
  createSafeLookup,
  CLOUD_METADATA_HOSTNAMES
};
