import { expect, test } from '@playwright/test';

test('keeps the real engine lazy until a user starts playback', async ({
  page,
}) => {
  const wasmRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.wasm')) wasmRequests.push(request.url());
  });
  await page.goto('/');
  expect(wasmRequests).toHaveLength(0);
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({ timeout: 15_000 });
  expect(wasmRequests).toHaveLength(1);
});
