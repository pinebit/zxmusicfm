import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChannelMeters } from './ChannelMeters.tsx';

describe('ChannelMeters', () => {
  it.each([
    ['ABC', ['CH A', 'CH B', 'CH C']],
    ['ACB', ['CH A', 'CH C', 'CH B']],
    ['BAC', ['CH B', 'CH A', 'CH C']],
  ] as const)(
    'arranges %s as left, center, and right',
    (channelOrder, labels) => {
      const { container } = render(
        <ChannelMeters
          adapter={undefined}
          playing={false}
          channelOrder={channelOrder}
        />,
      );

      expect(
        [...container.querySelectorAll('.meter strong')].map(
          (label) => label.textContent,
        ),
      ).toEqual(labels);
      expect(
        screen.getByLabelText(
          `Channel ${channelOrder[0]} level, left stereo position`,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(
          `Channel ${channelOrder[1]} level, center stereo position`,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(
          `Channel ${channelOrder[2]} level, right stereo position`,
        ),
      ).toBeInTheDocument();
    },
  );
});
