'use strict';

const fs = require('fs');
const path = require('path');
const { checkSessionSecret, MIN_LENGTH } = require('../../src/sessionSecretCheck');

describe('sessionSecretCheck — checkSessionSecret', () => {
  it.each([[''], [undefined], [null]])('%p → empty', (secret) => {
    expect(checkSessionSecret(secret).code).toBe('empty');
  });

  it.each([
    ['change-me-in-production'],
    ['change-me-with-a-random-secret'],
    ['change-me-with-a-random-secret-of-at-least-32-chars'],
    ['CHANGEME-abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('%p → placeholder (valeur d’exemple, même longue)', (secret) => {
    expect(checkSessionSecret(secret).code).toBe('placeholder');
  });

  it('secret court → too_short', () => {
    const r = checkSessionSecret('a1b2c3d4e5');
    expect(r.code).toBe('too_short');
    expect(r.message).toContain('10 characters');
  });

  it('secret aléatoire de 32 caractères ou plus → aucun avertissement', () => {
    expect(checkSessionSecret('x'.repeat(MIN_LENGTH - 1))?.code).toBe('too_short');
    expect(checkSessionSecret('9f8e7d6c5b4a39281706f5e4d3c2b1a0')).toBeNull();
  });

  it('les valeurs livrées dans les fichiers compose et env.example sont toutes signalées', () => {
    const files = [
      ...fs
        .readdirSync(path.join(__dirname, '../../docker'))
        .filter((f) => f.endsWith('.yml'))
        .map((f) => path.join(__dirname, '../../docker', f)),
      path.join(__dirname, '../../scripts/env.example'),
    ];
    const values = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/CPADMIN_SESSION_SECRET=([^\s#]+)/g)) {
        values.push(m[1]);
      }
    }
    expect(values.length).toBeGreaterThanOrEqual(7);
    for (const v of values) expect(checkSessionSecret(v)).not.toBeNull();
  });
});
