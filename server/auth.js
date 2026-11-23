const crypto = require('crypto');
const { db, queries } = require('./db');

// Retrieve or generate persistent HMAC secret for session tokens
function getAuthSecret() {
  try {
    const existing = queries.getSetting.get('auth_secret');
    if (existing && existing.value) {
      return existing.value;
    }
    const newSecret = crypto.randomBytes(32).toString('hex');
    queries.setSetting.run('auth_secret', newSecret);
    return newSecret;
  } catch (e) {
    return process.env.AUTH_SECRET || 'noc-secure-fallback-secret-2026';
  }
}

const AUTH_SECRET = getAuthSecret();

// Password hashing with native crypto.scrypt
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  try {
    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
  } catch (err) {
    return false;
  }
}

// Lightweight, zero-dependency signed session tokens (HMAC-SHA256)
function generateToken(user) {
  const payload = {
    uid: user.id,
    uname: user.username,
    role: user.role,
    gid: user.group_id,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
  };

  const str = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(str).digest('base64url');
  return `${str}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadStr, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadStr).digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch (e) {
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

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  authenticate,
  requireAuth,
  requirePermission,
  logAudit
};
