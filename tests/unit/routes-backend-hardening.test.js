'use strict';

const fs = require('fs');
const path = require('path');

describe('Backend hardening regressions', () => {
  const routesPath = path.join(__dirname, '../../src/routes.js');
  const dbPath = path.join(__dirname, '../../src/database.js');

  it('uses IP-based key generator for forgot-password limiter', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/const forgotPasswordLimiter = rateLimit\(/);
    expect(src).toMatch(/keyGenerator:\s*ipKeyGenerator/);
    expect(src).not.toMatch(/keyGenerator:\s*\(req\)\s*=>\s*req\.body\?\.useremail/);
  });

  it('keeps an explicit null password in PUT /chargepoints/:id (matchedData drops it)', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const putRoute = src.slice(src.indexOf("'/chargepoints/:id',\n  requireRole('admin'),\n  ...validateSchema(schema.IdParam, schema.ChargePoint)"));
    expect(putRoute).toMatch(/if \(req\.body\.password === null\) data\.password = null;/);
  });

  it('unsubscribes push endpoint only for current user', () => {
    const routes = fs.readFileSync(routesPath, 'utf8');
    const db = fs.readFileSync(dbPath, 'utf8');
    expect(routes).toMatch(/db\.deletePushSubscriptionByUser\(req\.user\.id,\s*endpoint\)/);
    expect(db).toMatch(/function deletePushSubscriptionByUser\(userId,\s*endpoint\)/);
    expect(db).toMatch(/DELETE FROM push_subscriptions WHERE user_id = \? AND endpoint = \?/);
  });

  it('restreint le rapport de remboursement aux sites gérés par le manager', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    const start = src.indexOf("'/transactions/reimbursement/csv'");
    expect(start).toBeGreaterThan(-1);
    const route = src.slice(start, src.indexOf('TRANSACTION DETAIL', start));
    expect(route).toMatch(/requireManager/);
    expect(route).toMatch(/getUserManagedSiteIds\(req\)/);
    expect(route).toMatch(/category: req\.query\.category \|\| 'pro'/);
    // La route doit être déclarée avant /transactions/:transactionId
    expect(start).toBeLessThan(src.indexOf("'/transactions/:transactionId'"));
  });

  it('transmet la catégorie du badge à la création et applique le filtre aux routes self-service', () => {
    const src = fs.readFileSync(routesPath, 'utf8');
    expect(src).toMatch(/data\.token_type,\s*null,\s*data\.category/);
    const userSection = src.slice(
      src.indexOf("'/user/transactions/stats'"),
      src.indexOf("'/user/stop-charge'")
    );
    // stats + liste + CSV
    expect(userSection.match(/filters\.category = req\.query\.category/g)).toHaveLength(3);
    expect(userSection).toMatch(/withTotal: true/);
  });
});


describe('Lot A — transactions : régressions routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes.js'), 'utf8');

  it("POST /init-config/chargepoint/:id/apply répond aussi pour une borne 1.6 (requête pendante)", () => {
    const start = src.indexOf("'/init-config/chargepoint/:id/apply'");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("router.post('/init-config/cascade-all'", start);
    const route = src.slice(start, end);
    // La branche 2.0.1 répond dans son bloc ; la branche 1.6 doit répondre après sa boucle
    const after16 = route.slice(route.indexOf('getEnabledInitialChargepointConfig()'));
    expect(after16).toMatch(/return res\.json\(\{ ok: true \}\)/);
  });

  it('les démarrages à distance transmettent evse_id (connectorId est numéroté par EVSE en 2.0.1)', () => {
    const calls = src.match(/remoteStartTransaction\(\s*cp\.identity,[^;]*;/g) || [];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatch(/req\.body\.evse_id \?\? null/);
  });
});

describe('Lot B — conformité OCPP : régressions routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes.js'), 'utf8');
  const routeBlock = (startMarker, endMarker) => {
    const start = src.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf(endMarker, start));
  };

  it('PUT config 2.0.1 : la valeur n\'est enregistrée que si SetVariables est Accepted / RebootRequired', () => {
    const route = routeBlock("'/chargepoints/:id/config/:key',\n  requireRole('admin'),\n  ...validateSchema(schema.IdParam, schema.ChargepointConfigUpdate)", 'GLOBAL_ONLY_KEYS');
    expect(route).toMatch(/setVariableResult\?\.\[0\]\?\.attributeStatus/);
    expect(route).toMatch(/if \(attributeStatus === 'Accepted' \|\| attributeStatus === 'RebootRequired'\) \{\s*db\.upsertChargepointVariable/);
    // la réponse expose le statut (l'UI affiche une erreur si ≠ Accepted)
    expect(route).toMatch(/res\.json\(\{ result, status: attributeStatus \?\? 'Rejected' \}\)/);
  });

  it('création de profil : validation spec + construction partagée (chargingProfiles.js)', () => {
    const route = routeBlock("router.post(\n  '/chargepoints/:id/charging-profiles',", "router.post(\n  '/chargepoints/:id/charging-profiles/clear'");
    expect(route).toMatch(/normalizeProfileInput\(req\.body\)/);
    expect(route).toMatch(/res\.status\(400\)\.json\(\{ error: normalized\.error \}\)/);
    expect(route).toMatch(/buildSetChargingProfileParams\(version,/);
  });

  it('« tout renvoyer » réutilise la même construction (une seule logique 1.6 / 2.0.1)', () => {
    const route = routeBlock("'/chargepoints/:id/charging-profiles/push-all'", "'/chargepoints/:id/charging-profiles/composite-schedule'");
    expect(route).toMatch(/buildSetChargingProfileParams\(/);
    expect(route).not.toMatch(/csChargingProfiles/);
  });

  it('ClearChargingProfile « Unknown » : la ligne périmée est supprimée (suppression et effacement filtré)', () => {
    const del = routeBlock("'/chargepoints/:id/charging-profiles/:profileDbId',\n  requireManager", '// ── Reservations ──');
    expect(del).toMatch(/result\?\.status === 'Accepted' \|\| result\?\.status === 'Unknown'/);
    const clear = routeBlock("'/chargepoints/:id/charging-profiles/clear'", "'/chargepoints/:id/charging-profiles/push-all'");
    expect(clear).toMatch(/result\?\.status === 'Accepted' \|\| result\?\.status === 'Unknown'/);
    expect(clear).toMatch(/mapPurpose\('1\.6', profile_purpose\)/);
    expect(clear).toMatch(/mapPurpose\('2\.0\.1', profile_purpose\)/);
  });

  it('ReserveNow 2.0.1 : type de jeton réel du badge (pas ISO14443 figé)', () => {
    const route = routeBlock("'/chargepoints/:id/reservations',\n  requireManager,\n  ...validateSchema(schema.IdParam, schema.CreateReservation)", "'/reservations/:reservationId',\n  requireManager");
    expect(route).toMatch(/db\.getIdTagByTag\(id_tag, cp\.site_id\)\?\.token_type \|\| 'ISO14443'/);
    expect(route).toMatch(/idToken: \{ idToken: id_tag, type: tokenType \}/);
  });
});
