import { applyChipAmplitudeModel } from './chipModel.ts';
import type {
  ChannelLevels,
  OfflineRender,
  PlaybackAdapter,
  PlaybackAdapterListener,
  PlaybackAdapterSnapshot,
  PlaybackStatus,
  RuntimeTrack,
} from './contracts.ts';
import {
  createEnginePlayer,
  createEnginePlayerAtSample,
  ENGINE_RENDER_CHUNK,
  ENGINE_SAMPLE_RATE,
  type EnginePlayer,
  generateEngineChannels,
  initializeYm2149,
  OFFLINE_SAMPLE_RATE,
} from './engine.ts';

const EMPTY_LEVELS: ChannelLevels = { A: 0, B: 0, C: 0 };
const SCHEDULE_CHUNK_SAMPLES = 4_410;
const SCHEDULE_AHEAD_SECONDS = 0.3;
const SCHEDULER_INTERVAL_MS = 50;
const START_LATENCY_SECONDS = 0.02;
const CENTER_GAIN = Math.SQRT1_2;
const MIX_HEADROOM = 0.5;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function assertFiniteTrack(track: RuntimeTrack): void {
  if (track.bytes.length === 0) {
    throw new Error(`Track ${track.id} has no runtime bytes.`);
  }
  if (!Number.isFinite(track.durationSeconds) || track.durationSeconds <= 0) {
    throw new Error(`Track ${track.id} has an invalid duration.`);
  }
  if (!Number.isInteger(track.frameRateHz) || track.frameRateHz <= 0) {
    throw new Error(`Track ${track.id} has an invalid frame rate.`);
  }
}

function rms(
  channels: Float32Array,
  channel: number,
  chipType: RuntimeTrack['chipType'],
): number {
  let sum = 0;
  const sampleCount = channels.length / 3;
  for (let index = channel; index < channels.length; index += 3) {
    const sample = applyChipAmplitudeModel(channels[index] ?? 0, chipType);
    sum += sample * sample;
  }
  return sampleCount === 0 ? 0 : Math.sqrt(sum / sampleCount);
}

function mixStereoSample(
  a: number,
  b: number,
  c: number,
  layout: RuntimeTrack['channelLayout'],
): readonly [number, number] {
  if (layout === 'ABC') {
    return [
      (a + b * CENTER_GAIN) * MIX_HEADROOM,
      (c + b * CENTER_GAIN) * MIX_HEADROOM,
    ];
  }
  return [
    (a + c * CENTER_GAIN) * MIX_HEADROOM,
    (b + c * CENTER_GAIN) * MIX_HEADROOM,
  ];
}

function isPlayingStatus(status: PlaybackStatus): boolean {
  return status === 'playing';
}

export class Ym2149PlaybackAdapter implements PlaybackAdapter {
  private status: PlaybackStatus = 'idle';
  private positionSeconds = 0;
  private durationSeconds = 0;
  private track: RuntimeTrack | undefined;
  private player: EnginePlayer | undefined;
  private listeners = new Set<PlaybackAdapterListener>();
  private audioContext: AudioContext | undefined;
  private gainNode: GainNode | undefined;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private scheduler: ReturnType<typeof globalThis.setInterval> | undefined;
  private nextScheduleTime = 0;
  private scheduledNativeSample = 0;
  private anchorContextTime = 0;
  private anchorPositionSeconds = 0;
  private levels: ChannelLevels = EMPTY_LEVELS;
  private volume = 1;
  private loadGeneration = 0;
  private disposed = false;

  constructor(permittedAudioContext?: AudioContext) {
    this.audioContext = permittedAudioContext;
  }

  async load(track: RuntimeTrack, signal: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    assertFiniteTrack(track);
    const generation = ++this.loadGeneration;
    this.stopScheduling();
    this.releasePlayer();
    this.track = track;
    this.durationSeconds = track.durationSeconds;
    this.positionSeconds = 0;
    this.status = 'loading';
    this.levels = EMPTY_LEVELS;
    this.publish();

    try {
      signal.throwIfAborted();
      await initializeYm2149();
      signal.throwIfAborted();
      if (generation !== this.loadGeneration || this.disposed) {
        return;
      }

      const player = createEnginePlayer(track.bytes);
      if (player.channelCount() !== 3) {
        player.free();
        throw new Error(
          `Track ${track.id} did not expose exactly A/B/C channels.`,
        );
      }
      this.player = player;
      this.status = 'ready';
      this.publish();
    } catch (error) {
      if (generation === this.loadGeneration && !signal.aborted) {
        this.status = 'error';
        this.publish();
      }
      throw error;
    }
  }

  async play(): Promise<void> {
    this.assertNotDisposed();
    if (
      this.player === undefined ||
      this.track === undefined ||
      !['ready', 'paused', 'ended'].includes(this.status)
    ) {
      return;
    }
    if (this.status === 'ended') {
      this.replacePlayerAt(0, false);
      this.positionSeconds = 0;
    }

    const context = this.ensureAudioContext();
    if (context.state === 'suspended') {
      await context.resume();
    }
    if (context.state !== 'running') {
      throw new Error(
        'Audio output is not running; a user gesture is required.',
      );
    }

    this.player.play();
    this.status = 'playing';
    this.anchorPositionSeconds = this.positionSeconds;
    this.anchorContextTime = context.currentTime + START_LATENCY_SECONDS;
    this.nextScheduleTime = this.anchorContextTime;
    this.scheduledNativeSample = Math.round(
      this.positionSeconds * ENGINE_SAMPLE_RATE,
    );
    this.scheduleBuffers();
    this.scheduler = globalThis.setInterval(() => {
      this.scheduleBuffers();
    }, SCHEDULER_INTERVAL_MS);
    this.publish();
  }

  pause(): void {
    if (!isPlayingStatus(this.status)) {
      return;
    }
    const position = this.livePosition();
    this.stopScheduling();
    this.replacePlayerAt(position, false);
    this.positionSeconds = position;
    this.status = 'paused';
    this.levels = EMPTY_LEVELS;
    this.publish();
  }

  stop(): void {
    if (this.player === undefined) {
      return;
    }
    this.stopScheduling();
    this.replacePlayerAt(0, false);
    this.positionSeconds = 0;
    this.status = 'ready';
    this.levels = EMPTY_LEVELS;
    this.publish();
  }

  async seek(positionSeconds: number): Promise<void> {
    this.assertNotDisposed();
    if (this.player === undefined || this.track === undefined) {
      return;
    }
    const wasPlaying = isPlayingStatus(this.status);
    const position = clamp(positionSeconds, 0, this.durationSeconds);
    this.stopScheduling();
    this.replacePlayerAt(position, false);
    this.positionSeconds = position;
    this.levels = EMPTY_LEVELS;

    if (position >= this.durationSeconds) {
      this.status = 'ended';
    } else if (wasPlaying) {
      this.status = 'paused';
      await this.play();
      return;
    } else if (this.status === 'paused') {
      this.status = 'paused';
    } else {
      this.status = 'ready';
    }
    this.publish();
  }

  setVolume(volume: number): void {
    this.volume = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
    this.updateGain();
  }

  getChannelLevels(): ChannelLevels {
    if (!isPlayingStatus(this.status)) {
      return EMPTY_LEVELS;
    }
    return {
      A: this.levels.A * this.volume,
      B: this.levels.B * this.volume,
      C: this.levels.C * this.volume,
    };
  }

  async renderOffline(
    track: RuntimeTrack,
    signal: AbortSignal,
  ): Promise<OfflineRender> {
    assertFiniteTrack(track);
    signal.throwIfAborted();
    await initializeYm2149();
    signal.throwIfAborted();

    const outputLength = Math.round(
      track.durationSeconds * OFFLINE_SAMPLE_RATE,
    );
    const nativeLength = Math.round(track.durationSeconds * ENGINE_SAMPLE_RATE);
    const channelA = new Float32Array(outputLength);
    const channelB = new Float32Array(outputLength);
    const channelC = new Float32Array(outputLength);
    const mix = new Float32Array(outputLength);
    const player = createEnginePlayer(track.bytes);
    player.play();

    let sourceStart = 0;
    let outputIndex = 0;
    let previous: readonly [number, number, number] | undefined;
    try {
      while (sourceStart < nativeLength + 1) {
        signal.throwIfAborted();
        const count = Math.min(
          ENGINE_RENDER_CHUNK,
          nativeLength + 1 - sourceStart,
        );
        const generated = generateEngineChannels(player, count).channels;
        const sourceEnd = sourceStart + count;

        while (outputIndex < outputLength) {
          const sourcePosition =
            (outputIndex * ENGINE_SAMPLE_RATE) / OFFLINE_SAMPLE_RATE;
          const low = Math.floor(sourcePosition);
          const high = low + 1;
          if (high >= sourceEnd) {
            break;
          }
          const fraction = sourcePosition - low;
          const read = (absoluteSample: number, channel: number): number => {
            if (absoluteSample === sourceStart - 1 && previous !== undefined) {
              return previous[channel] ?? 0;
            }
            return generated[(absoluteSample - sourceStart) * 3 + channel] ?? 0;
          };
          const interpolate = (channel: number): number => {
            const lowValue = read(low, channel);
            return lowValue + (read(high, channel) - lowValue) * fraction;
          };
          const a = applyChipAmplitudeModel(interpolate(0), track.chipType);
          const b = applyChipAmplitudeModel(interpolate(1), track.chipType);
          const c = applyChipAmplitudeModel(interpolate(2), track.chipType);
          channelA[outputIndex] = a;
          channelB[outputIndex] = b;
          channelC[outputIndex] = c;
          mix[outputIndex] = (a + b + c) * MIX_HEADROOM;
          outputIndex += 1;
        }

        const last = (count - 1) * 3;
        previous = [
          generated[last] ?? 0,
          generated[last + 1] ?? 0,
          generated[last + 2] ?? 0,
        ];
        sourceStart = sourceEnd;
      }
    } finally {
      player.free();
    }

    if (outputIndex !== outputLength) {
      throw new Error(
        `Offline render produced ${outputIndex} of ${outputLength} samples.`,
      );
    }
    return {
      sampleRate: OFFLINE_SAMPLE_RATE,
      channels: { A: channelA, B: channelB, C: channelC },
      mix,
    };
  }

  getSnapshot(): PlaybackAdapterSnapshot {
    return {
      status: this.status,
      positionSeconds: this.livePosition(),
      durationSeconds: this.durationSeconds,
    };
  }

  subscribe(listener: PlaybackAdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loadGeneration += 1;
    this.stopScheduling();
    this.releasePlayer();
    this.listeners.clear();
    const context = this.audioContext;
    this.audioContext = undefined;
    this.gainNode = undefined;
    if (context !== undefined && context.state !== 'closed') {
      void context.close();
    }
    this.status = 'idle';
    this.positionSeconds = 0;
    this.durationSeconds = 0;
    this.track = undefined;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('The playback adapter has been disposed.');
    }
  }

  private ensureAudioContext(): AudioContext {
    const context =
      this.audioContext ??
      new AudioContext({ sampleRate: OFFLINE_SAMPLE_RATE });
    this.audioContext = context;
    if (this.gainNode === undefined) {
      const gain = context.createGain();
      gain.connect(context.destination);
      this.gainNode = gain;
      this.updateGain();
    }
    return context;
  }

  private updateGain(): void {
    if (this.gainNode !== undefined) {
      this.gainNode.gain.value = this.volume;
    }
  }

  private livePosition(): number {
    if (!isPlayingStatus(this.status) || this.audioContext === undefined) {
      return this.positionSeconds;
    }
    return clamp(
      this.anchorPositionSeconds +
        Math.max(0, this.audioContext.currentTime - this.anchorContextTime),
      0,
      this.durationSeconds,
    );
  }

  private scheduleBuffers(): void {
    const context = this.audioContext;
    const gain = this.gainNode;
    const player = this.player;
    const track = this.track;
    if (
      context === undefined ||
      gain === undefined ||
      player === undefined ||
      track === undefined ||
      !isPlayingStatus(this.status)
    ) {
      return;
    }

    if (this.livePosition() >= this.durationSeconds) {
      this.finishAtEnd();
      return;
    }

    const nativeTotal = Math.round(this.durationSeconds * ENGINE_SAMPLE_RATE);
    while (
      this.nextScheduleTime < context.currentTime + SCHEDULE_AHEAD_SECONDS &&
      this.scheduledNativeSample < nativeTotal
    ) {
      const count = Math.min(
        SCHEDULE_CHUNK_SAMPLES,
        nativeTotal - this.scheduledNativeSample,
      );
      const generated = generateEngineChannels(player, count).channels;
      const buffer = context.createBuffer(2, count, ENGINE_SAMPLE_RATE);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let sample = 0; sample < count; sample += 1) {
        const base = sample * 3;
        const a = applyChipAmplitudeModel(generated[base] ?? 0, track.chipType);
        const b = applyChipAmplitudeModel(
          generated[base + 1] ?? 0,
          track.chipType,
        );
        const c = applyChipAmplitudeModel(
          generated[base + 2] ?? 0,
          track.chipType,
        );
        const stereo = mixStereoSample(a, b, c, track.channelLayout);
        left[sample] = stereo[0];
        right[sample] = stereo[1];
      }

      this.levels = {
        A: rms(generated, 0, track.chipType),
        B: rms(generated, 1, track.chipType),
        C: rms(generated, 2, track.chipType),
      };
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.addEventListener(
        'ended',
        () => {
          this.scheduledSources.delete(source);
        },
        { once: true },
      );
      source.start(this.nextScheduleTime);
      this.scheduledSources.add(source);
      this.scheduledNativeSample += count;
      this.nextScheduleTime += count / ENGINE_SAMPLE_RATE;
    }
  }

  private finishAtEnd(): void {
    this.stopScheduling(false);
    this.player?.pause();
    this.positionSeconds = this.durationSeconds;
    this.status = 'ended';
    this.levels = EMPTY_LEVELS;
    this.publish();
  }

  private stopScheduling(stopSources = true): void {
    if (this.scheduler !== undefined) {
      globalThis.clearInterval(this.scheduler);
      this.scheduler = undefined;
    }
    if (stopSources) {
      for (const source of this.scheduledSources) {
        try {
          source.stop();
        } catch {
          // A source that already ended is harmless.
        }
      }
    }
    this.scheduledSources.clear();
  }

  private replacePlayerAt(positionSeconds: number, playing: boolean): void {
    const track = this.track;
    if (track === undefined) {
      return;
    }
    const nativeSample = Math.round(positionSeconds * ENGINE_SAMPLE_RATE);
    const replacement = createEnginePlayerAtSample(track.bytes, nativeSample);
    if (!playing) {
      replacement.pause();
    }
    const previous = this.player;
    this.player = replacement;
    previous?.free();
  }

  private releasePlayer(): void {
    this.player?.free();
    this.player = undefined;
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
