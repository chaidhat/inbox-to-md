// Read-only access to the synced email markdown files of one sync directory.
// Filenames start with a YYYY-MM-DD stamp (see markdown.ts buildFilename), so
// a lexicographic sort on the basename is chronological.

import { readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';

export interface SyncedEmail {
  path: string;
  // Basename without the .md extension, e.g. "2026-05-20-re" — used as the
  // citation key in compacted digests.
  citationKey: string;
}

// Emails in syncPath, oldest first.
export function listSyncedEmails(syncPath: string): SyncedEmail[] {
  return readdirSync(syncPath)
    .filter((name: string) => name.endsWith('.md'))
    .sort((a: string, b: string) => a.localeCompare(b))
    .map((name: string) => ({ path: join(syncPath, name), citationKey: basename(name, '.md') }));
}

export function readSyncedEmail(email: SyncedEmail): string {
  return readFileSync(email.path, 'utf8');
}
