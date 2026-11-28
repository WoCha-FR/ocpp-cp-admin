'use strict';

// Démarrage d'une recharge depuis le tableau de bord utilisateur (/user/start-charge) :
// choix du badge quand plusieurs sont valides (pro / perso), refus quand aucun n'est valide
// (pas de repli sur le badge web automatique).

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

test.describe.serial('Démarrage depuis le tableau de bord utilisateur', () => {
  const suffix = Date.now();
  const siteName = `E2EStart${suffix}`;
  const identity = `E2EST-${suffix}`;
  const email = `e2e-start-${suffix}@example.com`;
  const password = 'TestPass!123';
  const tagPro = `PRO${suffix}`.slice(0, 20);
  const tagPerso = `PER${suffix}`.slice(0, 20);
  let siteId;
  let userId;
  let cli;
  const remoteStarts = [];

  test.afterAll(async () => {
    if (cli) await cli.close().catch(() => {});
  });

  test('prépare un site, une borne RFID connectée, un utilisateur et deux badges', async ({
    loggedInPage: page,
  }) => {
    const site = await apiCall(page, 'POST', '/sites', { name: siteName, address: '' });
    expect(site.status).toBe(201);
    siteId = site.body.id;
    const cp = await apiCall(page, 'POST', '/chargepoints', {
      identity,
      name: `Borne start ${suffix}`,
      mode: 1,
      site_id: siteId,
    });
    expect(cp.status).toBeLessThan(300);

    const user = await apiCall(page, 'POST', '/users', {
      useremail: email,
      password,
      shortname: 'E2E Start',
      role: 'user',
    });
    expect(user.status).toBe(201);
    userId = user.body.id;
    const sites = await apiCall(page, 'PUT', `/users/${userId}/sites`, {
      sites: [{ site_id: siteId, role: 'user', authorized: 1 }],
    });
    expect(sites.status).toBe(200);

    for (const [idTag, category] of [
      [tagPro, 'pro'],
      [tagPerso, 'perso'],
    ]) {
      const tag = await apiCall(page, 'POST', '/id-tags', {
        id_tag: idTag,
        user_id: userId,
        description: `Badge ${category}`,
        category,
      });
      expect(tag.status).toBeLessThan(300);
    }

    // Borne simulée : accepte les démarrages à distance et mémorise le badge reçu
    cli = new RPCClient({
      endpoint: OCPP_ENDPOINT,
      identity,
      protocols: ['ocpp1.6'],
      strictMode: false,
    });
    cli.handle('RemoteStartTransaction', ({ params }) => {
      remoteStarts.push(params.idTag);
      return { status: 'Accepted' };
    });
    cli.handle('GetConfiguration', () => ({ configurationKey: [], unknownKey: [] }));
    cli.handle(() => ({ status: 'Accepted' }));
    await cli.connect();
    await cli.call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'SIM' });
    await cli.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
  });

  async function openUserDashboard(browser) {
    const context = await browser.newContext();
    const userPage = await context.newPage();
    await userPage.goto('/');
    const login = await apiCall(userPage, 'POST', '/auth/login', { useremail: email, password });
    expect(login.status).toBe(200);
    await userPage.goto('/');
    await userPage.locator('#appPage').waitFor({ state: 'visible', timeout: 10000 });
    return { context, userPage };
  }

  test('deux badges valides : la confirmation propose le choix, le badge choisi est envoyé', async ({
    browser,
  }) => {
    const { context, userPage } = await openUserDashboard(browser);
    try {
      const startBtn = userPage.locator(
        `.connector-card:has-text("Borne start ${suffix}") [data-onclick*="userStartCharge"]`
      );
      await expect(startBtn).toBeVisible({ timeout: 10000 });
      await startBtn.click();

      const select = userPage.locator('#confirmSelect');
      await expect(select).toBeVisible({ timeout: 5000 });
      await expect(select.locator('option')).toHaveCount(2);
      await expect(select.locator('option', { hasText: tagPro })).toContainText(/Pro/);
      await select.selectOption(tagPro);
      await userPage.locator('#confirmBtnOk').click();

      await expect(userPage.locator('.toast-success')).toBeVisible({ timeout: 10000 });
      expect(remoteStarts).toEqual([tagPro]);

      // Sans choix explicite, l'API refuse plutôt que de prendre un badge au hasard
      const cps = await apiCall(userPage, 'GET', '/user/available-connectors');
      const conn = cps.body.find((c) => c.chargepoint_identity === identity);
      const noChoice = await apiCall(userPage, 'POST', '/user/start-charge', {
        chargepoint_id: conn.chargepoint_id,
        connector_id: 1,
      });
      expect(noChoice.status).toBe(409);
      expect(noChoice.body.error).toBe('ERR_ID_TAG_CHOICE_REQUIRED');
      // Badge d'un autre / inconnu : refusé
      const foreign = await apiCall(userPage, 'POST', '/user/start-charge', {
        chargepoint_id: conn.chargepoint_id,
        connector_id: 1,
        id_tag: 'NOTMINE123',
      });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error).toBe('ERR_ID_TAG_NOT_USABLE');
      expect(remoteStarts).toEqual([tagPro]);
    } finally {
      await context.close();
    }
  });

  test('badges désactivés : démarrage refusé, pas de badge web automatique', async ({
    loggedInPage: page,
    browser,
  }) => {
    const all = await apiCall(page, 'GET', '/id-tags');
    const mine = all.body.filter((t) => t.user_id === userId);
    expect(mine).toHaveLength(2);
    for (const t of mine) {
      const upd = await apiCall(page, 'PUT', `/id-tags/${t.id}`, {
        id_tag: t.id_tag,
        user_id: userId,
        description: t.description,
        category: t.category,
        active: 0,
      });
      expect(upd.status).toBe(200);
    }

    const { context, userPage } = await openUserDashboard(browser);
    try {
      const startBtn = userPage.locator(
        `.connector-card:has-text("Borne start ${suffix}") [data-onclick*="userStartCharge"]`
      );
      await expect(startBtn).toBeVisible({ timeout: 10000 });
      await startBtn.click();
      await expect(userPage.locator('.toast-error')).toContainText(
        /Aucun badge valide|No valid badge/,
        {
          timeout: 5000,
        }
      );
      await expect(userPage.locator('#confirmOverlay')).not.toHaveClass(/active/);

      const cps = await apiCall(userPage, 'GET', '/user/available-connectors');
      const conn = cps.body.find((c) => c.chargepoint_identity === identity);
      const res = await apiCall(userPage, 'POST', '/user/start-charge', {
        chargepoint_id: conn.chargepoint_id,
        connector_id: 1,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ERR_NO_VALID_ID_TAG');
    } finally {
      await context.close();
    }
    expect(remoteStarts).toHaveLength(1);
    const after = await apiCall(page, 'GET', '/id-tags');
    expect(after.body.some((t) => t.id_tag === `WEB-${userId}`)).toBe(false);
  });

  test('aucun badge : le badge web automatique est créé et utilisé', async ({
    loggedInPage: page,
    browser,
  }) => {
    const all = await apiCall(page, 'GET', '/id-tags');
    for (const t of all.body.filter((x) => x.user_id === userId)) {
      expect((await apiCall(page, 'DELETE', `/id-tags/${t.id}`)).status).toBe(200);
    }
    const { context, userPage } = await openUserDashboard(browser);
    try {
      const tags = await apiCall(
        userPage,
        'GET',
        `/user/start-charge/id-tags?chargepoint_id=${
          (await apiCall(userPage, 'GET', '/user/available-connectors')).body.find(
            (c) => c.chargepoint_identity === identity
          ).chargepoint_id
        }`
      );
      expect(tags.body).toEqual({ idTags: [], autoWeb: true, blocked: false, noBadge: false });

      const startBtn = userPage.locator(
        `.connector-card:has-text("Borne start ${suffix}") [data-onclick*="userStartCharge"]`
      );
      await startBtn.click();
      await expect(userPage.locator('#confirmSelect')).toBeHidden();
      await userPage.locator('#confirmBtnOk').click();
      await expect(userPage.locator('.toast-success')).toBeVisible({ timeout: 10000 });
      expect(remoteStarts[remoteStarts.length - 1]).toBe(`WEB-${userId}`);

      // Second démarrage : le badge web, inactif en base, est réutilisé (non compté comme
      // badge bloqué de l'utilisateur)
      const startsBefore = remoteStarts.length;
      const cpId = (await apiCall(userPage, 'GET', '/user/available-connectors')).body.find(
        (c) => c.chargepoint_identity === identity
      ).chargepoint_id;
      const again = await apiCall(
        userPage,
        'GET',
        `/user/start-charge/id-tags?chargepoint_id=${cpId}`
      );
      expect(again.body).toEqual({ idTags: [], autoWeb: true, blocked: false, noBadge: false });
      const second = await apiCall(userPage, 'POST', '/user/start-charge', {
        chargepoint_id: cpId,
        connector_id: 1,
      });
      expect(second.status).toBe(200);
      expect(second.body.idTag).toBe(`WEB-${userId}`);
      expect(remoteStarts).toHaveLength(startsBefore + 1);
      expect(remoteStarts[remoteStarts.length - 1]).toBe(`WEB-${userId}`);
    } finally {
      await context.close();
    }
    const webTags = (await apiCall(page, 'GET', '/id-tags')).body.filter(
      (t) => t.id_tag === `WEB-${userId}`
    );
    expect(webTags).toHaveLength(1);
    expect(webTags[0].active).toBeFalsy();
  });

  test('nettoyage', async ({ loggedInPage: page }) => {
    if (cli) {
      await cli.close().catch(() => {});
      cli = null;
    }
    const all = await apiCall(page, 'GET', '/id-tags');
    for (const t of all.body.filter((x) => x.user_id === userId)) {
      await apiCall(page, 'DELETE', `/id-tags/${t.id}`);
    }
    const cps = await apiCall(page, 'GET', '/chargepoints');
    const cp = cps.body.find((c) => c.identity === identity);
    if (cp) await apiCall(page, 'DELETE', `/chargepoints/${cp.id}`);
    if (userId) await apiCall(page, 'DELETE', `/users/${userId}`);
    if (siteId) await apiCall(page, 'DELETE', `/sites/${siteId}`);
  });
});
