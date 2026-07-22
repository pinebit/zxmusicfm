import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelVoices } from '../playback/contracts.ts';
import {
  advanceKeyEnergy,
  pianoKeys,
  PianoKeyboard,
  PIANO_MAX_MIDI,
  PIANO_MIN_MIDI,
  PIANO_RELEASE_MS,
} from './PianoKeyboard.tsx';

afterEach(() => vi.restoreAllMocks());

describe('PianoKeyboard', () => {
  it('builds brightness under signal and decays it after cutoff', () => {
    const firstPress = advanceKeyEnergy(0, 1, 16);
    const sustained = advanceKeyEnergy(firstPress, 1, 16);
    const released = advanceKeyEnergy(sustained, 0, 60);

    expect(firstPress).toBeGreaterThan(0);
    expect(sustained).toBeGreaterThan(firstPress);
    expect(released).toBeLessThan(sustained);
    expect(advanceKeyEnergy(sustained, 0, PIANO_RELEASE_MS)).toBeLessThan(0.02);
  });

  it('renders the conventional 88-key A0 through C8 range', () => {
    render(<PianoKeyboard adapter={undefined} playing={false} />);

    expect(
      screen.getByRole('img', {
        name: 'Live notes on an 88-key piano for channels A, B, and C',
      }),
    ).toBeInTheDocument();
    expect(pianoKeys).toHaveLength(88);
    expect(pianoKeys[0]?.midi).toBe(PIANO_MIN_MIDI);
    expect(pianoKeys.at(-1)?.midi).toBe(PIANO_MAX_MIDI);
    expect(pianoKeys.filter(({ black }) => !black)).toHaveLength(52);
    expect(pianoKeys.filter(({ black }) => black)).toHaveLength(36);
  });

  it('splits shared notes by channel and marks out-of-range activity', () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(
      () => undefined,
    );
    let voices: ChannelVoices = {
      A: { midiNote: 69, amplitude: 1 },
      B: { midiNote: 69, amplitude: 0.5 },
      C: { midiNote: 120, amplitude: 0.75 },
    };
    const adapter = { getChannelVoices: () => voices };
    const { container } = render(
      <PianoKeyboard adapter={adapter} playing={true} />,
    );

    act(() => nextFrame?.(0));
    const middleA = container.querySelector<HTMLElement>('[data-midi="69"]');
    expect(middleA).toHaveClass('is-active');
    expect(middleA).toHaveAttribute('data-channels', 'AB');
    expect(middleA?.style.getPropertyValue('--key-active-fill')).toContain(
      'linear-gradient',
    );
    expect(
      container.querySelector('.piano-overflow-high .channel-c'),
    ).toHaveClass('is-active');
    const initialIntensity = Number(middleA?.dataset.intensity);

    act(() => nextFrame?.(16));
    const sustainedIntensity = Number(middleA?.dataset.intensity);
    expect(sustainedIntensity).toBeGreaterThan(initialIntensity);

    voices = { A: null, B: null, C: null };
    act(() => nextFrame?.(32));
    const releaseIntensity = Number(middleA?.dataset.intensity);
    expect(middleA).toHaveClass('is-active');
    expect(releaseIntensity).toBeLessThan(sustainedIntensity);
    expect(
      container.querySelector('.piano-overflow-high .channel-c'),
    ).toHaveClass('is-active');

    act(() => nextFrame?.(PIANO_RELEASE_MS + 33));
    expect(middleA).not.toHaveClass('is-active');
    expect(
      container.querySelector('.piano-overflow-high .channel-c'),
    ).not.toHaveClass('is-active');
  });
});
