#!/usr/bin/env node
// `inbox-to-md <command>` — the npm bin entry. Dispatches to the same entry
// modules the npm scripts use:
//
//   inbox-to-md auth                     manage IMAP accounts (interactive TUI)
//   inbox-to-md sync [flags]             sync inboxes to markdown (default command)
//   inbox-to-md compact                  compact synced emails into one digest
//   inbox-to-md archive <md dir>         archive the emails behind the .md files
//
// Each entry module runs its own main() on import and reads its arguments
// from process.argv.slice(2), so the command token is spliced out before the
// dynamic import.

import { createRequire } from 'module';

const COMMANDS: Record<string, string> = {
  sync: './index.js',
  auth: './auth.js',
  compact: './compact.js',
  archive: './archive.js',
};

const USAGE = `Usage: inbox-to-md <command>

Commands:
  auth                 manage IMAP accounts (interactive TUI)
  sync [--since YYYY-MM-DD] [--force-rewrite]
                       sync inboxes to markdown (default command)
  compact              compact synced emails into one digest per account
  archive <md dir>     archive the emails behind the .md files in a directory

Options:
  -h, --help           show this help
  -v, --version        print the version`;

const arg = process.argv[2];

if (arg === '-h' || arg === '--help') {
  console.log(USAGE);
} else if (arg === '-v' || arg === '--version') {
  const require = createRequire(import.meta.url);
  console.log(require('../package.json').version);
} else if (arg !== undefined && !arg.startsWith('-') && !(arg in COMMANDS)) {
  console.error(`Unknown command "${arg}"\n\n${USAGE}`);
  process.exitCode = 1;
} else {
  // A known command is consumed; a flag or nothing falls through to `sync`
  // with the arguments untouched.
  const command = arg !== undefined && arg in COMMANDS ? arg : 'sync';
  if (command === process.argv[2]) process.argv.splice(2, 1);
  await import(COMMANDS[command]);
}
