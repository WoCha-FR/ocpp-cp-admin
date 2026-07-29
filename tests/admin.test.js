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
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
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
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
      return done(null, { id: user.id, useremail: user.useremail, role: user.role });
    })
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
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
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
