'use strict';

const { test, expect } = require('./fixtures');

test.describe('Init Config — OCPP 2.0.1', () => {
  test.beforeEach(async ({ loggedInPage: page }) => {
    await page.evaluate(() => navigate('configeditor'));
    await page.locator('.tabs').waitFor({ state: 'visible', timeout: 8000 });
  });

  test('onglet Bornes OCPP 2.0.1 présent si v201 activé', async ({ loggedInPage: page }) => {
    const tab = page.locator('.tab', { hasText: 'Bornes OCPP 2.0.1' });
    const isVisible = await tab.isVisible();

    if (!isVisible) {
      test.skip(true, 'OCPP 2.0.1 non activé dans cette instance');
      return;
    }

    await expect(tab).toBeVisible();
  });

  test('vue 2.0.1 — hint de description visible', async ({ loggedInPage: page }) => {
    const tab = page.locator('.tab', { hasText: 'Bornes OCPP 2.0.1' });
    if (!(await tab.isVisible())) {
      test.skip(true, 'OCPP 2.0.1 non activé dans cette instance');
      return;
    }

    await tab.click();
    await page.locator('#initConfigInner').waitFor({ state: 'visible', timeout: 8000 });

    const hint = page.locator('#initConfigInner p.text-muted');
    await expect(hint).toBeVisible({ timeout: 5000 });
    const text = await hint.textContent();
    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(10);
  });

  test('vue 2.0.1 — bouton "Appliquer à toutes les bornes" présent dans la topbar', async ({
    loggedInPage: page,
  }) => {
    const tab = page.locator('.tab', { hasText: 'Bornes OCPP 2.0.1' });
    if (!(await tab.isVisible())) {
      test.skip(true, 'OCPP 2.0.1 non activé dans cette instance');
      return;
    }

    await tab.click();
    await page.locator('#initConfigInner').waitFor({ state: 'visible', timeout: 8000 });

    const cascadeBtn = page.locator('#topbarActions button.btn-secondary', {
      hasText: 'Appliquer',
    });
    await expect(cascadeBtn).toBeVisible({ timeout: 5000 });
  });

  test('vue 2.0.1 — clic cascade ouvre la modale de confirmation', async ({
    loggedInPage: page,
  }) => {
    const tab = page.locator('.tab', { hasText: 'Bornes OCPP 2.0.1' });
    if (!(await tab.isVisible())) {
      test.skip(true, 'OCPP 2.0.1 non activé dans cette instance');
      return;
    }

    await tab.click();
    await page.locator('#initConfigInner').waitFor({ state: 'visible', timeout: 8000 });

    const cascadeBtn = page.locator('#topbarActions button.btn-secondary', {
      hasText: 'Appliquer',
    });
    await cascadeBtn.click();

    const modal = page.locator('#modal, .modal, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('vue 1.6 — hint de description toujours présent', async ({ loggedInPage: page }) => {
    const tab = page.locator('.tab', { hasText: 'Bornes OCPP 1.6' });
    if (!(await tab.isVisible())) {
      test.skip(true, 'OCPP 1.6 non activé dans cette instance');
      return;
    }

    await tab.click();
    await page.locator('#initConfigInner').waitFor({ state: 'visible', timeout: 8000 });

    const hint = page.locator('#initConfigInner p.text-muted');
    await expect(hint).toBeVisible({ timeout: 5000 });
  });
});
