import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  generateFoundationContent,
  resolveValidationMode,
  validateContent,
} from './foundation.ts';

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'zxspectrumfm-foundation-'),
  );
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
      'stale or nondeterministically formatted',
    );
  });

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
