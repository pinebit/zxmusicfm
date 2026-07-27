import { z } from 'zod';

import { ENGINE_COMMIT } from '../playback/enginePin.ts';
import {
  WAVEFORM_BUCKET_COUNT,
  WAVEFORM_BYTES_PER_TRACK,
  WAVEFORM_CHANNEL_COUNT,
} from '../playback/waveform.ts';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const httpsUrlSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'URL must use HTTPS.' });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: 'custom',
        message: 'URL must not contain credentials.',
      });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'URL is invalid.' });
  }
});

const plainTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/<[^>]+>/u.test(value), 'HTML is not allowed.');

const chipTypeSchema = z.enum(['AY', 'YM']);
const channelLayoutSchema = z.enum(['ABC', 'ACB']);
const sourceFormatSchema = z.enum([
  'PSG',
  'AY',
  'PT3',
  'STC',
  'ASC',
  'STP',
  'FTC',
]);
const runtimeFormatSchema = z.literal('YM6');

// Clamped when derived, so a pathological measurement cannot ship a gain that
// swamps the volume knob in either direction.
const normalizationGainDbSchema = z.number().min(-6).max(6);
const loudnessLufsSchema = z.number().min(-70).max(0);

export const trackSidecarSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: slugSchema,
  order: z.number().int().positive(),
  title: plainTextSchema.max(200),
  author: plainTextSchema.max(200),
  sourceUrl: httpsUrlSchema,
  subsong: z.number().int().positive(),
  chipType: chipTypeSchema.optional(),
  chipClockHz: z.number().int().min(1).max(4_294_967_295).optional(),
  frameRateHz: z.number().int().min(1).max(65_535).optional(),
  channelLayout: channelLayoutSchema.optional(),
  year: z.number().int().min(1970).max(9999).optional(),
  notes: plainTextSchema.max(2_000).optional(),
  durationOverrideSeconds: z.number().positive().max(1_800).optional(),
});

export type TrackSidecar = z.infer<typeof trackSidecarSchema>;

export const trackerConversionSchema = z.strictObject({
  tool: z.literal('zxtune123'),
  commit: z.literal('8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a'),
  mode: z.literal('psg'),
  optimization: z.literal(0),
  sourceFormat: z.enum(['PT3', 'STC', 'ASC', 'STP', 'FTC']),
  sourceSha256: sha256Schema,
  psgSha256: sha256Schema,
  psgByteLength: z.number().int().positive(),
});
export type TrackerConversionProvenance = z.infer<
  typeof trackerConversionSchema
>;

const ym6ConversionCommon = {
  commit: z.literal(ENGINE_COMMIT),
  ym6Sha256: sha256Schema,
  ym6ByteLength: z.number().int().positive(),
  clockHz: z.number().int().min(1).max(4_294_967_295),
  frameRateHz: z.literal(50),
  frameCount: z.number().int().positive(),
  title: plainTextSchema.max(200),
  author: plainTextSchema.max(200),
  comment: plainTextSchema.max(500),
} as const;

export const ym6ConversionSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('ym2149-psg2ym6'),
    ...ym6ConversionCommon,
    psgSha256: sha256Schema,
    psgByteLength: z.number().int().positive(),
  }),
  z.strictObject({
    tool: z.literal('zxmusicfm-ay-capture'),
    ...ym6ConversionCommon,
    sourceSha256: sha256Schema,
    sourceByteLength: z.number().int().positive(),
    subsong: z.number().int().positive(),
    durationSource: z.enum(['source', 'override']),
  }),
]);
export type Ym6ConversionProvenance = z.infer<typeof ym6ConversionSchema>;

export const generatedProvenanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  originalFileName: plainTextSchema.max(500),
  sourceFormat: sourceFormatSchema,
  sourceSha256: sha256Schema,
  sourceByteLength: z.number().int().positive(),
  subsong: z.number().int().positive(),
  chipType: chipTypeSchema,
  chipClockHz: z.number().int().min(1).max(4_294_967_295),
  frameRateHz: z.number().int().min(1).max(65_535),
  channelLayout: channelLayoutSchema,
  runtimeFormat: runtimeFormatSchema,
  runtimeSha256: sha256Schema,
  runtimeByteLength: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  durationSource: z.enum(['source', 'override']),
  durationOverride: z
    .strictObject({
      reason: z.literal('source-loop-or-unreliable-end'),
      requestedSeconds: z.number().positive().max(1_800),
      actualFrameCount: z.number().int().positive(),
      frameRateHz: z.number().int().positive(),
      actualDurationSeconds: z.number().positive(),
    })
    .nullable(),
  waveformSha256: sha256Schema,
  measuredLoudnessLufs: loudnessLufsSchema,
  normalizationGainDb: normalizationGainDbSchema,
  peakLimitedFrom: normalizationGainDbSchema.optional(),
  trackerConversion: trackerConversionSchema.nullable(),
  ym6Conversion: ym6ConversionSchema,
  preparationTool: z.literal('zxmusicfm-content-v1'),
  engine: z.strictObject({
    name: z.literal('ym2149-rs'),
    commit: z.literal(ENGINE_COMMIT),
  }),
});

export type GeneratedProvenance = z.infer<typeof generatedProvenanceSchema>;

const waveformManifestSchema = z.strictObject({
  url: z.string().regex(/^\/generated\/waveforms\.[a-f0-9]{64}\.bin$/u),
  sha256: sha256Schema,
  byteLength: z.number().int().positive(),
  formatVersion: z.literal(1),
  bucketCount: z.literal(WAVEFORM_BUCKET_COUNT),
  channelCount: z.literal(WAVEFORM_CHANNEL_COUNT),
});

const generatedTrackSchema = z
  .strictObject({
    id: slugSchema,
    order: z.number().int().positive(),
    title: plainTextSchema.max(200),
    author: plainTextSchema.max(200),
    sourceUrl: httpsUrlSchema,
    subsong: z.number().int().positive(),
    sourceFormat: sourceFormatSchema,
    runtimeFormat: runtimeFormatSchema,
    runtimeUrl: z
      .string()
      .regex(
        /^\/generated\/tracks\/[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{64}\.ym$/u,
      ),
    runtimeSha256: sha256Schema,
    runtimeByteLength: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    durationSource: z.enum(['source', 'override']),
    chipType: chipTypeSchema,
    chipClockHz: z.number().int().min(1).max(4_294_967_295),
    frameRateHz: z.number().int().min(1).max(65_535),
    channelLayout: channelLayoutSchema,
    measuredLoudnessLufs: loudnessLufsSchema,
    normalizationGainDb: normalizationGainDbSchema,
    peakLimitedFrom: normalizationGainDbSchema.optional(),
    waveformByteOffset: z.number().int().nonnegative(),
    waveformByteLength: z.literal(WAVEFORM_BYTES_PER_TRACK),
    year: z.number().int().min(1970).max(9999).optional(),
    notes: plainTextSchema.max(2_000).optional(),
  })
  .superRefine((track, context) => {
    const expectedRuntimePrefix = `/generated/tracks/${track.id}.`;
    if (!track.runtimeUrl.startsWith(expectedRuntimePrefix)) {
      context.addIssue({
        code: 'custom',
        message: 'runtimeUrl must contain the matching track ID.',
        path: ['runtimeUrl'],
      });
    }

    if (!track.runtimeUrl.includes(track.runtimeSha256)) {
      context.addIssue({
        code: 'custom',
        message: 'runtimeUrl must contain runtimeSha256.',
        path: ['runtimeUrl'],
      });
    }
  });

export const generatedCatalogSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    waveforms: waveformManifestSchema,
    tracks: z.array(generatedTrackSchema),
  })
  .superRefine((catalog, context) => {
    const seenIds = new Set<string>();
    for (const [index, track] of catalog.tracks.entries()) {
      if (seenIds.has(track.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate track ID: ${track.id}.`,
          path: ['tracks', index, 'id'],
        });
      }
      seenIds.add(track.id);

      if (track.order !== index + 1) {
        context.addIssue({
          code: 'custom',
          message: `Expected contiguous order ${index + 1}.`,
          path: ['tracks', index, 'order'],
        });
      }
    }
  });

export type GeneratedCatalog = z.infer<typeof generatedCatalogSchema>;
