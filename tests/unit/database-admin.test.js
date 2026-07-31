'use strict';

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

describe('database — getSystemStats()', () => {
  beforeAll(() => {
    db.getDb();
  });

  afterAll(() => {
    db.closeDb();
  });

  it('retourne des compteurs à 0 pour une base vide et une taille de BDD numérique', () => {
    const stats = db.getSystemStats();
    expect(stats.counts).toMatchObject({
      transactions: 0,
      ocpp_messages: 0,
      id_tags_events: 0,
      error_events: 0,
      reservations: 0,
      notification_log: 0,
    });
    expect(typeof stats.dbSizeBytes).toBe('number');
    expect(stats.dbSizeBytes).toBeGreaterThanOrEqual(0);
    expect(stats.connectedDb).toBe(0);
  });

  it('compte correctement les bornes marquées connectées en base', () => {
    db.createChargepoint('CP-STATS-1', 'CP1', 'pass');
    db.createChargepoint('CP-STATS-2', 'CP2', 'pass');
    db.upsertChargepoint('CP-STATS-1', { connected: 1 });

    const stats = db.getSystemStats();
    expect(stats.counts.chargepoints).toBeGreaterThanOrEqual(2);
    expect(stats.connectedDb).toBeGreaterThanOrEqual(1);
  });
});

describe('database — nettoyage des données', () => {
  let testDb;
  let cpId;

  beforeEach(() => {
    testDb = db.getDb();
    const cp = db.createChargepoint('CP-CLEANUP', 'CP Cleanup', 'pass');
    cpId = cp.id;
  });

  afterEach(() => {
    db.closeDb();
  });

  function insertTransaction(transactionId, { status, stopTime }) {
    testDb
      .prepare(
        `INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, status, start_time, stop_time)
         VALUES (?, ?, 1, ?, '2024-01-01T00:00:00Z', ?)`
      )
      .run(transactionId, cpId, status, stopTime || null);
  }

  describe('estimateTableSize()', () => {
    it('rejette un nom de table hors whitelist', () => {
      expect(() => db.estimateTableSize('users')).toThrow('ERR_INVALID_TABLE');
    });

    it('retourne 0 pour une table vide et croît avec du contenu texte', () => {
      expect(db.estimateTableSize('transactions_values')).toBe(0);
      insertTransaction('TX-SIZE', { status: 'Completed', stopTime: '2024-06-01T00:00:00Z' });
      db.upsertTransactionValues('TX-SIZE', { energieEntry: 'x'.repeat(500) });
      expect(db.estimateTableSize('transactions_values')).toBeGreaterThanOrEqual(500);
    });
  });

  describe('getCleanupStats()', () => {
    it('retourne count + sizeBytes pour chaque table nettoyable', () => {
      const stats = db.getCleanupStats();
      const tables = stats.map((s) => s.table);
      expect(tables).toEqual([
        'transactions_values',
        'ocpp_messages',
        'id_tags_events',
        'error_events',
        'notification_log',
        'reservations',
      ]);
      stats.forEach((s) => {
        expect(s.count).toBe(0);
        expect(s.sizeBytes).toBe(0);
      });
    });
  });

  describe('deleteTransactionValuesBefore()', () => {
    it('ne supprime que les transactions_values des transactions terminées antérieures à la date, jamais la transaction elle-même', () => {
      insertTransaction('TX-OLD', { status: 'Completed', stopTime: '2020-01-01T00:00:00Z' });
      insertTransaction('TX-RECENT', { status: 'Completed', stopTime: '2030-01-01T00:00:00Z' });
      insertTransaction('TX-ACTIVE', { status: 'Active', stopTime: null });
      db.upsertTransactionValues('TX-OLD', { energieEntry: '1' });
      db.upsertTransactionValues('TX-RECENT', { energieEntry: '1' });
      db.upsertTransactionValues('TX-ACTIVE', { energieEntry: '1' });

      const deleted = db.deleteTransactionValuesBefore('2024-01-01');

      expect(deleted).toBe(1);
      expect(db.getTransactionValues('TX-OLD')).toBeUndefined();
      expect(db.getTransactionValues('TX-RECENT')).toBeDefined();
      expect(db.getTransactionValues('TX-ACTIVE')).toBeDefined();
      // Les transactions elles-mêmes ne sont jamais supprimées
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n).toBe(3);
    });
  });

  describe('deleteIdTagEventsBefore()', () => {
    it('ne supprime que les événements antérieurs à la date', () => {
      testDb
        .prepare(
          `INSERT INTO id_tags_events (chargepoint_id, id_tag, status, timestamp) VALUES (?, 'TAG1', 'Accepted', ?)`
        )
        .run(cpId, '2020-01-01T00:00:00Z');
      testDb
        .prepare(
          `INSERT INTO id_tags_events (chargepoint_id, id_tag, status, timestamp) VALUES (?, 'TAG2', 'Accepted', ?)`
        )
        .run(cpId, '2030-01-01T00:00:00Z');

      const deleted = db.deleteIdTagEventsBefore('2024-01-01');
      expect(deleted).toBe(1);
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM id_tags_events').get().n).toBe(1);
    });
  });

  describe('deleteErrorEventsBefore()', () => {
    it('ne supprime que les événements antérieurs à la date', () => {
      testDb
        .prepare(
          `INSERT INTO error_events (chargepoint_id, event_type, created_at) VALUES (?, 'status_error', ?)`
        )
        .run(cpId, '2020-01-01T00:00:00Z');
      testDb
        .prepare(
          `INSERT INTO error_events (chargepoint_id, event_type, created_at) VALUES (?, 'status_error', ?)`
        )
        .run(cpId, '2030-01-01T00:00:00Z');

      const deleted = db.deleteErrorEventsBefore('2024-01-01');
      expect(deleted).toBe(1);
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM error_events').get().n).toBe(1);
    });
  });

  describe('deleteExpiredReservations()', () => {
    function insertReservation(reservationId, status, expiryDate) {
      testDb
        .prepare(
          `INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, status)
           VALUES (?, 1, ?, 'TAG1', ?, ?)`
        )
        .run(cpId, reservationId, expiryDate, status);
    }

    it('sans date : supprime toutes les réservations terminées quel que soit leur âge', () => {
      insertReservation(1, 'Fulfilled', '2020-01-01T00:00:00Z');
      insertReservation(2, 'Cancelled', '2030-01-01T00:00:00Z');
      insertReservation(3, 'Pending', '2030-01-01T00:00:00Z');

      const deleted = db.deleteExpiredReservations();
      expect(deleted).toBe(2);
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM reservations').get().n).toBe(1);
    });

    it('avec date : ne supprime que les réservations terminées antérieures à la date', () => {
      insertReservation(1, 'Fulfilled', '2020-01-01T00:00:00Z');
      insertReservation(2, 'Expired', '2030-01-01T00:00:00Z');

      const deleted = db.deleteExpiredReservations('2024-01-01');
      expect(deleted).toBe(1);
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM reservations').get().n).toBe(1);
    });
  });

  describe('deleteNotificationLogBefore()', () => {
    it('supprime les entrées de tous les utilisateurs antérieures à la date (à la différence de clearNotificationLog scopé)', () => {
      const otherUser = testDb
        .prepare(
          "INSERT INTO users (useremail, password, role, shortname) VALUES ('other@test.com', 'x', 'user', 'Other')"
        )
        .run().lastInsertRowid;
      testDb
        .prepare(
          `INSERT INTO notification_log (user_id, event_type, channel, created_at) VALUES (?, 'evt', 'web', ?)`
        )
        .run(otherUser, '2020-01-01T00:00:00Z');
      testDb
        .prepare(
          `INSERT INTO notification_log (user_id, event_type, channel, created_at) VALUES (?, 'evt', 'web', ?)`
        )
        .run(otherUser, '2030-01-01T00:00:00Z');

      const deleted = db.deleteNotificationLogBefore('2024-01-01');
      expect(deleted).toBe(1);
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM notification_log').get().n).toBe(1);
    });
  });

  describe('clearOcppMessages() avec before', () => {
    it('ne supprime que les messages antérieurs à la date quand before est fourni', () => {
      testDb
        .prepare(
          `INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, timestamp) VALUES (?, 'system', 'EVENT', ?)`
        )
        .run(cpId, '2020-01-01T00:00:00Z');
      testDb
        .prepare(
          `INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, timestamp) VALUES (?, 'system', 'EVENT', ?)`
        )
        .run(cpId, '2030-01-01T00:00:00Z');

      const deleted = db.clearOcppMessages(null, '2024-01-01');
      expect(deleted).toBe(1);
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM ocpp_messages').get().n).toBe(1);
    });
  });

  describe('vacuumDatabase()', () => {
    it("s'exécute sans erreur", () => {
      expect(() => db.vacuumDatabase()).not.toThrow();
    });
  });
});
