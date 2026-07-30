// `inbox-to-md compact` — process exit status for the compaction engine in
// core/compact.ts. It takes no arguments.

import { red } from '../core/ansi.js';
import { runCompact } from '../core/compact.js';
import { loadConfig } from '../core/config.js';
import { errorMessage } from '../core/errors.js';

async function main(): Promise<void> {
  if (await runCompact(loadConfig())) return;
  console.error('no synced emails found for any account — run `inbox-to-md sync` first');
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(red(errorMessage(err)));
  process.exitCode = 1;
});
