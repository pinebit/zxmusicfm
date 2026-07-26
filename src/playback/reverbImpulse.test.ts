import { describe, expect, it } from 'vitest';

import { createReverbImpulse } from './reverbImpulse.ts';

const RATE = 44_100;

/** Minimal `BaseAudioContext` stand-in: the generator only needs createBuffer. */
function createBufferContext(sampleRate = RATE): BaseAudioContext {
  return {
    sampleRate,
    createBuffer: (channels: number, length: number) => {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return {
        length,
        numberOfChannels: channels,
        sampleRate,
        getChannelData: (channel: number) => data[channel],
      };
    },
  } as unknown as BaseAudioContext;
}

const peak = (samples: Float32Array) =>
  samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);

describe('createReverbImpulse', () => {
  it('produces a stereo buffer of the requested length', () => {
    const buffer = createReverbImpulse(createBufferContext(), 1.2);
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(Math.round(RATE * 1.2));
  });

  it('is identical on every call', () => {
    // The seed is fixed so the tail cannot drift between loads or test runs; a
    // Math.random tail would make every listening comparison a moving target.
    const first = createReverbImpulse(createBufferContext(), 0.5);
    const second = createReverbImpulse(createBufferContext(), 0.5);
    expect(Array.from(first.getChannelData(0))).toEqual(
      Array.from(second.getChannelData(0)),
    );
    expect(Array.from(first.getChannelData(1))).toEqual(
      Array.from(second.getChannelData(1)),
    );
  });

  it('leaves the pre-delay silent', () => {
    const buffer = createReverbImpulse(createBufferContext(), 1.2);
    const preDelay = Math.round(0.012 * RATE);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      expect(peak(data.subarray(0, preDelay))).toBe(0);
      expect(peak(data.subarray(preDelay))).toBeGreaterThan(0);
    }
  });

  it('decays from start to end', () => {
    const buffer = createReverbImpulse(createBufferContext(), 1.2);
    const data = buffer.getChannelData(0);
    const preDelay = Math.round(0.012 * RATE);
    const window = 4_410;
    const early = peak(data.subarray(preDelay, preDelay + window));
    const middle = peak(
      data.subarray(data.length / 2, data.length / 2 + window),
    );
    const late = peak(data.subarray(data.length - window));
    expect(middle).toBeLessThan(early);
    expect(late).toBeLessThan(middle);
    // Far enough down by the end that the tail does not cut off audibly.
    expect(late).toBeLessThan(early * 0.01);
  });

  it('decorrelates the two channels', () => {
    // Identical channels would give a reverb with no width at all.
    const buffer = createReverbImpulse(createBufferContext(), 0.5);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    let dot = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < left.length; index += 1) {
      const l = left[index] ?? 0;
      const r = right[index] ?? 0;
      dot += l * r;
      leftEnergy += l * l;
      rightEnergy += r * r;
    }
    const correlation = dot / Math.sqrt(leftEnergy * rightEnergy);
    expect(Math.abs(correlation)).toBeLessThan(0.2);
  });

  it('scales with the context sample rate', () => {
    const buffer = createReverbImpulse(createBufferContext(48_000), 1);
    expect(buffer.length).toBe(48_000);
  });
});
