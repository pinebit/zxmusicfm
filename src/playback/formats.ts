export type RegisterFrame = Uint8Array;

export type ParsedPsg = {
  readonly frames: readonly RegisterFrame[];
  readonly frameCount: number;
};

export type Ym6Options = {
  readonly chipClockHz: number;
  readonly frameRateHz: number;
  readonly title?: string;
  readonly author?: string;
  readonly comment?: string;
};

const PSG_HEADER_LENGTH = 16;
const AY_HEADER_LENGTH = 20;
const AY_SONG_COUNT_OFFSET = 16;
const AY_FIRST_SONG_OFFSET = 17;
const AY_SONG_TABLE_POINTER_OFFSET = 18;
const AY_SONG_ENTRY_LENGTH = 4;
const REGISTER_COUNT = 16;
const YM6_HEADER_LENGTH = 34;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function fail(message: string): never {
  throw new Error(message);
}

function readByte(source: Uint8Array, offset: number, message: string): number {
  const value = source[offset];

  if (value === undefined) {
    fail(message);
  }

  return value;
}

function assertRegisterFrame(frame: RegisterFrame, index: number): void {
  if (frame.length !== REGISTER_COUNT) {
    fail(`Frame ${index} has ${frame.length} registers; expected 16.`);
  }
}

function writeU16BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(
    offset,
    value,
    false,
  );
}

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(
    offset,
    value,
    false,
  );
}

function readU16BE(source: Uint8Array, offset: number): number {
  return new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  ).getUint16(offset, false);
}

function readU32BE(source: Uint8Array, offset: number): number {
  return new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  ).getUint32(offset, false);
}

function hasMagic(bytes: Uint8Array, magic: string, offset = 0): boolean {
  if (bytes.length < offset + magic.length) {
    return false;
  }

  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function safeMetadata(value: string | undefined, field: string): Uint8Array {
  const normalized = value ?? '';
  if (normalized.includes('\0')) {
    fail(`${field} must not contain a NUL byte.`);
  }
  return textEncoder.encode(normalized);
}

/** Select one song from a multi-song ZXAY container without changing the source bytes. */
export function selectAySubsong(
  bytes: Uint8Array,
  subsong: number,
): Uint8Array {
  if (bytes.length < AY_HEADER_LENGTH || !hasMagic(bytes, 'ZXAYEMUL', 0)) {
    fail('AY input is missing the ZXAYEMUL signature or complete header.');
  }
  if (!Number.isInteger(subsong) || subsong < 1) {
    fail(`AY subsong ${subsong} must be a positive integer.`);
  }

  const songCount =
    readByte(
      bytes,
      AY_SONG_COUNT_OFFSET,
      'AY input is missing its song count.',
    ) + 1;
  if (subsong > songCount) {
    fail(
      `AY subsong ${subsong} is unavailable; source contains ${songCount} subsongs.`,
    );
  }

  const sourceView = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const tableOffset =
    AY_SONG_TABLE_POINTER_OFFSET +
    sourceView.getInt16(AY_SONG_TABLE_POINTER_OFFSET, false);
  const tableEnd = tableOffset + songCount * AY_SONG_ENTRY_LENGTH;
  if (tableOffset < AY_HEADER_LENGTH || tableEnd > bytes.length) {
    fail('AY input has an invalid song table pointer.');
  }

  const selectedEntryOffset =
    tableOffset + (subsong - 1) * AY_SONG_ENTRY_LENGTH;
  const selectedTablePointer =
    selectedEntryOffset - AY_SONG_TABLE_POINTER_OFFSET;
  if (selectedTablePointer < -0x8000 || selectedTablePointer > 0x7fff) {
    fail(`AY subsong ${subsong} song table pointer is out of range.`);
  }

  const selected = Uint8Array.from(bytes);
  selected[AY_SONG_COUNT_OFFSET] = 0;
  selected[AY_FIRST_SONG_OFFSET] = 0;
  new DataView(
    selected.buffer,
    selected.byteOffset,
    selected.byteLength,
  ).setInt16(AY_SONG_TABLE_POINTER_OFFSET, selectedTablePointer, false);
  return selected;
}

/** Parse the uncompressed AY Emulator PSG stream the pipeline accepts. */
export function parsePsg(bytes: Uint8Array): ParsedPsg {
  if (bytes.length < PSG_HEADER_LENGTH || !hasMagic(bytes, 'PSG', 0)) {
    fail('PSG input is missing the PSG signature and 0x1A marker.');
  }
  if (bytes[3] !== 0x1a) {
    fail('PSG input has an invalid signature marker at byte offset 3.');
  }

  const registers = new Uint8Array(REGISTER_COUNT);
  const frames: RegisterFrame[] = [];
  let offset = PSG_HEADER_LENGTH;
  let ended = false;

  const appendFrames = (frameCount: number) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const snapshot = registers.slice();
      snapshot[13] = 0xff;
      frames.push(snapshot);
    }
  };

  while (offset < bytes.length) {
    const commandOffset = offset;
    const command = readByte(
      bytes,
      offset,
      `Unexpected end of PSG data at byte ${commandOffset}`,
    );
    offset += 1;

    if (command <= 0x0f) {
      const current = frames.at(-1);
      if (current === undefined) {
        fail(
          `PSG register write at byte offset ${commandOffset} precedes the first frame marker.`,
        );
      }
      const value = bytes[offset];
      if (value === undefined) {
        fail(
          `PSG register ${command} write is truncated at byte offset ${commandOffset}.`,
        );
      }
      offset += 1;
      registers[command] = value;
      current[command] = value;
      continue;
    }

    if (command === 0xff) {
      appendFrames(1);
      continue;
    }

    if (command === 0xfe) {
      const delay = bytes[offset];
      if (delay === undefined) {
        fail(
          `PSG extended delay is truncated at byte offset ${commandOffset}.`,
        );
      }
      if (delay === 0) {
        fail(`PSG extended delay at byte offset ${commandOffset} is zero.`);
      }
      offset += 1;
      appendFrames(delay * 4);
      continue;
    }

    if (command === 0xfd) {
      ended = true;
      break;
    }

    fail(
      `Unsupported PSG command 0x${command.toString(16).padStart(2, '0')} at byte offset ${commandOffset}.`,
    );
  }

  if (ended && offset !== bytes.length) {
    fail(`PSG input contains trailing data after byte offset ${offset - 1}.`);
  }
  if (frames.length === 0) {
    fail('PSG input contains no complete audio frames.');
  }

  return { frames, frameCount: frames.length };
}

export function createYm6(
  frames: readonly RegisterFrame[],
  options: Ym6Options,
): Uint8Array {
  if (frames.length === 0 || frames.length > 100_000) {
    fail(`YM6 frame count ${frames.length} is outside 1...100000.`);
  }
  if (!Number.isInteger(options.chipClockHz) || options.chipClockHz <= 0) {
    fail('YM6 chipClockHz must be a positive integer.');
  }
  if (
    !Number.isInteger(options.frameRateHz) ||
    options.frameRateHz <= 0 ||
    options.frameRateHz > 65_535
  ) {
    fail('YM6 frameRateHz must be an integer in 1...65535.');
  }
  frames.forEach(assertRegisterFrame);
  const normalizedFrames = frames.map((source) => {
    const frame = Uint8Array.from(source);
    for (const register of [1, 3, 5])
      frame[register] = (frame[register] ?? 0) & 0x0f;
    frame[6] = (frame[6] ?? 0) & 0x1f;
    for (const register of [8, 9, 10])
      frame[register] = (frame[register] ?? 0) & 0x1f;
    if (frame[13] !== 0xff) frame[13] = (frame[13] ?? 0) & 0x0f;
    frame[14] = 0;
    frame[15] = 0;
    return frame;
  });

  const metadata = [
    safeMetadata(options.title, 'YM6 title'),
    safeMetadata(options.author, 'YM6 author'),
    safeMetadata(options.comment, 'YM6 comment'),
  ];
  const metadataLength = metadata.reduce(
    (total, field) => total + field.length + 1,
    0,
  );
  const result = new Uint8Array(
    YM6_HEADER_LENGTH + metadataLength + frames.length * REGISTER_COUNT + 4,
  );

  result.set(textEncoder.encode('YM6!LeOnArD!'), 0);
  writeU32BE(result, 12, frames.length);
  writeU32BE(result, 16, 1);
  writeU16BE(result, 20, 0);
  writeU32BE(result, 22, options.chipClockHz);
  writeU16BE(result, 26, options.frameRateHz);
  writeU32BE(result, 28, 0);
  writeU16BE(result, 32, 0);

  let offset = YM6_HEADER_LENGTH;
  for (const field of metadata) {
    result.set(field, offset);
    offset += field.length + 1;
  }
  for (let register = 0; register < REGISTER_COUNT; register += 1) {
    for (const frame of normalizedFrames) {
      result[offset] = frame[register] ?? 0;
      offset += 1;
    }
  }
  result.set(textEncoder.encode('End!'), offset);
  return result;
}

function readNullTerminated(
  bytes: Uint8Array,
  initialOffset: number,
): { readonly value: string; readonly offset: number } {
  const end = bytes.indexOf(0, initialOffset);
  if (end < 0) {
    fail(
      `YM metadata string at byte offset ${initialOffset} is not terminated.`,
    );
  }
  return {
    value: textDecoder.decode(bytes.subarray(initialOffset, end)),
    offset: end + 1,
  };
}

export function parseYm6(bytes: Uint8Array): {
  readonly frames: readonly RegisterFrame[];
  readonly chipClockHz: number;
  readonly frameRateHz: number;
  readonly title: string;
  readonly author: string;
  readonly comment: string;
} {
  if (
    bytes.length < YM6_HEADER_LENGTH ||
    !hasMagic(bytes, 'YM6!') ||
    !hasMagic(bytes, 'LeOnArD!', 4)
  ) {
    fail('YM6 input has an invalid header.');
  }

  const frameCount = readU32BE(bytes, 12);
  const attributes = readU32BE(bytes, 16);
  const digidrumCount = readU16BE(bytes, 20);
  const chipClockHz = readU32BE(bytes, 22);
  const frameRateHz = readU16BE(bytes, 26);
  const extraDataSize = readU16BE(bytes, 32);
  if (frameCount === 0 || frameCount > 100_000) {
    fail(`YM6 frame count ${frameCount} is outside 1...100000.`);
  }
  const loopFrame = readU32BE(bytes, 28);
  if (
    attributes !== 1 ||
    digidrumCount !== 0 ||
    loopFrame !== 0 ||
    extraDataSize !== 0
  ) {
    fail(
      'YM6 runtime input must use only register interleaving, no loop, no digidrums, and no extra data.',
    );
  }
  if (chipClockHz === 0 || frameRateHz === 0) {
    fail('YM6 runtime input has an invalid chip clock or frame rate.');
  }

  const title = readNullTerminated(bytes, YM6_HEADER_LENGTH);
  const author = readNullTerminated(bytes, title.offset);
  const comment = readNullTerminated(bytes, author.offset);
  const dataLength = frameCount * REGISTER_COUNT;
  const endMarkerOffset = comment.offset + dataLength;
  if (
    endMarkerOffset + 4 !== bytes.length ||
    !hasMagic(bytes, 'End!', endMarkerOffset)
  ) {
    fail('YM6 runtime input has invalid frame data length or end marker.');
  }

  const frames: RegisterFrame[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const registers = new Uint8Array(REGISTER_COUNT);
    for (let register = 0; register < REGISTER_COUNT; register += 1) {
      registers[register] =
        bytes[comment.offset + register * frameCount + frame] ?? 0;
    }
    if (
      (registers[1] ?? 0) > 0x0f ||
      (registers[3] ?? 0) > 0x0f ||
      (registers[5] ?? 0) > 0x0f ||
      (registers[6] ?? 0) > 0x1f ||
      (registers[8] ?? 0) > 0x1f ||
      (registers[9] ?? 0) > 0x1f ||
      (registers[10] ?? 0) > 0x1f ||
      ((registers[13] ?? 0) !== 0xff && (registers[13] ?? 0) > 0x0f) ||
      registers[14] !== 0 ||
      registers[15] !== 0
    ) {
      fail(`YM6 runtime frame ${frame} violates the strict ZX AY profile.`);
    }
    frames.push(registers);
  }

  return {
    frames,
    chipClockHz,
    frameRateHz,
    title: title.value,
    author: author.value,
    comment: comment.value,
  };
}
