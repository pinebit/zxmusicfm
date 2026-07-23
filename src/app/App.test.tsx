import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GeneratedCatalog } from '../content/schemas.ts';
import { PLAYER_STORAGE_KEY } from '../playback/persistence.ts';
import { App } from './App.tsx';

const emptyCatalog: GeneratedCatalog = {
  schemaVersion: 1,
  waveforms: {
    url: `/generated/waveforms.${'a'.repeat(64)}.bin`,
    sha256: 'a'.repeat(64),
    byteLength: 16,
    formatVersion: 1,
    bucketCount: 2048,
    channelCount: 3,
  },
  tracks: [],
};

const digest = '0'.repeat(64);
const catalogWithTrack: GeneratedCatalog = {
  ...emptyCatalog,
  tracks: [
    {
      id: 'solitude',
      order: 1,
      title: 'Solitude',
      author: 'Pator',
      sourceUrl: 'https://example.com/solitude',
      subsong: 1,
      sourceFormat: 'PSG',
      runtimeFormat: 'YM6',
      runtimeUrl: `/generated/tracks/solitude.${digest}.ym`,
      runtimeSha256: digest,
      runtimeByteLength: 1,
      durationSeconds: 2,
      durationSource: 'source',
      chipType: 'AY',
      chipClockHz: 1_773_400,
      frameRateHz: 50,
      channelLayout: 'ABC',
      waveformByteOffset: 32,
      waveformByteLength: 12_288,
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('shows the empty-state for a valid empty catalog', async () => {
    render(<App catalogLoader={() => Promise.resolve(emptyCatalog)} />);

    expect(await screen.findByText('No tracks available')).toBeInTheDocument();
  });

  it('retries catalog loading without reloading the page', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const catalogLoader = () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('Catalog unavailable.'))
        : Promise.resolve(emptyCatalog);
    };

    render(<App catalogLoader={catalogLoader} />);

    expect(
      await screen.findByText('The station list could not be loaded.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry catalog' }));

    expect(await screen.findByText('No tracks available')).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it('shows the selected track title and author on the ON AIR sign', async () => {
    localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        selectedTrackId: 'solitude',
        positionSeconds: 0,
        volume: 0.8,
        shuffle: false,
      }),
    );

    try {
      render(<App catalogLoader={() => Promise.resolve(catalogWithTrack)} />);

      expect(await screen.findByText('- Solitude | Pator')).toBeInTheDocument();
    } finally {
      localStorage.removeItem(PLAYER_STORAGE_KEY);
    }
  });

  it('keeps the main play button enabled before a track is selected', async () => {
    vi.stubGlobal('AudioContext', vi.fn());
    vi.stubGlobal('crypto', { subtle: {} });

    render(<App catalogLoader={() => Promise.resolve(catalogWithTrack)} />);

    expect(
      await screen.findByRole('button', { name: 'Play first track' }),
    ).toBeEnabled();
  });

  it('enters and exits distraction-free mode without fullscreen support', async () => {
    const user = userEvent.setup();

    render(<App catalogLoader={() => Promise.resolve(catalogWithTrack)} />);

    const enterButton = await screen.findByRole('button', {
      name: 'Enter distraction-free mode',
    });
    await user.click(enterButton);

    const exitButton = screen.getByRole('button', {
      name: 'Exit distraction-free mode',
    });
    const layout = exitButton.closest('.player-layout');
    expect(layout).toHaveClass('deck-maximized');
    expect(document.querySelector('.app-shell')).toHaveClass('deck-focus-mode');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Enter distraction-free mode',
        }),
      ).toHaveFocus(),
    );
    expect(layout).not.toHaveClass('deck-maximized');
    expect(document.body.style.overflow).toBe('');

    await user.click(
      screen.getByRole('button', {
        name: 'Enter distraction-free mode',
      }),
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Exit distraction-free mode',
      }),
    );
    expect(layout).not.toHaveClass('deck-maximized');

    await user.click(
      screen.getByRole('button', {
        name: 'Enter distraction-free mode',
      }),
    );
    if (layout === null) throw new Error('Player layout is missing.');
    await user.click(layout);
    expect(layout).not.toHaveClass('deck-maximized');
  });

  it('requests landscape after entering native fullscreen on mobile', async () => {
    const user = userEvent.setup();
    const requestFullscreen = vi.fn(() => Promise.resolve());
    const lock = vi.fn(() => Promise.resolve());
    const noop = (): void => undefined;
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
      matches: query === '(max-width: 760px)',
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }));
    vi.stubGlobal('screen', { orientation: { lock } });

    render(<App catalogLoader={() => Promise.resolve(catalogWithTrack)} />);

    const enterButton = await screen.findByRole('button', {
      name: 'Enter distraction-free mode',
    });
    const layout = enterButton.closest('.player-layout');
    if (layout === null) throw new Error('Player layout is missing.');
    Object.defineProperty(layout, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });

    await user.click(enterButton);

    expect(requestFullscreen).toHaveBeenCalledOnce();
    await waitFor(() => expect(lock).toHaveBeenCalledWith('landscape'));
  });

  it('renders playback progress beneath the ON AIR text', async () => {
    localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        selectedTrackId: 'solitude',
        positionSeconds: 1,
        volume: 0.8,
        shuffle: false,
      }),
    );

    try {
      render(<App catalogLoader={() => Promise.resolve(catalogWithTrack)} />);

      await screen.findByText('- Solitude | Pator');
      expect(
        document.querySelector<HTMLElement>('.on-air-progress > span'),
      ).toHaveStyle({ width: '50%' });
      expect(document.querySelector('.position-leds')).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem(PLAYER_STORAGE_KEY);
    }
  });
});
