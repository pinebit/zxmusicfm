import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VolumeKnob } from './VolumeKnob.tsx';

describe('VolumeKnob', () => {
  it('maps volume onto the same 270-degree range as the knob pointer', () => {
    const { rerender } = render(
      <VolumeKnob value={0} disabled={false} onChange={vi.fn()} />,
    );
    const knob = screen.getByRole('slider', { name: 'Master volume' });

    expect(knob.style.getPropertyValue('--volume-turn')).toBe('-135deg');
    expect(knob.style.getPropertyValue('--volume-level-sweep')).toBe('0deg');

    rerender(<VolumeKnob value={50} disabled={false} onChange={vi.fn()} />);
    expect(knob.style.getPropertyValue('--volume-turn')).toBe('0deg');
    expect(knob.style.getPropertyValue('--volume-level-sweep')).toBe(
      '136.8deg',
    );

    rerender(<VolumeKnob value={100} disabled={false} onChange={vi.fn()} />);
    expect(knob.style.getPropertyValue('--volume-turn')).toBe('135deg');
    expect(knob.style.getPropertyValue('--volume-level-sweep')).toBe(
      '271.8deg',
    );
  });

  it('shows and describes a zero-volume muted state', () => {
    const { rerender } = render(
      <VolumeKnob value={0} disabled={false} onChange={vi.fn()} />,
    );
    const knob = screen.getByRole('slider', { name: 'Master volume' });
    // Queried as a live region that stays in the tree across both states, so
    // gaining the text is a change a screen reader can announce.
    const indicator = screen.getByRole('status');

    // The glyph is aria-hidden, so the description has to come from its twin.
    expect(indicator).toHaveTextContent('Muted');
    expect(knob).toHaveAccessibleDescription('Muted');

    rerender(<VolumeKnob value={1} disabled={false} onChange={vi.fn()} />);

    expect(indicator).toBeEmptyDOMElement();
    expect(knob).toHaveAccessibleDescription('');
  });

  it('treats a volume that rounds to zero as muted', () => {
    render(<VolumeKnob value={0.4} disabled={false} onChange={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Muted');
  });

  it('stays silent about mute while the knob is disabled', () => {
    render(<VolumeKnob value={0} disabled={true} onChange={vi.fn()} />);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(
      screen.getByRole('slider', { name: 'Master volume' }),
    ).toHaveAccessibleDescription('');
  });
});
