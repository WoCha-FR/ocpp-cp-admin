'use strict';

const { test, expect } = require('./fixtures');

test.describe('Bornes de recharge', () => {
  test('affiche la page des bornes depuis la navigation', async ({ loggedInPage: page }) => {
    await page.locator('#navChargePoints').click();
    // Les filtres sont toujours affichés, qu'il y ait des données ou non
    await expect(page.locator('#cpFilterSite')).toBeVisible({ timeout: 10000 });
  });

  test('affiche les filtres de la liste', async ({ loggedInPage: page }) => {
    await page.locator('#navChargePoints').click();
    await page.locator('#cpFilterSite').waitFor({ timeout: 10000 });

    await expect(page.locator('#cpFilterSite')).toBeVisible();
    await expect(page.locator('#cpFilterStatus')).toBeVisible();
    await expect(page.locator('#cpFilterOnline')).toBeVisible();
  });

  test('affiche un état vide ou un tableau de bornes', async ({ loggedInPage: page }) => {
    await page.locator('#navChargePoints').click();
    await page.locator('#cpFilterSite').waitFor({ timeout: 10000 });

    // Soit un tableau, soit le message de liste vide
    const hasTable = await page.locator('#pageContent table').count() > 0;
    const hasEmptyMsg = await page.locator('#pageContent .text-muted').count() > 0;
    expect(hasTable || hasEmptyMsg).toBeTruthy();
  });

  test('le bouton réinitialiser les filtres est présent', async ({ loggedInPage: page }) => {
    await page.locator('#navChargePoints').click();
    await page.locator('#cpFilterSite').waitFor({ timeout: 10000 });

    await expect(page.locator('[data-onclick="resetCpListFilters()"]')).toBeVisible();
  });
});
