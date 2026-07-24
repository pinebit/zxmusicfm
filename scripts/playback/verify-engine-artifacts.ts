import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ENGINE_COMMIT } from '../../src/playback/enginePin.ts';

type EngineManifest = {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly files: Readonly<Record<string, string>>;
};

const vendorDirectory = path.resolve('vendor/ym2149');
const manifestPath = path.join(vendorDirectory, 'manifest.json');

// Bindings the runtime and the content pipeline actually call. A vendor drop
// that renames or removes any of them has to fail here rather than at playback.
const requiredBindings = [
  'generateSamples',
  'generateSamplesWithChannels',
  'getChannelStates',
  'channelCount',
  'get_registers',
  'hasDurationInfo',
  'duration_seconds',
  'play',
  'pause',
  'free',
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as EngineManifest;
  if (manifest.schemaVersion !== 1) {
    throw new Error('vendor/ym2149/manifest.json has an unsupported schema.');
  }
  // The pin lives in src/playback/enginePin.ts; this is what stops the vendored
  // artifacts from drifting away from the provenance schema and the pipeline.
  if (manifest.revision !== ENGINE_COMMIT) {
    throw new Error(
      `vendor/ym2149/manifest.json records revision ${manifest.revision}, but the pinned engine is ${ENGINE_COMMIT}.`,
    );
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
  for (const binding of requiredBindings) {
    if (!declarations.includes(binding)) {
      throw new Error(`Pinned engine bindings are missing ${binding}.`);
    }
  }

  console.log(
    `ym2149-rs ${manifest.revision} artifacts verified (${Object.keys(manifest.files).length} files, ${requiredBindings.length} bindings).`,
  );
}

await main();
