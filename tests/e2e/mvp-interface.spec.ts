import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('has no serious or critical accessibility findings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Credits / License' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Credits / License' }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  expect(blocking).toEqual([]);
});

test('traps and restores focus for credits and licenses', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Credits / License' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Credits / License' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: 'Andrei Smirnov' }),
  ).toHaveAttribute('href', 'https://github.com/pinebit');
  await expect(dialog.getByRole('heading', { name: 'Music' })).toHaveCount(0);
  await expect(
    dialog.getByRole('link', { name: 'Original source' }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('uses the conventional seek fallback and preserves playback when waveforms fail', async ({
  page,
}) => {
  await page.route('**/generated/waveforms.*.bin', (route) => route.abort());
  await page.goto('/');
  await expect(
    page.getByText('Visual waveforms are unavailable.'),
  ).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Seek Solitude' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({
    timeout: 15_000,
  });
});

test('shows a recoverable inline track error without silently skipping', async ({
  page,
}) => {
  await page.route('**/generated/tracks/*.ym', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(page.getByText('This track could not be loaded.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry track' })).toBeVisible();
  await expect(
    page.getByText('Playback error', { exact: true }),
  ).toBeAttached();
});

test('fits the acceptance widths and stacks only when space requires it', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Responsive matrix runs once in Chromium.',
  );
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(
      dimensions.content,
      `horizontal overflow at ${width}px`,
    ).toBeLessThanOrEqual(dimensions.viewport);
    const track = await page.locator('.track-panel').boundingBox();
    const meters = await page.locator('.meter-panel').boundingBox();
    const transport = await page.locator('.transport').boundingBox();
    const volume = await page
      .getByRole('slider', { name: 'Master volume' })
      .boundingBox();
    expect(track).not.toBeNull();
    expect(meters).not.toBeNull();
    expect(transport).not.toBeNull();
    expect(volume).not.toBeNull();
    if (
      track === null ||
      meters === null ||
      transport === null ||
      volume === null
    )
      continue;
    if (width <= 760)
      expect(track.y).toBeGreaterThan(meters.y + meters.height - 1);
    else expect(Math.abs(meters.y - track.y)).toBeLessThan(2);
    expect(volume.x).toBeGreaterThan(transport.x + transport.width - 1);
    expect(
      Math.abs(
        volume.y + volume.height / 2 - (transport.y + transport.height / 2),
      ),
    ).toBeLessThan(3);
  }

  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto('/');
  await expect(page.locator('.meter-panel')).toHaveCSS('position', 'static');
});

test('supports reduced motion and the global playback shortcut', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('h1').click();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: 'Play Solitude' }),
  ).toBeVisible();
});
