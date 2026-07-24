import type { RuntimeTrack } from './contracts.ts';
import {
  createEnginePlayer,
  generateEngineChannels,
  initializeYm2149,
} from './engine.ts';
import { createYm6, type RegisterFrame, type Ym6Options } from './formats.ts';
import { ENGINE_SAMPLE_RATE } from './sampleRates.ts';

const AY_FRAME_RATE = 50;
const AY_CHIP_CLOCK = 2_000_000;

function writeU16BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setUint16(offset, value, false);
}

function writeI16BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setInt16(offset, value, false);
}

function writeRelativePointer(
  target: Uint8Array,
  origin: number,
  destination: number,
): void {
  writeI16BE(target, origin, destination - origin);
}

function writeString(target: Uint8Array, offset: number, value: string): void {
  target.set(new TextEncoder().encode(`${value}\0`), offset);
}

export function createSyntheticFrames(
  frameCount = 100,
): readonly RegisterFrame[] {
  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const frame = new Uint8Array(16);
    frame[0] = 80 + (frameIndex % 120);
    frame[1] = 0;
    frame[2] = 130 + (frameIndex % 80);
    frame[3] = 0;
    frame[4] = 190 + (frameIndex % 50);
    frame[5] = 0;
    frame[6] = 3;
    frame[7] = 0x38;
    frame[8] = 15;
    frame[9] = frameIndex < frameCount / 3 ? 0 : 12;
    frame[10] = frameIndex < (frameCount * 2) / 3 ? 0 : 9;
    frame[13] = 0xff;
    return frame;
  });
}

export function createSyntheticYm3(
  frames: readonly RegisterFrame[],
): Uint8Array {
  const result = new Uint8Array(4 + frames.length * 14);
  result.set(new TextEncoder().encode('YM3!'));
  for (let register = 0; register < 14; register += 1) {
    for (let frame = 0; frame < frames.length; frame += 1) {
      result[4 + register * frames.length + frame] =
        frames[frame]?.[register] ?? 0;
    }
  }
  return result;
}

export function createSyntheticPsg(): Uint8Array {
  return new Uint8Array([
    0x50, 0x53, 0x47, 0x1a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0, 100, 1,
    0, 7, 0x3e, 8, 15, 0xff, 0, 120, 0xfe, 2, 0xfd,
  ]);
}

/** Build a project-created ZXAY/EMUL fixture with executable Z80 register writes. */
export function createSyntheticAy(looping: boolean): Uint8Array {
  const result = new Uint8Array(385);
  result.set(new TextEncoder().encode('ZXAYEMUL'));
  writeU16BE(result, 8, 0);
  result[10] = 0;
  result[11] = 0;
  writeRelativePointer(result, 12, 72);
  writeRelativePointer(result, 14, 88);
  result[16] = 0;
  result[17] = 0;
  writeRelativePointer(result, 18, 20);
  writeRelativePointer(result, 20, 52);
  writeRelativePointer(result, 22, 24);
  result.set([0, 1, 2, 3], 24);
  writeU16BE(result, 28, looping ? 0 : 50);
  writeU16BE(result, 30, 0);
  writeRelativePointer(result, 34, 38);
  writeRelativePointer(result, 36, 44);
  writeU16BE(result, 38, 0x9000);
  writeU16BE(result, 40, 0x8000);
  writeU16BE(result, 42, 0x8000);
  writeU16BE(result, 44, 0x8000);
  writeU16BE(result, 46, 257);
  writeRelativePointer(result, 48, 128);
  writeU16BE(result, 50, 0);
  writeString(
    result,
    52,
    looping ? 'Synthetic AY loop' : 'Synthetic AY finite',
  );
  writeString(result, 72, 'ZX-MUSIC.FM');
  writeString(result, 88, 'Project-created Phase 2 fixture');

  const code: number[] = [];
  for (const [register, value] of [
    [0, 100],
    [1, 0],
    [2, 150],
    [3, 0],
    [4, 200],
    [5, 0],
    [6, 3],
    [7, 0x38],
    [8, 15],
    [9, 0],
    [10, 0],
  ] as const) {
    code.push(
      0x01,
      0xfd,
      0xff,
      0x3e,
      register,
      0xed,
      0x79,
      0x01,
      0xfd,
      0xbf,
      0x3e,
      value,
      0xed,
      0x79,
    );
  }
  code.push(0xc9);
  result.set(code, 128);
  result[128 + 256] = 0xc9;
  return result;
}

export async function captureSyntheticAyAsYm6(
  source: Uint8Array,
  frameCount: number,
): Promise<Uint8Array> {
  await initializeYm2149();
  const player = createEnginePlayer(source);
  const frames: RegisterFrame[] = [];
  try {
    player.play();
    const samplesPerFrame = ENGINE_SAMPLE_RATE / AY_FRAME_RATE;
    for (let frame = 0; frame < frameCount; frame += 1) {
      generateEngineChannels(player, samplesPerFrame);
      const registers = player.get_registers();
      registers[13] = 0xff;
      frames.push(registers);
    }
  } finally {
    player.free();
  }
  return createYm6(frames, {
    chipClockHz: AY_CHIP_CLOCK,
    frameRateHz: AY_FRAME_RATE,
    title: 'Synthetic AY capture',
    author: 'ZX-MUSIC.FM',
    comment: 'Phase 2 deterministic capture',
  });
}

export function createProofRuntimeTrack(
  options: Partial<Ym6Options> = {},
): RuntimeTrack {
  const frameRateHz = options.frameRateHz ?? 50;
  const frames = createSyntheticFrames(frameRateHz * 2);
  return {
    id: 'phase-2-proof',
    bytes: createYm6(frames, {
      chipClockHz: options.chipClockHz ?? 1_773_400,
      frameRateHz,
      title: options.title ?? 'Phase 2 proof',
      author: options.author ?? 'ZX-MUSIC.FM',
      comment: options.comment ?? 'Project-created synthetic fixture',
    }),
    durationSeconds: frames.length / frameRateHz,
    chipType: 'AY',
    chipClockHz: options.chipClockHz ?? 1_773_400,
    frameRateHz,
    channelLayout: 'ABC',
  };
}
