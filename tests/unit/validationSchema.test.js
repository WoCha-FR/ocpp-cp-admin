'use strict';

const { checkSchema, validationResult } = require('express-validator');
const schema = require('../../src/validationSchema');

async function runSchema(schemaObj, body, params = {}, query = {}) {
  const req = { body, params, query, headers: {} };
  const middleware = checkSchema(schemaObj);
  // express-validator v7: middleware is an array of handlers
  for (const fn of middleware) {
    await new Promise((resolve) => fn(req, {}, resolve));
  }
  return validationResult(req);
}

// ── User ──
describe('validationSchema — User', () => {
  it('passes with valid data', async () => {
    const result = await runSchema(schema.User, {
      useremail: 'user@example.com',
      password: 'Str0ng!Pass',
      shortname: 'John',
    });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with invalid email', async () => {
    const result = await runSchema(schema.User, {
      useremail: 'not-an-email',
      password: 'Str0ng!Pass',
      shortname: 'John',
    });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_USER_EMAIL_INVALID');
  });

  it('fails with short password', async () => {
    const result = await runSchema(schema.User, {
      useremail: 'user@example.com',
      password: '123',
      shortname: 'John',
    });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_USER_PASSWORD');
  });

  it('fails with shortname too short', async () => {
    const result = await runSchema(schema.User, {
      useremail: 'user@example.com',
      password: 'Str0ng!Pass',
      shortname: 'J',
    });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_USER_SHORTNAME');
  });
});

// ── Site ──
describe('validationSchema — Site', () => {
  it('passes with valid name', async () => {
    const result = await runSchema(schema.Site, { name: 'Site ABC' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with name too short', async () => {
    const result = await runSchema(schema.Site, { name: 'AB' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_SITE_NAME');
  });

  it('fails with special characters in name', async () => {
    const result = await runSchema(schema.Site, { name: 'Site <script>' });
    expect(result.isEmpty()).toBe(false);
  });
});

// ── ChargePoint ──
describe('validationSchema — ChargePoint', () => {
  it('passes with valid uppercase identity', async () => {
    const result = await runSchema(schema.ChargePoint, {
      identity: 'EVSE001',
      name: 'Station A',
      mode: 1,
      site_id: 1,
    });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with lowercase identity', async () => {
    const result = await runSchema(schema.ChargePoint, {
      identity: 'evse001',
      name: 'Station A',
      mode: 1,
      site_id: 1,
    });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CHARGEPOINT_IDENTITY');
  });

  it('fails with identity too short', async () => {
    const result = await runSchema(schema.ChargePoint, {
      identity: 'EV',
      name: 'Station A',
      mode: 1,
      site_id: 1,
    });
    expect(result.isEmpty()).toBe(false);
  });

  it('fails with invalid mode', async () => {
    const result = await runSchema(schema.ChargePoint, {
      identity: 'EVSE001',
      name: 'Station A',
      mode: 99,
      site_id: 1,
    });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CHARGEPOINT_MODE');
  });

  it('passes with & and + in name', async () => {
    const result = await runSchema(schema.ChargePoint, {
      identity: 'VALIDCP01',
      mode: 1,
      site_id: 1,
      name: 'Snug & Co+',
    });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with script tag in name', async () => {
    const result = await runSchema(schema.ChargePoint, {
      identity: 'VALIDCP01',
      mode: 1,
      site_id: 1,
      name: '<script>alert(1)</script>',
    });
    expect(result.isEmpty()).toBe(false);
  });
});

// ── Login ──
describe('validationSchema — Login', () => {
  it('passes with valid credentials', async () => {
    const result = await runSchema(schema.Login, {
      useremail: 'admin@example.com',
      password: 'mypassword123',
    });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with empty password', async () => {
    const result = await runSchema(schema.Login, {
      useremail: 'admin@example.com',
      password: '',
    });
    expect(result.isEmpty()).toBe(false);
  });
});

// ── IdTag ──
describe('validationSchema — IdTag', () => {
  it('passes with valid id_tag', async () => {
    const result = await runSchema(schema.IdTag, { id_tag: 'ABC123DEF456' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with id_tag too short', async () => {
    const result = await runSchema(schema.IdTag, { id_tag: 'AB' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_IDTAG_FORMAT');
  });

  it('fails with special chars in id_tag', async () => {
    const result = await runSchema(schema.IdTag, { id_tag: 'AB-12345' });
    expect(result.isEmpty()).toBe(false);
  });
});

// ── CreateReservation ──
describe('validationSchema — CreateReservation', () => {
  const VALID = {
    connector_id: 1,
    id_tag: 'RFID001',
    expiry_date: '2030-06-01T10:00:00Z',
  };

  it('passes with valid data', async () => {
    const result = await runSchema(schema.CreateReservation, VALID);
    expect(result.isEmpty()).toBe(true);
  });

  it('fails when connector_id is 0 (must be >= 1)', async () => {
    const result = await runSchema(schema.CreateReservation, { ...VALID, connector_id: 0 });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_ID');
  });

  it('fails when connector_id is missing', async () => {
    const result = await runSchema(schema.CreateReservation, { ...VALID, connector_id: undefined });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_ID');
  });

  it('fails when id_tag is empty', async () => {
    const result = await runSchema(schema.CreateReservation, { ...VALID, id_tag: '' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_ID_TAG');
  });

  it('fails when id_tag exceeds 20 chars', async () => {
    const result = await runSchema(schema.CreateReservation, { ...VALID, id_tag: 'A'.repeat(21) });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_ID_TAG');
  });

  it('fails when expiry_date is not ISO8601', async () => {
    const result = await runSchema(schema.CreateReservation, { ...VALID, expiry_date: '01/06/2030' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_EXPIRY_DATE');
  });

  it('fails when expiry_date is missing', async () => {
    const result = await runSchema(schema.CreateReservation, { ...VALID, expiry_date: undefined });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_EXPIRY_DATE');
  });
});

// ── ConnectorDetails ──
describe('validationSchema — ConnectorDetails', () => {
  const VALID = { connector_name: 'Borne A', connector_power: 22, connector_type: 'Type2' };

  it('passes with valid data', async () => {
    const result = await runSchema(schema.ConnectorDetails, VALID);
    expect(result.isEmpty()).toBe(true);
  });

  it('passes when connector_name is absent (optional)', async () => {
    const { connector_name, ...rest } = VALID;
    const result = await runSchema(schema.ConnectorDetails, rest);
    expect(result.isEmpty()).toBe(true);
  });

  it('passes when connector_name is empty string', async () => {
    const result = await runSchema(schema.ConnectorDetails, { ...VALID, connector_name: '' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails when connector_name exceeds 50 characters', async () => {
    const result = await runSchema(schema.ConnectorDetails, { ...VALID, connector_name: 'A'.repeat(51) });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_NAME');
  });

  it('fails when connector_name contains forbidden characters', async () => {
    const result = await runSchema(schema.ConnectorDetails, { ...VALID, connector_name: 'Borne@A!' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_NAME');
  });

  it('fails when connector_power is absent', async () => {
    const { connector_power, ...rest } = VALID;
    const result = await runSchema(schema.ConnectorDetails, rest);
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_POWER');
  });

  it('fails when connector_power is 0 (must be >= 1)', async () => {
    const result = await runSchema(schema.ConnectorDetails, { ...VALID, connector_power: 0 });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_POWER');
  });

  it('fails when connector_power exceeds 900', async () => {
    const result = await runSchema(schema.ConnectorDetails, { ...VALID, connector_power: 901 });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_CONNECTOR_POWER');
  });
});

// ── ReservationIdParam ──
describe('validationSchema — ReservationIdParam', () => {
  it('passes with valid integer id in params', async () => {
    const result = await runSchema(schema.ReservationIdParam, {}, { reservationId: '42' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails when reservationId is 0', async () => {
    const result = await runSchema(schema.ReservationIdParam, {}, { reservationId: '0' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_ID');
  });

  it('fails when reservationId is not a number', async () => {
    const result = await runSchema(schema.ReservationIdParam, {}, { reservationId: 'abc' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_ID');
  });

  it('fails when reservationId is missing', async () => {
    const result = await runSchema(schema.ReservationIdParam, {}, {});
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_ID');
  });
});

// ── OcppMessagesQuery ──
describe('validationSchema — OcppMessagesQuery', () => {
  it('passes with no filters', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, {});
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with valid date_from and date_to', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, { date_from: '2026-05-20', date_to: '2026-05-20' });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with date_from and date_to as datetime strings', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, { date_from: '2026-05-20 00:00:00', date_to: '2026-05-20 23:59:59' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with invalid date_from format', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, { date_from: 'not-a-date' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_DATE_FROM');
  });

  it('fails with date_to in wrong format (DD/MM/YYYY)', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, { date_to: '20/05/2026' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_DATE_TO');
  });

  it('passes with origin=system', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, { origin: 'system' });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with message_type=EVENT', async () => {
    const result = await runSchema(schema.OcppMessagesQuery, {}, {}, { message_type: 'EVENT' });
    expect(result.isEmpty()).toBe(true);
  });
});

// ── TransactionsQuery ──
describe('validationSchema — TransactionsQuery', () => {
  it('passes with valid page', async () => {
    const result = await runSchema(schema.TransactionsQuery, {}, {}, { page: '2' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with page = 0', async () => {
    const result = await runSchema(schema.TransactionsQuery, {}, {}, { page: '0' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_PAGE');
  });

  it('fails with page = abc', async () => {
    const result = await runSchema(schema.TransactionsQuery, {}, {}, { page: 'abc' });
    expect(result.isEmpty()).toBe(false);
  });

  it('passes with limit = all', async () => {
    const result = await runSchema(schema.TransactionsQuery, {}, {}, { limit: 'all' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with limit as arbitrary string', async () => {
    const result = await runSchema(schema.TransactionsQuery, {}, {}, { limit: 'beaucoup' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_LIMIT');
  });
});

// ── UserTransactionsQuery ──
describe('validationSchema — UserTransactionsQuery', () => {
  it('passes with valid limit and page', async () => {
    const result = await runSchema(schema.UserTransactionsQuery, {}, {}, { limit: '25', page: '3' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with limit > 200', async () => {
    const result = await runSchema(schema.UserTransactionsQuery, {}, {}, { limit: '201' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_LIMIT');
  });

  it('fails with page = -1', async () => {
    const result = await runSchema(schema.UserTransactionsQuery, {}, {}, { page: '-1' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_PAGE');
  });

  it('passes with limit = all', async () => {
    const result = await runSchema(schema.UserTransactionsQuery, {}, {}, { limit: 'all' });
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with limit as arbitrary string', async () => {
    const result = await runSchema(schema.UserTransactionsQuery, {}, {}, { limit: 'beaucoup' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_LIMIT');
  });
});

// ── EvseDetails ──
describe('validationSchema — EvseDetails', () => {
  it('passes with a valid alphanumeric name', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: 'EVSE 01' });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with accented characters', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: 'Borne Electrique' });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with hyphens and underscores', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: 'EVSE-1_A' });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with exactly 50 characters', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: 'A'.repeat(50) });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes with empty string', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: '' });
    expect(result.isEmpty()).toBe(true);
  });

  it('passes when evse_name is absent (optional)', async () => {
    const result = await runSchema(schema.EvseDetails, {});
    expect(result.isEmpty()).toBe(true);
  });

  it('fails with name containing special characters (XSS)', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: '<script>alert(1)</script>' });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_EVSE_NAME');
  });

  it('fails with name exceeding 50 characters', async () => {
    const result = await runSchema(schema.EvseDetails, { evse_name: 'A'.repeat(51) });
    expect(result.isEmpty()).toBe(false);
    expect(result.array().map((e) => e.msg)).toContain('VALIDATION_EVSE_NAME');
  });
});
