'use strict';

// Lot 2 : droits du gestionnaire sur les badges, règles des badges, badge web automatique par
// site, borne sans site inactive. Cas d'une entreprise : un siège et un domicile de salarié
// gérés par le même gestionnaire, plus un site d'un autre gestionnaire.

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

// Borne 1.6 simulée : une session complète avec ce badge
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
      timestamp: new Date().toISOString(),
    });
    await cli.call('StopTransaction', {
      transactionId: started.transactionId,
      meterStop: 2000,
      timestamp: new Date().toISOString(),
    });
    return started;
  } finally {
    await cli.close();
  }
}

test.describe.serial('Badges : droits du gestionnaire et règles (lot 2)', () => {
  const suffix = Date.now();
  const short = String(suffix).slice(-8);
  const password = 'TestPass!123';
  const emails = {
    manager: `e2e-l2-mgr-${suffix}@example.com`,
    employee: `e2e-l2-emp-${suffix}@example.com`,
    outsider: `e2e-l2-out-${suffix}@example.com`,
    nobadge: `e2e-l2-nob-${suffix}@example.com`,
  };
  const ids = { tags: [] };
  const code = (p) => `${p}${short}`;

  async function as(browser, who, fn) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/');
      const login = await apiCall(page, 'POST', '/auth/login', {
        useremail: emails[who],
        password,
      });
      expect(login.status).toBe(200);
      await fn(page);
    } finally {
      await context.close();
    }
  }

  test('prépare : siège, domicile (badge web interdit), site d’un autre gestionnaire', async ({
    loggedInPage: page,
  }) => {
    const mk = async (key, name, extra = {}) => {
      const r = await apiCall(page, 'POST', '/sites', { name, address: '', ...extra });
      expect(r.status).toBe(201);
      ids[key] = r.body.id;
      return r.body;
    };
    await mk('hq', `E2EL2Siege${suffix}`);
    const home = await mk('home', `E2EL2Dom${suffix}`, { auto_web_badge: 0 });
    expect(home.auto_web_badge).toBe(0);
    await mk('other', `E2EL2Autre${suffix}`);

    const cp = await apiCall(page, 'POST', '/chargepoints', {
      identity: `E2EL2H-${suffix}`,
      name: `L2 domicile ${short}`,
      mode: 1,
      site_id: ids.home,
    });
    expect(cp.status).toBeLessThan(300);
    ids.cpHome = cp.body.id;

    for (const [who, shortname, sites] of [
      [
        'manager',
        'L2 Gestionnaire',
        [
          ['hq', 'manager'],
          ['home', 'manager'],
        ],
      ],
      [
        'employee',
        'L2 Salarie',
        [
          ['hq', 'user'],
          ['home', 'user'],
        ],
      ],
      [
        'outsider',
        'L2 Externe',
        [
          ['hq', 'user'],
          ['other', 'user'],
        ],
      ],
      [
        'nobadge',
        'L2 Sans badge',
        [
          ['home', 'user'],
          ['hq', 'user'],
        ],
      ],
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
        sites: sites.map(([key, role]) => ({ site_id: ids[key], role, authorized: 1 })),
      });
      expect(links.status).toBe(200);
    }
  });

  test('gestionnaire : badge pro global pour son salarié, refusé pour un salarié d’un autre site', async ({
    browser,
  }) => {
    await as(browser, 'manager', async (page) => {
      const users = await apiCall(page, 'GET', '/id-tags/assignable-users');
      expect(users.status).toBe(200);
      const byId = new Map(users.body.map((u) => [u.id, u]));
      expect(byId.get(ids.employee).global_allowed).toBe(true);
      expect(byId.get(ids.outsider).global_allowed).toBe(false);

      const pro = await apiCall(page, 'POST', '/id-tags', {
        id_tag: code('PRO'),
        user_id: ids.employee,
        category: 'pro',
      });
      expect(pro.status).toBe(201);
      ids.tags.push(pro.body.id);
      ids.proTag = pro.body.id;

      const denied = await apiCall(page, 'POST', '/id-tags', {
        id_tag: code('OUT'),
        user_id: ids.outsider,
        category: 'pro',
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('ERR_TAG_GLOBAL_NOT_MANAGED');

      // Badge perso limité au domicile, rattaché au salarié du site
      const perso = await apiCall(page, 'POST', '/id-tags', {
        id_tag: code('PER'),
        user_id: ids.employee,
        site_id: ids.home,
        category: 'perso',
      });
      expect(perso.status).toBe(201);
      ids.tags.push(perso.body.id);
      ids.persoTag = perso.body.id;

      // Le gestionnaire voit et gère ces badges
      const list = await apiCall(page, 'GET', '/id-tags');
      const mine = list.body.filter((t) => [ids.proTag, ids.persoTag].includes(t.id));
      expect(mine).toHaveLength(2);
      expect(mine.every((t) => t.can_manage)).toBe(true);
    });
  });

  test('règles : même code global et site refusé, code figé, badge généré réservé', async ({
    loggedInPage: page,
  }) => {
    const dup = await apiCall(page, 'POST', '/id-tags', {
      id_tag: code('PRO'),
      site_id: ids.home,
      category: 'pro',
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('ERR_TAG_ALREADY_EXISTS');

    const renamed = await apiCall(page, 'PUT', `/id-tags/${ids.proTag}`, {
      id_tag: code('NEW'),
      user_id: ids.employee,
      category: 'pro',
    });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error).toBe('ERR_TAG_CODE_IMMUTABLE');

    const reserved = await apiCall(page, 'POST', '/id-tags', { id_tag: `ADMIN${short}` });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error).toBe('ERR_TAG_RESERVED');
  });

  test('badge qui a servi : suppression refusée (409), désactivation possible', async ({
    loggedInPage: page,
  }) => {
    await simulateSession(`E2EL2H-${suffix}`, code('PER'));
    const del = await apiCall(page, 'DELETE', `/id-tags/${ids.persoTag}`);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: 'ERR_TAG_USED', count: 1 });
    const off = await apiCall(page, 'PUT', `/id-tags/${ids.persoTag}`, {
      id_tag: code('PER'),
      user_id: ids.employee,
      site_id: ids.home,
      category: 'perso',
      active: 0,
    });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(0);
  });

  test('domicile sans badge web automatique : un utilisateur sans badge est refusé', async ({
    browser,
  }) => {
    await as(browser, 'nobadge', async (page) => {
      const tags = await apiCall(
        page,
        'GET',
        `/user/start-charge/id-tags?chargepoint_id=${ids.cpHome}`
      );
      expect(tags.status).toBe(200);
      expect(tags.body).toEqual({ idTags: [], autoWeb: false, blocked: false, noBadge: true });
    });
  });

  test('borne sans site : inactive, la session lancée est enregistrée refusée', async ({
    loggedInPage: page,
  }) => {
    // Site temporaire supprimé : sa borne se retrouve sans site
    const tmp = await apiCall(page, 'POST', '/sites', { name: `E2EL2Tmp${suffix}`, address: '' });
    const identity = `E2EL2NS-${suffix}`;
    const cp = await apiCall(page, 'POST', '/chargepoints', {
      identity,
      name: `L2 sans site ${short}`,
      mode: 3,
      site_id: tmp.body.id,
    });
    ids.cpNoSite = cp.body.id;
    expect((await apiCall(page, 'DELETE', `/sites/${tmp.body.id}`)).status).toBe(200);

    const started = await simulateSession(identity, code('FREE'));
    expect(started.idTagInfo.status).toBe('Blocked');

    const txs = await apiCall(
      page,
      'GET',
      `/transactions?chargepoint_id=${ids.cpNoSite}&status=Rejected&limit=all`
    );
    expect(txs.body.total).toBe(1);

    const web = await apiCall(page, 'POST', '/connectors/start-charge', {
      chargepoint_id: ids.cpNoSite,
      connector_id: 1,
    });
    expect(web.status).toBe(409);
    expect(web.body.error).toBe('ERR_CHARGEPOINT_NO_SITE');
  });

  test('interface du gestionnaire : titulaire, portée « tous les sites », code non modifiable', async ({
    browser,
  }) => {
    await as(browser, 'manager', async (page) => {
      await page.goto('/');
      await page.locator('#appPage').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('#navIdTags').click();
      const row = page.locator('#pageContent table tbody tr', { hasText: code('PRO') });
      await expect(row).toBeVisible({ timeout: 10000 });

      await page.locator('[data-onclick="showCreateIdTagModal()"]').click();
      await expect(page.locator('#tagUserId option', { hasText: 'L2 Salarie' })).toHaveCount(1);
      await expect(page.locator('#tagUserId option', { hasText: 'L2 Gestionnaire' })).toHaveCount(
        1
      );
      await expect(page.locator('#tagSiteId option[value=""]')).toHaveCount(1);
      await page.locator('#modalContent [data-onclick="closeModal()"]').click();
      await expect(page.locator('#modalOverlay')).toBeHidden({ timeout: 5000 });

      await row.locator('[data-onclick*="showEditIdTagModal"]').click();
      await expect(page.locator('#editTagIdTag')).toHaveAttribute('readonly', '');
      await expect(page.locator('#editTagUserId')).toHaveValue(String(ids.employee));
      await expect(page.locator('#editTagSiteId')).toHaveValue('');
    });
  });

  test('interface admin : réglage du badge web automatique dans la fiche du site', async ({
    loggedInPage: page,
  }) => {
    await page.locator('#navSites').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: `E2EL2Dom${suffix}` });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator('.badge-gray')).toBeVisible();
    await row.locator('[data-onclick*="showEditSiteModal"]').click();
    await expect(page.locator('#siteAutoWebBadge')).not.toBeChecked();
    await page.locator('#modalContent [data-onclick="closeModal()"]').click();
  });

  test('nettoyage', async ({ loggedInPage: page }) => {
    for (const key of ['cpHome', 'cpNoSite']) {
      if (ids[key]) await apiCall(page, 'DELETE', `/chargepoints/${ids[key]}`);
    }
    for (const id of ids.tags) await apiCall(page, 'DELETE', `/id-tags/${id}`);
    for (const who of ['manager', 'employee', 'outsider', 'nobadge']) {
      if (ids[who]) await apiCall(page, 'DELETE', `/users/${ids[who]}`);
    }
    for (const key of ['hq', 'home', 'other']) {
      if (ids[key]) await apiCall(page, 'DELETE', `/sites/${ids[key]}`);
    }
  });
});
