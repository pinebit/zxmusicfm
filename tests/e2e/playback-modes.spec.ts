import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'zxmusicfm.player.v1';

const storedMode = (page: import('@playwright/test').Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null
      ? null
      : ((JSON.parse(raw) as { mode?: string }).mode ?? null);
  }, STORAGE_KEY);

test('switches between studio and vanilla sound while playing real audio', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Studio sound' });
  // Studio is what a new listener hears; vanilla is the deliberate opt-in.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const solitude = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Solitude', exact: true }),
  });
  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(solitude.locator('.waveform-canvas')).toHaveClass(
    /has-position/u,
  );

  const positionAfter = async () =>
    page
      .locator('.on-air-progress > span')
      .evaluate((element) => Number.parseFloat(element.style.width));

  // Switching renderer and processing chain must not interrupt playback: the
  // queued audio finishes on the chain that produced it while the incoming one
  // fades up, so the transport stays live and the position keeps advancing.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible();
  await expect(page.locator('.on-air-sign')).toHaveClass(/is-live/u);

  const beforeVanilla = await positionAfter();
  await expect
    .poll(positionAfter, { timeout: 15_000 })
    .toBeGreaterThan(beforeVanilla);

  // Back to studio. Vanilla to studio needs no engine reconstruction at all.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible();

  const beforeStudio = await positionAfter();
  await expect
    .poll(positionAfter, { timeout: 15_000 })
    .toBeGreaterThan(beforeStudio);

  // Meters keep reporting through both modes, so the audio really is flowing.
  await expect
    .poll(
      async () =>
        page
          .locator('meter[aria-label^="Channel A level"]')
          .evaluate((meter: HTMLMeterElement) => meter.value),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});

test('persists the chosen sound mode across a reload', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Studio sound' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await storedMode(page)).toBe('vanilla');

  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Studio sound' }),
  ).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'Studio sound' }).click();
  expect(await storedMode(page)).toBe('studio');
});

test('keeps both deck toggles accessible and labelled', async ({ page }) => {
  await page.goto('/');

  for (const name of ['Shuffle', 'Studio sound']) {
    const button = page.getByRole('button', { name });
    await expect(button).toHaveAttribute('aria-pressed', /true|false/u);
    // State comes from aria-pressed, so the accessible name must not change with
    // it; the tooltip is what carries the human-readable state.
    await expect(button).toHaveAttribute('title', /.+/u);
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  expect(blocking).toEqual([]);
});
