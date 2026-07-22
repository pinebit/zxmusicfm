import { expect, test } from '@playwright/test';

test('plays, seeks, meters, persists, and attributes the real Solitude PSG', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /mute/iu })).toHaveCount(0);

  const solitude = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Solitude', exact: true }),
  });
  await expect(page.locator('.waveform-canvas.has-position')).toHaveCount(0);
  await expect(
    solitude.getByRole('heading', { name: 'Solitude' }),
  ).toBeVisible();
  await expect(page.getByText('Pator', { exact: true }).first()).toBeVisible();
  await expect(
    solitude.getByRole('link', { name: 'Original source' }),
  ).toHaveAttribute('href', 'https://zxart.ee/eng/authors/p/pator/solitude/');
  await expect(solitude.locator('.waveform-canvas')).toBeVisible();
  const onAir = page.locator('.on-air-sign');
  await expect(onAir).toBeVisible();
  await expect(onAir).not.toHaveClass(/is-live/u);
  await expect(
    page.getByRole('img', {
      name: 'Live notes on an 88-key piano for channels A, B, and C',
    }),
  ).toBeVisible();
  await expect(page.locator('.piano-key')).toHaveCount(88);

  const restingNeedleTransforms = await Promise.all(
    ['A', 'B', 'C'].map((channel) =>
      page
        .locator(`.meter-${channel.toLowerCase()} .meter-needle`)
        .evaluate((needle) => getComputedStyle(needle).transform),
    ),
  );
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(solitude.locator('.waveform-canvas')).toHaveClass(
    /has-position/u,
  );
  await expect(
    page.locator('.track-row:not(.selected) .waveform-canvas.has-position'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(onAir).toHaveClass(/is-live/u);
  await expect(page.locator('.on-air-lamp')).toHaveCSS(
    'background-color',
    'rgb(255, 57, 73)',
  );
  const transportSurface = await page
    .getByRole('button', { name: 'Previous track' })
    .evaluate((button) => getComputedStyle(button).backgroundImage);
  const volumeSurface = await page
    .getByRole('slider', { name: 'Master volume' })
    .evaluate((knob) => getComputedStyle(knob).backgroundImage);
  expect(transportSurface).toBe(volumeSurface);
  for (const [index, channel] of ['A', 'B', 'C'].entries()) {
    await expect
      .poll(async () =>
        page
          .locator(`meter[aria-label="Channel ${channel} level"]`)
          .evaluate((meter: HTMLMeterElement) => meter.value),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        page
          .locator(`.meter-${channel.toLowerCase()} .meter-needle`)
          .evaluate((needle) => getComputedStyle(needle).transform),
      )
      .not.toBe(restingNeedleTransforms[index]);
  }
  await expect
    .poll(() => page.locator('.piano-key.is-active').count())
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pause Solitude' }).click();
  await expect(page.locator('.piano-key.is-active')).toHaveCount(0);
  const seek = page.getByRole('slider', { name: 'Seek Solitude' });
  await seek.fill('86.51');
  await expect(seek).toHaveAttribute('aria-valuetext', /1:26 of 2:53/u);

  const volume = page.getByRole('slider', { name: 'Master volume' });
  await volume.focus();
  await volume.press('Home');
  for (let index = 0; index < 3; index += 1) await volume.press('PageUp');
  for (let index = 0; index < 5; index += 1) await volume.press('ArrowRight');
  await expect(volume).toHaveAttribute('aria-valuenow', '35');

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

  // Auto-play-next is always on: reaching the end advances to the next track.
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('slider', { name: 'Seek Solitude' }).fill('172.9');
  await expect(
    page.getByRole('button', { name: 'Pause Insomnia' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: 'Play Solitude' }),
  ).toBeVisible();
});
