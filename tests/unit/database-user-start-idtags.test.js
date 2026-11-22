'use strict';

// Badges utilisables pour un démarrage depuis le site web (/user/start-charge) : un démarrage à
// distance en attente n'est pas recontrôlé à la réception de la transaction, la sélection du
// badge doit donc appliquer les mêmes contrôles qu'un badge présenté sur la borne.

const configMock = require('../helpers/config-mock');

jest.mock('../../src/config', () => ({
  getConfig: () => configMock,
  getConfigDir: () => '/tmp',
  castEnvValue: jest.fn(),
  deepGet: jest.fn(),
  deepSet: jest.fn(),
  ENV_OVERRIDES: [],
  CONFIG_FIELDS: [],
}));

jest.mock('../../src/logger', () => ({
  scope: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3');
  return function (_path, opts) {
    return new Real(':memory:', opts);
  };
});

const db = require('../../src/database');

let raw;
let siteA;
let siteB;
let userSeq = 0;

function addUser({ sites = [] } = {}) {
  userSeq += 1;
  const id = raw
    .prepare('INSERT INTO users (useremail, password, role) VALUES (?, ?, ?)')
    .run(`u${userSeq}@test.local`, 'x', 'user').lastInsertRowid;
  for (const [siteId, authorized] of sites) {
    raw
      .prepare('INSERT INTO user_sites (user_id, site_id, authorized) VALUES (?, ?, ?)')
      .run(id, siteId, authorized ? 1 : 0);
  }
  return Number(id);
}

function addTag(
  idTag,
  userId,
  { siteId = null, active = 1, expiry = null, category = 'perso' } = {}
) {
  raw
    .prepare(
      'INSERT INTO id_tags (id_tag, user_id, site_id, description, expiry_date, active, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(idTag, userId, siteId, `desc ${idTag}`, expiry, active, category);
}

const past = () => new Date(Date.now() - 86400000).toISOString();
const future = () => new Date(Date.now() + 86400000).toISOString();
const ids = (list) => list.map((t) => t.id_tag);

describe('database — getUserStartIdTags()', () => {
  beforeAll(() => {
    raw = db.getDb();
    siteA = Number(raw.prepare("INSERT INTO sites (sname) VALUES ('A')").run().lastInsertRowid);
    siteB = Number(raw.prepare("INSERT INTO sites (sname) VALUES ('B')").run().lastInsertRowid);
  });

  afterAll(() => {
    db.closeDb();
  });

  it('aucun badge → candidates 0 (badge web automatique côté route)', () => {
    const u = addUser({ sites: [[siteA, true]] });
    expect(db.getUserStartIdTags(u, siteA)).toEqual({ candidates: 0, usable: [], rejected: [] });
  });

  it('badge expiré ou désactivé : écarté, avec le motif', () => {
    const u = addUser({ sites: [[siteA, true]] });
    addTag('EXP001', u, { expiry: past() });
    addTag('OFF001', u, { active: 0 });
    addTag('OK0001', u, { expiry: future(), category: 'pro' });
    const r = db.getUserStartIdTags(u, siteA);
    expect(r.candidates).toBe(3);
    expect(r.usable).toEqual([
      { id_tag: 'OK0001', description: 'desc OK0001', category: 'pro', site_id: null },
    ]);
    expect(r.rejected).toEqual(
      expect.arrayContaining([
        { id_tag: 'EXP001', status: 'Expired', reason: 'expired_tag' },
        { id_tag: 'OFF001', status: 'Blocked', reason: 'inactive_tag' },
      ])
    );
  });

  it('tous les badges invalides → usable vide mais candidates > 0 (pas de repli web)', () => {
    const u = addUser({ sites: [[siteA, true]] });
    addTag('EXP002', u, { expiry: past() });
    const r = db.getUserStartIdTags(u, siteA);
    expect(r.candidates).toBe(1);
    expect(r.usable).toEqual([]);
  });

  it("badges d'un autre site ignorés ; badge du site et badge multi-sites retenus", () => {
    const u = addUser({
      sites: [
        [siteA, true],
        [siteB, true],
      ],
    });
    addTag('SITEB1', u, { siteId: siteB });
    addTag('SITEA1', u, { siteId: siteA });
    addTag('GLOB01', u);
    const r = db.getUserStartIdTags(u, siteA);
    expect(r.candidates).toBe(2);
    expect(ids(r.usable).sort()).toEqual(['GLOB01', 'SITEA1']);
  });

  it('plusieurs badges valides (pro / perso) → tous proposés', () => {
    const u = addUser({ sites: [[siteA, true]] });
    addTag('PRO001', u, { category: 'pro' });
    addTag('PERSO1', u, { category: 'perso' });
    expect(ids(db.getUserStartIdTags(u, siteA).usable)).toEqual(['PERSO1', 'PRO001']);
  });

  it("utilisateur non autorisé sur le site : écarté, sauf pour l'admin (ignoreUserSite)", () => {
    const u = addUser({ sites: [[siteA, false]] });
    addTag('NOAUTH', u);
    expect(db.getUserStartIdTags(u, siteA).rejected).toEqual([
      { id_tag: 'NOAUTH', status: 'Blocked', reason: 'user_not_authorized' },
    ]);
    expect(ids(db.getUserStartIdTags(u, siteA, { ignoreUserSite: true }).usable)).toEqual([
      'NOAUTH',
    ]);
    // ignoreUserSite ne lève que le contrôle d'autorisation sur le site, pas l'expiration
    addTag('NOAEXP', u, { expiry: past() });
    expect(ids(db.getUserStartIdTags(u, siteA, { ignoreUserSite: true }).usable)).not.toContain(
      'NOAEXP'
    );
  });

  it("même id_tag enregistré pour le site au nom d'un autre : badge multi-sites écarté", () => {
    const u = addUser({ sites: [[siteA, true]] });
    const other = addUser({ sites: [[siteA, true]] });
    addTag('SHARED', u);
    addTag('SHARED', other, { siteId: siteA });
    const r = db.getUserStartIdTags(u, siteA);
    expect(r.usable).toEqual([]);
    expect(r.rejected).toEqual([{ id_tag: 'SHARED', status: 'Invalid', reason: 'shadowed_tag' }]);
  });

  it('borne sans site : seuls les badges multi-sites sont candidats', () => {
    const u = addUser({ sites: [[siteA, true]] });
    addTag('NOSITE', u);
    addTag('ONLYA1', u, { siteId: siteA });
    const r = db.getUserStartIdTags(u, null);
    expect(r.candidates).toBe(1);
    expect(ids(r.usable)).toEqual(['NOSITE']);
  });
});
