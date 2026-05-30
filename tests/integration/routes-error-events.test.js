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

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function createApp() {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  runMigrations(testDb);

  const adminHash = bcrypt.hashSync('Admin!123', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('admin@test.com', adminHash, 'admin', 'Admin');

  const userHash = bcrypt.hashSync('User!1234', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('user@test.com', userHash, 'user', 'RegularUser');

  const testPassport = new passport.Passport();
  testPassport.use(new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
    if (!u || !bcrypt.compareSync(pwd, u.password)) return done(null, false);
    return done(null, { id: u.id, useremail: u.useremail, role: u.role, sites: [] });
  }));
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? { id: u.id, useremail: u.useremail, role: u.role, sites: [] } : false);
  });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret!!', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));
  app.use(testPassport.initialize());
  app.use(testPassport.session());

  app.use((req, res, next) => {
    let token = readCookie(req, CSRF_COOKIE);
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', path: '/' });
    }
    if (!CSRF_SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== token) {
      return res.status(403).json({ error: 'csrf_invalid' });
    }
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    next();
  }

  function requireManager(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role === 'admin') return next();
    const hasManagedSite = (req.user.sites || []).some((s) => s.role === 'manager');
    if (!hasManagedSite) return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    next();
  }

  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

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

  // Route sous test
  app.get('/api/error-events', requireManager, (req, res) => {
    const { chargepoint_id, site_id, event_type, ocpp_version, from, to, limit, offset } = req.query;

    // Validation manuelle des params (simule express-validator)
    if (chargepoint_id && !/^\d+$/.test(chargepoint_id)) return res.status(400).json({ error: 'VALIDATION_CHARGEPOINT_ID' });
    if (site_id && !/^\d+$/.test(site_id)) return res.status(400).json({ error: 'VALIDATION_SITE_ID' });
    if (event_type && !['status_error', 'disconnect', 'heartbeat_timeout'].includes(event_type)) return res.status(400).json({ error: 'VALIDATION_EVENT_TYPE' });
    if (ocpp_version && !['1.6', '2.0.1'].includes(ocpp_version)) return res.status(400).json({ error: 'VALIDATION_OCPP_VERSION' });

    let query = `SELECT ee.*, cp.identity AS chargepoint_identity, cp.cpname AS chargepoint_name, cp.site_id, s.sname AS site_name
      FROM error_events ee
      LEFT JOIN chargepoints cp ON cp.id = ee.chargepoint_id
      LEFT JOIN sites s ON s.id = cp.site_id
      WHERE 1=1`;
    const params = [];
    if (chargepoint_id) { query += ' AND ee.chargepoint_id = ?'; params.push(Number(chargepoint_id)); }
    if (site_id) { query += ' AND cp.site_id = ?'; params.push(Number(site_id)); }
    if (event_type) { query += ' AND ee.event_type = ?'; params.push(event_type); }
    if (ocpp_version) { query += ' AND ee.ocpp_version = ?'; params.push(ocpp_version); }
    if (from) { query += ' AND ee.created_at >= ?'; params.push(from); }
    if (to) { query += ' AND ee.created_at <= ?'; params.push(to); }
    const lim = limit === 'all' ? null : Math.min(Number(limit) || 100, 500);
    const off = Number(offset) || 0;
    if (lim !== null) {
      query += ' ORDER BY ee.id DESC LIMIT ? OFFSET ?';
      params.push(lim, off);
    } else {
      query += ' ORDER BY ee.id DESC';
    }
    res.json(testDb.prepare(query).all(...params));
  });

  return { app, db: testDb };
}

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookies = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : null;
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

describe('GET /api/error-events', () => {
  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/error-events');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur simple (non manager)', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/error-events');
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec un tableau vide pour un admin sans événements', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('retourne les événements insérés', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('TEST-CP-01', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type, connector_id, error_code) VALUES (?, '1.6', 'status_error', 1, 'GroundFailure')").run(cpId);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const e = res.body.find(x => x.chargepoint_id === cpId);
    expect(e).toBeDefined();
    expect(e.event_type).toBe('status_error');
    expect(e.error_code).toBe('GroundFailure');
    expect(e.chargepoint_identity).toBe('TEST-CP-01');
  });

  it('filtre par chargepoint_id', async () => {
    const cp1 = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-A', 'Available')").run().lastInsertRowid;
    const cp2 = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-B', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'disconnect')").run(cp1);
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'heartbeat_timeout')").run(cp2);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/error-events?chargepoint_id=${cp1}`);
    expect(res.status).toBe(200);
    expect(res.body.every(e => e.chargepoint_id === cp1)).toBe(true);
  });

  it('filtre par event_type', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-C', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'disconnect')").run(cpId);
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'status_error')").run(cpId);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events?event_type=disconnect');
    expect(res.status).toBe(200);
    expect(res.body.every(e => e.event_type === 'disconnect')).toBe(true);
  });

  it('rejette un event_type invalide avec 400', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events?event_type=invalid_type');
    expect(res.status).toBe(400);
  });

  it('rejette un chargepoint_id non entier avec 400', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events?chargepoint_id=abc');
    expect(res.status).toBe(400);
  });

  it('respecte le paramètre limit', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-D', 'Available')").run().lastInsertRowid;
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'disconnect')").run(cpId);
    }
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/error-events?chargepoint_id=${cpId}&limit=3`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
  });

  it('retourne tous les événements avec limit=all', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-ALL', 'Available')").run().lastInsertRowid;
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'disconnect')").run(cpId);
    }
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/error-events?chargepoint_id=${cpId}&limit=all`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(5);
  });

  it('filtre par ocpp_version', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-E', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'status_error')").run(cpId);
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '2.0.1', 'status_error')").run(cpId);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/error-events?chargepoint_id=${cpId}&ocpp_version=2.0.1`);
    expect(res.status).toBe(200);
    expect(res.body.every(e => e.ocpp_version === '2.0.1')).toBe(true);
  });

  it('retourne site_name dans les événements', async () => {
    const siteId = db.prepare("INSERT INTO sites (sname) VALUES ('Site Alpha')").run().lastInsertRowid;
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus, site_id) VALUES ('EE-CP-F', 'Available', ?)").run(siteId).lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'disconnect')").run(cpId);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events');
    expect(res.status).toBe(200);
    const e = res.body.find(x => x.chargepoint_id === cpId);
    expect(e).toBeDefined();
    expect(e.site_name).toBe('Site Alpha');
    expect(e.site_id).toBe(siteId);
  });

  it('filtre par site_id', async () => {
    const site1 = db.prepare("INSERT INTO sites (sname) VALUES ('Site Beta')").run().lastInsertRowid;
    const site2 = db.prepare("INSERT INTO sites (sname) VALUES ('Site Gamma')").run().lastInsertRowid;
    const cp1 = db.prepare("INSERT INTO chargepoints (identity, cpstatus, site_id) VALUES ('EE-CP-G', 'Available', ?)").run(site1).lastInsertRowid;
    const cp2 = db.prepare("INSERT INTO chargepoints (identity, cpstatus, site_id) VALUES ('EE-CP-H', 'Available', ?)").run(site2).lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'status_error')").run(cp1);
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '1.6', 'status_error')").run(cp2);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/error-events?site_id=${site1}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.every(e => e.site_id === site1)).toBe(true);
  });

  it('rejette un site_id non entier avec 400', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/error-events?site_id=abc');
    expect(res.status).toBe(400);
  });
});
