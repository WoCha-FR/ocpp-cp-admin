'use strict';

const request = require('supertest');
const { createTestApp } = require('../helpers/app-factory');

let app, db;

// Helper to get CSRF token via GET /api/auth/me
async function getCsrfToken(agent) {
  const res = await agent.get('/api/auth/me');
  const cookies = (res.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

beforeEach(() => {
  ({ app, db } = createTestApp());
});

afterEach(() => {
  db.close();
});

describe('POST /api/auth/login', () => {
  it('returns 200 and user data on valid credentials', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent
      .post('/api/auth/login')
      .set('x-xsrf-token', csrf)
      .send({ useremail: 'admin@test.com', password: 'Admin!123' });
    expect(res.status).toBe(200);
    expect(res.body.useremail).toBe('admin@test.com');
    expect(res.body.role).toBe('admin');
  });

  it('returns 401 on wrong password', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent
      .post('/api/auth/login')
      .set('x-xsrf-token', csrf)
      .send({ useremail: 'admin@test.com', password: 'WrongPass!1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ERR_WRONG_PASSWORD');
  });

  it('returns 401 on unknown user', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent
      .post('/api/auth/login')
      .set('x-xsrf-token', csrf)
      .send({ useremail: 'nobody@test.com', password: 'Admin!123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ERR_UNKNOWN_USER');
  });

  it('returns 403 on missing CSRF token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ useremail: 'admin@test.com', password: 'Admin!123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_invalid');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user info when authenticated', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    await agent
      .post('/api/auth/login')
      .set('x-xsrf-token', csrf)
      .send({ useremail: 'admin@test.com', password: 'Admin!123' });

    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.useremail).toBe('admin@test.com');
  });
});

describe('POST /api/auth/logout', () => {
  it('destroys session and /me returns 401 after logout', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    await agent
      .post('/api/auth/login')
      .set('x-xsrf-token', csrf)
      .send({ useremail: 'admin@test.com', password: 'Admin!123' });

    const logoutRes = await agent.post('/api/auth/logout').set('x-xsrf-token', csrf);
    expect(logoutRes.status).toBe(200);

    const meRes = await agent.get('/api/auth/me');
    expect(meRes.status).toBe(401);
  });
});
