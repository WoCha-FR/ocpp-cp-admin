# OCPP CP Admin

**Charge Point Management System (CSMS)** for Charge Point Operators (CPO), based on the OCPP 1.6 protocol.

OCPP CP Admin enables monitoring and managing electric vehicle charging infrastructure: charge point management, user management, charge transactions, real-time alerts, and an analytics dashboard.

> **🇫🇷 [Version française](README.fr.md)**

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Node.js](#nodejs-installation)
  - [Docker](#docker-installation)
  - [Docker Compose](#docker-compose)
- [Environment Variables](#environment-variables)
- [Configuration](#configuration)
  - [General](#general)
  - [Web Interface (WebUI)](#web-interface-webui)
  - [OCPP Server](#ocpp-server)
  - [Notifications](#notifications)
  - [Google OAuth Authentication](#google-oauth-authentication)
- [Getting Started](#getting-started)
- [Roles and Permissions](#roles-and-permissions)
- [OCPP 1.6 Protocol](#ocpp-16-protocol)
  - [Supported Operations](#supported-operations)
  - [Charge Point Connection](#charge-point-connection)
  - [Security Profiles](#security-profiles)
- [Notification System](#notification-system)
- [Logging](#logging)
- [Internationalization](#internationalization)
- [Development Scripts](#development-scripts)

---

## Features

### Charge Point Management
- Manual registration or automatic discovery of charge points
- Approval of pending charge points
- Assignment of charge points to sites
- Real-time monitoring (connector status, heartbeat, errors)
- Remote charge point configuration (GetConfiguration / ChangeConfiguration)
- OCPP message history (CALL / CALLRESULT / CALLERROR)

### Site and User Management
- Multi-site architecture
- Hierarchical roles: Admin, Manager, User
- Per-site and per-user authorization
- Local authentication (email / password) or Google OAuth 2.0
- Password reset via email with secure token

### Transactions and Charge Monitoring
- Active and completed transaction tracking
- Real-time data: energy (Wh), power (W), current (A per phase), state of charge (SOC %)
- Transaction history with filters
- CSV export of transactions
- Personal dashboard for users

### RFID Badge Management
- Badge creation and management (ID Tags)
- Automatic web tag generation for remote starts
- Expiration and authorization rejection tracking

### Multi-Channel Notifications
- **Email** (SMTP via Nodemailer)
- **Web Push** (browser notifications via Service Worker)
- **Pushover** (mobile push notifications)
- 21 event types with role-based filtering
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

### Progressive Web Application (PWA)
- Responsive interface (mobile-first)
- Light/dark theme
- Push notifications via Service Worker
- `/healthz` endpoint for monitoring

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
│         OCPP Server (WS Port 9000 / WSS Port 9001)     │
│  ┌────────────────────────────────────────────────────┐ │
│  │ OCPP 1.6 RPC                                       │ │
│  │ Authentication (password + client certificate)     │ │
│  │ Handlers: Boot, Authorize, Transactions ...        │ │
│  │ Remote commands: RemoteStart, ChangeConfig         │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket OCPP 1.6
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
| OCPP protocol | ocpp-rpc (OCPP 1.6-J) |
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

Four Docker Compose files are available in the `docker/` folder, suited for different deployment scenarios:

| File | Description |
|---|---|
| `docker-compose.http.yml` | App only — HTTP + WS (ports 3000/9000) |
| `docker-compose.https.yml` | App only — HTTPS + WSS (ports 3001/9001) |
| `docker-compose.yml` | Full stack: Traefik (HTTP) + App + FTP |
| `docker-compose.tls.yml` | Full stack: Traefik (HTTPS + WSS passthrough) + App + FTP |

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

On first startup, if `config/config.json` does not exist, it is automatically created from `config.sample.json`.

The entrypoint runs as root to seed default files and fix volume permissions, then drops privileges to a dedicated non-root user (`app`) via `su-exec`.

---

## Environment Variables

Values from `config.json` can be overridden by environment variables. The JSON file remains the base configuration; environment variables take precedence when set.

### Deployment / URLs

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_PUBLIC_URL` | `webui.publicUrl` | `https://cpadmin.example.com` |
| `CPADMIN_HTTP_HOST` | `webui.httpHost` | `0.0.0.0` |
| `CPADMIN_TRUST_PROXY` | `webui.trustProxy` | `true` |
| `CPADMIN_OCPP_WS_URL` | `ocpp.ocppWsUrl` | `ws://ws.example.com` |
| `CPADMIN_OCPP_WSS_URL` | `ocpp.wss.ocppWsUrl` | `wss://ws.example.com:9001` |
| `CPADMIN_DIAGNOSTICS_URL` | `ocpp.diagnosticsLocation` | `ftp://ftp.example.com` |

### Secrets

| Variable | JSON Config |
|---|---|
| `CPADMIN_SESSION_SECRET` | `webui.sessionSecret` |
| `CPADMIN_MAIL_HOST` | `notifs.mail.transport.host` |
| `CPADMIN_MAIL_PORT` | `notifs.mail.transport.port` |
| `CPADMIN_MAIL_USER` | `notifs.mail.transport.auth.user` |
| `CPADMIN_MAIL_PASS` | `notifs.mail.transport.auth.pass` |
| `CPADMIN_GOOGLE_CLIENT_ID` | `auth.google.client_id` |
| `CPADMIN_GOOGLE_CLIENT_SECRET` | `auth.google.client_secret` |
| `CPADMIN_VAPID_PUBLIC_KEY` | `notifs.webpush.vapidPublicKey` |
| `CPADMIN_VAPID_PRIVATE_KEY` | `notifs.webpush.vapidPrivateKey` |

### Feature Toggles

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_MAIL_ENABLED` | `notifs.mail.enabled` | `true` |
| `CPADMIN_MAIL_FROM` | `notifs.mail.from` | `CPADMIN <noreply@example.com>` |
| `CPADMIN_MAIL_SECURE` | `notifs.mail.transport.secure` | `true` (SSL/TLS from start) |
| `CPADMIN_WEBPUSH_ENABLED` | `notifs.webpush.enabled` | `true` |
| `CPADMIN_VAPID_SUBJECT` | `notifs.webpush.vapidSubject` | `mailto:admin@example.com` |
| `CPADMIN_PUSHOVER_ENABLED` | `notifs.pushover.enabled` | `true` |
| `CPADMIN_GOOGLE_AUTH_ENABLED` | `auth.google.enabled` | `true` |

### OCPP Behavior

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_OCPP_STRICT_MODE` | `ocpp.strictMode` | `false` (disable strict OCPP 1.6 validation) |
| `CPADMIN_OCPP_AUTO_ADD` | `ocpp.autoAddUnknownChargepoints` | `true` (auto-register unknown charge points) |
| `CPADMIN_OCPP_PENDING_UNKNOWN` | `ocpp.pendingUnknownChargepoints` | `true` (queue unknown charge points for approval) |

### General Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_LOGLEVEL` | `loglevel` | `debug`, `info`, `error` |
| `CPADMIN_LANGUAGE` | `language` | Any locale code from `locales/` folder (e.g. `fr`, `en`) |
| `CPADMIN_CPO_NAME` | `cpoName` | `My CPO` |

> Booleans (`true`/`false`) and numbers are automatically converted. Secrets are always treated as strings.

---

## Configuration

The configuration file is `config/config.json`. In development mode (`NODE_ENV=development`), `config/config.dev.json` is used if it exists.

Configuration values can be overridden by environment variables (see the [Environment Variables](#environment-variables) section).

### General

| Parameter | Type | Default | Description |
|---|---|---|---|
| `loglevel` | string | `"error"` | Log level: `error`, `warn`, `info`, `debug` |
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
  "heartbeatInterval": 3600,
  "autoAddUnknownChargepoints": false,
  "pendingUnknownChargepoints": true,
  "ocppWsUrl": "ws://ws.cpadmin.local:9000",
  "diagnosticsLocation": "ftp://example.com/diagnostics",
  "wss": {
    "enabled": false,
    "wssPort": 9001,
    "strictClientCert": false,
    "ocppWsUrl": "wss://ws.cpadmin.local:9001",
    "rsa": { "certFile": "...", "keyFile": "..." },
    "ecdsa": { "certFile": "...", "keyFile": "..." },
    "caFile": ""
  }
}
```

| Parameter | Description |
|---|---|
| `host` | OCPP server listen address |
| `wsPort` | WebSocket (WS) port |
| `strictMode` | OCPP strict mode (message validation) |
| `heartbeatInterval` | Heartbeat interval in seconds (sent to charge points on BootNotification) |
| `autoAddUnknownChargepoints` | Automatically add unknown charge points that connect |
| `pendingUnknownChargepoints` | Put unknown charge points pending admin approval |
| `ocppWsUrl` | OCPP WebSocket URL to communicate (for charge point configuration) |
| `diagnosticsLocation` | Destination URL for diagnostics upload |
| `wss.enabled` | Enable WebSocket Secure (TLS) |
| `wss.strictClientCert` | Require a valid client certificate |
| `wss.rsa` / `ecdsa` | Server certificates for WSS (dual algorithm supported, paths relative to `config/` folder) |
| `wss.caFile` | Certificate authority for client certificate validation (path relative to `config/` folder) |

### Notifications

```json
"notifs": {
  "authRejectThreshold": 3,
  "authRejectWindowMinutes": 5,
  "flapThreshold": 4,
  "flapWindowMinutes": 2,
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
| `mail.enabled` | Enable email notifications |
| `mail.from` | Sender address |
| `mail.transport` | SMTP transport configuration (Nodemailer) |
| `webpush.enabled` | Enable Web Push notifications |
| `webpush.vapid*` | VAPID keys for Web Push (to be generated) |
| `pushover.enabled` | Enable Pushover notifications |

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

## Getting Started

### Production Mode

```bash
npm start
```

### Development Mode (auto-reload)

```bash
npm run dev
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

## Roles and Permissions

The application uses three hierarchical role levels:

### Administrator (`admin`)

Full access to all features:
- Management of all sites, users, and charge points
- Global application configuration
- Approval of pending charge points
- View all transactions and OCPP messages
- Global CSV export
- Can also be a user on one or more sites

### Manager (`manager`)

Management restricted to authorized sites:
- Monitor charge points on assigned sites
- Manage users on assigned sites
- Remote start / stop charging
- View transactions on assigned sites
- CSV export for assigned sites
- Can also be a user on one or more sites

### User (`user`)

Limited access for charging:
- View available connectors on authorized sites
- Start and stop own charging sessions
- View personal transaction history
- Export own transactions to CSV
- Manage notification preferences

---

## OCPP 1.6 Protocol

The application implements the OCPP 1.6-J protocol (JSON over WebSocket) for communication with charge points.

### Supported Operations

#### Charge Point → Server (incoming requests)

| Operation | Description |
|---|---|
| **BootNotification** | Charge point startup notification (manufacturer info, firmware) |
| **Heartbeat** | Periodic heartbeat signal |
| **StatusNotification** | Connector or charge point status change |
| **Authorize** | RFID badge authorization request |
| **StartTransaction** | Charging session start |
| **StopTransaction** | Charging session end (stop reason, energy consumed) |
| **MeterValues** | Real-time metering data (energy, power, current, SOC) |
| **DataTransfer** | Vendor-specific data exchange |
| **DiagnosticsStatusNotification** | Diagnostics upload status |

#### Server → Charge Point (remote commands)

| Operation | Description |
|---|---|
| **RemoteStartTransaction** | Start a charging session remotely |
| **RemoteStopTransaction** | Stop a charging session remotely |
| **GetConfiguration** | Retrieve charge point configuration |
| **ChangeConfiguration** | Modify a configuration parameter |

A generic command interface allows sending any OCPP command through the API.

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

| Profile | Description |
|---|---|
| **Profile 1** | No authentication (unsecured WebSocket) |
| **Profile 2** | Password authentication (Basic Auth in WebSocket handshake) |
| **Profile 3** | TLS client certificate (WebSocket Secure with certificate verification) |

Charge points must be registered and authorized in the application to connect. Unrecognized charge points can be:
- **Rejected** (default behavior)
- **Automatically added** (`autoAddUnknownChargepoints: true`)
- **Put pending** approval (`pendingUnknownChargepoints: true`)

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

#### Manager Events

| Event | Description |
|---|---|
| Charge point online / offline | Connection state change |
| Connector available / unavailable | Connector status change |
| Connector error | Error reported by a connector |
| Repeated authorization rejections | Rejection threshold reached for a badge |
| Transaction started / ended | Charging activity on a site |

#### User Events

| Event | Description |
|---|---|
| Transaction started / ended | My charging session starts or ends |
| Charge suspended (EVSE) | The charge point has suspended charging |

Each user can configure their notification preferences (which events to receive and on which channels) through the application settings.

---

## Logging

The application uses **Winston** with daily file rotation.

| File | Contents | Retention |
|---|---|---|
| `logs/app-YYYY-MM-DD.log` | All logs (based on configured level) | 30 days |
| `logs/error-YYYY-MM-DD.log` | Errors only | 90 days |

Maximum file size: 20 MB.

Predefined logging scopes: `CPADM`, `WEBUI`, `OCPP`, `NOTIF`, `SQLDB`.

In development mode, logs are also displayed in the console with color-coded scopes.

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

# Start in development (auto-reload)
npm run dev

# Check code style
npm run lint

# Auto-fix style issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without modifying
npm run format:check
```

---

## Database

The application uses **SQLite** with **WAL** (Write-Ahead Logging) mode for improved concurrency performance.

Migrations are automatically executed on startup from the `migrations/` folder. The database is created in the `config/` folder with the configured name (default: `cpadmin.db`).

### Main Tables

| Table | Description |
|---|---|
| `sites` | Charging sites |
| `users` | User accounts |
| `user_sites` | User ↔ site association (with role) |
| `chargepoints` | Registered charge points |
| `connectors` | Charge point connectors |
| `chargepoint_config` | Charge point configuration |
| `transactions` | Charging sessions |
| `transactions_values` | Real-time metering data |
| `ocpp_messages` | OCPP message log |
| `users_password_resets` | Password reset tokens |

---

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).

- Full license text: [LICENSE](LICENSE)
- Copyright: [COPYRIGHT](COPYRIGHT)
- Authors: [AUTHORS](AUTHORS)
- Contribution process: [CONTRIBUTING.md](CONTRIBUTING.md)

Any modified version deployed as a network service must provide its corresponding source code under AGPL-3.0-only.