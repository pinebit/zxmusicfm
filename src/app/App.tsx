import { useEffect, useReducer, useState } from 'react';

import {
  generatedCatalogSchema,
  type GeneratedCatalog,
} from '../content/schemas.ts';

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; catalog: GeneratedCatalog }
  | { status: 'error'; message: string };

type CatalogAction =
  | { type: 'load' }
  | { type: 'success'; catalog: GeneratedCatalog }
  | { type: 'failure'; message: string };

type CatalogLoader = (signal: AbortSignal) => Promise<GeneratedCatalog>;

type AppProps = {
  readonly catalogLoader?: CatalogLoader;
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
      return { status: 'error', message: action.message };
  }
}

async function loadCatalog(signal: AbortSignal): Promise<GeneratedCatalog> {
  const response = await fetch('/generated/catalog.json', {
    cache: 'no-cache',
    signal,
  });

  if (!response.ok) {
    throw new Error(`Catalog request failed with status ${response.status}.`);
  }

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

export function App({ catalogLoader = loadCatalog }: AppProps) {
  const [state, dispatch] = useReducer(catalogReducer, initialState);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    void catalogLoader(controller.signal).then(
      (catalog) => {
        dispatch({ type: 'success', catalog });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({
            type: 'failure',
            message:
              error instanceof Error
                ? error.message
                : 'The catalog could not be loaded.',
          });
        }
      },
    );

    return () => {
      controller.abort();
    };
  }, [catalogLoader, loadAttempt]);

  const retry = () => {
    dispatch({ type: 'load' });
    setLoadAttempt((attempt) => attempt + 1);
  };

  return (
    <main className="diagnostic-shell">
      <p className="eyebrow">Phase 1 diagnostic shell</p>
      <h1>ZX-SPECTRUM.FM</h1>
      <p>
        Foundation only. Playback-engine integration begins after this phase
        gate passes.
      </p>

      <section aria-labelledby="foundation-status">
        <h2 id="foundation-status">Foundation status</h2>
        <dl>
          <div>
            <dt>Browser capabilities</dt>
            <dd>{hasRequiredCapabilities() ? 'Available' : 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Catalog</dt>
            <dd aria-live="polite">
              {state.status === 'loading' ? 'Loading…' : null}
              {state.status === 'ready'
                ? `Valid schema; ${state.catalog.tracks.length} tracks`
                : null}
              {state.status === 'error' ? state.message : null}
            </dd>
          </div>
        </dl>

        {state.status === 'error' ? (
          <button type="button" onClick={retry}>
            Retry
          </button>
        ) : null}
      </section>
    </main>
  );
}
