# OCPP CP Admin

**Charge Point Management System (CSMS)** for Charge Point Operators (CPO), supporting the **OCPP 1.6-J** and **OCPP 2.0.1** protocols.

OCPP CP Admin enables monitoring and managing electric vehicle charging infrastructure: charge point management, user management, charge transactions, real-time alerts, and an analytics dashboard.

> **🇫🇷 [Version française](README.fr.md)**

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Node.js](#nodejs-installation)
  - [Docker / Docker Compose](#docker-installation)
  - [Bare-metal (systemd)](#bare-metal-deployment-systemd)
- [Environment Variables](#environment-variables)
- [Configuration](#configuration)
  - [General](#general)
  - [Web Interface (WebUI)](#web-interface-webui)
  - [OCPP Server](#ocpp-server)
  - [Notifications](#notifications)
  - [Google OAuth Authentication](#google-oauth-authentication)
  - [Legal Pages](#legal-pages)
- [TLS Certificates](#tls-certificates)
  - [HTTPS — Web Interface](#https--web-interface)
  - [WSS — OCPP Server](#wss--ocpp-server-security-profile-2--3)
- [Getting Started](#getting-started)
- [Energy Tariffs](#energy-tariffs)
- [Business / Personal Badges and Reimbursement Exports](#business--personal-badges-and-reimbursement-exports)
- [Roles and Permissions](#roles-and-permissions)
- [OCPP Protocol (1.6 and 2.0.1)](#ocpp-protocol-16-and-201)
  - [Supported Operations — OCPP 1.6](#supported-operations--ocpp-16)
  - [Supported Operations — OCPP 2.0.1](#supported-operations--ocpp-201)
  - [Initialization Sequence](#initialization-sequence)
  - [Transaction Handling](#transaction-handling)
  - [Remote Starts](#remote-starts)
  - [Charge Point Connection](#charge-point-connection)
  - [Security Profiles](#security-profiles)
  - [Heartbeat & Connection Monitoring](#heartbeat--connection-monitoring)
- [Notification System](#notification-system)
- [Logging](#logging)
- [Internationalization](#internationalization)
- [Development Scripts](#development-scripts)
- [Database](#database)
  - [Backup](#backup)

---

## Features

### Charge Point Management
- Manual registration or automatic discovery of charge points
- Approval of pending charge points
- Assignment of charge points to sites
- OCPP 1.6 and OCPP 2.0.1 charge points side by side (multi-EVSE stations supported in 2.0.1)
- Real-time monitoring (connector status, heartbeat, errors)
- Remote charge point configuration (GetConfiguration / ChangeConfiguration in 1.6, GetBaseReport / SetVariables in 2.0.1) and a default configuration applied automatically on first connection
- OCPP message history (CALL / CALLRESULT / CALLERROR)

### Site and User Management
- Multi-site architecture
- Hierarchical roles: Admin, Manager, User
- Per-site and per-user authorization
- Local authentication (email / password) or Google OAuth 2.0
- Password reset via email with secure token

### Transactions and Charge Monitoring
- Active and completed transaction tracking
- Real-time data: energy (Wh), power (W), current (A per phase), state of charge (SOC %), temperature (°C), voltage (V per phase), frequency (Hz)
- Transaction history with filters; sessions refused at start (badge not authorized) are kept with the *Rejected* status, never billed — see [Transaction handling](#transaction-handling)
- Sessions closed by the server (lost end message, restart…) corrected by the charge point's real stop when it arrives later
- CSV export of transactions (including cost columns when a tariff is configured); cells that could be read as a spreadsheet formula (`=`, `+`, `-`, `@`…) are prefixed with an apostrophe
- Per-site energy tariffs (time slots and weekdays) with the cost of each session frozen at closing — see [Energy Tariffs](#energy-tariffs)
- Personal dashboard for users

### Error Event History
- Persistent log of hardware/network errors: `StatusNotification` faults, disconnections (after grace period), heartbeat timeouts
- Global view filterable by charge point, event type, OCPP version, and date range
- Accessible to managers and admins
- Real-time updates via WebSocket

### RFID Badge Management
- Badge creation and management (ID Tags), with a **business / personal** category — see [Business / Personal Badges and Reimbursement Exports](#business--personal-badges-and-reimbursement-exports)
- Automatic generation of badges for remote starts (`ADMIN`, `MGR-<site>`, `WEB-<user>`), refused when presented as an RFID card — see [Remote starts](#remote-starts)
- Expiration and authorization rejection tracking

### Charging Profiles
- Create and apply charging profiles on charge points via `SetChargingProfile`
- Supported purposes: `ChargePointMaxProfile` (global station power cap) and `TxDefaultProfile` (default transaction profile)
- Periodic (weekly) or relative scheduling with configurable power per time slot
- Absolute and recurring profiles are anchored by a "schedule start" (`startSchedule`, optional): when left empty, absolute profiles start at their validity start (or now) and recurring ones at today's midnight UTC; period offsets are seconds from that anchor. Maximum-limit profiles apply to the whole station (connector 0)
- Targeted or full profile clearing via `ClearChargingProfile`
- Automatic re-application of managed profiles on charge point reconnection

### Connector Reservations
- Reserve a connector (1.6) or an EVSE (2.0.1) for a given RFID badge via `ReserveNow`
- On-demand cancellation via `CancelReservation`
- Automatic expiration: from `StatusNotification` / `ReservationStatusUpdate` (2.0.1), and a server-side watchdog that releases reservations past their expiry date

### Multi-Channel Notifications
- **Email** (SMTP via Nodemailer)
- **Web Push** (browser notifications via Service Worker)
- **Pushover** (mobile push notifications)
- 22 event types with role-based filtering
- Per-user and per-channel preferences

### Dashboard and Analytics
- Real-time statistics: connected charge points, active transactions, connector states
- Charging KPIs: energy, duration, frequency
- Historical charts (configurable date range)

### Security and Monitoring
- Connection loop detection (flapping)
- Duplicate identity detection (same identifier from multiple IPs)
- Rate limiting on APIs and authentication
- HTTP security headers (Helmet)
- Structured logging with file rotation
- Automatic per-charge-point mTLS client certificate generation (built-in local CA)
- Optional OCPP security profile enforcement, per version (1.6 / 2.0.1) — WS/WSS+Auth, WSS+mTLS

### Progressive Web Application (PWA)
- Installable on desktop and mobile (Web App Manifest)
- Responsive interface (mobile-first)
- Light/dark theme
- Push notifications via Service Worker
- `/healthz` endpoint for monitoring
- `/metrics` endpoint in Prometheus text format (optional bearer token protection)

### System Administration
- System information: app version, uptime, Node.js memory usage, SQLite database size, connected charge points, per-table record counts
- Downloadable backup archive (ZIP): SQLite database (WAL-safe, no service interruption) + critical certificates (local client CA, per-charge-point certificates, manual mTLS CA)
- Historical data cleanup with a date filter: meter values (transaction curves, transactions themselves are kept), OCPP messages, ID tag events, error events, notification log, expired reservations — plus a database VACUUM
- Raw OCPP console: send any command with arbitrary JSON parameters to a connected charge point, with an in-session history
- Comparison of OCPP parameters between charge points of the same OCPP version, with discrepancies highlighted and forced (override) values flagged
- Restricted to administrators only

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser / Mobile                    │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP/HTTPS
┌──────────────────▼──────────────────────────────────────┐
│         Express Web Server (Port 3000/3001)             │
│  ┌────────────────────────────────────────────────────┐ │
│  │ REST API                                           │ │
│  │ Auth, Sites, Users, Charge Points, Transactions    │ │
│  │ Notifications, Dashboard                           │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
┌───▼─────┐  ┌─────▼────┐  ┌──────▼──────┐
│ SQLite  │  │ Sessions │  │ Real-time   │
│  (DB)   │  │ (SQLite) │  │ broadcast   │
└─────────┘  └──────────┘  └─────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│         OCPP Server (WS Port 9000 / WSS Port 9001)      │
│  ┌────────────────────────────────────────────────────┐ │
│  │ OCPP 1.6 / 2.0.1 RPC                               │ │
│  │ Authentication (password + client certificate)     │ │
│  │ Handlers: Boot, Authorize, Transactions ...        │ │
│  │ Remote commands: RemoteStart, ChangeConfig ...     │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket OCPP 1.6 / 2.0.1
          ┌────────▼────────┐
          │   EVSE Stations │
          └─────────────────┘
```

### Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 |
| Web framework | Express 5 |
| Database | SQLite 3 (better-sqlite3, WAL mode) |
| OCPP protocol | ocpp-rpc (OCPP 1.6-J and OCPP 2.0.1) |
| Authentication | Passport.js (local + Google OAuth 2.0) |
| Password hashing | bcryptjs |
| HTTP security | Helmet, express-rate-limit |
| Email | Nodemailer |
| Web Push | web-push |
| Logging | Winston + daily rotation |
| i18n | i18next |
| Linting | ESLint + Prettier |

---

## Prerequisites

- **Node.js** >= 22
- **npm** >= 10
- Or **Docker** / **Docker Compose**

---

## Installation

### Node.js Installation

```bash
# Clone the repository
git clone <repository-url>
cd ocpp-cp-admin

# Install dependencies
npm install

# Copy the sample configuration
cp config/config.sample.json config/config.json
```

Edit `config/config.json` according to your needs (see the [Configuration](#configuration) section).

### Docker Installation

The image is available on **GitHub Container Registry** and **Docker Hub**:

```bash
docker pull ghcr.io/wocha-fr/ocpp-cp-admin:latest
# or
docker pull wocha/ocpp-cp-admin:latest
```

Or build the image locally:

```bash
docker build -t ghcr.io/wocha-fr/ocpp-cp-admin .
```

Six Docker Compose files are available in the `docker/` folder, suited for different deployment scenarios:

| File | Description |
|---|---|
| `docker-compose.http.yml` | App only — HTTP + WS (ports 3000/9000) |
| `docker-compose.https.yml` | App only — HTTPS + WSS (ports 3001/9000/9001, certbot included) |
| `docker-compose.yml` | Full stack: Traefik (HTTPS, TLS termination) + App + FTP |
| `docker-compose.tls.yml` | Full stack: Traefik (HTTPS + WSS passthrough) + cert export + App + FTP |
| `docker-compose.traefik-ext.yml` | Same as `docker-compose.yml` with an existing (external) Traefik |
| `docker-compose.tls-ext.yml` | Same as `docker-compose.tls.yml` with an existing (external) Traefik |

```bash
# Example: full stack with Traefik
docker compose -f docker/docker-compose.yml up -d

# Example: app only HTTP
docker compose -f docker/docker-compose.http.yml up -d
```

Traefik-based stacks include:
- **Reverse proxy** with host-based routing (`cpadmin.local`, `ws.cpadmin.local`)
- **FTP server** for charge point diagnostics retrieval
- **Let's Encrypt support** (TLS variant)
- **TCP passthrough** for OCPP WSS with client certificate authentication (TLS variant)

See [`docker/README.md`](docker/README.md) for details on each compose file.

**Exposed Ports:**

| Port | Usage |
|------|-------|
| 3000 | Web Interface (HTTP) |
| 3001 | Web Interface (HTTPS, if enabled) |
| 9000 | OCPP Server (WebSocket) |
| 9001 | OCPP Server (WebSocket Secure, if enabled) |

**Volumes:**

| Volume | Contents |
|--------|---------|
| `/app/config` | Configuration, database, and certificates (`certs/`) |
| `/app/logs` | Log files |
| `/app/public/img` | Static images |
| `/app/locales-custom` | Custom locale files (add or override translations) |

The `/healthz` endpoint is used for Docker health checks (HTTP GET, every 30s).

The `/metrics` endpoint exposes Prometheus-format metrics (chargepoints, transactions, connectors by status, uptime, heap). It is accessible without authentication by default; set `metrics.bearerToken` (or `CPADMIN_METRICS_TOKEN`) to require a bearer token.

On first startup, if `config/config.json` does not exist, it is automatically created from `config.sample.json`.

The entrypoint runs as root to seed default files and fix volume permissions, then drops privileges to a dedicated non-root user (`app`) via `su-exec`.

### Bare-metal Deployment (systemd)

For servers running without Docker, a ready-to-use systemd unit is provided in `scripts/`.

**1. Create a dedicated user and deploy the application:**

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ocpp-cp-admin
sudo mkdir -p /opt/ocpp-cp-admin
sudo cp -r . /opt/ocpp-cp-admin
sudo chown -R ocpp-cp-admin:ocpp-cp-admin /opt/ocpp-cp-admin
cd /opt/ocpp-cp-admin && sudo -u ocpp-cp-admin npm ci --omit=dev
```

**2. Configure environment variables:**

```bash
# Copy the template and fill in your values
sudo mkdir -p /etc/ocpp-cp-admin
sudo cp scripts/env.example /etc/ocpp-cp-admin/env
sudo nano /etc/ocpp-cp-admin/env
sudo chmod 600 /etc/ocpp-cp-admin/env

# Then uncomment the EnvironmentFile= line in the unit file:
# EnvironmentFile=/etc/ocpp-cp-admin/env
```

See [`scripts/env.example`](scripts/env.example) for all available variables.

**3. Install and start the service:**

```bash
sudo cp scripts/ocpp-cp-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ocpp-cp-admin

# View logs
journalctl -u ocpp-cp-admin -f
```


---

## Environment Variables

Values from `config.json` can be overridden by environment variables. The JSON file remains the base configuration; environment variables take precedence when set.

### Deployment / URLs

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_PUBLIC_URL` | `webui.publicUrl` | `https://cpadmin.example.com` |
| `CPADMIN_HTTP_HOST` | `webui.httpHost` | `0.0.0.0` |
| `CPADMIN_TRUST_PROXY` | `webui.trustProxy` | `true` (required behind a reverse proxy) |
| `CPADMIN_OCPP_WS_URL` | `ocpp.ocppWsUrl` | `ws://ws.example.com` |
| `CPADMIN_OCPP_WSS_URL` | `ocpp.wss.ocppWsUrl` | `wss://ws.example.com:9001` |
| `CPADMIN_OCPP_WSS_ROOT_CA_FILE` | `ocpp.wss.rootCaFile` | `certs/isrg-root-x1.pem` (see [Root CA — WSS server certificate troubleshooting](#root-ca--wss-server-certificate-troubleshooting)) |
| `CPADMIN_DIAGNOSTICS_URL` | `ocpp.diagnosticsLocation` | `ftp://ftp.example.com` |
| `CPADMIN_SESSION_SECRET` | `webui.sessionSecret` | |

### General Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_LOGLEVEL` | `loglevel` | `debug`, `info`, `error` |
| `LOG_CONSOLE` | *(no JSON equivalent)* | `true` — force console log output (useful for temporary debugging in production) |
| `CPADMIN_LANGUAGE` | `language` | Any locale code from `locales/` folder (e.g. `fr`, `en`) |
| `CPADMIN_CPO_NAME` | `cpoName` | `My CPO` |

### Feature Activation

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_WEBUI_HTTPS_ENABLED` | `webui.https.enabled` | `true` (enable native HTTPS on the web interface) |
| `CPADMIN_OCPP_WSS_ENABLED` | `ocpp.wss.enabled` | `true` (enable native WSS on the OCPP server) |

### OCPP Behavior

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_OCPP_STRICT_MODE` | `ocpp.strictMode` | `false` (disable strict validation of OCPP messages against the JSON schemas) |
| `CPADMIN_OCPP_CALL_TIMEOUT` | `ocpp.callTimeoutSeconds` | `45` |
| `CPADMIN_OCPP_AUTO_ADD` | `ocpp.autoAddUnknownChargepoints` | `false` (`true` auto-registers unknown charge points — avoid on an Internet-facing server) |
| `CPADMIN_OCPP_PENDING_UNKNOWN` | `ocpp.pendingUnknownChargepoints` | `true` (queue unknown charge points for approval) |
| `CPADMIN_OCPP_V16_ENABLED` | `ocpp.v16.enabled` | `false` (disable OCPP 1.6 support) |
| `CPADMIN_OCPP_V16_ENFORCE_SECURITY_PROFILE` | `ocpp.v16.enforceSecurityProfile` | `true` (see [OCPP security profile enforcement](#ocpp-security-profile-enforcement)) |
| `CPADMIN_OCPP_V201_ENABLED` | `ocpp.v201.enabled` | `true` (enable OCPP 2.0.1 support) |
| `CPADMIN_OCPP_V201_ENFORCE_SECURITY_PROFILE` | `ocpp.v201.enforceSecurityProfile` | `true` (see [OCPP security profile enforcement](#ocpp-security-profile-enforcement)) |
| `CPADMIN_OCPP_TRUST_PROXY_PROTO` | `ocpp.trustProxyProto` | `true` (behind a Traefik-like reverse proxy) |

### Mail Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_MAIL_ENABLED` | `notifs.mail.enabled` | `true` |
| `CPADMIN_MAIL_FROM` | `notifs.mail.from` | `CPADMIN <noreply@example.com>` |
| `CPADMIN_MAIL_HOST` | `notifs.mail.transport.host` | |
| `CPADMIN_MAIL_PORT` | `notifs.mail.transport.port` | |
| `CPADMIN_MAIL_USER` | `notifs.mail.transport.auth.user` | |
| `CPADMIN_MAIL_PASS` | `notifs.mail.transport.auth.pass` | |
| `CPADMIN_MAIL_SECURE` | `notifs.mail.transport.secure` | `true` (SSL/TLS from start) |

### WebPush Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_WEBPUSH_ENABLED` | `notifs.webpush.enabled` | `true` |
| `CPADMIN_VAPID_PUBLIC_KEY` | `notifs.webpush.vapidPublicKey` | |
| `CPADMIN_VAPID_PRIVATE_KEY` | `notifs.webpush.vapidPrivateKey` | |
| `CPADMIN_VAPID_SUBJECT` | `notifs.webpush.vapidSubject` | `mailto:admin@example.com` |

### Pushover Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_PUSHOVER_ENABLED` | `notifs.pushover.enabled` | `true` |

### Notification Defaults

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_NOTIF_DISABLED_EVENTS` | `notifs.defaultDisabledEvents` | `connector_available,connector_unavailable` |
| `CPADMIN_NOTIF_RECONNECT_GRACE_PERIOD` | `notifs.reconnectGracePeriodSeconds` | `60` (seconds before an offline notification) |
| `CPADMIN_NOTIF_AVAILABILITY_DEBOUNCE` | `notifs.availabilityDebounceSeconds` | `5` (seconds before an available / unavailable notification) |

### Google Auth Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_GOOGLE_AUTH_ENABLED` | `auth.google.enabled` | `true` |
| `CPADMIN_GOOGLE_CLIENT_ID` | `auth.google.client_id` | |
| `CPADMIN_GOOGLE_CLIENT_SECRET` | `auth.google.client_secret` | |

### Prometheus Metrics

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_METRICS_TOKEN` | `metrics.bearerToken` | `my-secret-token` |

> If not set, `/metrics` is accessible without authentication (suitable for private/Docker networks).

> Booleans (`true`/`false`) and numbers are automatically converted.
> Secrets are always treated as strings.

---

## Configuration

The configuration file is `config/config.json`. In development mode (`NODE_ENV=development`), `config/config.dev.json` is used if it exists.

Configuration values can be overridden by environment variables (see the [Environment Variables](#environment-variables) section).

### Configuration Editor (UI)

Administrators can edit the configuration directly from the web interface via **Settings → Configuration**. The editor displays all parameters organized by section in a table with three columns:

- **File value** — the value currently stored in `config.json`
- **Env. variable** — the associated environment variable name and its current value (or *not set* if undefined)
- **New value** — editable field pre-filled with the effective value (env override takes precedence over the file value)

Required fields are validated before saving. The application restarts automatically after a successful save.

> Environment variables are informational only — they cannot be modified from the UI. The editor writes only to `config.json`.

### General

| Parameter | Type | Default | Description |
|---|---|---|---|
| `loglevel` | string | `"error"` | Log level: `error`, `warn`, `info`, `debug`, `trace` (`trace` adds the full PEM of client certificates, very verbose) |
| `language` | string | `"fr"` | Default application language (any locale code from `locales/` folder, e.g. `fr`, `en`) |
| `dbname` | string | `"cpadmin.db"` | SQLite database file name |
| `cpoName` | string | `"CP Admin"` | Organization name (displayed in the interface) |

### Web Interface (WebUI)

```json
"webui": {
  "httpHost": "localhost",
  "httpPort": 3000,
  "trustProxy": false,
  "publicUrl": "http://localhost:3000",
  "sessionSecret": "",
  "https": {
    "enabled": false,
    "httpsPort": 3001,
    "certFile": "certs/server.crt",
    "keyFile": "certs/server.key"
  }
}
```

| Parameter | Description |
|---|---|
| `httpHost` | HTTP listen address (`0.0.0.0` to listen on all interfaces) |
| `httpPort` | HTTP port |
| `trustProxy` | Enable if behind a reverse proxy (`true` or number of proxies) |
| `publicUrl` | Public URL of the application (used in emails, Google OAuth callback) |
| `sessionSecret` | Secret key for sessions (auto-generated if empty on each startup) |
| `https.enabled` | Enable HTTPS server |
| `https.httpsPort` | HTTPS port |
| `https.certFile` / `keyFile` | Paths to TLS certificate and key files (relative to the `config/` folder) |

### OCPP Server

```json
"ocpp": {
  "host": "0.0.0.0",
  "wsPort": 9000,
  "strictMode": true,
  "callTimeoutSeconds": 45,
  "autoAddUnknownChargepoints": false,
  "pendingUnknownChargepoints": true,
  "trustProxyProto": false,
  "ocppWsUrl": "ws://ws.cpadmin.local:9000",
  "diagnosticsLocation": "ftp://example.com/diagnostics",
  "v16":  { "enabled": true, "enforceSecurityProfile": false },
  "v201": { "enabled": false, "enforceSecurityProfile": false },
  "wss": {
    "enabled": false,
    "wssPort": 9001,
    "strictClientCert": false,
    "ocppWsUrl": "wss://ws.cpadmin.local:9001",
    "rsa": { "certFile": "...", "keyFile": "..." },
    "ecdsa": { "certFile": "...", "keyFile": "..." },
    "caFile": "",
    "rootCaFile": "",
    "clientCa": {
      "certFile": "certs/clients/ca.crt",
      "keyFile": "certs/clients/ca.key",
      "certValidityDays": 1825
    }
  }
}
```

| Parameter | Description |
|---|---|
| `host` | OCPP server listen address |
| `wsPort` | WebSocket (WS) port |
| `strictMode` | OCPP strict mode (message validation) |
| `callTimeoutSeconds` | Timeout in seconds waiting for a response to an OCPP call |
| `autoAddUnknownChargepoints` | Automatically add unknown charge points that connect |
| `pendingUnknownChargepoints` | Put unknown charge points pending admin approval |
| `trustProxyProto` | Trust the `X-Forwarded-Proto` header (`https` / `wss`) to recognize a WSS connection terminated upstream by a reverse proxy (e.g. Traefik) that then forwards to the app as plain WS: the charge point is shown as connected over WSS and the logs say so. No effect on authentication. Enable only behind such a proxy — see [OCPP security profile enforcement](#ocpp-security-profile-enforcement) |
| `ocppWsUrl` | OCPP WebSocket URL to communicate (for charge point configuration) |
| `diagnosticsLocation` | Destination URL for diagnostics upload |
| `v16.enabled` | Enable OCPP 1.6 support (default: `true`) — set to `false` to disable; a warning is logged and all connections are rejected if both versions are disabled |
| `v16.enforceSecurityProfile` | Reject OCPP 1.6 connections that meet none of the 3 security profiles recognized by the spec (default: `false`) — see [OCPP security profile enforcement](#ocpp-security-profile-enforcement) |
| `v201.enabled` | Enable OCPP 2.0.1 support (default: `false`) — see [Supported Operations — OCPP 2.0.1](#supported-operations--ocpp-201) |
| `v201.enforceSecurityProfile` | Reject OCPP 2.0.1 connections that meet none of the 3 security profiles recognized by the spec (default: `false`) — see [OCPP security profile enforcement](#ocpp-security-profile-enforcement) |
| `wss.enabled` | Enable WebSocket Secure (TLS) |
| `wss.strictClientCert` | Require a valid client certificate |
| `wss.rsa` / `ecdsa` | Server certificates for WSS (dual algorithm supported, paths relative to `config/` folder) |
| `wss.caFile` | Certificate authority for client certificate validation (path relative to `config/` folder) — unrelated to `rootCaFile` below, used only for incoming client certificates (mTLS, Security Profile 3) |
| `wss.rootCaFile` | Root certificate to troubleshoot charge point connection failures — see [Root CA — WSS server certificate troubleshooting](#root-ca--wss-server-certificate-troubleshooting) |
| `wss.clientCa` | Local CA used to automatically issue a per-charge-point client certificate (`certFile`/`keyFile`, auto-initialized on first generated certificate) and default validity period for issued certificates (`certValidityDays`) — see [Automatic client certificate generation](#automatic-client-certificate-generation) |

### Notifications

```json
"notifs": {
  "authRejectThreshold": 3,
  "authRejectWindowMinutes": 5,
  "flapThreshold": 4,
  "flapWindowMinutes": 2,
  "refusedCooldownMinutes": 60,
  "reconnectGracePeriodSeconds": 60,
  "availabilityDebounceSeconds": 5,
  "mail": {
    "enabled": false,
    "from": "CPADMIN <noreply@cpadmin.local>",
    "transport": {
      "host": "smtp.example.com",
      "port": 587,
      "secure": false,
      "auth": { "user": "...", "pass": "..." }
    }
  },
  "webpush": {
    "enabled": false,
    "vapidSubject": "mailto:admin@example.com",
    "vapidPublicKey": "",
    "vapidPrivateKey": ""
  },
  "pushover": {
    "enabled": false
  }
}
```

| Parameter | Description |
|---|---|
| `authRejectThreshold` | Number of RFID authorization rejections before notification |
| `authRejectWindowMinutes` | Time window for RFID rejection counting (minutes) |
| `flapThreshold` | Number of rapid reconnections before flapping alert |
| `flapWindowMinutes` | Time window for flapping detection (minutes) |
| `refusedCooldownMinutes` | Cooldown between two `chargepoint_refused` notifications for the same identity (default: 60 min) |
| `reconnectGracePeriodSeconds` | Grace period in seconds before sending the offline notification. If the chargepoint reconnects within this delay, both offline and online notifications are suppressed (default: `60`) |
| `availabilityDebounceSeconds` | Debounce delay (seconds) before sending Available/Unavailable notifications. Prevents spurious alerts from chargepoints that rapidly toggle status on connection (default: `5`) |
| `mail.enabled` | Enable email notifications |
| `mail.from` | Sender address |
| `mail.transport` | SMTP transport configuration (Nodemailer) |
| `webpush.enabled` | Enable Web Push notifications |
| `webpush.vapid*` | VAPID keys for Web Push (to be generated) |
| `pushover.enabled` | Enable Pushover notifications |
| `defaultDisabledEvents` | Events disabled by default for users with no saved preferences (comma-separated list via env) |

### Google OAuth Authentication

```json
"auth": {
  "google": {
    "enabled": false,
    "client_id": "",
    "client_secret": ""
  }
}
```

When enabled, users can sign in with their Google account. The Google account is matched by email address to an existing user. The OAuth callback URL is derived from `webui.publicUrl`.

---

### Legal Pages

The application exposes two public routes (no authentication required):

| URL | Content |
|---|---|
| `/privacy` | Privacy policy |
| `/terms` | Terms of use |

Links to these pages are displayed at the bottom of the login page. You should register both URLs in your [Google API Console](https://console.developers.google.com/) OAuth consent screen configuration.

**Default content** is provided in `public/legal/` (shipped with the application). These generic templates indicate the sections that should be customised (operator name, contact details, etc.).

**Customising the content** — place your own Markdown files in `config/legal/` to override the defaults without modifying application files:

```bash
mkdir -p config/legal

# Override French privacy policy
cp public/legal/privacy.fr.md config/legal/privacy.fr.md
# Edit config/legal/privacy.fr.md

# Add a language not shipped by default (e.g. German, added via locales-custom/)
cp public/legal/privacy.fr.md config/legal/privacy.de.md
# Translate and edit config/legal/privacy.de.md
```

File naming convention: `{privacy|terms}.{lang}.md` (e.g. `privacy.fr.md`, `terms.en.md`).

The language is resolved from the `?lang=` query parameter, then from the browser `Accept-Language` header, then from `config.language`. If no file is found for a given language, the application falls back to the default language.

**Docker** — no changes required. The `config/` directory is already mounted as a volume (`./data/config:/app/config`); place your override files in `./data/config/legal/` on the host.

---

## TLS Certificates

Certificates are stored in the `config/certs/` folder (all paths in `config.json` are relative to `config/`).

The application supports **hot-reload**: when a certificate file changes on disk the server reloads its TLS context automatically — no restart required. Symlinks pointing to Let's Encrypt's `live/` directory take full advantage of this.

---

### HTTPS — Web Interface

> Requires `webui.https.enabled: true`.

**Development — self-signed certificate:**

```bash
mkdir -p config/certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout config/certs/server.key \
  -out    config/certs/server.crt \
  -subj   "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

**Production — Let's Encrypt (symlinks, auto-renewed):**

```bash
certbot certonly --standalone -d cpadmin.example.com

mkdir -p config/certs
ln -sf /etc/letsencrypt/live/cpadmin.example.com/fullchain.pem config/certs/server.crt
ln -sf /etc/letsencrypt/live/cpadmin.example.com/privkey.pem   config/certs/server.key
```

Because the symlinks always resolve to the latest archive files after `certbot renew`, no post-renewal hook is needed — the server detects the change and hot-reloads automatically.

`config.json` excerpt:

```json
"webui": {
  "https": {
    "enabled": true,
    "httpsPort": 3001,
    "certFile": "certs/server.crt",
    "keyFile":  "certs/server.key"
  }
}
```

---

### WSS — OCPP Server (Security Profile 2 / 3)

> Requires `ocpp.wss.enabled: true`. The server loads **both an RSA and an ECDSA certificate simultaneously** to support the widest range of charge point implementations.

**Development — self-signed RSA + ECDSA:**

```bash
mkdir -p config/certs

# RSA
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout config/certs/rsa-server.key \
  -out    config/certs/rsa-server.crt \
  -subj   "/CN=ws.cpadmin.local" \
  -addext "subjectAltName=DNS:ws.cpadmin.local,IP:127.0.0.1"

# ECDSA
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -days 365 -nodes \
  -keyout config/certs/ecdsa-server.key \
  -out    config/certs/ecdsa-server.crt \
  -subj   "/CN=ws.cpadmin.local" \
  -addext "subjectAltName=DNS:ws.cpadmin.local,IP:127.0.0.1"
```

**Production — Let's Encrypt (symlinks, auto-renewed):**

```bash
# RSA certificate (default)
certbot certonly --standalone -d ws.cpadmin.example.com

# ECDSA certificate (separate lineage)
certbot certonly --standalone -d ws.cpadmin.example.com \
  --key-type ecdsa --cert-name ws-cpadmin-ecdsa

mkdir -p config/certs

# RSA symlinks
ln -sf /etc/letsencrypt/live/ws.cpadmin.example.com/fullchain.pem config/certs/rsa-server.crt
ln -sf /etc/letsencrypt/live/ws.cpadmin.example.com/privkey.pem   config/certs/rsa-server.key

# ECDSA symlinks
ln -sf /etc/letsencrypt/live/ws-cpadmin-ecdsa/fullchain.pem config/certs/ecdsa-server.crt
ln -sf /etc/letsencrypt/live/ws-cpadmin-ecdsa/privkey.pem   config/certs/ecdsa-server.key
```

`config.json` excerpt:

```json
"ocpp": {
  "wss": {
    "enabled": true,
    "wssPort": 9001,
    "strictClientCert": false,
    "rsa":   { "certFile": "certs/rsa-server.crt",  "keyFile": "certs/rsa-server.key" },
    "ecdsa": { "certFile": "certs/ecdsa-server.crt", "keyFile": "certs/ecdsa-server.key" },
    "caFile": "",
    "rootCaFile": ""
  }
}
```

#### Root CA — WSS server certificate troubleshooting

Some charge points validate the WSS server certificate against their own trust store. If the certificate configured above (`rsa`/`ecdsa` `certFile`) is not recognized by the charge point — a self-signed certificate never provisioned on the charge point, or an outdated root CA on old firmware — the connection fails. `ocpp.wss.rootCaFile` addresses this: it lets a site manager download the root certificate from the charge point's detail page for manual import on the device, and is also appended automatically to the certificate chain served during the WSS handshake for charge points whose TLS stack needs to see the full chain explicitly.

This is unrelated to `ocpp.wss.caFile`, which only validates **incoming client certificates** (mTLS, Security Profile 3).

Which file to point `rootCaFile` to depends on the **type of certificate** used for `rsa`/`ecdsa`, not on the installation mode (Docker or standalone) or environment (dev/prod):

- **Self-signed certificate** (generated with `openssl req -x509 ...` above): the server certificate is already its own root — `rootCaFile` simply points to the same file (e.g. `certs/rsa-server.crt`). If both RSA and ECDSA are self-signed, the downloaded file is a PEM bundle containing both certificates: a charge point receives one or the other depending on the algorithms it advertises, and `rootCaFile` can even be left empty in that case.
- **Certificate from a CA** (Let's Encrypt or any other public/private provider): the `fullchain.pem`/`certFile` supplied by the CA usually does not include the root (Let's Encrypt's convention, notably) — fetch the root certificate separately from the provider and place it at `config/certs/root-ca.crt`. Example with Let's Encrypt (`ISRG Root X1`, valid until 2035):
  ```bash
  curl -o config/certs/root-ca.crt https://letsencrypt.org/certs/isrgrootx1.pem
  ```
  (check the exact URL on https://letsencrypt.org/certificates/ at the time of writing). For another provider, refer to its documentation to obtain its root certificate.
  > **Docker + Let's Encrypt**: the `ISRG Root X1` certificate ships with the app at `config/certs/isrg-root-x1.pem` — no `curl` needed. The three Let's Encrypt-based compose files (`docker-compose.https.yml`, `docker-compose.tls.yml`, `docker-compose.tls-ext.yml`) already set `CPADMIN_OCPP_WSS_ROOT_CA_FILE=certs/isrg-root-x1.pem`, so this is enabled automatically. Standalone installations can point to the same vendored file manually (see below) instead of fetching it.
- **Charge point with a single installable file**: some firmwares have only one slot for the mTLS file, which then replaces the server root and prevents server verification. The "Download with server root" button on the charge point page returns the client PEM (certificate + key) followed by the server root bundle (`?withRoot=1` on `GET /api/chargepoints/:id/client-cert/download`).
- `config.json`: `"rootCaFile": "certs/root-ca.crt"` (third-party CA), `"certs/isrg-root-x1.pem"` (vendored Let's Encrypt root, see above), or `"certs/rsa-server.crt"` (self-signed).

This is a **troubleshooting fallback**: with Let's Encrypt, most modern charge points already trust `ISRG Root X1` natively (in public root stores since ~2016) — the download is only useful for old/fixed firmware or private-CA/self-signed deployments.

#### Security Profile 3 — Client Certificate Authentication

The server validates that the client certificate is signed by a trusted CA (`wss.caFile`). Two ways to obtain client certificates:

- **Automatic per-charge-point generation** (recommended — see [Automatic client certificate generation](#automatic-client-certificate-generation)): the app acts as a local CA and issues one certificate per charge point with `CN` = the charge point's identity. Required if you plan to enable [OCPP security profile enforcement](#ocpp-security-profile-enforcement), since it needs CN == identity matching to verify mTLS.
- **Manual, generic certificate**: create your own CA with `openssl` and issue a **single certificate shared by all charge points** (generic `CN`, not tied to any charge point identity), then set `strictClientCert: true` and `caFile` to that CA's certificate. This is a valid lighter-weight option for basic mTLS (Profile 3) without per-charge-point identity binding — but **it cannot satisfy security profile enforcement**, which requires `CN` to exactly match each charge point's identity.

> **Mixed mode** (`strictClientCert: false` with `caFile` set): the server requests a certificate but still accepts password authentication (Profile 2). Certificates that are presented are validated against the CA.

#### Automatic client certificate generation

Alternative to the manual CA/certificate above: the app can act as a local CA and automatically issue a client certificate **per charge point**, with `CN` = the charge point's exact identity. No added dependency — uses the system's `openssl` binary (`child_process.execFile`, never `exec`, to avoid any shell injection).

**Requirement:** `openssl` must be available on the server's PATH. Availability is checked on demand; if missing (common on Windows without development tools installed), generation fails cleanly (`ERR_OPENSSL_UNAVAILABLE`) without affecting the rest of the app.

**How it works:**
1. On the first certificate generated, a self-signed local CA is created at `ocpp.wss.clientCa.certFile`/`keyFile` (default: `certs/clients/ca.crt`/`ca.key`) if it doesn't already exist.
2. A client certificate is automatically generated when a charge point is created (`POST /chargepoints`) or when a pending charge point is accepted — stored under `config/certs/clients/cp-<identity>/{cert.pem,key.pem}`.
3. The **Certificates** section of the charge point detail page (managers of the charge point's site and admins) offers:
   - the **server root certificate** (`ocpp-wss-root-ca.crt`, see [Root CA](#root-ca--wss-server-certificate-troubleshooting)) — also available from the **WSS root certificate** button at the top of the charge point list, before any charge point exists;
   - the **client certificate** (combined cert+key PEM, `<identity>-client.pem`);
   - the **client certificate with the server root** (`<identity>-client-with-root.pem`, for firmwares with a single certificate slot);
   - the expiry date of the client certificate.

   Managers can download these files since they deploy them onto the charge point. **Generating or regenerating** the certificate remains admin-only, as it issues a new private key (regeneration asks for confirmation).
4. Default validity period is `ocpp.wss.clientCa.certValidityDays` (5 years).
5. **Regenerating revokes the previous certificate immediately**: its fingerprint is added to `certs/clients/revoked.json` (checked on every mTLS connection, no restart needed, included in the backup archive), and the charge point's current session is closed — without ending its charging sessions. It cannot reconnect with mTLS until the new certificate is installed on it. Deleting a charge point also revokes and erases its certificate and private key. Certificates issued by a manual CA (`ocpp.wss.caFile`) are not covered by this list.

**For the WSS server to trust certificates issued this way**, point `ocpp.wss.caFile` at the same file as `ocpp.wss.clientCa.certFile` (or copy it), then restart the app — `caFile` remains the single mTLS trust mechanism; the issuing CA is not automatically wired into the validation chain.

```json
"wss": {
  "caFile": "certs/clients/ca.crt",
  "clientCa": {
    "certFile": "certs/clients/ca.crt",
    "keyFile": "certs/clients/ca.key",
    "certValidityDays": 1825
  }
}
```

This per-charge-point generation (CN == identity) is a **prerequisite** for OCPP security profile enforcement in mTLS mode, on either version — see [OCPP security profile enforcement](#ocpp-security-profile-enforcement).

---

## Getting Started

### Production Mode

```bash
npm start
```

### Development Mode

```bash
npm run start-dev
```

The application starts:
1. The Express web server on the configured port (default: 3000)
2. The OCPP WebSocket server on the configured port (default: 9000)
3. Database migrations are automatically executed on startup

A default administrator account is created on first startup if the database is empty:

| | |
|---|---|
| **Email** | `admin@admin.com` |
| **Password** | `admin123` |

> **⚠️ Important:** Change the email and password of this account on first login.

---

## Energy Tariffs

Each site can have its own **price per kWh grid**. It is used to estimate the share of charging in the overall electricity bill, and to give people charging a company vehicle at home a supporting document for their expense claims.

### Configuring a tariff

On the **Sites** page, the **Tariff** button (managers of the site and administrators) opens the grid editor:

| Field | Description |
|---|---|
| Currency | 3-letter ISO code (`EUR`, `CHF`…), default `EUR` |
| Time zone | IANA time zone of the site (`Europe/Paris`…), default `Europe/Paris`. Slots are evaluated in this time zone, daylight saving time included |
| Default price | Price per kWh applied to hours **not covered** by a slot. **Left empty, no cost is computed for the site.** Required as soon as there is at least one slot |
| Slots | Label (e.g. `Peak`, `Off-peak`), days of the week (Mon → Sun), start time, end time (`24:00` allowed as an end), price per kWh |

Rules:

- A slot with an end time earlier than its start time spans midnight (e.g. `22:00 → 06:00`). It **belongs entirely to the day it starts on**: a Friday `22:00 → 06:00` slot covers Friday 22:00 to Saturday 06:00.
- Slots must not overlap, including the part spilling over the next day. For instance, a Friday `22:00 → 06:00` slot and a Saturday `00:00 → 24:00` slot overlap; use `06:00 → 24:00` for the Saturday instead.
- Example — weekday off-peak plus a weekend rate:

  | Label | Days | Slot | Price |
  |---|---|---|---|
  | Off-peak | Mon–Fri | `22:00 → 06:00` | 0.15 |
  | Weekend | Sat–Sun | `06:00 → 24:00` | 0.10 |
  | *(default)* | all other hours | | 0.25 |

### How the cost is computed

- The cost is computed **when the session is closed** (all closing paths: StopTransaction / TransactionEvent `Ended`, orphan sessions, server restart recovery) and then **frozen** on the transaction (`cost`, `cost_currency`, `cost_details`). Single exception: a session closed by the server (end message not received) is computed again once when the charge point's real stop arrives later — see [Transaction handling](#transaction-handling).
- Sessions refused at start (*Rejected* status) never have a cost.
- The energy is split across slots using the **MeterValues** received during the session (piecewise-linear cumulated energy curve). If the charge point sent none, the energy is **spread proportionally to the duration** (the calculation method is shown in the session detail).
- Changing the grid afterwards **never changes past sessions**, and sessions closed before a tariff existed are **not back-filled**: the cost of a session is meant to stay a reliable supporting document.
- A calculation failure never prevents a session from being closed (the session simply has no cost).

### Where costs appear

- **Transactions** (managers/admins) and **My transactions** (users): *Cost* column and a cost KPI card (totals are grouped by currency, different currencies are never added together).
- **Session detail**: cost breakdown per slot (time span, kWh, price, amount), calculation method and time zone.
- **CSV exports** (global/site export and personal export): four extra columns — `Cost`, `Currency`, `Average price (/kWh)` and `Tariff breakdown` (e.g. `Peak 6.20 kWh × 0.2500 = 1.55 | Off-peak 12.00 kWh × 0.1500 = 1.80`). They are empty for sessions without a cost. Each user only sees the cost of their own sessions. A `Category` column (business / personal badge) is also present. Cells starting with `=`, `+`, `-` or `@` (badge, user name… — except numbers) are prefixed with an apostrophe so that a spreadsheet never runs them as a formula.

> Access to a session's detail (`GET /api/transactions/:id`) is restricted to administrators, managers of the site of the charge point and the owner of the RFID badge used.

---

## Business / Personal Badges and Reimbursement Exports

Each RFID badge has a **category**: `personal` (default) or `business`. It lets you separate what must be reimbursed (charging a company vehicle) from private consumption, whatever the site where the badge is used.

### Setting up the category

- On the **RFID badges** page, the create/edit form has a **Category** selector, and the list has a *Category* column and filter.
- Existing badges (and automatically created `MGR-*` / `WEB-*` badges) are **personal** by default: switch to *business* the badges that must be reimbursed.
- A *business* badge should be **linked to a user**, otherwise its sessions appear without a name in the per-employee report.

### Typical set-up: company with several sites

- One **site** per location (headquarters, employees' homes…) with its own [tariff](#energy-tariffs).
- Create the badges with **no site** (*All sites*): a badge is then valid everywhere. Two badges per employee (business + personal) are simply two badges linked to the same user.
- **Link each employee to every site** where they may charge (user management): otherwise authorization is refused with `user_not_linked`.

### Filters and exports

- **Transactions** page (managers/admins): *Category* filter, also applied to the CSV export, plus a `Category` column.
- **My transactions** page (all users): same *Category* filter, applied to the list, KPIs and CSV export. The personal CSV ends with a **total row** (kWh and cost per currency): filtered on *business*, it is a ready-to-use expense report.
- **Reimbursement export** (button on the **Transactions** page, managers/admins): CSV aggregated **by site, then by employee** — number of completed sessions, energy (kWh) and cost per currency, with a total per site. It follows the site, category (**business** by default) and date filters of the page. A manager only gets the sites they manage. Sessions of a site with no tariff have an empty cost.

> Confidentiality: sessions of personal badges remain visible to site managers (the company pays for the charge points); only the exports separate the two categories.

---

## Roles and Permissions

The application uses three hierarchical role levels:

### Administrator (`admin`)

Full access to all features:
- Management of all sites, users, and charge points
- Global application configuration
- Approval of pending charge points
- View all transactions and OCPP messages
- Global CSV export
- Energy tariffs of every site
- Exclusive access to the System Administration page (system info/backup, data cleanup, raw OCPP console, OCPP parameter comparison)
- Can also be a user on one or more sites

### Manager (`manager`)

Management restricted to authorized sites:
- Monitor charge points on assigned sites
- Manage users on assigned sites
- Remote start / stop charging
- Everyday charge point operations: `Reset`, `ChangeAvailability`, `UnlockConnector`, `TriggerMessage`, `ClearCache`, `GetLocalListVersion`, and diagnostics / log upload to the configured `ocpp.diagnosticsLocation` only (the generic command route `POST /api/chargepoints/:id/command` refuses any other OCPP command to a manager — configuration, firmware, certificates… are admin-only)
- View transactions on assigned sites
- CSV export for assigned sites
- Configure the energy tariff (price per kWh) of assigned sites
- Can also be a user on one or more sites

### User (`user`)

Limited access for charging:
- View available connectors on authorized sites
- Start and stop own charging sessions
- View personal transaction history
- Export own transactions to CSV (with the cost of own sessions when the site has a tariff)
- Manage notification preferences

---

## REST API (selected endpoints)

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/error-events` | manager+ | Paginated error event log. Query params: `chargepoint_id`, `event_type` (`status_error`\|`disconnect`\|`heartbeat_timeout`\|`security_event`\|`notify_event`), `ocpp_version` (`1.6`\|`2.0.1`), `from`, `to` (ISO 8601), `limit` (max 500), `offset` |
| `GET` | `/api/transactions`, `/api/transactions/csv`, `/api/user/transactions`, `/api/user/transactions/stats`, `/api/user/transactions/csv` | manager+ / user | Accept a `category` filter (`pro`\|`perso`) on the badge used for the session, and a `status` filter (`Active`\|`Completed`\|`Rejected`). Refused (`Rejected`) sessions are only returned when explicitly filtered |
| `GET` | `/api/sites/:siteId/tariff` | manager of the site / admin | Tariff of a site: `currency`, `timezone`, `default_price_per_kwh` and `periods[]` (`label`, `days` as ISO weekdays `1`–`7`, `start_time`, `end_time`, `price_per_kwh`) |
| `PUT` | `/api/sites/:siteId/tariff` | manager of the site / admin | Atomically replaces the tariff of a site (same body as the `GET` response). `400` with `ERR_TARIFF_*` codes when invalid (format, overlap, missing default price…) |
| `GET` | `/api/transactions/reimbursement/csv` | manager of the site / admin | Reimbursement CSV by site then employee. Query params: `site_id`, `category` (`pro`\|`perso`, default `pro`), `from`, `to` (ISO 8601) |
| `GET` | `/api/transactions/:id` | admin / site manager / badge owner | Session detail, including the frozen `cost`, `cost_currency` and `cost_details`. `:id` is the **internal identifier** of the session (`id` field of the lists), not the OCPP `transaction_id` — only unique per charge point in OCPP 2.0.1 |
| `GET` | `/api/transactions/:id/values` | admin / site manager / badge owner | Real-time metering series for a transaction (same `:id`): `energie`, `courant`, `soc`, `temperature`, `tension`, `frequence` |
| `GET` | `/metrics` | optional token | Prometheus-format metrics |
| `GET` | `/healthz` | public | Health check |

---

## OCPP Protocol (1.6 and 2.0.1)

The application implements **OCPP 1.6-J** and **OCPP 2.0.1** (JSON over WebSocket). Both versions can run side by side on the same ports: the version is negotiated with each charge point through the WebSocket sub-protocol (`ocpp1.6` / `ocpp2.0.1`). OCPP 1.6 is enabled by default; OCPP 2.0.1 is enabled with `ocpp.v201.enabled: true` (or `CPADMIN_OCPP_V201_ENABLED=true`).

### Supported Operations — OCPP 1.6

#### Charge Point → Server (incoming requests)

| Operation | Description |
|---|---|
| **BootNotification** | Charge point startup notification (manufacturer info, firmware) — triggers the [initialization sequence](#initialization-sequence) on first connection |
| **Heartbeat** | Periodic heartbeat signal |
| **StatusNotification** | Connector or charge point status change |
| **Authorize** | RFID badge authorization request |
| **StartTransaction** | Charging session start (a refused badge is still recorded, see [Transaction handling](#transaction-handling)) |
| **StopTransaction** | Charging session end (stop reason, energy consumed); the response carries the actual status of the badge used to stop |
| **MeterValues** | Real-time metering data (energy, power, current, SOC, temperature, voltage, frequency); `SignedData` values are ignored |
| **DataTransfer** | Vendor-specific data exchange (no vendor extension implemented: answered `UnknownVendorId`, as required by the specification) |
| **DiagnosticsStatusNotification** | Diagnostics upload status |
| **FirmwareStatusNotification** | Firmware update progress status |

#### Server → Charge Point (commands)

| Operation | Used for |
|---|---|
| **RemoteStartTransaction** / **RemoteStopTransaction** | Start / stop a charging session from the interface |
| **GetConfiguration** / **ChangeConfiguration** | Read and modify configuration keys |
| **SetChargingProfile** / **ClearChargingProfile** / **GetCompositeSchedule** | [Charging profiles](#charging-profiles) |
| **ReserveNow** / **CancelReservation** | Connector reservations (expired reservations are released automatically) |
| **Reset** (Soft / Hard), **ChangeAvailability**, **UnlockConnector**, **TriggerMessage**, **ClearCache**, **GetLocalListVersion**, **GetDiagnostics** | Operations from the charge point page |

### Supported Operations — OCPP 2.0.1

#### Charging Station → Server (incoming requests)

| Operation | Description |
|---|---|
| **BootNotification**, **Heartbeat**, **StatusNotification** | Startup, keep-alive, connector status (per EVSE) |
| **Authorize** | Badge (`idToken`) authorization; the token type is checked against the type stored for the badge |
| **TransactionEvent** | `Started` / `Updated` / `Ended` events of a session (badge presented after plug-in, remote start correlated by `remoteStartId`, stop reason read from `stoppedReason`, meter values) |
| **MeterValues** | Meter values outside a transaction |
| **NotifyReport** | Device model inventory (response to `GetBaseReport`), stored as the charge point variables |
| **ReservationStatusUpdate** | Reservation expired / removed by the charging station |
| **FirmwareStatusNotification**, **LogStatusNotification** | Firmware update and log upload progress (failures are notified) |
| **SecurityEventNotification**, **NotifyEvent** | Security events and alerting/critical device events, stored in the error event history |
| **DataTransfer** | Answered `UnknownVendorId` (no vendor extension) |
| **NotifyChargingLimit**, **ClearedChargingLimit**, **ReportChargingProfiles**, **NotifyCustomerInformation**, **NotifyDisplayMessages**, **NotifyMonitoringReport**, **PublishFirmwareStatusNotification** | Acknowledged (informational, not used) |
| **SignCertificate**, **GetCertificateStatus**, **Get15118EVCertificate**, **NotifyEVChargingNeeds**, **NotifyEVChargingSchedule** | Explicitly refused (`Rejected` / `Failed`): certificate management over OCPP and ISO 15118 are not supported |

#### Server → Charging Station (commands)

| Operation | Used for |
|---|---|
| **RequestStartTransaction** / **RequestStopTransaction** | Start / stop a charging session (an EVSE can be targeted on multi-EVSE stations) |
| **GetTransactionStatus** | After a reconnection, checks that sessions still active in the database still exist on the station |
| **GetBaseReport**, **GetVariables** / **SetVariables** | Read the device model and modify variables (including variables with an instance, e.g. `MessageTimeout[Default]`) |
| **SetChargingProfile** / **ClearChargingProfile** / **GetCompositeSchedule** | [Charging profiles](#charging-profiles) (`ChargingStationMaxProfile`, `TxDefaultProfile`) |
| **ReserveNow** / **CancelReservation** | EVSE reservations |
| **Reset** (Immediate / OnIdle), **ChangeAvailability**, **UnlockConnector**, **TriggerMessage**, **ClearCache**, **GetLocalListVersion**, **GetLog** | Operations from the charge point page |

**Not supported in OCPP 2.0.1:** certificate management over OCPP (`InstallCertificate`, `CertificateSigned`, `SignCertificate`… — client certificates are issued by the app, see [Automatic client certificate generation](#automatic-client-certificate-generation)), ISO 15118 / Plug & Charge, `GetChargingProfiles`, local authorization list management, display messages, monitoring, and the `totalCost` field of `TransactionEventResponse`.

For both versions, administrators can send any other command with arbitrary JSON parameters from the raw OCPP console (System Administration page).

### Initialization Sequence

On the first connection of a charge point (or after **Reinitialize** on its page), the server runs:

1. `ClearCache`;
2. `ClearChargingProfile` (only when the app manages no profile for this charge point);
3. reading of the configuration — `GetConfiguration` (1.6, paginated if needed) or `GetBaseReport` + `NotifyReport` (2.0.1);
4. application of the **default configuration** (*Settings → Default OCPP Configuration*): `ChangeConfiguration` keys (1.6) or `SetVariables` variables (2.0.1), except values locked (override) on this charge point;
5. re-application of the values locked on this charge point.

The default configuration enforces `AuthorizeRemoteTxRequests=false` (1.6) and `AuthCtrlr.AuthorizeRemoteStart=false` (2.0.1), so that a charge point does not ask for the authorization of the badge of a remote start (see [Remote starts](#remote-starts)). An OCPP 2.0.1 variable can carry an **instance** (field in the default configuration form). *Apply to all charge points* sends the 1.6 keys only to 1.6 charge points and the 2.0.1 variables only to 2.0.1 charge points; offline charge points receive them at their next initialization.

### Transaction Handling

- **Transactions are identified by charge point**: in 2.0.1 the `transactionId` is generated by the charging station and is only unique for it. In the interface and the API, a session is designated by its internal identifier (`id`).
- **Refused start**: when the badge is refused at `StartTransaction` / `TransactionEvent(Started)`, the session is still recorded with the **Rejected** status (in 1.6 the charge point receives a real `transactionId`, not `0`): the energy delivered before the cut is kept, but the session is never billed and is excluded from lists, totals and exports (*Rejected* filter on the Transactions page).
- **Sessions closed by the server**: the server closes a session itself when it can no longer expect its end message — connector back to `Available`, new session on the same connector, server restart, OCPP version change, de-authorization, or a 2.0.1 station confirming the end through `GetTransactionStatus`. If the real `StopTransaction` / `TransactionEvent(Ended)` arrives afterwards (the specification does not guarantee message order), it **corrects** the session (meter, time, stop reason) and the cost is computed again, without a new notification. Meter values received late for such a session are kept for the chart.
- **Retransmissions**: a `StartTransaction`, `TransactionEvent(Started)`, `StopTransaction` or `Ended` sent again by the charge point (lost response) never creates a duplicate nor sends notifications twice.

### Remote Starts

Starts from the interface use the user's badge or a **badge generated** by the app (`ADMIN`, `MGR-<site>`, `WEB-<user>`, sent with the `Central` token type in 2.0.1). Generated badges are refused when presented as an RFID card. During a remote start, the server remembers the badge (and the 2.0.1 `remoteStartId`) for 60 seconds:

- an `Authorize` for this badge, from this charge point, is accepted — useful for charge points whose `AuthorizeRemoteTxRequests` / `AuthorizeRemoteStart` key is read-only;
- only this badge skips the authorization check: another badge presented on the connector in the meantime is still checked.

### Charge Point Connection

Charge points connect via WebSocket to:
```
ws://<host>:<wsPort>/<identity>
```

Or in secure mode:
```
wss://<host>:<wssPort>/<identity>
```

Where `<identity>` is the unique identifier of the charge point (registered in the application).

### Security Profiles

The OCPP security profiles (OCPP 1.6 security whitepaper, OCPP 2.0.1 part 2 — A00):

| Profile | Transport | Charge point authentication |
|---|---|---|
| **Profile 1** | WS (unsecured) | Password (Basic Auth in the WebSocket handshake) |
| **Profile 2** | WSS (TLS) | Password (Basic Auth) |
| **Profile 3** | WSS (TLS) | TLS client certificate (mTLS) |

A connection with **no authentication at all** (plain WS without password) is not one of these profiles; it is accepted by default for compatibility, and can be refused per OCPP version — see [OCPP security profile enforcement](#ocpp-security-profile-enforcement).

Charge points must be registered and authorized in the application to connect. Unrecognized charge points can be:
- **Rejected** (default behavior)
- **Automatically added** (`autoAddUnknownChargepoints: true`)
- **Put pending** approval (`pendingUnknownChargepoints: true`)

#### OCPP security profile enforcement

> Opt-in **independently per OCPP version**, via `ocpp.v16.enforceSecurityProfile` and `ocpp.v201.enforceSecurityProfile` — enabling one does not affect the other, so a mixed 1.6/2.0.1 fleet can be migrated one version at a time.

By default, a charge point can connect over plain WS with no authentication at all — a mode neither the OCPP 1.6 nor the 2.0.1 security whitepaper recognizes as valid, which can cause undefined firmware behavior on the charge point side (e.g. rejecting `TriggerMessage` commands). Setting `enforceSecurityProfile: true` on a version restricts its connections to the 3 security profiles approved by the spec:

| Accepted profile | Condition checked |
|---|---|
| WS + Basic Auth | Password provided in the handshake (WS or WSS) |
| WSS + Basic Auth | Password provided in the handshake (WS or WSS) |
| WSS + mTLS | Client certificate validated by the TLS chain (`socket.authorized === true`) **and** certificate `CN` == charge point identity |

Any connection attempt on an enforced version matching none of these profiles is rejected (`401`), with an automatic admin notification (reason `wss_no_auth` when no authentication is presented over WSS, `ws_no_auth` when a plain WS connection sends no password, `mtls_invalid` when a client certificate is presented but is invalid or the identity doesn't match).

**Password and mTLS**: when a client certificate is verified (trusted CA and `CN` == identity), the Basic Auth password is neither required nor checked — the certificate is the credential (Security Profile 3), whether or not enforcement is enabled. A password still sent by the charge point (e.g. kept in its memory after a profile upgrade) or still stored for it on the server does not cause a refusal; it is only logged. Without a verified certificate, the password checks apply as before.

**Password length**: a charge point password is 8 to 40 alphanumeric characters (the range common to OCPP 1.6 and 2.0.1). Note: OCPP 2.0.1 (A00.FR.205) requires **at least 16 characters**; a 2.0.1 charge point may reject a shorter password. Use 16 characters or more for 2.0.1 charge points.

**Prerequisite for mTLS mode**: each charge point must have a client certificate whose `CN` exactly matches its identity — see [Automatic client certificate generation](#automatic-client-certificate-generation). A single certificate shared by all charge points (generic CN) does not satisfy this condition under enforcement.

**Reverse proxy (Traefik, etc.)**: with `ocpp.trustProxyProto: true`, a connection arriving as plain WS on the app with an `X-Forwarded-Proto: https` (or `wss`) header is considered secured by TLS upstream: the charge point is shown as connected over **WSS**, the logs mention `WSS (TLS terminated by proxy)` and a refusal is classified `wss_no_auth`. It has **no effect on authentication**: the password is still required. Enable it only behind a reverse proxy that sets this header (otherwise a client could forge it). **WSS+mTLS remains impossible behind a TLS-terminating reverse proxy** (the client certificate is never forwarded to the app): only the Basic Auth profiles remain usable in that case.

**Startup warning**: when enforcement is enabled on a version while `ocpp.wss.caFile` is empty, a warning is logged at startup — client certificates cannot be verified, so every mTLS connection would be refused (the message gives the path of the local client CA when it exists).

### Heartbeat & Connection Monitoring

The server uses two complementary mechanisms to detect disconnected or unresponsive charge points.

#### WebSocket Ping (transport level)
The `ocpp-rpc` library sends WebSocket ping frames to each charge point at its default interval (30 seconds). If no pong is received, the connection is terminated immediately. This detects network-level drops (lost 4G link, NAT timeout, etc.) within ~60 seconds, regardless of OCPP configuration.

Activity deferral (`deferPingsOnActivity`) is enabled: if a charge point is actively sending OCPP messages (e.g. `MeterValues`), the ping is deferred until the connection goes idle, reducing unnecessary traffic on metered connections.

#### Heartbeat Watchdog (application level)
A server-side watchdog checks at regular intervals whether each connected charge point has sent a `Heartbeat` message recently. A charge point that has not sent a heartbeat within `HeartbeatInterval × 2` seconds is forcibly disconnected.

The heartbeat interval is a **global system parameter** managed exclusively in *Settings → Default OCPP Configuration*: the `HeartbeatInterval` key for OCPP 1.6 charge points and the `OCPPCommCtrlr.HeartbeatInterval` variable for OCPP 2.0.1 charge points. It is returned in the `BootNotification` response, applied during initialization and cannot be overridden per charge point. The watchdog reads the value matching the OCPP version of each charge point from the database, so changes take effect immediately without restarting the server.

When a charge point is disconnected by the watchdog, a **Dead charge point (heartbeat timeout)** notification is sent to admins and managers (web push by default, email optionally). The generic *charge point offline* notification is suppressed in this case to avoid duplicate alerts.

> **Default value:** 600 seconds. The effective timeout before disconnection is 1200 seconds (20 minutes).

---

## Notification System

The application provides an event-driven alert system.

### Available Channels

| Channel | Required Configuration |
|---|---|
| **Email** | SMTP server (`notifs.mail`) |
| **Web Push** | VAPID keys (`notifs.webpush`) |
| **Pushover** | Token and user key (in user profile) |

### Event Types

#### Administrator Events

| Event | Description |
|---|---|
| Server start / stop | The OCPP server has started or stopped |
| Pending charge point | An unknown charge point is trying to connect |
| Auto-added charge point | An unknown charge point was automatically added |
| Duplicate identity | Same charge point identifier from a different IP |
| Flapping | Rapid repeated reconnections from a charge point |
| Connection refused | A charge point was refused (unknown, not authorized, wrong or missing password, security profile not met…) — at most once per `refusedCooldownMinutes` for the same identity and reason |
| Initialization result | Keys / variables of the default configuration rejected, not supported or requiring a reboot |
| Diagnostics / log upload | Upload finished or failed |
| Firmware update | Firmware installed or update failed |

#### Manager Events

| Event | Description |
|---|---|
| Charge point online / offline | Connection state change |
| **Dead charge point (heartbeat timeout)** | Server-side forced disconnection of a non-responsive charge point |
| Connector available / unavailable | Connector status change |
| Connector error | Error reported by a connector |
| Repeated authorization rejections | Rejection threshold reached for a badge |
| Transaction started / ended | Charging activity on a site |

#### User Events

| Event | Description |
|---|---|
| Transaction started / ended | My charging session starts or ends |
| Vehicle charged | The vehicle has stopped drawing energy (connector `SuspendedEV`, target charge reached): it can be unplugged |

Each user can configure their notification preferences (which events to receive and on which channels) through the application settings.

> **Default behavior:** Users who have never configured their preferences receive all events applicable to their role via **email** (if SMTP is configured). This default can be partially restricted by listing events in `notifs.defaultDisabledEvents` (config.json) or `CPADMIN_NOTIF_DISABLED_EVENTS` (env). Users can always override these defaults in their profile.

---

## Logging

The application uses **Winston** with daily file rotation.

| File | Contents | Retention |
|---|---|---|
| `logs/app-YYYY-MM-DD.log` | All logs (based on configured level) | 30 days |
| `logs/error-YYYY-MM-DD.log` | Errors only | 90 days |

Maximum file size: 20 MB.

Predefined logging scopes: `CPADM` (application), `WEBUI` (web server), `AUTH` (authentication), `OCPP` (OCPP server), `CERTCA` (client certificate authority), `NOTIF`, `NOTIFMAIL`, `NOTIFPUSH`, `NOTIFPUSHOVER` (notifications), `SQLDB` (database).

In development mode, logs are also displayed in the console with color-coded scopes.

To temporarily enable console output in production (e.g. to diagnose a startup error), set the `LOG_CONSOLE=true` environment variable:

```bash
LOG_CONSOLE=true npm start
```

Console output in production uses plain text (no ANSI colors).

---

## Internationalization

The application ships with:
- **French** (`fr`) — default language
- **English** (`en`)

The default language is configured in `config.json` (`language`) or via the `CPADMIN_LANGUAGE` environment variable. Each user can choose their preferred language in their profile.

Translations cover the interface, notifications, CSV exports, and date formats.

### Adding a New Language

New languages can be added **without modifying the source code**. The i18n engine automatically discovers all `.json` files in the `locales/` folder at startup.

To add a language (e.g. German `de`):

1. Copy an existing locale file as a template:
   ```bash
   cp locales/en.json locales/de.json
   ```
2. Translate all values in `locales/de.json` (keep the keys unchanged)
3. Update the `language_label` and `_localeConfig` section to match the new locale:
   ```json
   {
     "language_label": "🇩🇪 Deutsch",
     "_localeConfig": {
       "dateFns": "de",
       "flatpickrLocale": "de",
       "dateFormat": "d.m.Y",
       "dateTimeFormat": "d.m.Y H:i"
     }
   }
   ```
4. Set the new language as default (optional):
   - In `config.json`: `"language": "de"`
   - Or via environment variable: `CPADMIN_LANGUAGE=de`
5. Restart the application

> With Docker, built-in locales (`en`, `fr`) are embedded in the image and updated with each release. To add a custom locale **without rebuilding**, place the `.json` file in the `locales-custom` volume. Custom files are merged on top of built-in locales — keys from custom files override built-in ones while the rest remains intact. See [`docker/README.md`](docker/README.md) for details.

---

## Development Scripts

```bash
# Start in production
npm start

# Start in development mode
npm run start-dev

# Start in development mode with file watching (auto-reload on change)
npm run start-watch

# Check code style (ESLint on src/)
npm run lint:check

# Auto-fix style issues
npm run lint:fix

# Format code with Prettier
npm run format:fix

# Check formatting without modifying
npm run format:check

# Backup the database (see Database > Backup)
npm run backup

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests in CI mode (coverage + forceExit)
npm run test:ci

# End-to-end tests (Playwright — starts the app on port 3099 with a dedicated e2e.db database)
npm run test:e2e
# … with the Playwright interactive UI
npm run test:e2e:ui

# Scan for secrets in source files
npm run audit:secrets

# Audit npm dependencies for high severity vulnerabilities (production / including dev)
npm run audit:deps
npm run audit:depsdev
```

---

## Database

The application uses **SQLite** with **WAL** (Write-Ahead Logging) mode for improved concurrency performance.

Migrations are automatically executed on startup from the `migrations/` folder. The database is created in the `config/` folder with the configured name (default: `cpadmin.db`).

### Backup

A backup script is provided in `scripts/backup.js`. It uses the `better-sqlite3` online backup API, which is safe even while the application is running (WAL mode compatible). The same archive can be downloaded from the System Administration page (admin only).

Each backup is a **ZIP archive** containing:

- the SQLite database;
- the **local client CA** (`certs/clients/ca.crt`, `ca.key`, `ca.srl`) and the **per-charge-point client certificates** (`certs/clients/cp-<identity>/`);
- the **manual mTLS CA** set in `ocpp.wss.caFile` (and its private key when found next to it — a warning is raised otherwise);
- a `MANIFEST.txt` listing what was included and any warning.

These certificates cannot be regenerated without re-issuing and redeploying a certificate on every charge point. Server certificates (Let's Encrypt / Traefik), the web UI HTTPS certificate and the public root CA are **not** included. The archive contains private keys: store it securely.

```bash
# Backup with default settings (7 backups kept in config/backups/)
npm run backup

# Custom destination and retention
node scripts/backup.js --backup-dir /mnt/nas/backups --keep 30

# Custom database path
node scripts/backup.js --db-path /data/cpadmin.db --backup-dir /backups
```

Backup files are named `cpadmin_YYYY-MM-DD_HH-MM-SS.zip`. Old backups beyond the `--keep` limit are automatically deleted (legacy `.db` backups from earlier versions are rotated too).

**Restore procedure:**

1. Stop the application.
2. Unzip the desired backup into the config directory (entries are relative to it; entries under `external/` come from outside that directory, see `MANIFEST.txt`):
   ```bash
   unzip -o config/backups/cpadmin_YYYY-MM-DD_HH-MM-SS.zip -d config
   ```
   (for a legacy `.db` backup: `cp config/backups/cpadmin_….db config/cpadmin.db`)
3. Remove WAL files if present:
   ```bash
   rm -f config/cpadmin.db-shm config/cpadmin.db-wal
   ```
4. Restart the application.

**Docker — scheduled backup (optional):**

Add this service to your `docker-compose.yml`:

```yaml
backup:
  image: ghcr.io/wocha-fr/ocpp-cp-admin:latest
  restart: unless-stopped
  entrypoint: /bin/sh
  command: >
    -c "while true; do
          node /app/scripts/backup.js --backup-dir /backups --keep 30;
          sleep 86400;
        done"
  volumes:
    - ./data/config:/app/config
    - ./data/backups:/backups
  environment:
    - NODE_ENV=production
```

### Main Tables

| Table | Description |
|---|---|
| `sites` | Charging sites (with the tariff settings `currency`, `timezone`, `default_price_per_kwh`) |
| `site_tariff_periods` | Tariff slots of a site (label, days, start/end time, price per kWh) |
| `users` | User accounts |
| `user_sites` | User ↔ site association (with role) |
| `chargepoints` | Registered charge points |
| `evses` | EVSEs of OCPP 2.0.1 charge points |
| `connectors` | Charge point connectors |
| `chargepoint_config` | Configuration keys of OCPP 1.6 charge points (with the locked/override flag) |
| `chargepoint_variables` | Device model variables of OCPP 2.0.1 charge points (component, variable, attribute, instance, EVSE) |
| `chargepoint_init_config` / `chargepoint_init_variables` | Default OCPP configuration applied to charge points (1.6 keys / 2.0.1 variables) |
| `id_tags` | RFID badges (owner, site, expiry, business/personal category, token type) |
| `id_tags_events` | Authorization rejections of badges |
| `transactions` | Charging sessions, identified by charge point (`chargepoint_id`, `transaction_id`): status `Active` / `Completed` / `Rejected`, frozen cost (`cost`, `cost_currency`, `cost_details`), `closed_by` (`station` or `server`) |
| `transactions_values` | Real-time metering data of a session |
| `ocpp_messages` | OCPP message log |
| `users_password_resets` | Password reset tokens |
| `charging_profiles` | Charging profiles applied to charge points |
| `reservations` | Active and historical connector reservations |
| `error_events` | Persistent log of hardware/network errors (StatusNotification faults, disconnections, heartbeat timeouts, security events, alerting device events) |
| `notification_preferences` / `push_subscriptions` / `notification_log` | Notification preferences per user and channel, Web Push subscriptions, sent notifications |

---

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).

- Full license text: [LICENSE](LICENSE)
- Copyright: [COPYRIGHT](COPYRIGHT)
- Authors: [AUTHORS](AUTHORS)
- Contribution process: [CONTRIBUTING.md](CONTRIBUTING.md)

Any modified version deployed as a network service must provide its corresponding source code under AGPL-3.0-only.