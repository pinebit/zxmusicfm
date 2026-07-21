const LED_COUNT = 24;

type PositionLedsProps = {
  readonly fraction: number;
  readonly mode: 'position' | 'volume';
  readonly paused: boolean;
};

/**
 * A non-interactive strip of faded LEDs below the gauges. It fills left to
 * right with the playback position (orange), switches to the volume level
 * (green) while the knob is being turned, and slow-flashes while paused.
 * Position and volume remain available to assistive tech through the seek and
 * volume sliders, so the strip itself is decorative.
 */
export function PositionLeds({ fraction, mode, paused }: PositionLedsProps) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const litCount = Math.round(clamped * LED_COUNT);
  return (
    <div
      className="position-leds"
      data-mode={mode}
      data-paused={paused ? 'true' : 'false'}
      aria-hidden="true"
    >
      {Array.from({ length: LED_COUNT }, (_, index) => (
        <span
          key={index}
          className={`position-led${index < litCount ? ' is-lit' : ''}`}
        />
      ))}
    </div>
  );
}
