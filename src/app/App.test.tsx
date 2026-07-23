import { render, screen } from '@testing-library/react';
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
});
