'use strict';

const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configMock = require('../helpers/config-mock');

jest.mock('../../src/config', () => ({
  getConfig: () => configMock,
  getConfigDir: () => '/tmp',
  castEnvValue: jest.fn(),
  deepGet: jest.fn(),
  deepSet: jest.fn(),
  ENV_OVERRIDES: [],
  CONFIG_FIELDS: [],
}));

jest.mock('../../src/logger', () => ({
  scope: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3');
  return function (_path, opts) {
    return new Real(':memory:', opts);
  };
});

const db = require('../../src/database');
const { createTestApp } = require('../helpers/app-factory');

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookies = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : null;
  await agent.post('/api/auth/login').set('x-xsrf-token', csrf).send({ useremail: email, password });
  return csrf;
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    next();
  };
}

// Le scaffold auth/session/CSRF vient de createTestApp() (tests/helpers/app-factory.js) et opère
// sur sa propre base :memory: isolée (utilisateurs admin@test.com / user@test.com uniquement).
// Les routes admin ci-dessous, elles, appellent le vrai src/database.js (singleton mocké en mémoire
// via jest.mock('better-sqlite3') ci-dessus) : la donnée métier (bornes, transactions...) est donc
// posée séparément via db.* dans chaque test.
function mountAdminRoutes(app) {
  const APP_VERSION = require('../../package.json').version;

  app.get('/api/admin/info', requireRole('admin'), (req, res) => {
    const stats = db.getSystemStats();
    res.json({
      version: APP_VERSION,
      uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(),
      dbSizeBytes: stats.dbSizeBytes,
      counts: stats.counts,
      connected: { db: stats.connectedDb, live: 0 },
    });
  });

  app.get('/api/admin/db/backup', requireRole('admin'), async (req, res) => {
    const tempPath = path.join(os.tmpdir(), `cpadmin-backup-test-${crypto.randomUUID()}.sqlite`);
    try {
      await db.backupDatabase(tempPath);
    } catch {
      return res.status(500).json({ error: 'ERR_BACKUP_FAILED' });
    }
    res.download(tempPath, 'cpadmin-backup-test.sqlite', () => {
      fs.unlink(tempPath, () => {});
    });
  });

  const BEFORE_DATE_RE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/;

  app.get('/api/admin/cleanup/stats', requireRole('admin'), (req, res) => {
    res.json(db.getCleanupStats());
  });

  app.delete('/api/admin/cleanup/transaction-values', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.body.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteTransactionValuesBefore(req.body.before) });
  });

  app.delete('/api/admin/cleanup/id-tag-events', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.body.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteIdTagEventsBefore(req.body.before) });
  });

  app.delete('/api/admin/cleanup/error-events', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.body.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteErrorEventsBefore(req.body.before) });
  });

  app.delete('/api/admin/cleanup/reservations', requireRole('admin'), (req, res) => {
    if (req.body.before && !BEFORE_DATE_RE.test(req.body.before))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteExpiredReservations(req.body.before || null) });
  });

  app.delete('/api/admin/cleanup/notification-log', requireRole('admin'), (req, res) => {
    if (!BEFORE_DATE_RE.test(req.query.before || ''))
      return res.status(400).json({ error: 'VALIDATION_BEFORE' });
    res.json({ deleted: db.deleteNotificationLogBefore(req.query.before) });
  });

  app.post('/api/admin/db/vacuum', requireRole('admin'), (req, res) => {
    db.vacuumDatabase();
    res.json({ ok: true });
  });

  app.get('/api/admin/chargepoints/compare', requireRole('admin'), (req, res) => {
    const idsParam = req.query.ids;
    if (typeof idsParam !== 'string') return res.status(400).json({ error: 'VALIDATION_IDS' });
    const parts = idsParam.split(',');
    if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^\d+$/.test(p))) {
      return res.status(400).json({ error: 'VALIDATION_IDS' });
    }
    const ids = [...new Set(parts.map(Number))];
    const cps = ids.map((id) => db.getChargepointById(id)).filter(Boolean);
    if (cps.length !== ids.length) {
      return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    }
    const versions = new Set(cps.map((cp) => cp.ocpp_version || '1.6'));
    if (versions.size > 1) {
      return res.status(400).json({ error: 'ERR_MIXED_OCPP_VERSION' });
    }
    const version = [...versions][0];
    const chargepoints = cps.map((cp) => ({
      id: cp.id,
      identity: cp.identity,
      name: cp.cpname,
      vendor: cp.vendor,
      model: cp.model,
    }));

    const rowsMap = new Map();
    if (version === '2.0.1') {
      for (const cp of cps) {
        for (const v of db.getChargepointVariables(cp.id)) {
          const rowKey = [v.component, v.variable, v.attribute, v.instance].join('|');
          if (!rowsMap.has(rowKey)) {
            rowsMap.set(rowKey, {
              component: v.component,
              variable: v.variable,
              attribute: v.attribute,
              instance: v.instance,
              sortKey: rowKey,
              values: {},
            });
          }
          rowsMap.get(rowKey).values[cp.id] = { value: v.value, is_override: !!v.is_override };
        }
      }
    } else {
      for (const cp of cps) {
        for (const c of db.getChargepointConfig(cp.id)) {
          if (!rowsMap.has(c.key)) {
            rowsMap.set(c.key, { key: c.key, sortKey: c.key, values: {} });
          }
          rowsMap.get(c.key).values[cp.id] = { value: c.value, is_override: !!c.is_override };
        }
      }
    }

    const rows = [...rowsMap.values()]
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map((row) => {
        // eslint-disable-next-line no-unused-vars
        const { sortKey, ...rest } = row;
        const missing = !cps.every((cp) => rest.values[cp.id] !== undefined);
        const presentValues = cps
          .filter((cp) => rest.values[cp.id] !== undefined)
          .map((cp) => rest.values[cp.id].value);
        const valuesDiffer = new Set(presentValues).size > 1;
        return { ...rest, diff: missing || valuesDiffer, missing, valuesDiffer };
      });

    res.json({ version, chargepoints, rows });
  });
}

function createApp() {
  const { app } = createTestApp();
  mountAdminRoutes(app);
  return app;
}

describe('GET /api/admin/info', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('retourne 401 si non authentifié', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/info');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur non-admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/admin/info');
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec les infos système pour un admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/admin/info');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.memory).toHaveProperty('heapUsed');
    expect(typeof res.body.dbSizeBytes).toBe('number');
    expect(res.body.counts).toHaveProperty('transactions');
    expect(res.body.connected).toMatchObject({ db: 0, live: 0 });
  });
});

describe('GET /api/admin/db/backup', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('retourne 401 si non authentifié', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/db/backup');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur non-admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/admin/db/backup');
    expect(res.status).toBe(403);
  });

  it('retourne un fichier SQLite téléchargeable pour un admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/admin/db/backup');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

// ── Endpoints admin — nettoyage des données (onglet 2) ──
describe('Endpoints admin — nettoyage des données', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('GET /api/admin/cleanup/stats retourne 401/403/200 selon le rôle', async () => {
    const app = createApp();
    const anon = await request(app).get('/api/admin/cleanup/stats');
    expect(anon.status).toBe(401);

    const userAgent = request.agent(app);
    await loginAs(userAgent, 'user@test.com', 'User!1234');
    const forbidden = await userAgent.get('/api/admin/cleanup/stats');
    expect(forbidden.status).toBe(403);

    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const ok = await adminAgent.get('/api/admin/cleanup/stats').set('x-xsrf-token', csrf);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body.map((r) => r.table)).toContain('transactions_values');
  });

  it('DELETE /api/admin/cleanup/transaction-values purge les valeurs sans toucher aux transactions', async () => {
    const app = createApp();
    const testDb = db.getDb();
    const cp = db.createChargepoint('CP-EP-CLEANUP', 'CP', 'pass');
    testDb
      .prepare(
        `INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, status, start_time, stop_time)
         VALUES ('TX-EP-OLD', ?, 1, 'Completed', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`
      )
      .run(cp.id);
    db.upsertTransactionValues('TX-EP-OLD', { energieEntry: '1' });

    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const res = await adminAgent
      .delete('/api/admin/cleanup/transaction-values')
      .set('x-xsrf-token', csrf)
      .send({ before: '2030-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(
      testDb.prepare("SELECT * FROM transactions WHERE transaction_id = 'TX-EP-OLD'").get()
    ).toBeDefined();
    expect(db.getTransactionValues('TX-EP-OLD')).toBeUndefined();
  });

  it('DELETE /api/admin/cleanup/transaction-values rejette une requête sans date (VALIDATION_BEFORE)', async () => {
    const app = createApp();
    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const res = await adminAgent
      .delete('/api/admin/cleanup/transaction-values')
      .set('x-xsrf-token', csrf)
      .send({});
    expect(res.status).toBe(400);
  });

  it('DELETE /api/admin/cleanup/reservations accepte une requête sans date (before optionnel)', async () => {
    const app = createApp();
    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const res = await adminAgent
      .delete('/api/admin/cleanup/reservations')
      .set('x-xsrf-token', csrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deleted');
  });

  it('POST /api/admin/db/vacuum retourne 200 pour un admin et 403 sinon', async () => {
    const app = createApp();
    const userAgent = request.agent(app);
    const userCsrf = await loginAs(userAgent, 'user@test.com', 'User!1234');
    const forbidden = await userAgent.post('/api/admin/db/vacuum').set('x-xsrf-token', userCsrf);
    expect(forbidden.status).toBe(403);

    const adminAgent = request.agent(app);
    const csrf = await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    const ok = await adminAgent.post('/api/admin/db/vacuum').set('x-xsrf-token', csrf);
    expect(ok.status).toBe(200);
  });
});

// ── Endpoint admin — comparaison des paramètres OCPP entre bornes (onglet 4) ──
describe('GET /api/admin/chargepoints/compare', () => {
  beforeEach(() => {
    db.getDb();
  });

  afterEach(() => {
    db.closeDb();
  });

  it('retourne 401 si non authentifié', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/chargepoints/compare?ids=1,2');
    expect(res.status).toBe(401);
  });

  it('retourne 403 pour un utilisateur non-admin', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get('/api/admin/chargepoints/compare?ids=1,2');
    expect(res.status).toBe(403);
  });

  it('rejette moins de 2 ids ou plus de 4 ids (VALIDATION_IDS)', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const tooFew = await agent.get('/api/admin/chargepoints/compare?ids=1');
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.error).toBe('VALIDATION_IDS');
    const tooMany = await agent.get('/api/admin/chargepoints/compare?ids=1,2,3,4,5');
    expect(tooMany.status).toBe(400);
  });

  it("retourne 404 ERR_CHARGEPOINT_NOT_FOUND si une borne sélectionnée n'existe pas", async () => {
    const app = createApp();
    const cp = db.createChargepoint('CP-CMP-1', 'CP1', 'pass');
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/admin/chargepoints/compare?ids=${cp.id},999999`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ERR_CHARGEPOINT_NOT_FOUND');
  });

  it('retourne 400 ERR_MIXED_OCPP_VERSION si les bornes ont des versions OCPP différentes', async () => {
    const app = createApp();
    const cp1 = db.createChargepoint('CP-CMP-V16', 'CP1', 'pass');
    const cp2 = db.createChargepoint('CP-CMP-V201', 'CP2', 'pass');
    db.upsertChargepoint('CP-CMP-V201', { ocpp_version: '2.0.1' });
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/admin/chargepoints/compare?ids=${cp1.id},${cp2.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ERR_MIXED_OCPP_VERSION');
  });

  it('compare les configs OCPP 1.6 : détecte les écarts et traite un paramètre absent comme un écart', async () => {
    const app = createApp();
    const cp1 = db.createChargepoint('CP-CMP-A', 'CP A', 'pass');
    const cp2 = db.createChargepoint('CP-CMP-B', 'CP B', 'pass');
    db.upsertChargepointConfig(cp1.id, 'HeartbeatInterval', '300', 0);
    db.upsertChargepointConfig(cp2.id, 'HeartbeatInterval', '300', 0);
    db.upsertChargepointConfig(cp1.id, 'MeterValueSampleInterval', '60', 0);
    db.upsertChargepointConfig(cp2.id, 'MeterValueSampleInterval', '120', 0);
    db.upsertChargepointConfig(cp1.id, 'OnlyOnCp1', 'x', 0, true);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/admin/chargepoints/compare?ids=${cp1.id},${cp2.id}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.6');
    expect(res.body.chargepoints.map((c) => c.id).sort()).toEqual([cp1.id, cp2.id].sort());

    const rowsByKey = Object.fromEntries(res.body.rows.map((r) => [r.key, r]));
    expect(rowsByKey.HeartbeatInterval.diff).toBe(false);
    expect(rowsByKey.HeartbeatInterval.missing).toBe(false);
    expect(rowsByKey.HeartbeatInterval.valuesDiffer).toBe(false);

    expect(rowsByKey.MeterValueSampleInterval.diff).toBe(true);
    expect(rowsByKey.MeterValueSampleInterval.missing).toBe(false);
    expect(rowsByKey.MeterValueSampleInterval.valuesDiffer).toBe(true);

    // Paramètre absent chez cp2 : diff global à true, mais valuesDiffer reste false
    // (les valeurs présentes concordent) — permet au front de distinguer les deux cas.
    expect(rowsByKey.OnlyOnCp1.diff).toBe(true);
    expect(rowsByKey.OnlyOnCp1.missing).toBe(true);
    expect(rowsByKey.OnlyOnCp1.valuesDiffer).toBe(false);
    expect(rowsByKey.OnlyOnCp1.values[cp2.id]).toBeUndefined();
    expect(rowsByKey.OnlyOnCp1.values[cp1.id].is_override).toBe(true);
  });

  it('compare les variables OCPP 2.0.1 en pivotant sur component/variable/attribute', async () => {
    const app = createApp();
    const cp1 = db.createChargepoint('CP-CMP-201-A', 'CP A', 'pass');
    const cp2 = db.createChargepoint('CP-CMP-201-B', 'CP B', 'pass');
    db.upsertChargepoint('CP-CMP-201-A', { ocpp_version: '2.0.1' });
    db.upsertChargepoint('CP-CMP-201-B', { ocpp_version: '2.0.1' });
    db.upsertChargepointVariable(cp1.id, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '300');
    db.upsertChargepointVariable(cp2.id, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '600');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/admin/chargepoints/compare?ids=${cp1.id},${cp2.id}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('2.0.1');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].component).toBe('OCPPCommCtrlr');
    expect(res.body.rows[0].variable).toBe('HeartbeatInterval');
    expect(res.body.rows[0].diff).toBe(true);
  });
});
