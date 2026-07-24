import type { RuntimeTrack } from './contracts.ts';

// Integer levels used by ym2149-rs v0.9.1, normalized by its MAX_LEVEL.
const ymRawLevels = [
  50, 60, 71, 85, 101, 120, 143, 170, 202, 241, 287, 341, 405, 482, 574, 682,
  811, 965, 1148, 1365, 1623, 1930, 2296, 2730, 3247, 3861, 4592, 5461, 6494,
  7723, 9184, 10_922,
] as const;

const ymMagnitudes = ymRawLevels.map((value) => value / 10_922);

// Peter Sovietov's measured AY table, used by Ayumi. AY has 16 effective
// levels, represented as adjacent pairs on the YM engine's 32-step envelope.
const ayMagnitudes = [
  0, 0, 0.00999465934234, 0.00999465934234, 0.0144502937362, 0.0144502937362,
  0.0210574502174, 0.0210574502174, 0.0307011520562, 0.0307011520562,
  0.0455481803616, 0.0455481803616, 0.0644998855573, 0.0644998855573,
  0.107362478065, 0.107362478065, 0.126588845655, 0.126588845655, 0.20498970016,
  0.20498970016, 0.292210269322, 0.292210269322, 0.372838941024, 0.372838941024,
  0.492530708782, 0.492530708782, 0.635324635691, 0.635324635691,
  0.805584802014, 0.805584802014, 1, 1,
] as const;

type MagnitudeCandidate = {
  readonly ym: number;
  readonly ay: number;
};

const ayCandidates: readonly MagnitudeCandidate[] = ymMagnitudes.flatMap(
  (ym, index) => {
    const ay = ayMagnitudes[index] ?? 0;
    return [
      { ym, ay },
      { ym: ym / 2, ay: ay / 2 },
    ];
  },
);

// Fourteen candidates share a `ym` magnitude with a different `ay` result, so
// the first match wins and the candidate order is part of the mapping. Never
// reorder this list or relax the strict `<` comparison to chase a binary search;
// both change the AY amplitude of real chip levels.
function nearestAyMagnitude(magnitude: number): number {
  let nearest = ayCandidates[0];
  if (nearest === undefined) {
    return 0;
  }
  let nearestDistance = Math.abs(magnitude - nearest.ym);

  for (let index = 1; index < ayCandidates.length; index += 1) {
    const candidate = ayCandidates[index];
    if (candidate === undefined) continue;
    const distance = Math.abs(magnitude - candidate.ym);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest.ay;
}

// Live playback only ever presents the chip's own discrete levels, so the scan
// resolves the same few dozen magnitudes over and over — a second of
// three-channel audio is 132,300 calls. Memoize what actually arrives rather
// than the candidate table itself: the engine hands back `Float32Array` samples,
// whose values are not bit-identical to these double-precision levels.
//
// The offline render interpolates between samples, so it can present unbounded
// distinct magnitudes. Cap the table so that path degrades to a plain scan
// instead of growing without limit; live playback settles well inside the cap.
const AY_MAGNITUDE_CACHE_LIMIT = 1_024;
const resolvedAyMagnitudes = new Map<number, number>();

function mapAyMagnitude(magnitude: number): number {
  const resolved = resolvedAyMagnitudes.get(magnitude);
  if (resolved !== undefined) {
    return resolved;
  }
  const mapped = nearestAyMagnitude(magnitude);
  if (resolvedAyMagnitudes.size < AY_MAGNITUDE_CACHE_LIMIT) {
    resolvedAyMagnitudes.set(magnitude, mapped);
  }
  return mapped;
}

export function applyChipAmplitudeModel(
  value: number,
  chipType: RuntimeTrack['chipType'],
): number {
  if (chipType === 'YM' || value === 0) {
    return value;
  }
  const magnitude = mapAyMagnitude(Math.abs(value));
  return value < 0 ? -magnitude : magnitude;
}
