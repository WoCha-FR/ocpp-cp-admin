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
| `docker-compose.yml` | Full stack with Traefik (HTTPS, TLS termination) + FTP |
| `docker-compose.tls.yml` | Full stack with Traefik, HTTPS + WSS passthrough + cert export |

---

### `docker-compose.http.yml` — App Only (HTTP + WS)

The simplest setup. The application is exposed directly without a reverse proxy.

- **Port 3000**: web interface (HTTP)
- **Port 9000**: OCPP WebSocket server

```bash
docker compose -f docker/docker-compose.http.yml up -d
```

> Suitable for internal use, development, or when an external reverse proxy is already in place.

**Variables to replace before starting:**

| Variable / Value | Role | Mandatory |
|---|---|---|
| `CPADMIN_PUBLIC_URL=http://localhost:3000` | Public URL of the web interface (used in notification links) | Yes |
| `CPADMIN_OCPP_WS_URL=ws://localhost:9000` | OCPP WebSocket URL given to charge points | Yes |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ocpp:changeme@localhost` | FTP URL where charge points send diagnostics — adapt host and credentials | Yes |
| `CPADMIN_SESSION_SECRET=change-me-in-production` | Session signing secret — use at least 32 random characters | Yes |
| FTP `USERS=ocpp\|changeme` | FTP username and password | Yes |
| FTP `ADDRESS=localhost` | External address used by charge points in FTP passive mode | Yes |

---

### `docker-compose.https.yml` — App Only (HTTPS + WSS)

The application handles TLS itself. Certificates are obtained via **Let's Encrypt** (certbot standalone) and automatically deployed to `./data/config/certs/`.

- **Port 3001**: web interface (HTTPS)
- **Port 9000**: OCPP WebSocket (unencrypted, Security Profile 1)
- **Port 9001**: OCPP WebSocket Secure (TLS managed by the app, Security Profile 2/3)

**First start — obtain certificates before launching the full stack:**

```bash
docker compose -f docker/docker-compose.https.yml up certbot
# Wait for "[certbot] Certificates deployed." then:
docker compose -f docker/docker-compose.https.yml up -d
```

**Variables to replace before starting:**

| Variable / Value | Role | Mandatory |
|---|---|---|
| `CERTBOT_DOMAIN=cpadmin.example.com` | Domain for Let's Encrypt certificate — must be publicly reachable | Yes |
| `CERTBOT_EMAIL=admin@example.com` | Email for Let's Encrypt expiry alerts | Yes |
| `CPADMIN_PUBLIC_URL=https://cpadmin.example.com` | Public HTTPS URL of the web interface | Yes |
| `CPADMIN_OCPP_WS_URL=ws://cpadmin.example.com:9000` | OCPP WS URL (charge points without TLS) | Yes |
| `CPADMIN_OCPP_WSS_URL=wss://cpadmin.example.com:9001` | OCPP WSS URL (charge points with TLS) | Yes |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ocpp:changeme@cpadmin.example.com` | FTP URL for diagnostics — adapt host and credentials | Yes |
| `CPADMIN_SESSION_SECRET=change-me-in-production` | Session signing secret — use at least 32 random characters | Yes |
| FTP `USERS=ocpp\|changeme` | FTP username and password | Yes |
| FTP `ADDRESS=cpadmin.example.com` | External address for FTP passive mode | Yes |

**Prerequisites:**
- Port 80 must be publicly reachable for the ACME HTTP challenge
- `CPADMIN_WEBUI_HTTPS_ENABLED=true` and `CPADMIN_OCPP_WSS_ENABLED=true` are already set in the compose file — no manual `config.json` changes needed

---

### `docker-compose.yml` — Traefik + FTP (HTTPS, TLS Termination)

Full stack with three services:

| Service | Role |
|---|---|
| **Traefik** | Reverse proxy, HTTPS (Let's Encrypt via TLS challenge) + WSS on port 443 |
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

**Variables to replace before starting:**

| Variable / Value | Role | Mandatory |
|---|---|---|
| `admin@cpadmin.local` (ACME email in `command:`) | Email for Let's Encrypt expiry alerts | Yes |
| `cpadmin.local` (all Traefik labels) | Domain of the web interface | Yes |
| `ws.cpadmin.local` (all Traefik labels) | Domain of the OCPP WebSocket endpoint | Yes |
| `CPADMIN_PUBLIC_URL=https://cpadmin.local` | Public HTTPS URL of the web interface | Yes |
| `CPADMIN_OCPP_WS_URL=ws://ws.cpadmin.local` | OCPP WS URL given to charge points | Yes |
| `CPADMIN_OCPP_WSS_URL=wss://ws.cpadmin.local` | OCPP WSS URL given to charge points | Yes |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ftp.cpadmin.local` | FTP URL for diagnostics | Yes |
| `CPADMIN_SESSION_SECRET=change-me-with-a-random-secret` | Session signing secret — use at least 32 random characters | Yes |
| FTP `USERS=ocpp\|changeme` | FTP username and password | Yes |
| FTP `ADDRESS=ftp.cpadmin.local` | External address for FTP passive mode | Yes |

---

### `docker-compose.tls.yml` — Traefik + FTP (HTTPS + WSS Passthrough)

Fully secured version. Traefik handles HTTPS for the web interface (Let's Encrypt) and performs **TCP passthrough** for OCPP WSS, allowing the app to manage TLS and client certificate authentication (Security Profile 3).

Traefik generates **two certificates** (RSA2048 + ECDSA P-256) via Let's Encrypt. They are automatically extracted to `./data/config/certs/` by two dedicated `cert-dumper` services.

| Service | Role |
|---|---|
| **Traefik** | HTTPS reverse proxy (Let's Encrypt, RSA + ECDSA) + TCP passthrough WSS |
| **cert-dumper-rsa** | Watches `acme-rsa.json` and copies RSA certs to `./data/config/certs/` |
| **cert-dumper-ecdsa** | Watches `acme-ecdsa.json` and copies ECDSA certs to `./data/config/certs/` |
| **cert-init** | One-shot: generates a local CA + shared client certificate (`client.pem`) in `./data/config/certs/` — skipped on subsequent starts if files already exist |
| **ocpp-cp-admin** | Application (OCPP WSS managed internally) |
| **FTP** | FTP server for diagnostics |

**Routing:**
- `https://cpadmin.local` (port 443) → web interface (TLS terminated by Traefik)
- `http://cpadmin.local` (port 80) → automatic redirect to HTTPS
- `ws://ws.cpadmin.local` (port 80) → OCPP WS (charge points without TLS)
- `wss://ws.cpadmin.local` (port 9001) → OCPP WSS (TCP passthrough — TLS managed by the app)

```bash
docker compose -f docker/docker-compose.tls.yml up -d
```

**Variables to replace before starting:**

| Variable / Value | Role | Mandatory |
|---|---|---|
| `admin@cpadmin.local` (ACME email, repeated for RSA and ECDSA resolvers) | Email for Let's Encrypt expiry alerts | Yes |
| `cpadmin.local` (all Traefik labels) | Domain of the web interface | Yes |
| `ws.cpadmin.local` (all Traefik labels) | Domain of the OCPP WebSocket endpoint | Yes |
| `CPADMIN_PUBLIC_URL=https://cpadmin.local` | Public HTTPS URL of the web interface | Yes |
| `CPADMIN_OCPP_WS_URL=ws://ws.cpadmin.local` | OCPP WS URL (charge points without TLS) | Yes |
| `CPADMIN_OCPP_WSS_URL=wss://ws.cpadmin.local` | OCPP WSS URL (charge points with TLS, Security Profile 2/3) | Yes |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ftp.cpadmin.local` | FTP URL for diagnostics | Yes |
| FTP `USERS=ocpp\|changeme` | FTP username and password | Yes |
| FTP `ADDRESS=ftp.cpadmin.local` | External address for FTP passive mode | Yes |

**Prerequisites:**
- `CPADMIN_OCPP_WSS_ENABLED=true` is already set in the compose file — no manual `config.json` changes needed
- The cert-dumpers automatically populate `./data/config/certs/` with `rsa-server.crt`, `rsa-server.key`, `ecdsa-server.crt`, `ecdsa-server.key` — no manual certificate handling required

**Security Profile 3 — client certificate authentication:**

On first `docker compose up`, `cert-init` automatically generates in `./data/config/certs/`:
- `ca.key` / `ca.crt` — local CA (validity: 10 years)
- `client.key` / `client.crt` / `client.pem` — single shared certificate for all charge points (validity: 1 year)

To activate Security Profile 3, add the following to `config.json` and restart:

```json
"wss": {
  "strictClientCert": true,
  "caFile": "certs/ca.crt"
}
```

Then deploy `./data/config/certs/client.pem` (contains certificate + private key) to each charge point.

> `cert-init` is idempotent: files already present are never overwritten. To renew the client certificate, delete `client.pem` and restart the stack.

---

## Mounted Volume Permissions

The entrypoint runs as root to seed default files into empty volumes (`config/`, `public/img/`) and fix their ownership. It then drops privileges to a dedicated non-root user (`app`, UID 1000) via `su-exec` before starting the application.

This means volume permissions are handled automatically — no manual `chown` is required on the host.

---

## Data Directory Structure

All compose files use **bind mounts** under a `./data/` directory, relative to the compose file location. This makes your data directly accessible on the host filesystem.

```
./data/
├── config/            # config.json + certificates (certs/)
├── logs/              # application log files
├── ftp/               # FTP diagnostics files (ocpp/ subfolder)
├── public-img/        # custom static images (optional, uncomment in compose)
├── locales-custom/    # custom locale files (optional, uncomment in compose)
└── letsencrypt/       # Traefik ACME files (docker-compose.tls.yml only)
```

> The `letsencrypt` named Docker volume is only used in `docker-compose.yml` (managed by Docker, not accessible directly on the host).

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
| `CPADMIN_OCPP_STRICT_MODE` | `ocpp.strictMode` | `false` (disable strict OCPP 1.6 validation) |
| `CPADMIN_OCPP_CALL_TIMEOUT` | `ocpp.callTimeoutSeconds` | `45` |
| `CPADMIN_OCPP_AUTO_ADD` | `ocpp.autoAddUnknownChargepoints` | `true` (auto-register unknown charge points) |
| `CPADMIN_OCPP_PENDING_UNKNOWN` | `ocpp.pendingUnknownChargepoints` | `true` (queue unknown charge points for approval) |
| `CPADMIN_OCPP_V16_ENABLED` | `ocpp.v16.enabled` | `false` (disable OCPP 1.6 support) |
| `CPADMIN_OCPP_V201_ENABLED` | `ocpp.v201.enabled` | `true` (enable OCPP 2.0.1 support — in development) |

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

### Prometheus Metrics

| Variable | JSON Config | Example |
|---|---|---|
| `CPADMIN_METRICS_TOKEN` | `metrics.bearerToken` | `my-secret-token` |

> If not set, `/metrics` is accessible without authentication (suitable for private/Docker networks).

> Booleans (`true`/`false`) and numbers are automatically converted.
> Secrets are always treated as strings.

---

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
