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

    await use(page);
  },
});

module.exports = { test, expect };
