import { vi } from 'vitest';

/**
 * A scriptable `AudioContext` double for adapter tests. `currentTime` is driven
 * by the test rather than a real clock, which is what lets the audible-time gates
 * on levels and voices be asserted deterministically.
 */
export function createTestAudioContext(): {
  readonly context: AudioContext;
  readonly gainValues: () => number[];
  setCurrentTime(value: number): void;
} {
  let currentTime = 0;
  const gains: { gain: AudioParam }[] = [];
  const audioNode = () => ({ connect: vi.fn() });
  const audioParam = (initialValue: number) => {
    const parameter = {
      value: initialValue,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn((value: number) => {
        parameter.value = value;
        return parameter;
      }),
      linearRampToValueAtTime: vi.fn((value: number) => {
        parameter.value = value;
        return parameter;
      }),
    };
    return parameter as unknown as AudioParam;
  };
  const context = {
    state: 'running',
    destination: audioNode(),
    get currentTime() {
      return currentTime;
    },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    createGain: vi.fn(() => {
      const gain = { ...audioNode(), gain: audioParam(1) };
      gains.push(gain);
      return gain;
    }),
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
    createChannelSplitter: vi.fn(() => ({
      ...audioNode(),
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
    })),
    createAnalyser: vi.fn(() => ({
      ...audioNode(),
      fftSize: 2_048,
      smoothingTimeConstant: 0.8,
      getFloatTimeDomainData: vi.fn(),
    })),
    createChannelMerger: vi.fn(() => audioNode()),
    createBuffer: vi.fn((channels: number, length: number) => {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
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
    gainValues: () => gains.map(({ gain }) => gain.value),
    setCurrentTime(value: number) {
      currentTime = value;
    },
  };
}
