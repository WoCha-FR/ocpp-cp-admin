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

let tmpDir;

// certAuthority.js utilise getConfig()/getConfigDir() — on les mocke pour pointer
// vers un dossier temporaire par test, comme pour tests/unit/certAuthority.test.js.
jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({ ocpp: { wss: { clientCa: {} } } })),
  getConfigDir: jest.fn(() => tmpDir),
}));

jest.mock('../../src/logger', () => ({
  scope: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const certAuthority = require('../../src/certAuthority');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function createApp() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initNewDatabase(db);

  const adminHash = bcrypt.hashSync('Admin!123', 4);
  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'admin@test.com', adminHash, 'admin', 'Admin'
  );
  const managerHash = bcrypt.hashSync('Manager!123', 4);
  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'manager@test.com', managerHash, 'user', 'Manager'
  );
  const managerId = db.prepare("SELECT id FROM users WHERE useremail = 'manager@test.com'").get().id;
  const siteA = db.prepare("INSERT INTO sites (sname) VALUES ('Site A')").run().lastInsertRowid;
  db.prepare('INSERT INTO user_sites (user_id, site_id, role) VALUES (?, ?, ?)').run(managerId, siteA, 'manager');

  function loadUser(row) {
    const sites = db.prepare('SELECT site_id, role FROM user_sites WHERE user_id = ?').all(row.id);
    return { id: row.id, useremail: row.useremail, role: row.role, sites };
  }

  const testPassport = new passport.Passport();
  testPassport.use(new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
    const u = db.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
    if (!u || !bcrypt.compareSync(pwd, u.password)) return done(null, false);
    return done(null, loadUser(u));
  }));
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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

  function requireRoleAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
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

  // Mirrors src/routes.js: POST/GET /chargepoints/:id/client-cert(/download) — admin uniquement
  app.post('/api/chargepoints/:id/client-cert', requireRoleAdmin, async (req, res) => {
    const cp = db.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    try {
      await certAuthority.generateClientCertificate(cp.identity);
      const clientCertExpiresAt = await certAuthority.getClientCertExpiry(cp.identity);
      res.json({ hasClientCert: true, clientCertExpiresAt });
    } catch (e) {
      if (e.message === 'ERR_OPENSSL_UNAVAILABLE') {
        return res.status(503).json({ error: 'ERR_OPENSSL_UNAVAILABLE' });
      }
      res.status(500).json({ error: 'ERR_INTERNAL' });
    }
  });

  app.get('/api/chargepoints/:id/client-cert/download', requireRoleAdmin, (req, res) => {
    const cp = db.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    const pem = certAuthority.getCombinedClientCertPem(cp.identity);
    if (!pem) return res.status(404).json({ error: 'ERR_CLIENT_CERT_NOT_FOUND' });
    res.setHeader('Content-Disposition', `attachment; filename="${cp.identity}-client.pem"`);
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.send(pem);
  });

  return { app, db };
}

async function loginAs(agent, useremail, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookie = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : '';
  await agent.post('/api/auth/login').set(CSRF_HEADER, csrf).send({ useremail, password });
  return csrf;
}

const opensslAvailable = (() => {
  try {
    require('child_process').execFileSync('openssl', ['version']);
    return true;
  } catch (e) {
    return false;
  }
})();
const itIfOpenssl = opensslAvailable ? it : it.skip;

describe('POST /api/chargepoints/:id/client-cert', () => {
  let app, db, cpId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpadmin-client-cert-'));
    certAuthority._resetOpensslCache();
    ({ app, db } = createApp());
    cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus, initialized) VALUES ('CP-CERT-TEST', 'Available', 1)")
      .run().lastInsertRowid;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retourne 401 si non authentifié', async () => {
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent.post(`/api/chargepoints/${cpId}/client-cert`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un manager de site (action réservée à l\'admin)', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.post(`/api/chargepoints/${cpId}/client-cert`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(403);
  });

  it('retourne 404 pour une borne inexistante', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.post('/api/chargepoints/9999/client-cert').set(CSRF_HEADER, csrf);
    expect(res.status).toBe(404);
  });

  itIfOpenssl('génère le certificat et permet ensuite son téléchargement (admin)', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');

    const genRes = await agent.post(`/api/chargepoints/${cpId}/client-cert`).set(CSRF_HEADER, csrf);
    expect(genRes.status).toBe(200);
    expect(genRes.body.hasClientCert).toBe(true);
    expect(genRes.body.clientCertExpiresAt).toBeTruthy();

    const dlRes = await agent.get(`/api/chargepoints/${cpId}/client-cert/download`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-disposition']).toMatch(/CP-CERT-TEST-client\.pem/);
    expect(dlRes.text).toContain('-----BEGIN CERTIFICATE-----');
    expect(dlRes.text).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it("retourne 404 au téléchargement si aucun certificat n'a été généré", async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/chargepoints/${cpId}/client-cert/download`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_CLIENT_CERT_NOT_FOUND');
  });

  it('retourne 403 pour un manager au téléchargement (réservé admin)', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent.get(`/api/chargepoints/${cpId}/client-cert/download`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(403);
  });
});
