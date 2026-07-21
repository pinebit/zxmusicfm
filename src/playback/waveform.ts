import type { OfflineRender } from './contracts.ts';

export const WAVEFORM_BUCKET_COUNT = 2_048;
export const WAVEFORM_CHANNEL_COUNT = 3;
export const WAVEFORM_BYTES_PER_TRACK =
  WAVEFORM_BUCKET_COUNT * WAVEFORM_CHANNEL_COUNT * 2;

function encodeMinimum(value: number): number {
  return Math.max(-127, Math.min(127, Math.floor(value * 127)));
}

function encodeMaximum(value: number): number {
  return Math.max(-127, Math.min(127, Math.ceil(value * 127)));
}

export function encodeWaveformPayload(render: OfflineRender): Uint8Array {
  const payload = new Uint8Array(WAVEFORM_BYTES_PER_TRACK);
  const signed = new Int8Array(payload.buffer);
  const sources = [render.channels.A, render.channels.B, render.channels.C];

  for (let channel = 0; channel < sources.length; channel += 1) {
    const samples = sources[channel];
    if (samples === undefined) {
      continue;
    }
    const channelOffset = channel * WAVEFORM_BUCKET_COUNT * 2;
    for (let bucket = 0; bucket < WAVEFORM_BUCKET_COUNT; bucket += 1) {
      const start = Math.floor(
        (bucket * samples.length) / WAVEFORM_BUCKET_COUNT,
      );
      const end = Math.floor(
        ((bucket + 1) * samples.length) / WAVEFORM_BUCKET_COUNT,
      );
      let minimum = 0;
      let maximum = 0;
      if (end > start) {
        minimum = 1;
        maximum = -1;
        for (let index = start; index < end; index += 1) {
          const sample = samples[index] ?? 0;
          minimum = Math.min(minimum, sample);
          maximum = Math.max(maximum, sample);
        }
      }
      signed[channelOffset + bucket * 2] = encodeMinimum(minimum);
      signed[channelOffset + bucket * 2 + 1] = encodeMaximum(maximum);
    }
  }

  return payload;
}
