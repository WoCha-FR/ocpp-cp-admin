'use strict';

const { test, expect } = require('@playwright/test');
const { test: loggedInTest } = require('./fixtures');

test.describe('Authentification', () => {
  test('affiche la page de login quand non authentifié', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loginPage')).toBeVisible();
    await expect(page.locator('#appPage')).toBeHidden();
  });

  test('login réussi avec identifiants valides', async ({ page }) => {
    await page.goto('/');
    await page.fill('#loginEmail', 'admin@admin.com');
    await page.fill('#loginPassword', 'admin123');
    await page.locator('#loginForm button[type="submit"]').click();

    await expect(page.locator('#appPage')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#loginPage')).toBeHidden();
  });

  test('affiche une erreur avec un mauvais mot de passe', async ({ page }) => {
    await page.goto('/');
    await page.fill('#loginEmail', 'admin@admin.com');
    await page.fill('#loginPassword', 'mauvais-mot-de-passe');
    await page.locator('#loginForm button[type="submit"]').click();

    await expect(page.locator('#loginError')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#appPage')).toBeHidden();
  });

  test('affiche une erreur avec un email inconnu', async ({ page }) => {
    await page.goto('/');
    await page.fill('#loginEmail', 'inconnu@exemple.com');
    await page.fill('#loginPassword', 'admin123');
    await page.locator('#loginForm button[type="submit"]').click();

    await expect(page.locator('#loginError')).toBeVisible({ timeout: 5000 });
  });
});

loggedInTest.describe('Déconnexion', () => {
  loggedInTest('peut se déconnecter', async ({ loggedInPage: page }) => {
    await page.locator('[data-onclick*="logout"]').click();
    await expect(page.locator('#loginPage')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#appPage')).toBeHidden();
  });
});
