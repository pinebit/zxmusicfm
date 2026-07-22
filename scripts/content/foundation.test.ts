import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  detectSupportedSource,
  generateFoundationContent,
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
    await expect(validateContent(root)).resolves.toMatchObject({
      trackCount: 0,
    });
  });

  it('rejects a stale generated catalog', async () => {
    const root = await createTemporaryRoot();
    await generateFoundationContent(root);
    const catalogPath = path.join(root, 'public', 'generated', 'catalog.json');
    const catalog = await readFile(catalogPath, 'utf8');
    await writeFile(catalogPath, catalog.replace(/\n$/u, ''));

    await expect(validateContent(root)).rejects.toThrow(
      'generated catalog is stale or has unexpected bytes',
    );
  });

  it('validates the generated real catalog and provenance', async () => {
    await expect(validateContent(process.cwd())).resolves.toBeDefined();
  }, 60_000);
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
    expect(detectSupportedSource(opaqueTrackerBytes, 'song.stp')).toEqual({
      format: 'STP',
      extension: '.stp',
    });
    expect(detectSupportedSource(opaqueTrackerBytes, 'song.ftc')).toEqual({
      format: 'FTC',
      extension: '.ftc',
    });
  });

  it('does not route an unsupported extension as a tracker', () => {
    expect(() =>
      detectSupportedSource(new Uint8Array([1, 2, 3]), 'song.mod'),
    ).toThrow('unsupported source signature');
  });
});
