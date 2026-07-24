import { applyChipAmplitudeModel } from './chipModel.ts';
import type {
  ChannelId,
  ChannelLevels,
  ChannelOrder,
  ChannelVoices,
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
  getEngineChannelVoices,
  initializeYm2149,
  OFFLINE_SAMPLE_RATE,
} from './engine.ts';

const EMPTY_LEVELS: ChannelLevels = { A: 0, B: 0, C: 0 };
const EMPTY_VOICES: ChannelVoices = { A: null, B: null, C: null };
const SCHEDULE_CHUNK_SAMPLES = 4_410;
const SCHEDULE_AHEAD_SECONDS = 0.3;
const SCHEDULER_INTERVAL_MS = 50;
const START_LATENCY_SECONDS = 0.02;
const CENTER_GAIN = Math.SQRT1_2;
const MIX_HEADROOM = 0.5;
const CHANNELS = ['A', 'B', 'C'] as const;

// Master post-processing chain applied to the stereo mix, in order:
// sub-sonic high-pass → bass low-shelf → safety limiter → high-frequency
// low-pass, then the volume gain node. Tuned for the YM/AY square-wave sound.
const SUBSONIC_HZ = 25; // high-pass: block DC / subsonic energy
const FILTER_Q = Math.SQRT1_2; // Butterworth (flat) response for HP/LP
const BASS_SHELF_HZ = 180; // low-shelf corner
const BASS_SHELF_DB = 4; // low-shelf boost
const LIMITER_THRESHOLD_DB = -1; // catch peaks the boost pushes past 0 dBFS
const SMOOTHING_HZ = 15_000; // low-pass: tame harsh highs / aliasing

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
  // Head of the master post-processing chain, after the channel router. The
  // chain runs to `gainNode` and is built once in `buildAudioGraph`.
  private masterInput: AudioNode | undefined;
  private channelInput: AudioNode | undefined;
  private channelMixGains:
    Readonly<Record<ChannelId, readonly [GainNode, GainNode]>> | undefined;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private scheduler: ReturnType<typeof globalThis.setInterval> | undefined;
  private nextScheduleTime = 0;
  private scheduledNativeSample = 0;
  private anchorContextTime = 0;
  private anchorPositionSeconds = 0;
  // Levels stamped with the AudioContext time at which each scheduled chunk
  // becomes audible, so meters can read the currently-heard chunk rather than
  // the furthest one queued ahead.
  private levelTimeline: {
    readonly time: number;
    readonly levels: ChannelLevels;
  }[] = [];
  // Pitch changes are recorded at source-frame resolution and stamped with
  // their audible AudioContext time. Reading the engine directly would expose
  // the buffers scheduled up to 300 ms ahead.
  private voiceTimeline: {
    readonly time: number;
    readonly voices: ChannelVoices;
  }[] = [];
  private volume = 1;
  private channelOrder: ChannelOrder = 'ABC';
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
    this.levelTimeline = [];
    this.voiceTimeline = [];
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
    this.levelTimeline = [];
    this.voiceTimeline = [];
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
    this.levelTimeline = [];
    this.voiceTimeline = [];
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
    this.levelTimeline = [];
    this.voiceTimeline = [];

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

  setChannelOrder(channelOrder: ChannelOrder): void {
    if (this.channelOrder === channelOrder) return;
    this.channelOrder = channelOrder;
    this.updateChannelMix();
  }

  getChannelLevels(): ChannelLevels {
    if (!isPlayingStatus(this.status) || this.audioContext === undefined) {
      return EMPTY_LEVELS;
    }
    const now = this.audioContext.currentTime;
    // Drop chunks that a later one has already superseded at the playhead.
    while (this.levelTimeline.length > 1) {
      const next = this.levelTimeline[1];
      if (next === undefined || next.time > now) break;
      this.levelTimeline.shift();
    }
    const current = this.levelTimeline[0]?.levels ?? EMPTY_LEVELS;
    return {
      A: current.A * this.volume,
      B: current.B * this.volume,
      C: current.C * this.volume,
    };
  }

  getChannelVoices(): ChannelVoices {
    if (!isPlayingStatus(this.status) || this.audioContext === undefined) {
      return EMPTY_VOICES;
    }
    const now = this.audioContext.currentTime;
    while (this.voiceTimeline.length > 1) {
      const next = this.voiceTimeline[1];
      if (next === undefined || next.time > now) break;
      this.voiceTimeline.shift();
    }
    const current = this.voiceTimeline[0];
    return current !== undefined && current.time <= now
      ? current.voices
      : EMPTY_VOICES;
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
    this.masterInput = undefined;
    this.channelInput = undefined;
    this.channelMixGains = undefined;
    if (context !== undefined && context.state !== 'closed') {
      void context.close();
    }
    this.status = 'idle';
    this.positionSeconds = 0;
    this.durationSeconds = 0;
    this.track = undefined;
    this.levelTimeline = [];
    this.voiceTimeline = [];
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
      this.buildAudioGraph(context);
    }
    return context;
  }

  // Builds the fixed output graph once: three discrete chip channels → stereo
  // routing → highpass → bass → limiter → smoothing → gain(volume) →
  // destination. Keeping routing gains outside scheduled buffers lets channel
  // order changes take effect while those buffers are already playing.
  private buildAudioGraph(context: AudioContext): void {
    const gain = context.createGain();
    gain.connect(context.destination);
    this.gainNode = gain;
    this.updateGain();

    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = SUBSONIC_HZ;
    highpass.Q.value = FILTER_Q;

    const bass = context.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = BASS_SHELF_HZ;
    bass.gain.value = BASS_SHELF_DB;

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    const smoothing = context.createBiquadFilter();
    smoothing.type = 'lowpass';
    smoothing.frequency.value = SMOOTHING_HZ;
    smoothing.Q.value = FILTER_Q;

    highpass.connect(bass);
    bass.connect(limiter);
    limiter.connect(smoothing);
    smoothing.connect(gain);
    this.masterInput = highpass;

    const splitter = context.createChannelSplitter(3);
    splitter.channelCount = 3;
    splitter.channelCountMode = 'explicit';
    splitter.channelInterpretation = 'discrete';
    const merger = context.createChannelMerger(2);
    merger.connect(highpass);
    const channelMixGains = Object.fromEntries(
      CHANNELS.map((channel, channelIndex) => {
        const left = context.createGain();
        const right = context.createGain();
        splitter.connect(left, channelIndex);
        splitter.connect(right, channelIndex);
        left.connect(merger, 0, 0);
        right.connect(merger, 0, 1);
        return [channel, [left, right] as const];
      }),
    ) as Record<ChannelId, readonly [GainNode, GainNode]>;
    this.channelInput = splitter;
    this.channelMixGains = channelMixGains;
    this.updateChannelMix();
  }

  private updateGain(): void {
    if (this.gainNode !== undefined) {
      this.gainNode.gain.value = this.volume;
    }
  }

  private updateChannelMix(): void {
    const gains = this.channelMixGains;
    if (gains === undefined) return;
    const [leftChannel, centerChannel, rightChannel] = this.channelOrder;
    const context = this.audioContext;
    const transitionEnd =
      context !== undefined && isPlayingStatus(this.status)
        ? context.currentTime + 0.008
        : undefined;
    const setGain = (parameter: AudioParam, value: number) => {
      if (context === undefined || transitionEnd === undefined) {
        parameter.value = value;
        return;
      }
      parameter.cancelScheduledValues(context.currentTime);
      parameter.setValueAtTime(parameter.value, context.currentTime);
      parameter.linearRampToValueAtTime(value, transitionEnd);
    };
    for (const channel of CHANNELS) {
      const [left, right] = gains[channel];
      setGain(
        left.gain,
        channel === leftChannel
          ? MIX_HEADROOM
          : channel === centerChannel
            ? CENTER_GAIN * MIX_HEADROOM
            : 0,
      );
      setGain(
        right.gain,
        channel === rightChannel
          ? MIX_HEADROOM
          : channel === centerChannel
            ? CENTER_GAIN * MIX_HEADROOM
            : 0,
      );
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

    // Bound the timeline when getChannelLevels is not polling (e.g. hidden tab).
    const audibleCutoff = context.currentTime - 1;
    while (this.levelTimeline.length > 1) {
      const next = this.levelTimeline[1];
      if (next === undefined || next.time > audibleCutoff) break;
      this.levelTimeline.shift();
    }
    while (this.voiceTimeline.length > 1) {
      const next = this.voiceTimeline[1];
      if (next === undefined || next.time > audibleCutoff) break;
      this.voiceTimeline.shift();
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
      const buffer = context.createBuffer(3, count, ENGINE_SAMPLE_RATE);
      const outputA = buffer.getChannelData(0);
      const outputB = buffer.getChannelData(1);
      const outputC = buffer.getChannelData(2);
      const squared = { A: 0, B: 0, C: 0 };
      let generatedOffset = 0;
      while (generatedOffset < count) {
        const absoluteSample = this.scheduledNativeSample + generatedOffset;
        const currentFrame = Math.floor(
          (absoluteSample * track.frameRateHz) / ENGINE_SAMPLE_RATE,
        );
        const nextFrameSample = Math.ceil(
          ((currentFrame + 1) * ENGINE_SAMPLE_RATE) / track.frameRateHz,
        );
        const segmentCount = Math.min(
          count - generatedOffset,
          Math.max(1, nextFrameSample - absoluteSample),
        );
        const generated = generateEngineChannels(player, segmentCount).channels;
        this.voiceTimeline.push({
          time: this.nextScheduleTime + generatedOffset / ENGINE_SAMPLE_RATE,
          voices: getEngineChannelVoices(player),
        });

        for (let sample = 0; sample < segmentCount; sample += 1) {
          const base = sample * 3;
          const outputIndex = generatedOffset + sample;
          const a = applyChipAmplitudeModel(
            generated[base] ?? 0,
            track.chipType,
          );
          const b = applyChipAmplitudeModel(
            generated[base + 1] ?? 0,
            track.chipType,
          );
          const c = applyChipAmplitudeModel(
            generated[base + 2] ?? 0,
            track.chipType,
          );
          squared.A += a * a;
          squared.B += b * b;
          squared.C += c * c;
          outputA[outputIndex] = a;
          outputB[outputIndex] = b;
          outputC[outputIndex] = c;
        }
        generatedOffset += segmentCount;
      }

      this.levelTimeline.push({
        time: this.nextScheduleTime,
        levels: {
          A: Math.sqrt(squared.A / count),
          B: Math.sqrt(squared.B / count),
          C: Math.sqrt(squared.C / count),
        },
      });
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.channelInput ?? this.masterInput ?? gain);
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
    this.levelTimeline = [];
    this.voiceTimeline = [];
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
