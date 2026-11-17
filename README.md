# NOC Real-Time Website & Landing Page Monitoring Dashboard

A high-density, real-time Network Operations Center (NOC) web application health and landing page monitoring dashboard built with Node.js, Express, WebSockets, SQLite, and vanilla modern web technologies.

![NOC Dashboard](public/favicon.svg)

---

## ⚡ Highlights & Key Capabilities

- **High-Density NOC Operations Deck**: Engineered for wallboards, command center screens, multi-monitor setups, and desktop operations.
- **Sub-Second Real-Time Telemetry**: Bi-directional WebSockets (`ws`) push live probe heartbeats, latency changes, and state transitions to all connected operators with zero polling delay.
- **Deep Network Phase Breakdown**: High-precision timing telemetry measuring:
  - DNS Lookup Time
  - TCP Connect Time
  - TLS Handshake Time (HTTPS)
  - Time To First Byte (TTFB)
  - Total Request & Download Duration
- **Automated SSL Certificate Health & Expiration Tracker**:
  - Live inspection of peer certificates (Issuer, Validity dates).
  - Countdown of days remaining until expiration.
  - Automatic **DEGRADED** alerts when certificates are within 14 days of expiry, and **CRITICAL** alerts on expired certificates.
- **Content & Keyword Assertion**:
  - Validates that landing pages and web apps not only return HTTP 200, but also contain expected text/strings (preventing silent defacements or soft-error pages).
- **Incident State Machine & Automated Alerting**:
  - Automatically records outages, downtime duration, root causes, and tracks Mean Time To Recovery (MTTR).
  - One-click NOC operator incident acknowledgment.
- **Integrated NOC Audio Synthesizer (Web Audio API)**:
  - Built-in sound effects without external audio files:
    - High-urgency dual-frequency siren on service outage.
    - Harmonic chord chime on service recovery.
    - Subtle acoustic feedback on manual pings.
    - Quick mute/unmute toggle persisted in localStorage.
- **3 Dynamic NOC Visualizations**:
  - **Cards Grid**: Dense cards with glowing status indicators, latency metrics, SSL countdown badges, 35-check history tick bars, and quick actions.
  - **Wallboard Matrix**: Ultra-compact grid showing dozens of systems simultaneously with immediate red/green/amber recognition.
  - **Dense Telemetry Table**: Full operational data columns with inline sparklines and last check times.
- **Zero-Dependency Frontend**: 100% vanilla HTML5, CSS3, and JavaScript — works completely offline and inside air-gapped private networks.
- **Persistent Embedded SQLite Engine**: Uses `better-sqlite3` configured with WAL (Write-Ahead Logging) for reliable local storage of configurations, heartbeats, SLAs, and incidents.

---

## 🚀 Quick Start

### 1. Requirements
- Node.js 18.0.0 or later (Node.js 24+ fully supported)

### 2. Run the Monitoring Server
```bash
npm start
```
Or for live code reload during development:
```bash
npm run dev
```

### 3. Open the Dashboard
Navigate to [http://localhost:3000](http://localhost:3000) in any modern browser.

---

## 🖥️ Architecture Overview

```
.
├── server/
│   ├── index.js          # Express HTTP + WebSocket server setup & routing
│   ├── db.js             # SQLite database management (better-sqlite3 in WAL mode)
│   ├── checker.js        # Precision probe engine (DNS, TCP, TLS, TTFB, SSL & Keyword)
│   ├── scheduler.js      # Target check scheduler & incident state machine
│   ├── api.js            # REST API endpoints & mock chaos routes
│   └── ws.js             # WebSocket real-time broadcast and client handlers
├── public/
│   ├── index.html        # High-density NOC command center layout
│   ├── favicon.svg       # Custom vector radar icon
│   ├── css/
│   │   └── noc.css       # Obsidian & neon emerald NOC theme, high-contrast styles
│   └── js/
│       ├── app.js        # Reactive client controller & Web Audio synthesizer
│       └── charts.js     # High-DPI canvas latency timeline & history ticks
└── package.json
```

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Self-health probe for the monitoring server itself |
| `GET` | `/api/summary` | Global NOC summary (health score, monitor counts, avg latency) |
| `GET` | `/api/monitors` | List all targets with latest heartbeat, 24h uptime, and sparkline |
| `POST` | `/api/monitors` | Create a new target endpoint |
| `GET` | `/api/monitors/:id` | Detailed telemetry inspection (history, SLAs, incidents) |
| `PUT` | `/api/monitors/:id` | Update target configuration |
| `DELETE` | `/api/monitors/:id` | Remove target endpoint |
| `POST` | `/api/monitors/:id/toggle` | Pause or resume monitoring for a target |
| `POST` | `/api/monitors/:id/check` | Trigger an immediate out-of-schedule check |
| `POST` | `/api/monitors/check-all` | Trigger immediate checks across all active targets |
| `GET` | `/api/incidents` | List active and recent incidents |
| `POST` | `/api/incidents/:id/acknowledge`| Acknowledge an active incident |

---

## ⚡ WebSocket Events

Connect to `ws://localhost:3000/ws`.

### Server -> Client:
- `initial_state`: Full snapshot of monitors and active incidents on initial connect.
- `check_result`: Broadcast immediately upon completion of any target probe.
- `incident_started`: Broadcast when a target transitions to `DOWN`.
- `incident_resolved`: Broadcast when a down target returns to `UP`.
- `incident_acknowledged`: Broadcast when an operator acknowledges an alert.
- `monitor_created` / `monitor_updated` / `monitor_deleted`: Sync changes across screens.

### Client -> Server:
- `{"type": "check_now", "monitorId": 1}`: Triggers an immediate probe.
- `{"type": "check_all"}`: Triggers immediate probes on all targets.
- `{"type": "ping"}`: Heartbeat check (responds with `pong`).

---

## 🛡️ License
MIT License. Built for high-reliability operations and 24/7 web availability.

