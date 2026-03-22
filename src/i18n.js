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
const CUSTOM_LOCALES_DIR = path.join(__dirname, '..', 'locales-custom');
const SUPPORTED_LANGUAGES = [];
const resources = {};

/**
 * Deep merge source into target (modifies target in place).
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// Charger dynamiquement tous les fichiers de traduction intégrés
const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
for (const file of files) {
  const lng = path.basename(file, '.json');
  try {
    resources[lng] = {
      translation: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf-8')),
    };
    SUPPORTED_LANGUAGES.push(lng);
  } catch (err) {
    logger.error(`Failed to load locale ${file}: ${err.message}`);
  }
}

// Charger les locales personnalisées (ajout ou surcharge)
if (fs.existsSync(CUSTOM_LOCALES_DIR)) {
  const customFiles = fs.readdirSync(CUSTOM_LOCALES_DIR).filter((f) => f.endsWith('.json'));
  for (const file of customFiles) {
    const lng = path.basename(file, '.json');
    try {
      const custom = JSON.parse(fs.readFileSync(path.join(CUSTOM_LOCALES_DIR, file), 'utf-8'));
      if (resources[lng]) {
        // Fusionner par-dessus la locale intégrée
        deepMerge(resources[lng].translation, custom);
        logger.info(`Merged custom locale overrides for '${lng}'`);
      } else {
        // Nouvelle langue ajoutée par l'utilisateur
        resources[lng] = { translation: custom };
        SUPPORTED_LANGUAGES.push(lng);
        logger.info(`Loaded custom locale '${lng}'`);
      }
    } catch (err) {
      logger.error(`Failed to load custom locale ${file}: ${err.message}`);
    }
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
