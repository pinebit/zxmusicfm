import { useRef, type CSSProperties } from 'react';

type VolumeKnobProps = {
  readonly value: number;
  readonly disabled: boolean;
  /**
   * `scrubbing` marks the continuous stream of values a pointer drag produces, as
   * opposed to a discrete keyboard commit. Persistence is coalesced only for the
   * former; a keypress has to survive an immediate reload.
   */
  readonly onChange: (value: number, scrubbing: boolean) => void;
};

function clamp(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function VolumeKnob({ value, disabled, onChange }: VolumeKnobProps) {
  const gesture = useRef<
    | {
        readonly pointerId: number;
        readonly x: number;
        readonly y: number;
        readonly value: number;
      }
    | undefined
  >(undefined);
  const percent = clamp(value);

  return (
    <div className="volume-knob-wrap">
      <div
        className="volume-knob"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Master volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent} percent`}
        aria-disabled={disabled}
        style={
          {
            '--volume-turn': `${-135 + percent * 2.7}deg`,
            '--volume-level-sweep': `${
              percent === 0 ? 0 : Math.min(271.8, percent * 2.7 + 1.8)
            }deg`,
          } as CSSProperties
        }
        onKeyDown={(event) => {
          if (disabled) return;
          const changes: Partial<Record<string, number>> = {
            ArrowUp: 1,
            ArrowRight: 1,
            ArrowDown: -1,
            ArrowLeft: -1,
            PageUp: 10,
            PageDown: -10,
          };
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            onChange(event.key === 'Home' ? 0 : 100, false);
            return;
          }
          const change = changes[event.key];
          if (change !== undefined) {
            event.preventDefault();
            onChange(clamp(percent + change), false);
          }
        }}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            value: percent,
          };
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (start?.pointerId !== event.pointerId) return;
          const delta =
            (event.clientX - start.x - (event.clientY - start.y)) / 1.5;
          onChange(clamp(start.value + delta), true);
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          if (start?.pointerId === event.pointerId) {
            gesture.current = undefined;
            event.currentTarget.releasePointerCapture(event.pointerId);
            // Commit the value the drag settled on, so it persists immediately.
            onChange(percent, false);
          }
        }}
        onPointerCancel={() => {
          gesture.current = undefined;
        }}
      >
        <span aria-hidden="true" />
      </div>
    </div>
  );
}
