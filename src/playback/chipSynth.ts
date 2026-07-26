import { AY_DAC_MAGNITUDES, YM_DAC_MAGNITUDES } from './chipModel.ts';
import type { ChipChannelState, RuntimeTrack } from './contracts.ts';
import type { RegisterFrame } from './formats.ts';

/**
 * A band-limited YM2149 renderer driven directly by register frames.
 *
 * The vendored engine snaps every tone edge to the output sample grid, which
 * jitters the pulse width. Measured on a 4105 Hz tone at 44.1 kHz that produces
 * spurious even harmonics around -13 dB and inharmonic partials around -16 dB —
 * artifacts that land between 1 and 12 kHz, where no output filter can remove
 * them. This renderer instead integrates the chip's piecewise-constant output
 * exactly over each output interval, so an edge falling three quarters of the
 * way through a sample contributes exactly three quarters of it. Integrating at
 * four times the output rate and decimating through two halfband stages then
 * discards the partials above the output Nyquist rather than folding them down.
 *
 * Nothing here touches the vanilla path: the engine, its amplitude model and the
 * offline waveform render are all unchanged.
 */

// The tone, noise and envelope counters all advance at clock/8. That is what
// makes tone frequency clock/(16*period), the noise shift rate clock/(16*period)
// and one 32-step envelope cycle clock/(256*period).
const CHIP_STEP_DIVISOR = 8;

const OVERSAMPLE = 4;
// Stage one only has to clear the 88.2 kHz Nyquist, so it can be short. Stage
// two runs at the output rate and sets the audible passband, so it is longer.
const STAGE_ONE_PAIRS = 6;
const STAGE_TWO_PAIRS = 16;

const CHANNEL_COUNT = 3;
const ENVELOPE_STEPS = 32;
const MAX_LEVEL_INDEX = ENVELOPE_STEPS - 1;
// YM files write 0xFF to R13 to mean "leave the envelope alone this frame".
// Treating it as a shape write would retrigger the envelope 50 times a second.
const NO_ENVELOPE_WRITE = 0xff;

/**
 * Blackman-windowed halfband taps of length `pairs * 4 - 1`. Every even offset
 * from the centre lands on a sinc zero, so half the table is zero by
 * construction and `nonZeroTapIndices` skips it.
 */
function halfbandTaps(pairs: number): Float64Array {
  const length = pairs * 4 - 1;
  const centre = (length - 1) / 2;
  const taps = new Float64Array(length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const offset = index - centre;
    const argument = (Math.PI * offset) / 2;
    const sinc = offset === 0 ? 1 : Math.sin(argument) / argument;
    const phase = (2 * Math.PI * index) / (length - 1);
    const window = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
    const tap = 0.5 * sinc * window;
    taps[index] = tap;
    sum += tap;
  }
  for (let index = 0; index < length; index += 1) {
    taps[index] = (taps[index] ?? 0) / sum;
  }
  return taps;
}

function nonZeroTapIndices(taps: Float64Array): Int32Array {
  const indices: number[] = [];
  for (let index = 0; index < taps.length; index += 1) {
    if (taps[index] !== 0) indices.push(index);
  }
  return Int32Array.from(indices);
}

/** Decimate-by-two FIR over `channels` interleaved streams. */
class HalfbandDecimator {
  private readonly taps: Float64Array;
  private readonly indices: Int32Array;
  private readonly history: Float64Array;
  private readonly length: number;
  private readonly channels: number;
  private write = 0;
  private phase = 0;

  constructor(pairs: number, channels: number) {
    this.channels = channels;
    this.taps = halfbandTaps(pairs);
    this.indices = nonZeroTapIndices(this.taps);
    this.length = this.taps.length;
    this.history = new Float64Array(this.length * channels);
  }

  reset(): void {
    this.history.fill(0);
    this.write = 0;
    this.phase = 0;
  }

  /** Returns true when `output` holds a new decimated sample. */
  push(input: Float64Array, output: Float64Array): boolean {
    const { channels, history, length } = this;
    const newest = this.write;
    const base = newest * channels;
    for (let channel = 0; channel < channels; channel += 1) {
      history[base + channel] = input[channel] ?? 0;
    }
    this.write = newest + 1 === length ? 0 : newest + 1;
    this.phase ^= 1;
    if (this.phase !== 0) return false;

    for (let channel = 0; channel < channels; channel += 1) {
      output[channel] = 0;
    }
    for (const index of this.indices) {
      const coefficient = this.taps[index] ?? 0;
      let slot = newest - index;
      if (slot < 0) slot += length;
      const offset = slot * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        output[channel] =
          (output[channel] ?? 0) +
          coefficient * (history[offset + channel] ?? 0);
      }
    }
    return true;
  }
}

export type ChipSynthOptions = {
  readonly frames: readonly RegisterFrame[];
  readonly chipClockHz: number;
  readonly frameRateHz: number;
  readonly chipType: RuntimeTrack['chipType'];
  readonly sampleRate: number;
};

export class ChipSynth {
  private readonly frames: readonly RegisterFrame[];
  private readonly dac: readonly number[];
  private readonly chipClockHz: number;
  private readonly frameRateHz: number;
  private readonly sampleRate: number;
  /** Chip steps covered by one oversampled output slot. */
  private readonly stepsPerSlot: number;

  private readonly tonePeriod = new Int32Array(CHANNEL_COUNT).fill(1);
  private readonly toneCounter = new Int32Array(CHANNEL_COUNT);
  private readonly toneState = new Int32Array(CHANNEL_COUNT);
  private readonly toneDisabled = [false, false, false];
  private readonly noiseDisabled = [false, false, false];
  private readonly envelopeMode = [false, false, false];
  private readonly amplitude = new Int32Array(CHANNEL_COUNT);
  private readonly fixedMagnitude = new Float64Array(CHANNEL_COUNT);
  private readonly level = new Float64Array(CHANNEL_COUNT);

  private noisePeriod = 1;
  private noiseCounter = 0;
  private noiseState = 1;
  private lfsr = 1;

  private envelopePeriod = 1;
  private envelopeCounter = 0;
  private envelopePosition = 0;
  private envelopeAttack = false;
  private envelopeAlternate = false;
  private envelopeHold = false;
  private envelopeHolding = false;
  private envelopeActive = false;

  private stepFraction = 0;
  private frameIndex = -1;
  private nextFrameSample = 0;
  private position = 0;

  private readonly stageOne = new HalfbandDecimator(
    STAGE_ONE_PAIRS,
    CHANNEL_COUNT,
  );
  private readonly stageTwo = new HalfbandDecimator(
    STAGE_TWO_PAIRS,
    CHANNEL_COUNT,
  );
  private readonly slot = new Float64Array(CHANNEL_COUNT);
  private readonly stageOneOut = new Float64Array(CHANNEL_COUNT);
  private readonly stageTwoOut = new Float64Array(CHANNEL_COUNT);

  constructor(options: ChipSynthOptions) {
    if (options.frames.length === 0) {
      throw new Error('ChipSynth needs at least one register frame.');
    }
    this.frames = options.frames;
    this.dac =
      options.chipType === 'AY' ? AY_DAC_MAGNITUDES : YM_DAC_MAGNITUDES;
    this.chipClockHz = options.chipClockHz;
    this.frameRateHz = options.frameRateHz;
    this.sampleRate = options.sampleRate;
    this.stepsPerSlot =
      options.chipClockHz /
      (CHIP_STEP_DIVISOR * options.sampleRate * OVERSAMPLE);
    this.reset();
  }

  get sample(): number {
    return this.position;
  }

  /**
   * Register values are absolute, so a position change only needs every frame up
   * to the target replayed — no audio has to be rendered. Tone, noise and
   * envelope phase restart instead of being reconstructed, which is inaudible
   * and is why a mode switch or seek here is effectively free.
   */
  seekToSample(sample: number): void {
    this.reset();
    const target = Math.min(
      Math.floor((sample * this.frameRateHz) / this.sampleRate),
      this.frames.length - 1,
    );
    for (let index = 0; index <= target; index += 1) {
      this.applyFrame(index);
    }
    this.frameIndex = target;
    this.nextFrameSample = Math.ceil(
      ((target + 1) * this.sampleRate) / this.frameRateHz,
    );
    this.position = sample;
    this.refreshLevels();
  }

  /** Interleaved A/B/C samples, matching the engine's channel block layout. */
  render(sampleCount: number): Float32Array {
    const output = new Float32Array(sampleCount * CHANNEL_COUNT);
    const { slot, stageOne, stageOneOut, stageTwo, stageTwoOut } = this;

    for (let index = 0; index < sampleCount; index += 1) {
      while (this.position >= this.nextFrameSample) {
        this.applyNextFrame();
      }
      for (let over = 0; over < OVERSAMPLE; over += 1) {
        this.integrateSlot(slot);
        if (
          stageOne.push(slot, stageOneOut) &&
          stageTwo.push(stageOneOut, stageTwoOut)
        ) {
          const base = index * CHANNEL_COUNT;
          output[base] = stageTwoOut[0] ?? 0;
          output[base + 1] = stageTwoOut[1] ?? 0;
          output[base + 2] = stageTwoOut[2] ?? 0;
        }
      }
      this.position += 1;
    }
    return output;
  }

  getChannelStates(): readonly ChipChannelState[] {
    const envelopeIndex = this.envelopeLevelIndex();
    const states: ChipChannelState[] = [];
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      const levelIndex = this.envelopeMode[channel]
        ? envelopeIndex
        : (this.amplitude[channel] ?? 0) === 0
          ? 0
          : (this.amplitude[channel] ?? 0) * 2 + 1;
      states.push({
        frequency: this.chipClockHz / (16 * (this.tonePeriod[channel] ?? 1)),
        amplitude: levelIndex / MAX_LEVEL_INDEX,
        toneEnabled: !(this.toneDisabled[channel] ?? true),
      });
    }
    return states;
  }

  private reset(): void {
    this.tonePeriod.fill(1);
    this.toneCounter.fill(0);
    this.toneState.fill(0);
    this.toneDisabled.fill(false);
    this.noiseDisabled.fill(false);
    this.envelopeMode.fill(false);
    this.amplitude.fill(0);
    this.fixedMagnitude.fill(0);
    this.level.fill(0);
    this.noisePeriod = 1;
    this.noiseCounter = 0;
    this.noiseState = 1;
    this.lfsr = 1;
    this.envelopePeriod = 1;
    this.envelopeCounter = 0;
    this.envelopePosition = 0;
    this.envelopeAttack = false;
    this.envelopeAlternate = false;
    this.envelopeHold = false;
    this.envelopeHolding = false;
    this.envelopeActive = false;
    this.stepFraction = 0;
    this.frameIndex = -1;
    this.nextFrameSample = 0;
    this.position = 0;
    this.stageOne.reset();
    this.stageTwo.reset();
  }

  private applyNextFrame(): void {
    this.frameIndex += 1;
    this.applyFrame(this.frameIndex);
    this.nextFrameSample = Math.ceil(
      ((this.frameIndex + 1) * this.sampleRate) / this.frameRateHz,
    );
  }

  /** Frames past the end hold the last written state, matching the engine. */
  private applyFrame(index: number): void {
    const frame = this.frames[index];
    if (frame === undefined) return;

    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      const fine = frame[channel * 2] ?? 0;
      const coarse = (frame[channel * 2 + 1] ?? 0) & 0x0f;
      const period = (coarse << 8) | fine;
      this.tonePeriod[channel] = period === 0 ? 1 : period;
    }
    const noisePeriod = (frame[6] ?? 0) & 0x1f;
    this.noisePeriod = noisePeriod === 0 ? 1 : noisePeriod;

    const mixer = frame[7] ?? 0;
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      this.toneDisabled[channel] = ((mixer >> channel) & 1) !== 0;
      this.noiseDisabled[channel] = ((mixer >> (channel + 3)) & 1) !== 0;
      const register = frame[8 + channel] ?? 0;
      const envelopeMode = (register & 0x10) !== 0;
      const amplitude = register & 0x0f;
      this.envelopeMode[channel] = envelopeMode;
      this.amplitude[channel] = amplitude;
      this.fixedMagnitude[channel] =
        amplitude === 0
          ? (this.dac[0] ?? 0)
          : (this.dac[amplitude * 2 + 1] ?? 0);
    }
    this.envelopeActive = this.envelopeMode.some((enabled) => enabled);

    const envelopePeriod = ((frame[12] ?? 0) << 8) | (frame[11] ?? 0);
    this.envelopePeriod = envelopePeriod === 0 ? 1 : envelopePeriod;

    const shape = frame[13] ?? NO_ENVELOPE_WRITE;
    if (shape !== NO_ENVELOPE_WRITE) this.resetEnvelope(shape);
    this.refreshLevels();
  }

  /**
   * Shapes without the continue bit are indistinguishable from 0x09 (fall then
   * hold at zero) and 0x0F (rise then drop to zero and hold), so they are
   * remapped and only the four continue-bit shapes need modelling.
   */
  private resetEnvelope(rawShape: number): void {
    const shape =
      (rawShape & 0x08) !== 0
        ? rawShape & 0x0f
        : (rawShape & 0x04) !== 0
          ? 0x0f
          : 0x09;
    this.envelopeAttack = (shape & 0x04) !== 0;
    this.envelopeAlternate = (shape & 0x02) !== 0;
    this.envelopeHold = (shape & 0x01) !== 0;
    this.envelopeHolding = false;
    this.envelopePosition = 0;
    this.envelopeCounter = 0;
  }

  private envelopeLevelIndex(): number {
    if (this.envelopeHolding) return this.envelopeAttack ? MAX_LEVEL_INDEX : 0;
    return this.envelopeAttack
      ? this.envelopePosition
      : MAX_LEVEL_INDEX - this.envelopePosition;
  }

  private advanceEnvelope(): void {
    this.envelopePosition += 1;
    if (this.envelopePosition < ENVELOPE_STEPS) return;
    this.envelopePosition = 0;
    if (this.envelopeAlternate) this.envelopeAttack = !this.envelopeAttack;
    if (this.envelopeHold) this.envelopeHolding = true;
  }

  private refreshLevels(): void {
    const envelopeMagnitude = this.envelopeActive
      ? (this.dac[this.envelopeLevelIndex()] ?? 0)
      : 0;
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      const audible =
        ((this.toneDisabled[channel] ?? false) ||
          this.toneState[channel] === 1) &&
        ((this.noiseDisabled[channel] ?? false) || this.noiseState === 1);
      this.level[channel] = !audible
        ? 0
        : this.envelopeMode[channel]
          ? envelopeMagnitude
          : (this.fixedMagnitude[channel] ?? 0);
    }
  }

  private step(): void {
    let changed = false;
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      const counter = (this.toneCounter[channel] ?? 0) + 1;
      if (counter >= (this.tonePeriod[channel] ?? 1)) {
        this.toneCounter[channel] = 0;
        this.toneState[channel] = (this.toneState[channel] ?? 0) ^ 1;
        changed = true;
      } else {
        this.toneCounter[channel] = counter;
      }
    }

    this.noiseCounter += 1;
    if (this.noiseCounter >= this.noisePeriod * 2) {
      this.noiseCounter = 0;
      const feedback = (this.lfsr ^ (this.lfsr >> 3)) & 1;
      this.lfsr = (this.lfsr >> 1) | (feedback << 16);
      this.noiseState = this.lfsr & 1;
      changed = true;
    }

    if (!this.envelopeHolding) {
      this.envelopeCounter += 1;
      if (this.envelopeCounter >= this.envelopePeriod) {
        this.envelopeCounter = 0;
        this.advanceEnvelope();
        if (this.envelopeActive) changed = true;
      }
    }

    if (changed) this.refreshLevels();
  }

  /**
   * Averages the chip output over one oversampled slot. The signal only changes
   * at chip-step boundaries, so accumulating `level * elapsed` across the
   * partial steps the slot spans is an exact integral, not an approximation.
   */
  private integrateSlot(target: Float64Array): void {
    const total = this.stepsPerSlot;
    let remaining = total;
    let accumulatorA = 0;
    let accumulatorB = 0;
    let accumulatorC = 0;

    while (remaining > 0) {
      const capacity = 1 - this.stepFraction;
      const take = remaining < capacity ? remaining : capacity;
      if (take <= 0) {
        this.stepFraction = 0;
        this.step();
        continue;
      }
      accumulatorA += (this.level[0] ?? 0) * take;
      accumulatorB += (this.level[1] ?? 0) * take;
      accumulatorC += (this.level[2] ?? 0) * take;
      remaining -= take;
      this.stepFraction += take;
      if (this.stepFraction >= 1) {
        this.stepFraction = 0;
        this.step();
      }
    }

    target[0] = accumulatorA / total;
    target[1] = accumulatorB / total;
    target[2] = accumulatorC / total;
  }
}
