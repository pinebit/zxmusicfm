import { expect, test } from '@playwright/test';

test('loads the catalog shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'ZX-MUSIC.FM' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Solitude' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Batman The Movie' }),
  ).toBeVisible();
  const actionEpilogue = page.getByRole('listitem').filter({
    has: page.getByRole('heading', {
      level: 3,
      name: '"ACTION" EPILOGUE',
      exact: true,
    }),
  });
  await expect(actionEpilogue).toBeVisible();
  await expect(
    actionEpilogue.getByRole('link', { name: 'Original source' }),
  ).toHaveAttribute(
    'href',
    'https://zxtunes.com/ru/authors/ksa-mortal-kombat-hackers-group',
  );
  await expect(page.locator('.track-row')).toHaveCount(16);
  await expect(
    page.getByRole('link', { name: 'Buy me a coffee' }),
  ).toHaveAttribute('href', 'https://buymeacoffee.com/pinebit');
});
