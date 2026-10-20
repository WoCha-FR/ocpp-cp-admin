'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '../fixtures/wss-root-ca');

// Certificats de test (clés privées non conservées) :
//   rsa-selfsigned / ecdsa-selfsigned : certificats serveur auto-signés (leur propre racine)
//   ca-root + ca-signed-leaf          : feuille signée par une racine publique absente du fichier
let mockWss;

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({ ocpp: { wss: mockWss } })),
  getConfigDir: jest.fn(() => FIXTURES),
}));

const { getWssRootCaBundle, buildServerChain, parseCerts } = require('../../src/wssRootCa');

const read = (name) => fs.readFileSync(path.join(FIXTURES, name));
const count = (buf) => parseCerts(buf).length;
const fingerprints = (buf) => parseCerts(buf).map((c) => c.x509.fingerprint256);

describe('wssRootCa — getWssRootCaBundle', () => {
  it('auto-signé RSA + ECDSA avec rootCaFile sur le RSA seul : le bundle couvre les deux', () => {
    mockWss = {
      rsa: { certFile: 'rsa-selfsigned.crt' },
      ecdsa: { certFile: 'ecdsa-selfsigned.crt' },
      rootCaFile: 'rsa-selfsigned.crt',
    };
    const bundle = getWssRootCaBundle();
    expect(count(bundle)).toBe(2);
    expect(fingerprints(bundle)).toEqual(
      expect.arrayContaining([
        ...fingerprints(read('rsa-selfsigned.crt')),
        ...fingerprints(read('ecdsa-selfsigned.crt')),
      ])
    );
  });

  it('auto-signé sans rootCaFile : les certificats serveur auto-signés suffisent', () => {
    mockWss = {
      rsa: { certFile: 'rsa-selfsigned.crt' },
      ecdsa: { certFile: 'ecdsa-selfsigned.crt' },
      rootCaFile: '',
    };
    expect(count(getWssRootCaBundle())).toBe(2);
  });

  it('feuille signée par une CA : seule la racine configurée est livrée', () => {
    mockWss = {
      rsa: { certFile: 'ca-signed-leaf.crt' },
      ecdsa: { certFile: 'ca-signed-leaf.crt' },
      rootCaFile: 'ca-root.crt',
    };
    const bundle = getWssRootCaBundle();
    expect(count(bundle)).toBe(1);
    expect(fingerprints(bundle)).toEqual(fingerprints(read('ca-root.crt')));
  });

  it('ne livre aucun doublon (même racine et même certificat)', () => {
    mockWss = {
      rsa: { certFile: 'rsa-selfsigned.crt' },
      ecdsa: { certFile: 'rsa-selfsigned.crt' },
      rootCaFile: 'rsa-selfsigned.crt',
    };
    expect(count(getWssRootCaBundle())).toBe(1);
  });

  it('retourne null sans racine configurée ni certificat auto-signé', () => {
    mockWss = {
      rsa: { certFile: 'ca-signed-leaf.crt' },
      ecdsa: { certFile: 'ca-signed-leaf.crt' },
      rootCaFile: '',
    };
    expect(getWssRootCaBundle()).toBeNull();
  });

  it('ignore un rootCaFile ou un certFile introuvable', () => {
    mockWss = {
      rsa: { certFile: 'absent.crt' },
      ecdsa: { certFile: 'ecdsa-selfsigned.crt' },
      rootCaFile: 'absent-root.crt',
    };
    expect(count(getWssRootCaBundle())).toBe(1);
  });
});

describe('wssRootCa — buildServerChain', () => {
  it('renvoie le certificat tel quel sans rootCaFile', () => {
    mockWss = { rootCaFile: '' };
    const cert = read('rsa-selfsigned.crt');
    expect(buildServerChain(cert, [])).toBe(cert);
  });

  it('auto-signé : pas de doublon quand la racine est le certificat lui-même', () => {
    mockWss = { rootCaFile: 'rsa-selfsigned.crt' };
    const cert = read('rsa-selfsigned.crt');
    expect(count(buildServerChain(cert, [read('ecdsa-selfsigned.crt')]))).toBe(1);
  });

  it("auto-signé : n'ajoute pas à la chaîne ECDSA le certificat RSA de l'autre paire", () => {
    mockWss = { rootCaFile: 'rsa-selfsigned.crt' };
    const ecdsa = read('ecdsa-selfsigned.crt');
    const chain = buildServerChain(ecdsa, [read('rsa-selfsigned.crt')]);
    expect(fingerprints(chain)).toEqual(fingerprints(ecdsa));
  });

  it('feuille signée par une CA : ajoute la racine configurée à la chaîne', () => {
    mockWss = { rootCaFile: 'ca-root.crt' };
    const leaf = read('ca-signed-leaf.crt');
    const chain = buildServerChain(leaf, [leaf]);
    expect(fingerprints(chain)).toEqual([
      ...fingerprints(leaf),
      ...fingerprints(read('ca-root.crt')),
    ]);
  });

  it('ne rajoute pas une racine déjà présente dans la chaîne (fullchain avec racine)', () => {
    mockWss = { rootCaFile: 'ca-root.crt' };
    const fullchain = Buffer.concat([
      read('ca-signed-leaf.crt'),
      Buffer.from('\n'),
      read('ca-root.crt'),
    ]);
    expect(count(buildServerChain(fullchain, []))).toBe(2);
  });
});
