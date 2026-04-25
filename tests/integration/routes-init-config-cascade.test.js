'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/migrator');

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'x-xsrf-token';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCsrfCookie(setCookieHeaders) {
  const cookies = (setCookieHeaders || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function createApp(connectedClients = new Map(), mockCallClient = jest.fn()) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'admin@test.com', bcrypt.hashSync('Admin!123', 4), 'admin', 'Admin'
  );
  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'user@test.com', bcrypt.hashSync('User!1234', 4), 'user', 'RegularUser'
  );

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = db.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
      return done(null, { id: user.id, useremail: user.useremail, role: user.role });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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

  app.get('/api/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    res.json(req.user);
  });

  app.post('/api/auth/login', (req, res, next) => {
    testPassport.authenticate('local', (err, user) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: 'ERR_INVALID_AUTH' });
      req.logIn(user, (err) => {
        if (err) return next(err);
        res.json(user);
      });
    })(req, res, next);
  });

  // Mirrors the POST /init-config/cascade-all route from src/routes.js
  app.post('/api/init-config/cascade-all', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });

    const configs = db
      .prepare('SELECT * FROM chargepoint_init_config WHERE enabled = 1 ORDER BY key')
      .all();
    const chargepoints = db.prepare('SELECT * FROM chargepoints').all();

    const applied = [];
    const queued = [];
    const skipped = [];
    const errors = [];

    for (const cp of chargepoints) {
      const isOnline = connectedClients.has(cp.identity);
      let cpQueued = false;

      for (const cfg of configs) {
        const current = db
          .prepare('SELECT * FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
          .get(cp.id, cfg.key);
        if (current?.is_override) {
          skipped.push({ identity: cp.identity, key: cfg.key, reason: 'override' });
          continue;
        }
        if (current?.value === cfg.value) continue;

        if (isOnline) {
          try {
            const result = await mockCallClient(cp.identity, 'ChangeConfiguration', {
              key: cfg.key,
              value: cfg.value,
            });
            if (result?.status === 'Accepted' || result?.status === 'RebootRequired') {
              const existing = db
                .prepare('SELECT id FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
                .get(cp.id, cfg.key);
              if (existing) {
                db.prepare(
                  "UPDATE chargepoint_config SET value = ?, readonly = 0, updated_at = datetime('now') WHERE chargepoint_id = ? AND key = ?"
                ).run(cfg.value, cp.id, cfg.key);
              } else {
                db.prepare(
                  'INSERT INTO chargepoint_config (chargepoint_id, key, value, readonly, is_override) VALUES (?, ?, ?, 0, 0)'
                ).run(cp.id, cfg.key, cfg.value);
              }
              applied.push({ identity: cp.identity, key: cfg.key });
            } else {
              errors.push({ identity: cp.identity, key: cfg.key, reason: result?.status });
            }
          } catch (e) {
            errors.push({ identity: cp.identity, key: cfg.key, reason: e.message });
          }
        } else if (!cpQueued) {
          db.prepare('UPDATE chargepoints SET initialized = 0 WHERE id = ?').run(cp.id);
          queued.push({ identity: cp.identity });
          cpQueued = true;
        }
      }
    }

    res.json({ applied, queued, skipped, errors });
  });

  return { app, db };
}

async function loginAs(agent, email = 'admin@test.com', password = 'Admin!123') {
  const meRes = await agent.get('/api/auth/me');
  const csrf = readCsrfCookie(meRes.headers['set-cookie']);
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

// ── Helpers DB ──

function insertChargepoint(db, identity, initialized = 1) {
  return db
    .prepare("INSERT INTO chargepoints (identity, cpstatus, initialized) VALUES (?, 'Available', ?)")
    .run(identity, initialized).lastInsertRowid;
}

function insertInitConfig(db, key, value, enabled = 1) {
  db.prepare('DELETE FROM chargepoint_init_config WHERE key = ?').run(key);
  db.prepare('INSERT INTO chargepoint_init_config (key, value, enabled) VALUES (?, ?, ?)').run(
    key, value, enabled
  );
}

function insertCpConfig(db, cpId, key, value, isOverride = 0) {
  db.prepare(
    'INSERT OR REPLACE INTO chargepoint_config (chargepoint_id, key, value, readonly, is_override) VALUES (?, ?, ?, 0, ?)'
  ).run(cpId, key, value, isOverride);
}

// ══════════════════════════════════════════════════════════════════

describe('POST /api/init-config/cascade-all', () => {
  describe('access control', () => {
    let app, db;

    beforeEach(() => {
      ({ app, db } = createApp());
    });

    afterEach(() => db.close());

    it('returns 401 if not authenticated', async () => {
      const agent = request.agent(app);
      const meRes = await agent.get('/api/auth/me');
      const csrf = readCsrfCookie(meRes.headers['set-cookie']);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
      const agent = request.agent(app);
      const csrf = await loginAs(agent, 'user@test.com', 'User!1234');
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ERR_ACCESS_DENIED');
    });
  });

  describe('no enabled configs', () => {
    let app, db;

    beforeEach(() => {
      ({ app, db } = createApp());
      db.prepare('UPDATE chargepoint_init_config SET enabled = 0').run();
      insertChargepoint(db, 'CP-001');
    });

    afterEach(() => db.close());

    it('returns empty result when no init-config is enabled', async () => {
      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ applied: [], queued: [], skipped: [], errors: [] });
    });
  });

  describe('offline chargepoint (no override)', () => {
    let app, db;

    beforeEach(() => {
      ({ app, db } = createApp(new Map()));
      db.prepare('DELETE FROM chargepoint_init_config').run();
      insertInitConfig(db, 'HeartbeatInterval', '300');
      insertInitConfig(db, 'WebSocketPingInterval', '60');
    });

    afterEach(() => db.close());

    it('adds chargepoint to queued and resets initialized to 0', async () => {
      const cpId = insertChargepoint(db, 'CP-OFFLINE', 1);

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.queued).toHaveLength(1);
      expect(res.body.queued[0].identity).toBe('CP-OFFLINE');
      expect(res.body.applied).toHaveLength(0);
      expect(res.body.skipped).toHaveLength(0);

      const cp = db.prepare('SELECT initialized FROM chargepoints WHERE id = ?').get(cpId);
      expect(cp.initialized).toBe(0);
    });

    it('queues offline chargepoint only once regardless of config count', async () => {
      insertChargepoint(db, 'CP-OFFLINE2', 1);

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.body.queued).toHaveLength(1);
    });

    it('does not queue if offline cp config already matches (no change needed)', async () => {
      const cpId = insertChargepoint(db, 'CP-MATCH', 1);
      insertCpConfig(db, cpId, 'HeartbeatInterval', '300');
      insertCpConfig(db, cpId, 'WebSocketPingInterval', '60');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.body.queued).toHaveLength(0);
      const cp = db.prepare('SELECT initialized FROM chargepoints WHERE id = ?').get(cpId);
      expect(cp.initialized).toBe(1);
    });
  });

  describe('online chargepoint — callClient success', () => {
    let app, db, mockCallClient;

    beforeEach(() => {
      mockCallClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
      const connected = new Map([['CP-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_config').run();
      insertInitConfig(db, 'HeartbeatInterval', '600');
    });

    afterEach(() => db.close());

    it('sends ChangeConfiguration and adds to applied', async () => {
      insertChargepoint(db, 'CP-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.applied).toHaveLength(1);
      expect(res.body.applied[0]).toEqual({ identity: 'CP-ONLINE', key: 'HeartbeatInterval' });
      expect(mockCallClient).toHaveBeenCalledWith('CP-ONLINE', 'ChangeConfiguration', {
        key: 'HeartbeatInterval',
        value: '600',
      });
    });

    it('saves the new value in chargepoint_config with is_override = 0', async () => {
      const cpId = insertChargepoint(db, 'CP-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      const cfg = db
        .prepare('SELECT * FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
        .get(cpId, 'HeartbeatInterval');
      expect(cfg).toBeDefined();
      expect(cfg.value).toBe('600');
      expect(cfg.is_override).toBe(0);
    });

    it('treats RebootRequired as success', async () => {
      mockCallClient.mockResolvedValue({ status: 'RebootRequired' });
      insertChargepoint(db, 'CP-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.body.applied).toHaveLength(1);
    });

    it('skips config already at the correct value', async () => {
      const cpId = insertChargepoint(db, 'CP-ONLINE');
      insertCpConfig(db, cpId, 'HeartbeatInterval', '600');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.body.applied).toHaveLength(0);
      expect(mockCallClient).not.toHaveBeenCalled();
    });
  });

  describe('online chargepoint — callClient failure', () => {
    let app, db, mockCallClient;

    beforeEach(() => {
      db = undefined;
    });

    afterEach(() => db?.close());

    it('adds to errors when callClient returns Rejected', async () => {
      mockCallClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
      const connected = new Map([['CP-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_config').run();
      insertInitConfig(db, 'HeartbeatInterval', '600');
      insertChargepoint(db, 'CP-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0]).toMatchObject({ identity: 'CP-ONLINE', key: 'HeartbeatInterval', reason: 'Rejected' });
      expect(res.body.applied).toHaveLength(0);
    });

    it('adds to errors when callClient throws', async () => {
      mockCallClient = jest.fn().mockRejectedValue(new Error('connection lost'));
      const connected = new Map([['CP-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_config').run();
      insertInitConfig(db, 'HeartbeatInterval', '600');
      insertChargepoint(db, 'CP-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].reason).toBe('connection lost');
    });
  });

  describe('override protection', () => {
    let app, db, mockCallClient;

    beforeEach(() => {
      mockCallClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
      const connected = new Map([['CP-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_config').run();
      insertInitConfig(db, 'WebSocketPingInterval', '60');
    });

    afterEach(() => db.close());

    it('skips config marked as override and does not call callClient', async () => {
      const cpId = insertChargepoint(db, 'CP-ONLINE');
      insertCpConfig(db, cpId, 'WebSocketPingInterval', '120', 1);

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0]).toMatchObject({
        identity: 'CP-ONLINE',
        key: 'WebSocketPingInterval',
        reason: 'override',
      });
      expect(mockCallClient).not.toHaveBeenCalled();

      const cfg = db
        .prepare('SELECT value FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
        .get(cpId, 'WebSocketPingInterval');
      expect(cfg.value).toBe('120');
    });
  });

  describe('mixed scenario', () => {
    let app, db, mockCallClient;

    afterEach(() => db.close());

    it('correctly categorises online / offline / override chargepoints', async () => {
      mockCallClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
      const connected = new Map([['CP-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));

      db.prepare('DELETE FROM chargepoint_init_config').run();
      insertInitConfig(db, 'HeartbeatInterval', '600');

      const cpOnlineId = insertChargepoint(db, 'CP-ONLINE');
      const cpOfflineId = insertChargepoint(db, 'CP-OFFLINE');
      const cpOverrideId = insertChargepoint(db, 'CP-OVERRIDE');
      insertCpConfig(db, cpOverrideId, 'HeartbeatInterval', '300', 1);

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent.post('/api/init-config/cascade-all').set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.applied.map((a) => a.identity)).toContain('CP-ONLINE');
      expect(res.body.queued.map((q) => q.identity)).toContain('CP-OFFLINE');
      expect(res.body.skipped.map((s) => s.identity)).toContain('CP-OVERRIDE');
      expect(res.body.errors).toHaveLength(0);

      // Override untouched
      const overrideCfg = db
        .prepare('SELECT value FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
        .get(cpOverrideId, 'HeartbeatInterval');
      expect(overrideCfg.value).toBe('300');

      // Offline reset
      const offlineCp = db.prepare('SELECT initialized FROM chargepoints WHERE id = ?').get(cpOfflineId);
      expect(offlineCp.initialized).toBe(0);
    });
  });
});
