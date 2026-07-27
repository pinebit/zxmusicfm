import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAudioContext } from '../test/audioContext.ts';
import { createProofRuntimeTrack } from './proofFixtures.ts';
import type { RuntimeTrack } from './contracts.ts';
import type { WorkletCommand, WorkletReply } from './workletMessages.ts';
import { Ym2149PlaybackAdapter } from './Ym2149PlaybackAdapter.ts';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function commandTypes(
  messages: readonly { readonly message: unknown }[],
): string[] {
  return messages.map(({ message }) => (message as WorkletCommand).type);
}

async function startLoad(
  adapter: Ym2149PlaybackAdapter,
  track: RuntimeTrack,
  context: ReturnType<typeof createTestAudioContext>,
): Promise<{ readonly promise: Promise<void> }> {
  const promise = adapter.load(track, new AbortController().signal);
  await vi.waitFor(() => expect(context.ports).toHaveLength(1));
  const port = required(context.ports[0], 'worklet port');
  await vi.waitFor(() => expect(commandTypes(port.messages)).toContain('init'));
  port.reply({ type: 'ready' } satisfies WorkletReply);
  await vi.waitFor(() => expect(commandTypes(port.messages)).toContain('load'));
  return { promise };
}

async function finishLoad(
  promise: Promise<void>,
  context: ReturnType<typeof createTestAudioContext>,
  generation: number,
  frameCount = 100,
): Promise<void> {
  required(context.ports[0], 'worklet port').reply({
    type: 'loaded',
    generation,
    frameCount,
    sampleRate: 48_000,
  } satisfies WorkletReply);
  await promise;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ym2149PlaybackAdapter AudioWorklet bridge', () => {
  it('builds one worklet and sends load/play/pause/seek in order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    const { promise: load } = await startLoad(
      adapter,
      createProofRuntimeTrack(),
      context,
    );
    await finishLoad(load, context, 1);

    await adapter.play();
    adapter.pause();
    await adapter.seek(1.25);

    const messages = required(context.ports[0], 'worklet port').messages;
    expect(commandTypes(messages)).toEqual([
      'init',
      'load',
      'play',
      'pause',
      'seek',
    ]);
    expect(messages.at(-1)?.message).toMatchObject({
      type: 'seek',
      frame: 62,
    });
    expect(context.workletModules).toHaveLength(1);
    adapter.dispose();
  });

  it('ignores stale generation replies from a replaced load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    const { promise: first } = await startLoad(
      adapter,
      createProofRuntimeTrack(),
      context,
    );
    await finishLoad(first, context, 1);

    const second = adapter.load(
      { ...createProofRuntimeTrack(), id: 'newer' },
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(
        commandTypes(required(context.ports[0], 'worklet port').messages),
      ).toEqual(['init', 'load', 'load']),
    );
    required(context.ports[0], 'worklet port').reply({
      type: 'frame',
      generation: 1,
      audioTime: 0,
      frame: 50,
      rms: [1, 1, 1],
      registers: new Uint8Array(16),
    } satisfies WorkletReply);
    expect(adapter.getChannelLevels()).toEqual({ A: 0, B: 0, C: 0 });

    await finishLoad(second, context, 2);
    expect(context.ports).toHaveLength(1);
    adapter.dispose();
  });

  it('gates levels and ZX-clock voices until their audio time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    const track = {
      ...createProofRuntimeTrack(),
      chipClockHz: 1_773_400,
      normalizationGainDb: 6,
    };
    const { promise: load } = await startLoad(adapter, track, context);
    await finishLoad(load, context, 1);
    adapter.setVolume(0.5);

    const registers = new Uint8Array(16);
    registers[0] = 100;
    registers[2] = 150;
    registers[4] = 200;
    registers[7] = 0x38;
    registers[8] = 15;
    registers[9] = 12;
    registers[10] = 9;
    required(context.ports[0], 'worklet port').reply({
      type: 'frame',
      generation: 1,
      audioTime: 2,
      frame: 50,
      rms: [0.2, 0.1, 0.05],
      registers,
    } satisfies WorkletReply);

    context.setCurrentTime(1.99);
    expect(adapter.getChannelLevels()).toEqual({ A: 0, B: 0, C: 0 });
    expect(adapter.getChannelVoices()).toEqual({
      A: null,
      B: null,
      C: null,
    });

    context.setCurrentTime(2);
    expect(adapter.getChannelLevels().A).toBeCloseTo(
      0.2 * 0.5 * Math.pow(10, 6 / 20),
    );
    const voices = adapter.getChannelVoices();
    expect(voices.A?.midiNote).toBeCloseTo(
      69 + 12 * Math.log2(1_773_400 / (16 * 100) / 440),
    );
    expect(voices.A?.amplitude).toBe(1);
    adapter.dispose();
  });

  it('reads an envelope-driven voice on the same scale as a volume-driven one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    const { promise: load } = await startLoad(
      adapter,
      createProofRuntimeTrack(),
      context,
    );
    await finishLoad(load, context, 1);

    const registers = new Uint8Array(16);
    registers[0] = 100;
    registers[2] = 100;
    registers[7] = 0x38;
    registers[8] = 0x10; // channel A follows the envelope
    registers[9] = 8; // channel B holds register level 8
    required(context.ports[0], 'worklet port').reply({
      type: 'frame',
      generation: 1,
      audioTime: 0,
      // Channel A sits at the AY DAC amplitude of register level 8.
      rms: [0.126_588_85, 0, 0],
      frame: 0,
      registers,
    } satisfies WorkletReply);

    const voices = adapter.getChannelVoices();
    // The envelope level is generator state no register carries, so it has to be
    // read from the rendered level. Both channels are at the same chip level and
    // must therefore shade their keys alike, within one DAC step of each other.
    expect(voices.A?.amplitude).toBeCloseTo(0.63, 2);
    expect(voices.B?.amplitude).toBeCloseTo(8 / 15, 2);
    expect(
      Math.abs((voices.A?.amplitude ?? 0) - (voices.B?.amplitude ?? 0)),
    ).toBeLessThan(0.1);
    adapter.dispose();
  });

  it('leaves noise-mixing channels off the piano', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    const { promise: load } = await startLoad(
      adapter,
      createProofRuntimeTrack(),
      context,
    );
    await finishLoad(load, context, 1);

    const registers = new Uint8Array(16);
    registers[0] = 100;
    registers[2] = 100;
    registers[4] = 100;
    // R7 is active low, noise in bits 3-5 and tone in bits 0-2: A is tone only,
    // B mixes tone with noise, C is noise only.
    registers[7] = 0b00_001_100;
    registers[8] = 15;
    registers[9] = 15;
    registers[10] = 15;
    required(context.ports[0], 'worklet port').reply({
      type: 'frame',
      generation: 1,
      audioTime: 0,
      rms: [0.5, 0.5, 0.5],
      frame: 0,
      registers,
    } satisfies WorkletReply);

    const voices = adapter.getChannelVoices();
    expect(voices.A?.midiNote).toBeGreaterThan(0);
    // A percussion channel's tone period is usually a leftover value, so a note
    // drawn from it would light an arbitrary key.
    expect(voices.B).toBeNull();
    expect(voices.C).toBeNull();
    adapter.dispose();
  });

  it('ramps the ABC/ACB/BAC routing and plain normalization gains', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    const track = {
      ...createProofRuntimeTrack(),
      normalizationGainDb: -3,
    };
    const { promise: load } = await startLoad(adapter, track, context);
    await finishLoad(load, context, 1);

    expect(context.gainValues().slice(2)).toEqual([
      Math.pow(10, -3 / 20),
      0.5,
      0,
      0.5 * Math.SQRT1_2,
      0.5 * Math.SQRT1_2,
      0,
      0.5,
    ]);

    adapter.setChannelOrder('BAC');
    expect(context.gainValues().slice(-6)).toEqual([
      0.5 * Math.SQRT1_2,
      0.5 * Math.SQRT1_2,
      0.5,
      0,
      0,
      0.5,
    ]);
    adapter.setChannelOrder('ACB');
    expect(context.gainValues().slice(-6)).toEqual([
      0.5,
      0,
      0,
      0.5,
      0.5 * Math.SQRT1_2,
      0.5 * Math.SQRT1_2,
    ]);
    adapter.dispose();
  });

  it('keeps the listener stereo order across worklet build and track load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })),
      ),
    );
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({});
    const context = createTestAudioContext();
    const adapter = new Ym2149PlaybackAdapter(context.context);
    // The controller applies the stored preference before anything is loaded,
    // so it lands while the routing nodes do not exist yet.
    adapter.setChannelOrder('BAC');

    const { promise: load } = await startLoad(
      adapter,
      { ...createProofRuntimeTrack(), channelLayout: 'ACB' },
      context,
    );
    await finishLoad(load, context, 1);

    // BAC: B left, A centre, C right. The track's own `channelLayout` is curator
    // metadata and must not overwrite what the listener chose.
    expect(context.gainValues().slice(-6)).toEqual([
      0.5 * Math.SQRT1_2,
      0.5 * Math.SQRT1_2,
      0.5,
      0,
      0,
      0.5,
    ]);
    adapter.dispose();
  });
});
