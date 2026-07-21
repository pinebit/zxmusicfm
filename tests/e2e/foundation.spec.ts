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
    page.getByRole('link', { name: 'ZX-MUSIC.FM V0.1' }),
  ).toHaveAttribute('href', 'https://github.com/pinebit/zxmusicfm');
});
