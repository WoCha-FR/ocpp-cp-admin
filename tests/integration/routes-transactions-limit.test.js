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
  const adminId = testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', adminHash, 'admin', 'Admin').lastInsertRowid;

  const userHash = bcrypt.hashSync('User!1234', 4);
  const userId = testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('user@test.com', userHash, 'user', 'UserOne').lastInsertRowid;

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const u = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!u || !bcrypt.compareSync(pwd, u.password)) return done(null, false);
      return done(null, { id: u.id, useremail: u.useremail, role: u.role, sites: [] });
    })
  );
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
    return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
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

  // Inline reimplementation de la logique limit/all pour /api/transactions
  app.get('/api/transactions', requireManager, (req, res) => {
    const { chargepoint_id, status, from, to, limit } = req.query;
    let query = `SELECT t.transaction_id, t.status, t.chargepoint_id
      FROM transactions t
      JOIN chargepoints cp ON t.chargepoint_id = cp.id
      WHERE 1=1`;
    const params = [];
    if (chargepoint_id) { query += ' AND t.chargepoint_id = ?'; params.push(Number(chargepoint_id)); }
    if (status) { query += ' AND t.status = ?'; params.push(status); }
    if (from) { query += ' AND t.start_time >= ?'; params.push(from); }
    if (to) { query += ' AND t.start_time <= ?'; params.push(to); }

    const countResult = testDb.prepare(`SELECT COUNT(*) as total FROM transactions t JOIN chargepoints cp ON t.chargepoint_id = cp.id WHERE 1=1`).get();

    const effectiveLimit = limit === 'all' ? 999999 : Math.min(Number(limit) || 50, 200);
    const rows = testDb.prepare(query + ' ORDER BY t.id DESC LIMIT ? OFFSET ?').all(...params, effectiveLimit, 0);

    res.json({ data: rows, total: countResult.total, stats: { totalEnergy: 0, activeCount: 0, totalMinutes: 0 } });
  });

  // Inline reimplementation de la logique limit/all pour /api/user/transactions
  app.get('/api/user/transactions', requireAuth, (req, res) => {
    const { status, from, to, limit } = req.query;
    const uid = req.user.id;
    let query = `SELECT t.transaction_id, t.status, t.chargepoint_id
      FROM transactions t
      JOIN chargepoints cp ON t.chargepoint_id = cp.id
      LEFT JOIN id_tags it ON it.id_tag = t.id_tag
      WHERE it.user_id = ?`;
    const params = [uid];
    if (status) { query += ' AND t.status = ?'; params.push(status); }
    if (from) { query += ' AND t.start_time >= ?'; params.push(from); }
    if (to) { query += ' AND t.start_time <= ?'; params.push(to); }

    const countResult = testDb.prepare(`SELECT COUNT(*) as total FROM transactions t JOIN id_tags it ON it.id_tag = t.id_tag WHERE it.user_id = ?`).get(uid);

    const effectiveLimit = limit === 'all' ? 999999 : Math.min(Number(limit) || 50, 200);
    const rows = testDb.prepare(query + ' ORDER BY t.id DESC LIMIT ? OFFSET ?').all(...params, effectiveLimit, 0);

    res.json({ data: rows, total: countResult.total, stats: { totalEnergy: 0, activeCount: 0, totalMinutes: 0 } });
  });

  app.get('/api/transactions/:transactionId', requireAuth, (req, res) => {
    const tx = testDb.prepare(`
      SELECT t.*, cp.identity as chargepoint_identity, cp.cpname as chargepoint_name,
        s.sname as site_name,
        CASE WHEN tv.id IS NOT NULL THEN 1 ELSE 0 END as has_values,
        cn.connector_name as connector_name
      FROM transactions t
      JOIN chargepoints cp ON t.chargepoint_id = cp.id
      LEFT JOIN sites s ON cp.site_id = s.id
      LEFT JOIN transactions_values tv ON t.transaction_id = tv.transaction_id
      LEFT JOIN connectors cn ON cn.chargepoint_id = t.chargepoint_id AND cn.connector_id = t.connector_id
      WHERE t.transaction_id = ?
    `).get(req.params.transactionId);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    res.json(tx);
  });

  return { app, db: testDb, adminId, userId };
}

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookies = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : null;
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

let app, db, adminId, userId;

beforeEach(() => {
  ({ app, db, adminId, userId } = createApp());
});

afterEach(() => {
  db.close();
});

describe('GET /api/transactions — paramètre limit', () => {
  function insertCpAndTxs(n) {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('LIMIT-TEST-CP', 'Available')")
      .run().lastInsertRowid;
    for (let i = 0; i < n; i++) {
      db.prepare(
        "INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, status) VALUES (?, ?, 1, 'Completed')"
      ).run(`TX-LIMIT-${i}`, cpId);
    }
    return cpId;
  }

  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(401);
  });

  it('respecte le paramètre limit numérique', async () => {
    insertCpAndTxs(5);
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/transactions?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  it('retourne toutes les transactions avec limit=all', async () => {
    insertCpAndTxs(5);
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/transactions?limit=all');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
  });

  it('retourne le total dans la réponse avec limit=all', async () => {
    insertCpAndTxs(3);
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/transactions?limit=all');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('stats');
  });
});

describe('GET /api/transactions/:transactionId', () => {
  function insertCpAndTx(txId) {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus, cpname) VALUES ('DETAIL-CP', 'Available', 'Borne Détail')")
      .run().lastInsertRowid;
    db.prepare(
      "INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, id_tag, meter_start, status) VALUES (?,?,1,'DETAIL-TAG',1000,'Completed')"
    ).run(txId, cpId);
    return cpId;
  }

  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/transactions/TX-DETAIL-1');
    expect(res.status).toBe(401);
  });

  it("retourne 404 pour un transaction_id inexistant", async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/transactions/TX-DOES-NOT-EXIST');
    expect(res.status).toBe(404);
  });

  it('retourne les métadonnées complètes de la transaction', async () => {
    insertCpAndTx('TX-DETAIL-1');
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/transactions/TX-DETAIL-1');
    expect(res.status).toBe(200);
    expect(res.body.transaction_id).toBe('TX-DETAIL-1');
    expect(res.body.chargepoint_name).toBe('Borne Détail');
    expect(res.body.id_tag).toBe('DETAIL-TAG');
    expect(res.body.meter_start).toBe(1000);
    expect(res.body).toHaveProperty('has_values');
    expect(res.body).toHaveProperty('site_name');
  });
});

describe('GET /api/user/transactions — paramètre limit', () => {
  function insertUserTxs(db, userId, n) {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('USER-LIMIT-CP', 'Available')")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO id_tags (id_tag, user_id) VALUES ('TAG-USER-LIMIT', ?)").run(userId);
    for (let i = 0; i < n; i++) {
      db.prepare(
        "INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, id_tag, status) VALUES (?, ?, 1, 'TAG-USER-LIMIT', 'Completed')"
      ).run(`UTX-LIMIT-${i}`, cpId);
    }
    return cpId;
  }

  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/user/transactions');
    expect(res.status).toBe(401);
  });

  it('respecte le paramètre limit numérique', async () => {
    insertUserTxs(db, userId, 5);
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/user/transactions?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  it('retourne toutes les transactions utilisateur avec limit=all', async () => {
    insertUserTxs(db, userId, 4);
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/user/transactions?limit=all');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(4);
  });
});
