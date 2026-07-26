import { ChipSynth } from './chipSynth.ts';
import type { ChannelVoices, RuntimeTrack } from './contracts.ts';
import {
  createEnginePlayer,
  createEnginePlayerAtSample,
  type EnginePlayer,
  generateEngineChannels,
  getEngineChannelVoices,
  toChannelVoices,
} from './engine.ts';
import { parseYm6 } from './formats.ts';
import { ENGINE_SAMPLE_RATE } from './sampleRates.ts';

/**
 * A sample producer for the scheduler. Both renderers expose the same shape so
 * `scheduleBuffers` does not care which mode is active, and each tracks its own
 * position so switching modes reconciles only the source that becomes active.
 */
export type ChipSource = {
  /** Source-sample position this producer will render next. */
  readonly sample: number;
  play(): void;
  pause(): void;
  /** `sampleCount * 3` interleaved A/B/C samples. */
  render(sampleCount: number): Float32Array;
  getVoices(): ChannelVoices;
  seekToSample(sample: number, signal?: AbortSignal): void;
  free(): void;
};

/**
 * The pinned engine. Its native seek does not reconstruct tone/noise/envelope
 * phase, so a position change means a fresh player rendered deterministically
 * from zero — roughly 1 ms per second of audio. Callers defer that to `play`.
 */
class EngineChipSource implements ChipSource {
  private player: EnginePlayer;
  private position = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.player = createEnginePlayer(bytes);
  }

  channelCount(): number {
    return this.player.channelCount();
  }

  get sample(): number {
    return this.position;
  }

  play(): void {
    this.player.play();
  }

  pause(): void {
    this.player.pause();
  }

  render(sampleCount: number): Float32Array {
    const generated = generateEngineChannels(this.player, sampleCount);
    this.position += sampleCount;
    return generated.channels;
  }

  getVoices(): ChannelVoices {
    return getEngineChannelVoices(this.player);
  }

  seekToSample(sample: number, signal?: AbortSignal): void {
    const replacement = createEnginePlayerAtSample(this.bytes, sample, signal);
    replacement.pause();
    const previous = this.player;
    this.player = replacement;
    this.position = sample;
    previous.free();
  }

  free(): void {
    this.player.free();
  }
}

/** The band-limited renderer. Seeks by replaying register writes, so it is free. */
class SynthChipSource implements ChipSource {
  private readonly synth: ChipSynth;

  constructor(track: RuntimeTrack) {
    const parsed = parseYm6(track.bytes);
    this.synth = new ChipSynth({
      frames: parsed.frames,
      chipClockHz: parsed.chipClockHz,
      frameRateHz: parsed.frameRateHz,
      chipType: track.chipType,
      sampleRate: ENGINE_SAMPLE_RATE,
    });
  }

  get sample(): number {
    return this.synth.sample;
  }

  play(): void {
    // Nothing to gate: the synth only advances when rendered.
  }

  pause(): void {
    // See `play`.
  }

  render(sampleCount: number): Float32Array {
    return this.synth.render(sampleCount);
  }

  getVoices(): ChannelVoices {
    return toChannelVoices(this.synth.getChannelStates());
  }

  seekToSample(sample: number): void {
    this.synth.seekToSample(sample);
  }

  free(): void {
    // No external resource to release.
  }
}

export function createEngineChipSource(bytes: Uint8Array): {
  readonly source: ChipSource;
  readonly channelCount: number;
} {
  const source = new EngineChipSource(bytes);
  return { source, channelCount: source.channelCount() };
}

export function createSynthChipSource(track: RuntimeTrack): ChipSource {
  return new SynthChipSource(track);
}
