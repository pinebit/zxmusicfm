import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

import initializeWasm, {
  Ym2149Player,
} from '../../vendor/ym2149/ym2149_wasm.js';

const CHIP_CLOCK = 1_773_400;
const SAMPLE_RATE = 44_100;
const FRAME_RATE = 50;
const FRAME_COUNT = 400;
const REGISTER_COUNT = 16;

function writeU16BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setUint16(offset, value, false);
}

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setUint32(offset, value, false);
}

/** Build the strict, interleaved single-chip ZX profile emitted by psg2ym6. */
function toneYm6(period: number): Uint8Array {
  const metadata = new TextEncoder().encode('Spectrum gate\0ZX-MUSIC.FM\0\0');
  const headerLength = 34;
  const result = new Uint8Array(
    headerLength + metadata.length + FRAME_COUNT * REGISTER_COUNT + 4,
  );
  result.set(new TextEncoder().encode('YM6!LeOnArD!'));
  writeU32BE(result, 12, FRAME_COUNT);
  writeU32BE(result, 16, 1); // register-interleaved
  writeU16BE(result, 20, 0); // no digi-drums
  writeU32BE(result, 22, CHIP_CLOCK);
  writeU16BE(result, 26, FRAME_RATE);
  writeU32BE(result, 28, 0); // ignored while the loop attribute is disabled
  writeU16BE(result, 32, 0); // no extra header data
  result.set(metadata, headerLength);

  const framesOffset = headerLength + metadata.length;
  for (let register = 0; register < REGISTER_COUNT; register += 1) {
    const value =
      register === 0
        ? period & 0xff
        : register === 1
          ? (period >> 8) & 0x0f
          : register === 7
            ? 0b111_110
            : register === 8
              ? 15
              : register === 13
                ? 0xff
                : 0;
    result.fill(
      value,
      framesOffset + register * FRAME_COUNT,
      framesOffset + (register + 1) * FRAME_COUNT,
    );
  }
  result.set(new TextEncoder().encode('End!'), result.length - 4);
  return result;
}

function channelA(rendered: Float32Array): Float64Array {
  const result = new Float64Array(rendered.length / 3);
  for (let sample = 0; sample < result.length; sample += 1) {
    result[sample] = rendered[sample * 3] ?? 0;
  }
  return result;
}

/** Magnitude at one frequency via Goertzel, on a Hann-windowed, DC-free block. */
function magnitudeAt(samples: Float64Array, hz: number): number {
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= samples.length;

  const angularFrequency = (2 * Math.PI * hz) / SAMPLE_RATE;
  const coefficient = 2 * Math.cos(angularFrequency);
  let previous = 0;
  let previousPrevious = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / samples.length);
    const current =
      ((samples[index] ?? 0) - mean) * window +
      coefficient * previous -
      previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return Math.sqrt(
    Math.max(
      0,
      previous * previous +
        previousPrevious * previousPrevious -
        coefficient * previous * previousPrevious,
    ),
  );
}

beforeAll(async () => {
  await initializeWasm({
    module_or_path: await readFile('vendor/ym2149/ym2149_wasm_bg.wasm'),
  });
});

describe('pinned engine spectral integration', () => {
  it('keeps a 4105 Hz tone free of even harmonics and inharmonic partials', () => {
    const period = 27;
    const fundamental = CHIP_CLOCK / (16 * period);
    const player = Ym2149Player.newWithOptions(toneYm6(period), {
      sampleRate: SAMPLE_RATE,
      chipModel: 'ay8912',
      strictZxYm6: true,
    });

    try {
      player.play();
      player.generateSamplesWithChannels(8_820);
      const generated = player.generateSamplesWithChannels(32_768) as {
        readonly channels: Float32Array;
      };
      const rendered = channelA(generated.channels);
      const reference = magnitudeAt(rendered, fundamental);
      expect(reference).toBeGreaterThan(0);

      const relativeDb = (hz: number) =>
        20 * Math.log10(magnitudeAt(rendered, hz) / reference);

      for (const harmonic of [2, 4]) {
        expect(relativeDb(fundamental * harmonic)).toBeLessThan(-45);
      }
      for (const ratio of [0.26, 0.74, 1.49, 1.74, 2.26, 3.74]) {
        expect(relativeDb(fundamental * ratio)).toBeLessThan(-55);
      }
      expect(relativeDb(fundamental * 3)).toBeGreaterThan(-20);
    } finally {
      player.free();
    }
  });
});
