export const PLAYER_STORAGE_KEY = 'zx-spectrum-fm.player.v1';

export type PlayerPreferences = {
  readonly schemaVersion: 1;
  readonly selectedTrackId: string | null;
  readonly positionSeconds: number;
  readonly volume: number;
  readonly autoPlayNext: boolean;
  readonly shuffle: boolean;
};

export const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
  schemaVersion: 1,
  selectedTrackId: null,
  positionSeconds: 0,
  volume: 0.8,
  autoPlayNext: true,
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
    autoPlayNext:
      typeof value.autoPlayNext === 'boolean'
        ? value.autoPlayNext
        : DEFAULT_PLAYER_PREFERENCES.autoPlayNext,
    shuffle:
      typeof value.shuffle === 'boolean'
        ? value.shuffle
        : DEFAULT_PLAYER_PREFERENCES.shuffle,
  };
}

export function loadPlayerPreferences(
  storage: Pick<Storage, 'getItem'>,
  tracks: readonly TrackDuration[],
): PlayerPreferences {
  try {
    const stored = storage.getItem(PLAYER_STORAGE_KEY);
    return stored === null
      ? DEFAULT_PLAYER_PREFERENCES
      : parsePlayerPreferences(JSON.parse(stored) as unknown, tracks);
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
