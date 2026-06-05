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

const BASE_PROFILE = {
  connector_id: 0,
  stack_level: 0,
  profile_purpose: 'ChargePointMaxProfile',
  profile_kind: 'Absolute',
  charging_rate_unit: 'W',
  schedule_periods: [{ startPeriod: 0, limit: 11000 }],
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function createApp(options = {}) {
  const { callClient = jest.fn().mockResolvedValue({ status: 'Accepted' }), isConnected = true } = options;

  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  initNewDatabase(testDb);

  const hash = bcrypt.hashSync('Admin!123', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', hash, 'admin', 'Admin');

  testDb
    .prepare('INSERT INTO chargepoints (identity, cpname, mode, authorized, feat_smartcharging) VALUES (?,?,?,?,?)')
    .run('CP001', 'Test CP', 1, 1, 1);
  const cp = testDb.prepare("SELECT * FROM chargepoints WHERE identity = 'CP001'").get();

  const connectedClients = isConnected ? new Map([['CP001', {}]]) : new Map();

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

  function requireAuth(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    next();
  }

  function getNextProfileId(chargepointId) {
    const row = testDb.prepare('SELECT MAX(profile_id) AS m FROM charging_profiles WHERE chargepoint_id = ?').get(chargepointId);
    return (row?.m ?? 0) + 1;
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

  // GET — liste les profils
  app.get('/api/chargepoints/:id/charging-profiles', requireAuth, (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    const profiles = testDb.prepare('SELECT * FROM charging_profiles WHERE chargepoint_id = ?').all(found.id);
    res.json(profiles);
  });

  // POST — crée et envoie à la borne
  app.post('/api/chargepoints/:id/charging-profiles', requireAuth, async (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const { connector_id = 0, stack_level = 0, profile_purpose, profile_kind,
      recurrency_kind, valid_from, valid_to, charging_rate_unit = 'W', schedule_periods } = req.body;

    if (!profile_purpose || !profile_kind || !Array.isArray(schedule_periods) || schedule_periods.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR' });
    }

    const profile_id = getNextProfileId(found.id);
    const chargingSchedule = {
      chargingRateUnit: charging_rate_unit,
      chargingSchedulePeriod: schedule_periods.map((p) => {
        const period = { startPeriod: p.startPeriod, limit: p.limit };
        if (p.numberPhases != null) period.numberPhases = p.numberPhases;
        return period;
      }),
    };

    const info = testDb.prepare(`
      INSERT INTO charging_profiles
        (chargepoint_id, profile_id, connector_id, stack_level, profile_purpose, profile_kind,
         recurrency_kind, valid_from, valid_to, charging_rate_unit, schedule_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
    `).run(found.id, profile_id, connector_id, stack_level, profile_purpose, profile_kind,
      recurrency_kind || null, valid_from || null, valid_to || null,
      charging_rate_unit, JSON.stringify(chargingSchedule));
    const dbId = info.lastInsertRowid;

    const csChargingProfiles = {
      chargingProfileId: profile_id,
      stackLevel: stack_level,
      chargingProfilePurpose: profile_purpose,
      chargingProfileKind: profile_kind,
      chargingSchedule,
    };
    if (recurrency_kind) csChargingProfiles.recurrencyKind = recurrency_kind;
    if (valid_from) csChargingProfiles.validFrom = valid_from;
    if (valid_to) csChargingProfiles.validTo = valid_to;

    try {
      const result = await callClient(found.identity, 'SetChargingProfile', { connectorId: connector_id, csChargingProfiles });
      const status = result?.status ?? 'Rejected';
      testDb.prepare("UPDATE charging_profiles SET status = ? WHERE id = ?").run(status, dbId);
      res.json({ status, id: dbId });
    } catch (e) {
      testDb.prepare('DELETE FROM charging_profiles WHERE id = ?').run(dbId);
      res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
    }
  });

  // POST — clear avec filtres
  app.post('/api/chargepoints/:id/charging-profiles/clear', requireAuth, async (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const { profile_id, connector_id, profile_purpose, stack_level } = req.body;
    const ocppParams = {};
    if (profile_id != null) ocppParams.id = profile_id;
    if (connector_id != null) ocppParams.connectorId = connector_id;
    if (profile_purpose) ocppParams.chargingProfilePurpose = profile_purpose;
    if (stack_level != null) ocppParams.stackLevel = stack_level;

    try {
      const result = await callClient(found.identity, 'ClearChargingProfile', ocppParams);
      if (result?.status === 'Accepted') {
        const conditions = ['chargepoint_id = ?'];
        const params = [found.id];
        if (profile_id != null) { conditions.push('profile_id = ?'); params.push(profile_id); }
        if (connector_id != null) { conditions.push('connector_id = ?'); params.push(connector_id); }
        if (profile_purpose) { conditions.push('profile_purpose = ?'); params.push(profile_purpose); }
        if (stack_level != null) { conditions.push('stack_level = ?'); params.push(stack_level); }
        testDb.prepare(`DELETE FROM charging_profiles WHERE ${conditions.join(' AND ')}`).run(...params);
      }
      res.json({ status: result?.status ?? 'Unknown' });
    } catch (e) {
      res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
    }
  });

  // POST — composite schedule
  app.post('/api/chargepoints/:id/charging-profiles/composite-schedule', requireAuth, async (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const { connector_id, duration, charging_rate_unit } = req.body;
    const ocppParams = { connectorId: connector_id, duration };
    if (charging_rate_unit) ocppParams.chargingRateUnit = charging_rate_unit;

    try {
      const result = await callClient(found.identity, 'GetCompositeSchedule', ocppParams);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
    }
  });

  // DELETE — supprime un profil précis
  app.delete('/api/chargepoints/:id/charging-profiles/:profileDbId', requireAuth, async (req, res) => {
    const found = testDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!found) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    const profileDbId = Number(req.params.profileDbId);
    const profile = testDb.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(profileDbId);
    if (!profile || profile.chargepoint_id !== found.id) return res.status(404).json({ error: 'ERR_PROFILE_NOT_FOUND' });

    if (profile.status === 'Rejected') {
      testDb.prepare('DELETE FROM charging_profiles WHERE id = ?').run(profileDbId);
      return res.json({ status: 'Accepted' });
    }

    if (!connectedClients.has(found.identity)) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    try {
      const result = await callClient(found.identity, 'ClearChargingProfile', { id: profile.profile_id });
      if (result?.status === 'Accepted') {
        testDb.prepare('DELETE FROM charging_profiles WHERE id = ?').run(profileDbId);
      }
      res.json({ status: result?.status ?? 'Unknown' });
    } catch (e) {
      res.status(500).json({ error: 'ERR_INTERNAL', details: e.message });
    }
  });

  return { app, db: testDb, cp };
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
//  GET /charging-profiles
// ══════════════════════════════════════════════════════
describe('GET /api/chargepoints/:id/charging-profiles', () => {
  it('retourne 401 si non authentifié', async () => {
    const { app, cp } = createApp();
    const res = await request(app).get(`/api/chargepoints/${cp.id}/charging-profiles`);
    expect(res.status).toBe(401);
  });

  it('retourne 404 si borne inconnue', async () => {
    const { app } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get('/api/chargepoints/9999/charging-profiles').set(CSRF_HEADER, csrf);
    expect(res.status).toBe(404);
  });

  it('retourne un tableau vide si aucun profil', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get(`/api/chargepoints/${cp.id}/charging-profiles`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retourne les profils existants', async () => {
    const { app, db, cp } = createApp();
    db.prepare(`
      INSERT INTO charging_profiles (chargepoint_id, profile_id, connector_id, stack_level,
        profile_purpose, profile_kind, charging_rate_unit, schedule_json, status)
      VALUES (?, 1, 0, 0, 'ChargePointMaxProfile', 'Absolute', 'W', '{}', 'Accepted')
    `).run(cp.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.get(`/api/chargepoints/${cp.id}/charging-profiles`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].profile_purpose).toBe('ChargePointMaxProfile');
  });
});

// ══════════════════════════════════════════════════════
//  POST /charging-profiles
// ══════════════════════════════════════════════════════
describe('POST /api/chargepoints/:id/charging-profiles', () => {
  it('retourne 401 si non authentifié', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    // Récupérer le token CSRF sans se connecter
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent.post(`/api/chargepoints/${cp.id}/charging-profiles`).set(CSRF_HEADER, csrf).send(BASE_PROFILE);
    expect(res.status).toBe(401);
  });

  it('retourne 400 si la borne est hors ligne', async () => {
    const { app, cp } = createApp({ isConnected: false });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles`)
      .set(CSRF_HEADER, csrf)
      .send(BASE_PROFILE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });

  it('retourne 400 si payload invalide (schedule_periods absent)', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles`)
      .set(CSRF_HEADER, csrf)
      .send({ ...BASE_PROFILE, schedule_periods: undefined });
    expect(res.status).toBe(400);
  });

  it('crée le profil et appelle SetChargingProfile avec les bons paramètres', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles`)
      .set(CSRF_HEADER, csrf)
      .send(BASE_PROFILE);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Accepted');

    // callClient appelé avec les bons params OCPP
    expect(callClient).toHaveBeenCalledWith('CP001', 'SetChargingProfile', expect.objectContaining({
      connectorId: 0,
      csChargingProfiles: expect.objectContaining({
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: expect.objectContaining({
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
        }),
      }),
    }));

    // Statut Accepted en DB
    const profile = db.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(res.body.id);
    expect(profile.status).toBe('Accepted');
  });

  it('status Rejected sauvegardé en DB si borne refuse', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles`)
      .set(CSRF_HEADER, csrf)
      .send(BASE_PROFILE);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
    const profile = db.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(res.body.id);
    expect(profile.status).toBe('Rejected');
  });

  it('supprime le profil en DB si callClient lève une erreur', async () => {
    const callClient = jest.fn().mockRejectedValue(new Error('timeout'));
    const { app, db, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles`)
      .set(CSRF_HEADER, csrf)
      .send(BASE_PROFILE);

    expect(res.status).toBe(500);
    const profiles = db.prepare('SELECT * FROM charging_profiles WHERE chargepoint_id = ?').all(cp.id);
    expect(profiles.length).toBe(0);
  });

  it('n\'inclut pas recurrencyKind/validFrom/validTo si non fournis', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent.post(`/api/chargepoints/${cp.id}/charging-profiles`).set(CSRF_HEADER, csrf).send(BASE_PROFILE);

    const [, , payload] = callClient.mock.calls[0];
    expect(payload.csChargingProfiles.recurrencyKind).toBeUndefined();
    expect(payload.csChargingProfiles.validFrom).toBeUndefined();
    expect(payload.csChargingProfiles.validTo).toBeUndefined();
  });

  it('inclut recurrencyKind/validFrom/validTo quand fournis', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent.post(`/api/chargepoints/${cp.id}/charging-profiles`).set(CSRF_HEADER, csrf).send({
      ...BASE_PROFILE,
      profile_kind: 'Recurring',
      recurrency_kind: 'Daily',
      valid_from: '2025-01-01T00:00:00Z',
      valid_to: '2025-12-31T23:59:59Z',
    });

    const [, , payload] = callClient.mock.calls[0];
    expect(payload.csChargingProfiles.recurrencyKind).toBe('Daily');
    expect(payload.csChargingProfiles.validFrom).toBe('2025-01-01T00:00:00Z');
    expect(payload.csChargingProfiles.validTo).toBe('2025-12-31T23:59:59Z');
  });
});

// ══════════════════════════════════════════════════════
//  DELETE /charging-profiles/:profileDbId
// ══════════════════════════════════════════════════════
describe('DELETE /api/chargepoints/:id/charging-profiles/:profileDbId', () => {
  function insertProfile(db, cpId, profileId = 1) {
    const info = db.prepare(`
      INSERT INTO charging_profiles (chargepoint_id, profile_id, connector_id, stack_level,
        profile_purpose, profile_kind, charging_rate_unit, schedule_json, status)
      VALUES (?, ?, 0, 0, 'ChargePointMaxProfile', 'Absolute', 'W', '{}', 'Accepted')
    `).run(cpId, profileId);
    return info.lastInsertRowid;
  }

  it('retourne 401 si non authentifié', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookie = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : '';
    const res = await agent.delete(`/api/chargepoints/${cp.id}/charging-profiles/1`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(401);
  });

  it('retourne 404 si le profil n\'appartient pas à la borne', async () => {
    const { app, cp } = createApp();
    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    const res = await agent.delete(`/api/chargepoints/${cp.id}/charging-profiles/9999`).set(CSRF_HEADER, csrf);
    expect(res.status).toBe(404);
  });

  it('supprime le profil en DB si la borne accepte (Accepted)', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp } = createApp({ callClient });
    const dbId = insertProfile(db, cp.id);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/chargepoints/${cp.id}/charging-profiles/${dbId}`).set(CSRF_HEADER, csrf);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Accepted');
    expect(db.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(dbId)).toBeUndefined();
  });

  it('conserve le profil en DB si la borne refuse (Rejected)', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp } = createApp({ callClient });
    const dbId = insertProfile(db, cp.id, 2);
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/chargepoints/${cp.id}/charging-profiles/${dbId}`).set(CSRF_HEADER, csrf);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
    expect(db.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(dbId)).toBeDefined();
  });

  it('supprime directement un profil avec statut Rejected sans appeler la borne', async () => {
    const callClient = jest.fn();
    const { app, db, cp } = createApp({ callClient });
    const dbId = db.prepare(`
      INSERT INTO charging_profiles (chargepoint_id, profile_id, connector_id, stack_level,
        profile_purpose, profile_kind, charging_rate_unit, schedule_json, status)
      VALUES (?, 3, 0, 0, 'ChargePointMaxProfile', 'Absolute', 'W', '{}', 'Rejected')
    `).run(cp.id).lastInsertRowid;
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent.delete(`/api/chargepoints/${cp.id}/charging-profiles/${dbId}`).set(CSRF_HEADER, csrf);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Accepted');
    expect(db.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(dbId)).toBeUndefined();
    expect(callClient).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
//  POST /charging-profiles/clear
// ══════════════════════════════════════════════════════
describe('POST /api/chargepoints/:id/charging-profiles/clear', () => {
  it('transmet les filtres à ClearChargingProfile', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles/clear`)
      .set(CSRF_HEADER, csrf)
      .send({ profile_purpose: 'TxDefaultProfile', connector_id: 1 });

    expect(callClient).toHaveBeenCalledWith('CP001', 'ClearChargingProfile', {
      chargingProfilePurpose: 'TxDefaultProfile',
      connectorId: 1,
    });
  });

  it('supprime les profils matching en DB si Accepted', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, db, cp } = createApp({ callClient });

    db.prepare(`
      INSERT INTO charging_profiles (chargepoint_id, profile_id, connector_id, stack_level,
        profile_purpose, profile_kind, charging_rate_unit, schedule_json, status)
      VALUES (?, 1, 0, 0, 'TxDefaultProfile', 'Absolute', 'W', '{}', 'Accepted')
    `).run(cp.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles/clear`)
      .set(CSRF_HEADER, csrf)
      .send({ profile_purpose: 'TxDefaultProfile' });

    expect(db.prepare('SELECT * FROM charging_profiles WHERE chargepoint_id = ?').all(cp.id).length).toBe(0);
  });

  it('ne supprime rien en DB si Rejected', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Rejected' });
    const { app, db, cp } = createApp({ callClient });

    db.prepare(`
      INSERT INTO charging_profiles (chargepoint_id, profile_id, connector_id, stack_level,
        profile_purpose, profile_kind, charging_rate_unit, schedule_json, status)
      VALUES (?, 1, 0, 0, 'ChargePointMaxProfile', 'Absolute', 'W', '{}', 'Accepted')
    `).run(cp.id);

    const agent = request.agent(app);
    const csrf = await loginAs(agent);
    await agent.post(`/api/chargepoints/${cp.id}/charging-profiles/clear`).set(CSRF_HEADER, csrf).send({});

    expect(db.prepare('SELECT * FROM charging_profiles WHERE chargepoint_id = ?').all(cp.id).length).toBe(1);
  });

  it('envoie un objet vide si aucun filtre', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent.post(`/api/chargepoints/${cp.id}/charging-profiles/clear`).set(CSRF_HEADER, csrf).send({});

    expect(callClient).toHaveBeenCalledWith('CP001', 'ClearChargingProfile', {});
  });
});

// ══════════════════════════════════════════════════════
//  POST /charging-profiles/composite-schedule
// ══════════════════════════════════════════════════════
describe('POST /api/chargepoints/:id/charging-profiles/composite-schedule', () => {
  it('appelle GetCompositeSchedule avec les bons paramètres', async () => {
    const mockResult = { status: 'Accepted', connectorId: 0, scheduleStart: '2025-01-01T00:00:00Z', chargingSchedule: {} };
    const callClient = jest.fn().mockResolvedValue(mockResult);
    const { app, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles/composite-schedule`)
      .set(CSRF_HEADER, csrf)
      .send({ connector_id: 0, duration: 86400, charging_rate_unit: 'W' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(mockResult);
    expect(callClient).toHaveBeenCalledWith('CP001', 'GetCompositeSchedule', {
      connectorId: 0,
      duration: 86400,
      chargingRateUnit: 'W',
    });
  });

  it('n\'inclut pas chargingRateUnit si non fourni', async () => {
    const callClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
    const { app, cp } = createApp({ callClient });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles/composite-schedule`)
      .set(CSRF_HEADER, csrf)
      .send({ connector_id: 0, duration: 3600 });

    const [, , params] = callClient.mock.calls[0];
    expect(params.chargingRateUnit).toBeUndefined();
  });

  it('retourne 400 si borne hors ligne', async () => {
    const { app, cp } = createApp({ isConnected: false });
    const agent = request.agent(app);
    const csrf = await loginAs(agent);

    const res = await agent
      .post(`/api/chargepoints/${cp.id}/charging-profiles/composite-schedule`)
      .set(CSRF_HEADER, csrf)
      .send({ connector_id: 0, duration: 3600 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });
});
