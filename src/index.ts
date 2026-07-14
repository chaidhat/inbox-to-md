// `npm start` — sync all configured inboxes to markdown.
//
//   npm start                          sync since the 1st of last month
//   npm start -- --since 2026-01-01    sync since a specific date

import { red } from './ansi.js';
import { loadConfig } from './config.js';
import { runSync } from './sync.js';

const USAGE = 'Usage: npm start [-- --since YYYY-MM-DD]';

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

function parseArgs(argv: string[]): { since: Date | undefined } {
  let since: Date | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--since requires a value\n${USAGE}`);
      since = parseSinceValue(value);
    } else if (arg.startsWith('--since=')) {
      since = parseSinceValue(arg.slice('--since='.length));
    } else {
      throw new Error(`Unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return { since };
}

async function main(): Promise<void> {
  const { since } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const ok = await runSync(config, since);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
