export type RegisterFrame = Uint8Array;

export type ParsedPsg = {
  readonly frames: readonly RegisterFrame[];
  readonly frameCount: number;
};

export type YmRuntimePreparation = {
  readonly bytes: Uint8Array;
  readonly format: 'YM6';
  readonly mode: 'copy' | 'normalize';
  readonly frames: readonly RegisterFrame[];
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
const textDecoder = new TextDecoder('windows-1252');

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

function pushFrame(
  frames: RegisterFrame[],
  registers: Uint8Array,
  envelopeShape: number | undefined,
): void {
  const frame = registers.slice();
  frame[13] = envelopeShape ?? 0xff;
  frames.push(frame);
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

/** Parse the uncompressed AY Emulator PSG stream accepted by the MVP. */
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
  const state = { timelineStarted: false };
  let envelopeShape: number | undefined;
  let wroteSinceBoundary = false;
  let ended = false;

  const commitDelay = (frameCount: number) => {
    if (!state.timelineStarted) {
      state.timelineStarted = true;
      return;
    }

    for (let frame = 0; frame < frameCount; frame += 1) {
      pushFrame(frames, registers, frame === 0 ? envelopeShape : undefined);
    }
    envelopeShape = undefined;
    wroteSinceBoundary = false;
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
      if (!state.timelineStarted) {
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
      if (command === 13) {
        envelopeShape = value & 0x0f;
      }
      wroteSinceBoundary = true;
      continue;
    }

    if (command === 0xff) {
      commitDelay(1);
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
      commitDelay(delay * 4);
      continue;
    }

    if (command === 0xfd) {
      if (wroteSinceBoundary) {
        pushFrame(frames, registers, envelopeShape);
      }
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
  if (!state.timelineStarted) {
    fail('PSG input contains no frame marker.');
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
  writeU32BE(result, 16, 0);
  writeU16BE(result, 20, 0);
  writeU32BE(result, 22, options.chipClockHz);
  writeU16BE(result, 26, options.frameRateHz);
  writeU32BE(result, 28, 0xffff_ffff);
  writeU16BE(result, 32, 0);

  let offset = YM6_HEADER_LENGTH;
  for (const field of metadata) {
    result.set(field, offset);
    offset += field.length + 1;
  }
  for (const frame of frames) {
    result.set(frame, offset);
    offset += REGISTER_COUNT;
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
  if (attributes !== 0 || digidrumCount !== 0 || extraDataSize !== 0) {
    fail(
      'YM6 runtime input uses unsupported attributes, digidrums, or extra data.',
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
    const offset = comment.offset + frame * REGISTER_COUNT;
    frames.push(bytes.slice(offset, offset + REGISTER_COUNT));
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

export function parseYm3(bytes: Uint8Array): readonly RegisterFrame[] {
  if (!hasMagic(bytes, 'YM3!')) {
    fail('YM3 input has an invalid header.');
  }
  const payloadLength = bytes.length - 4;
  if (payloadLength <= 0 || payloadLength % 14 !== 0) {
    fail(
      `YM3 payload length ${payloadLength} is not a positive multiple of 14.`,
    );
  }
  const frameCount = payloadLength / 14;
  const frames: RegisterFrame[] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = new Uint8Array(REGISTER_COUNT);
    for (let register = 0; register < 14; register += 1) {
      frame[register] = bytes[4 + register * frameCount + frameIndex] ?? 0;
    }
    frames.push(frame);
  }
  return frames;
}

export function prepareYmRuntime(
  bytes: Uint8Array,
  options: Ym6Options,
): YmRuntimePreparation {
  if (hasMagic(bytes, 'YM6!')) {
    const parsed = parseYm6(bytes);
    if (
      parsed.chipClockHz !== options.chipClockHz ||
      parsed.frameRateHz !== options.frameRateHz
    ) {
      fail(
        'YM6 embedded clock or frame rate conflicts with the requested runtime.',
      );
    }
    return {
      bytes: bytes.slice(),
      format: 'YM6',
      mode: 'copy',
      frames: parsed.frames,
    };
  }

  if (hasMagic(bytes, 'YM3!')) {
    const frames = parseYm3(bytes);
    return {
      bytes: createYm6(frames, options),
      format: 'YM6',
      mode: 'normalize',
      frames,
    };
  }

  fail(
    'Unsupported YM input; the Phase 2 proof accepts YM3 and compliant YM6.',
  );
}
