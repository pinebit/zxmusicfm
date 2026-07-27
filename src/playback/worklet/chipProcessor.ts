import './utf8Shim.ts';
import { initSync, Ym2149Player } from '../../../vendor/ym2149/ym2149_wasm.js';
import type {
  WorkletCommand,
  WorkletFrameSnapshot,
  WorkletReply,
} from '../workletMessages.ts';

declare const currentTime: number;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor,
): void;

const CHANNEL_COUNT = 3;
const RENDER_SAMPLES = 1_024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertGeneratedChannels(
  value: unknown,
  sampleCount: number,
): Float32Array {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The playback engine returned invalid channel audio.');
  }
  const generated = value as Partial<
    Record<'channels' | 'channelCount', unknown>
  >;
  if (
    !(generated.channels instanceof Float32Array) ||
    generated.channelCount !== CHANNEL_COUNT ||
    generated.channels.length !== sampleCount * CHANNEL_COUNT
  ) {
    throw new Error('The playback engine did not return three chip channels.');
  }
  return generated.channels;
}

class Ym2149ChipProcessor extends AudioWorkletProcessor {
  private player: Ym2149Player | undefined;
  private generation = 0;
  private playing = false;
  private endedSent = false;
  private ring: Float32Array = new Float32Array();
  private ringOffset = 0;
  private ringSamples = 0;
  private renderedSamples = 0;
  private totalSamples = 0;
  private frameRateHz = 50;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => {
      this.handleCommand(event.data);
    };
  }

  private reply(message: WorkletReply): void {
    this.port.postMessage(message);
  }

  private clearRing(): void {
    this.ring = new Float32Array();
    this.ringOffset = 0;
    this.ringSamples = 0;
  }

  private handleCommand(command: WorkletCommand): void {
    try {
      switch (command.type) {
        case 'init':
          // `initSync` returns early once instantiated, so a repeated init is a
          // no-op rather than a second instantiation.
          initSync({ module: command.wasm });
          this.reply({ type: 'ready' });
          break;
        case 'load':
          this.player?.free();
          this.generation = command.generation;
          this.player = Ym2149Player.newWithOptions(command.bytes, {
            sampleRate,
            chipModel: command.chipType === 'AY' ? 'ay8912' : 'ym2149',
            strictZxYm6: true,
          });
          if (this.player.channelCount() !== CHANNEL_COUNT) {
            throw new Error(
              `Expected three chip channels, got ${this.player.channelCount()}.`,
            );
          }
          this.playing = false;
          this.endedSent = false;
          this.frameRateHz = command.frameRateHz;
          this.renderedSamples = 0;
          this.totalSamples = Math.round(
            (this.player.frame_count() * sampleRate) / this.frameRateHz,
          );
          this.clearRing();
          this.reply({
            type: 'loaded',
            generation: this.generation,
            frameCount: this.player.frame_count(),
            sampleRate,
          });
          break;
        case 'play':
          if (command.generation === this.generation && this.player) {
            this.player.play();
            this.playing = true;
            this.endedSent = false;
          }
          break;
        case 'pause':
          if (command.generation === this.generation && this.player) {
            this.player.pause();
            this.playing = false;
          }
          break;
        case 'stop':
          if (command.generation === this.generation && this.player) {
            this.player.stop();
            this.playing = false;
            this.endedSent = false;
            this.renderedSamples = 0;
            this.clearRing();
          }
          break;
        case 'seek':
          if (command.generation === this.generation && this.player) {
            this.player.seek_to_frame(command.frame);
            this.endedSent = false;
            this.renderedSamples = Math.round(
              (command.frame * sampleRate) / this.frameRateHz,
            );
            this.clearRing();
          }
          break;
      }
    } catch (error) {
      this.reply(
        command.type === 'init'
          ? { type: 'error', message: errorMessage(error) }
          : {
              type: 'error',
              generation: command.generation,
              message: errorMessage(error),
            },
      );
    }
  }

  private fillRing(outputOffset: number): void {
    if (!this.player || !this.playing) {
      return;
    }

    const sampleCount = Math.min(
      RENDER_SAMPLES,
      this.totalSamples - this.renderedSamples,
    );
    if (sampleCount <= 0) {
      this.clearRing();
      return;
    }
    // Read before rendering, and stamp with the instant this block starts
    // sounding, so the reported position, the notes and the levels all describe
    // the same audio. `currentTime` is the start of the current render quantum,
    // and `outputOffset` is how far into it this block begins — normally zero,
    // because the block length is a multiple of every render quantum size, but
    // a host with an unusual quantum would otherwise drift by up to one.
    const audioTime = currentTime + outputOffset / sampleRate;
    const frame = this.player.frame_position();
    const registers = this.player.get_registers();
    this.ring = assertGeneratedChannels(
      this.player.generateSamplesWithChannels(sampleCount),
      sampleCount,
    );
    this.ringOffset = 0;
    this.ringSamples = sampleCount;
    this.renderedSamples += sampleCount;

    const sums: [number, number, number] = [0, 0, 0];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const base = sample * CHANNEL_COUNT;
      for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
        const value = this.ring[base + channel] ?? 0;
        sums[channel] = (sums[channel] ?? 0) + value * value;
      }
    }

    const snapshot: WorkletFrameSnapshot = {
      type: 'frame',
      generation: this.generation,
      audioTime,
      frame,
      rms: [
        Math.sqrt(sums[0] / sampleCount),
        Math.sqrt(sums[1] / sampleCount),
        Math.sqrt(sums[2] / sampleCount),
      ],
      registers,
    };
    this.reply(snapshot);
  }

  process(
    _inputs: readonly Float32Array[][],
    outputs: readonly Float32Array[][],
  ): boolean {
    const output = outputs[0];
    const outputA = output?.[0];
    const outputB = output?.[1];
    const outputC = output?.[2];
    if (
      outputA === undefined ||
      outputB === undefined ||
      outputC === undefined
    ) {
      return true;
    }
    const channelOutputs = [outputA, outputB, outputC] as const;
    for (const channel of channelOutputs) {
      channel.fill(0);
    }
    if (!this.player || !this.playing) {
      return true;
    }

    const outputLength = outputA.length;
    let outputOffset = 0;
    while (outputOffset < outputLength) {
      if (this.ring.length === 0 || this.ringOffset >= this.ringSamples) {
        this.fillRing(outputOffset);
      }
      if (this.ring.length === 0) {
        break;
      }

      const count = Math.min(
        this.ringSamples - this.ringOffset,
        outputLength - outputOffset,
      );
      for (let sample = 0; sample < count; sample += 1) {
        const sourceBase = (this.ringOffset + sample) * CHANNEL_COUNT;
        for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
          const target = channelOutputs[channel];
          if (target === undefined) continue;
          target[outputOffset + sample] = this.ring[sourceBase + channel] ?? 0;
        }
      }
      this.ringOffset += count;
      outputOffset += count;
    }

    if (
      (!this.player.is_playing() ||
        this.player.frame_position() >= this.player.frame_count()) &&
      this.renderedSamples >= this.totalSamples &&
      this.ringOffset >= this.ringSamples
    ) {
      this.playing = false;
      if (!this.endedSent) {
        this.endedSent = true;
        this.reply({ type: 'ended', generation: this.generation });
      }
    }
    return true;
  }
}

registerProcessor('ym2149-chip', Ym2149ChipProcessor);
