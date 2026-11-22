'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const { createBackupArchive, listBackupCertFiles } = require('../../src/backupArchive');

function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = {};
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve(entries));
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            entries[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

describe('backupArchive', () => {
  let root;
  let configDir;
  const write = (rel, content = rel, base = configDir) => {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-backup-test-'));
    configDir = path.join(root, 'config');
    fs.mkdirSync(configDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('listBackupCertFiles', () => {
    it('ne retourne rien (ni avertissement) sans aucun certificat', () => {
      expect(listBackupCertFiles({ ocpp: { wss: {} } }, configDir)).toEqual({
        files: [],
        warnings: [],
      });
    });

    it('inclut la CA locale, son .srl et les certificats par borne', () => {
      write('certs/clients/ca.crt');
      write('certs/clients/ca.key');
      write('certs/clients/ca.srl');
      write('certs/clients/cp-CP1/cert.pem');
      write('certs/clients/cp-CP1/key.pem');
      write('certs/clients/autre-dossier/x.pem');
      const { files, warnings } = listBackupCertFiles({ ocpp: { wss: {} } }, configDir);
      expect(files.map((f) => f.entryName).sort()).toEqual([
        'certs/clients/ca.crt',
        'certs/clients/ca.key',
        'certs/clients/ca.srl',
        'certs/clients/cp-CP1/cert.pem',
        'certs/clients/cp-CP1/key.pem',
      ]);
      expect(warnings).toEqual([]);
    });

    it('inclut la liste de révocation des certificats clients (sinon une restauration les réactive)', () => {
      write('certs/clients/ca.crt');
      write('certs/clients/ca.key');
      write('certs/clients/revoked.json', '{}');
      const { files } = listBackupCertFiles({ ocpp: { wss: {} } }, configDir);
      const revoked = files.find((f) => f.entryName === 'certs/clients/revoked.json');
      expect(revoked).toBeDefined();
      expect(revoked.source).toBe('revoked client certificates');
    });

    it('sans liste de révocation : rien de plus dans l’archive', () => {
      write('certs/clients/ca.crt');
      write('certs/clients/ca.key');
      const { files } = listBackupCertFiles({ ocpp: { wss: {} } }, configDir);
      expect(files.some((f) => f.entryName.endsWith('revoked.json'))).toBe(false);
    });

    it('avertit si la CA locale est incomplète', () => {
      write('certs/clients/ca.crt');
      const { warnings } = listBackupCertFiles({ ocpp: { wss: {} } }, configDir);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/private key/);
    });

    it('inclut caFile et sa clé sœur sans doublon avec la CA locale', () => {
      write('certs/clients/ca.crt');
      write('certs/clients/ca.key');
      const { files, warnings } = listBackupCertFiles(
        { ocpp: { wss: { caFile: 'certs/clients/ca.crt' } } },
        configDir
      );
      expect(files.map((f) => f.entryName).sort()).toEqual([
        'certs/clients/ca.crt',
        'certs/clients/ca.key',
      ]);
      expect(warnings).toEqual([]);
    });

    it('inclut une CA manuelle hors dossier de config sous external/', () => {
      const caPath = write('pki/mtls-ca.crt', 'CA', root);
      write('pki/mtls-ca.key', 'KEY', root);
      const { files } = listBackupCertFiles({ ocpp: { wss: { caFile: caPath } } }, configDir);
      expect(files.map((f) => f.entryName).sort()).toEqual([
        'external/1-mtls-ca.crt',
        'external/2-mtls-ca.key',
      ]);
    });

    it('avertit si caFile est introuvable', () => {
      const { files, warnings } = listBackupCertFiles(
        { ocpp: { wss: { caFile: 'certs/absent.crt' } } },
        configDir
      );
      expect(files).toEqual([]);
      expect(warnings[0]).toMatch(/not found/);
    });

    it('avertit explicitement si caFile existe sans clé sœur', () => {
      write('certs/ca.crt');
      const { files, warnings } = listBackupCertFiles(
        { ocpp: { wss: { caFile: 'certs/ca.crt' } } },
        configDir
      );
      expect(files.map((f) => f.entryName)).toEqual(['certs/ca.crt']);
      expect(warnings[0]).toMatch(/No private key found/);
    });

    it('respecte clientCa.certFile / keyFile personnalisés', () => {
      write('pki/my-ca.crt');
      write('pki/my-ca.key');
      const { files } = listBackupCertFiles(
        { ocpp: { wss: { clientCa: { certFile: 'pki/my-ca.crt', keyFile: 'pki/my-ca.key' } } } },
        configDir
      );
      expect(files.map((f) => f.entryName).sort()).toEqual(['pki/my-ca.crt', 'pki/my-ca.key']);
    });
  });

  describe('createBackupArchive', () => {
    it('produit un ZIP avec la base, les certificats et le MANIFEST', async () => {
      write('certs/clients/ca.crt', 'CA-CERT');
      write('certs/clients/ca.key', 'CA-KEY');
      write('certs/clients/cp-CP1/cert.pem', 'CP1-CERT');
      write('certs/ca.crt', 'MANUAL-CA');
      const sqlitePath = write('tmp.sqlite', 'SQLITE-DATA', root);
      const outPath = path.join(root, 'out.zip');

      const { files, warnings } = await createBackupArchive({
        sqlitePath,
        dbEntryName: 'cpadmin.db',
        outPath,
        config: { ocpp: { wss: { caFile: 'certs/ca.crt' } } },
        configDir,
      });
      expect(files).toHaveLength(4);
      expect(warnings).toHaveLength(1); // CA manuelle sans clé sœur

      const entries = await readZip(outPath);
      expect(entries['cpadmin.db']).toBe('SQLITE-DATA');
      expect(entries['certs/clients/ca.key']).toBe('CA-KEY');
      expect(entries['certs/clients/cp-CP1/cert.pem']).toBe('CP1-CERT');
      expect(entries['certs/ca.crt']).toBe('MANUAL-CA');
      expect(entries['MANIFEST.txt']).toMatch(/WARNINGS:/);
      expect(entries['MANIFEST.txt']).toMatch(/certs\/clients\/ca\.crt/);
    });

    it('produit un ZIP valide (base + manifeste) sans aucun certificat', async () => {
      const sqlitePath = write('tmp.sqlite', 'DB', root);
      const outPath = path.join(root, 'out.zip');
      await createBackupArchive({
        sqlitePath,
        dbEntryName: 'cpadmin.db',
        outPath,
        config: {},
        configDir,
      });
      const entries = await readZip(outPath);
      expect(Object.keys(entries).sort()).toEqual(['MANIFEST.txt', 'cpadmin.db']);
      expect(entries['MANIFEST.txt']).toMatch(/\(none\)/);
    });
  });
});
