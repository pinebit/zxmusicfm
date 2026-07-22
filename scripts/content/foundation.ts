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
  generatedProvenanceSchema,
  trackerConversionSchema,
  trackSidecarSchema,
  type GeneratedCatalog,
  type GeneratedProvenance,
  type TrackerConversionProvenance,
  type TrackSidecar,
} from '../../src/content/schemas.ts';
import type { RuntimeTrack } from '../../src/playback/contracts.ts';
import {
  createEnginePlayer,
  createEnginePlayerAtSample,
  ENGINE_SAMPLE_RATE,
  fastForwardEngine,
  generateEngineChannels,
  initializeYm2149,
} from '../../src/playback/engine.ts';
import {
  createYm6,
  parsePsg,
  parseYm3,
  parseYm6,
  prepareYmRuntime,
  selectAySubsong,
  type RegisterFrame,
} from '../../src/playback/formats.ts';
import {
  encodeWaveformPayload,
  WAVEFORM_BUCKET_COUNT,
  WAVEFORM_BYTES_PER_TRACK,
  WAVEFORM_CHANNEL_COUNT,
} from '../../src/playback/waveform.ts';
import { Ym2149PlaybackAdapter } from '../../src/playback/Ym2149PlaybackAdapter.ts';
import {
  convertTrackerToPsg,
  ZXTUNE_COMMIT,
  type TrackerExtension,
} from './tracker.ts';

const waveformMagic = Buffer.from('ZXWF', 'ascii');
const waveformHeaderLength = 16;
const waveformEncoding = 1;
const engineCommit = 'b3096aac0dcab6dd1d82c0209f579761943aadc6';
const comparisonTolerance = 0.000_001;

export type ValidationResult = {
  readonly trackCount: number;
  readonly catalogPath: string;
  readonly waveformPath: string;
};

export type TrackInput = {
  readonly directory: string;
  readonly sourcePath: string;
  readonly sourceExtension:
    '.ay' | '.psg' | '.ym' | '.pt3' | '.stc' | '.asc' | '.stp';
  readonly sidecar: TrackSidecar;
};

type PreparedTrack = {
  readonly input: TrackInput;
  readonly runtime: Uint8Array;
  readonly waveform: Uint8Array;
  readonly provenance: GeneratedProvenance;
  readonly catalog: Omit<
    GeneratedCatalog['tracks'][number],
    'runtimeUrl' | 'waveformByteOffset'
  >;
};

type PreparedContent = {
  readonly tracks: readonly PreparedTrack[];
  readonly catalog: GeneratedCatalog;
  readonly catalogBytes: Buffer;
  readonly waveformBytes: Buffer;
  readonly waveformFileName: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasMagic(bytes: Uint8Array, magic: string): boolean {
  return Array.from(magic).every(
    (character, index) => bytes[index] === character.charCodeAt(0),
  );
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
        if (typeof issue !== 'object' || issue === null) return String(issue);
        const issuePath =
          'path' in issue && Array.isArray(issue.path)
            ? issue.path.join('.')
            : '<root>';
        const message =
          'message' in issue ? String(issue.message) : 'Invalid value.';
        return `${issuePath}: ${message}`;
      })
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function discoverTrackInputs(root: string): Promise<TrackInput[]> {
  const tracksDirectory = path.join(root, 'content', 'tracks');
  if (!(await isDirectory(tracksDirectory))) return [];
  const entries = await readdir(tracksDirectory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const inputs: TrackInput[] = [];

  for (const directoryName of directories) {
    const directory = path.join(tracksDirectory, directoryName);
    const sidecarPath = path.join(directory, 'track.json');
    let sidecar: TrackSidecar;
    try {
      sidecar = trackSidecarSchema.parse(
        JSON.parse(await readFile(sidecarPath, 'utf8')) as unknown,
      );
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
      /^source\.(?:ay|psg|ym|pt3|stc|asc|stp)$/u.test(fileName),
    );
    if (sourceFiles.length !== 1) {
      throw new Error(
        `${directory}: expected exactly one supported source file; found ${sourceFiles.length}.`,
      );
    }
    const sourceFile = sourceFiles[0];
    if (sourceFile === undefined) {
      throw new Error(`${directory}: authoritative source file is missing.`);
    }
    const sourceExtension = path.extname(
      sourceFile,
    ) as TrackInput['sourceExtension'];
    if (sourceExtension !== '.ay' && sidecar.subsong !== 1) {
      throw new Error(
        `${sidecarPath}: ${sourceExtension} input requires subsong 1.`,
      );
    }
    if (
      ['.psg', '.pt3', '.stc', '.asc', '.stp'].includes(sourceExtension) &&
      sidecar.durationOverrideSeconds !== undefined
    ) {
      throw new Error(
        `${sidecarPath}: finite PSG and tracker inputs cannot use durationOverrideSeconds.`,
      );
    }
    inputs.push({
      directory,
      sourcePath: path.join(directory, sourceFile),
      sourceExtension,
      sidecar,
    });
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

function requiredPlaybackField<
  K extends 'chipType' | 'chipClockHz' | 'frameRateHz' | 'channelLayout',
>(input: TrackInput, field: K): NonNullable<TrackSidecar[K]> {
  const value = input.sidecar[field];
  if (value === undefined) {
    throw new Error(
      `${path.join(input.directory, 'track.json')}: ${field} is required because the source does not unambiguously provide it.`,
    );
  }
  return value;
}

function asTrackerExtension(
  extension: TrackInput['sourceExtension'],
): TrackerExtension | undefined {
  return extension === '.pt3' ||
    extension === '.stc' ||
    extension === '.asc' ||
    extension === '.stp'
    ? extension
    : undefined;
}

async function generateTrackerConversions(
  inputs: readonly TrackInput[],
): Promise<void> {
  for (const input of inputs) {
    const extension = asTrackerExtension(input.sourceExtension);
    if (extension === undefined) continue;
    const source = await readFile(input.sourcePath);
    try {
      await readTrackerConversion(input, source);
      continue;
    } catch {
      // Missing or stale conversions are rebuilt below with the pinned tool.
    }
    const conversion = await convertTrackerToPsg(source, extension);
    const metadata: TrackerConversionProvenance = {
      tool: 'zxtune123',
      commit: ZXTUNE_COMMIT,
      mode: 'psg',
      sourceFormat: conversion.sourceFormat,
      sourceSha256: conversion.sourceSha256,
      psgSha256: conversion.psgSha256,
      psgByteLength: conversion.psg.length,
    };
    const generated = path.join(input.directory, 'generated');
    await atomicWrite(path.join(generated, 'source.psg'), conversion.psg);
    await atomicWrite(
      path.join(generated, 'tracker-conversion.json'),
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
    );
  }
}

async function readTrackerConversion(
  input: TrackInput,
  source: Uint8Array,
): Promise<{
  readonly psg: Buffer;
  readonly metadata: TrackerConversionProvenance;
}> {
  const generated = path.join(input.directory, 'generated');
  let psg: Buffer;
  let metadata: TrackerConversionProvenance;
  try {
    psg = await readFile(path.join(generated, 'source.psg'));
    metadata = trackerConversionSchema.parse(
      JSON.parse(
        await readFile(path.join(generated, 'tracker-conversion.json'), 'utf8'),
      ) as unknown,
    );
  } catch (error) {
    throw new Error(
      `${input.sourcePath}: missing or invalid tracker conversion; run npm run content:generate with Docker available.`,
      { cause: error },
    );
  }
  const expectedFormat = input.sourceExtension.slice(1).toUpperCase();
  if (
    metadata.sourceFormat !== expectedFormat ||
    metadata.sourceSha256 !== sha256(source) ||
    metadata.psgSha256 !== sha256(psg) ||
    metadata.psgByteLength !== psg.length
  ) {
    throw new Error(
      `${input.sourcePath}: tracker conversion is stale or inconsistent; run npm run content:generate with Docker available.`,
    );
  }
  return { psg, metadata };
}

async function initializeContentEngine(root: string): Promise<void> {
  const wasm = await readFile(
    path.join(root, 'vendor', 'ym2149', 'ym2149_wasm_bg.wasm'),
  );
  await initializeYm2149(wasm);
}

function compareFrames(
  expected: readonly RegisterFrame[],
  actual: readonly RegisterFrame[],
  trackId: string,
): void {
  if (expected.length !== actual.length) {
    throw new Error(
      `${trackId}: conversion frame count differs (${expected.length} source, ${actual.length} runtime).`,
    );
  }
  for (let frame = 0; frame < expected.length; frame += 1) {
    for (let register = 0; register < 16; register += 1) {
      const sourceValue = expected[frame]?.[register];
      const runtimeValue = actual[frame]?.[register];
      if (sourceValue !== runtimeValue) {
        throw new Error(
          `${trackId}: conversion mismatch at frame ${frame}, register ${register}: expected ${sourceValue}, actual ${runtimeValue}.`,
        );
      }
    }
  }
}

function validateRuntimeSeeks(
  runtime: Uint8Array,
  durationSeconds: number,
  trackId: string,
): void {
  const positions = [
    0,
    durationSeconds * 0.25,
    durationSeconds * 0.5,
    durationSeconds * 0.75,
    Math.max(0, durationSeconds - 1),
  ];
  for (const position of new Set(
    positions.map((value) => Math.min(value, durationSeconds)),
  )) {
    const sample = Math.round(position * ENGINE_SAMPLE_RATE);
    const remaining = Math.max(
      0,
      Math.round(durationSeconds * ENGINE_SAMPLE_RATE) - sample,
    );
    const count = Math.min(ENGINE_SAMPLE_RATE, remaining);
    if (count === 0) continue;
    const uninterrupted = createEnginePlayer(runtime);
    const restored = createEnginePlayerAtSample(runtime, sample);
    try {
      uninterrupted.play();
      fastForwardEngine(uninterrupted, sample);
      const expected = generateEngineChannels(uninterrupted, count);
      const actual = generateEngineChannels(restored, count);
      for (let index = 0; index < actual.mono.length; index += 1) {
        const difference = Math.abs(
          (expected.mono[index] ?? 0) - (actual.mono[index] ?? 0),
        );
        if (difference > comparisonTolerance) {
          throw new Error(
            `${trackId}: seek mix mismatch at ${position.toFixed(6)}s, sample ${index}; difference ${difference} exceeds ${comparisonTolerance}.`,
          );
        }
      }
      for (let index = 0; index < actual.channels.length; index += 1) {
        const difference = Math.abs(
          (expected.channels[index] ?? 0) - (actual.channels[index] ?? 0),
        );
        if (difference > comparisonTolerance) {
          throw new Error(
            `${trackId}: seek mismatch at ${position.toFixed(6)}s, channel ${index % 3}, sample ${Math.floor(index / 3)}; difference ${difference} exceeds ${comparisonTolerance}.`,
          );
        }
      }
    } finally {
      uninterrupted.free();
      restored.free();
    }
  }
}

function detectSourceFormat(
  bytes: Uint8Array,
): GeneratedProvenance['sourceFormat'] {
  if (hasMagic(bytes, 'PSG') && bytes[3] === 0x1a) return 'PSG';
  if (hasMagic(bytes, 'ZXAYEMUL')) return 'AY';
  if (hasMagic(bytes, 'YM6!')) return 'YM6';
  if (hasMagic(bytes, 'YM3!')) return 'YM3';
  throw new Error(
    'unsupported source signature; expected PSG, ZXAY/EMUL, YM3, or YM6',
  );
}

function assertExtensionMatches(
  input: TrackInput,
  sourceFormat: GeneratedProvenance['sourceFormat'],
): void {
  const expected =
    sourceFormat === 'PSG' ? '.psg' : sourceFormat === 'AY' ? '.ay' : '.ym';
  if (input.sourceExtension !== expected) {
    throw new Error(
      `${input.sourcePath}: extension ${input.sourceExtension} does not match detected ${sourceFormat} format.`,
    );
  }
}

function captureAy(
  source: Uint8Array,
  input: TrackInput,
  frameRateHz: number,
): {
  readonly frames: readonly RegisterFrame[];
  readonly durationSource: 'source' | 'override';
} {
  const player = createEnginePlayer(
    selectAySubsong(source, input.sidecar.subsong),
  );
  try {
    const reliable = player.hasDurationInfo() && player.duration_seconds() > 0;
    const override = input.sidecar.durationOverrideSeconds;
    if (reliable && override !== undefined) {
      throw new Error(
        `${input.sidecar.id}: durationOverrideSeconds is not allowed on a reliably finite AY source.`,
      );
    }
    if (!reliable && override === undefined) {
      throw new Error(
        `${input.sidecar.id}: looping or unreliable AY source requires durationOverrideSeconds.`,
      );
    }
    const requestedDuration = reliable
      ? player.duration_seconds()
      : (override ?? 0);
    const frameCount = Math.ceil(requestedDuration * frameRateHz);
    const samplesPerFrame = ENGINE_SAMPLE_RATE / frameRateHz;
    if (!Number.isInteger(samplesPerFrame)) {
      throw new Error(
        `${input.sidecar.id}: frame rate ${frameRateHz} does not divide the engine sample rate.`,
      );
    }
    const frames: RegisterFrame[] = [];
    player.play();
    for (let frame = 0; frame < frameCount; frame += 1) {
      player.generateSamples(samplesPerFrame);
      const registers = player.get_registers();
      registers[13] = 0xff;
      frames.push(registers);
    }
    return { frames, durationSource: reliable ? 'source' : 'override' };
  } finally {
    player.free();
  }
}

async function originalFileName(input: TrackInput): Promise<string> {
  try {
    const stagedName = (
      await readFile(
        path.join(input.directory, 'generated', 'original-name.txt'),
        'utf8',
      )
    ).trim();
    if (stagedName !== '') return stagedName;
  } catch {
    // Only a newly staged import uses this transient handoff.
  }
  const provenancePath = path.join(
    input.directory,
    'generated',
    'provenance.json',
  );
  try {
    const parsed = generatedProvenanceSchema.parse(
      JSON.parse(await readFile(provenancePath, 'utf8')) as unknown,
    );
    return parsed.originalFileName;
  } catch {
    return path.basename(input.sourcePath);
  }
}

async function prepareTrack(
  root: string,
  input: TrackInput,
): Promise<PreparedTrack> {
  const source = await readFile(input.sourcePath);
  if (source.length === 0)
    throw new Error(`${input.sourcePath}: source is empty.`);
  const trackerExtension = asTrackerExtension(input.sourceExtension);
  let sourceFormat: GeneratedProvenance['sourceFormat'];
  let playableSource: Uint8Array = source;
  let trackerConversion: TrackerConversionProvenance | null = null;
  if (trackerExtension === undefined) {
    sourceFormat = detectSourceFormat(source);
    assertExtensionMatches(input, sourceFormat);
  } else {
    const converted = await readTrackerConversion(input, source);
    sourceFormat = converted.metadata.sourceFormat;
    playableSource = converted.psg;
    trackerConversion = converted.metadata;
  }

  const chipType = requiredPlaybackField(input, 'chipType');
  let chipClockHz = requiredPlaybackField(input, 'chipClockHz');
  let frameRateHz = requiredPlaybackField(input, 'frameRateHz');
  const channelLayout = requiredPlaybackField(input, 'channelLayout');
  let frames: readonly RegisterFrame[];
  let runtime: Uint8Array;
  let runtimeMode: GeneratedProvenance['runtimeMode'];
  let durationSource: GeneratedProvenance['durationSource'] = 'source';

  if (sourceFormat === 'PSG' || trackerConversion !== null) {
    frames = parsePsg(playableSource).frames;
    runtime = createYm6(frames, {
      chipClockHz,
      frameRateHz,
      title: input.sidecar.title,
      author: input.sidecar.author,
      comment:
        trackerConversion === null
          ? `Converted from ${path.basename(input.sourcePath)} by ZX-MUSIC.FM`
          : `Converted from ${sourceFormat} through ZXTune PSG by ZX-MUSIC.FM`,
    });
    runtimeMode = 'convert';
  } else if (sourceFormat === 'AY') {
    const captured = captureAy(source, input, frameRateHz);
    frames = captured.frames;
    durationSource = captured.durationSource;
    runtime = createYm6(frames, {
      chipClockHz,
      frameRateHz,
      title: input.sidecar.title,
      author: input.sidecar.author,
      comment: `Captured from AY subsong ${input.sidecar.subsong} by ZX-MUSIC.FM`,
    });
    runtimeMode = 'convert';
  } else {
    if (sourceFormat === 'YM6') {
      const embedded = parseYm6(source);
      if (
        embedded.chipClockHz !== chipClockHz ||
        embedded.frameRateHz !== frameRateHz
      ) {
        throw new Error(
          `${input.sidecar.id}: sidecar clock or frame rate conflicts with unambiguous YM6 metadata.`,
        );
      }
    }
    const prepared = prepareYmRuntime(source, {
      chipClockHz,
      frameRateHz,
      title: input.sidecar.title,
      author: input.sidecar.author,
      comment: 'Normalized by ZX-MUSIC.FM',
    });
    frames = prepared.frames;
    runtime = prepared.bytes;
    runtimeMode = prepared.mode === 'copy' ? 'copy' : 'normalize';
  }

  const parsedRuntime = parseYm6(runtime);
  chipClockHz = parsedRuntime.chipClockHz;
  frameRateHz = parsedRuntime.frameRateHz;
  compareFrames(frames, parsedRuntime.frames, input.sidecar.id);
  const durationSeconds = parsedRuntime.frames.length / frameRateHz;
  const runtimeTrack: RuntimeTrack = {
    id: input.sidecar.id,
    bytes: runtime,
    durationSeconds,
    chipType,
    chipClockHz,
    frameRateHz,
    channelLayout,
  };
  validateRuntimeSeeks(runtime, durationSeconds, input.sidecar.id);
  const adapter = new Ym2149PlaybackAdapter();
  const render = await adapter.renderOffline(
    runtimeTrack,
    new AbortController().signal,
  );
  adapter.dispose();
  const waveform = encodeWaveformPayload(render);
  const runtimeHash = sha256(runtime);
  const durationOverride =
    durationSource === 'override' &&
    input.sidecar.durationOverrideSeconds !== undefined
      ? {
          reason: 'source-loop-or-unreliable-end' as const,
          requestedSeconds: input.sidecar.durationOverrideSeconds,
          actualFrameCount: frames.length,
          frameRateHz,
          actualDurationSeconds: durationSeconds,
        }
      : null;
  const provenance: GeneratedProvenance = {
    schemaVersion: 1,
    originalFileName: await originalFileName(input),
    sourceFormat,
    sourceSha256: sha256(source),
    sourceByteLength: source.length,
    subsong: input.sidecar.subsong,
    chipType,
    chipClockHz,
    frameRateHz,
    channelLayout,
    runtimeMode,
    runtimeFormat: 'YM6',
    runtimeSha256: runtimeHash,
    runtimeByteLength: runtime.length,
    frameCount: frames.length,
    durationSeconds,
    durationSource,
    durationOverride,
    waveformSha256: sha256(waveform),
    trackerConversion,
    preparationTool: 'zxmusicfm-content-v1',
    engine: { name: 'ym2149-rs', commit: engineCommit },
  };
  const catalog: PreparedTrack['catalog'] = {
    id: input.sidecar.id,
    order: input.sidecar.order,
    title: input.sidecar.title,
    author: input.sidecar.author,
    sourceUrl: input.sidecar.sourceUrl,
    subsong: input.sidecar.subsong,
    sourceFormat,
    runtimeFormat: 'YM6',
    runtimeSha256: runtimeHash,
    runtimeByteLength: runtime.length,
    durationSeconds,
    durationSource,
    chipType,
    chipClockHz,
    frameRateHz,
    channelLayout,
    waveformByteLength: 12_288,
    ...(input.sidecar.year === undefined ? {} : { year: input.sidecar.year }),
    ...(input.sidecar.notes === undefined
      ? {}
      : { notes: input.sidecar.notes }),
  };
  return { input, runtime, waveform, provenance, catalog };
}

function createWaveformPack(payloads: readonly Uint8Array[]): Buffer {
  const header = Buffer.alloc(waveformHeaderLength);
  waveformMagic.copy(header, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(WAVEFORM_BUCKET_COUNT, 6);
  header.writeUInt8(WAVEFORM_CHANNEL_COUNT, 8);
  header.writeUInt8(waveformEncoding, 9);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(payloads.length, 12);
  return Buffer.concat([
    header,
    ...payloads.map((payload) => Buffer.from(payload)),
  ]);
}

async function prepareContent(root: string): Promise<PreparedContent> {
  const inputs = await discoverTrackInputs(root);
  if (inputs.length > 0) await initializeContentEngine(root);
  const tracks: PreparedTrack[] = [];
  for (const input of inputs) tracks.push(await prepareTrack(root, input));
  const waveformBytes = createWaveformPack(
    tracks.map(({ waveform }) => waveform),
  );
  const waveformHash = sha256(waveformBytes);
  const waveformFileName = `waveforms.${waveformHash}.bin`;
  const catalog: GeneratedCatalog = {
    schemaVersion: 1,
    waveforms: {
      url: `/generated/${waveformFileName}`,
      sha256: waveformHash,
      byteLength: waveformBytes.length,
      formatVersion: 1,
      bucketCount: WAVEFORM_BUCKET_COUNT,
      channelCount: WAVEFORM_CHANNEL_COUNT,
    },
    tracks: tracks.map((track, index) => ({
      ...track.catalog,
      runtimeUrl: `/generated/tracks/${track.catalog.id}.${track.catalog.runtimeSha256}.ym`,
      waveformByteOffset:
        waveformHeaderLength + index * WAVEFORM_BYTES_PER_TRACK,
    })),
  };
  generatedCatalogSchema.parse(catalog);
  return {
    tracks,
    catalog,
    catalogBytes: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`),
    waveformBytes,
    waveformFileName,
  };
}

async function atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function cleanHashedAssets(
  directory: string,
  pattern: RegExp,
  expected: ReadonlySet<string>,
): Promise<void> {
  if (!(await isDirectory(directory))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      pattern.test(entry.name) &&
      !expected.has(entry.name)
    ) {
      await unlink(path.join(directory, entry.name));
    }
  }
}

export async function generateFoundationContent(root: string): Promise<void> {
  await generateTrackerConversions(await discoverTrackInputs(root));
  const prepared = await prepareContent(root);
  const publicDirectory = path.join(root, 'public', 'generated');
  const publicTracks = path.join(publicDirectory, 'tracks');
  await mkdir(publicTracks, { recursive: true });

  for (const track of prepared.tracks) {
    const generated = path.join(track.input.directory, 'generated');
    await atomicWrite(path.join(generated, 'playback.ym'), track.runtime);
    await atomicWrite(path.join(generated, 'waveform.bin'), track.waveform);
    await atomicWrite(
      path.join(generated, 'provenance.json'),
      Buffer.from(`${JSON.stringify(track.provenance, null, 2)}\n`),
    );
    await unlink(path.join(generated, 'original-name.txt')).catch(
      () => undefined,
    );
    await atomicWrite(
      path.join(
        publicTracks,
        `${track.catalog.id}.${track.catalog.runtimeSha256}.ym`,
      ),
      track.runtime,
    );
  }
  await atomicWrite(
    path.join(publicDirectory, prepared.waveformFileName),
    prepared.waveformBytes,
  );
  await atomicWrite(
    path.join(publicDirectory, 'catalog.json'),
    prepared.catalogBytes,
  );

  await cleanHashedAssets(
    publicDirectory,
    /^waveforms\.[a-f0-9]{64}\.bin$/u,
    new Set([prepared.waveformFileName]),
  );
  await cleanHashedAssets(
    publicTracks,
    /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{64}\.ym$/u,
    new Set(
      prepared.tracks.map(
        (track) => `${track.catalog.id}.${track.catalog.runtimeSha256}.ym`,
      ),
    ),
  );
}

function validateWaveformPack(
  bytes: Buffer,
  trackCount: number,
  filePath: string,
): void {
  if (
    bytes.length < waveformHeaderLength ||
    !bytes.subarray(0, 4).equals(waveformMagic)
  ) {
    throw new Error(`${filePath}: invalid ZXWF header.`);
  }
  if (
    bytes.readUInt16LE(4) !== 1 ||
    bytes.readUInt16LE(6) !== WAVEFORM_BUCKET_COUNT ||
    bytes.readUInt8(8) !== WAVEFORM_CHANNEL_COUNT ||
    bytes.readUInt8(9) !== waveformEncoding ||
    bytes.readUInt16LE(10) !== 0 ||
    bytes.readUInt32LE(12) !== trackCount
  ) {
    throw new Error(
      `${filePath}: unsupported or inconsistent waveform header.`,
    );
  }
  if (
    bytes.length !==
    waveformHeaderLength + trackCount * WAVEFORM_BYTES_PER_TRACK
  ) {
    throw new Error(`${filePath}: waveform pack length is inconsistent.`);
  }
  for (let offset = waveformHeaderLength; offset < bytes.length; offset += 2) {
    const minimum = bytes.readInt8(offset);
    const maximum = bytes.readInt8(offset + 1);
    if (minimum === -128 || maximum === -128 || minimum > maximum) {
      throw new Error(
        `${filePath}: invalid waveform values at byte ${offset}.`,
      );
    }
  }
}

async function assertExactFile(
  filePath: string,
  expected: Uint8Array,
  label: string,
): Promise<void> {
  let actual: Buffer;
  try {
    actual = await readFile(filePath);
  } catch (error) {
    throw new Error(
      `${filePath}: missing ${label}: ${formatSchemaError(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!actual.equals(Buffer.from(expected))) {
    throw new Error(`${filePath}: ${label} is stale or has unexpected bytes.`);
  }
}

export async function validateContent(root: string): Promise<ValidationResult> {
  const inputs = await discoverTrackInputs(root);
  const expected = await prepareContent(root);
  const catalogPath = path.join(root, 'public', 'generated', 'catalog.json');
  await assertExactFile(
    catalogPath,
    expected.catalogBytes,
    'generated catalog',
  );
  const waveformPath = path.join(
    root,
    'public',
    'generated',
    expected.waveformFileName,
  );
  await assertExactFile(waveformPath, expected.waveformBytes, 'waveform pack');
  validateWaveformPack(
    expected.waveformBytes,
    expected.tracks.length,
    waveformPath,
  );

  for (const track of expected.tracks) {
    const generated = path.join(track.input.directory, 'generated');
    const provenanceBytes = Buffer.from(
      `${JSON.stringify(track.provenance, null, 2)}\n`,
    );
    generatedProvenanceSchema.parse(track.provenance);
    await assertExactFile(
      path.join(generated, 'playback.ym'),
      track.runtime,
      'canonical runtime',
    );
    await assertExactFile(
      path.join(generated, 'waveform.bin'),
      track.waveform,
      'track waveform',
    );
    await assertExactFile(
      path.join(generated, 'provenance.json'),
      provenanceBytes,
      'provenance',
    );
    await assertExactFile(
      path.join(
        root,
        'public',
        'generated',
        'tracks',
        `${track.catalog.id}.${track.catalog.runtimeSha256}.ym`,
      ),
      track.runtime,
      'public runtime asset',
    );
  }

  return {
    trackCount: inputs.length,
    catalogPath,
    waveformPath,
  };
}

export function detectSupportedSource(
  bytes: Uint8Array,
  originalFileName?: string,
): {
  readonly format: GeneratedProvenance['sourceFormat'];
  readonly extension: TrackInput['sourceExtension'];
} {
  const suppliedExtension = originalFileName
    ? path.extname(originalFileName.toLowerCase())
    : '';
  try {
    const format = detectSourceFormat(bytes);
    const extension =
      format === 'AY' ? '.ay' : format === 'PSG' ? '.psg' : '.ym';
    if (suppliedExtension !== '' && suppliedExtension !== extension) {
      throw new Error(
        `${originalFileName}: extension ${suppliedExtension} does not match detected ${format} format.`,
      );
    }
    return {
      format,
      extension,
    };
  } catch (error) {
    const extension = /^\.(pt3|stc|asc|stp)$/u.exec(suppliedExtension)
      ? (suppliedExtension as TrackerExtension)
      : undefined;
    if (extension === undefined) throw error;
    return {
      format: extension.slice(1).toUpperCase() as 'PT3' | 'STC' | 'ASC' | 'STP',
      extension,
    };
  }
}

export function extractYmFrameCount(bytes: Uint8Array): number {
  if (hasMagic(bytes, 'YM6!')) return parseYm6(bytes).frames.length;
  if (hasMagic(bytes, 'YM3!')) return parseYm3(bytes).length;
  throw new Error('not a supported YM source');
}
