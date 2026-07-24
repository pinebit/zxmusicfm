import { useEffect, useRef } from 'react';

import type {
  ChannelId,
  ChannelOrder,
  PlaybackAdapter,
} from '../playback/contracts.ts';

type ChannelMetersProps = {
  readonly adapter: PlaybackAdapter | undefined;
  readonly playing: boolean;
  readonly channelOrder: ChannelOrder;
};

// Below this smoothed level a needle is visually at rest, so the loop can stop.
const SETTLED_LEVEL = 0.0005;
const CHANNELS_BY_ORDER: Readonly<Record<ChannelOrder, readonly ChannelId[]>> =
  {
    ABC: ['A', 'B', 'C'],
    ACB: ['A', 'C', 'B'],
    BAC: ['B', 'A', 'C'],
  };
const STEREO_POSITIONS = ['left', 'center', 'right'] as const;

export function ChannelMeters({
  adapter,
  playing,
  channelOrder,
}: ChannelMetersProps) {
  const gaugeRefs = useRef<Record<'A' | 'B' | 'C', HTMLDivElement | null>>({
    A: null,
    B: null,
    C: null,
  });
  const meterRefs = useRef<Record<'A' | 'B' | 'C', HTMLMeterElement | null>>({
    A: null,
    B: null,
    C: null,
  });
  // Persist smoothing across play/pause so needles release rather than snap.
  const smoothedRef = useRef<Record<'A' | 'B' | 'C', number>>({
    A: 0,
    B: 0,
    C: 0,
  });

  useEffect(() => {
    let frame = 0;
    let previousTime = performance.now();
    const smoothed = smoothedRef.current;
    const update = (now: number) => {
      const elapsed = Math.max(0, now - previousTime);
      previousTime = now;
      const levels =
        !playing || document.visibilityState === 'hidden'
          ? { A: 0, B: 0, C: 0 }
          : (adapter?.getChannelLevels() ?? { A: 0, B: 0, C: 0 });
      let settling = false;
      for (const channel of ['A', 'B', 'C'] as const) {
        const amplitude = levels[channel];
        const decibels = amplitude <= 0 ? -48 : 20 * Math.log10(amplitude);
        const target = Math.max(0, Math.min(1, (decibels + 48) / 48));
        const timeConstant = target > smoothed[channel] ? 60 : 300;
        const alpha = 1 - Math.exp(-elapsed / timeConstant);
        smoothed[channel] += (target - smoothed[channel]) * alpha;
        if (smoothed[channel] > SETTLED_LEVEL) settling = true;
        const meter = meterRefs.current[channel];
        if (meter !== null) {
          meter.value = smoothed[channel];
        }
        const gauge = gaugeRefs.current[channel];
        if (gauge !== null) {
          gauge.style.setProperty(
            '--meter-angle',
            `${-148 + smoothed[channel] * 116}deg`,
          );
        }
      }
      // Keep animating while sound is playing or needles are still releasing;
      // otherwise stop until playback resumes (this effect re-runs on `playing`).
      if (playing || settling) {
        frame = requestAnimationFrame(update);
      }
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [adapter, playing]);

  return (
    <div
      className="meter-bank"
      aria-label="Live AY channel levels arranged by stereo position"
    >
      {CHANNELS_BY_ORDER[channelOrder].map((channel, index) => (
        <div
          ref={(element) => {
            gaugeRefs.current[channel] = element;
          }}
          className={`meter meter-${channel.toLowerCase()}`}
          key={channel}
        >
          <span className="meter-scale" aria-hidden="true">
            −48&nbsp;&nbsp; −36&nbsp;&nbsp; −24&nbsp;&nbsp; −12&nbsp;&nbsp; 0
          </span>
          <span className="meter-unit" aria-hidden="true">
            dBFS
          </span>
          <meter
            ref={(element) => {
              meterRefs.current[channel] = element;
            }}
            min={0}
            max={1}
            aria-label={`Channel ${channel} level, ${STEREO_POSITIONS[index]} stereo position`}
          />
          <span className="meter-needle" aria-hidden="true" />
          <strong>CH {channel}</strong>
        </div>
      ))}
    </div>
  );
}
