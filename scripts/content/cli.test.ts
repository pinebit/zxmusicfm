import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createSyntheticPsg } from '../../src/playback/proofFixtures.ts';

const run = promisify(execFile);
const cli = path.resolve('scripts/content/cli.ts');

async function command(root: string, argumentsList: readonly string[]) {
  return await run(process.execPath, [cli, ...argumentsList], {
    cwd: root,
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe('atomic content commands', () => {
  it('imports, updates, rejects collisions without writes, and removes a PSG', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zxmusicfm-cli-'));
    await cp('vendor', path.join(root, 'vendor'), { recursive: true });
    await writeFile(path.join(root, 'fixture.psg'), createSyntheticPsg());

    await command(root, [
      'import',
      '--file',
      'fixture.psg',
      '--non-interactive',
      '--id',
      'fixture-track',
      '--order',
      '1',
      '--title',
      'Fixture',
      '--author',
      'Project',
      '--source-url',
      'https://example.com/fixture',
      '--chip-type',
      'AY',
      '--chip-clock-hz',
      '1773400',
      '--frame-rate-hz',
      '50',
      '--channel-layout',
      'ABC',
    ]);
    const catalogPath = path.join(root, 'public', 'generated', 'catalog.json');
    const importedCatalog = await readFile(catalogPath, 'utf8');
    expect(importedCatalog).toContain('fixture-track');

    await expect(
      command(root, [
        'import',
        '--file',
        'fixture.psg',
        '--non-interactive',
        '--id',
        'fixture-track',
        '--order',
        '1',
        '--title',
        'Collision',
        '--author',
        'Project',
        '--source-url',
        'https://example.com/fixture',
        '--chip-type',
        'AY',
        '--chip-clock-hz',
        '1773400',
        '--frame-rate-hz',
        '50',
        '--channel-layout',
        'ABC',
      ]),
    ).rejects.toThrow();
    expect(await readFile(catalogPath, 'utf8')).toBe(importedCatalog);

    await command(root, [
      'update',
      '--id',
      'fixture-track',
      '--title',
      'Updated Fixture',
      '--non-interactive',
    ]);
    expect(await readFile(catalogPath, 'utf8')).toContain('Updated Fixture');

    await command(root, [
      'remove',
      '--id',
      'fixture-track',
      '--non-interactive',
      '--yes',
    ]);
    const removed = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      readonly tracks: readonly unknown[];
    };
    expect(removed.tracks).toHaveLength(0);
  }, 30_000);
});
