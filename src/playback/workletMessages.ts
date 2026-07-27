export type WorkletCommand =
  | {
      readonly type: 'init';
      /**
       * Engine bytes, transferred. Deliberately not a compiled
       * `WebAssembly.Module`: see the note in `Ym2149PlaybackAdapter`.
       */
      readonly wasm: ArrayBuffer;
    }
  | {
      readonly type: 'load';
      readonly generation: number;
      readonly bytes: Uint8Array;
      readonly chipType: 'AY' | 'YM';
      readonly frameRateHz: number;
    }
  | { readonly type: 'play'; readonly generation: number }
  | { readonly type: 'pause'; readonly generation: number }
  | { readonly type: 'stop'; readonly generation: number }
  | {
      readonly type: 'seek';
      readonly generation: number;
      readonly frame: number;
    };

export type WorkletFrameSnapshot = {
  readonly type: 'frame';
  readonly generation: number;
  readonly audioTime: number;
  readonly frame: number;
  readonly rms: readonly [number, number, number];
  readonly registers: Uint8Array;
};

export type WorkletReply =
  | { readonly type: 'ready' }
  | {
      readonly type: 'loaded';
      readonly generation: number;
      readonly frameCount: number;
      readonly sampleRate: number;
    }
  | { readonly type: 'ended'; readonly generation: number }
  | {
      readonly type: 'error';
      readonly generation?: number;
      readonly message: string;
    }
  | WorkletFrameSnapshot;
