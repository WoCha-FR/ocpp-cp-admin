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
  initNewDatabase(testDb);

  const adminHash = bcrypt.hashSync('Admin!123', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('admin@test.com', adminHash, 'admin', 'Admin');

  const userHash = bcrypt.hashSync('User!1234', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('user@test.com', userHash, 'user', 'RegularUser');

  const managerHash = bcrypt.hashSync('Manager!123', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('manager@test.com', managerHash, 'user', 'Manager');
  const managerId = testDb.prepare("SELECT id FROM users WHERE useremail = 'manager@test.com'").get().id;

  const siteA = testDb.prepare("INSERT INTO sites (sname) VALUES ('Site A')").run().lastInsertRowid;
  const siteB = testDb.prepare("INSERT INTO sites (sname) VALUES ('Site B')").run().lastInsertRowid;
  testDb.prepare('INSERT INTO user_sites (user_id, site_id, role) VALUES (?, ?, ?)').run(managerId, siteA, 'manager');

  testDb.prepare('INSERT INTO chargepoints (identity, cpname, site_id) VALUES (?,?,?)').run('CP-A', 'CP Site A', siteA);
  testDb.prepare('INSERT INTO chargepoints (identity, cpname, site_id) VALUES (?,?,?)').run('CP-B', 'CP Site B', siteB);
  const cpA = testDb.prepare("SELECT * FROM chargepoints WHERE identity = 'CP-A'").get();
  const cpB = testDb.prepare("SELECT * FROM chargepoints WHERE identity = 'CP-B'").get();

  function loadUser(row) {
    const sites = testDb.prepare('SELECT site_id, role FROM user_sites WHERE user_id = ?').all(row.id);
    return { id: row.id, useremail: row.useremail, role: row.role, sites };
  }

  const testPassport = new passport.Passport();
  testPassport.use(new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
    if (!u || !bcrypt.compareSync(pwd, u.password)) return done(null, false);
    return done(null, loadUser(u));
  }));
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? loadUser(u) : false);
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

  function getUserManagedSiteIds(req) {
    if (req.user.role === 'admin') return null;
    return (req.user.sites || []).filter((s) => s.role === 'manager').map((s) => s.site_id);
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
    if (event_type && !['status_error', 'disconnect', 'heartbeat_timeout', 'security_event', 'notify_event'].includes(event_type)) return res.status(400).json({ error: 'VALIDATION_EVENT_TYPE' });
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

  // DELETE — supprime un événement error_events
  app.delete('/api/error-events/:id', requireManager, (req, res) => {
    const id = Number(req.params.id);
    const existing = testDb.prepare(
      `SELECT ee.*, cp.site_id
       FROM error_events ee
       LEFT JOIN chargepoints cp ON cp.id = ee.chargepoint_id
       WHERE ee.id = ?`
    ).get(id);
    if (!existing) return res.status(404).json({ error: 'ERR_EVENT_NOT_FOUND' });
    if (req.user.role !== 'admin') {
      const managedSiteIds = getUserManagedSiteIds(req);
      if (managedSiteIds !== null && (!existing.site_id || !managedSiteIds.includes(existing.site_id))) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    testDb.prepare('DELETE FROM error_events WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return { app, db: testDb, cpA, cpB };
}

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookies = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : null;
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

function insertErrorEvent(db, cpId, eventType = 'disconnect') {
  const info = db.prepare(
    `INSERT INTO error_events (chargepoint_id, ocpp_version, event_type)
     VALUES (?, '1.6', ?)`
  ).run(cpId, eventType);
  return info.lastInsertRowid;
}

let app, db, cpA, cpB;

beforeEach(() => {
  ({ app, db, cpA, cpB } = createApp());
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

  it('filtre par event_type security_event / notify_event (OCPP 2.0.1)', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('EE-CP-201', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '2.0.1', 'security_event')").run(cpId);
    db.prepare("INSERT INTO error_events (chargepoint_id, ocpp_version, event_type) VALUES (?, '2.0.1', 'notify_event')").run(cpId);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');

    const secRes = await agent.get('/api/error-events?event_type=security_event');
    expect(secRes.status).toBe(200);
    expect(secRes.body.every(e => e.event_type === 'security_event')).toBe(true);

    const notifyRes = await agent.get('/api/error-events?event_type=notify_event');
    expect(notifyRes.status).toBe(200);
    expect(notifyRes.body.every(e => e.event_type === 'notify_event')).toBe(true);
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

// ══════════════════════════════════════════════════════
//  DELETE /api/error-events/:id
// ══════════════════════════════════════════════════════
describe('DELETE /api/error-events/:id', () => {
  it('retourne 401 si non authentifié', async () => {
    const id = insertErrorEvent(db, cpA.id);
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent.delete(`/api/error-events/${id}`).set('x-xsrf-token', csrf);
    expect(res.status).toBe(401);
  });

  it('retourne 404 + ERR_EVENT_NOT_FOUND si l\'id n\'existe pas', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.delete('/api/error-events/9999').set('x-xsrf-token', csrf);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_EVENT_NOT_FOUND');
  });

  it('retourne 403 + ERR_SITE_NOT_MANAGED si un manager supprime un événement d\'un site non géré', async () => {
    const id = insertErrorEvent(db, cpB.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.delete(`/api/error-events/${id}`).set('x-xsrf-token', csrf);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ERR_SITE_NOT_MANAGED');
    expect(db.prepare('SELECT * FROM error_events WHERE id = ?').get(id)).toBeDefined();
  });

  it('retourne 200 + { ok: true } pour un manager autorisé sur le site et supprime la ligne', async () => {
    const id = insertErrorEvent(db, cpA.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.delete(`/api/error-events/${id}`).set('x-xsrf-token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.prepare('SELECT * FROM error_events WHERE id = ?').get(id)).toBeUndefined();
  });

  it('retourne 200 pour un admin quel que soit le site et supprime la ligne', async () => {
    const id = insertErrorEvent(db, cpB.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.delete(`/api/error-events/${id}`).set('x-xsrf-token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.prepare('SELECT * FROM error_events WHERE id = ?').get(id)).toBeUndefined();
  });
});
