import { useState } from 'react';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelOrder, ChannelVoices } from '../playback/contracts.ts';
import {
  advanceKeyEnergy,
  pianoKeys,
  PianoKeyboard,
  PIANO_MAX_MIDI,
  PIANO_MIN_MIDI,
  PIANO_RELEASE_MS,
} from './PianoKeyboard.tsx';

afterEach(() => vi.restoreAllMocks());

function colorChannelSum(fill: string): number {
  const channels = fill.match(/\d+/g)?.slice(0, 3).map(Number);
  if (channels?.length !== 3) {
    throw new Error(`Expected an RGB color in "${fill}".`);
  }
  return channels.reduce((sum, channel) => sum + channel, 0);
}

describe('PianoKeyboard', () => {
  it('builds energy under signal and decays it after cutoff', () => {
    const firstPress = advanceKeyEnergy(0, 1, 16);
    const sustained = advanceKeyEnergy(firstPress, 1, 16);
    const released = advanceKeyEnergy(sustained, 0, 60);

    expect(firstPress).toBeGreaterThan(0);
    expect(sustained).toBeGreaterThan(firstPress);
    expect(released).toBeLessThan(sustained);
    expect(advanceKeyEnergy(sustained, 0, PIANO_RELEASE_MS)).toBeLessThan(0.02);
  });

  it('renders the conventional 88-key A0 through C8 range', () => {
    render(
      <PianoKeyboard
        adapter={undefined}
        playing={false}
        channelOrder="ABC"
        onChannelOrderChange={() => undefined}
      />,
    );

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

  it('cycles through the three stereo channel orders', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [channelOrder, setChannelOrder] = useState<ChannelOrder>('ABC');
      return (
        <PianoKeyboard
          adapter={undefined}
          playing={false}
          channelOrder={channelOrder}
          onChannelOrderChange={setChannelOrder}
        />
      );
    }
    render(<Harness />);

    await user.click(
      screen.getByRole('button', {
        name: 'Stereo channel order ABC; change to ACB',
      }),
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Stereo channel order ACB; change to BAC',
      }),
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Stereo channel order BAC; change to ABC',
      }),
    );

    expect(
      screen.getByRole('button', {
        name: 'Stereo channel order ABC; change to ACB',
      }),
    ).toHaveTextContent('A·B·C');
  });

  it('splits shared notes by channel and ignores out-of-range activity', () => {
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
      <PianoKeyboard
        adapter={adapter}
        playing={true}
        channelOrder="ABC"
        onChannelOrderChange={() => undefined}
      />,
    );

    act(() => nextFrame?.(0));
    const middleA = container.querySelector<HTMLElement>('[data-midi="69"]');
    expect(middleA).toHaveClass('is-active');
    expect(middleA).toHaveAttribute('data-channels', 'AB');
    expect(middleA?.style.getPropertyValue('--key-active-fill')).toContain(
      'linear-gradient',
    );
    expect(container.querySelector('.piano-overflow')).not.toBeInTheDocument();
    const initialIntensity = Number(middleA?.dataset.intensity);
    const initialColor = colorChannelSum(
      middleA?.style.getPropertyValue('--key-active-fill') ?? '',
    );

    act(() => nextFrame?.(16));
    const sustainedIntensity = Number(middleA?.dataset.intensity);
    const sustainedColor = colorChannelSum(
      middleA?.style.getPropertyValue('--key-active-fill') ?? '',
    );
    expect(sustainedIntensity).toBeGreaterThan(initialIntensity);
    expect(sustainedColor).toBeLessThan(initialColor);

    voices = { A: null, B: null, C: null };
    act(() => nextFrame?.(32));
    const releaseIntensity = Number(middleA?.dataset.intensity);
    const releaseColor = colorChannelSum(
      middleA?.style.getPropertyValue('--key-active-fill') ?? '',
    );
    expect(middleA).toHaveClass('is-active');
    expect(releaseIntensity).toBeLessThan(sustainedIntensity);
    expect(releaseColor).toBeGreaterThan(sustainedColor);

    act(() => nextFrame?.(PIANO_RELEASE_MS + 33));
    expect(middleA).not.toHaveClass('is-active');
  });
});
