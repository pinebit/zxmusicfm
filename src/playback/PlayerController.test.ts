import { describe, expect, it, vi } from 'vitest';

import type { GeneratedCatalog } from '../content/schemas.ts';
import type {
  ChannelOrder,
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
  readonly channelOrders: ChannelOrder[] = [];
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

  setChannelOrder(channelOrder: ChannelOrder): void {
    this.channelOrders.push(channelOrder);
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
  ) => Promise<Uint8Array<ArrayBuffer>>,
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

  it('applies a persisted channel order when creating the adapter and updates it live', async () => {
    const adapter = new FakeAdapter();
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, () => Promise.resolve(new Uint8Array([1]))),
    );
    controller.setChannelOrder('BAC');
    controller.playSelected();

    await vi.waitFor(() =>
      expect(controller.getSnapshot().status).toBe('playing'),
    );
    expect(adapter.channelOrders).toEqual(['BAC']);

    controller.setChannelOrder('ACB');
    expect(adapter.channelOrders).toEqual(['BAC', 'ACB']);
    expect(controller.getSnapshot().preferences.channelOrder).toBe('ACB');
    controller.dispose();
  });

  it('ignores a stale failure after a rapid newer selection succeeds', async () => {
    const first = deferred<Uint8Array<ArrayBuffer>>();
    const adapter = new FakeAdapter();
    const requested: string[] = [];
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, (url) => {
        requested.push(url);
        return url.includes('/one.')
          ? first.promise
          : Promise.resolve(new Uint8Array([2]));
      }),
    );

    // Wait until the first request is genuinely in flight, so superseding it
    // exercises stale-failure handling rather than cancelling before the fetch.
    controller.play('one');
    await vi.waitFor(() =>
      expect(requested.some((url) => url.includes('/one.'))).toBe(true),
    );
    controller.play('two');
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        status: 'playing',
        selectedTrackId: 'two',
      }),
    );

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

  it('ignores a stale completion after a rapid newer selection succeeds', async () => {
    const first = deferred<Uint8Array<ArrayBuffer>>();
    const adapter = new FakeAdapter();
    const requested: string[] = [];
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, (url) => {
        requested.push(url);
        return url.includes('/one.')
          ? first.promise
          : Promise.resolve(new Uint8Array([2]));
      }),
    );

    controller.play('one');
    await vi.waitFor(() =>
      expect(requested.some((url) => url.includes('/one.'))).toBe(true),
    );
    controller.play('two');
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        status: 'playing',
        selectedTrackId: 'two',
      }),
    );

    // A late success must not load over the newer track or move its position.
    first.resolve(new Uint8Array([1]));
    await flush();
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'playing',
      selectedTrackId: 'two',
      error: null,
    });
    expect(adapter.loads).toEqual(['two']);
    controller.dispose();
  });

  it('creates one adapter and one audio context for rapid selections', async () => {
    const created: FakeAdapter[] = [];
    const contexts: AudioContext[] = [];
    const engineImport = deferred<null>();
    const controller = new PlayerController(catalog, {
      storage: { getItem: () => null, setItem: () => undefined },
      fetchTrack: () => Promise.resolve(new Uint8Array([1])),
      requestPermission: () => {
        const context = {
          state: 'running',
          close: vi.fn(),
        } as unknown as AudioContext;
        contexts.push(context);
        return { context, ready: Promise.resolve() };
      },
      createAdapter: async () => {
        // Stand in for the dynamic engine import, holding both selections
        // inside adapter creation at the same time.
        await engineImport.promise;
        const adapter = new FakeAdapter();
        created.push(adapter);
        return adapter;
      },
    });

    controller.play('one');
    controller.play('two');
    engineImport.resolve(null);
    await vi.waitFor(() =>
      expect(controller.getSnapshot().status).toBe('playing'),
    );

    expect(created).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    controller.dispose();
  });

  it('plays again after an activate, dispose, activate remount cycle', async () => {
    const adapter = new FakeAdapter();
    const controller = new PlayerController(
      catalog,
      dependencies(adapter, () => Promise.resolve(new Uint8Array([1]))),
    );

    // React remounts effects without rebuilding the memoized controller.
    controller.activate()();
    const stop = controller.activate();

    controller.play('one');
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        status: 'playing',
        selectedTrackId: 'one',
      }),
    );
    stop();
  });

  it('coalesces scrubbed volume writes but persists discrete ones immediately', () => {
    const writes: string[] = [];
    const adapter = new FakeAdapter();
    const controller = new PlayerController(catalog, {
      ...dependencies(adapter, () => Promise.resolve(new Uint8Array([1]))),
      storage: {
        getItem: () => null,
        setItem: (_key, value) => writes.push(value),
      },
    });

    // A pointer drag publishes a value per move; those must not each hit storage.
    const beforeScrub = writes.length;
    for (let step = 1; step <= 20; step += 1) {
      controller.setVolume(step / 20, true);
    }
    expect(writes.length).toBe(beforeScrub);
    expect(controller.getSnapshot().preferences.volume).toBe(1);

    // A keypress, or the commit at the end of a drag, has to survive an
    // immediate reload without waiting for a timer or for `pagehide`.
    controller.setVolume(0.35);
    expect(writes.length).toBe(beforeScrub + 1);
    expect(JSON.parse(writes[writes.length - 1] ?? '{}')).toMatchObject({
      volume: 0.35,
    });

    controller.dispose();
  });

  it('flushes a pending scrubbed volume write on teardown', () => {
    const writes: string[] = [];
    const adapter = new FakeAdapter();
    const controller = new PlayerController(catalog, {
      ...dependencies(adapter, () => Promise.resolve(new Uint8Array([1]))),
      storage: {
        getItem: () => null,
        setItem: (_key, value) => writes.push(value),
      },
    });

    controller.setVolume(0.5, true);
    const beforeTeardown = writes.length;
    controller.dispose();
    expect(writes.length).toBe(beforeTeardown + 1);
    expect(JSON.parse(writes[writes.length - 1] ?? '{}')).toMatchObject({
      volume: 0.5,
    });
  });

  it('does not write preferences on teardown when nothing is pending', () => {
    const writes: string[] = [];
    const adapter = new FakeAdapter();
    const controller = new PlayerController(catalog, {
      ...dependencies(adapter, () => Promise.resolve(new Uint8Array([1]))),
      storage: {
        getItem: () => null,
        setItem: (_key, value) => writes.push(value),
      },
    });

    const beforeTeardown = writes.length;
    controller.dispose();
    expect(writes.length).toBe(beforeTeardown);
  });

  it('disposes the adapter and ignores completion during an active load', async () => {
    const request = deferred<Uint8Array<ArrayBuffer>>();
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
