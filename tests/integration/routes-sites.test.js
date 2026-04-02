'use strict';

const request = require('supertest');
const { createTestApp } = require('../helpers/app-factory');

let app, db;

async function loginAs(agent, email, password) {
  const meRes = await agent.get('/api/auth/me');
  const cookies = (meRes.headers['set-cookie'] || []).join('; ');
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  const csrf = match ? decodeURIComponent(match[1]) : null;
  await agent
    .post('/api/auth/login')
    .set('x-xsrf-token', csrf)
    .send({ useremail: email, password });
  return csrf;
}

beforeEach(() => {
  ({ app, db } = createTestApp());
});

afterEach(() => {
  db.close();
});

describe('GET /api/sites', () => {
  it('returns 401 if not authenticated', async () => {
    const res = await request(app).get('/api/sites');
    expect(res.status).toBe(401);
  });

  it('admin sees all sites', async () => {
    db.prepare('INSERT INTO sites (sname) VALUES (?)').run('SiteAlpha');
    db.prepare('INSERT INTO sites (sname) VALUES (?)').run('SiteBeta');

    const agent = request.agent(app);
    await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent.get('/api/sites');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('regular user sees only their sites', async () => {
    const s1 = db.prepare("INSERT INTO sites (sname) VALUES ('UserSite')").run();
    db.prepare("INSERT INTO sites (sname) VALUES ('OtherSite')").run();
    const user = db.prepare("SELECT * FROM users WHERE useremail = 'user@test.com'").get();
    db.prepare('INSERT INTO user_sites (user_id, site_id, role, authorized) VALUES (?,?,?,?)').run(
      user.id,
      s1.lastInsertRowid,
      'user',
      1
    );

    const agent = request.agent(app);
    await loginAs(agent, 'user@test.com', 'User!1234');

    const res = await agent.get('/api/sites');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sname).toBe('UserSite');
  });
});

describe('POST /api/sites', () => {
  it('returns 401 if not authenticated', async () => {
    const agent = request.agent(app);
    const meRes = await agent.get('/api/auth/me');
    const cookies = (meRes.headers['set-cookie'] || []).join('; ');
    const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
    const csrf = match ? decodeURIComponent(match[1]) : null;
    const res = await agent
      .post('/api/sites')
      .set('x-xsrf-token', csrf)
      .send({ name: 'New Site' });
    expect(res.status).toBe(401);
  });

  it('admin can create a site', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent
      .post('/api/sites')
      .set('x-xsrf-token', csrf)
      .send({ name: 'Brand New Site' });
    expect(res.status).toBe(201);
    expect(res.body.sname).toBe('Brand New Site');
  });

  it('returns 400 for site name too short', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'admin@test.com', 'Admin!123');

    const res = await agent
      .post('/api/sites')
      .set('x-xsrf-token', csrf)
      .send({ name: 'AB' });
    expect(res.status).toBe(400);
  });

  it('non-admin gets 403', async () => {
    const agent = request.agent(app);
    const csrf = await loginAs(agent, 'user@test.com', 'User!1234');

    const res = await agent
      .post('/api/sites')
      .set('x-xsrf-token', csrf)
      .send({ name: 'Unauthorized Site' });
    expect(res.status).toBe(403);
  });
});
