// `npm start` — sync all configured inboxes to markdown.

import { red } from './ansi.js';
import { loadConfig } from './config.js';
import { runSync } from './sync.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ok = await runSync(config);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
