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

const EXPIRY = '2030-06-01T10:00:00Z';

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function createApp(options = {}) {
  const {
    callClient = jest.fn().mockResolvedValue({ status: 'Accepted' }),
    isConnected = true,
    ocppVersion = '1.6',
  } = options;

  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  initNewDatabase(testDb);

  const hash = bcrypt.hashSync('Admin!123', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', hash, 'admin', 'Admin');
  const adminUser = testDb.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();

  testDb
    .prepare('INSERT INTO chargepoints (identity, cpname, mode, authorized, feat_reservation, ocpp_version) VALUES (?,?,?,?,?,?)')
    .run('CP001', 'Test CP', 1, 1, 1, ocppVersion);
  const cp = testDb.prepare("SELECT * FROM chargepoints WHERE identity = 'CP001'").get();

  const connectedClients = isConnected ? new Map([['CP001', {}]]) : new Map();

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
      return done(null, { id: user.id, useremail: user.useremail, role: user.role, sites: [] });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? { id: u.id, useremail: u.useremail, role: u.role, sites: [] } : false);
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

  function getNextReservationId(chargepointId) {
    const row = testDb
      .prepare(
        "SELECT MAX(reservation_id) AS max_id FROM reservations WHERE chargepoint_id = ? AND status NOT IN ('Cancelled','Expired','Fulfilled')"
      )
      .get(chargepointId);
    return (row?.max_id ?? 0) + 1;
  }

  // GET — list reservations
  app.get('/api/chargepoints/:id/reservations', requireManager, (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    const rows = testDb
      .prepare(
        `SELECT r.*, u.shortname AS created_by_name, e.evse_name, cn.connector_name
         FROM reservations r
         LEFT JOIN users u ON r.created_by = u.id
         LEFT JOIN evses e ON e.chargepoint_id = r.chargepoint_id AND e.evse_id = r.evse_id
         LEFT JOIN connectors cn ON cn.chargepoint_id = r.chargepoint_id AND cn.connector_id = r.connector_id AND cn.evse_id IS r.evse_id
         WHERE r.chargepoint_id = ?
         ORDER BY r.created_at DESC`
      )
      .all(found.id);
    res.json(rows);
  });

  // POST — create reservation
  app.post('/api/chargepoints/:id/reservations', requireManager, async (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    if (!found.feat_reservation) return res.status(400).json({ error: 'ERR_RESERVATION_NOT_SUPPORTED' });
    if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const { connector_id, id_tag, expiry_date } = req.body;
    if (!connector_id || connector_id < 1 || !id_tag || !expiry_date) {
      return res.status(400).json({ error: 'VALIDATION_ERROR' });
    }

    const reservation_id = getNextReservationId(found.id);
    try {
      const result = await callClient(found.identity, 'ReserveNow', {
        connectorId: connector_id,
        expiryDate: expiry_date,
        idTag: id_tag,
        reservationId: reservation_id,
      });
      const status = result?.status ?? 'Rejected';
      if (status !== 'Accepted') return res.status(422).json({ status });
      const info = testDb
        .prepare(
          'INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, created_by) VALUES (?,?,?,?,?,?)'
        )
        .run(found.id, connector_id, reservation_id, id_tag, expiry_date, req.user.id);
      res.status(201).json({ status, id: info.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
    }
  });

  // DELETE — cancel reservation
  app.delete('/api/reservations/:reservationId', requireManager, async (req, res) => {
    const reservationId = Number(req.params.reservationId);
    const reservation = testDb.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    if (!reservation) return res.status(404).json({ error: 'ERR_RESERVATION_NOT_FOUND' });
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(reservation.chargepoint_id);
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    try {
      const result = await callClient(found.identity, 'CancelReservation', {
        reservationId: reservation.reservation_id,
      });
      const status = result?.status ?? 'Rejected';
      if (status === 'Accepted') {
        testDb.prepare("UPDATE reservations SET status = 'Cancelled' WHERE id = ?").run(reservationId);
      }
      res.json({ status });
    } catch (e) {
      res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
    }
  });

  return { app, db: testDb, cp, adminUser };
}

async function loginAs(agent) {
  const meRes = await agent.get('/api/auth/me');
  const cookie = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : '';
  await agent.post('/api/auth/login').set(CSRF_HEADER, csrf).send({ useremail: 'admin@test.com', password: 'Admin!123' });
  return csrf;
}

// ══════════════════════════════════════════════════════
//  GET /chargepoints/:id/reservations
// ══════════════════════════════════════════════════════
describe('GET /api/chargepoints/:id/reservations', () => {
  it('retourne 401 si non authentifié', async () => {
    const { app, cp } = createApp();
    const res = await request(app).get(`/api/chargepoints/${cp.id}/reservations`);
    expect(res.status).toBe(401);
  });

  it('retourne 404 si borne inconnue', async () => {
    const { app } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get('/api/chargepoints/9999/reservations').set(CSRF_HEADER, csrf);
    expect(res.status).toBe(404);
  });

  it('retourne un tableau vide si aucune réservation', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retourne les réservations existantes avec created_by_name', async () => {
    const { app, db, cp, adminUser } = createApp();
    db.prepare(
      'INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, created_by) VALUES (?,?,?,?,?,?)'
    ).run(cp.id, 1, 1, 'TAG001', EXPIRY, adminUser.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id_tag).toBe('TAG001');
    expect(res.body[0].status).toBe('Pending');
    expect(res.body[0].created_by_name).toBe('Admin');
  });

  it('retourne connector_name via JOIN pour borne OCPP 1.6', async () => {
    const { app, db, cp, adminUser } = createApp();
    db.prepare(
      'INSERT INTO connectors (chargepoint_id, connector_id, connector_name) VALUES (?,?,?)'
    ).run(cp.id, 1, 'AC Type 2');
    db.prepare(
      'INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, created_by) VALUES (?,?,?,?,?,?)'
    ).run(cp.id, 1, 1, 'TAG001', EXPIRY, adminUser.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body[0].connector_id).toBe(1);
    expect(res.body[0].connector_name).toBe('AC Type 2');
    expect(res.body[0].evse_name).toBeNull();
  });

  it('retourne evse_name via JOIN pour borne OCPP 2.0.1', async () => {
    const { app, db, cp, adminUser } = createApp({ ocppVersion: '2.0.1' });
    db.prepare(
      'INSERT INTO evses (chargepoint_id, evse_id, evse_name) VALUES (?,?,?)'
    ).run(cp.id, 1, 'EVSE Principal');
    db.prepare(
      'INSERT INTO reservations (chargepoint_id, evse_id, reservation_id, id_tag, expiry_date, created_by) VALUES (?,?,?,?,?,?)'
    ).run(cp.id, 1, 1, 'TAG001', EXPIRY, adminUser.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body[0].evse_id).toBe(1);
    expect(res.body[0].evse_name).toBe('EVSE Principal');
    expect(res.body[0].connector_id).toBeNull();
    expect(res.body[0].connector_name).toBeNull();
  });
});

// ══════════════════════════════════════════════════════
//  POST /chargepoints/:id/reservations
// ══════════════════════════════════════════════════════
describe('POST /api/chargepoints/:id/reservations', () => {
  const VALID_BODY = { connector_id: 1, id_tag: 'TAG001', expiry_date: EXPIRY };

  it('retourne 401 si non authentifié', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('retourne 400 si feat_reservation désactivé sur la borne', async () => {
    const { app, db, cp } = createApp();
    db.prepare('UPDATE chargepoints SET feat_reservation = 0 WHERE id = ?').run(cp.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_RESERVATION_NOT_SUPPORTED');
  });

  it('retourne 400 si la borne est hors ligne', async () => {
    const { app, cp } = createApp({ isConnected: false });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });

  it('crée la réservation et retourne 201 si la borne accepte', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('Accepted');
    expect(typeof res.body.id).toBe('number');

    expect(callClient).toHaveBeenCalledWith('CP001', 'ReserveNow', expect.objectContaining({
      connectorId: 1,
      idTag: 'TAG001',
      expiryDate: EXPIRY,
      reservationId: 1,
    }));

    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(res.body.id);
    expect(row).toBeDefined();
    expect(row.status).toBe('Pending');
    expect(row.connector_id).toBe(1);
    expect(row.reservation_id).toBe(1);
  });

  it('retourne 422 sans créer de réservation si la borne refuse', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('Rejected');
    expect(db.prepare('SELECT * FROM reservations WHERE chargepoint_id = ?').all(cp.id).length).toBe(0);
  });

  it('le reservation_id s\'incrémente à chaque réservation active', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent.post(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf).send({ connector_id: 1, id_tag: 'TAG001', expiry_date: EXPIRY });
    const res2 = await agent.post(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf).send({ connector_id: 2, id_tag: 'TAG002', expiry_date: EXPIRY });

    const row2 = db.prepare('SELECT * FROM reservations WHERE id = ?').get(res2.body.id);
    expect(row2.reservation_id).toBe(2);
  });

  it("le reservation_id ne réutilise pas l'id d'une réservation InUse", async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp, adminUser } = createApp({ callClient });
    db.prepare(
      "INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, status, created_by) VALUES (?,?,?,?,?,?,?)"
    ).run(cp.id, 1, 1, 'TAG001', EXPIRY, 'InUse', adminUser.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send({ connector_id: 2, id_tag: 'TAG002', expiry_date: EXPIRY });

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(res.body.id);
    expect(row.reservation_id).toBe(2);
  });

  it("le reservation_id peut réutiliser l'id d'une réservation Fulfilled", async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp, adminUser } = createApp({ callClient });
    db.prepare(
      "INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, status, created_by) VALUES (?,?,?,?,?,?,?)"
    ).run(cp.id, 1, 1, 'TAG001', EXPIRY, 'Fulfilled', adminUser.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send({ connector_id: 2, id_tag: 'TAG002', expiry_date: EXPIRY });

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(res.body.id);
    expect(row.reservation_id).toBe(1);
  });
});

// ══════════════════════════════════════════════════════
//  DELETE /reservations/:reservationId
// ══════════════════════════════════════════════════════
describe('DELETE /api/reservations/:reservationId', () => {
  function insertReservation(db, cpId, adminId, opts = {}) {
    const info = db
      .prepare(
        'INSERT INTO reservations (chargepoint_id, connector_id, reservation_id, id_tag, expiry_date, status, created_by) VALUES (?,?,?,?,?,?,?)'
      )
      .run(cpId, opts.connector_id ?? 1, opts.reservation_id ?? 1, opts.id_tag ?? 'TAG001', EXPIRY, opts.status ?? 'Pending', adminId);
    return info.lastInsertRowid;
  }

  it('retourne 401 si non authentifié', async () => {
    const { app, db, cp, adminUser } = createApp();
    const id = insertReservation(db, cp.id, adminUser.id);
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent.delete(`/api/reservations/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(401);
  });

  it('retourne 404 si réservation inconnue', async () => {
    const { app } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.delete('/api/reservations/9999').set(CSRF_HEADER, csrf);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_RESERVATION_NOT_FOUND');
  });

  it('retourne 400 si la borne est hors ligne', async () => {
    const { app, db, cp, adminUser } = createApp({ isConnected: false });
    const id = insertReservation(db, cp.id, adminUser.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.delete(`/api/reservations/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });

  it('annule la réservation en DB si la borne accepte', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp, adminUser } = createApp({ callClient });
    const id = insertReservation(db, cp.id, adminUser.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/reservations/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Accepted');

    expect(callClient).toHaveBeenCalledWith('CP001', 'CancelReservation', { reservationId: 1 });

    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    expect(row.status).toBe('Cancelled');
  });

  it('conserve le statut d\'origine si la borne refuse', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp, adminUser } = createApp({ callClient });
    const id = insertReservation(db, cp.id, adminUser.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/reservations/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');

    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    expect(row.status).toBe('Pending');
  });

  it('retourne 500 si callClient lève une erreur', async () => {
    const callClient = jest.fn().mockRejectedValue(new Error('timeout'));
    const { app, db, cp, adminUser } = createApp({ callClient });
    const id = insertReservation(db, cp.id, adminUser.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/reservations/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(500);

    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    expect(row.status).toBe('Pending');
  });

  it('conserve le statut InUse si la borne refuse l\'annulation', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp, adminUser } = createApp({ callClient });
    const id = insertReservation(db, cp.id, adminUser.id, { status: 'InUse' });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/reservations/${id}`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');

    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    expect(row.status).toBe('InUse');
  });
});

// ══════════════════════════════════════════════════════
//  POST /chargepoints/:id/reservations — OCPP 2.0.1
// ══════════════════════════════════════════════════════
describe('POST /api/chargepoints/:id/reservations — OCPP 2.0.1', () => {
  function createApp201(options = {}) {
    const { callClient = jest.fn().mockResolvedValue({ status: 'Accepted' }) } = options;

    const testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    initNewDatabase(testDb);

    const hash = bcrypt.hashSync('Admin!123', 4);
    testDb
      .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
      .run('admin@test.com', hash, 'admin', 'Admin');

    testDb
      .prepare(
        "INSERT INTO chargepoints (identity, cpname, mode, authorized, feat_reservation, ocpp_version) VALUES (?,?,?,?,?,?)"
      )
      .run('CP201', 'Test CP 201', 1, 1, 1, '2.0.1');
    const cp = testDb.prepare("SELECT * FROM chargepoints WHERE identity = 'CP201'").get();

    const connectedClients = new Map([['CP201', {}]]);

    const testPassport = new passport.Passport();
    testPassport.use(
      new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
        const user = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
        if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
        return done(null, { id: user.id, useremail: user.useremail, role: user.role, sites: [] });
      })
    );
    testPassport.serializeUser((u, done) => done(null, u.id));
    testPassport.deserializeUser((id, done) => {
      const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
      done(null, u ? { id: u.id, useremail: u.useremail, role: u.role, sites: [] } : false);
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

    app.post('/api/chargepoints/:id/reservations', requireManager, async (req, res) => {
      const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
      if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
      if (!found.feat_reservation) return res.status(400).json({ error: 'ERR_RESERVATION_NOT_SUPPORTED' });
      if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

      const { connector_id, id_tag, expiry_date } = req.body;
      const row = testDb
        .prepare(
          "SELECT MAX(reservation_id) AS max_id FROM reservations WHERE chargepoint_id = ? AND status NOT IN ('Cancelled','Expired','Fulfilled')"
        )
        .get(found.id);
      const reservation_id = (row?.max_id ?? 0) + 1;

      try {
        let result;
        if (found.ocpp_version === '2.0.1') {
          result = await callClient(found.identity, 'ReserveNow', {
            id: reservation_id,
            expiryDateTime: expiry_date,
            idToken: { idToken: id_tag, type: 'ISO14443' },
            evseId: connector_id,
          });
        } else {
          result = await callClient(found.identity, 'ReserveNow', {
            connectorId: connector_id,
            expiryDate: expiry_date,
            idTag: id_tag,
            reservationId: reservation_id,
          });
        }
        const status = result?.status ?? 'Rejected';
        if (status !== 'Accepted') return res.status(422).json({ status });
        const info = testDb.prepare(
          'INSERT INTO reservations (chargepoint_id, connector_id, evse_id, reservation_id, id_tag, expiry_date, created_by) VALUES (?,?,?,?,?,?,?)'
        ).run(
          found.id,
          found.ocpp_version === '2.0.1' ? null : connector_id,
          found.ocpp_version === '2.0.1' ? connector_id : null,
          reservation_id,
          id_tag,
          expiry_date,
          req.user.id
        );
        res.status(201).json({ status, id: info.lastInsertRowid });
      } catch (e) {
        res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
      }
    });

    return { app, db: testDb, cp };
  }

  const VALID_BODY = { connector_id: 1, id_tag: 'TAG001', expiry_date: EXPIRY };

  it('appelle ReserveNow avec idToken object et expiryDateTime pour borne 2.0.1', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp201({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(callClient).toHaveBeenCalledWith('CP201', 'ReserveNow', {
      id: 1,
      expiryDateTime: EXPIRY,
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evseId: 1,
    });
  });

  it('ne passe pas connectorId/idTag/reservationId dans le payload 2.0.1', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp201({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent.post(`/api/chargepoints/${cp.id}/reservations`).set(CSRF_HEADER, csrf).send(VALID_BODY);

    const [, , payload] = callClient.mock.calls[0];
    expect(payload.connectorId).toBeUndefined();
    expect(payload.idTag).toBeUndefined();
    expect(payload.reservationId).toBeUndefined();
    expect(payload.expiryDate).toBeUndefined();
  });

  it('stocke evse_id et connector_id=null en DB pour borne 2.0.1', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp } = createApp201({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(res.body.id);
    expect(row.evse_id).toBe(1);
    expect(row.connector_id).toBeNull();
  });

  it('retourne 422 sans créer de réservation si la borne refuse', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp } = createApp201({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/reservations`)
      .set(CSRF_HEADER, csrf)
      .send(VALID_BODY);

    expect(res.status).toBe(422);
    expect(db.prepare('SELECT * FROM reservations WHERE chargepoint_id = ?').all(cp.id).length).toBe(0);
  });
});
