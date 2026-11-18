const nodemailer = require('nodemailer');
const { queries, db } = require('./db');

// Helper to load all notification settings
function getNotificationSettings() {
  const rows = queries.getAllSettings.all();
  const settings = {
    smtp_enabled: '0',
    smtp_host: 'smtp.office365.com',
    smtp_port: '587',
    smtp_secure: '0',
    smtp_user: '',
    smtp_pass: '',
    smtp_from_email: '',
    smtp_from_name: 'PAU NOC Radar Alerts',
    notify_outage_enabled: '1',
    notify_recovery_enabled: '1',
    notify_recipients: ''
  };

  for (const r of rows) {
    if (r.key in settings) {
      settings[r.key] = r.value;
    }
  }

  return settings;
}

// Create Nodemailer transport instance
function createTransporter(customCfg = null) {
  const cfg = customCfg || getNotificationSettings();

  if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass) {
    return null;
  }

  const port = Number(cfg.smtp_port) || 587;
  const isSecure = Boolean(Number(cfg.smtp_secure) === 1 || port === 465);

  return nodemailer.createTransport({
    host: cfg.smtp_host.trim(),
    port: port,
    secure: isSecure,
    auth: {
      user: cfg.smtp_user.trim(),
      pass: cfg.smtp_pass
    },
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: true
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'Under a minute';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs} seconds`;
  return `${mins}m ${secs}s`;
}

// Verify credentials and send test email
async function sendTestEmail(customSettings, targetEmail) {
  const cfg = customSettings || getNotificationSettings();
  const transporter = createTransporter(cfg);

  if (!transporter) {
    throw new Error('Incomplete SMTP configuration. Host, username, and password are required.');
  }

  const recipient = (targetEmail || cfg.notify_recipients || cfg.smtp_user || '').trim();
  if (!recipient) {
    throw new Error('Please specify a recipient email address to send the test email to.');
  }

  // First verify SMTP connection handshake
  await transporter.verify();

  const fromAddress = `"${cfg.smtp_from_name || 'PAU NOC Alerts'}" <${cfg.smtp_from_email || cfg.smtp_user}>`;
  const now = new Date().toUTCString();

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #060b17; color: #f8fafc; margin: 0; padding: 20px; }
        .card { max-width: 560px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; overflow: hidden; }
        .header { background: #1e1b4b; padding: 20px; border-bottom: 1px solid #312e81; }
        .title { color: #818cf8; font-size: 18px; font-weight: 700; margin: 0; }
        .body { padding: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1; }
        .table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        .table td { padding: 8px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
        .table td.label { color: #94a3b8; font-weight: 600; width: 40%; }
        .table td.val { color: #fff; font-family: monospace; }
        .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 12px; }
        .footer { padding: 15px 20px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h2 class="title">🧪 Microsoft 365 SMTP Relay Verification</h2>
        </div>
        <div class="body">
          <p>This is a test notification confirming that the <strong>NOC Website Monitoring System</strong> has successfully authenticated and established connection with your outgoing mail server.</p>
          <table class="table">
            <tr><td class="label">SMTP Gateway</td><td class="val">${cfg.smtp_host}:${cfg.smtp_port}</td></tr>
            <tr><td class="label">Authenticated User</td><td class="val">${cfg.smtp_user}</td></tr>
            <tr><td class="label">Security Type</td><td class="val">${cfg.smtp_port == 465 ? 'SSL/TLS' : 'STARTTLS (Port 587)'}</td></tr>
            <tr><td class="label">Connection Status</td><td><span class="badge">VERIFIED & ACTIVE</span></td></tr>
            <tr><td class="label">Dispatched At</td><td class="val">${now}</td></tr>
          </table>
        </div>
        <div class="footer">
          NOC RADAR // Pan-Atlantic University High-Density Monitor • Automated Dispatch
        </div>
      </div>
    </body>
    </html>
  `;

  const info = await transporter.sendMail({
    from: fromAddress,
    to: recipient,
    subject: `🧪 [NOC TEST] Microsoft 365 SMTP Relay Connection Verified`,
    text: `NOC Radar SMTP Test: Outgoing email relay (${cfg.smtp_host}) successfully authenticated at ${now}.`,
    html: html
  });

  return {
    success: true,
    messageId: info.messageId,
    recipient: recipient
  };
}

// Send service outage alert
async function sendOutageAlert(incident, monitor, heartbeat) {
  try {
    const cfg = getNotificationSettings();
    if (cfg.smtp_enabled !== '1' || cfg.notify_outage_enabled !== '1') {
      return; // Disabled
    }

    const recipients = (cfg.notify_recipients || '').split(',').map(e => e.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return;
    }

    const transporter = createTransporter(cfg);
    if (!transporter) return;

    const fromAddress = `"${cfg.smtp_from_name || 'PAU NOC Alerts'}" <${cfg.smtp_from_email || cfg.smtp_user}>`;
    const now = new Date().toUTCString();
    const errMsg = (heartbeat && heartbeat.error_message) || incident.cause || 'HTTP Request Failed';
    const statusCode = (heartbeat && heartbeat.status_code) ? heartbeat.status_code : 'N/A';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #060b17; color: #f8fafc; margin: 0; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #7f1d1d; border-radius: 8px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .header { background: #450a0a; padding: 20px; border-bottom: 2px solid #ef4444; }
          .title { color: #fca5a5; font-size: 18px; font-weight: 800; margin: 0; display: flex; align-items: center; gap: 8px; }
          .body { padding: 22px; font-size: 14px; line-height: 1.6; color: #cbd5e1; }
          .alert-box { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; padding: 12px 16px; margin: 15px 0; }
          .table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          .table td { padding: 10px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
          .table td.label { color: #94a3b8; font-weight: 600; width: 35%; }
          .table td.val { color: #fff; font-family: monospace; word-break: break-all; }
          .badge-down { display: inline-block; background: #991b1b; color: #fecaca; padding: 3px 8px; border-radius: 4px; font-weight: 800; font-size: 11px; }
          .footer { padding: 15px 20px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h2 class="title">🚨 CRITICAL SERVICE OUTAGE DETECTED</h2>
          </div>
          <div class="body">
            <p>The NOC Health Monitor has detected an active outage on the following target service:</p>
            <div class="alert-box">
              <strong style="color: #f87171; font-size: 15px;">${monitor.name} is DOWN</strong>
              <div style="font-size: 12px; color: #cbd5e1; margin-top: 4px;">Detected Error: <code>${errMsg}</code></div>
            </div>
            <table class="table">
              <tr><td class="label">Target Service</td><td class="val">${monitor.name}</td></tr>
              <tr><td class="label">Endpoint URL</td><td class="val"><a href="${monitor.url}" style="color: #38bdf8;">${monitor.url}</a></td></tr>
              <tr><td class="label">Group / Tier</td><td class="val">${monitor.group_tag || 'Production'}</td></tr>
              <tr><td class="label">HTTP Status</td><td class="val"><span class="badge-down">${statusCode}</span></td></tr>
              <tr><td class="label">Outage Started</td><td class="val">${now}</td></tr>
            </table>
          </div>
          <div class="footer">
            PAN-ATLANTIC UNIVERSITY // NOC RADAR TELEMETRY • IMMEDIATE ACTION REQUIRED
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: fromAddress,
      to: recipients.join(', '),
      subject: `🚨 [NOC OUTAGE] ${monitor.name} is DOWN (${statusCode})`,
      text: `CRITICAL ALERT: Target "${monitor.name}" (${monitor.url}) has failed checks at ${now}. Root cause: ${errMsg}.`,
      html: html
    });

    try {
      queries.insertAuditLog.run(
        null,
        'SYSTEM_NOTIFIER',
        'OUTAGE_EMAIL_DISPATCHED',
        monitor.id,
        `Sent outage alert for ${monitor.name} to ${recipients.join(', ')}`,
        '127.0.0.1'
      );
    } catch (e) {}

  } catch (err) {
    console.warn('[Notifier] Failed to send outage email:', err.message);
  }
}

// Send service recovery alert
async function sendRecoveryAlert(incident, monitor, heartbeat) {
  try {
    const cfg = getNotificationSettings();
    if (cfg.smtp_enabled !== '1' || cfg.notify_recovery_enabled !== '1') {
      return; // Disabled
    }

    const recipients = (cfg.notify_recipients || '').split(',').map(e => e.trim()).filter(Boolean);
    if (recipients.length === 0) return;

    const transporter = createTransporter(cfg);
    if (!transporter) return;

    const fromAddress = `"${cfg.smtp_from_name || 'PAU NOC Alerts'}" <${cfg.smtp_from_email || cfg.smtp_user}>`;
    const now = new Date().toUTCString();
    const durationText = incident.duration_seconds ? formatDuration(incident.duration_seconds) : 'Resolved';
    const latency = heartbeat && heartbeat.response_time_ms ? `${heartbeat.response_time_ms} ms` : 'Normal';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #060b17; color: #f8fafc; margin: 0; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #065f46; border-radius: 8px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .header { background: #064e3b; padding: 20px; border-bottom: 2px solid #10b981; }
          .title { color: #6ee7b7; font-size: 18px; font-weight: 800; margin: 0; }
          .body { padding: 22px; font-size: 14px; line-height: 1.6; color: #cbd5e1; }
          .alert-box { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 6px; padding: 12px 16px; margin: 15px 0; }
          .table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          .table td { padding: 10px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
          .table td.label { color: #94a3b8; font-weight: 600; width: 35%; }
          .table td.val { color: #fff; font-family: monospace; word-break: break-all; }
          .badge-up { display: inline-block; background: #047857; color: #d1fae5; padding: 3px 8px; border-radius: 4px; font-weight: 800; font-size: 11px; }
          .footer { padding: 15px 20px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h2 class="title">✅ SERVICE RECOVERED // ALL CLEAR</h2>
          </div>
          <div class="body">
            <p>The target service has successfully passed consecutive health checks and is back online.</p>
            <div class="alert-box">
              <strong style="color: #34d399; font-size: 15px;">${monitor.name} is back ONLINE</strong>
              <div style="font-size: 12px; color: #a7f3d0; margin-top: 4px;">Total Downtime Duration: <strong>${durationText}</strong></div>
            </div>
            <table class="table">
              <tr><td class="label">Target Service</td><td class="val">${monitor.name}</td></tr>
              <tr><td class="label">Endpoint URL</td><td class="val"><a href="${monitor.url}" style="color: #38bdf8;">${monitor.url}</a></td></tr>
              <tr><td class="label">Status</td><td class="val"><span class="badge-up">200 OK (ONLINE)</span></td></tr>
              <tr><td class="label">Current Latency</td><td class="val">${latency}</td></tr>
              <tr><td class="label">Recovery Time</td><td class="val">${now}</td></tr>
            </table>
          </div>
          <div class="footer">
            PAN-ATLANTIC UNIVERSITY // NOC RADAR TELEMETRY • SERVICE STABILIZED
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: fromAddress,
      to: recipients.join(', '),
      subject: `✅ [NOC RESOLVED] ${monitor.name} is back ONLINE (${durationText})`,
      text: `RECOVERY NOTICE: Target "${monitor.name}" (${monitor.url}) has recovered at ${now}. Outage duration was ${durationText}.`,
      html: html
    });

    try {
      queries.insertAuditLog.run(
        null,
        'SYSTEM_NOTIFIER',
        'RECOVERY_EMAIL_DISPATCHED',
        monitor.id,
        `Sent recovery alert for ${monitor.name} to ${recipients.join(', ')}`,
        '127.0.0.1'
      );
    } catch (e) {}

  } catch (err) {
    console.warn('[Notifier] Failed to send recovery email:', err.message);
  }
}

module.exports = {
  getNotificationSettings,
  createTransporter,
  sendTestEmail,
  sendOutageAlert,
  sendRecoveryAlert
};
