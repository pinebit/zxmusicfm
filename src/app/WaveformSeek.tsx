import { useCallback, useEffect, useRef, useState } from 'react';

import type { DecodedWaveform } from '../content/runtime.ts';
import type { PlaybackAdapter } from '../playback/contracts.ts';
import { WAVEFORM_BUCKET_COUNT } from '../playback/waveform.ts';
import { channelPalette } from './channelPalette.ts';
import { formatTime } from './formatTime.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

type WaveformSeekProps = {
  readonly adapter?: Pick<PlaybackAdapter, 'getSnapshot'> | undefined;
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
  divider: '#34383d',
  playhead: '#f4e7c3',
  unplayed: '#111315',
} as const;

const CHANNELS = ['A', 'B', 'C'] as const;
const BAR_PITCH_CSS_PX = 4;
const BAR_WIDTH_CSS_PX = 2;
const BAR_END_ALPHA_HEX = '7a';
const BAR_CENTER_ALPHA_HEX = 'f2';

// The subset of the 2D context that lane drawing needs, so the same routine can
// target the visible canvas or an offscreen cache.
type LaneContext = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'createLinearGradient'
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
 * Groups the fixed-resolution peak data into a number of display bars. Averaging
 * each bar's peak magnitudes keeps broad changes in the song visible without
 * letting one transient make a whole visual interval look uniformly loud.
 */
export function aggregateWaveformBars(
  peaks: Int8Array,
  barCount: number,
): Float32Array {
  const bars = new Float32Array(barCount);
  for (let bar = 0; bar < barCount; bar += 1) {
    const start = Math.floor((bar * WAVEFORM_BUCKET_COUNT) / barCount);
    const end = Math.max(
      start + 1,
      Math.floor(((bar + 1) * WAVEFORM_BUCKET_COUNT) / barCount),
    );
    let magnitude = 0;
    for (let bucket = start; bucket < end; bucket += 1) {
      const minimum = peaks[bucket * 2] ?? 0;
      const maximum = peaks[bucket * 2 + 1] ?? 0;
      magnitude += Math.max(Math.abs(minimum), Math.abs(maximum)) / 127;
    }
    bars[bar] = magnitude / (end - start);
  }
  return bars;
}

export function waveformBarCount(width: number, ratio: number): number {
  const cssWidth = width / ratio;
  return Math.min(
    WAVEFORM_BUCKET_COUNT,
    Math.max(1, Math.floor(cssWidth / BAR_PITCH_CSS_PX)),
  );
}

/**
 * Draws responsive, spaced bars in three channel lanes. The static result is
 * cached whenever `OffscreenCanvas` exists so animation only redraws progress.
 */
function drawStaticLanes(
  target: LaneContext,
  width: number,
  height: number,
  ratio: number,
  waveform: DecodedWaveform,
): void {
  const laneHeight = height / CHANNELS.length;
  const barCount = waveformBarCount(width, ratio);
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
    const bars = aggregateWaveformBars(waveform[channel], barCount);
    const channelColor = waveformPalette[channel];
    const gradient = target.createLinearGradient(
      0,
      center - amplitude,
      0,
      center + amplitude,
    );
    gradient.addColorStop(0, `${channelColor}${BAR_END_ALPHA_HEX}`);
    gradient.addColorStop(0.5, `${channelColor}${BAR_CENTER_ALPHA_HEX}`);
    gradient.addColorStop(1, `${channelColor}${BAR_END_ALPHA_HEX}`);
    target.strokeStyle = gradient;
    target.globalAlpha = 1;
    target.lineWidth = BAR_WIDTH_CSS_PX * ratio;
    target.beginPath();
    for (let bar = 0; bar < barCount; bar += 1) {
      const x = ((bar + 0.5) / barCount) * width;
      const halfHeight = Math.max(ratio * 0.5, (bars[bar] ?? 0) * amplitude);
      target.moveTo(x, center - halfHeight);
      target.lineTo(x, center + halfHeight);
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
    },
    [duration, showPosition, visualWaveform],
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
