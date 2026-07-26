import {
  buildStudioChain,
  buildVanillaChain,
  CHANNELS,
  MIX_HEADROOM,
  mixTransitionEnd,
  type ModeChain,
  OSCILLOSCOPE_FFT_SIZE,
} from './audioGraph.ts';
import { applyChipAmplitudeModel } from './chipModel.ts';
import {
  type ChipSource,
  createEngineChipSource,
  createSynthChipSource,
} from './chipSource.ts';
import {
  type ChannelLevels,
  type ChannelOrder,
  type ChannelVoices,
  type OfflineRender,
  type OscilloscopeSamples,
  type PlaybackAdapter,
  type PlaybackAdapterListener,
  type PlaybackAdapterSnapshot,
  type PlaybackMode,
  playbackModes,
  type PlaybackStatus,
  type RuntimeTrack,
} from './contracts.ts';
import {
  createEnginePlayer,
  ENGINE_RENDER_CHUNK,
  generateEngineChannels,
  initializeYm2149,
} from './engine.ts';
import { ENGINE_SAMPLE_RATE, OFFLINE_SAMPLE_RATE } from './sampleRates.ts';

const EMPTY_LEVELS: ChannelLevels = { A: 0, B: 0, C: 0 };
const EMPTY_VOICES: ChannelVoices = { A: null, B: null, C: null };
const SCHEDULE_CHUNK_SAMPLES = 4_410;
const SCHEDULE_AHEAD_SECONDS = 0.3;
const SCHEDULER_INTERVAL_MS = 50;
const START_LATENCY_SECONDS = 0.02;
// A mode switch renders both sources for one chunk and crossfades between the
// two chains, so the listener hears a morph rather than a splice. Without the
// overlap the retiring chain's buffers simply stop, and the DC step that leaves
// in its high-pass is an audible thump.
const CROSSFADE_SAMPLES = SCHEDULE_CHUNK_SAMPLES;
const CROSSFADE_SECONDS = CROSSFADE_SAMPLES / ENGINE_SAMPLE_RATE;
const DEFAULT_MODE: PlaybackMode = 'studio';

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
  private listeners = new Set<PlaybackAdapterListener>();
  private audioContext: AudioContext | undefined;
  private gainNode: GainNode | undefined;
  // Build-time loudness match. Each chain applies it ahead of its own limiter,
  // so a track that needs lifting is caught rather than clipped.
  private normalizationGainDb = 0;
  // Chains are built on first use: a listener who stays in vanilla never pays
  // for the studio convolver, and vice versa.
  private chains: Partial<Record<PlaybackMode, ModeChain>> = {};
  private mode: PlaybackMode = DEFAULT_MODE;
  private readonly oscilloscopeSamples: OscilloscopeSamples = {
    A: new Float32Array(OSCILLOSCOPE_FFT_SIZE),
    B: new Float32Array(OSCILLOSCOPE_FFT_SIZE),
    C: new Float32Array(OSCILLOSCOPE_FFT_SIZE),
  };
  // Both renderers stay loaded so a mode switch only has to reconcile the one
  // becoming active. Each tracks its own source-sample position.
  private sources: Partial<Record<PlaybackMode, ChipSource>> = {};
  // The mode being faded out, rendered alongside the active one until its
  // source-sample deadline passes.
  private retiring:
    { readonly mode: PlaybackMode; readonly untilSample: number } | undefined;
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
  // their audible AudioContext time. Reading the renderer directly would expose
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
    this.releaseSources();
    this.track = track;
    this.durationSeconds = track.durationSeconds;
    this.positionSeconds = 0;
    this.status = 'loading';
    this.levelTimeline = [];
    this.voiceTimeline = [];
    this.normalizationGainDb = track.normalizationGainDb ?? 0;
    this.updateNormalization();
    this.publish();

    try {
      signal.throwIfAborted();
      await initializeYm2149();
      signal.throwIfAborted();
      if (generation !== this.loadGeneration || this.disposed) {
        return;
      }

      const { source, channelCount } = createEngineChipSource(track.bytes);
      if (channelCount !== 3) {
        source.free();
        throw new Error(
          `Track ${track.id} did not expose exactly A/B/C channels.`,
        );
      }
      this.sources = {
        vanilla: source,
        studio: createSynthChipSource(track),
      };
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
    const source = this.sources[this.mode];
    if (
      source === undefined ||
      this.track === undefined ||
      !['ready', 'paused', 'ended'].includes(this.status)
    ) {
      return;
    }
    if (this.status === 'ended') {
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

    // The only place a renderer is rewound. Doing it here rather than in
    // pause/stop/seek keeps those instant and collapses a pause-then-seek, or a
    // pause-then-different-track, into no reconstruction at all.
    const startSample = Math.round(this.positionSeconds * ENGINE_SAMPLE_RATE);
    if (source.sample !== startSample) {
      source.seekToSample(startSample);
    }

    source.play();
    this.retiring = undefined;
    this.status = 'playing';
    this.anchorPositionSeconds = this.positionSeconds;
    this.anchorContextTime = context.currentTime + START_LATENCY_SECONDS;
    this.nextScheduleTime = this.anchorContextTime;
    this.scheduledNativeSample = startSample;
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
    this.pauseSources();
    this.positionSeconds = position;
    this.status = 'paused';
    this.levelTimeline = [];
    this.voiceTimeline = [];
    this.publish();
  }

  stop(): void {
    if (this.sources[this.mode] === undefined) {
      return;
    }
    this.stopScheduling();
    this.pauseSources();
    this.positionSeconds = 0;
    this.status = 'ready';
    this.levelTimeline = [];
    this.voiceTimeline = [];
    this.publish();
  }

  async seek(positionSeconds: number): Promise<void> {
    this.assertNotDisposed();
    if (this.sources[this.mode] === undefined || this.track === undefined) {
      return;
    }
    const wasPlaying = isPlayingStatus(this.status);
    const position = clamp(positionSeconds, 0, this.durationSeconds);
    this.stopScheduling();
    this.pauseSources();
    this.positionSeconds = position;
    this.levelTimeline = [];
    this.voiceTimeline = [];

    if (position >= this.durationSeconds) {
      this.status = 'ended';
    } else if (wasPlaying) {
      this.status = 'paused';
      await this.play();
      return;
    } else if (this.status !== 'paused') {
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

  /**
   * Switches renderer and processing chain together. While playing, the retiring
   * mode keeps rendering for one chunk so the two chains crossfade; the audio
   * already queued always finishes on the chain that produced it.
   */
  setMode(mode: PlaybackMode): void {
    if (this.mode === mode) return;
    const previous = this.mode;
    this.mode = mode;

    const context = this.audioContext;
    if (context === undefined || this.gainNode === undefined) {
      // No graph yet: `play` builds the right chain and reconciles the source.
      return;
    }
    const incoming = this.ensureChain(mode);
    const outgoing = this.chains[previous];

    if (!isPlayingStatus(this.status)) {
      incoming.input.gain.value = 1;
      if (outgoing !== undefined) outgoing.input.gain.value = 0;
      this.retiring = undefined;
      return;
    }

    const source = this.sources[mode];
    const at = Math.max(context.currentTime, this.nextScheduleTime);
    const end = at + CROSSFADE_SECONDS;
    const ramp = (parameter: AudioParam, target: number) => {
      parameter.cancelScheduledValues(context.currentTime);
      parameter.setValueAtTime(parameter.value, at);
      parameter.linearRampToValueAtTime(target, end);
    };
    ramp(incoming.input.gain, 1);
    if (outgoing !== undefined) ramp(outgoing.input.gain, 0);

    if (source !== undefined) {
      if (source.sample !== this.scheduledNativeSample) {
        source.seekToSample(this.scheduledNativeSample);
      }
      source.play();
    }
    this.retiring = {
      mode: previous,
      untilSample: this.scheduledNativeSample + CROSSFADE_SAMPLES,
    };
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
    const current = this.levelTimeline[0];
    // A chunk queued ahead of the playhead is not audible yet, so report rest
    // until it is — the same gate `getChannelVoices` applies.
    if (current === undefined || current.time > now) {
      return EMPTY_LEVELS;
    }
    // Includes the loudness match, so the needles do not disagree with what is
    // heard by up to three decibels from one track to the next.
    const scale = this.volume * this.normalizationLinear();
    return {
      A: current.levels.A * scale,
      B: current.levels.B * scale,
      C: current.levels.C * scale,
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

  getOscilloscopeSamples(): OscilloscopeSamples {
    const analysers = this.chains[this.mode]?.analysers;
    if (analysers !== undefined) {
      for (const channel of CHANNELS) {
        analysers[channel].getFloatTimeDomainData(
          this.oscilloscopeSamples[channel],
        );
      }
    }
    return this.oscilloscopeSamples;
  }

  /**
   * The dry engine render that feeds the committed waveform peaks. Deliberately
   * unaffected by playback mode: the waveform lanes describe the track, not the
   * current presentation of it.
   */
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
    let generated: Float32Array = new Float32Array(0);
    let previous: readonly [number, number, number] | undefined;

    // Declared once for the whole render rather than per output sample; a
    // three-minute track interpolates over eight million of them.
    const read = (absoluteSample: number, channel: number): number => {
      if (absoluteSample === sourceStart - 1 && previous !== undefined) {
        return previous[channel] ?? 0;
      }
      return generated[(absoluteSample - sourceStart) * 3 + channel] ?? 0;
    };
    const interpolate = (
      channel: number,
      low: number,
      high: number,
      fraction: number,
    ): number => {
      const lowValue = read(low, channel);
      return lowValue + (read(high, channel) - lowValue) * fraction;
    };

    try {
      while (sourceStart < nativeLength + 1) {
        signal.throwIfAborted();
        const count = Math.min(
          ENGINE_RENDER_CHUNK,
          nativeLength + 1 - sourceStart,
        );
        generated = generateEngineChannels(player, count).channels;
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
          const a = applyChipAmplitudeModel(
            interpolate(0, low, high, fraction),
            track.chipType,
          );
          const b = applyChipAmplitudeModel(
            interpolate(1, low, high, fraction),
            track.chipType,
          );
          const c = applyChipAmplitudeModel(
            interpolate(2, low, high, fraction),
            track.chipType,
          );
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
    this.releaseSources();
    this.listeners.clear();
    const context = this.audioContext;
    this.audioContext = undefined;
    this.gainNode = undefined;
    this.chains = {};
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
      this.audioContext ?? new AudioContext({ sampleRate: ENGINE_SAMPLE_RATE });
    this.audioContext = context;
    if (this.gainNode === undefined) {
      this.buildAudioGraph(context);
    }
    return context;
  }

  /**
   * Builds the volume node the chains share, then the chain for the active mode.
   * Keeping the routing gains outside the scheduled buffers lets channel order
   * and mode changes take effect while those buffers are already playing.
   */
  private buildAudioGraph(context: AudioContext): void {
    const gain = context.createGain();
    gain.connect(context.destination);
    this.gainNode = gain;
    this.updateGain();
    this.ensureChain(this.mode).input.gain.value = 1;
  }

  private ensureChain(mode: PlaybackMode): ModeChain {
    const existing = this.chains[mode];
    if (existing !== undefined) return existing;
    const context = this.audioContext;
    const gain = this.gainNode;
    if (context === undefined || gain === undefined) {
      throw new Error('The audio graph has not been built yet.');
    }
    const chain =
      mode === 'vanilla'
        ? buildVanillaChain(context, gain)
        : buildStudioChain(context, gain);
    // A chain built while another is active must start silent, or its first
    // buffer arrives at full level partway through a crossfade.
    chain.input.gain.value = 0;
    chain.setChannelOrder(this.channelOrder, undefined);
    chain.setNormalization(this.normalizationLinear());
    this.chains[mode] = chain;
    return chain;
  }

  private updateGain(): void {
    if (this.gainNode !== undefined) {
      this.gainNode.gain.value = this.volume;
    }
  }

  private normalizationLinear(): number {
    return 10 ** (this.normalizationGainDb / 20);
  }

  private updateNormalization(): void {
    const gain = this.normalizationLinear();
    for (const mode of playbackModes) {
      this.chains[mode]?.setNormalization(gain);
    }
  }

  private updateChannelMix(): void {
    const context = this.audioContext;
    const transitionEnd =
      context === undefined
        ? undefined
        : mixTransitionEnd(context, isPlayingStatus(this.status));
    for (const mode of playbackModes) {
      this.chains[mode]?.setChannelOrder(this.channelOrder, transitionEnd);
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
    const chain = this.chains[this.mode];
    const source = this.sources[this.mode];
    const track = this.track;
    if (
      context === undefined ||
      chain === undefined ||
      source === undefined ||
      track === undefined ||
      !isPlayingStatus(this.status)
    ) {
      return;
    }

    if (this.livePosition() >= this.durationSeconds) {
      this.finishAtEnd();
      return;
    }

    // Bound the timelines when getChannelLevels is not polling (e.g. hidden tab).
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

    // The studio renderer indexes the DAC tables directly, so only the engine's
    // output needs a chip level recovered from it. Resolved once per tick rather
    // than per sample.
    const recoverChipLevel = this.mode === 'vanilla';
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
        const generated = source.render(segmentCount);
        this.voiceTimeline.push({
          time: this.nextScheduleTime + generatedOffset / ENGINE_SAMPLE_RATE,
          voices: source.getVoices(),
        });

        for (let sample = 0; sample < segmentCount; sample += 1) {
          const base = sample * 3;
          const outputIndex = generatedOffset + sample;
          let a = generated[base] ?? 0;
          let b = generated[base + 1] ?? 0;
          let c = generated[base + 2] ?? 0;
          if (recoverChipLevel) {
            a = applyChipAmplitudeModel(a, track.chipType);
            b = applyChipAmplitudeModel(b, track.chipType);
            c = applyChipAmplitudeModel(c, track.chipType);
          }
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
      this.startBuffer(context, buffer, chain);
      this.scheduleRetiringChunk(context, count);
      this.scheduledNativeSample += count;
      this.nextScheduleTime += count / ENGINE_SAMPLE_RATE;
    }
  }

  /** Keeps the outgoing mode audible across the crossfade window. */
  private scheduleRetiringChunk(context: AudioContext, count: number): void {
    const retiring = this.retiring;
    if (retiring === undefined) return;
    if (this.scheduledNativeSample >= retiring.untilSample) {
      this.retiring = undefined;
      return;
    }
    const chain = this.chains[retiring.mode];
    const source = this.sources[retiring.mode];
    const track = this.track;
    if (chain === undefined || source === undefined || track === undefined) {
      this.retiring = undefined;
      return;
    }

    const generated = source.render(count);
    const buffer = context.createBuffer(3, count, ENGINE_SAMPLE_RATE);
    const outputA = buffer.getChannelData(0);
    const outputB = buffer.getChannelData(1);
    const outputC = buffer.getChannelData(2);
    const recoverChipLevel = retiring.mode === 'vanilla';
    for (let sample = 0; sample < count; sample += 1) {
      const base = sample * 3;
      let a = generated[base] ?? 0;
      let b = generated[base + 1] ?? 0;
      let c = generated[base + 2] ?? 0;
      if (recoverChipLevel) {
        a = applyChipAmplitudeModel(a, track.chipType);
        b = applyChipAmplitudeModel(b, track.chipType);
        c = applyChipAmplitudeModel(c, track.chipType);
      }
      outputA[sample] = a;
      outputB[sample] = b;
      outputC[sample] = c;
    }
    this.startBuffer(context, buffer, chain);
  }

  private startBuffer(
    context: AudioContext,
    buffer: AudioBuffer,
    chain: ModeChain,
  ): void {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(chain.input);
    source.addEventListener(
      'ended',
      () => {
        this.scheduledSources.delete(source);
      },
      { once: true },
    );
    source.start(this.nextScheduleTime);
    this.scheduledSources.add(source);
  }

  private finishAtEnd(): void {
    this.stopScheduling(false);
    this.pauseSources();
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
    this.retiring = undefined;
  }

  private pauseSources(): void {
    for (const mode of playbackModes) {
      this.sources[mode]?.pause();
    }
  }

  private releaseSources(): void {
    for (const mode of playbackModes) {
      this.sources[mode]?.free();
    }
    this.sources = {};
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
