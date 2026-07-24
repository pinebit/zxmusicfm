import { useCallback, useEffect, useRef, useState } from 'react';

import type { DecodedWaveform } from '../content/runtime.ts';
import type { PlaybackAdapter } from '../playback/contracts.ts';
import { WAVEFORM_BUCKET_COUNT } from '../playback/waveform.ts';
import { channelPalette } from './channelPalette.ts';
import { formatTime } from './formatTime.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

type WaveformSeekProps = {
  readonly adapter?:
    Pick<PlaybackAdapter, 'getSnapshot' | 'getOscilloscopeSamples'> | undefined;
  readonly playing?: boolean;
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
  lensBackground: '#0b0d0f',
  lensBorder: '#c9a956',
} as const;

const CHANNELS = ['A', 'B', 'C'] as const;

// The subset of the 2D context that lane drawing needs, so the same routine can
// target the visible canvas or an offscreen cache.
type LaneContext = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'globalAlpha'
  | 'lineCap'
  | 'lineTo'
  | 'lineWidth'
  | 'moveTo'
  | 'stroke'
  | 'strokeStyle'
>;

type StaticLayer = {
  readonly surface: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  readonly waveform: DecodedWaveform;
};

/**
 * Draws the three channel lanes: divider, baseline, and 2,048 peak segments per
 * channel. That is ~6,100 stroked segments, far too much to repeat per frame
 * just to move a playhead, so it is cached whenever `OffscreenCanvas` exists.
 */
function drawStaticLanes(
  target: LaneContext,
  width: number,
  height: number,
  ratio: number,
  waveform: DecodedWaveform,
): void {
  const laneHeight = height / CHANNELS.length;
  target.lineCap = 'round';
  for (const [index, channel] of CHANNELS.entries()) {
    const center = laneHeight * (index + 0.5);
    const amplitude = laneHeight * 0.38;
    if (index > 0) {
      target.globalAlpha = 1;
      target.strokeStyle = waveformPalette.divider;
      target.lineWidth = Math.max(1, ratio * 0.75);
      target.beginPath();
      target.moveTo(0, laneHeight * index);
      target.lineTo(width, laneHeight * index);
      target.stroke();
    }
    target.globalAlpha = 0.4;
    target.strokeStyle = waveformPalette.baseline;
    target.lineWidth = Math.max(1, ratio * 0.5);
    target.beginPath();
    target.moveTo(0, center);
    target.lineTo(width, center);
    target.stroke();

    const peaks = waveform[channel];
    target.strokeStyle = waveformPalette[channel];
    target.globalAlpha = 0.9;
    target.lineWidth = Math.max(1, ratio);
    target.beginPath();
    for (let bucket = 0; bucket < WAVEFORM_BUCKET_COUNT; bucket += 1) {
      const x = (bucket / (WAVEFORM_BUCKET_COUNT - 1)) * width;
      const minimum = (peaks[bucket * 2] ?? 0) / 127;
      const maximum = (peaks[bucket * 2 + 1] ?? 0) / 127;
      target.moveTo(x, center - maximum * amplitude);
      target.lineTo(x, center - minimum * amplitude);
    }
    target.stroke();
  }
}

function createStaticLayer(
  width: number,
  height: number,
  ratio: number,
  waveform: DecodedWaveform,
): StaticLayer | undefined {
  if (typeof OffscreenCanvas !== 'function') return undefined;
  try {
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d');
    if (context === null) return undefined;
    drawStaticLanes(context, width, height, ratio, waveform);
    return { surface, width, height, waveform };
  } catch {
    // Any offscreen failure just means drawing the lanes inline instead.
    return undefined;
  }
}

export function WaveformSeek({
  adapter,
  playing = false,
  waveform,
  duration,
  position,
  showPosition,
  disabled,
  label,
  onCommit,
}: WaveformSeekProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const hoverMarkerRef = useRef<HTMLSpanElement>(null);
  const pointerActive = useRef(false);
  const previewRef = useRef<number | undefined>(undefined);
  const staticLayer = useRef<StaticLayer | undefined>(undefined);
  const [preview, setPreview] = useState<number>();
  const [canvasFailed, setCanvasFailed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const displayedPosition = preview ?? position;
  const visualWaveform = canvasFailed ? undefined : waveform;
  // Under reduced motion the playhead still tracks the coarse position updates
  // the controller publishes; only the per-frame loop stands down.
  const animating =
    showPosition && playing && preview === undefined && !reducedMotion;

  // Latest position for the animation loop and the resize callback, so a new
  // coarse position does not tear down and rebuild them four times a second.
  const positionRef = useRef(displayedPosition);
  useEffect(() => {
    positionRef.current = displayedPosition;
  }, [displayedPosition]);

  const drawWaveform = useCallback(
    (currentPosition: number) => {
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
      const progress = Math.min(
        1,
        Math.max(0, duration === 0 ? 0 : currentPosition / duration),
      );

      const cached = staticLayer.current;
      const usable =
        cached?.width === width &&
        cached.height === height &&
        cached.waveform === visualWaveform
          ? cached
          : createStaticLayer(width, height, ratio, visualWaveform);
      staticLayer.current = usable;
      if (usable === undefined) {
        drawStaticLanes(context, width, height, ratio, visualWaveform);
      } else {
        context.globalAlpha = 1;
        context.drawImage(usable.surface, 0, 0);
      }

      context.lineCap = 'round';
      context.globalAlpha = 0.67;
      context.fillStyle = waveformPalette.unplayed;
      context.fillRect(progress * width, 0, width - progress * width, height);
      if (!showPosition) return;

      context.globalAlpha = 1;
      context.fillStyle = waveformPalette.playhead;
      context.fillRect(progress * width - ratio, 0, ratio * 2, height);

      const lensSize = Math.min(height, width);
      const lensX = Math.min(
        width - lensSize,
        Math.max(0, progress * width - lensSize / 2),
      );
      const lensY = 0;
      const lensLaneHeight = lensSize / CHANNELS.length;
      const oscilloscopeSamples = adapter?.getOscilloscopeSamples?.();

      context.save();
      context.globalAlpha = 1;
      context.shadowColor = 'rgb(0 0 0 / 55%)';
      context.shadowBlur = ratio * 4;
      context.fillStyle = waveformPalette.lensBackground;
      context.fillRect(lensX, lensY, lensSize, lensSize);
      context.restore();

      context.save();
      context.beginPath();
      context.rect(lensX, lensY, lensSize, lensSize);
      context.clip();

      for (const [index, channel] of CHANNELS.entries()) {
        const center = lensY + lensLaneHeight * (index + 0.5);
        const amplitude = lensLaneHeight * 0.37;
        if (index > 0) {
          context.globalAlpha = 1;
          context.strokeStyle = waveformPalette.divider;
          context.lineWidth = Math.max(1, ratio * 0.75);
          context.beginPath();
          context.moveTo(lensX, lensY + lensLaneHeight * index);
          context.lineTo(lensX + lensSize, lensY + lensLaneHeight * index);
          context.stroke();
        }

        context.globalAlpha = 0.45;
        context.strokeStyle = waveformPalette.baseline;
        context.lineWidth = Math.max(1, ratio * 0.5);
        context.beginPath();
        context.moveTo(lensX, center);
        context.lineTo(lensX + lensSize, center);
        context.stroke();

        const samples = oscilloscopeSamples?.[channel];
        if (samples !== undefined) {
          const sampleCount = Math.min(256, samples.length);
          const latestStart = samples.length - sampleCount;
          const triggerSearchStart = Math.max(1, latestStart - sampleCount);
          let sampleStart = latestStart;
          for (
            let sample = triggerSearchStart;
            sample <= latestStart;
            sample += 1
          ) {
            const previous = samples[sample - 1] ?? 0;
            const current = samples[sample] ?? 0;
            if (previous <= 0 && current > 0) {
              sampleStart = sample;
              break;
            }
          }
          context.globalAlpha = 1;
          context.strokeStyle = waveformPalette[channel];
          context.lineWidth = Math.max(1, ratio);
          context.beginPath();
          for (let sample = 0; sample < sampleCount; sample += 1) {
            const x = lensX + (sample / (sampleCount - 1)) * lensSize;
            const value = samples[sampleStart + sample] ?? 0;
            const y = center - value * amplitude;
            if (sample === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.stroke();
        }
      }

      const lensPlayheadX = Math.min(
        lensX + lensSize,
        Math.max(lensX, progress * width),
      );
      context.globalAlpha = 1;
      context.fillStyle = waveformPalette.playhead;
      context.fillRect(
        lensPlayheadX - ratio * 0.75,
        lensY,
        ratio * 1.5,
        lensSize,
      );
      context.restore();

      context.globalAlpha = 1;
      context.strokeStyle = waveformPalette.lensBorder;
      context.lineWidth = Math.max(1, ratio);
      context.strokeRect(
        lensX + ratio * 0.5,
        lensY + ratio * 0.5,
        lensSize - ratio,
        lensSize - ratio,
      );
    },
    [adapter, duration, showPosition, visualWaveform],
  );

  // Redraw when the rendered size changes, including after the track list is
  // restored on fullscreen exit. Never refetches waveform data.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || visualWaveform === undefined) return;
    const observer = new ResizeObserver(() => {
      drawWaveform(positionRef.current);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawWaveform, visualWaveform]);

  // Draw on mount, whenever the static inputs change, and on each coarse
  // position update while no animation loop owns the canvas.
  useEffect(() => {
    if (animating) return;
    drawWaveform(displayedPosition);
  }, [animating, displayedPosition, drawWaveform]);

  useEffect(() => {
    if (!animating) return;
    const startedAt = performance.now();
    const positionAtStart = positionRef.current;
    let frame = 0;
    const animate = (now: number) => {
      drawWaveform(
        adapter?.getSnapshot().positionSeconds ??
          Math.min(duration, positionAtStart + (now - startedAt) / 1_000),
      );
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [adapter, animating, drawWaveform, duration]);

  const positionHoverMarker = (clientX: number) => {
    const range = rangeRef.current;
    const marker = hoverMarkerRef.current;
    if (disabled || range === null || marker === null) return;
    const bounds = range.getBoundingClientRect();
    const x = Math.min(
      Math.max(0, bounds.width - 1),
      Math.max(0, clientX - bounds.left),
    );
    marker.style.transform = `translateX(${x}px)`;
    marker.style.opacity = '1';
  };

  const hideHoverMarker = () => {
    const marker = hoverMarkerRef.current;
    if (marker !== null) marker.style.opacity = '0';
  };

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
      {visualWaveform === undefined ? null : (
        <span
          ref={hoverMarkerRef}
          className="waveform-hover-marker"
          aria-hidden="true"
        />
      )}
      <input
        ref={rangeRef}
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
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') {
            positionHoverMarker(event.clientX);
          }
        }}
        onPointerMove={(event) => {
          if (event.pointerType === 'mouse') {
            positionHoverMarker(event.clientX);
          }
        }}
        onPointerLeave={hideHoverMarker}
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
