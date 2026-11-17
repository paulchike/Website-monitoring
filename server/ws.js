const { WebSocketServer, WebSocket } = require('ws');
const { queries } = require('./db');

function setupWebSocket(server, scheduler) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload, timestamp: Date.now() });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Hook scheduler to this broadcaster
  scheduler.setBroadcaster(broadcast);

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Send initial snapshot on connect
    try {
      const activeIncidents = queries.getActiveIncidents.all();
      const monitors = queries.getAllMonitors.all().map(m => {
        const latest = queries.getLatestHeartbeatForMonitor.get(m.id);
        const history = queries.getRecentHeartbeatsForMonitor.all(m.id, 35).reverse();
        const activeIncident = queries.getActiveIncidentForMonitor.get(m.id) || null;
        return {
          ...m,
          is_active: Boolean(m.is_active),
          ssl_check_enabled: Boolean(m.ssl_check_enabled),
          latestHeartbeat: latest,
          history,
          activeIncident
        };
      });

      ws.send(JSON.stringify({
        type: 'initial_state',
        payload: {
          monitors,
          activeIncidents,
          serverTime: new Date().toISOString()
        }
      }));
    } catch (err) {
      console.error('[WS] Error sending initial state:', err);
    }

    // Handle messages from client
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        } else if (msg.type === 'check_now' && msg.monitorId) {
          await scheduler.runCheck(Number(msg.monitorId));
        } else if (msg.type === 'check_all') {
          await scheduler.runAllNow();
        }
      } catch (err) {
        console.error('[WS] Error handling client message:', err);
      }
    });
  });

  // Ping clients every 20s to detect broken connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 20000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  return { wss, broadcast };
}

module.exports = { setupWebSocket };

