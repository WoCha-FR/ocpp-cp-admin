'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let tmpDir;
let configMock;

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(),
  getConfigDir: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  scope: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { getConfig, getConfigDir } = require('../../src/config');
const certAuthority = require('../../src/certAuthority');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-certauth-'));
  configMock = { ocpp: { wss: { clientCa: {} } } };
  getConfig.mockReturnValue(configMock);
  getConfigDir.mockReturnValue(tmpDir);
  certAuthority._resetOpensslCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('certAuthority — getClientCaConfigWarning', () => {
  it('ne signale rien sans enforcement', () => {
    expect(certAuthority.getClientCaConfigWarning()).toBeNull();
  });

  it('ne signale rien si caFile est renseigné', () => {
    configMock.ocpp.v16 = { enforceSecurityProfile: true };
    configMock.ocpp.wss.caFile = 'certs/clients/ca.crt';
    expect(certAuthority.getClientCaConfigWarning()).toBeNull();
  });

  it('signale caFile vide avec enforcement 1.6 et indique la CA locale trouvée', () => {
    configMock.ocpp.v16 = { enforceSecurityProfile: true };
    fs.mkdirSync(path.join(tmpDir, 'certs/clients'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'certs/clients/ca.crt'), 'x');
    const warning = certAuthority.getClientCaConfigWarning();
    expect(warning).toMatch(/OCPP 1\.6\)/);
    expect(warning).toMatch(/ocpp\.wss\.caFile is empty/);
    expect(warning).toMatch(/local client CA was found — set ocpp\.wss\.caFile to "certs\/clients\/ca\.crt"/);
  });

  it('signale caFile vide avec enforcement 2.0.1 et sans CA locale (Basic Auth seulement)', () => {
    configMock.ocpp.v201 = { enforceSecurityProfile: true };
    const warning = certAuthority.getClientCaConfigWarning();
    expect(warning).toMatch(/OCPP 2\.0\.1\)/);
    expect(warning).toMatch(/Only Basic Auth connections will be accepted/);
  });

  it('mentionne les deux versions quand les deux flags sont actifs', () => {
    configMock.ocpp.v16 = { enforceSecurityProfile: true };
    configMock.ocpp.v201 = { enforceSecurityProfile: true };
    expect(certAuthority.getClientCaConfigWarning()).toMatch(/OCPP 1\.6, 2\.0\.1\)/);
  });
});

describe('certAuthority — isOpensslAvailable', () => {
  it('détecte la disponibilité et met le résultat en cache', async () => {
    const first = await certAuthority.isOpensslAvailable();
    expect(typeof first).toBe('boolean');
    const second = await certAuthority.isOpensslAvailable();
    expect(second).toBe(first);
  });
});

// Les tests suivants nécessitent un vrai binaire openssl (présent sur ubuntu-latest en CI ;
// absent par défaut sous Windows — le test se saute proprement dans ce cas, conformément au
// comportement applicatif attendu : désactivation propre si openssl est introuvable).
// Détection synchrone (indépendante du cache du module) car les blocs it()/it.skip() sont
// résolus à la collecte des tests, avant qu'un beforeAll async n'ait pu s'exécuter.
const opensslAvailableSync = (() => {
  try {
    require('child_process').execFileSync('openssl', ['version']);
    return true;
  } catch (e) {
    return false;
  }
})();

describe('certAuthority — génération de certificats (openssl requis)', () => {
  const itIfOpenssl = (name, fn) => (opensslAvailableSync ? it(name, fn) : it.skip(name, fn));

  itIfOpenssl('initialise une CA locale auto-signée', async () => {
    const ok = await certAuthority.ensureLocalCaInitialized();
    expect(ok).toBe(true);
    const { certPath, keyPath } = certAuthority.clientCaPaths();
    expect(fs.existsSync(certPath)).toBe(true);
    expect(fs.existsSync(keyPath)).toBe(true);
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    expect(cert.subject).toMatch(/CN=OCPP-CP-Admin Local CA/);
    expect(cert.issuer).toBe(cert.subject); // auto-signé
  });

  itIfOpenssl("ne régénère pas la CA si elle existe déjà (idempotent)", async () => {
    await certAuthority.ensureLocalCaInitialized();
    const { certPath } = certAuthority.clientCaPaths();
    const firstMtime = fs.statSync(certPath).mtimeMs;
    await certAuthority.ensureLocalCaInitialized();
    expect(fs.statSync(certPath).mtimeMs).toBe(firstMtime);
  });

  itIfOpenssl('génère un certificat client avec CN == identity, signé par la CA locale', async () => {
    await certAuthority.generateClientCertificate('CP-TEST-001');
    expect(certAuthority.hasClientCert('CP-TEST-001')).toBe(true);

    const { certPath } = certAuthority.getClientCertPaths('CP-TEST-001');
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    expect(cert.subject).toBe('CN=CP-TEST-001');

    const { certPath: caCertPath } = certAuthority.clientCaPaths();
    const caCert = new crypto.X509Certificate(fs.readFileSync(caCertPath));
    expect(cert.checkIssued(caCert)).toBe(true);

    expect(
      certAuthority.verifyClientCertMatchesIdentity({ subject: { CN: 'CP-TEST-001' } }, 'CP-TEST-001')
    ).toBe(true);
    expect(
      certAuthority.verifyClientCertMatchesIdentity({ subject: { CN: 'CP-TEST-001' } }, 'CP-OTHER')
    ).toBe(false);
  });

  itIfOpenssl('hasClientCert / getCombinedClientCertPem reflètent l\'état sur disque', async () => {
    expect(certAuthority.hasClientCert('CP-TEST-002')).toBe(false);
    expect(certAuthority.getCombinedClientCertPem('CP-TEST-002')).toBeNull();

    await certAuthority.generateClientCertificate('CP-TEST-002');
    expect(certAuthority.hasClientCert('CP-TEST-002')).toBe(true);

    const pem = certAuthority.getCombinedClientCertPem('CP-TEST-002');
    expect(pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
  });

  itIfOpenssl('getCombinedClientCertPem ajoute le bundle de racines serveur après la clé', async () => {
    await certAuthority.generateClientCertificate('CP-TEST-ROOT');
    const bundle = '-----BEGIN CERTIFICATE-----\nROOT1\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nROOT2\n-----END CERTIFICATE-----\n';

    const withRoots = certAuthority.getCombinedClientCertPem('CP-TEST-ROOT', bundle);
    expect(withRoots.endsWith(bundle)).toBe(true);
    expect(withRoots.indexOf('PRIVATE KEY')).toBeLessThan(withRoots.indexOf('ROOT1'));
    expect(certAuthority.getCombinedClientCertPem('CP-TEST-ROOT')).not.toContain('ROOT1');
  });

  itIfOpenssl('régénérer un certificat existant remplace la clé/cert précédents', async () => {
    await certAuthority.generateClientCertificate('CP-TEST-003');
    const { certPath } = certAuthority.getClientCertPaths('CP-TEST-003');
    const firstCert = fs.readFileSync(certPath, 'utf8');

    await certAuthority.generateClientCertificate('CP-TEST-003');
    const secondCert = fs.readFileSync(certPath, 'utf8');
    expect(secondCert).not.toBe(firstCert);
  });

  itIfOpenssl('getClientCertExpiry retourne une date ISO future cohérente avec certValidityDays', async () => {
    configMock.ocpp.wss.clientCa.certValidityDays = 30;
    await certAuthority.generateClientCertificate('CP-TEST-004');
    const expiry = await certAuthority.getClientCertExpiry('CP-TEST-004');
    expect(expiry).not.toBeNull();
    const days = (new Date(expiry).getTime() - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(31);
  });
});


// ── Lot C : révocation des certificats clients, génération atomique, permissions ──
describe('certAuthority — révocation (lot C)', () => {
  const itIfOpenssl = (name, fn) => (opensslAvailableSync ? it(name, fn) : it.skip(name, fn));
  const fingerprintOf = (identity) => {
    const { certPath } = certAuthority.getClientCertPaths(identity);
    return new crypto.X509Certificate(fs.readFileSync(certPath)).fingerprint256;
  };
  const revokedFile = () => path.join(tmpDir, 'certs', 'clients', 'revoked.json');

  it("isClientCertRevoked : faux sans liste de révocation, sans empreinte ou sans certificat", () => {
    expect(certAuthority.isClientCertRevoked({ fingerprint256: 'AA:BB' })).toBe(false);
    expect(certAuthority.isClientCertRevoked({})).toBe(false);
    expect(certAuthority.isClientCertRevoked(null)).toBe(false);
  });

  it('isClientCertRevoked : lit la liste (insensible à la casse) ; liste corrompue = aucune révocation, sans exception', () => {
    fs.mkdirSync(path.dirname(revokedFile()), { recursive: true });
    fs.writeFileSync(revokedFile(), JSON.stringify({ 'AA:BB:CC': { identity: 'X' } }));
    expect(certAuthority.isClientCertRevoked({ fingerprint256: 'AA:BB:CC' })).toBe(true);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: 'aa:bb:cc' })).toBe(true);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: 'AA:BB:DD' })).toBe(false);
    fs.writeFileSync(revokedFile(), '{ pas du json');
    expect(certAuthority.isClientCertRevoked({ fingerprint256: 'AA:BB:CC' })).toBe(false);
    fs.writeFileSync(revokedFile(), '["tableau"]');
    expect(certAuthority.isClientCertRevoked({ fingerprint256: 'AA:BB:CC' })).toBe(false);
  });

  it('revokeClientCertificate : null (et aucun fichier) si la borne n\'a pas de certificat', () => {
    expect(certAuthority.revokeClientCertificate('CP-NOCERT')).toBeNull();
    expect(fs.existsSync(revokedFile())).toBe(false);
  });

  itIfOpenssl('la première génération ne révoque rien', async () => {
    const res = await certAuthority.generateClientCertificate('CP-REV-001');
    expect(res.revokedPrevious).toBeNull();
    expect(fs.existsSync(revokedFile())).toBe(false);
  });

  itIfOpenssl('régénérer révoque l\'ancien certificat (empreinte) et pas le nouveau', async () => {
    await certAuthority.generateClientCertificate('CP-REV-002');
    const oldFp = fingerprintOf('CP-REV-002');

    const res = await certAuthority.generateClientCertificate('CP-REV-002');
    const newFp = fingerprintOf('CP-REV-002');

    expect(newFp).not.toBe(oldFp);
    expect(res.revokedPrevious).toBe(oldFp);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: oldFp })).toBe(true);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: newFp })).toBe(false);
    const list = JSON.parse(fs.readFileSync(revokedFile(), 'utf8'));
    expect(list[oldFp]).toMatchObject({ identity: 'CP-REV-002', reason: 'regenerated' });
  });

  itIfOpenssl('plusieurs régénérations : toutes les anciennes empreintes restent révoquées', async () => {
    await certAuthority.generateClientCertificate('CP-REV-003');
    const fp1 = fingerprintOf('CP-REV-003');
    await certAuthority.generateClientCertificate('CP-REV-003');
    const fp2 = fingerprintOf('CP-REV-003');
    await certAuthority.generateClientCertificate('CP-REV-003');
    const fp3 = fingerprintOf('CP-REV-003');
    expect(certAuthority.isClientCertRevoked({ fingerprint256: fp1 })).toBe(true);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: fp2 })).toBe(true);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: fp3 })).toBe(false);
  });

  itIfOpenssl('removeClientCertificate : révoque puis efface le dossier (clé privée comprise)', async () => {
    await certAuthority.generateClientCertificate('CP-REV-004');
    const fp = fingerprintOf('CP-REV-004');
    const dir = path.dirname(certAuthority.getClientCertPaths('CP-REV-004').certPath);

    expect(certAuthority.removeClientCertificate('CP-REV-004')).toBe(fp);
    expect(fs.existsSync(dir)).toBe(false);
    expect(certAuthority.hasClientCert('CP-REV-004')).toBe(false);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: fp })).toBe(true);
    // identité réutilisée : un nouveau certificat est valide, l'ancien reste révoqué
    await certAuthority.generateClientCertificate('CP-REV-004');
    expect(certAuthority.isClientCertRevoked({ fingerprint256: fingerprintOf('CP-REV-004') })).toBe(false);
    expect(certAuthority.isClientCertRevoked({ fingerprint256: fp })).toBe(true);
  });

  it('removeClientCertificate sans certificat : sans effet ni exception', () => {
    expect(() => certAuthority.removeClientCertificate('CP-NEVER')).not.toThrow();
    expect(certAuthority.removeClientCertificate('CP-NEVER')).toBeNull();
  });

  itIfOpenssl('un échec de génération ne modifie ni le certificat actuel ni la liste de révocation', async () => {
    await certAuthority.generateClientCertificate('CP-REV-005');
    const { certPath, keyPath } = certAuthority.getClientCertPaths('CP-REV-005');
    const certBefore = fs.readFileSync(certPath, 'utf8');
    const keyBefore = fs.readFileSync(keyPath, 'utf8');

    // CA illisible → openssl x509 -req échoue après la création de la clé
    const { certPath: caCert } = certAuthority.clientCaPaths();
    fs.writeFileSync(caCert, 'pas un certificat');

    await expect(certAuthority.generateClientCertificate('CP-REV-005')).rejects.toBeDefined();
    expect(fs.readFileSync(certPath, 'utf8')).toBe(certBefore);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(keyBefore);
    expect(fs.existsSync(revokedFile())).toBe(false);
  });

  itIfOpenssl('aucun fichier temporaire (clé privée) ne subsiste après la génération', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cpadmin-csr-'));
    await certAuthority.generateClientCertificate('CP-REV-006');
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cpadmin-csr-'));
    expect(after.length).toBe(before.length);
  });

  // Les droits POSIX n'ont pas de sens sous Windows
  const posixIt = (name, fn) => (process.platform !== 'win32' && opensslAvailableSync ? it(name, fn) : it.skip(name, fn));
  posixIt('clés privées (CA et borne) en 0600, dossiers en 0700', async () => {
    await certAuthority.generateClientCertificate('CP-REV-007');
    const { keyPath: caKey } = certAuthority.clientCaPaths();
    const { keyPath } = certAuthority.getClientCertPaths('CP-REV-007');
    expect(fs.statSync(caKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
  });
});
