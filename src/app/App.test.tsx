import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { GeneratedCatalog } from '../content/schemas.ts';
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

describe('App', () => {
  it('reports a schema-valid empty development catalog', async () => {
    render(<App catalogLoader={() => Promise.resolve(emptyCatalog)} />);

    expect(
      await screen.findByText('Valid schema; 0 tracks'),
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText('Valid schema; 0 tracks'),
    ).toBeInTheDocument();
    expect(attempt).toBe(2);
  });
});
