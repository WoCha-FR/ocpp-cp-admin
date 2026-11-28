'use strict';

const { test, expect } = require('./fixtures');

async function csrfHeaders(page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
  return { 'x-xsrf-token': csrf, 'content-type': 'application/json' };
}

test.describe('Page Administration système', () => {
  test('un utilisateur non-admin n\'a pas accès à la page Administration', async ({ loggedInPage: page, browser }) => {
    const headers = await csrfHeaders(page);
    const email = `e2e-admin-guard-${Date.now()}@example.com`;
    const password = 'TestPass!123';

    const createResp = await page.request.post('/api/users', {
      headers,
      data: JSON.stringify({ useremail: email, password, shortname: 'E2E Guard', role: 'user' }),
    });
    expect(createResp.ok()).toBeTruthy();
    const created = await createResp.json();

    const managerContext = await browser.newContext();
    try {
      const managerPage = await managerContext.newPage();
      await managerPage.goto('/');
      const managerHeaders = await csrfHeaders(managerPage);
      const loginResp = await managerPage.request.post('/api/auth/login', {
        headers: managerHeaders,
        data: JSON.stringify({ useremail: email, password }),
      });
      expect(loginResp.ok()).toBeTruthy();

      await managerPage.goto('/');
      await managerPage.locator('#appPage').waitFor({ state: 'visible', timeout: 10000 });

      // Pas de lien "Administration" dans la nav
      await expect(managerPage.locator('#navAdmin')).toBeHidden({ timeout: 10000 });

      // Accès direct bloqué : navigate('admin') redirige vers le dashboard
      await managerPage.evaluate(() => navigate('admin'));
      const landedPage = await managerPage.evaluate(() => currentPage);
      expect(landedPage).toBe('dashboard');
      await expect(managerPage.locator('#pageContent .tabs')).toHaveCount(0);
    } finally {
      await managerContext.close();
    }

    const delResp = await page.request.delete(`/api/users/${created.id}`, { headers });
    expect(delResp.ok()).toBeTruthy();
  });

  test('affiche les informations système et permet le téléchargement de la sauvegarde', async ({ loggedInPage: page }) => {
    await page.locator('#navAdmin').click();
    await page.locator('#adminInfoBody .stats-grid').waitFor({ timeout: 10000 });

    const statValues = page.locator('#adminInfoBody .stat-value');
    await expect(statValues).toHaveCount(5);
    for (const value of await statValues.allTextContents()) {
      expect(value.trim().length).toBeGreaterThan(0);
    }

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-onclick="downloadDbBackup()"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^cpadmin-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  test('nettoyage des données : annulation puis confirmation avec succès', async ({ loggedInPage: page }) => {
    await page.locator('#navAdmin').click();
    await page.locator('[data-onclick="switchAdminTab(\'cleanup\')"]').click();
    await page.locator('#cleanupStatsBody table').waitFor({ timeout: 10000 });

    const deleteBtn = page.locator('[data-onclick="openCleanupModal(\'reservations\')"]');

    // Annulation : pas de suppression déclenchée
    await deleteBtn.click();
    await expect(page.locator('#cleanupModalDate')).toBeVisible({ timeout: 5000 });
    await page.locator('#modalContent [data-onclick="closeModal()"]').click();
    await expect(page.locator('#modalOverlay')).toBeHidden({ timeout: 5000 });

    // Confirmation : suppression avec date obligatoire
    await deleteBtn.click();
    await expect(page.locator('#cleanupModalDate')).toBeVisible({ timeout: 5000 });
    await page.fill('#cleanupModalDate', '2020-01-01');
    await page.locator('[data-onclick*="confirmCleanupAction"]').click();
    await expect(page.locator('#modalOverlay')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
  });

  test('rétention automatique : inactive sans la clé (instance mise à jour), activation par la configuration', async ({ loggedInPage: page }) => {
    const cookies = await page.context().cookies();
    const headers = { 'x-xsrf-token': cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '' };
    // config.e2e.json n'a pas de section retention : cas d'une instance mise à jour
    const status = await (await page.request.get('/api/admin/retention')).json();
    expect(status).toMatchObject({ enabled: false, source: 'default' });
    expect(status.days).toMatchObject({ ocppMessages: 90, meterValues: 730, sessions: 1825 });
    // Passage immédiat refusé tant qu'elle est inactive
    expect((await page.request.post('/api/admin/retention/run', { headers })).status()).toBe(409);
    expect((await page.request.put('/api/admin/retention/enabled', { headers })).status()).toBe(404);

    await page.locator('#navAdmin').click();
    await page.locator(`[data-onclick="switchAdminTab('cleanup')"]`).click();
    const table = page.locator('#retentionTable');
    await expect(table).toBeVisible({ timeout: 10000 });
    await expect(table.locator('tr[data-retention="sessions"]')).toContainText(/1825/);
    await expect(page.locator('#retentionBody .push-prompt-banner')).toBeVisible();
    await expect(page.locator('#retentionBody [data-onclick*="runRetentionNow"]')).toHaveCount(0);

    // « Activer » mène à l'éditeur de configuration, section Rétention des données
    await page.locator('#retentionConfigBtn').click();
    await expect(page.locator('#configTabContent')).toContainText('retention.enabled', { timeout: 10000 });
  });

  test('console OCPP : formulaire masqué et message adapté sans borne connectée', async ({ loggedInPage: page }) => {
    await page.locator('#navAdmin').click();
    await page.locator('[data-onclick="switchAdminTab(\'console\')"]').click();
    await page.locator('#adminTabContent .card').first().waitFor({ timeout: 10000 });

    // Aucune borne connectée dans l'environnement e2e : le formulaire ne doit pas s'afficher
    await expect(page.locator('#consoleCpSelect')).toHaveCount(0);
    await expect(page.locator('#consoleMethodInput')).toHaveCount(0);
    await expect(page.locator('#adminTabContent .text-muted').first()).toBeVisible();

    // Historique vide par défaut
    await expect(page.locator('#consoleHistoryBody .text-muted')).toBeVisible();
  });

  test('comparaison OCPP : sélection de bornes et affichage du résultat pivoté', async ({ loggedInPage: page }) => {
    const headers = await csrfHeaders(page);
    const suffix = Date.now();

    const siteResp = await page.request.post('/api/sites', {
      headers,
      data: JSON.stringify({ name: `E2E Compare Site ${suffix}` }),
    });
    expect(siteResp.ok()).toBeTruthy();
    const site = await siteResp.json();

    const cpIds = [];
    for (const n of [1, 2]) {
      const resp = await page.request.post('/api/chargepoints', {
        headers,
        data: JSON.stringify({
          identity: `E2ECMP${suffix}${n}`,
          name: `E2E Compare ${n}`,
          mode: 1,
          site_id: site.id,
        }),
      });
      expect(resp.ok()).toBeTruthy();
      const cp = await resp.json();
      cpIds.push(cp.id);
    }

    try {
      await page.locator('#navAdmin').click();
      await page.locator('[data-onclick="switchAdminTab(\'compare\')"]').click();
      await page.locator('#compareCpList').waitFor({ timeout: 10000 });

      for (const id of cpIds) {
        await page.locator(`#compareCpList input[type="checkbox"][value="${id}"]`).check();
      }

      const runBtn = page.locator('#compareRunBtn');
      await expect(runBtn).toBeEnabled();
      await runBtn.click();

      await expect(page.locator('#compareResult table')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#compareResult').getByText('E2E Compare 1')).toBeVisible();
      await expect(page.locator('#compareResult').getByText('E2E Compare 2')).toBeVisible();
    } finally {
      for (const id of cpIds) {
        await page.request.delete(`/api/chargepoints/${id}`, { headers });
      }
      await page.request.delete(`/api/sites/${site.id}`, { headers });
    }
  });
});
