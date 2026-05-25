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

  test('peut effacer la date d\'expiration d\'un tag RFID', async ({ loggedInPage: page }) => {
    const tagId = `E2EEXP${Date.now()}`;

    // Créer un tag avec une date d'expiration
    await page.locator('[data-onclick="showCreateIdTagModal()"]').click();
    await page.fill('#tagIdTag', tagId);
    await page.locator('#tagExpiry').evaluate(el => el._flatpickr.setDate('2030-12-31'));
    await page.locator('[data-onclick="withBtn(this, createIdTag)"]').click();
    await expect(page.locator('#tagIdTag')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#pageContent').getByText(tagId)).toBeVisible({ timeout: 8000 });

    // Ouvrir le formulaire d'édition et vider la date
    const row = page.locator('#pageContent table tbody tr', { hasText: tagId });
    await row.locator('[data-onclick*="showEditIdTagModal"]').click();
    await expect(page.locator('#editTagIdTag')).toBeVisible({ timeout: 5000 });
    await page.locator('#editTagExpiry').evaluate(el => el._flatpickr.clear());
    await page.locator('[data-onclick*="updateIdTag"]').click();
    await expect(page.locator('#editTagIdTag')).toBeHidden({ timeout: 5000 });

    // Vérifier que la date a bien été supprimée
    await row.locator('[data-onclick*="showEditIdTagModal"]').click();
    await expect(page.locator('#editTagExpiry')).toHaveValue('');

    // Nettoyage
    await page.locator('#modalContent [data-onclick="closeModal()"]').click();
    await expect(page.locator('#modalOverlay')).toBeHidden({ timeout: 5000 });
    await row.locator('[data-onclick*="deleteIdTag"]').click();
    await page.locator('#confirmBtnOk').click();
    await expect(page.locator('#pageContent').getByText(tagId)).toBeHidden({ timeout: 8000 });
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
