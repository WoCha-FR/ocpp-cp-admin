'use strict';

const { test, expect } = require('./fixtures');

test.describe('Tableau de bord', () => {
  test('affiche les cartes de statistiques après login', async ({ loggedInPage: page }) => {
    // Le dashboard est la page par défaut après login
    await expect(page.locator('.stat-card').first()).toBeVisible({ timeout: 10000 });
    const statCards = page.locator('.stat-card');
    expect(await statCards.count()).toBeGreaterThanOrEqual(2);
  });

  test('affiche les KPI de recharge', async ({ loggedInPage: page }) => {
    await expect(page.locator('#kpiContainer')).toBeVisible({ timeout: 10000 });
  });

  test('les sélecteurs de période KPI sont présents', async ({ loggedInPage: page }) => {
    await expect(page.locator('.kpi-period-btn').first()).toBeVisible({ timeout: 8000 });
    const periodBtns = page.locator('.kpi-period-btn');
    expect(await periodBtns.count()).toBeGreaterThanOrEqual(4);
  });

  test('aucune erreur JS dans la console', async ({ loggedInPage: page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Attendre le chargement complet
    await page.locator('.stat-card').first().waitFor({ timeout: 10000 });
    expect(errors).toHaveLength(0);
  });
});
