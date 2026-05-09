'use strict';

const fs = require('fs');
const path = require('path');

describe('Backend access control guards', () => {
  const routesPath = path.join(__dirname, '../../src/routes.js');

  it('protects GET /sites/:id with per-site authorization check', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/router\.get\('\/sites\/:id'/);
    expect(src).toMatch(/const siteIds = getUserSiteIds\(req\)/);
    expect(src).toMatch(/siteIds !== null && !siteIds\.includes\(siteId\)/);
    expect(src).toMatch(/ERR_ACCESS_DENIED/);
  });

  it('protects GET /id-tags/:id with managed-site authorization check', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/router\.get\('\/id-tags\/:id'/);
    expect(src).toMatch(/const managedSiteIds = getUserManagedSiteIds\(req\)/);
    expect(src).toMatch(/tag\.site_id && !managedSiteIds\.includes\(tag\.site_id\)/);
    expect(src).toMatch(/ERR_SITE_NOT_MANAGED/);
  });
});

