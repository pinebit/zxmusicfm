import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

type EngineManifest = {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly files: Readonly<Record<string, string>>;
};

const vendorDirectory = path.resolve('vendor/ym2149');
const manifestPath = path.join(vendorDirectory, 'manifest.json');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as EngineManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.revision)
  ) {
    throw new Error('vendor/ym2149/manifest.json has an invalid revision.');
  }

  for (const [file, expected] of Object.entries(manifest.files)) {
    const actual = sha256(await readFile(path.join(vendorDirectory, file)));
    if (actual !== expected) {
      throw new Error(
        `vendor/ym2149/${file} is stale: expected ${expected}, received ${actual}.`,
      );
    }
  }

  const declarations = await readFile(
    path.join(vendorDirectory, 'ym2149_wasm.d.ts'),
    'utf8',
  );
  for (const method of [
    'generateSamplesWithChannels',
    'getChannelOutputs',
    'seek_to_frame',
    'channelCount',
  ]) {
    if (!declarations.includes(method)) {
      throw new Error(`Pinned engine bindings are missing ${method}.`);
    }
  }

  console.log(
    `ym2149-rs ${manifest.revision} artifacts verified (${Object.keys(manifest.files).length} files).`,
  );
}

await main();
