'use strict';

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
  scope: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3');
  return function (_path, opts) {
    return new Real(':memory:', opts);
  };
});

const db = require('../../src/database');

beforeAll(() => {
  db.getDb();
});

afterAll(() => {
  db.closeDb();
});

// ── Sites ──
describe('database — Sites CRUD', () => {
  let siteId;

  it('creates a site', () => {
    const site = db.createSite('Test Site', '1 Main Street');
    expect(site).toMatchObject({ sname: 'Test Site', address: '1 Main Street' });
    siteId = site.id;
  });

  it('gets a site by id', () => {
    const site = db.getSiteById(siteId);
    expect(site.sname).toBe('Test Site');
  });

  it('lists all sites', () => {
    const sites = db.getAllSites();
    expect(sites.length).toBeGreaterThanOrEqual(1);
  });

  it('updates a site', () => {
    const updated = db.updateSite(siteId, 'Renamed Site', '2 Other Road');
    expect(updated.sname).toBe('Renamed Site');
  });

  it('returns null for unknown site id', () => {
    expect(db.getSiteById(9999)).toBeUndefined();
  });

  it('deletes a site', () => {
    db.deleteSite(siteId);
    expect(db.getSiteById(siteId)).toBeUndefined();
  });
});

// ── Users ──
describe('database — Users CRUD', () => {
  let userId;

  it('creates a user', () => {
    const user = db.createUser('test@example.com', 'Str0ng!Pass', 'user', 'Tester');
    expect(user).toMatchObject({ useremail: 'test@example.com', role: 'user' });
    userId = user.id;
  });

  it('gets user by id', () => {
    const user = db.getUserById(userId);
    expect(user.useremail).toBe('test@example.com');
  });

  it('gets user by email', () => {
    const user = db.getUserByEmail('test@example.com');
    expect(user.id).toBe(userId);
  });

  it('updates last login', () => {
    expect(() => db.updateLastLogin(userId)).not.toThrow();
  });

  it('updates user data', () => {
    const updated = db.updateUser(userId, { shortname: 'Updated' });
    expect(updated.shortname).toBe('Updated');
  });

  it('lists all users', () => {
    const users = db.getAllUsers();
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it('returns undefined for unknown user', () => {
    expect(db.getUserById(9999)).toBeUndefined();
  });

  it('deletes a user', () => {
    db.deleteUser(userId);
    expect(db.getUserById(userId)).toBeUndefined();
  });
});

// ── Password resets ──
describe('database — Password reset tokens', () => {
  let userId;

  beforeAll(() => {
    const user = db.createUser('reset@example.com', 'Str0ng!Pass', 'user', 'ResetUser');
    userId = user.id;
  });

  afterAll(() => {
    db.deleteUser(userId);
  });

  it('creates and retrieves a reset token', () => {
    db.createPasswordReset(userId, 'abc123hash', new Date(Date.now() + 3600000).toISOString());
    const reset = db.getUserPasswordResetByToken('abc123hash');
    expect(reset).toBeTruthy();
    expect(reset.user_id).toBe(userId);
  });

  it('marks a reset token as used', () => {
    const reset = db.getUserPasswordResetByToken('abc123hash');
    db.markUserPasswordResetAsUsed(reset.id);
    const updated = db.getUserPasswordResetByToken('abc123hash');
    expect(updated.used).toBe(1);
  });

  it('deletes expired resets', () => {
    expect(() => db.deleteExpiredPasswordResets()).not.toThrow();
  });
});

// ── User-Site relationship ──
describe('database — User-Site linking', () => {
  let userId, siteId;

  beforeAll(() => {
    const site = db.createSite('LinkSite', null);
    siteId = site.id;
    const user = db.createUser('link@example.com', 'Str0ng!Pass', 'user', 'Linker');
    userId = user.id;
  });

  afterAll(() => {
    db.deleteUser(userId);
    db.deleteSite(siteId);
  });

  it('adds a user to a site', () => {
    expect(() =>
      db
        .getDb()
        .prepare('INSERT INTO user_sites (user_id, site_id, role, authorized) VALUES (?,?,?,?)')
        .run(userId, siteId, 'user', 1)
    ).not.toThrow();
  });

  it('gets user sites', () => {
    const sites = db.getUserSites(userId);
    expect(sites.length).toBe(1);
    expect(sites[0].site_id).toBe(siteId);
  });

  it('gets site users', () => {
    const users = db.getSiteUsers(siteId);
    expect(users.length).toBe(1);
  });
});
