import { ENGINE_SAMPLE_RATE } from './sampleRates.ts';

export type PermittedAudioContext = {
  readonly context: AudioContext;
  readonly ready: Promise<void>;
};

/** Must be called synchronously from the user gesture that permits audio. */
export function requestPlaybackAudioPermission(): PermittedAudioContext {
  const context = new AudioContext({ sampleRate: ENGINE_SAMPLE_RATE });
  const ready =
    context.state === 'suspended' ? context.resume() : Promise.resolve();
  return { context, ready };
}
