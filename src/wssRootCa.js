'use strict';

// ── Racines de confiance du serveur OCPP WSS ──
// Le serveur présente deux chaînes (RSA et ECDSA) et une borne reçoit l'une ou l'autre
// selon les algorithmes qu'elle annonce. Pour qu'une borne puisse valider le serveur,
// la racine téléchargeable doit donc couvrir les deux :
//   - `ocpp.wss.rootCaFile` s'il est défini (ex. ISRG Root X1 pour Let's Encrypt) ;
//   - chaque certificat serveur (RSA / ECDSA) qui est auto-signé, donc sa propre racine.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getConfig, getConfigDir } = require('./config');

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function parseCerts(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const certs = [];
  for (const pem of text.match(PEM_BLOCK) || []) {
    try {
      certs.push({ pem, x509: new crypto.X509Certificate(pem) });
    } catch {
      // Bloc PEM illisible : ignoré
    }
  }
  return certs;
}

function isSelfSigned(x509) {
  try {
    return x509.checkIssued(x509) && x509.verify(x509.publicKey);
  } catch {
    return false;
  }
}

function readIfExists(file) {
  if (!file) return null;
  const filePath = path.resolve(getConfigDir(), file);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

// Certificats serveur configurés (RSA puis ECDSA) : la feuille est le premier bloc du fichier
function serverLeafCerts() {
  const wss = getConfig().ocpp?.wss || {};
  return [wss.rsa, wss.ecdsa]
    .map((conf) => readIfExists(conf?.certFile))
    .filter(Boolean)
    .map((buf) => parseCerts(buf)[0])
    .filter(Boolean);
}

function configuredRootCerts() {
  const buf = readIfExists(getConfig().ocpp?.wss?.rootCaFile);
  return buf ? parseCerts(buf) : [];
}

// Bundle PEM des racines à installer sur une borne (sans doublon), ou null si aucune
function getWssRootCaBundle() {
  const candidates = [
    ...configuredRootCerts(),
    ...serverLeafCerts().filter((c) => isSelfSigned(c.x509)),
  ];
  const seen = new Set();
  const pems = [];
  for (const { pem, x509 } of candidates) {
    if (seen.has(x509.fingerprint256)) continue;
    seen.add(x509.fingerprint256);
    pems.push(pem);
  }
  return pems.length ? `${pems.join('\n')}\n` : null;
}

// Chaîne servie pendant le handshake pour une paire de certificats : on ajoute la racine
// configurée uniquement si elle n'y figure pas déjà et si elle n'est pas le certificat
// auto-signé de l'autre paire (chaîne sans rapport avec ce certificat).
function buildServerChain(certBuf, otherCertBufs = []) {
  const rootBuf = readIfExists(getConfig().ocpp?.wss?.rootCaFile);
  if (!rootBuf) return certBuf;
  const present = new Set(parseCerts(certBuf).map((c) => c.x509.fingerprint256));
  const foreignRoots = new Set(
    otherCertBufs
      .map((buf) => parseCerts(buf)[0])
      .filter((c) => c && isSelfSigned(c.x509))
      .map((c) => c.x509.fingerprint256)
  );
  const toAppend = parseCerts(rootBuf).filter(
    (c) => !present.has(c.x509.fingerprint256) && !foreignRoots.has(c.x509.fingerprint256)
  );
  if (!toAppend.length) return certBuf;
  return Buffer.concat([certBuf, Buffer.from(`\n${toAppend.map((c) => c.pem).join('\n')}\n`)]);
}

module.exports = { getWssRootCaBundle, buildServerChain, isSelfSigned, parseCerts };
