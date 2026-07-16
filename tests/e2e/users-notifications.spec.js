'use strict';

const { test, expect } = require('./fixtures');

test.describe('Notifications utilisateur (administration)', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    await page.locator('#navUsers').click();
    await expect(page.locator('#pageContent table')).toBeVisible({ timeout: 10000 });
  });

  test("l'admin peut modifier les notifications d'un utilisateur depuis la page Utilisateurs", async ({ loggedInPage: page }) => {
    const email = `e2e-notif-${Date.now()}@example.com`;

    // Créer un utilisateur de test
    await page.locator('[data-onclick="showCreateUserModal()"]').click();
    await expect(page.locator('#newUseremail')).toBeVisible({ timeout: 5000 });
    await page.fill('#newUseremail', email);
    await page.fill('#newShortname', 'E2E Notif User');
    await page.fill('#newPassword', 'TestPass!123');
    await page.locator('[data-onclick="withBtn(this, createUser)"]').click();
    await expect(page.locator('#newUseremail')).toBeHidden({ timeout: 5000 });
    const row = page.locator('#pageContent table tbody tr', { hasText: email });
    await expect(row).toBeVisible({ timeout: 8000 });

    // Ouvrir la modale de notifications de cet utilisateur
    await row.locator('[data-onclick*="showUserNotificationsModal"]').click();
    const form = page.locator('#userNotifPrefsForm');
    await expect(form).toBeVisible({ timeout: 5000 });

    const firstCheckbox = form.locator('input[type="checkbox"]').first();
    await expect(firstCheckbox).toBeVisible();
    const wasChecked = await firstCheckbox.isChecked();
    if (wasChecked) {
      await firstCheckbox.uncheck();
    } else {
      await firstCheckbox.check();
    }
    const eventType = await firstCheckbox.getAttribute('data-event');
    const channel = await firstCheckbox.getAttribute('data-channel');

    await page.locator('#userNotifPrefsForm button[type="submit"]').click();
    await expect(form).toBeHidden({ timeout: 5000 });

    // Rouvrir la modale et vérifier que le nouvel état a été persisté
    await row.locator('[data-onclick*="showUserNotificationsModal"]').click();
    await expect(form).toBeVisible({ timeout: 5000 });
    const reopenedCheckbox = form.locator(
      `input[type="checkbox"][data-event="${eventType}"][data-channel="${channel}"]`
    );
    await expect(reopenedCheckbox).toHaveJSProperty('checked', !wasChecked);

    // Nettoyage
    await page.locator('#modalContent [data-onclick="closeModal()"]').click();
    await expect(page.locator('#modalOverlay')).toBeHidden({ timeout: 5000 });
    await row.locator('[data-onclick*="deleteUser"]').click();
    await page.locator('#confirmBtnOk').click();
    await expect(page.locator('#pageContent').getByText(email)).toBeHidden({ timeout: 8000 });
  });
});
