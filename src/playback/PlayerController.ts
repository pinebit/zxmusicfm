import type { GeneratedCatalog } from '../content/schemas.ts';
import { fetchVerifiedBytes } from '../content/runtime.ts';
import { requestPlaybackAudioPermission } from './audioPermission.ts';
import type {
  ChannelOrder,
  PlaybackAdapter,
  PlaybackAdapterSnapshot,
  RuntimeTrack,
} from './contracts.ts';
import {
  loadPlayerPreferences,
  savePlayerPreferences,
  type PlayerPreferences,
} from './persistence.ts';

type CatalogTrack = GeneratedCatalog['tracks'][number];

export type PlayerError = {
  readonly category: 'track' | 'audio-permission';
  readonly operation: 'load' | 'play' | 'seek';
  readonly recoverable: true;
};

export type PlayerControllerSnapshot = {
  readonly status:
    'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
  readonly selectedTrackId: string | null;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly preferences: PlayerPreferences;
  readonly error: PlayerError | null;
};

type ControllerListener = () => void;
type AudioPermission = ReturnType<typeof requestPlaybackAudioPermission>;
type ControllerDependencies = {
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly random?: () => number;
  readonly fetchTrack?: typeof fetchVerifiedBytes;
  readonly requestPermission?: () => AudioPermission;
  readonly createAdapter?: (context: AudioContext) => Promise<PlaybackAdapter>;
};

const POSITION_UPDATE_MS = 250;
const CHECKPOINT_MS = 5_000;
// Continuous controls (the volume knob) publish on every pointer move, so their
// preference write is coalesced instead of hitting storage per event.
const PREFERENCE_SAVE_DELAY_MS = 400;
// `previous` only ever walks back a handful of entries; the cap stops an
// unattended session from accumulating one string per auto-advanced track.
const MAX_HISTORY_ENTRIES = 50;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isAudioPermissionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    ['NotAllowedError', 'InvalidStateError'].includes(error.name)
  );
}

function shuffled(values: readonly string[], random: () => number): string[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = result[index];
    const other = result[swap];
    if (current !== undefined && other !== undefined) {
      result[index] = other;
      result[swap] = current;
    }
  }
  return result;
}

export class PlayerController {
  private readonly catalog: GeneratedCatalog;
  private snapshot: PlayerControllerSnapshot;
  private readonly listeners = new Set<ControllerListener>();
  private readonly tracksById: ReadonlyMap<string, CatalogTrack>;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  private readonly random: () => number;
  private readonly fetchTrack: typeof fetchVerifiedBytes;
  private readonly requestPermission: () => AudioPermission;
  private readonly createAdapter: (
    context: AudioContext,
  ) => Promise<PlaybackAdapter>;
  private adapter: PlaybackAdapter | undefined;
  private adapterPromise: Promise<PlaybackAdapter> | undefined;
  private adapterUnsubscribe: (() => void) | undefined;
  // One permitted context for the whole controller. Rapid selections must not
  // each mint their own, and whichever owner ends up holding it closes it.
  private permission: AudioPermission | undefined;
  private loadedTrackId: string | undefined;
  private activeLoad: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private ticker: number | undefined;
  private preferenceSaveTimer: number | undefined;
  private lastCheckpointAt = 0;
  private shuffleQueue: string[] = [];
  private history: string[] = [];

  constructor(
    catalog: GeneratedCatalog,
    dependencies: ControllerDependencies = {},
  ) {
    this.catalog = catalog;
    this.tracksById = new Map(catalog.tracks.map((track) => [track.id, track]));
    this.storage = dependencies.storage ?? localStorage;
    this.random = dependencies.random ?? Math.random;
    this.fetchTrack = dependencies.fetchTrack ?? fetchVerifiedBytes;
    this.requestPermission =
      dependencies.requestPermission ?? requestPlaybackAudioPermission;
    this.createAdapter =
      dependencies.createAdapter ??
      (async (context) => {
        const { Ym2149PlaybackAdapter } =
          await import('./Ym2149PlaybackAdapter.ts');
        return new Ym2149PlaybackAdapter(context);
      });

    const preferences = loadPlayerPreferences(this.storage, catalog.tracks);
    const track =
      preferences.selectedTrackId === null
        ? undefined
        : this.tracksById.get(preferences.selectedTrackId);
    this.snapshot = {
      status: track === undefined ? 'idle' : 'ready',
      selectedTrackId: track?.id ?? null,
      positionSeconds: preferences.positionSeconds,
      durationSeconds: track?.durationSeconds ?? 0,
      preferences,
      error: null,
    };
  }

  /**
   * Start the position ticker and Media Session handlers, returning a disposer.
   * Kept out of the constructor so a controller built during render (e.g. in a
   * discarded `useMemo` result) never leaks a timer or global handlers.
   *
   * Re-entrant on purpose: React remounts an effect without rebuilding a
   * `useMemo` value, so a disposed controller has to come back to life rather
   * than sit permanently inert with a live ticker.
   */
  activate = (): (() => void) => {
    this.disposed = false;
    this.installMediaSession();
    this.startTicker();
    return () => this.dispose();
  };

  getSnapshot = (): PlayerControllerSnapshot => this.snapshot;

  subscribe = (listener: ControllerListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAdapter(): PlaybackAdapter | undefined {
    return this.adapter;
  }

  toggle(trackId: string): void {
    if (
      this.snapshot.selectedTrackId === trackId &&
      this.snapshot.status === 'playing'
    ) {
      this.pause();
      return;
    }
    this.play(trackId);
  }

  playSelected(): void {
    const trackId =
      this.snapshot.selectedTrackId ?? this.catalog.tracks[0]?.id ?? null;
    if (trackId !== null) this.play(trackId);
  }

  play(trackId: string, requestedPosition?: number): void {
    void this.selectAndPlay(
      trackId,
      requestedPosition,
      this.acquirePermission(),
      true,
    );
  }

  pause(): void {
    if (this.snapshot.status !== 'playing' || this.adapter === undefined)
      return;
    this.adapter.pause();
    const current = this.adapter.getSnapshot();
    this.update({
      status: 'paused',
      positionSeconds: current.positionSeconds,
      error: null,
    });
    this.persistPosition(current.positionSeconds);
  }

  seek(trackId: string, positionSeconds: number): void {
    const track = this.tracksById.get(trackId);
    if (track === undefined) return;
    const position = clamp(positionSeconds, 0, track.durationSeconds);
    if (this.snapshot.selectedTrackId !== trackId) {
      this.play(trackId, position);
      return;
    }
    if (this.adapter === undefined || this.loadedTrackId !== trackId) {
      this.update({
        status: position >= track.durationSeconds ? 'ended' : 'ready',
        positionSeconds: position,
        error: null,
      });
      this.persistPosition(position);
      return;
    }
    const generation = this.generation;
    void this.adapter.seek(position).then(
      () => {
        if (!this.isCurrent(generation)) return;
        const current = this.adapter?.getSnapshot();
        if (current !== undefined) {
          this.update({
            status: current.status,
            positionSeconds: current.positionSeconds,
            error: null,
          });
          this.persistPosition(current.positionSeconds);
        }
      },
      (error: unknown) => this.fail(error, 'seek', track, position, generation),
    );
  }

  retry(): void {
    const trackId = this.snapshot.selectedTrackId;
    if (trackId !== null) this.play(trackId, this.snapshot.positionSeconds);
  }

  enableAudio(): void {
    this.retry();
  }

  next(): void {
    const nextTrackId = this.takeNextTrack();
    if (nextTrackId !== undefined) {
      this.selectFromSequence(nextTrackId);
    }
  }

  previous(): void {
    const previousTrackId = this.history.pop() ?? this.snapshot.selectedTrackId;
    if (previousTrackId !== null) {
      void this.selectAndPlay(
        previousTrackId,
        0,
        this.acquirePermission(),
        false,
      );
    }
  }

  setShuffle(enabled: boolean): void {
    this.shuffleQueue = [];
    this.setPreferences({ ...this.snapshot.preferences, shuffle: enabled });
  }

  /**
   * `scrubbing` marks a value from a continuous gesture. The gain change always
   * applies immediately; only the storage write is coalesced, and only while
   * scrubbing, so a discrete change survives an immediate reload.
   */
  setVolume(volume: number, scrubbing = false): void {
    const nextVolume = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
    this.adapter?.setVolume(nextVolume);
    this.setPreferences(
      { ...this.snapshot.preferences, volume: nextVolume },
      scrubbing,
    );
  }

  setChannelOrder(channelOrder: ChannelOrder): void {
    this.adapter?.setChannelOrder(channelOrder);
    this.setPreferences({
      ...this.snapshot.preferences,
      channelOrder,
    });
  }

  persistNow(): void {
    const position =
      this.adapter?.getSnapshot().positionSeconds ??
      this.snapshot.positionSeconds;
    this.persistPosition(position, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.activeLoad?.abort();
    this.activeLoad = undefined;
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.ticker = undefined;
    this.flushPreferenceSave();
    this.releaseAudio();
    this.clearMediaSession();
    this.listeners.clear();
  }

  /** Must run synchronously inside the gesture that permits audio. */
  private acquirePermission(): AudioPermission | undefined {
    if (this.adapter !== undefined) return undefined;
    this.permission ??= this.requestPermission();
    return this.permission;
  }

  /**
   * Tear down the audio side, leaving exactly one owner responsible for closing
   * the permitted context: the adapter once it has adopted it, this controller
   * until then.
   */
  private releaseAudio(): void {
    const adapter = this.adapter;
    const permission = this.permission;
    this.adapterUnsubscribe?.();
    this.adapterUnsubscribe = undefined;
    this.adapter = undefined;
    this.adapterPromise = undefined;
    this.permission = undefined;
    this.loadedTrackId = undefined;
    if (adapter !== undefined) {
      adapter.dispose();
      return;
    }
    if (permission !== undefined && permission.context.state !== 'closed') {
      void permission.context.close();
    }
  }

  private async selectAndPlay(
    trackId: string,
    requestedPosition: number | undefined,
    permission: AudioPermission | undefined,
    recordHistory: boolean,
  ): Promise<void> {
    const track = this.tracksById.get(trackId);
    if (track === undefined || this.disposed) return;
    const changedTrack = this.snapshot.selectedTrackId !== trackId;
    if (
      changedTrack &&
      recordHistory &&
      this.snapshot.selectedTrackId !== null
    ) {
      this.pushHistory(this.snapshot.selectedTrackId);
    }
    if (changedTrack && this.snapshot.preferences.shuffle) {
      this.shuffleQueue = this.shuffleQueue.filter((id) => id !== trackId);
    }
    if (changedTrack) this.adapter?.stop();

    const requested = clamp(
      requestedPosition ??
        (changedTrack
          ? 0
          : this.snapshot.status === 'ended'
            ? 0
            : this.snapshot.positionSeconds),
      0,
      track.durationSeconds,
    );
    const generation = this.beginLoad(track, requested);
    try {
      if (permission !== undefined) await permission.ready;
      // The permitted context is shared, so a superseded selection leaves it
      // open for the newer one; `releaseAudio` is the only thing that closes it.
      if (!this.isCurrent(generation)) return;
      const adapter = await this.ensureAdapter(permission);
      if (!this.isCurrent(generation)) return;

      let loadedFromScratch = false;
      if (changedTrack || this.loadedTrackId !== track.id) {
        const load = this.activeLoad;
        if (load === undefined) return;
        const bytes = await this.fetchTrack(
          track.runtimeUrl,
          track.runtimeByteLength,
          track.runtimeSha256,
          load.signal,
          `${track.title} runtime`,
        );
        if (!this.isCurrent(generation)) return;
        const runtime: RuntimeTrack = {
          id: track.id,
          bytes,
          durationSeconds: track.durationSeconds,
          chipType: track.chipType,
          chipClockHz: track.chipClockHz,
          frameRateHz: track.frameRateHz,
          channelLayout: track.channelLayout,
        };
        await adapter.load(runtime, load.signal);
        if (!this.isCurrent(generation)) return;
        this.loadedTrackId = track.id;
        loadedFromScratch = true;
      }

      // A freshly loaded engine already sits at zero, so seeking there would
      // rebuild it for nothing.
      const target = requested >= track.durationSeconds ? 0 : requested;
      if (!loadedFromScratch || target !== 0) {
        await adapter.seek(target);
        if (!this.isCurrent(generation)) return;
      }
      this.update({ status: 'ready', positionSeconds: requested, error: null });
      await adapter.play();
      if (!this.isCurrent(generation)) return;
      this.update({ status: 'playing', error: null });
      this.lastCheckpointAt = Date.now();
      this.updateMediaMetadata(track);
    } catch (error) {
      if (isAudioPermissionError(error)) {
        this.releaseAudio();
      }
      this.fail(error, 'play', track, requested, generation);
    }
  }

  private beginLoad(track: CatalogTrack, position: number): number {
    this.generation += 1;
    this.activeLoad?.abort();
    this.activeLoad = new AbortController();
    const preferences = {
      ...this.snapshot.preferences,
      selectedTrackId: track.id,
      positionSeconds: position,
    };
    this.snapshot = {
      status: 'loading',
      selectedTrackId: track.id,
      positionSeconds: position,
      durationSeconds: track.durationSeconds,
      preferences,
      error: null,
    };
    this.savePreferences();
    this.publish();
    return this.generation;
  }

  private async ensureAdapter(
    permission: AudioPermission | undefined,
  ): Promise<PlaybackAdapter> {
    if (this.adapter !== undefined) return this.adapter;
    if (permission === undefined) {
      throw new DOMException(
        'Audio permission is required.',
        'NotAllowedError',
      );
    }
    // `createAdapter` dynamically imports the engine module, so two rapid
    // selections both arrive here before the first resolves. Sharing the
    // in-flight promise keeps one AudioContext and one engine instance rather
    // than orphaning whichever adapter loses the assignment race.
    this.adapterPromise ??= this.createSoleAdapter(permission);
    return await this.adapterPromise;
  }

  private async createSoleAdapter(
    permission: AudioPermission,
  ): Promise<PlaybackAdapter> {
    try {
      const adapter = await this.createAdapter(permission.context);
      if (this.disposed) {
        adapter.dispose();
        throw new Error('Player controller has been disposed.');
      }
      adapter.setVolume(this.snapshot.preferences.volume);
      adapter.setChannelOrder(this.snapshot.preferences.channelOrder);
      this.adapterUnsubscribe = adapter.subscribe((next) => {
        this.handleAdapterSnapshot(next);
      });
      this.adapter = adapter;
      return adapter;
    } catch (error) {
      // Leave no memoized rejection behind, so a retry can build a new adapter.
      this.adapterPromise = undefined;
      throw error;
    }
  }

  private handleAdapterSnapshot(next: PlaybackAdapterSnapshot): void {
    if (this.disposed || this.snapshot.selectedTrackId === null) return;
    if (next.status === 'ended' && this.snapshot.status !== 'ended') {
      this.update({
        status: 'ended',
        positionSeconds: next.durationSeconds,
        error: null,
      });
      this.persistPosition(next.durationSeconds);
      // Auto-play-next is always on: reaching the end advances to the next
      // track whenever the catalog holds more than one.
      if (this.catalog.tracks.length > 1) {
        const nextTrackId = this.takeNextTrack();
        if (nextTrackId !== undefined) this.selectFromSequence(nextTrackId);
      }
    }
  }

  private takeNextTrack(): string | undefined {
    const tracks = this.catalog.tracks;
    if (tracks.length < 2) return undefined;
    const selected = this.snapshot.selectedTrackId;
    if (this.snapshot.preferences.shuffle) {
      if (this.shuffleQueue.length === 0) {
        this.shuffleQueue = shuffled(
          tracks.map(({ id }) => id).filter((id) => id !== selected),
          this.random,
        );
      }
      return this.shuffleQueue.shift();
    }
    const index = tracks.findIndex(({ id }) => id === selected);
    return tracks[(index + 1 + tracks.length) % tracks.length]?.id;
  }

  private selectFromSequence(trackId: string): void {
    if (this.snapshot.selectedTrackId !== null) {
      this.pushHistory(this.snapshot.selectedTrackId);
    }
    void this.selectAndPlay(trackId, 0, this.acquirePermission(), false);
  }

  private pushHistory(trackId: string): void {
    this.history.push(trackId);
    if (this.history.length > MAX_HISTORY_ENTRIES) this.history.shift();
  }

  private fail(
    error: unknown,
    operation: PlayerError['operation'],
    track: CatalogTrack,
    requestedPosition: number,
    generation: number,
  ): void {
    if (
      !this.isCurrent(generation) ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      return;
    }
    const audioPermission = isAudioPermissionError(error);
    this.update({
      status: 'error',
      selectedTrackId: track.id,
      positionSeconds: requestedPosition,
      durationSeconds: track.durationSeconds,
      error: {
        category: audioPermission ? 'audio-permission' : 'track',
        operation,
        recoverable: true,
      },
    });
    this.persistPosition(requestedPosition);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private update(
    changes: Partial<Omit<PlayerControllerSnapshot, 'preferences'>>,
  ): void {
    this.snapshot = { ...this.snapshot, ...changes };
    this.publish();
  }

  private setPreferences(
    preferences: PlayerPreferences,
    coalesceSave = false,
  ): void {
    this.snapshot = { ...this.snapshot, preferences };
    if (coalesceSave) this.schedulePreferenceSave();
    else this.savePreferences();
    this.publish();
  }

  private persistPosition(positionSeconds: number, publish = true): void {
    const preferences = {
      ...this.snapshot.preferences,
      positionSeconds,
    };
    this.snapshot = { ...this.snapshot, positionSeconds, preferences };
    this.savePreferences();
    if (publish) this.publish();
  }

  private schedulePreferenceSave(): void {
    if (this.preferenceSaveTimer !== undefined) return;
    this.preferenceSaveTimer = window.setTimeout(() => {
      this.preferenceSaveTimer = undefined;
      savePlayerPreferences(this.storage, this.snapshot.preferences);
    }, PREFERENCE_SAVE_DELAY_MS);
  }

  /** Writes current preferences, superseding any coalesced write. */
  private savePreferences(): void {
    this.cancelPreferenceSave();
    savePlayerPreferences(this.storage, this.snapshot.preferences);
  }

  /**
   * Writes only if a coalesced save is still pending, so tearing the controller
   * down never invents a preference write of its own.
   */
  private flushPreferenceSave(): void {
    if (this.preferenceSaveTimer === undefined) return;
    this.cancelPreferenceSave();
    savePlayerPreferences(this.storage, this.snapshot.preferences);
  }

  private cancelPreferenceSave(): void {
    if (this.preferenceSaveTimer === undefined) return;
    window.clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = undefined;
  }

  private startTicker(): void {
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.ticker = window.setInterval(() => {
      if (this.snapshot.status !== 'playing' || this.adapter === undefined)
        return;
      const current = this.adapter.getSnapshot();
      this.snapshot = {
        ...this.snapshot,
        positionSeconds: current.positionSeconds,
      };
      this.publish();
      if (Date.now() - this.lastCheckpointAt >= CHECKPOINT_MS) {
        this.lastCheckpointAt = Date.now();
        this.persistPosition(current.positionSeconds, false);
      }
      this.updateMediaPosition(current);
    }, POSITION_UPDATE_MS);
  }

  private publish(): void {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState =
        this.snapshot.status === 'playing'
          ? 'playing'
          : this.snapshot.status === 'paused' ||
              this.snapshot.status === 'ready' ||
              this.snapshot.status === 'ended'
            ? 'paused'
            : 'none';
    }
    for (const listener of this.listeners) listener();
  }

  private installMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const set = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported Media Session actions do not affect ordinary playback.
      }
    };
    set('play', () => this.playSelected());
    set('pause', () => this.pause());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.previous());
  }

  private clearMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    for (const action of [
      'play',
      'pause',
      'nexttrack',
      'previoustrack',
    ] as const) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        // Ignore unsupported cleanup actions.
      }
    }
  }

  private updateMediaMetadata(track: CatalogTrack): void {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in globalThis))
      return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.author,
      album: 'ZX-MUSIC.FM',
      artwork: [
        { src: '/app-icon.svg', sizes: '512x512', type: 'image/svg+xml' },
      ],
    });
  }

  private updateMediaPosition(current: PlaybackAdapterSnapshot): void {
    if (!('mediaSession' in navigator) || current.durationSeconds <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: current.durationSeconds,
        playbackRate: 1,
        position: clamp(
          current.positionSeconds,
          0,
          Math.max(0, current.durationSeconds - Number.EPSILON),
        ),
      });
    } catch {
      // Position reporting is enhancement-only.
    }
  }
}
