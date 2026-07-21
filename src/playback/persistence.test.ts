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

  it('migrates preferences saved under the former project-name key', () => {
    const previousKey = ['zx', 'spectrum', 'fm.player.v1'].join('-');
    const values = new Map([
      [
        previousKey,
        JSON.stringify({
          ...DEFAULT_PLAYER_PREFERENCES,
          volume: 0.35,
          shuffle: true,
        }),
      ],
    ]);

    expect(
      loadPlayerPreferences(
        {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
          removeItem: (key) => values.delete(key),
        },
        tracks,
      ),
    ).toMatchObject({ volume: 0.35, shuffle: true });
    expect(values.has(previousKey)).toBe(false);
    expect(values.has(PLAYER_STORAGE_KEY)).toBe(true);
  });
});
