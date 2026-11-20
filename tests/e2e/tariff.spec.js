'use strict';

const { RPCClient } = require('ocpp-rpc');
const { test, expect } = require('./fixtures');

const OCPP_ENDPOINT = 'ws://localhost:9099';
const START = '2026-01-12T20:00:00.000Z'; // lundi 21:00 à Paris (hiver, UTC+1)
const STOP = '2026-01-12T22:00:00.000Z'; // lundi 23:00 à Paris

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
    body = null; // réponse non JSON (export CSV)
  }
  return { status: resp.status(), body, raw: text };
}

// Simule une borne OCPP 1.6 : une session de 10 kWh entre START et STOP (sans MeterValues → prorata)
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
    await cli.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
    const started = await cli.call('StartTransaction', {
      connectorId: 1,
      idTag,
      meterStart: 0,
      timestamp: START,
    });
    await cli.call('StopTransaction', {
      transactionId: started.transactionId,
      meterStop: 10000,
      timestamp: STOP,
    });
    return String(started.transactionId);
  } finally {
    await cli.close();
  }
}

test.describe.serial('Tarification du kWh', () => {
  const suffix = Date.now();
  const siteName = `E2ETarif${suffix}`;
  const identity = `E2ETF-${suffix}`;
  let siteId;
  let transactionId;

  test('prépare un site et une borne en mode libre', async ({ loggedInPage: page }) => {
    const site = await apiCall(page, 'POST', '/sites', { name: siteName, address: '' });
    expect(site.status).toBe(201);
    siteId = site.body.id;
    const cp = await apiCall(page, 'POST', '/chargepoints', {
      identity,
      name: `Borne tarif ${suffix}`,
      mode: 3,
      site_id: siteId,
    });
    expect(cp.status).toBeLessThan(300);
  });

  test('le site n\'a pas de tarif au départ', async ({ loggedInPage: page }) => {
    await page.locator('#navSites').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: siteName });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator('[data-onclick*="showSiteTariffModal"]')).toBeVisible();
    await expect(row.getByText(/Non configuré|Not configured/)).toBeVisible();
  });

  test('refuse une grille dont les tranches se chevauchent', async ({ loggedInPage: page }) => {
    await page.locator('#navSites').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: siteName });
    await row.locator('[data-onclick*="showSiteTariffModal"]').click();
    await expect(page.locator('#tariffDefaultPrice')).toBeVisible({ timeout: 5000 });

    await page.fill('#tariffDefaultPrice', '0.30');
    for (let i = 0; i < 2; i++) {
      await page.locator('[data-onclick="tariffAddPeriod()"]').click();
    }
    const periods = page.locator('#tariffPeriods .tariff-period');
    await periods.nth(0).locator('.tp-start').fill('06:00');
    await periods.nth(0).locator('.tp-end').fill('22:00');
    await periods.nth(0).locator('.tp-price').fill('0.25');
    await periods.nth(1).locator('.tp-start').fill('20:00'); // chevauche 06:00 → 22:00
    await periods.nth(1).locator('.tp-end').fill('23:00');
    await periods.nth(1).locator('.tp-price').fill('0.15');

    await page.locator('#modalContent [data-onclick*="saveSiteTariff"]').click();
    await expect(page.locator('.toast-error')).toContainText(/chevauchent|overlap/, { timeout: 5000 });
    // la modale reste ouverte
    await expect(page.locator('#tariffDefaultPrice')).toBeVisible();
    await page.locator('#modalContent [data-onclick="closeModal()"]').click();
  });

  test('enregistre une grille HP/HC via la modale', async ({ loggedInPage: page }) => {
    await page.locator('#navSites').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: siteName });
    await row.locator('[data-onclick*="showSiteTariffModal"]').click();
    await expect(page.locator('#tariffDefaultPrice')).toBeVisible({ timeout: 5000 });

    await page.fill('#tariffDefaultPrice', '0.30');
    for (let i = 0; i < 2; i++) {
      await page.locator('[data-onclick="tariffAddPeriod()"]').click();
    }
    const periods = page.locator('#tariffPeriods .tariff-period');
    await periods.nth(0).locator('.tp-label').fill('HP');
    await periods.nth(0).locator('.tp-start').fill('06:00');
    await periods.nth(0).locator('.tp-end').fill('22:00');
    await periods.nth(0).locator('.tp-price').fill('0.25');
    await periods.nth(1).locator('.tp-label').fill('HC');
    await periods.nth(1).locator('.tp-start').fill('22:00');
    await periods.nth(1).locator('.tp-end').fill('06:00');
    await periods.nth(1).locator('.tp-price').fill('0.15');

    await page.locator('#modalContent [data-onclick*="saveSiteTariff"]').click();
    await expect(page.locator('#tariffDefaultPrice')).toBeHidden({ timeout: 5000 });

    const tf = await apiCall(page, 'GET', `/sites/${siteId}/tariff`);
    expect(tf.status).toBe(200);
    expect(tf.body.default_price_per_kwh).toBe(0.3);
    expect(tf.body.periods.map((p) => p.label).sort()).toEqual(['HC', 'HP']);

    // Le résumé du tarif apparaît dans la liste des sites
    const updatedRow = page.locator('#pageContent table tbody tr', { hasText: siteName });
    await expect(updatedRow.getByText('/kWh')).toBeVisible({ timeout: 8000 });
  });

  test('une session simulée a son coût figé, visible en liste et en détail', async ({
    loggedInPage: page,
  }) => {
    transactionId = await simulateSession(identity, `E2ETAG${suffix}`.slice(0, 20));

    // 5 kWh en HP (0.25) + 5 kWh en HC (0.15) = 2,00 €
    const detail = await apiCall(page, 'GET', `/transactions/${transactionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.cost).toBe(2);
    expect(detail.body.cost_currency).toBe('EUR');
    expect(JSON.parse(detail.body.cost_details).segments.map((s) => s.label)).toEqual(['HP', 'HC']);

    await page.locator('#navTransactions').click();
    const row = page.locator('#pageContent table tbody tr', { hasText: transactionId });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText(/2[.,]00/);
    await expect(page.locator('.stat-card', { hasText: /Coût total|Total cost/ })).toBeVisible();

    await row.locator('[data-onclick*="showTransactionDetail"]').click();
    const card = page.locator('#pageContent .card', { hasText: /Détail du coût|Cost breakdown/ });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('HP');
    await expect(card).toContainText('HC');
    await expect(card).toContainText(/2[.,]00/);
  });

  test('l\'export CSV contient les colonnes de coût', async ({ loggedInPage: page }) => {
    const res = await apiCall(page, 'GET', `/transactions/csv?site_id=${siteId}`);
    expect(res.status).toBe(200);
    const [head, line] = res.raw.replace('﻿', '').split('\r\n');
    // en-têtes dans la langue de l'utilisateur (fr ou en selon l'état de la base e2e)
    expect(head).toMatch(/Coût|Cost/);
    expect(head).toMatch(/Devise|Currency/);
    expect(head).toMatch(/Prix moyen|Average price/);
    expect(head).toMatch(/Détail tarifaire|Tariff breakdown/);
    expect(line).toContain('"2.00"');
    expect(line).toContain('"EUR"');
    expect(line).toContain('HP 5.00 kWh × 0.2500 = 1.25');
  });

  test('modifier la grille ne change pas le coût de la session passée', async ({
    loggedInPage: page,
  }) => {
    const put = await apiCall(page, 'PUT', `/sites/${siteId}/tariff`, {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      default_price_per_kwh: 1,
      periods: [],
    });
    expect(put.status).toBe(200);
    const detail = await apiCall(page, 'GET', `/transactions/${transactionId}`);
    expect(detail.body.cost).toBe(2);
  });

  test('l\'API de tarif exige une authentification', async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const res = await anon.get(`/api/sites/${siteId}/tariff`);
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test('nettoyage', async ({ loggedInPage: page }) => {
    const cps = await apiCall(page, 'GET', '/chargepoints');
    const cp = cps.body.find((c) => c.identity === identity);
    if (cp) await apiCall(page, 'DELETE', `/chargepoints/${cp.id}`);
    await apiCall(page, 'DELETE', `/sites/${siteId}`);
  });
});
