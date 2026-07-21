export const PLAYER_STORAGE_KEY = 'zxmusicfm.player.v1';
const PREVIOUS_PLAYER_STORAGE_KEY = ['zx', 'spectrum', 'fm.player.v1'].join(
  '-',
);

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'> &
  Partial<Pick<Storage, 'removeItem'>>;

export type PlayerPreferences = {
  readonly schemaVersion: 1;
  readonly selectedTrackId: string | null;
  readonly positionSeconds: number;
  readonly volume: number;
  readonly shuffle: boolean;
};

export const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
  schemaVersion: 1,
  selectedTrackId: null,
  positionSeconds: 0,
  volume: 0.8,
  shuffle: false,
};

type TrackDuration = {
  readonly id: string;
  readonly durationSeconds: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteRange(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

export function parsePlayerPreferences(
  value: unknown,
  tracks: readonly TrackDuration[],
): PlayerPreferences {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return DEFAULT_PLAYER_PREFERENCES;
  }

  const requestedTrackId =
    typeof value.selectedTrackId === 'string'
      ? value.selectedTrackId
      : value.selectedTrackId === null
        ? null
        : DEFAULT_PLAYER_PREFERENCES.selectedTrackId;
  const track = tracks.find(({ id }) => id === requestedTrackId);
  const selectedTrackId = track?.id ?? null;
  const positionSeconds =
    track === undefined
      ? 0
      : Math.min(
          finiteRange(value.positionSeconds, 0, Infinity, 0),
          track.durationSeconds,
        );

  return {
    schemaVersion: 1,
    selectedTrackId,
    positionSeconds,
    volume: finiteRange(value.volume, 0, 1, DEFAULT_PLAYER_PREFERENCES.volume),
    shuffle:
      typeof value.shuffle === 'boolean'
        ? value.shuffle
        : DEFAULT_PLAYER_PREFERENCES.shuffle,
  };
}

export function loadPlayerPreferences(
  storage: PreferenceStorage,
  tracks: readonly TrackDuration[],
): PlayerPreferences {
  try {
    const current = storage.getItem(PLAYER_STORAGE_KEY);
    if (current !== null) {
      return parsePlayerPreferences(JSON.parse(current) as unknown, tracks);
    }

    const previous = storage.getItem(PREVIOUS_PLAYER_STORAGE_KEY);
    if (previous === null) return DEFAULT_PLAYER_PREFERENCES;
    const preferences = parsePlayerPreferences(
      JSON.parse(previous) as unknown,
      tracks,
    );
    storage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(preferences));
    storage.removeItem?.(PREVIOUS_PLAYER_STORAGE_KEY);
    return preferences;
  } catch {
    return DEFAULT_PLAYER_PREFERENCES;
  }
}

export function savePlayerPreferences(
  storage: Pick<Storage, 'setItem'>,
  preferences: PlayerPreferences,
): void {
  try {
    storage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Persistence is best-effort and must never block playback.
  }
}
