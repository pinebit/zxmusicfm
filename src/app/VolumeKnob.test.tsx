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
});
