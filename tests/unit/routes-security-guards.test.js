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

  it('protects DELETE /id-tags-events/:id with requireManager and managed-site authorization check', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/router\.delete\(\s*'\/id-tags-events\/:id',\s*requireManager/);
    expect(src).toMatch(/const managedSiteIds = getUserManagedSiteIds\(req\)/);
    expect(src).toMatch(/!existing\.site_id \|\| !managedSiteIds\.includes\(existing\.site_id\)/);
    expect(src).toMatch(/ERR_SITE_NOT_MANAGED/);
  });

  it('protects DELETE /error-events/:id with requireManager and managed-site authorization check', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/router\.delete\(\s*'\/error-events\/:id',\s*requireManager/);
    expect(src).toMatch(/const managedSiteIds = getUserManagedSiteIds\(req\)/);
    expect(src).toMatch(/!existing\.site_id \|\| !managedSiteIds\.includes\(existing\.site_id\)/);
    expect(src).toMatch(/ERR_SITE_NOT_MANAGED/);
  });

  it('protects GET/PUT /sites/:siteId/tariff with requireManager and managed-site check', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/router\.get\(\s*'\/sites\/:siteId\/tariff',\s*requireManager/);
    expect(src).toMatch(/router\.put\(\s*'\/sites\/:siteId\/tariff',\s*requireManager/);
    const helper = src.slice(src.indexOf('function assertSiteManaged'));
    expect(helper).toMatch(/const managedIds = getUserManagedSiteIds\(req\)/);
    expect(helper).toMatch(/!managedIds\.includes\(siteId\)/);
    expect(helper).toMatch(/ERR_SITE_NOT_MANAGED/);
    // la route PUT valide la grille avant de l'enregistrer
    expect(src).toMatch(/tariff\.validateTariff\(input\)/);
  });

  it('restricts GET /transactions/:id (+ /values) to admin, site manager or tag owner', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const helper = src.slice(src.indexOf('function canViewTransaction'));
    expect(helper).toMatch(/req\.user\.role === 'admin'/);
    expect(helper).toMatch(/tx\.tag_user_id === req\.user\.id/);
    expect(helper).toMatch(/managedIds\.includes\(cp\.site_id\)/);
    const detail = src.slice(src.indexOf("router.get('/transactions/:id',"));
    expect(detail.slice(0, 500)).toMatch(/canViewTransaction\(req, tx\)/);
    const values = src.slice(src.indexOf("'/transactions/:id/values'"));
    // Transaction inconnue → 404 (plus de relevés servis sans contrôle d'accès)
    expect(values.slice(0, 600)).toMatch(/if \(!tx\) return res\.status\(404\)/);
    expect(values.slice(0, 600)).toMatch(/canViewTransaction\(req, tx\)/);
  });
});
