'use strict';

// Lot 4 : tarif daté saisi en retard (aperçu, confirmation, recalcul tracé), correction du badge
// d'une session (motif obligatoire, coût inchangé) et section « Régularisations » de l'export
// remboursement. Une session passée (il y a 40 jours) jouée par une borne OCPP 1.6 simulée.

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

test.describe.serial('Tarifs datés, corrections et régularisations (lot 4)', () => {
  const suffix = Date.now();
  const short = String(suffix).slice(-8);
  const siteName = `E2EL4Site${suffix}`;
  const identity = `E2EL4-${suffix}`;
  const password = 'TestPass!123';
  const badges = { paul: `L4PAUL${short}`, anne: `L4ANNE${short}` };
  const ids = {};
  // Session passée : il y a 40 jours, 08:00 → 09:00 UTC, 10 kWh (toujours avant le mois en cours)
  const startMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() - 40,
    8
  );
  const sessionDate = new Date(startMs).toISOString().slice(0, 10);
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const tariffBody = (grids, extra = {}) => ({
    currency: 'EUR',
    timezone: 'Europe/Paris',
    grids,
    ...extra,
  });
  const flat = (price, from = null) => ({ valid_from: from, default_price_per_kwh: price, periods: [] });

  test('prépare : site à 0,20 €/kWh, deux salariés avec badge pro, une session passée', async ({
    loggedInPage: page,
  }) => {
    const site = await apiCall(page, 'POST', '/sites', { name: siteName, address: '' });
    expect(site.status).toBe(201);
    ids.site = site.body.id;
    expect((await apiCall(page, 'PUT', `/sites/${ids.site}/tariff`, tariffBody([flat(0.2)]))).status).toBe(200);
    const cp = await apiCall(page, 'POST', '/chargepoints', {
      identity,
      name: `L4 borne ${short}`,
      mode: 1,
      site_id: ids.site,
    });
    expect(cp.status).toBe(201);

    for (const [who, shortname] of [
      ['paul', 'L4 Paul'],
      ['anne', 'L4 Anne'],
    ]) {
      const u = await apiCall(page, 'POST', '/users', {
        useremail: `e2e-l4-${who}-${suffix}@example.com`,
        password,
        shortname,
        role: 'user',
      });
      expect(u.status).toBe(201);
      ids[who] = u.body.id;
      await apiCall(page, 'PUT', `/users/${u.body.id}/sites`, {
        sites: [{ site_id: ids.site, role: 'user', authorized: 1 }],
      });
      const tag = await apiCall(page, 'POST', '/id-tags', {
        id_tag: badges[who],
        user_id: u.body.id,
        category: 'pro',
      });
      expect(tag.status).toBe(201);
    }

    const cli = new RPCClient({ endpoint: OCPP_ENDPOINT, identity, protocols: ['ocpp1.6'], strictMode: false });
    cli.handle(() => ({ status: 'Accepted' }));
    await cli.connect();
    try {
      await cli.call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'SIM' });
      const started = await cli.call('StartTransaction', {
        connectorId: 1,
        idTag: badges.paul,
        meterStart: 0,
        timestamp: new Date(startMs).toISOString(),
      });
      expect(started.idTagInfo.status).toBe('Accepted');
      await cli.call('StopTransaction', {
        transactionId: started.transactionId,
        meterStop: 10000,
        timestamp: new Date(startMs + 3600000).toISOString(),
      });
    } finally {
      await cli.close();
    }
    const txs = await apiCall(page, 'GET', `/transactions?site_id=${ids.site}&limit=all`);
    expect(txs.body.total).toBe(1);
    ids.tx = txs.body.data[0].id;
    expect(txs.body.data[0]).toMatchObject({ cost: 2, tag_username: 'L4 Paul' });
  });

  test('tarif daté saisi en retard : aperçu, refus sans confirmation', async ({ loggedInPage: page }) => {
    const late = tariffBody([flat(0.2), flat(0.3, sessionDate)]);
    const dry = await apiCall(page, 'PUT', `/sites/${ids.site}/tariff`, { ...late, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.preview).toMatchObject({
      count: 1,
      totals: [{ currency: 'EUR', old_cost: 2, new_cost: 3, delta: 1 }],
    });
    const refused = await apiCall(page, 'PUT', `/sites/${ids.site}/tariff`, late);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('ERR_TARIFF_RECALC_CONFIRM_REQUIRED');
    // un tarif futur s'enregistre sans confirmation
    const future = await apiCall(page, 'PUT', `/sites/${ids.site}/tariff`, tariffBody([flat(0.2), flat(0.5, '2099-01-01')]));
    expect(future.status).toBe(200);
    expect(future.body.recalculated).toBe(0);
    expect((await apiCall(page, 'GET', `/transactions/${ids.tx}`)).body.cost).toBe(2);
  });

  test('interface : grille datée ajoutée, recalcul confirmé et tracé', async ({ loggedInPage: page }) => {
    await page.locator('#navSites').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: siteName });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText(/0[.,]5/); // prochain tarif (2099) annoncé
    await row.locator('[data-onclick*="showSiteTariffModal"]').click();
    await expect(page.locator('#tariffGrids')).toBeVisible({ timeout: 5000 });
    await page.locator('#tariffNewFrom').fill(sessionDate);
    await page.locator('[data-onclick="tariffAddGrid()"]').click();
    await page.locator('#tariffDefaultPrice').fill('0.3');
    await page.locator('#modalContent [data-onclick*="saveSiteTariff"]').click();
    await expect(page.locator('#confirmMessage')).toContainText(/1 session/, { timeout: 5000 });
    await page.locator('#confirmBtnOk').click();
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 10000 });

    const tx = await apiCall(page, 'GET', `/transactions/${ids.tx}`);
    expect(tx.body.cost).toBe(3);
    expect(tx.body.corrections).toEqual([
      expect.objectContaining({ kind: 'tariff', old_cost: 2, new_cost: 3 }),
    ]);
    const tariff = await apiCall(page, 'GET', `/sites/${ids.site}/tariff`);
    expect(tariff.body.grids.map((g) => g.valid_from)).toEqual([null, sessionDate, '2099-01-01']);
  });

  test('interface : correction du badge avec motif, coût inchangé', async ({ loggedInPage: page }) => {
    const empty = await apiCall(page, 'POST', `/transactions/${ids.tx}/badge-correction`, {
      id_tag_id: 1,
      reason: '',
    });
    expect(empty.status).toBe(400);

    await page.evaluate((id) => showTransactionDetail(id, 'transactions'), ids.tx);
    await page.locator('#topbarActions [data-onclick*="showBadgeCorrectionModal"]').click();
    const select = page.locator('#corrTagId');
    await expect(select).toBeVisible({ timeout: 5000 });
    await select.selectOption(await select.locator('option', { hasText: badges.anne }).getAttribute('value'));
    await page.locator('#corrReason').fill('badge prêté par Paul');
    await page.locator('#modalContent [data-onclick*="submitBadgeCorrection"]').click();
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#pageContent')).toContainText('badge prêté par Paul', { timeout: 10000 });

    const tx = await apiCall(page, 'GET', `/transactions/${ids.tx}`);
    expect(tx.body).toMatchObject({ id_tag: badges.anne, tag_username: 'L4 Anne', tag_category: 'pro', cost: 3 });
    expect(tx.body.corrections.map((c) => c.kind)).toEqual(['tariff', 'badge']);
    expect(tx.body.corrections[1]).toMatchObject({ old_id_tag: badges.paul, reason: 'badge prêté par Paul' });
  });

  test('export remboursement du mois : section « Régularisations » pour la session passée', async ({
    loggedInPage: page,
  }) => {
    const res = await apiCall(
      page,
      'GET',
      `/transactions/reimbursement/csv?category=pro&site_id=${ids.site}&from=${monthStart}`
    );
    expect(res.status).toBe(200);
    const lines = String(res.body).split('\r\n');
    const title = lines.findIndex((l) => l.includes('Régularisations') || l.includes('Adjustments'));
    expect(title).toBeGreaterThan(-1);
    const section = lines.slice(title + 2).join('\n');
    // tarif : +1,00 pour Paul ; badge : session retirée à Paul (−3,00) et ajoutée à Anne (+3,00)
    expect(section).toMatch(/"L4 Paul"[^\n]*"1\.00";"EUR"/);
    expect(section).toMatch(/"L4 Paul"[^\n]*"-10\.00";"-3\.00";"EUR"/);
    expect(section).toMatch(/"L4 Anne"[^\n]*"10\.00";"3\.00";"EUR"/);
    expect(section).toMatch(/"1\.00";"EUR"\s*$/); // total : +1,00
    // la période de la session elle-même : pas de régularisation, valeurs corrigées
    const sessionMonth = await apiCall(
      page,
      'GET',
      `/transactions/reimbursement/csv?category=pro&site_id=${ids.site}&from=${sessionDate}&to=${sessionDate}`
    );
    expect(String(sessionMonth.body)).not.toMatch(/Régularisations|Adjustments/);
    expect(String(sessionMonth.body)).toMatch(/"L4 Anne"[^\r]*"3\.00"/);
  });

  test('nettoyage : le site garde son historique, il est archivé', async ({ loggedInPage: page }) => {
    if (ids.site) await apiCall(page, 'POST', `/sites/${ids.site}/archive`);
  });
});
