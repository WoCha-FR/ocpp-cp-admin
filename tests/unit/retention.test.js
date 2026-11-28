'use strict';

// Lot 5 : rétention automatique. Données techniques échues supprimées, sessions échues
// anonymisées (jamais supprimées), activation par l'instance ou forcée par la configuration.

const configMock = { ...require('../helpers/config-mock') };

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
const retention = require('../../src/retention');

const NOW = new Date('2026-11-28T12:00:00Z');

beforeAll(() => db.getDb());
afterAll(() => db.closeDb());
afterEach(() => {
  delete configMock.retention;
});

describe('retention — durées et dates limites', () => {
  it('valeurs par défaut : OCPP 90 j, rejets/erreurs/réservations/notifications 1 an, courbes 2 ans, sessions 5 ans', () => {
    expect(retention.getRetentionDays()).toEqual({
      ocppMessages: 90,
      rejections: 365,
      errorEvents: 365,
      reservations: 365,
      notifications: 365,
      meterValues: 730,
      sessions: 1825,
    });
  });

  it('surcharges, 0 = jamais, valeur invalide = valeur par défaut', () => {
    configMock.retention = { ocppMessagesDays: 30, sessionsDays: 0, meterValuesDays: -4, errorEventsDays: '60' };
    const days = retention.getRetentionDays();
    expect(days).toMatchObject({ ocppMessages: 30, sessions: 0, meterValues: 730, errorEvents: 60 });
    const cutoffs = retention.getCutoffs(days, NOW);
    expect(cutoffs.ocppMessages).toBe('2026-10-29');
    expect(cutoffs.sessions).toBeNull();
  });
});

describe('retention — activation (fichier de configuration ou CPADMIN_RETENTION_ENABLED)', () => {
  afterEach(() => {
    delete process.env.CPADMIN_RETENTION_ENABLED;
  });

  it('clé absente (instance mise à jour) : inactive ; true dans le fichier : active', () => {
    expect(retention.getRetentionActivation()).toEqual({ enabled: false, source: 'default' });
    configMock.retention = { enabled: true };
    expect(retention.getRetentionActivation()).toEqual({ enabled: true, source: 'config' });
    configMock.retention = { enabled: false };
    expect(retention.getRetentionActivation()).toEqual({ enabled: false, source: 'config' });
  });

  it('variable d’environnement signalée comme source (valeur déjà appliquée à la config)', () => {
    process.env.CPADMIN_RETENTION_ENABLED = 'true';
    configMock.retention = { enabled: true };
    expect(retention.getRetentionActivation()).toEqual({ enabled: true, source: 'env' });
  });

  it('inactive : le passage ne fait rien, sauf forcé', () => {
    expect(retention.runRetention({ now: NOW })).toEqual({ ran: false });
    expect(retention.runRetention({ now: NOW, force: true }).ran).toBe(true);
  });

  it('installation neuve : config.sample.json active la rétention avec les durées par défaut', () => {
    const sample = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../config/config.sample.json'), 'utf8'));
    expect(sample.retention.enabled).toBe(true);
    configMock.retention = sample.retention;
    expect(retention.getRetentionDays()).toEqual({
      ocppMessages: 90,
      rejections: 365,
      errorEvents: 365,
      reservations: 365,
      notifications: 365,
      meterValues: 730,
      sessions: 1825,
    });
  });
});

describe('retention — passage', () => {
  beforeEach(() => {
    configMock.retention = { enabled: true };
  });
  let cp;
  let oldTx;
  let recentTx;
  let activeOld;

  beforeAll(() => {
    const raw = db.getDb();
    const site = db.createSite('Site rétention', null).id;
    cp = db.createChargepoint('CP-RETENTION', 'R', null, 1, site).id;
    const user = db.createUser('ret-user@test.com', 'Passw0rd!x', 'user', 'Retenu').id;
    db.createIdTag('RETTAG', user, null, null, null, 1, 'ISO14443', null, 'pro');

    // Session de 2020 (> 5 ans), session récente, session ancienne restée active
    const mk = (connector, start, stop) => {
      const tx = db.createTransaction(cp, connector, 'RETTAG', 0, start, 'rfid');
      if (stop) db.stopTransaction(cp, tx.transaction_id, 5000, stop, 'Local');
      return db.getTransactionById(tx.id);
    };
    oldTx = mk(1, '2020-01-10T08:00:00Z', '2020-01-10T09:00:00Z');
    recentTx = mk(2, '2026-11-01T08:00:00Z', '2026-11-01T09:00:00Z');
    activeOld = mk(3, '2020-02-01T08:00:00Z', null);
    raw.prepare(
      "INSERT INTO transaction_corrections (transaction_id, site_id, kind, reason, author_name, old_user_name, new_user_name) VALUES (?, ?, 'badge', 'prêt de Jean', 'Admin', 'Jean', 'Marie')"
    ).run(oldTx.id, site);
    // Courbes : ancienne (2023) et récente
    raw.prepare("UPDATE transactions SET stop_time = '2023-06-01T09:00:00Z', start_time = '2023-06-01T08:00:00Z' WHERE id = ?").run(recentTx.id);
    raw.prepare("INSERT INTO transactions_values (chargepoint_id, transaction_id, energie) VALUES (?, ?, '[]')").run(cp, recentTx.transaction_id);
    const newer = mk(4, '2026-11-20T08:00:00Z', '2026-11-20T09:00:00Z');
    raw.prepare("INSERT INTO transactions_values (chargepoint_id, transaction_id, energie) VALUES (?, ?, '[]')").run(cp, newer.transaction_id);

    // Journal OCPP, rejets, erreurs, notifications, réservations : un ancien et un récent chacun
    raw.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, timestamp) VALUES (?, 'csms', 'CALL', 'Old', '2026-01-01 10:00:00'), (?, 'csms', 'CALL', 'New', '2026-11-27 10:00:00')").run(cp, cp);
    raw.prepare("INSERT INTO id_tags_events (chargepoint_id, id_tag, status, timestamp) VALUES (?, 'X', 'Invalid', '2025-01-01 10:00:00'), (?, 'X', 'Invalid', '2026-11-01 10:00:00')").run(cp, cp);
    raw.prepare("INSERT INTO error_events (chargepoint_id, event_type, created_at) VALUES (?, 'disconnect', '2025-01-01 10:00:00'), (?, 'disconnect', '2026-11-01 10:00:00')").run(cp, cp);
    raw.prepare("INSERT INTO notification_log (user_id, event_type, channel, created_at) VALUES (?, 'x', 'mail', '2025-01-01 10:00:00'), (?, 'x', 'mail', '2026-11-01 10:00:00')").run(user, user);
    raw.prepare("INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, status) VALUES (?, 1, 1, 'X', '2025-01-01T10:00:00Z', 'Expired'), (?, 1, 2, 'X', '2026-11-01T10:00:00Z', 'Expired'), (?, 1, 3, 'X', '2024-01-01T10:00:00Z', 'Pending')").run(cp, cp, cp);
  });

  it('l’aperçu compte exactement ce que le passage traite', () => {
    const status = retention.getRetentionStatus(NOW);
    expect(status.preview).toEqual({
      ocppMessages: 1,
      rejections: 1,
      errorEvents: 1,
      reservations: 1,
      notifications: 1,
      meterValues: 1,
      sessions: 1,
    });
    const run = retention.runRetention({ now: NOW });
    expect(run.counts).toEqual(status.preview);
    expect(retention.getRetentionStatus(NOW).lastRun).toEqual({ at: NOW.toISOString(), counts: run.counts });
    // Deuxième passage : plus rien
    expect(Object.values(retention.runRetention({ now: NOW }).counts).every((n) => n === 0)).toBe(true);
  });

  it('données récentes conservées ; réservation non terminée jamais supprimée', () => {
    const raw = db.getDb();
    expect(raw.prepare('SELECT action FROM ocpp_messages WHERE chargepoint_id = ?').all(cp)).toEqual([{ action: 'New' }]);
    expect(raw.prepare('SELECT status FROM reservations WHERE chargepoint_id = ? ORDER BY reservation_id').all(cp)).toEqual([
      { status: 'Expired' },
      { status: 'Pending' },
    ]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM transactions_values WHERE chargepoint_id = ?').get(cp).n).toBe(1);
  });

  it('session échue anonymisée, jamais supprimée : énergie, coût, site et catégorie gardés', () => {
    const tx = db.getTransactionById(oldTx.id);
    expect(tx).toMatchObject({ id_tag: null, user_id: null, user_name: null, tag_category: 'pro', meter_stop: 5000, site_id: oldTx.site_id });
    const [c] = db.getTransactionCorrections(oldTx.id);
    expect(c).toMatchObject({ reason: null, author_name: null, old_user_name: null, new_user_name: null, kind: 'badge' });
    // session récente et session ancienne encore active : intactes
    expect(db.getTransactionById(recentTx.id).id_tag).toBe('RETTAG');
    expect(db.getTransactionById(activeOld.id)).toMatchObject({ status: 'Active', id_tag: 'RETTAG' });
  });
});
