import { useEffect, useRef } from 'react';

import type { PlaybackAdapter } from '../playback/contracts.ts';

type ChannelMetersProps = {
  readonly adapter: PlaybackAdapter | undefined;
};

export function ChannelMeters({ adapter }: ChannelMetersProps) {
  const meterRefs = useRef<Record<'A' | 'B' | 'C', HTMLMeterElement | null>>({
    A: null,
    B: null,
    C: null,
  });

  useEffect(() => {
    let frame = 0;
    let previousTime = performance.now();
    const smoothed = { A: 0, B: 0, C: 0 };
    const update = (now: number) => {
      const elapsed = Math.max(0, now - previousTime);
      previousTime = now;
      const levels =
        document.visibilityState === 'hidden'
          ? { A: 0, B: 0, C: 0 }
          : (adapter?.getChannelLevels() ?? { A: 0, B: 0, C: 0 });
      for (const channel of ['A', 'B', 'C'] as const) {
        const amplitude = levels[channel];
        const decibels = amplitude <= 0 ? -48 : 20 * Math.log10(amplitude);
        const target = Math.max(0, Math.min(1, (decibels + 48) / 48));
        const timeConstant = target > smoothed[channel] ? 60 : 300;
        const alpha = 1 - Math.exp(-elapsed / timeConstant);
        smoothed[channel] += (target - smoothed[channel]) * alpha;
        const meter = meterRefs.current[channel];
        if (meter !== null) {
          meter.value = smoothed[channel];
          meter.style.setProperty('--meter-level', String(smoothed[channel]));
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [adapter]);

  return (
    <div className="meter-bank" aria-label="Live AY channel levels">
      {(['A', 'B', 'C'] as const).map((channel) => (
        <div className={`meter meter-${channel.toLowerCase()}`} key={channel}>
          <span className="meter-scale" aria-hidden="true">
            −48 · −24 · 0
          </span>
          <meter
            ref={(element) => {
              meterRefs.current[channel] = element;
            }}
            min={0}
            max={1}
            aria-label={`Channel ${channel} level`}
          />
          <span className="meter-needle" aria-hidden="true" />
          <strong>CHANNEL {channel}</strong>
        </div>
      ))}
    </div>
  );
}
