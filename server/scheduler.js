const { queries } = require('./db');
const { performCheck } = require('./checker');
const notifier = require('./notifier');

class Scheduler {
  constructor() {
    this.timers = new Map(); // monitorId -> NodeJS.Timeout
    this.inFlight = new Set(); // monitorId
    this.wsBroadcaster = null;
  }

  setBroadcaster(broadcaster) {
    this.wsBroadcaster = broadcaster;
  }

  broadcast(type, payload) {
    if (this.wsBroadcaster) {
      try {
        this.wsBroadcaster(type, payload);
      } catch (err) {
        console.error('[Scheduler] Broadcast error:', err);
      }
    }
  }

  start() {
    console.log('[Scheduler] Initializing monitoring schedule...');
    this.syncAll();
    
    // Periodically sync every 60s in case of drift or config changes
    setInterval(() => {
      this.syncAll();
    }, 60000);

    // Initial check across active monitors staggered by 500ms
    const activeMonitors = queries.getActiveMonitors.all();
    activeMonitors.forEach((monitor, index) => {
      setTimeout(() => {
        this.runCheck(monitor.id);
      }, index * 600);
    });
  }

  syncAll() {
    const activeMonitors = queries.getActiveMonitors.all();
    const activeIds = new Set(activeMonitors.map(m => m.id));

    // Clear timers for monitors that are no longer active
    for (const [id, timer] of this.timers.entries()) {
      if (!activeIds.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
      }
    }

    // Schedule active monitors
    for (const monitor of activeMonitors) {
      if (!this.timers.has(monitor.id)) {
        const intervalMs = Math.max(5, monitor.interval_seconds || 30) * 1000;
        const timer = setInterval(() => {
          this.runCheck(monitor.id);
        }, intervalMs);
        this.timers.set(monitor.id, timer);
      }
    }
  }

  restartMonitor(monitorId) {
    if (this.timers.has(monitorId)) {
      clearInterval(this.timers.get(monitorId));
      this.timers.delete(monitorId);
    }
    const monitor = queries.getMonitorById.get(monitorId);
    if (monitor && monitor.is_active) {
      const intervalMs = Math.max(5, monitor.interval_seconds || 30) * 1000;
      const timer = setInterval(() => {
        this.runCheck(monitor.id);
      }, intervalMs);
      this.timers.set(monitor.id, timer);
      this.runCheck(monitor.id);
    }
  }

  stopMonitor(monitorId) {
    if (this.timers.has(monitorId)) {
      clearInterval(this.timers.get(monitorId));
      this.timers.delete(monitorId);
    }
  }

  async runCheck(monitorId) {
    if (this.inFlight.has(monitorId)) {
      return; // Already checking
    }

    const monitor = queries.getMonitorById.get(monitorId);
    if (!monitor) return;

    this.inFlight.add(monitorId);

    try {
      const result = await performCheck(monitor);

      // Save heartbeat to DB
      const insertData = {
        monitor_id: monitorId,
        status: result.status,
        status_code: result.status_code,
        response_time_ms: result.response_time_ms,
        dns_time_ms: result.dns_time_ms,
        tcp_time_ms: result.tcp_time_ms,
        tls_time_ms: result.tls_time_ms,
        ttfb_ms: result.ttfb_ms,
        error_message: result.error_message,
        ssl_days_remaining: result.ssl_days_remaining,
        ssl_valid: result.ssl_valid,
        ssl_issuer: result.ssl_issuer
      };
      
      const insertResult = queries.insertHeartbeat.run(insertData);
      const heartbeatId = insertResult.lastInsertRowid;

      // Incident state machine
      const activeIncident = queries.getActiveIncidentForMonitor.get(monitorId);

      if (result.status === 'DOWN') {
        if (!activeIncident) {
          const cause = result.error_message || `HTTP Check Failed (${result.status_code})`;
          const incRes = queries.createIncident.run(monitorId, cause);
          const newIncident = {
            id: incRes.lastInsertRowid,
            monitor_id: monitorId,
            monitor_name: monitor.name,
            monitor_url: monitor.url,
            group_tag: monitor.group_tag,
            started_at: new Date().toISOString(),
            cause,
            status: 'ACTIVE'
          };
          this.broadcast('incident_started', newIncident);
          // Dispatch Outage Email Alert via Microsoft 365 Relay
          notifier.sendOutageAlert(newIncident, monitor, result).catch(e => {
            console.warn('[Scheduler] Outage email dispatch warning:', e.message);
          });
        }
      } else if (result.status === 'UP') {
        if (activeIncident) {
          queries.resolveIncident.run(activeIncident.id);
          const resolvedIncident = {
            ...activeIncident,
            resolved_at: new Date().toISOString(),
            status: 'RESOLVED'
          };
          this.broadcast('incident_resolved', resolvedIncident);
          // Dispatch Recovery Email Alert via Microsoft 365 Relay
          notifier.sendRecoveryAlert(resolvedIncident, monitor, result).catch(e => {
            console.warn('[Scheduler] Recovery email dispatch warning:', e.message);
          });
        }
      }

      // Broadcast check result
      this.broadcast('check_result', {
        heartbeat: {
          id: heartbeatId,
          ...insertData,
          timestamp: new Date().toISOString()
        },
        monitor: {
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          group_tag: monitor.group_tag,
          is_active: monitor.is_active
        }
      });

    } catch (err) {
      console.error(`[Scheduler] Check execution error on monitor ${monitorId}:`, err);
    } finally {
      this.inFlight.delete(monitorId);
    }
  }

  async runAllNow() {
    const monitors = queries.getAllMonitors.all();
    const promises = monitors.map((m, idx) => {
      return new Promise(res => {
        setTimeout(async () => {
          await this.runCheck(m.id);
          res();
        }, idx * 150);
      });
    });
    await Promise.all(promises);
  }
}

const scheduler = new Scheduler();

module.exports = scheduler;

