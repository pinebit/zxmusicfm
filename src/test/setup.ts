import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom does not implement matchMedia, which components query for the
// prefers-reduced-motion setting. Report "no preference" with inert listeners.
if (typeof window.matchMedia !== 'function') {
  const noop = (): void => undefined;
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  });
}

afterEach(() => {
  cleanup();
});
