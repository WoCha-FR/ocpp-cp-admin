'use strict';

// Lot 3 : cycle de vie des sites, bornes et comptes. Suppression refusée dès qu'il y a un
// historique (archivage proposé), remplacement d'une borne par changement d'identifiant,
// archivage et restauration, désactivation et suppression (anonymisation) d'un compte,
// dernier manager protégé. Avec une vraie borne OCPP 1.6 simulée.

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
    body = text;
  }
  return { status: resp.status(), body };
}

// Le serveur limite les connexions OCPP (10 par minute et par IP) : leurs heures sont notées
// pour laisser la fenêtre se vider avant les specs suivantes
const ocppAttempts = [];

function makeClient(identity) {
  ocppAttempts.push(Date.now());
  const cli = new RPCClient({
    endpoint: OCPP_ENDPOINT,
    identity,
    protocols: ['ocpp1.6'],
    strictMode: false,
    reconnect: false,
  });
  cli.handle(() => ({ status: 'Accepted' }));
  return cli;
}

// La connexion est-elle acceptée par le serveur ?
async function canConnect(identity) {
  const cli = makeClient(identity);
  try {
    await cli.connect();
    await cli.close();
    return true;
  } catch {
    return false;
  }
}

async function simulateSession(identity, idTag) {
  const cli = makeClient(identity);
  await cli.connect();
  try {
    await cli.call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'SIM' });
    const started = await cli.call('StartTransaction', {
      connectorId: 1,
      idTag,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    await cli.call('StopTransaction', {
      transactionId: started.transactionId,
      meterStop: 4000,
      timestamp: new Date().toISOString(),
    });
    return started;
  } finally {
    await cli.close();
  }
}

test.describe.serial('Cycle de vie des sites, bornes et comptes (lot 3)', () => {
  const suffix = Date.now();
  const short = String(suffix).slice(-8);
  const password = 'TestPass!123';
  const identities = {
    first: `E2EL3A-${suffix}`,
    replaced: `E2EL3B-${suffix}`,
    renamedOnline: `E2EL3C-${suffix}`,
  };
  const emails = {
    manager: `e2e-l3-mgr-${suffix}@example.com`,
    employee: `e2e-l3-emp-${suffix}@example.com`,
  };
  const ids = {};
  const badge = `L3PRO${short}`;

  const cpBody = (identity) => ({
    identity,
    name: `L3 borne ${short}`,
    mode: 1,
    site_id: ids.site,
  });

  test('prépare : un site, une borne, un manager, un salarié avec un badge pro et une session', async ({
    loggedInPage: page,
  }) => {
    const site = await apiCall(page, 'POST', '/sites', { name: `E2EL3Site${suffix}`, address: '' });
    expect(site.status).toBe(201);
    ids.site = site.body.id;
    const cp = await apiCall(page, 'POST', '/chargepoints', cpBody(identities.first));
    expect(cp.status).toBe(201);
    ids.cp = cp.body.id;

    for (const [who, shortname, role] of [
      ['manager', 'L3 Gestionnaire', 'manager'],
      ['employee', 'L3 Salarie', 'user'],
    ]) {
      const u = await apiCall(page, 'POST', '/users', {
        useremail: emails[who],
        password,
        shortname,
        role: 'user',
      });
      expect(u.status).toBe(201);
      ids[who] = u.body.id;
      const links = await apiCall(page, 'PUT', `/users/${u.body.id}/sites`, {
        sites: [{ site_id: ids.site, role, authorized: 1 }],
      });
      expect(links.status).toBe(200);
    }
    const tag = await apiCall(page, 'POST', '/id-tags', {
      id_tag: badge,
      user_id: ids.employee,
      category: 'pro',
      description: 'Badge de L3 Salarie',
    });
    expect(tag.status).toBe(201);
    ids.tag = tag.body.id;

    const started = await simulateSession(identities.first, badge);
    expect(started.idTagInfo.status).toBe('Accepted');
  });

  test('suppression refusée dès qu’il y a une session (borne et site)', async ({
    loggedInPage: page,
  }) => {
    const cp = await apiCall(page, 'DELETE', `/chargepoints/${ids.cp}`);
    expect(cp.status).toBe(409);
    expect(cp.body).toMatchObject({ error: 'ERR_CHARGEPOINT_HAS_SESSIONS', count: 1 });
    const site = await apiCall(page, 'DELETE', `/sites/${ids.site}`);
    expect(site.status).toBe(409);
    expect(site.body).toMatchObject({ error: 'ERR_SITE_HAS_SESSIONS', count: 1 });
  });

  test('remplacement de la borne : nouvel identifiant, historique conservé, ancien refusé', async ({
    loggedInPage: page,
  }) => {
    const taken = await apiCall(page, 'POST', '/chargepoints', cpBody(identities.first));
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('ERR_CHARGEPOINT_IDENTITY_TAKEN');

    const upd = await apiCall(page, 'PUT', `/chargepoints/${ids.cp}`, cpBody(identities.replaced));
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ identity: identities.replaced, identity_changed: true });

    expect(await canConnect(identities.first)).toBe(false);
    // La borne de remplacement se connecte ; la connexion sert au test suivant (le serveur
    // limite les connexions OCPP par minute et par IP)
    ids.live = makeClient(identities.replaced);
    await ids.live.connect();
    const txs = await apiCall(page, 'GET', `/transactions?chargepoint_id=${ids.cp}&limit=all`);
    expect(txs.body.total).toBe(1);
    expect(txs.body.data[0]).toMatchObject({ id_tag: badge, tag_category: 'pro' });
  });

  test('renommer une borne connectée : déconnectée, aucune borne fantôme recréée', async ({
    loggedInPage: page,
  }) => {
    const cli = ids.live;
    const closed = new Promise((resolve) => cli.once('close', resolve));
    const upd = await apiCall(
      page,
      'PUT',
      `/chargepoints/${ids.cp}`,
      cpBody(identities.renamedOnline)
    );
    expect(upd.status).toBe(200);
    await closed;
    ids.live = null;
    // laisser le serveur traiter la fermeture (mise à jour « déconnectée »)
    await page.waitForTimeout(300);
    const all = await apiCall(page, 'GET', '/chargepoints');
    expect(all.body.some((c) => c.identity === identities.replaced)).toBe(false);
    expect(all.body.filter((c) => c.id === ids.cp)).toHaveLength(1);
  });

  test('archivage du site : borne refusée, historique lisible, écritures refusées', async ({
    loggedInPage: page,
  }) => {
    const arch = await apiCall(page, 'POST', `/sites/${ids.site}/archive`);
    expect(arch.status).toBe(200);
    expect(arch.body.archived_chargepoints).toBe(1);
    expect(arch.body.archived_at).toBeTruthy();

    expect(await canConnect(identities.renamedOnline)).toBe(false);
    const txs = await apiCall(page, 'GET', `/transactions?site_id=${ids.site}&limit=all`);
    expect(txs.body.total).toBe(1);

    const edit = await apiCall(page, 'PUT', `/sites/${ids.site}`, { name: `E2EL3Site${suffix}` });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('ERR_SITE_ARCHIVED');
    const tag = await apiCall(page, 'POST', '/id-tags', {
      id_tag: `L3ARC${short}`,
      site_id: ids.site,
    });
    expect(tag.status).toBe(409);
    const cpEdit = await apiCall(page, 'PUT', `/chargepoints/${ids.cp}`, cpBody(identities.first));
    expect(cpEdit.status).toBe(409);
    expect(cpEdit.body.error).toBe('ERR_CHARGEPOINT_ARCHIVED');
  });

  test('interface : site archivé signalé et restauré depuis la page Sites', async ({
    loggedInPage: page,
  }) => {
    await page.locator('#navSites').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: `E2EL3Site${suffix}` });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText(/Archivé|Archived/);
    await expect(row.locator('[data-onclick*="showEditSiteModal"]')).toHaveCount(0);
    await row.locator('[data-onclick*="restoreSite"]').click();
    await page.locator('#confirmBtnOk').click();
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 10000 });
    await expect(row.locator('[data-onclick*="archiveSite"]')).toBeVisible({ timeout: 10000 });

    // restaurée : la borne se connecte de nouveau (connexion gardée pour le test suivant)
    ids.live = makeClient(identities.renamedOnline);
    await ids.live.connect();
  });

  test('compte désactivé : connexion et badge refusés, puis réactivé', async ({
    loggedInPage: page,
    browser,
  }) => {
    const off = await apiCall(page, 'PUT', `/users/${ids.employee}/disabled`, { disabled: true });
    expect(off.status).toBe(200);
    expect(off.body.disabled_at).toBeTruthy();
    const self = await apiCall(page, 'PUT', `/users/${(await apiCall(page, 'GET', '/auth/me')).body.id}/disabled`, {
      disabled: true,
    });
    expect(self.status).toBe(403);

    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      await other.goto('/');
      const login = await apiCall(other, 'POST', '/auth/login', {
        useremail: emails.employee,
        password,
      });
      expect(login.status).toBe(401);
      expect(login.body.error).toBe('ERR_ACCOUNT_DISABLED');
    } finally {
      await context.close();
    }

    try {
      const auth = await ids.live.call('Authorize', { idTag: badge });
      expect(auth.idTagInfo.status).toBe('Blocked');
    } finally {
      await ids.live.close();
      ids.live = null;
    }

    const on = await apiCall(page, 'PUT', `/users/${ids.employee}/disabled`, { disabled: false });
    expect(on.status).toBe(200);
    expect(on.body.disabled_at).toBeNull();
  });

  test('dernier manager : ni retrait, ni désactivation, ni suppression', async ({
    loggedInPage: page,
  }) => {
    for (const [method, url, data] of [
      ['DELETE', `/users/${ids.manager}`],
      ['PUT', `/users/${ids.manager}/disabled`, { disabled: true }],
      ['DELETE', `/sites/${ids.site}/users/${ids.manager}`],
      ['PUT', `/users/${ids.manager}/sites`, { sites: [{ site_id: ids.site, role: 'user', authorized: 1 }] }],
      ['PATCH', `/sites/${ids.site}/users/${ids.manager}`, { role: 'user' }],
    ]) {
      const res = await apiCall(page, method, url, data);
      expect(res.status, `${method} ${url}`).toBe(400);
      expect(res.body.error).toBe('ERR_LAST_SITE_MANAGER');
    }
    // e-mail déjà utilisé, quelle que soit la casse
    const dup = await apiCall(page, 'POST', '/users', {
      useremail: emails.manager.toUpperCase(),
      password,
      shortname: 'L3 Doublon',
      role: 'user',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('ERR_EMAIL_ALREADY_USED');
    // rôle global « manager » : refusé (rôle de site seulement)
    const role = await apiCall(page, 'PUT', `/users/${ids.employee}`, {
      useremail: emails.employee,
      role: 'manager',
    });
    expect(role.status).toBe(400);
  });

  test('suppression d’un compte : export proposé, sessions anonymisées, badge détaché', async ({
    loggedInPage: page,
  }) => {
    const csv = await apiCall(page, 'GET', `/transactions/csv?user_id=${ids.employee}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('L3 Salarie');

    await page.locator('#navUsers').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: emails.employee });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.locator('[data-onclick*="deleteUser"]').click();
    await expect(
      page.locator(`#modalContent a[href="/api/transactions/csv?user_id=${ids.employee}"]`)
    ).toBeVisible();
    await page.locator('#modalContent [data-onclick*="execDeleteUser"]').click();
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 10000 });

    const txs = await apiCall(page, 'GET', `/transactions?site_id=${ids.site}&limit=all`);
    expect(txs.body.total).toBe(1);
    expect(txs.body.data[0].tag_username).toMatch(new RegExp(`#${ids.employee}$`));
    expect(txs.body.data[0].tag_username).not.toContain('L3 Salarie');
    const tag = await apiCall(page, 'GET', `/id-tags/${ids.tag}`);
    expect(tag.body).toMatchObject({ active: 0, user_id: null, description: null });
  });

  test.afterAll(async () => {
    if (ids.live) await ids.live.close().catch(() => {});
  });

  test('nettoyage : la borne et le site gardent leur historique, ils sont archivés', async ({
    loggedInPage: page,
  }) => {
    test.setTimeout(120000);
    if (ids.site) await apiCall(page, 'POST', `/sites/${ids.site}/archive`);
    const wait = Math.max(...ocppAttempts) + 61000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  });
});
