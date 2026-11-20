const nodemailer = require('nodemailer');
const { queries, db } = require('./db');

// In-memory token cache for Microsoft Graph API
let cachedGraphToken = null;
let graphTokenExpiresAt = 0;

// Helper to load all notification settings from SQLite
function getNotificationSettings() {
  const rows = queries.getAllSettings.all();
  const settings = {
    email_enabled: '0',
    delivery_method: 'app_registration', // 'app_registration' | 'smtp'
    // Microsoft 365 App Registration (Entra ID / Azure AD)
    ms_tenant_id: '',
    ms_client_id: '',
    ms_client_secret: '',
    ms_sender_email: '',
    ms_from_name: 'PAU NOC Radar Alerts',
    // Outage alert triggers
    notify_outage_enabled: '1',
    notify_recovery_enabled: '1',
    notify_recipients: '',
    // Classic SMTP fallback settings
    smtp_enabled: '0',
    smtp_host: 'smtp.office365.com',
    smtp_port: '587',
    smtp_secure: '0',
    smtp_user: '',
    smtp_pass: '',
    smtp_from_email: '',
    smtp_from_name: 'PAU NOC Radar Alerts'
  };

  for (const r of rows) {
    if (r.key in settings) {
      settings[r.key] = r.value;
    }
  }

  // Backward compatibility: if smtp_enabled was '1' and delivery_method wasn't set
  if (settings.email_enabled === '0' && settings.smtp_enabled === '1') {
    settings.email_enabled = '1';
  }

  return settings;
}

// Request OAuth2 Bearer token from Microsoft Entra ID (Azure AD) via Client Credentials
async function getMicrosoftGraphToken(tenantId, clientId, clientSecret) {
  const tId = (tenantId || '').trim();
  const cId = (clientId || '').trim();
  const secret = (clientSecret || '').trim();

  if (!tId || !cId || !secret) {
    throw new Error('Incomplete App Registration: Directory (Tenant) ID, Application (Client) ID, and Client Secret are required.');
  }

  // Check valid cache (with 2 min buffer)
  if (cachedGraphToken && Date.now() < graphTokenExpiresAt - 120000) {
    return cachedGraphToken;
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${encodeURIComponent(tId)}/oauth2/v2.0/token`;
  const formParams = new URLSearchParams();
  formParams.append('client_id', cId);
  formParams.append('client_secret', secret);
  formParams.append('scope', 'https://graph.microsoft.com/.default');
  formParams.append('grant_type', 'client_credentials');

  let res;
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams.toString()
    });
  } catch (netErr) {
    throw new Error(`Failed to connect to Microsoft identity endpoint (${tokenEndpoint}): ${netErr.message}`);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const code = data.error || 'AuthenticationFailed';
    const desc = data.error_description ? data.error_description.split('\r\n')[0] : 'Could not authenticate with Microsoft Entra ID';
    throw new Error(`Entra ID Auth Failed [${code}]: ${desc}`);
  }

  cachedGraphToken = data.access_token;
  graphTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return cachedGraphToken;
}

// Send email using Microsoft Graph API /v1.0/users/{sender}/sendMail
async function sendViaMicrosoftGraph(cfg, { recipients, subject, html, text }) {
  const token = await getMicrosoftGraphToken(cfg.ms_tenant_id, cfg.ms_client_id, cfg.ms_client_secret);
  const senderEmail = (cfg.ms_sender_email || cfg.smtp_from_email || cfg.smtp_user || '').trim();

  if (!senderEmail) {
    throw new Error('Sender Mailbox is required. Enter the Microsoft 365 mailbox address (e.g. alerts@pau.edu.ng) assigned in your tenant.');
  }

  const toRecipients = recipients.map(email => ({
    emailAddress: { address: email.trim() }
  }));

  const payload = {
    message: {
      subject: subject,
      body: {
        contentType: 'HTML',
        content: html
      },
      toRecipients: toRecipients
    },
    saveToSentItems: false
  };

  const graphEndpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`;

  let res;
  try {
    res = await fetch(graphEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (netErr) {
    throw new Error(`Failed to connect to Microsoft Graph API (${graphEndpoint}): ${netErr.message}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const errCode = errBody.error ? errBody.error.code : `HTTP_${res.status}`;
    const errMsg = errBody.error ? errBody.error.message : res.statusText;

    if (errCode === 'ErrorAccessDenied' || errCode === 'Authorization_RequestDenied') {
      throw new Error(`Microsoft Graph Access Denied: The App Registration lacks the "Mail.Send" Application permission, or Admin Consent has not been granted in Entra ID.`);
    }
    if (errCode === 'ResourceNotFound' || errCode === 'ErrorItemNotFound') {
      throw new Error(`Sender Mailbox Not Found: Mailbox "${senderEmail}" does not exist in Microsoft 365 tenant (${cfg.ms_tenant_id}).`);
    }

    throw new Error(`Microsoft Graph Error [${errCode}]: ${errMsg}`);
  }

  return {
    success: true,
    method: 'microsoft_graph',
    sender: senderEmail,
    recipients: recipients
  };
}

// Fallback: Create Nodemailer transport instance for classic SMTP
function createSmtpTransporter(customCfg = null) {
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

async function sendViaSmtp(cfg, { recipients, subject, html, text }) {
  const transporter = createSmtpTransporter(cfg);
  if (!transporter) {
    throw new Error('Incomplete SMTP configuration. Host, username, and password are required.');
  }

  const fromAddress = `"${cfg.smtp_from_name || 'PAU NOC Alerts'}" <${cfg.smtp_from_email || cfg.smtp_user}>`;
  const info = await transporter.sendMail({
    from: fromAddress,
    to: recipients.join(', '),
    subject: subject,
    text: text,
    html: html
  });

  return {
    success: true,
    method: 'smtp',
    messageId: info.messageId,
    recipients: recipients
  };
}

// Core unified email dispatcher
async function dispatchEmail(cfg, { recipients, subject, html, text }) {
  const method = cfg.delivery_method || (cfg.ms_client_id ? 'app_registration' : 'smtp');

  if (method === 'app_registration') {
    return await sendViaMicrosoftGraph(cfg, { recipients, subject, html, text });
  } else {
    return await sendViaSmtp(cfg, { recipients, subject, html, text });
  }
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'Under a minute';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs} seconds`;
  return `${mins}m ${secs}s`;
}

// Verify credentials and dispatch a test email
async function sendTestEmail(customSettings, targetEmail) {
  const cfg = customSettings || getNotificationSettings();
  const method = cfg.delivery_method || (cfg.ms_client_id ? 'app_registration' : 'smtp');

  const recipient = (targetEmail || cfg.notify_recipients || cfg.ms_sender_email || cfg.smtp_user || '').trim();
  if (!recipient) {
    throw new Error('Please specify a recipient email address to send the test verification email to.');
  }

  const now = new Date().toUTCString();
  const isGraph = method === 'app_registration';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #060b17; color: #f8fafc; margin: 0; padding: 20px; }
        .card { max-width: 580px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .header { background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); padding: 22px; border-bottom: 2px solid #6366f1; }
        .title { color: #818cf8; font-size: 18px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 8px; }
        .badge-type { display: inline-block; background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.4); font-size: 11px; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-weight: 600; margin-top: 6px; }
        .body { padding: 22px; font-size: 14px; line-height: 1.6; color: #cbd5e1; }
        .table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        .table td { padding: 9px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
        .table td.label { color: #94a3b8; font-weight: 600; width: 38%; }
        .table td.val { color: #fff; font-family: monospace; word-break: break-all; }
        .badge-ok { display: inline-block; background: #064e3b; color: #34d399; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 12px; }
        .footer { padding: 15px 20px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h2 class="title">🧪 Microsoft 365 Dispatch Verification</h2>
          <span class="badge-type">${isGraph ? 'MICROSOFT ENTRA ID • APP REGISTRATION (GRAPH API)' : 'SMTP RELAY HANDSHAKE'}</span>
        </div>
        <div class="body">
          <p>This automated test confirms that the <strong>NOC Website Monitoring System</strong> has successfully authenticated and established connection with Microsoft 365.</p>
          <table class="table">
            <tr><td class="label">Dispatch Provider</td><td class="val">${isGraph ? 'Microsoft Graph API (OAuth 2.0)' : 'SMTP Relay Gateway'}</td></tr>
            ${isGraph ? `
              <tr><td class="label">Directory (Tenant) ID</td><td class="val">${cfg.ms_tenant_id}</td></tr>
              <tr><td class="label">Application (Client) ID</td><td class="val">${cfg.ms_client_id}</td></tr>
              <tr><td class="label">Sender Mailbox</td><td class="val">${cfg.ms_sender_email}</td></tr>
            ` : `
              <tr><td class="label">SMTP Gateway</td><td class="val">${cfg.smtp_host}:${cfg.smtp_port}</td></tr>
              <tr><td class="label">Authenticated User</td><td class="val">${cfg.smtp_user}</td></tr>
            `}
            <tr><td class="label">Connection Status</td><td><span class="badge-ok">AUTHENTICATED & VERIFIED</span></td></tr>
            <tr><td class="label">Dispatched At</td><td class="val">${now}</td></tr>
          </table>
        </div>
        <div class="footer">
          NOC RADAR // Pan-Atlantic University High-Density Monitor • Automated Diagnostic Dispatch
        </div>
      </div>
    </body>
    </html>
  `;

  await dispatchEmail(cfg, {
    recipients: [recipient],
    subject: `🧪 [NOC TEST] Microsoft 365 App Registration Connection Verified`,
    text: `NOC Radar Test: Microsoft 365 (${isGraph ? 'App Registration Graph API' : 'SMTP'}) successfully authenticated at ${now}.`,
    html: html
  });

  return {
    success: true,
    recipient: recipient,
    method: isGraph ? 'Microsoft Graph (App Registration)' : 'SMTP Relay'
  };
}

// Send service outage alert
async function sendOutageAlert(incident, monitor, heartbeat) {
  try {
    const cfg = getNotificationSettings();
    const isEnabled = cfg.email_enabled === '1' || cfg.smtp_enabled === '1';
    if (!isEnabled || cfg.notify_outage_enabled !== '1') {
      return; // Disabled
    }

    const recipients = (cfg.notify_recipients || '').split(',').map(e => e.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return;
    }

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

    await dispatchEmail(cfg, {
      recipients: recipients,
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
    const isEnabled = cfg.email_enabled === '1' || cfg.smtp_enabled === '1';
    if (!isEnabled || cfg.notify_recovery_enabled !== '1') {
      return; // Disabled
    }

    const recipients = (cfg.notify_recipients || '').split(',').map(e => e.trim()).filter(Boolean);
    if (recipients.length === 0) return;

    const now = new Date().toUTCString();
    const durationText = incident.started_at ? formatDuration(Math.round((Date.now() - new Date(incident.started_at).getTime()) / 1000)) : 'Recent outage';
    const responseTime = (heartbeat && heartbeat.response_time_ms) ? `${Math.round(heartbeat.response_time_ms)}ms` : 'Healthy';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #060b17; color: #f8fafc; margin: 0; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #14532d; border-radius: 8px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .header { background: #052e16; padding: 20px; border-bottom: 2px solid #22c55e; }
          .title { color: #86efac; font-size: 18px; font-weight: 800; margin: 0; display: flex; align-items: center; gap: 8px; }
          .body { padding: 22px; font-size: 14px; line-height: 1.6; color: #cbd5e1; }
          .alert-box { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.4); border-radius: 6px; padding: 12px 16px; margin: 15px 0; }
          .table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          .table td { padding: 10px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
          .table td.label { color: #94a3b8; font-weight: 600; width: 35%; }
          .table td.val { color: #fff; font-family: monospace; word-break: break-all; }
          .badge-up { display: inline-block; background: #15803d; color: #dcfce7; padding: 3px 8px; border-radius: 4px; font-weight: 800; font-size: 11px; }
          .footer { padding: 15px 20px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h2 class="title">✅ SERVICE INCIDENT RESOLVED</h2>
          </div>
          <div class="body">
            <p>The NOC Health Monitor reports that the service outage has resolved and the target is fully operational:</p>
            <div class="alert-box">
              <strong style="color: #4ade80; font-size: 15px;">${monitor.name} is back ONLINE</strong>
              <div style="font-size: 12px; color: #cbd5e1; margin-top: 4px;">Total Outage Duration: <strong>${durationText}</strong></div>
            </div>
            <table class="table">
              <tr><td class="label">Target Service</td><td class="val">${monitor.name}</td></tr>
              <tr><td class="label">Endpoint URL</td><td class="val"><a href="${monitor.url}" style="color: #38bdf8;">${monitor.url}</a></td></tr>
              <tr><td class="label">Current Status</td><td class="val"><span class="badge-up">200 OK • UP</span></td></tr>
              <tr><td class="label">Latency</td><td class="val">${responseTime}</td></tr>
              <tr><td class="label">Resolved At</td><td class="val">${now}</td></tr>
            </table>
          </div>
          <div class="footer">
            PAN-ATLANTIC UNIVERSITY // NOC RADAR TELEMETRY • ALL CLEAR
          </div>
        </div>
      </body>
      </html>
    `;

    await dispatchEmail(cfg, {
      recipients: recipients,
      subject: `✅ [NOC RESOLVED] ${monitor.name} is back ONLINE (${durationText})`,
      text: `RESOLUTION NOTICE: Target "${monitor.name}" (${monitor.url}) has recovered and is operational as of ${now}. Total downtime: ${durationText}.`,
      html: html
    });

    try {
      queries.insertAuditLog.run(
        null,
        'SYSTEM_NOTIFIER',
        'RECOVERY_EMAIL_DISPATCHED',
        monitor.id,
        `Sent recovery notification for ${monitor.name} to ${recipients.join(', ')}`,
        '127.0.0.1'
      );
    } catch (e) {}

  } catch (err) {
    console.warn('[Notifier] Failed to send recovery email:', err.message);
  }
}

module.exports = {
  getNotificationSettings,
  sendTestEmail,
  sendOutageAlert,
  sendRecoveryAlert
};
