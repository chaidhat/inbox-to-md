// Read-only access to the synced email markdown files, addressed by index:
// 0 is the oldest email, getNumberOfEmails() - 1 the newest. Filenames start
// with a YYYY-MM-DD stamp (see markdown.ts buildFilename), so a lexicographic
// sort on the basename is chronological.

import { readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { loadConfig } from './config.js';

// Loaded once at import time; the sync paths are stable for a run.
const emailPaths: string[] = loadConfig()
  .accounts.flatMap((account) =>
    readdirSync(account.syncPath)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, path: join(account.syncPath, name) })),
  )
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) => entry.path);

export function getNumberOfEmails(): number {
  return emailPaths.length;
}

// Basename of email n without the .md extension, e.g. "2026-05-20-re" —
// used as the citation key in compacted digests.
export function getEmailCitationKey(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= emailPaths.length) {
    throw new RangeError(`email index ${n} out of range [0, ${emailPaths.length})`);
  }
  return basename(emailPaths[n], '.md');
}

export function getEmail(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= emailPaths.length) {
    throw new RangeError(`email index ${n} out of range [0, ${emailPaths.length})`);
  }
  return readFileSync(emailPaths[n], 'utf8');
}

// Concatenation of emails i (inclusive) through j (exclusive). Built with
// slice + join instead of `s +=` in a loop so one call is O(total bytes),
// not O(total bytes squared).
export function getEmailSubstrings(i: number, j: number): string {
  const n = getNumberOfEmails();
  const start = Math.max(0, i);
  const end = Math.min(j, n);
  const parts: string[] = [];
  for (let k = start; k < end; k++) {
    parts.push(getEmail(k));
  }
  return parts.join('');
}
