const express = require('express');
const { queries, db } = require('./db');
const scheduler = require('./scheduler');

const router = express.Router();

// Helper to compute uptime percentage
function calculateUptime(monitorId, intervalClause) {
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'UP' OR status = 'DEGRADED' THEN 1 ELSE 0 END) as successful,
      AVG(response_time_ms) as avg_latency
    FROM heartbeats
    WHERE monitor_id = ? AND timestamp >= datetime('now', ?)
  `).get(monitorId, intervalClause);

  const total = stats.total || 0;
  const successful = stats.successful || 0;
  const uptimePercent = total > 0 ? (successful / total) * 100 : 100;
  return {
    uptimePercent: Math.round(uptimePercent * 100) / 100,
    totalChecks: total,
    avgLatency: Math.round((stats.avg_latency || 0) * 10) / 10
  };
}

// GET /api/monitors
router.get('/monitors', (req, res) => {
  try {
    const monitors = queries.getAllMonitors.all();
    const enriched = monitors.map((monitor) => {
      const latestHeartbeat = queries.getLatestHeartbeatForMonitor.get(monitor.id) || null;
      // Get last 35 heartbeats for visual history bar & sparkline
      const history = queries.getRecentHeartbeatsForMonitor.all(monitor.id, 35).reverse();
      const uptime24h = calculateUptime(monitor.id, '-24 hours');
      const activeIncident = queries.getActiveIncidentForMonitor.get(monitor.id) || null;

      return {
        ...monitor,
        is_active: Boolean(monitor.is_active),
        ssl_check_enabled: Boolean(monitor.ssl_check_enabled),
        latestHeartbeat,
        history,
        uptime24h: uptime24h.uptimePercent,
        avgLatency24h: uptime24h.avgLatency,
        activeIncident
      };
    });

    res.json({ success: true, monitors: enriched });
  } catch (err) {
    console.error('Error fetching monitors:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/monitors/:id
router.get('/monitors/:id', (req, res) => {
  try {
    const monitorId = Number(req.params.id);
    const monitor = queries.getMonitorById.get(monitorId);
    if (!monitor) {
      return res.status(404).json({ success: false, error: 'Monitor not found' });
    }

    const latestHeartbeat = queries.getLatestHeartbeatForMonitor.get(monitorId) || null;
    const history = queries.getRecentHeartbeatsForMonitor.all(monitorId, 60).reverse();
    const uptime24h = calculateUptime(monitorId, '-24 hours');
    const uptime7d = calculateUptime(monitorId, '-7 days');
    const uptime30d = calculateUptime(monitorId, '-30 days');
    const activeIncident = queries.getActiveIncidentForMonitor.get(monitorId) || null;
    const incidents = db.prepare(`
      SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 15
    `).all(monitorId);

    res.json({
      success: true,
      monitor: {
        ...monitor,
        is_active: Boolean(monitor.is_active),
        ssl_check_enabled: Boolean(monitor.ssl_check_enabled),
        latestHeartbeat,
        history,
        uptimeStats: {
          '24h': uptime24h,
          '7d': uptime7d,
          '30d': uptime30d
        },
        activeIncident,
        incidents
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/monitors
router.post('/monitors', (req, res) => {
  try {
    const {
      name,
      url,
      method = 'GET',
      interval_seconds = 30,
      timeout_ms = 10000,
      expected_status = 200,
      keyword_check = '',
      ssl_check_enabled = 1,
      group_tag = 'Production',
      is_active = 1,
      custom_headers = ''
    } = req.body;

    if (!name || !url) {
      return res.status(400).json({ success: false, error: 'Name and URL are required' });
    }

    const result = queries.createMonitor.run({
      name: name.trim(),
      url: url.trim(),
      method: method.toUpperCase(),
      interval_seconds: Number(interval_seconds) || 30,
      timeout_ms: Number(timeout_ms) || 10000,
      expected_status: Number(expected_status) || 200,
      keyword_check: (keyword_check || '').trim(),
      ssl_check_enabled: ssl_check_enabled ? 1 : 0,
      group_tag: (group_tag || 'Production').trim(),
      is_active: is_active ? 1 : 0,
      custom_headers: (custom_headers || '').trim()
    });

    const newId = result.lastInsertRowid;
    const newMonitor = queries.getMonitorById.get(newId);

    scheduler.restartMonitor(newId);
    scheduler.broadcast('monitor_created', newMonitor);

    res.status(201).json({ success: true, monitor: newMonitor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/monitors/:id
router.put('/monitors/:id', (req, res) => {
  try {
    const monitorId = Number(req.params.id);
    const existing = queries.getMonitorById.get(monitorId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Monitor not found' });
    }

    const {
      name = existing.name,
      url = existing.url,
      method = existing.method,
      interval_seconds = existing.interval_seconds,
      timeout_ms = existing.timeout_ms,
      expected_status = existing.expected_status,
      keyword_check = existing.keyword_check,
      ssl_check_enabled = existing.ssl_check_enabled,
      group_tag = existing.group_tag,
      is_active = existing.is_active,
      custom_headers = existing.custom_headers
    } = req.body;

    queries.updateMonitor.run({
      id: monitorId,
      name: name.trim(),
      url: url.trim(),
      method: method.toUpperCase(),
      interval_seconds: Number(interval_seconds) || 30,
      timeout_ms: Number(timeout_ms) || 10000,
      expected_status: Number(expected_status) || 200,
      keyword_check: (keyword_check || '').trim(),
      ssl_check_enabled: ssl_check_enabled ? 1 : 0,
      group_tag: (group_tag || 'Production').trim(),
      is_active: is_active ? 1 : 0,
      custom_headers: (custom_headers || '').trim()
    });

    const updated = queries.getMonitorById.get(monitorId);
    scheduler.restartMonitor(monitorId);
    scheduler.broadcast('monitor_updated', updated);

    res.json({ success: true, monitor: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/monitors/:id
router.delete('/monitors/:id', (req, res) => {
  try {
    const monitorId = Number(req.params.id);
    const existing = queries.getMonitorById.get(monitorId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Monitor not found' });
    }

    scheduler.stopMonitor(monitorId);
    queries.deleteMonitor.run(monitorId);
    scheduler.broadcast('monitor_deleted', { id: monitorId });

    res.json({ success: true, message: 'Monitor removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/monitors/:id/toggle (Pause / Resume)
router.post('/monitors/:id/toggle', (req, res) => {
  try {
    const monitorId = Number(req.params.id);
    queries.toggleMonitorActive.run(monitorId);
    const updated = queries.getMonitorById.get(monitorId);
    scheduler.restartMonitor(monitorId);
    scheduler.broadcast('monitor_updated', updated);

    res.json({ success: true, monitor: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/monitors/:id/check (Trigger immediate check)
router.post('/monitors/:id/check', async (req, res) => {
  try {
    const monitorId = Number(req.params.id);
    const monitor = queries.getMonitorById.get(monitorId);
    if (!monitor) {
      return res.status(404).json({ success: false, error: 'Monitor not found' });
    }

    // Trigger check
    await scheduler.runCheck(monitorId);
    const latest = queries.getLatestHeartbeatForMonitor.get(monitorId);

    res.json({ success: true, latestHeartbeat: latest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/monitors/check-all (Trigger immediate check on all monitors)
router.post('/monitors/check-all', async (req, res) => {
  try {
    scheduler.runAllNow();
    res.json({ success: true, message: 'Triggered check on all monitors' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/incidents
router.get('/incidents', (req, res) => {
  try {
    const active = queries.getActiveIncidents.all();
    const recent = queries.getRecentIncidents.all(30);
    res.json({ success: true, active, recent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/incidents/:id/acknowledge
router.post('/incidents/:id/acknowledge', (req, res) => {
  try {
    const incidentId = Number(req.params.id);
    const operator = req.body.operator || 'NOC Operator';
    queries.acknowledgeIncident.run(operator, incidentId);
    const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);

    scheduler.broadcast('incident_acknowledged', updated);
    res.json({ success: true, incident: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/summary
router.get('/summary', (req, res) => {
  try {
    const monitors = queries.getAllMonitors.all();
    let total = monitors.length;
    let upCount = 0;
    let degradedCount = 0;
    let downCount = 0;
    let pausedCount = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    monitors.forEach((m) => {
      if (!m.is_active) {
        pausedCount++;
        return;
      }
      const hb = queries.getLatestHeartbeatForMonitor.get(m.id);
      if (!hb) {
        upCount++;
        return;
      }
      if (hb.status === 'UP') upCount++;
      else if (hb.status === 'DEGRADED') degradedCount++;
      else if (hb.status === 'DOWN') downCount++;

      if (hb.response_time_ms > 0) {
        totalLatency += hb.response_time_ms;
        latencyCount++;
      }
    });

    const activeIncidents = queries.getActiveIncidents.all();
    const activeCount = total - pausedCount;
    const healthScore = activeCount > 0 
      ? Math.round(((upCount + degradedCount * 0.5) / activeCount) * 1000) / 10
      : 100;

    res.json({
      success: true,
      summary: {
        totalMonitors: total,
        upCount,
        degradedCount,
        downCount,
        pausedCount,
        avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
        healthScore,
        activeIncidentsCount: activeIncidents.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports (Comprehensive SLA, Uptime & Latency Telemetry Reports with CSV export)
router.get('/reports', (req, res) => {
  try {
    const rangeParam = req.query.range || '24h';
    let intervalClause = '-24 hours';
    let rangeLabel = 'Last 24 Hours';
    if (rangeParam === '7d') {
      intervalClause = '-7 days';
      rangeLabel = 'Last 7 Days';
    } else if (rangeParam === '30d') {
      intervalClause = '-30 days';
      rangeLabel = 'Last 30 Days';
    }

    const monitorId = req.query.monitor_id && req.query.monitor_id !== 'all' ? Number(req.query.monitor_id) : null;

    // Fetch target monitors
    let targetMonitors = [];
    if (monitorId) {
      const single = queries.getMonitorById.get(monitorId);
      if (single) targetMonitors.push(single);
    } else {
      targetMonitors = queries.getAllMonitors.all();
    }

    const reportItems = targetMonitors.map(m => {
      const stats = db.prepare(`
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
      `).get(m.id, intervalClause);

      const latest = queries.getLatestHeartbeatForMonitor.get(m.id);

      const incidents = db.prepare(`
        SELECT COUNT(*) as incident_count,
               COALESCE(SUM(duration_seconds), 0) as total_downtime_seconds
        FROM incidents
        WHERE monitor_id = ? AND (started_at >= datetime('now', ?) OR status = 'ACTIVE')
      `).get(m.id, intervalClause);

      const total = stats.total_checks || 0;
      const up = stats.up_checks || 0;
      const deg = stats.degraded_checks || 0;
      const down = stats.down_checks || 0;
      const uptime = total > 0 ? Math.round(((up + deg) / total) * 10000) / 100 : 100;

      return {
        id: m.id,
        name: m.name,
        url: m.url,
        group_tag: m.group_tag,
        is_active: Boolean(m.is_active),
        current_status: !m.is_active ? 'PAUSED' : (latest ? latest.status : 'UP'),
        total_checks: total,
        up_checks: up,
        degraded_checks: deg,
        down_checks: down,
        uptime_percent: uptime,
        avg_latency_ms: stats.avg_latency ? Math.round(stats.avg_latency * 10) / 10 : 0,
        min_latency_ms: stats.min_latency ? Math.round(stats.min_latency * 10) / 10 : 0,
        max_latency_ms: stats.max_latency ? Math.round(stats.max_latency * 10) / 10 : 0,
        ssl_days_remaining: latest ? latest.ssl_days_remaining : null,
        ssl_valid: latest ? latest.ssl_valid : null,
        incident_count: incidents.incident_count || 0,
        total_downtime_seconds: incidents.total_downtime_seconds || 0,
        last_checked: latest ? latest.timestamp : null
      };
    });

    // Recent Incidents list in range
    const incidentsList = db.prepare(`
      SELECT i.*, m.name as monitor_name, m.url as monitor_url, m.group_tag
      FROM incidents i
      JOIN monitors m ON i.monitor_id = m.id
      WHERE (i.started_at >= datetime('now', ?) OR i.status = 'ACTIVE')
        ${monitorId ? 'AND i.monitor_id = ?' : ''}
      ORDER BY i.started_at DESC
    `).all(...(monitorId ? [intervalClause, monitorId] : [intervalClause]));

    // Executive summary calculations
    let sumUptime = 0;
    let sumLatency = 0;
    let latencyCount = 0;
    let totalChecksAll = 0;
    let totalIncidentsAll = 0;
    let totalDowntimeAll = 0;

    reportItems.forEach(item => {
      sumUptime += item.uptime_percent;
      if (item.avg_latency_ms > 0) {
        sumLatency += item.avg_latency_ms;
        latencyCount++;
      }
      totalChecksAll += item.total_checks;
      totalIncidentsAll += item.incident_count;
      totalDowntimeAll += item.total_downtime_seconds;
    });

    const executiveSummary = {
      range: rangeLabel,
      generatedAt: new Date().toISOString(),
      monitorsEvaluated: reportItems.length,
      averageUptimePercent: reportItems.length ? Math.round((sumUptime / reportItems.length) * 100) / 100 : 100,
      averageLatencyMs: latencyCount ? Math.round((sumLatency / latencyCount) * 10) / 10 : 0,
      totalProbesRun: totalChecksAll,
      totalIncidents: totalIncidentsAll,
      totalDowntimeMinutes: Math.round((totalDowntimeAll / 60) * 10) / 10
    };

    // If CSV format requested, serialize and return CSV file
    if (req.query.format === 'csv') {
      const csvRows = [];
      csvRows.push([
        'Monitor Name',
        'Target URL',
        'Group/Tier',
        'Current Status',
        'Time Range',
        'Total Probes',
        'Successful (UP)',
        'Degraded',
        'Down',
        'Uptime SLA (%)',
        'Avg Latency (ms)',
        'Min Latency (ms)',
        'Max Latency (ms)',
        'SSL Days Remaining',
        'Incidents Count',
        'Total Downtime (Seconds)',
        'Last Checked (UTC)'
      ].map(h => `"${h}"`).join(','));

      reportItems.forEach(item => {
        csvRows.push([
          item.name,
          item.url,
          item.group_tag,
          item.current_status,
          rangeLabel,
          item.total_checks,
          item.up_checks,
          item.degraded_checks,
          item.down_checks,
          item.uptime_percent,
          item.avg_latency_ms,
          item.min_latency_ms,
          item.max_latency_ms,
          item.ssl_days_remaining !== null ? item.ssl_days_remaining : 'N/A',
          item.incident_count,
          item.total_downtime_seconds,
          item.last_checked || 'N/A'
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(','));
      });

      const filename = `noc-sla-report-${rangeParam}-${Date.now()}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csvRows.join('\r\n'));
    }

    res.json({
      success: true,
      executiveSummary,
      reportItems,
      incidents: incidentsList
    });
  } catch (err) {
    console.error('Error generating report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mock Endpoints for testing & simulated chaos
let mockFlakyCounter = 0;
router.get('/mock/flaky', (req, res) => {
  mockFlakyCounter++;
  if (mockFlakyCounter % 4 === 0) {
    return res.status(503).json({ error: 'Service Temporarily Unavailable (Mock Chaos)' });
  }
  res.json({ status: 'ok', message: 'Flaky service operating normally' });
});

router.get('/mock/slow', (req, res) => {
  setTimeout(() => {
    res.json({ status: 'ok', message: 'Delayed response simulating degraded network' });
  }, 1800);
});

router.get('/mock/down', (req, res) => {
  res.status(500).json({ error: 'Internal Server Error (Mock Hard Outage)' });
});

router.get('/mock/404', (req, res) => {
  res.status(404).send('<!DOCTYPE html><html><body><h1>404 Not Found</h1><p>The requested URL was not found on this server.</p></body></html>');
});

router.get('/mock/dberror', (req, res) => {
  // Simulates a soft 200/500 database connection failure page
  res.status(200).send('<!DOCTYPE html><html><body><h1>Error establishing a database connection</h1><p>Cannot connect to the database server: SQLSTATE[HY000] [2002] Connection refused</p></body></html>');
});

module.exports = router;

