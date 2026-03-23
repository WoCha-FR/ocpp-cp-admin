# Déploiement Docker

Quatre fichiers Docker Compose sont disponibles dans le dossier `docker/`.
Choisissez celui qui correspond à votre infrastructure.

> **🇬🇧 [English version](README.md)**

---

## Fichiers disponibles

| Fichier | Cas d'usage |
|---|---|
| `docker-compose.http.yml` | Déploiement simple, HTTP uniquement |
| `docker-compose.https.yml` | Déploiement simple, HTTPS/WSS géré par l'app |
| `docker-compose.yml` | Stack complète avec Traefik (HTTPS) + FTP |
| `docker-compose.tls.yml` | Stack complète avec Traefik, HTTPS + WSS passthrough |

---

### `docker-compose.http.yml` — App seule (HTTP + WS)

Le plus simple. L'application est exposée directement sans reverse proxy.

- **Port 3000** : interface web (HTTP)
- **Port 9000** : serveur OCPP WebSocket

```bash
docker compose -f docker/docker-compose.http.yml up -d
```

> Adapté pour un usage interne, du développement, ou si un reverse proxy externe est déjà en place.

---

### `docker-compose.https.yml` — App seule (HTTPS + WSS)

L'application gère elle-même le TLS. Les certificats doivent être placés dans le volume `config`, sous le dossier `certs/` (conformément aux chemins définis dans `config.json`).

- **Port 3001** : interface web (HTTPS)
- **Port 9001** : serveur OCPP WebSocket Secure

```bash
docker compose -f docker/docker-compose.https.yml up -d
```

**Prérequis :**
- Activer `webui.https.enabled` et/ou `ocpp.wss.enabled` dans `config.json`
- Placer les certificats dans `config/certs/`

---

### `docker-compose.yml` — Traefik + FTP (HTTPS, TLS termination)

Stack complète avec trois services :

| Service | Rôle |
|---|---|
| **Traefik** | Reverse proxy, HTTPS (Let's Encrypt) + WSS sur le port 443 |
| **ocpp-cp-admin** | Application (HTTP + WS en interne) |
| **FTP** | Serveur FTP pour la récupération des diagnostics de bornes |

**Routage Traefik :**
- `http://cpadmin.local` → redirection vers HTTPS
- `https://cpadmin.local` → interface web (TLS terminé par Traefik)
- `ws://ws.cpadmin.local` (port 80) → OCPP WebSocket (bornes sans TLS)
- `wss://ws.cpadmin.local` (port 443) → OCPP WebSocket (TLS terminé par Traefik)

```bash
docker compose -f docker/docker-compose.yml up -d
```

> L'app ne gère pas le TLS — Traefik s'en charge via Let's Encrypt.

---

### `docker-compose.tls.yml` — Traefik + FTP (HTTPS + WSS passthrough)

Version sécurisée complète. Traefik gère le HTTPS pour l'interface web (Let's Encrypt) et fait du **TCP passthrough** pour le WSS OCPP, permettant à l'app de gérer l'authentification par certificat client.

| Service | Rôle |
|---|---|
| **Traefik** | Reverse proxy HTTPS (Let's Encrypt) + TCP passthrough WSS |
| **ocpp-cp-admin** | Application (OCPP WSS géré en interne) |
| **FTP** | Serveur FTP pour les diagnostics |

**Routage :**
- `https://cpadmin.local` (port 443) → interface web (TLS terminé par Traefik)
- `http://cpadmin.local` (port 80) → redirection automatique vers HTTPS
- `ws://ws.cpadmin.local` (port 80) → OCPP WS (bornes sans TLS)
- `wss://ws.cpadmin.local` (port 9001) → OCPP WSS (TLS passthrough vers l'app)

```bash
docker compose -f docker/docker-compose.tls.yml up -d
```

**Prérequis :**
- Activer `ocpp.wss.enabled` dans `config.json`
- Placer les certificats OCPP (RSA/ECDSA) dans `config/certs/`
- Adapter l'email ACME dans le compose (`admin@cpadmin.local`)

> Nécessaire si des bornes utilisent le **Security Profile 3** OCPP (authentification par certificat client).

---

## Permissions des volumes montés

L'entrypoint s'exécute en root pour copier les fichiers par défaut dans les volumes vides (`config/`, `public/img/`) et corriger leurs permissions. Il bascule ensuite vers un utilisateur non-root dédié (`app`, UID 1000) via `su-exec` avant de lancer l'application.

Les permissions des volumes sont donc gérées automatiquement — aucun `chown` manuel n'est nécessaire côté hôte.

---

## Variables d'environnement

Les valeurs de `config.json` peuvent être surchargées par variables d'environnement (le fichier JSON n'est pas modifié).

### Déploiement / URLs

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_PUBLIC_URL` | `webui.publicUrl` | `https://cpadmin.example.com` |
| `CPADMIN_HTTP_HOST` | `webui.httpHost` | `0.0.0.0` |
| `CPADMIN_TRUST_PROXY` | `webui.trustProxy` | `true` (requis derrière un reverse proxy) |
| `CPADMIN_OCPP_WS_URL` | `ocpp.ocppWsUrl` | `ws://ws.example.com` |
| `CPADMIN_OCPP_WSS_URL` | `ocpp.wss.ocppWsUrl` | `wss://ws.example.com:9001` |
| `CPADMIN_DIAGNOSTICS_URL` | `ocpp.diagnosticsLocation` | `ftp://ftp.example.com` |
| `CPADMIN_SESSION_SECRET` | `webui.sessionSecret` | |

### Configuration générale

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_LOGLEVEL` | `loglevel` | `debug`, `info`, `error` |
| `CPADMIN_LANGUAGE` | `language` | Tout code locale du dossier `locales/` (ex. `fr`, `en`) |
| `CPADMIN_CPO_NAME` | `cpoName` | `Mon CPO` |

### Comportement OCPP

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_OCPP_STRICT_MODE` | `ocpp.strictMode` | `false` (désactiver la validation stricte OCPP 1.6) |
| `CPADMIN_OCPP_AUTO_ADD` | `ocpp.autoAddUnknownChargepoints` | `true` (enregistrer automatiquement les bornes inconnues) |
| `CPADMIN_OCPP_PENDING_UNKNOWN` | `ocpp.pendingUnknownChargepoints` | `true` (mettre les bornes inconnues en attente d'approbation) |

### Configuration mail

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_MAIL_ENABLED` | `notifs.mail.enabled` | `true` |
| `CPADMIN_MAIL_FROM` | `notifs.mail.from` | `CPADMIN <noreply@example.com>` |
| `CPADMIN_MAIL_HOST` | `notifs.mail.transport.host` | |
| `CPADMIN_MAIL_PORT` | `notifs.mail.transport.port` | |
| `CPADMIN_MAIL_USER` | `notifs.mail.transport.auth.user` | |
| `CPADMIN_MAIL_PASS` | `notifs.mail.transport.auth.pass` | |
| `CPADMIN_MAIL_SECURE` | `notifs.mail.transport.secure` | `true` (SSL/TLS dès la connexion) |

### Configuration WebPush

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_WEBPUSH_ENABLED` | `notifs.webpush.enabled` | `true` |
| `CPADMIN_VAPID_PUBLIC_KEY` | `notifs.webpush.vapidPublicKey` | |
| `CPADMIN_VAPID_PRIVATE_KEY` | `notifs.webpush.vapidPrivateKey` | |
| `CPADMIN_VAPID_SUBJECT` | `notifs.webpush.vapidSubject` | `mailto:admin@example.com` |

### Configuration Pushover

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_PUSHOVER_ENABLED` | `notifs.pushover.enabled` | `true` |

### Configuration Google Auth

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_GOOGLE_AUTH_ENABLED` | `auth.google.enabled` | `true` |
| `CPADMIN_GOOGLE_CLIENT_ID` | `auth.google.client_id` | |
| `CPADMIN_GOOGLE_CLIENT_SECRET` | `auth.google.client_secret` | |

> Les booléens (`true`/`false`) et les nombres sont convertis automatiquement.
> Les secrets sont toujours traités comme des chaînes de caractères.

---

## Volumes

| Volume | Contenu |
|---|---|
| `config` | Configuration (`config.json`) et certificats (`certs/`) |
| `logs` | Fichiers de logs |
| `public-img` | Images statiques de l'interface |
| `locales-custom` | Fichiers de locale personnalisés (ajout ou surcharge de traductions) |
| `ftp-data` | Fichiers de diagnostics récupérés (composes avec FTP) |
| `letsencrypt` | Certificats ACME Let's Encrypt (compose TLS) |

### Ajouter une locale personnalisée (Docker)

Les locales intégrées (`en`, `fr`) font partie de l'image et sont mises à jour à chaque nouvelle version. Pour ajouter une nouvelle langue ou surcharger des traductions existantes, placez des fichiers `.json` dans le volume `locales-custom` :

```bash
# Copier un fichier de locale dans le conteneur
docker cp mon-de.json ocpp-cp-admin:/app/locales-custom/de.json
docker restart ocpp-cp-admin
```

Les fichiers personnalisés sont **fusionnés par-dessus** les locales intégrées :
- Un fichier avec un code existant (ex. `fr.json`) surcharge uniquement les clés présentes, le reste est conservé.
- Un fichier avec un nouveau code (ex. `de.json`) enregistre la langue comme disponible.
