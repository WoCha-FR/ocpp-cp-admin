'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const Database = require('better-sqlite3');
const { initNewDatabase } = require('../../src/migrator');

function createApp() {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  initNewDatabase(testDb);

  const userHash = bcrypt.hashSync('User!1234', 4);
  testDb
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?,?,?,?)')
    .run('user@test.com', userHash, 'user', 'UserOne');

  const testPassport = new passport.Passport();
  testPassport.use(
    new LocalStrategy({ usernameField: 'useremail', passwordField: 'password' }, (email, pwd, done) => {
      const u = testDb.prepare('SELECT * FROM users WHERE useremail = ?').get(email);
      if (!u || !bcrypt.compareSync(pwd, u.password)) return done(null, false);
      return done(null, { id: u.id, useremail: u.useremail, role: u.role });
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

  // Reimplémentation fidèle de GET /api/transactions/:transactionId/values (src/routes.js)
  // avec l'ajout du point de départ synthétique.
  app.get('/api/transactions/:transactionId/values', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });

    const transactionId = req.params.transactionId;
    const values = testDb
      .prepare('SELECT * FROM transactions_values WHERE transaction_id = ?')
      .get(transactionId);
    const tx = testDb
      .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
      .get(transactionId);

    const energie = values && values.energie ? JSON.parse(values.energie) : [];
    if (tx) {
      const startUnix = Math.floor(new Date(tx.start_time).getTime() / 1000);
      if (energie.length === 0 || energie[0].x > startUnix) {
        energie.unshift({ x: startUnix, offer: null, power: null, energy: 0 });
      }
    }

    if (!values)
      return res.json({
        energie,
        courant: [],
        soc: [],
        temperature: [],
        tension: [],
        frequence: [],
      });
    res.json({
      energie,
      courant: values.courant ? JSON.parse(values.courant) : [],
      soc: values.soc ? JSON.parse(values.soc) : [],
      temperature: values.temperature ? JSON.parse(values.temperature) : [],
      tension: values.tension ? JSON.parse(values.tension) : [],
      frequence: values.frequence ? JSON.parse(values.frequence) : [],
    });
  });

  return { app, db: testDb };
}

async function loginAsUser(agent) {
  await agent.post('/api/auth/login').send({ useremail: 'user@test.com', password: 'User!1234' });
}

let app, db;

beforeEach(() => {
  ({ app, db } = createApp());
});

afterEach(() => {
  db.close();
});

const START_TIME = '2026-09-05T10:00:00.000Z';
const START_UNIX = Math.floor(new Date(START_TIME).getTime() / 1000);

function insertCpAndTx(txId, startTime = START_TIME) {
  const cpId = db
    .prepare("INSERT INTO chargepoints (identity, cpstatus) VALUES ('VALUES-CP', 'Available')")
    .run().lastInsertRowid;
  db.prepare(
    "INSERT INTO transactions (transaction_id, chargepoint_id, connector_id, meter_start, start_time, status) VALUES (?,?,1,1000,?,'Completed')"
  ).run(txId, cpId, startTime);
  return cpId;
}

describe('GET /api/transactions/:transactionId/values — point de départ synthétique', () => {
  it("ajoute un point synthétique (x=start_time, energy=0) quand la transaction n'a aucune valeur", async () => {
    insertCpAndTx('TX-VAL-1');
    const agent = request.agent(app);
    await loginAsUser(agent);
    const res = await agent.get('/api/transactions/TX-VAL-1/values');
    expect(res.status).toBe(200);
    expect(res.body.energie).toEqual([{ x: START_UNIX, offer: null, power: null, energy: 0 }]);
  });

  it('préfixe le point synthétique quand la première entrée réelle est postérieure au start_time', async () => {
    insertCpAndTx('TX-VAL-2');
    const laterEntry = { x: START_UNIX + 300, offer: 32, power: 7000, energy: 0.5 };
    db.prepare(
      'INSERT INTO transactions_values (transaction_id, energie) VALUES (?, ?)'
    ).run('TX-VAL-2', JSON.stringify([laterEntry]));

    const agent = request.agent(app);
    await loginAsUser(agent);
    const res = await agent.get('/api/transactions/TX-VAL-2/values');
    expect(res.status).toBe(200);
    expect(res.body.energie).toEqual([
      { x: START_UNIX, offer: null, power: null, energy: 0 },
      laterEntry,
    ]);
  });

  it('ne duplique pas le point de départ si une entrée existe déjà à start_time ou avant', async () => {
    insertCpAndTx('TX-VAL-3');
    const earlyEntry = { x: START_UNIX, offer: 32, power: 0, energy: 0 };
    db.prepare(
      'INSERT INTO transactions_values (transaction_id, energie) VALUES (?, ?)'
    ).run('TX-VAL-3', JSON.stringify([earlyEntry]));

    const agent = request.agent(app);
    await loginAsUser(agent);
    const res = await agent.get('/api/transactions/TX-VAL-3/values');
    expect(res.status).toBe(200);
    expect(res.body.energie).toEqual([earlyEntry]);
  });

  it('retourne 401 si non authentifié', async () => {
    const res = await request(app).get('/api/transactions/TX-VAL-1/values');
    expect(res.status).toBe(401);
  });
});
