const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';

// ── Couleurs ANSI pour les scopes en console ──
// Les scopes connus ont une couleur fixe. Tout nouveau scope reçoit
// automatiquement une couleur stable (basée sur un hash du nom).
const SCOPE_COLORS = {
  CPADM: '\x1b[32m',
  WEBUI: '\x1b[33m',
  OCPP: '\x1b[34m',
  NOTIF: '\x1b[35m',
  SQLDB: '\x1b[31m',
};
const RESET = '\x1b[0m';

// Palette de couleurs vives pour les scopes non déclarés
const AUTO_PALETTE = [
  '\x1b[31m', // rouge
  '\x1b[32m', // vert
  '\x1b[33m', // jaune
  '\x1b[34m', // bleu
  '\x1b[35m', // magenta
  '\x1b[36m', // cyan
  '\x1b[90m', // gris
  '\x1b[91m', // rouge clair
  '\x1b[92m', // vert clair
  '\x1b[93m', // jaune clair
  '\x1b[94m', // bleu clair
  '\x1b[95m', // magenta clair
  '\x1b[96m', // cyan clair
];

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function colorScope(scope) {
  if (!scope) return '';
  let color = SCOPE_COLORS[scope];
  if (!color) {
    // Attribuer une couleur stable basée sur le hash du nom
    color = AUTO_PALETTE[hashCode(scope) % AUTO_PALETTE.length];
    SCOPE_COLORS[scope] = color; // mettre en cache
  }
  return `${color}[${scope}]${RESET} `;
}

// ── Format human-readable partagé (console + fichier) ──
const readableFormat = winston.format.printf(
  // eslint-disable-next-line no-unused-vars
  ({ timestamp, level, message, scope, service, stack, ...meta }) => {
    const s = scope ? `[${scope}] ` : '';
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const stackTrace = stack ? `\n${stack}` : '';
    return `${timestamp} ${level}: ${s}${message}${extra}${stackTrace}`;
  }
);

// ── Format console avec scope colorisé ──
const consoleFormat = winston.format.printf(
  // eslint-disable-next-line no-unused-vars
  ({ timestamp, level, message, scope, service, stack, ...meta }) => {
    const s = colorScope(scope);
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const stackTrace = stack ? `\n${stack}` : '';
    return `${timestamp} ${level}: ${s}${message}${extra}${stackTrace}`;
  }
);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true })
  ),
  defaultMeta: { service: 'CPADMIN' },
  transports: [
    // Fichier principal (tous les niveaux)
    new winston.transports.DailyRotateFile({
      dirname: path.join(__dirname, '..', 'logs'),
      filename: 'app-%DATE%.log',
      maxSize: '20m',
      maxFiles: '30d',
      format: winston.format.combine(winston.format.uncolorize(), readableFormat),
    }),
    // Fichier erreurs uniquement
    new winston.transports.DailyRotateFile({
      dirname: path.join(__dirname, '..', 'logs'),
      filename: 'error-%DATE%.log',
      level: 'error',
      maxSize: '20m',
      maxFiles: '90d',
      format: winston.format.combine(winston.format.uncolorize(), readableFormat),
    }),
  ],
});

// ── Console en mode développement ou si LOG_CONSOLE=true ──
const consoleEnabled = isDev || process.env.LOG_CONSOLE === 'true';
if (consoleEnabled) {
  logger.add(
    new winston.transports.Console({
      format: isDev
        ? winston.format.combine(winston.format.colorize(), consoleFormat)
        : winston.format.combine(winston.format.uncolorize(), consoleFormat),
    })
  );
}

// ── Factory pour créer des child loggers par module ──
logger.scope = (scopeName) => logger.child({ scope: scopeName });

// ── Modifier le niveau de log à chaud (après chargement config par ex.) ──
logger.setLevel = (level) => {
  logger.info(`Log level changed to '${level}'`, { scope: 'CPADM' });
  logger.level = level;
  logger.transports.forEach((t) => {
    // Ne pas changer le niveau du transport error-only
    if (t.filename && t.filename.startsWith('error-')) return;
    t.level = level;
  });
};

module.exports = logger;
