import { useEffect, useRef } from 'react';

import type {
  ChannelId,
  ChannelVoices,
  PlaybackAdapter,
} from '../playback/contracts.ts';
import { channelPalette } from './channelPalette.ts';

export const PIANO_MIN_MIDI = 21; // A0
export const PIANO_MAX_MIDI = 108; // C8
export const PIANO_RELEASE_MS = 220;

const CHANNELS = ['A', 'B', 'C'] as const;
const PIANO_ATTACK_MS = 45;
const MINIMUM_VISIBLE_ENERGY = 0.02;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const WHITE_KEY_COUNT = 52;
const BLACK_KEY_WIDTH = (100 / WHITE_KEY_COUNT) * 0.62;
const EMPTY_VOICES: ChannelVoices = { A: null, B: null, C: null };

type PianoKey = {
  readonly midi: number;
  readonly black: boolean;
  readonly left: number;
  readonly width: number;
};

type VisualVoice = {
  readonly midi: number;
  readonly channel: ChannelId;
  readonly energy: number;
};

function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(midi % 12);
}

export const pianoKeys: readonly PianoKey[] = (() => {
  const keys: PianoKey[] = [];
  let whiteIndex = 0;
  for (let midi = PIANO_MIN_MIDI; midi <= PIANO_MAX_MIDI; midi += 1) {
    const black = isBlackKey(midi);
    if (black) {
      keys.push({
        midi,
        black,
        left: (whiteIndex / WHITE_KEY_COUNT) * 100 - BLACK_KEY_WIDTH / 2,
        width: BLACK_KEY_WIDTH,
      });
    } else {
      keys.push({
        midi,
        black,
        left: (whiteIndex / WHITE_KEY_COUNT) * 100,
        width: 100 / WHITE_KEY_COUNT,
      });
      whiteIndex += 1;
    }
  }
  return keys;
})();

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function advanceKeyEnergy(
  currentEnergy: number,
  signalAmplitude: number,
  elapsedMs: number,
): number {
  const energy = clamp(currentEnergy);
  const signal = clamp(signalAmplitude);
  const elapsed = Math.max(0, elapsedMs);
  if (signal > 0) {
    const target = 0.28 + Math.sqrt(signal) * 0.72;
    const attack = 1 - Math.exp(-elapsed / PIANO_ATTACK_MS);
    return clamp(Math.max(target * 0.32, energy + (target - energy) * attack));
  }
  // Four time constants reach the visibility threshold at approximately the
  // advertised release duration while retaining an exponential-looking tail.
  return energy * Math.exp((-4 * elapsed) / PIANO_RELEASE_MS);
}

function hexChannels(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function blendColor(background: string, foreground: string, amount: number) {
  const base = hexChannels(background);
  const color = hexChannels(foreground);
  const mix = clamp(amount);
  const channel = (index: 0 | 1 | 2) =>
    Math.round(base[index] + (color[index] - base[index]) * mix);
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

function activeKeyFill(voices: readonly VisualVoice[], black: boolean): string {
  const base = black ? '#111315' : '#cbc5b5';
  const activeColor = ({ channel, energy }: VisualVoice) =>
    blendColor(base, channelPalette[channel], 0.12 + energy * 0.88);
  const stops = voices.flatMap((voice, index) => {
    const start = (index / voices.length) * 100;
    const end = ((index + 1) / voices.length) * 100;
    return [`${activeColor(voice)} ${start}%`, `${activeColor(voice)} ${end}%`];
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function activeKeyGlow(voices: readonly VisualVoice[]): string {
  const strongest = voices.reduce((left, right) =>
    right.energy > left.energy ? right : left,
  );
  const [red, green, blue] = hexChannels(channelPalette[strongest.channel]);
  return `rgb(${red} ${green} ${blue} / ${clamp(strongest.energy * 0.72)})`;
}

type PianoKeyboardProps = {
  readonly adapter: Pick<PlaybackAdapter, 'getChannelVoices'> | undefined;
  readonly playing: boolean;
};

export function PianoKeyboard({ adapter, playing }: PianoKeyboardProps) {
  const keyRefs = useRef(new Map<number, HTMLSpanElement>());
  const lowRefs = useRef<Record<ChannelId, HTMLSpanElement | null>>({
    A: null,
    B: null,
    C: null,
  });
  const highRefs = useRef<Record<ChannelId, HTMLSpanElement | null>>({
    A: null,
    B: null,
    C: null,
  });
  const activeKeys = useRef(new Set<number>());
  const visualVoices = useRef(new Map<string, VisualVoice>());
  const previousSignature = useRef('');

  useEffect(() => {
    let frame = 0;
    let previousTime: number | undefined;
    const update = (now: number) => {
      const visuallyPlaying = playing && document.visibilityState !== 'hidden';
      const voices = visuallyPlaying
        ? (adapter?.getChannelVoices() ?? EMPTY_VOICES)
        : EMPTY_VOICES;
      const elapsed =
        previousTime === undefined ? 1000 / 60 : now - previousTime;
      previousTime = now;

      if (!visuallyPlaying) {
        visualVoices.current.clear();
      } else {
        const signals = new Map<
          string,
          {
            readonly midi: number;
            readonly channel: ChannelId;
            readonly amplitude: number;
          }
        >();
        for (const channel of CHANNELS) {
          const voice = voices[channel];
          if (voice === null) continue;
          const midi = Math.round(voice.midiNote);
          signals.set(`${channel}:${midi}`, {
            midi,
            channel,
            amplitude: voice.amplitude,
          });
        }

        for (const [id, visual] of visualVoices.current) {
          const signal = signals.get(id);
          const energy = advanceKeyEnergy(
            visual.energy,
            signal?.amplitude ?? 0,
            elapsed,
          );
          signals.delete(id);
          if (energy <= MINIMUM_VISIBLE_ENERGY) {
            visualVoices.current.delete(id);
          } else {
            visualVoices.current.set(id, { ...visual, energy });
          }
        }
        for (const [id, signal] of signals) {
          visualVoices.current.set(id, {
            midi: signal.midi,
            channel: signal.channel,
            energy: advanceKeyEnergy(0, signal.amplitude, elapsed),
          });
        }
      }

      const grouped = new Map<number, VisualVoice[]>();
      const lowEnergies = new Map<ChannelId, number>();
      const highEnergies = new Map<ChannelId, number>();
      for (const visual of visualVoices.current.values()) {
        const { midi, channel, energy } = visual;
        if (midi < PIANO_MIN_MIDI) {
          lowEnergies.set(
            channel,
            Math.max(lowEnergies.get(channel) ?? 0, energy),
          );
        } else if (midi > PIANO_MAX_MIDI) {
          highEnergies.set(
            channel,
            Math.max(highEnergies.get(channel) ?? 0, energy),
          );
        } else {
          const groupedVoices = grouped.get(midi) ?? [];
          groupedVoices.push(visual);
          grouped.set(midi, groupedVoices);
        }
      }
      for (const groupedVoices of grouped.values()) {
        groupedVoices.sort(
          (left, right) =>
            CHANNELS.indexOf(left.channel) - CHANNELS.indexOf(right.channel),
        );
      }
      const signature = [
        [...grouped]
          .sort(([left], [right]) => left - right)
          .map(
            ([midi, groupedVoices]) =>
              `${midi}:${groupedVoices.map(({ channel, energy }) => `${channel}${energy.toFixed(3)}`).join('')}`,
          )
          .join(','),
        CHANNELS.map(
          (channel) => lowEnergies.get(channel)?.toFixed(3) ?? '-',
        ).join(','),
        CHANNELS.map(
          (channel) => highEnergies.get(channel)?.toFixed(3) ?? '-',
        ).join(','),
      ].join('|');

      if (signature !== previousSignature.current) {
        for (const midi of activeKeys.current) {
          const key = keyRefs.current.get(midi);
          key?.classList.remove('is-active');
          key?.style.removeProperty('--key-active-fill');
          key?.style.removeProperty('--key-active-glow');
          if (key !== undefined) {
            delete key.dataset.channels;
            delete key.dataset.intensity;
          }
        }
        activeKeys.current.clear();
        for (const channel of CHANNELS) {
          lowRefs.current[channel]?.classList.remove('is-active');
          lowRefs.current[channel]?.style.removeProperty(
            '--overflow-intensity',
          );
          highRefs.current[channel]?.classList.remove('is-active');
          highRefs.current[channel]?.style.removeProperty(
            '--overflow-intensity',
          );
        }

        for (const channel of CHANNELS) {
          const low = lowEnergies.get(channel);
          const lowIndicator = lowRefs.current[channel];
          if (low !== undefined && lowIndicator !== null) {
            lowIndicator.style.setProperty('--overflow-intensity', `${low}`);
            lowIndicator.classList.add('is-active');
          }
          const high = highEnergies.get(channel);
          const highIndicator = highRefs.current[channel];
          if (high !== undefined && highIndicator !== null) {
            highIndicator.style.setProperty('--overflow-intensity', `${high}`);
            highIndicator.classList.add('is-active');
          }
        }

        for (const [midi, groupedVoices] of grouped) {
          const key = keyRefs.current.get(midi);
          if (key === undefined) continue;
          const intensity = Math.max(
            ...groupedVoices.map(({ energy }) => energy),
          );
          key.style.setProperty(
            '--key-active-fill',
            activeKeyFill(groupedVoices, isBlackKey(midi)),
          );
          key.style.setProperty(
            '--key-active-glow',
            activeKeyGlow(groupedVoices),
          );
          key.dataset.channels = groupedVoices
            .map(({ channel }) => channel)
            .join('');
          key.dataset.intensity = intensity.toFixed(3);
          key.classList.add('is-active');
          activeKeys.current.add(midi);
        }
        previousSignature.current = signature;
      }

      if (playing) frame = requestAnimationFrame(update);
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [adapter, playing]);

  const whiteKeys = pianoKeys.filter(({ black }) => !black);
  const blackKeys = pianoKeys.filter(({ black }) => black);
  const renderKey = ({ midi, black, left, width }: PianoKey) => (
    <span
      ref={(element) => {
        if (element === null) keyRefs.current.delete(midi);
        else keyRefs.current.set(midi, element);
      }}
      className={`piano-key piano-key-${black ? 'black' : 'white'}`}
      data-midi={midi}
      key={midi}
      style={{ left: `${left}%`, width: `${width}%` }}
    />
  );

  return (
    <div
      className="piano-visualizer"
      role="img"
      aria-label="Live notes on an 88-key piano for channels A, B, and C"
    >
      <div className="piano-keyboard-heading" aria-hidden="true" />
      <div className="piano-keyboard-row" aria-hidden="true">
        <span className="piano-overflow piano-overflow-low">
          {CHANNELS.map((channel) => (
            <i
              ref={(element) => {
                lowRefs.current[channel] = element;
              }}
              className={`channel-${channel.toLowerCase()}`}
              style={{
                background: channelPalette[channel],
                color: channelPalette[channel],
              }}
              key={channel}
            />
          ))}
        </span>
        <span className="piano-keybed">
          {whiteKeys.map(renderKey)}
          {blackKeys.map(renderKey)}
        </span>
        <span className="piano-overflow piano-overflow-high">
          {CHANNELS.map((channel) => (
            <i
              ref={(element) => {
                highRefs.current[channel] = element;
              }}
              className={`channel-${channel.toLowerCase()}`}
              style={{
                background: channelPalette[channel],
                color: channelPalette[channel],
              }}
              key={channel}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
