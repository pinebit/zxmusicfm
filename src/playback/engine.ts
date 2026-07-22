import initializeWasm, {
  Ym2149Player,
  type InitInput,
} from '../../vendor/ym2149/ym2149_wasm.js';

import type { ChannelVoices } from './contracts.ts';

export const ENGINE_SAMPLE_RATE = 44_100;
export const OFFLINE_SAMPLE_RATE = 48_000;
export const ENGINE_RENDER_CHUNK = 44_100;

export type EnginePlayer = InstanceType<typeof Ym2149Player>;

export type EngineChannels = {
  readonly mono: Float32Array;
  readonly channels: Float32Array;
  readonly channelCount: number;
};

type EngineChannelState = {
  readonly frequency: number;
  readonly amplitude: number;
  readonly toneEnabled: boolean;
};

let initialization: Promise<void> | undefined;

export function initializeYm2149(input?: InitInput): Promise<void> {
  initialization ??= initializeWasm({
    module_or_path:
      input ??
      new URL('../../vendor/ym2149/ym2149_wasm_bg.wasm', import.meta.url),
  }).then(() => undefined);
  return initialization;
}

export function createEnginePlayer(bytes: Uint8Array): EnginePlayer {
  return new Ym2149Player(bytes);
}

export function generateEngineChannels(
  player: EnginePlayer,
  sampleCount: number,
): EngineChannels {
  const generated = player.generateSamplesWithChannels(sampleCount) as Partial<
    Record<'mono' | 'channels' | 'channelCount', unknown>
  >;
  if (
    !(generated.mono instanceof Float32Array) ||
    !(generated.channels instanceof Float32Array) ||
    generated.channelCount !== 3 ||
    generated.mono.length !== sampleCount ||
    generated.channels.length !== sampleCount * 3
  ) {
    throw new Error(
      'ym2149-rs returned an invalid three-channel sample block.',
    );
  }
  return {
    mono: generated.mono,
    channels: generated.channels,
    channelCount: generated.channelCount,
  };
}

function isEngineChannelState(value: unknown): value is EngineChannelState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof EngineChannelState, unknown>>;
  return (
    typeof candidate.frequency === 'number' &&
    Number.isFinite(candidate.frequency) &&
    typeof candidate.amplitude === 'number' &&
    Number.isFinite(candidate.amplitude) &&
    typeof candidate.toneEnabled === 'boolean'
  );
}

export function frequencyToMidiNote(frequencyHz: number): number | null {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return null;
  return Math.round(69 + 12 * Math.log2(frequencyHz / 440));
}

export function getEngineChannelVoices(player: EnginePlayer): ChannelVoices {
  // The generated binding exposes visualization state as `any`; narrow it at
  // this application-owned boundary before the adapter consumes it.
  const value: unknown = player.getChannelStates();
  if (typeof value !== 'object' || value === null || !('channels' in value)) {
    throw new Error('ym2149-rs returned invalid channel visualization state.');
  }
  const channels: unknown = value.channels;
  if (!Array.isArray(channels) || channels.length < 3) {
    throw new Error('ym2149-rs returned invalid channel visualization state.');
  }
  const channelStates: EngineChannelState[] = [];
  for (const channel of channels.slice(0, 3) as unknown[]) {
    if (!isEngineChannelState(channel)) {
      throw new Error(
        'ym2149-rs returned invalid channel visualization state.',
      );
    }
    channelStates.push(channel);
  }
  const voice = (channel: EngineChannelState | undefined) => {
    if (channel === undefined || !channel.toneEnabled || channel.amplitude <= 0)
      return null;
    const midiNote = frequencyToMidiNote(channel.frequency);
    return midiNote === null
      ? null
      : {
          midiNote,
          amplitude: Math.min(1, Math.max(0, channel.amplitude)),
        };
  };
  return {
    A: voice(channelStates[0]),
    B: voice(channelStates[1]),
    C: voice(channelStates[2]),
  };
}

export function fastForwardEngine(
  player: EnginePlayer,
  sampleCount: number,
  signal?: AbortSignal,
): void {
  let remaining = sampleCount;
  while (remaining > 0) {
    signal?.throwIfAborted();
    const chunk = Math.min(remaining, ENGINE_RENDER_CHUNK);
    player.generateSamples(chunk);
    remaining -= chunk;
  }
}

export function createEnginePlayerAtSample(
  bytes: Uint8Array,
  sample: number,
  signal?: AbortSignal,
): EnginePlayer {
  const player = createEnginePlayer(bytes);
  try {
    player.play();
    fastForwardEngine(player, sample, signal);
    return player;
  } catch (error) {
    player.free();
    throw error;
  }
}
