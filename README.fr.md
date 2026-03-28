# OCPP CP Admin

**Système de gestion de bornes de recharge (CSMS)** pour opérateurs de charge (CPO), basé sur le protocole OCPP 1.6.

OCPP CP Admin permet de superviser et piloter une infrastructure de recharge pour véhicules électriques : gestion des bornes, des utilisateurs, des transactions de charge, alertes en temps réel et tableau de bord analytique.

> **🇬🇧 [English version](README.md)**

---

## Table des matières

- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Prérequis](#prérequis)
- [Installation](#installation)
  - [Node.js](#installation-nodejs)
  - [Docker](#installation-docker)
  - [Docker Compose](#docker-compose)
- [Variables d'environnement](#variables-denvironnement)
- [Configuration](#configuration)
  - [Général](#général)
  - [Interface Web (WebUI)](#interface-web-webui)
  - [Serveur OCPP](#serveur-ocpp)
  - [Notifications](#notifications)
  - [Authentification Google OAuth](#authentification-google-oauth)
- [Certificats TLS](#certificats-tls)
  - [HTTPS — Interface Web](#https--interface-web)
  - [WSS — Serveur OCPP](#wss--serveur-ocpp-profils-de-sécurité-2--3)
- [Démarrage](#démarrage)
- [Rôles et permissions](#rôles-et-permissions)
- [Protocole OCPP 1.6](#protocole-ocpp-16)
  - [Opérations supportées](#opérations-supportées)
  - [Connexion des bornes](#connexion-des-bornes)
  - [Profils de sécurité](#profils-de-sécurité)
- [Notifications](#système-de-notifications)
- [Journalisation](#journalisation)
- [Internationalisation](#internationalisation)
- [Scripts de développement](#scripts-de-développement)

---

## Fonctionnalités

### Gestion des bornes de recharge
- Enregistrement manuel ou découverte automatique des bornes
- Approbation des bornes en attente de connexion
- Affectation des bornes à des sites
- Supervision en temps réel (statut connecteur, heartbeat, erreurs)
- Configuration à distance des bornes (GetConfiguration / ChangeConfiguration)
- Historique des messages OCPP (CALL / CALLRESULT / CALLERROR)

### Gestion des sites et utilisateurs
- Architecture multi-sites
- Rôles hiérarchiques : Admin, Manager, Utilisateur
- Autorisation par site et par utilisateur
- Authentification locale (email / mot de passe) ou Google OAuth 2.0
- Réinitialisation de mot de passe par email avec jeton sécurisé

### Transactions et suivi de charge
- Suivi des transactions actives et terminées
- Données temps réel : énergie (Wh), puissance (W), courant (A par phase), état de charge (SOC %)
- Historique des transactions avec filtres
- Export CSV des transactions
- Tableau de bord personnel pour les utilisateurs

### Gestion des badges RFID
- Création et gestion de badges (ID Tags)
- Génération automatique de tags web pour les démarrages à distance
- Suivi des expirations et des rejets d'autorisation

### Notifications multi-canaux
- **Email** (SMTP via Nodemailer)
- **Web Push** (notifications navigateur via Service Worker)
- **Pushover** (notifications push mobiles)
- 21 types d'événements avec filtrage par rôle
- Préférences par utilisateur et par canal

### Tableau de bord et analytique
- Statistiques en temps réel : bornes connectées, transactions actives, états des connecteurs
- KPIs de charge : énergie, durée, fréquence
- Graphiques historiques (plage de dates configurable)

### Sécurité et monitoring
- Détection de connexions en boucle (flapping)
- Détection d'identités dupliquées (même identifiant depuis plusieurs IPs)
- Rate limiting sur les API et l'authentification
- En-têtes de sécurité HTTP (Helmet)
- Journalisation structurée avec rotation des fichiers

### Application web progressive (PWA)
- Interface responsive (mobile-first)
- Thème clair/sombre
- Notifications push via Service Worker
- Point d'accès `/healthz` pour le monitoring

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Navigateur / Mobile                   │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP/HTTPS
┌──────────────────▼──────────────────────────────────────┐
│         Serveur Web Express (Port 3000/3001)            │
│  ┌────────────────────────────────────────────────────┐ │
│  │ API REST                                           │ │
│  │ Auth, Sites, Utilisateurs, Bornes, Transactions    │ │
│  │ Notifications, Tableau de bord                     │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
┌───▼─────┐  ┌─────▼────┐  ┌──────▼──────┐
│ SQLite  │  │ Sessions │  │ Diffusion   │
│  (BDD)  │  │ (SQLite) │  │ temps réel  │
└─────────┘  └──────────┘  └─────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│         Serveur OCPP (WS Port 9000 / WSS Port 9001)     │
│  ┌────────────────────────────────────────────────────┐ │
│  │ OCPP 1.6 RPC                                       │ │
│  │ Authentification (mot de passe + certificat client)│ │
│  │ Handlers : Boot, Authorize, Transactions ...       │ │
│  │ Commandes distantes : RemoteStart, ChangeConfig    │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket OCPP 1.6
          ┌────────▼────────┐
          │  Bornes EVSE    │
          └─────────────────┘
```

### Stack technique

| Composant | Technologie |
|---|---|
| Runtime | Node.js 22 |
| Framework web | Express 5 |
| Base de données | SQLite 3 (better-sqlite3, mode WAL) |
| Protocole OCPP | ocpp-rpc (OCPP 1.6-J) |
| Authentification | Passport.js (local + Google OAuth 2.0) |
| Hachage mot de passe | bcryptjs |
| Sécurité HTTP | Helmet, express-rate-limit |
| Email | Nodemailer |
| Push Web | web-push |
| Journalisation | Winston + rotation quotidienne |
| i18n | i18next |
| Linting | ESLint + Prettier |

---

## Prérequis

- **Node.js** >= 22
- **npm** >= 10
- Ou **Docker** / **Docker Compose**

---

## Installation

### Installation Node.js

```bash
# Cloner le dépôt
git clone <url-du-depot>
cd ocpp-cp-admin

# Installer les dépendances
npm install

# Copier la configuration exemple
cp config/config.sample.json config/config.json
```

Éditez `config/config.json` selon vos besoins (voir la section [Configuration](#configuration)).

### Installation Docker

L'image est disponible sur **GitHub Container Registry** et **Docker Hub** :

```bash
docker pull ghcr.io/wocha-fr/ocpp-cp-admin:latest
# ou
docker pull wocha/ocpp-cp-admin:latest
```

Quatre fichiers Docker Compose sont disponibles dans le dossier `docker/`, adaptés à différents scénarios de déploiement :

| Fichier | Description |
|---|---|
| `docker-compose.http.yml` | App seule — HTTP + WS (ports 3000/9000) |
| `docker-compose.https.yml` | App seule — HTTPS + WSS (ports 3001/9000/9001, certbot inclus) |
| `docker-compose.yml` | Stack complète : Traefik (HTTPS, TLS termination) + App + FTP |
| `docker-compose.tls.yml` | Stack complète : Traefik (HTTPS + WSS passthrough) + export certs + App + FTP |

```bash
# Exemple : stack complète avec Traefik
docker compose -f docker/docker-compose.yml up -d

# Exemple : app seule HTTP
docker compose -f docker/docker-compose.http.yml up -d
```

Les stacks avec Traefik incluent :
- **Reverse proxy** avec routage par nom d'hôte (`cpadmin.local`, `ws.cpadmin.local`)
- **Serveur FTP** pour la récupération des diagnostics de bornes
- **Support Let's Encrypt** (variante TLS)
- **TCP passthrough** pour le WSS OCPP avec authentification par certificat client (variante TLS)

Consultez le fichier [`docker/README.md`](docker/README.md) pour le détail de chaque compose.

**Ports exposés :**

| Port | Usage |
|------|-------|
| 3000 | Interface Web (HTTP) |
| 3001 | Interface Web (HTTPS, si activé) |
| 9000 | Serveur OCPP (WebSocket) |
| 9001 | Serveur OCPP (WebSocket Secure, si activé) |

**Volumes :**

| Volume | Contenu |
|--------|---------|
| `/app/config` | Configuration, base de données et certificats (`certs/`) |
| `/app/logs` | Fichiers de journalisation |
| `/app/public/img` | Images statiques |
| `/app/locales-custom` | Fichiers de locale personnalisés (ajout ou surcharge de traductions) |
Le point d'accès `/healthz` est utilisé pour le health check Docker (HTTP GET, toutes les 30s).

Au premier démarrage, si `config/config.json` n'existe pas, il est créé automatiquement depuis `config.sample.json`.

L'entrypoint s'exécute en root pour copier les fichiers par défaut et corriger les permissions des volumes, puis bascule vers un utilisateur non-root dédié (`app`) via `su-exec`.

---

## Variables d'environnement

Les valeurs de `config.json` peuvent être surchargées par variables d'environnement. Le fichier JSON reste la base de configuration ; les variables d'environnement prennent le dessus si elles sont définies.

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

> Les booléens (`true`/`false`) et les nombres sont convertis automatiquement.
> Les secrets sont toujours traités comme des chaînes de caractères.

---

## Configuration

Le fichier de configuration est `config/config.json`. En mode développement (`NODE_ENV=development`), le fichier `config/config.dev.json` est utilisé s'il existe.

Les valeurs du fichier de configuration peuvent être surchargées par variables d'environnement (voir la section [Variables d'environnement](#variables-denvironnement)).

### Éditeur de configuration (UI)

Les administrateurs peuvent modifier la configuration directement depuis l'interface web via **Paramètres → Configuration**. L'éditeur affiche tous les paramètres regroupés par section dans un tableau à trois colonnes :

- **Valeur fichier** — la valeur actuellement stockée dans `config.json`
- **Variable d'env.** — le nom de la variable d'environnement associée et sa valeur courante (ou *non définie* si absente)
- **Nouvelle valeur** — champ éditable pré-rempli avec la valeur effective (la surcharge env a priorité sur la valeur fichier)

Les champs obligatoires sont validés avant l'enregistrement. L'application redémarre automatiquement après une sauvegarde réussie.

> Les variables d'environnement sont affichées à titre informatif uniquement — elles ne peuvent pas être modifiées depuis l'interface. L'éditeur écrit uniquement dans `config.json`.

### Général

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `loglevel` | string | `"error"` | Niveau de log : `error`, `warn`, `info`, `debug` |
| `language` | string | `"fr"` | Langue par défaut de l'application (tout code locale du dossier `locales/`, ex. `fr`, `en`) |
| `dbname` | string | `"cpadmin.db"` | Nom du fichier de base de données SQLite |
| `cpoName` | string | `"CP Admin"` | Nom de l'organisation (affiché dans l'interface) |

### Interface Web (WebUI)

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

| Paramètre | Description |
|---|---|
| `httpHost` | Adresse d'écoute HTTP (`0.0.0.0` pour écouter sur toutes les interfaces) |
| `httpPort` | Port HTTP |
| `trustProxy` | Activer si derrière un reverse proxy (`true` ou nombre de proxies) |
| `publicUrl` | URL publique de l'application (utilisée dans les emails, le callback Google OAuth) |
| `sessionSecret` | Clé secrète pour les sessions (générée automatiquement si vide à chaque démarrage) |
| `https.enabled` | Activer le serveur HTTPS |
| `https.httpsPort` | Port HTTPS |
| `https.certFile` / `keyFile` | Chemins vers les fichiers certificat et clé TLS (relatifs au dossier `config/`) |

### Serveur OCPP

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

| Paramètre | Description |
|---|---|
| `host` | Adresse d'écoute du serveur OCPP |
| `wsPort` | Port WebSocket (WS) |
| `strictMode` | Mode strict OCPP (validation des messages) |
| `heartbeatInterval` | Intervalle de heartbeat en secondes (envoyé aux bornes au BootNotification) |
| `autoAddUnknownChargepoints` | Ajouter automatiquement les bornes inconnues qui se connectent |
| `pendingUnknownChargepoints` | Mettre les bornes inconnues en attente d'approbation admin |
| `ocppWsUrl` | URL WebSocket OCPP à communiquer (pour la configuration des bornes) |
| `diagnosticsLocation` | URL de destination pour l'upload des diagnostics |
| `wss.enabled` | Activer le WebSocket Secure (TLS) |
| `wss.strictClientCert` | Exiger un certificat client valide |
| `wss.rsa` / `ecdsa` | Certificats serveur pour WSS (double algorithme supporté, chemins relatifs au dossier `config/`) |
| `wss.caFile` | Autorité de certification pour la validation des certificats clients (chemin relatif au dossier `config/`) |

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

| Paramètre | Description |
|---|---|
| `authRejectThreshold` | Nombre de rejets d'autorisation RFID avant notification |
| `authRejectWindowMinutes` | Fenêtre de temps pour le comptage des rejets RFID (minutes) |
| `flapThreshold` | Nombre de reconnexions rapides d'une borne avant alerte flapping |
| `flapWindowMinutes` | Fenêtre de temps pour la détection de flapping (minutes) |
| `mail.enabled` | Activer les notifications par email |
| `mail.from` | Adresse d'expéditeur |
| `mail.transport` | Configuration du transport SMTP (Nodemailer) |
| `webpush.enabled` | Activer les notifications Web Push |
| `webpush.vapid*` | Clés VAPID pour Web Push (à générer) |
| `pushover.enabled` | Activer les notifications Pushover |

### Authentification Google OAuth

```json
"auth": {
  "google": {
    "enabled": false,
    "client_id": "",
    "client_secret": ""
  }
}
```

Si activé, les utilisateurs peuvent se connecter via leur compte Google. Le compte Google est associé par adresse email à un utilisateur existant. L'URL de callback OAuth est dérivée de `webui.publicUrl`.

---

## Certificats TLS

Les certificats sont stockés dans le dossier `config/certs/` (tous les chemins dans `config.json` sont relatifs à `config/`).

L'application supporte le **rechargement à chaud** : lorsqu'un fichier de certificat change sur le disque, le serveur recharge son contexte TLS automatiquement — sans redémarrage. Les liens symboliques pointant vers le dossier `live/` de Let's Encrypt tirent pleinement profit de ce mécanisme.

---

### HTTPS — Interface Web

> Nécessite `webui.https.enabled: true`.

**Développement — certificat auto-signé :**

```bash
mkdir -p config/certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout config/certs/server.key \
  -out    config/certs/server.crt \
  -subj   "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

**Production — Let's Encrypt (liens symboliques, renouvellement automatique) :**

```bash
certbot certonly --standalone -d cpadmin.example.com

mkdir -p config/certs
ln -sf /etc/letsencrypt/live/cpadmin.example.com/fullchain.pem config/certs/server.crt
ln -sf /etc/letsencrypt/live/cpadmin.example.com/privkey.pem   config/certs/server.key
```

Les liens symboliques pointant toujours vers les derniers fichiers d'archive après `certbot renew`, aucun hook post-renouvellement n'est nécessaire — le serveur détecte le changement et recharge automatiquement.

Extrait `config.json` :

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

### WSS — Serveur OCPP (Profils de sécurité 2 / 3)

> Nécessite `ocpp.wss.enabled: true`. Le serveur charge **simultanément un certificat RSA et un certificat ECDSA** afin de prendre en charge le plus grand nombre d'implémentations de bornes.

**Développement — RSA + ECDSA auto-signés :**

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

**Production — Let's Encrypt (liens symboliques, renouvellement automatique) :**

```bash
# Certificat RSA (par défaut)
certbot certonly --standalone -d ws.cpadmin.example.com

# Certificat ECDSA (lignée séparée)
certbot certonly --standalone -d ws.cpadmin.example.com \
  --key-type ecdsa --cert-name ws-cpadmin-ecdsa

mkdir -p config/certs

# Liens symboliques RSA
ln -sf /etc/letsencrypt/live/ws.cpadmin.example.com/fullchain.pem config/certs/rsa-server.crt
ln -sf /etc/letsencrypt/live/ws.cpadmin.example.com/privkey.pem   config/certs/rsa-server.key

# Liens symboliques ECDSA
ln -sf /etc/letsencrypt/live/ws-cpadmin-ecdsa/fullchain.pem config/certs/ecdsa-server.crt
ln -sf /etc/letsencrypt/live/ws-cpadmin-ecdsa/privkey.pem   config/certs/ecdsa-server.key
```

Extrait `config.json` :

```json
"ocpp": {
  "wss": {
    "enabled": true,
    "wssPort": 9001,
    "strictClientCert": false,
    "rsa":   { "certFile": "certs/rsa-server.crt",  "keyFile": "certs/rsa-server.key" },
    "ecdsa": { "certFile": "certs/ecdsa-server.crt", "keyFile": "certs/ecdsa-server.key" },
    "caFile": ""
  }
}
```

#### Profil de sécurité 3 — Authentification par certificat client

Le serveur vérifie que le certificat client est signé par une CA de confiance. Un **certificat unique partagé par toutes les bornes** est suffisant — le CN n'est pas comparé à l'identité de la borne.

**1. Créer une CA locale :**

```bash
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout config/certs/ca.key \
  -out    config/certs/ca.crt \
  -subj   "/CN=OCPP-CA"
```

**2. Émettre un certificat client unique (à installer sur toutes les bornes) :**

```bash
# Clé + CSR
openssl req -newkey rsa:2048 -nodes \
  -keyout config/certs/client.key \
  -out    config/certs/client.csr \
  -subj   "/CN=ocpp-client"

# Signer avec la CA
openssl x509 -req -days 365 -sha256 \
  -in     config/certs/client.csr \
  -CA     config/certs/ca.crt \
  -CAkey  config/certs/ca.key \
  -CAcreateserial \
  -out    config/certs/client.crt

# Combiner le certificat et la clé dans un seul fichier PEM
cat config/certs/client.crt config/certs/client.key > config/certs/client.pem
```

**3. Activer la validation stricte du certificat client :**

```json
"wss": {
  "strictClientCert": true,
  "caFile": "certs/ca.crt"
}
```

Installez `client.pem` (contient le certificat et la clé privée) sur chaque borne.

> **Mode mixte** (`strictClientCert: false` avec `caFile` renseigné) : le serveur demande un certificat mais accepte également l'authentification par mot de passe (Profil 2). Les certificats présentés sont validés contre la CA.

---

## Démarrage

### Mode production

```bash
npm start
```

### Mode développement (rechargement automatique)

```bash
npm run dev
```

L'application démarre :
1. Le serveur web Express sur le port configuré (défaut : 3000)
2. Le serveur OCPP WebSocket sur le port configuré (défaut : 9000)
3. Les migrations de base de données sont exécutées automatiquement au démarrage

Un compte administrateur par défaut est créé au premier démarrage si la base de données est vide :

| | |
|---|---|
| **Email** | `admin@admin.com` |
| **Mot de passe** | `admin123` |

> **⚠️ Important :** Changez l'adresse email et le mot de passe de ce compte dès la première connexion.

---

## Rôles et permissions

L'application repose sur trois niveaux de rôles hiérarchiques :

### Administrateur (`admin`)

Accès complet à toutes les fonctionnalités :
- Gestion de tous les sites, utilisateurs et bornes
- Configuration globale de l'application
- Approbation des bornes en attente
- Visualisation de toutes les transactions et messages OCPP
- Export CSV global
- Peut également être utilisateur sur un ou plusieurs sites

### Manager (`manager`)

Gestion restreinte aux sites autorisés :
- Supervision des bornes de ses sites
- Gestion des utilisateurs de ses sites
- Démarrage / arrêt de charge à distance
- Visualisation des transactions de ses sites
- Export CSV de ses sites
- Peut également être utilisateur sur un ou plusieurs sites

### Utilisateur (`user`)

Accès limité à la recharge :
- Voir les connecteurs disponibles sur ses sites autorisés
- Démarrer et arrêter ses propres sessions de charge
- Consulter son historique de transactions
- Exporter ses transactions en CSV
- Gérer ses préférences de notifications

---

## Protocole OCPP 1.6

L'application implémente le protocole OCPP 1.6-J (JSON sur WebSocket) pour la communication avec les bornes de recharge.

### Opérations supportées

#### Borne → Serveur (requêtes entrantes)

| Opération | Description |
|---|---|
| **BootNotification** | Notification de démarrage de la borne (informations constructeur, firmware) |
| **Heartbeat** | Signal de vie périodique |
| **StatusNotification** | Changement de statut d'un connecteur ou de la borne |
| **Authorize** | Demande d'autorisation d'un badge RFID |
| **StartTransaction** | Début de session de charge |
| **StopTransaction** | Fin de session de charge (raison d'arrêt, énergie consommée) |
| **MeterValues** | Données de comptage temps réel (énergie, puissance, courant, SOC) |
| **DataTransfer** | Échange de données propriétaires constructeur |
| **DiagnosticsStatusNotification** | Statut de l'upload de diagnostics |

#### Serveur → Borne (commandes distantes)

| Opération | Description |
|---|---|
| **RemoteStartTransaction** | Démarrer une session de charge à distance |
| **RemoteStopTransaction** | Arrêter une session de charge à distance |
| **GetConfiguration** | Récupérer la configuration de la borne |
| **ChangeConfiguration** | Modifier un paramètre de configuration |

Une interface de commande générique permet d'envoyer n'importe quelle commande OCPP via l'API.

### Connexion des bornes

Les bornes se connectent via WebSocket à l'URL :
```
ws://<host>:<wsPort>/<identity>
```

Ou en mode sécurisé :
```
wss://<host>:<wssPort>/<identity>
```

Où `<identity>` est l'identifiant unique de la borne (enregistré dans l'application).

### Profils de sécurité

| Profil | Description |
|---|---|
| **Profil 1** | Pas d'authentification (WebSocket non sécurisé) |
| **Profil 2** | Authentification par mot de passe (Basic Auth dans le handshake WebSocket) |
| **Profil 3** | Certificat client TLS (WebSocket Secure avec vérification certificat) |

Les bornes doivent être enregistrées et autorisées dans l'application pour pouvoir se connecter. Les bornes non reconnues peuvent être :
- **Rejetées** (comportement par défaut)
- **Ajoutées automatiquement** (`autoAddUnknownChargepoints: true`)
- **Mises en attente** d'approbation (`pendingUnknownChargepoints: true`)

---

## Système de notifications

L'application propose un système d'alertes piloté par les événements.

### Canaux disponibles

| Canal | Configuration requise |
|---|---|
| **Email** | Serveur SMTP (`notifs.mail`) |
| **Web Push** | Clés VAPID (`notifs.webpush`) |
| **Pushover** | Token et clé utilisateur (dans le profil utilisateur) |

### Types d'événements

#### Événements Administrateur

| Événement | Description |
|---|---|
| Démarrage / arrêt serveur | Le serveur OCPP a démarré ou s'est arrêté |
| Borne en attente | Une borne inconnue tente de se connecter |
| Ajout automatique de borne | Une borne inconnue a été ajoutée automatiquement |
| Identité dupliquée | Même identifiant de borne depuis une IP différente |
| Flapping | Reconnexions rapides et répétées d'une borne |

#### Événements Manager

| Événement | Description |
|---|---|
| Borne en ligne / hors ligne | Changement d'état de connexion d'une borne |
| Connecteur disponible / indisponible | Changement de statut d'un connecteur |
| Erreur connecteur | Erreur signalée par un connecteur |
| Rejets d'autorisation répétés | Seuil de rejets atteint pour un badge |
| Transaction démarrée / terminée | Activité de charge sur un site |

#### Événements Utilisateur

| Événement | Description |
|---|---|
| Transaction démarrée / terminée | Ma session de charge démarre ou se termine |
| Charge suspendue (EVSE) | La borne a suspendu la charge |

Chaque utilisateur peut configurer ses préférences de notification (quels événements recevoir et sur quels canaux) via les paramètres de l'application.

---

## Journalisation

L'application utilise **Winston** avec rotation quotidienne des fichiers de log.

| Fichier | Contenu | Rétention |
|---|---|---|
| `logs/app-YYYY-MM-DD.log` | Tous les logs (selon le niveau configuré) | 30 jours |
| `logs/error-YYYY-MM-DD.log` | Erreurs uniquement | 90 jours |

Taille maximale par fichier : 20 Mo.

Les scopes de logging prédéfinis sont : `CPADM`, `WEBUI`, `OCPP`, `NOTIF`, `SQLDB`.

En mode développement, les logs sont également affichés en console avec coloration par scope.

Pour activer temporairement la sortie console en production (ex. pour diagnostiquer une erreur au démarrage), définir la variable d'environnement `LOG_CONSOLE=true` :

```bash
LOG_CONSOLE=true npm start
```

La sortie console en production utilise du texte brut (sans couleurs ANSI).

---

## Internationalisation

L'application est livrée avec :
- **Français** (`fr`) — langue par défaut
- **Anglais** (`en`)

La langue par défaut est configurée dans `config.json` (`language`) ou via la variable d'environnement `CPADMIN_LANGUAGE`. Chaque utilisateur peut choisir sa langue préférée dans son profil.

Les traductions incluent l'interface, les notifications, les exports CSV et les formats de dates.

### Ajouter une nouvelle langue

De nouvelles langues peuvent être ajoutées **sans modifier le code source**. Le moteur i18n découvre automatiquement tous les fichiers `.json` du dossier `locales/` au démarrage.

Pour ajouter une langue (ex. allemand `de`) :

1. Copier un fichier de locale existant comme modèle :
   ```bash
   cp locales/en.json locales/de.json
   ```
2. Traduire toutes les valeurs dans `locales/de.json` (conserver les clés inchangées)
3. Mettre à jour la section `language_label` et `_localeConfig` pour la nouvelle locale :
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
4. Définir la nouvelle langue par défaut (optionnel) :
   - Dans `config.json` : `"language": "de"`
   - Ou via variable d'environnement : `CPADMIN_LANGUAGE=de`
5. Redémarrer l'application

> Avec Docker, les locales intégrées (`en`, `fr`) font partie de l'image et sont mises à jour à chaque nouvelle version. Pour ajouter une locale personnalisée **sans reconstruire l'image**, placez le fichier `.json` dans le volume `locales-custom`. Les fichiers personnalisés sont fusionnés par-dessus les locales intégrées — les clés du fichier personnalisé surchargent celles de l'image, le reste est conservé. Voir [`docker/README.fr.md`](docker/README.fr.md) pour les détails.

---

## Scripts de développement

```bash
# Démarrer en production
npm start

# Démarrer en développement (rechargement automatique)
npm run dev

# Vérifier le style de code
npm run lint

# Corriger automatiquement les problèmes de style
npm run lint:fix

# Formater le code avec Prettier
npm run format

# Vérifier le formatage sans modifier
npm run format:check
```

---

## Base de données

L'application utilise **SQLite** avec le mode **WAL** (Write-Ahead Logging) pour de meilleures performances en concurrence.

Les migrations sont exécutées automatiquement au démarrage depuis le dossier `migrations/`. La base de données est créée dans le dossier `config/` avec le nom configuré (défaut : `cpadmin.db`).

### Tables principales

| Table | Description |
|---|---|
| `sites` | Sites de recharge |
| `users` | Comptes utilisateurs |
| `user_sites` | Association utilisateurs ↔ sites (avec rôle) |
| `chargepoints` | Bornes de recharge enregistrées |
| `connectors` | Connecteurs des bornes |
| `chargepoint_config` | Configuration des bornes |
| `transactions` | Sessions de charge |
| `transactions_values` | Données de comptage temps réel |
| `ocpp_messages` | Journal des messages OCPP |
| `users_password_resets` | Jetons de réinitialisation de mot de passe |

---

## Licence

Ce projet est distribue sous licence GNU Affero General Public License v3.0 (AGPL-3.0-only).

- Texte complet de la licence : [LICENSE](LICENSE)
- Copyright : [COPYRIGHT](COPYRIGHT)
- Auteurs : [AUTHORS](AUTHORS)
- Processus de contribution : [CONTRIBUTING.md](CONTRIBUTING.md)

Toute version modifiee et exploitee comme service reseau doit fournir son code source correspondant sous AGPL-3.0-only.
