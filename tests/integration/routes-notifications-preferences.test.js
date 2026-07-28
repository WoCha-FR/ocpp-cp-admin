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

// Événements fictifs utilisés dans les tests (subset représentatif, avec rôles
// comme dans src/notifications.js pour pouvoir tester le filtrage par rôle cible)
const MOCK_EVENT_DEFS = {
  server_started: { roles: ['admin'], defaultChannels: [] },
  chargepoint_online: { roles: ['admin', 'manager'], defaultChannels: ['email'] },
  transaction_started: { roles: ['user'], defaultChannels: ['email', 'webpush'] },
};
const MOCK_CHANNELS = ['email', 'webpush', 'pushover'];

// Miroir simplifié de notifications.getEventsForUser : un admin a tous les rôles,
// un utilisateur classique n'a que le rôle "user" (pas de gestion de site dans ces tests).
function getEventsForUser(user) {
  const roles = user.role === 'admin' ? ['admin', 'manager', 'user'] : ['user'];
  const result = {};
  for (const [event, def] of Object.entries(MOCK_EVENT_DEFS)) {
    if (roles.some((r) => def.roles.includes(r))) {
      result[event] = { defaultChannels: def.defaultChannels };
    }
  }
  return result;
}

function createApp() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initNewDatabase(db);

  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'admin@test.com', bcrypt.hashSync('Admin!123', 4), 'admin', 'Admin'
  );
  db.prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)').run(
    'user@test.com', bcrypt.hashSync('User!1234', 4), 'user', 'RegularUser'
  );

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = db.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user || !bcrypt.compareSync(pwd, user.password)) return done(null, false);
      return done(null, { id: user.id, useremail: user.useremail, role: user.role, sites: [] });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, u ? { id: u.id, useremail: u.useremail, role: u.role, sites: [] } : false);
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

  // Helpers DB inline (miroir de database.js)
  function getPrefs(userId) {
    return db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ? ORDER BY event_type, channel')
      .all(userId);
  }

  function upsertPref(userId, eventType, channel, enabled) {
    const existing = db
      .prepare('SELECT id FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?')
      .get(userId, eventType, channel);
    if (existing) {
      db.prepare('UPDATE notification_preferences SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, existing.id);
    } else {
      db.prepare('INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (?,?,?,?)').run(
        userId, eventType, channel, enabled ? 1 : 0
      );
    }
  }

  function upsertPrefsBulk(userId, prefs) {
    const upsert = db.transaction((list) => {
      for (const p of list) upsertPref(userId, p.event_type, p.channel, p.enabled);
    });
    upsert(prefs);
  }

  // Miroir de la fonction loadNotificationPreferences() de src/routes.js
  function loadPreferencesForUser(user) {
    const events = getEventsForUser(user);
    const channels = MOCK_CHANNELS;
    const prefs = getPrefs(user.id);

    const eventsWithPrefs = new Set(prefs.map((p) => p.event_type));
    const missingPrefs = [];
    for (const [eventType, eventDef] of Object.entries(events)) {
      if (!eventsWithPrefs.has(eventType)) {
        for (const channel of channels) {
          missingPrefs.push({
            event_type: eventType,
            channel,
            enabled: eventDef.defaultChannels.includes(channel),
          });
        }
      }
    }
    if (missingPrefs.length > 0) {
      upsertPrefsBulk(user.id, missingPrefs);
    }

    const allPrefs = missingPrefs.length > 0 ? getPrefs(user.id) : prefs;
    return { events, preferences: allPrefs, channels };
  }

  // Route GET /api/notifications/preferences — miroir de routes.js avec la logique B
  app.get('/api/notifications/preferences', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    res.json(loadPreferencesForUser(req.user));
  });

  // Routes admin — miroir de GET/PUT /api/users/:id/notifications/preferences de routes.js
  app.get('/api/users/:id/notifications/preferences', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    const targetId = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'ERR_UNKNOWN_USER' });
    res.json(loadPreferencesForUser(target));
  });

  app.put('/api/users/:id/notifications/preferences', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    const targetId = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'ERR_UNKNOWN_USER' });
    const { preferences } = req.body;
    if (!Array.isArray(preferences)) return res.status(400).json({ error: 'ERR_USERPREF_TABLE' });
    const allowedEvents = getEventsForUser(target);
    const invalid = preferences.filter((p) => !allowedEvents[p.event_type]);
    if (invalid.length > 0) {
      return res.status(403).json({ error: 'ERR_UNAUTHORIZED_EVENTS' });
    }
    upsertPrefsBulk(targetId, preferences);
    res.json({ ok: true });
  });

  return { app, db };
}

// ── Helpers ──

async function getCsrf(agent) {
  const res = await agent.get('/api/auth/me');
  const cookies = (res.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function loginAs(agent, email, password) {
  const csrf = await getCsrf(agent);
  await agent.post('/api/auth/login').set(CSRF_HEADER, csrf).send({ useremail: email, password });
  return csrf;
}

// ── Tests ──

let app, db;

beforeEach(() => {
  ({ app, db } = createApp());
});

afterEach(() => {
  db.close();
});

describe('GET /api/notifications/preferences', () => {
  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/notifications/preferences');
    expect(res.status).toBe(401);
  });

  it('matérialise les préférences par défaut en DB au premier accès', async () => {
    const user = db.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();

    // Aucune préférence en DB avant le premier appel
    const before = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(user.id);
    expect(before).toHaveLength(0);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/notifications/preferences');

    expect(res.status).toBe(200);

    // La DB doit maintenant contenir une ligne par (event × channel)
    const after = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(user.id);
    const expectedCount = Object.keys(MOCK_EVENT_DEFS).length * MOCK_CHANNELS.length;
    expect(after).toHaveLength(expectedCount);
  });

  it('retourne les canaux activés selon defaultChannels lors de la matérialisation', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/notifications/preferences');

    expect(res.status).toBe(200);
    const { preferences } = res.body;

    // server_started : defaultChannels=[] → tout désactivé
    const serverStartedPrefs = preferences.filter((p) => p.event_type === 'server_started');
    expect(serverStartedPrefs.every((p) => !p.enabled)).toBe(true);

    // chargepoint_online : defaultChannels=['email'] → email activé, autres non
    const cpOnlineEmail = preferences.find(
      (p) => p.event_type === 'chargepoint_online' && p.channel === 'email'
    );
    const cpOnlineWebpush = preferences.find(
      (p) => p.event_type === 'chargepoint_online' && p.channel === 'webpush'
    );
    expect(cpOnlineEmail.enabled).toBeTruthy();
    expect(cpOnlineWebpush.enabled).toBeFalsy();

    // transaction_started : defaultChannels=['email','webpush'] → les deux activés
    const txEmail = preferences.find(
      (p) => p.event_type === 'transaction_started' && p.channel === 'email'
    );
    const txWebpush = preferences.find(
      (p) => p.event_type === 'transaction_started' && p.channel === 'webpush'
    );
    const txPushover = preferences.find(
      (p) => p.event_type === 'transaction_started' && p.channel === 'pushover'
    );
    expect(txEmail.enabled).toBeTruthy();
    expect(txWebpush.enabled).toBeTruthy();
    expect(txPushover.enabled).toBeFalsy();
  });

  it('ne recrée pas les préférences si elles existent déjà en DB', async () => {
    const user = db.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();

    // Pré-insérer des préférences manuellement
    db.prepare(
      'INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (?,?,?,?)'
    ).run(user.id, 'chargepoint_online', 'email', 0);

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    await agent.get('/api/notifications/preferences');

    // La préférence existante ne doit pas avoir été écrasée
    const pref = db
      .prepare(
        'SELECT * FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?'
      )
      .get(user.id, 'chargepoint_online', 'email');
    expect(pref.enabled).toBe(0);
  });

  it('les préférences de deux utilisateurs sont indépendantes', async () => {
    const admin = db.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();
    const user = db.prepare("SELECT * FROM users WHERE useremail = 'user@test.com'").get();

    const adminAgent = request.agent(app);
    await loginAs(adminAgent, 'admin@test.com', 'Admin!123');
    await adminAgent.get('/api/notifications/preferences');

    const userAgent = request.agent(app);
    await loginAs(userAgent, 'user@test.com', 'User!1234');
    await userAgent.get('/api/notifications/preferences');

    const adminPrefs = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(admin.id);
    const userPrefs = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(user.id);

    expect(adminPrefs.length).toBeGreaterThan(0);
    expect(userPrefs.length).toBeGreaterThan(0);
    expect(adminPrefs.every((p) => p.user_id === admin.id)).toBe(true);
    expect(userPrefs.every((p) => p.user_id === user.id)).toBe(true);
  });

  it('un second appel ne double pas les entrées en DB', async () => {
    const user = db.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    await agent.get('/api/notifications/preferences');
    await agent.get('/api/notifications/preferences');

    const prefs = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(user.id);
    const expectedCount = Object.keys(MOCK_EVENT_DEFS).length * MOCK_CHANNELS.length;
    expect(prefs).toHaveLength(expectedCount);
  });
});

describe('Admin : GET/PUT /api/users/:id/notifications/preferences', () => {
  it('GET retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/users/1/notifications/preferences');
    expect(res.status).toBe(401);
  });

  it('GET retourne 403 si non admin', async () => {
    const admin = db.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();
    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');
    const res = await agent.get(`/api/users/${admin.id}/notifications/preferences`);
    expect(res.status).toBe(403);
  });

  it('GET retourne 404 pour un utilisateur inconnu', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get('/api/users/999999/notifications/preferences');
    expect(res.status).toBe(404);
  });

  it("admin peut lire les préférences d'un autre utilisateur (matérialisées pour la cible, pas pour l'admin)", async () => {
    const admin = db.prepare("SELECT * FROM users WHERE useremail = 'admin@test.com'").get();
    const target = db.prepare("SELECT * FROM users WHERE useremail = 'user@test.com'").get();

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');
    const res = await agent.get(`/api/users/${target.id}/notifications/preferences`);

    expect(res.status).toBe(200);
    // La cible ('user') ne voit que les événements de rôle 'user'
    expect(Object.keys(res.body.events)).toEqual(['transaction_started']);

    const targetPrefs = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(target.id);
    expect(targetPrefs.length).toBeGreaterThan(0);

    // Les préférences de l'admin lui-même ne doivent pas avoir été matérialisées
    const adminPrefs = db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .all(admin.id);
    expect(adminPrefs).toHaveLength(0);
  });

  it("admin peut modifier les préférences d'un autre utilisateur, persistées pour le bon user_id", async () => {
    const target = db.prepare("SELECT * FROM users WHERE useremail = 'user@test.com'").get();

    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent
      .put(`/api/users/${target.id}/notifications/preferences`)
      .set(CSRF_HEADER, csrf)
      .send({ preferences: [{ event_type: 'transaction_started', channel: 'email', enabled: false }] });

    expect(res.status).toBe(200);

    const pref = db
      .prepare(
        'SELECT * FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?'
      )
      .get(target.id, 'transaction_started', 'email');
    expect(pref.enabled).toBe(0);
  });

  it("rejette les event_type hors du rôle effectif de l'utilisateur ciblé", async () => {
    const target = db.prepare("SELECT * FROM users WHERE useremail = 'user@test.com'").get();

    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');

    // chargepoint_online est réservé aux rôles admin/manager, pas au rôle 'user' de la cible
    const res = await agent
      .put(`/api/users/${target.id}/notifications/preferences`)
      .set(CSRF_HEADER, csrf)
      .send({ preferences: [{ event_type: 'chargepoint_online', channel: 'email', enabled: true }] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ERR_UNAUTHORIZED_EVENTS');
  });
});
