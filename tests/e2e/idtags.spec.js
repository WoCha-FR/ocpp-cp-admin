'use strict';

const { test, expect } = require('./fixtures');

test.describe('Tags RFID', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    await page.locator('#navIdTags').click();
    await page.locator('#idTagFilterStatus').waitFor({ timeout: 10000 });
  });

  test('affiche la page des tags RFID depuis la navigation', async ({ loggedInPage: page }) => {
    await expect(page.locator('#idTagFilterStatus')).toBeVisible();
  });

  test('affiche les filtres de la liste', async ({ loggedInPage: page }) => {
    await expect(page.locator('#idTagFilterStatus')).toBeVisible();
    await expect(page.locator('#idTagFilterSite')).toBeVisible();
  });

  test('le bouton d\'ajout est présent dans la barre d\'action', async ({ loggedInPage: page }) => {
    await expect(page.locator('[data-onclick="showCreateIdTagModal()"]')).toBeVisible();
  });

  test('peut ajouter un tag RFID et le voir dans la liste', async ({ loggedInPage: page }) => {
    const tagId = `E2E${Date.now()}`;

    await page.locator('[data-onclick="showCreateIdTagModal()"]').click();
    await expect(page.locator('#tagIdTag')).toBeVisible({ timeout: 5000 });

    await page.fill('#tagIdTag', tagId);
    await page.locator('[data-onclick*="createIdTag"]').click();

    // Attendre que le modal se ferme et la liste se recharge
    await expect(page.locator('#tagIdTag')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#pageContent table')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#pageContent').getByText(tagId)).toBeVisible();
  });

  test('peut supprimer un tag RFID', async ({ loggedInPage: page }) => {
    // Créer un tag à supprimer
    const tagId = `E2EDEL${Date.now()}`;

    await page.locator('[data-onclick="showCreateIdTagModal()"]').click();
    await page.fill('#tagIdTag', tagId);
    await page.locator('[data-onclick*="createIdTag"]').click();
    await expect(page.locator('#tagIdTag')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#pageContent').getByText(tagId)).toBeVisible({ timeout: 8000 });

    // Supprimer le tag — le bouton delete est dans la même ligne
    const row = page.locator('#pageContent table tbody tr', { hasText: tagId });
    await row.locator('[data-onclick*="deleteIdTag"]').click();

    // Confirmer la suppression dans le dialog
    await page.locator('#confirmBtnOk').click();

    await expect(page.locator('#pageContent').getByText(tagId)).toBeHidden({ timeout: 8000 });
  });
});
