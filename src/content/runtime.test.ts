import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { decodeWaveformPack, verifyBytes } from './runtime.ts';
import { generatedCatalogSchema } from './schemas.ts';

describe('generated waveform runtime', () => {
  it('verifies and decodes the real catalog pack into A/B/C envelopes', async () => {
    const catalog = generatedCatalogSchema.parse(
      JSON.parse(
        await readFile('public/generated/catalog.json', 'utf8'),
      ) as unknown,
    );
    const manifest = catalog.waveforms;
    const bytes = new Uint8Array(await readFile(`public${manifest.url}`));

    await expect(
      verifyBytes(bytes, manifest.byteLength, manifest.sha256, 'Waveform pack'),
    ).resolves.toBeUndefined();
    const waveforms = decodeWaveformPack(bytes, catalog);
    const solitude = waveforms.get('pator-solitude');
    expect(solitude?.A).toHaveLength(4_096);
    expect(solitude?.B).toHaveLength(4_096);
    expect(solitude?.C).toHaveLength(4_096);
    expect(solitude?.A.some((value) => value !== 0)).toBe(true);
    expect(solitude?.B.some((value) => value !== 0)).toBe(true);
    expect(solitude?.C.some((value) => value !== 0)).toBe(true);
  });

  it('rejects bytes before decoding when integrity differs', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      verifyBytes(bytes, 3, '0'.repeat(64), 'fixture'),
    ).rejects.toThrow('integrity check failed');
  });
});
