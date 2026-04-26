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
const GLOBAL_ONLY_KEYS = ['HeartbeatInterval'];

function createApp() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const hash = bcrypt.hashSync('Admin!123', 4);
  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'admin@test.com', hash, 'admin', 'Admin'
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
    let token = (req.headers.cookie || '').split(';').reduce((acc, part) => {
      const [k, v] = part.trim().split('=');
      return k === CSRF_COOKIE ? decodeURIComponent(v) : acc;
    }, null);
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

  // Route chargepoint config — mirrors the GLOBAL_ONLY_KEYS check from routes.js
  app.put('/api/chargepoints/:id/config/:key', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'ERR_VALUE_REQUIRED' });
    }
    if (GLOBAL_ONLY_KEYS.includes(key)) {
      return res.status(400).json({ error: 'ERR_KEY_NOT_OVERRIDABLE' });
    }
    // Borne non connectée (simulé)
    return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });
  });

  // POST /api/chargepoints/:id/config/get-key — mock OCPP via options
  app.post('/api/chargepoints/:id/config/get-key', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key) return res.status(400).json({ error: 'ERR_KEY_REQUIRED' });
    const cp = db.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    // Simuler la réponse OCPP via une option injectée
    if (!app._mockOcppGetConfig) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });
    const result = app._mockOcppGetConfig(key);
    const found = Array.isArray(result?.configurationKey) && result.configurationKey.length > 0;
    res.json({ found, entry: found ? result.configurationKey[0] : null, unknown: result?.unknownKey ?? [] });
  });

  return { app, db };
}

async function loginAs(agent) {
  const meRes = await agent.get('/api/auth/me');
  const cookies = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : null;
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: 'admin@test.com', password: 'Admin!123' });
  return csrf;
}

let app, db;

beforeEach(() => {
  ({ app, db } = createApp());
});

afterEach(() => {
  db.close();
});

describe('PUT /api/chargepoints/:id/config/:key — GLOBAL_ONLY_KEYS protection', () => {
  it('returns 401 if not authenticated', async () => {
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookies = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : null;
    const res = await agent
      .put('/api/chargepoints/1/config/HeartbeatInterval')
      .set('x-xsrf-token', csrf)
      .send({ value: '300' });
    expect(res.status).toBe(401);
  });

  it('returns 400 ERR_KEY_NOT_OVERRIDABLE for HeartbeatInterval', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .put('/api/chargepoints/1/config/HeartbeatInterval')
      .set('x-xsrf-token', csrf)
      .send({ value: '300' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_KEY_NOT_OVERRIDABLE');
  });

  it('does not block other config keys', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .put('/api/chargepoints/1/config/WebSocketPingInterval')
      .set('x-xsrf-token', csrf)
      .send({ value: '60' });
    // Borne offline — mais pas bloqué par GLOBAL_ONLY_KEYS
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });

  it('returns 400 ERR_VALUE_REQUIRED when value is missing', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .put('/api/chargepoints/1/config/HeartbeatInterval')
      .set('x-xsrf-token', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_VALUE_REQUIRED');
  });
});

describe('POST /api/chargepoints/:id/config/get-key', () => {
  it('returns 401 if not authenticated', async () => {
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const csrf = decodeURIComponent(
      ((meRes.headers['set-cookie'] || []).join('; ').match(/XSRF-TOKEN=([^;]+)/) || [])[1] || ''
    );
    const res = await agent
      .post('/api/chargepoints/1/config/get-key')
      .set('x-xsrf-token', csrf)
      .send({ key: 'HeartbeatInterval' });
    expect(res.status).toBe(401);
  });

  it('returns 400 ERR_KEY_REQUIRED when key is missing', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post('/api/chargepoints/1/config/get-key')
      .set('x-xsrf-token', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_KEY_REQUIRED');
  });

  it('returns 400 ERR_KEY_REQUIRED when key is empty string', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post('/api/chargepoints/1/config/get-key')
      .set('x-xsrf-token', csrf)
      .send({ key: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_KEY_REQUIRED');
  });

  it('returns 404 ERR_CHARGEPOINT_NOT_FOUND for unknown chargepoint', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post('/api/chargepoints/9999/config/get-key')
      .set('x-xsrf-token', csrf)
      .send({ key: 'HeartbeatInterval' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_NOT_FOUND');
  });

  it('returns 400 ERR_CHARGEPOINT_OFFLINE when chargepoint is not connected', async () => {
    db.prepare(
      "INSERT INTO chargepoints (identity, cpname, password) VALUES ('CP001', 'Test CP', 'pass')"
    ).run();
    const cp = db.prepare("SELECT id FROM chargepoints WHERE identity = 'CP001'").get();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/config/get-key`)
      .set('x-xsrf-token', csrf)
      .send({ key: 'HeartbeatInterval' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });

  it('returns found=true with entry when key is known to the chargepoint', async () => {
    db.prepare(
      "INSERT INTO chargepoints (identity, cpname, password) VALUES ('CP002', 'Test CP 2', 'pass')"
    ).run();
    const cp = db.prepare("SELECT id FROM chargepoints WHERE identity = 'CP002'").get();
    app._mockOcppGetConfig = (key) => ({
      configurationKey: [{ key, value: '60', readonly: false }],
      unknownKey: [],
    });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/config/get-key`)
      .set('x-xsrf-token', csrf)
      .send({ key: 'HeartbeatInterval' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.entry).toMatchObject({ key: 'HeartbeatInterval', value: '60' });
    expect(res.body.unknown).toEqual([]);
    app._mockOcppGetConfig = null;
  });

  it('returns found=false when key is unknown to the chargepoint', async () => {
    db.prepare(
      "INSERT INTO chargepoints (identity, cpname, password) VALUES ('CP003', 'Test CP 3', 'pass')"
    ).run();
    const cp = db.prepare("SELECT id FROM chargepoints WHERE identity = 'CP003'").get();
    app._mockOcppGetConfig = (key) => ({
      configurationKey: [],
      unknownKey: [key],
    });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/config/get-key`)
      .set('x-xsrf-token', csrf)
      .send({ key: 'ProprietaryKey' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.entry).toBeNull();
    expect(res.body.unknown).toContain('ProprietaryKey');
    app._mockOcppGetConfig = null;
  });
});
