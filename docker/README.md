# Docker Deployment

Four Docker Compose files are available in the `docker/` folder.
Choose the one that matches your infrastructure.

> **🇫🇷 [Version française](README.fr.md)**

---

## Available Files

| File | Use Case |
|---|---|
| `docker-compose.http.yml` | Simple deployment, HTTP only |
| `docker-compose.https.yml` | Simple deployment, HTTPS/WSS managed by the app |
| `docker-compose.yml` | Full stack with Traefik (HTTPS) + FTP |
| `docker-compose.tls.yml` | Full stack with Traefik, HTTPS + WSS passthrough |

---

### `docker-compose.http.yml` — App Only (HTTP + WS)

The simplest setup. The application is exposed directly without a reverse proxy.

- **Port 3000**: web interface (HTTP)
- **Port 9000**: OCPP WebSocket server

```bash
docker compose -f docker/docker-compose.http.yml up -d
```

> Suitable for internal use, development, or when an external reverse proxy is already in place.

---

### `docker-compose.https.yml` — App Only (HTTPS + WSS)

The application handles TLS itself. Certificates must be placed in the `config` volume, under the `certs/` folder (as defined in `config.json`).

- **Port 3001**: web interface (HTTPS)
- **Port 9001**: OCPP WebSocket Secure server

```bash
docker compose -f docker/docker-compose.https.yml up -d
```

**Prerequisites:**
- Enable `webui.https.enabled` and/or `ocpp.wss.enabled` in `config.json`
- Place certificates in `config/certs/`

---

### `docker-compose.yml` — Traefik + FTP (HTTPS, TLS Termination)

Full stack with three services:

| Service | Role |
|---|---|
| **Traefik** | Reverse proxy, HTTPS (Let's Encrypt) + WSS on port 443 |
| **ocpp-cp-admin** | Application (HTTP + WS internally) |
| **FTP** | FTP server for charge point diagnostics retrieval |

**Traefik Routing:**
- `http://cpadmin.local` → redirect to HTTPS
- `https://cpadmin.local` → web interface (TLS terminated by Traefik)
- `ws://ws.cpadmin.local` (port 80) → OCPP WebSocket (charge points without TLS)
- `wss://ws.cpadmin.local` (port 443) → OCPP WebSocket (TLS terminated by Traefik)

```bash
docker compose -f docker/docker-compose.yml up -d
```

> The app does not handle TLS — Traefik takes care of it via Let's Encrypt.

---

### `docker-compose.tls.yml` — Traefik + FTP (HTTPS + WSS Passthrough)

Fully secured version. Traefik handles HTTPS for the web interface (Let's Encrypt) and performs **TCP passthrough** for OCPP WSS, allowing the app to manage client certificate authentication.

| Service | Role |
|---|---|
| **Traefik** | HTTPS reverse proxy (Let's Encrypt) + TCP passthrough WSS |
| **ocpp-cp-admin** | Application (OCPP WSS managed internally) |
| **FTP** | FTP server for diagnostics |

**Routing:**
- `https://cpadmin.local` (port 443) → web interface (TLS terminated by Traefik)
- `http://cpadmin.local` (port 80) → automatic redirect to HTTPS
- `ws://ws.cpadmin.local` (port 80) → OCPP WS (charge points without TLS)
- `wss://ws.cpadmin.local` (port 9001) → OCPP WSS (TLS passthrough to the app)

```bash
docker compose -f docker/docker-compose.tls.yml up -d
```

**Prerequisites:**
- Enable `ocpp.wss.enabled` in `config.json`
- Place OCPP certificates (RSA/ECDSA) in `config/certs/`
- Update the ACME email in the compose file (`admin@cpadmin.local`)

> Required if charge points use OCPP **Security Profile 3** (client certificate authentication).

---

## Mounted Volume Permissions

The entrypoint runs as root to seed default files into empty volumes (`config/`, `public/img/`) and fix their ownership. It then drops privileges to a dedicated non-root user (`app`, UID 1000) via `su-exec` before starting the application.

This means volume permissions are handled automatically — no manual `chown` is required on the host.

---

## Environment Variables

Values from `config.json` can be overridden by environment variables (the JSON file is not modified).

### Deployment / URLs

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_PUBLIC_URL` | `webui.publicUrl` | `https://cpadmin.example.com` |
| `CPADMIN_HTTP_HOST` | `webui.httpHost` | `0.0.0.0` |
| `CPADMIN_TRUST_PROXY` | `webui.trustProxy` | `true` (required behind a reverse proxy) |
| `CPADMIN_OCPP_WS_URL` | `ocpp.ocppWsUrl` | `ws://ws.example.com` |
| `CPADMIN_OCPP_WSS_URL` | `ocpp.wss.ocppWsUrl` | `wss://ws.example.com:9001` |
| `CPADMIN_DIAGNOSTICS_URL` | `ocpp.diagnosticsLocation` | `ftp://ftp.example.com` |
| `CPADMIN_SESSION_SECRET` | `webui.sessionSecret` | |

### General Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_LOGLEVEL` | `loglevel` | `debug`, `info`, `error` |
| `CPADMIN_LANGUAGE` | `language` | Any locale code from `locales/` folder (e.g. `fr`, `en`) |
| `CPADMIN_CPO_NAME` | `cpoName` | `My CPO` |

### OCPP Behavior

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_OCPP_STRICT_MODE` | `ocpp.strictMode` | `false` (disable strict OCPP 1.6 validation) |
| `CPADMIN_OCPP_AUTO_ADD` | `ocpp.autoAddUnknownChargepoints` | `true` (auto-register unknown charge points) |
| `CPADMIN_OCPP_PENDING_UNKNOWN` | `ocpp.pendingUnknownChargepoints` | `true` (queue unknown charge points for approval) |

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

### Google Auth Configuration

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_GOOGLE_AUTH_ENABLED` | `auth.google.enabled` | `true` |
| `CPADMIN_GOOGLE_CLIENT_ID` | `auth.google.client_id` | |
| `CPADMIN_GOOGLE_CLIENT_SECRET` | `auth.google.client_secret` | |

> Booleans (`true`/`false`) and numbers are automatically converted.
> Secrets are always treated as strings.

---

## Volumes

| Volume | Contents |
|---|---|
| `config` | Configuration (`config.json`) and certificates (`certs/`) |
| `logs` | Log files |
| `public-img` | Web interface static images |
| `locales-custom` | Custom locale files (add or override translations) |
| `ftp-data` | Retrieved diagnostics files (FTP-based composes) |
| `letsencrypt` | ACME Let's Encrypt certificates (TLS compose) |

### Adding a Custom Locale (Docker)

Built-in locales (`en`, `fr`) are embedded in the image and updated with each release. To add a new language or override existing translations, place `.json` files in the `locales-custom` volume:

```bash
# Copy the volume mount point (find the actual path with docker volume inspect)
docker cp my-de.json ocpp-cp-admin:/app/locales-custom/de.json
docker restart ocpp-cp-admin
```

Custom files are **merged on top** of built-in locales:
- A file with an existing locale code (e.g. `fr.json`) overrides specific keys, keeping the rest intact.
- A file with a new code (e.g. `de.json`) registers the language.