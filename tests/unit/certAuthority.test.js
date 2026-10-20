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

