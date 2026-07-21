import { Ym2149PlaybackAdapter } from './Ym2149PlaybackAdapter.ts';
import { createProofRuntimeTrack } from './proofFixtures.ts';
import { encodeWaveformPayload } from './waveform.ts';

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function assertProof(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runBrowserPlaybackProof(
  audioContext: AudioContext,
): Promise<string> {
  const adapter = new Ym2149PlaybackAdapter(audioContext);
  const track = createProofRuntimeTrack();
  const controller = new AbortController();
  try {
    const offline = await adapter.renderOffline(track, controller.signal);
    assertProof(
      offline.mix.length === track.durationSeconds * 48_000,
      'Offline render did not contain the expected 48 kHz sample count.',
    );
    for (const channel of ['A', 'B', 'C'] as const) {
      assertProof(
        offline.channels[channel].some((sample) => Math.abs(sample) > 0.001),
        `Channel ${channel} produced no exact samples.`,
      );
    }
    const waveform = encodeWaveformPayload(offline);
    assertProof(
      waveform.length === 12_288,
      'Waveform payload size is invalid.',
    );

    await adapter.load(track, controller.signal);
    await adapter.seek(0.5);
    assertProof(
      adapter.getSnapshot().status === 'ready',
      'Restored position did not remain paused and ready.',
    );
    adapter.setVolume(0.02);
    await adapter.play();
    const advanceDeadline = performance.now() + 3_000;
    while (
      adapter.getSnapshot().positionSeconds <= 0.51 &&
      performance.now() < advanceDeadline
    ) {
      await wait(25);
    }
    assertProof(
      Object.values(adapter.getChannelLevels()).some((level) => level > 0),
      'Live channel levels did not update.',
    );
    adapter.setMuted(true);
    assertProof(
      Object.values(adapter.getChannelLevels()).every((level) => level === 0),
      'Mute did not silence the channel levels.',
    );
    adapter.setMuted(false);
    adapter.setVolume(0);
    assertProof(
      Object.values(adapter.getChannelLevels()).every((level) => level === 0),
      'Zero volume did not silence the channel levels.',
    );
    adapter.setVolume(0.02);
    adapter.pause();
    const paused = adapter.getSnapshot();
    assertProof(
      paused.status === 'paused',
      'Pause lifecycle transition failed.',
    );
    assertProof(
      paused.positionSeconds > 0.5,
      `Playback position did not advance (audio=${audioContext.state}, clock=${audioContext.currentTime.toFixed(3)}, position=${paused.positionSeconds.toFixed(3)}).`,
    );
    adapter.stop();
    assertProof(
      adapter.getSnapshot().status === 'ready' &&
        adapter.getSnapshot().positionSeconds === 0,
      'Stop did not reset the loaded track.',
    );

    await adapter.seek(1.98);
    await adapter.play();
    const deadline = performance.now() + 5_000;
    while (
      adapter.getSnapshot().status !== 'ended' &&
      performance.now() < deadline
    ) {
      await wait(25);
    }
    assertProof(
      adapter.getSnapshot().status === 'ended',
      'Natural end detection did not fire.',
    );
    return 'Passed: WASM, A/B/C, 48 kHz render, restore, play, pause, seek, and end';
  } finally {
    controller.abort();
    adapter.dispose();
  }
}
