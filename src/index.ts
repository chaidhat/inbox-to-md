// `npm start` — sync all configured inboxes to markdown.
//
//   npm start                          sync since the 1st of last month
//   npm start -- --since 2026-01-01    sync since a specific date
//   npm start -- --force-rewrite       re-download and overwrite already-synced files

import { red } from './ansi.js';
import { loadConfig } from './config.js';
import { runSync } from './sync.js';

const USAGE = 'Usage: inbox-to-md sync [--since YYYY-MM-DD] [--force-rewrite]';

// Strict YYYY-MM-DD, validated by round-trip so e.g. 2026-02-31 is rejected
// rather than silently rolling over into March.
function parseSinceValue(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid --since date "${value}" (expected YYYY-MM-DD)\n${USAGE}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid --since date "${value}" (no such day)\n${USAGE}`);
  }
  return date;
}

function parseArgs(argv: string[]): { since: Date | undefined; forceRewrite: boolean } {
  let since: Date | undefined;
  let forceRewrite = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--since requires a value\n${USAGE}`);
      since = parseSinceValue(value);
    } else if (arg.startsWith('--since=')) {
      since = parseSinceValue(arg.slice('--since='.length));
    } else if (arg === '--force-rewrite') {
      forceRewrite = true;
    } else {
      throw new Error(`Unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return { since, forceRewrite };
}

async function main(): Promise<void> {
  const { since, forceRewrite } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const ok = await runSync(config, since, forceRewrite);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
