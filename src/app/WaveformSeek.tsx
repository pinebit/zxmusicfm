import { useEffect, useRef, useState } from 'react';

import type { DecodedWaveform } from '../content/runtime.ts';
import { WAVEFORM_BUCKET_COUNT } from '../playback/waveform.ts';

type WaveformSeekProps = {
  readonly waveform: DecodedWaveform | undefined;
  readonly duration: number;
  readonly position: number;
  readonly disabled: boolean;
  readonly label: string;
  readonly onCommit: (seconds: number) => void;
};

const colors = {
  A: '#ef4458',
  B: '#f2c14e',
  C: '#58d8e3',
} as const;

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const tail = String(whole % 60).padStart(2, '0');
  return hours === 0
    ? `${minutes}:${tail}`
    : `${hours}:${String(minutes).padStart(2, '0')}:${tail}`;
}

export function WaveformSeek({
  waveform,
  duration,
  position,
  disabled,
  label,
  onCommit,
}: WaveformSeekProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerActive = useRef(false);
  const previewRef = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState<number>();
  const [canvasFailed, setCanvasFailed] = useState(false);
  const displayedPosition = preview ?? position;
  const visualWaveform = canvasFailed ? undefined : waveform;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || visualWaveform === undefined) return;
    const context = canvas.getContext('2d');
    if (context === null) {
      setCanvasFailed(true);
      return;
    }
    const ratio = Math.max(1, window.devicePixelRatio);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    const center = height / 2;
    const progress = duration === 0 ? 0 : displayedPosition / duration;
    for (const channel of ['A', 'B', 'C'] as const) {
      const peaks = visualWaveform[channel];
      context.strokeStyle = colors[channel];
      context.globalAlpha = 0.78;
      context.lineWidth = Math.max(1, ratio);
      context.beginPath();
      for (let bucket = 0; bucket < WAVEFORM_BUCKET_COUNT; bucket += 1) {
        const x = (bucket / (WAVEFORM_BUCKET_COUNT - 1)) * width;
        const minimum = (peaks[bucket * 2] ?? 0) / 127;
        const maximum = (peaks[bucket * 2 + 1] ?? 0) / 127;
        context.moveTo(x, center - maximum * center * 0.9);
        context.lineTo(x, center - minimum * center * 0.9);
      }
      context.stroke();
    }
    context.globalAlpha = 0.67;
    context.fillStyle = '#111318';
    context.fillRect(progress * width, 0, width, height);
    context.globalAlpha = 1;
    context.fillStyle = '#f6e7bd';
    context.fillRect(progress * width - ratio, 0, ratio * 2, height);
  }, [displayedPosition, duration, visualWaveform]);

  return (
    <div className="waveform-control">
      {visualWaveform === undefined ? (
        <p className="waveform-status">
          Waveform unavailable; using seek slider.
        </p>
      ) : (
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          aria-hidden="true"
        />
      )}
      <input
        className={
          visualWaveform === undefined ? 'seek-fallback' : 'waveform-range'
        }
        type="range"
        min={0}
        max={duration}
        step={0.01}
        value={Math.min(displayedPosition, duration)}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${formatTime(displayedPosition)} of ${formatTime(duration)}`}
        onPointerDown={() => {
          pointerActive.current = true;
          previewRef.current = position;
          setPreview(position);
        }}
        onPointerUp={() => {
          pointerActive.current = false;
          const committed = previewRef.current ?? position;
          previewRef.current = undefined;
          setPreview(undefined);
          onCommit(committed);
        }}
        onPointerCancel={() => {
          pointerActive.current = false;
          previewRef.current = undefined;
          setPreview(undefined);
        }}
        onInput={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (pointerActive.current) {
            previewRef.current = value;
            setPreview(value);
          } else onCommit(value);
        }}
        onKeyDown={(event) => {
          const keyChanges: Partial<Record<string, number>> = {
            ArrowLeft: -5,
            ArrowDown: -5,
            ArrowRight: 5,
            ArrowUp: 5,
            PageDown: -duration * 0.1,
            PageUp: duration * 0.1,
          };
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            onCommit(event.key === 'Home' ? 0 : duration);
            return;
          }
          const change = keyChanges[event.key];
          if (change !== undefined) {
            event.preventDefault();
            onCommit(Math.min(duration, Math.max(0, position + change)));
          }
        }}
      />
    </div>
  );
}
