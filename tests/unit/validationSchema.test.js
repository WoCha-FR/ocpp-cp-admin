'use strict';

const { checkSchema, validationResult } = require('express-validator');
const schema = require('../../src/validationSchema');

async function runSchema(schemaObj, body) {
  const req = { body, params: {}, query: {}, headers: {} };
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
