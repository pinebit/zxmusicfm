import { describe, expect, it, vi } from 'vitest';

import type { GeneratedCatalog } from '../content/schemas.ts';
import type {
  PlaybackAdapter,
  PlaybackAdapterListener,
  PlaybackAdapterSnapshot,
  RuntimeTrack,
} from './contracts.ts';
import { PlayerController } from './PlayerController.ts';

const digest = '0'.repeat(64);
const catalog: GeneratedCatalog = {
  schemaVersion: 1,
  waveforms: {
    url: `/generated/waveforms.${digest}.bin`,
    sha256: digest,
    byteLength: 24_608,
    formatVersion: 1,
    bucketCount: 2048,
    channelCount: 3,
  },
  tracks: ['one', 'two'].map((id, index) => ({
    id,
    order: index + 1,
    title: id,
    author: 'Test',
    sourceUrl: `https://example.com/${id}`,
    subsong: 1,
    sourceFormat: 'PSG',
    runtimeFormat: 'YM6',
    runtimeUrl: `/generated/tracks/${id}.${digest}.ym`,
    runtimeSha256: digest,
    runtimeByteLength: 1,
    durationSeconds: 2,
    durationSource: 'source',
    chipType: 'AY',
    chipClockHz: 1_773_400,
    frameRateHz: 50,
    channelLayout: 'ABC',
    waveformByteOffset: 32 + index * 12_288,
    waveformByteLength: 12_288,
  })),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeAdapter implements PlaybackAdapter {
  snapshot: PlaybackAdapterSnapshot = {
    status: 'ready',
    positionSeconds: 0,
    durationSeconds: 0,
  };
  readonly loads: string[] = [];
  readonly listeners = new Set<PlaybackAdapterListener>();
  readonly dispose = vi.fn();

  load(track: RuntimeTrack): Promise<void> {
    this.loads.push(track.id);
    this.snapshot = {
      status: 'ready',
      positionSeconds: 0,
      durationSeconds: track.durationSeconds,
    };
    return Promise.resolve();
  }

  play(): Promise<void> {
    this.snapshot = { ...this.snapshot, status: 'playing' };
    return Promise.resolve();
  }

  pause(): void {
    this.snapshot = { ...this.snapshot, status: 'paused' };
  }

  stop(): void {
    this.snapshot = { ...this.snapshot, status: 'ready', positionSeconds: 0 };
  }

  seek(positionSeconds: number): Promise<void> {
    this.snapshot = { ...this.snapshot, positionSeconds };
    return Promise.resolve();
  }

  setVolume(volume: number): void {
    void volume;
  }

  getChannelLevels() {
    return { A: 0, B: 0, C: 0 } as const;
  }

  getChannelVoices() {
    return { A: null, B: null, C: null } as const;
  }

  renderOffline(): Promise<never> {
    throw new Error('Not used by controller tests.');
  }

  getSnapshot(): PlaybackAdapterSnapshot {
    return this.snapshot;
  }

  subscribe(listener: PlaybackAdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function dependencies(
  adapter: FakeAdapter,
  fetchTrack: (
    url: string,
    byteLength: number,
    sha256: string,
    signal: AbortSignal,
    label: string,
  ) => Promise<Uint8Array>,
) {
  const context = {
    state: 'running',
    close: vi.fn(),
  } as unknown as AudioContext;
  return {
    storage: { getItem: () => null, setItem: () => undefined },
    fetchTrack,
    requestPermission: () => ({ context, ready: Promise.resolve() }),
    createAdapter: () => Promise.resolve(adapter),
  };
}

describe('PlayerController async ownership', () => {
  it('plays the first catalog track when no track was previously selected', async () => {
    const adapter = new FakeAdapter();
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, () => Promise.resolve(new Uint8Array([1]))),
    );

    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      selectedTrackId: null,
    });

    controller.playSelected();

    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        status: 'playing',
        selectedTrackId: 'one',
      });
    });
    expect(adapter.loads).toEqual(['one']);
    controller.dispose();
  });

  it('ignores a stale failure after a rapid newer selection succeeds', async () => {
    const first = deferred<Uint8Array>();
    const adapter = new FakeAdapter();
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, (url) =>
        url.includes('/one.')
          ? first.promise
          : Promise.resolve(new Uint8Array([2])),
      ),
    );

    controller.play('one');
    await flush();
    controller.play('two');
    await flush();
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'playing',
      selectedTrackId: 'two',
    });

    first.reject(new Error('late request failure'));
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'playing',
      selectedTrackId: 'two',
      error: null,
    });
    expect(adapter.loads).toEqual(['two']);
    controller.dispose();
  });

  it('disposes the adapter and ignores completion during an active load', async () => {
    const request = deferred<Uint8Array>();
    const adapter = new FakeAdapter();
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, () => request.promise),
    );

    controller.play('one');
    await flush();
    controller.dispose();
    request.resolve(new Uint8Array([1]));
    await flush();

    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(adapter.loads).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loading',
      selectedTrackId: 'one',
    });
  });
});
