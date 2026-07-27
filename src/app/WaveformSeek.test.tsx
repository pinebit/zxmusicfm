import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecodedWaveform } from '../content/runtime.ts';
import { WAVEFORM_BUCKET_COUNT } from '../playback/waveform.ts';
import {
  aggregateWaveformBars,
  WaveformSeek,
  waveformBarCount,
} from './WaveformSeek.tsx';

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
  readonly createLinearGradient: ReturnType<typeof vi.fn>;
  readonly addColorStop: ReturnType<typeof vi.fn>;
} {
  const clearRect = vi.fn();
  const addColorStop = vi.fn();
  const createLinearGradient = vi.fn(() => ({ addColorStop }));
  const context = {
    beginPath: vi.fn(),
    clearRect,
    clip: vi.fn(),
    createLinearGradient,
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    roundRect: vi.fn(),
    save: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  return { clearRect, createLinearGradient, addColorStop };
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
};

describe('WaveformSeek', () => {
  it('aggregates every source bucket into responsive display bars', () => {
    const peaks = new Int8Array(WAVEFORM_BUCKET_COUNT * 2);
    for (let bucket = 0; bucket < WAVEFORM_BUCKET_COUNT / 2; bucket += 1) {
      peaks[bucket * 2] = -127;
      peaks[bucket * 2 + 1] = 80;
    }
    for (
      let bucket = WAVEFORM_BUCKET_COUNT / 2;
      bucket < WAVEFORM_BUCKET_COUNT;
      bucket += 1
    ) {
      peaks[bucket * 2] = -32;
      peaks[bucket * 2 + 1] = 64;
    }

    const bars = aggregateWaveformBars(peaks, 2);
    expect(bars[0]).toBe(1);
    expect(bars[1]).toBeCloseTo(64 / 127, 6);

    peaks.fill(0);
    peaks[peaks.length - 1] = 127;
    expect(aggregateWaveformBars(peaks, 3)[2]).toBeGreaterThan(0);
  });

  it('derives bar density from CSS width rather than device pixels', () => {
    expect(waveformBarCount(120, 1)).toBe(30);
    expect(waveformBarCount(240, 2)).toBe(30);
    expect(waveformBarCount(1, 1)).toBe(1);
    expect(waveformBarCount(20_000, 1)).toBe(WAVEFORM_BUCKET_COUNT);
  });

  it('fades each channel bar toward its upper and lower tips', () => {
    const { createLinearGradient, addColorStop } = stubDrawingContext();
    countingResizeObserver();

    render(
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

    expect(createLinearGradient).toHaveBeenCalledTimes(3);
    expect(addColorStop.mock.calls).toEqual([
      [0, '#dca6ad66'],
      [0.5, '#dca6ade6'],
      [1, '#dca6ad66'],
      [0, '#dfcda266'],
      [0.5, '#dfcda2e6'],
      [1, '#dfcda266'],
      [0, '#9fcbd066'],
      [0.5, '#9fcbd0e6'],
      [1, '#9fcbd066'],
    ]);
  });

  it('positions a seek marker under a hovering mouse', () => {
    const addColorStop = vi.fn();
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop })),
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
    const addColorStop = vi.fn();
    const context = {
      beginPath: vi.fn(),
      clearRect,
      createLinearGradient: vi.fn(() => ({ addColorStop })),
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
