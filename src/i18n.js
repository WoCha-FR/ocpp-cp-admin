/**
 * Initialisation i18next côté serveur.
 * Utilisé uniquement pour les templates de notification.
 * Les fichiers de traduction sont partagés avec le frontend (locales/*.json).
 */
const i18next = require('i18next');
const path = require('path');
const fs = require('fs');
const { getConfig } = require('./config');
const logger = require('./logger').scope('I18N');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const SUPPORTED_LANGUAGES = [];
const resources = {};

// Charger dynamiquement tous les fichiers de traduction
const files = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
for (const file of files) {
  const lng = path.basename(file, '.json');
  try {
    resources[lng] = { translation: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf-8')) };
    SUPPORTED_LANGUAGES.push(lng);
  } catch (err) {
    logger.error(`Failed to load locale ${file}: ${err.message}`);
  }
}

if (SUPPORTED_LANGUAGES.length === 0) {
  logger.warn('No locale files found in locales/. The application will not function correctly.');
}

const defaultLang = getConfig().language || 'fr';
i18next.init({
  lng: defaultLang,
  fallbackLng: defaultLang,
  resources,
  interpolation: {
    escapeValue: false, // pas d'échappement HTML côté serveur
  },
});

logger.info(`i18next initialized with languages: ${SUPPORTED_LANGUAGES.join(', ')}`);

/**
 * Traduit une clé pour une langue donnée.
 * @param {string} key - Clé de traduction (ex: 'notification.server_started.title')
 * @param {object} [options] - Options i18next (lng, variables d'interpolation…)
 * @returns {string}
 */
function trad(key, options = {}) {
  return i18next.t(key, options);
}

module.exports = { trad, i18next, SUPPORTED_LANGUAGES, LOCALES_DIR };