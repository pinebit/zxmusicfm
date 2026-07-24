import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ZXTUNE_COMMIT =
  '8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a' as const;
export const TRACKER_FORMATS = ['PT3', 'STC', 'ASC', 'STP', 'FTC'] as const;
export type TrackerFormat = (typeof TRACKER_FORMATS)[number];
export type TrackerExtension = '.pt3' | '.stc' | '.asc' | '.stp' | '.ftc';

const dockerImage = `zxmusicfm-zxtune:${ZXTUNE_COMMIT.slice(0, 12)}`;
// ZXTune is not chatty, but a failing run reports through stderr and the default
// 1 MiB pipe buffer would turn a diagnosable error into ENOBUFS.
const converterOutputLimit = 8 * 1024 * 1024;
function resolveDockerfile(): string {
  try {
    return fileURLToPath(new URL('./zxtune/Dockerfile', import.meta.url));
  } catch {
    return path.resolve('scripts/content/zxtune/Dockerfile');
  }
}
const dockerfile = resolveDockerfile();
const execFileAsync = promisify(execFile);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedFormat(extension: TrackerExtension): TrackerFormat {
  switch (extension) {
    case '.pt3':
      return 'PT3';
    case '.stc':
      return 'STC';
    case '.asc':
      return 'ASC';
    case '.stp':
      return 'STP';
    case '.ftc':
      return 'FTC';
  }
}

async function buildImage(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'build',
        '--tag',
        dockerImage,
        '--file',
        dockerfile,
        path.dirname(dockerfile),
      ],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker image build exited with status ${code}.`));
    });
  });
}

async function ensureImage(): Promise<void> {
  try {
    await execFileAsync('docker', ['image', 'inspect', dockerImage]);
  } catch {
    try {
      await buildImage();
    } catch (error) {
      throw new Error(
        'Tracker conversion requires a running Docker installation capable of building the pinned ZXTune image.',
        { cause: error },
      );
    }
  }
}

function containerArguments(work: string): string[] {
  const user =
    typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? [`--user=${process.getuid()}:${process.getgid()}`]
      : [];
  return [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    ...user,
    '--mount',
    `type=bind,source=${work},target=/work`,
    dockerImage,
  ];
}

async function runConverter(
  work: string,
  argumentsList: readonly string[],
): Promise<void> {
  try {
    await execFileAsync(
      'docker',
      [...containerArguments(work), ...argumentsList],
      { maxBuffer: converterOutputLimit },
    );
  } catch (error) {
    const detail =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      `ZXTune tracker conversion failed${detail === '' ? '.' : `: ${detail}`}`,
      { cause: error },
    );
  }
}

export type TrackerConversion = {
  readonly sourceFormat: TrackerFormat;
  readonly sourceSha256: string;
  readonly psg: Buffer;
  readonly psgSha256: string;
};

export async function convertTrackerToPsg(
  source: Uint8Array,
  extension: TrackerExtension,
): Promise<TrackerConversion> {
  await ensureImage();
  const work = await mkdtemp(path.join(tmpdir(), 'zxmusicfm-zxtune-'));
  try {
    const sourceName = `input${extension}`;
    await writeFile(path.join(work, sourceName), source);
    await runConverter(work, [
      '--index',
      'filename=/work/index.csv,csv=[Type]',
      '--providers-options',
      'file.overwrite=1',
      `/work/${sourceName}`,
    ]);
    const rows = (await readFile(path.join(work, 'index.csv'), 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((row) => row.trim())
      .filter((row) => row !== '');
    const detected = rows.at(-1);
    const expected = expectedFormat(extension);
    if (detected !== expected) {
      throw new Error(
        `Tracker extension ${extension} does not match ZXTune type ${detected ?? '<undetected>'}; expected ${expected}.`,
      );
    }
    // A container holding several modules yields several rows, and only the last
    // one was matched above. Reject when another row names a different supported
    // type, because the conversion below would not correspond to it.
    const conflicting = rows.filter(
      (row): row is TrackerFormat =>
        row !== expected &&
        (TRACKER_FORMATS as readonly string[]).includes(row),
    );
    if (conflicting.length > 0) {
      throw new Error(
        `ZXTune detected additional module types (${conflicting.join(', ')}) alongside ${expected}; only single-module tracker sources are accepted.`,
      );
    }

    await runConverter(work, [
      '--convert',
      'mode=psg,filename=/work/output.psg',
      '--providers-options',
      'file.overwrite=1',
      `/work/${sourceName}`,
    ]);
    const psg = await readFile(path.join(work, 'output.psg'));
    if (psg.length < 4 || psg.subarray(0, 4).toString('binary') !== 'PSG\x1a') {
      throw new Error('ZXTune did not produce an AY Emulator PSG stream.');
    }
    return {
      sourceFormat: expected,
      sourceSha256: sha256(source),
      psg,
      psgSha256: sha256(psg),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
