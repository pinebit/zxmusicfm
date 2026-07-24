import type { GeneratedCatalog } from './schemas.ts';
import {
  WAVEFORM_BUCKET_COUNT,
  WAVEFORM_BYTES_PER_TRACK,
  WAVEFORM_CHANNEL_COUNT,
} from '../playback/waveform.ts';

const WAVEFORM_HEADER_LENGTH = 16;

export type DecodedWaveform = Readonly<Record<'A' | 'B' | 'C', Int8Array>>;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

// Takes an `ArrayBuffer`-backed view so the payload can be hashed in place
// instead of being copied to satisfy `BufferSource`.
export async function verifyBytes(
  bytes: Uint8Array<ArrayBuffer>,
  expectedLength: number,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (bytes.length !== expectedLength) {
    throw new Error(
      `${label} length mismatch: expected ${expectedLength}, received ${bytes.length}.`,
    );
  }
  const digest = bytesToHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  );
  if (digest !== expectedSha256) {
    throw new Error(`${label} integrity check failed.`);
  }
}

export async function fetchVerifiedBytes(
  url: string,
  expectedLength: number,
  expectedSha256: string,
  signal: AbortSignal,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${label} request failed with status ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyBytes(bytes, expectedLength, expectedSha256, label);
  return bytes;
}

function assertWaveformHeader(
  bytes: Uint8Array,
  catalog: GeneratedCatalog,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (
    bytes.length < WAVEFORM_HEADER_LENGTH ||
    magic !== 'ZXWF' ||
    view.getUint16(4, true) !== 1 ||
    view.getUint16(6, true) !== WAVEFORM_BUCKET_COUNT ||
    view.getUint8(8) !== WAVEFORM_CHANNEL_COUNT ||
    view.getUint8(9) !== 1 ||
    view.getUint16(10, true) !== 0 ||
    view.getUint32(12, true) !== catalog.tracks.length
  ) {
    throw new Error('Waveform pack has an unsupported or corrupt header.');
  }
  if (
    bytes.length !==
    WAVEFORM_HEADER_LENGTH + catalog.tracks.length * WAVEFORM_BYTES_PER_TRACK
  ) {
    throw new Error('Waveform pack length does not match its track count.');
  }
}

export function decodeWaveformPack(
  bytes: Uint8Array,
  catalog: GeneratedCatalog,
): ReadonlyMap<string, DecodedWaveform> {
  assertWaveformHeader(bytes, catalog);
  const decoded = new Map<string, DecodedWaveform>();
  for (const track of catalog.tracks) {
    const start = track.waveformByteOffset;
    const end = start + track.waveformByteLength;
    if (
      start < WAVEFORM_HEADER_LENGTH ||
      end > bytes.length ||
      track.waveformByteLength !== WAVEFORM_BYTES_PER_TRACK
    ) {
      throw new Error(`Waveform slice for ${track.id} is outside the pack.`);
    }
    const signed = new Int8Array(
      bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end),
    );
    for (let offset = 0; offset < signed.length; offset += 2) {
      const minimum = signed[offset];
      const maximum = signed[offset + 1];
      if (
        minimum === undefined ||
        maximum === undefined ||
        minimum === -128 ||
        maximum === -128 ||
        minimum > maximum
      ) {
        throw new Error(`Waveform values for ${track.id} are corrupt.`);
      }
    }
    const channelLength = WAVEFORM_BUCKET_COUNT * 2;
    decoded.set(track.id, {
      A: signed.slice(0, channelLength),
      B: signed.slice(channelLength, channelLength * 2),
      C: signed.slice(channelLength * 2, channelLength * 3),
    });
  }
  return decoded;
}
