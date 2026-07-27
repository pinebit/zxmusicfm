import workletUrl from './worklet/chipProcessor.ts?worker&url';
import wasmUrl from '../../vendor/ym2149/ym2149_wasm_bg.wasm?url';
import {
  buildOutputRouting,
  rampGain,
  type OutputRouting,
} from './audioGraph.ts';
import type {
  ChannelId,
  ChannelLevels,
  ChannelOrder,
  ChannelVoice,
  ChannelVoices,
  PlaybackAdapter,
  PlaybackAdapterListener,
  PlaybackAdapterSnapshot,
  PlaybackStatus,
  RuntimeTrack,
} from './contracts.ts';
import type {
  WorkletCommand,
  WorkletFrameSnapshot,
  WorkletReply,
} from './workletMessages.ts';

const AUDIO_WORKLET_URL = import.meta.env.DEV
  ? '/@zxmusicfm/chipProcessor.js'
  : workletUrl;
const CHANNEL_IDS: readonly ChannelId[] = ['A', 'B', 'C'];
const CHANNEL_COUNT = CHANNEL_IDS.length;
const VOLUME_TRANSITION_SECONDS = 0.02;
const SNAPSHOT_RETENTION_SECONDS = 1;
/**
 * Floor for turning a channel's measured level into the 0..1 amplitude the piano
 * visualiser shades keys with. An envelope level is generator state that no
 * register exposes, so an envelope-driven channel has to be read from its
 * rendered level, which sits on the DAC curve rather than the register index.
 * The AY DAC steps about 3.2 dB per index, so a 48 dB floor puts that reading
 * within about 0.1 of the register-linear scale used for volume-driven channels
 * (index 4 gives 0.38 against 0.27, index 8 gives 0.63 against 0.53, index 12
 * gives 0.87 against 0.80). Both paths therefore read as the same brightness.
 */
const AMPLITUDE_FLOOR_DB = 48;

type PendingLoad = {
  readonly generation: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): DOMException {
  return new DOMException('Playback load was aborted.', 'AbortError');
}

function frequencyToMidiNote(frequencyHz: number): number | null {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return null;
  return 69 + 12 * Math.log2(frequencyHz / 440);
}

function amplitudeFromLevel(level: number): number {
  if (!(level > 0)) return 0;
  const decibels = 20 * Math.log10(Math.min(1, level));
  return clamp((decibels + AMPLITUDE_FLOOR_DB) / AMPLITUDE_FLOOR_DB, 0, 1);
}

export class Ym2149PlaybackAdapter implements PlaybackAdapter {
  private readonly context: AudioContext;
  private readonly listeners = new Set<PlaybackAdapterListener>();
  private readonly volumeGain: GainNode;
  private node: AudioWorkletNode | undefined;
  private routing: OutputRouting | undefined;
  private initialization: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private pendingLoad: PendingLoad | undefined;
  private generation = 0;
  private status: PlaybackStatus = 'idle';
  private durationSeconds = 0;
  private frameRateHz = 50;
  private frameCount = 0;
  private chipClockHz = 1_773_400;
  private volume = 1;
  private normalizationGain = 1;
  // The listener's stereo order, held here because the routing nodes do not
  // exist until the worklet is built. `setChannelOrder` is called once while the
  // adapter is still bare, so applying it only to `routing` would drop it.
  private channelOrder: ChannelOrder = 'ABC';
  private positionSeconds = 0;
  private snapshots: WorkletFrameSnapshot[] = [];
  private audibleSnapshot: WorkletFrameSnapshot | undefined;
  private disposed = false;

  constructor(context: AudioContext) {
    this.context = context;
    this.volumeGain = context.createGain();
    this.volumeGain.connect(context.destination);
  }

  private snapshot(): PlaybackAdapterSnapshot {
    return {
      status: this.status,
      positionSeconds: this.currentPositionSeconds(),
      durationSeconds: this.durationSeconds,
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private setStatus(status: PlaybackStatus): void {
    this.status = status;
    this.publish();
  }

  private post(command: WorkletCommand, transfer: Transferable[] = []): void {
    if (this.node === undefined) {
      throw new Error('The audio worklet is not initialized.');
    }
    this.node.port.postMessage(command, transfer);
  }

  private async ensureWorklet(): Promise<void> {
    if (this.initialization !== undefined) {
      return await this.initialization;
    }

    this.initialization = (async () => {
      await this.context.audioWorklet.addModule(AUDIO_WORKLET_URL);
      if (this.disposed) {
        throw new Error('Playback was disposed during initialization.');
      }

      const node = new AudioWorkletNode(this.context, 'ym2149-chip', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [CHANNEL_COUNT],
        channelCount: CHANNEL_COUNT,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
      node.port.onmessage = (event: MessageEvent<WorkletReply>) => {
        this.handleReply(event.data);
      };
      node.onprocessorerror = () => {
        this.fail(new Error('The chip audio processor stopped unexpectedly.'));
      };
      this.node = node;
      this.routing = buildOutputRouting(this.context, this.volumeGain);
      this.routing.setChannelOrder(this.channelOrder);
      this.routing.setNormalization(this.normalizationGain);
      node.connect(this.routing.input);

      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(
          `Could not load the playback engine (${response.status}).`,
        );
      }
      const wasmBytes = await response.arrayBuffer();

      // The engine crosses as transferred bytes and is compiled inside the
      // worklet. A compiled `WebAssembly.Module` would keep the compile off the
      // audio thread, but Chromium accepts that `postMessage` without throwing
      // and then never delivers it, and `structuredClone` of the same module
      // succeeds — so no feature probe can tell the difference, and the only
      // alternative is racing the reply against a timer. Bytes are deterministic
      // on every engine. The compile happens once, during setup, while the graph
      // is still silent, so the render quantum it stalls would have produced
      // silence anyway.
      await new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        this.post({ type: 'init', wasm: wasmBytes }, [wasmBytes]);
      });
    })().catch((error: unknown) => {
      const normalized = new Error(errorMessage(error));
      this.fail(normalized);
      throw normalized;
    });

    return await this.initialization;
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.pendingLoad?.reject(error);
    this.pendingLoad = undefined;
    if (!this.disposed) this.setStatus('error');
  }

  private handleReply(reply: WorkletReply): void {
    if (reply.type === 'ready') {
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (reply.type === 'error') {
      if (
        reply.generation === undefined ||
        reply.generation === this.generation
      ) {
        this.fail(new Error(reply.message));
      }
      return;
    }
    if (reply.generation !== this.generation) return;

    switch (reply.type) {
      case 'loaded':
        this.frameCount = reply.frameCount;
        this.durationSeconds = reply.frameCount / this.frameRateHz;
        this.positionSeconds = 0;
        this.snapshots = [];
        this.audibleSnapshot = undefined;
        this.pendingLoad?.resolve();
        this.pendingLoad = undefined;
        this.setStatus('ready');
        break;
      case 'frame':
        this.snapshots.push(reply);
        this.pruneSnapshots();
        break;
      case 'ended':
        this.positionSeconds = this.durationSeconds;
        this.setStatus('ended');
        break;
    }
  }

  private pruneSnapshots(): void {
    const cutoff = this.context.currentTime - SNAPSHOT_RETENTION_SECONDS;
    while (this.snapshots.length > 1) {
      const next = this.snapshots[1];
      if (next === undefined || next.audioTime > cutoff) break;
      this.snapshots.shift();
    }
  }

  private updateAudibleSnapshot(): WorkletFrameSnapshot | undefined {
    while (this.snapshots.length > 0) {
      const next = this.snapshots[0];
      if (next === undefined || next.audioTime > this.context.currentTime) {
        break;
      }
      this.audibleSnapshot = this.snapshots.shift();
    }
    return this.audibleSnapshot;
  }

  async load(track: RuntimeTrack, signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Playback has been disposed.');
    if (signal.aborted) throw abortError();

    const generation = ++this.generation;
    this.pendingLoad?.reject(abortError());
    this.pendingLoad = undefined;
    this.durationSeconds = track.durationSeconds;
    this.frameRateHz = track.frameRateHz;
    this.chipClockHz = track.chipClockHz;
    this.normalizationGain = Math.pow(
      10,
      (track.normalizationGainDb ?? 0) / 20,
    );
    this.setStatus('loading');

    await this.ensureWorklet();
    signal.throwIfAborted();
    if (!this.isCurrentGeneration(generation)) {
      throw abortError();
    }

    // Only the loudness match is per track. `channelLayout` is curator metadata
    // describing the source tracker's convention; the audible order belongs to
    // the listener's cycler, so a track change must not overwrite it.
    this.routing?.setNormalization(this.normalizationGain);

    const bytes = track.bytes.slice();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pendingLoad?.generation === generation) {
          this.pendingLoad = undefined;
        }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingLoad = {
        generation,
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.post(
        {
          type: 'load',
          generation,
          bytes,
          chipType: track.chipType,
          frameRateHz: track.frameRateHz,
        },
        [bytes.buffer],
      );
    });
  }

  async play(): Promise<void> {
    if (
      this.status === 'idle' ||
      this.status === 'loading' ||
      this.status === 'error'
    ) {
      return;
    }
    if (this.status === 'ended') await this.seek(0);
    await this.context.resume();
    this.post({ type: 'play', generation: this.generation });
    this.setStatus('playing');
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.positionSeconds = this.currentPositionSeconds();
    this.snapshots = [];
    this.audibleSnapshot = undefined;
    this.post({ type: 'pause', generation: this.generation });
    this.setStatus('paused');
  }

  stop(): void {
    if (this.status === 'idle' || this.status === 'loading') return;
    this.positionSeconds = 0;
    this.snapshots = [];
    this.audibleSnapshot = undefined;
    this.post({ type: 'stop', generation: this.generation });
    this.setStatus('ready');
  }

  seek(positionSeconds: number): Promise<void> {
    if (this.status === 'idle' || this.status === 'loading') {
      return Promise.resolve();
    }
    const position = clamp(positionSeconds, 0, this.durationSeconds);
    const frame = clamp(
      Math.floor(position * this.frameRateHz),
      0,
      this.frameCount,
    );
    this.positionSeconds = frame / this.frameRateHz;
    this.snapshots = [];
    this.audibleSnapshot = undefined;
    this.post({
      type: 'seek',
      generation: this.generation,
      frame,
    });
    if (position >= this.durationSeconds) {
      this.setStatus('ended');
    } else {
      this.publish();
    }
    return Promise.resolve();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    rampGain(
      this.volumeGain.gain,
      this.volume,
      this.context,
      this.context.currentTime + VOLUME_TRANSITION_SECONDS,
    );
  }

  setChannelOrder(channelOrder: ChannelOrder): void {
    this.channelOrder = channelOrder;
    this.routing?.setChannelOrder(channelOrder);
  }

  private currentPositionSeconds(): number {
    const audible = this.updateAudibleSnapshot();
    if (audible === undefined) return this.positionSeconds;
    const elapsed =
      this.status === 'playing'
        ? Math.max(0, this.context.currentTime - audible.audioTime)
        : 0;
    return clamp(
      audible.frame / this.frameRateHz + elapsed,
      0,
      this.durationSeconds,
    );
  }

  getSnapshot(): PlaybackAdapterSnapshot {
    return this.snapshot();
  }

  getChannelLevels(): ChannelLevels {
    const audible = this.updateAudibleSnapshot();
    const scale = this.volume * this.normalizationGain;
    return {
      A: (audible?.rms[0] ?? 0) * scale,
      B: (audible?.rms[1] ?? 0) * scale,
      C: (audible?.rms[2] ?? 0) * scale,
    };
  }

  getChannelVoices(): ChannelVoices {
    const audible = this.updateAudibleSnapshot();
    if (audible === undefined) return { A: null, B: null, C: null };

    const registers = audible.registers;
    const voices: Partial<Record<ChannelId, ChannelVoice | null>> = {};
    const register = (index: number): number => registers[index] ?? 0;
    for (const [channel, channelId] of CHANNEL_IDS.entries()) {
      const period =
        register(channel * 2) | ((register(channel * 2 + 1) & 0x0f) << 8);
      const toneEnabled = (register(7) & (1 << channel)) === 0;
      // R7 bits 3-5 gate noise, active low. A channel mixing noise has no
      // musical pitch to show: its tone period is often a leftover value, and
      // the percussion it produces would otherwise light an arbitrary key.
      const noiseEnabled = (register(7) & (1 << (channel + 3))) === 0;
      const amplitudeRegister = register(8 + channel);
      const amplitude =
        (amplitudeRegister & 0x10) !== 0
          ? amplitudeFromLevel(audible.rms[channel] ?? 0)
          : (amplitudeRegister & 0x0f) / 15;
      const frequencyHz =
        toneEnabled && !noiseEnabled && period > 0
          ? this.chipClockHz / (16 * period)
          : 0;
      const midiNote = frequencyToMidiNote(frequencyHz);
      voices[channelId] =
        midiNote === null || amplitude <= 0 ? null : { midiNote, amplitude };
    }
    return voices as ChannelVoices;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation;
  }

  subscribe(listener: PlaybackAdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pendingLoad?.reject(abortError());
    this.pendingLoad = undefined;
    this.node?.disconnect();
    this.node?.port.close();
    this.routing?.dispose();
    this.volumeGain.disconnect();
    if (this.context.state !== 'closed') void this.context.close();
    this.listeners.clear();
  }
}
