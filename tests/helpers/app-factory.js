'use strict';

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/migrator');

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'x-xsrf-token';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Creates a self-contained Express app backed by SQLite :memory: for integration tests.
 * Returns { app, db, adminUser }
 */
function createTestApp() {
  const testDb = createTestDb();

  // Create admin user (bcrypt rounds=4 for speed in tests)
  const passwordHash = bcrypt.hashSync('Admin!123', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('admin@test.com', passwordHash, 'admin', 'Admin');
  const adminUser = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get('admin@test.com');

  // Create regular user
  const userHash = bcrypt.hashSync('User!1234', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('user@test.com', userHash, 'user', 'RegularUser');
  const regularUser = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get('user@test.com');

  // Local passport strategy
  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const user = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!user) return done(null, false, { message: 'ERR_UNKNOWN_USER' });
      if (!bcrypt.compareSync(pwd, user.password)) return done(null, false, { message: 'ERR_WRONG_PASSWORD' });
      return done(null, { id: user.id, useremail: user.useremail, role: user.role, sites: [] });
    })
  );
  testPassport.serializeUser((u, done) => done(null, u.id));
  testPassport.deserializeUser((id, done) => {
    const u = testDb.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return done(null, false);
    done(null, { id: u.id, useremail: u.useremail, role: u.role, sites: [] });
  });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: 'test-secret-for-sessions!!',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );
  app.use(testPassport.initialize());
  app.use(testPassport.session());

  // CSRF middleware
  app.use((req, res, next) => {
    let token = readCookie(req, CSRF_COOKIE);
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', path: '/' });
    }
    if (!CSRF_SAFE_METHODS.has(req.method)) {
      const headerToken = req.headers[CSRF_HEADER];
      if (!headerToken || headerToken !== token) {
        return res.status(403).json({ error: 'csrf_invalid' });
      }
    }
    next();
  });

  // ── Test routes ──

  app.get('/api/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    res.json(req.user);
  });

  app.post('/api/auth/login', (req, res, next) => {
    testPassport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: info?.message || 'ERR_INVALID_AUTH' });
      req.logIn(user, (err) => {
        if (err) return next(err);
        res.json({ id: user.id, useremail: user.useremail, role: user.role });
      });
    })(req, res, next);
  });

  app.post('/api/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => res.json({ ok: true }));
    });
  });

  // Sites routes
  app.get('/api/sites', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    const sites = testDb.prepare('SELECT * FROM sites ORDER BY sname').all();
    if (req.user.role === 'admin') return res.json(sites);
    const userSiteIds = testDb
      .prepare('SELECT site_id FROM user_sites WHERE user_id = ?')
      .all(req.user.id)
      .map((r) => r.site_id);
    return res.json(sites.filter((s) => userSiteIds.includes(s.id)));
  });

  app.post('/api/sites', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    const { name, address } = req.body;
    if (!name || name.length < 5) return res.status(400).json({ error: 'VALIDATION_SITE_NAME' });
    const info = testDb
      .prepare('INSERT INTO sites (sname, address) VALUES (?, ?)')
      .run(name, address || null);
    const site = testDb.prepare('SELECT * FROM sites WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(site);
  });

  return { app, db: testDb, adminUser, regularUser };
}

module.exports = { createTestApp };
