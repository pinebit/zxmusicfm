import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const converterPath = path.join(projectRoot, '.tools', 'bin', 'psg2ym6');

export type PsgToYm6Parameters = {
  readonly clockHz: number;
  readonly frameRateHz: 50;
  readonly title: string;
  readonly author: string;
  readonly comment: string;
};

async function assertConverterAvailable(): Promise<void> {
  try {
    const details = await stat(converterPath);
    if (!details.isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(
      `The pinned PSG-to-YM6 converter is unavailable at ${converterPath}; run npm run engine:install-converter.`,
      { cause: error },
    );
  }
}

export async function convertPsgToYm6(
  psg: Uint8Array,
  parameters: PsgToYm6Parameters,
): Promise<{
  readonly bytes: Buffer;
  readonly parameters: PsgToYm6Parameters;
}> {
  await assertConverterAvailable();

  const work = await mkdtemp(path.join(tmpdir(), 'zxmusicfm-psg2ym6-'));
  const input = path.join(work, 'input.psg');
  const output = path.join(work, 'output.ym');
  try {
    await writeFile(input, psg);
    try {
      await execFileAsync(converterPath, [
        input,
        output,
        '--clock-hz',
        String(parameters.clockHz),
        '--title',
        parameters.title,
        '--author',
        parameters.author,
        '--comment',
        parameters.comment,
        '--quiet',
      ]);
    } catch (error) {
      const detail =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String(error.stderr).trim()
          : '';
      throw new Error(
        `Pinned PSG-to-YM6 conversion failed${detail === '' ? '.' : `: ${detail}`}`,
        { cause: error },
      );
    }
    return {
      bytes: await readFile(output),
      parameters,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
