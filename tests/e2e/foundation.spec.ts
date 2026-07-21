import { expect, test } from '@playwright/test';

test('loads the Phase 1 diagnostic shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'ZX-SPECTRUM.FM' }),
  ).toBeVisible();
  await expect(page.getByText('Valid schema; 0 tracks')).toBeVisible();
});
