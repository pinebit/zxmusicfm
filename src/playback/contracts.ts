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

export type ChannelLevels = Readonly<Record<ChannelId, number>>;

export type RuntimeTrack = {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly durationSeconds: number;
  readonly chipType: 'AY' | 'YM';
  readonly chipClockHz: number;
  readonly frameRateHz: number;
  readonly channelLayout: 'ABC' | 'ACB';
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
  getChannelLevels(): ChannelLevels;
  renderOffline(
    track: RuntimeTrack,
    signal: AbortSignal,
  ): Promise<OfflineRender>;
  getSnapshot(): PlaybackAdapterSnapshot;
  subscribe(listener: PlaybackAdapterListener): () => void;
  dispose(): void;
};
