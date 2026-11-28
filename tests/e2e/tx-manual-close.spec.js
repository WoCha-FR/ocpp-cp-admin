'use strict';

// Clôture manuelle d'une transaction restée active (borne qui ne revient pas) :
// bouton sur le détail réservé à l'admin / au manager du site, clôture en base avec le dernier
// relevé connu (closed_by = server), correction par l'arrêt réel si la borne revient.

const { RPCClient } = require('ocpp-rpc');
const { test, expect } = require('./fixtures');

const OCPP_ENDPOINT = 'ws://localhost:9099';

async function apiCall(page, method, url, data) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
  const resp = await page.request.fetch('/api' + url, {
    method,
    headers: { 'x-xsrf-token': csrf, 'content-type': 'application/json' },
    data: data ? JSON.stringify(data) : undefined,
  });
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: resp.status(), body };
}

function simulatedChargepoint(identity) {
  const cli = new RPCClient({
    endpoint: OCPP_ENDPOINT,
    identity,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });
  // TriggerMessage, GetConfiguration… envoyés par le serveur à la connexion
  cli.handle('GetConfiguration', () => ({ configurationKey: [], unknownKey: [] }));
  cli.handle(() => ({ status: 'Accepted' }));
  return cli;
}

test.describe.serial('Clôture manuelle d’une transaction', () => {
  const suffix = Date.now();
  const siteName = `E2EClose${suffix}`;
  const identity = `E2ECL-${suffix}`;
  const email = `e2e-close-${suffix}@example.com`;
  const password = 'TestPass!123';
  const idTag = `CLS${suffix}`.slice(0, 20);
  const START = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const METER = new Date(Date.now() - 3600 * 1000).toISOString();
  let siteId;
  let userId;
  let transactionId;
  let txRowId;

  const detailButton = (p) => p.locator('#topbarActions [data-onclick*="closeTransactionManually"]');

  async function openDetail(p, rowId) {
    await p.evaluate((id) => showTransactionDetail(id, 'transactions'), rowId);
    await expect(p.locator('#pageTitle')).toContainText(`#${transactionId}`, { timeout: 10000 });
    await expect(p.locator('#pageContent .detail-sections')).toBeVisible({ timeout: 10000 });
  }

  test('prépare un site tarifé, un utilisateur avec badge et une session restée active', async ({
    loggedInPage: page,
  }) => {
    const site = await apiCall(page, 'POST', '/sites', { name: siteName, address: '' });
    expect(site.status).toBe(201);
    siteId = site.body.id;
    const tariff = await apiCall(page, 'PUT', `/sites/${siteId}/tariff`, {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      default_price_per_kwh: 0.2,
      periods: [],
    });
    expect(tariff.status).toBe(200);
    const cp = await apiCall(page, 'POST', '/chargepoints', {
      identity,
      name: `Borne clôture ${suffix}`,
      mode: 3,
      site_id: siteId,
    });
    expect(cp.status).toBeLessThan(300);

    const user = await apiCall(page, 'POST', '/users', {
      useremail: email,
      password,
      shortname: 'E2E Close',
      role: 'user',
    });
    expect(user.status).toBe(201);
    userId = user.body.id;
    const sites = await apiCall(page, 'PUT', `/users/${userId}/sites`, {
      sites: [{ site_id: siteId, role: 'user', authorized: 1 }],
    });
    expect(sites.status).toBe(200);
    const tag = await apiCall(page, 'POST', '/id-tags', {
      id_tag: idTag,
      user_id: userId,
      description: 'Badge clôture',
    });
    expect(tag.status).toBeLessThan(300);

    // Borne simulée : démarre une session, envoie un relevé (5 kWh), puis disparaît sans arrêt
    const cli = simulatedChargepoint(identity);
    await cli.connect();
    try {
      await cli.call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'SIM' });
      await cli.call('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Available',
      });
      const started = await cli.call('StartTransaction', {
        connectorId: 1,
        idTag,
        meterStart: 1000,
        timestamp: START,
      });
      transactionId = String(started.transactionId);
      await cli.call('MeterValues', {
        connectorId: 1,
        transactionId: started.transactionId,
        meterValue: [
          {
            timestamp: METER,
            sampledValue: [
              { value: '6000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
            ],
          },
        ],
      });
    } finally {
      await cli.close();
    }

    const list = await apiCall(page, 'GET', `/transactions?site_id=${siteId}&limit=all`);
    const tx = list.body.data.find((t) => String(t.transaction_id) === transactionId);
    txRowId = tx.id;
    // la déconnexion de la borne ne clôt pas la session
    expect(tx.status).toBe('Active');
  });

  test('utilisateur simple (propriétaire du badge) : détail visible, pas de bouton, API refusée', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const userPage = await context.newPage();
    try {
      await userPage.goto('/');
      const login = await apiCall(userPage, 'POST', '/auth/login', { useremail: email, password });
      expect(login.status).toBe(200);
      await userPage.goto('/');
      await userPage.locator('#appPage').waitFor({ state: 'visible', timeout: 10000 });

      await openDetail(userPage, txRowId);
      await expect(detailButton(userPage)).toHaveCount(0);

      const res = await apiCall(userPage, 'POST', `/transactions/${txRowId}/close`);
      expect(res.status).toBe(403);
    } finally {
      await context.close();
    }
  });

  test('admin : clôture depuis le détail, avec confirmation, au dernier relevé connu', async ({
    loggedInPage: page,
  }) => {
    await openDetail(page, txRowId);
    const btn = detailButton(page);
    await expect(btn).toBeVisible();

    // annulation : rien ne change
    await btn.click();
    await expect(page.locator('#confirmMessage')).toContainText(/PAS arrêtée|NOT stopped/, {
      timeout: 5000,
    });
    await page.locator('#confirmBtnCancel').click();
    expect((await apiCall(page, 'GET', `/transactions/${txRowId}`)).body.status).toBe('Active');

    // confirmation
    await btn.click();
    await page.locator('#confirmBtnOk').click();
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 10000 });
    // le détail est rechargé : session close, plus de bouton
    await expect(detailButton(page)).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('#pageContent .detail-sections')).toBeVisible();

    const tx = (await apiCall(page, 'GET', `/transactions/${txRowId}`)).body;
    expect(tx.status).toBe('Completed');
    expect(tx.closed_by).toBe('server');
    expect(tx.stop_reason).toBe('Other');
    expect(tx.meter_stop).toBe(6000);
    expect(tx.cost).toBe(1); // 5 kWh × 0,20 €
  });

  test('une session déjà close est refusée (409)', async ({ loggedInPage: page }) => {
    const res = await apiCall(page, 'POST', `/transactions/${txRowId}/close`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ERR_TRANSACTION_NOT_ACTIVE');
    const unknown = await apiCall(page, 'POST', '/transactions/999999999/close');
    expect(unknown.status).toBe(404);
  });

  test('la borne revient et envoie son arrêt réel : la session est corrigée', async ({
    loggedInPage: page,
  }) => {
    const cli = simulatedChargepoint(identity);
    await cli.connect();
    try {
      await cli.call('StopTransaction', {
        transactionId: Number(transactionId),
        meterStop: 11000,
        timestamp: new Date().toISOString(),
        reason: 'Local',
      });
    } finally {
      await cli.close();
    }
    const tx = (await apiCall(page, 'GET', `/transactions/${txRowId}`)).body;
    expect(tx.status).toBe('Completed');
    expect(tx.closed_by).toBe('station');
    expect(tx.meter_stop).toBe(11000);
    expect(tx.cost).toBe(2); // 10 kWh × 0,20 €
  });

  test('nettoyage', async ({ loggedInPage: page }) => {
    const all = await apiCall(page, 'GET', '/id-tags');
    for (const t of all.body.filter((x) => x.user_id === userId)) {
      await apiCall(page, 'DELETE', `/id-tags/${t.id}`);
    }
    const cps = await apiCall(page, 'GET', '/chargepoints');
    const cp = cps.body.find((c) => c.identity === identity);
    if (cp) await apiCall(page, 'DELETE', `/chargepoints/${cp.id}`);
    if (userId) await apiCall(page, 'DELETE', `/users/${userId}`);
    if (siteId) {
      // site avec un historique : suppression refusée (409), on l'archive
      const del = await apiCall(page, 'DELETE', `/sites/${siteId}`);
      if (del.status === 409) await apiCall(page, 'POST', `/sites/${siteId}/archive`);
    }
  });
});
