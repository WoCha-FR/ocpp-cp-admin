'use strict';

// Vérifie la désactivation propre de la génération de certificats clients quand
// openssl est introuvable sur le système (cas Windows sans openssl sur le PATH).

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({ ocpp: { wss: { clientCa: {} } } })),
  getConfigDir: jest.fn(() => tmpDir),
}));

jest.mock('../../src/logger', () => ({
  scope: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('child_process', () => ({
  execFile: (cmd, args, cb) => cb(new Error('spawn openssl ENOENT')),
}));

const certAuthority = require('../../src/certAuthority');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-certauth-noopenssl-'));
  certAuthority._resetOpensslCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('certAuthority — openssl indisponible', () => {
  it('isOpensslAvailable retourne false', async () => {
    expect(await certAuthority.isOpensslAvailable()).toBe(false);
  });

  it("ensureLocalCaInitialized retourne false sans créer de fichier", async () => {
    expect(await certAuthority.ensureLocalCaInitialized()).toBe(false);
    const { certPath } = certAuthority.clientCaPaths();
    expect(fs.existsSync(certPath)).toBe(false);
  });

  it('generateClientCertificate rejette avec ERR_OPENSSL_UNAVAILABLE', async () => {
    await expect(certAuthority.generateClientCertificate('CP-NOSSL')).rejects.toThrow(
      'ERR_OPENSSL_UNAVAILABLE'
    );
  });

  it('getClientCertExpiry retourne null (aucun cert, pas de crash)', async () => {
    expect(await certAuthority.getClientCertExpiry('CP-NOSSL')).toBeNull();
  });
});
