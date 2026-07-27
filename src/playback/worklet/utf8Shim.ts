type DecoderInput = ArrayBuffer | ArrayBufferView | undefined;

const scope = globalThis as {
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
};

if (typeof scope.TextDecoder === 'undefined') {
  class TextDecoderShim {
    decode(input?: DecoderInput): string {
      const bytes =
        input === undefined
          ? new Uint8Array()
          : input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let output = '';
      for (let index = 0; index < bytes.length;) {
        const first = bytes[index];
        if (first === undefined) break;
        index += 1;
        if (first < 0x80) {
          output += String.fromCharCode(first);
          continue;
        }

        const continuationCount =
          first < 0xe0 ? 1 : first < 0xf0 ? 2 : first < 0xf8 ? 3 : -1;
        if (continuationCount < 0 || index + continuationCount > bytes.length) {
          output += '\uFFFD';
          continue;
        }

        let codePoint = first & (0x7f >> continuationCount);
        let valid = true;
        for (let offset = 0; offset < continuationCount; offset += 1) {
          const next = bytes[index];
          if (next === undefined) {
            valid = false;
            break;
          }
          index += 1;
          if ((next & 0xc0) !== 0x80) {
            valid = false;
            break;
          }
          codePoint = (codePoint << 6) | (next & 0x3f);
        }
        output += valid ? String.fromCodePoint(codePoint) : '\uFFFD';
      }
      return output;
    }
  }

  scope.TextDecoder = TextDecoderShim as unknown as typeof TextDecoder;
}

if (typeof scope.TextEncoder === 'undefined') {
  class TextEncoderShim {
    encode(input = ''): Uint8Array {
      const bytes: number[] = [];
      for (const character of input) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint < 0x80) {
          bytes.push(codePoint);
        } else if (codePoint < 0x800) {
          bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint < 0x10000) {
          bytes.push(
            0xe0 | (codePoint >> 12),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f),
          );
        } else {
          bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 0x3f),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f),
          );
        }
      }
      return Uint8Array.from(bytes);
    }

    encodeInto(
      input: string,
      destination: Uint8Array,
    ): TextEncoderEncodeIntoResult {
      const encoded = this.encode(input);
      const written = Math.min(encoded.length, destination.length);
      destination.set(encoded.subarray(0, written));
      return { read: input.length, written };
    }
  }

  scope.TextEncoder = TextEncoderShim as unknown as typeof TextEncoder;
}
