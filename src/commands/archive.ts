// `inbox-to-md archive <md dir>` — argument parsing and process exit status
// for the archive engine in core/archive.ts.

import { statSync } from 'fs';
import { resolve } from 'path';
import { red } from '../core/ansi.js';
import { runArchive } from '../core/archive.js';
import { loadConfig } from '../core/config.js';
import { errorMessage } from '../core/errors.js';

const USAGE = 'Usage: inbox-to-md archive <md dir>';

function parseDirArg(argv: string[]): string {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    throw new Error(USAGE);
  }
  const dir = resolve(argv[0]);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`No such directory: ${dir}\n${USAGE}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dir}\n${USAGE}`);
  return dir;
}

async function main(): Promise<void> {
  const dir = parseDirArg(process.argv.slice(2));
  const ok = await runArchive(loadConfig(), dir);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(red(errorMessage(err)));
  process.exitCode = 1;
});
