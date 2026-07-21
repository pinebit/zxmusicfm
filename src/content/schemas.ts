import { z } from 'zod';

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
  'YM2',
  'YM3',
  'YM3b',
  'YM4',
  'YM5',
  'YM6',
]);
const runtimeFormatSchema = z.enum(['YM2', 'YM3', 'YM3b', 'YM4', 'YM5', 'YM6']);

export const trackSidecarSchema = z
  .strictObject({
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
    licenseName: plainTextSchema.max(300).optional(),
    licenseUrl: httpsUrlSchema.optional(),
    notes: plainTextSchema.max(2_000).optional(),
    durationOverrideSeconds: z.number().positive().max(1_800).optional(),
  })
  .superRefine((sidecar, context) => {
    const hasLicenseName = sidecar.licenseName !== undefined;
    const hasLicenseUrl = sidecar.licenseUrl !== undefined;
    if (hasLicenseName !== hasLicenseUrl) {
      context.addIssue({
        code: 'custom',
        message: 'licenseName and licenseUrl must be provided together.',
        path: hasLicenseName ? ['licenseUrl'] : ['licenseName'],
      });
    }
  });

export type TrackSidecar = z.infer<typeof trackSidecarSchema>;

const waveformManifestSchema = z.strictObject({
  url: z.string().regex(/^\/generated\/waveforms\.[a-f0-9]{64}\.bin$/u),
  sha256: sha256Schema,
  byteLength: z.number().int().positive(),
  formatVersion: z.literal(1),
  bucketCount: z.literal(2048),
  channelCount: z.literal(3),
});

const generatedTrackSchema = z
  .strictObject({
    id: slugSchema,
    order: z.number().int().positive(),
    title: plainTextSchema.max(200),
    author: plainTextSchema.max(200),
    sourceUrl: httpsUrlSchema,
    subsong: z.number().int().positive(),
    licenseName: plainTextSchema.max(300).nullable(),
    licenseUrl: httpsUrlSchema.nullable(),
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
    waveformByteOffset: z.number().int().nonnegative(),
    waveformByteLength: z.literal(12_288),
    year: z.number().int().min(1970).max(9999).optional(),
    notes: plainTextSchema.max(2_000).optional(),
  })
  .superRefine((track, context) => {
    if ((track.licenseName === null) !== (track.licenseUrl === null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Generated license fields must both be strings or both be null.',
      });
    }

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
