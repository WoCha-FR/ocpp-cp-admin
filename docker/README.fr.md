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
| `docker-compose.yml` | Stack complète avec Traefik (HTTPS, TLS termination) + FTP |
| `docker-compose.tls.yml` | Stack complète avec Traefik, HTTPS + WSS passthrough + export des certs |

---

### `docker-compose.http.yml` — App seule (HTTP + WS)

Le plus simple. L'application est exposée directement sans reverse proxy.

- **Port 3000** : interface web (HTTP)
- **Port 9000** : serveur OCPP WebSocket

```bash
docker compose -f docker/docker-compose.http.yml up -d
```

> Adapté pour un usage interne, du développement, ou si un reverse proxy externe est déjà en place.

**Variables à adapter avant le démarrage :**

| Variable / Valeur | Rôle | Obligatoire |
|---|---|---|
| `CPADMIN_PUBLIC_URL=http://localhost:3000` | URL publique de l'interface (liens dans les notifications) | Oui |
| `CPADMIN_OCPP_WS_URL=ws://localhost:9000` | URL WebSocket OCPP communiquée aux bornes | Oui |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ocpp:changeme@localhost` | URL FTP pour les diagnostics — adapter l'hôte et les identifiants | Oui |
| `CPADMIN_SESSION_SECRET=change-me-in-production` | Secret de signature des sessions — utiliser au moins 32 caractères aléatoires | Oui |
| FTP `USERS=ocpp\|changeme` | Identifiants FTP (utilisateur et mot de passe) | Oui |
| FTP `ADDRESS=localhost` | Adresse externe utilisée par les bornes en mode passif FTP | Oui |

---

### `docker-compose.https.yml` — App seule (HTTPS + WSS)

L'application gère elle-même le TLS. Les certificats sont obtenus via **Let's Encrypt** (certbot standalone) et automatiquement déposés dans `./data/config/certs/`.

- **Port 3001** : interface web (HTTPS)
- **Port 9000** : OCPP WebSocket non chiffré (Security Profile 1)
- **Port 9001** : OCPP WebSocket Secure (TLS géré par l'app, Security Profile 2/3)

**Premier démarrage — obtenir les certificats avant de lancer le reste de la stack :**

```bash
docker compose -f docker/docker-compose.https.yml up certbot
# Attendre le message "[certbot] Certificates deployed." puis :
docker compose -f docker/docker-compose.https.yml up -d
```

**Variables à adapter avant le démarrage :**

| Variable / Valeur | Rôle | Obligatoire |
|---|---|---|
| `CERTBOT_DOMAIN=cpadmin.example.com` | Domaine pour le certificat Let's Encrypt — doit être accessible publiquement | Oui |
| `CERTBOT_EMAIL=admin@example.com` | E-mail pour les alertes d'expiration Let's Encrypt | Oui |
| `CPADMIN_PUBLIC_URL=https://cpadmin.example.com` | URL HTTPS publique de l'interface | Oui |
| `CPADMIN_OCPP_WS_URL=ws://cpadmin.example.com:9000` | URL OCPP WS (bornes sans TLS) | Oui |
| `CPADMIN_OCPP_WSS_URL=wss://cpadmin.example.com:9001` | URL OCPP WSS (bornes avec TLS) | Oui |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ocpp:changeme@cpadmin.example.com` | URL FTP pour les diagnostics — adapter l'hôte et les identifiants | Oui |
| `CPADMIN_SESSION_SECRET=change-me-in-production` | Secret de signature des sessions — utiliser au moins 32 caractères aléatoires | Oui |
| FTP `USERS=ocpp\|changeme` | Identifiants FTP | Oui |
| FTP `ADDRESS=cpadmin.example.com` | Adresse externe pour le mode passif FTP | Oui |

**Prérequis :**
- Le port 80 doit être accessible publiquement pour le challenge ACME HTTP
- Activer `webui.https.enabled` et/ou `ocpp.wss.enabled` dans `config.json`

---

### `docker-compose.yml` — Traefik + FTP (HTTPS, TLS termination)

Stack complète avec trois services :

| Service | Rôle |
|---|---|
| **Traefik** | Reverse proxy, HTTPS (Let's Encrypt via TLS challenge) + WSS sur le port 443 |
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

**Variables à adapter avant le démarrage :**

| Variable / Valeur | Rôle | Obligatoire |
|---|---|---|
| `admin@cpadmin.local` (email ACME dans `command:`) | E-mail pour les alertes d'expiration Let's Encrypt | Oui |
| `cpadmin.local` (labels Traefik) | Domaine de l'interface web | Oui |
| `ws.cpadmin.local` (labels Traefik) | Domaine du point d'entrée WebSocket OCPP | Oui |
| `CPADMIN_PUBLIC_URL=https://cpadmin.local` | URL HTTPS publique de l'interface | Oui |
| `CPADMIN_OCPP_WS_URL=ws://ws.cpadmin.local` | URL OCPP WS communiquée aux bornes | Oui |
| `CPADMIN_OCPP_WSS_URL=wss://ws.cpadmin.local` | URL OCPP WSS communiquée aux bornes | Oui |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ftp.cpadmin.local` | URL FTP pour les diagnostics | Oui |
| `CPADMIN_SESSION_SECRET=change-me-with-a-random-secret` | Secret de signature des sessions — utiliser au moins 32 caractères aléatoires | Oui |
| FTP `USERS=ocpp\|changeme` | Identifiants FTP | Oui |
| FTP `ADDRESS=ftp.cpadmin.local` | Adresse externe pour le mode passif FTP | Oui |

---

### `docker-compose.tls.yml` — Traefik + FTP (HTTPS + WSS passthrough)

Version sécurisée complète. Traefik gère le HTTPS pour l'interface web (Let's Encrypt) et fait du **TCP passthrough** pour le WSS OCPP, permettant à l'app de gérer le TLS et l'authentification par certificat client (Security Profile 3).

Traefik génère **deux certificats** (RSA2048 + ECDSA P-256) via Let's Encrypt. Ils sont automatiquement extraits vers `./data/config/certs/` par deux services `cert-dumper` dédiés.

| Service | Rôle |
|---|---|
| **Traefik** | Reverse proxy HTTPS (Let's Encrypt, RSA + ECDSA) + TCP passthrough WSS |
| **cert-dumper-rsa** | Surveille `acme-rsa.json` et copie les certs RSA dans `./data/config/certs/` |
| **cert-dumper-ecdsa** | Surveille `acme-ecdsa.json` et copie les certs ECDSA dans `./data/config/certs/` |
| **cert-init** | One-shot : génère une CA locale + certificat client partagé (`client.pem`) dans `./data/config/certs/` — ignoré si les fichiers existent déjà |
| **ocpp-cp-admin** | Application (OCPP WSS géré en interne) |
| **FTP** | Serveur FTP pour les diagnostics |

**Routage :**
- `https://cpadmin.local` (port 443) → interface web (TLS terminé par Traefik)
- `http://cpadmin.local` (port 80) → redirection automatique vers HTTPS
- `ws://ws.cpadmin.local` (port 80) → OCPP WS (bornes sans TLS)
- `wss://ws.cpadmin.local` (port 9001) → OCPP WSS (TCP passthrough — TLS géré par l'app)

```bash
docker compose -f docker/docker-compose.tls.yml up -d
```

**Variables à adapter avant le démarrage :**

| Variable / Valeur | Rôle | Obligatoire |
|---|---|---|
| `admin@cpadmin.local` (email ACME, répété pour les resolvers RSA et ECDSA) | E-mail pour les alertes d'expiration Let's Encrypt | Oui |
| `cpadmin.local` (labels Traefik) | Domaine de l'interface web | Oui |
| `ws.cpadmin.local` (labels Traefik) | Domaine du point d'entrée WebSocket OCPP | Oui |
| `CPADMIN_PUBLIC_URL=https://cpadmin.local` | URL HTTPS publique de l'interface | Oui |
| `CPADMIN_OCPP_WS_URL=ws://ws.cpadmin.local` | URL OCPP WS (bornes sans TLS) | Oui |
| `CPADMIN_OCPP_WSS_URL=wss://ws.cpadmin.local` | URL OCPP WSS (bornes avec TLS, Security Profile 2/3) | Oui |
| `CPADMIN_DIAGNOSTICS_URL=ftp://ftp.cpadmin.local` | URL FTP pour les diagnostics | Oui |
| FTP `USERS=ocpp\|changeme` | Identifiants FTP | Oui |
| FTP `ADDRESS=ftp.cpadmin.local` | Adresse externe pour le mode passif FTP | Oui |

**Prérequis :**
- Activer `ocpp.wss.enabled` dans `config.json`
- Les cert-dumpers alimentent automatiquement `./data/config/certs/` avec `rsa-server.crt`, `rsa-server.key`, `ecdsa-server.crt`, `ecdsa-server.key` — aucune manipulation manuelle de certificats n'est nécessaire

**Security Profile 3 — authentification par certificat client :**

Au premier `docker compose up`, `cert-init` génère automatiquement dans `./data/config/certs/` :
- `ca.key` / `ca.crt` — CA locale (validité : 10 ans)
- `client.key` / `client.crt` / `client.pem` — certificat partagé par toutes les bornes (validité : 1 an)

Pour activer le Security Profile 3, ajouter dans `config.json` et redémarrer :

```json
"wss": {
  "strictClientCert": true,
  "caFile": "certs/ca.crt"
}
```

Déposer ensuite `./data/config/certs/client.pem` (contient certificat + clé privée) sur chaque borne.

> `cert-init` est idempotent : les fichiers déjà présents ne sont jamais écrasés. Pour renouveler le certificat client, supprimer `client.pem` et relancer la stack.

---

## Permissions des volumes montés

L'entrypoint s'exécute en root pour copier les fichiers par défaut dans les volumes vides (`config/`, `public/img/`) et corriger leurs permissions. Il bascule ensuite vers un utilisateur non-root dédié (`app`, UID 1000) via `su-exec` avant de lancer l'application.

Les permissions des volumes sont donc gérées automatiquement — aucun `chown` manuel n'est nécessaire côté hôte.

---

## Structure du dossier de données

Tous les composes utilisent des **bind mounts** sous un dossier `./data/`, relatif à l'emplacement du fichier compose. Vos données sont ainsi directement accessibles sur le système hôte.

```
./data/
├── config/            # config.json + certificats (certs/)
├── logs/              # fichiers de logs applicatifs
├── ftp/               # fichiers de diagnostics FTP (sous-dossier ocpp/)
├── public-img/        # images statiques personnalisées (optionnel, décommenter dans le compose)
├── locales-custom/    # fichiers de locale personnalisés (optionnel, décommenter dans le compose)
└── letsencrypt/       # fichiers ACME Traefik (docker-compose.tls.yml uniquement)
```

> Le volume nommé Docker `letsencrypt` n'est utilisé que dans `docker-compose.yml` (géré par Docker, non accessible directement sur l'hôte).

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
| `LOG_CONSOLE` | *(pas d'équivalent JSON)* | `true` — force l'affichage des logs en console (utile pour déboguer temporairement en production) |
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

### Métriques Prometheus

| Variable | Config JSON | Exemple |
|---|---|---|
| `CPADMIN_METRICS_TOKEN` | `metrics.bearerToken` | `mon-token-secret` |

> Si non défini, `/metrics` est accessible sans authentification (adapté aux réseaux privés/Docker).

> Les booléens (`true`/`false`) et les nombres sont convertis automatiquement.
> Les secrets sont toujours traités comme des chaînes de caractères.

---

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
