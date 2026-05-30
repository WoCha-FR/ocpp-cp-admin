'use strict';

const { test, expect } = require('./fixtures');

test.describe('Page Alertes (historique d\'erreurs)', () => {
  test('le lien de navigation "Alertes" est visible pour un admin', async ({ loggedInPage: page }) => {
    await expect(page.locator('#navErrorEvents')).toBeVisible({ timeout: 10000 });
  });

  test('navigue vers la page Alertes depuis la sidebar', async ({ loggedInPage: page }) => {
    await page.locator('#navErrorEvents').click();
    await page.locator('#pageContent').waitFor({ timeout: 10000 });

    const title = page.locator('#pageTitle');
    await expect(title).toBeVisible({ timeout: 10000 });
  });

  test('affiche les filtres (site, borne, type, période)', async ({ loggedInPage: page }) => {
    await page.locator('#navErrorEvents').click();
    await page.locator('#eeFilterCp').waitFor({ timeout: 10000 });

    await expect(page.locator('#eeFilterSite')).toBeVisible();
    await expect(page.locator('#eeFilterCp')).toBeVisible();
    await expect(page.locator('#eeFilterType')).toBeVisible();
    // flatpickr crée un alt input (class="form-control input") comme sibling de l'input original
    await expect(page.locator('#eeFilterFrom + input')).toBeVisible();
    await expect(page.locator('#eeFilterTo + input')).toBeVisible();
  });

  test('affiche un tableau ou un message vide (pas d\'erreur JS)', async ({ loggedInPage: page }) => {
    await page.locator('#navErrorEvents').click();
    await page.locator('#pageContent').waitFor({ timeout: 10000 });

    // Attendre que la page ait fini de charger (disparition du spinner ou présence de contenu)
    await page.waitForSelector('#eeFilterCp', { timeout: 10000 });

    const hasTable = await page.locator('#pageContent table').count() > 0;
    const hasEmpty = await page.locator('#pageContent .text-muted').count() > 0;
    expect(hasTable || hasEmpty).toBeTruthy();
  });

  test('le bouton réinitialiser les filtres est présent', async ({ loggedInPage: page }) => {
    await page.locator('#navErrorEvents').click();
    await page.locator('#eeFilterCp').waitFor({ timeout: 10000 });

    await expect(page.locator('[data-onclick="resetErrorEventsFilters()"]')).toBeVisible();
  });

  test('les filtres se réinitialisent à chaque ouverture de page', async ({ loggedInPage: page }) => {
    // Aller sur la page, sélectionner un type
    await page.locator('#navErrorEvents').click();
    await page.locator('#eeFilterType').waitFor({ timeout: 10000 });
    await page.locator('#eeFilterType').selectOption('disconnect');

    // Naviguer ailleurs puis revenir
    await page.locator('[data-page="dashboard"]').click();
    await page.locator('#navErrorEvents').click();
    await page.locator('#eeFilterType').waitFor({ timeout: 10000 });

    // Le filtre doit être remis à vide
    const selectedValue = await page.locator('#eeFilterType').inputValue();
    expect(selectedValue).toBe('');
  });
});
