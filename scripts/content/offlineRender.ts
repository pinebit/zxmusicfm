import { readFile } from 'node:fs/promises';
import path from 'node:path';

import initializeWasm, {
  Ym2149Player,
} from '../../vendor/ym2149/ym2149_wasm.js';
import type {
  ChannelId,
  ChannelOrder,
  RuntimeTrack,
} from '../../src/playback/contracts.ts';
import { CENTER_GAIN, MIX_HEADROOM } from '../../src/playback/audioGraph.ts';
import {
  selectAySubsong,
  type RegisterFrame,
} from '../../src/playback/formats.ts';

export const OFFLINE_SAMPLE_RATE = 48_000 as const;
const AY_CAPTURE_SAMPLE_RATE = 44_100;
const RENDER_CHUNK_SAMPLES = OFFLINE_SAMPLE_RATE;
const CHANNEL_COUNT = 3;
const CHANNEL_ORDERS: readonly ChannelOrder[] = ['ABC', 'ACB', 'BAC'];

export type OfflineRender = {
  readonly sampleRate: typeof OFFLINE_SAMPLE_RATE;
  readonly channels: Readonly<Record<ChannelId, Float32Array>>;
  readonly mix: Float32Array;
  readonly worstEarPeak: number;
};

let initialization: Promise<void> | undefined;

export function initializeOfflineEngine(root: string): Promise<void> {
  initialization ??= readFile(
    path.join(root, 'vendor', 'ym2149', 'ym2149_wasm_bg.wasm'),
  )
    .then((wasm) => initializeWasm({ module_or_path: wasm }))
    .then(() => undefined);
  return initialization;
}

function assertGeneratedChannels(
  value: unknown,
  sampleCount: number,
): Float32Array {
  if (typeof value !== 'object' || value === null) {
    throw new Error('ym2149-rs returned an invalid channel render.');
  }
  const generated = value as Partial<
    Record<'channels' | 'channelCount', unknown>
  >;
  if (
    !(generated.channels instanceof Float32Array) ||
    generated.channelCount !== CHANNEL_COUNT ||
    generated.channels.length !== sampleCount * CHANNEL_COUNT
  ) {
    throw new Error('ym2149-rs returned an invalid three-channel render.');
  }
  return generated.channels;
}

export function captureAyFrames(
  source: Uint8Array,
  subsong: number,
  frameRateHz: number,
  durationOverrideSeconds: number | undefined,
  trackId: string,
): {
  readonly frames: readonly RegisterFrame[];
  readonly durationSource: 'source' | 'override';
} {
  const player = new Ym2149Player(selectAySubsong(source, subsong));
  try {
    const reliable = player.hasDurationInfo() && player.duration_seconds() > 0;
    if (reliable && durationOverrideSeconds !== undefined) {
      throw new Error(
        `${trackId}: durationOverrideSeconds is not allowed on a reliably finite AY source.`,
      );
    }
    if (!reliable && durationOverrideSeconds === undefined) {
      throw new Error(
        `${trackId}: looping or unreliable AY source requires durationOverrideSeconds.`,
      );
    }
    const durationSeconds = reliable
      ? player.duration_seconds()
      : (durationOverrideSeconds ?? 0);
    const samplesPerFrame = AY_CAPTURE_SAMPLE_RATE / frameRateHz;
    if (!Number.isInteger(samplesPerFrame)) {
      throw new Error(
        `${trackId}: frame rate ${frameRateHz} does not divide the AY capture sample rate.`,
      );
    }

    const frameCount = Math.ceil(durationSeconds * frameRateHz);
    const frames: RegisterFrame[] = [];
    player.play();
    for (let frame = 0; frame < frameCount; frame += 1) {
      player.generateSamples(samplesPerFrame);
      const registers = player.get_registers();
      // The AY fallback preserves the established capture behavior. The WASM
      // exposes register state, not the write event needed to distinguish an
      // R13 retrigger, so absent writes remain the canonical sentinel.
      registers[13] = 0xff;
      frames.push(registers);
    }
    return {
      frames,
      durationSource: reliable ? 'source' : 'override',
    };
  } finally {
    player.free();
  }
}

export function renderOffline(
  track: RuntimeTrack,
  signal: AbortSignal,
): OfflineRender {
  signal.throwIfAborted();
  const outputLength = Math.round(track.durationSeconds * OFFLINE_SAMPLE_RATE);
  const channels = {
    A: new Float32Array(outputLength),
    B: new Float32Array(outputLength),
    C: new Float32Array(outputLength),
  };
  const mix = new Float32Array(outputLength);
  const player = Ym2149Player.newWithOptions(track.bytes, {
    sampleRate: OFFLINE_SAMPLE_RATE,
    chipModel: track.chipType === 'AY' ? 'ay8912' : 'ym2149',
    strictZxYm6: true,
  });
  let worstEarPeak = 0;

  try {
    if (player.channelCount() !== CHANNEL_COUNT) {
      throw new Error(
        `Track ${track.id} did not expose exactly A/B/C channels.`,
      );
    }
    player.play();
    for (let offset = 0; offset < outputLength;) {
      signal.throwIfAborted();
      const count = Math.min(RENDER_CHUNK_SAMPLES, outputLength - offset);
      const generated = assertGeneratedChannels(
        player.generateSamplesWithChannels(count),
        count,
      );
      for (let index = 0; index < count; index += 1) {
        const base = index * CHANNEL_COUNT;
        const values = {
          A: generated[base] ?? 0,
          B: generated[base + 1] ?? 0,
          C: generated[base + 2] ?? 0,
        };
        const outputIndex = offset + index;
        channels.A[outputIndex] = values.A;
        channels.B[outputIndex] = values.B;
        channels.C[outputIndex] = values.C;
        mix[outputIndex] = (values.A + values.B + values.C) * MIX_HEADROOM;

        for (const order of CHANNEL_ORDERS) {
          const left =
            (Math.abs(values[order[0] as ChannelId]) +
              CENTER_GAIN * Math.abs(values[order[1] as ChannelId])) *
            MIX_HEADROOM;
          const right =
            (Math.abs(values[order[2] as ChannelId]) +
              CENTER_GAIN * Math.abs(values[order[1] as ChannelId])) *
            MIX_HEADROOM;
          worstEarPeak = Math.max(worstEarPeak, left, right);
        }
      }
      offset += count;
    }
  } finally {
    player.free();
  }

  return {
    sampleRate: OFFLINE_SAMPLE_RATE,
    channels,
    mix,
    worstEarPeak,
  };
}
