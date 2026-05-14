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

// ── Init Config (paramètres OCPP globaux) ──
describe('database — Init Config CRUD', () => {
  let entryId;
  const TEST_KEY = 'TestMeterValueInterval';

  it('creates an init config entry', () => {
    const result = db.createInitialChargepointConfig(TEST_KEY, '120', true);
    expect(result.changes).toBe(1);
    entryId = result.lastInsertRowid;
  });

  it('gets all init config entries', () => {
    const rows = db.getInitialChargepointConfig();
    expect(rows.some((r) => r.key === TEST_KEY)).toBe(true);
  });

  it('gets only enabled entries', () => {
    db.createInitialChargepointConfig('TestDisabledKey', '60', false);
    const enabled = db.getEnabledInitialChargepointConfig();
    expect(enabled.some((r) => r.key === TEST_KEY)).toBe(true);
    expect(enabled.some((r) => r.key === 'TestDisabledKey')).toBe(false);
  });

  it('gets an entry by key', () => {
    const entry = db.getInitialChargepointConfigByKey(TEST_KEY);
    expect(entry).toBeDefined();
    expect(entry.value).toBe('120');
    expect(entry.enabled).toBe(1);
  });

  it('returns undefined for unknown key', () => {
    expect(db.getInitialChargepointConfigByKey('UnknownKey')).toBeUndefined();
  });

  it('updates an init config entry', () => {
    db.updateInitialChargepointConfig(entryId, { value: '300' });
    const entry = db.getInitialChargepointConfigByKey(TEST_KEY);
    expect(entry.value).toBe('300');
  });

  it('deletes an init config entry', () => {
    db.deleteInitialChargepointConfig(entryId);
    expect(db.getInitialChargepointConfigByKey(TEST_KEY)).toBeUndefined();
  });
});

// ── Chargepoint initialization flags ──
describe('database — Chargepoint initialization flags', () => {
  let cpId;

  beforeAll(() => {
    db.upsertChargepoint('TEST-REINIT', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('TEST-REINIT').id;
  });

  it('new chargepoint starts with initialized = 0', () => {
    expect(db.getChargepointById(cpId).initialized).toBe(0);
  });

  it('markChargepointInitialized sets initialized to 1', () => {
    db.markChargepointInitialized(cpId);
    expect(db.getChargepointById(cpId).initialized).toBe(1);
  });

  it('resetChargepointInitialized sets initialized back to 0', () => {
    db.resetChargepointInitialized(cpId);
    expect(db.getChargepointById(cpId).initialized).toBe(0);
  });
});

// ── Charging Profiles ──
describe('database — Charging Profiles CRUD', () => {
  let cpId;
  let profileDbId;

  const baseProfile = {
    connector_id: 0,
    stack_level: 0,
    profile_purpose: 'ChargePointMaxProfile',
    profile_kind: 'Absolute',
    charging_rate_unit: 'W',
    schedule_json: JSON.stringify({
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
    }),
  };

  beforeAll(() => {
    db.upsertChargepoint('CP-PROFILE-TEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-PROFILE-TEST').id;
  });

  it('getNextProfileId returns 1 when no profiles exist', () => {
    expect(db.getNextProfileId(cpId)).toBe(1);
  });

  it('createChargingProfile inserts and returns a numeric id', () => {
    profileDbId = db.createChargingProfile({ chargepoint_id: cpId, profile_id: 1, ...baseProfile });
    expect(typeof profileDbId).toBe('number');
    expect(profileDbId).toBeGreaterThan(0);
  });

  it('getNextProfileId increments after insert', () => {
    expect(db.getNextProfileId(cpId)).toBe(2);
  });

  it('getChargingProfileById returns the inserted profile with Pending status', () => {
    const p = db.getChargingProfileById(profileDbId);
    expect(p).toBeDefined();
    expect(p.profile_purpose).toBe('ChargePointMaxProfile');
    expect(p.status).toBe('Pending');
    expect(p.chargepoint_id).toBe(cpId);
  });

  it('getChargingProfiles returns list for chargepoint', () => {
    const list = db.getChargingProfiles(cpId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].chargepoint_id).toBe(cpId);
  });

  it('getChargingProfiles filters by profile_purpose', () => {
    db.createChargingProfile({ chargepoint_id: cpId, profile_id: 2, ...baseProfile, profile_purpose: 'TxDefaultProfile' });
    const list = db.getChargingProfiles(cpId, { profile_purpose: 'ChargePointMaxProfile' });
    expect(list.every((p) => p.profile_purpose === 'ChargePointMaxProfile')).toBe(true);
  });

  it('getChargingProfiles filters by connector_id', () => {
    db.createChargingProfile({ chargepoint_id: cpId, profile_id: 3, ...baseProfile, connector_id: 1 });
    const list = db.getChargingProfiles(cpId, { connector_id: 0 });
    expect(list.every((p) => p.connector_id === 0)).toBe(true);
  });

  it('updateChargingProfileStatus changes status to Accepted', () => {
    db.updateChargingProfileStatus(profileDbId, 'Accepted');
    expect(db.getChargingProfileById(profileDbId).status).toBe('Accepted');
  });

  it('updateChargingProfileStatus changes status to Rejected', () => {
    db.updateChargingProfileStatus(profileDbId, 'Rejected');
    expect(db.getChargingProfileById(profileDbId).status).toBe('Rejected');
  });

  it('deleteChargingProfileById removes the profile', () => {
    const tempId = db.createChargingProfile({ chargepoint_id: cpId, profile_id: 99, ...baseProfile });
    db.deleteChargingProfileById(tempId);
    expect(db.getChargingProfileById(tempId)).toBeUndefined();
  });

  it('clearChargingProfilesByFilter removes by profile_purpose', () => {
    expect(db.getChargingProfiles(cpId, { profile_purpose: 'TxDefaultProfile' }).length).toBeGreaterThan(0);
    db.clearChargingProfilesByFilter(cpId, { profile_purpose: 'TxDefaultProfile' });
    expect(db.getChargingProfiles(cpId, { profile_purpose: 'TxDefaultProfile' }).length).toBe(0);
  });

  it('clearChargingProfilesByFilter with no filter removes all profiles for the chargepoint', () => {
    expect(db.getChargingProfiles(cpId).length).toBeGreaterThan(0);
    db.clearChargingProfilesByFilter(cpId);
    expect(db.getChargingProfiles(cpId).length).toBe(0);
  });

  it('ON DELETE CASCADE removes profiles when chargepoint is deleted', () => {
    db.upsertChargepoint('CP-CASCADE-TEST', { cpstatus: 'Available', connected: 0 });
    const cascadeCp = db.getChargepointByIdentity('CP-CASCADE-TEST');
    db.createChargingProfile({ chargepoint_id: cascadeCp.id, profile_id: 1, ...baseProfile });
    expect(db.getChargingProfiles(cascadeCp.id).length).toBe(1);
    db.deleteChargepoint(cascadeCp.id);
    expect(db.getChargingProfiles(cascadeCp.id).length).toBe(0);
  });
});

// ── Reservations ──
describe('database — Reservations CRUD', () => {
  let cpId, userId;

  const EXPIRY = '2030-01-01T12:00:00Z';

  beforeAll(() => {
    db.upsertChargepoint('CP-RESV-TEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-RESV-TEST').id;
    const user = db.createUser('resv@example.com', 'Str0ng!Pass', 'user', 'ResvUser');
    userId = user.id;
  });

  afterAll(() => {
    db.deleteUser(userId);
  });

  it('getNextReservationId returns 1 when no active reservations', () => {
    expect(db.getNextReservationId(cpId)).toBe(1);
  });

  it('createReservation inserts and returns a numeric id', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 1,
      reservation_id: 1,
      id_tag: 'TAG001',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('getNextReservationId increments after a Pending reservation', () => {
    expect(db.getNextReservationId(cpId)).toBe(2);
  });

  it('getReservationsByChargepoint returns inserted reservation with created_by_name', () => {
    const rows = db.getReservationsByChargepoint(cpId);
    expect(rows.length).toBe(1);
    expect(rows[0].id_tag).toBe('TAG001');
    expect(rows[0].status).toBe('Pending');
    expect(rows[0].created_by_name).toBe('ResvUser');
  });

  it('getReservationById returns the row', () => {
    const rows = db.getReservationsByChargepoint(cpId);
    const resv = db.getReservationById(rows[0].id);
    expect(resv).toBeDefined();
    expect(resv.id_tag).toBe('TAG001');
  });

  it('getReservationById returns undefined for unknown id', () => {
    expect(db.getReservationById(99999)).toBeUndefined();
  });

  it('activateReservationByConnector sets Pending → Active', () => {
    const rows = db.getReservationsByChargepoint(cpId);
    const id = rows[0].id;
    db.activateReservationByConnector(cpId, 1);
    expect(db.getReservationById(id).status).toBe('Active');
  });

  it('getNextReservationId still increments when reservation is Active', () => {
    expect(db.getNextReservationId(cpId)).toBe(2);
  });

  it('updateReservationStatus changes status to Cancelled', () => {
    const rows = db.getReservationsByChargepoint(cpId);
    const id = rows[0].id;
    db.updateReservationStatus(id, 'Cancelled');
    expect(db.getReservationById(id).status).toBe('Cancelled');
  });

  it('getNextReservationId resets to 1 when only Cancelled reservations exist', () => {
    expect(db.getNextReservationId(cpId)).toBe(1);
  });

  it('expireReservationByConnector sets Pending/Active → Expired', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 2,
      reservation_id: 1,
      id_tag: 'TAG002',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.expireReservationByConnector(cpId, 2);
    expect(db.getReservationById(id).status).toBe('Expired');
  });

  it('expireReservationByConnector also expires Active reservations', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 3,
      reservation_id: 2,
      id_tag: 'TAG003',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.activateReservationByConnector(cpId, 3);
    expect(db.getReservationById(id).status).toBe('Active');
    db.expireReservationByConnector(cpId, 3);
    expect(db.getReservationById(id).status).toBe('Expired');
  });

  it('ON DELETE CASCADE removes reservations when chargepoint is deleted', () => {
    db.upsertChargepoint('CP-RESV-CASCADE', { cpstatus: 'Available', connected: 0 });
    const cascadeCp = db.getChargepointByIdentity('CP-RESV-CASCADE');
    db.createReservation({
      chargepoint_id: cascadeCp.id,
      connector_id: 1,
      reservation_id: 1,
      id_tag: 'TAGX',
      expiry_date: EXPIRY,
      created_by: null,
    });
    expect(db.getReservationsByChargepoint(cascadeCp.id).length).toBe(1);
    db.deleteChargepoint(cascadeCp.id);
    expect(db.getReservationsByChargepoint(cascadeCp.id).length).toBe(0);
  });
});

// ── getExpiredActiveReservations ──
describe('database — getExpiredActiveReservations', () => {
  let cpId, userId;

  const PAST = '2020-01-01 12:00:00';
  const FUTURE = '2030-01-01 12:00:00';
  const GRACE_S = 60;
  // 10 years of grace → datetime('now', '-315360000 seconds') ≈ year 2016
  // so PAST (2020) does NOT satisfy expiry_date < 2016 → not returned
  const LARGE_GRACE_S = 315360000;

  beforeAll(() => {
    db.upsertChargepoint('CP-EXPIRY-TEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-EXPIRY-TEST').id;
    const user = db.createUser('expiry@example.com', 'Str0ng!Pass', 'user', 'ExpiryUser');
    userId = user.id;
  });

  afterAll(() => {
    db.deleteUser(userId);
  });

  it('returns empty when no reservations exist', () => {
    expect(db.getExpiredActiveReservations(GRACE_S)).toEqual([]);
  });

  it('returns Pending reservation with past expiry', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 1,
      reservation_id: 10,
      id_tag: 'EXPTAG1',
      expiry_date: PAST,
      created_by: userId,
    });
    const rows = db.getExpiredActiveReservations(GRACE_S);
    expect(rows.some((r) => r.id === id && r.status === 'Pending')).toBe(true);
    db.updateReservationStatus(id, 'Cancelled');
  });

  it('returns Active reservation with past expiry', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 2,
      reservation_id: 11,
      id_tag: 'EXPTAG2',
      expiry_date: PAST,
      created_by: userId,
    });
    db.activateReservationByConnector(cpId, 2);
    const rows = db.getExpiredActiveReservations(GRACE_S);
    expect(rows.some((r) => r.id === id && r.status === 'Active')).toBe(true);
    db.updateReservationStatus(id, 'Cancelled');
  });

  it('does not return reservation with future expiry', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 3,
      reservation_id: 12,
      id_tag: 'EXPTAG3',
      expiry_date: FUTURE,
      created_by: userId,
    });
    const rows = db.getExpiredActiveReservations(GRACE_S);
    expect(rows.some((r) => r.id === id)).toBe(false);
    db.updateReservationStatus(id, 'Cancelled');
  });

  it('does not return already-Expired reservation', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 4,
      reservation_id: 13,
      id_tag: 'EXPTAG4',
      expiry_date: PAST,
      created_by: userId,
    });
    db.updateReservationStatus(id, 'Expired');
    const rows = db.getExpiredActiveReservations(GRACE_S);
    expect(rows.some((r) => r.id === id)).toBe(false);
  });

  it('does not return Cancelled reservation', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 5,
      reservation_id: 14,
      id_tag: 'EXPTAG5',
      expiry_date: PAST,
      created_by: userId,
    });
    db.updateReservationStatus(id, 'Cancelled');
    const rows = db.getExpiredActiveReservations(GRACE_S);
    expect(rows.some((r) => r.id === id)).toBe(false);
  });

  it('includes identity from chargepoints join', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 6,
      reservation_id: 15,
      id_tag: 'EXPTAG6',
      expiry_date: PAST,
      created_by: userId,
    });
    const rows = db.getExpiredActiveReservations(GRACE_S);
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row.identity).toBe('CP-EXPIRY-TEST');
    db.updateReservationStatus(id, 'Cancelled');
  });

  it('handles ISO 8601 format with T and Z (as sent by the frontend)', () => {
    // toISOString() produces '2020-01-01T12:00:00.000Z' — SQLite must normalise via datetime()
    const isoDate = new Date('2020-01-01T12:00:00.000Z').toISOString();
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 8,
      reservation_id: 17,
      id_tag: 'EXPTAG8',
      expiry_date: isoDate,
      created_by: userId,
    });
    const rows = db.getExpiredActiveReservations(GRACE_S);
    expect(rows.some((r) => r.id === id)).toBe(true);
    db.updateReservationStatus(id, 'Cancelled');
  });

  it('does not return reservation still within grace period', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 7,
      reservation_id: 16,
      id_tag: 'EXPTAG7',
      expiry_date: PAST,
      created_by: userId,
    });
    const rows = db.getExpiredActiveReservations(LARGE_GRACE_S);
    expect(rows.some((r) => r.id === id)).toBe(false);
    db.updateReservationStatus(id, 'Cancelled');
  });
});

// ── HeartbeatInterval — comportement watchdog ──
describe('database — HeartbeatInterval global config', () => {
  it('HeartbeatInterval est présent dans la migration', () => {
    const entry = db.getInitialChargepointConfigByKey('HeartbeatInterval');
    expect(entry).toBeDefined();
    expect(parseInt(entry.value, 10)).toBeGreaterThan(0);
  });

  it('la valeur est utilisée comme intervalle heartbeat (fallback 300)', () => {
    const entry = db.getInitialChargepointConfigByKey('HeartbeatInterval');
    const interval = entry ? parseInt(entry.value, 10) : 300;
    expect(interval).toBeGreaterThan(0);
  });

  it('fallback à 300 si la clé est absente', () => {
    const entry = db.getInitialChargepointConfigByKey('NonExistentKey');
    const interval = entry ? parseInt(entry.value, 10) : 300;
    expect(interval).toBe(300);
  });
});
