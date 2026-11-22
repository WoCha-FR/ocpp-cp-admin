'use strict';

// Migration 011 : AuthorizeRemoteTxRequests (1.6) / AuthCtrlr.AuthorizeRemoteStart (2.0.1)
// imposées à false dans la configuration initiale appliquée aux bornes.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initNewDatabase } = require('../../src/migrator');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/011-authorize-remote-start-false.sql'),
  'utf-8'
);

const initConfig = (db) =>
  db
    .prepare("SELECT value, enabled FROM chargepoint_init_config WHERE key = 'AuthorizeRemoteTxRequests'")
    .get();
const initVariable = (db) =>
  db
    .prepare(
      "SELECT value, enabled FROM chargepoint_init_variables WHERE component = 'AuthCtrlr' AND variable = 'AuthorizeRemoteStart' AND attribute = 'Actual'"
    )
    .get();

describe('migration 011 — démarrages à distance sans Authorize préalable', () => {
  it('base existante : ajoute la clé 1.6 et active la variable 2.0.1 désactivée', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chargepoint_init_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE chargepoint_init_variables (
        id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT NOT NULL, variable TEXT NOT NULL,
        attribute TEXT NOT NULL DEFAULT 'Actual', value TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (component, variable, attribute));
      INSERT INTO chargepoint_init_variables (component, variable, value, enabled)
        VALUES ('AuthCtrlr', 'AuthorizeRemoteStart', 'false', 0);
    `);
    db.exec(MIGRATION);
    expect(initConfig(db)).toEqual({ value: 'false', enabled: 1 });
    expect(initVariable(db)).toEqual({ value: 'false', enabled: 1 });
    db.close();
  });

  it('impose false même si la clé avait été créée à true', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chargepoint_init_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE chargepoint_init_variables (
        id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT NOT NULL, variable TEXT NOT NULL,
        attribute TEXT NOT NULL DEFAULT 'Actual', value TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (component, variable, attribute));
      INSERT INTO chargepoint_init_config (key, value, enabled) VALUES ('AuthorizeRemoteTxRequests', 'true', 0);
    `);
    db.exec(MIGRATION);
    expect(initConfig(db)).toEqual({ value: 'false', enabled: 1 });
    expect(initVariable(db)).toEqual({ value: 'false', enabled: 1 });
    db.close();
  });

  it('base neuve (schéma 001) : les deux réglages sont déjà actifs à false', () => {
    const db = new Database(':memory:');
    initNewDatabase(db);
    expect(initConfig(db)).toEqual({ value: 'false', enabled: 1 });
    expect(initVariable(db)).toEqual({ value: 'false', enabled: 1 });
    db.close();
  });
});
