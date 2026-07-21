import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  detectSupportedSource,
  generateFoundationContent,
  resolveValidationMode,
  validateContent,
} from './foundation.ts';

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zxmusicfm-foundation-'));
  await mkdir(path.join(root, 'public'), { recursive: true });
  return root;
}

describe('foundation content generation', () => {
  it('generates and validates deterministic empty artifacts', async () => {
    const root = await createTemporaryRoot();

    await generateFoundationContent(root);
    const firstCatalog = await readFile(
      path.join(root, 'public', 'generated', 'catalog.json'),
    );
    await generateFoundationContent(root);
    const secondCatalog = await readFile(
      path.join(root, 'public', 'generated', 'catalog.json'),
    );

    expect(secondCatalog).toEqual(firstCatalog);
    await expect(validateContent(root, 'development')).resolves.toMatchObject({
      mode: 'development',
      trackCount: 0,
    });
  });

  it('rejects a stale generated catalog', async () => {
    const root = await createTemporaryRoot();
    await generateFoundationContent(root);
    const catalogPath = path.join(root, 'public', 'generated', 'catalog.json');
    const catalog = await readFile(catalogPath, 'utf8');
    await writeFile(catalogPath, catalog.replace(/\n$/u, ''));

    await expect(validateContent(root, 'development')).rejects.toThrow(
      'generated catalog is stale or has unexpected bytes',
    );
  });

  it('validates the generated real catalog and provenance', async () => {
    await expect(
      validateContent(process.cwd(), 'development'),
    ).resolves.toMatchObject({
      mode: 'development',
      trackCount: 7,
    });
  }, 30_000);

  it('rejects an empty release catalog', async () => {
    const root = await createTemporaryRoot();
    await generateFoundationContent(root);

    await expect(validateContent(root, 'release')).rejects.toThrow(
      'Release validation requires 20–30 tracks',
    );
  });
});

describe('resolveValidationMode', () => {
  it('defaults to development', () => {
    expect(resolveValidationMode([], {})).toBe('development');
  });

  it('uses release mode for explicit or Vercel production validation', () => {
    expect(resolveValidationMode(['--release'], {})).toBe('release');
    expect(resolveValidationMode([], { VERCEL_ENV: 'production' })).toBe(
      'release',
    );
  });
});

describe('tracker source routing', () => {
  it('routes supported tracker extensions to pinned ZXTune validation', () => {
    const opaqueTrackerBytes = new Uint8Array([1, 2, 3]);

    expect(detectSupportedSource(opaqueTrackerBytes, 'song.pt3')).toEqual({
      format: 'PT3',
      extension: '.pt3',
    });
    expect(detectSupportedSource(opaqueTrackerBytes, 'song.stc')).toEqual({
      format: 'STC',
      extension: '.stc',
    });
    expect(detectSupportedSource(opaqueTrackerBytes, 'song.asc')).toEqual({
      format: 'ASC',
      extension: '.asc',
    });
  });

  it('does not route an unsupported extension as a tracker', () => {
    expect(() =>
      detectSupportedSource(new Uint8Array([1, 2, 3]), 'song.mod'),
    ).toThrow('unsupported source signature');
  });
});
