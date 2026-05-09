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

  it('unsubscribes push endpoint only for current user', () => {
    const routes = fs.readFileSync(routesPath, 'utf8');
    const db = fs.readFileSync(dbPath, 'utf8');
    expect(routes).toMatch(/db\.deletePushSubscriptionByUser\(req\.user\.id,\s*endpoint\)/);
    expect(db).toMatch(/function deletePushSubscriptionByUser\(userId,\s*endpoint\)/);
    expect(db).toMatch(/DELETE FROM push_subscriptions WHERE user_id = \? AND endpoint = \?/);
  });
});

