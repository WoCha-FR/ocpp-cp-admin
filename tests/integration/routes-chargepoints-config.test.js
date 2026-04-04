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
