const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3099',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'node src/server.js',
    url: 'http://localhost:3099/healthz',
    timeout: 30000,
    reuseExistingServer: false,
    env: { NODE_ENV: 'e2e' },
  },
  workers: 1,
  retries: 0,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  reporter: [['html', { open: 'never' }]],
});
