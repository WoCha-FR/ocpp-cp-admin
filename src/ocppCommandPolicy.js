'use strict';

// ── Politique d'accès à la route générique POST /chargepoints/:id/command ──
// La route relaie une commande OCPP quelconque à la borne. Réservée à l'admin, c'est la
// « console OCPP » ; ouverte à un manager de site, elle lui permettrait de contourner les
// routes réservées à l'admin (ChangeConfiguration / SetVariables = changer l'AuthorizationKey
// ou les URL, UpdateFirmware = installer un firmware, SetNetworkProfile, InstallCertificate,
// DataTransfer, SetChargingProfile hors du cadre géré…). Un manager n'a donc droit qu'aux
// commandes d'exploitation courante de l'interface (boutons de l'onglet Informations).

const MANAGER_ALLOWED_COMMANDS = new Set([
  'Reset',
  'ChangeAvailability',
  'UnlockConnector',
  'TriggerMessage',
  'ClearCache',
  'GetLocalListVersion',
  'GetDiagnostics', // 1.6 — emplacement imposé, voir ci-dessous
  'GetLog', // 2.0.1 — emplacement imposé, voir ci-dessous
]);

// Commandes qui envoient des données de la borne vers une URL fournie par l'appelant : un
// manager ne peut utiliser que l'emplacement configuré par l'admin (ocpp.diagnosticsLocation),
// sinon il pourrait exfiltrer les journaux de la borne vers un serveur de son choix.
function requestedUploadLocation(method, params) {
  if (method === 'GetDiagnostics') return params?.location;
  if (method === 'GetLog') return params?.log?.remoteLocation;
  return undefined;
}

/**
 * @param {string} role     rôle de l'utilisateur ('admin' | 'manager' | …)
 * @param {string} method   action OCPP demandée
 * @param {object} params   paramètres de la commande
 * @param {object} config   configuration applicative (ocpp.diagnosticsLocation)
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function checkCommandAllowed(role, method, params, config) {
  if (role === 'admin') return { ok: true };
  if (!MANAGER_ALLOWED_COMMANDS.has(method)) {
    return { ok: false, error: 'ERR_OCPP_COMMAND_NOT_ALLOWED' };
  }
  if (method === 'GetDiagnostics' || method === 'GetLog') {
    const configured = config?.ocpp?.diagnosticsLocation || '';
    const requested = requestedUploadLocation(method, params) || '';
    if (requested !== configured) {
      return { ok: false, error: 'ERR_OCPP_COMMAND_NOT_ALLOWED' };
    }
  }
  return { ok: true };
}

module.exports = { checkCommandAllowed, MANAGER_ALLOWED_COMMANDS };
