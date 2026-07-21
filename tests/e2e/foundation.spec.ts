import { expect, test } from '@playwright/test';

test('loads the diagnostic shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'ZX-MUSIC.FM' }),
  ).toBeVisible();
  await expect(page.getByText('Valid schema; 7 tracks')).toBeAttached();
  await expect(
    page.locator('data.app-version[value="0.1.0"]'),
  ).toHaveAccessibleName('Application version 0.1.0');
});
