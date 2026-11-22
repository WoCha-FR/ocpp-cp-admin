'use strict';

// ── Contrôle du secret de session (webui.sessionSecret / CPADMIN_SESSION_SECRET) ──
// Module pur. Le secret signe le cookie de session : un secret connu (valeur d'exemple des
// fichiers docker-compose) ou trop court affaiblit la protection des sessions. Un secret vide
// n'est pas dangereux (l'application en tire un au hasard) mais déconnecte tous les
// utilisateurs à chaque redémarrage.

const MIN_LENGTH = 32;
// Valeurs d'exemple livrées dans les fichiers compose / env.example
const PLACEHOLDER_RE = /change-?me/i;

/**
 * @param {string|undefined|null} secret
 * @returns {null | {code: 'empty'|'placeholder'|'too_short', message: string}}
 */
function checkSessionSecret(secret) {
  const s = typeof secret === 'string' ? secret : '';
  if (s === '') {
    return {
      code: 'empty',
      message:
        'webui.sessionSecret is empty: a random secret is generated at each start, so every user is ' +
        'logged out when the server restarts. Set CPADMIN_SESSION_SECRET (32+ random characters).',
    };
  }
  if (PLACEHOLDER_RE.test(s)) {
    return {
      code: 'placeholder',
      message:
        'webui.sessionSecret still has its example value ("change-me…"): session cookies are signed ' +
        'with a publicly known secret. Set CPADMIN_SESSION_SECRET to 32+ random characters, e.g. ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    };
  }
  if (s.length < MIN_LENGTH) {
    return {
      code: 'too_short',
      message: `webui.sessionSecret is only ${s.length} characters long: use at least ${MIN_LENGTH} random characters.`,
    };
  }
  return null;
}

module.exports = { checkSessionSecret, MIN_LENGTH };
