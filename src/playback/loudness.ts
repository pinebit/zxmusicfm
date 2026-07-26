/**
 * ITU-R BS.1770 loudness, used at build time to level the catalog.
 *
 * Track-to-track RMS across the current catalog spans 5.6 dB, which is an
 * audible jump between tracks. Plain RMS would over-correct bass-heavy tracks,
 * so this applies the standard's K-weighting (a high-frequency shelf plus a
 * high-pass) and its gating, and reports LUFS.
 *
 * The chip render is mono per channel and the offline mix is a single lane, so
 * only one channel is measured; BS.1770's channel weighting for a mono
 * measurement is unity.
 */

const BLOCK_SECONDS = 0.4;
const BLOCK_OVERLAP = 0.75;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_DB = -10;

type BiquadCoefficients = {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
};

/**
 * Stage 1 of K-weighting: a +4 dB shelf above about 1.5 kHz modelling the
 * acoustic effect of a head. Derived at the measured rate rather than using the
 * standard's 48 kHz constants, so any sample rate measures correctly.
 */
function shelvingFilter(sampleRate: number): BiquadCoefficients {
  const gainDb = 3.999_843_853_973_347;
  const q = 0.707_175_236_955_419_6;
  const centreHz = 1_681.974_450_955_533;

  const k = Math.tan((Math.PI * centreHz) / sampleRate);
  const v0 = 10 ** (gainDb / 20);
  const vb = v0 ** 0.499_666_774_154_541_6;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (v0 + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - v0)) / a0,
    b2: (v0 - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Stage 2 of K-weighting: an RLB high-pass near 38 Hz. */
function highPassFilter(sampleRate: number): BiquadCoefficients {
  const q = 0.500_327_037_323_877_3;
  const cutoffHz = 38.135_470_876_024_44;

  const k = Math.tan((Math.PI * cutoffHz) / sampleRate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

function filterInPlace(
  samples: Float64Array,
  coefficients: BiquadCoefficients,
): void {
  const { b0, b1, b2, a1, a2 } = coefficients;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index] ?? 0;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    samples[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

function blockLoudness(
  weighted: Float64Array,
  start: number,
  length: number,
): number {
  let sum = 0;
  for (let index = start; index < start + length; index += 1) {
    const value = weighted[index] ?? 0;
    sum += value * value;
  }
  return -0.691 + 10 * Math.log10(sum / length + Number.MIN_VALUE);
}

/**
 * Gated loudness in LUFS, or `null` for a signal with nothing above the absolute
 * gate — which here means genuine silence, not merely a quiet track.
 *
 * A signal shorter than one gating block is measured ungated over its whole
 * length. Gating is a refinement for programme material, and refusing to measure
 * a short signal would be indistinguishable from refusing to measure a silent
 * one; the content pipeline treats those very differently.
 */
export function measureLoudnessLufs(
  samples: Float32Array,
  sampleRate: number,
): number | null {
  const blockLength = Math.round(BLOCK_SECONDS * sampleRate);
  if (samples.length === 0) return null;

  const weighted = Float64Array.from(samples);
  filterInPlace(weighted, shelvingFilter(sampleRate));
  filterInPlace(weighted, highPassFilter(sampleRate));

  if (weighted.length < blockLength) {
    const whole = blockLoudness(weighted, 0, weighted.length);
    return whole > ABSOLUTE_GATE_LUFS ? whole : null;
  }

  const step = Math.max(1, Math.round(blockLength * (1 - BLOCK_OVERLAP)));
  const blocks: number[] = [];
  for (let start = 0; start + blockLength <= weighted.length; start += step) {
    blocks.push(blockLoudness(weighted, start, blockLength));
  }

  const aboveAbsolute = blocks.filter((value) => value > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return null;

  // The relative gate is set from the mean of the blocks that cleared the
  // absolute gate, then applied to the same set.
  const meanPower =
    aboveAbsolute.reduce((total, value) => total + 10 ** (value / 10), 0) /
    aboveAbsolute.length;
  const relativeGate = -0.691 + 10 * Math.log10(meanPower) + RELATIVE_GATE_DB;
  const gated = aboveAbsolute.filter((value) => value > relativeGate);
  if (gated.length === 0) return null;

  const gatedPower =
    gated.reduce((total, value) => total + 10 ** (value / 10), 0) /
    gated.length;
  return -0.691 + 10 * Math.log10(gatedPower);
}
