import { lookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type RemoteDownload = {
  readonly bytes: Buffer;
  readonly finalUrl: string;
  readonly originalFileName: string;
};

type ResolvedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

function sanitizedUrl(input: URL): string {
  const copy = new URL(input);
  copy.username = '';
  copy.password = '';
  copy.hash = '';
  return copy.toString();
}

function parseIpv4(address: string): readonly number[] | undefined {
  const parts = address.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
}

function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (parts === undefined) return true;
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Expands any accepted IPv6 form to its sixteen bytes. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  const [head = '', tail, extra] = address.split('::');
  if (extra !== undefined) return undefined;
  const readGroups = (value: string): number[] | undefined => {
    if (value === '') return [];
    const groups: number[] = [];
    for (const group of value.split(':')) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const leading = readGroups(head);
  const trailing = tail === undefined ? [] : readGroups(tail);
  if (leading === undefined || trailing === undefined) return undefined;
  const missing = 8 - leading.length - trailing.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return undefined;
  const groups = [...leading, ...Array<number>(missing).fill(0), ...trailing];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/**
 * Exported for tests. Fails closed: anything not recognised as a routable
 * public address is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return isBlockedIpv4(address);
  if (!net.isIPv6(address)) return true;
  // Compare on the expanded bytes rather than on text. `::1` and
  // `0:0:0:0:0:0:0:1` are the same address, and `2001:db8::` and `2001:0db8::`
  // are the same prefix; a `startsWith` check on the compressed form only
  // happens to work for the shapes `dns.lookup` returns today.
  const bytes = ipv6Bytes(address.toLowerCase().split('%')[0] ?? '');
  if (bytes === undefined) return true;
  const [first = 0, second = 0] = bytes;
  // `::`, `::1`, and the rest of the reserved low range.
  if (bytes.subarray(0, 15).every((byte) => byte === 0)) return true;
  // IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible (`::/96`) forms are never
  // legitimate AAAA answers for a public archive, so reject them outright rather
  // than trying to re-derive the embedded IPv4.
  if (bytes.subarray(0, 10).every((byte) => byte === 0)) return true;
  return (
    (first & 0xfe) === 0xfc || // fc00::/7 unique local
    (first === 0xfe && (second & 0xc0) === 0x80) || // fe80::/10 link local
    first === 0xff || // ff00::/8 multicast
    (first === 0x20 &&
      second === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8) // 2001:db8::/32
  );
}

async function resolvePublic(hostname: string): Promise<ResolvedAddress[]> {
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('destination is localhost');
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error('DNS returned no addresses');
  }
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('DNS returned a prohibited address');
  }
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}

function validateUrl(value: string, hop: number): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`remote URL at redirect hop ${hop} is invalid`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`remote URL at redirect hop ${hop} must use HTTPS`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`remote URL at redirect hop ${hop} contains credentials`);
  }
  url.hash = '';
  return url;
}

async function requestOnce(
  url: URL,
  signal: AbortSignal,
  addresses: readonly ResolvedAddress[],
): Promise<{
  readonly status: number;
  readonly location: string | undefined;
  readonly bytes: Buffer;
}> {
  return await new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        agent: false,
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          'User-Agent': 'zxmusicfm-content/1',
        },
        lookup: (_hostname, options, callback) => {
          const requestedFamily =
            typeof options === 'number' ? options : (options.family ?? 0);
          const all = typeof options === 'object' && options.all === true;
          if (all) {
            const matching = addresses.filter((candidate) =>
              requestedFamily === 0
                ? true
                : candidate.family === requestedFamily,
            );
            if (matching.length === 0) {
              callback(new Error('validated DNS result is unavailable'), []);
              return;
            }
            callback(null, matching);
            return;
          }
          const address =
            addresses.find((candidate) =>
              requestedFamily === 0
                ? true
                : candidate.family === requestedFamily,
            ) ?? addresses[0];
          if (address === undefined) {
            callback(new Error('validated DNS result is unavailable'), '', 0);
            return;
          }
          callback(null, address.address, address.family);
        },
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECT_STATUSES.has(status)) {
          response.resume();
          resolve({ status, location, bytes: Buffer.alloc(0) });
          return;
        }
        if (status < 200 || status > 299) {
          response.resume();
          reject(new Error(`HTTP status ${status}`));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          response.destroy();
          reject(new Error('declared response exceeds 16 MiB'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_BYTES) {
            response.destroy(new Error('response exceeds 16 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (length === 0) {
            reject(new Error('response is empty'));
            return;
          }
          resolve({ status, location, bytes: Buffer.concat(chunks, length) });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export async function downloadRemoteFile(
  input: string,
): Promise<RemoteDownload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const visited = new Set<string>();
  let url = validateUrl(input, 0);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const displayUrl = sanitizedUrl(url);
      if (visited.has(displayUrl)) {
        throw new Error(`redirect loop at hop ${hop}: ${displayUrl}`);
      }
      visited.add(displayUrl);
      let addresses: ResolvedAddress[];
      try {
        addresses = await resolvePublic(url.hostname);
      } catch (error) {
        throw new Error(
          `DNS validation failed at hop ${hop} for ${displayUrl}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      let response: Awaited<ReturnType<typeof requestOnce>>;
      try {
        response = await requestOnce(url, controller.signal, addresses);
      } catch (error) {
        const category = controller.signal.aborted ? 'timeout' : 'request';
        throw new Error(
          `${category} failure at hop ${hop} for ${displayUrl}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        const pathname = decodeURIComponent(url.pathname);
        const name = pathname.split('/').filter(Boolean).at(-1) ?? 'download';
        return {
          bytes: response.bytes,
          finalUrl: displayUrl,
          originalFileName: name,
        };
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`redirect limit exceeded for ${displayUrl}`);
      }
      if (response.location === undefined) {
        throw new Error(
          `redirect at hop ${hop} has no Location: ${displayUrl}`,
        );
      }
      url = validateUrl(new URL(response.location, url).toString(), hop + 1);
    }
    // Unreachable: the final iteration either returns or throws. Kept because
    // control-flow analysis cannot see that, and the function returns a value.
    throw new Error('redirect limit exceeded');
  } finally {
    clearTimeout(timeout);
  }
}
