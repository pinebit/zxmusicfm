import path from 'node:path';

import {
  generateFoundationContent,
  resolveValidationMode,
  validateContent,
} from './foundation.ts';

const supportedCommands = [
  'generate',
  'import',
  'remove',
  'update',
  'validate',
] as const;

type Command = (typeof supportedCommands)[number];

function isCommand(value: string | undefined): value is Command {
  return supportedCommands.some((command) => command === value);
}

async function main(): Promise<void> {
  const [commandInput, ...argumentsList] = process.argv.slice(2);
  if (!isCommand(commandInput)) {
    throw new Error(`Expected one command: ${supportedCommands.join(', ')}.`);
  }

  const root = path.resolve(process.cwd());
  switch (commandInput) {
    case 'generate':
      await generateFoundationContent(root);
      process.stdout.write(
        'Generated deterministic Phase 1 content artifacts.\n',
      );
      return;
    case 'validate': {
      const mode = resolveValidationMode(argumentsList, process.env);
      const result = await validateContent(root, mode);
      process.stdout.write(
        `Content valid (${result.mode}, ${result.trackCount} tracks).\n`,
      );
      return;
    }
    case 'import':
    case 'remove':
    case 'update':
      throw new Error(
        `${commandInput} is reserved by the command contract and will be implemented in Phase 3; no files were changed.`,
      );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Content command failed: ${message}\n`);
  process.exitCode = 1;
});
