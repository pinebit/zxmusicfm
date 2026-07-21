import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  generatedCatalogSchema,
  trackSidecarSchema,
  type GeneratedCatalog,
  type TrackSidecar,
} from '../../src/content/schemas.ts';

const waveformMagic = Buffer.from('ZXWF', 'ascii');
const waveformHeaderLength = 16;
const waveformBuckets = 2_048;
const waveformChannels = 3;
const waveformEncoding = 1;

export type ValidationMode = 'development' | 'release';

export type ValidationResult = {
  readonly mode: ValidationMode;
  readonly trackCount: number;
  readonly catalogPath: string;
  readonly waveformPath: string;
};

type TrackInput = {
  readonly directory: string;
  readonly sourceExtension: '.ay' | '.psg' | '.ym';
  readonly sidecar: TrackSidecar;
};

type EmptyArtifacts = {
  readonly catalog: GeneratedCatalog;
  readonly catalogBytes: Buffer;
  readonly waveformBytes: Buffer;
  readonly waveformFileName: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createEmptyWaveformPack(): Buffer {
  const header = Buffer.alloc(waveformHeaderLength);
  waveformMagic.copy(header, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(waveformBuckets, 6);
  header.writeUInt8(waveformChannels, 8);
  header.writeUInt8(waveformEncoding, 9);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(0, 12);
  return header;
}

function createEmptyArtifacts(): EmptyArtifacts {
  const waveformBytes = createEmptyWaveformPack();
  const waveformHash = sha256(waveformBytes);
  const waveformFileName = `waveforms.${waveformHash}.bin`;
  const catalog: GeneratedCatalog = {
    schemaVersion: 1,
    waveforms: {
      url: `/generated/${waveformFileName}`,
      sha256: waveformHash,
      byteLength: waveformBytes.byteLength,
      formatVersion: 1,
      bucketCount: waveformBuckets,
      channelCount: waveformChannels,
    },
    tracks: [],
  };
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);

  return { catalog, catalogBytes, waveformBytes, waveformFileName };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function formatSchemaError(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues
      .map((issue: unknown) => {
        if (typeof issue !== 'object' || issue === null) {
          return String(issue);
        }
        const pathValue =
          'path' in issue && Array.isArray(issue.path)
            ? issue.path.join('.')
            : '<root>';
        const message =
          'message' in issue ? String(issue.message) : 'Invalid value.';
        return `${pathValue}: ${message}`;
      })
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

async function discoverTrackInputs(root: string): Promise<TrackInput[]> {
  const tracksDirectory = path.join(root, 'content', 'tracks');
  if (!(await isDirectory(tracksDirectory))) {
    return [];
  }

  const directoryEntries = await readdir(tracksDirectory, {
    withFileTypes: true,
  });
  const trackDirectories = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const inputs: TrackInput[] = [];
  for (const directoryName of trackDirectories) {
    const directory = path.join(tracksDirectory, directoryName);
    const sidecarPath = path.join(directory, 'track.json');
    let sidecarInput: unknown;
    try {
      sidecarInput = JSON.parse(await readFile(sidecarPath, 'utf8'));
    } catch (error) {
      throw new Error(
        `${sidecarPath}: unable to read valid JSON: ${formatSchemaError(error)}`,
        { cause: error },
      );
    }

    let sidecar: TrackSidecar;
    try {
      sidecar = trackSidecarSchema.parse(sidecarInput);
    } catch (error) {
      throw new Error(`${sidecarPath}: ${formatSchemaError(error)}`, {
        cause: error,
      });
    }

    if (sidecar.id !== directoryName) {
      throw new Error(
        `${sidecarPath}: id must match containing directory ${directoryName}.`,
      );
    }

    const sourceFiles = (await readdir(directory)).filter((fileName) =>
      /^source\.(?:ay|psg|ym)$/u.test(fileName),
    );
    if (sourceFiles.length !== 1) {
      throw new Error(
        `${directory}: expected exactly one source.ay, source.psg, or source.ym; found ${sourceFiles.length}.`,
      );
    }

    const sourceFile = sourceFiles[0];
    if (sourceFile === undefined) {
      throw new Error(`${directory}: authoritative source file is missing.`);
    }
    const sourceExtension = path.extname(
      sourceFile,
    ) as TrackInput['sourceExtension'];

    if (sourceExtension === '.psg') {
      const requiredPsgFields = [
        'chipType',
        'chipClockHz',
        'frameRateHz',
        'channelLayout',
      ] as const;
      for (const field of requiredPsgFields) {
        if (sidecar[field] === undefined) {
          throw new Error(
            `${sidecarPath}: ${field} is required for PSG input.`,
          );
        }
      }
      if (sidecar.subsong !== 1) {
        throw new Error(`${sidecarPath}: PSG input requires subsong 1.`);
      }
      if (sidecar.durationOverrideSeconds !== undefined) {
        throw new Error(
          `${sidecarPath}: PSG input cannot use durationOverrideSeconds.`,
        );
      }
    }

    if (sourceExtension === '.ym' && sidecar.subsong !== 1) {
      throw new Error(`${sidecarPath}: YM input requires subsong 1.`);
    }

    inputs.push({ directory, sourceExtension, sidecar });
  }

  inputs.sort((left, right) => left.sidecar.order - right.sidecar.order);
  for (const [index, input] of inputs.entries()) {
    if (input.sidecar.order !== index + 1) {
      throw new Error(
        `${path.join(input.directory, 'track.json')}: expected contiguous order ${index + 1}.`,
      );
    }
  }

  return inputs;
}

function validateRights(
  inputs: readonly TrackInput[],
  mode: ValidationMode,
): void {
  if (mode !== 'release') {
    return;
  }

  if (inputs.length < 20 || inputs.length > 30) {
    throw new Error(
      `Release validation requires 20–30 tracks; found ${inputs.length}.`,
    );
  }

  for (const input of inputs) {
    if (
      input.sidecar.licenseName === undefined ||
      input.sidecar.licenseUrl === undefined
    ) {
      throw new Error(
        `${path.join(input.directory, 'track.json')}: release tracks require licenseName and licenseUrl.`,
      );
    }
  }
}

function validateWaveformPack(
  bytes: Buffer,
  expectedTrackCount: number,
  filePath: string,
): void {
  if (bytes.byteLength < waveformHeaderLength) {
    throw new Error(`${filePath}: waveform pack is shorter than its header.`);
  }
  if (!bytes.subarray(0, 4).equals(waveformMagic)) {
    throw new Error(`${filePath}: invalid ZXWF magic.`);
  }
  if (bytes.readUInt16LE(4) !== 1) {
    throw new Error(`${filePath}: unsupported waveform format version.`);
  }
  if (bytes.readUInt16LE(6) !== waveformBuckets) {
    throw new Error(`${filePath}: unexpected waveform bucket count.`);
  }
  if (bytes.readUInt8(8) !== waveformChannels) {
    throw new Error(`${filePath}: unexpected waveform channel count.`);
  }
  if (bytes.readUInt8(9) !== waveformEncoding) {
    throw new Error(`${filePath}: unsupported waveform value encoding.`);
  }
  if (bytes.readUInt16LE(10) !== 0) {
    throw new Error(`${filePath}: waveform reserved header value is nonzero.`);
  }
  if (bytes.readUInt32LE(12) !== expectedTrackCount) {
    throw new Error(
      `${filePath}: waveform track count does not match catalog.`,
    );
  }

  const expectedLength = waveformHeaderLength + expectedTrackCount * 12_288;
  if (bytes.byteLength !== expectedLength) {
    throw new Error(
      `${filePath}: expected ${expectedLength} bytes; found ${bytes.byteLength}.`,
    );
  }

  for (
    let offset = waveformHeaderLength;
    offset < bytes.byteLength;
    offset += 2
  ) {
    const minimum = bytes.readInt8(offset);
    const maximum = bytes.readInt8(offset + 1);
    if (minimum === -128 || maximum === -128) {
      throw new Error(`${filePath}: reserved -128 waveform value is present.`);
    }
    if (minimum > maximum) {
      throw new Error(`${filePath}: waveform minimum exceeds maximum.`);
    }
  }
}

async function atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function generateFoundationContent(root: string): Promise<void> {
  const inputs = await discoverTrackInputs(root);
  if (inputs.length !== 0) {
    throw new Error(
      'Phase 1 generation supports only the valid empty development catalog; real-track generation begins in Phase 3.',
    );
  }

  const generatedDirectory = path.join(root, 'public', 'generated');
  await mkdir(generatedDirectory, { recursive: true });

  const expected = createEmptyArtifacts();
  const waveformPath = path.join(generatedDirectory, expected.waveformFileName);
  const catalogPath = path.join(generatedDirectory, 'catalog.json');

  const existingEntries = await readdir(generatedDirectory, {
    withFileTypes: true,
  });
  for (const entry of existingEntries) {
    if (
      entry.isFile() &&
      /^waveforms\.[a-f0-9]{64}\.bin$/u.test(entry.name) &&
      entry.name !== expected.waveformFileName
    ) {
      await unlink(path.join(generatedDirectory, entry.name));
    }
  }

  await atomicWrite(waveformPath, expected.waveformBytes);
  await atomicWrite(catalogPath, expected.catalogBytes);
}

export async function validateContent(
  root: string,
  mode: ValidationMode,
): Promise<ValidationResult> {
  const inputs = await discoverTrackInputs(root);
  validateRights(inputs, mode);

  const catalogPath = path.join(root, 'public', 'generated', 'catalog.json');
  let catalogBytes: Buffer;
  let catalogInput: unknown;
  try {
    catalogBytes = await readFile(catalogPath);
    catalogInput = JSON.parse(catalogBytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `${catalogPath}: unable to read valid generated catalog: ${formatSchemaError(error)}`,
      { cause: error },
    );
  }

  let catalog: GeneratedCatalog;
  try {
    catalog = generatedCatalogSchema.parse(catalogInput);
  } catch (error) {
    throw new Error(`${catalogPath}: ${formatSchemaError(error)}`, {
      cause: error,
    });
  }

  if (catalog.tracks.length !== inputs.length) {
    throw new Error(
      `${catalogPath}: catalog has ${catalog.tracks.length} tracks but authoritative content has ${inputs.length}.`,
    );
  }

  const waveformFileName = path.basename(catalog.waveforms.url);
  const waveformPath = path.join(root, 'public', 'generated', waveformFileName);
  const waveformBytes = await readFile(waveformPath).catch((error: unknown) => {
    throw new Error(
      `${waveformPath}: unable to read waveform pack: ${formatSchemaError(error)}`,
    );
  });

  if (waveformBytes.byteLength !== catalog.waveforms.byteLength) {
    throw new Error(`${waveformPath}: byte length does not match catalog.`);
  }
  if (sha256(waveformBytes) !== catalog.waveforms.sha256) {
    throw new Error(`${waveformPath}: SHA-256 does not match catalog.`);
  }
  validateWaveformPack(waveformBytes, catalog.tracks.length, waveformPath);

  if (inputs.length === 0) {
    const expected = createEmptyArtifacts();
    if (!catalogBytes.equals(expected.catalogBytes)) {
      throw new Error(
        `${catalogPath}: generated catalog is stale or nondeterministically formatted.`,
      );
    }
    if (!waveformBytes.equals(expected.waveformBytes)) {
      throw new Error(`${waveformPath}: generated waveform pack is stale.`);
    }
  } else {
    throw new Error(
      'Phase 1 validation recognizes authoritative tracks but canonical runtime validation begins in Phase 3.',
    );
  }

  return {
    mode,
    trackCount: inputs.length,
    catalogPath,
    waveformPath,
  };
}

export function resolveValidationMode(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
): ValidationMode {
  return argumentsList.includes('--release') ||
    environment.CONTENT_RELEASE === '1' ||
    environment.VERCEL_ENV === 'production'
    ? 'release'
    : 'development';
}
