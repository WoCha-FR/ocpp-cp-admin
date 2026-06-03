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

  it('expireActiveReservationByConnector sets Pending → Expired', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 2,
      reservation_id: 1,
      id_tag: 'TAG002',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.expireActiveReservationByConnector(cpId, 2);
    expect(db.getReservationById(id).status).toBe('Expired');
  });

  it('expireActiveReservationByConnector also expires Active reservations', () => {
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
    db.expireActiveReservationByConnector(cpId, 3);
    expect(db.getReservationById(id).status).toBe('Expired');
  });

  it('expireActiveReservationByConnector does not expire InUse reservations', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 4,
      reservation_id: 3,
      id_tag: 'TAG004',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.activateReservationByConnector(cpId, 4);
    db.startUsingReservationByConnectorAndIdTag(cpId, 4, 'TAG004');
    expect(db.getReservationById(id).status).toBe('InUse');
    db.expireActiveReservationByConnector(cpId, 4);
    expect(db.getReservationById(id).status).toBe('InUse');
  });

  it('startUsingReservationByConnectorAndIdTag sets Active → InUse only when idTag matches', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 5,
      reservation_id: 4,
      id_tag: 'TAG005',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.activateReservationByConnector(cpId, 5);
    const changed = db.startUsingReservationByConnectorAndIdTag(cpId, 5, 'WRONG_TAG');
    expect(changed).toBe(0);
    expect(db.getReservationById(id).status).toBe('Active');
    const changed2 = db.startUsingReservationByConnectorAndIdTag(cpId, 5, 'TAG005');
    expect(changed2).toBe(1);
    expect(db.getReservationById(id).status).toBe('InUse');
  });

  it('fulfillReservationByConnectorAndIdTag sets InUse → Fulfilled only when idTag matches', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 6,
      reservation_id: 5,
      id_tag: 'TAG006',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.activateReservationByConnector(cpId, 6);
    db.startUsingReservationByConnectorAndIdTag(cpId, 6, 'TAG006');
    const changed = db.fulfillReservationByConnectorAndIdTag(cpId, 6, 'WRONG_TAG');
    expect(changed).toBe(0);
    expect(db.getReservationById(id).status).toBe('InUse');
    const changed2 = db.fulfillReservationByConnectorAndIdTag(cpId, 6, 'TAG006');
    expect(changed2).toBe(1);
    expect(db.getReservationById(id).status).toBe('Fulfilled');
  });

  it('fulfillInUseReservationByConnector sets InUse → Fulfilled regardless of idTag', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 7,
      reservation_id: 6,
      id_tag: 'TAG007',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    db.activateReservationByConnector(cpId, 7);
    db.startUsingReservationByConnectorAndIdTag(cpId, 7, 'TAG007');
    db.fulfillInUseReservationByConnector(cpId, 7);
    expect(db.getReservationById(id).status).toBe('Fulfilled');
  });

  it('getReservationByOcppId returns reservation by OCPP-level reservation_id', () => {
    const id = db.createReservation({
      chargepoint_id: cpId,
      connector_id: 8,
      reservation_id: 42,
      id_tag: 'TAG008',
      expiry_date: EXPIRY,
      created_by: userId,
    });
    const resv = db.getReservationByOcppId(cpId, 42);
    expect(resv).toBeDefined();
    expect(resv.id).toBe(id);
    expect(resv.id_tag).toBe('TAG008');
    expect(db.getReservationByOcppId(cpId, 999)).toBeUndefined();
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

// ── getTransactions — connector_name ──
describe('database — getTransactions connector_name', () => {
  let cpId;
  const START = '2026-01-01T10:00:00Z';

  beforeAll(() => {
    db.upsertChargepoint('CP-CNTX-TEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-CNTX-TEST').id;
  });

  it('returns connector_name when connector has a name', () => {
    db.getDb()
      .prepare('INSERT OR REPLACE INTO connectors (chargepoint_id, connector_id, connector_name) VALUES (?,?,?)')
      .run(cpId, 1, 'Prise A');
    db.createTransaction(cpId, 1, 'TAG001', 0, START, 'local');

    const txs = db.getTransactions({ chargepoint_id: cpId });
    const tx = txs.find((t) => t.connector_id === 1);
    expect(tx).toBeDefined();
    expect(tx.connector_name).toBe('Prise A');
  });

  it('returns connector_name as null when connector has no name', () => {
    db.getDb()
      .prepare('INSERT OR REPLACE INTO connectors (chargepoint_id, connector_id, connector_name) VALUES (?,?,?)')
      .run(cpId, 2, null);
    db.createTransaction(cpId, 2, 'TAG002', 0, START, 'local');

    const txs = db.getTransactions({ chargepoint_id: cpId });
    const tx = txs.find((t) => t.connector_id === 2);
    expect(tx).toBeDefined();
    expect(tx.connector_name).toBeNull();
  });
});

// ── resetStateOnStartup ──
describe('database — resetStateOnStartup', () => {
  let cpId1, cpId2, txId;

  beforeAll(() => {
    db.upsertChargepoint('CP-RST-1', { cpstatus: 'Charging', connected: 1, connected_wss: 1, initialized: 1 });
    cpId1 = db.getChargepointByIdentity('CP-RST-1').id;
    db.upsertConnector(cpId1, 1, 'Charging', 'NoError', null, null, null);
    const tx = db.createTransaction(cpId1, 1, 'RSTTAG1', 1000, new Date().toISOString(), 'rfid');
    txId = tx.transaction_id;

    db.upsertChargepoint('CP-RST-2', { cpstatus: 'Available', connected: 0, initialized: 1 });
    cpId2 = db.getChargepointByIdentity('CP-RST-2').id;
  });

  it('remet connected=0 et cpstatus=null sur toutes les bornes', () => {
    db.resetStateOnStartup();
    const cp1 = db.getChargepointById(cpId1);
    expect(cp1.connected).toBe(0);
    expect(cp1.connected_wss).toBe(0);
    expect(cp1.cpstatus).toBeNull();
  });

  it('ne modifie pas initialized (donnée persistante)', () => {
    const cp1 = db.getChargepointById(cpId1);
    expect(cp1.initialized).toBe(1);
    const cp2 = db.getChargepointById(cpId2);
    expect(cp2.initialized).toBe(1);
  });

  it('ferme les transactions Active avec stop_reason=Other', () => {
    const tx = db.getTransactionByTransactionId(txId);
    expect(tx.status).toBe('Completed');
    expect(tx.stop_reason).toBe('Other');
    expect(tx.stop_time).not.toBeNull();
    expect(tx.charging_state).toBeNull();
  });

  it('calcule meter_stop = meter_start + energy si energy est renseigné', () => {
    // start_time dans le passé lointain pour ne pas polluer les tests KPI (filtre 7/30 jours)
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertChargepoint('CP-RST-ENERGY', { connected: 1, initialized: 1 });
    const cpE = db.getChargepointByIdentity('CP-RST-ENERGY').id;
    const tx = db.createTransaction(cpE, 1, 'RSTENERGY', 10000, oldDate, 'rfid');
    // updateTransactionPowerEnergy stocke energy = energyWh - meter_start
    // donc on passe 12500 (absolu) → energy = 12500 - 10000 = 2500
    db.updateTransactionPowerEnergy(tx.transaction_id, 3000, 12500);
    db.resetStateOnStartup();
    const closed = db.getTransactionByTransactionId(tx.transaction_id);
    expect(closed.status).toBe('Completed');
    expect(closed.meter_stop).toBe(12500); // meter_start(10000) + energy(2500)
    expect(closed.energy).toBeNull();
  });

  it('laisse meter_stop à null si energy est null', () => {
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertChargepoint('CP-RST-NOENERGY', { connected: 1, initialized: 1 });
    const cpN = db.getChargepointByIdentity('CP-RST-NOENERGY').id;
    const tx = db.createTransaction(cpN, 1, 'RSTNOENERGY', 5000, oldDate, 'rfid');
    db.resetStateOnStartup();
    const closed = db.getTransactionByTransactionId(tx.transaction_id);
    expect(closed.status).toBe('Completed');
    expect(closed.meter_stop).toBeNull();
  });

  it('remet cnstatus=null sur tous les connecteurs', () => {
    const connectors = db.getConnectorsByChargepoint(cpId1);
    expect(connectors[0].cnstatus).toBeNull();
  });

  it('retourne le nombre correct d\'enregistrements modifiés', () => {
    db.upsertChargepoint('CP-RST-COUNT', { connected: 1 });
    const cpCount = db.getChargepointByIdentity('CP-RST-COUNT').id;
    db.createTransaction(cpCount, 1, 'RSTTAG2', 0, new Date().toISOString(), 'rfid');
    const result = db.resetStateOnStartup();
    expect(result.chargepoints).toBeGreaterThanOrEqual(1);
    expect(result.transactions).toBeGreaterThanOrEqual(1);
    expect(result.connectors).toBeGreaterThanOrEqual(0);
  });

  it('est idempotent : un 2e appel ne ferme plus de transactions', () => {
    const result = db.resetStateOnStartup();
    expect(result.transactions).toBe(0);
  });
});

// ── resetConnectorsByChargepoint ──
describe('database — resetConnectorsByChargepoint', () => {
  let cpId;

  beforeAll(() => {
    db.upsertChargepoint('CP-RSCN-1', { connected: 0 });
    cpId = db.getChargepointByIdentity('CP-RSCN-1').id;
    db.upsertConnector(cpId, 1, 'Charging', 'NoError', null, null, null);
    db.upsertConnector(cpId, 2, 'Available', 'NoError', null, null, null);
  });

  it('met cnstatus=null sur tous les connecteurs de la borne', () => {
    db.resetConnectorsByChargepoint(cpId);
    const connectors = db.getConnectorsByChargepoint(cpId);
    expect(connectors).toHaveLength(2);
    for (const c of connectors) {
      expect(c.cnstatus).toBeNull();
    }
  });

  it('ne touche pas les connecteurs d\'autres bornes', () => {
    db.upsertChargepoint('CP-RSCN-2', { connected: 0 });
    const otherId = db.getChargepointByIdentity('CP-RSCN-2').id;
    db.upsertConnector(otherId, 1, 'Available', 'NoError', null, null, null);
    db.resetConnectorsByChargepoint(cpId);
    const otherConnectors = db.getConnectorsByChargepoint(otherId);
    expect(otherConnectors[0].cnstatus).toBe('Available');
  });
});

// ── OCPP Messages date filter ──
describe('database — OCPP Messages date filter', () => {
  let siteId, cpId;

  beforeAll(() => {
    const site = db.createSite('MsgSite', null);
    siteId = site.id;
    const cp = db.createChargepoint('TEST-MSG-01', 'Msg CP', 'pass', 1, siteId);
    cpId = cp.id;
    const raw = db.getDb();
    const ins = raw.prepare(
      `INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run(cpId, 'chargepoint', 'CALL',       'BootNotification', '{}', '2026-05-19 10:00:00');
    ins.run(cpId, 'csms',        'CALLRESULT',  'BootNotification', '{}', '2026-05-20 10:00:00');
    ins.run(cpId, 'chargepoint', 'CALL',       'Heartbeat',        '{}', '2026-05-20 14:00:00');
  });

  afterAll(() => {
    db.clearOcppMessages(cpId);
  });

  it('returns all messages without date filter', () => {
    expect(db.getOcppMessages({ chargepoint_id: cpId }).length).toBe(3);
  });

  it('filters messages by date_from', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, date_from: '2026-05-20 00:00:00' });
    expect(msgs.length).toBe(2);
  });

  it('filters messages by date_to', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, date_to: '2026-05-19 23:59:59' });
    expect(msgs.length).toBe(1);
    expect(msgs[0].action).toBe('BootNotification');
    expect(msgs[0].origin).toBe('chargepoint');
  });

  it('filters messages by full day range', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, date_from: '2026-05-20 00:00:00', date_to: '2026-05-20 23:59:59' });
    expect(msgs.length).toBe(2);
  });

  it('returns empty for date with no messages', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, date_from: '2026-05-21 00:00:00', date_to: '2026-05-21 23:59:59' });
    expect(msgs.length).toBe(0);
  });
});

// ── OCPP Messages multi-action filter ──
describe('database — OCPP Messages multi-action filter', () => {
  let cpId;

  beforeAll(() => {
    const site = db.createSite('MultiActSite', null);
    const cp = db.createChargepoint('TEST-MULTIACT-01', 'MultiAct CP', 'pass', 1, site.id);
    cpId = cp.id;
    const raw = db.getDb();
    const ins = raw.prepare(
      `INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload) VALUES (?, ?, ?, ?, ?)`
    );
    ins.run(cpId, 'chargepoint', 'CALL',       'BootNotification',   '{}');
    ins.run(cpId, 'chargepoint', 'CALL',       'Heartbeat',          '{}');
    ins.run(cpId, 'csms',        'CALLRESULT',  'StatusNotification', '{}');
  });

  afterAll(() => {
    db.clearOcppMessages(cpId);
  });

  it('filtre sur une seule action', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, actions: ['Heartbeat'] });
    expect(msgs.length).toBe(1);
    expect(msgs[0].action).toBe('Heartbeat');
  });

  it('filtre sur plusieurs actions (OR)', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, actions: ['Heartbeat', 'BootNotification'] });
    expect(msgs.length).toBe(2);
  });

  it('filtre LIKE insensible à la casse', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, actions: ['heartbeat'] });
    expect(msgs.length).toBe(1);
  });

  it('retourne tous les messages si actions est vide', () => {
    const msgs = db.getOcppMessages({ chargepoint_id: cpId, actions: [] });
    expect(msgs.length).toBe(3);
  });
});

// ── getDashboardChartData / getChargingKpi ──
describe('database — getDashboardChartData / getChargingKpi', () => {
  let cpId;
  const TODAY = new Date().toISOString().slice(0, 19) + 'Z';

  beforeAll(() => {
    db.upsertChargepoint('CP-KPI-TEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-KPI-TEST').id;
    db.getDb().prepare('INSERT OR IGNORE INTO connectors (chargepoint_id, connector_id) VALUES (?,?)').run(cpId, 1);
    db.getDb().prepare('INSERT OR IGNORE INTO connectors (chargepoint_id, connector_id) VALUES (?,?)').run(cpId, 2);

    // Transaction complétée : meter_start=0, meter_stop=5000 => 5 kWh
    const tx1 = db.createTransaction(cpId, 1, 'TAG-KPI', 0, TODAY, 'rfid');
    db.stopTransaction(tx1.transaction_id, 5000, TODAY, 'Local');

    // Transaction active : energy = 2000 Wh net => 2 kWh
    const tx2 = db.createTransaction(cpId, 2, 'TAG-KPI', 0, TODAY, 'rfid');
    db.updateTransactionPowerEnergy(tx2.transaction_id, null, 2000);
  });

  describe('getDashboardChartData', () => {
    it('inclut les transactions actives et complétées dans tx_count', () => {
      const { energyPerDay } = db.getDashboardChartData(null, 7);
      const total = energyPerDay.reduce((s, d) => s + d.tx_count, 0);
      expect(total).toBeGreaterThanOrEqual(2);
    });

    it('inclut l\'énergie des transactions actives dans energy_kwh', () => {
      const { energyPerDay } = db.getDashboardChartData(null, 7);
      const totalKwh = energyPerDay.reduce((s, d) => s + d.energy_kwh, 0);
      expect(totalKwh).toBeGreaterThanOrEqual(7.0);
    });

    it('days=0 retourne au moins autant de données que days=7', () => {
      const r7 = db.getDashboardChartData(null, 7);
      const r0 = db.getDashboardChartData(null, 0);
      const count7 = r7.energyPerDay.reduce((s, d) => s + d.tx_count, 0);
      const count0 = r0.energyPerDay.reduce((s, d) => s + d.tx_count, 0);
      expect(count0).toBeGreaterThanOrEqual(count7);
    });

    it('retourne tableau vide si aucune transaction dans la plage', () => {
      const { energyPerDay } = db.getDashboardChartData([999999], 7);
      expect(energyPerDay).toEqual([]);
    });
  });

  describe('getChargingKpi', () => {
    it('totalSessions inclut les transactions actives', () => {
      const { period } = db.getChargingKpi(null, 7);
      expect(period.totalSessions).toBeGreaterThanOrEqual(2);
    });

    it('totalEnergy inclut l\'énergie des transactions actives', () => {
      const { period } = db.getChargingKpi(null, 7);
      expect(period.totalEnergy).toBeGreaterThanOrEqual(7.0);
    });

    it('avgEnergy ne tient compte que des transactions complétées', () => {
      const { period } = db.getChargingKpi(null, 7);
      // La transaction complétée vaut 5 kWh, l'active est exclue de la moyenne
      expect(period.avgEnergy).toBeCloseTo(5.0, 1);
    });

    it('days=0 retourne au moins autant de sessions que days=7', () => {
      const r7 = db.getChargingKpi(null, 7);
      const r0 = db.getChargingKpi(null, 0);
      expect(r0.period.totalSessions).toBeGreaterThanOrEqual(r7.period.totalSessions);
    });

    it('allTime inclut les transactions actives', () => {
      const { allTime } = db.getChargingKpi(null, 30);
      expect(allTime.totalSessions).toBeGreaterThanOrEqual(2);
      expect(allTime.totalEnergy).toBeGreaterThanOrEqual(7.0);
    });
  });
});

// ── Meter Values ──
describe('database — meter values', () => {
  let cpId;

  beforeAll(() => {
    db.upsertChargepoint('CP-METER-TEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-METER-TEST').id;
    db.upsertConnector(cpId, 1, 'Available', 'NoError', null, null, null);
    db.upsertConnector(cpId, 2, 'Available', 'NoError', null, null, null);
  });

  it('updateConnectorMeterValue met à jour meter_value du connecteur', () => {
    db.updateConnectorMeterValue(cpId, 1, 15000);
    const connectors = db.getConnectorsByChargepoint(cpId);
    const cn1 = connectors.find((c) => c.connector_id === 1);
    expect(cn1.meter_value).toBe(15000);
  });

  it('updateConnectorMeterValue recalcule chargepoints.meter_value (SUM)', () => {
    db.updateConnectorMeterValue(cpId, 2, 5000);
    const cp = db.getChargepointById(cpId);
    expect(cp.meter_value).toBe(20000);
  });

  it('recalcChargepointMeterValue exclut les connecteurs à 0', () => {
    db.upsertChargepoint('CP-METER-ZERO', { cpstatus: 'Available', connected: 0 });
    const zeroId = db.getChargepointByIdentity('CP-METER-ZERO').id;
    db.upsertConnector(zeroId, 1, 'Available', 'NoError', null, null, null);
    db.upsertConnector(zeroId, 2, 'Available', 'NoError', null, null, null);
    db.updateConnectorMeterValue(zeroId, 1, 8000);
    // connector 2 reste à 0 (DEFAULT) → exclu du SUM
    db.recalcChargepointMeterValue(zeroId);
    const cp = db.getChargepointById(zeroId);
    expect(cp.meter_value).toBe(8000);
  });

  it('updateChargepointMeterValue écrit directement dans chargepoints', () => {
    db.updateChargepointMeterValue(cpId, 99999);
    const cp = db.getChargepointById(cpId);
    expect(cp.meter_value).toBe(99999);
  });
});

// ── getTransactions — pagination ──
describe('database — getTransactions pagination', () => {
  let cpId;
  const START = '2026-01-01T10:00:00Z';
  const STOP  = '2026-01-01T11:00:00Z';

  beforeAll(() => {
    db.upsertChargepoint('CP-PAGTEST', { cpstatus: 'Available', connected: 0 });
    cpId = db.getChargepointByIdentity('CP-PAGTEST').id;
    for (let i = 0; i < 5; i++) {
      const tx = db.createTransaction(cpId, 1, 'TAG-PAG', i * 100, START, 'local');
      if (i < 3) db.stopTransaction(tx.transaction_id, (i + 1) * 100, STOP, 'Local');
    }
  });

  it('retourne { data, total, stats } quand limit est fourni', () => {
    const result = db.getTransactions({ chargepoint_id: cpId, limit: 10, offset: 0 });
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('stats');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(5);
  });

  it('applique correctement LIMIT et OFFSET', () => {
    const page1 = db.getTransactions({ chargepoint_id: cpId, limit: 2, offset: 0 });
    const page2 = db.getTransactions({ chargepoint_id: cpId, limit: 2, offset: 2 });
    expect(page1.data.length).toBe(2);
    expect(page2.data.length).toBe(2);
    expect(page1.data[0].id).not.toBe(page2.data[0].id);
    expect(page1.total).toBe(page2.total);
  });

  it('stats.activeCount est correct', () => {
    const result = db.getTransactions({ chargepoint_id: cpId, limit: 50, offset: 0 });
    expect(result.stats.activeCount).toBe(2);
  });

  it('retourne un tableau brut sans limit (rétrocompat CSV)', () => {
    const result = db.getTransactions({ chargepoint_id: cpId });
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── Error Events ──
describe('database — Error Events', () => {
  let cpId;

  beforeAll(() => {
    const site = db.createSite('EE Site', '1 Error Street');
    const cp = db.upsertChargepoint('EE-CP-001', { cpstatus: 'Available' });
    cpId = db.getChargepointByIdentity('EE-CP-001').id;
    db.assignChargepointToSite(cpId, site.id);
  });

  it('insère un status_error 1.6 avec tous les champs', () => {
    db.insertErrorEvent(cpId, 'status_error', {
      ocpp_version: '1.6',
      connector_id: 1,
      status: 'Faulted',
      error_code: 'GroundFailure',
      vendor_id: 'ACME',
      vendor_error_code: 'E42',
      info: 'Ground fault detected',
    });
    const events = db.getErrorEvents({ chargepoint_id: cpId });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const e = events[0];
    expect(e.event_type).toBe('status_error');
    expect(e.ocpp_version).toBe('1.6');
    expect(e.connector_id).toBe(1);
    expect(e.status).toBe('Faulted');
    expect(e.error_code).toBe('GroundFailure');
    expect(e.vendor_id).toBe('ACME');
    expect(e.vendor_error_code).toBe('E42');
    expect(e.info).toBe('Ground fault detected');
  });

  it('insère un disconnect sans champs optionnels', () => {
    db.insertErrorEvent(cpId, 'disconnect', { ocpp_version: '1.6' });
    const events = db.getErrorEvents({ chargepoint_id: cpId, event_type: 'disconnect' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event_type).toBe('disconnect');
    expect(events[0].connector_id).toBeNull();
    expect(events[0].error_code).toBeNull();
  });

  it('insère un heartbeat_timeout', () => {
    db.insertErrorEvent(cpId, 'heartbeat_timeout', { ocpp_version: '1.6' });
    const events = db.getErrorEvents({ chargepoint_id: cpId, event_type: 'heartbeat_timeout' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event_type).toBe('heartbeat_timeout');
  });

  it('insère un événement 2.0.1 avec evse_id, component, variable, severity, tech_code', () => {
    db.insertErrorEvent(cpId, 'status_error', {
      ocpp_version: '2.0.1',
      evse_id: 1,
      component: 'Connector',
      variable: 'AvailabilityState',
      severity: 2,
      tech_code: 'GFI_FAULT',
      tech_info: 'Ground fault interrupt triggered',
      info: '0',
    });
    const events = db.getErrorEvents({ chargepoint_id: cpId, ocpp_version: '2.0.1' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const e = events[0];
    expect(e.ocpp_version).toBe('2.0.1');
    expect(e.evse_id).toBe(1);
    expect(e.component).toBe('Connector');
    expect(e.severity).toBe(2);
    expect(e.tech_code).toBe('GFI_FAULT');
  });

  it('filtre par event_type', () => {
    const statusErrors = db.getErrorEvents({ chargepoint_id: cpId, event_type: 'status_error' });
    expect(statusErrors.every(e => e.event_type === 'status_error')).toBe(true);
  });

  it('filtre par ocpp_version', () => {
    const v16 = db.getErrorEvents({ chargepoint_id: cpId, ocpp_version: '1.6' });
    expect(v16.every(e => e.ocpp_version === '1.6')).toBe(true);
    const v201 = db.getErrorEvents({ chargepoint_id: cpId, ocpp_version: '2.0.1' });
    expect(v201.every(e => e.ocpp_version === '2.0.1')).toBe(true);
  });

  it('retourne les résultats dans l\'ordre décroissant (id DESC)', () => {
    const events = db.getErrorEvents({ chargepoint_id: cpId });
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i].id).toBeGreaterThan(events[i + 1].id);
    }
  });

  it('respecte limit et offset', () => {
    const all = db.getErrorEvents({ chargepoint_id: cpId });
    const page1 = db.getErrorEvents({ chargepoint_id: cpId, limit: 2, offset: 0 });
    const page2 = db.getErrorEvents({ chargepoint_id: cpId, limit: 2, offset: 2 });
    expect(page1.length).toBe(Math.min(2, all.length));
    if (all.length > 2) {
      expect(page1[0].id).not.toBe(page2[0].id);
    }
  });

  it('filtre par site_ids — exclut les bornes hors site', () => {
    const cp2 = db.upsertChargepoint('EE-CP-002', { cpstatus: 'Available' });
    const cp2Id = db.getChargepointByIdentity('EE-CP-002').id;
    db.insertErrorEvent(cp2Id, 'disconnect', { ocpp_version: '1.6' });
    // Filtrer sur un site_id qui n'inclut pas cp2
    const events = db.getErrorEvents({ chargepoint_id: cpId });
    expect(events.every(e => e.chargepoint_id === cpId)).toBe(true);
  });

  it('inclut identity et cpname dans les résultats', () => {
    const events = db.getErrorEvents({ chargepoint_id: cpId });
    expect(events[0]).toHaveProperty('chargepoint_identity');
    expect(events[0].chargepoint_identity).toBe('EE-CP-001');
  });
});

// ── Transaction Values (nouvelles métriques) ──
describe('database — Transaction Values (nouvelles métriques)', () => {
  let cpId;
  let txId;

  beforeAll(() => {
    db.upsertChargepoint('TV-CP-001', { cpstatus: 'Available' });
    cpId = db.getChargepointByIdentity('TV-CP-001').id;
    const tx = db.createTransaction(cpId, 1, 'TV-TAG', 0, '2026-01-01T10:00:00Z', 'local');
    txId = tx.transaction_id;
  });

  it('insère une entrée temperature (INSERT)', () => {
    db.upsertTransactionValues(txId, { tempEntry: { x: 1000, y: 42.5 } });
    const row = db.getTransactionValues(txId);
    const temp = JSON.parse(row.temperature);
    expect(temp).toHaveLength(1);
    expect(temp[0]).toEqual({ x: 1000, y: 42.5 });
  });

  it('appende une entrée temperature (UPDATE)', () => {
    db.upsertTransactionValues(txId, { tempEntry: { x: 1060, y: 43.1 } });
    const row = db.getTransactionValues(txId);
    const temp = JSON.parse(row.temperature);
    expect(temp).toHaveLength(2);
    expect(temp[1].y).toBeCloseTo(43.1);
  });

  it('insère une entrée tension triphasée', () => {
    db.upsertTransactionValues(txId, { tensionEntry: { x: 1000, l1: 230.1, l2: 229.8, l3: 231.0 } });
    const row = db.getTransactionValues(txId);
    const tension = JSON.parse(row.tension);
    expect(tension).toHaveLength(1);
    expect(tension[0].l1).toBeCloseTo(230.1);
    expect(tension[0].l2).toBeCloseTo(229.8);
    expect(tension[0].l3).toBeCloseTo(231.0);
  });

  it('appende une entrée tension (UPDATE)', () => {
    db.upsertTransactionValues(txId, { tensionEntry: { x: 1060, l1: 228.5, l2: null, l3: null } });
    const row = db.getTransactionValues(txId);
    const tension = JSON.parse(row.tension);
    expect(tension).toHaveLength(2);
  });

  it('insère une entrée frequence', () => {
    db.upsertTransactionValues(txId, { freqEntry: { x: 1000, y: 50.02 } });
    const row = db.getTransactionValues(txId);
    const freq = JSON.parse(row.frequence);
    expect(freq).toHaveLength(1);
    expect(freq[0].y).toBeCloseTo(50.02);
  });

  it('appende une entrée frequence (UPDATE)', () => {
    db.upsertTransactionValues(txId, { freqEntry: { x: 1060, y: 49.98 } });
    const row = db.getTransactionValues(txId);
    const freq = JSON.parse(row.frequence);
    expect(freq).toHaveLength(2);
  });

  it('insère toutes les nouvelles métriques en une seule opération', () => {
    const tx2 = db.createTransaction(cpId, 1, 'TV-TAG-2', 0, '2026-01-02T10:00:00Z', 'local');
    db.upsertTransactionValues(tx2.transaction_id, {
      tempEntry: { x: 2000, y: 35.0 },
      tensionEntry: { x: 2000, l1: 230.0, l2: null, l3: null },
      freqEntry: { x: 2000, y: 50.0 },
    });
    const row = db.getTransactionValues(tx2.transaction_id);
    expect(JSON.parse(row.temperature)).toHaveLength(1);
    expect(JSON.parse(row.tension)).toHaveLength(1);
    expect(JSON.parse(row.frequence)).toHaveLength(1);
  });

  it('les colonnes nouvelles restent null si non fournies', () => {
    const tx3 = db.createTransaction(cpId, 1, 'TV-TAG-3', 0, '2026-01-03T10:00:00Z', 'local');
    db.upsertTransactionValues(tx3.transaction_id, { energieEntry: { x: 3000, power: 7000, offer: null, energy: 100 } });
    const row = db.getTransactionValues(tx3.transaction_id);
    expect(row.temperature).toBeNull();
    expect(row.tension).toBeNull();
    expect(row.frequence).toBeNull();
  });
});

// ── getChargepointVariables ──
describe('database — getChargepointVariables', () => {
  let cpId;

  beforeAll(() => {
    const rawDb = db.getDb();
    const info = rawDb
      .prepare("INSERT INTO chargepoints (identity, ocpp_version) VALUES ('VAR-CP-001', '2.0.1')")
      .run();
    cpId = info.lastInsertRowid;
    db.upsertChargepointVariable(cpId, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '600');
    db.upsertChargepointVariable(cpId, 'TxCtrlr', 'EVConnectionTimeOut', 'Actual', '60');
  });

  it('returns all variables for the chargepoint', () => {
    const vars = db.getChargepointVariables(cpId);
    expect(vars.length).toBeGreaterThanOrEqual(2);
    expect(vars.some((v) => v.component === 'OCPPCommCtrlr' && v.variable === 'HeartbeatInterval')).toBe(true);
  });

  it('returns empty array for unknown chargepoint', () => {
    const vars = db.getChargepointVariables(999999);
    expect(vars).toEqual([]);
  });

  it('returns rows ordered by component, variable, attribute', () => {
    const vars = db.getChargepointVariables(cpId);
    const sorted = [...vars].sort((a, b) =>
      a.component.localeCompare(b.component) || a.variable.localeCompare(b.variable)
    );
    expect(vars.map((v) => v.id)).toEqual(sorted.map((v) => v.id));
  });
});

// ── getEvsesByChargepoint ──
describe('database — getEvsesByChargepoint', () => {
  let cpId;

  beforeAll(() => {
    const rawDb = db.getDb();
    const info = rawDb
      .prepare("INSERT INTO chargepoints (identity, ocpp_version) VALUES ('EVSE-CP-001', '2.0.1')")
      .run();
    cpId = info.lastInsertRowid;
    db.upsertEvse(cpId, 1, 'Available');
    db.upsertEvse(cpId, 2, 'Charging');
  });

  it('returns EVSEs for chargepoint', () => {
    const evses = db.getEvsesByChargepoint(cpId);
    expect(evses.length).toBe(2);
    expect(evses[0].evse_id).toBe(1);
    expect(evses[1].evse_id).toBe(2);
  });

  it('returns empty array for unknown chargepoint', () => {
    expect(db.getEvsesByChargepoint(999999)).toEqual([]);
  });

  it('updates EVSE status on upsert', () => {
    db.upsertEvse(cpId, 1, 'Faulted');
    const evses = db.getEvsesByChargepoint(cpId);
    const evse1 = evses.find((e) => e.evse_id === 1);
    expect(evse1.status).toBe('Faulted');
  });
});

// ── chargepoint_init_variables CRUD ──
describe('database — Init Variables CRUD (OCPP 2.0.1)', () => {
  let entryId;
  // Utiliser un composant/variable unique pour éviter le conflit avec les données initiales
  const TEST_COMPONENT = 'TestCtrlr';
  const TEST_VARIABLE = 'TestInterval';

  it('creates an init variable entry', () => {
    const result = db.createInitialChargepointVariable(
      TEST_COMPONENT,
      TEST_VARIABLE,
      'Actual',
      '999',
      true
    );
    expect(result.changes).toBe(1);
    entryId = result.lastInsertRowid;
  });

  it('gets all init variable entries', () => {
    const rows = db.getInitialChargepointVariables();
    expect(rows.some((r) => r.component === TEST_COMPONENT && r.variable === TEST_VARIABLE)).toBe(true);
  });

  it('gets only enabled entries', () => {
    db.createInitialChargepointVariable(TEST_COMPONENT, 'TestDisabled', 'Actual', '0', false);
    const enabled = db.getEnabledInitialChargepointVariables();
    expect(enabled.some((r) => r.variable === TEST_VARIABLE)).toBe(true);
    expect(enabled.some((r) => r.variable === 'TestDisabled')).toBe(false);
  });

  it('updates an init variable entry', () => {
    db.updateInitialChargepointVariable(entryId, { value: '300' });
    const rows = db.getInitialChargepointVariables();
    const entry = rows.find((r) => r.id === entryId);
    expect(entry.value).toBe('300');
  });

  it('toggles enabled flag', () => {
    db.updateInitialChargepointVariable(entryId, { enabled: false });
    const rows = db.getInitialChargepointVariables();
    const entry = rows.find((r) => r.id === entryId);
    expect(entry.enabled).toBe(0);
  });

  it('deletes an init variable entry', () => {
    db.deleteInitialChargepointVariable(entryId);
    const rows = db.getInitialChargepointVariables();
    expect(rows.some((r) => r.id === entryId)).toBe(false);
  });
});

describe('database — getInitialChargepointVariableByKey', () => {
  it('returns the variable when it exists (seeded by migration)', () => {
    const row = db.getInitialChargepointVariableByKey('OCPPCommCtrlr', 'HeartbeatInterval');
    expect(row).not.toBeNull();
    expect(row.component).toBe('OCPPCommCtrlr');
    expect(row.variable).toBe('HeartbeatInterval');
    expect(row.attribute).toBe('Actual');
  });

  it('returns undefined for an unknown key', () => {
    const row = db.getInitialChargepointVariableByKey('Unknown', 'NonExistent');
    expect(row).toBeUndefined();
  });
});
