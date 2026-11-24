const crypto = require('crypto');
const { db, queries } = require('./db');

// Known weak, default, or predictable secrets that must never be used in production
const WEAK_SECRETS_BLOCKLIST = new Set([
  'secret',
  'jwt_secret',
  'jwtsecret',
  'auth_secret',
  'authsecret',
  'password',
  '123456',
  '12345678',
  '123456789',
  'changeme',
  'admin',
  'default',
  'test',
  'noc-secure-fallback-secret-2026',
  'noc-secure-fallback-secret',
  'supersecret',
  'keyboardcat'
]);

/**
 * Validates whether a secret key meets production cryptographic requirements:
 * 1. String type and non-empty
 * 2. Minimum 32 characters (256 bits of entropy for HS256, adhering to RFC 7518 §3.2)
 * 3. Not in known weak secrets blocklist
 */
function isCryptographicallySecure(secret) {
  if (!secret || typeof secret !== 'string') return false;
  const trimmed = secret.trim();
  if (trimmed.length < 32) return false;

  const lower = trimmed.toLowerCase();
  if (WEAK_SECRETS_BLOCKLIST.has(lower)) return false;

  // Reject secrets containing obvious weak words or default tokens
  const weakKeywords = [
    'secret',
    'password',
    'changeme',
    'jwt_secret',
    'jwtsecret',
    'auth_secret',
    'authsecret',
    'supersecret',
    'keyboardcat',
    'fallback-secret'
  ];
  for (const kw of weakKeywords) {
    if (lower.includes(kw)) {
      return false;
    }
  }

  // Reject low character diversity (e.g. repeated characters or predictable sequences)
  const uniqueChars = new Set(trimmed).size;
  if (uniqueChars < 8) return false;

  return true;
}

/**
 * Derives a hardened 512-bit key using HKDF-SHA256 if an operator sets a weak key
 */
function hardenSecret(rawSecret) {
  return crypto.hkdfSync(
    'sha256',
    Buffer.from(rawSecret, 'utf8'),
    Buffer.from('pau-noc-jwt-salt-v1', 'utf8'),
    Buffer.from('jwt-signature-key-hardening', 'utf8'),
    64
  ).toString('hex');
}

/**
 * Generates a high-entropy 512-bit cryptographically secure random key
 */
function generateSecureRandomKey() {
  return crypto.randomBytes(64).toString('hex');
}

// Secret state container with rotation support
let jwtSecretState = {
  primarySecret: null,
  previousSecrets: [],
  source: 'uninitialized'
};

/**
 * Resolves the JWT HMAC secret using strict multi-tier hierarchy:
 * 1. Environment variable JWT_SECRET or AUTH_SECRET
 * 2. Persisted secret in SQLite settings table (jwt_secret / auth_secret)
 * 3. Auto-generated 512-bit cryptographically secure random key persisted to DB
 * 4. Ephemeral in-memory 512-bit random key (if DB write fails; never a static fallback string)
 */
function initializeJwtSecret() {
  const envSecret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
  let primarySecret = null;
  let source = 'unknown';

  if (envSecret && envSecret.trim().length > 0) {
    const trimmed = envSecret.trim();
    if (isCryptographicallySecure(trimmed)) {
      primarySecret = trimmed;
      source = 'environment';
    } else {
      console.warn('[Security Warning] JWT_SECRET in environment does not meet 256-bit entropy standards or is in the weak secrets blocklist. Cryptographically hardening secret using HKDF-SHA256.');
      primarySecret = hardenSecret(trimmed);
      source = 'environment_hardened';
    }
  } else {
    // Check database settings
    try {
      const stored = queries.getSetting.get('jwt_secret') || queries.getSetting.get('auth_secret');
      if (stored && stored.value && isCryptographicallySecure(stored.value)) {
        primarySecret = stored.value;
        source = 'database';
      } else {
        // Generate new high-entropy 512-bit key and persist
        const newSecret = generateSecureRandomKey();
        try {
          queries.setSetting.run('jwt_secret', newSecret);
          primarySecret = newSecret;
          source = 'generated_persisted';
        } catch (dbWriteErr) {
          primarySecret = newSecret;
          source = 'ephemeral';
          console.warn('[Security Alert] Unable to persist generated JWT secret to database:', dbWriteErr.message);
        }
      }
    } catch (dbReadErr) {
      primarySecret = generateSecureRandomKey();
      source = 'ephemeral';
      console.warn('[Security Alert] Database unavailable during JWT secret initialization. Using ephemeral 512-bit key:', dbReadErr.message);
    }
  }

  // Load previous secrets for zero-downtime key rotation
  const previousSecrets = [];
  const envPrev = process.env.JWT_PREVIOUS_SECRETS || process.env.AUTH_PREVIOUS_SECRETS;
  if (envPrev && typeof envPrev === 'string') {
    envPrev.split(',').forEach(s => {
      const trimmed = s.trim();
      if (trimmed.length > 0 && trimmed !== primarySecret && !previousSecrets.includes(trimmed)) {
        previousSecrets.push(trimmed);
      }
    });
  }

  try {
    const dbPrev = queries.getSetting.get('jwt_previous_secrets');
    if (dbPrev && dbPrev.value) {
      try {
        const parsed = JSON.parse(dbPrev.value);
        if (Array.isArray(parsed)) {
          parsed.forEach(s => {
            if (typeof s === 'string' && s.length > 0 && s !== primarySecret && !previousSecrets.includes(s)) {
              previousSecrets.push(s);
            }
          });
        }
      } catch (_) {}
    }
  } catch (_) {}

  jwtSecretState = {
    primarySecret,
    previousSecrets,
    source
  };

  return primarySecret;
}

// Initialize on module load
initializeJwtSecret();

/**
 * Administratively rotates the JWT secret.
 * Moves current secret to previousSecrets list to ensure zero-downtime for existing user sessions.
 *
 * @param {string} [customSecret] Optional custom secret; if omitted, generates a 512-bit random key
 * @returns {{ success: boolean, source: string, previousSecretsCount: number, rotatedAt: string }}
 */
function rotateJwtSecret(customSecret = null) {
  let newKey = customSecret ? customSecret.trim() : null;
  let source = 'generated';

  if (newKey) {
    if (!isCryptographicallySecure(newKey)) {
      newKey = hardenSecret(newKey);
      source = 'custom_hardened';
    } else {
      source = 'custom';
    }
  } else {
    newKey = generateSecureRandomKey();
    source = 'generated';
  }

  const oldSecret = jwtSecretState.primarySecret;
  const updatedPrevious = [oldSecret, ...jwtSecretState.previousSecrets.filter(s => s !== oldSecret)].slice(0, 5);

  try {
    queries.setSetting.run('jwt_secret', newKey);
    queries.setSetting.run('jwt_previous_secrets', JSON.stringify(updatedPrevious));
  } catch (e) {
    console.warn('[Security Warning] Failed to persist rotated JWT secret to database:', e.message);
  }

  jwtSecretState = {
    primarySecret: newKey,
    previousSecrets: updatedPrevious,
    source: `rotated_${source}`
  };

  return {
    success: true,
    source: jwtSecretState.source,
    previousSecretsCount: updatedPrevious.length,
    rotatedAt: new Date().toISOString()
  };
}

/**
 * Returns security metadata about the active JWT secret configuration.
 * Raw secret keys are NEVER exposed in this inspection response.
 */
function getJwtSecurityDetails() {
  const secret = jwtSecretState.primarySecret || '';
  return {
    algorithm: 'HS256',
    token_format: 'RFC-7519',
    key_source: jwtSecretState.source,
    key_length_chars: secret.length,
    key_entropy_bits: Math.min(512, secret.length * 8),
    is_secure: isCryptographicallySecure(secret),
    has_active_secret: Boolean(secret && secret.length >= 32),
    rotation_keys_configured: jwtSecretState.previousSecrets.length,
    session_duration_days: 7
  };
}

// Password hashing with native crypto.scrypt
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  try {
    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const hashBuf = Buffer.from(hash, 'hex');
    const testBuf = Buffer.from(testHash, 'hex');
    if (hashBuf.length !== testBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, testBuf);
  } catch (err) {
    return false;
  }
}

// Standard RFC 7519 JWT header for HMAC-SHA256
const JWT_HEADER_B64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/**
 * Issues an RFC 7519 standard JWT token signed with the active 512-bit HMAC secret
 * @param {Object} user
 * @returns {string} Standard 3-segment JWT (header.payload.signature)
 */
function generateToken(user) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + (7 * 24 * 60 * 60); // 7 days

  const payload = {
    iss: 'pau-noc-monitor',
    sub: String(user.id),
    uid: user.id,
    uname: user.username,
    role: user.role,
    gid: user.group_id,
    iat: nowSeconds,
    exp: expSeconds,
    exp_ms: Date.now() + 7 * 24 * 60 * 60 * 1000
  };

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', jwtSecretState.primarySecret)
    .update(`${JWT_HEADER_B64}.${payloadStr}`)
    .digest('base64url');

  return `${JWT_HEADER_B64}.${payloadStr}.${signature}`;
}

/**
 * Verifies a JWT token using constant-time comparison, algorithm verification,
 * and key rotation support. Handles both RFC 7519 3-segment JWTs and legacy 2-segment tokens.
 *
 * @param {string} token
 * @returns {Object|null} payload or null if invalid/expired
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 && parts.length !== 2) return null;

  try {
    const isStandardJwt = parts.length === 3;
    let headerStr = null;
    let payloadStr = null;
    let signature = null;
    let signedContent = null;

    if (isStandardJwt) {
      [headerStr, payloadStr, signature] = parts;

      // 1. Algorithm Verification: enforce HS256, strictly reject "none" or asymmetric algorithms
      const header = JSON.parse(Buffer.from(headerStr, 'base64url').toString('utf8'));
      if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') {
        return null;
      }
      signedContent = `${headerStr}.${payloadStr}`;
    } else {
      // Backwards-compatible 2-part legacy token
      [payloadStr, signature] = parts;
      signedContent = payloadStr;
    }

    const sigBuf = Buffer.from(signature);
    const candidateSecrets = [
      jwtSecretState.primarySecret,
      ...jwtSecretState.previousSecrets
    ].filter(Boolean);

    let signatureValid = false;
    for (const secret of candidateSecrets) {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(signedContent)
        .digest('base64url');
      const expBuf = Buffer.from(expectedSig);

      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) {
      return null;
    }

    // 2. Decode and validate payload
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));

    // Expiration verification: handles both epoch seconds (standard) and epoch milliseconds
    const now = Date.now();
    if (payload.exp) {
      const expMs = payload.exp < 10000000000 ? payload.exp * 1000 : payload.exp;
      if (now > expMs) {
        return null; // Expired
      }
    }

    // Clock skew protection: reject tokens issued more than 60 seconds in the future
    if (payload.iat) {
      const iatMs = payload.iat < 10000000000 ? payload.iat * 1000 : payload.iat;
      if (iatMs > now + 60000) {
        return null; // Issued in future
      }
    }

    return payload;
  } catch (err) {
    // Malformed token or JSON parsing error
    return null;
  }
}

// Middleware to extract user from Authorization header or cookie
function authenticate(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['cookie']) {
    const match = req.headers['cookie'].match(/noc_token=([^;]+)/);
    if (match) token = match[1];
  }

  if (!token) {
    req.user = null;
    return next();
  }

  const payload = verifyToken(token);
  if (!payload) {
    req.user = null;
    return next();
  }

  try {
    const user = queries.getUserById.get(payload.uid);
    if (!user || !user.is_active) {
      req.user = null;
      return next();
    }

    req.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      email: user.email,
      role: user.role,
      groupId: user.group_id,
      groupName: user.group_name || 'Ungrouped',
      permissions: {
        can_add_url: Boolean(user.role === 'ADMIN' || user.role === 'OPERATOR' || user.can_add_url),
        can_edit_url: Boolean(user.role === 'ADMIN' || user.role === 'OPERATOR' || user.can_edit_url),
        can_delete_url: Boolean(user.role === 'ADMIN' || user.role === 'OPERATOR' || user.can_delete_url),
        can_toggle_url: Boolean(user.role === 'ADMIN' || user.role === 'OPERATOR' || user.can_toggle_url),
        can_manage_users: Boolean(user.role === 'ADMIN' || user.can_manage_users)
      }
    };
  } catch (e) {
    req.user = null;
  }

  next();
}

// Middleware: Require authentication
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please log in to perform this operation.'
    });
  }
  next();
}

// Middleware: Require specific permission (can_add_url, can_edit_url, etc.)
function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please log in as an Administrator or Operator.'
      });
    }

    // Admins bypass all individual checks
    if (req.user.role === 'ADMIN') {
      return next();
    }

    // Operators have access to pause/resume, edit settings, create targets, delete targets
    if (req.user.role === 'OPERATOR' && perm !== 'can_manage_users') {
      return next();
    }

    if (!req.user.permissions || !req.user.permissions[perm]) {
      const permDescriptions = {
        can_add_url: 'create new monitoring targets',
        can_edit_url: 'edit target and notification settings',
        can_delete_url: 'delete monitoring targets',
        can_toggle_url: 'pause or resume monitoring',
        can_manage_users: 'manage user accounts and groups'
      };
      const desc = permDescriptions[perm] || perm;
      return res.status(403).json({
        success: false,
        error: `Permission Denied: Only users with Admin or Operator privilege can ${desc}.`
      });
    }

    next();
  };
}

// Helper to record audit events
function logAudit(req, action, targetId = null, details = '') {
  try {
    const userId = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : 'anonymous';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    queries.insertAuditLog.run(userId, username, action, targetId, details, ip);
  } catch (e) {
    console.warn('[Audit] Failed to log action:', e.message);
  }
}

/**
 * Generates a signed anti-CSRF token (HMAC-SHA256 with domain separation)
 * @param {string|number} userId
 * @returns {string} token
 */
function generateCsrfToken(userId = 'guest') {
  const payload = {
    uid: userId,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    rnd: crypto.randomBytes(16).toString('hex')
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', jwtSecretState.primarySecret)
    .update(`csrf:${payloadStr}`)
    .digest('base64url');
  return `${payloadStr}.${signature}`;
}

/**
 * Verifies an anti-CSRF token with key rotation support
 * @param {string} token
 * @returns {boolean} isValid
 */
function verifyCsrfToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payloadStr, signature] = parts;
  try {
    const sigBuf = Buffer.from(signature);
    const candidateSecrets = [
      jwtSecretState.primarySecret,
      ...jwtSecretState.previousSecrets
    ].filter(Boolean);

    let signatureValid = false;
    for (const secret of candidateSecrets) {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`csrf:${payloadStr}`)
        .digest('base64url');
      const expBuf = Buffer.from(expectedSig);
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) return false;

    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return false; // Expired
    }
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateCsrfToken,
  verifyCsrfToken,
  rotateJwtSecret,
  getJwtSecurityDetails,
  isCryptographicallySecure,
  initializeJwtSecret,
  authenticate,
  requireAuth,
  requirePermission,
  logAudit
};
