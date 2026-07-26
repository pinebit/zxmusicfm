import { describe, expect, it } from 'vitest';

import { measureLoudnessLufs } from './loudness.ts';

const RATE = 48_000;

function sine(
  hz: number,
  seconds: number,
  amplitude: number,
  rate = RATE,
): Float32Array {
  const length = Math.round(rate * seconds);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / rate);
  }
  return samples;
}

/** Measures and narrows, so the assertions below read as plain numbers. */
function measured(samples: Float32Array, rate = RATE): number {
  const value = measureLoudnessLufs(samples, rate);
  if (value === null) {
    throw new Error('expected a measurable loudness');
  }
  return value;
}

describe('measureLoudnessLufs', () => {
  it('measures a 1 kHz tone close to its own RMS level', () => {
    // K-weighting is nearly flat at 1 kHz, so a tone whose RMS is -20 dBFS has to
    // land near -20 LUFS. A mistranscribed filter coefficient would show up here.
    const amplitude = Math.SQRT2 * 10 ** (-20 / 20);
    const value = measured(sine(1_000, 4, amplitude));
    expect(value).toBeGreaterThan(-22);
    expect(value).toBeLessThan(-18);
  });

  it('tracks amplitude changes decibel for decibel', () => {
    const quiet = measured(sine(1_000, 4, 0.1));
    const loud = measured(sine(1_000, 4, 0.2));
    expect(loud - quiet).toBeCloseTo(20 * Math.log10(2), 2);
  });

  it('weights high frequencies above low ones at equal amplitude', () => {
    // The point of K-weighting over plain RMS: the shelf lifts content the ear is
    // more sensitive to, and the RLB high-pass discounts deep bass.
    expect(measured(sine(4_000, 4, 0.2))).toBeGreaterThan(
      measured(sine(60, 4, 0.2)),
    );
  });

  it('reports silence as unmeasurable', () => {
    expect(measureLoudnessLufs(new Float32Array(RATE * 2), RATE)).toBeNull();
    expect(measureLoudnessLufs(new Float32Array(0), RATE)).toBeNull();
  });

  it('measures a signal shorter than one gating block', () => {
    // Short is not silent. The content pipeline treats an unmeasurable render as
    // a hard error, so refusing to measure a brief fixture would fail an import
    // that is perfectly valid — the synthetic PSG fixture is two frames long.
    const value = measured(sine(1_000, 0.05, 0.2));
    expect(value).toBeGreaterThan(-30);
    expect(value).toBeLessThan(0);
  });

  it('ignores a quiet passage when gating a mostly loud programme', () => {
    // The relative gate exists so trailing silence does not drag the figure down.
    const loud = sine(1_000, 4, 0.2);
    const padded = new Float32Array(loud.length + RATE * 4);
    padded.set(loud);
    expect(Math.abs(measured(padded) - measured(loud))).toBeLessThan(1);
  });

  it('measures the same level at either project sample rate', () => {
    // Coefficients are derived at the measured rate, so the offline render's
    // 48 kHz and playback's 44.1 kHz must agree.
    const at48 = measured(sine(1_000, 4, 0.2, 48_000), 48_000);
    const at44 = measured(sine(1_000, 4, 0.2, 44_100), 44_100);
    expect(Math.abs(at48 - at44)).toBeLessThan(0.2);
  });
});
