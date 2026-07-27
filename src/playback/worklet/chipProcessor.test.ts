import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSyntheticFrames } from '../proofFixtures.ts';
import { createYm6, type RegisterFrame } from '../formats.ts';
import type { WorkletCommand, WorkletReply } from '../workletMessages.ts';

type ProcessorPort = {
  onmessage: ((event: MessageEvent<WorkletCommand>) => void) | null;
  readonly replies: WorkletReply[];
  postMessage(message: WorkletReply): void;
};

type Processor = {
  readonly port: ProcessorPort;
  process(
    inputs: readonly Float32Array[][],
    outputs: readonly Float32Array[][],
  ): boolean;
};

type ProcessorConstructor = new () => Processor;

let ProcessorClass: ProcessorConstructor;
let wasmBytes: Uint8Array;

class AudioWorkletProcessorStub {
  readonly port: ProcessorPort = {
    onmessage: null,
    replies: [],
    postMessage(message) {
      this.replies.push(message);
    },
  };
}

function send(processor: Processor, command: WorkletCommand): void {
  processor.port.onmessage?.({ data: command } as MessageEvent<WorkletCommand>);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function processQuantum(processor: Processor): Float32Array[] {
  const channels = Array.from({ length: 3 }, () => new Float32Array(128));
  processor.process([], [channels]);
  const now = Number(Reflect.get(globalThis, 'currentTime'));
  Reflect.set(globalThis, 'currentTime', now + 128 / 48_000);
  return channels;
}

function loudFrames(frameCount: number): readonly RegisterFrame[] {
  return createSyntheticFrames(frameCount).map((source) => {
    const frame = source.slice();
    frame[8] = 15;
    frame[9] = 12;
    frame[10] = 9;
    return frame;
  });
}

function runtimeBytes(frames: readonly RegisterFrame[]): Uint8Array {
  return createYm6(frames, {
    chipClockHz: 1_773_400,
    frameRateHz: 50,
    title: 'Worklet proof',
    author: 'ZX-MUSIC.FM',
  });
}

function createLoadedProcessor(bytes: Uint8Array, generation = 1): Processor {
  const processor = new ProcessorClass();
  send(processor, {
    type: 'init',
    wasm: wasmBytes.slice().buffer,
  });
  send(processor, {
    type: 'load',
    generation,
    bytes,
    chipType: 'AY',
    frameRateHz: 50,
  });
  send(processor, { type: 'play', generation });
  return processor;
}

beforeAll(async () => {
  vi.stubGlobal('sampleRate', 48_000);
  vi.stubGlobal('currentTime', 0);
  vi.stubGlobal('AudioWorkletProcessor', AudioWorkletProcessorStub);
  vi.stubGlobal(
    'registerProcessor',
    (_name: string, constructor: ProcessorConstructor) => {
      ProcessorClass = constructor;
    },
  );
  wasmBytes = new Uint8Array(
    await readFile('vendor/ym2149/ym2149_wasm_bg.wasm'),
  );
  await import('./chipProcessor.ts');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('ym2149-chip worklet processor', () => {
  it('drains 1024-sample renders across quanta without gaps or repeats', () => {
    Reflect.set(globalThis, 'currentTime', 0);
    const bytes = runtimeBytes(loudFrames(100));
    const processor = createLoadedProcessor(bytes);
    const rendered = [[], [], []] as [number[], number[], number[]];

    for (let quantum = 0; quantum < 9; quantum += 1) {
      const channels = processQuantum(processor);
      for (let channel = 0; channel < 3; channel += 1) {
        required(rendered[channel], 'rendered channel').push(
          ...required(channels[channel], 'worklet output channel'),
        );
      }
    }

    expect(
      rendered.every((channel) => channel.some((value) => value !== 0)),
    ).toBe(true);
    const snapshots = processor.port.replies.filter(
      (reply) => reply.type === 'frame',
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      type: 'frame',
      generation: 1,
    });
    // The ninth quantum crosses the ring boundary. Continuity means neither
    // side is replaced with an all-zero allocation.
    expect(rendered[0].slice(1_016, 1_032).some((value) => value !== 0)).toBe(
      true,
    );
  });

  it('seeks directly to the requested frame', () => {
    Reflect.set(globalThis, 'currentTime', 0);
    const processor = createLoadedProcessor(runtimeBytes(loudFrames(100)));
    processQuantum(processor);
    send(processor, { type: 'seek', generation: 1, frame: 50 });
    processQuantum(processor);

    const snapshot = processor.port.replies
      .filter((reply) => reply.type === 'frame')
      .at(-1);
    expect(snapshot).toMatchObject({
      type: 'frame',
      generation: 1,
    });
    if (snapshot?.type !== 'frame') throw new Error('Missing frame snapshot.');
    expect(snapshot.frame).toBeGreaterThanOrEqual(50);
  });

  it('does not treat the R13 sentinel as an envelope retrigger', () => {
    Reflect.set(globalThis, 'currentTime', 0);
    const frames = loudFrames(20).map((source, index) => {
      const frame = source.slice();
      frame[8] = 0x10;
      frame[9] = 0;
      frame[10] = 0;
      frame[11] = 100;
      frame[12] = 0;
      frame[13] = index === 0 ? 0x09 : 0xff;
      return frame;
    });
    const processor = createLoadedProcessor(runtimeBytes(frames));
    const channelA: number[] = [];
    for (let quantum = 0; quantum < 15; quantum += 1) {
      channelA.push(
        ...required(processQuantum(processor)[0], 'worklet output channel A'),
      );
    }

    const firstFrame = channelA.slice(0, 960);
    const secondFrame = channelA.slice(960, 1_920);
    expect(secondFrame).not.toEqual(firstFrame);
  });

  it('posts ended exactly once at the finite frame count', () => {
    Reflect.set(globalThis, 'currentTime', 0);
    const processor = createLoadedProcessor(runtimeBytes(loudFrames(2)));
    for (let quantum = 0; quantum < 24; quantum += 1) {
      processQuantum(processor);
    }

    const ended = processor.port.replies.filter(
      (reply) => reply.type === 'ended',
    );
    expect(ended).toEqual([{ type: 'ended', generation: 1 }]);
  });
});
