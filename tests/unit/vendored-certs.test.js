'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

describe('config/certs/isrg-root-x1.pem — certificat racine Let\'s Encrypt vendored', () => {
  const certPath = path.join(__dirname, '../../config/certs/isrg-root-x1.pem');

  it('existe et est un certificat PEM valide auto-signé "ISRG Root X1"', () => {
    expect(fs.existsSync(certPath)).toBe(true);
    const pem = fs.readFileSync(certPath, 'utf8');
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----/);

    const cert = new crypto.X509Certificate(pem);
    expect(cert.subject).toMatch(/CN=ISRG Root X1/);
    expect(cert.issuer).toBe(cert.subject); // racine auto-signée
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
