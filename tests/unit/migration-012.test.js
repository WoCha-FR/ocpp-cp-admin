'use strict';

// Migration 012 : variables initiales 2.0.1 avec instance + corrections Device Model.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initNewDatabase } = require('../../src/migrator');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/012-init-variables-instance.sql'),
  'utf-8'
);

function oldDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chargepoint_init_variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT NOT NULL, variable TEXT NOT NULL,
      attribute TEXT NOT NULL DEFAULT 'Actual', value TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (component, variable, attribute));
    INSERT INTO chargepoint_init_variables (id, component, variable, value, enabled) VALUES
      (1, 'OCPPCommCtrlr', 'HeartbeatInterval', '600', 1),
      (2, 'OCPPCommCtrlr', 'MessageTimeout', '45', 1),
      (3, 'OCPPCommCtrlr', 'MessageAttempts', '5', 0),
      (4, 'OCPPCommCtrlr', 'MessageAttemptInterval', '90', 0),
      (5, 'ReservationCtrlr', 'ReservationTimeOut', '60', 0),
      (6, 'ClockCtrlr', 'TimeOffset', 'UTC+0', 0);
  `);
  return db;
}

const row = (db, component, variable) =>
  db
    .prepare('SELECT * FROM chargepoint_init_variables WHERE component = ? AND variable = ?')
    .get(component, variable);

describe('migration 012 — variables initiales conformes au Device Model 2.0.1', () => {
  let db;
  beforeEach(() => {
    db = oldDb();
    db.exec(MIGRATION);
  });
  afterEach(() => db.close());

  it('renseigne l’instance des variables qui en exigent une, en gardant valeur et activation', () => {
    expect(row(db, 'OCPPCommCtrlr', 'MessageTimeout')).toMatchObject({
      id: 2,
      instance: 'Default',
      value: '45',
      enabled: 1,
    });
    expect(row(db, 'OCPPCommCtrlr', 'MessageAttempts')).toMatchObject({
      instance: 'TransactionEvent',
      value: '5',
    });
    expect(row(db, 'OCPPCommCtrlr', 'MessageAttemptInterval').instance).toBe('TransactionEvent');
    expect(row(db, 'OCPPCommCtrlr', 'HeartbeatInterval').instance).toBe('');
  });

  it('supprime ReservationCtrlr.ReservationTimeOut (absente du Device Model)', () => {
    expect(row(db, 'ReservationCtrlr', 'ReservationTimeOut')).toBeUndefined();
  });

  it('corrige TimeOffset au format RFC 3339', () => {
    expect(row(db, 'ClockCtrlr', 'TimeOffset').value).toBe('+00:00');
  });

  it('une même variable peut exister avec plusieurs instances', () => {
    const ins = db.prepare(
      "INSERT INTO chargepoint_init_variables (component, variable, instance, value) VALUES ('OCPPCommCtrlr', 'MessageAttempts', ?, '3')"
    );
    expect(() => ins.run('Other')).not.toThrow();
    expect(() => ins.run('TransactionEvent')).toThrow(/UNIQUE/);
  });

  it('base neuve (schéma 001) : mêmes valeurs', () => {
    const fresh = new Database(':memory:');
    initNewDatabase(fresh);
    expect(row(fresh, 'OCPPCommCtrlr', 'MessageTimeout').instance).toBe('Default');
    expect(row(fresh, 'OCPPCommCtrlr', 'MessageAttempts').instance).toBe('TransactionEvent');
    expect(row(fresh, 'OCPPCommCtrlr', 'MessageAttemptInterval').instance).toBe('TransactionEvent');
    expect(row(fresh, 'ReservationCtrlr', 'ReservationTimeOut')).toBeUndefined();
    expect(row(fresh, 'ClockCtrlr', 'TimeOffset').value).toBe('+00:00');
    fresh.close();
  });
});
