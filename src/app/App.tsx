import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  decodeWaveformPack,
  fetchVerifiedBytes,
  type DecodedWaveform,
} from '../content/runtime.ts';
import {
  generatedCatalogSchema,
  type GeneratedCatalog,
} from '../content/schemas.ts';
import { PlayerController } from '../playback/PlayerController.ts';
import type {
  PlayerControllerSnapshot,
  PlayerError,
} from '../playback/PlayerController.ts';
import { BrandWordmark } from './BrandWordmark.tsx';
import { ChannelMeters } from './ChannelMeters.tsx';
import {
  MaximizeIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  RestoreIcon,
} from './ControlIcons.tsx';
import { CreditsDialog } from './CreditsDialog.tsx';
import { formatTime } from './formatTime.ts';
import { PianoKeyboard } from './PianoKeyboard.tsx';
import { VolumeKnob } from './VolumeKnob.tsx';
import { WaveformSeek } from './WaveformSeek.tsx';

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; catalog: GeneratedCatalog }
  | { status: 'error' };
type CatalogAction =
  | { type: 'load' }
  | { type: 'success'; catalog: GeneratedCatalog }
  | { type: 'failure' };
type CatalogLoader = (signal: AbortSignal) => Promise<GeneratedCatalog>;
type AppProps = { readonly catalogLoader?: CatalogLoader };
type WaveformState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly tracks: ReadonlyMap<string, DecodedWaveform>;
    };

const initialState: CatalogState = { status: 'loading' };
const mobilePortraitQuery =
  '(max-width: 1024px) and (orientation: portrait) and (hover: none) and (pointer: coarse)';

function catalogReducer(
  _state: CatalogState,
  action: CatalogAction,
): CatalogState {
  switch (action.type) {
    case 'load':
      return { status: 'loading' };
    case 'success':
      return { status: 'ready', catalog: action.catalog };
    case 'failure':
      return { status: 'error' };
  }
}

async function loadCatalog(signal: AbortSignal): Promise<GeneratedCatalog> {
  const response = await fetch('/generated/catalog.json', {
    cache: 'no-cache',
    signal,
  });
  if (!response.ok) throw new Error('Catalog request failed.');
  return generatedCatalogSchema.parse(await response.json());
}

function hasRequiredCapabilities(): boolean {
  const capabilities = globalThis as Partial<
    Pick<typeof globalThis, 'AudioContext' | 'WebAssembly' | 'crypto'>
  >;
  return (
    typeof capabilities.WebAssembly === 'object' &&
    typeof capabilities.AudioContext === 'function' &&
    typeof capabilities.crypto?.subtle === 'object'
  );
}

const playbackStatusLabels: Readonly<
  Record<PlayerControllerSnapshot['status'], string>
> = {
  idle: 'Stopped',
  loading: 'Loading',
  ready: 'Ready',
  playing: 'Playing',
  paused: 'Paused',
  ended: 'Finished',
  error: 'Playback error',
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'button, a, input, textarea, select, [role="slider"], dialog',
    ) !== null
  );
}

function playerErrorMessage(error: PlayerError): string {
  if (error.category === 'audio-permission') {
    return 'Your browser paused audio before it could start.';
  }
  if (error.operation === 'seek') {
    return 'This position could not be opened. Try again.';
  }
  return 'This track could not be loaded. Check your connection and try again.';
}

function PlayerApplication({
  catalog,
  deckMaximized,
  onDeckMaximizedChange,
}: {
  readonly catalog: GeneratedCatalog;
  readonly deckMaximized: boolean;
  readonly onDeckMaximizedChange: (maximized: boolean) => void;
}) {
  const controller = useMemo(() => new PlayerController(catalog), [catalog]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [waveforms, setWaveforms] = useState<WaveformState>({
    status: 'loading',
  });
  const [waveformAttempt, setWaveformAttempt] = useState(0);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [mobilePortrait, setMobilePortrait] = useState(
    () => window.matchMedia(mobilePortraitQuery).matches,
  );
  const creditsTrigger = useRef<HTMLButtonElement>(null);
  const deckMaximizeTrigger = useRef<HTMLButtonElement>(null);
  const playerLayout = useRef<HTMLDivElement>(null);
  const deckControls = useRef<HTMLDivElement>(null);
  const capable = hasRequiredCapabilities();
  const hasTracks = catalog.tracks.length > 0;
  const controlsDisabled = !capable || !hasTracks;
  const lockMobileLandscape = useCallback(async (): Promise<boolean> => {
    const orientation = (
      window.screen as unknown as {
        readonly orientation?: ScreenOrientation;
      }
    ).orientation;
    if (typeof orientation?.lock !== 'function') return false;
    try {
      await orientation.lock('landscape');
      return true;
    } catch {
      return false;
    }
  }, []);
  const orientation = (
    window.screen as unknown as {
      readonly orientation?: ScreenOrientation;
    }
  ).orientation;
  const mobileLandscapeFullscreenAvailable =
    typeof document.documentElement.requestFullscreen === 'function' &&
    typeof orientation?.lock === 'function';
  const deckMaximizationAvailable =
    !mobilePortrait || mobileLandscapeFullscreenAvailable;
  const closeDeckMaximized = useCallback(() => {
    if (document.fullscreenElement === playerLayout.current) {
      void document.exitFullscreen();
    } else {
      onDeckMaximizedChange(false);
      window.setTimeout(() => deckMaximizeTrigger.current?.focus(), 0);
    }
  }, [onDeckMaximizedChange]);
  const toggleDeckMaximized = useCallback(() => {
    if (deckMaximized) {
      closeDeckMaximized();
      return;
    }
    const requiresLandscapeLock =
      window.matchMedia(mobilePortraitQuery).matches;
    const layout = playerLayout.current;
    const controlsWidth = deckControls.current?.getBoundingClientRect().width;
    if (controlsWidth !== undefined) {
      layout?.style.setProperty(
        '--normal-deck-controls-width',
        `${controlsWidth}px`,
      );
    }
    if (layout === null || typeof layout.requestFullscreen !== 'function') {
      if (requiresLandscapeLock) return;
      onDeckMaximizedChange(true);
      return;
    }
    void layout.requestFullscreen().then(
      async () => {
        if (!requiresLandscapeLock) return;
        if (await lockMobileLandscape()) return;
        if (document.fullscreenElement === layout) {
          await document.exitFullscreen().catch(() => undefined);
        }
      },
      () => {
        if (requiresLandscapeLock) return;
        onDeckMaximizedChange(true);
      },
    );
  }, [
    closeDeckMaximized,
    deckMaximized,
    lockMobileLandscape,
    onDeckMaximizedChange,
  ]);

  useEffect(() => {
    const abort = new AbortController();
    setWaveforms({ status: 'loading' });
    const manifest = catalog.waveforms;
    void fetchVerifiedBytes(
      manifest.url,
      manifest.byteLength,
      manifest.sha256,
      abort.signal,
      'Waveform pack',
    ).then(
      (bytes) => {
        try {
          setWaveforms({
            status: 'ready',
            tracks: decodeWaveformPack(bytes, catalog),
          });
        } catch {
          setWaveforms({ status: 'error' });
        }
      },
      () => {
        if (!abort.signal.aborted) setWaveforms({ status: 'error' });
      },
    );
    return () => abort.abort();
  }, [catalog, waveformAttempt]);

  useEffect(() => {
    const pageHide = () => controller.persistNow();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && deckMaximized) {
        event.preventDefault();
        closeDeckMaximized();
        return;
      }
      if (
        event.code !== 'Space' ||
        event.repeat ||
        isInteractiveTarget(event.target) ||
        snapshot.selectedTrackId === null ||
        !capable
      ) {
        return;
      }
      event.preventDefault();
      if (snapshot.status === 'playing') controller.pause();
      else controller.playSelected();
    };
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('keydown', keyboard);
    return () => {
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('keydown', keyboard);
    };
  }, [
    capable,
    closeDeckMaximized,
    controller,
    deckMaximized,
    onDeckMaximizedChange,
    snapshot.selectedTrackId,
    snapshot.status,
  ]);

  useEffect(() => controller.activate(), [controller]);

  useEffect(() => {
    const media = window.matchMedia(mobilePortraitQuery);
    const syncMobilePortrait = () => {
      setMobilePortrait(media.matches);
      if (
        !media.matches &&
        document.fullscreenElement === playerLayout.current
      ) {
        onDeckMaximizedChange(true);
      }
    };
    syncMobilePortrait();
    media.addEventListener('change', syncMobilePortrait);
    return () => media.removeEventListener('change', syncMobilePortrait);
  }, [onDeckMaximizedChange]);

  useEffect(() => {
    if (!deckMaximized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [deckMaximized]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const maximized =
        document.fullscreenElement === playerLayout.current &&
        !window.matchMedia(mobilePortraitQuery).matches;
      onDeckMaximizedChange(maximized);
      if (!maximized) {
        window.setTimeout(() => deckMaximizeTrigger.current?.focus(), 0);
      }
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () =>
      document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, [onDeckMaximizedChange]);

  const selectedTrack = catalog.tracks.find(
    ({ id }) => id === snapshot.selectedTrackId,
  );
  const playbackProgress =
    snapshot.durationSeconds > 0
      ? snapshot.positionSeconds / snapshot.durationSeconds
      : 0;
  const closeCredits = useCallback(() => {
    setCreditsOpen(false);
    window.setTimeout(() => creditsTrigger.current?.focus(), 0);
  }, []);

  return (
    <>
      {!capable ? (
        <section className="notice-panel" role="alert">
          <strong>Playback is not supported in this browser.</strong>
          <span>
            You can still browse the catalog and credits. Try a current Chrome,
            Firefox, Safari, or Edge release to listen.
          </span>
        </section>
      ) : null}

      {waveforms.status === 'error' ? (
        <section className="waveform-notice" aria-live="polite">
          <span>
            Visual waveforms are unavailable. Seek sliders remain available.
          </span>
          <button
            type="button"
            onClick={() => setWaveformAttempt((value) => value + 1)}
          >
            Retry waveforms
          </button>
        </section>
      ) : null}

      <div
        ref={playerLayout}
        className={`player-layout${deckMaximized ? ' deck-maximized' : ''}`}
        onClick={(event) => {
          if (deckMaximized && event.target === event.currentTarget) {
            closeDeckMaximized();
          }
        }}
      >
        <section className="track-panel" aria-labelledby="track-list-heading">
          <div className="panel-heading">
            <h2 id="track-list-heading" className="section-kicker">
              CURATED TRACKS
            </h2>
          </div>

          {!hasTracks ? (
            <div className="empty-state">
              <strong>No tracks available</strong>
              <span>The development catalog is valid but currently empty.</span>
            </div>
          ) : (
            <ol className="track-list">
              {catalog.tracks.map((track, trackIndex) => {
                const selected = snapshot.selectedTrackId === track.id;
                const position = selected ? snapshot.positionSeconds : 0;
                const playing = selected && snapshot.status === 'playing';
                const loading = selected && snapshot.status === 'loading';
                const failed = selected && snapshot.status === 'error';
                return (
                  <li
                    className={`track-row${selected ? ' selected' : ''}`}
                    aria-current={selected ? 'true' : undefined}
                    key={track.id}
                  >
                    <span className="track-index" aria-hidden="true">
                      {String(trackIndex + 1).padStart(2, '0')}
                    </span>
                    <button
                      className="play-button"
                      type="button"
                      disabled={controlsDisabled || loading}
                      aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
                      onClick={() => controller.toggle(track.id)}
                    >
                      {loading ? (
                        <span aria-hidden="true">•••</span>
                      ) : playing ? (
                        <PauseIcon />
                      ) : (
                        <PlayIcon />
                      )}
                    </button>
                    <div className="track-main">
                      <div className="track-meta">
                        <div className="track-identity">
                          <h3>{track.title}</h3>
                          <div className="track-secondary">
                            <p>{track.author}</p>
                            {track.year !== undefined ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <p>{track.year}</p>
                              </>
                            ) : null}
                            <a
                              className="track-source-link"
                              href={track.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Original source for ${track.title}`}
                              title="Original source"
                            >
                              <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                focusable="false"
                              >
                                <path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3Z" />
                                <path d="M19 19H5V5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2v6Z" />
                              </svg>
                            </a>
                          </div>
                        </div>
                        <time
                          dateTime={`PT${Math.round(track.durationSeconds)}S`}
                        >
                          {selected ? `${formatTime(position)} / ` : ''}
                          {formatTime(track.durationSeconds)}
                        </time>
                      </div>
                      <WaveformSeek
                        adapter={selected ? controller.getAdapter() : undefined}
                        playing={playing}
                        waveform={
                          waveforms.status === 'ready'
                            ? waveforms.tracks.get(track.id)
                            : undefined
                        }
                        duration={track.durationSeconds}
                        position={position}
                        showPosition={selected}
                        disabled={controlsDisabled || loading}
                        label={`Seek ${track.title}`}
                        onCommit={(seconds) =>
                          controller.seek(track.id, seconds)
                        }
                      />
                      {loading ? (
                        <p className="track-status" role="status">
                          Loading and checking track…
                        </p>
                      ) : null}
                      {failed && snapshot.error !== null ? (
                        <div className="inline-error" role="alert">
                          <span>{playerErrorMessage(snapshot.error)}</span>
                          <button
                            type="button"
                            onClick={() =>
                              snapshot.error?.category === 'audio-permission'
                                ? controller.enableAudio()
                                : controller.retry()
                            }
                          >
                            {snapshot.error.category === 'audio-permission'
                              ? 'Tap/click to enable audio'
                              : 'Retry track'}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <aside className="meter-panel" aria-label="Playback deck">
          <div className="meter-heading">
            <div className="on-air-display">
              <p
                className={`section-kicker on-air-sign${
                  snapshot.status === 'playing' ? ' is-live' : ''
                }`}
              >
                <span className="on-air-lamp" aria-hidden="true" />
                <span className="on-air-label">ON AIR</span>
                {selectedTrack ? (
                  <span className="on-air-track">
                    {' - '}
                    {selectedTrack.title} | {selectedTrack.author}
                  </span>
                ) : null}
              </p>
              <span className="on-air-progress" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.max(0, Math.min(1, playbackProgress)) * 100}%`,
                  }}
                />
              </span>
            </div>
            <span className="visually-hidden" aria-live="polite">
              {playbackStatusLabels[snapshot.status]}
            </span>
            {deckMaximizationAvailable ? (
              <button
                ref={deckMaximizeTrigger}
                type="button"
                className="deck-maximize-button"
                aria-label={
                  deckMaximized
                    ? 'Exit distraction-free mode'
                    : 'Enter distraction-free mode'
                }
                title={
                  deckMaximized
                    ? 'Exit distraction-free mode'
                    : 'Enter distraction-free mode'
                }
                aria-pressed={deckMaximized}
                onClick={toggleDeckMaximized}
              >
                {deckMaximized ? <RestoreIcon /> : <MaximizeIcon />}
              </button>
            ) : null}
          </div>
          {selectedTrack === undefined ? (
            <p className="choose-track">Choose a track to start listening.</p>
          ) : null}
          <ChannelMeters
            adapter={controller.getAdapter()}
            playing={snapshot.status === 'playing'}
            channelOrder={snapshot.preferences.channelOrder}
          />
          <PianoKeyboard
            adapter={controller.getAdapter()}
            playing={snapshot.status === 'playing'}
            channelOrder={snapshot.preferences.channelOrder}
            onChannelOrderChange={(channelOrder) =>
              controller.setChannelOrder(channelOrder)
            }
          />

          <div ref={deckControls} className="deck-controls">
            <div className="deck-options">
              <button
                type="button"
                className="deck-button deck-toggle"
                aria-label="Shuffle"
                aria-pressed={snapshot.preferences.shuffle}
                disabled={catalog.tracks.length < 2}
                aria-describedby={
                  catalog.tracks.length < 2 ? 'shuffle-help' : undefined
                }
                onClick={() =>
                  controller.setShuffle(!snapshot.preferences.shuffle)
                }
              >
                <span className="deck-led" aria-hidden="true" />
                <span className="deck-toggle-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
                  </svg>
                </span>
              </button>
              {catalog.tracks.length < 2 ? (
                <span id="shuffle-help" className="visually-hidden">
                  Shuffle needs at least two tracks.
                </span>
              ) : null}
            </div>

            <div className="transport">
              <div className="transport-buttons" aria-label="Playback controls">
                <button
                  type="button"
                  disabled={controlsDisabled || selectedTrack === undefined}
                  aria-label="Previous track"
                  onClick={() => controller.previous()}
                >
                  <PreviousIcon />
                </button>
                <button
                  className="transport-primary"
                  type="button"
                  disabled={controlsDisabled || snapshot.status === 'loading'}
                  aria-label={
                    snapshot.status === 'playing'
                      ? 'Pause selected track'
                      : selectedTrack === undefined
                        ? 'Play first track'
                        : 'Play selected track'
                  }
                  onClick={() =>
                    snapshot.status === 'playing'
                      ? controller.pause()
                      : controller.playSelected()
                  }
                >
                  {snapshot.status === 'playing' ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button
                  type="button"
                  disabled={controlsDisabled || catalog.tracks.length < 2}
                  aria-label="Next track"
                  onClick={() => controller.next()}
                >
                  <NextIcon />
                </button>
              </div>
            </div>

            <div className="volume-control">
              <VolumeKnob
                value={snapshot.preferences.volume * 100}
                disabled={!hasTracks}
                onChange={(value) => controller.setVolume(value / 100)}
              />
            </div>
          </div>
        </aside>
      </div>

      <footer className="site-footer">
        <nav aria-label="Project, credits, and support">
          <a
            href="https://zxart.ee/eng/music/"
            target="_blank"
            rel="noopener noreferrer"
          >
            ZX-Art music
          </a>
          <button
            ref={creditsTrigger}
            type="button"
            onClick={() => setCreditsOpen(true)}
          >
            About
          </button>
          <a
            href="https://buymeacoffee.com/pinebit"
            target="_blank"
            rel="noopener noreferrer"
          >
            Buy me a coffee
          </a>
        </nav>
      </footer>
      <CreditsDialog open={creditsOpen} onClose={closeCredits} />
    </>
  );
}

export function App({ catalogLoader = loadCatalog }: AppProps) {
  const [state, dispatch] = useReducer(catalogReducer, initialState);
  const [attempt, setAttempt] = useState(0);
  const [deckMaximized, setDeckMaximized] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    void catalogLoader(abort.signal).then(
      (catalog) => dispatch({ type: 'success', catalog }),
      () => {
        if (!abort.signal.aborted) dispatch({ type: 'failure' });
      },
    );
    return () => abort.abort();
  }, [attempt, catalogLoader]);

  return (
    <main className={`app-shell${deckMaximized ? ' deck-focus-mode' : ''}`}>
      <header className="brand-header">
        <div className="brand-titles">
          <h1>
            <span className="visually-hidden">ZX-MUSIC.FM</span>
            <BrandWordmark />
          </h1>
        </div>
        <div className="spectrum-stripe" aria-hidden="true" />
      </header>

      {state.status === 'loading' ? (
        <section className="loading-shell" aria-live="polite">
          <span className="loading-reel" aria-hidden="true" />
          Loading catalog…
        </section>
      ) : null}
      {state.status === 'error' ? (
        <section className="page-error" role="alert">
          <div>
            <strong>The station list could not be loaded.</strong>
            <span>Check your connection and try again.</span>
          </div>
          <button
            type="button"
            onClick={() => {
              dispatch({ type: 'load' });
              setAttempt((value) => value + 1);
            }}
          >
            Retry catalog
          </button>
        </section>
      ) : null}
      {state.status === 'ready' ? (
        <PlayerApplication
          catalog={state.catalog}
          deckMaximized={deckMaximized}
          onDeckMaximizedChange={setDeckMaximized}
        />
      ) : null}
    </main>
  );
}
