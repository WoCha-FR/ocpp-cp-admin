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

const GLOBAL_ONLY_VARS_201 = [{ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' }];

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

  // Mirrors DELETE /init-config/variables/:id from src/routes.js
  app.delete('/api/init-config/variables/:id', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });

    const id = Number(req.params.id);
    const all = db.prepare('SELECT * FROM chargepoint_init_variables').all();
    const row = all.find((v) => v.id === id);
    if (row && GLOBAL_ONLY_VARS_201.some((g) => g.component === row.component && g.variable === row.variable)) {
      return res.status(400).json({ error: 'ERR_VAR_NOT_DELETABLE' });
    }
    db.prepare('DELETE FROM chargepoint_init_variables WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return { app, db };
}

async function loginAs(agent, email = 'admin@test.com', password = 'Admin!123') {
  const meRes = await agent.get('/api/auth/me');
  const csrf = readCsrfCookie(meRes.headers['set-cookie']);
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

// ══════════════════════════════════════════════════════════════════

describe('DELETE /api/init-config/variables/:id — protection variable système', () => {
  let app, db, agent, csrf;

  beforeEach(async () => {
    ({ app, db } = createApp());
    agent = request.agent(app);
    csrf = await loginAs(agent);
  });

  afterEach(() => db.close());

  it('returns 401 if not authenticated', async () => {
    const row = db
      .prepare("SELECT id FROM chargepoint_init_variables WHERE component='OCPPCommCtrlr' AND variable='HeartbeatInterval'")
      .get();
    const unauthAgent = request.agent(app);
    const meRes = await unauthAgent.get('/api/auth/me');
    const unauthCsrf = readCsrfCookie(meRes.headers['set-cookie']);
    const res = await unauthAgent
      .delete(`/api/init-config/variables/${row.id}`)
      .set('x-xsrf-token', unauthCsrf);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const row = db
      .prepare("SELECT id FROM chargepoint_init_variables WHERE component='OCPPCommCtrlr' AND variable='HeartbeatInterval'")
      .get();
    const userAgent = request.agent(app);
    const userCsrf = await loginAs(userAgent, 'user@test.com', 'User!1234');
    const res = await userAgent
      .delete(`/api/init-config/variables/${row.id}`)
      .set('x-xsrf-token', userCsrf);
    expect(res.status).toBe(403);
  });

  it('returns 400 ERR_VAR_NOT_DELETABLE for OCPPCommCtrlr.HeartbeatInterval', async () => {
    const row = db
      .prepare("SELECT id FROM chargepoint_init_variables WHERE component='OCPPCommCtrlr' AND variable='HeartbeatInterval'")
      .get();
    expect(row).toBeDefined();
    const res = await agent
      .delete(`/api/init-config/variables/${row.id}`)
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_VAR_NOT_DELETABLE');
  });

  it('variable OCPPCommCtrlr.HeartbeatInterval reste en base après tentative de suppression', async () => {
    const row = db
      .prepare("SELECT id FROM chargepoint_init_variables WHERE component='OCPPCommCtrlr' AND variable='HeartbeatInterval'")
      .get();
    await agent.delete(`/api/init-config/variables/${row.id}`).set('x-xsrf-token', csrf);
    const still = db
      .prepare("SELECT id FROM chargepoint_init_variables WHERE component='OCPPCommCtrlr' AND variable='HeartbeatInterval'")
      .get();
    expect(still).toBeDefined();
  });

  it('allows deleting a non-system variable', async () => {
    const ins = db
      .prepare(
        "INSERT INTO chargepoint_init_variables (component,variable,attribute,value,enabled) VALUES ('TxCtrlr','TestVariable','Actual','true',1)"
      )
      .run();
    const res = await agent
      .delete(`/api/init-config/variables/${ins.lastInsertRowid}`)
      .set('x-xsrf-token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const gone = db
      .prepare('SELECT id FROM chargepoint_init_variables WHERE id = ?')
      .get(ins.lastInsertRowid);
    expect(gone).toBeUndefined();
  });
});
