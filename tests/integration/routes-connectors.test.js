'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const Database = require('better-sqlite3');
const { checkSchema, validationResult, matchedData } = require('express-validator');
const { initNewDatabase } = require('../../src/migrator');
const schema = require('../../src/validationSchema');

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

  const hash = bcrypt.hashSync('Admin!123', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', hash, 'admin', 'Admin');

  const managerHash = bcrypt.hashSync('Manager!123', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('manager@test.com', managerHash, 'user', 'Manager');

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
      return done(null, { id: user.id, useremail: user.useremail, role: user.role });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? { id: u.id, useremail: u.useremail, role: u.role } : false);
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

  // PUT /api/connectors/:id — mirrors src/routes.js logic with testDb
  app.put('/api/connectors/:id', ...checkSchema({ ...schema.IdParam, ...schema.ConnectorDetails }), (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });

    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);

    const cp = testDb
      .prepare(
        `SELECT cn.*, cp.site_id FROM connectors cn
         JOIN chargepoints cp ON cp.id = cn.chargepoint_id
         WHERE cn.id = ?`
      )
      .get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CONNECTOR_NOT_FOUND' });

    if (req.user.role !== 'admin') {
      const managed = testDb
        .prepare('SELECT site_id FROM user_sites WHERE user_id = ? AND authorized = 1')
        .all(req.user.id)
        .map((r) => r.site_id);
      if (!managed.includes(cp.site_id)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }

    const { connector_name, connector_power, connector_type } = data;
    const existing = testDb.prepare('SELECT * FROM connectors WHERE id = ?').get(Number(req.params.id));

    const newName =
      connector_name !== undefined
        ? connector_name.trim() === ''
          ? null
          : connector_name
        : existing.connector_name;
    const newPower =
      connector_power !== undefined
        ? connector_power === '' || connector_power === null
          ? null
          : parseInt(connector_power, 10)
        : existing.connector_power;
    const newType = connector_type !== undefined ? connector_type : existing.connector_type;

    testDb
      .prepare(
        `UPDATE connectors SET connector_name = ?, connector_power = ?, connector_type = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(newName, newPower, newType, Number(req.params.id));

    res.json(testDb.prepare('SELECT * FROM connectors WHERE id = ?').get(Number(req.params.id)));
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

function insertConnector(db, { name = 'Initial', power = 7, type = 'Type2' } = {}) {
  db.prepare("INSERT INTO chargepoints (identity, cpname, password) VALUES ('CP001', 'Test CP', 'pass')").run();
  const cp = db.prepare("SELECT id, site_id FROM chargepoints WHERE identity = 'CP001'").get();
  db.prepare(
    'INSERT INTO connectors (chargepoint_id, connector_id, connector_name, connector_power, connector_type) VALUES (?,?,?,?,?)'
  ).run(cp.id, 1, name, power, type);
  const cn = db.prepare('SELECT id FROM connectors WHERE chargepoint_id = ?').get(cp.id);
  return { connectorId: cn.id, cpSiteId: cp.site_id };
}

describe('PUT /api/connectors/:id', () => {
  it('returns 401 if not authenticated', async () => {
    const { connectorId } = insertConnector(db);
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const csrf = decodeURIComponent(
      ((meRes.headers['set-cookie'] || []).join('; ').match(/XSRF-TOKEN=([^;]+)/) || [])[1] || ''
    );
    const res = await agent
      .put(`/api/connectors/${connectorId}`)
      .set('x-xsrf-token', csrf)
      .send({ connector_name: 'X', connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown connector', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .put('/api/connectors/9999')
      .set('x-xsrf-token', csrf)
      .send({ connector_name: 'X', connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_CONNECTOR_NOT_FOUND');
  });

  it('returns 403 if manager has no access to the site', async () => {
    const { connectorId } = insertConnector(db);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'manager@test.com', 'Manager!123');
    const res = await agent
      .put(`/api/connectors/${connectorId}`)
      .set('x-xsrf-token', csrf)
      .send({ connector_name: 'X', connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ERR_SITE_NOT_MANAGED');
  });

  it('returns 400 when connector_name has forbidden characters', async () => {
    const { connectorId } = insertConnector(db);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .put(`/api/connectors/${connectorId}`)
      .set('x-xsrf-token', csrf)
      .send({ connector_name: 'Borne@!', connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('VALIDATION_CONNECTOR_NAME');
  });

  it('returns 200 and saves name when connector_name is provided', async () => {
    const { connectorId } = insertConnector(db);
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .put(`/api/connectors/${connectorId}`)
      .set('x-xsrf-token', csrf)
      .send({ connector_name: 'Borne B', connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(200);
    expect(res.body.connector_name).toBe('Borne B');
  });

  it('returns 200 and clears name when connector_name is empty string', async () => {
    const { connectorId } = insertConnector(db, { name: 'Borne A' });
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .put(`/api/connectors/${connectorId}`)
      .set('x-xsrf-token', csrf)
      .send({ connector_name: '', connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(200);
    expect(res.body.connector_name).toBeNull();
  });

  it('returns 200 and preserves existing name when connector_name is absent', async () => {
    const { connectorId } = insertConnector(db, { name: 'Borne A' });
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent
      .put(`/api/connectors/${connectorId}`)
      .set('x-xsrf-token', csrf)
      .send({ connector_power: 22, connector_type: 'Type2' });
    expect(res.status).toBe(200);
    expect(res.body.connector_name).toBe('Borne A');
  });
});
