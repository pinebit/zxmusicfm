import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrandWordmark } from './BrandWordmark.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BrandWordmark', () => {
  it('restarts the spectrum sweep after a randomized pause', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(<BrandWordmark />);
    const sweep =
      container.querySelector<SVGAnimateTransformElement>('animateTransform');
    if (sweep === null) throw new Error('Spectrum sweep is missing.');
    const beginElement = vi.fn();
    sweep.beginElement = beginElement;

    expect(sweep).toHaveAttribute('dur', '2.4s');
    expect(sweep).toHaveAttribute('calcMode', 'linear');
    expect(sweep).toHaveAttribute('fill', 'remove');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(beginElement).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(beginElement).toHaveBeenCalledTimes(2);
    expect(container.querySelector('animateTransform')).toBe(sweep);
  });

  it('omits the spectrum sweep when reduced motion is preferred', () => {
    const noop = (): void => undefined;
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }));

    const { container } = render(<BrandWordmark />);

    expect(container.querySelector('animateTransform')).not.toBeInTheDocument();
    expect(
      container.querySelector('.brand-spectrum-pixels'),
    ).not.toBeInTheDocument();
  });
});
