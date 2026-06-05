'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const Database = require('better-sqlite3');
const { initNewDatabase } = require('../../src/migrator');

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
  initNewDatabase(db);

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

  // Mirrors the POST /init-config/variables/cascade-all route from src/routes.js
  app.post('/api/init-config/variables/cascade-all', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });

    const vars = db
      .prepare('SELECT * FROM chargepoint_init_variables WHERE enabled = 1 ORDER BY component, variable, attribute')
      .all();
    const chargepoints = db
      .prepare("SELECT * FROM chargepoints WHERE ocpp_version = '2.0.1'")
      .all();

    const applied = [];
    const queued = [];
    const skipped = [];
    const errors = [];

    for (const cp of chargepoints) {
      const isOnline = connectedClients.has(cp.identity);
      let cpQueued = false;

      for (const v of vars) {
        if (isOnline) {
          try {
            const result = await mockCallClient(cp.identity, 'SetVariables', {
              setVariableData: [
                {
                  component: { name: v.component },
                  variable: { name: v.variable },
                  attributeType: v.attribute || 'Actual',
                  attributeValue: v.value,
                },
              ],
            });
            const setResult = result?.setVariableResult?.[0];
            if (
              setResult?.attributeStatus === 'Accepted' ||
              setResult?.attributeStatus === 'RebootRequired'
            ) {
              const attr = v.attribute || 'Actual';
              const existing = db
                .prepare(
                  'SELECT id FROM chargepoint_variables WHERE chargepoint_id = ? AND component = ? AND variable = ? AND attribute = ?'
                )
                .get(cp.id, v.component, v.variable, attr);
              if (existing) {
                db.prepare(
                  "UPDATE chargepoint_variables SET value = ?, updated_at = datetime('now') WHERE id = ?"
                ).run(v.value, existing.id);
              } else {
                db.prepare(
                  'INSERT INTO chargepoint_variables (chargepoint_id, component, variable, attribute, value) VALUES (?, ?, ?, ?, ?)'
                ).run(cp.id, v.component, v.variable, attr, v.value);
              }
              applied.push({ identity: cp.identity, key: `${v.component}.${v.variable}` });
            } else {
              errors.push({
                identity: cp.identity,
                key: `${v.component}.${v.variable}`,
                reason: setResult?.attributeStatus,
              });
            }
          } catch (e) {
            errors.push({
              identity: cp.identity,
              key: `${v.component}.${v.variable}`,
              reason: e.message,
            });
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

function insertChargepoint201(db, identity, initialized = 1) {
  return db
    .prepare(
      "INSERT INTO chargepoints (identity, cpstatus, ocpp_version, initialized) VALUES (?, 'Available', '2.0.1', ?)"
    )
    .run(identity, initialized).lastInsertRowid;
}

function insertChargepoint16(db, identity) {
  return db
    .prepare("INSERT INTO chargepoints (identity, cpstatus, ocpp_version, initialized) VALUES (?, 'Available', '1.6', 1)")
    .run(identity).lastInsertRowid;
}

function insertInitVariable(db, component, variable, value, enabled = 1) {
  db.prepare(
    'DELETE FROM chargepoint_init_variables WHERE component = ? AND variable = ? AND attribute = ?'
  ).run(component, variable, 'Actual');
  db.prepare(
    'INSERT INTO chargepoint_init_variables (component, variable, attribute, value, enabled) VALUES (?, ?, ?, ?, ?)'
  ).run(component, variable, 'Actual', value, enabled);
}

// ══════════════════════════════════════════════════════════════════

describe('POST /api/init-config/variables/cascade-all', () => {
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
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
      const agent = request.agent(app);
      const csrf = await loginAs(agent, 'user@test.com', 'User!1234');
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ERR_ACCESS_DENIED');
    });
  });

  describe('no 2.0.1 chargepoints', () => {
    let app, db;

    beforeEach(() => {
      ({ app, db } = createApp());
      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '300');
      insertChargepoint16(db, 'CP-16-ONLY');
    });

    afterEach(() => db.close());

    it('returns empty result when no 2.0.1 chargepoints exist', async () => {
      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ applied: [], queued: [], skipped: [], errors: [] });
    });

    it('ignores 1.6 chargepoints completely', async () => {
      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);
      expect(res.body.applied).toHaveLength(0);
      expect(res.body.queued).toHaveLength(0);
    });
  });

  describe('offline 2.0.1 chargepoint', () => {
    let app, db;

    beforeEach(() => {
      ({ app, db } = createApp(new Map()));
      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '300');
      insertInitVariable(db, 'OCPPCommCtrlr', 'WebSocketPingInterval', '60');
    });

    afterEach(() => db.close());

    it('adds chargepoint to queued and resets initialized to 0', async () => {
      const cpId = insertChargepoint201(db, 'CP201-OFFLINE', 1);

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.queued).toHaveLength(1);
      expect(res.body.queued[0].identity).toBe('CP201-OFFLINE');
      expect(res.body.applied).toHaveLength(0);

      const cp = db.prepare('SELECT initialized FROM chargepoints WHERE id = ?').get(cpId);
      expect(cp.initialized).toBe(0);
    });

    it('queues offline chargepoint only once regardless of variable count', async () => {
      insertChargepoint201(db, 'CP201-OFFLINE2', 1);

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.body.queued).toHaveLength(1);
    });
  });

  describe('online 2.0.1 chargepoint — SetVariables accepted', () => {
    let app, db, mockCallClient;

    beforeEach(() => {
      mockCallClient = jest
        .fn()
        .mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Accepted' }] });
      const connected = new Map([['CP201-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '600');
    });

    afterEach(() => db.close());

    it('sends SetVariables and adds to applied', async () => {
      insertChargepoint201(db, 'CP201-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.applied).toHaveLength(1);
      expect(res.body.applied[0]).toEqual({
        identity: 'CP201-ONLINE',
        key: 'OCPPCommCtrlr.HeartbeatInterval',
      });
      expect(mockCallClient).toHaveBeenCalledWith('CP201-ONLINE', 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'HeartbeatInterval' },
            attributeType: 'Actual',
            attributeValue: '600',
          },
        ],
      });
    });

    it('persists the new value in chargepoint_variables', async () => {
      const cpId = insertChargepoint201(db, 'CP201-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      await agent.post('/api/init-config/variables/cascade-all').set('x-xsrf-token', csrf);

      const row = db
        .prepare(
          'SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? AND component = ? AND variable = ?'
        )
        .get(cpId, 'OCPPCommCtrlr', 'HeartbeatInterval');
      expect(row).toBeDefined();
      expect(row.value).toBe('600');
    });

    it('treats RebootRequired as success', async () => {
      mockCallClient.mockResolvedValue({
        setVariableResult: [{ attributeStatus: 'RebootRequired' }],
      });
      insertChargepoint201(db, 'CP201-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.body.applied).toHaveLength(1);
    });
  });

  describe('online 2.0.1 chargepoint — SetVariables rejected', () => {
    let app, db, mockCallClient;

    afterEach(() => db?.close());

    it('adds to errors when SetVariables returns Rejected', async () => {
      mockCallClient = jest
        .fn()
        .mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Rejected' }] });
      const connected = new Map([['CP201-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '600');
      insertChargepoint201(db, 'CP201-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0]).toMatchObject({
        identity: 'CP201-ONLINE',
        key: 'OCPPCommCtrlr.HeartbeatInterval',
        reason: 'Rejected',
      });
      expect(res.body.applied).toHaveLength(0);
    });

    it('adds to errors when callClient throws', async () => {
      mockCallClient = jest.fn().mockRejectedValue(new Error('connection lost'));
      const connected = new Map([['CP201-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '600');
      insertChargepoint201(db, 'CP201-ONLINE');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].reason).toBe('connection lost');
    });
  });

  describe('skipped result is always empty (no override concept for variables)', () => {
    let app, db, mockCallClient;

    beforeEach(() => {
      mockCallClient = jest
        .fn()
        .mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Accepted' }] });
      const connected = new Map([['CP201-ONLINE', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));
      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '300');
      insertChargepoint201(db, 'CP201-ONLINE');
    });

    afterEach(() => db.close());

    it('always returns skipped as empty array', async () => {
      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.body.skipped).toEqual([]);
    });
  });

  describe('mixed scenario — online 2.0.1 + offline 2.0.1 + 1.6', () => {
    let app, db, mockCallClient;

    afterEach(() => db.close());

    it('correctly categorises online / offline / 1.6-ignored chargepoints', async () => {
      mockCallClient = jest
        .fn()
        .mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Accepted' }] });
      const connected = new Map([['CP201-ON', {}]]);
      ({ app, db } = createApp(connected, mockCallClient));

      db.prepare('DELETE FROM chargepoint_init_variables').run();
      insertInitVariable(db, 'OCPPCommCtrlr', 'HeartbeatInterval', '600');

      const cpOnlineId = insertChargepoint201(db, 'CP201-ON');
      const cpOfflineId = insertChargepoint201(db, 'CP201-OFF');
      insertChargepoint16(db, 'CP16-IGNORED');

      const agent = request.agent(app);
      const csrf = await loginAs(agent);
      const res = await agent
        .post('/api/init-config/variables/cascade-all')
        .set('x-xsrf-token', csrf);

      expect(res.status).toBe(200);
      expect(res.body.applied.map((a) => a.identity)).toContain('CP201-ON');
      expect(res.body.queued.map((q) => q.identity)).toContain('CP201-OFF');
      expect(res.body.applied.map((a) => a.identity)).not.toContain('CP16-IGNORED');
      expect(res.body.queued.map((q) => q.identity)).not.toContain('CP16-IGNORED');
      expect(res.body.errors).toHaveLength(0);

      // Offline 2.0.1 réinitialisé
      const offlineCp = db.prepare('SELECT initialized FROM chargepoints WHERE id = ?').get(cpOfflineId);
      expect(offlineCp.initialized).toBe(0);

      // Online 2.0.1 variable persistée
      const onlineVar = db
        .prepare(
          'SELECT value FROM chargepoint_variables WHERE chargepoint_id = ? AND component = ? AND variable = ?'
        )
        .get(cpOnlineId, 'OCPPCommCtrlr', 'HeartbeatInterval');
      expect(onlineVar?.value).toBe('600');
    });
  });
});
