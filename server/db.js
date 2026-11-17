const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'monitoring.db');
const db = new Database(dbPath);

// Enable WAL mode for optimal concurrent reads/writes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT DEFAULT 'GET',
    interval_seconds INTEGER DEFAULT 30,
    timeout_ms INTEGER DEFAULT 10000,
    expected_status INTEGER DEFAULT 200,
    keyword_check TEXT DEFAULT '',
    ssl_check_enabled INTEGER DEFAULT 1,
    group_tag TEXT DEFAULT 'Production',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    status TEXT NOT NULL, -- 'UP', 'DOWN', 'DEGRADED'
    status_code INTEGER,
    response_time_ms REAL,
    dns_time_ms REAL,
    tcp_time_ms REAL,
    tls_time_ms REAL,
    ttfb_ms REAL,
    error_message TEXT,
    ssl_days_remaining INTEGER,
    ssl_valid INTEGER,
    ssl_issuer TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_heartbeats_monitor_time ON heartbeats(monitor_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_heartbeats_time ON heartbeats(timestamp DESC);

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    duration_seconds INTEGER,
    cause TEXT,
    status TEXT DEFAULT 'ACTIVE', -- 'ACTIVE', 'RESOLVED'
    acknowledged_at DATETIME,
    acknowledged_by TEXT,
    FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Safe migration for existing databases: ensure custom_headers exists
try {
  db.exec(`ALTER TABLE monitors ADD COLUMN custom_headers TEXT DEFAULT ''`);
} catch (e) {
  // column already exists
}

// Helper queries
const queries = {
  // Monitors
  getAllMonitors: db.prepare(`SELECT * FROM monitors ORDER BY group_tag ASC, name ASC`),
  getActiveMonitors: db.prepare(`SELECT * FROM monitors WHERE is_active = 1`),
  getMonitorById: db.prepare(`SELECT * FROM monitors WHERE id = ?`),
  createMonitor: db.prepare(`
    INSERT INTO monitors (name, url, method, interval_seconds, timeout_ms, expected_status, keyword_check, ssl_check_enabled, group_tag, is_active, custom_headers)
    VALUES (@name, @url, @method, @interval_seconds, @timeout_ms, @expected_status, @keyword_check, @ssl_check_enabled, @group_tag, @is_active, @custom_headers)
  `),
  updateMonitor: db.prepare(`
    UPDATE monitors SET 
      name = @name,
      url = @url,
      method = @method,
      interval_seconds = @interval_seconds,
      timeout_ms = @timeout_ms,
      expected_status = @expected_status,
      keyword_check = @keyword_check,
      ssl_check_enabled = @ssl_check_enabled,
      group_tag = @group_tag,
      is_active = @is_active,
      custom_headers = @custom_headers,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `),
  deleteMonitor: db.prepare(`DELETE FROM monitors WHERE id = ?`),
  toggleMonitorActive: db.prepare(`UPDATE monitors SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?`),

  // Heartbeats
  insertHeartbeat: db.prepare(`
    INSERT INTO heartbeats (
      monitor_id, status, status_code, response_time_ms,
      dns_time_ms, tcp_time_ms, tls_time_ms, ttfb_ms,
      error_message, ssl_days_remaining, ssl_valid, ssl_issuer
    ) VALUES (
      @monitor_id, @status, @status_code, @response_time_ms,
      @dns_time_ms, @tcp_time_ms, @tls_time_ms, @ttfb_ms,
      @error_message, @ssl_days_remaining, @ssl_valid, @ssl_issuer
    )
  `),
  getLatestHeartbeatForMonitor: db.prepare(`
    SELECT * FROM heartbeats WHERE monitor_id = ? ORDER BY id DESC LIMIT 1
  `),
  getRecentHeartbeatsForMonitor: db.prepare(`
    SELECT * FROM heartbeats WHERE monitor_id = ? ORDER BY id DESC LIMIT ?
  `),
  getHeartbeatHistorySummary: db.prepare(`
    SELECT 
      status,
      COUNT(*) as count,
      AVG(response_time_ms) as avg_latency
    FROM heartbeats 
    WHERE monitor_id = ? AND timestamp >= datetime('now', ?)
  `),

  // Incidents
  getActiveIncidentForMonitor: db.prepare(`
    SELECT * FROM incidents WHERE monitor_id = ? AND status = 'ACTIVE' LIMIT 1
  `),
  createIncident: db.prepare(`
    INSERT INTO incidents (monitor_id, cause, status) VALUES (?, ?, 'ACTIVE')
  `),
  resolveIncident: db.prepare(`
    UPDATE incidents SET 
      status = 'RESOLVED',
      resolved_at = CURRENT_TIMESTAMP,
      duration_seconds = CAST((strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', started_at)) AS INTEGER)
    WHERE id = ?
  `),
  acknowledgeIncident: db.prepare(`
    UPDATE incidents SET 
      acknowledged_at = CURRENT_TIMESTAMP,
      acknowledged_by = ?
    WHERE id = ?
  `),
  getRecentIncidents: db.prepare(`
    SELECT i.*, m.name as monitor_name, m.url as monitor_url, m.group_tag
    FROM incidents i
    JOIN monitors m ON i.monitor_id = m.id
    ORDER BY i.started_at DESC LIMIT ?
  `),
  getActiveIncidents: db.prepare(`
    SELECT i.*, m.name as monitor_name, m.url as monitor_url, m.group_tag
    FROM incidents i
    JOIN monitors m ON i.monitor_id = m.id
    WHERE i.status = 'ACTIVE'
    ORDER BY i.started_at DESC
  `),

  // Clean old heartbeats (retention management)
  purgeOldHeartbeats: db.prepare(`
    DELETE FROM heartbeats WHERE timestamp < datetime('now', '-30 days')
  `)
};

// Seed default monitors and realistic historical data if database is empty
function seedDatabaseIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as count FROM monitors').get().count;
  if (count > 0) return;

  console.log('[DB] Seeding default NOC monitoring targets...');

  const defaultMonitors = [
    {
      name: 'NOC Self-Health Probe',
      url: 'http://localhost:3000/health',
      method: 'GET',
      interval_seconds: 10,
      timeout_ms: 3000,
      expected_status: 200,
      keyword_check: 'healthy',
      ssl_check_enabled: 0,
      group_tag: 'Infrastructure',
      is_active: 1
    },
    {
      name: 'Cloudflare DNS Gateway',
      url: 'https://1.1.1.1',
      method: 'GET',
      interval_seconds: 15,
      timeout_ms: 5000,
      expected_status: 200,
      keyword_check: '',
      ssl_check_enabled: 1,
      group_tag: 'Core Network',
      is_active: 1
    },
    {
      name: 'Google Public Portal',
      url: 'https://www.google.com',
      method: 'GET',
      interval_seconds: 20,
      timeout_ms: 5000,
      expected_status: 200,
      keyword_check: '',
      ssl_check_enabled: 1,
      group_tag: 'Core Network',
      is_active: 1
    },
    {
      name: 'Wikipedia Global Encyclopedia',
      url: 'https://www.wikipedia.org',
      method: 'GET',
      interval_seconds: 30,
      timeout_ms: 8000,
      expected_status: 200,
      keyword_check: 'Wikipedia',
      ssl_check_enabled: 1,
      group_tag: 'Landing Pages',
      is_active: 1
    },
    {
      name: 'GitHub System Status API',
      url: 'https://www.githubstatus.com',
      method: 'GET',
      interval_seconds: 30,
      timeout_ms: 8000,
      expected_status: 200,
      keyword_check: '',
      ssl_check_enabled: 1,
      group_tag: 'APIs & Services',
      is_active: 1
    },
    {
      name: 'Internet Archive Gateway',
      url: 'https://archive.org',
      method: 'GET',
      interval_seconds: 45,
      timeout_ms: 10000,
      expected_status: 200,
      keyword_check: '',
      ssl_check_enabled: 1,
      group_tag: 'Landing Pages',
      is_active: 1
    },
    {
      name: 'Mock Production Flaky API',
      url: 'http://localhost:3000/api/mock/flaky',
      method: 'GET',
      interval_seconds: 15,
      timeout_ms: 3000,
      expected_status: 200,
      keyword_check: 'ok',
      ssl_check_enabled: 0,
      group_tag: 'Staging & QA',
      is_active: 1
    }
  ];

  const insertStmt = queries.createMonitor;
  const insertHeartbeatStmt = queries.insertHeartbeat;

  const insertAll = db.transaction(() => {
    for (const mon of defaultMonitors) {
      const res = insertStmt.run(mon);
      const monitorId = res.lastInsertRowid;

      // Seed 40 historical heartbeats over the last 2 hours
      const now = Date.now();
      for (let i = 40; i >= 1; i--) {
        const timestampOffset = now - i * 3 * 60 * 1000;
        const tsString = new Date(timestampOffset).toISOString().replace('T', ' ').substring(0, 19);

        // Calculate realistic variations
        const isSelf = mon.url.includes('localhost');
        const isFlaky = mon.url.includes('flaky');
        let status = 'UP';
        let statusCode = 200;
        let responseTime = isSelf ? 2 + Math.random() * 5 : 25 + Math.random() * 85;
        let errMsg = null;

        if (isFlaky && i % 8 === 0) {
          status = 'DOWN';
          statusCode = 503;
          responseTime = 120;
          errMsg = 'HTTP 503 Service Unavailable (Simulated)';
        } else if (i % 15 === 0) {
          status = 'DEGRADED';
          responseTime = 480 + Math.random() * 200;
        }

        db.prepare(`
          INSERT INTO heartbeats (
            monitor_id, status, status_code, response_time_ms,
            dns_time_ms, tcp_time_ms, tls_time_ms, ttfb_ms,
            error_message, ssl_days_remaining, ssl_valid, ssl_issuer, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          monitorId,
          status,
          statusCode,
          Math.round(responseTime * 10) / 10,
          isSelf ? 0.2 : 8.5,
          isSelf ? 0.3 : 15.2,
          mon.ssl_check_enabled ? 22.4 : null,
          Math.round((responseTime * 0.7) * 10) / 10,
          errMsg,
          mon.ssl_check_enabled ? 75 : null,
          mon.ssl_check_enabled ? 1 : null,
          mon.ssl_check_enabled ? "Let's Encrypt / Cloudflare" : null,
          tsString
        );
      }
    }
  });

  insertAll();
  console.log('[DB] Seeding completed.');
}

seedDatabaseIfEmpty();

module.exports = {
  db,
  queries
};

