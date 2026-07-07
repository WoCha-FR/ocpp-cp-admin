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
  app.use(session({ secret: 'test-secret!!', resave: false, saveUninitialized: false }));
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

  // DELETE — supprime un événement id-tags-events
  app.delete('/api/id-tags-events/:id', requireManager, (req, res) => {
    const id = Number(req.params.id);
    const existing = testDb.prepare(
      `SELECT ite.*, cp.site_id
       FROM id_tags_events ite
       LEFT JOIN chargepoints cp ON cp.id = ite.chargepoint_id
       WHERE ite.id = ?`
    ).get(id);
    if (!existing) return res.status(404).json({ error: 'ERR_EVENT_NOT_FOUND' });
    if (req.user.role !== 'admin') {
      const managedSiteIds = getUserManagedSiteIds(req);
      if (managedSiteIds !== null && (!existing.site_id || !managedSiteIds.includes(existing.site_id))) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    testDb.prepare('DELETE FROM id_tags_events WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return { app, db: testDb, cpA, cpB };
}

async function loginAs(agent, useremail, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookie = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : '';
  await agent.post('/api/auth/login').set(CSRF_HEADER, csrf).send({ useremail, password });
  return csrf;
}

function insertEvent(db, cpId, idTag = 'TAGEVT') {
  const info = db.prepare(
    `INSERT INTO id_tags_events (chargepoint_id, connector_id, id_tag, status, reason, source)
     VALUES (?, 1, ?, 'Blocked', 'expired', 'authorize')`
  ).run(cpId, idTag);
  return info.lastInsertRowid;
}

// ══════════════════════════════════════════════════════
//  DELETE /api/id-tags-events/:id
// ══════════════════════════════════════════════════════
describe('DELETE /api/id-tags-events/:id', () => {
  it('retourne 401 si non authentifié', async () => {
    const { app, db, cpA } = createApp();
    const id = insertEvent(db, cpA.id);
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent.delete(`/api/id-tags-events/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(401);
  });

  it('retourne 404 + ERR_EVENT_NOT_FOUND si l\'id n\'existe pas', async () => {
    const { app } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.delete('/api/id-tags-events/9999').set(CSRF_HEADER, csrf);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_EVENT_NOT_FOUND');
  });

  it('retourne 403 + ERR_SITE_NOT_MANAGED si un manager supprime un événement d\'un site non géré', async () => {
    const { app, db, cpB } = createApp();
    const id = insertEvent(db, cpB.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.delete(`/api/id-tags-events/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ERR_SITE_NOT_MANAGED');
    expect(db.prepare('SELECT * FROM id_tags_events WHERE id = ?').get(id)).toBeDefined();
  });

  it('retourne 200 + { ok: true } pour un manager autorisé sur le site et supprime la ligne', async () => {
    const { app, db, cpA } = createApp();
    const id = insertEvent(db, cpA.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.delete(`/api/id-tags-events/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.prepare('SELECT * FROM id_tags_events WHERE id = ?').get(id)).toBeUndefined();
  });

  it('retourne 200 pour un admin quel que soit le site et supprime la ligne', async () => {
    const { app, db, cpB } = createApp();
    const id = insertEvent(db, cpB.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.delete(`/api/id-tags-events/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.prepare('SELECT * FROM id_tags_events WHERE id = ?').get(id)).toBeUndefined();
  });
});
