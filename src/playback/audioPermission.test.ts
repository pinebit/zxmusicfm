import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestPlaybackAudioPermission } from './audioPermission.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestPlaybackAudioPermission', () => {
  it('requests a playback audio session before creating an AudioContext', () => {
    const audioSession = { type: 'auto' };
    let sessionTypeAtContextCreation: string | undefined;

    class TestAudioContext {
      readonly state = 'running';

      constructor() {
        sessionTypeAtContextCreation = audioSession.type;
      }
    }

    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('AudioContext', TestAudioContext);

    requestPlaybackAudioPermission();

    expect(audioSession.type).toBe('playback');
    expect(sessionTypeAtContextCreation).toBe('playback');
  });

  it('still creates an AudioContext when the Audio Session API is unavailable', () => {
    let constructionCount = 0;

    class TestAudioContext {
      readonly state = 'running';

      constructor() {
        constructionCount += 1;
      }
    }

    vi.stubGlobal('navigator', {});
    vi.stubGlobal('AudioContext', TestAudioContext);

    const permission = requestPlaybackAudioPermission();

    expect(constructionCount).toBe(1);
    expect(permission.context).toBeInstanceOf(TestAudioContext);
  });
});
