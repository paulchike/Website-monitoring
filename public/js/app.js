/**
 * NOC Real-Time Monitoring Dashboard Controller
 */
class NOCDashboard {
  constructor() {
    this.monitors = [];
    this.activeIncidents = [];
    this.summary = {};
    this.filter = 'all';
    this.groupFilter = 'ALL';
    this.searchQuery = '';
    this.currentView = localStorage.getItem('noc_view') || 'cards';
    this.soundEnabled = localStorage.getItem('noc_sound') !== 'false';
    this.activeDetailMonitorId = null;
    this.ws = null;
    this.wsReconnectTimer = null;
    this.audioCtx = null;
    this.streamLogs = [];
    this.isStreamOpen = false;

    this.init();
  }

  init() {
    this.initClock();
    this.initSound();
    this.initEventListeners();
    this.initWebSocket();
    this.setView(this.currentView);
    this.fetchInitialSummary();
  }

  /* ========================================================================
     Clock & Timers
     ======================================================================== */
  initClock() {
    const clockEl = document.getElementById('utc-clock');
    const updateTime = () => {
      const now = new Date();
      if (clockEl) {
        clockEl.textContent = now.toUTCString().slice(17, 25);
      }
    };
    updateTime();
    setInterval(updateTime, 1000);
  }

  /* ========================================================================
     Audio Alerts Synthesizer (Web Audio API)
     ======================================================================== */
  initSound() {
    this.updateSoundButtonUI();
    const btn = document.getElementById('btn-sound-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        this.soundEnabled = !this.soundEnabled;
        localStorage.setItem('noc_sound', this.soundEnabled);
        this.updateSoundButtonUI();
        if (this.soundEnabled) {
          this.playPingBlip();
        }
      });
    }
  }

  ensureAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  updateSoundButtonUI() {
    const onIcon = document.getElementById('icon-sound-on');
    const offIcon = document.getElementById('icon-sound-off');
    const label = document.getElementById('sound-label');
    if (this.soundEnabled) {
      if (onIcon) onIcon.classList.remove('hidden');
      if (offIcon) offIcon.classList.add('hidden');
      if (label) label.textContent = 'ALERTS: ON';
    } else {
      if (onIcon) onIcon.classList.add('hidden');
      if (offIcon) offIcon.classList.remove('hidden');
      if (label) label.textContent = 'ALERTS: MUTED';
    }
  }

  playIncidentAlarm() {
    if (!this.soundEnabled) return;
    try {
      this.ensureAudioContext();
      if (!this.audioCtx) return;

      const now = this.audioCtx.currentTime;
      // High-priority alternating siren beep
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(440, now + 0.15);
      osc.frequency.setValueAtTime(880, now + 0.3);
      osc.frequency.setValueAtTime(440, now + 0.45);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.6);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.6);
    } catch (e) {
      console.warn('Audio alert error:', e);
    }
  }

  playRecoveryChime() {
    if (!this.soundEnabled) return;
    try {
      this.ensureAudioContext();
      if (!this.audioCtx) return;

      const now = this.audioCtx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, now + idx * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.4);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now + idx * 0.1);
        osc.stop(now + idx * 0.1 + 0.4);
      });
    } catch (e) {
      console.warn('Audio alert error:', e);
    }
  }

  playPingBlip() {
    if (!this.soundEnabled) return;
    try {
      this.ensureAudioContext();
      if (!this.audioCtx) return;

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1100, now);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.05);

      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.05);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.05);
    } catch (e) {}
  }

  /* ========================================================================
     WebSocket Real-time Client
     ======================================================================== */
  initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const indicator = document.getElementById('ws-indicator');
    const label = indicator ? indicator.querySelector('.ws-label') : null;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        if (indicator) {
          indicator.className = 'ws-badge ws-connected';
          if (label) label.textContent = 'LIVE STREAM';
        }
        if (this.wsReconnectTimer) {
          clearTimeout(this.wsReconnectTimer);
          this.wsReconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleWebSocketMessage(msg);
        } catch (err) {
          console.error('[WS] Parse error:', err);
        }
      };

      this.ws.onclose = () => {
        if (indicator) {
          indicator.className = 'ws-badge ws-disconnected';
          if (label) label.textContent = 'RECONNECTING...';
        }
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        if (indicator) {
          indicator.className = 'ws-badge ws-disconnected';
          if (label) label.textContent = 'DISCONNECTED';
        }
      };
    } catch (err) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.wsReconnectTimer) {
      this.wsReconnectTimer = setTimeout(() => {
        this.initWebSocket();
      }, 3000);
    }
  }

  handleWebSocketMessage(msg) {
    switch (msg.type) {
      case 'initial_state':
        this.monitors = msg.payload.monitors || [];
        this.activeIncidents = msg.payload.activeIncidents || [];
        this.updateGroupsDropdown();
        this.refreshAll();
        break;

      case 'check_result':
        this.onCheckResult(msg.payload);
        break;

      case 'incident_started':
        this.onIncidentStarted(msg.payload);
        break;

      case 'incident_resolved':
        this.onIncidentResolved(msg.payload);
        break;

      case 'incident_acknowledged':
        this.onIncidentAcknowledged(msg.payload);
        break;

      case 'monitor_created':
      case 'monitor_updated':
        this.fetchMonitorsList();
        break;

      case 'monitor_deleted':
        this.monitors = this.monitors.filter(m => m.id !== msg.payload.id);
        this.refreshAll();
        break;
    }
  }

  onCheckResult(payload) {
    const { heartbeat, monitor } = payload;
    const existing = this.monitors.find(m => m.id === monitor.id);

    if (existing) {
      const prevStatus = existing.latestHeartbeat ? existing.latestHeartbeat.status : 'UP';
      existing.latestHeartbeat = heartbeat;
      if (!existing.history) existing.history = [];
      existing.history.push(heartbeat);
      if (existing.history.length > 50) existing.history.shift();

      // Audio triggers on state transition
      if (prevStatus !== 'DOWN' && heartbeat.status === 'DOWN') {
        this.playIncidentAlarm();
      } else if (prevStatus === 'DOWN' && heartbeat.status === 'UP') {
        this.playRecoveryChime();
      }
    }

    // Append to live stream drawer
    this.addStreamLog(heartbeat, monitor);

    // If modal is inspecting this monitor, refresh chart & timing
    if (this.activeDetailMonitorId === monitor.id) {
      this.updateDetailModalLive(monitor.id);
    }

    this.renderKPIs();
    this.renderMonitors();
  }

  onIncidentStarted(incident) {
    this.activeIncidents = this.activeIncidents.filter(i => i.id !== incident.id);
    this.activeIncidents.unshift(incident);
    this.playIncidentAlarm();
    this.renderIncidentBanner();
    this.renderKPIs();
  }

  onIncidentResolved(incident) {
    this.activeIncidents = this.activeIncidents.filter(i => i.id !== incident.id);
    this.playRecoveryChime();
    this.renderIncidentBanner();
    this.renderKPIs();
  }

  onIncidentAcknowledged(incident) {
    const idx = this.activeIncidents.findIndex(i => i.id === incident.id);
    if (idx !== -1) {
      this.activeIncidents[idx] = incident;
    }
    this.renderIncidentBanner();
  }

  /* ========================================================================
     API Data Fetching
     ======================================================================== */
  async fetchInitialSummary() {
    try {
      const res = await fetch('/api/monitors');
      const data = await res.json();
      if (data.success) {
        this.monitors = data.monitors;
        this.updateGroupsDropdown();
        this.refreshAll();
      }
    } catch (err) {
      console.error('Initial fetch failed:', err);
    }
  }

  async fetchMonitorsList() {
    try {
      const res = await fetch('/api/monitors');
      const data = await res.json();
      if (data.success) {
        this.monitors = data.monitors;
        this.updateGroupsDropdown();
        this.refreshAll();
      }
    } catch (err) {}
  }

  /* ========================================================================
     UI Rendering
     ======================================================================== */
  refreshAll() {
    this.renderKPIs();
    this.renderIncidentBanner();
    this.renderMonitors();
  }

  renderKPIs() {
    let total = this.monitors.length;
    let upCount = 0;
    let degradedCount = 0;
    let downCount = 0;
    let pausedCount = 0;
    let totalLatency = 0;
    let latencyChecks = 0;

    this.monitors.forEach(m => {
      if (!m.is_active) {
        pausedCount++;
        return;
      }
      const status = m.latestHeartbeat ? m.latestHeartbeat.status : 'UP';
      if (status === 'UP') upCount++;
      else if (status === 'DEGRADED') degradedCount++;
      else if (status === 'DOWN') downCount++;

      if (m.latestHeartbeat && m.latestHeartbeat.response_time_ms > 0) {
        totalLatency += m.latestHeartbeat.response_time_ms;
        latencyChecks++;
      }
    });

    const activeCount = total - pausedCount;
    const healthScore = activeCount > 0 
      ? Math.round(((upCount + degradedCount * 0.5) / activeCount) * 1000) / 10 
      : 100;
    const avgLatency = latencyChecks > 0 ? Math.round(totalLatency / latencyChecks) : 0;

    // Elements
    const healthScoreEl = document.getElementById('kpi-health-score');
    const healthBarEl = document.getElementById('kpi-health-bar');
    const totalEl = document.getElementById('kpi-total');
    const pausedEl = document.getElementById('kpi-paused');
    const upEl = document.getElementById('kpi-up');
    const degradedEl = document.getElementById('kpi-degraded');
    const downEl = document.getElementById('kpi-down');
    const avgLatencyEl = document.getElementById('kpi-avg-latency');
    const incidentsBadgeEl = document.getElementById('kpi-incidents-badge');

    // Counts in filter pills
    document.getElementById('count-all').textContent = total;
    document.getElementById('count-up').textContent = upCount;
    document.getElementById('count-degraded').textContent = degradedCount;
    document.getElementById('count-down').textContent = downCount;
    document.getElementById('count-paused').textContent = pausedCount;

    if (healthScoreEl) healthScoreEl.textContent = `${healthScore}%`;
    if (healthBarEl) {
      healthBarEl.style.width = `${healthScore}%`;
      healthBarEl.className = healthScore >= 98 ? 'kpi-bar-fill bg-emerald' : (healthScore >= 85 ? 'kpi-bar-fill bg-amber' : 'kpi-bar-fill bg-rose');
    }
    if (totalEl) totalEl.textContent = total;
    if (pausedEl) pausedEl.textContent = pausedCount;
    if (upEl) upEl.textContent = upCount;
    if (degradedEl) degradedEl.textContent = degradedCount;
    if (downEl) downEl.textContent = downCount;
    if (avgLatencyEl) avgLatencyEl.textContent = latencyChecks > 0 ? `${avgLatency} ms` : '-- ms';
    if (incidentsBadgeEl) incidentsBadgeEl.textContent = `${this.activeIncidents.length} INCIDENTS`;

    // Global Top Status Pill
    const globalPill = document.getElementById('global-status-pill');
    const globalText = document.getElementById('global-status-text');
    if (globalPill && globalText) {
      if (downCount > 0) {
        globalPill.className = 'status-pill status-down';
        globalText.textContent = `${downCount} SERVICE OUTAGE${downCount > 1 ? 'S' : ''}`;
      } else if (degradedCount > 0) {
        globalPill.className = 'status-pill status-degraded';
        globalText.textContent = `${degradedCount} DEGRADED SERVICE${degradedCount > 1 ? 'S' : ''}`;
      } else {
        globalPill.className = 'status-pill status-up';
        globalText.textContent = 'ALL SYSTEMS OPERATIONAL';
      }
    }
  }

  renderIncidentBanner() {
    const banner = document.getElementById('incident-banner');
    if (!banner) return;

    if (this.activeIncidents.length === 0) {
      banner.classList.add('hidden');
      return;
    }

    banner.classList.remove('hidden');
    const first = this.activeIncidents[0];
    const titleEl = document.getElementById('incident-banner-title');
    const descEl = document.getElementById('incident-banner-desc');
    const ackBtn = document.getElementById('btn-ack-incident');

    if (titleEl) {
      titleEl.textContent = `CRITICAL INCIDENT: ${first.monitor_name || 'MONITOR TARGET'} DOWN`;
    }
    if (descEl) {
      descEl.textContent = `Outage detected at ${new Date(first.started_at).toLocaleTimeString()} - Cause: ${first.cause || 'Target unreachable'}`;
    }
    if (ackBtn) {
      if (first.acknowledged_at) {
        ackBtn.textContent = 'ALARM ACKNOWLEDGED';
        ackBtn.disabled = true;
      } else {
        ackBtn.textContent = 'ACKNOWLEDGE ALARM';
        ackBtn.disabled = false;
        ackBtn.onclick = () => this.acknowledgeIncident(first.id);
      }
    }
  }

  getFilteredMonitors() {
    return this.monitors.filter(m => {
      // Status filter
      const status = !m.is_active ? 'paused' : (m.latestHeartbeat ? m.latestHeartbeat.status.toLowerCase() : 'up');
      if (this.filter !== 'all' && status !== this.filter) {
        return false;
      }

      // Group filter
      if (this.groupFilter !== 'ALL' && m.group_tag !== this.groupFilter) {
        return false;
      }

      // Search query
      if (this.searchQuery.trim() !== '') {
        const q = this.searchQuery.toLowerCase();
        const nameMatch = m.name.toLowerCase().includes(q);
        const urlMatch = m.url.toLowerCase().includes(q);
        const groupMatch = (m.group_tag || '').toLowerCase().includes(q);
        const keywordMatch = (m.keyword_check || '').toLowerCase().includes(q);
        if (!nameMatch && !urlMatch && !groupMatch && !keywordMatch) {
          return false;
        }
      }

      return true;
    });
  }

  renderMonitors() {
    const filtered = this.getFilteredMonitors();
    const emptyState = document.getElementById('empty-state');

    const cardsContainer = document.getElementById('monitors-cards-grid');
    const matrixContainer = document.getElementById('monitors-matrix-view');
    const tableContainer = document.getElementById('monitors-table-view');

    if (filtered.length === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (cardsContainer) cardsContainer.innerHTML = '';
      if (matrixContainer) matrixContainer.innerHTML = '';
      if (document.getElementById('monitors-table-body')) {
        document.getElementById('monitors-table-body').innerHTML = '';
      }
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    if (this.currentView === 'cards') {
      this.renderCardsView(filtered);
    } else if (this.currentView === 'matrix') {
      this.renderMatrixView(filtered);
    } else if (this.currentView === 'table') {
      this.renderTableView(filtered);
    }
  }

  /* View 1: Card Grid */
  renderCardsView(items) {
    const container = document.getElementById('monitors-cards-grid');
    if (!container) return;

    container.innerHTML = items.map(m => {
      const hb = m.latestHeartbeat || {};
      const status = !m.is_active ? 'PAUSED' : (hb.status || 'UP');
      const isDown = status === 'DOWN';
      const isDegraded = status === 'DEGRADED';
      const isPaused = status === 'PAUSED';

      let statusPillClass = 'status-up';
      if (isDown) statusPillClass = 'status-down';
      else if (isDegraded) statusPillClass = 'status-degraded';
      else if (isPaused) statusPillClass = 'status-paused';

      const latencyMs = hb.response_time_ms ? `${Math.round(hb.response_time_ms)}ms` : '--';
      const uptimeStr = m.uptime24h !== undefined ? `${m.uptime24h}%` : '100%';

      // SSL Display
      let sslHtml = '<span class="ssl-badge">🛡️ N/A</span>';
      if (m.ssl_check_enabled && hb.ssl_days_remaining !== null && hb.ssl_days_remaining !== undefined) {
        let sslClass = 'ssl-good';
        if (hb.ssl_days_remaining <= 0) sslClass = 'ssl-expired';
        else if (hb.ssl_days_remaining <= 14) sslClass = 'ssl-warning';
        sslHtml = `<span class="ssl-badge ${sslClass}" title="SSL valid for ${hb.ssl_days_remaining} days (${hb.ssl_issuer || 'Verified'})">🛡️ ${hb.ssl_days_remaining}d</span>`;
      }

      // History Ticks
      const ticksHtml = window.NOCCharts 
        ? window.NOCCharts.renderHistoryTicksHtml(m.history, 35) 
        : '';

      // Identify specific error causes (404 Not Found, Database Error, Cloudflare WAF, etc.)
      let errorBannerHtml = '';
      let httpCodeBadge = `HTTP ${hb.status_code || 200}`;
      let httpCodeColor = 'uptime-summary-text';

      if (isDown && hb.error_message) {
        const msg = hb.error_message;
        const isDbErr = msg.toLowerCase().includes('database') || msg.toLowerCase().includes('sql');
        const is404 = hb.status_code === 404 || msg.includes('404');
        const isCf = msg.includes('Cloudflare');

        let badgeClass = 'card-err-down';
        let badgeIcon = '⚠️';
        let label = msg;

        if (isDbErr) {
          badgeClass = 'card-err-db';
          badgeIcon = '🗄️';
          label = `DB ERROR: ${msg.replace(/^Database Error:\s*/i, '')}`;
          httpCodeBadge = 'DATABASE ERROR';
        } else if (is404) {
          badgeClass = 'card-err-404';
          badgeIcon = '🔍';
          label = 'HTTP 404 NOT FOUND (Page Missing)';
          httpCodeBadge = 'HTTP 404 NOT FOUND';
        } else if (isCf) {
          badgeClass = 'card-err-down';
          badgeIcon = '🛡️';
          label = 'CLOUDFLARE WAF 403 CHALLENGE';
          httpCodeBadge = 'HTTP 403 FORBIDDEN';
        } else if (hb.status_code >= 500) {
          httpCodeBadge = `HTTP ${hb.status_code} ERROR`;
        }

        httpCodeColor = 'uptime-summary-text text-rose';

        errorBannerHtml = `
          <div class="card-error-banner ${badgeClass}" title="${msg}">
            <span class="err-icon">${badgeIcon}</span>
            <span class="err-text">${label}</span>
          </div>
        `;
      }

      return `
        <div class="monitor-card ${isDown ? 'card-down' : ''}" onclick="window.app.openDetails(${m.id})">
          <div class="card-top">
            <div class="card-title-col">
              <div class="card-name-row">
                <span class="status-pill ${statusPillClass}"><span class="pulse-dot"></span>${status}</span>
                <span class="card-name" title="${m.name}">${m.name}</span>
              </div>
              <a href="${m.url}" target="_blank" rel="noopener noreferrer" class="card-url" onclick="event.stopPropagation()">${m.url}</a>
            </div>
            <div class="card-badges">
              <span class="group-tag">${m.group_tag || 'Default'}</span>
            </div>
          </div>

          <div class="card-mid">
            <div class="card-metric-cell">
              <span style="color: var(--text-dim);">Latency:</span>
              <span class="latency-val ${isDown ? 'text-rose' : (isDegraded ? 'text-amber' : 'text-cyan')}">${latencyMs}</span>
            </div>
            <div class="card-metric-cell">
              ${sslHtml}
            </div>
            <div class="card-metric-cell">
              <span style="color: var(--text-dim);">24h:</span>
              <span class="text-emerald" style="font-weight: 700;">${uptimeStr}</span>
            </div>
          </div>

          ${errorBannerHtml}

          <div class="card-bottom">
            <div class="history-strip-header">
              <span>RECENT CHECKS</span>
              <span>EVERY ${m.interval_seconds}S</span>
            </div>
            ${ticksHtml}
            <div class="card-actions-row" onclick="event.stopPropagation()">
              <span class="${httpCodeColor}" style="font-weight: 700; font-size: 10px;">${httpCodeBadge}</span>
              <div style="display: flex; gap: 4px;">
                <button class="btn-card-action" onclick="window.app.triggerPing(${m.id})" title="Ping this endpoint immediately">PING</button>
                <button class="btn-card-action" onclick="window.app.toggleActive(${m.id})" title="Pause / Resume">${m.is_active ? 'PAUSE' : 'RESUME'}</button>
                <button class="btn-card-action" onclick="window.app.openEditById(${m.id})" title="Edit Target & Headers">EDIT</button>
                <button class="btn-card-action" onclick="window.app.openDetails(${m.id})" title="Inspect Telemetry">INSPECT</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /* View 2: High-Density NOC Wallboard Matrix */
  renderMatrixView(items) {
    const container = document.getElementById('monitors-matrix-view');
    if (!container) return;

    container.innerHTML = items.map(m => {
      const hb = m.latestHeartbeat || {};
      const status = !m.is_active ? 'PAUSED' : (hb.status || 'UP');
      let tileClass = 'tile-up';
      if (status === 'DOWN') tileClass = 'tile-down';
      else if (status === 'DEGRADED') tileClass = 'tile-degraded';
      else if (status === 'PAUSED') tileClass = 'tile-paused';

      let displayVal = hb.response_time_ms ? `${Math.round(hb.response_time_ms)}ms` : '--';
      if (status === 'DOWN') {
        if (hb.status_code === 404) displayVal = '404';
        else if (hb.error_message && (hb.error_message.includes('Database') || hb.error_message.includes('SQL'))) displayVal = 'DB ERR';
        else if (hb.status_code) displayVal = `HTTP ${hb.status_code}`;
        else displayVal = 'DOWN';
      }

      return `
        <div class="matrix-tile ${tileClass}" onclick="window.app.openDetails(${m.id})">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div class="matrix-tile-name" title="${m.name}">${m.name}</div>
            <span style="font-size: 9px; font-weight: 700; color: var(--text-dim);">${status}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <span class="matrix-tile-val ${status === 'DOWN' ? 'text-rose' : (status === 'DEGRADED' ? 'text-amber' : 'text-cyan')}">${displayVal}</span>
            <span class="matrix-tile-group">${m.group_tag || 'Core'}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  /* View 3: Dense Telemetry Table */
  renderTableView(items) {
    const tbody = document.getElementById('monitors-table-body');
    if (!tbody) return;

    tbody.innerHTML = items.map(m => {
      const hb = m.latestHeartbeat || {};
      const status = !m.is_active ? 'PAUSED' : (hb.status || 'UP');
      const isDown = status === 'DOWN';
      let statusPillClass = 'status-up';
      if (isDown) statusPillClass = 'status-down';
      else if (status === 'DEGRADED') statusPillClass = 'status-degraded';
      else if (status === 'PAUSED') statusPillClass = 'status-paused';

      const latencyMs = hb.response_time_ms ? `${Math.round(hb.response_time_ms)}ms` : '--';
      const uptimeStr = m.uptime24h !== undefined ? `${m.uptime24h}%` : '100%';
      const sslText = hb.ssl_days_remaining !== null && hb.ssl_days_remaining !== undefined 
        ? `${hb.ssl_days_remaining} days` 
        : 'N/A';

      const ticksHtml = window.NOCCharts 
        ? window.NOCCharts.renderHistoryTicksHtml(m.history, 20) 
        : '';

      const errSnippet = (isDown && hb.error_message) 
        ? `<div style="font-size: 10px; color: #f87171; font-weight: 600; margin-top: 2px;">⚠️ ${hb.error_message}</div>` 
        : '';

      return `
        <tr class="${isDown ? 'table-row-down' : ''}" onclick="window.app.openDetails(${m.id})" style="cursor: pointer;">
          <td><span class="status-pill ${statusPillClass}"><span class="pulse-dot"></span>${status}</span></td>
          <td>
            <div style="font-weight: 700; color: #fff;">${m.name}</div>
            <div style="font-size: 10.5px; color: var(--text-dim); font-family: var(--font-mono);">${m.url}</div>
            ${errSnippet}
          </td>
          <td><span class="group-tag">${m.group_tag || 'Production'}</span></td>
          <td style="font-family: var(--font-mono); font-weight: 700;" class="${isDown ? 'text-rose' : 'text-cyan'}">${latencyMs}</td>
          <td style="font-size: 11px; color: var(--text-muted);">${sslText}</td>
          <td style="font-family: var(--font-mono); font-weight: 700; color: var(--color-up);">${uptimeStr}</td>
          <td>${ticksHtml}</td>
          <td style="text-align: right;" onclick="event.stopPropagation()">
            <button class="btn-card-action" onclick="window.app.triggerPing(${m.id})">PING</button>
            <button class="btn-card-action" onclick="window.app.openEditById(${m.id})">EDIT</button>
            <button class="btn-card-action" onclick="window.app.openDetails(${m.id})">INSPECT</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  /* Groups Dropdown */
  updateGroupsDropdown() {
    const select = document.getElementById('group-filter');
    if (!select) return;

    const groups = new Set(['Production', 'Landing Pages', 'Core Network', 'APIs & Services', 'Infrastructure', 'Staging & QA']);
    this.monitors.forEach(m => {
      if (m.group_tag) groups.add(m.group_tag);
    });

    const currentVal = this.groupFilter;
    let html = `<option value="ALL">All Groups</option>`;
    groups.forEach(g => {
      html += `<option value="${g}" ${g === currentVal ? 'selected' : ''}>${g}</option>`;
    });
    select.innerHTML = html;
  }

  /* Bottom Stream Logs */
  addStreamLog(heartbeat, monitor) {
    const list = document.getElementById('stream-logs-list');
    const latestEl = document.getElementById('stream-latest-event');
    const timeStr = new Date(heartbeat.timestamp || Date.now()).toLocaleTimeString();

    const statusClass = heartbeat.status === 'UP' ? 'log-status-up' : (heartbeat.status === 'DEGRADED' ? 'log-status-degraded' : 'log-status-down');
    const latencyStr = heartbeat.response_time_ms ? `${Math.round(heartbeat.response_time_ms)}ms` : 'TIMEOUT';
    const detailStr = heartbeat.error_message || `HTTP ${heartbeat.status_code || 200} OK`;

    if (latestEl) {
      latestEl.textContent = `[${timeStr}] ${monitor.name}: ${heartbeat.status} (${latencyStr}) - ${detailStr}`;
    }

    if (list) {
      const entry = document.createElement('div');
      entry.className = 'stream-log-entry';
      entry.innerHTML = `
        <span class="log-time">${timeStr}</span>
        <span class="${statusClass}">[${heartbeat.status}]</span>
        <span class="log-name" title="${monitor.name}">${monitor.name}</span>
        <span class="log-latency">${latencyStr}</span>
        <span class="log-detail" title="${detailStr}">${detailStr}</span>
      `;
      list.prepend(entry);

      // Keep maximum 80 stream logs
      if (list.children.length > 80) {
        list.removeChild(list.lastChild);
      }
    }
  }

  /* ========================================================================
     Target Deep-Dive Telemetry Inspector Modal
     ======================================================================== */
  async openDetails(monitorId) {
    this.activeDetailMonitorId = monitorId;
    const modal = document.getElementById('modal-details');
    if (!modal) return;

    try {
      const res = await fetch(`/api/monitors/${monitorId}`);
      const data = await res.json();
      if (!data.success) return;

      const m = data.monitor;
      const hb = m.latestHeartbeat || {};

      // Fill headers & badges
      document.getElementById('detail-title').textContent = m.name;
      document.getElementById('detail-url').textContent = `${m.method || 'GET'} ${m.url}`;

      const statusPill = document.getElementById('detail-status-pill');
      const status = !m.is_active ? 'PAUSED' : (hb.status || 'UP');
      statusPill.className = `status-pill status-${status.toLowerCase()}`;
      statusPill.textContent = status;

      // Fill KPIs
      document.getElementById('detail-curr-latency').textContent = hb.response_time_ms ? `${Math.round(hb.response_time_ms)} ms` : '--';
      document.getElementById('detail-uptime-24h').textContent = m.uptimeStats ? `${m.uptimeStats['24h'].uptimePercent}%` : '100%';
      document.getElementById('detail-uptime-7d').textContent = m.uptimeStats ? `${m.uptimeStats['7d'].uptimePercent}%` : '100%';
      document.getElementById('detail-uptime-30d').textContent = m.uptimeStats ? `${m.uptimeStats['30d'].uptimePercent}%` : '100%';

      // SSL Info
      const sslInfoEl = document.getElementById('detail-ssl-info');
      if (m.ssl_check_enabled && hb.ssl_days_remaining !== null && hb.ssl_days_remaining !== undefined) {
        sslInfoEl.textContent = `${hb.ssl_days_remaining}d remaining`;
        sslInfoEl.className = hb.ssl_days_remaining <= 14 ? 'detail-kpi-val text-amber' : 'detail-kpi-val text-emerald';
      } else {
        sslInfoEl.textContent = 'Not Applicable';
        sslInfoEl.className = 'detail-kpi-val';
      }

      // Timing breakdown bar
      const dns = hb.dns_time_ms || 0;
      const tcp = hb.tcp_time_ms || 0;
      const tls = hb.tls_time_ms || 0;
      const ttfb = hb.ttfb_ms || 0;
      const totalPhases = Math.max(0.1, dns + tcp + tls + ttfb);

      const setTiming = (id, val, label) => {
        const el = document.getElementById(id);
        if (el) {
          if (val > 0) {
            const pct = Math.max(12, Math.round((val / totalPhases) * 100));
            el.style.width = `${pct}%`;
            el.style.display = 'flex';
            el.textContent = `${label}: ${Math.round(val)}ms`;
          } else {
            el.style.display = 'none';
          }
        }
      };
      setTiming('timing-dns', dns, 'DNS');
      setTiming('timing-tcp', tcp, 'TCP');
      setTiming('timing-tls', tls, 'TLS');
      setTiming('timing-ttfb', ttfb, 'TTFB');

      // If all are zero (e.g. failed/offline probe), show a fallback message
      const bar = document.querySelector('.timing-breakdown-bar');
      if (dns === 0 && tcp === 0 && tls === 0 && ttfb === 0) {
        if (bar) {
          bar.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;color:var(--text-dim);font-size:11px;">Phase timing data unavailable for failed probe</div>';
        }
      } else if (bar && !bar.querySelector('.timing-segment')) {
        bar.innerHTML = `
          <div id="timing-dns" class="timing-segment timing-dns" title="DNS Lookup">DNS: 0ms</div>
          <div id="timing-tcp" class="timing-segment timing-tcp" title="TCP Connect">TCP: 0ms</div>
          <div id="timing-tls" class="timing-segment timing-tls" title="TLS Handshake">TLS: 0ms</div>
          <div id="timing-ttfb" class="timing-segment timing-ttfb" title="TTFB">TTFB: 0ms</div>
        `;
        setTiming('timing-dns', dns, 'DNS');
        setTiming('timing-tcp', tcp, 'TCP');
        setTiming('timing-tls', tls, 'TLS');
        setTiming('timing-ttfb', ttfb, 'TTFB');
      }

      // Latency Timeline Canvas
      const canvas = document.getElementById('detail-latency-chart');
      if (canvas && window.NOCCharts) {
        const stats = window.NOCCharts.renderLatencyChart(canvas, m.history);
        const summaryEl = document.getElementById('detail-chart-summary');
        if (summaryEl && stats) {
          summaryEl.textContent = `Min: ${stats.min}ms | Avg: ${stats.avg}ms | Max: ${stats.max}ms | p95: ${stats.p95}ms`;
        }
      }

      // Recent Probes Log Table
      const tbody = document.getElementById('detail-probes-tbody');
      if (tbody && m.history) {
        tbody.innerHTML = [...m.history].reverse().slice(0, 20).map(h => {
          const time = new Date(h.timestamp).toLocaleTimeString();
          const isUp = h.status === 'UP';
          const isDeg = h.status === 'DEGRADED';
          const statusColor = isUp ? 'text-emerald' : (isDeg ? 'text-amber' : 'text-rose');
          const sslDisp = h.ssl_days_remaining !== null ? `${h.ssl_days_remaining}d` : '-';
          return `
            <tr>
              <td style="font-family: var(--font-mono); color: var(--text-dim);">${time}</td>
              <td class="${statusColor}" style="font-weight: 700;">${h.status}</td>
              <td style="font-family: var(--font-mono);">${h.status_code || '-'}</td>
              <td style="font-family: var(--font-mono);">${h.response_time_ms ? Math.round(h.response_time_ms) + 'ms' : '-'}</td>
              <td style="color: var(--text-muted);">${sslDisp}</td>
              <td style="color: var(--text-dim);">${h.error_message || 'OK (Probe Successful)'}</td>
            </tr>
          `;
        }).join('');
      }

      // Action buttons in modal
      const pingBtn = document.getElementById('detail-ping-now-btn');
      if (pingBtn) {
        pingBtn.onclick = () => this.triggerPing(m.id);
      }

      const toggleBtn = document.getElementById('detail-btn-toggle');
      if (toggleBtn) {
        toggleBtn.textContent = m.is_active ? 'Pause Monitoring' : 'Resume Monitoring';
        toggleBtn.onclick = async () => {
          await this.toggleActive(m.id);
          this.openDetails(m.id);
        };
      }

      const editBtn = document.getElementById('detail-btn-edit');
      if (editBtn) {
        editBtn.onclick = () => {
          modal.close();
          this.openEditModal(m);
        };
      }

      const deleteBtn = document.getElementById('detail-btn-delete');
      if (deleteBtn) {
        deleteBtn.onclick = () => {
          if (confirm(`Are you sure you want to permanently delete monitor "${m.name}"?`)) {
            this.deleteMonitor(m.id);
            modal.close();
          }
        };
      }

      modal.showModal();
    } catch (err) {
      console.error('Failed to open details:', err);
    }
  }

  async updateDetailModalLive(monitorId) {
    // Only re-fetch if modal is actively open
    const modal = document.getElementById('modal-details');
    if (modal && modal.open) {
      this.openDetails(monitorId);
    }
  }

  /* ========================================================================
     Target Add / Edit Dialog
     ======================================================================== */
  openAddModal() {
    const modal = document.getElementById('modal-target');
    const form = document.getElementById('form-target');
    if (!modal || !form) return;

    form.reset();
    document.getElementById('modal-target-title').textContent = 'Add New Target Endpoint';
    document.getElementById('form-monitor-id').value = '';
    document.getElementById('form-interval').value = '30';
    document.getElementById('form-timeout').value = '10000';
    document.getElementById('form-expected-status').value = '200';
    document.getElementById('form-ssl-check').checked = true;
    document.getElementById('form-headers').value = '';

    modal.showModal();
  }

  openEditById(monitorId) {
    const m = this.monitors.find(item => item.id === monitorId);
    if (m) this.openEditModal(m);
  }

  openEditModal(monitor) {
    const modal = document.getElementById('modal-target');
    if (!modal) return;

    document.getElementById('modal-target-title').textContent = `Edit Target: ${monitor.name}`;
    document.getElementById('form-monitor-id').value = monitor.id;
    document.getElementById('form-name').value = monitor.name;
    document.getElementById('form-url').value = monitor.url;
    document.getElementById('form-group').value = monitor.group_tag || 'Production';
    document.getElementById('form-method').value = monitor.method || 'GET';
    document.getElementById('form-interval').value = monitor.interval_seconds || 30;
    document.getElementById('form-timeout').value = monitor.timeout_ms || 10000;
    document.getElementById('form-expected-status').value = monitor.expected_status || 200;
    document.getElementById('form-keyword').value = monitor.keyword_check || '';
    document.getElementById('form-ssl-check').checked = Boolean(monitor.ssl_check_enabled);
    document.getElementById('form-headers').value = monitor.custom_headers || '';

    modal.showModal();
  }

  async saveTargetForm(e) {
    e.preventDefault();
    const id = document.getElementById('form-monitor-id').value;
    const payload = {
      name: document.getElementById('form-name').value,
      url: document.getElementById('form-url').value,
      group_tag: document.getElementById('form-group').value || 'Production',
      method: document.getElementById('form-method').value,
      interval_seconds: Number(document.getElementById('form-interval').value),
      timeout_ms: Number(document.getElementById('form-timeout').value),
      expected_status: Number(document.getElementById('form-expected-status').value),
      keyword_check: document.getElementById('form-keyword').value,
      ssl_check_enabled: document.getElementById('form-ssl-check').checked ? 1 : 0,
      custom_headers: document.getElementById('form-headers').value
    };

    try {
      const url = id ? `/api/monitors/${id}` : '/api/monitors';
      const method = id ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('modal-target').close();
        this.fetchMonitorsList();
      } else {
        alert(`Error saving target: ${data.error}`);
      }
    } catch (err) {
      alert(`Network error saving target: ${err.message}`);
    }
  }

  /* ========================================================================
     Action Triggers
     ======================================================================== */
  async triggerPing(monitorId) {
    this.playPingBlip();
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'check_now', monitorId }));
      } else {
        await fetch(`/api/monitors/${monitorId}/check`, { method: 'POST' });
      }
    } catch (err) {
      console.error('Trigger ping failed:', err);
    }
  }

  async triggerPingAll() {
    this.playPingBlip();
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'check_all' }));
      } else {
        await fetch('/api/monitors/check-all', { method: 'POST' });
      }
    } catch (err) {
      console.error('Ping all failed:', err);
    }
  }

  async toggleActive(monitorId) {
    try {
      const res = await fetch(`/api/monitors/${monitorId}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const idx = this.monitors.findIndex(m => m.id === monitorId);
        if (idx !== -1) {
          this.monitors[idx].is_active = data.monitor.is_active;
          this.refreshAll();
        }
      }
    } catch (err) {
      console.error('Toggle active failed:', err);
    }
  }

  async deleteMonitor(monitorId) {
    try {
      const res = await fetch(`/api/monitors/${monitorId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.monitors = this.monitors.filter(m => m.id !== monitorId);
        this.refreshAll();
      }
    } catch (err) {
      console.error('Delete monitor failed:', err);
    }
  }

  async acknowledgeIncident(incidentId) {
    try {
      const res = await fetch(`/api/incidents/${incidentId}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator: 'NOC Controller' })
      });
      const data = await res.json();
      if (data.success) {
        this.onIncidentAcknowledged(data.incident);
      }
    } catch (err) {}
  }

  /* ========================================================================
     SLA & Telemetry Reporting & Export
     ======================================================================== */
  openReportModal() {
    const modal = document.getElementById('modal-report');
    if (!modal) return;

    // Populate target monitor select
    const select = document.getElementById('report-monitor-select');
    if (select) {
      let html = `<option value="all">All Targets (Executive Overview)</option>`;
      this.monitors.forEach(m => {
        html += `<option value="${m.id}">${m.name} (${m.url})</option>`;
      });
      select.innerHTML = html;
    }

    this.loadReport();
    modal.showModal();
  }

  async loadReport() {
    const monitorSelect = document.getElementById('report-monitor-select');
    const rangeSelect = document.getElementById('report-range-select');

    const monitorId = monitorSelect ? monitorSelect.value : 'all';
    const range = rangeSelect ? rangeSelect.value : '24h';

    try {
      const res = await fetch(`/api/reports?range=${range}&monitor_id=${monitorId}`);
      const data = await res.json();
      if (!data.success) return;

      const { executiveSummary, reportItems, incidents } = data;

      // Executive KPI banner
      document.getElementById('rep-kpi-uptime').textContent = `${executiveSummary.averageUptimePercent}%`;
      document.getElementById('rep-kpi-range-label').textContent = executiveSummary.range;
      document.getElementById('rep-kpi-latency').textContent = `${executiveSummary.averageLatencyMs} ms`;
      document.getElementById('rep-kpi-probes').textContent = executiveSummary.totalProbesRun.toLocaleString();
      document.getElementById('rep-kpi-incidents').textContent = executiveSummary.totalIncidents;
      document.getElementById('rep-kpi-downtime').textContent = `${executiveSummary.totalDowntimeMinutes} min`;

      document.getElementById('rep-generated-at').textContent = `Generated: ${new Date(executiveSummary.generatedAt).toLocaleString()}`;
      document.getElementById('rep-table-title').textContent = monitorId === 'all' 
        ? `Performance Metrics by URL (${reportItems.length} Targets)` 
        : `Performance Metrics for Selected Target`;

      // Render Telemetry Table
      const tbody = document.getElementById('rep-monitors-tbody');
      if (tbody) {
        tbody.innerHTML = reportItems.map(item => {
          const statusClass = item.current_status === 'UP' ? 'status-up' : (item.current_status === 'DEGRADED' ? 'status-degraded' : (item.current_status === 'DOWN' ? 'status-down' : 'status-paused'));
          
          let uptimeBadgeColor = 'text-emerald';
          if (item.uptime_percent < 95) uptimeBadgeColor = 'text-rose';
          else if (item.uptime_percent < 99) uptimeBadgeColor = 'text-amber';

          const sslText = item.ssl_days_remaining !== null ? `${item.ssl_days_remaining}d` : 'N/A';
          const downtimeMin = item.total_downtime_seconds > 0 ? `${Math.round(item.total_downtime_seconds / 60)}m` : '0m';

          return `
            <tr>
              <td><span class="status-pill ${statusClass}">${item.current_status}</span></td>
              <td>
                <div style="font-weight:700; color:#fff;">${item.name}</div>
                <div style="font-size:10px; color:var(--text-dim); font-family:var(--font-mono);">${item.url}</div>
              </td>
              <td><span class="group-tag">${item.group_tag || 'Production'}</span></td>
              <td style="font-family:var(--font-mono);">${item.total_checks}</td>
              <td style="font-family:var(--font-mono); font-weight:800;" class="${uptimeBadgeColor}">${item.uptime_percent}%</td>
              <td style="font-family:var(--font-mono); font-weight:700;" class="text-cyan">${item.avg_latency_ms}ms</td>
              <td style="font-family:var(--font-mono); font-size:10px; color:var(--text-dim);">${item.min_latency_ms}ms / ${item.max_latency_ms}ms</td>
              <td style="font-size:11px; color:var(--text-muted);">${sslText}</td>
              <td style="font-family:var(--font-mono);">${item.incident_count} (${downtimeMin})</td>
            </tr>
          `;
        }).join('');
      }

      // Render Incident History Table
      const incTbody = document.getElementById('rep-incidents-tbody');
      const incCountLabel = document.getElementById('rep-incidents-count-label');
      if (incCountLabel) {
        incCountLabel.textContent = `${incidents.length} event(s) recorded in ${executiveSummary.range}`;
      }

      if (incTbody) {
        if (incidents.length === 0) {
          incTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--color-up);padding:14px;font-weight:600;">✅ No outages or incidents recorded during this period</td></tr>`;
        } else {
          incTbody.innerHTML = incidents.map(inc => {
            const time = new Date(inc.started_at).toLocaleString();
            const dur = inc.duration_seconds ? `${Math.round(inc.duration_seconds / 60)} min (${inc.duration_seconds}s)` : 'Ongoing';
            const isResolved = inc.status === 'RESOLVED';
            return `
              <tr>
                <td style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-dim);">${time}</td>
                <td style="font-weight:700; color:#fff;">${inc.monitor_name || 'Target'}</td>
                <td style="font-family:var(--font-mono);">${dur}</td>
                <td style="color:var(--text-muted);">${inc.cause || 'Target unreachable'}</td>
                <td><span class="status-pill ${isResolved ? 'status-up' : 'status-down'}">${inc.status}</span></td>
              </tr>
            `;
          }).join('');
        }
      }

    } catch (err) {
      console.error('Error loading report:', err);
    }
  }

  exportReportCSV() {
    const monitorSelect = document.getElementById('report-monitor-select');
    const rangeSelect = document.getElementById('report-range-select');
    const monitorId = monitorSelect ? monitorSelect.value : 'all';
    const range = rangeSelect ? rangeSelect.value : '24h';
    window.location.href = `/api/reports?range=${range}&monitor_id=${monitorId}&format=csv`;
  }

  async exportReportJSON() {
    const monitorSelect = document.getElementById('report-monitor-select');
    const rangeSelect = document.getElementById('report-range-select');
    const monitorId = monitorSelect ? monitorSelect.value : 'all';
    const range = rangeSelect ? rangeSelect.value : '24h';

    try {
      const res = await fetch(`/api/reports?range=${range}&monitor_id=${monitorId}`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `noc-sla-report-${range}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Failed to export JSON: ${err.message}`);
    }
  }

  resetFilters() {
    this.filter = 'all';
    this.groupFilter = 'ALL';
    this.searchQuery = '';
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    const groupSelect = document.getElementById('group-filter');
    if (groupSelect) groupSelect.value = 'ALL';
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    const allPill = document.querySelector('.filter-pill[data-filter="all"]');
    if (allPill) allPill.classList.add('active');
    this.renderMonitors();
  }

  setView(viewName) {
    this.currentView = viewName;
    localStorage.setItem('noc_view', viewName);

    const cardsContainer = document.getElementById('monitors-cards-grid');
    const matrixContainer = document.getElementById('monitors-matrix-view');
    const tableContainer = document.getElementById('monitors-table-view');

    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));

    if (viewName === 'cards') {
      if (cardsContainer) cardsContainer.classList.remove('hidden');
      if (matrixContainer) matrixContainer.classList.add('hidden');
      if (tableContainer) tableContainer.classList.add('hidden');
      document.getElementById('view-cards-btn')?.classList.add('active');
    } else if (viewName === 'matrix') {
      if (cardsContainer) cardsContainer.classList.add('hidden');
      if (matrixContainer) matrixContainer.classList.remove('hidden');
      if (tableContainer) tableContainer.classList.add('hidden');
      document.getElementById('view-matrix-btn')?.classList.add('active');
    } else if (viewName === 'table') {
      if (cardsContainer) cardsContainer.classList.add('hidden');
      if (matrixContainer) matrixContainer.classList.add('hidden');
      if (tableContainer) tableContainer.classList.remove('hidden');
      document.getElementById('view-table-btn')?.classList.add('active');
    }

    this.renderMonitors();
  }

  /* ========================================================================
     DOM Event Listeners
     ======================================================================== */
  initEventListeners() {
    // Search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        this.renderMonitors();
      });
    }

    // Keyboard shortcut '/' to search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput?.focus();
      }
    });

    // Filter pills
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.filter = pill.dataset.filter;
        this.renderMonitors();
      });
    });

    // Group filter dropdown
    const groupSelect = document.getElementById('group-filter');
    if (groupSelect) {
      groupSelect.addEventListener('change', (e) => {
        this.groupFilter = e.target.value;
        this.renderMonitors();
      });
    }

    // View switchers
    document.getElementById('view-cards-btn')?.addEventListener('click', () => this.setView('cards'));
    document.getElementById('view-matrix-btn')?.addEventListener('click', () => this.setView('matrix'));
    document.getElementById('view-table-btn')?.addEventListener('click', () => this.setView('table'));

    // Header buttons
    document.getElementById('btn-add-monitor')?.addEventListener('click', () => this.openAddModal());
    document.getElementById('btn-check-all')?.addEventListener('click', () => this.triggerPingAll());
    document.getElementById('btn-open-reports')?.addEventListener('click', () => this.openReportModal());

    // Reports modal filters & export
    document.getElementById('report-monitor-select')?.addEventListener('change', () => this.loadReport());
    document.getElementById('report-range-select')?.addEventListener('change', () => this.loadReport());
    document.getElementById('btn-export-csv')?.addEventListener('click', () => this.exportReportCSV());
    document.getElementById('btn-export-json')?.addEventListener('click', () => this.exportReportJSON());
    document.getElementById('btn-print-report')?.addEventListener('click', () => window.print());

    // Target form submit
    document.getElementById('form-target')?.addEventListener('submit', (e) => this.saveTargetForm(e));

    // Bottom stream drawer toggle
    document.getElementById('btn-toggle-stream')?.addEventListener('click', () => {
      const drawer = document.getElementById('stream-logs');
      const chevron = document.querySelector('.chevron-icon');
      if (drawer) {
        this.isStreamOpen = !this.isStreamOpen;
        if (this.isStreamOpen) {
          drawer.classList.remove('hidden');
          if (chevron) chevron.style.transform = 'rotate(180deg)';
        } else {
          drawer.classList.add('hidden');
          if (chevron) chevron.style.transform = 'rotate(0deg)';
        }
      }
    });
  }
}

// Bootstrap app on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new NOCDashboard();
});
