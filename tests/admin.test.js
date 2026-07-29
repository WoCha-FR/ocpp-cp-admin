'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;

const configMock = require('./helpers/config-mock');

jest.mock('../src/config', () => ({
  getConfig: () => configMock,
  getConfigDir: () => '/tmp',
  castEnvValue: jest.fn(),
  deepGet: jest.fn(),
  deepSet: jest.fn(),
  ENV_OVERRIDES: [],
  CONFIG_FIELDS: [],
}));

jest.mock('../src/logger', () => ({
  scope: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3');
  return function (_path, opts) {
    return new Real(':memory:', opts);
  };
});

const db = require('../src/database');

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'x-xsrf-token';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCsrfCookie(setCookieHeaders) {
  const cookies = (setCookieHeaders || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const csrf = readCsrfCookie(meRes.headers['set-cookie']);
  await agent
    .post('/api/auth/login')
    .set('x-xsrf-token', csrf)
    .send({ useremail: email, password });
  return csrf;
}

// ── database.js — getSystemStats() ──
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

// ── database.js — nettoyage des données (onglet 2) ──
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

// ── GET /api/admin/info ──
function createApp() {
  const testDb = db.getDb();

  const hash = bcrypt.hashSync('Admin!123', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', hash, 'admin', 'Admin');
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('user@test.com', hash, 'user', 'User');

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy(
      { usernameField: 'useremail', passwordField: 'password' },
      (email, pwd, done) => {
        const user = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
        if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
        return done(null, { id: user.id, useremail: user.useremail, role: user.role });
      }
    )
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? { id: u.id, useremail: u.useremail, role: u.role } : false);
  });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret!!', resave: false, saveUninitialized: false }));
  app.use(testPassport.initialize());
  app.use(testPassport.session());

  app.use((req, res, next) => {
    const header = req.headers.cookie || '';
    let token = null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1 && part.slice(0, eq).trim() === CSRF_COOKIE) {
        token = decodeURIComponent(part.slice(eq + 1).trim());
        break;
      }
    }
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', path: '/' });
    }
    if (!CSRF_SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== token) {
      return res.status(403).json({ error: 'csrf_invalid' });
    }
    next();
  });

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
      if (!roles.includes(req.user.role))
        return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
      next();
    };
  }

  app.get('/api/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    res.json(req.user);
  });

  app.post('/api/auth/login', (req, res, next) => {
    testPassport.authenticate('local', (err, user) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: 'ERR_INVALID_AUTH' });
      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.json(user);
      });
    })(req, res, next);
  });

  const APP_VERSION = require('../package.json').version;
  app.get('/api/admin/info', requireRole('admin'), (req, res) => {
    const stats = db.getSystemStats();
    res.json({
      version: APP_VERSION,
      uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(),
      dbSizeBytes: stats.dbSizeBytes,
      counts: stats.counts,
      connected: { db: stats.connectedDb, live: 0 },
    });
  });

  app.get('/api/admin/db/backup', requireRole('admin'), async (req, res) => {
    const tempPath = path.join(os.tmpdir(), `cpadmin-backup-test-${crypto.randomUUID()}.sqlite`);
    try {
      await db.backupDatabase(tempPath);
    } catch {
      return res.status(500).json({ error: 'ERR_BACKUP_FAILED' });
    }
    res.download(tempPath, 'cpadmin-backup-test.sqlite', () => {
      fs.unlink(tempPath, () => {});
    });
  });

  const BEFORE_DATE_RE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/;

  app.get('/api/admin/cleanup/stats', requireRole('admin'), (req, res) => {
    res.json(db.getCleanupStats());
  });

  app.delete('/api/admin/cleanup/transaction-values', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.body.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteTransactionValuesBefore(req.body.before) });
  });

  app.delete('/api/admin/cleanup/id-tag-events', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.body.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteIdTagEventsBefore(req.body.before) });
  });

  app.delete('/api/admin/cleanup/error-events', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.body.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteErrorEventsBefore(req.body.before) });
  });

  app.delete('/api/admin/cleanup/reservations', requireRole('admin'), (req, res) => {
    if (req.body.before && !BEFORE_DATE_RE.test(req.body.before))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteExpiredReservations(req.body.before || null) });
  });

  app.delete('/api/admin/cleanup/notification-log', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.query.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteNotificationLogBefore(req.query.before) });
  });

  app.post('/api/admin/db/vacuum', requireRole('admin'), (req, res) => {
    db.vacuumDatabase();
    res.json({ ok: true });
  });

  return app;
}

describe('GET /api/admin/info', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('retourne 401 si non authentifié', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/info');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur non-admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'Admin!123');
    const res = await agent.get('/api/admin/info');
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec les infos système pour un admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/admin/info');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.memory).toHaveProperty('heapUsed');
    expect(typeof res.body.dbSizeBytes).toBe('number');
    expect(res.body.counts).toHaveProperty('transactions');
    expect(res.body.connected).toMatchObject({ db: 0, live: 0 });
  });
});

describe('GET /api/admin/db/backup', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('retourne 401 si non authentifié', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/db/backup');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur non-admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'Admin!123');
    const res = await agent.get('/api/admin/db/backup');
    expect(res.status).toBe(403);
  });

  it('retourne un fichier SQLite téléchargeable pour un admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/admin/db/backup');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

// ── Endpoints admin — nettoyage des données (onglet 2) ──
describe('Endpoints admin — nettoyage des données', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('GET /api/admin/cleanup/stats retourne 401/403/200 selon le rôle', async () => {
    const app = createApp();
    const anon = await request(app).get('/api/admin/cleanup/stats');
    expect(anon.status).toBe(401);

    const userAgent = request.agent(app);
    await loginAs(userAgent, 'user@test.com', 'Admin!123');
    const forbidden = await userAgent.get('/api/admin/cleanup/stats');
    expect(forbidden.status).toBe(403);

    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const ok = await adminAgent.get('/api/admin/cleanup/stats').set('x-xsrf-token', csrf);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body.map((r) => r.table)).toContain('transactions_values');
  });

  it('DELETE /api/admin/cleanup/transaction-values purge les valeurs sans toucher aux transactions', async () => {
    const app = createApp();
    const testDb = db.getDb();
    const cp = db.createChargepoint('CP-EP-CLEANUP', 'CP', 'pass');
    testDb
      .prepare(
        `INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, status, start_time, stop_time)
         VALUES ('TX-EP-OLD', ?, 1, 'Completed', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`
      )
      .run(cp.id);
    db.upsertTransactionValues('TX-EP-OLD', { energieEntry: '1' });

    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const res = await adminAgent
      .delete('/api/admin/cleanup/transaction-values')
      .set('x-xsrf-token', csrf)
      .send({ before: '2030-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(
      testDb.prepare("SELECT * FROM transactions WHERE transaction_id = 'TX-EP-OLD'").get()
    ).toBeDefined();
    expect(db.getTransactionValues('TX-EP-OLD')).toBeUndefined();
  });

  it('DELETE /api/admin/cleanup/transaction-values rejette une requête sans date (VALIDATION_BEFORE)', async () => {
    const app = createApp();
    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const res = await adminAgent
      .delete('/api/admin/cleanup/transaction-values')
      .set('x-xsrf-token', csrf)
      .send({});
    expect(res.status).toBe(400);
  });

  it('DELETE /api/admin/cleanup/reservations accepte une requête sans date (before optionnel)', async () => {
    const app = createApp();
    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const res = await adminAgent
      .delete('/api/admin/cleanup/reservations')
      .set('x-xsrf-token', csrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deleted');
  });

  it('POST /api/admin/db/vacuum retourne 200 pour un admin et 403 sinon', async () => {
    const app = createApp();
    const userAgent = request.agent(app);
    const userCsrf = await loginAs(userAgent, 'user@test.com', 'Admin!123');
    const forbidden = await userAgent.post('/api/admin/db/vacuum').set('x-xsrf-token', userCsrf);
    expect(forbidden.status).toBe(403);

    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const ok = await adminAgent.post('/api/admin/db/vacuum').set('x-xsrf-token', csrf);
    expect(ok.status).toBe(200);
  });
});
