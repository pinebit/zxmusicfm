import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  detectSupportedSource,
  discoverTrackInputs,
  generateFoundationContent,
  validateContent,
} from './foundation.ts';
import { downloadRemoteFile } from './remote.ts';
import {
  trackSidecarSchema,
  type TrackSidecar,
} from '../../src/content/schemas.ts';

const supportedCommands = [
  'generate',
  'import',
  'remove',
  'update',
  'validate',
] as const;
type Command = (typeof supportedCommands)[number];
type Arguments = ReadonlyMap<string, string | true>;

function isCommand(value: string | undefined): value is Command {
  return supportedCommands.some((command) => command === value);
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !value.startsWith('--') || value.length === 2) {
      throw new Error(`Unexpected argument: ${value ?? '<missing>'}.`);
    }
    const key = value.slice(2);
    if (parsed.has(key)) throw new Error(`Duplicate option --${key}.`);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed.set(key, next);
      index += 1;
    } else {
      parsed.set(key, true);
    }
  }
  return parsed;
}

function stringOption(
  argumentsMap: Arguments,
  key: string,
): string | undefined {
  const value = argumentsMap.get(key);
  if (value === true) throw new Error(`--${key} requires a value.`);
  return value;
}

function booleanOption(argumentsMap: Arguments, key: string): boolean {
  const value = argumentsMap.get(key);
  if (typeof value === 'string')
    throw new Error(`--${key} does not accept a value.`);
  return value === true;
}

function numberOption(
  argumentsMap: Arguments,
  key: string,
): number | undefined {
  const value = stringOption(argumentsMap, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`--${key} must be a finite number.`);
  return parsed;
}

function assertKnown(
  argumentsMap: Arguments,
  allowed: readonly string[],
): void {
  for (const key of argumentsMap.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown option --${key}.`);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  if (await exists(source)) await cp(source, destination, { recursive: true });
}

async function createStage(root: string): Promise<string> {
  const stage = await mkdtemp(path.join(root, '.content-stage-'));
  await mkdir(path.join(stage, 'public'), { recursive: true });
  await copyIfPresent(path.join(root, 'content'), path.join(stage, 'content'));
  await copyIfPresent(
    path.join(root, 'public', 'generated'),
    path.join(stage, 'public', 'generated'),
  );
  await copyIfPresent(path.join(root, 'vendor'), path.join(stage, 'vendor'));
  return stage;
}

async function replaceDirectory(
  staged: string,
  destination: string,
  backup: string,
): Promise<boolean> {
  const hadDestination = await exists(destination);
  if (hadDestination) await rename(destination, backup);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(staged, destination);
  return hadDestination;
}

async function commitStage(root: string, stage: string): Promise<void> {
  const suffix = `.backup-${process.pid}`;
  const content = path.join(root, 'content');
  const publicGenerated = path.join(root, 'public', 'generated');
  const contentBackup = `${content}${suffix}`;
  const publicBackup = `${publicGenerated}${suffix}`;
  let contentMoved = false;
  let publicMoved = false;
  let hadContent = false;
  let hadPublic = false;
  try {
    hadContent = await replaceDirectory(
      path.join(stage, 'content'),
      content,
      contentBackup,
    );
    contentMoved = true;
    hadPublic = await replaceDirectory(
      path.join(stage, 'public', 'generated'),
      publicGenerated,
      publicBackup,
    );
    publicMoved = true;
    if (hadContent) await rm(contentBackup, { recursive: true, force: true });
    if (hadPublic) await rm(publicBackup, { recursive: true, force: true });
  } catch (error) {
    if (publicMoved)
      await rm(publicGenerated, { recursive: true, force: true });
    if (hadPublic && (await exists(publicBackup))) {
      await rename(publicBackup, publicGenerated);
    }
    if (contentMoved) await rm(content, { recursive: true, force: true });
    if (hadContent && (await exists(contentBackup))) {
      await rename(contentBackup, content);
    }
    throw error;
  }
}

async function mutateAtomically(
  root: string,
  mutation: (stage: string) => Promise<void>,
): Promise<void> {
  const stage = await createStage(root);
  try {
    await mutation(stage);
    await generateFoundationContent(stage);
    await validateContent(stage);
    await commitStage(root, stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function promptFor(
  current: string | undefined,
  label: string,
  nonInteractive: boolean,
): Promise<string> {
  if (current !== undefined && current.trim() !== '') return current;
  if (nonInteractive || !process.stdin.isTTY) {
    throw new Error(`Missing required --${label}.`);
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await terminal.question(`${label}: `)).trim();
    if (answer === '') throw new Error(`${label} is required.`);
    return answer;
  } finally {
    terminal.close();
  }
}

async function acquireSource(
  root: string,
  argumentsMap: Arguments,
): Promise<{
  readonly bytes: Buffer;
  readonly originalFileName: string;
  readonly retrieval: string;
}> {
  const file = stringOption(argumentsMap, 'file');
  const url = stringOption(argumentsMap, 'url');
  if ((file === undefined) === (url === undefined)) {
    throw new Error('Provide exactly one of --file or --url.');
  }
  if (file !== undefined) {
    const filePath = path.resolve(root, file);
    const bytes = await readFile(filePath);
    if (bytes.length === 0) throw new Error(`${filePath}: source is empty.`);
    return {
      bytes,
      originalFileName: path.basename(filePath),
      retrieval: filePath,
    };
  }
  const downloaded = await downloadRemoteFile(url ?? '');
  return {
    bytes: downloaded.bytes,
    originalFileName: downloaded.originalFileName,
    retrieval: downloaded.finalUrl,
  };
}

function sidecarFromArguments(
  argumentsMap: Arguments,
  required: {
    readonly id: string;
    readonly title: string;
    readonly author: string;
    readonly sourceUrl: string;
  },
  order: number,
): TrackSidecar {
  const optional = <T>(value: T | undefined): T | undefined => value;
  const raw = {
    schemaVersion: 1,
    id: required.id,
    order,
    title: required.title,
    author: required.author,
    sourceUrl: required.sourceUrl,
    subsong: numberOption(argumentsMap, 'subsong') ?? 1,
    chipType: optional(stringOption(argumentsMap, 'chip-type')),
    chipClockHz: numberOption(argumentsMap, 'chip-clock-hz'),
    frameRateHz: numberOption(argumentsMap, 'frame-rate-hz'),
    channelLayout: optional(stringOption(argumentsMap, 'channel-layout')),
    year: numberOption(argumentsMap, 'year'),
    notes: optional(stringOption(argumentsMap, 'notes')),
    durationOverrideSeconds: numberOption(
      argumentsMap,
      'duration-override-seconds',
    ),
  };
  return trackSidecarSchema.parse(
    Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined),
    ),
  );
}

async function shiftForInsertion(stage: string, order: number): Promise<void> {
  const inputs = await discoverTrackInputs(stage);
  if (order < 1 || order > inputs.length + 1) {
    throw new Error(`--order must be between 1 and ${inputs.length + 1}.`);
  }
  for (const input of [...inputs].reverse()) {
    if (input.sidecar.order >= order) {
      await writeJson(path.join(input.directory, 'track.json'), {
        ...input.sidecar,
        order: input.sidecar.order + 1,
      });
    }
  }
}

const metadataOptions = [
  'id',
  'order',
  'title',
  'author',
  'source-url',
  'subsong',
  'chip-type',
  'chip-clock-hz',
  'frame-rate-hz',
  'channel-layout',
  'year',
  'notes',
  'duration-override-seconds',
] as const;

async function importTrack(
  root: string,
  values: readonly string[],
): Promise<void> {
  const args = parseArguments(values);
  assertKnown(args, [...metadataOptions, 'file', 'url', 'non-interactive']);
  const nonInteractive = booleanOption(args, 'non-interactive');
  const source = await acquireSource(root, args);
  const detected = detectSupportedSource(source.bytes, source.originalFileName);
  const id = await promptFor(stringOption(args, 'id'), 'id', nonInteractive);
  const title = await promptFor(
    stringOption(args, 'title'),
    'title',
    nonInteractive,
  );
  const author = await promptFor(
    stringOption(args, 'author'),
    'author',
    nonInteractive,
  );
  const sourceUrl = await promptFor(
    stringOption(args, 'source-url'),
    'source-url',
    nonInteractive,
  );
  const order = numberOption(args, 'order');
  if (order === undefined || !Number.isInteger(order)) {
    throw new Error('Missing required integer --order.');
  }
  const sidecar = sidecarFromArguments(
    args,
    { id, title, author, sourceUrl },
    order,
  );

  await mutateAtomically(root, async (stage) => {
    const directory = path.join(stage, 'content', 'tracks', id);
    if (await exists(directory)) throw new Error(`Track ${id} already exists.`);
    await shiftForInsertion(stage, order);
    await mkdir(path.join(directory, 'generated'), { recursive: true });
    await writeFile(
      path.join(directory, `source${detected.extension}`),
      source.bytes,
    );
    await writeJson(path.join(directory, 'track.json'), sidecar);
    await writeFile(
      path.join(directory, 'generated', 'original-name.txt'),
      `${source.originalFileName}\n`,
    );
  });
  process.stdout.write(
    `Imported ${id} (${detected.format}, ${source.bytes.length} bytes) from ${source.retrieval}; generated and validated canonical assets.\n`,
  );
}

async function reorderTrack(
  stage: string,
  id: string,
  requestedOrder: number,
): Promise<void> {
  const inputs = await discoverTrackInputs(stage);
  const current = inputs.find((input) => input.sidecar.id === id);
  if (current === undefined) throw new Error(`Unknown track: ${id}.`);
  if (requestedOrder < 1 || requestedOrder > inputs.length) {
    throw new Error(`--order must be between 1 and ${inputs.length}.`);
  }
  const oldOrder = current.sidecar.order;
  for (const input of inputs) {
    let order = input.sidecar.order;
    if (input.sidecar.id === id) order = requestedOrder;
    else if (
      requestedOrder < oldOrder &&
      order >= requestedOrder &&
      order < oldOrder
    )
      order += 1;
    else if (
      requestedOrder > oldOrder &&
      order > oldOrder &&
      order <= requestedOrder
    )
      order -= 1;
    if (order !== input.sidecar.order) {
      await writeJson(path.join(input.directory, 'track.json'), {
        ...input.sidecar,
        order,
      });
    }
  }
}

async function updateTrack(
  root: string,
  values: readonly string[],
): Promise<void> {
  const args = parseArguments(values);
  assertKnown(args, [
    ...metadataOptions,
    'file',
    'url',
    'replace-source',
    'non-interactive',
  ]);
  const id = stringOption(args, 'id');
  if (id === undefined) throw new Error('Missing required --id.');
  const replacementRequested = booleanOption(args, 'replace-source');
  const replacement = replacementRequested
    ? await acquireSource(root, args)
    : undefined;
  if (!replacementRequested && (args.has('file') || args.has('url'))) {
    throw new Error(
      'Replacing an authoritative source requires --replace-source.',
    );
  }
  if (
    !replacementRequested &&
    [...args.keys()].every((key) => ['id', 'non-interactive'].includes(key))
  ) {
    throw new Error('Update requires at least one changed field.');
  }

  await mutateAtomically(root, async (stage) => {
    const inputs = await discoverTrackInputs(stage);
    const input = inputs.find((candidate) => candidate.sidecar.id === id);
    if (input === undefined) throw new Error(`Unknown track: ${id}.`);
    const order = numberOption(args, 'order');
    if (order !== undefined) {
      if (!Number.isInteger(order))
        throw new Error('--order must be an integer.');
      await reorderTrack(stage, id, order);
    }
    const refreshed = (await discoverTrackInputs(stage)).find(
      (candidate) => candidate.sidecar.id === id,
    );
    if (refreshed === undefined) throw new Error(`Unknown track: ${id}.`);
    const mapping: Readonly<Record<string, keyof TrackSidecar>> = {
      title: 'title',
      author: 'author',
      'source-url': 'sourceUrl',
      subsong: 'subsong',
      'chip-type': 'chipType',
      'chip-clock-hz': 'chipClockHz',
      'frame-rate-hz': 'frameRateHz',
      'channel-layout': 'channelLayout',
      year: 'year',
      notes: 'notes',
      'duration-override-seconds': 'durationOverrideSeconds',
    };
    const updated: Record<string, unknown> = { ...refreshed.sidecar };
    for (const [option, field] of Object.entries(mapping)) {
      if (!args.has(option)) continue;
      updated[field] = [
        'subsong',
        'chip-clock-hz',
        'frame-rate-hz',
        'year',
        'duration-override-seconds',
      ].includes(option)
        ? numberOption(args, option)
        : stringOption(args, option);
    }
    await writeJson(
      path.join(refreshed.directory, 'track.json'),
      trackSidecarSchema.parse(updated),
    );
    if (replacement !== undefined) {
      const detected = detectSupportedSource(
        replacement.bytes,
        replacement.originalFileName,
      );
      await rm(refreshed.sourcePath);
      await writeFile(
        path.join(refreshed.directory, `source${detected.extension}`),
        replacement.bytes,
      );
      await mkdir(path.join(refreshed.directory, 'generated'), {
        recursive: true,
      });
      await writeFile(
        path.join(refreshed.directory, 'generated', 'original-name.txt'),
        `${replacement.originalFileName}\n`,
      );
    }
  });
  process.stdout.write(
    `Updated ${id}; regenerated and validated all affected assets.\n`,
  );
}

async function removeTrack(
  root: string,
  values: readonly string[],
): Promise<void> {
  const args = parseArguments(values);
  assertKnown(args, ['id', 'yes', 'non-interactive']);
  const id = stringOption(args, 'id');
  if (id === undefined) throw new Error('Missing required --id.');
  const nonInteractive = booleanOption(args, 'non-interactive');
  let confirmed = booleanOption(args, 'yes');
  const target = path.join(root, 'content', 'tracks', id);
  process.stdout.write(
    `Remove track directory ${target} and its catalog entry.\n`,
  );
  if (!confirmed && nonInteractive) {
    throw new Error('Non-interactive removal requires --yes.');
  }
  if (!confirmed) {
    if (!process.stdin.isTTY)
      throw new Error('Removal confirmation requires --yes.');
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      confirmed =
        (await terminal.question('Type the track ID to confirm: ')).trim() ===
        id;
    } finally {
      terminal.close();
    }
  }
  if (!confirmed) throw new Error('Removal was not confirmed.');

  await mutateAtomically(root, async (stage) => {
    const inputs = await discoverTrackInputs(stage);
    const input = inputs.find((candidate) => candidate.sidecar.id === id);
    if (input === undefined) throw new Error(`Unknown track: ${id}.`);
    await rm(input.directory, { recursive: true });
    for (const remaining of inputs.filter(
      (candidate) => candidate.sidecar.order > input.sidecar.order,
    )) {
      await writeJson(path.join(remaining.directory, 'track.json'), {
        ...remaining.sidecar,
        order: remaining.sidecar.order - 1,
      });
    }
  });
  process.stdout.write(
    `Removed ${id}; regenerated and validated remaining content.\n`,
  );
}

async function main(): Promise<void> {
  const [commandInput, ...argumentsList] = process.argv.slice(2);
  if (!isCommand(commandInput)) {
    throw new Error(`Expected one command: ${supportedCommands.join(', ')}.`);
  }
  const root = path.resolve(process.cwd());
  switch (commandInput) {
    case 'generate':
      assertKnown(parseArguments(argumentsList), []);
      await generateFoundationContent(root);
      process.stdout.write('Generated deterministic content artifacts.\n');
      return;
    case 'validate': {
      assertKnown(parseArguments(argumentsList), []);
      const result = await validateContent(root);
      process.stdout.write(
        `Content valid (${result.trackCount} tracks).\n`,
      );
      return;
    }
    case 'import':
      await importTrack(root, argumentsList);
      return;
    case 'update':
      await updateTrack(root, argumentsList);
      return;
    case 'remove':
      await removeTrack(root, argumentsList);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Content command failed: ${message}\n`);
  process.exitCode = 1;
});
