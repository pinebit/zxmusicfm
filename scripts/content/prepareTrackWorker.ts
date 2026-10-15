import { parentPort, workerData } from 'node:worker_threads';

import {
  prepareTrack,
  type PreparedTrack,
  type TrackInput,
} from './foundation.ts';
import { initializeOfflineEngine } from './offlineRender.ts';

export type PrepareTrackReply =
  | { readonly ok: true; readonly track: PreparedTrack }
  | { readonly ok: false; readonly error: unknown };

// One slot of the `prepareContent` pool: each message is a track to render,
// answered with its prepared artifacts or the error that stopped it.
if (parentPort === null) {
  throw new Error('prepareTrackWorker.ts must run as a worker thread.');
}
const port = parentPort;
await initializeOfflineEngine(workerData as string);
port.on('message', (input: TrackInput) => {
  prepareTrack(input).then(
    (track) => {
      port.postMessage({ ok: true, track } satisfies PrepareTrackReply);
    },
    (error: unknown) => {
      port.postMessage({ ok: false, error } satisfies PrepareTrackReply);
    },
  );
});
