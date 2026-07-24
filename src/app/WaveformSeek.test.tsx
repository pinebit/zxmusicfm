import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecodedWaveform } from '../content/runtime.ts';
import { WAVEFORM_BUCKET_COUNT } from '../playback/waveform.ts';
import { WaveformSeek } from './WaveformSeek.tsx';

const waveform = Object.fromEntries(
  ['A', 'B', 'C'].map((channel) => [
    channel,
    new Int8Array(WAVEFORM_BUCKET_COUNT * 2),
  ]),
) as DecodedWaveform;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubDrawingContext(): {
  readonly clearRect: ReturnType<typeof vi.fn>;
} {
  const clearRect = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect,
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  return { clearRect };
}

function stubReducedMotion(reduce: boolean): void {
  const noop = (): void => undefined;
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  }));
}

function countingResizeObserver(): { readonly count: () => number } {
  let constructed = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor() {
        constructed += 1;
      }

      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
  return { count: () => constructed };
}

const playingAdapter = {
  getSnapshot: () => ({
    status: 'playing' as const,
    positionSeconds: 1,
    durationSeconds: 120,
  }),
  getOscilloscopeSamples: () => ({
    A: new Float32Array(1_024),
    B: new Float32Array(1_024),
    C: new Float32Array(1_024),
  }),
};

describe('WaveformSeek', () => {
  it('positions a seek marker under a hovering mouse', () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context,
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    const { container } = render(
      <WaveformSeek
        waveform={waveform}
        duration={120}
        position={0}
        showPosition={false}
        disabled={false}
        label="Seek test track"
        onCommit={vi.fn()}
      />,
    );
    const range = container.querySelector('input');
    const marker = container.querySelector<HTMLElement>(
      '.waveform-hover-marker',
    );
    if (range === null || marker === null) {
      throw new Error('Waveform seek controls are missing.');
    }
    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
      bottom: 96,
      height: 96,
      left: 20,
      right: 220,
      top: 0,
      width: 200,
      x: 20,
      y: 0,
      toJSON: () => undefined,
    });

    fireEvent.pointerMove(range, { clientX: 95, pointerType: 'mouse' });
    expect(marker).toHaveStyle({
      opacity: '1',
      transform: 'translateX(75px)',
    });

    fireEvent.pointerLeave(range);
    expect(marker).toHaveStyle({ opacity: '0' });
  });

  it('redraws after its canvas is hidden and restored', () => {
    let width = 120;
    let height = 96;
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const clearRect = vi.fn();
    const context = {
      beginPath: vi.fn(),
      clearRect,
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context,
    );
    vi.spyOn(
      HTMLCanvasElement.prototype,
      'clientWidth',
      'get',
    ).mockImplementation(() => width);
    vi.spyOn(
      HTMLCanvasElement.prototype,
      'clientHeight',
      'get',
    ).mockImplementation(() => height);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      },
    );

    const { container, unmount } = render(
      <WaveformSeek
        waveform={waveform}
        duration={120}
        position={0}
        showPosition={false}
        disabled={false}
        label="Seek test track"
        onCommit={vi.fn()}
      />,
    );
    const canvas = container.querySelector('canvas');
    if (canvas === null) throw new Error('Waveform canvas is missing.');
    expect(canvas.width).toBe(120);
    expect(canvas.height).toBe(96);
    expect(observe).toHaveBeenCalledWith(canvas);

    width = 0;
    height = 0;
    act(() => resizeCallback?.([], {} as ResizeObserver));
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);

    width = 240;
    height = 96;
    act(() => resizeCallback?.([], {} as ResizeObserver));
    expect(canvas.width).toBe(240);
    expect(canvas.height).toBe(96);
    expect(clearRect).toHaveBeenCalledTimes(3);

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps one resize observer and one animation loop across position updates', () => {
    stubDrawingContext();
    const observers = countingResizeObserver();
    stubReducedMotion(false);
    const frames = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockReturnValue(1);

    const view = (positionSeconds: number) => (
      <WaveformSeek
        adapter={playingAdapter}
        playing
        waveform={waveform}
        duration={120}
        position={positionSeconds}
        showPosition
        disabled={false}
        label="Seek test track"
        onCommit={vi.fn()}
      />
    );
    const { rerender } = render(view(1));
    expect(observers.count()).toBe(1);
    const framesAfterMount = frames.mock.calls.length;

    // The controller publishes a coarse position four times a second. That must
    // not rebuild the observer or restart the loop.
    rerender(view(1.25));
    rerender(view(1.5));
    rerender(view(1.75));

    expect(observers.count()).toBe(1);
    expect(frames.mock.calls.length).toBe(framesAfterMount);
  });

  it('stops the animation loop but keeps redrawing under reduced motion', () => {
    const { clearRect } = stubDrawingContext();
    countingResizeObserver();
    stubReducedMotion(true);
    const frames = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockReturnValue(1);

    const view = (positionSeconds: number) => (
      <WaveformSeek
        adapter={playingAdapter}
        playing
        waveform={waveform}
        duration={120}
        position={positionSeconds}
        showPosition
        disabled={false}
        label="Seek test track"
        onCommit={vi.fn()}
      />
    );
    const { rerender } = render(view(1));
    expect(frames).not.toHaveBeenCalled();

    const drawsAfterMount = clearRect.mock.calls.length;
    rerender(view(2));
    expect(clearRect.mock.calls.length).toBeGreaterThan(drawsAfterMount);
    expect(frames).not.toHaveBeenCalled();
  });
});
