import { expect, test } from '@playwright/test';

/**
 * The renderer now lives in an `AudioWorklet`, which is where this project's
 * riskiest cross-browser code sits: the compiled `WebAssembly.Module` crossing
 * the processor port, the UTF-8 shim standing in for the codecs an
 * `AudioWorkletGlobalScope` does not expose, and a self-contained bundle with no
 * static imports. None of that can be proven in jsdom, and a failure there is
 * silent — the transport reports playing while nothing renders. These journeys
 * run on every configured browser project for that reason.
 */
test('renders real audio through the worklet and keeps the transport live', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  const playbackConsoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => {
    // `vite preview` does not serve the analytics beacon, and a failed
    // subresource is reported as a console error in some browsers. Keep the
    // assertion on messages that could come from the engine or its worklet.
    if (
      message.type() === 'error' &&
      /worklet|processor|wasm|webassembly|engine|chip|decoder/iu.test(
        message.text(),
      )
    ) {
      playbackConsoleErrors.push(message.text());
    }
  });

  await page.goto('/');
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
  await expect(page.locator('.on-air-sign')).toHaveClass(/is-live/u);

  const progress = async () =>
    page
      .locator('.on-air-progress > span')
      .evaluate((element) => Number.parseFloat(element.style.width));

  // Position is derived from frame counts the processor reports, so it only
  // advances if the worklet is actually rendering and posting snapshots.
  const started = await progress();
  await expect.poll(progress, { timeout: 15_000 }).toBeGreaterThan(started);

  // A seek is a message to the processor rather than a re-render, and playback
  // has to survive it.
  const seek = solitude.getByRole('slider', { name: 'Seek Solitude' });
  await seek.focus();
  await seek.press('PageUp');
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible();
  const afterSeek = await progress();
  await expect.poll(progress, { timeout: 15_000 }).toBeGreaterThan(afterSeek);

  await page.getByRole('button', { name: 'Pause Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Play Solitude' }),
  ).toBeVisible();

  // `onprocessorerror` and a throwing processor both surface here, and so does a
  // missing TextDecoder in the worklet scope.
  expect(pageErrors).toEqual([]);
  expect(playbackConsoleErrors).toEqual([]);
});

test('cycles the stereo order without losing it on the next track', async ({
  page,
}) => {
  await page.goto('/');
  const cycler = page.getByRole('button', {
    name: /Stereo channel order/u,
  });
  await expect(cycler).toHaveAttribute('title', 'Stereo order: ABC');
  await cycler.click();
  await expect(cycler).toHaveAttribute('title', 'Stereo order: ACB');

  await page.getByRole('button', { name: 'Play Solitude' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause Solitude' }),
  ).toBeVisible({ timeout: 15_000 });
  // A track load must not replace the listener's order with the track's own
  // curator-recorded `channelLayout`.
  await expect(cycler).toHaveAttribute('title', 'Stereo order: ACB');

  await page.getByRole('button', { name: 'Next track' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause selected track' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(cycler).toHaveAttribute('title', 'Stereo order: ACB');

  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('zxmusicfm.player.v1');
    return raw === null
      ? null
      : ((JSON.parse(raw) as { channelOrder?: string }).channelOrder ?? null);
  });
  expect(stored).toBe('ACB');
});
