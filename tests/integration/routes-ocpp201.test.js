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

function createApp(connectedClients = new Map(), mockCallClient = jest.fn()) {
  const rawDb = new Database(':memory:');
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  initNewDatabase(rawDb);

  rawDb.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'admin@test.com', bcrypt.hashSync('Admin!123', 4), 'admin', 'Admin'
  );

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const u = rawDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!u || !bcrypt.compareSync(pwd, u.password)) return done(null, false);
      return done(null, { id: u.id, useremail: u.useremail, role: u.role });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = rawDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? { id: u.id, useremail: u.useremail, role: u.role } : false);
  });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret!!', resave: false, saveUninitialized: false }));
  app.use(testPassport.initialize());
  app.use(testPassport.session());

  app.use((req, res, next) => {
    let token = null;
    for (const part of (req.headers.cookie || '').split(';')) {
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
      req.logIn(user, (err2) => { if (err2) return next(err2); res.json(user); });
    })(req, res, next);
  });

  const requireAuth = (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    next();
  };

  // ── GET /api/chargepoints/:id/config ──
  app.get('/api/chargepoints/:id/config', requireAuth, (req, res) => {
    const cp = rawDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    if (cp.ocpp_version === '2.0.1') {
      return res.json(
        rawDb.prepare(
          'SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? ORDER BY component, variable, attribute'
        ).all(cp.id)
      );
    }
    res.json(
      rawDb.prepare('SELECT * FROM chargepoint_config WHERE chargepoint_id = ? ORDER BY key').all(cp.id)
    );
  });

  // ── GET /api/chargepoints/:id/evses ──
  app.get('/api/chargepoints/:id/evses', requireAuth, (req, res) => {
    const cp = rawDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    res.json(rawDb.prepare('SELECT * FROM evses WHERE chargepoint_id = ? ORDER BY evse_id').all(cp.id));
  });

  // ── PUT /api/chargepoints/:id/evses/:evseId ──
  app.put('/api/chargepoints/:id/evses/:evseId', requireAuth, (req, res) => {
    const cp = rawDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    const evse = rawDb
      .prepare('SELECT * FROM evses WHERE chargepoint_id = ? AND evse_id = ?')
      .get(cp.id, Number(req.params.evseId));
    if (!evse) return res.status(404).json({ error: 'ERR_EVSE_NOT_FOUND' });
    const evse_name = req.body.evse_name ?? null;
    rawDb
      .prepare('UPDATE evses SET evse_name = ? WHERE chargepoint_id = ? AND evse_id = ?')
      .run(evse_name || null, cp.id, Number(req.params.evseId));
    res.json(
      rawDb.prepare('SELECT * FROM evses WHERE chargepoint_id = ? AND evse_id = ?')
        .get(cp.id, Number(req.params.evseId))
    );
  });

  // ── PUT /api/chargepoints/:id/config/:key (branch 2.0.1) ──
  app.put('/api/chargepoints/:id/config/:key', requireAuth, async (req, res) => {
    const cp = rawDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    const client = connectedClients.get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined || value === null) return res.status(400).json({ error: 'ERR_VALUE_REQUIRED' });
    if (client.protocol === 'ocpp2.0.1') {
      const dotIdx = key.indexOf('.');
      if (dotIdx === -1) return res.status(400).json({ error: 'ERR_INVALID_KEY_FORMAT' });
      const component = key.slice(0, dotIdx);
      const variable = key.slice(dotIdx + 1);
      try {
        const result = await mockCallClient(cp.identity, 'SetVariables', {
          setVariableData: [{ component: { name: component }, variable: { name: variable }, attributeType: 'Actual', attributeValue: String(value) }],
        });
        rawDb.prepare(
          `INSERT INTO chargepoint_variables (chargepoint_id, component, variable, attribute, instance, evse_id, connector_id, value)
           VALUES (?, ?, ?, 'Actual', '', 0, 0, ?)
           ON CONFLICT(chargepoint_id, component, variable, attribute, instance, evse_id, connector_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        ).run(cp.id, component, variable, String(value));
        return res.json({ result });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });
  });

  // ── CRUD /api/init-config/variables ──
  app.get('/api/init-config/variables', requireAuth, (req, res) => {
    res.json(rawDb.prepare('SELECT * FROM chargepoint_init_variables ORDER BY component, variable, attribute').all());
  });

  app.post('/api/init-config/variables', requireAuth, (req, res) => {
    const { component, variable, attribute, value, enabled } = req.body;
    if (!component || !variable || value === undefined) {
      return res.status(400).json({ error: 'ERR_MISSING_FIELDS' });
    }
    try {
      const result = rawDb.prepare(
        "INSERT INTO chargepoint_init_variables (component, variable, attribute, value, enabled) VALUES (?, ?, ?, ?, ?)"
      ).run(component, variable, attribute || 'Actual', value, enabled ? 1 : 0);
      res.json({ id: result.lastInsertRowid });
    } catch (e) {
      if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'INIT_VARIABLE_EXISTS' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/init-config/variables/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const { value, enabled } = req.body;
    const fields = [];
    const vals = [];
    if (value !== undefined) { fields.push('value = ?'); vals.push(value); }
    if (enabled !== undefined) { fields.push('enabled = ?'); vals.push(enabled ? 1 : 0); }
    if (!fields.length) return res.json({ ok: true });
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    rawDb.prepare(`UPDATE chargepoint_init_variables SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  });

  app.delete('/api/init-config/variables/:id', requireAuth, (req, res) => {
    rawDb.prepare('DELETE FROM chargepoint_init_variables WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── POST /api/chargepoints/:id/command ──
  app.post('/api/chargepoints/:id/command', requireAuth, async (req, res) => {
    const cp = rawDb.prepare('SELECT * FROM chargepoints WHERE id = ?').get(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    const client = connectedClients.get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });
    const method = req.body.method;
    const params = req.body.params || {};
    try {
      let callParams = params;
      if (cp.ocpp_version === '2.0.1' && method === 'ChangeAvailability') {
        const { type, evseId, connectorId } = params;
        const id = evseId ?? connectorId ?? null;
        callParams = { operationalStatus: type };
        if (id != null && id !== 0) callParams.evse = { id };
      }
      const result = await mockCallClient(cp.identity, method, callParams);
      res.json({ result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return { app, rawDb };
}

async function loginAndGetCsrf(agent) {
  const me = await agent.get('/api/auth/me');
  const csrf = readCsrfCookie(me.headers['set-cookie']) || readCsrfCookie([me.headers.cookie]);
  await agent.post('/api/auth/login').set(CSRF_HEADER, csrf).send({ useremail: 'admin@test.com', password: 'Admin!123' });
  return csrf;
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('GET /api/chargepoints/:id/config — branche ocpp_version', () => {
  let app, rawDb, agent, csrf;

  beforeAll(async () => {
    ({ app, rawDb } = createApp());
    agent = request.agent(app);
    csrf = await loginAndGetCsrf(agent);
  });

  it('retourne chargepoint_config pour une borne 1.6', async () => {
    const site = rawDb.prepare("INSERT INTO sites (sname) VALUES ('S1')").run();
    const cp = rawDb.prepare(
      "INSERT INTO chargepoints (identity, ocpp_version) VALUES ('CP16', '1.6')"
    ).run();
    rawDb.prepare(
      "INSERT INTO chargepoint_config (chargepoint_id, key, value) VALUES (?, 'HeartbeatInterval', '300')"
    ).run(cp.lastInsertRowid);

    const res = await agent.get(`/api/chargepoints/${cp.lastInsertRowid}/config`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('key');
  });

  it('retourne chargepoint_variables pour une borne 2.0.1', async () => {
    const cp = rawDb.prepare(
      "INSERT INTO chargepoints (identity, ocpp_version) VALUES ('CP201', '2.0.1')"
    ).run();
    rawDb.prepare(
      "INSERT INTO chargepoint_variables (chargepoint_id, component, variable, attribute, value) VALUES (?, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '600')"
    ).run(cp.lastInsertRowid);

    const res = await agent.get(`/api/chargepoints/${cp.lastInsertRowid}/config`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('component');
    expect(res.body[0]).toHaveProperty('variable');
  });

  it('retourne 404 pour une borne inexistante', async () => {
    const res = await agent.get('/api/chargepoints/999999/config');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/chargepoints/:id/evses', () => {
  let app, rawDb, agent, csrf, cpId;

  beforeAll(async () => {
    ({ app, rawDb } = createApp());
    agent = request.agent(app);
    csrf = await loginAndGetCsrf(agent);
    const cp = rawDb.prepare(
      "INSERT INTO chargepoints (identity, ocpp_version) VALUES ('EVSE-TEST', '2.0.1')"
    ).run();
    cpId = cp.lastInsertRowid;
    rawDb.prepare("INSERT INTO evses (chargepoint_id, evse_id, status) VALUES (?, 1, 'Available')").run(cpId);
    rawDb.prepare("INSERT INTO evses (chargepoint_id, evse_id, status) VALUES (?, 2, 'Charging')").run(cpId);
  });

  it('retourne la liste des EVSEs', async () => {
    const res = await agent.get(`/api/chargepoints/${cpId}/evses`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].evse_id).toBe(1);
    expect(res.body[1].status).toBe('Charging');
  });

  it('retourne tableau vide pour borne sans EVSEs', async () => {
    const cp2 = rawDb.prepare("INSERT INTO chargepoints (identity) VALUES ('EVSE-EMPTY')").run();
    const res = await agent.get(`/api/chargepoints/${cp2.lastInsertRowid}/evses`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retourne 404 pour une borne inexistante', async () => {
    const res = await agent.get('/api/chargepoints/999999/evses');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/chargepoints/:id/config/:key — branche OCPP 2.0.1', () => {
  let app, rawDb, agent, csrf, cpId;
  const mockCallClient = jest.fn().mockResolvedValue({
    setVariableResult: [{ attributeStatus: 'Accepted' }],
  });
  const connectedClients = new Map();

  beforeAll(async () => {
    ({ app, rawDb } = createApp(connectedClients, mockCallClient));
    agent = request.agent(app);
    csrf = await loginAndGetCsrf(agent);
    const cp = rawDb.prepare(
      "INSERT INTO chargepoints (identity, ocpp_version) VALUES ('201-CONFIG', '2.0.1')"
    ).run();
    cpId = cp.lastInsertRowid;
    connectedClients.set('201-CONFIG', { protocol: 'ocpp2.0.1' });
  });

  it('refuse la clé sans point', async () => {
    const res = await agent
      .put(`/api/chargepoints/${cpId}/config/HeartbeatInterval`)
      .set(CSRF_HEADER, csrf)
      .send({ value: '300' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_INVALID_KEY_FORMAT');
  });

  it('appelle SetVariables et upsert la variable', async () => {
    const res = await agent
      .put(`/api/chargepoints/${cpId}/config/OCPPCommCtrlr.HeartbeatInterval`)
      .set(CSRF_HEADER, csrf)
      .send({ value: '600' });
    expect(res.status).toBe(200);
    expect(mockCallClient).toHaveBeenCalledWith(
      '201-CONFIG',
      'SetVariables',
      expect.objectContaining({
        setVariableData: [
          expect.objectContaining({
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'HeartbeatInterval' },
          }),
        ],
      })
    );
    const saved = rawDb.prepare(
      "SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? AND component = 'OCPPCommCtrlr' AND variable = 'HeartbeatInterval'"
    ).get(cpId);
    expect(saved).toBeDefined();
    expect(saved.value).toBe('600');
  });

  it('retourne 400 si borne hors ligne', async () => {
    const cp2 = rawDb.prepare(
      "INSERT INTO chargepoints (identity, ocpp_version) VALUES ('201-OFFLINE', '2.0.1')"
    ).run();
    const res = await agent
      .put(`/api/chargepoints/${cp2.lastInsertRowid}/config/OCPPCommCtrlr.HeartbeatInterval`)
      .set(CSRF_HEADER, csrf)
      .send({ value: '300' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_OFFLINE');
  });
});

describe('CRUD /api/init-config/variables', () => {
  let app, rawDb, agent, csrf, entryId;

  beforeAll(async () => {
    ({ app, rawDb } = createApp());
    agent = request.agent(app);
    csrf = await loginAndGetCsrf(agent);
  });

  it('GET retourne liste vide initialement', async () => {
    const res = await agent.get('/api/init-config/variables');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST crée une variable', async () => {
    const res = await agent
      .post('/api/init-config/variables')
      .set(CSRF_HEADER, csrf)
      .send({ component: 'TestCtrlr', variable: 'TestInterval', attribute: 'Actual', value: '999', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    entryId = res.body.id;
  });

  it('GET retourne la variable créée', async () => {
    const res = await agent.get('/api/init-config/variables');
    expect(res.body.some((v) => v.component === 'TestCtrlr' && v.variable === 'TestInterval')).toBe(true);
  });

  it('POST rejette les doublons (component + variable + attribute)', async () => {
    const res = await agent
      .post('/api/init-config/variables')
      .set(CSRF_HEADER, csrf)
      .send({ component: 'TestCtrlr', variable: 'TestInterval', attribute: 'Actual', value: '999', enabled: true });
    expect(res.status).toBe(409);
  });

  it('PUT met à jour la valeur', async () => {
    const res = await agent
      .put(`/api/init-config/variables/${entryId}`)
      .set(CSRF_HEADER, csrf)
      .send({ value: '300' });
    expect(res.status).toBe(200);
    const list = await agent.get('/api/init-config/variables');
    const entry = list.body.find((v) => v.id === entryId);
    expect(entry.value).toBe('300');
  });

  it('PUT bascule enabled', async () => {
    await agent.put(`/api/init-config/variables/${entryId}`).set(CSRF_HEADER, csrf).send({ enabled: false });
    const list = await agent.get('/api/init-config/variables');
    const entry = list.body.find((v) => v.id === entryId);
    expect(entry.enabled).toBe(0);
  });

  it('DELETE supprime la variable', async () => {
    const res = await agent
      .delete(`/api/init-config/variables/${entryId}`)
      .set(CSRF_HEADER, csrf);
    expect(res.status).toBe(200);
    const list = await agent.get('/api/init-config/variables');
    expect(list.body.some((v) => v.id === entryId)).toBe(false);
  });

  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/init-config/variables');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/chargepoints/:id/evses/:evseId', () => {
  let app, rawDb, agent, csrf, cpId;

  beforeAll(async () => {
    ({ app, rawDb } = createApp());
    agent = request.agent(app);
    csrf = await loginAndGetCsrf(agent);
    const cp = rawDb
      .prepare("INSERT INTO chargepoints (identity, ocpp_version) VALUES ('EVSE-NAME-TEST', '2.0.1')")
      .run();
    cpId = cp.lastInsertRowid;
    rawDb.prepare("INSERT INTO evses (chargepoint_id, evse_id, status) VALUES (?, 1, 'Available')").run(cpId);
  });

  afterAll(() => rawDb.close());

  it('retourne 401 si non authentifié', async () => {
    const unauth = request.agent(app);
    const meRes = await unauth.get('/api/auth/me');
    const c = readCsrfCookie(meRes.headers['set-cookie']);
    const res = await unauth
      .put(`/api/chargepoints/${cpId}/evses/1`)
      .set('x-xsrf-token', c)
      .send({ evse_name: 'Test' });
    expect(res.status).toBe(401);
  });

  it('met à jour evse_name avec une valeur valide', async () => {
    const res = await agent
      .put(`/api/chargepoints/${cpId}/evses/1`)
      .set('x-xsrf-token', csrf)
      .send({ evse_name: 'EVSE Principal' });
    expect(res.status).toBe(200);
    expect(res.body.evse_name).toBe('EVSE Principal');
  });

  it('efface evse_name avec une chaîne vide', async () => {
    const res = await agent
      .put(`/api/chargepoints/${cpId}/evses/1`)
      .set('x-xsrf-token', csrf)
      .send({ evse_name: '' });
    expect(res.status).toBe(200);
    expect(res.body.evse_name).toBeNull();
  });

  it('retourne 404 pour une borne inexistante', async () => {
    const res = await agent
      .put('/api/chargepoints/999999/evses/1')
      .set('x-xsrf-token', csrf)
      .send({ evse_name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_NOT_FOUND');
  });

  it('retourne 404 pour un evseId inexistant', async () => {
    const res = await agent
      .put(`/api/chargepoints/${cpId}/evses/99`)
      .set('x-xsrf-token', csrf)
      .send({ evse_name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_EVSE_NOT_FOUND');
  });
});

describe("POST /api/chargepoints/:id/command — adaptation ChangeAvailability OCPP 2.0.1", () => {
  let app, rawDb, agent, csrf, cp201Id, cp16Id;
  const mockCallClient = jest.fn().mockResolvedValue({ status: 'Accepted' });
  const connectedClients = new Map();

  beforeAll(async () => {
    ({ app, rawDb } = createApp(connectedClients, mockCallClient));
    agent = request.agent(app);
    csrf = await loginAndGetCsrf(agent);

    const cp201 = rawDb
      .prepare("INSERT INTO chargepoints (identity, ocpp_version) VALUES ('CMD-201', '2.0.1')")
      .run();
    cp201Id = cp201.lastInsertRowid;
    connectedClients.set('CMD-201', { protocol: 'ocpp2.0.1' });

    const cp16 = rawDb
      .prepare("INSERT INTO chargepoints (identity, ocpp_version) VALUES ('CMD-16', '1.6')")
      .run();
    cp16Id = cp16.lastInsertRowid;
    connectedClients.set('CMD-16', { protocol: 'ocpp1.6' });
  });

  beforeEach(() => {
    mockCallClient.mockClear();
  });

  it('ChangeAvailability borne entière (evseId=0) → operationalStatus sans champ evse', async () => {
    const res = await agent
      .post(`/api/chargepoints/${cp201Id}/command`)
      .set(CSRF_HEADER, csrf)
      .send({ method: 'ChangeAvailability', params: { type: 'Inoperative', evseId: 0 } });
    expect(res.status).toBe(200);
    expect(mockCallClient).toHaveBeenCalledWith('CMD-201', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    expect(mockCallClient.mock.calls[0][2]).not.toHaveProperty('evse');
  });

  it('ChangeAvailability EVSE spécifique (evseId=2) → evse:{id:2}', async () => {
    const res = await agent
      .post(`/api/chargepoints/${cp201Id}/command`)
      .set(CSRF_HEADER, csrf)
      .send({ method: 'ChangeAvailability', params: { type: 'Operative', evseId: 2 } });
    expect(res.status).toBe(200);
    expect(mockCallClient).toHaveBeenCalledWith('CMD-201', 'ChangeAvailability', {
      operationalStatus: 'Operative',
      evse: { id: 2 },
    });
  });

  it('UnlockConnector 2.0.1 → params passés directement sans transformation', async () => {
    const res = await agent
      .post(`/api/chargepoints/${cp201Id}/command`)
      .set(CSRF_HEADER, csrf)
      .send({ method: 'UnlockConnector', params: { evseId: 1, connectorId: 1 } });
    expect(res.status).toBe(200);
    expect(mockCallClient).toHaveBeenCalledWith('CMD-201', 'UnlockConnector', {
      evseId: 1,
      connectorId: 1,
    });
  });

  it('ChangeAvailability 1.6 → params non transformés (connectorId conservé)', async () => {
    const res = await agent
      .post(`/api/chargepoints/${cp16Id}/command`)
      .set(CSRF_HEADER, csrf)
      .send({ method: 'ChangeAvailability', params: { type: 'Inoperative', connectorId: 1 } });
    expect(res.status).toBe(200);
    expect(mockCallClient).toHaveBeenCalledWith('CMD-16', 'ChangeAvailability', {
      type: 'Inoperative',
      connectorId: 1,
    });
  });

  it('GetLog 2.0.1 → params passés directement avec clé log', async () => {
    const res = await agent
      .post(`/api/chargepoints/${cp201Id}/command`)
      .set(CSRF_HEADER, csrf)
      .send({
        method: 'GetLog',
        params: { logType: 'DiagnosticsLog', requestId: 12345, log: { remoteLocation: 'ftp://server/path' } },
      });
    expect(res.status).toBe(200);
    expect(mockCallClient).toHaveBeenCalledWith('CMD-201', 'GetLog', {
      logType: 'DiagnosticsLog',
      requestId: 12345,
      log: { remoteLocation: 'ftp://server/path' },
    });
  });

  it('GetLog 2.0.1 → la clé log est transmise telle quelle (pas renommée en logParameters)', async () => {
    await agent
      .post(`/api/chargepoints/${cp201Id}/command`)
      .set(CSRF_HEADER, csrf)
      .send({
        method: 'GetLog',
        params: { logType: 'DiagnosticsLog', requestId: 1, log: { remoteLocation: 'ftp://x' } },
      });
    const sentParams = mockCallClient.mock.calls[0][2];
    expect(sentParams).toHaveProperty('log');
    expect(sentParams).not.toHaveProperty('logParameters');
  });
});
