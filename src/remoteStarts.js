'use strict';

// ── Démarrages à distance en attente ──
// Entre l'envoi d'un RemoteStartTransaction (1.6) / RequestStartTransaction (2.0.1) et la
// réception du StartTransaction / TransactionEvent(Started) correspondant, on mémorise QUI a
// demandé le démarrage (source, utilisateur) et AVEC QUEL BADGE.
//
// Le badge sert de garde-fou : seul ce badge bénéficie du démarrage à distance.
//  - M9 : un autre badge présenté sur le même connecteur pendant l'attente reste contrôlé ;
//  - H3 : une borne réglée pour autoriser les démarrages à distance (AuthorizeRemoteTxRequests
//    1.6 / AuthorizeRemoteStart 2.0.1) envoie Authorize avec le badge généré (ADMIN, MGR-x,
//    WEB-x) : il n'est accepté que si un démarrage à distance avec CE badge est en attente
//    sur CETTE borne.
//
// Module pur : la Map est fournie par l'appelant (ocpp-common.pendingRemoteStarts).

// Badges générés par le CSMS (jamais portés par une carte RFID)
const AUTO_TAG_PREFIXES = ['WEB-', 'ADMIN', 'MGR-'];
const PENDING_TTL_MS = 60000;

function isGeneratedTag(idTag) {
  return typeof idTag === 'string' && AUTO_TAG_PREFIXES.some((p) => idTag.startsWith(p));
}

function pendingKey(identity, connectorId) {
  return `${identity}_${connectorId}`;
}

// Clé `${identity}_${connectorId}` (ou ancienne clé `${identity}` seule)
function belongsTo(key, identity) {
  return key === identity || key.startsWith(`${identity}_`);
}

/**
 * Enregistre un démarrage à distance en attente (expire après `ttlMs`).
 * @param {Map} map
 * @param {{source: string, userId: number|null, idTag: string, remoteStartId?: number}} entry
 * @returns {string} la clé
 */
function registerPendingRemoteStart(map, identity, connectorId, entry, ttlMs = PENDING_TTL_MS) {
  const key = pendingKey(identity, connectorId);
  const stored = { ...entry };
  map.set(key, stored);
  const timer = setTimeout(() => {
    // Ne pas effacer une demande plus récente sur le même connecteur
    if (map.get(key) === stored) map.delete(key);
  }, ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  return key;
}

/**
 * Cherche le démarrage à distance en attente correspondant, sur cette borne uniquement.
 * Priorité : remoteStartId (2.0.1, corrélation prévue par la spec), puis le connecteur, puis
 * n'importe quel connecteur de la borne — toujours avec le MÊME badge.
 * @returns {{key: string, entry: object}|null}
 */
function findPendingRemoteStart(
  map,
  identity,
  { connectorId = null, idTag = null, remoteStartId = null } = {}
) {
  const candidates = [];
  for (const [key, entry] of map) {
    if (belongsTo(key, identity)) candidates.push({ key, entry });
  }
  if (remoteStartId != null) {
    const byId = candidates.find((c) => c.entry.remoteStartId === remoteStartId);
    if (byId) return byId;
  }
  if (!idTag) return null;
  const sameTag = candidates.filter((c) => c.entry.idTag === idTag);
  if (connectorId != null) {
    const onConnector = sameTag.find((c) => c.key === pendingKey(identity, connectorId));
    if (onConnector) return onConnector;
  }
  return sameTag[0] || null;
}

module.exports = {
  AUTO_TAG_PREFIXES,
  PENDING_TTL_MS,
  isGeneratedTag,
  pendingKey,
  registerPendingRemoteStart,
  findPendingRemoteStart,
};
