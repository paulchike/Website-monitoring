/**
 * High-Density NOC Canvas Charting & History Tick Visualizer
 */
const NOCCharts = {
  /**
   * Renders high-precision retina canvas latency timeline
   */
  renderLatencyChart(canvas, historyData) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Retina support
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.width;
    const height = rect.height || canvas.height;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    if (!historyData || historyData.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No probe telemetry recorded yet', width / 2, height / 2);
      return { min: 0, avg: 0, max: 0, p95: 0 };
    }

    const padding = { top: 20, right: 30, bottom: 25, left: 45 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Extract valid latencies
    const latencies = historyData.map(h => (h.status === 'DOWN' ? 0 : (h.response_time_ms || 0)));
    const validLatencies = latencies.filter(l => l > 0);

    const minLat = validLatencies.length ? Math.min(...validLatencies) : 0;
    const maxLat = validLatencies.length ? Math.max(...validLatencies) : 50;
    const avgLat = validLatencies.length 
      ? Math.round(validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length) 
      : 0;

    // Calculate p95
    const sorted = [...validLatencies].sort((a, b) => a - b);
    const p95Idx = Math.floor(sorted.length * 0.95);
    const p95Lat = sorted.length ? sorted[p95Idx] : 0;

    // Set scale max with 15% headroom
    const scaleMax = Math.max(50, Math.ceil((maxLat * 1.15) / 25) * 25);

    // Draw grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';

    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const val = Math.round((scaleMax / gridSteps) * i);
      const y = padding.top + chartH - (i / gridSteps) * chartH;

      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      ctx.fillText(`${val}ms`, padding.left - 6, y + 3);
    }

    // Coordinates mapping
    const stepX = chartW / Math.max(1, historyData.length - 1);
    const points = historyData.map((h, i) => {
      const isDown = h.status === 'DOWN';
      const lat = isDown ? scaleMax : (h.response_time_ms || 0);
      const x = padding.left + i * stepX;
      const y = padding.top + chartH - (Math.min(lat, scaleMax) / scaleMax) * chartH;
      return { x, y, isDown, status: h.status, latency: h.response_time_ms, time: h.timestamp };
    });

    // Area fill gradient
    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, padding.top + chartH);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line stroke
    ctx.beginPath();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // Data points & error markers
    points.forEach(p => {
      ctx.beginPath();
      if (p.isDown) {
        ctx.fillStyle = '#ef4444';
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (p.status === 'DEGRADED') {
        ctx.fillStyle = '#f59e0b';
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#06b6d4';
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    return {
      min: Math.round(minLat),
      avg: avgLat,
      max: Math.round(maxLat),
      p95: Math.round(p95Lat)
    };
  },

  /**
   * Generates HTML for 35 recent status blocks (ticks)
   */
  renderHistoryTicksHtml(historyArray, maxTicks = 35) {
    const total = maxTicks;
    const history = historyArray || [];
    const recent = history.slice(-total);
    const emptyCount = total - recent.length;

    let html = '<div class="history-ticks">';

    // Pad with empty ticks if less than total
    for (let i = 0; i < emptyCount; i++) {
      html += `<div class="tick tick-empty" title="No probe data"></div>`;
    }

    recent.forEach(h => {
      let statusClass = 'tick-up';
      if (h.status === 'DEGRADED') statusClass = 'tick-degraded';
      else if (h.status === 'DOWN') statusClass = 'tick-down';

      const timeStr = new Date(h.timestamp).toLocaleTimeString();
      const rawTooltip = `${timeStr} — ${h.status} (${h.response_time_ms ? h.response_time_ms + 'ms' : 'No response'}) ${h.error_message ? '- ' + h.error_message : ''}`;
      const safeTooltip = String(rawTooltip).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

      html += `<div class="tick ${statusClass}" title="${safeTooltip}"></div>`;
    });

    html += '</div>';
    return html;
  }
};

window.NOCCharts = NOCCharts;

