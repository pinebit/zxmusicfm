import { describe, expect, it } from 'vitest';

import { ChipSynth } from './chipSynth.ts';
import type { RegisterFrame } from './formats.ts';
import { ENGINE_SAMPLE_RATE } from './sampleRates.ts';

const CHIP_CLOCK = 1_773_400;
const FRAME_RATE = 50;
const NO_ENVELOPE_WRITE = 0xff;

function synth(
  frames: readonly RegisterFrame[],
  chipType: 'AY' | 'YM' = 'YM',
): ChipSynth {
  return new ChipSynth({
    frames,
    chipClockHz: CHIP_CLOCK,
    frameRateHz: FRAME_RATE,
    chipType,
    sampleRate: ENGINE_SAMPLE_RATE,
  });
}

/** A steady tone on channel A with noise disabled everywhere. */
function toneFrames(
  period: number,
  amplitude = 15,
  count = 400,
): RegisterFrame[] {
  return Array.from({ length: count }, () => {
    const frame = new Uint8Array(16);
    frame[0] = period & 0xff;
    frame[1] = (period >> 8) & 0x0f;
    frame[7] = 0b111_110;
    frame[8] = amplitude;
    frame[13] = NO_ENVELOPE_WRITE;
    return frame;
  });
}

function channel(rendered: Float32Array, index: number): Float64Array {
  const out = new Float64Array(rendered.length / 3);
  for (let sample = 0; sample < out.length; sample += 1) {
    out[sample] = rendered[sample * 3 + index] ?? 0;
  }
  return out;
}

function peak(samples: Float64Array): number {
  let maximum = 0;
  for (const value of samples) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

/** Magnitude at one frequency via Goertzel, on a Hann-windowed, DC-free block. */
function magnitudeAt(samples: Float64Array, hz: number): number {
  const length = samples.length;
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= length;

  const w = (2 * Math.PI * hz) / ENGINE_SAMPLE_RATE;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let index = 0; index < length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / length);
    const value = ((samples[index] ?? 0) - mean) * window;
    const s0 = value + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2));
}

function render(
  instrument: ChipSynth,
  samples: number,
  skip = 8_820,
): Float64Array {
  instrument.render(skip);
  return channel(instrument.render(samples), 0);
}

describe('ChipSynth band limiting', () => {
  // The defect this renderer exists to fix. The vendored engine snaps tone edges
  // to the output sample grid, which on this tone puts spurious even harmonics
  // near -13 dB and inharmonic partials near -16 dB. Exact-area integration
  // places edges with sub-sample precision, so both must collapse.
  it('keeps a high tone free of inharmonic partials and even harmonics', () => {
    const period = 27;
    const fundamental = CHIP_CLOCK / (16 * period);
    const rendered = render(synth(toneFrames(period)), 32_768);
    const reference = magnitudeAt(rendered, fundamental);
    expect(reference).toBeGreaterThan(0);

    const relativeDb = (hz: number) =>
      20 * Math.log10(magnitudeAt(rendered, hz) / reference);

    // A square wave has only odd harmonics; every even one is an artifact.
    for (const harmonic of [2, 4]) {
      expect(relativeDb(fundamental * harmonic)).toBeLessThan(-45);
    }
    // Frequencies that are not harmonics at all must be far further down.
    for (const ratio of [0.26, 0.74, 1.49, 1.74, 2.26, 3.74]) {
      expect(relativeDb(fundamental * ratio)).toBeLessThan(-55);
    }
    // The odd harmonics that should be there still are.
    expect(relativeDb(fundamental * 3)).toBeGreaterThan(-20);
  });

  it('renders a low tone as a clean odd-harmonic series', () => {
    const period = 428;
    const fundamental = CHIP_CLOCK / (16 * period);
    const rendered = render(synth(toneFrames(period)), 32_768);
    const reference = magnitudeAt(rendered, fundamental);

    expect(
      20 * Math.log10(magnitudeAt(rendered, fundamental * 3) / reference),
    ).toBeGreaterThan(-15);
    expect(
      20 * Math.log10(magnitudeAt(rendered, fundamental * 2) / reference),
    ).toBeLessThan(-45);
  });

  it('places the fundamental at the frequency the chip period asks for', () => {
    const period = 111;
    const expected = CHIP_CLOCK / (16 * period);
    const rendered = render(synth(toneFrames(period)), 32_768);
    // Stronger at the true fundamental than a semitone either side of it.
    expect(magnitudeAt(rendered, expected)).toBeGreaterThan(
      magnitudeAt(rendered, expected * 2 ** (1 / 12)),
    );
    expect(magnitudeAt(rendered, expected)).toBeGreaterThan(
      magnitudeAt(rendered, expected * 2 ** (-1 / 12)),
    );
  });
});

describe('ChipSynth envelopes', () => {
  /** One envelope-driven channel, shape written on the first frame only. */
  function envelopeFrames(shape: number, coarsePeriod = 2): RegisterFrame[] {
    return Array.from({ length: 200 }, (_, index) => {
      const frame = new Uint8Array(16);
      frame[0] = 100;
      frame[7] = 0b111_110;
      frame[8] = 0x10; // channel A follows the envelope
      frame[11] = 0;
      frame[12] = coarsePeriod;
      frame[13] = index === 0 ? shape : NO_ENVELOPE_WRITE;
      return frame;
    });
  }

  const head = (samples: Float64Array) => peak(samples.subarray(0, 2_000));
  const tail = (samples: Float64Array) =>
    peak(samples.subarray(samples.length - 2_000));

  // Shapes without the continue bit are indistinguishable from 0x09 and 0x0F, so
  // the four continue-bit behaviours are what actually need to be right.
  it('holds at silence after a single decay for shapes 0-3 and 9', () => {
    for (const shape of [0, 1, 2, 3, 9]) {
      const rendered = render(
        synth(envelopeFrames(shape)),
        ENGINE_SAMPLE_RATE,
        0,
      );
      expect(head(rendered)).toBeGreaterThan(0.5);
      expect(tail(rendered)).toBeLessThan(0.02);
    }
  });

  it('holds at silence after a single attack for shapes 4-7 and 15', () => {
    for (const shape of [4, 5, 6, 7, 15]) {
      const rendered = render(
        synth(envelopeFrames(shape)),
        ENGINE_SAMPLE_RATE,
        0,
      );
      expect(head(rendered)).toBeLessThan(0.25);
      expect(tail(rendered)).toBeLessThan(0.02);
    }
  });

  it('holds at full level for shapes 11 and 13', () => {
    for (const shape of [11, 13]) {
      const rendered = render(
        synth(envelopeFrames(shape)),
        ENGINE_SAMPLE_RATE,
        0,
      );
      expect(tail(rendered)).toBeGreaterThan(0.5);
    }
  });

  it('keeps cycling for the repeating shapes 8, 10, 12 and 14', () => {
    // One 32-step cycle at this period spans about 3,260 samples, so the window
    // has to cover a full cycle or an alternating sweep can be sampled entirely
    // within its quiet phase. Over a full cycle it must still reach full level.
    for (const shape of [8, 10, 12, 14]) {
      const rendered = render(
        synth(envelopeFrames(shape)),
        ENGINE_SAMPLE_RATE,
        0,
      );
      expect(peak(rendered.subarray(rendered.length - 8_000))).toBeGreaterThan(
        0.5,
      );
    }
  });

  it('does not retrigger the envelope while R13 reads 0xFF', () => {
    // A shape write on every frame would restart a slow envelope 50 times a
    // second, which is why the YM no-write sentinel has to be honoured.
    const slow = envelopeFrames(9, 0x20);
    const retriggered = slow.map((frame) => {
      const copy = new Uint8Array(frame);
      copy[13] = 9;
      return copy;
    });
    const held = render(synth(slow), ENGINE_SAMPLE_RATE, 0);
    const restarted = render(synth(retriggered), ENGINE_SAMPLE_RATE, 0);
    expect(tail(held)).toBeLessThan(tail(restarted));
  });
});

describe('ChipSynth position handling', () => {
  it('advances its reported position by exactly what it rendered', () => {
    const instrument = synth(toneFrames(111));
    expect(instrument.sample).toBe(0);
    instrument.render(1_000);
    expect(instrument.sample).toBe(1_000);
    instrument.render(441);
    expect(instrument.sample).toBe(1_441);
  });

  it('seeks by replaying register writes rather than rendering', () => {
    // Registers are absolute, so the state at a position does not depend on the
    // audio between here and there. Two synths that arrive at the same sample by
    // different routes must then render identically.
    const frames = toneFrames(111);
    const target = 44_100;
    const seeked = synth(frames);
    seeked.seekToSample(target);
    expect(seeked.sample).toBe(target);

    const played = synth(frames);
    played.render(target);
    const fromSeek = channel(seeked.render(4_410), 0);
    const fromPlay = channel(played.render(4_410), 0);

    // Not sample-identical: seeking restarts tone and envelope phase instead of
    // reconstructing it. The audible content has to match all the same.
    expect(peak(fromSeek)).toBeCloseTo(peak(fromPlay), 2);
    const fundamental = CHIP_CLOCK / (16 * 111);
    expect(magnitudeAt(fromSeek, fundamental)).toBeCloseTo(
      magnitudeAt(fromPlay, fundamental),
      0,
    );
  });

  it('picks up the envelope shape written before the frame it seeks to', () => {
    const frames = Array.from({ length: 200 }, (_, index) => {
      const frame = new Uint8Array(16);
      frame[0] = 100;
      frame[7] = 0b111_110;
      frame[8] = 0x10;
      frame[11] = 0;
      frame[12] = 2;
      // Written once, a hundred frames before the seek target.
      frame[13] = index === 0 ? 13 : NO_ENVELOPE_WRITE;
      return frame;
    });
    const instrument = synth(frames);
    instrument.seekToSample(ENGINE_SAMPLE_RATE * 2);
    // Shape 13 rises then holds at full level, so the channel must be audible.
    expect(peak(channel(instrument.render(4_410), 0))).toBeGreaterThan(0.5);
  });

  it('holds the last register state past the final frame', () => {
    const frames = toneFrames(111, 15, 10);
    const instrument = synth(frames);
    const beyond = channel(
      instrument.render(ENGINE_SAMPLE_RATE).subarray(3 * 20_000),
      0,
    );
    expect(peak(beyond)).toBeGreaterThan(0.1);
  });
});

describe('ChipSynth chip models', () => {
  it("uses each chip type's own DAC table", () => {
    // AY level 0 is true silence; the YM2149's DAC has a small floor there. With
    // the envelope at zero the two chips therefore differ.
    const frames = Array.from({ length: 100 }, () => {
      const frame = new Uint8Array(16);
      frame[0] = 100;
      frame[7] = 0b111_110;
      frame[8] = 0; // fixed amplitude zero
      frame[13] = NO_ENVELOPE_WRITE;
      return frame;
    });
    const ay = render(synth(frames, 'AY'), 4_410, 4_410);
    const ym = render(synth(frames, 'YM'), 4_410, 4_410);
    expect(peak(ay)).toBe(0);
    expect(peak(ym)).toBeGreaterThan(0);
    expect(peak(ym)).toBeLessThan(0.01);
  });

  it('renders noise-only channels as broadband content', () => {
    const frames = Array.from({ length: 200 }, () => {
      const frame = new Uint8Array(16);
      frame[6] = 5; // noise period
      frame[7] = 0b110_111; // tone off everywhere, noise on channel A
      frame[8] = 15;
      frame[13] = NO_ENVELOPE_WRITE;
      return frame;
    });
    const rendered = render(synth(frames), 32_768);
    expect(peak(rendered)).toBeGreaterThan(0.1);
    // Broadband rather than tonal: no single frequency dominates the way a
    // square wave's fundamental does.
    const total = [500, 1_500, 3_000, 5_000, 7_000].map((hz) =>
      magnitudeAt(rendered, hz),
    );
    const strongest = Math.max(...total);
    const weakest = Math.min(...total);
    expect(strongest / weakest).toBeLessThan(12);
  });
});

describe('ChipSynth channel states', () => {
  it('reports pitch and amplitude for an audible tone', () => {
    const instrument = synth(toneFrames(111));
    instrument.render(4_410);
    const states = instrument.getChannelStates();
    expect(states).toHaveLength(3);
    expect(states[0]?.frequency).toBeCloseTo(CHIP_CLOCK / (16 * 111), 3);
    expect(states[0]?.toneEnabled).toBe(true);
    expect(states[0]?.amplitude).toBeGreaterThan(0);
  });

  it('reports a silent channel as having no amplitude', () => {
    const frames = toneFrames(111, 0);
    const instrument = synth(frames);
    instrument.render(4_410);
    // Fixed amplitude zero is silence, not the DAC index one above it.
    expect(instrument.getChannelStates()[0]?.amplitude).toBe(0);
  });

  it('marks channels whose tone the mixer has disabled', () => {
    const instrument = synth(toneFrames(111));
    instrument.render(4_410);
    const states = instrument.getChannelStates();
    expect(states[0]?.toneEnabled).toBe(true);
    // Channels B and C are disabled in the fixture's mixer byte.
    expect(states[1]?.toneEnabled).toBe(false);
    expect(states[2]?.toneEnabled).toBe(false);
  });
});

describe('ChipSynth construction', () => {
  it('rejects an empty frame list', () => {
    expect(() => synth([])).toThrow(/at least one register frame/u);
  });

  it('is deterministic across instances', () => {
    const frames = toneFrames(111);
    const first = channel(synth(frames).render(4_410), 0);
    const second = channel(synth(frames).render(4_410), 0);
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});
