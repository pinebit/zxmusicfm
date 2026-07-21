import initializeWasm, {
  Ym2149Player,
  type InitInput,
} from '../../vendor/ym2149/ym2149_wasm.js';

export const ENGINE_SAMPLE_RATE = 44_100;
export const OFFLINE_SAMPLE_RATE = 48_000;
export const ENGINE_RENDER_CHUNK = 44_100;

export type EnginePlayer = InstanceType<typeof Ym2149Player>;

export type EngineChannels = {
  readonly mono: Float32Array;
  readonly channels: Float32Array;
  readonly channelCount: number;
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
