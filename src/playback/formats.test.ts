import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createYm6, parsePsg, parseYm6 } from './formats.ts';
import { createSyntheticFrames, createSyntheticPsg } from './proofFixtures.ts';

describe('PSG and YM canonical runtime formats', () => {
  it('parses short and extended PSG delays without inventing a leading frame', () => {
    const parsed = parsePsg(createSyntheticPsg());

    expect(parsed.frameCount).toBe(10);
    expect(parsed.frames[0]?.[0]).toBe(100);
    expect(parsed.frames.slice(1).every((frame) => frame[0] === 120)).toBe(
      true,
    );
    expect(parsed.frames.every((frame) => frame[13] === 0xff)).toBe(true);
  });

  it('rejects unsupported PSG commands with a byte offset', () => {
    const invalid = createSyntheticPsg();
    invalid[16] = 0x20;

    expect(() => parsePsg(invalid)).toThrow(
      'Unsupported PSG command 0x20 at byte offset 16',
    );
  });

  it('parses the real Solitude PSG with the expected whole-frame duration', async () => {
    const bytes = new Uint8Array(
      await readFile('tests/fixtures/playback/pator-solitude.psg'),
    );
    const parsed = parsePsg(bytes);

    expect(bytes).toHaveLength(63_474);
    expect(parsed.frameCount).toBe(8_652);
    expect(parsed.frameCount / 50).toBe(173.04);
  });

  it('round-trips deterministic strict interleaved YM6 frames', () => {
    const frames = createSyntheticFrames(12);
    const bytes = createYm6(frames, {
      chipClockHz: 1_773_400,
      frameRateHz: 50,
      title: 'Round trip',
      author: 'ZX-MUSIC.FM',
    });
    const parsed = parseYm6(bytes);

    expect(parsed.title).toBe('Round trip');
    expect(parsed.chipClockHz).toBe(1_773_400);
    expect(parsed.frameRateHz).toBe(50);
    expect(parsed.frames).toEqual(frames);
  });
});
