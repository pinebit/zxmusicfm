export const playbackStatuses = [
  'idle',
  'loading',
  'ready',
  'playing',
  'paused',
  'ended',
  'error',
] as const;

export type PlaybackStatus = (typeof playbackStatuses)[number];

export type ChannelId = 'A' | 'B' | 'C';

export type ChannelOrder = 'ABC' | 'ACB' | 'BAC';

/**
 * `vanilla` is the pinned engine through the original master chain. `studio` is
 * the band-limited renderer through the per-channel processing chain. Both are
 * always available and switch on the fly.
 */
export type PlaybackMode = 'vanilla' | 'studio';

export const playbackModes: readonly PlaybackMode[] = ['vanilla', 'studio'];

/** Per-channel generator state shared by both renderers. */
export type ChipChannelState = {
  readonly frequency: number;
  readonly amplitude: number;
  readonly toneEnabled: boolean;
};

export type ChannelLevels = Readonly<Record<ChannelId, number>>;

export type ChannelVoice = {
  readonly midiNote: number;
  readonly amplitude: number;
};

// Current pitch and normalized register amplitude for each audible tone
// generator. A null channel is silent, noise-only, or has no finite frequency.
export type ChannelVoices = Readonly<Record<ChannelId, ChannelVoice | null>>;

export type OscilloscopeSamples = Readonly<
  Record<ChannelId, Float32Array<ArrayBuffer>>
>;

export type RuntimeTrack = {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly durationSeconds: number;
  readonly chipType: 'AY' | 'YM';
  readonly chipClockHz: number;
  readonly frameRateHz: number;
  readonly channelLayout: 'ABC' | 'ACB';
  /**
   * Build-time measured gain that brings this track to the catalog's common
   * loudness. Absent for the offline render, which measures loudness rather than
   * consuming it.
   */
  readonly normalizationGainDb?: number;
};

export type OfflineRender = {
  readonly sampleRate: 48_000;
  readonly channels: Readonly<Record<ChannelId, Float32Array>>;
  readonly mix: Float32Array;
};

export type PlaybackAdapterSnapshot = {
  readonly status: PlaybackStatus;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
};

export type PlaybackAdapterListener = (
  snapshot: PlaybackAdapterSnapshot,
) => void;

export type PlaybackAdapter = {
  load(track: RuntimeTrack, signal: AbortSignal): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(positionSeconds: number): Promise<void>;
  setVolume(volume: number): void;
  setChannelOrder(channelOrder: ChannelOrder): void;
  setMode(mode: PlaybackMode): void;
  getChannelLevels(): ChannelLevels;
  getChannelVoices(): ChannelVoices;
  getOscilloscopeSamples?(): OscilloscopeSamples;
  renderOffline(
    track: RuntimeTrack,
    signal: AbortSignal,
  ): Promise<OfflineRender>;
  getSnapshot(): PlaybackAdapterSnapshot;
  subscribe(listener: PlaybackAdapterListener): () => void;
  dispose(): void;
};
