'use strict';

const { test, expect } = require('./fixtures');

test.describe('Export CSV des logs d\'une borne', () => {
  test('le bouton export CSV est présent dans l\'onglet Logs si une borne existe', async ({ loggedInPage: page }) => {
    await page.locator('#navChargePoints').click();
    await page.locator('#cpFilterSite').waitFor({ timeout: 10000 });

    const firstRow = page.locator('#pageContent table tbody tr').first();
    const hasRows = await firstRow.count() > 0;
    if (!hasRows) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.locator('#detailTabLogs').waitFor({ timeout: 10000 });
    await page.locator('#detailTabLogs').click();
    await page.locator('#detailTabContent').waitFor({ timeout: 10000 });

    await expect(page.locator('[data-onclick^="exportCpLogsCsv("]')).toBeVisible({ timeout: 5000 });
  });

  test('le bouton export CSV déclenche un téléchargement', async ({ loggedInPage: page }) => {
    await page.locator('#navChargePoints').click();
    await page.locator('#cpFilterSite').waitFor({ timeout: 10000 });

    const firstRow = page.locator('#pageContent table tbody tr').first();
    const hasRows = await firstRow.count() > 0;
    if (!hasRows) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.locator('#detailTabLogs').waitFor({ timeout: 10000 });
    await page.locator('#detailTabLogs').click();
    await page.locator('#detailTabContent').waitFor({ timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.locator('[data-onclick^="exportCpLogsCsv("]').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^logs-.+-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
