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

// createApp() reçoit un objet `config` mutable partagé avec le test, pour simuler
// la présence/absence de `ocpp.wss.rootCaFile` sans recréer toute l'app.
function createApp(config) {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  initNewDatabase(testDb);

  const adminHash = bcrypt.hashSync('Admin!123', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('admin@test.com', adminHash, 'admin', 'Admin');

  const managerHash = bcrypt.hashSync('Manager!123', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('manager@test.com', managerHash, 'user', 'Manager');
  const managerId = testDb.prepare("SELECT id FROM users WHERE useremail = 'manager@test.com'").get().id;

  const userHash = bcrypt.hashSync('User!1234', 4);
  testDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run('user@test.com', userHash, 'user', 'RegularUser');

  const siteA = testDb.prepare("INSERT INTO sites (sname) VALUES ('Site A')").run().lastInsertRowid;
  testDb.prepare('INSERT INTO user_sites (user_id, site_id, role) VALUES (?, ?, ?)').run(managerId, siteA, 'manager');

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

  // GET /api/wss-root-ca — mirrors src/routes.js logic (ressource globale, requireManager)
  app.get('/api/wss-root-ca', requireManager, (req, res) => {
    const rootCaFile = config.ocpp?.wss?.rootCaFile;
    if (!rootCaFile) {
      return res.status(404).json({ error: 'ERR_ROOT_CA_NOT_CONFIGURED' });
    }
    const rootCaPath = path.resolve(config.configDir, rootCaFile);
    if (!fs.existsSync(rootCaPath)) {
      return res.status(404).json({ error: 'ERR_ROOT_CA_NOT_CONFIGURED' });
    }
    res.download(rootCaPath, 'ocpp-wss-root-ca.crt');
  });

  return { app, db: testDb };
}

async function loginAs(agent, useremail, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookie = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : '';
  await agent.post('/api/auth/login').set(CSRF_HEADER, csrf).send({ useremail, password });
  return csrf;
}

describe('GET /api/wss-root-ca', () => {
  let tmpDir;
  let rootCaPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-wss-root-ca-'));
    rootCaPath = path.join(tmpDir, 'root-ca.crt');
    fs.writeFileSync(rootCaPath, '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retourne 401 si non authentifié', async () => {
    const config = { configDir: tmpDir, ocpp: { wss: { rootCaFile: 'root-ca.crt' } } };
    const { app } = createApp(config);
    const res = await request(app).get('/api/wss-root-ca');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur sans rôle manager', async () => {
    const config = { configDir: tmpDir, ocpp: { wss: { rootCaFile: 'root-ca.crt' } } };
    const { app } = createApp(config);
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/wss-root-ca');
    expect(res.status).toBe(403);
  });

  it("retourne 404 ERR_ROOT_CA_NOT_CONFIGURED si rootCaFile n'est pas configuré", async () => {
    const config = { configDir: tmpDir, ocpp: { wss: {} } };
    const { app } = createApp(config);
    const agent = request.agent(app);
    await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.get('/api/wss-root-ca');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_ROOT_CA_NOT_CONFIGURED');
  });

  it("retourne 404 ERR_ROOT_CA_NOT_CONFIGURED si le fichier configuré n'existe pas", async () => {
    const config = { configDir: tmpDir, ocpp: { wss: { rootCaFile: 'missing.crt' } } };
    const { app } = createApp(config);
    const agent = request.agent(app);
    await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.get('/api/wss-root-ca');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_ROOT_CA_NOT_CONFIGURED');
  });

  it('retourne le certificat téléchargeable pour un manager de site (pas admin)', async () => {
    const config = { configDir: tmpDir, ocpp: { wss: { rootCaFile: 'root-ca.crt' } } };
    const { app } = createApp(config);
    const agent = request.agent(app);
    await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.get('/api/wss-root-ca');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/ocpp-wss-root-ca\.crt/);
    expect(res.text).toContain('FAKE');
  });

  it('retourne le certificat téléchargeable pour un admin', async () => {
    const config = { configDir: tmpDir, ocpp: { wss: { rootCaFile: 'root-ca.crt' } } };
    const { app } = createApp(config);
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/wss-root-ca');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });
});
