'use strict';

// Migration 013 : site, titulaire et catégorie figés sur chaque session. Le rattrapage doit
// reproduire exactement la résolution utilisée jusqu'ici à l'affichage (aucun chiffre ne change
// au moment de la mise à jour).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initNewDatabase } = require('../../src/migrator');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/013-history-preservation.sql'),
  'utf-8'
);

// Schéma minimal antérieur à la migration 013 (colonnes utiles au rattrapage)
function oldDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT, sname TEXT UNIQUE NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, useremail TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL, shortname TEXT);
    CREATE TABLE chargepoints (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT UNIQUE NOT NULL,
      site_id INTEGER);
    CREATE TABLE id_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, id_tag TEXT NOT NULL,
      user_id INTEGER, site_id INTEGER,
      category TEXT NOT NULL DEFAULT 'perso' CHECK (category IN ('pro', 'perso')));
    CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT,
      chargepoint_id INTEGER NOT NULL, connector_id INTEGER NOT NULL, id_tag TEXT,
      start_time TEXT, status TEXT DEFAULT 'Active');

    INSERT INTO sites (id, sname) VALUES (1, 'Siège'), (2, 'Domicile');
    INSERT INTO users (id, useremail, password, role, shortname) VALUES
      (1, 'alice@test.local', 'x', 'user', 'Alice'),
      (2, 'bob@test.local', 'x', 'user', NULL),
      (3, 'carol@test.local', 'x', 'user', 'Carol');
    INSERT INTO chargepoints (id, identity, site_id) VALUES (1, 'CP-SIEGE', 1), (2, 'CP-DOM', 2),
      (3, 'CP-NOSITE', NULL);
    INSERT INTO id_tags (id, id_tag, user_id, site_id, category) VALUES
      (1, 'GLOBAL', 1, NULL, 'pro'),
      (2, 'SHADOW', 1, NULL, 'perso'),
      (3, 'SHADOW', 3, 2, 'pro'),
      (4, 'EMAILONLY', 2, NULL, 'perso'),
      (5, 'OTHERSITE', 3, 1, 'pro'),
      (6, 'NOUSER', NULL, NULL, 'pro');
    INSERT INTO transactions (id, transaction_id, chargepoint_id, connector_id, id_tag) VALUES
      (1, 'T1', 1, 1, 'GLOBAL'),
      (2, 'T2', 1, 1, 'SHADOW'),
      (3, 'T3', 2, 1, 'SHADOW'),
      (4, 'T4', 1, 1, 'EMAILONLY'),
      (5, 'T5', 2, 1, 'OTHERSITE'),
      (6, 'T6', 1, 1, 'UNKNOWN'),
      (7, 'T7', 1, 1, NULL),
      (8, 'T8', 3, 1, 'GLOBAL'),
      (9, 'T9', 1, 1, 'NOUSER');
  `);
  return db;
}

const tx = (db, id) =>
  db
    .prepare('SELECT site_id, user_id, user_name, tag_category FROM transactions WHERE id = ?')
    .get(id);

describe('migration 013 — historique figé des sessions', () => {
  let db;
  beforeAll(() => {
    db = oldDb();
    db.exec(MIGRATION);
  });
  afterAll(() => db.close());

  it('fige le site actuel de la borne (NULL pour une borne sans site)', () => {
    expect(tx(db, 1).site_id).toBe(1);
    expect(tx(db, 3).site_id).toBe(2);
    expect(tx(db, 8).site_id).toBeNull();
  });

  it('badge global : titulaire, nom et catégorie', () => {
    expect(tx(db, 1)).toEqual({ site_id: 1, user_id: 1, user_name: 'Alice', tag_category: 'pro' });
  });

  it('même code global et propre au site : la fiche du site de la borne prime', () => {
    // Sur le siège, seule la fiche globale s'applique ; au domicile, la fiche du site
    expect(tx(db, 2)).toMatchObject({ user_id: 1, tag_category: 'perso' });
    expect(tx(db, 3)).toMatchObject({ user_id: 3, user_name: 'Carol', tag_category: 'pro' });
  });

  it("nom du titulaire : son e-mail à défaut de nom court ; badge d'un autre site retenu en dernier", () => {
    expect(tx(db, 4)).toMatchObject({ user_id: 2, user_name: 'bob@test.local' });
    expect(tx(db, 5)).toMatchObject({ user_id: 3, tag_category: 'pro' });
  });

  it('badge inconnu ou absent : aucun titulaire ni catégorie', () => {
    expect(tx(db, 6)).toEqual({ site_id: 1, user_id: null, user_name: null, tag_category: null });
    expect(tx(db, 7)).toEqual({ site_id: 1, user_id: null, user_name: null, tag_category: null });
  });

  it('borne sans site : badge global retenu ; badge sans titulaire : catégorie seule', () => {
    expect(tx(db, 8)).toMatchObject({ site_id: null, user_id: 1, tag_category: 'pro' });
    expect(tx(db, 9)).toEqual({ site_id: 1, user_id: null, user_name: null, tag_category: 'pro' });
  });

  it('ajoute les colonnes du cycle de vie avec leurs valeurs par défaut', () => {
    expect(db.prepare('SELECT archived_at, auto_web_badge FROM sites WHERE id = 1').get()).toEqual({
      archived_at: null,
      auto_web_badge: 1,
    });
    expect(
      db.prepare('SELECT archived_at FROM chargepoints WHERE id = 1').get().archived_at
    ).toBeNull();
    expect(db.prepare('SELECT disabled_at FROM users WHERE id = 1').get().disabled_at).toBeNull();
  });

  it('refuse une catégorie inconnue sur une session', () => {
    expect(() =>
      db.prepare("UPDATE transactions SET tag_category = 'xx' WHERE id = 1").run()
    ).toThrow(/CHECK/);
  });

  it('base neuve (schéma 001) : mêmes colonnes et index', () => {
    const fresh = new Database(':memory:');
    initNewDatabase(fresh);
    const cols = (table) =>
      fresh
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    expect(cols('transactions')).toEqual(
      expect.arrayContaining(['site_id', 'user_id', 'user_name', 'tag_category'])
    );
    expect(cols('sites')).toEqual(expect.arrayContaining(['archived_at', 'auto_web_badge']));
    expect(cols('chargepoints')).toContain('archived_at');
    expect(cols('users')).toContain('disabled_at');
    const indexes = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions'")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_transactions_site', 'idx_transactions_user'])
    );
    fresh.close();
  });
});
