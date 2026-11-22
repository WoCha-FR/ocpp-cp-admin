'use strict';

// Migration 010 : transactions identifiées par (borne, transaction_id) + colonne closed_by.
// On part du schéma antérieur (transaction_id UNIQUE global, transactions_values sans borne)
// et on vérifie la reprise des données.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/010-transactions-per-chargepoint.sql'),
  'utf-8'
);

function oldSchemaDb() {
  const db = new Database(':memory:');
  // Une base existante peut contenir des relevés orphelins (clés étrangères non vérifiées à
  // l'époque) : on les autorise pour construire la fixture
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE chargepoints (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT UNIQUE NOT NULL);
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT(36) UNIQUE,
      chargepoint_id INTEGER NOT NULL,
      evse_id INTEGER,
      connector_id INTEGER NOT NULL,
      charging_state TEXT,
      id_tag TEXT,
      id_token_type TEXT,
      start_source TEXT DEFAULT 'rfid' CHECK(start_source IN ('rfid', 'web', 'local', 'remote')),
      meter_start INTEGER,
      meter_stop INTEGER,
      start_time TEXT,
      stop_time TEXT,
      stop_reason TEXT,
      status TEXT DEFAULT 'Active',
      power INTEGER,
      energy INTEGER,
      cost REAL,
      cost_currency TEXT,
      cost_details TEXT,
      FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE
    );
    CREATE TABLE transactions_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT(36) NOT NULL,
      energie TEXT, courant TEXT, soc TEXT, temperature TEXT, tension TEXT, frequence TEXT,
      FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE
    );
  `);
  db.prepare("INSERT INTO chargepoints (identity) VALUES ('CP-A'), ('CP-B')").run();
  db.prepare(
    `INSERT INTO transactions (id, transaction_id, chargepoint_id, connector_id, meter_start, meter_stop,
       start_time, stop_time, status, cost, cost_currency)
     VALUES (10, 'T1', 1, 1, 0, 5000, '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 'Completed', 1.25, 'EUR'),
            (11, 'T2', 2, 1, 100, NULL, '2026-01-02T10:00:00Z', NULL, 'Active', NULL, NULL)`
  ).run();
  db.prepare(
    `INSERT INTO transactions_values (id, transaction_id, energie) VALUES
       (1, 'T1', '[{"x":1}]'), (2, 'T2', '[{"x":2}]'), (3, 'GHOST', '[]')`
  ).run();
  return db;
}

function migrate(db) {
  db.pragma('foreign_keys = OFF');
  db.exec(MIGRATION);
  db.pragma('foreign_keys = ON');
}

describe('migration 010 — transactions par borne', () => {
  let db;

  beforeEach(() => {
    db = oldSchemaDb();
    migrate(db);
  });

  afterEach(() => db.close());

  it('reprend les transactions à l’identique (id interne, coût, statut) avec closed_by NULL', () => {
    const t1 = db.prepare('SELECT * FROM transactions WHERE id = 10').get();
    expect(t1).toMatchObject({
      transaction_id: 'T1',
      chargepoint_id: 1,
      meter_stop: 5000,
      status: 'Completed',
      cost: 1.25,
      cost_currency: 'EUR',
      closed_by: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n).toBe(2);
  });

  it('renseigne la borne des relevés et abandonne les relevés orphelins', () => {
    const rows = db.prepare('SELECT id, chargepoint_id, transaction_id FROM transactions_values ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, chargepoint_id: 1, transaction_id: 'T1' },
      { id: 2, chargepoint_id: 2, transaction_id: 'T2' },
    ]);
  });

  it('autorise le même transaction_id sur deux bornes, pas sur la même', () => {
    const ins = db.prepare(
      "INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, status) VALUES (?, ?, 1, 'Active')"
    );
    expect(() => ins.run('T1', 2)).not.toThrow();
    expect(() => ins.run('T1', 1)).toThrow(/UNIQUE/);
  });

  it('les relevés suivent leur transaction (clé étrangère composite, suppression en cascade)', () => {
    expect(() =>
      db
        .prepare("INSERT INTO transactions_values (chargepoint_id, transaction_id) VALUES (1, 'T2')")
        .run()
    ).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM transactions WHERE id = 10').run();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM transactions_values WHERE transaction_id = 'T1'").get().n
    ).toBe(0);
  });

  it('closed_by n’accepte que station / server', () => {
    expect(() => db.prepare("UPDATE transactions SET closed_by = 'other' WHERE id = 10").run()).toThrow(
      /CHECK/
    );
    expect(() => db.prepare("UPDATE transactions SET closed_by = 'server' WHERE id = 10").run()).not.toThrow();
  });
});
