import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestAudioContext } from '../test/audioContext.ts';
import * as engine from './engine.ts';
import { createProofRuntimeTrack } from './proofFixtures.ts';
import { ENGINE_SAMPLE_RATE } from './sampleRates.ts';
import { Ym2149PlaybackAdapter } from './Ym2149PlaybackAdapter.ts';

// Count engine reconstructions while keeping the real implementation. Rewinding
// renders deterministically from sample zero, so its cost grows with the target
// position; the guarantee under test is that it happens once, in `play`.
vi.mock('./engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine.ts')>();
  return {
    ...actual,
    createEnginePlayerAtSample: vi.fn(actual.createEnginePlayerAtSample),
  };
});

const reconstructions = () =>
  vi.mocked(engine.createEnginePlayerAtSample).mock.calls;

beforeAll(async () => {
  await engine.initializeYm2149(
    new Uint8Array(await readFile('vendor/ym2149/ym2149_wasm_bg.wasm')),
  );
});

describe('Ym2149PlaybackAdapter engine reconstruction', () => {
  it('does not rewind the engine on pause, stop, or a paused seek', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();
    const afterFirstPlay = reconstructions().length;

    clock.setCurrentTime(0.5);
    adapter.pause();
    expect(adapter.getSnapshot().status).toBe('paused');
    expect(reconstructions()).toHaveLength(afterFirstPlay);

    await adapter.seek(1);
    expect(adapter.getSnapshot().positionSeconds).toBe(1);
    expect(reconstructions()).toHaveLength(afterFirstPlay);

    adapter.stop();
    expect(adapter.getSnapshot().positionSeconds).toBe(0);
    expect(reconstructions()).toHaveLength(afterFirstPlay);

    adapter.dispose();
  });

  it('rewinds once when playback resumes at the recorded position', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();

    clock.setCurrentTime(0.5);
    adapter.pause();
    await adapter.seek(1.25);
    const beforeResume = reconstructions().length;

    await adapter.play();
    const calls = reconstructions();
    expect(calls).toHaveLength(beforeResume + 1);
    // Reconciled against the recorded position, not the further-ahead sample the
    // scheduler had already generated.
    expect(calls[calls.length - 1]?.[1]).toBe(
      Math.round(1.25 * ENGINE_SAMPLE_RATE),
    );
    expect(adapter.getSnapshot().status).toBe('playing');

    adapter.dispose();
  });

  it('skips the rewind when resuming exactly where the engine already sits', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);

    // A freshly loaded engine sits at zero, so starting at zero needs no rewind.
    const beforeFirstPlay = reconstructions().length;
    await adapter.play();
    expect(reconstructions()).toHaveLength(beforeFirstPlay);

    adapter.dispose();
  });

  it('reports rest until a scheduled chunk becomes audible', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();

    // Buffers are queued ahead of the playhead; levels must not run ahead of the
    // sound, matching the gate `getChannelVoices` applies.
    expect(adapter.getChannelLevels()).toEqual({ A: 0, B: 0, C: 0 });
    clock.setCurrentTime(0.02);
    expect(
      Object.values(adapter.getChannelLevels()).some((level) => level > 0),
    ).toBe(true);

    adapter.dispose();
  });
});
