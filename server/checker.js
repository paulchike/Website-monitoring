const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Performs a comprehensive network health check with high-precision timing breakdown,
 * SSL certificate inspection, status verification, redirect handling, and custom headers.
 *
 * @param {Object} monitor
 * @param {number} redirectHop
 * @returns {Promise<Object>} checkResult
 */
async function performCheck(monitor, redirectHop = 0) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(monitor.url);
    } catch (err) {
      return resolve({
        status: 'DOWN',
        status_code: 0,
        response_time_ms: 0,
        dns_time_ms: 0,
        tcp_time_ms: 0,
        tls_time_ms: 0,
        ttfb_ms: 0,
        error_message: `Invalid URL format: ${err.message}`,
        ssl_days_remaining: null,
        ssl_valid: null,
        ssl_issuer: null
      });
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const timeoutMs = monitor.timeout_ms || 10000;

    let dnsStart = 0;
    let dnsEnd = 0;
    let tcpStart = 0;
    let tcpEnd = 0;
    let tlsStart = 0;
    let tlsEnd = 0;
    let ttfbEnd = 0;
    const requestStart = performance.now();

    let sslDaysRemaining = null;
    let sslValid = null;
    let sslIssuer = null;
    let settled = false;

    // Default headers emulate a modern web browser to avoid generic bot blocks
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Connection': 'close'
    };

    // Parse custom headers (JSON or "Header-Name: Value" per line)
    if (monitor.custom_headers && monitor.custom_headers.trim() !== '') {
      const raw = monitor.custom_headers.trim();
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          Object.assign(headers, parsed);
        } catch (e) {
          console.warn('[Checker] Failed to parse custom_headers as JSON:', e.message);
        }
      } else {
        raw.split('\n').forEach(line => {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.substring(0, idx).trim();
            const v = line.substring(idx + 1).trim();
            if (k && v) headers[k] = v;
          }
        });
      }
    }

    const options = {
      method: monitor.method || 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false
    };

    const req = client.request(options, (res) => {
      ttfbEnd = performance.now();

      // Inspect SSL Certificate if HTTPS
      if (isHttps && req.socket) {
        try {
          const cert = req.socket.getPeerCertificate(true);
          if (cert && cert.valid_to) {
            const validTo = new Date(cert.valid_to);
            const now = new Date();
            const diffTime = validTo.getTime() - now.getTime();
            sslDaysRemaining = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
            sslValid = diffTime > 0 ? 1 : 0;
            sslIssuer = cert.issuer ? (cert.issuer.O || cert.issuer.CN || 'Unknown') : 'Unknown';
          }
        } catch (certErr) {
          console.warn(`[Checker] SSL inspection failed for ${monitor.url}:`, certErr.message);
        }
      }

      // Handle HTTP redirects (301, 302, 307, 308) up to 3 hops
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirectHop < 3) {
        if (!settled) {
          settled = true;
          req.destroy();
          try {
            const nextUrl = new URL(res.headers.location, parsedUrl).toString();
            return resolve(performCheck({ ...monitor, url: nextUrl }, redirectHop + 1));
          } catch (redirErr) {
            // If redirect resolution fails, fall through to evaluate as-is
          }
        }
      }

      let responseBody = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        // Read at most 256KB to verify keyword without high memory usage
        if (responseBody.length < 262144) {
          responseBody += chunk;
        }
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;

        const requestEnd = performance.now();
        const totalDurationMs = Math.max(0.1, requestEnd - requestStart);
        const dnsMs = (dnsEnd > 0 && dnsStart > 0 && dnsEnd >= dnsStart) ? (dnsEnd - dnsStart) : 0;
        const tcpMs = (tcpEnd > 0 && tcpStart > 0 && tcpEnd >= tcpStart) ? (tcpEnd - tcpStart) : 0;
        const tlsMs = (tlsEnd > 0 && tlsStart > 0 && tlsEnd >= tlsStart) ? (tlsEnd - tlsStart) : 0;
        const ttfbMs = (ttfbEnd > 0 && ttfbEnd >= requestStart) ? (ttfbEnd - requestStart) : 0;

        const expectedStatus = monitor.expected_status || 200;

        let status = 'UP';
        let errorMessage = null;

        // Check for common Database Error signatures in response body (e.g. soft 200/500 database outages)
        let detectedDbError = null;
        const dbErrorPatterns = [
          { pattern: /error establishing a database connection/i, name: 'Database Connection Error (WordPress/MySQL)' },
          { pattern: /cannot connect to (the )?database/i, name: 'Cannot connect to database' },
          { pattern: /database connection (failed|error)/i, name: 'Database Connection Failed' },
          { pattern: /sqlstate\[[a-z0-9]+\]/i, name: 'SQLSTATE Database Exception' },
          { pattern: /too many connections/i, name: 'Database "Too Many Connections" Limit Exceeded' },
          { pattern: /deadlock found when trying to get lock/i, name: 'Database Deadlock Error' },
          { pattern: /could not connect to server: connection refused/i, name: 'Postgres Connection Refused' },
          { pattern: /mongo(db)? (server selection|connection) error/i, name: 'MongoDB Connection Error' },
          { pattern: /database (down|unavailable|offline)/i, name: 'Database Offline' }
        ];

        for (const dbCheck of dbErrorPatterns) {
          if (dbCheck.pattern.test(responseBody)) {
            detectedDbError = dbCheck.name;
            break;
          }
        }

        // Check for Web Server Unknown Error / Cloudflare Error code 520 signatures in response body
        let detectedWebServer520Error = null;
        const webServer520Patterns = [
          { pattern: /web server is returning an unknown error/i, name: 'Web server is returning an unknown error (Error code 520)' },
          { pattern: /error code 520/i, name: 'Cloudflare Error code 520 (Web server returning unknown error)' },
          { pattern: /error 520(\s|:|-|<)/i, name: 'Error 520: Web server is returning an unknown error' },
          { pattern: /there is an unknown error on the origin web server/i, name: 'Origin Web Server Unknown Error (Error code 520)' }
        ];

        for (const wsCheck of webServer520Patterns) {
          if (wsCheck.pattern.test(responseBody)) {
            detectedWebServer520Error = wsCheck.name;
            break;
          }
        }

        // Verify status code
        const isStatusMatch = (expectedStatus >= 100 && expectedStatus < 600)
          ? statusCode === expectedStatus
          : (statusCode >= 200 && statusCode < 400);

        if (detectedWebServer520Error || statusCode === 520) {
          // Downtime Trigger: Web server is returning an unknown error (Error code 520)
          status = 'DOWN';
          if (statusCode === 520) {
            errorMessage = 'HTTP 520: Web server is returning an unknown error (Error code 520)';
          } else if (statusCode === 503) {
            errorMessage = 'HTTP 503 Service Unavailable: Web server is returning an unknown error (Error code 520)';
          } else if (statusCode > 0 && statusCode !== 200) {
            errorMessage = `HTTP ${statusCode}: Web server is returning an unknown error (Error code 520)`;
          } else {
            errorMessage = 'Web server is returning an unknown error (Error code 520)';
          }
        } else if (detectedDbError) {
          status = 'DOWN';
          errorMessage = `Database Error: ${detectedDbError}`;
        } else if (statusCode === 503) {
          // Downtime Trigger: HTTP 503 Service Unavailable
          status = 'DOWN';
          errorMessage = 'HTTP 503 Service Unavailable';
        } else if (!isStatusMatch) {
          status = 'DOWN';
          if (statusCode === 404) {
            errorMessage = 'HTTP 404 Not Found (Page does not exist)';
          } else if (statusCode === 403 && (res.headers['server'] === 'cloudflare' || responseBody.includes('Just a moment...'))) {
            errorMessage = 'Cloudflare WAF Block (HTTP 403 - Bot/Challenge Gate)';
          } else if (statusCode === 500) {
            errorMessage = 'HTTP 500 Internal Server Error';
          } else if (statusCode === 502) {
            errorMessage = 'HTTP 502 Bad Gateway';
          } else if (statusCode === 503) {
            errorMessage = 'HTTP 503 Service Unavailable';
          } else if (statusCode === 504) {
            errorMessage = 'HTTP 504 Gateway Timeout';
          } else if (statusCode === 520) {
            errorMessage = 'HTTP 520: Web server is returning an unknown error (Error code 520)';
          } else if (statusCode === 521) {
            errorMessage = 'HTTP 521 Web Server Is Down';
          } else if (statusCode === 522) {
            errorMessage = 'HTTP 522 Connection Timed Out (Cloudflare)';
          } else if (statusCode === 523) {
            errorMessage = 'HTTP 523 Origin Is Unreachable';
          } else if (statusCode === 524) {
            errorMessage = 'HTTP 524 A Timeout Occurred';
          } else if (statusCode === 525) {
            errorMessage = 'HTTP 525 SSL Handshake Failed';
          } else if (statusCode === 526) {
            errorMessage = 'HTTP 526 Invalid SSL Certificate';
          } else {
            errorMessage = `HTTP Status mismatch: received ${statusCode}, expected ${expectedStatus}`;
          }
        }

        // Verify keyword assertion if set
        if (status === 'UP' && monitor.keyword_check && monitor.keyword_check.trim() !== '') {
          const keyword = monitor.keyword_check.trim();
          if (!responseBody.includes(keyword)) {
            status = 'DOWN';
            errorMessage = `Keyword assertion failed: missing "${keyword}" in response`;
          }
        }

        // Verify SSL health
        if (status === 'UP' && monitor.ssl_check_enabled && isHttps) {
          if (sslValid === 0) {
            status = 'DOWN';
            errorMessage = `SSL Certificate expired!`;
          } else if (sslDaysRemaining !== null && sslDaysRemaining <= 14) {
            status = 'DEGRADED';
            errorMessage = `SSL Certificate expiring in ${sslDaysRemaining} days`;
          }
        }

        // Latency thresholds for DEGRADED state
        if (status === 'UP' && totalDurationMs > 2500) {
          status = 'DEGRADED';
          errorMessage = `High latency detected: ${Math.round(totalDurationMs)}ms (threshold: 2500ms)`;
        }

        resolve({
          status,
          status_code: statusCode,
          response_time_ms: Math.round(totalDurationMs * 10) / 10,
          dns_time_ms: Math.round(dnsMs * 10) / 10,
          tcp_time_ms: Math.round(tcpMs * 10) / 10,
          tls_time_ms: isHttps ? Math.round(tlsMs * 10) / 10 : null,
          ttfb_ms: Math.round(ttfbMs * 10) / 10,
          error_message: errorMessage,
          ssl_days_remaining: sslDaysRemaining,
          ssl_valid: sslValid,
          ssl_issuer: sslIssuer
        });
      });
    });

    // Capture socket events for network phase timings
    req.on('socket', (socket) => {
      dnsStart = performance.now();

      socket.on('lookup', () => {
        dnsEnd = performance.now();
        tcpStart = performance.now();
      });

      socket.on('connect', () => {
        tcpEnd = performance.now();
        if (isHttps) {
          tlsStart = performance.now();
        }
      });

      socket.on('secureConnect', () => {
        tlsEnd = performance.now();
      });
    });

    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      const totalDurationMs = performance.now() - requestStart;
      const dnsMs = (dnsEnd > 0 && dnsStart > 0 && dnsEnd >= dnsStart) ? (dnsEnd - dnsStart) : 0;
      const tcpMs = (tcpEnd > 0 && tcpStart > 0 && tcpEnd >= tcpStart) ? (tcpEnd - tcpStart) : 0;
      resolve({
        status: 'DOWN',
        status_code: 0,
        response_time_ms: Math.round(totalDurationMs * 10) / 10,
        dns_time_ms: Math.round(dnsMs * 10) / 10,
        tcp_time_ms: Math.round(tcpMs * 10) / 10,
        tls_time_ms: null,
        ttfb_ms: 0,
        error_message: `Connection timed out after ${timeoutMs}ms`,
        ssl_days_remaining: null,
        ssl_valid: null,
        ssl_issuer: null
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      const totalDurationMs = performance.now() - requestStart;
      resolve({
        status: 'DOWN',
        status_code: 0,
        response_time_ms: Math.round(totalDurationMs * 10) / 10,
        dns_time_ms: 0,
        tcp_time_ms: 0,
        tls_time_ms: null,
        ttfb_ms: 0,
        error_message: `Connection error: ${err.message || err.code}`,
        ssl_days_remaining: null,
        ssl_valid: null,
        ssl_issuer: null
      });
    });

    req.end();
  });
}

module.exports = {
  performCheck
};
