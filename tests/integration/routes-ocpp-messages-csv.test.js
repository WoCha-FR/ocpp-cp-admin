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
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', adminHash, 'admin', 'Admin');

  const userHash = bcrypt.hashSync('User!1234', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('user@test.com', userHash, 'user', 'UserOne');

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

  // Route sous test — réimplémentation inline de GET /api/ocpp-messages/csv
  app.get('/api/ocpp-messages/csv', requireManager, (req, res) => {
    const { chargepoint_id, origin, message_type, action, date_from, date_to } = req.query;

    let query = `SELECT om.*, cp.identity AS chargepoint_identity
      FROM ocpp_messages om
      LEFT JOIN chargepoints cp ON cp.id = om.chargepoint_id
      WHERE 1=1`;
    const params = [];
    if (chargepoint_id) { query += ' AND om.chargepoint_id = ?'; params.push(Number(chargepoint_id)); }
    if (origin) { query += ' AND om.origin = ?'; params.push(origin); }
    if (message_type) { query += ' AND om.message_type = ?'; params.push(message_type); }
    const actions = action ? (Array.isArray(action) ? action : [action]) : [];
    if (actions.length > 0) {
      const conds = actions.map(() => 'UPPER(om.action) LIKE UPPER(?)').join(' OR ');
      query += ` AND (${conds})`;
      actions.forEach(a => params.push(`%${a}%`));
    }
    if (date_from) { query += ' AND om.timestamp >= ?'; params.push(date_from); }
    if (date_to) { query += ' AND om.timestamp <= ?'; params.push(date_to); }
    query += ' ORDER BY om.id DESC';

    const messages = testDb.prepare(query).all(...params);

    const headers = ['Horodatage', 'Borne', 'Origine', 'Type', 'Action', 'Payload JSON'];
    const csvRows = [headers.join(';')];
    for (const m of messages) {
      const row = [
        m.timestamp || '',
        m.chargepoint_identity || '',
        m.origin || '',
        m.message_type || '',
        m.action || '',
        m.payload || '',
      ].map((v) => `"${String(v).replace(/"/g, '""').replace(/;/g, ',')}"`);
      csvRows.push(row.join(';'));
    }

    const csv = '﻿' + csvRows.join('\r\n');
    const cpIdentity = chargepoint_id
      ? (messages[0]?.chargepoint_identity || chargepoint_id)
      : 'all';
    const filename = `logs-${cpIdentity}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
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

describe('GET /api/ocpp-messages/csv', () => {
  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/ocpp-messages/csv');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur simple (non manager)', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/ocpp-messages/csv');
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec Content-Type text/csv', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('la réponse commence par le BOM UTF-8', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.body[0]).toBe(0xEF);
    expect(res.body[1]).toBe(0xBB);
    expect(res.body[2]).toBe(0xBF);
  });

  it('la première ligne contient les en-têtes attendus', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv');
    const lines = res.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Horodatage;Borne;Origine;Type;Action;Payload JSON');
  });

  it('retourne uniquement la ligne d\'en-têtes quand il n\'y a pas de messages', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv');
    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('inclut les messages insérés dans le CSV', async () => {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-01', 'Available')")
      .run().lastInsertRowid;
    db.prepare(
      "INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload, timestamp) VALUES (?,?,?,?,?,?)"
    ).run(cpId, 'chargepoint', 'CALL', 'BootNotification', '{"reason":"PowerUp"}', '2024-01-01 10:00:00');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/ocpp-messages/csv?chargepoint_id=${cpId}`);

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"CSV-CP-01"');
    expect(lines[1]).toContain('"chargepoint"');
    expect(lines[1]).toContain('"CALL"');
    expect(lines[1]).toContain('"BootNotification"');
  });

  it('filtre par chargepoint_id', async () => {
    const cp1 = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-A', 'Available')").run().lastInsertRowid;
    const cp2 = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-B', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cp1, 'chargepoint', 'CALL', 'Heartbeat', '{}');
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cp2, 'csms', 'CALLRESULT', 'Heartbeat', '{}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/ocpp-messages/csv?chargepoint_id=${cp1}`);

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"CSV-CP-A"');
    expect(lines[1]).not.toContain('"CSV-CP-B"');
  });

  it('filtre par origin', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-O', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'BootNotification', '{}');
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'csms', 'CALLRESULT', 'BootNotification', '{}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv?origin=csms');

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"csms"');
    expect(lines[1]).not.toContain('"chargepoint"');
  });

  it('filtre par message_type', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-T', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'BootNotification', '{}');
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'csms', 'CALLRESULT', 'BootNotification', '{}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv?message_type=CALLRESULT');

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"CALLRESULT"');
  });

  it('filtre par action (partiel, insensible à la casse)', async () => {
    const cpId = db.prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-ACT', 'Available')").run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'BootNotification', '{}');
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'Heartbeat', '{}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/ocpp-messages/csv?action=bootnotif');

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"BootNotification"');
  });

  it('le Content-Disposition inclut l\'identity de la borne dans le nom de fichier', async () => {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('MY-CHARGER', 'Available')")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'Heartbeat', '{}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/ocpp-messages/csv?chargepoint_id=${cpId}`);

    expect(res.headers['content-disposition']).toMatch(/logs-MY-CHARGER-\d{4}-\d{2}-\d{2}\.csv/);
  });

  it('échappe les guillemets doubles dans le payload', async () => {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-QUOT', 'Available')")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'BootNotification', '{"key":"val\"ue"}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/ocpp-messages/csv?chargepoint_id=${cpId}`);

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[1]).toContain('""');
  });

  it('remplace les points-virgules dans le payload par des virgules', async () => {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-CP-SEMI', 'Available')")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL', 'DataTransfer', 'val1;val2');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/ocpp-messages/csv?chargepoint_id=${cpId}`);

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[1]).not.toContain('val1;val2');
    expect(lines[1]).toContain('val1,val2');
  });

  it('filtre par plusieurs actions via multi-params', async () => {
    const cpId = db
      .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('CSV-MULTI-01', 'Available')")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL',      'Heartbeat',          '{}');
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'chargepoint', 'CALL',      'BootNotification',   '{}');
    db.prepare("INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?,?,?,?,?)")
      .run(cpId, 'csms',        'CALLRESULT', 'StatusNotification', '{}');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/ocpp-messages/csv?chargepoint_id=${cpId}&action=Heartbeat&action=BootNotification`);

    const lines = res.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines.length).toBe(3); // 1 entête + 2 messages
    expect(lines.some(l => l.includes('"Heartbeat"'))).toBe(true);
    expect(lines.some(l => l.includes('"BootNotification"'))).toBe(true);
    expect(lines.some(l => l.includes('"StatusNotification"'))).toBe(false);
  });
});
