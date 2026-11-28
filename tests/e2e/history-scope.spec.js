'use strict';

// Lot 1 : historique figé des sessions et périmètre des gestionnaires.
// - un gestionnaire ne voit, dans les pages de gestion, que les sites qu'il GÈRE (pas ceux où il
//   n'est que simple utilisateur), même pour ses propres sessions ;
// - une session garde son site, son titulaire et sa catégorie après modification du badge et
//   déplacement de la borne.

const { RPCClient } = require('ocpp-rpc');
const { test, expect } = require('./fixtures');

const OCPP_ENDPOINT = 'ws://localhost:9099';
const START = '2026-02-02T08:00:00.000Z';
const STOP = '2026-02-02T09:00:00.000Z';

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
  return { status: resp.status(), body, raw: text };
}

async function simulateSession(identity, idTag) {
  const cli = new RPCClient({
    endpoint: OCPP_ENDPOINT,
    identity,
    protocols: ['ocpp1.6'],
    strictMode: false,
  });
  await cli.connect();
  try {
    await cli.call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'SIM' });
    const started = await cli.call('StartTransaction', {
      connectorId: 1,
      idTag,
      meterStart: 0,
      timestamp: START,
    });
    await cli.call('StopTransaction', {
      transactionId: started.transactionId,
      meterStop: 4000,
      timestamp: STOP,
    });
    return String(started.transactionId);
  } finally {
    await cli.close();
  }
}

test.describe.serial('Historique figé et périmètre des gestionnaires', () => {
  const suffix = Date.now();
  const managed = `E2EGere${suffix}`;
  const other = `E2EAutre${suffix}`;
  const cpManaged = `E2EHG-${suffix}`;
  const cpOther = `E2EHA-${suffix}`;
  const email = `e2e-scope-${suffix}@example.com`;
  const password = 'TestPass!123';
  const tag = `HSC${suffix}`.slice(0, 20);
  const ids = {};

  async function asManager(browser, fn) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/');
      const login = await apiCall(page, 'POST', '/auth/login', { useremail: email, password });
      expect(login.status).toBe(200);
      await fn(page);
    } finally {
      await context.close();
    }
  }

  test('prépare deux sites, un gestionnaire du premier (simple utilisateur du second)', async ({
    loggedInPage: page,
  }) => {
    for (const [key, name] of [
      ['managed', managed],
      ['other', other],
    ]) {
      const site = await apiCall(page, 'POST', '/sites', { name, address: '' });
      expect(site.status).toBe(201);
      ids[key] = site.body.id;
    }
    for (const [key, identity, siteKey] of [
      ['cpManaged', cpManaged, 'managed'],
      ['cpOther', cpOther, 'other'],
    ]) {
      const cp = await apiCall(page, 'POST', '/chargepoints', {
        identity,
        name: identity,
        mode: 1,
        site_id: ids[siteKey],
      });
      expect(cp.status).toBeLessThan(300);
      ids[key] = cp.body.id;
    }
    const user = await apiCall(page, 'POST', '/users', {
      useremail: email,
      password,
      shortname: 'E2E Scope',
      role: 'user',
    });
    expect(user.status).toBe(201);
    ids.user = user.body.id;
    const links = await apiCall(page, 'PUT', `/users/${ids.user}/sites`, {
      sites: [
        { site_id: ids.managed, role: 'manager', authorized: 1 },
        { site_id: ids.other, role: 'user', authorized: 1 },
      ],
    });
    expect(links.status).toBe(200);
    const created = await apiCall(page, 'POST', '/id-tags', {
      id_tag: tag,
      user_id: ids.user,
      description: 'Badge pro global',
      category: 'pro',
    });
    expect(created.status).toBeLessThan(300);
    ids.tag = created.body.id;

    // Une session du gestionnaire sur chaque site
    ids.txManaged = await simulateSession(cpManaged, tag);
    ids.txOther = await simulateSession(cpOther, tag);
  });

  test("pages de gestion : rien du site où il n'est que simple utilisateur", async ({
    browser,
  }) => {
    await asManager(browser, async (page) => {
      const cps = await apiCall(page, 'GET', '/chargepoints');
      expect(cps.status).toBe(200);
      const identities = cps.body.map((c) => c.identity);
      expect(identities).toContain(cpManaged);
      expect(identities).not.toContain(cpOther);

      const txs = await apiCall(page, 'GET', '/transactions?limit=all');
      const cpsInTx = txs.body.data.map((t) => t.chargepoint_identity);
      expect(cpsInTx).toContain(cpManaged);
      expect(cpsInTx).not.toContain(cpOther);

      // Filtrer explicitement le site non géré ne donne rien
      const forced = await apiCall(page, 'GET', `/transactions?site_id=${ids.other}&limit=all`);
      expect(forced.body.total).toBe(0);

      const dash = await apiCall(page, 'GET', '/dashboard');
      expect(dash.body.totalSites).toBe(1);

      // « Mes transactions » garde ses deux sessions
      const mine = await apiCall(page, 'GET', '/user/transactions?limit=all');
      expect(mine.body.data.map((t) => t.chargepoint_identity).sort()).toEqual(
        [cpManaged, cpOther].sort()
      );
    });
  });

  test('la session garde site, titulaire et catégorie après modification du badge et déplacement de la borne', async ({
    loggedInPage: page,
  }) => {
    const upd = await apiCall(page, 'PUT', `/id-tags/${ids.tag}`, {
      id_tag: tag,
      user_id: null,
      description: 'Badge modifié',
      category: 'perso',
    });
    expect(upd.status).toBe(200);
    const moved = await apiCall(page, 'PUT', `/chargepoints/${ids.cpManaged}/assign`, {
      site_id: ids.other,
    });
    expect(moved.status).toBe(200);

    const list = await apiCall(page, 'GET', `/transactions?site_id=${ids.managed}&limit=all`);
    const tx = list.body.data.find((t) => t.transaction_id === ids.txManaged);
    expect(tx).toMatchObject({
      site_id: ids.managed,
      site_name: managed,
      tag_user_id: ids.user,
      tag_username: 'E2E Scope',
      tag_category: 'pro',
    });

    const csv = await apiCall(
      page,
      'GET',
      `/transactions/reimbursement/csv?site_id=${ids.managed}`
    );
    expect(csv.status).toBe(200);
    expect(csv.raw).toContain('E2E Scope');
  });

  test('nettoyage', async ({ loggedInPage: page }) => {
    for (const key of ['cpManaged', 'cpOther']) {
      if (ids[key]) await apiCall(page, 'DELETE', `/chargepoints/${ids[key]}`);
    }
    if (ids.tag) await apiCall(page, 'DELETE', `/id-tags/${ids.tag}`);
    if (ids.user) await apiCall(page, 'DELETE', `/users/${ids.user}`);
    for (const key of ['managed', 'other']) {
      if (ids[key]) await apiCall(page, 'DELETE', `/sites/${ids[key]}`);
    }
  });
});
