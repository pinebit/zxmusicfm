import { vi } from 'vitest';

export type TestWorkletPort = {
  readonly messages: {
    readonly message: unknown;
    readonly transfer: readonly Transferable[];
  }[];
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  reply(message: unknown): void;
  close(): void;
};

/**
 * A scriptable `AudioContext` double. `currentTime` and worklet replies are
 * driven by tests so audible-time gating stays deterministic.
 */
export function createTestAudioContext(): {
  readonly context: AudioContext;
  readonly gainValues: () => number[];
  readonly ports: readonly TestWorkletPort[];
  readonly workletModules: readonly string[];
  setCurrentTime(value: number): void;
} {
  let currentTime = 0;
  const gains: { gain: AudioParam }[] = [];
  const ports: TestWorkletPort[] = [];
  const workletModules: string[] = [];

  const audioNode = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
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

  class TestAudioWorkletNode {
    readonly port: TestWorkletPort;
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
    onprocessorerror: ((event: Event) => void) | null = null;

    constructor(...argumentsList: unknown[]) {
      void argumentsList;
      const messages: {
        readonly message: unknown;
        readonly transfer: readonly Transferable[];
      }[] = [];
      this.port = {
        messages,
        onmessage: null,
        postMessage(message, transfer = []) {
          messages.push({ message, transfer });
        },
        reply(message) {
          this.onmessage?.({ data: message } as MessageEvent);
        },
        close: vi.fn(),
      };
      ports.push(this.port);
    }
  }
  vi.stubGlobal('AudioWorkletNode', TestAudioWorkletNode);

  const context = {
    state: 'running',
    sampleRate: 48_000,
    destination: audioNode(),
    audioWorklet: {
      addModule: vi.fn((url: string) => {
        workletModules.push(url);
        return Promise.resolve();
      }),
    },
    get currentTime() {
      return currentTime;
    },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    createGain: vi.fn(() => {
      const gain = {
        ...audioNode(),
        gain: audioParam(1),
        channelCount: 2,
        channelCountMode: 'max',
        channelInterpretation: 'speakers',
      };
      gains.push(gain);
      return gain;
    }),
    createChannelSplitter: vi.fn(() => audioNode()),
    createChannelMerger: vi.fn(() => audioNode()),
  } as unknown as AudioContext;

  return {
    context,
    gainValues: () => gains.map(({ gain }) => gain.value),
    ports,
    workletModules,
    setCurrentTime(value: number) {
      currentTime = value;
    },
  };
}
