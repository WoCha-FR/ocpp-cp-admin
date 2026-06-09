'use strict';

const { test: base, expect } = require('@playwright/test');

const E2E_ADMIN = { useremail: 'admin@admin.com', password: 'admin123' };

const test = base.extend({
  loggedInPage: async ({ page }, use) => {
    // First visit sets the CSRF cookie
    await page.goto('/');
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';

    const resp = await page.request.post('/api/auth/login', {
      headers: { 'x-xsrf-token': csrf, 'content-type': 'application/json' },
      data: JSON.stringify(E2E_ADMIN),
    });
    if (!resp.ok()) throw new Error(`Login failed: ${resp.status()} ${await resp.text()}`);

    // Reload — JS detects the session and renders the app
    await page.goto('/');
    await page.locator('#appPage').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => {
      const appPage = document.getElementById('appPage');
      const loginPage = document.getElementById('loginPage');
      const pageTitle = document.getElementById('pageTitle');
      const pageContent = document.getElementById('pageContent');
      const appVisible = appPage && !appPage.classList.contains('hidden');
      const loginHidden = !loginPage || loginPage.classList.contains('hidden');
      const titleReady = Boolean(pageTitle && pageTitle.textContent && pageTitle.textContent.trim().length > 0);
      const contentReady = Boolean(pageContent && pageContent.children.length > 0);
      return appVisible && loginHidden && titleReady && contentReady;
    }, { timeout: 10000 });
    await page.locator('#navConfigEditor').waitFor({ state: 'visible', timeout: 10000 });

    await use(page);
  },
});

module.exports = { test, expect };
