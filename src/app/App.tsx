import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import packageMetadata from '../../package.json';
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
import { ChannelMeters } from './ChannelMeters.tsx';
import { CreditsDialog } from './CreditsDialog.tsx';
import { DotMatrixTrackDisplay } from './DotMatrixTrackDisplay.tsx';
import { formatTime } from './formatTime.ts';
import { SevenSegmentTime } from './SevenSegmentTime.tsx';
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
}: {
  readonly catalog: GeneratedCatalog;
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
  const creditsTrigger = useRef<HTMLButtonElement>(null);
  const capable = hasRequiredCapabilities();
  const hasTracks = catalog.tracks.length > 0;
  const controlsDisabled = !capable || !hasTracks;

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
  }, [capable, controller, snapshot.selectedTrackId, snapshot.status]);

  useEffect(() => controller.activate(), [controller]);

  const selectedTrack = catalog.tracks.find(
    ({ id }) => id === snapshot.selectedTrackId,
  );
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

      <div className="player-layout">
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
              {catalog.tracks.map((track) => {
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
                    <button
                      className="play-button"
                      type="button"
                      disabled={controlsDisabled || loading}
                      aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
                      onClick={() => controller.toggle(track.id)}
                    >
                      <span aria-hidden="true">
                        {loading ? '•••' : playing ? '⏸' : '▶'}
                      </span>
                    </button>
                    <div className="track-main">
                      <div className="track-meta">
                        <div className="track-identity">
                          <h3>{track.title}</h3>
                          <span aria-hidden="true">/</span>
                          <p>{track.author}</p>
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
                        <time
                          dateTime={`PT${Math.round(track.durationSeconds)}S`}
                        >
                          {selected ? `${formatTime(position)} / ` : ''}
                          {formatTime(track.durationSeconds)}
                        </time>
                      </div>
                      <WaveformSeek
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
            <p
              className={`section-kicker on-air-sign${
                snapshot.status === 'playing' ? ' is-live' : ''
              }`}
            >
              <span className="on-air-lamp" aria-hidden="true" />
              ON AIR
            </p>
            <span className="visually-hidden" aria-live="polite">
              {playbackStatusLabels[snapshot.status]}
            </span>
          </div>
          {selectedTrack === undefined ? (
            <p className="choose-track">Choose a track to start listening.</p>
          ) : (
            <div className="now-playing">
              <DotMatrixTrackDisplay
                title={selectedTrack.title}
                author={selectedTrack.author}
              />
              <SevenSegmentTime
                elapsed={formatTime(snapshot.positionSeconds)}
                total={formatTime(selectedTrack.durationSeconds)}
              />
            </div>
          )}
          <ChannelMeters
            adapter={controller.getAdapter()}
            playing={snapshot.status === 'playing'}
          />

          <fieldset
            className="deck-options"
            aria-label="Playback sequence settings"
          >
            <legend className="visually-hidden">Playback sequence</legend>
            <label className="deck-option">
              <input
                type="checkbox"
                aria-label="Auto-Play Next"
                checked={snapshot.preferences.autoPlayNext}
                disabled={!hasTracks}
                onChange={(event) =>
                  controller.setAutoPlayNext(event.currentTarget.checked)
                }
              />
              <span className="deck-option-face" aria-hidden="true" />
              <span className="deck-option-name">Auto Next</span>
            </label>
            <label className="deck-option">
              <input
                type="checkbox"
                checked={snapshot.preferences.shuffle}
                disabled={catalog.tracks.length < 2}
                aria-describedby={
                  catalog.tracks.length < 2 ? 'shuffle-help' : undefined
                }
                onChange={(event) =>
                  controller.setShuffle(event.currentTarget.checked)
                }
              />
              <span className="deck-option-face" aria-hidden="true" />
              <span className="deck-option-name">Shuffle</span>
            </label>
            {catalog.tracks.length < 2 ? (
              <span id="shuffle-help" className="visually-hidden">
                Shuffle needs at least two tracks.
              </span>
            ) : null}
          </fieldset>

          <div className="deck-controls">
            <div className="transport" aria-label="Playback controls">
              <button
                type="button"
                disabled={controlsDisabled || selectedTrack === undefined}
                aria-label="Previous track"
                onClick={() => controller.previous()}
              >
                <span aria-hidden="true">⏮</span>
              </button>
              <button
                className="transport-primary"
                type="button"
                disabled={
                  controlsDisabled ||
                  selectedTrack === undefined ||
                  snapshot.status === 'loading'
                }
                aria-label={
                  snapshot.status === 'playing'
                    ? 'Pause selected track'
                    : 'Play selected track'
                }
                onClick={() =>
                  snapshot.status === 'playing'
                    ? controller.pause()
                    : controller.playSelected()
                }
              >
                <span aria-hidden="true">
                  {snapshot.status === 'playing' ? '⏸' : '▶'}
                </span>
              </button>
              <button
                type="button"
                disabled={controlsDisabled || catalog.tracks.length < 2}
                aria-label="Next track"
                onClick={() => controller.next()}
              >
                <span aria-hidden="true">⏭</span>
              </button>
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
        <div className="footer-meta">
          <p>Independent, curated ZX Spectrum music radio.</p>
          <data
            className="app-version"
            value={packageMetadata.version}
            aria-label={`Application version ${packageMetadata.version}`}
          >
            v{packageMetadata.version}
          </data>
        </div>
        <nav aria-label="Project and credits">
          <a
            href="https://github.com/pinebit/zxmusicfm"
            target="_blank"
            rel="noopener noreferrer"
          >
            Source code
          </a>
          <a
            href="https://zxart.ee/eng/music/"
            target="_blank"
            rel="noopener noreferrer"
          >
            ZX-Art music collection
          </a>
          <button
            ref={creditsTrigger}
            type="button"
            onClick={() => setCreditsOpen(true)}
          >
            Credits / License
          </button>
        </nav>
      </footer>
      <CreditsDialog open={creditsOpen} onClose={closeCredits} />
    </>
  );
}

export function App({ catalogLoader = loadCatalog }: AppProps) {
  const [state, dispatch] = useReducer(catalogReducer, initialState);
  const [attempt, setAttempt] = useState(0);

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
    <main className="app-shell">
      <header className="brand-header">
        <div>
          <p className="eyebrow">
            CURATED CHIP MUSIC · THREE CHANNELS · ONE MACHINE
          </p>
          <h1>ZX-MUSIC.FM</h1>
        </div>
        <div className="brand-chip" aria-hidden="true">
          <strong>AY-3-8910</strong>
          <span>PROGRAMMABLE SOUND GENERATOR</span>
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
        <PlayerApplication catalog={state.catalog} />
      ) : null}
    </main>
  );
}
