'use strict';

// Droits sur les badges : admin, gestionnaire de ses sites, badge global d'un salarié dont tous
// les sites sont gérés (cas d'une entreprise avec des bornes chez ses salariés).

const { canAccessIdTag, idTagWriteError, canOwnGlobalTag } = require('../../src/idTagPolicy');
const { startBlockReason } = require('../../src/chargepointPolicy');

const admin = { isAdmin: true, managedSiteIds: [] };
// Gestionnaire de l'entreprise : siège (1) et domiciles (2, 3)
const manager = { isAdmin: false, managedSiteIds: [1, 2, 3] };

const employee = { role: 'user', site_ids: [1, 2, 3] }; // lié aux 3 sites gérés
const outsider = { role: 'user', site_ids: [1, 9] }; // aussi lié à un site d'un autre gestionnaire
const adminUser = { role: 'admin', site_ids: [1] };

describe('idTagPolicy — canAccessIdTag', () => {
  it("l'admin accède à tout", () => {
    expect(canAccessIdTag(admin, { site_id: null, user_id: null }, null)).toBe(true);
    expect(canAccessIdTag(admin, { site_id: 9, user_id: 1 }, outsider)).toBe(true);
  });

  it('badge limité à un site : seulement les sites gérés', () => {
    expect(canAccessIdTag(manager, { site_id: 2, user_id: null }, null)).toBe(true);
    expect(canAccessIdTag(manager, { site_id: 9, user_id: null }, null)).toBe(false);
  });

  it('badge global : seulement celui d’un salarié dont tous les sites sont gérés', () => {
    expect(canAccessIdTag(manager, { site_id: null, user_id: 5 }, employee)).toBe(true);
    expect(canAccessIdTag(manager, { site_id: null, user_id: 6 }, outsider)).toBe(false);
    expect(canAccessIdTag(manager, { site_id: null, user_id: 7 }, adminUser)).toBe(false);
    expect(canAccessIdTag(manager, { site_id: null, user_id: null }, null)).toBe(false);
    // salarié sans aucun site : pas de badge global géré par un gestionnaire
    expect(canAccessIdTag(manager, { site_id: null, user_id: 8 }, { role: 'user', site_ids: [] })).toBe(false);
  });
});

describe('idTagPolicy — idTagWriteError', () => {
  it("l'admin écrit tout", () => {
    expect(idTagWriteError(admin, { site_id: null, user_id: null }, null)).toBeNull();
  });

  it('création sur un site géré, sans titulaire ou avec un salarié de ce site', () => {
    expect(idTagWriteError(manager, { site_id: 2, user_id: null }, null)).toBeNull();
    expect(idTagWriteError(manager, { site_id: 2, user_id: 5 }, employee)).toBeNull();
  });

  it('création refusée : site non géré, titulaire hors du site, compte admin', () => {
    expect(idTagWriteError(manager, { site_id: 9, user_id: null }, null)).toBe('ERR_SITE_NOT_MANAGED');
    expect(idTagWriteError(manager, { site_id: 3, user_id: 6 }, outsider)).toBe(
      'ERR_TAG_USER_NOT_IN_SITE'
    );
    expect(idTagWriteError(manager, { site_id: 1, user_id: 7 }, adminUser)).toBe(
      'ERR_TAG_USER_NOT_IN_SITE'
    );
  });

  it('badge global : titulaire obligatoire et entièrement géré', () => {
    expect(idTagWriteError(manager, { site_id: null, user_id: null }, null)).toBe('ERR_SITE_REQUIRED');
    expect(idTagWriteError(manager, { site_id: null, user_id: 5 }, employee)).toBeNull();
    expect(idTagWriteError(manager, { site_id: null, user_id: 6 }, outsider)).toBe(
      'ERR_TAG_GLOBAL_NOT_MANAGED'
    );
  });

  it('modification : badge existant hors périmètre refusé', () => {
    const existing = { site_id: 9, user_id: null };
    expect(idTagWriteError(manager, { site_id: 2, user_id: null }, null, { existing })).toBe(
      'ERR_SITE_NOT_MANAGED'
    );
  });

  it('modification sans changer de titulaire : un titulaire historique hors site reste toléré', () => {
    // badge du site 2 rattaché à un salarié qui n'y est plus lié : on peut encore le désactiver
    const existing = { site_id: 2, user_id: 6 };
    expect(idTagWriteError(manager, { site_id: 2, user_id: 6 }, outsider, { existing })).toBeNull();
    // …mais pas le rattacher à quelqu'un hors du site
    expect(
      idTagWriteError(manager, { site_id: 2, user_id: 7 }, adminUser, { existing })
    ).toBe('ERR_TAG_USER_NOT_IN_SITE');
  });
});

describe('idTagPolicy — canOwnGlobalTag', () => {
  it('signale à l’interface les titulaires possibles d’un badge global', () => {
    expect(canOwnGlobalTag(admin, outsider)).toBe(true);
    expect(canOwnGlobalTag(manager, employee)).toBe(true);
    expect(canOwnGlobalTag(manager, outsider)).toBe(false);
  });
});

describe('chargepointPolicy — startBlockReason', () => {
  it('borne sans site : inactive ; avec site : démarrage permis', () => {
    expect(startBlockReason({ site_id: null })).toBe('chargepoint_no_site');
    expect(startBlockReason({ site_id: 0 })).toBe('chargepoint_no_site');
    expect(startBlockReason({ site_id: 3 })).toBeNull();
    expect(startBlockReason(null)).toBeNull();
  });
});
