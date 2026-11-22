'use strict';

// ── Archive de sauvegarde : base SQLite + certificats critiques (ZIP) ──
// Module volontairement autonome (aucun require de ./config ni ./logger) : il est utilisé
// à la fois par la route GET /admin/db/backup et par scripts/backup.js (cron), qui lui
// fournissent la configuration et le dossier de config.
//
// Périmètre des certificats (secrets non régénérables sans réémission sur chaque borne) :
//   - CA cliente locale (cert + clé + fichier de série .srl) ;
//   - certificats clients par borne (certs/clients/cp-<identity>/) ;
//   - CA manuelle `ocpp.wss.caFile` (+ clé sœur si trouvée).
// Exclus : certs serveur WSS (Let's Encrypt/Traefik), cert HTTPS webui, racine publique.

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const DEFAULT_CLIENT_CA_CERT = 'certs/clients/ca.crt';
const DEFAULT_CLIENT_CA_KEY = 'certs/clients/ca.key';

const toPosix = (p) => p.split(path.sep).join('/');
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// Chemin dans l'archive : relatif au dossier de config si le fichier s'y trouve
// (la restauration se résume à dézipper dans ce dossier), sinon external/<n>-<nom>.
function makeEntryNamer(configDir) {
  const root = path.resolve(configDir);
  let externalCount = 0;
  return (absPath) => {
    const rel = path.relative(root, absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
    externalCount += 1;
    return `external/${externalCount}-${path.basename(absPath)}`;
  };
}

// Clé sœur d'un fichier de CA : <base>.key, <base>-key.pem, <base>.key.pem, puis ca.key dans le même dossier.
function findSiblingKey(caPath) {
  const dir = path.dirname(caPath);
  const base = path.basename(caPath, path.extname(caPath));
  const candidates = [
    path.join(dir, `${base}.key`),
    path.join(dir, `${base}-key.pem`),
    path.join(dir, `${base}.key.pem`),
    path.join(dir, 'ca.key'),
  ];
  return candidates.find(isFile) || null;
}

function listClientCertFiles(clientsDir) {
  let entries;
  try {
    entries = fs.readdirSync(clientsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('cp-')) continue;
    const dir = path.join(clientsDir, entry.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile()) files.push(path.join(dir, f.name));
    }
  }
  return files;
}

/**
 * Liste les fichiers de certificats à inclure dans la sauvegarde.
 * @param {object} config     configuration applicative (ocpp.wss.clientCa / caFile)
 * @param {string} configDir  dossier de config (base de résolution des chemins relatifs)
 * @returns {{ files: {absPath: string, entryName: string, source: string}[], warnings: string[] }}
 */
function listBackupCertFiles(config, configDir) {
  const wss = config?.ocpp?.wss || {};
  const clientCa = wss.clientCa || {};
  const resolve = (p) => path.resolve(configDir, p);
  const name = makeEntryNamer(configDir);

  const files = [];
  const seen = new Set();
  const warnings = [];
  const add = (absPath, source) => {
    if (seen.has(absPath) || !isFile(absPath)) return;
    seen.add(absPath);
    files.push({ absPath, entryName: name(absPath), source });
  };

  // CA cliente locale
  const caCert = resolve(clientCa.certFile || DEFAULT_CLIENT_CA_CERT);
  const caKey = resolve(clientCa.keyFile || DEFAULT_CLIENT_CA_KEY);
  const caSerial = path.join(
    path.dirname(caCert),
    `${path.basename(caCert, path.extname(caCert))}.srl`
  );
  add(caCert, 'local client CA');
  add(caKey, 'local client CA');
  add(caSerial, 'local client CA');
  if (isFile(caCert) !== isFile(caKey)) {
    warnings.push(
      `Local client CA is incomplete: ${isFile(caCert) ? 'private key' : 'certificate'} not found (${isFile(caCert) ? caKey : caCert}).`
    );
  }

  // Certificats clients par borne
  // (dossier fixe, cf. getClientCertDir dans certAuthority.js)
  for (const f of listClientCertFiles(resolve('certs/clients')))
    add(f, 'charge point client certificate');
  // Liste de révocation (empreintes) : sans elle, une restauration réactiverait les certificats révoqués
  add(resolve('certs/clients/revoked.json'), 'revoked client certificates');

  // CA manuelle (security profile 3)
  if (wss.caFile) {
    const manualCa = resolve(wss.caFile);
    if (!isFile(manualCa)) {
      warnings.push(`ocpp.wss.caFile is set but the file was not found: ${manualCa}.`);
    } else {
      add(manualCa, 'manual mTLS CA (ocpp.wss.caFile)');
      const sibling = findSiblingKey(manualCa);
      if (sibling) {
        add(sibling, 'manual mTLS CA (ocpp.wss.caFile)');
      } else {
        warnings.push(
          `No private key found next to ocpp.wss.caFile (${manualCa}): it is NOT in this backup — ` +
            'if it is not stored elsewhere, losing it means re-issuing every charge point certificate.'
        );
      }
    }
  }

  return { files, warnings };
}

function buildManifest({ dbEntryName, files, warnings }) {
  const lines = [
    'OCPP CP Admin backup',
    `Created: ${new Date().toISOString()}`,
    '',
    `Database: ${dbEntryName}`,
    '',
    `Certificates (${files.length}):`,
    ...(files.length
      ? files.map((f) => `  ${f.entryName}  <-  ${f.absPath}  [${f.source}]`)
      : ['  (none)']),
  ];
  if (warnings.length) lines.push('', 'WARNINGS:', ...warnings.map((w) => `  - ${w}`));
  lines.push(
    '',
    'Restore: stop the app, unzip this archive into the config directory (entries are',
    'relative to it), remove cpadmin.db-shm / cpadmin.db-wal, restart. Entries under',
    'external/ come from outside the config directory: copy them back to the original path above.',
    ''
  );
  return lines.join('\n');
}

/**
 * Crée l'archive ZIP (base SQLite déjà sauvegardée + certificats + MANIFEST.txt).
 * @param {object} opts
 * @param {string} opts.sqlitePath    copie cohérente de la base (db.backup)
 * @param {string} opts.dbEntryName   nom de l'entrée de la base dans l'archive (ex. cpadmin.db)
 * @param {string} opts.outPath       fichier .zip à écrire
 * @param {object} opts.config        configuration applicative
 * @param {string} opts.configDir     dossier de config
 * @returns {Promise<{ files: object[], warnings: string[] }>}
 */
function createBackupArchive({ sqlitePath, dbEntryName, outPath, config, configDir }) {
  const { files, warnings } = listBackupCertFiles(config, configDir);
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const out = fs.createWriteStream(outPath);
    out.on('close', () => resolve({ files, warnings }));
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);

    zip.addFile(sqlitePath, dbEntryName);
    for (const f of files) zip.addFile(f.absPath, f.entryName, { mode: 0o100600 });
    zip.addBuffer(
      Buffer.from(buildManifest({ dbEntryName, files, warnings }), 'utf8'),
      'MANIFEST.txt'
    );
    zip.end();
  });
}

module.exports = { createBackupArchive, listBackupCertFiles };
