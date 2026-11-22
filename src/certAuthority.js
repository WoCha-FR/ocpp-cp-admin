'use strict';

// ── CA locale + génération de certificats clients OCPP (Security Profile 3 / mTLS) ──
// Aucune dépendance ajoutée : utilise le binaire `openssl` du système via execFile
// (jamais `exec`, pour éviter toute injection shell sur l'identité de la borne).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getConfig, getConfigDir } = require('./config');
const logger = require('./logger').scope('CERTCA');

const execFileAsync = promisify(execFile);

const CA_CN = 'OCPP-CP-Admin Local CA';
const DEFAULT_CLIENT_CA_CERT = 'certs/clients/ca.crt';
const DEFAULT_CLIENT_CA_KEY = 'certs/clients/ca.key';
const DEFAULT_VALIDITY_DAYS = 1825; // 5 ans

let opensslAvailable = null;

function clientCaConfig() {
  const config = getConfig();
  const clientCa = config.ocpp?.wss?.clientCa || {};
  return {
    certFile: clientCa.certFile || DEFAULT_CLIENT_CA_CERT,
    keyFile: clientCa.keyFile || DEFAULT_CLIENT_CA_KEY,
    certValidityDays: clientCa.certValidityDays || DEFAULT_VALIDITY_DAYS,
  };
}

function clientCaPaths() {
  const { certFile, keyFile } = clientCaConfig();
  return {
    certPath: path.resolve(getConfigDir(), certFile),
    keyPath: path.resolve(getConfigDir(), keyFile),
  };
}

// ── Disponibilité d'openssl (vérifiée une fois, mise en cache) ──
async function isOpensslAvailable() {
  if (opensslAvailable !== null) return opensslAvailable;
  try {
    await execFileAsync('openssl', ['version']);
    opensslAvailable = true;
    // eslint-disable-next-line no-unused-vars
  } catch (e) {
    logger.warn('openssl introuvable — génération de certificats clients désactivée');
    opensslAvailable = false;
  }
  return opensslAvailable;
}

// Réservé aux tests : permet de forcer/réinitialiser le cache de détection.
function _resetOpensslCache() {
  opensslAvailable = null;
}

// ── Initialisation de la CA locale (auto-signée) si absente ──
async function ensureLocalCaInitialized() {
  if (!(await isOpensslAvailable())) return false;
  const { certPath, keyPath } = clientCaPaths();
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return true;

  fs.mkdirSync(path.dirname(certPath), { recursive: true, mode: 0o700 });
  const { certValidityDays } = clientCaConfig();

  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-days',
    String(certValidityDays),
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    `/CN=${CA_CN}`,
  ]);
  restrictPrivateKey(keyPath);
  logger.info(`CA locale initialisée : ${certPath}`);
  return true;
}

// Clé privée lisible par le seul propriétaire (0600). OpenSSL le fait déjà avec -keyout
// récent ; ce chmod explicite ne dépend ni de la version d'OpenSSL ni de l'umask.
function restrictPrivateKey(keyPath) {
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch (e) {
    logger.warn(`chmod 0600 impossible sur ${keyPath}: ${e.message}`);
  }
}

function getClientCertDir(identity) {
  return path.resolve(getConfigDir(), 'certs', 'clients', `cp-${identity}`);
}

function getClientCertPaths(identity) {
  const dir = getClientCertDir(identity);
  return {
    certPath: path.join(dir, 'cert.pem'),
    keyPath: path.join(dir, 'key.pem'),
  };
}

function hasClientCert(identity) {
  const { certPath, keyPath } = getClientCertPaths(identity);
  return fs.existsSync(certPath) && fs.existsSync(keyPath);
}

// ── Révocation des certificats clients ──
// Le serveur ne vérifie que « signé par la CA + CN == identité » : sans liste de révocation, un
// certificat régénéré (compromission supposée) ou d'une borne supprimée resterait valide
// jusqu'à son expiration. La liste (empreintes SHA-256) est consultée à chaque connexion mTLS :
// effet immédiat, sans redémarrage. Seuls les certificats générés par l'application y figurent ;
// ceux d'une CA manuelle (ocpp.wss.caFile) ne sont pas concernés.
function revokedListPath() {
  return path.resolve(getConfigDir(), 'certs', 'clients', 'revoked.json');
}

function readRevokedList() {
  try {
    const parsed = JSON.parse(fs.readFileSync(revokedListPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT' && e.name !== 'TypeError') {
      logger.error(
        `Liste de révocation illisible (${e.message}) : aucun certificat n'est révoqué !`
      );
    }
    return {};
  }
}

function writeRevokedList(list) {
  const file = revokedListPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // écriture atomique : jamais de liste tronquée
}

function certFingerprint(certPath) {
  try {
    return new crypto.X509Certificate(fs.readFileSync(certPath)).fingerprint256;
  } catch {
    return null;
  }
}

// Révoque le certificat actuellement en place pour cette identité ; retourne son empreinte ou null
function revokeClientCertificate(identity, reason = 'regenerated') {
  const { certPath } = getClientCertPaths(identity);
  const fingerprint = certFingerprint(certPath);
  if (!fingerprint) return null;
  const list = readRevokedList();
  list[fingerprint] = { identity, reason, revokedAt: new Date().toISOString() };
  writeRevokedList(list);
  logger.warn(`Certificat client révoqué pour ${identity} (${reason}) : ${fingerprint}`);
  return fingerprint;
}

// Certificat présenté par une borne (objet de socket.getPeerCertificate()) révoqué ?
function isClientCertRevoked(peerCert) {
  const fingerprint = peerCert && peerCert.fingerprint256;
  if (!fingerprint) return false;
  return Object.prototype.hasOwnProperty.call(readRevokedList(), String(fingerprint).toUpperCase());
}

// Suppression d'une borne : le certificat est révoqué puis les fichiers (dont la clé) effacés
function removeClientCertificate(identity) {
  const revoked = revokeClientCertificate(identity, 'chargepoint_deleted');
  fs.rmSync(getClientCertDir(identity), { recursive: true, force: true });
  return revoked;
}

// ── Date d'expiration du certificat client (lecture, sans dépendance) ──
async function getClientCertExpiry(identity) {
  if (!hasClientCert(identity)) return null;
  if (!(await isOpensslAvailable())) return null;
  const { certPath } = getClientCertPaths(identity);
  try {
    const { stdout } = await execFileAsync('openssl', [
      'x509',
      '-enddate',
      '-noout',
      '-in',
      certPath,
    ]);
    const match = stdout.match(/notAfter=(.+)/);
    if (!match) return null;
    const date = new Date(match[1].trim());
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch (e) {
    logger.warn(`Lecture de la date d'expiration impossible pour ${identity}: ${e.message}`);
    return null;
  }
}

// ── Génération (ou régénération) du certificat client d'une borne ──
// La CN du certificat est fixée à l'identité exacte de la borne : c'est ce qui
// permet la vérification CN == identity côté serveur lors de la connexion mTLS.
async function generateClientCertificate(identity) {
  if (!(await isOpensslAvailable())) {
    throw new Error('ERR_OPENSSL_UNAVAILABLE');
  }
  if (!(await ensureLocalCaInitialized())) {
    throw new Error('ERR_OPENSSL_UNAVAILABLE');
  }

  const { certPath: caCertPath, keyPath: caKeyPath } = clientCaPaths();
  const { certValidityDays } = clientCaConfig();
  const dir = getClientCertDir(identity);
  const { certPath, keyPath } = getClientCertPaths(identity);

  // Tout est généré dans un dossier temporaire (0700) puis installé : un échec openssl ne
  // laisse jamais une paire clé/certificat à moitié remplacée, et l'ancien certificat n'est
  // révoqué qu'une fois le nouveau prêt.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-csr-'));
  const csrPath = path.join(tmpDir, 'client.csr');
  const newKeyPath = path.join(tmpDir, 'key.pem');
  const newCertPath = path.join(tmpDir, 'cert.pem');
  let revokedPrevious;
  try {
    await execFileAsync('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      newKeyPath,
      '-out',
      csrPath,
      '-subj',
      `/CN=${identity}`,
    ]);

    await execFileAsync('openssl', [
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      caCertPath,
      '-CAkey',
      caKeyPath,
      '-CAcreateserial',
      '-out',
      newCertPath,
      '-days',
      String(certValidityDays),
    ]);

    revokedPrevious = revokeClientCertificate(identity, 'regenerated');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(newKeyPath, keyPath);
    restrictPrivateKey(keyPath);
    fs.copyFileSync(newCertPath, certPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  logger.info(`Certificat client généré pour ${identity}`);
  return { certPath, keyPath, revokedPrevious };
}

// ── PEM combiné (cert + clé) pour le téléchargement ──
// rootBundle (optionnel) : racine(s) serveur ajoutée(s) à la suite, pour les firmwares qui
// n'ont qu'un seul fichier à installer (le PEM client remplacerait sinon la racine serveur).
function getCombinedClientCertPem(identity, rootBundle = null) {
  const { certPath, keyPath } = getClientCertPaths(identity);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
  const cert = fs.readFileSync(certPath, 'utf8').trim();
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  const roots = rootBundle ? `${rootBundle.trim()}\n` : '';
  return `${cert}\n${key}\n${roots}`;
}

// ── Vérification CN == identity pour une connexion mTLS ──
// Utilisée par l'enforcement des profils de sécurité OCPP 2.0.1 (branchement
// laissé à ocpp-common.js, gated par le flag ocpp.v201.enforceSecurityProfile).
function verifyClientCertMatchesIdentity(peerCert, identity) {
  if (!peerCert || !peerCert.subject) return false;
  return peerCert.subject.CN === identity;
}

// ── Double sécurité : enforcement actif mais aucune CA pour vérifier les certificats clients ──
// Sans ocpp.wss.caFile, Node ne fait confiance qu'aux CA publiques par défaut : un certificat
// signé par la CA locale n'est jamais « authorized » et toute connexion mTLS est refusée.
// Retourne le message d'avertissement à logger au démarrage, ou null s'il n'y a rien à signaler.
function getClientCaConfigWarning() {
  const config = getConfig();
  const enforced = [
    config.ocpp?.v16?.enforceSecurityProfile && '1.6',
    config.ocpp?.v201?.enforceSecurityProfile && '2.0.1',
  ].filter(Boolean);
  if (enforced.length === 0 || config.ocpp?.wss?.caFile) return null;

  const { certFile } = clientCaConfig();
  const { certPath } = clientCaPaths();
  const base =
    `OCPP security profile enforcement is enabled (OCPP ${enforced.join(', ')}) but ocpp.wss.caFile is empty: ` +
    'client certificates (mTLS) cannot be verified and every mTLS connection will be refused';
  return fs.existsSync(certPath)
    ? `${base}. The local client CA was found — set ocpp.wss.caFile to "${certFile}" and restart`
    : `${base}. Only Basic Auth connections will be accepted; set ocpp.wss.caFile to your client CA file to allow mTLS`;
}

module.exports = {
  getClientCaConfigWarning,
  isOpensslAvailable,
  ensureLocalCaInitialized,
  generateClientCertificate,
  getClientCertPaths,
  hasClientCert,
  getClientCertExpiry,
  getCombinedClientCertPem,
  revokeClientCertificate,
  isClientCertRevoked,
  removeClientCertificate,
  verifyClientCertMatchesIdentity,
  clientCaPaths,
  _resetOpensslCache,
};
