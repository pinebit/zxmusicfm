import { useEffect, useRef, useState } from 'react';

import type { DecodedWaveform } from '../content/runtime.ts';
import { WAVEFORM_BUCKET_COUNT } from '../playback/waveform.ts';
import { channelPalette } from './channelPalette.ts';
import { formatTime } from './formatTime.ts';

type WaveformSeekProps = {
  readonly waveform: DecodedWaveform | undefined;
  readonly duration: number;
  readonly position: number;
  readonly showPosition: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onCommit: (seconds: number) => void;
};

const waveformPalette = {
  ...channelPalette,
  baseline: '#777d84',
  divider: '#34383d',
  playhead: '#f4e7c3',
  unplayed: '#111315',
} as const;

export function WaveformSeek({
  waveform,
  duration,
  position,
  showPosition,
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
    const progress = duration === 0 ? 0 : displayedPosition / duration;
    const channels = ['A', 'B', 'C'] as const;
    const laneHeight = height / channels.length;
    context.lineCap = 'round';
    for (const [index, channel] of channels.entries()) {
      const center = laneHeight * (index + 0.5);
      const amplitude = laneHeight * 0.38;
      if (index > 0) {
        context.globalAlpha = 1;
        context.strokeStyle = waveformPalette.divider;
        context.lineWidth = Math.max(1, ratio * 0.75);
        context.beginPath();
        context.moveTo(0, laneHeight * index);
        context.lineTo(width, laneHeight * index);
        context.stroke();
      }
      context.globalAlpha = 0.4;
      context.strokeStyle = waveformPalette.baseline;
      context.lineWidth = Math.max(1, ratio * 0.5);
      context.beginPath();
      context.moveTo(0, center);
      context.lineTo(width, center);
      context.stroke();

      const peaks = visualWaveform[channel];
      context.strokeStyle = waveformPalette[channel];
      context.globalAlpha = 0.9;
      context.lineWidth = Math.max(1, ratio);
      context.beginPath();
      for (let bucket = 0; bucket < WAVEFORM_BUCKET_COUNT; bucket += 1) {
        const x = (bucket / (WAVEFORM_BUCKET_COUNT - 1)) * width;
        const minimum = (peaks[bucket * 2] ?? 0) / 127;
        const maximum = (peaks[bucket * 2 + 1] ?? 0) / 127;
        context.moveTo(x, center - maximum * amplitude);
        context.lineTo(x, center - minimum * amplitude);
      }
      context.stroke();
    }
    context.globalAlpha = 0.67;
    context.fillStyle = waveformPalette.unplayed;
    context.fillRect(progress * width, 0, width, height);
    if (showPosition) {
      context.globalAlpha = 1;
      context.fillStyle = waveformPalette.playhead;
      context.fillRect(progress * width - ratio, 0, ratio * 2, height);
    }
  }, [displayedPosition, duration, showPosition, visualWaveform]);

  return (
    <div className="waveform-control">
      {visualWaveform === undefined ? (
        <p className="waveform-status">
          Waveform unavailable; using seek slider.
        </p>
      ) : (
        <canvas
          ref={canvasRef}
          className={`waveform-canvas${showPosition ? ' has-position' : ''}`}
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
