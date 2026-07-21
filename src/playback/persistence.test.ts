import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAYER_PREFERENCES,
  loadPlayerPreferences,
  parsePlayerPreferences,
  PLAYER_STORAGE_KEY,
  savePlayerPreferences,
} from './persistence.ts';

const tracks = [{ id: 'proof', durationSeconds: 2 }] as const;

describe('player persistence', () => {
  it('restores a selected track and clamps its position without restoring play', () => {
    const restored = parsePlayerPreferences(
      {
        schemaVersion: 1,
        selectedTrackId: 'proof',
        positionSeconds: 5,
        volume: 0.4,
        autoPlayNext: false,
        shuffle: true,
      },
      tracks,
    );

    expect(restored).toEqual({
      schemaVersion: 1,
      selectedTrackId: 'proof',
      positionSeconds: 2,
      volume: 0.4,
      autoPlayNext: false,
      shuffle: true,
    });
    expect(restored).not.toHaveProperty('playing');
  });

  it('validates version-one fields independently', () => {
    expect(
      parsePlayerPreferences(
        {
          schemaVersion: 1,
          selectedTrackId: 'proof',
          positionSeconds: 0.75,
          volume: 'loud',
          autoPlayNext: true,
          shuffle: false,
        },
        tracks,
      ),
    ).toMatchObject({
      selectedTrackId: 'proof',
      positionSeconds: 0.75,
      volume: 0.8,
    });
  });

  it('treats unavailable storage as best-effort', () => {
    const unavailable = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };

    expect(loadPlayerPreferences(unavailable, tracks)).toBe(
      DEFAULT_PLAYER_PREFERENCES,
    );
    expect(() =>
      savePlayerPreferences(unavailable, DEFAULT_PLAYER_PREFERENCES),
    ).not.toThrow();
  });

  it('writes the complete preference object under the stable key', () => {
    const values = new Map<string, string>();
    savePlayerPreferences(
      { setItem: (key, value) => values.set(key, value) },
      DEFAULT_PLAYER_PREFERENCES,
    );

    expect(JSON.parse(values.get(PLAYER_STORAGE_KEY) ?? '')).toEqual(
      DEFAULT_PLAYER_PREFERENCES,
    );
  });
});
