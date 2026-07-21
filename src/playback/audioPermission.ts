export type PermittedAudioContext = {
  readonly context: AudioContext;
  readonly ready: Promise<void>;
};

/** Must be called synchronously from the user gesture that permits audio. */
export function requestPlaybackAudioPermission(): PermittedAudioContext {
  const context = new AudioContext({ sampleRate: 48_000 });
  const ready =
    context.state === 'suspended' ? context.resume() : Promise.resolve();
  return { context, ready };
}
