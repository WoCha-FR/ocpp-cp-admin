'use strict';

// Migration 014 : tarifs datés et journal des corrections. La grille existante d'un site devient
// la grille « depuis l'origine » sans aucune modification (coûts déjà figés inchangés).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initNewDatabase } = require('../../src/migrator');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/014-dated-tariffs-corrections.sql'),
  'utf-8'
);

function oldDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT, sname TEXT UNIQUE NOT NULL,
      currency TEXT DEFAULT 'EUR', timezone TEXT DEFAULT 'Europe/Paris', default_price_per_kwh REAL);
    CREATE TABLE site_tariff_periods (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL,
      label TEXT, days TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7', start_time TEXT NOT NULL,
      end_time TEXT NOT NULL, price_per_kwh REAL NOT NULL,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE);
    CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, cost REAL);
    INSERT INTO sites (id, sname, default_price_per_kwh) VALUES (1, 'Siège', 0.2);
    INSERT INTO site_tariff_periods (site_id, label, start_time, end_time, price_per_kwh)
      VALUES (1, 'HC', '22:00', '06:00', 0.15);
    INSERT INTO transactions (id, cost) VALUES (1, 2.5);
  `);
  return db;
}

describe('migration 014 — tarifs datés et journal des corrections', () => {
  it('la grille existante devient la grille « depuis l’origine », coûts inchangés', () => {
    const db = oldDb();
    db.exec(MIGRATION);
    expect(db.prepare('SELECT default_price_per_kwh FROM sites WHERE id = 1').get().default_price_per_kwh).toBe(0.2);
    expect(db.prepare('SELECT label, version_id FROM site_tariff_periods').all()).toEqual([{ label: 'HC', version_id: null }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM site_tariff_versions').get().n).toBe(0);
    expect(db.prepare('SELECT cost FROM transactions WHERE id = 1').get().cost).toBe(2.5);
  });

  it('une grille datée par jour et par site ; ses tranches partent avec elle', () => {
    const db = oldDb();
    db.exec(MIGRATION);
    const v = db.prepare("INSERT INTO site_tariff_versions (site_id, valid_from, default_price_per_kwh) VALUES (1, '2027-01-01', 0.25)").run();
    expect(() => db.prepare("INSERT INTO site_tariff_versions (site_id, valid_from) VALUES (1, '2027-01-01')").run()).toThrow();
    db.prepare("INSERT INTO site_tariff_periods (site_id, start_time, end_time, price_per_kwh, version_id) VALUES (1, '22:00', '06:00', 0.18, ?)").run(v.lastInsertRowid);
    db.prepare('DELETE FROM site_tariff_versions WHERE id = ?').run(v.lastInsertRowid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM site_tariff_periods').get().n).toBe(1);
  });

  it('journal des corrections : genre contrôlé, horodatage ISO, supprimé avec la session', () => {
    const db = oldDb();
    db.exec(MIGRATION);
    db.prepare("INSERT INTO transaction_corrections (transaction_id, kind, reason) VALUES (1, 'badge', 'prêt')").run();
    expect(() => db.prepare("INSERT INTO transaction_corrections (transaction_id, kind) VALUES (1, 'index')").run()).toThrow();
    expect(db.prepare('SELECT created_at FROM transaction_corrections').get().created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.prepare('DELETE FROM transactions WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM transaction_corrections').get().n).toBe(0);
  });

  it('schéma initial (001) identique : mêmes tables et colonnes qu’après migration', () => {
    const fresh = new Database(':memory:');
    initNewDatabase(fresh);
    const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();
    const migrated = oldDb();
    migrated.exec(MIGRATION);
    for (const table of ['site_tariff_versions', 'transaction_corrections']) {
      expect(cols(fresh, table)).toEqual(cols(migrated, table));
    }
    expect(cols(fresh, 'site_tariff_periods')).toContain('version_id');
  });
});
