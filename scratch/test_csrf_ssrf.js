const assert = require('assert');
const { generateCsrfToken, verifyCsrfToken, generateToken } = require('../server/auth');
const { validateUrlForSSRF, createSafeLookup, isRestrictedIP } = require('../server/ssrf');
const { performCheck } = require('../server/checker');
const apiRouter = require('../server/api');

async function runTests() {
  console.log('====================================================');
  console.log('       SECURITY TEST SUITE: CSRF & SSRF DEFENSES');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(e);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(e);
      failed++;
    }
  }

  /* ------------------------------------------------------------------------
     1. CSRF Token Generation & Cryptographic Verification Tests
     ------------------------------------------------------------------------ */
  console.log('--- 1. Anti-CSRF Token Generation & Verification ---');

  test('generateCsrfToken creates a signed token with 2 parts', () => {
    const token = generateCsrfToken(1);
    assert(typeof token === 'string');
    assert(token.includes('.'));
    const parts = token.split('.');
    assert.strictEqual(parts.length, 2);
  });

  test('verifyCsrfToken validates a freshly generated token', () => {
    const token = generateCsrfToken(42);
    assert.strictEqual(verifyCsrfToken(token), true);
  });

  test('verifyCsrfToken rejects tampered signature', () => {
    const token = generateCsrfToken(1);
    const [payload, sig] = token.split('.');
    const tamperedSig = sig.slice(0, -4) + 'abcd';
    assert.strictEqual(verifyCsrfToken(`${payload}.${tamperedSig}`), false);
  });

  test('verifyCsrfToken rejects tampered payload', () => {
    const token = generateCsrfToken(1);
    const [, sig] = token.split('.');
    const fakePayload = Buffer.from(JSON.stringify({ uid: 999, exp: Date.now() + 100000 })).toString('base64url');
    assert.strictEqual(verifyCsrfToken(`${fakePayload}.${sig}`), false);
  });

  test('verifyCsrfToken rejects session auth tokens (Domain Separation)', () => {
    const sessionToken = generateToken({ id: 1, username: 'admin', role: 'ADMIN', group_id: 1 });
    assert.strictEqual(verifyCsrfToken(sessionToken), false, 'Session token must not be accepted as CSRF token');
  });

  test('verifyCsrfToken rejects null, empty or garbage string', () => {
    assert.strictEqual(verifyCsrfToken(null), false);
    assert.strictEqual(verifyCsrfToken(''), false);
    assert.strictEqual(verifyCsrfToken('invalid.garbage.token'), false);
    assert.strictEqual(verifyCsrfToken('notatoken'), false);
  });

  /* ------------------------------------------------------------------------
     2. Express Router Anti-CSRF Middleware Tests
     ------------------------------------------------------------------------ */
  console.log('\n--- 2. Express API Anti-CSRF Middleware Enforcement ---');

  function invokeRouter(method, path, headers = {}, body = {}) {
    return new Promise((resolve) => {
      let statusCode = 200;
      let responseData = null;
      let headersSent = {};

      const req = {
        method,
        url: path,
        path,
        headers: { host: 'localhost:3000', ...headers },
        body,
        query: {},
        params: {},
        socket: { remoteAddress: '127.0.0.1' }
      };

      const res = {
        status(code) {
          statusCode = code;
          return res;
        },
        setHeader(k, v) {
          headersSent[k.toLowerCase()] = v;
          return res;
        },
        json(data) {
          responseData = data;
          resolve({ statusCode, responseData, headersSent });
          return res;
        },
        send(data) {
          responseData = data;
          resolve({ statusCode, responseData, headersSent });
          return res;
        }
      };

      apiRouter.handle(req, res, () => {
        resolve({ statusCode, responseData, headersSent, passed: true });
      });
    });
  }

  await testAsync('GET /api/auth/csrf-token issues a valid anti-CSRF token', async () => {
    const res = await invokeRouter('GET', '/auth/csrf-token');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.responseData.success, true);
    assert(res.responseData.csrfToken);
    assert.strictEqual(verifyCsrfToken(res.responseData.csrfToken), true);
  });

  await testAsync('State-changing POST rejected with 403 when CSRF token is missing (with cookie)', async () => {
    const res = await invokeRouter('POST', '/monitors/1/check', {
      cookie: 'noc_token=some-session-token'
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('CSRF verification failed'));
  });

  await testAsync('State-changing POST rejected with 403 when CSRF token is invalid', async () => {
    const res = await invokeRouter('POST', '/monitors/1/check', {
      cookie: 'noc_token=some-session-token',
      'x-csrf-token': 'invalid-forged-csrf-token'
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('CSRF verification failed'));
  });

  await testAsync('State-changing POST rejected with 403 on cross-origin Origin mismatch', async () => {
    const validCsrf = generateCsrfToken(1);
    const res = await invokeRouter('POST', '/monitors/1/check', {
      origin: 'https://evil-attacker.com',
      'x-csrf-token': validCsrf
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('Origin mismatch'));
  });

  await testAsync('State-changing POST rejected with 403 on cross-origin Referer mismatch', async () => {
    const validCsrf = generateCsrfToken(1);
    const res = await invokeRouter('POST', '/monitors/1/check', {
      referer: 'https://evil-attacker.com/malicious-page.html',
      'x-csrf-token': validCsrf
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('Referer mismatch'));
  });

  await testAsync('State-changing POST passes CSRF middleware when valid X-CSRF-Token is provided', async () => {
    const validCsrf = generateCsrfToken(1);
    // POST /monitors/1/check will pass CSRF check and proceed to handler
    const res = await invokeRouter('POST', '/monitors/1/check', {
      'x-csrf-token': validCsrf,
      origin: 'http://localhost:3000'
    });
    // Status is 200 (if monitor 1 exists) or 404 (if monitor 1 doesn't exist), but NOT 403 CSRF rejected!
    assert.notStrictEqual(res.statusCode, 403);
  });

  await testAsync('POST /api/auth/login is exempt from pre-existing CSRF token requirement', async () => {
    // Calling login without CSRF token should NOT return 403 CSRF error
    const res = await invokeRouter('POST', '/auth/login', {}, { username: 'admin', password: 'bad-password' });
    // Expect 401 Unauthorized for bad password, NOT 403 CSRF error!
    assert.strictEqual(res.statusCode, 401);
    assert(res.responseData.error.includes('Invalid username or password'));
  });

  /* ------------------------------------------------------------------------
     3. SSRF URL & IP Restriction Policy Tests
     ------------------------------------------------------------------------ */
  console.log('\n--- 3. SSRF URL Validation & IP Restriction Policy ---');

  test('isRestrictedIP flags AWS/Azure/GCP cloud metadata IP (169.254.169.254)', () => {
    assert.strictEqual(isRestrictedIP('169.254.169.254'), true);
  });

  test('isRestrictedIP flags RFC 1918 private IPv4 spaces', () => {
    assert.strictEqual(isRestrictedIP('10.0.0.1'), true);
    assert.strictEqual(isRestrictedIP('10.254.254.254'), true);
    assert.strictEqual(isRestrictedIP('172.16.0.1'), true);
    assert.strictEqual(isRestrictedIP('172.31.255.255'), true);
    assert.strictEqual(isRestrictedIP('192.168.0.1'), true);
    assert.strictEqual(isRestrictedIP('192.168.1.254'), true);
  });

  test('isRestrictedIP flags Loopback and Carrier-Grade NAT', () => {
    assert.strictEqual(isRestrictedIP('127.0.0.1'), true);
    assert.strictEqual(isRestrictedIP('127.0.0.2'), true);
    assert.strictEqual(isRestrictedIP('100.64.0.1'), true);
    assert.strictEqual(isRestrictedIP('100.127.255.255'), true);
    assert.strictEqual(isRestrictedIP('0.0.0.0'), true);
  });

  test('isRestrictedIP allows public IP addresses', () => {
    assert.strictEqual(isRestrictedIP('8.8.8.8'), false);
    assert.strictEqual(isRestrictedIP('1.1.1.1'), false);
    assert.strictEqual(isRestrictedIP('93.184.216.34'), false);
  });

  test('isRestrictedIP flags IPv6 loopback, ULA, and metadata', () => {
    assert.strictEqual(isRestrictedIP('::1'), true);
    assert.strictEqual(isRestrictedIP('fe80::1'), true);
    assert.strictEqual(isRestrictedIP('fc00::1'), true);
    assert.strictEqual(isRestrictedIP('fd00:ec2::254'), true); // AWS EC2 IPv6 metadata
    assert.strictEqual(isRestrictedIP('::ffff:127.0.0.1'), true); // IPv4-mapped
    assert.strictEqual(isRestrictedIP('::ffff:169.254.169.254'), true);
  });

  await testAsync('validateUrlForSSRF blocks AWS/Azure metadata IP URL', async () => {
    const res = await validateUrlForSSRF('http://169.254.169.254/latest/meta-data/');
    assert.strictEqual(res.safe, false);
    assert(res.error.includes('Metadata') || res.error.includes('prohibited'));
  });

  await testAsync('validateUrlForSSRF blocks Google Cloud metadata hostname', async () => {
    const res = await validateUrlForSSRF('http://metadata.google.internal/computeMetadata/v1/');
    assert.strictEqual(res.safe, false);
    assert(res.error.includes('Metadata'));
  });

  await testAsync('validateUrlForSSRF blocks private internal LAN targets', async () => {
    const res1 = await validateUrlForSSRF('http://10.0.0.5:8080/internal-api');
    assert.strictEqual(res1.safe, false);

    const res2 = await validateUrlForSSRF('http://192.168.1.1/router-login');
    assert.strictEqual(res2.safe, false);

    const res3 = await validateUrlForSSRF('http://172.16.10.20/db');
    assert.strictEqual(res3.safe, false);
  });

  await testAsync('validateUrlForSSRF blocks dangerous loopback ports (SSH, Redis, etc.)', async () => {
    const res1 = await validateUrlForSSRF('http://localhost:22/');
    assert.strictEqual(res1.safe, false);
    assert(res1.error.includes('Loopback access restricted'));

    const res2 = await validateUrlForSSRF('http://127.0.0.1:6379/');
    assert.strictEqual(res2.safe, false);

    const res3 = await validateUrlForSSRF('http://localhost:8080/admin');
    assert.strictEqual(res3.safe, false);
  });

  await testAsync('validateUrlForSSRF allows legitimate NOC self-health check', async () => {
    const res1 = await validateUrlForSSRF('http://localhost:3000/health');
    assert.strictEqual(res1.safe, true);

    const res2 = await validateUrlForSSRF('http://127.0.0.1:3000/api/mock/flaky');
    assert.strictEqual(res2.safe, true);
  });

  await testAsync('validateUrlForSSRF blocks non-HTTP/HTTPS protocols', async () => {
    const res1 = await validateUrlForSSRF('file:///etc/passwd');
    assert.strictEqual(res1.safe, false);

    const res2 = await validateUrlForSSRF('gopher://127.0.0.1:6379/_flushall');
    assert.strictEqual(res2.safe, false);

    const res3 = await validateUrlForSSRF('ftp://internal.backup.srv/');
    assert.strictEqual(res3.safe, false);
  });

  /* ------------------------------------------------------------------------
     4. Target Creation & Editing SSRF Pre-Validation in API
     ------------------------------------------------------------------------ */
  console.log('\n--- 4. Target Creation & Editing SSRF Pre-Validation ---');

  const adminToken = generateToken({ id: 1, username: 'admin', role: 'ADMIN', group_id: 1 });
  const csrfToken = generateCsrfToken(1);

  await testAsync('POST /api/monitors rejects AWS metadata IP target with 400 Bad Request', async () => {
    const res = await invokeRouter('POST', '/monitors', {
      authorization: `Bearer ${adminToken}`,
      'x-csrf-token': csrfToken
    }, {
      name: 'SSRF Exploit Probe',
      url: 'http://169.254.169.254/latest/meta-data/'
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('SSRF Security Policy Block'));
  });

  await testAsync('POST /api/monitors rejects private LAN IP (192.168.1.1) with 400 Bad Request', async () => {
    const res = await invokeRouter('POST', '/monitors', {
      authorization: `Bearer ${adminToken}`,
      'x-csrf-token': csrfToken
    }, {
      name: 'Internal Router Target',
      url: 'http://192.168.1.1/admin'
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('SSRF Security Policy Block'));
  });

  await testAsync('POST /api/monitors rejects loopback port 22 with 400 Bad Request', async () => {
    const res = await invokeRouter('POST', '/monitors', {
      authorization: `Bearer ${adminToken}`,
      'x-csrf-token': csrfToken
    }, {
      name: 'Local SSH Target',
      url: 'http://127.0.0.1:22/'
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.error.includes('SSRF Security Policy Block'));
  });

  /* ------------------------------------------------------------------------
     5. Checker SSRF Defense Pre-Flight Check Tests
     ------------------------------------------------------------------------ */
  console.log('\n--- 5. Network Health Checker SSRF Defense ---');

  await testAsync('performCheck blocks AWS metadata URL without executing network probe', async () => {
    const result = await performCheck({
      url: 'http://169.254.169.254/latest/meta-data/',
      timeout_ms: 1000
    });
    assert.strictEqual(result.status, 'DOWN');
    assert(result.error_message.includes('SSRF Security Block'));
  });

  await testAsync('performCheck blocks internal network probe (10.0.0.1)', async () => {
    const result = await performCheck({
      url: 'http://10.0.0.1:8080/admin',
      timeout_ms: 1000
    });
    assert.strictEqual(result.status, 'DOWN');
    assert(result.error_message.includes('SSRF Security Block'));
  });

  await testAsync('performCheck blocks unauthorized loopback port (localhost:22)', async () => {
    const result = await performCheck({
      url: 'http://localhost:22/',
      timeout_ms: 1000
    });
    assert.strictEqual(result.status, 'DOWN');
    assert(result.error_message.includes('SSRF Security Block'));
  });

  /* ------------------------------------------------------------------------
     6. DNS Rebinding Mitigation (createSafeLookup)
     ------------------------------------------------------------------------ */
  console.log('\n--- 6. DNS Rebinding Mitigation Hook ---');

  test('createSafeLookup returns a function with lookup signature', () => {
    const safeLookup = createSafeLookup();
    assert.strictEqual(typeof safeLookup, 'function');
  });

  await testAsync('createSafeLookup blocks connection to metadata hostnames', async () => {
    const safeLookup = createSafeLookup();
    await new Promise((resolve) => {
      safeLookup('metadata.google.internal', {}, (err, addr) => {
        assert(err !== null, 'Should return error for metadata host');
        assert(err.message.includes('SSRF Blocked'));
        resolve();
      });
    });
  });

  console.log('\n====================================================');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
