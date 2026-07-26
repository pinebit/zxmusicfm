import { vi } from 'vitest';

/**
 * A scriptable `AudioContext` double for adapter tests. `currentTime` is driven
 * by the test rather than a real clock, which is what lets the audible-time gates
 * on levels and voices be asserted deterministically.
 */
export function createTestAudioContext(): {
  readonly context: AudioContext;
  readonly gainValues: () => number[];
  /** Pan positions in creation order, for the studio chain's routing. */
  readonly panValues: () => number[];
  /** How many convolvers exist, to prove mode chains are built lazily and once. */
  readonly convolverCount: () => number;
  setCurrentTime(value: number): void;
} {
  let currentTime = 0;
  let convolvers = 0;
  const gains: { gain: AudioParam }[] = [];
  const panners: { pan: AudioParam }[] = [];
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
    sampleRate: 44_100,
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
    // Studio chain nodes. Only the properties the graph builder writes are
    // modelled; nothing here renders audio.
    createWaveShaper: vi.fn(() => ({
      ...audioNode(),
      curve: null,
      oversample: 'none',
    })),
    createStereoPanner: vi.fn(() => {
      const panner = { ...audioNode(), pan: audioParam(0) };
      panners.push(panner);
      return panner;
    }),
    createConvolver: vi.fn(() => {
      convolvers += 1;
      return { ...audioNode(), buffer: null, normalize: true };
    }),
    createDelay: vi.fn(() => ({
      ...audioNode(),
      delayTime: audioParam(0),
    })),
    createOscillator: vi.fn(() => ({
      ...audioNode(),
      type: 'sine',
      frequency: audioParam(440),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBuffer: vi.fn((channels: number, length: number) => {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return {
        length,
        numberOfChannels: channels,
        sampleRate: 44_100,
        getChannelData: (channel: number) => data[channel],
      };
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
    panValues: () => panners.map(({ pan }) => pan.value),
    convolverCount: () => convolvers,
    setCurrentTime(value: number) {
      currentTime = value;
    },
  };
}
