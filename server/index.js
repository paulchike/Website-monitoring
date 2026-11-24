const http = require('http');
const path = require('path');
const express = require('express');
const { db, queries } = require('./db');
const scheduler = require('./scheduler');
const { setupWebSocket } = require('./ws');
const apiRoutes = require('./api');
const { generateToken, verifyPassword, logAudit } = require('./auth');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Defense-in-depth: HTTP Security Headers & Content-Security-Policy (CSP) to block XSS
app.use((req, res, next) => {
  // Content-Security-Policy (CSP): Restrict script, frame, connection, and object sources
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'self';"
  );
  // Prevent MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent Clickjacking / UI Redressing
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Legacy XSS Protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Health check endpoint for self-monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    system: 'NOC Website Health Monitor',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// REST API routes
app.use('/api', apiRoutes);

// Dedicated Staff Login & RBAC Authentication Routes
const authPortalRoutes = [
  '/login', '/login/',
  '/admin', '/admin/',
  '/admin/login', '/admin/login/',
  '/operator', '/operator/',
  '/operator/login', '/operator/login/'
];

// Serve Login Portal for GET requests
app.get(authPortalRoutes, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Native Form & Direct HTTP POST handler for all portal paths and root (eliminates "Cannot POST")
app.post([...authPortalRoutes, '/'], (req, res) => {
  const isJsonRequest = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.is('json');
  const { username, password } = req.body || {};

  if (!username || !password) {
    if (isJsonRequest) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    return res.redirect('/login?error=missing');
  }

  const user = queries.getUserByUsername.get(username.trim().toLowerCase());
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash, user.salt)) {
    if (isJsonRequest) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }
    return res.redirect('/login?error=invalid');
  }

  queries.updateUserLastLogin.run(user.id);
  const token = generateToken(user);
  logAudit(req, 'LOGIN', user.id, `User ${user.username} authenticated via web portal`);

  // Set secure HttpOnly session cookie
  res.setHeader('Set-Cookie', `noc_token=${token}; Path=/; HttpOnly; SameSite=Lax`);

  if (isJsonRequest) {
    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role
      }
    });
  }

  return res.redirect('/');
});

// Serve static frontend assets with no-cache in development
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Fallback routing: handle SPA page requests and catch-all to prevent "Cannot GET" or "Cannot POST"
app.use((req, res) => {
  // Never intercept API routes with HTML/redirects
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return res.status(404).json({
      success: false,
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`
    });
  }

  // For any web page navigation (GET), serve the SPA index.html
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }

  // For any unhandled non-API POST or state-changing request, redirect back to dashboard
  return res.redirect('/');
});

// Setup WebSocket server
setupWebSocket(server, scheduler);

// Start server and monitoring scheduler
server.listen(PORT, '0.0.0.0', () => {
  console.log('================================================================');
  console.log('       NOC REAL-TIME WEBSITE & LANDING PAGE MONITOR');
  console.log('================================================================');
  console.log(`[HTTP] Server operational on: http://0.0.0.0:${PORT}`);
  console.log(`[WS]   Real-time WebSocket stream on: ws://0.0.0.0:${PORT}/ws`);
  console.log(`[DB]   SQLite Engine Active in WAL mode`);
  console.log('================================================================');

  // Launch background scheduler
  scheduler.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received. Shutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
