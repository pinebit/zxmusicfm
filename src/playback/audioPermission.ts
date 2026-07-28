export type PermittedAudioContext = {
  readonly context: AudioContext;
  readonly ready: Promise<void>;
};

type AudioSessionType =
  | 'auto'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'play-and-record';

type NavigatorWithAudioSession = Navigator & {
  readonly audioSession?: {
    type: AudioSessionType;
  };
};

/** Must be called synchronously from the user gesture that permits audio. */
export function requestPlaybackAudioPermission(): PermittedAudioContext {
  const audioSession = (navigator as NavigatorWithAudioSession).audioSession;
  if (audioSession !== undefined) {
    // Web Audio defaults to an ambient session on iOS, so the phone's silent
    // switch mutes it. Music playback belongs on the media playback session.
    audioSession.type = 'playback';
  }

  const context = new AudioContext();
  const ready =
    context.state === 'suspended' ? context.resume() : Promise.resolve();
  return { context, ready };
}
