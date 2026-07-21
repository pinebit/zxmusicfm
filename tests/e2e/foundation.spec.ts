import { expect, test } from '@playwright/test';

test('loads the diagnostic shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'ZX-SPECTRUM.FM' }),
  ).toBeVisible();
  await expect(page.getByText('Valid schema; 9 tracks')).toBeAttached();
});
