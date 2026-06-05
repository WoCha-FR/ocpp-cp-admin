const fs = require('fs');
const path = require('path');
const logger = require('./logger').scope('SQLDB');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/**
 * Initialise la table de suivi des migrations si elle n'existe pas.
 */
function initMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Retourne la liste des fichiers .sql du dossier migrations/, triés par nom.
 */
function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Retourne les noms de fichiers déjà appliqués en base.
 */
function getAppliedMigrations(db) {
  return db
    .prepare('SELECT filename FROM schema_migrations ORDER BY filename')
    .all()
    .map((row) => row.filename);
}

/**
 * Exécute toutes les migrations non encore appliquées, dans une transaction.
 * Retourne le nombre de migrations appliquées.
 */
function runMigrations(db) {
  initMigrationsTable(db);

  const files = getMigrationFiles();
  const applied = new Set(getAppliedMigrations(db));
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    logger.debug('Migration: up-to-date');
    return 0;
  }

  const applyAll = db.transaction(() => {
    for (const file of pending) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
      logger.info(`Migration applied: ${file}`);
    }
  });

  db.pragma('foreign_keys = OFF');
  applyAll();
  db.pragma('foreign_keys = ON');
  return pending.length;
}

/**
 * Initialise une nouvelle base de données vierge :
 * applique le schéma initial complet (001) et marque toutes les migrations comme appliquées.
 */
function initNewDatabase(db) {
  const initialSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001-initial-schema.sql'), 'utf-8');
  db.exec(initialSql);
  initMigrationsTable(db);
  const files = getMigrationFiles();
  const markAll = db.transaction(() => {
    for (const file of files) {
      db.prepare('INSERT OR IGNORE INTO schema_migrations (filename) VALUES (?)').run(file);
    }
  });
  markAll();
  logger.info(`New database initialized (${files.length} migrations marked as applied)`);
}

module.exports = { runMigrations, initNewDatabase };
