import { expect, test } from '@playwright/test';

test('plays, seeks, meters, persists, and attributes the real Solitude PSG', async ({
  page,
}) => {
  await page.goto('/');

  const solitude = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Solitude', exact: true }),
  });
  await expect(
    solitude.getByRole('heading', { name: 'Solitude' }),
  ).toBeVisible();
  await expect(page.getByText('Pator', { exact: true }).first()).toBeVisible();
  await expect(
    solitude.getByRole('link', { name: 'Original source' }),
  ).toHaveAttribute('href', 'https://zxart.ee/eng/authors/p/pator/solitude/');
  await expect(solitude.locator('.waveform-canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  for (const channel of ['A', 'B', 'C']) {
    await expect
      .poll(async () =>
        page
          .locator(`meter[aria-label="Channel ${channel} level"]`)
          .evaluate((meter: HTMLMeterElement) => meter.value),
      )
      .toBeGreaterThan(0);
  }

  await page.getByRole('button', { name: 'Pause Solitude' }).click();
  const seek = page.getByRole('slider', { name: 'Seek Solitude' });
  await seek.fill('86.51');
  await expect(seek).toHaveAttribute('aria-valuetext', /1:26 of 2:53/u);

  const volume = page.getByRole('slider', { name: 'Master volume' });
  await volume.focus();
  await volume.press('Home');
  for (let index = 0; index < 3; index += 1) await volume.press('PageUp');
  for (let index = 0; index < 5; index += 1) await volume.press('ArrowRight');
  await expect(volume).toHaveAttribute('aria-valuenow', '35');
  await page.getByRole('button', { name: 'Mute' }).click();
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Play Solitude' }),
  ).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Seek Solitude' }),
  ).toHaveAttribute('aria-valuetext', /1:26 of 2:53/u);
  await expect(
    page.getByRole('slider', { name: 'Master volume' }),
  ).toHaveAttribute('aria-valuenow', '35');
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();

  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Pause Solitude' }).click();
  const autoPlayNext = page.getByRole('checkbox', {
    name: 'Auto-Play Next',
  });
  await page
    .locator('label.toggle-control')
    .filter({ hasText: 'Auto-Play Next' })
    .click();
  await expect(autoPlayNext).not.toBeChecked();
  await page.getByRole('slider', { name: 'Seek Solitude' }).fill('172.8');
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(page.getByRole('button', { name: 'Play Solitude' })).toBeVisible(
    {
      timeout: 5_000,
    },
  );
  await expect(
    page.getByRole('slider', { name: 'Seek Solitude' }),
  ).toHaveAttribute('aria-valuetext', /2:53 of 2:53/u);
});
