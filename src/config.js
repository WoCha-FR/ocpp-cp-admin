const fs = require('fs');
const path = require('path');
const logger = require('./logger').scope('CPADM');

const CONFIG_DIR_DEFAULT = path.join(__dirname, '..', 'config');
const SAMPLE_FILE = path.join(CONFIG_DIR_DEFAULT, 'config.sample.json');

let config = null;
let configDir = null;

function resolveConfigPath() {
  // Priorité 1 : config.dev.json si NODE_ENV=development
  if (process.env.NODE_ENV === 'development') {
    const devFile = path.join(CONFIG_DIR_DEFAULT, 'config.dev.json');
    if (fs.existsSync(devFile)) {
      return { file: devFile, dir: CONFIG_DIR_DEFAULT };
    }
    logger.warn('config/config.dev.json not found, fallback on config/config.json');
  }
  // Priorité 2 : config/config.json (défaut)
  return { file: path.join(CONFIG_DIR_DEFAULT, 'config.json'), dir: CONFIG_DIR_DEFAULT };
}

// Overrides de configuration via variables d'environnement.
// Seules les valeurs liées au déploiement (URLs, secrets) sont concernées.
// type: 'auto' (défaut) = cast automatique booléen/nombre, 'string' = toujours string.
const ENV_OVERRIDES = [
  // ── Déploiement / URLs ──
  { env: 'CPADMIN_PUBLIC_URL', path: ['webui', 'publicUrl'] },
  { env: 'CPADMIN_HTTP_HOST', path: ['webui', 'httpHost'] },
  { env: 'CPADMIN_TRUST_PROXY', path: ['webui', 'trustProxy'] },
  { env: 'CPADMIN_OCPP_WS_URL', path: ['ocpp', 'ocppWsUrl'] },
  { env: 'CPADMIN_OCPP_WSS_URL', path: ['ocpp', 'wss', 'ocppWsUrl'] },
  { env: 'CPADMIN_DIAGNOSTICS_URL', path: ['ocpp', 'diagnosticsLocation'] },
  // ── Secrets ──
  { env: 'CPADMIN_SESSION_SECRET', path: ['webui', 'sessionSecret'], type: 'string' },
  { env: 'CPADMIN_MAIL_HOST', path: ['notifs', 'mail', 'transport', 'host'] },
  { env: 'CPADMIN_MAIL_PORT', path: ['notifs', 'mail', 'transport', 'port'] },
  {
    env: 'CPADMIN_MAIL_USER',
    path: ['notifs', 'mail', 'transport', 'auth', 'user'],
    type: 'string',
  },
  {
    env: 'CPADMIN_MAIL_PASS',
    path: ['notifs', 'mail', 'transport', 'auth', 'pass'],
    type: 'string',
  },
  { env: 'CPADMIN_GOOGLE_CLIENT_ID', path: ['auth', 'google', 'client_id'], type: 'string' },
  {
    env: 'CPADMIN_GOOGLE_CLIENT_SECRET',
    path: ['auth', 'google', 'client_secret'],
    type: 'string',
  },
  {
    env: 'CPADMIN_VAPID_PUBLIC_KEY',
    path: ['notifs', 'webpush', 'vapidPublicKey'],
    type: 'string',
  },
  {
    env: 'CPADMIN_VAPID_PRIVATE_KEY',
    path: ['notifs', 'webpush', 'vapidPrivateKey'],
    type: 'string',
  },
  // ── Activation des fonctionnalités ──
  { env: 'CPADMIN_MAIL_ENABLED', path: ['notifs', 'mail', 'enabled'] },
  { env: 'CPADMIN_MAIL_FROM', path: ['notifs', 'mail', 'from'], type: 'string' },
  { env: 'CPADMIN_MAIL_SECURE', path: ['notifs', 'mail', 'transport', 'secure'] },
  { env: 'CPADMIN_WEBPUSH_ENABLED', path: ['notifs', 'webpush', 'enabled'] },
  { env: 'CPADMIN_VAPID_SUBJECT', path: ['notifs', 'webpush', 'vapidSubject'], type: 'string' },
  { env: 'CPADMIN_PUSHOVER_ENABLED', path: ['notifs', 'pushover', 'enabled'] },
  { env: 'CPADMIN_GOOGLE_AUTH_ENABLED', path: ['auth', 'google', 'enabled'] },
  // ── Métriques ──
  { env: 'CPADMIN_METRICS_TOKEN', path: ['metrics', 'bearerToken'], type: 'string' },
  // ── Comportement OCPP ──
  { env: 'CPADMIN_OCPP_STRICT_MODE', path: ['ocpp', 'strictMode'] },
  { env: 'CPADMIN_OCPP_CALL_TIMEOUT', path: ['ocpp', 'callTimeoutSeconds'] },
  { env: 'CPADMIN_OCPP_AUTO_ADD', path: ['ocpp', 'autoAddUnknownChargepoints'] },
  { env: 'CPADMIN_OCPP_PENDING_UNKNOWN', path: ['ocpp', 'pendingUnknownChargepoints'] },
  // ── Configuration générale ──
  { env: 'CPADMIN_LOGLEVEL', path: ['loglevel'] },
  { env: 'CPADMIN_LANGUAGE', path: ['language'] },
  { env: 'CPADMIN_CPO_NAME', path: ['cpoName'], type: 'string' },
];

function castEnvValue(raw, type) {
  if (type === 'string') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== '') return num;
  return raw;
}

function applyEnvOverrides(cfg) {
  for (const { env, path: keys, type } of ENV_OVERRIDES) {
    const raw = process.env[env];
    if (raw === undefined) continue;
    const value = castEnvValue(raw, type);
    let obj = cfg;
    for (let i = 0; i < keys.length - 1; i++) {
      if (obj[keys[i]] == null || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    logger.debug(`Config override from env: ${env}`);
  }
}

function loadConfig() {
  if (config) return config;

  const { file, dir } = resolveConfigPath();

  if (!fs.existsSync(file)) {
    if (fs.existsSync(SAMPLE_FILE)) {
      logger.error(`Configuration file not found: ${file}`);
      logger.error(`Copy config/config.sample.json to config/config.json and edit it:`);
      logger.error(`  cp config/config.sample.json config/config.json`);
    } else {
      logger.error(`Configuration file not found: ${file}`);
    }
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf-8');
  config = JSON.parse(raw);
  configDir = dir;
  applyEnvOverrides(config);
  validateConfig(config);
  logger.info(`Configuration loaded from: ${file}`);
  return config;
}

function validateConfig(cfg) {
  const required = [
    'webui',
    'webui.httpPort',
    'webui.sessionSecret',
    'ocpp',
    'ocpp.wsPort',
    'ocpp.host',
  ];
  const missing = required.filter((key) => {
    const parts = key.split('.');
    let obj = cfg;
    for (const p of parts) {
      if (obj == null || typeof obj !== 'object' || !(p in obj)) return true;
      obj = obj[p];
    }
    return obj === undefined;
  });
  if (missing.length > 0) {
    logger.error(`Missing required config keys: ${missing.join(', ')}`);
    logger.error('Check config/config.sample.json for the expected structure.');
    process.exit(1);
  }
}

function getConfig() {
  if (!config) loadConfig();
  return config;
}

/**
 * Retourne le dossier où le fichier de config a été chargé.
 * Permet de résoudre les chemins relatifs (DB, certificats) depuis ce dossier.
 */
function getConfigDir() {
  if (!configDir) loadConfig();
  return configDir;
}

function getConfigFilePath() {
  const { file } = resolveConfigPath();
  return file;
}

const CONFIG_FIELDS = [
  // ── Général ──
  {
    key: 'loglevel',
    section: 'general',
    type: 'select',
    choices: ['error', 'warn', 'info', 'debug'],
    required: false,
    sensitive: false,
  },
  {
    key: 'language',
    section: 'general',
    type: 'select',
    get choices() {
      return require('./i18n').SUPPORTED_LANGUAGES;
    },
    required: false,
    sensitive: false,
  },
  { key: 'cpoName', section: 'general', type: 'string', required: false, sensitive: false },
  { key: 'dbname', section: 'general', type: 'string', required: false, sensitive: false },
  // ── Web UI ──
  { key: 'webui.httpHost', section: 'webui', type: 'string', required: false, sensitive: false },
  { key: 'webui.httpPort', section: 'webui', type: 'number', required: true, sensitive: false },
  { key: 'webui.publicUrl', section: 'webui', type: 'string', required: false, sensitive: false },
  { key: 'webui.sessionSecret', section: 'webui', type: 'string', required: true, sensitive: true },
  { key: 'webui.trustProxy', section: 'webui', type: 'boolean', required: false, sensitive: false },
  {
    key: 'webui.https.enabled',
    section: 'webui',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  {
    key: 'webui.https.httpsPort',
    section: 'webui',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'webui.https.certFile',
    section: 'webui',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'webui.https.keyFile',
    section: 'webui',
    type: 'string',
    required: false,
    sensitive: false,
  },
  // ── OCPP ──
  { key: 'ocpp.host', section: 'ocpp', type: 'string', required: true, sensitive: false },
  { key: 'ocpp.wsPort', section: 'ocpp', type: 'number', required: true, sensitive: false },
  { key: 'ocpp.strictMode', section: 'ocpp', type: 'boolean', required: false, sensitive: false },
  {
    key: 'ocpp.callTimeoutSeconds',
    section: 'ocpp',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'ocpp.autoAddUnknownChargepoints',
    section: 'ocpp',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  {
    key: 'ocpp.pendingUnknownChargepoints',
    section: 'ocpp',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  { key: 'ocpp.ocppWsUrl', section: 'ocpp', type: 'string', required: false, sensitive: false },
  {
    key: 'ocpp.diagnosticsLocation',
    section: 'ocpp',
    type: 'string',
    required: false,
    sensitive: false,
  },
  { key: 'ocpp.wss.enabled', section: 'ocpp', type: 'boolean', required: false, sensitive: false },
  { key: 'ocpp.wss.wssPort', section: 'ocpp', type: 'number', required: false, sensitive: false },
  {
    key: 'ocpp.wss.strictClientCert',
    section: 'ocpp',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  { key: 'ocpp.wss.ocppWsUrl', section: 'ocpp', type: 'string', required: false, sensitive: false },
  {
    key: 'ocpp.wss.rsa.certFile',
    section: 'ocpp',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'ocpp.wss.rsa.keyFile',
    section: 'ocpp',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'ocpp.wss.ecdsa.certFile',
    section: 'ocpp',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'ocpp.wss.ecdsa.keyFile',
    section: 'ocpp',
    type: 'string',
    required: false,
    sensitive: false,
  },
  { key: 'ocpp.wss.caFile', section: 'ocpp', type: 'string', required: false, sensitive: false },
  // ── Notifications ──
  {
    key: 'notifs.authRejectThreshold',
    section: 'notifs',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.authRejectWindowMinutes',
    section: 'notifs',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.flapThreshold',
    section: 'notifs',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.flapWindowMinutes',
    section: 'notifs',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.mail.enabled',
    section: 'notifs',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  { key: 'notifs.mail.from', section: 'notifs', type: 'string', required: false, sensitive: false },
  {
    key: 'notifs.mail.transport.host',
    section: 'notifs',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.mail.transport.port',
    section: 'notifs',
    type: 'number',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.mail.transport.secure',
    section: 'notifs',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.mail.transport.auth.user',
    section: 'notifs',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.mail.transport.auth.pass',
    section: 'notifs',
    type: 'string',
    required: false,
    sensitive: true,
  },
  {
    key: 'notifs.webpush.enabled',
    section: 'notifs',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.webpush.vapidSubject',
    section: 'notifs',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'notifs.webpush.vapidPublicKey',
    section: 'notifs',
    type: 'string',
    required: false,
    sensitive: true,
  },
  {
    key: 'notifs.webpush.vapidPrivateKey',
    section: 'notifs',
    type: 'string',
    required: false,
    sensitive: true,
  },
  {
    key: 'notifs.pushover.enabled',
    section: 'notifs',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  // ── Métriques ──
  {
    key: 'metrics.bearerToken',
    section: 'metrics',
    type: 'string',
    required: false,
    sensitive: true,
  },
  // ── Auth ──
  {
    key: 'auth.google.enabled',
    section: 'auth',
    type: 'boolean',
    required: false,
    sensitive: false,
  },
  {
    key: 'auth.google.client_id',
    section: 'auth',
    type: 'string',
    required: false,
    sensitive: false,
  },
  {
    key: 'auth.google.client_secret',
    section: 'auth',
    type: 'string',
    required: false,
    sensitive: true,
  },
];

function deepGet(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function deepSet(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

module.exports = {
  loadConfig,
  getConfig,
  getConfigDir,
  getConfigFilePath,
  ENV_OVERRIDES,
  CONFIG_FIELDS,
  deepGet,
  deepSet,
  castEnvValue,
};
