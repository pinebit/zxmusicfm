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
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  generatedCatalogSchema,
  generatedProvenanceSchema,
  trackerConversionSchema,
  trackSidecarSchema,
  ym6ConversionSchema,
  type GeneratedCatalog,
  type GeneratedProvenance,
  type TrackerConversionProvenance,
  type TrackSidecar,
  type Ym6ConversionProvenance,
} from '../../src/content/schemas.ts';
import type { RuntimeTrack } from '../../src/playback/contracts.ts';
import { ENGINE_COMMIT } from '../../src/playback/enginePin.ts';
import { measureLoudnessLufs } from '../../src/playback/loudness.ts';
import { createYm6, parsePsg, parseYm6 } from '../../src/playback/formats.ts';
import {
  encodeWaveformPayload,
  WAVEFORM_BUCKET_COUNT,
  WAVEFORM_BYTES_PER_TRACK,
  WAVEFORM_CHANNEL_COUNT,
} from '../../src/playback/waveform.ts';
import {
  captureAyFrames,
  initializeOfflineEngine,
  renderOffline,
} from './offlineRender.ts';
import type { PrepareTrackReply } from './prepareTrackWorker.ts';
import { convertPsgToYm6 } from './psg2ym6.ts';
import {
  convertTrackerToPsg,
  ZXTUNE_COMMIT,
  type TrackerExtension,
} from './tracker.ts';

const waveformMagic = Buffer.from('ZXWF', 'ascii');
const waveformHeaderLength = 16;
const waveformEncoding = 1;

export type ValidationResult = {
  readonly trackCount: number;
  readonly catalogPath: string;
  readonly waveformPath: string;
};

export type TrackInput = {
  readonly directory: string;
  readonly sourcePath: string;
  readonly sourceExtension:
    '.ay' | '.psg' | '.pt3' | '.stc' | '.asc' | '.stp' | '.ftc';
  readonly sidecar: TrackSidecar;
};

export type PreparedTrack = {
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
      /^source\.(?:ay|psg|pt3|stc|asc|stp|ftc)$/u.test(fileName),
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
      ['.psg', '.pt3', '.stc', '.asc', '.stp', '.ftc'].includes(
        sourceExtension,
      ) &&
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
    extension === '.stp' ||
    extension === '.ftc'
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
      optimization: 0,
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

async function readYm6Conversion(
  input: TrackInput,
  source: Uint8Array,
  psg: Uint8Array | undefined,
): Promise<{
  readonly runtime: Buffer;
  readonly metadata: Ym6ConversionProvenance;
}> {
  const generated = path.join(input.directory, 'generated');
  let runtime: Buffer;
  let metadata: Ym6ConversionProvenance;
  try {
    runtime = await readFile(path.join(generated, 'playback.ym'));
    metadata = ym6ConversionSchema.parse(
      JSON.parse(
        await readFile(path.join(generated, 'ym6-conversion.json'), 'utf8'),
      ) as unknown,
    );
  } catch (error) {
    throw new Error(
      `${input.sourcePath}: missing or invalid YM6 conversion; run npm run content:generate with the pinned converter available.`,
      { cause: error },
    );
  }

  const chipClockHz = requiredPlaybackField(input, 'chipClockHz');
  const frameRateHz = requiredPlaybackField(input, 'frameRateHz');
  const parsed = parseYm6(runtime);
  const commonMatches =
    metadata.ym6Sha256 === sha256(runtime) &&
    metadata.ym6ByteLength === runtime.length &&
    metadata.clockHz === chipClockHz &&
    metadata.frameRateHz === frameRateHz &&
    metadata.frameCount === parsed.frames.length &&
    metadata.title === input.sidecar.title &&
    metadata.author === input.sidecar.author &&
    parsed.chipClockHz === chipClockHz &&
    parsed.frameRateHz === frameRateHz &&
    parsed.title === input.sidecar.title &&
    parsed.author === input.sidecar.author;
  const inputMatches =
    input.sourceExtension === '.ay'
      ? metadata.tool === 'zxmusicfm-ay-capture' &&
        metadata.sourceSha256 === sha256(source) &&
        metadata.sourceByteLength === source.length &&
        metadata.subsong === input.sidecar.subsong
      : metadata.tool === 'ym2149-psg2ym6' &&
        psg !== undefined &&
        metadata.psgSha256 === sha256(psg) &&
        metadata.psgByteLength === psg.length &&
        metadata.frameCount === parsePsg(psg).frameCount;
  if (!commonMatches || !inputMatches) {
    throw new Error(
      `${input.sourcePath}: YM6 conversion is stale or inconsistent; run npm run content:generate with the pinned converter available.`,
    );
  }
  return { runtime, metadata };
}

async function resolvePsgInput(
  input: TrackInput,
  source: Uint8Array,
): Promise<{
  readonly psg: Uint8Array;
  readonly trackerConversion: TrackerConversionProvenance | null;
}> {
  const trackerExtension = asTrackerExtension(input.sourceExtension);
  if (trackerExtension === undefined) {
    if (input.sourceExtension !== '.psg') {
      throw new Error(`${input.sourcePath}: expected a PSG-backed source.`);
    }
    parsePsg(source);
    if (source[source.length - 1] === 0xfd) {
      return { psg: source, trackerConversion: null };
    }
    // Some valid legacy PSG streams end immediately after a frame boundary.
    // The pinned Rust converter requires the explicit end marker, so normalize
    // only its derived input while preserving the authoritative source bytes.
    const endsAtFrameBoundary = source[source.length - 1] === 0xff;
    const terminated = endsAtFrameBoundary
      ? Uint8Array.from(source)
      : new Uint8Array(source.length + 1);
    if (!endsAtFrameBoundary) terminated.set(source);
    terminated[terminated.length - 1] = 0xfd;
    return { psg: terminated, trackerConversion: null };
  }
  const converted = await readTrackerConversion(input, source);
  parsePsg(converted.psg);
  return {
    psg: converted.psg,
    trackerConversion: converted.metadata,
  };
}

async function generateYm6Conversions(
  root: string,
  inputs: readonly TrackInput[],
): Promise<void> {
  if (inputs.length > 0) await initializeOfflineEngine(root);
  for (const input of inputs) {
    const source = await readFile(input.sourcePath);
    const generated = path.join(input.directory, 'generated');
    let runtime: Uint8Array;
    let metadata: Ym6ConversionProvenance;

    if (input.sourceExtension === '.ay') {
      try {
        await readYm6Conversion(input, source, undefined);
        continue;
      } catch {
        // Missing or stale AY captures are rebuilt below.
      }
      const frameRateHz = requiredPlaybackField(input, 'frameRateHz');
      const chipClockHz = requiredPlaybackField(input, 'chipClockHz');
      if (frameRateHz !== 50) {
        throw new Error(
          `${input.sidecar.id}: the strict ZX AY YM6 profile requires 50 Hz frames.`,
        );
      }
      const captured = captureAyFrames(
        source,
        input.sidecar.subsong,
        frameRateHz,
        input.sidecar.durationOverrideSeconds,
        input.sidecar.id,
      );
      const comment = `Captured from AY subsong ${input.sidecar.subsong} by ZX-MUSIC.FM`;
      runtime = createYm6(captured.frames, {
        chipClockHz,
        frameRateHz,
        title: input.sidecar.title,
        author: input.sidecar.author,
        comment,
      });
      metadata = {
        tool: 'zxmusicfm-ay-capture',
        commit: ENGINE_COMMIT,
        sourceSha256: sha256(source),
        sourceByteLength: source.length,
        subsong: input.sidecar.subsong,
        durationSource: captured.durationSource,
        ym6Sha256: sha256(runtime),
        ym6ByteLength: runtime.length,
        clockHz: chipClockHz,
        frameRateHz,
        frameCount: captured.frames.length,
        title: input.sidecar.title,
        author: input.sidecar.author,
        comment,
      };
    } else {
      const { psg, trackerConversion } = await resolvePsgInput(input, source);
      try {
        await readYm6Conversion(input, source, psg);
        continue;
      } catch {
        // Missing or stale PSG conversions are rebuilt below.
      }
      const chipClockHz = requiredPlaybackField(input, 'chipClockHz');
      const frameRateHz = requiredPlaybackField(input, 'frameRateHz');
      if (frameRateHz !== 50) {
        throw new Error(
          `${input.sidecar.id}: the pinned PSG converter requires 50 Hz frames.`,
        );
      }
      const parsedPsg = parsePsg(psg);
      const comment =
        trackerConversion === null
          ? `Converted from ${path.basename(input.sourcePath)} by ZX-MUSIC.FM`
          : `Converted from ${trackerConversion.sourceFormat} through ZXTune PSG by ZX-MUSIC.FM`;
      const converted = await convertPsgToYm6(psg, {
        clockHz: chipClockHz,
        frameRateHz,
        title: input.sidecar.title,
        author: input.sidecar.author,
        comment,
      });
      runtime = converted.bytes;
      metadata = {
        tool: 'ym2149-psg2ym6',
        commit: ENGINE_COMMIT,
        psgSha256: sha256(psg),
        psgByteLength: psg.length,
        ym6Sha256: sha256(runtime),
        ym6ByteLength: runtime.length,
        clockHz: chipClockHz,
        frameRateHz,
        frameCount: parsedPsg.frameCount,
        title: input.sidecar.title,
        author: input.sidecar.author,
        comment,
      };
    }

    parseYm6(runtime);
    ym6ConversionSchema.parse(metadata);
    await atomicWrite(path.join(generated, 'playback.ym'), runtime);
    await atomicWrite(
      path.join(generated, 'ym6-conversion.json'),
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
    );
  }
}

function detectSourceFormat(
  bytes: Uint8Array,
): GeneratedProvenance['sourceFormat'] {
  if (hasMagic(bytes, 'PSG') && bytes[3] === 0x1a) return 'PSG';
  if (hasMagic(bytes, 'ZXAYEMUL')) return 'AY';
  throw new Error('unsupported source signature; expected PSG or ZXAY/EMUL');
}

function assertExtensionMatches(
  input: TrackInput,
  sourceFormat: GeneratedProvenance['sourceFormat'],
): void {
  const expected = sourceFormat === 'PSG' ? '.psg' : '.ay';
  if (input.sourceExtension !== expected) {
    throw new Error(
      `${input.sourcePath}: extension ${input.sourceExtension} does not match detected ${sourceFormat} format.`,
    );
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
  return (
    (await readRecordedOriginalFileName(provenancePath)) ??
    path.basename(input.sourcePath)
  );
}

/**
 * Reads the curator's original filename out of an existing provenance document.
 *
 * Deliberately reads the one field rather than validating the whole document:
 * this value survives nowhere else, so parsing against the current schema would
 * silently replace it with `source.<ext>` for every track the first time the
 * schema gains or drops any other field. Exported so that stays table-tested.
 */
export async function readRecordedOriginalFileName(
  provenancePath: string,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('originalFileName' in parsed) ||
    typeof parsed.originalFileName !== 'string' ||
    parsed.originalFileName.trim() === ''
  ) {
    return undefined;
  }
  return parsed.originalFileName;
}

// Set near the catalog's measured median rather than at a broadcast reference.
// Dense square waves measure loud at a modest peak, so a figure this high is
// expected here. The separate peak ceiling below is what makes this safe without
// a limiter in the browser graph.
const LOUDNESS_TARGET_LUFS = -9;
const MAX_NORMALIZATION_GAIN_DB = 6;
const PLAYBACK_PEAK_CEILING_DB = -0.3;

/**
 * Measures the dry offline mix and derives the gain that brings it to the
 * catalog's common loudness. Rounded to two decimals so the value written into
 * provenance and the catalog is stable under byte comparison.
 */
function measureLoudness(
  mix: Float32Array,
  sampleRate: number,
  worstEarPeak: number,
  trackId: string,
): {
  readonly measuredLoudnessLufs: number;
  readonly normalizationGainDb: number;
  readonly peakLimitedFrom?: number;
} {
  const measured = measureLoudnessLufs(mix, sampleRate);
  if (measured === null) {
    throw new Error(
      `${trackId}: rendered mix has no measurable loudness, which means it is silent.`,
    );
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  const loudnessGain = Math.max(
    -MAX_NORMALIZATION_GAIN_DB,
    Math.min(MAX_NORMALIZATION_GAIN_DB, LOUDNESS_TARGET_LUFS - measured),
  );
  const peakGain =
    worstEarPeak > 0
      ? 20 * Math.log10(10 ** (PLAYBACK_PEAK_CEILING_DB / 20) / worstEarPeak)
      : MAX_NORMALIZATION_GAIN_DB;
  const gain = Math.min(loudnessGain, peakGain);
  const peakLimited = gain < loudnessGain;
  // A peak-limited gain is rounded toward safety so serialization cannot move
  // it a hundredth of a decibel back above the ceiling.
  const serializedGain = peakLimited
    ? Math.floor(gain * 100) / 100
    : round(gain);
  return {
    measuredLoudnessLufs: round(measured),
    normalizationGainDb: serializedGain,
    ...(peakLimited ? { peakLimitedFrom: round(loudnessGain) } : {}),
  };
}

export async function prepareTrack(input: TrackInput): Promise<PreparedTrack> {
  const source = await readFile(input.sourcePath);
  if (source.length === 0)
    throw new Error(`${input.sourcePath}: source is empty.`);
  const trackerExtension = asTrackerExtension(input.sourceExtension);
  let sourceFormat: GeneratedProvenance['sourceFormat'];
  let trackerConversion: TrackerConversionProvenance | null = null;
  let psg: Uint8Array | undefined;
  if (trackerExtension === undefined) {
    sourceFormat = detectSourceFormat(source);
    assertExtensionMatches(input, sourceFormat);
    if (sourceFormat === 'PSG') {
      psg = (await resolvePsgInput(input, source)).psg;
    }
  } else {
    const converted = await readTrackerConversion(input, source);
    sourceFormat = converted.metadata.sourceFormat;
    psg = converted.psg;
    trackerConversion = converted.metadata;
  }

  const chipType = requiredPlaybackField(input, 'chipType');
  const chipClockHz = requiredPlaybackField(input, 'chipClockHz');
  const frameRateHz = requiredPlaybackField(input, 'frameRateHz');
  const channelLayout = requiredPlaybackField(input, 'channelLayout');
  const { runtime, metadata: ym6Conversion } = await readYm6Conversion(
    input,
    source,
    psg,
  );
  const parsedRuntime = parseYm6(runtime);
  const frames = parsedRuntime.frames;
  const durationSource: GeneratedProvenance['durationSource'] =
    ym6Conversion.tool === 'zxmusicfm-ay-capture'
      ? ym6Conversion.durationSource
      : 'source';
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
  const render = renderOffline(runtimeTrack, new AbortController().signal);
  const waveform = encodeWaveformPayload(render);
  const loudness = measureLoudness(
    render.mix,
    render.sampleRate,
    render.worstEarPeak,
    input.sidecar.id,
  );
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
    runtimeFormat: 'YM6',
    runtimeSha256: runtimeHash,
    runtimeByteLength: runtime.length,
    frameCount: frames.length,
    durationSeconds,
    durationSource,
    durationOverride,
    waveformSha256: sha256(waveform),
    measuredLoudnessLufs: loudness.measuredLoudnessLufs,
    normalizationGainDb: loudness.normalizationGainDb,
    ...(loudness.peakLimitedFrom === undefined
      ? {}
      : { peakLimitedFrom: loudness.peakLimitedFrom }),
    trackerConversion,
    ym6Conversion,
    preparationTool: 'zxmusicfm-content-v1',
    engine: { name: 'ym2149-rs', commit: ENGINE_COMMIT },
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
    measuredLoudnessLufs: loudness.measuredLoudnessLufs,
    normalizationGainDb: loudness.normalizationGainDb,
    ...(loudness.peakLimitedFrom === undefined
      ? {}
      : { peakLimitedFrom: loudness.peakLimitedFrom }),
    waveformByteLength: WAVEFORM_BYTES_PER_TRACK,
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

// Each in-flight track holds its whole 48 kHz render, about 70 MB per minute of
// audio, so the pool is bounded by memory as well as cores: eight six-minute
// tracks stay well inside the 8 GB of Vercel's smallest build machine.
const MAX_PREPARE_WORKERS = 8;

/**
 * Renders tracks on a pool of worker threads and returns them in input order.
 * A failure stops further dispatch; once in-flight tracks drain, the earliest
 * failing track's error is thrown, exactly as a sequential run would.
 */
async function prepareTracks(
  root: string,
  inputs: readonly TrackInput[],
): Promise<PreparedTrack[]> {
  const tracks: PreparedTrack[] = [];
  const failures: { readonly index: number; readonly error: unknown }[] = [];
  let next = 0;
  // Joined from this module's own path because Vite rewrites the
  // `new URL(..., import.meta.url)` form into a non-file URL under Vitest.
  const workerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'prepareTrackWorker.ts',
  );

  const runWorker = () =>
    new Promise<void>((resolve) => {
      const worker = new Worker(workerPath, { workerData: root });
      let inFlight: number | undefined;
      const dispatch = () => {
        if (next < inputs.length && failures.length === 0) {
          inFlight = next;
          next += 1;
          worker.postMessage(inputs[inFlight]);
        } else {
          inFlight = undefined;
          void worker.terminate();
        }
      };
      worker.on('message', (reply: PrepareTrackReply) => {
        if (inFlight === undefined) return;
        if (reply.ok) tracks[inFlight] = reply.track;
        else failures.push({ index: inFlight, error: reply.error });
        dispatch();
      });
      worker.on('error', (error) => {
        if (inFlight !== undefined) failures.push({ index: inFlight, error });
        inFlight = undefined;
      });
      worker.on('exit', () => {
        if (inFlight !== undefined) {
          failures.push({
            index: inFlight,
            error: new Error(
              `${inputs[inFlight]?.sourcePath ?? 'track'}: preparation worker exited unexpectedly.`,
            ),
          });
        }
        resolve();
      });
      dispatch();
    });

  const workerCount = Math.min(
    inputs.length,
    availableParallelism(),
    MAX_PREPARE_WORKERS,
  );
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  const [firstFailure] = failures.sort((a, b) => a.index - b.index);
  if (firstFailure !== undefined) throw firstFailure.error;
  return tracks;
}

async function prepareContent(root: string): Promise<PreparedContent> {
  const inputs = await discoverTrackInputs(root);
  const tracks = await prepareTracks(root, inputs);
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
  const inputs = await discoverTrackInputs(root);
  await generateTrackerConversions(inputs);
  await generateYm6Conversions(root, inputs);
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
    trackCount: expected.tracks.length,
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
    const extension = format === 'AY' ? '.ay' : '.psg';
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
    const extension = /^\.(pt3|stc|asc|stp|ftc)$/u.exec(suppliedExtension)
      ? (suppliedExtension as TrackerExtension)
      : undefined;
    if (extension === undefined) throw error;
    return {
      format: extension.slice(1).toUpperCase() as
        'PT3' | 'STC' | 'ASC' | 'STP' | 'FTC',
      extension,
    };
  }
}

export function extractYmFrameCount(bytes: Uint8Array): number {
  if (hasMagic(bytes, 'YM6!')) return parseYm6(bytes).frames.length;
  throw new Error('not a supported YM6 runtime');
}
