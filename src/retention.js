'use strict';

// ── Rétention automatique des données ──
// Tâche quotidienne qui efface les données techniques échues et anonymise les sessions échues.
// Durées en jours (retention.* / CPADMIN_RETENTION_*), 0 = jamais. Les valeurs par défaut :
// journal OCPP 90 j ; rejets (événements de badge), erreurs, réservations terminées et journal
// des notifications 1 an ; courbes de mesure 2 ans (le coût figé et son détail restent) ;
// sessions 5 ans puis anonymisées (jamais supprimées).
//
// Activation : retention.enabled (fichier de configuration) ou CPADMIN_RETENTION_ENABLED, qui
// l'emporte. Absente = inactive : une instance mise à jour (config.json sans la clé) n'efface
// rien tant que l'admin ne l'active pas ; une installation neuve part de config.sample.json, où
// elle est active.

const db = require('./database');
const { getConfig } = require('./config');
const logger = require('./logger').scope('RETEN');

const DAY_MS = 86400000;

const RETENTION_TARGETS = [
  { key: 'ocppMessages', configKey: 'ocppMessagesDays', defaultDays: 90 },
  { key: 'rejections', configKey: 'rejectionsDays', defaultDays: 365 },
  { key: 'errorEvents', configKey: 'errorEventsDays', defaultDays: 365 },
  { key: 'reservations', configKey: 'reservationsDays', defaultDays: 365 },
  { key: 'notifications', configKey: 'notificationsDays', defaultDays: 365 },
  { key: 'meterValues', configKey: 'meterValuesDays', defaultDays: 730 },
  { key: 'sessions', configKey: 'sessionsDays', defaultDays: 1825 },
];

/** Durées effectives (jours, 0 = jamais) ; une valeur invalide reprend la valeur par défaut */
function getRetentionDays(cfg = getConfig()) {
  const section = (cfg && cfg.retention) || {};
  const out = {};
  for (const { key, configKey, defaultDays } of RETENTION_TARGETS) {
    const raw = section[configKey];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (raw === undefined || raw === null || raw === '') {
      out[key] = defaultDays;
    } else if (Number.isInteger(n) && n >= 0) {
      out[key] = n;
    } else {
      logger.warn(`Invalid retention.${configKey} (${raw}): default ${defaultDays} days used`);
      out[key] = defaultDays;
    }
  }
  return out;
}

/** Dates limites (AAAA-MM-JJ, UTC) : ce qui est antérieur est concerné ; null = jamais */
function getCutoffs(days, now = new Date()) {
  const out = {};
  for (const [key, n] of Object.entries(days)) {
    out[key] = n > 0 ? new Date(now.getTime() - n * DAY_MS).toISOString().slice(0, 10) : null;
  }
  return out;
}

/** { enabled, source: 'env' | 'config' | 'default' } */
function getRetentionActivation(cfg = getConfig()) {
  const value = cfg && cfg.retention ? cfg.retention.enabled : undefined;
  const source =
    process.env.CPADMIN_RETENTION_ENABLED !== undefined
      ? 'env'
      : value !== undefined
        ? 'config'
        : 'default';
  return { enabled: value === true, source };
}

// Dernier passage, en mémoire (aussi tracé dans le journal) : remis à zéro au redémarrage
let lastRun = null;

function getLastRun() {
  return lastRun;
}

/** État complet pour la page Administration : activation, durées, aperçu, dernier passage */
function getRetentionStatus(now = new Date()) {
  const days = getRetentionDays();
  const cutoffs = getCutoffs(days, now);
  return {
    ...getRetentionActivation(),
    days,
    cutoffs,
    preview: db.countRetention(cutoffs),
    lastRun: getLastRun(),
  };
}

/**
 * Passage de rétention. Sans `force`, ne fait rien si la rétention est inactive.
 * @returns {{ran: boolean, counts?: object, at?: string}}
 */
function runRetention({ now = new Date(), force = false } = {}) {
  if (!force && !getRetentionActivation().enabled) return { ran: false };
  const cutoffs = getCutoffs(getRetentionDays(), now);
  const counts = db.applyRetention(cutoffs);
  const at = now.toISOString();
  lastRun = { at, counts };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    logger.info(
      `Retention: ${Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')}`
    );
  } else {
    logger.debug('Retention: nothing to delete');
  }
  return { ran: true, counts, at };
}

// Premier passage quelques minutes après le démarrage, puis toutes les 24 h
let startTimer = null;
let dailyTimer = null;

function safeRun() {
  try {
    runRetention();
  } catch (err) {
    logger.error(`Retention run failed: ${err.message}`);
  }
}

function startRetentionScheduler({ initialDelayMs = 5 * 60 * 1000 } = {}) {
  stopRetentionScheduler();
  startTimer = setTimeout(safeRun, initialDelayMs);
  dailyTimer = setInterval(safeRun, DAY_MS);
  if (startTimer.unref) startTimer.unref();
  if (dailyTimer.unref) dailyTimer.unref();
  const { enabled, source } = getRetentionActivation();
  logger.info(
    `Retention scheduler started (${enabled ? 'enabled' : 'disabled'}, set by ${source})`
  );
}

function stopRetentionScheduler() {
  if (startTimer) clearTimeout(startTimer);
  if (dailyTimer) clearInterval(dailyTimer);
  startTimer = null;
  dailyTimer = null;
}

module.exports = {
  RETENTION_TARGETS,
  getRetentionDays,
  getCutoffs,
  getRetentionActivation,
  getRetentionStatus,
  runRetention,
  startRetentionScheduler,
  stopRetentionScheduler,
};
