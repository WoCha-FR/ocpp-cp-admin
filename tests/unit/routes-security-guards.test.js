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

  it('protects GET /id-tags/:id with the badge policy (idTagPolicy.canAccessIdTag)', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const start = src.indexOf("router.get('/id-tags/:id'");
    expect(start).toBeGreaterThan(-1);
    const route = src.slice(start, src.indexOf('\n});', start));
    expect(route).toMatch(
      /canAccessIdTag\(idTagPolicyContext\(req\), tag, db\.getUserScope\(tag\.user_id\)\)/
    );
    expect(route).toMatch(/ERR_SITE_NOT_MANAGED/);
  });

  it('badges : liste filtrée, écriture contrôlée, code figé, suppression seulement si jamais utilisé', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const section = src.slice(
      src.indexOf("router.get('/id-tags', requireManager"),
      src.indexOf("//  ID TAGS EVENTS (rejets d'autorisation)")
    );
    // assignable-users déclarée avant /id-tags/:id (sinon capturée par le paramètre)
    expect(section.indexOf("'/id-tags/assignable-users'")).toBeGreaterThan(-1);
    expect(section.indexOf("'/id-tags/assignable-users'")).toBeLessThan(
      section.indexOf("'/id-tags/:id'")
    );
    expect(section).toMatch(/can_manage: !isGeneratedTag\(t\.id_tag\) && canAccessIdTag/);
    expect(section.match(/idTagWriteError\(idTagPolicyContext\(req\)/g)).toHaveLength(2);
    expect(section.match(/db\.hasIdTagScopeConflict\(/g)).toHaveLength(2);
    expect(section).toMatch(/isGeneratedTag\(data\.id_tag\)\) return res\.status\(400\)\.json\(\{ error: 'ERR_TAG_RESERVED' \}\)/);
    expect(section).toMatch(
      /data\.id_tag !== existing\.id_tag\) \{\s*return res\.status\(400\)\.json\(\{ error: 'ERR_TAG_CODE_IMMUTABLE' \}\)/
    );
    expect(section).toMatch(/db\.countIdTagSessions\(existing\)/);
    expect(section).toMatch(/status\(409\)\.json\(\{ error: 'ERR_TAG_USED', count: sessions \}\)/);
    // badges générés protégés côté serveur (modification et suppression), admin compris
    expect(section.match(/generatedTagError\(existing\.id_tag, '(update|delete)'\)/g)).toHaveLength(2);
  });

  it('borne sans site : démarrages web, gestionnaire et réservations refusés', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const helper = src.slice(src.indexOf('function getUserStartChargepoint'));
    expect(helper.slice(0, 400)).toMatch(
      /startBlockReason\(cp\)\) return \{ status: 409, error: 'ERR_CHARGEPOINT_NO_SITE' \}/
    );
    const blocked = /startBlockReason\(cp\)\) return res\.status\(409\)\.json\(\{ error: 'ERR_CHARGEPOINT_NO_SITE' \}\)/;
    for (const path of ["'/connectors/start-charge',", "'/chargepoints/:id/reservations',\n  requireManager,\n  ...validateSchema(schema.IdParam, schema.CreateReservation)"]) {
      const start = src.indexOf(path);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, start + 700)).toMatch(blocked);
    }
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

  it('pages de gestion : périmètre limité aux sites GÉRÉS (jamais aux sites où l’on est simple utilisateur)', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    // getUserSiteIds (tous les sites de l'utilisateur) n'est plus utilisé que par GET /sites et /sites/:id
    const uses = [...src.matchAll(/(?<!function )getUserSiteIds\(req\)/g)].map((m) => m.index);
    expect(uses).toHaveLength(2);
    for (const idx of uses) {
      const before = src.slice(0, idx);
      const route = before.slice(before.lastIndexOf('router.'));
      expect(route).toMatch(/^router\.get\('\/sites(\/:id)?', requireAuth/);
    }
    const filter = src.slice(src.indexOf('function filterBySite'));
    expect(filter.slice(0, 200)).toMatch(/getUserManagedSiteIds\(req\)/);
    for (const path of [
      "'/transactions',",
      "'/transactions/csv',",
      "'/ocpp-messages',",
      "'/ocpp-messages/csv',",
      "'/id-tags-events',",
      "'/error-events',",
      "'/dashboard/chart-data'",
      "'/dashboard/kpi'",
    ]) {
      const start = src.indexOf(path);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, start + 1500)).toMatch(/getUserManagedSiteIds\(req\)/);
    }
  });

  it('/user/stop-charge : titulaire figé de la session, pas le badge relu en direct', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const start = src.indexOf("'/user/stop-charge',");
    const route = src.slice(start, src.indexOf('\n);', start));
    expect(route).toMatch(/tx\.tag_user_id !== req\.user\.id/);
    expect(route).not.toMatch(/getIdTagByTag/);
  });

  it('restricts GET /transactions/:id (+ /values) to admin, site manager or tag owner', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const helper = src.slice(src.indexOf('function canViewTransaction'));
    expect(helper).toMatch(/req\.user\.role === 'admin'/);
    expect(helper).toMatch(/tx\.tag_user_id === req\.user\.id/);
    // site où la session a eu lieu (figé au démarrage), pas le site actuel de la borne
    expect(helper).toMatch(/managedIds\.includes\(tx\.site_id\)/);
    const detail = src.slice(src.indexOf("router.get('/transactions/:id',"));
    expect(detail.slice(0, 500)).toMatch(/canViewTransaction\(req, tx\)/);
    const values = src.slice(src.indexOf("'/transactions/:id/values'"));
    // Transaction inconnue → 404 (plus de relevés servis sans contrôle d'accès)
    expect(values.slice(0, 600)).toMatch(/if \(!tx\) return res\.status\(404\)/);
    expect(values.slice(0, 600)).toMatch(/canViewTransaction\(req, tx\)/);
  });

  it('POST /transactions/:id/close : requireManager + site géré, sans commande à la borne', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const start = src.indexOf("'/transactions/:id/close',");
    expect(start).toBeGreaterThan(-1);
    const route = src.slice(start, src.indexOf('\n);', start));
    expect(route).toMatch(/'\/transactions\/:id\/close',\s*requireManager/);
    expect(route).toMatch(/validateSchema\(schema\.IdParam\)/);
    expect(route).toMatch(/const managedIds = getUserManagedSiteIds\(req\)/);
    expect(route).toMatch(/!managedIds\.includes\(cp\.site_id\)/);
    expect(route).toMatch(/ERR_SITE_NOT_MANAGED/);
    expect(route).toMatch(/db\.closeTransactionManually\(tx\.id\)/);
    expect(route).toMatch(/status\(409\)\.json\(\{ error: 'ERR_TRANSACTION_NOT_ACTIVE' \}\)/);
    // clôture en base uniquement : aucune commande OCPP envoyée à la borne
    expect(route).not.toMatch(/remoteStopTransaction|callClient/);
  });

  it('POST /user/start-charge : badge contrôlé, pas de repli web si les badges sont invalides', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const start = src.indexOf("'/user/start-charge',");
    const route = src.slice(start, src.indexOf('remoteStartTransaction(', start));
    expect(route).toMatch(/validateSchema\(schema\.UserStartCharge\)/);
    expect(route).toMatch(/getUserStartChargepoint\(req, chargepoint_id\)/);
    expect(route).toMatch(/getUserStartTags\(req, cp\)/);
    // badge web automatique seulement quand l'utilisateur n'a aucun badge pour ce site, et si
    // le site l'autorise
    expect(route).toMatch(
      /if \(candidates === 0\) \{[\s\S]*?if \(!siteAllowsAutoWebBadge\(cp\)\) \{\s*return res\.status\(403\)\.json\(\{ error: 'ERR_NO_BADGE_FOR_SITE' \}\);\s*\}\s*idTag = `WEB-\$\{req\.user\.id\}`/
    );
    expect(route).toMatch(/usable\.length === 0\) \{[\s\S]*?ERR_NO_VALID_ID_TAG/);
    expect(route).toMatch(/!usable\.some\(\(t\) => t\.id_tag === requested\)/);
    expect(route).toMatch(/status\(409\)\.json\(\{ error: 'ERR_ID_TAG_CHOICE_REQUIRED' \}\)/);
    // plus de sélection « premier badge actif » sans contrôle d'expiration
    expect(route).not.toMatch(/getAllIdTags\(\)/);
    expect(route).not.toMatch(/userTags\[0\]/);
  });

  it('GET /user/start-charge/id-tags : même contrôle de site que le démarrage', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const start = src.indexOf("'/user/start-charge/id-tags',");
    const route = src.slice(start, start + 700);
    expect(route).toMatch(/requireAuth/);
    expect(route).toMatch(/getUserStartChargepoint\(req, req\.query\.chargepoint_id\)/);
    const helper = src.slice(src.indexOf('function getUserStartChargepoint'));
    expect(helper.slice(0, 900)).toMatch(/ERR_USER_NOT_AUTHORIZED_IN_SITE/);
    expect(src).toMatch(/ignoreUserSite: req\.user\.role === 'admin'/);
    // aucun badge et badge web interdit sur le site : signalé à l'interface
    expect(route).toMatch(/noBadge: candidates === 0 && !autoWebAllowed/);
  });
});

// ── Lot 3 : sites, bornes et comptes ──
describe('Lot 3 — cycle de vie des sites, bornes et comptes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes.js'), 'utf8');
  const block = (startMarker, len = 1800) => {
    const start = src.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, start + len);
  };

  it('suppression d’un site ou d’une borne refusée dès qu’une session existe (archivage proposé)', () => {
    const site = block("router.delete('/sites/:id', requireRole('admin')", 500);
    expect(site).toMatch(/db\.countSiteSessions\(siteId\)/);
    expect(site).toMatch(/status\(409\)\.json\(\{ error: 'ERR_SITE_HAS_SESSIONS', count \}\)/);
    const cp = block("router.delete(\n  '/chargepoints/:id',", 900);
    expect(cp).toMatch(/db\.countChargepointSessions\(cp\.id\)/);
    expect(cp).toMatch(/ERR_CHARGEPOINT_HAS_SESSIONS/);
    expect(cp.indexOf('countChargepointSessions')).toBeLessThan(cp.indexOf('db.deleteChargepoint'));
  });

  it('archivage et restauration : admin seul, jamais pendant une recharge, certificats gérés', () => {
    for (const route of ["'/sites/:id/archive'", "'/sites/:id/restore'", "'/chargepoints/:id/archive'", "'/chargepoints/:id/restore'"]) {
      expect(block(route, 120)).toMatch(/requireRole\('admin'\)/);
    }
    const site = block("'/sites/:id/archive'");
    expect(site).toMatch(/countActiveTransactions\(cpIds\) > 0[\s\S]*ERR_CHARGEPOINT_SESSION_ACTIVE/);
    expect(site).toMatch(/disconnectChargepoint\(cp\.identity, 'archived'\)/);
    expect(site).toMatch(/revokeChargepointCert\(cp\.identity, 'chargepoint_archived'\)/);
    const cp = block("'/chargepoints/:id/archive'");
    expect(cp).toMatch(/countActiveTransactions\(cp\.id\) > 0/);
    expect(cp).toMatch(/revokeChargepointCert\(cp\.identity, 'chargepoint_archived'\)/);
    expect(block("'/chargepoints/:id/restore'")).toMatch(/siteArchivedError\(res, cp\.site_id\)[\s\S]*generateChargepointCert/);
  });

  it('site archivé : écritures refusées (site, tarif, utilisateurs, badges, bornes)', () => {
    expect(src).toMatch(/function siteArchivedError\(res, siteId\)[\s\S]{0,200}ERR_SITE_ARCHIVED/);
    expect(block("router.put(\n  '/sites/:id',")).toMatch(/siteArchivedError\(res, Number\(req\.params\.id\)\)/);
    expect(block("router.put(\n  '/sites/:siteId/tariff',")).toMatch(/siteArchivedError\(res, siteId\)/);
    expect(block("router.post(\n  '/sites/:siteId/users',")).toMatch(/siteArchivedError\(res, siteId\)/);
    expect(block("router.patch(\n  '/sites/:siteId/users/:userId',")).toMatch(/siteArchivedError\(res, siteId\)/);
    expect(block("router.post('/id-tags'", 1500)).toMatch(/siteArchivedError\(res, next\.site_id\)/);
    expect(block("router.post('/chargepoints', requireRole('admin')", 600)).toMatch(/siteArchivedError\(res, data\.site_id\)/);
    expect(block("'/chargepoints/pending/:identity/accept'", 900)).toMatch(/siteArchivedError\(res, data\.site_id\)/);
  });

  it('changement d’identité : refusé en recharge ou si pris, ancien certificat révoqué, nouveau généré', () => {
    const route = block("router.put(\n  '/chargepoints/:id',", 3000);
    expect(route).toMatch(/before\.archived_at\) return res\.status\(409\)\.json\(\{ error: 'ERR_CHARGEPOINT_ARCHIVED' \}\)/);
    expect(route).toMatch(/\(identityChanged \|\| siteChanged\) && db\.countActiveTransactions\(before\.id\) > 0/);
    expect(route).toMatch(/identityChanged && db\.getChargepointByIdentity\(data\.identity\)[\s\S]{0,120}ERR_CHARGEPOINT_IDENTITY_TAKEN/);
    expect(route).toMatch(/disconnectChargepoint\(before\.identity, 'identity_changed'\)/);
    expect(route).toMatch(/revokeChargepointCert\(before\.identity, 'identity_changed'\)/);
    expect(route).toMatch(/generateChargepointCert\(cp\.identity\)/);
    const assign = block("'/chargepoints/:id/assign',", 1200);
    expect(assign).toMatch(/countActiveTransactions\(before\.id\) > 0/);
    expect(assign).toMatch(/siteArchivedError\(res, data\.site_id\)/);
  });

  it('plus de recréation d’une borne fantôme par le code OCPP (mise à jour seule)', () => {
    for (const file of ['ocpp-common.js', 'ocpp-server-16.js', 'ocpp-server-201.js']) {
      const code = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
      expect(code).not.toMatch(/db\.upsertChargepoint\(/);
    }
    const common = fs.readFileSync(path.join(__dirname, '../../src/ocpp-common.js'), 'utf8');
    expect(common).toMatch(/cp && cp\.archived_at[\s\S]{0,400}reject\(401, 'Charge point archived'\)/);
  });

  it('dernier manager protégé sur tous les chemins (rôle, retrait, sites, désactivation, suppression)', () => {
    expect(block("router.patch(\n  '/sites/:siteId/users/:userId',", 2000)).toMatch(/soleManagerOf\(userId, \[siteId\]\)\.length > 0/);
    expect(block("router.delete(\n  '/sites/:siteId/users/:userId',", 1000)).toMatch(/soleManagerOf\(userId, \[siteId\]\)\.length > 0/);
    expect(block("'/users/:id/sites',", 1500)).toMatch(/soleManagerOf\(userId\)\.filter[\s\S]{0,120}lastManagerError/);
    expect(block("'/users/:id/disabled',", 1500)).toMatch(/soleManagerOf\(targetId\)[\s\S]{0,80}lastManagerError/);
    expect(block("router.delete('/users/:id',", 1200)).toMatch(/soleManagerOf\(targetId\)[\s\S]{0,80}lastManagerError/);
  });

  it('comptes : désactivation admin (ni soi, ni dernier admin), suppression anonymisée, e-mail unique', () => {
    const dis = block("'/users/:id/disabled',", 1500);
    expect(dis).toMatch(/requireRole\('admin'\)/);
    expect(dis).toMatch(/ERR_CANNOT_DISABLE_SELF/);
    expect(dis).toMatch(/ERR_CANNOT_DISABLE_LAST_ADMIN/);
    expect(dis).toMatch(/closeUiSessions\(targetId\)/);
    const del = block("router.delete('/users/:id',", 1200);
    expect(del).toMatch(/i18next\.t\('users\.uDeletedUserName'/);
    expect(del).toMatch(/db\.deleteUser\(targetId, label\)/);
    expect(del).toMatch(/closeUiSessions\(targetId\)/);
    expect(block("router.post(\n  '/users',", 800)).toMatch(/db\.isEmailTaken\(data\.useremail\)[\s\S]{0,100}ERR_EMAIL_ALREADY_USED/);
    expect(block("router.put(\n  '/users/:id',", 1200)).toMatch(/db\.isEmailTaken\(data\.useremail, targetId\)/);
    // export des sessions d'un salarié réservé à l'admin
    expect(block("'/transactions/csv',", 1200)).toMatch(/req\.query\.user_id && req\.user\.role === 'admin'/);
  });

  it('compte désactivé : connexion refusée (local, Google), session et temps réel coupés', () => {
    const auth = fs.readFileSync(path.join(__dirname, '../../src/auth.js'), 'utf8');
    expect(auth.match(/ERR_ACCOUNT_DISABLED/g)).toHaveLength(3);
    expect(auth).toMatch(/if \(!user \|\| user\.disabled_at\) return done\(null, false\)/);
    const server = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    expect(server).toMatch(/if \(!dbUser \|\| dbUser\.disabled_at\)/);
    expect(server).toMatch(/setUiSessionCloser\(/);
  });
});
