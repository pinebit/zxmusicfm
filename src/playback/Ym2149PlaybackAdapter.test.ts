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
//
// These cases have to select vanilla explicitly. Studio is the default mode and
// its renderer seeks by replaying register writes, so under studio the engine is
// never rebuilt and every assertion below would hold for the wrong reason.
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
    adapter.setMode('vanilla');
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
    adapter.setMode('vanilla');
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
    adapter.setMode('vanilla');

    // A freshly loaded engine sits at zero, so starting at zero needs no rewind.
    const beforeFirstPlay = reconstructions().length;
    await adapter.play();
    expect(reconstructions()).toHaveLength(beforeFirstPlay);

    adapter.dispose();
  });

  it('does not rewind the engine when studio mode is the one playing', async () => {
    // Studio is the default, so its renderer is what `play` reconciles. The
    // engine must not be rebuilt for a mode nobody is listening to.
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    const before = reconstructions().length;

    await adapter.play();
    clock.setCurrentTime(0.5);
    adapter.pause();
    await adapter.seek(1.25);
    await adapter.play();

    expect(reconstructions()).toHaveLength(before);
    adapter.dispose();
  });

  it('reconstructs the engine only once when switching to vanilla mid-playback', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();
    const before = reconstructions().length;

    clock.setCurrentTime(0.2);
    adapter.setMode('vanilla');
    expect(reconstructions()).toHaveLength(before + 1);

    // Switching back needs no engine work at all; the synth seeks by replaying
    // register writes.
    adapter.setMode('studio');
    expect(reconstructions()).toHaveLength(before + 1);
    expect(adapter.getSnapshot().status).toBe('playing');

    adapter.dispose();
  });

  it('defers reconciliation when the mode changes while paused', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();
    clock.setCurrentTime(0.5);
    adapter.pause();
    const before = reconstructions().length;

    // Nothing is scheduled, so the switch itself must not rebuild anything.
    adapter.setMode('vanilla');
    expect(reconstructions()).toHaveLength(before);

    // `play` then reconciles exactly once, at the recorded position.
    await adapter.play();
    expect(reconstructions()).toHaveLength(before + 1);

    adapter.dispose();
  });

  it('ignores a switch to the mode already selected', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();
    const before = reconstructions().length;

    adapter.setMode('studio');
    adapter.setMode('studio');
    expect(reconstructions()).toHaveLength(before);

    adapter.dispose();
  });

  it('builds one chain per mode and only on demand', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();

    // Studio only: a listener who never leaves it must not pay for vanilla, and
    // a vanilla listener must not pay for the convolver.
    expect(clock.convolverCount()).toBe(1);

    adapter.setMode('vanilla');
    adapter.setMode('studio');
    adapter.setMode('vanilla');
    // Chains are memoized, so repeated switching never rebuilds either one.
    expect(clock.convolverCount()).toBe(1);

    adapter.dispose();
  });

  it('applies the track loudness match without clipping the output', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    const track = createProofRuntimeTrack();
    await adapter.load(
      { ...track, normalizationGainDb: 6 },
      new AbortController().signal,
    );
    await adapter.play();

    // A +6 dB match must appear as a linear gain of about 2 somewhere in the
    // chain, and it sits ahead of the limiter so the boost cannot leave the
    // output over full scale.
    expect(clock.gainValues().some((value) => Math.abs(value - 2) < 0.01)).toBe(
      true,
    );

    adapter.dispose();
  });

  it('reads the oscilloscope from the analysers of the active mode', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();

    // Studio's analysers sit after the per-channel processing, which is what
    // makes the lenses show the smoothed waveform rather than the raw chip edges.
    const studio = adapter.getOscilloscopeSamples();
    expect(Object.keys(studio)).toEqual(['A', 'B', 'C']);
    adapter.setMode('vanilla');
    expect(Object.keys(adapter.getOscilloscopeSamples())).toEqual([
      'A',
      'B',
      'C',
    ]);

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
