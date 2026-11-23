const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'monitoring.db');
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
    custom_headers TEXT DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS user_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    can_add_url INTEGER DEFAULT 0,
    can_edit_url INTEGER DEFAULT 0,
    can_delete_url INTEGER DEFAULT 0,
    can_toggle_url INTEGER DEFAULT 0,
    can_manage_users INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'VIEWER',
    group_id INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    FOREIGN KEY(group_id) REFERENCES user_groups(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target_id INTEGER,
    details TEXT,
    ip_address TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
  getUptimeStats: db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'UP' OR status = 'DEGRADED' THEN 1 ELSE 0 END) as successful,
      AVG(response_time_ms) as avg_latency
    FROM heartbeats
    WHERE monitor_id = ? AND timestamp >= datetime('now', ?)
  `),
  getIncidentsForMonitor: db.prepare(`
    SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?
  `),

  // Incidents
  getIncidentById: db.prepare(`
    SELECT i.*, m.name as monitor_name, m.url as monitor_url, m.group_tag
    FROM incidents i
    LEFT JOIN monitors m ON i.monitor_id = m.id
    WHERE i.id = ?
  `),
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

  // Reports & SLA Aggregations
  getReportStatsForMonitor: db.prepare(`
    SELECT 
      COUNT(*) as total_checks,
      SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) as up_checks,
      SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END) as degraded_checks,
      SUM(CASE WHEN status = 'DOWN' THEN 1 ELSE 0 END) as down_checks,
      AVG(CASE WHEN response_time_ms > 0 THEN response_time_ms ELSE NULL END) as avg_latency,
      MIN(CASE WHEN response_time_ms > 0 THEN response_time_ms ELSE NULL END) as min_latency,
      MAX(CASE WHEN response_time_ms > 0 THEN response_time_ms ELSE NULL END) as max_latency
    FROM heartbeats
    WHERE monitor_id = ? AND timestamp >= datetime('now', ?)
  `),
  getReportIncidentsForMonitor: db.prepare(`
    SELECT COUNT(*) as incident_count,
           COALESCE(SUM(duration_seconds), 0) as total_downtime_seconds
    FROM incidents
    WHERE monitor_id = ? AND (started_at >= datetime('now', ?) OR status = 'ACTIVE')
  `),
  getReportIncidentsAll: db.prepare(`
    SELECT i.*, m.name as monitor_name, m.url as monitor_url, m.group_tag
    FROM incidents i
    JOIN monitors m ON i.monitor_id = m.id
    WHERE (i.started_at >= datetime('now', ?) OR i.status = 'ACTIVE')
    ORDER BY i.started_at DESC
  `),
  getReportIncidentsByMonitor: db.prepare(`
    SELECT i.*, m.name as monitor_name, m.url as monitor_url, m.group_tag
    FROM incidents i
    JOIN monitors m ON i.monitor_id = m.id
    WHERE (i.started_at >= datetime('now', ?) OR i.status = 'ACTIVE')
      AND i.monitor_id = ?
    ORDER BY i.started_at DESC
  `),

  // Clean old heartbeats (retention management)
  purgeOldHeartbeats: db.prepare(`
    DELETE FROM heartbeats WHERE timestamp < datetime('now', '-30 days')
  `),

  // RBAC: Users
  getUserByUsername: db.prepare(`
    SELECT u.*, g.name as group_name, g.can_add_url, g.can_edit_url, g.can_delete_url, g.can_toggle_url, g.can_manage_users
    FROM users u
    LEFT JOIN user_groups g ON u.group_id = g.id
    WHERE u.username = ?
  `),
  getUserById: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.email, u.role, u.group_id, u.is_active, u.created_at, u.last_login,
           g.name as group_name, g.can_add_url, g.can_edit_url, g.can_delete_url, g.can_toggle_url, g.can_manage_users
    FROM users u
    LEFT JOIN user_groups g ON u.group_id = g.id
    WHERE u.id = ?
  `),
  getAllUsers: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.email, u.role, u.group_id, u.is_active, u.created_at, u.last_login,
           g.name as group_name, g.can_add_url, g.can_edit_url, g.can_delete_url, g.can_toggle_url, g.can_manage_users
    FROM users u
    LEFT JOIN user_groups g ON u.group_id = g.id
    ORDER BY u.id ASC
  `),
  createUser: db.prepare(`
    INSERT INTO users (username, password_hash, salt, display_name, email, role, group_id, is_active)
    VALUES (@username, @password_hash, @salt, @display_name, @email, @role, @group_id, @is_active)
  `),
  updateUser: db.prepare(`
    UPDATE users SET
      display_name = @display_name,
      email = @email,
      role = @role,
      group_id = @group_id,
      is_active = @is_active
    WHERE id = @id
  `),
  updateUserPassword: db.prepare(`
    UPDATE users SET password_hash = ?, salt = ? WHERE id = ?
  `),
  updateUserLastLogin: db.prepare(`
    UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?
  `),
  deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),

  // RBAC: User Groups
  getAllGroups: db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) as user_count
    FROM user_groups g
    ORDER BY g.id ASC
  `),
  getGroupById: db.prepare(`SELECT * FROM user_groups WHERE id = ?`),
  createGroup: db.prepare(`
    INSERT INTO user_groups (name, description, can_add_url, can_edit_url, can_delete_url, can_toggle_url, can_manage_users)
    VALUES (@name, @description, @can_add_url, @can_edit_url, @can_delete_url, @can_toggle_url, @can_manage_users)
  `),
  updateGroup: db.prepare(`
    UPDATE user_groups SET
      name = @name,
      description = @description,
      can_add_url = @can_add_url,
      can_edit_url = @can_edit_url,
      can_delete_url = @can_delete_url,
      can_toggle_url = @can_toggle_url,
      can_manage_users = @can_manage_users
    WHERE id = @id
  `),
  deleteGroup: db.prepare(`DELETE FROM user_groups WHERE id = ?`),

  // RBAC: Audit Logs
  insertAuditLog: db.prepare(`
    INSERT INTO audit_logs (user_id, username, action, target_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getRecentAuditLogs: db.prepare(`
    SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?
  `),

  // System Settings (SMTP, Notifications)
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),

  // Database Initialization & Seeding Helpers
  getMonitorCount: db.prepare(`SELECT COUNT(*) as count FROM monitors`),
  getUserGroupCount: db.prepare(`SELECT COUNT(*) as count FROM user_groups`),
  getUserCount: db.prepare(`SELECT COUNT(*) as count FROM users`),
  getGroupByName: db.prepare(`SELECT id FROM user_groups WHERE name = ?`),
  insertSeedHeartbeat: db.prepare(`
    INSERT INTO heartbeats (
      monitor_id, status, status_code, response_time_ms,
      dns_time_ms, tcp_time_ms, tls_time_ms, ttfb_ms,
      error_message, ssl_days_remaining, ssl_valid, ssl_issuer, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
};

// Seed default monitors and realistic historical data if database is empty
function seedDatabaseIfEmpty() {
  const count = queries.getMonitorCount.get().count;
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
      is_active: 1,
      custom_headers: ''
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
      is_active: 1,
      custom_headers: ''
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
      is_active: 1,
      custom_headers: ''
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
      is_active: 1,
      custom_headers: ''
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
      is_active: 1,
      custom_headers: ''
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
      is_active: 1,
      custom_headers: ''
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
      is_active: 1,
      custom_headers: ''
    }
  ];

  const insertStmt = queries.createMonitor;
  const insertHeartbeatStmt = queries.insertHeartbeat;

  const insertAll = db.transaction(() => {
    for (const mon of defaultMonitors) {
      const res = insertStmt.run({ custom_headers: '', ...mon });
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

        queries.insertSeedHeartbeat.run(
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

// Seed default RBAC groups and initial users if empty
function seedAuthIfEmpty() {
  const groupCount = queries.getUserGroupCount.get().count;
  if (groupCount === 0) {
    console.log('[DB] Seeding default RBAC user groups...');
    db.exec(`
      INSERT INTO user_groups (name, description, can_add_url, can_edit_url, can_delete_url, can_toggle_url, can_manage_users)
      VALUES 
        ('NOC Administrators', 'Full control: Add, edit, and delete monitoring URLs, manage users and roles', 1, 1, 1, 1, 1),
        ('Operations Engineers', 'Operations team: Pause/resume, edit settings, create and delete monitoring targets', 1, 1, 1, 1, 0),
        ('Stakeholders & Viewers', 'Read-only access: View status dashboards, wallboards, and SLA metrics', 0, 0, 0, 0, 0)
    `);
  }

  const userCount = queries.getUserCount.get().count;
  if (userCount === 0) {
    console.log('[DB] Seeding default RBAC users...');
    const adminSalt = crypto.randomBytes(16).toString('hex');
    const adminHash = crypto.scryptSync('admin123', adminSalt, 64).toString('hex');

    const opSalt = crypto.randomBytes(16).toString('hex');
    const opHash = crypto.scryptSync('operator123', opSalt, 64).toString('hex');

    const viewSalt = crypto.randomBytes(16).toString('hex');
    const viewHash = crypto.scryptSync('viewer123', viewSalt, 64).toString('hex');

    const adminGroup = queries.getGroupByName.get('NOC Administrators');
    const opGroup = queries.getGroupByName.get('Operations Engineers');
    const viewGroup = queries.getGroupByName.get('Stakeholders & Viewers');

    queries.createUser.run({
      username: 'admin',
      password_hash: adminHash,
      salt: adminSalt,
      display_name: 'Lead NOC Administrator',
      email: 'admin@pau.edu.ng',
      role: 'ADMIN',
      group_id: adminGroup ? adminGroup.id : 1,
      is_active: 1
    });

    queries.createUser.run({
      username: 'operator',
      password_hash: opHash,
      salt: opSalt,
      display_name: 'Operations Engineer',
      email: 'ops@pau.edu.ng',
      role: 'OPERATOR',
      group_id: opGroup ? opGroup.id : 2,
      is_active: 1
    });

    queries.createUser.run({
      username: 'viewer',
      password_hash: viewHash,
      salt: viewSalt,
      display_name: 'Dashboard Viewer',
      email: 'viewer@pau.edu.ng',
      role: 'VIEWER',
      group_id: viewGroup ? viewGroup.id : 3,
      is_active: 1
    });

    console.log('[DB] RBAC seeding completed. Default users ready (admin, operator, viewer).');
  }
}

seedDatabaseIfEmpty();
seedAuthIfEmpty();

module.exports = {
  db,
  queries
};

