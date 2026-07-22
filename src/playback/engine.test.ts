import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { applyChipAmplitudeModel } from './chipModel.ts';
import type { RuntimeTrack } from './contracts.ts';
import {
  createEnginePlayer,
  createEnginePlayerAtSample,
  ENGINE_SAMPLE_RATE,
  type EnginePlayer,
  frequencyToMidiNote,
  generateEngineChannels,
  getEngineChannelVoices,
  initializeYm2149,
} from './engine.ts';
import { createYm6, parsePsg, parseYm6, selectAySubsong } from './formats.ts';
import {
  captureSyntheticAyAsYm6,
  createProofRuntimeTrack,
  createSyntheticAy,
} from './proofFixtures.ts';
import { Ym2149PlaybackAdapter } from './Ym2149PlaybackAdapter.ts';
import { encodeWaveformPayload, WAVEFORM_BYTES_PER_TRACK } from './waveform.ts';

function maximumDifference(left: Float32Array, right: Float32Array): number {
  expect(left.length).toBe(right.length);
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)),
    );
  }
  return maximum;
}

async function fixtureBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function createTestAudioContext(): {
  readonly context: AudioContext;
  setCurrentTime(value: number): void;
} {
  let currentTime = 0;
  const audioNode = () => ({ connect: vi.fn() });
  const context = {
    state: 'running',
    destination: audioNode(),
    get currentTime() {
      return currentTime;
    },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    createGain: vi.fn(() => ({ ...audioNode(), gain: { value: 1 } })),
    createBiquadFilter: vi.fn(() => ({
      ...audioNode(),
      type: 'lowpass',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0 },
    })),
    createDynamicsCompressor: vi.fn(() => ({
      ...audioNode(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
    createBuffer: vi.fn((_channels: number, length: number) => {
      const data = [new Float32Array(length), new Float32Array(length)];
      return { getChannelData: (channel: number) => data[channel] };
    }),
    createBufferSource: vi.fn(() => ({
      ...audioNode(),
      buffer: null,
      addEventListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
  } as unknown as AudioContext;
  return {
    context,
    setCurrentTime(value: number) {
      currentTime = value;
    },
  };
}

beforeAll(async () => {
  await initializeYm2149(
    await fixtureBytes('vendor/ym2149/ym2149_wasm_bg.wasm'),
  );
});

describe('pinned ym2149-rs engine', () => {
  it('converts and validates per-channel tone voices', () => {
    expect(frequencyToMidiNote(27.5)).toBe(21);
    expect(frequencyToMidiNote(440)).toBe(69);
    expect(frequencyToMidiNote(4_186.01)).toBe(108);
    expect(frequencyToMidiNote(0)).toBeNull();

    const player = {
      getChannelStates: () => ({
        channels: [
          { frequency: 440, amplitude: 1, toneEnabled: true },
          { frequency: 220, amplitude: 0, toneEnabled: true },
          { frequency: 110, amplitude: 1, toneEnabled: false },
        ],
      }),
    } as unknown as EnginePlayer;
    expect(getEngineChannelVoices(player)).toEqual({
      A: { midiNote: 69, amplitude: 1 },
      B: null,
      C: null,
    });
  });

  it('publishes voices only when their scheduled audio is audible', async () => {
    const clock = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(clock.context);
    await adapter.load(createProofRuntimeTrack(), new AbortController().signal);
    await adapter.play();

    expect(adapter.getChannelVoices()).toEqual({
      A: null,
      B: null,
      C: null,
    });
    clock.setCurrentTime(0.02);
    expect(
      Object.values(adapter.getChannelVoices()).some((voice) => voice !== null),
    ).toBe(true);

    adapter.pause();
    expect(adapter.getChannelVoices()).toEqual({
      A: null,
      B: null,
      C: null,
    });
    adapter.dispose();
  });

  it('selects distinct pinned AY and YM nonlinear amplitude models', () => {
    const ymFixedMaximum = 9_184 / 10_922;
    expect(applyChipAmplitudeModel(ymFixedMaximum, 'YM')).toBe(ymFixedMaximum);
    expect(applyChipAmplitudeModel(ymFixedMaximum, 'AY')).toBe(1);
    expect(applyChipAmplitudeModel(-ymFixedMaximum, 'AY')).toBe(-1);
  });

  it('produces genuine A/B/C output and a complete 48 kHz waveform render', async () => {
    const track = createProofRuntimeTrack();
    const adapter = new Ym2149PlaybackAdapter();
    const render = await adapter.renderOffline(
      track,
      new AbortController().signal,
    );

    expect(render.sampleRate).toBe(48_000);
    expect(render.mix).toHaveLength(96_000);
    for (const channel of ['A', 'B', 'C'] as const) {
      expect(
        render.channels[channel].some((sample) => Math.abs(sample) > 0.001),
      ).toBe(true);
    }
    const waveform = encodeWaveformPayload(render);
    expect(waveform).toHaveLength(WAVEFORM_BYTES_PER_TRACK);
    expect(new Int8Array(waveform.buffer)).not.toContain(-128);
    adapter.dispose();
  });

  it('reconstructs an exact seek while the upstream native seek loses phase', () => {
    const track = createProofRuntimeTrack();
    const targetSample = ENGINE_SAMPLE_RATE;
    const windowSamples = ENGINE_SAMPLE_RATE / 2;

    const uninterrupted = createEnginePlayer(track.bytes);
    uninterrupted.play();
    generateEngineChannels(uninterrupted, targetSample);
    const expected = generateEngineChannels(
      uninterrupted,
      windowSamples,
    ).channels;

    const nativeSeek = createEnginePlayer(track.bytes);
    nativeSeek.seek_to_frame(track.frameRateHz);
    nativeSeek.play();
    const native = generateEngineChannels(nativeSeek, windowSamples).channels;

    const reconstructed = createEnginePlayerAtSample(track.bytes, targetSample);
    const actual = generateEngineChannels(
      reconstructed,
      windowSamples,
    ).channels;

    expect(maximumDifference(expected, native)).toBeGreaterThan(0.1);
    expect(maximumDifference(expected, actual)).toBe(0);
    uninterrupted.free();
    nativeSeek.free();
    reconstructed.free();
  });

  it.each([
    ['finite', false, 50],
    ['looping with explicit override', true, 75],
  ] as const)(
    'captures a %s AY fixture into equivalent finite YM6',
    async (_name, looping, frameCount) => {
      const ay = createSyntheticAy(looping);
      const ym = await captureSyntheticAyAsYm6(ay, frameCount);
      expect(parseYm6(ym).frames).toHaveLength(frameCount);

      for (const isolatedChannel of [null, 0, 1, 2] as const) {
        const source = createEnginePlayer(ay);
        const runtime = createEnginePlayer(ym);
        if (isolatedChannel !== null) {
          for (let channel = 0; channel < 3; channel += 1) {
            source.setChannelMute(channel, channel !== isolatedChannel);
            runtime.setChannelMute(channel, channel !== isolatedChannel);
          }
        }
        source.play();
        runtime.play();
        const sampleCount = (ENGINE_SAMPLE_RATE / 50) * frameCount;
        expect(
          maximumDifference(
            source.generateSamples(sampleCount),
            runtime.generateSamples(sampleCount),
          ),
        ).toBeLessThanOrEqual(0.000_001);
        source.free();
        runtime.free();
      }
    },
  );

  it('selects the requested song from a multi-song ZXAY container', async () => {
    const source = await readFile(
      'content/tracks/matty-batman-cathedral/source.ay',
    );
    const selected = selectAySubsong(source, 7);
    const player = createEnginePlayer(selected);
    const metadata = player.metadata;

    expect(source[16]).toBe(6);
    expect(selected[16]).toBe(0);
    expect(metadata.title).toBe(
      'Batman The Movie - Level 5 - The Cathedral (AY)',
    );
    expect(metadata.duration_seconds).toBe(131);
    metadata.free();
    player.free();
  });

  it('matches uninterrupted Solitude output at every fixed seek position', async () => {
    const psg = parsePsg(
      await fixtureBytes('tests/fixtures/playback/pator-solitude.psg'),
    );
    const bytes = createYm6(psg.frames, {
      chipClockHz: 1_773_400,
      frameRateHz: 50,
      title: 'Solitude',
      author: 'Pator',
    });
    const nativeLength = psg.frameCount * (ENGINE_SAMPLE_RATE / 50);
    const targets = [
      0,
      Math.round(nativeLength * 0.25),
      Math.round(nativeLength * 0.5),
      Math.round(nativeLength * 0.75),
      nativeLength - ENGINE_SAMPLE_RATE,
    ];
    const uninterrupted = createEnginePlayer(bytes);
    uninterrupted.play();
    let cursor = 0;

    for (const target of targets) {
      uninterrupted.generateSamples(target - cursor);
      const window = Math.min(ENGINE_SAMPLE_RATE, nativeLength - target);
      const expected = generateEngineChannels(uninterrupted, window).channels;
      const reconstructed = createEnginePlayerAtSample(bytes, target);
      const actual = generateEngineChannels(reconstructed, window).channels;

      expect(maximumDifference(expected, actual)).toBeLessThanOrEqual(
        0.000_001,
      );
      reconstructed.free();
      cursor = target + window;
    }
    uninterrupted.free();
  }, 60_000);

  it('converts and completely renders the real Solitude PSG for waveform input', async () => {
    const psg = parsePsg(
      await fixtureBytes('tests/fixtures/playback/pator-solitude.psg'),
    );
    const bytes = createYm6(psg.frames, {
      chipClockHz: 1_773_400,
      frameRateHz: 50,
      title: 'Solitude',
      author: 'Pator',
    });
    const track: RuntimeTrack = {
      id: 'pator-solitude-proof',
      bytes,
      durationSeconds: psg.frameCount / 50,
      chipType: 'AY',
      chipClockHz: 1_773_400,
      frameRateHz: 50,
      channelLayout: 'ABC',
    };
    const adapter = new Ym2149PlaybackAdapter();
    const render = await adapter.renderOffline(
      track,
      new AbortController().signal,
    );
    const waveform = encodeWaveformPayload(render);

    expect(render.mix).toHaveLength(8_304_960);
    expect(waveform).toHaveLength(12_288);
    for (const channel of ['A', 'B', 'C'] as const) {
      expect(
        render.channels[channel].some((sample) => Math.abs(sample) > 0.001),
      ).toBe(true);
    }
    adapter.dispose();
  }, 60_000);
});
