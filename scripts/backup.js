#!/usr/bin/env node
/**
 * scripts/backup.js — SQLite online backup using better-sqlite3 backup API
 *
 * Usage:
 *   node scripts/backup.js [options]
 *
 * Options:
 *   --db-path    <path>   Path to the SQLite database file
 *                         (default: resolved from config/config.json)
 *   --backup-dir <dir>    Directory where backups are stored
 *                         (default: <config-dir>/backups)
 *   --keep       <n>      Number of backups to keep (default: 7)
 *
 * Examples:
 *   node scripts/backup.js
 *   node scripts/backup.js --backup-dir /mnt/nas/backups --keep 30
 *
 * Docker cron example (add to docker-compose.yml):
 *
 *   backup:
 *     image: ghcr.io/wocha-fr/ocpp-cp-admin:latest
 *     restart: unless-stopped
 *     entrypoint: /bin/sh
 *     command: >
 *       -c "while true; do
 *             node /app/scripts/backup.js --backup-dir /backups --keep 30;
 *             sleep 86400;
 *           done"
 *     volumes:
 *       - ./data/config:/app/config
 *       - ./data/backups:/backups
 *     environment:
 *       - NODE_ENV=production
 *
 * Restore procedure:
 *   1. Stop the application.
 *   2. Copy the desired backup file over the database:
 *        cp backups/cpadmin_YYYY-MM-DD_HH-MM-SS.db data/config/cpadmin.db
 *   3. Remove WAL files if present:
 *        rm -f data/config/cpadmin.db-shm data/config/cpadmin.db-wal
 *   4. Restart the application.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ── Resolve DB path from config ─────────────────────────────────────────────
function resolveFromConfig() {
  const configDir = path.resolve(__dirname, '..', 'config');
  let configFile = path.join(configDir, 'config.json');
  if (process.env.NODE_ENV === 'development') {
    const devFile = path.join(configDir, 'config.dev.json');
    if (fs.existsSync(devFile)) configFile = devFile;
  }
  let dbname = 'cpadmin.db';
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (cfg.general?.dbname) dbname = cfg.general.dbname;
  } catch {
    console.warn(`[backup] Could not read config: ${configFile} — using default dbname.`);
  }
  return { dbPath: path.resolve(configDir, dbname), configDir };
}

const { dbPath: defaultDbPath, configDir } = resolveFromConfig();

const dbPath = args['db-path'] ? path.resolve(args['db-path']) : defaultDbPath;
const backupDir = args['backup-dir']
  ? path.resolve(args['backup-dir'])
  : path.join(configDir, 'backups');
const keepCount = args['keep'] ? Math.max(1, parseInt(args['keep'], 10)) : 7;

// ── Backup ──────────────────────────────────────────────────────────────────
async function runBackup() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[backup] Database not found: ${dbPath}`);
    process.exit(1);
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .slice(0, 19);
  const backupName = `cpadmin_${timestamp}.db`;
  const backupPath = path.join(backupDir, backupName);

  console.log(`[backup] Source     : ${dbPath}`);
  console.log(`[backup] Destination: ${backupPath}`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }

  const stat = fs.statSync(backupPath);
  console.log(`[backup] Done       : ${(stat.size / 1024).toFixed(1)} KB`);

  // ── Rotate old backups ───────────────────────────────────────────────────
  const pattern = /^cpadmin_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/;
  const existing = fs
    .readdirSync(backupDir)
    .filter((f) => pattern.test(f))
    .sort();

  const toDelete = existing.slice(0, Math.max(0, existing.length - keepCount));
  for (const f of toDelete) {
    fs.rmSync(path.join(backupDir, f));
    console.log(`[backup] Removed    : ${f}`);
  }

  console.log(`[backup] Retained   : ${Math.min(existing.length, keepCount)} backup(s) in ${backupDir}`);
}

runBackup().catch((err) => {
  console.error('[backup] Error:', err.message);
  process.exit(1);
});
