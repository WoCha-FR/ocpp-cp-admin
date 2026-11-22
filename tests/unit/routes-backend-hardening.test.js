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
