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

function readCsrfCookie(setCookieHeaders) {
  const cookies = (setCookieHeaders || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function createApp(connectedIdentities = new Set()) {
  const sqliteDb = new Database(':memory:');
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  initNewDatabase(sqliteDb);

  sqliteDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', bcrypt.hashSync('Admin!123', 4), 'admin', 'Admin');

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = sqliteDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
      return done(null, { id: user.id, useremail: user.useremail, role: user.role });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
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
      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.json(user);
      });
    })(req, res, next);
  });

  app.get('/api/dashboard', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });

    const connectors = sqliteDb
      .prepare(
        `SELECT c.cnstatus, c.error_code, cp.identity AS chargepoint_identity
         FROM connectors c
         JOIN chargepoints cp ON c.chargepoint_id = cp.id
         WHERE c.connector_id > 0`
      )
      .all();

    const connectorStats = {
      Available: 0, Preparing: 0, Charging: 0, SuspendedEV: 0,
      SuspendedEVSE: 0, Finishing: 0, Reserved: 0, Unavailable: 0,
      Faulted: 0, Offline: 0, WithError: 0,
    };

    connectors.forEach((c) => {
      const online = connectedIdentities.has(c.chargepoint_identity);
      if (!online) {
        connectorStats.Offline++;
      } else {
        if (c.cnstatus) {
          if (Object.prototype.hasOwnProperty.call(connectorStats, c.cnstatus)) connectorStats[c.cnstatus]++;
          else connectorStats[c.cnstatus] = 1;
        }
        if (c.error_code && c.error_code !== 'NoError') connectorStats.WithError++;
      }
    });

    res.json({ connectorStats, totalConnectors: connectors.length });
  });

  return { app, db: sqliteDb };
}

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const csrf = readCsrfCookie(meRes.headers['set-cookie']);
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

function insertChargepoint(db, identity, cnstatus = null) {
  const info = db
    .prepare("INSERT INTO chargepoints (identity, cpname, password) VALUES (?, ?, 'pass')")
    .run(identity, identity);
  const cpId = info.lastInsertRowid;
  db.prepare(
    'INSERT INTO connectors (chargepoint_id, connector_id, cnstatus) VALUES (?, 1, ?)'
  ).run(cpId, cnstatus);
  return cpId;
}

describe('GET /api/dashboard — connectorStats', () => {
  it('retourne 401 si non authentifié', async () => {
    const { app, db } = createApp();
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
    db.close();
  });

  it('ne crée pas de clé Unknown pour un connecteur en ligne avec cnstatus null', async () => {
    const connectedIdentities = new Set(['CP-ONLINE']);
    const { app, db } = createApp(connectedIdentities);
    insertChargepoint(db, 'CP-ONLINE', null);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.connectorStats).not.toHaveProperty('Unknown');
    expect(res.body.connectorStats).not.toHaveProperty('null');
    expect(res.body.connectorStats.Offline).toBe(0);
    db.close();
  });

  it('compte correctement un connecteur en ligne avec cnstatus Available', async () => {
    const connectedIdentities = new Set(['CP-AVAIL']);
    const { app, db } = createApp(connectedIdentities);
    insertChargepoint(db, 'CP-AVAIL', 'Available');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.connectorStats.Available).toBe(1);
    expect(res.body.connectorStats.Offline).toBe(0);
    db.close();
  });

  it('compte un connecteur hors ligne dans Offline, quelle que soit la valeur de cnstatus', async () => {
    const connectedIdentities = new Set();
    const { app, db } = createApp(connectedIdentities);
    insertChargepoint(db, 'CP-OFFLINE', 'Available');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.connectorStats.Offline).toBe(1);
    expect(res.body.connectorStats.Available).toBe(0);
    db.close();
  });

  it('gère correctement un mélange de connecteurs', async () => {
    const connectedIdentities = new Set(['CP-NULL', 'CP-AVAIL', 'CP-CHARGING']);
    const { app, db } = createApp(connectedIdentities);
    insertChargepoint(db, 'CP-NULL', null);
    insertChargepoint(db, 'CP-AVAIL', 'Available');
    insertChargepoint(db, 'CP-CHARGING', 'Charging');
    insertChargepoint(db, 'CP-OFFLINE', 'Available');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    const stats = res.body.connectorStats;
    expect(stats.Available).toBe(1);
    expect(stats.Charging).toBe(1);
    expect(stats.Offline).toBe(1);
    expect(stats).not.toHaveProperty('Unknown');
    expect(stats).not.toHaveProperty('null');
    expect(res.body.totalConnectors).toBe(4);
    db.close();
  });
});
