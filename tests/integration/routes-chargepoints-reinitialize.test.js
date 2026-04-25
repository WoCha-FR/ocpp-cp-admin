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

function createApp() {
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

  app.post('/api/chargepoints/:id/reinitialize', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) return res.status(400).json({ error: 'VALIDATION_ID' });
    const cp = db.prepare('SELECT * FROM chargepoints WHERE id = ?').get(id);
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    db.prepare('UPDATE chargepoints SET initialized = 0 WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return { app, db };
}

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const csrf = readCsrfCookie(meRes.headers['set-cookie']);
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

let app, db;

beforeEach(() => {
  ({ app, db } = createApp());
});

afterEach(() => {
  db.close();
});

describe('POST /api/chargepoints/:id/reinitialize', () => {
  let cpId;

  beforeEach(() => {
    const info = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus, initialized) VALUES ('CP-TEST', 'Available', 1)")
      .run();
    cpId = info.lastInsertRowid;
  });

  it('returns 401 if not authenticated', async () => {
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const csrf = readCsrfCookie(meRes.headers['set-cookie']);
    const res = await agent
      .post(`/api/chargepoints/${cpId}/reinitialize`)
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent
      .post(`/api/chargepoints/${cpId}/reinitialize`)
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ERR_ACCESS_DENIED');
  });

  it('returns 404 for unknown chargepoint id', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .post('/api/chargepoints/9999/reinitialize')
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_NOT_FOUND');
  });

  it('admin resets initialized to 0 and returns { ok: true }', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .post(`/api/chargepoints/${cpId}/reinitialize`)
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const cp = db.prepare('SELECT * FROM chargepoints WHERE id = ?').get(cpId);
    expect(cp.initialized).toBe(0);
  });

  it('chargepoint already at initialized = 0 stays at 0', async () => {
    db.prepare('UPDATE chargepoints SET initialized = 0 WHERE id = ?').run(cpId);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .post(`/api/chargepoints/${cpId}/reinitialize`)
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT initialized FROM chargepoints WHERE id = ?').get(cpId).initialized).toBe(0);
  });
});
