import { expect, test } from '@playwright/test';

test('loads the catalog shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'ZX-MUSIC.FM' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Solitude' }),
  ).toBeVisible();
  await expect(page.locator('.track-row')).toHaveCount(7);
  await expect(
    page.locator('data.app-version[value="0.1.0"]'),
  ).toHaveAccessibleName('Application version 0.1.0');
});
