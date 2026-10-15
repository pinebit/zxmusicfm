import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  generatedCatalogSchema,
  generatedProvenanceSchema,
} from '../../src/content/schemas.ts';
import { ENGINE_COMMIT } from '../../src/playback/enginePin.ts';
import {
  detectSupportedSource,
  generateFoundationContent,
  readRecordedOriginalFileName,
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

  it('carries the recorded original filename across a schema change', async () => {
    const root = await createTemporaryRoot();
    const provenancePath = path.join(root, 'provenance.json');
    const write = (value: unknown) =>
      writeFile(provenancePath, JSON.stringify(value));

    // The curator's filename lives only in provenance, and a regeneration reads
    // it back to carry it forward. A document written by an older or newer
    // schema still has to yield it, or the value is replaced by `source.<ext>`
    // for every track the moment any unrelated field moves.
    await write({
      originalFileName: 'Klav_-_Satisfaction_9_(1994).stc',
      runtimeMode: 'convert',
      thisFieldDoesNotExistInTheSchema: true,
    });
    await expect(readRecordedOriginalFileName(provenancePath)).resolves.toBe(
      'Klav_-_Satisfaction_9_(1994).stc',
    );

    for (const absent of [
      {},
      { originalFileName: '' },
      { originalFileName: 3 },
    ]) {
      await write(absent);
      await expect(
        readRecordedOriginalFileName(provenancePath),
      ).resolves.toBeUndefined();
    }
    await writeFile(provenancePath, 'not json');
    await expect(
      readRecordedOriginalFileName(provenancePath),
    ).resolves.toBeUndefined();
    await expect(
      readRecordedOriginalFileName(path.join(root, 'missing.json')),
    ).resolves.toBeUndefined();
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

  it('reports the earliest failing track when several fail', async () => {
    // Tracks are prepared on worker threads and can fail in any order. The
    // error must still name the track a sequential run would have stopped at.
    const catalog = generatedCatalogSchema.parse(
      JSON.parse(
        await readFile(
          path.join(process.cwd(), 'public', 'generated', 'catalog.json'),
          'utf8',
        ),
      ) as unknown,
    );
    const shortest = [...catalog.tracks]
      .sort((left, right) => left.durationSeconds - right.durationSeconds)
      .slice(0, 3);
    const root = await createTemporaryRoot();
    await cp(path.join(process.cwd(), 'vendor'), path.join(root, 'vendor'), {
      recursive: true,
    });
    for (const [index, track] of shortest.entries()) {
      const directory = path.join(root, 'content', 'tracks', track.id);
      await cp(
        path.join(process.cwd(), 'content', 'tracks', track.id),
        directory,
        { recursive: true },
      );
      const sidecarPath = path.join(directory, 'track.json');
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<
        string,
        unknown
      >;
      // A retitled sidecar no longer matches the title its committed YM6
      // conversion embeds, so every track after the first is stale.
      await writeFile(
        sidecarPath,
        JSON.stringify({
          ...sidecar,
          order: index + 1,
          ...(index === 0 ? {} : { title: `${track.title} (retitled)` }),
        }),
      );
    }

    const validation = validateContent(root);
    await expect(validation).rejects.toThrow(
      path.join(root, 'content', 'tracks', shortest[1]?.id ?? '', 'source'),
    );
    await expect(validation).rejects.toThrow('YM6 conversion is stale');
  }, 30_000);

  it('validates the generated real catalog and provenance', async () => {
    await expect(validateContent(process.cwd())).resolves.toBeDefined();
  }, 120_000);

  it('derives a bounded loudness match for every committed track', async () => {
    const catalog = generatedCatalogSchema.parse(
      JSON.parse(
        await readFile(
          path.join(process.cwd(), 'public', 'generated', 'catalog.json'),
          'utf8',
        ),
      ) as unknown,
    );

    for (const track of catalog.tracks) {
      // Rounded to two decimals so the value is stable under the byte comparison
      // `validateContent` performs, and clamped so a pathological measurement
      // cannot ship a gain that swamps the volume knob.
      expect(track.normalizationGainDb).toBe(
        Math.round(track.normalizationGainDb * 100) / 100,
      );
      expect(Math.abs(track.normalizationGainDb)).toBeLessThanOrEqual(6);

      const provenance = generatedProvenanceSchema.parse(
        JSON.parse(
          await readFile(
            path.join(
              process.cwd(),
              'content',
              'tracks',
              track.id,
              'generated',
              'provenance.json',
            ),
            'utf8',
          ),
        ) as unknown,
      );
      // The catalog carries the gain the browser applies; provenance also keeps
      // the measurement it came from, so a retune can be reasoned about later.
      expect(provenance.normalizationGainDb).toBe(track.normalizationGainDb);
      expect(provenance.measuredLoudnessLufs).toBeLessThan(0);
      expect(provenance.ym6Conversion.commit).toBe(ENGINE_COMMIT);
      expect(provenance.ym6Conversion.ym6Sha256).toBe(provenance.runtimeSha256);
      expect(provenance.ym6Conversion.ym6ByteLength).toBe(
        provenance.runtimeByteLength,
      );
    }
  }, 30_000);

  it('derives each gain as the distance from the loudness target', async () => {
    // Pins the target and the clamp. Asserting the derivation rather than the
    // spread of the current catalog, whose contents are a curatorial choice.
    const target = -9;
    const catalog = generatedCatalogSchema.parse(
      JSON.parse(
        await readFile(
          path.join(process.cwd(), 'public', 'generated', 'catalog.json'),
          'utf8',
        ),
      ) as unknown,
    );

    for (const track of catalog.tracks) {
      const provenance = generatedProvenanceSchema.parse(
        JSON.parse(
          await readFile(
            path.join(
              process.cwd(),
              'content',
              'tracks',
              track.id,
              'generated',
              'provenance.json',
            ),
            'utf8',
          ),
        ) as unknown,
      );
      const expected = Math.max(
        -6,
        Math.min(6, target - provenance.measuredLoudnessLufs),
      );
      // Within a rounding step: the gain is derived from the unrounded
      // measurement, while provenance stores the rounded one.
      if (track.peakLimitedFrom === undefined) {
        expect(track.normalizationGainDb).toBeCloseTo(expected, 1);
      } else {
        expect(track.peakLimitedFrom).toBeCloseTo(expected, 1);
        expect(track.normalizationGainDb).toBeLessThan(track.peakLimitedFrom);
        expect(provenance.peakLimitedFrom).toBe(track.peakLimitedFrom);
      }
    }
  }, 30_000);
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
    expect(
      detectSupportedSource(new TextEncoder().encode('ZXAYEMUL'), 'song.ay'),
    ).toEqual({
      format: 'AY',
      extension: '.ay',
    });
  });

  it('does not route an unsupported extension as a tracker', () => {
    expect(() =>
      detectSupportedSource(new Uint8Array([1, 2, 3]), 'song.mod'),
    ).toThrow('unsupported source signature');
    expect(() =>
      detectSupportedSource(
        new TextEncoder().encode('YM6!LeOnArD!'),
        'song.ym',
      ),
    ).toThrow('unsupported source signature');
  });
});
