import { describe, expect, it } from 'vitest';

import { generatedCatalogSchema, trackSidecarSchema } from './schemas.ts';

describe('trackSidecarSchema', () => {
  const validSidecar = {
    schemaVersion: 1,
    id: 'test-track',
    order: 1,
    title: 'Test Track',
    author: 'Test Author',
    sourceUrl: 'https://example.com/tracks/test-track',
    subsong: 1,
  } as const;

  it('accepts the common authoritative fields', () => {
    expect(trackSidecarSchema.parse(validSidecar)).toEqual(validSidecar);
  });

  it('rejects unknown properties', () => {
    expect(() =>
      trackSidecarSchema.parse({ ...validSidecar, typoField: true }),
    ).toThrow();
  });
});

describe('generatedCatalogSchema', () => {
  it('accepts a valid empty development catalog', () => {
    const hash = 'a'.repeat(64);
    expect(
      generatedCatalogSchema.parse({
        schemaVersion: 1,
        waveforms: {
          url: `/generated/waveforms.${hash}.bin`,
          sha256: hash,
          byteLength: 16,
          formatVersion: 1,
          bucketCount: 2048,
          channelCount: 3,
        },
        tracks: [],
      }),
    ).toBeDefined();
  });
});
