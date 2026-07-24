import { describe, expect, it } from 'vitest';

import { applyChipAmplitudeModel } from './chipModel.ts';

// Independent restatement of the mapping, written as the straightforward
// nearest-neighbour scan. `applyChipAmplitudeModel` resolves the chip's discrete
// levels through a precomputed table for speed, so this reference exists to
// prove the fast path returns identical values — including at the magnitudes
// where two candidates tie and the first one has to win.
const ymRawLevels = [
  50, 60, 71, 85, 101, 120, 143, 170, 202, 241, 287, 341, 405, 482, 574, 682,
  811, 965, 1148, 1365, 1623, 1930, 2296, 2730, 3247, 3861, 4592, 5461, 6494,
  7723, 9184, 10_922,
];
const ayMagnitudes = [
  0, 0, 0.00999465934234, 0.00999465934234, 0.0144502937362, 0.0144502937362,
  0.0210574502174, 0.0210574502174, 0.0307011520562, 0.0307011520562,
  0.0455481803616, 0.0455481803616, 0.0644998855573, 0.0644998855573,
  0.107362478065, 0.107362478065, 0.126588845655, 0.126588845655, 0.20498970016,
  0.20498970016, 0.292210269322, 0.292210269322, 0.372838941024, 0.372838941024,
  0.492530708782, 0.492530708782, 0.635324635691, 0.635324635691,
  0.805584802014, 0.805584802014, 1, 1,
];
const candidates = ymRawLevels
  .map((level) => level / 10_922)
  .flatMap((ym, index) => {
    const ay = ayMagnitudes[index] ?? 0;
    return [
      { ym, ay },
      { ym: ym / 2, ay: ay / 2 },
    ];
  });

function referenceApply(value: number): number {
  if (value === 0) return value;
  const magnitude = Math.abs(value);
  let nearest = candidates[0];
  if (nearest === undefined) return 0;
  let nearestDistance = Math.abs(magnitude - nearest.ym);
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(magnitude - candidate.ym);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return value < 0 ? -nearest.ay : nearest.ay;
}

const levelMagnitudes = candidates.map(({ ym }) => ym);

describe('applyChipAmplitudeModel', () => {
  it('passes YM samples through untouched', () => {
    for (const value of [0, 0.25, -0.25, 1, -1, 0.000_001]) {
      expect(applyChipAmplitudeModel(value, 'YM')).toBe(value);
    }
  });

  it('leaves silence alone on both chips', () => {
    expect(applyChipAmplitudeModel(0, 'AY')).toBe(0);
    expect(applyChipAmplitudeModel(-0, 'AY')).toBe(-0);
  });

  it('matches the reference scan on every discrete chip level', () => {
    for (const magnitude of levelMagnitudes) {
      expect(applyChipAmplitudeModel(magnitude, 'AY')).toBe(
        referenceApply(magnitude),
      );
      expect(applyChipAmplitudeModel(-magnitude, 'AY')).toBe(
        referenceApply(-magnitude),
      );
    }
  });

  it('matches the reference scan on interpolated magnitudes that are not levels', () => {
    // The offline render interpolates between source samples, so it presents
    // magnitudes that never appear in the level table.
    for (let step = 0; step <= 4_000; step += 1) {
      const value = step / 2_000 - 1;
      expect(applyChipAmplitudeModel(value, 'AY')).toBe(referenceApply(value));
    }
  });

  it('resolves ties toward the earlier candidate', () => {
    // Raw level 60 is both `ymRawLevels[1]` and half of `ymRawLevels[5]`, and
    // the two candidates carry different AY magnitudes. The earlier candidate
    // wins, so this level maps to silence rather than to the halved level.
    expect(applyChipAmplitudeModel(60 / 10_922, 'AY')).toBe(0);
    // Raw level 5461 is half of full scale; the earlier candidate wins again.
    expect(applyChipAmplitudeModel(5461 / 10_922, 'AY')).toBe(0.635324635691);
  });

  it('preserves sign symmetry', () => {
    for (const magnitude of levelMagnitudes) {
      const positive = applyChipAmplitudeModel(magnitude, 'AY');
      const negative = applyChipAmplitudeModel(-magnitude, 'AY');
      expect(negative).toBe(positive === 0 ? -0 : -positive);
    }
  });
});
