const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');
const path = require('path');
const { WebSocketServer } = require('ws');
const { i18next, SUPPORTED_LANGUAGES } = require('./i18n');

const logger = require('./logger').scope('CPADM');
const { getConfig, getConfigDir } = require('./config');
const db = require('./database');
const passport = require('./auth');
const {
  createOCPPServer,
  setBroadcast,
  startHeartbeatWatchdog,
  stopHeartbeatWatchdog,
} = require('./ocpp-server');
const routes = require('./routes');
const notifications = require('./notifications');

const logWEBUI = logger.scope('WEBUI');
const logOCPP = logger.scope('OCPP');

const config = getConfig();
logger.setLevel(config.loglevel || 'error');
const HTTP_HOST = config.webui.httpHost || 'localhost';
const HTTP_PORT = config.webui.httpPort || 3000;
const HTTPS_PORT = config.webui.https?.httpsPort || 3001;
const OCPP_HOST = config.ocpp.host || '0.0.0.0';
const OCPP_WS_PORT = config.ocpp.wsPort || 9000;
const OCPP_WSS_PORT = config.ocpp.wss?.wssPort || 9001;
const uiSslEnabled = config.webui.https && config.webui.https.enabled;
const wsSslEnabled = config.ocpp.wss && config.ocpp.wss.enabled;
const ocppStrictClientCert = config.ocpp.wss?.strictClientCert === true;

// ── Initialiser la DB ──
const sqliteDb = db.getDb();

// ── Initialiser le système de notifications ──
notifications.init();

// ── Express App ──
const app = express();
if (config.webui.trustProxy) {
  app.set('trust proxy', config.webui.trustProxy);
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
      },
    },
  })
);
const sessionMiddleware = session({
  store: new SqliteStore({
    client: sqliteDb,
    expired: {
      clear: true,
      intervalMs: 15 * 60 * 1000, // nettoyage toutes les 15 min
    },
  }),
  secret: config.webui.sessionSecret || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24h
    httpOnly: true,
    secure: uiSslEnabled, // cookie sécurisé si HTTPS activé
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);

// ── Passport ──
app.use(passport.initialize());
app.use(passport.session());

// Redirect HTTP to HTTPS si SSL activé
if (uiSslEnabled) {
  app.use((req, res, next) => {
    if (!req.secure && req.path !== '/healthz') {
      return res.redirect(`https://${req.hostname}:${HTTPS_PORT}${req.url}`);
    }
    next();
  });
}

// API routes
app.use('/api', routes);

// Liveness endpoint for container orchestrators and Docker health checks.
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Lire index.html une seule fois au démarrage
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

// Préparer le JSON des traductions (une seule fois, mis en cache)
const i18nResources = {};
for (const lng of SUPPORTED_LANGUAGES) {
  i18nResources[lng] = { translation: i18next.getResourceBundle(lng, 'translation') };
}
const defaultLang = config.language || 'fr';
const languageLabels = {};
for (const lng of SUPPORTED_LANGUAGES) {
  const label = i18next.t('language_label', { lng });
  languageLabels[lng] = label && label !== 'language_label' ? label : `🌐 ${lng.toUpperCase()}`;
}
const i18nScript = `<script>window.__I18N__=${JSON.stringify(i18nResources)};window.__SUPPORTED_LANGUAGES__=${JSON.stringify(SUPPORTED_LANGUAGES)};window.__DEFAULT_LANG__=${JSON.stringify(defaultLang)};window.__LANGUAGE_LABELS__=${JSON.stringify(languageLabels)};</script>`;

// Préparer le HTML final avec les traductions injectées (une seule fois, mis en cache)
const finalHtml = indexHtml.replace(
  '<script src="https://cdn.jsdelivr.net/npm/i18next',
  i18nScript + '<script src="https://cdn.jsdelivr.net/npm/i18next'
);

// Servir l'UI statique (index: false pour que le catch-all serve le HTML avec i18n)
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.get('/{*splat}', (req, res) => {
  res.type('html').send(finalHtml);
});

// ── Helper : charger une paire cert/clé SSL ──
function loadCertKeyPair(label, certFile, keyFile, log) {
  if (!certFile || !keyFile) {
    log.error(`${label}: cert/key configuration missing from config.json`);
    process.exit(1);
  }
  const certPath = path.resolve(getConfigDir(), certFile);
  const keyPath = path.resolve(getConfigDir(), keyFile);
  if (!fs.existsSync(certPath)) {
    log.error(`${label}: Certificate not found: ${certPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(keyPath)) {
    log.error(`${label}: Private key not found: ${keyPath}`);
    process.exit(1);
  }
  log.debug(`${label}: Certificate loaded: ${certPath}`);
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

// ── Chemins des certificats surveillés ──
const watchedCertPaths = new Set();
let certReloadTimer = null;

// ── Construire les options TLS pour UI HTTPS ──
function buildUiSslOptions() {
  return loadCertKeyPair(
    'HTTPS',
    config.webui.https.certFile,
    config.webui.https.keyFile,
    logWEBUI
  );
}

// ── Construire les options TLS pour OCPP WSS (RSA & ECDSA) ──
function buildWsSslOptions() {
  const pairs = [
    { name: 'RSA', conf: config.ocpp.wss.rsa },
    { name: 'ECDSA', conf: config.ocpp.wss.ecdsa },
  ];
  const loaded = pairs.map(({ name, conf }) =>
    loadCertKeyPair(`WSS ${name}`, conf?.certFile, conf?.keyFile, logOCPP)
  );
  const options = {
    cert: loaded.map((p) => p.cert),
    key: loaded.map((p) => p.key),
    requestCert: true, // Demander un certificat client (Security Profile 3)
    rejectUnauthorized: ocppStrictClientCert, // true = profile 3 strict, false = mode mixte profile 2/3
  };
  if (config.ocpp.wss.caFile) {
    const caPath = path.resolve(getConfigDir(), config.ocpp.wss.caFile);
    if (fs.existsSync(caPath)) {
      options.ca = fs.readFileSync(caPath);
    } else {
      logOCPP.warn(`WSS: CA file not found (ignored): ${caPath}`);
    }
  }
  return options;
}

// ── Rechargement à chaud des certificats TLS (sans redémarrage) ──
function reloadCerts() {
  for (const p of watchedCertPaths) {
    if (!fs.existsSync(p)) {
      logger.error(`Certificate file missing during reload: ${p} — reload skipped`);
      return;
    }
  }
  try {
    if (uiSslEnabled && httpsServer) {
      httpsServer.setSecureContext(buildUiSslOptions());
      logWEBUI.info('UI HTTPS: TLS certificates hot-reloaded');
    }
    if (wsSslEnabled && ocppHttpsServer) {
      ocppHttpsServer.setSecureContext(buildWsSslOptions());
      logOCPP.info('OCPP WSS: TLS certificates hot-reloaded');
    }
  } catch (err) {
    logger.error('Failed to hot-reload TLS certificates:', err);
    gracefulShutdown('CERT_RELOAD_ERROR');
  }
}

// ── Surveillance des fichiers certificats ──
function watchCertFiles() {
  if (watchedCertPaths.size === 0) return;
  for (const certPath of watchedCertPaths) {
    fs.watchFile(certPath, { interval: 60_000, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        if (certReloadTimer) clearTimeout(certReloadTimer);
        certReloadTimer = setTimeout(() => {
          logger.info(`Certificate changed: ${path.basename(certPath)} — reloading TLS context`);
          reloadCerts();
        }, 500);
      }
    });
  }
  logger.debug(`Watching ${watchedCertPaths.size} certificate file(s) for TLS hot-reload`);
}

// ── Charger les certificats SSL pour UI HTTPS ──
let uiSslOptions = null;
if (uiSslEnabled) {
  uiSslOptions = buildUiSslOptions();
  watchedCertPaths.add(path.resolve(getConfigDir(), config.webui.https.certFile));
  watchedCertPaths.add(path.resolve(getConfigDir(), config.webui.https.keyFile));
}

// ── Charger les certificats SSL (RSA & ECDSA) pour OCPP WSS ──
let wsSslOptions = null;

if (wsSslEnabled) {
  wsSslOptions = buildWsSslOptions();
  for (const conf of [config.ocpp.wss.rsa, config.ocpp.wss.ecdsa]) {
    if (conf?.certFile) watchedCertPaths.add(path.resolve(getConfigDir(), conf.certFile));
    if (conf?.keyFile) watchedCertPaths.add(path.resolve(getConfigDir(), conf.keyFile));
  }
  if (config.ocpp.wss.caFile) {
    const caPath = path.resolve(getConfigDir(), config.ocpp.wss.caFile);
    if (fs.existsSync(caPath)) watchedCertPaths.add(caPath);
  }
  logOCPP.debug(`WSS: RSA & ECDSA certificates loaded (strictClientCert=${ocppStrictClientCert})`);
  if (ocppStrictClientCert) {
    logOCPP.info(
      'WSS strict client certificate validation enabled (OCPP Security Profile 3 strict)'
    );
  } else {
    logOCPP.info(
      'WSS mixed mode enabled: Profile 2 (Basic Auth) and Profile 3 (client cert) accepted'
    );
  }
}

// ── HTTP Server pour l'UI + WebSocket temps réel ──
const httpServer = http.createServer(app);
const httpsServer = uiSslEnabled ? https.createServer(uiSslOptions, app) : null;

// WebSocket pour le temps réel côté UI
const uiClients = new Set();

function attachUIWebSocket(server, label) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    sessionMiddleware(req, {}, () => {
      if (!req.session?.passport?.user) {
        ws.close(4401, 'Unauthorized');
        return;
      }
      uiClients.add(ws);
      logWEBUI.debug(`UI WS Client connected${label} (${uiClients.size} total)`);
      ws.on('close', () => {
        uiClients.delete(ws);
        logWEBUI.debug(`UI WS Client disconnected${label} (${uiClients.size} total)`);
      });
    });
  });
}

attachUIWebSocket(httpServer, '');
if (httpsServer) attachUIWebSocket(httpsServer, ' (secure)');

function broadcastToUI(message) {
  for (const client of uiClients) {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      client.send(message);
    }
  }
}

// Connecter le broadcast OCPP → UI
setBroadcast(broadcastToUI);

// ── Serveur OCPP sur port séparé ──
const ocppServer = createOCPPServer();
let ocppWssServer = null;
let ocppHttpsServer = null;

async function start() {
  // Démarrer le serveur OCPP WS (toujours actif)
  await ocppServer.listen(OCPP_WS_PORT, OCPP_HOST);
  logOCPP.info(`OCPP 1.6J WS server listening on ws://${OCPP_HOST}:${OCPP_WS_PORT}`);
  // Démarrer le serveur OCPP WSS en parallèle si SSL activé
  if (wsSslEnabled) {
    ocppWssServer = createOCPPServer({ isWSS: true });
    setBroadcast(broadcastToUI); // connecter le broadcast aussi sur le serveur WSS
    ocppHttpsServer = https.createServer(wsSslOptions);
    ocppHttpsServer.on('upgrade', ocppWssServer.handleUpgrade);
    await new Promise((resolve, reject) => {
      ocppHttpsServer.once('error', reject);
      ocppHttpsServer.listen(OCPP_WSS_PORT, OCPP_HOST, () => {
        logOCPP.info(`OCPP 1.6J WSS server listening on wss://${OCPP_HOST}:${OCPP_WSS_PORT}`);
        resolve();
      });
    });
  }
  // Démarrer le serveur HTTP (UI + API)
  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    logWEBUI.info(`Web interface available at http://${HTTP_HOST}:${HTTP_PORT}`);
    logWEBUI.info(`WebSocket UI available at ws://${HTTP_HOST}:${HTTP_PORT}/ws`);
  });
  if (uiSslEnabled) {
    httpsServer.listen(HTTPS_PORT, HTTP_HOST, () => {
      logWEBUI.info(`Web interface available at https://${HTTP_HOST}:${HTTPS_PORT}`);
    });
  }
  // Démarrer la surveillance des certificats TLS
  watchCertFiles();
  // Démarrer le watchdog de heartbeat
  startHeartbeatWatchdog();
  logOCPP.info('Heartbeat watchdog started');
  // Emission d'une notification de démarrage
  notifications.emit('server_started', {});
}

function flushAndExit(code) {
  logger.on('finish', () => process.exit(code));
  logger.end();
}

start().catch((err) => {
  logger.error('Start-up error:', err);
  flushAndExit(1);
});

// ── Graceful Shutdown ──
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.debug(`Signal received: ${signal}. Stop in progress...`);

  const TIMEOUT = 10_000;
  const forceExit = setTimeout(() => {
    logger.error('Timeout exceeded, forced stop.');
    flushAndExit(1);
  }, TIMEOUT);

  try {
    // 0. Arrêter le watchdog de heartbeat et la surveillance des certificats
    stopHeartbeatWatchdog();
    for (const p of watchedCertPaths) fs.unwatchFile(p);
    if (certReloadTimer) clearTimeout(certReloadTimer);
    await notifications.emit('server_stopping', { signal });
    // 1. Fermer les clients WebSocket UI
    for (const client of uiClients) {
      client.close(1001, 'Server shutting down');
    }
    // 2. Fermer le serveur OCPP WS
    await ocppServer.close();
    // 3. Fermer le serveur OCPP WSS (si actif)
    if (ocppWssServer) await ocppWssServer.close();
    if (ocppHttpsServer) {
      await new Promise((resolve) => ocppHttpsServer.close(resolve));
    }
    // 4. Fermer le serveur HTTP & HTTPS
    await new Promise((resolve) => httpServer.close(resolve));
    if (httpsServer) {
      await new Promise((resolve) => httpsServer.close(resolve));
    }
    // 5. Fermer la base de données SQLite
    db.closeDb();
    // 6. Arrêt complet
    logger.debug('Clean stop complete.');
    clearTimeout(forceExit);
    logger.on('finish', () => process.exit(0));
    logger.end();
  } catch (err) {
    logger.error('Error during stop :', err);
    clearTimeout(forceExit);
    flushAndExit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error('Exception not caught', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rejected and not managed', { reason });
  gracefulShutdown('unhandledRejection');
});
