'use strict';

// ── CA locale + génération de certificats clients OCPP (Security Profile 3 / mTLS) ──
// Aucune dépendance ajoutée : utilise le binaire `openssl` du système via execFile
// (jamais `exec`, pour éviter toute injection shell sur l'identité de la borne).

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

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
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
  logger.info(`CA locale initialisée : ${certPath}`);
  return true;
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
  fs.mkdirSync(dir, { recursive: true });
  const { certPath, keyPath } = getClientCertPaths(identity);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-csr-'));
  const csrPath = path.join(tmpDir, 'client.csr');
  try {
    await execFileAsync('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
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
      certPath,
      '-days',
      String(certValidityDays),
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  logger.info(`Certificat client généré pour ${identity}`);
  return { certPath, keyPath };
}

// ── PEM combiné (cert + clé) pour le téléchargement ──
function getCombinedClientCertPem(identity) {
  const { certPath, keyPath } = getClientCertPaths(identity);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
  const cert = fs.readFileSync(certPath, 'utf8').trim();
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  return `${cert}\n${key}\n`;
}

// ── Vérification CN == identity pour une connexion mTLS ──
// Utilisée par l'enforcement des profils de sécurité OCPP 2.0.1 (branchement
// laissé à ocpp-common.js, gated par le flag ocpp.v201.enforceSecurityProfile).
function verifyClientCertMatchesIdentity(peerCert, identity) {
  if (!peerCert || !peerCert.subject) return false;
  return peerCert.subject.CN === identity;
}

module.exports = {
  isOpensslAvailable,
  ensureLocalCaInitialized,
  generateClientCertificate,
  getClientCertPaths,
  hasClientCert,
  getClientCertExpiry,
  getCombinedClientCertPem,
  verifyClientCertMatchesIdentity,
  clientCaPaths,
  _resetOpensslCache,
};
