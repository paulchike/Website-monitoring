const http = require('http');
const path = require('path');
const express = require('express');
const { db } = require('./db');
const scheduler = require('./scheduler');
const { setupWebSocket } = require('./ws');
const apiRoutes = require('./api');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Fallback to index.html for SPA routing
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  next();
});

// Setup WebSocket server
setupWebSocket(server, scheduler);

// Start server and monitoring scheduler
server.listen(PORT, () => {
  console.log('================================================================');
  console.log('       NOC REAL-TIME WEBSITE & LANDING PAGE MONITOR');
  console.log('================================================================');
  console.log(`[HTTP] Server operational on: http://localhost:${PORT}`);
  console.log(`[WS]   Real-time WebSocket stream on: ws://localhost:${PORT}/ws`);
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
