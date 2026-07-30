// Sync engine. For each configured account, fetches every email the account
// can see within the window (this month and last month by default) and writes
// one markdown file per email into the account's sync path. Idempotent: emails
// already on disk (matched by message-id in the files' frontmatter) are skipped
// without downloading their bodies — unless --force-rewrite, which re-downloads
// them and overwrites the files in place (e.g. to pick up frontmatter added by
// a newer version of renderEmail). Mirrors deletions too: a file whose email
// has vanished from the server (and whose date is safely inside the sync
// window) is deleted after a clean sync.
//
// Nothing here knows a protocol — a MailSource supplies the messages. See
// core/mail-source.ts.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { openMailSource } from '../integration/open.js';
import { bold, dim, green, red } from './ansi.js';
import type { Account, Config } from './config.js';
import { errorMessage } from './errors.js';
import type { ChangeResult, ListResult, MailSource, MessageRef } from './mail-source.js';
import { buildFilename, fallbackHash, listSyncedFiles, readSyncedFrontmatter, renderEmail, type EmailContent } from './markdown.js';

interface SyncCounts {
  written: number;
  skipped: number;
  deleted: number;
  errors: number;
}

// What we know about a previously synced file, read from its frontmatter.
// Used both for dedupe (the map keys) and for pruning files whose email has
// since disappeared from the server.
interface ExistingFile {
  name: string;
  date: Date | null;
}

// A search window works at day granularity in the server's timezone, while our
// frontmatter stores the email's header date — the two can disagree around the
// boundary. Only prune files comfortably inside the window so a boundary
// mismatch can't delete a still-live email.
const PRUNE_BOUNDARY_MARGIN_MS = 24 * 60 * 60 * 1000;

// In-place progress line, TTY only: piped output stays clean (matching the
// ansi.ts helpers, which also degrade to plain text off-TTY). Overwrites
// itself with \r and is cleared before any real line is printed.
class ProgressLine {
  private active = false;

  update(text: string): void {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\r\x1b[2K  ${dim(text)}`);
    this.active = true;
  }

  clear(): void {
    if (!this.active) return;
    process.stdout.write('\r\x1b[2K');
    this.active = false;
  }
}

function computeSinceDate(now: Date = new Date()): Date {
  // Month -1 in January normalizes to December of the prior year.
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

// The files on disk are the only dedupe state — no sidecar index, which would
// drift the moment the user deletes or moves a file and then silently skip
// re-syncing it.
function collectExistingFiles(dir: string): Map<string, ExistingFile> {
  const existing = new Map<string, ExistingFile>();
  for (const file of listSyncedFiles(dir)) {
    const { messageId, date } = readSyncedFrontmatter(file.path);
    if (messageId === null) continue; // nothing to dedupe against
    existing.set(messageId, { name: file.name, date });
  }
  return existing;
}

// Deletes files whose email is no longer on the server. Callers must only
// reach here after a complete listing, so serverIds covers all the mail the
// account can see. Even then, only files we can positively rule dead are
// removed: the email's date must sit safely inside the sync window, since
// older mail was never searched and its absence from serverIds means nothing.
// Everything else — including files with unparseable frontmatter — is left
// alone. Mail the user moved to Trash or Spam counts as deleted: those are the
// only mailboxes a full sync skips.
function pruneDeletedEmails(
  dir: string,
  existing: Map<string, ExistingFile>,
  serverIds: Set<string>,
  since: Date,
): number {
  return deleteFiles(dir, [...existing].filter(([id]) => !serverIds.has(id)), since);
}

// The incremental counterpart: an incremental listing cannot prove that an
// unmentioned message is gone, so only the ids the provider explicitly
// reported as deleted are candidates.
function pruneReportedDeletions(
  dir: string,
  existing: Map<string, ExistingFile>,
  removedMessageIds: string[],
  since: Date,
): number {
  const removed = new Set(removedMessageIds);
  return deleteFiles(dir, [...existing].filter(([id]) => removed.has(id)), since);
}

function deleteFiles(dir: string, candidates: [string, ExistingFile][], since: Date): number {
  const cutoff = since.getTime() + PRUNE_BOUNDARY_MARGIN_MS;
  let deleted = 0;
  for (const [, file] of candidates) {
    if (!file.date || file.date.getTime() < cutoff) continue;
    rmSync(join(dir, file.name), { force: true });
    deleted++;
  }
  return deleted;
}

// A truncated file whose frontmatter already contains the message-id would
// make every future run skip a half-written email — so write to a tmp name
// (not *.md, invisible to the scanner) and rename into place.
function writeFileAtomic(path: string, content: string): void {
  const tmp = path + '.tmp';
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function chooseTargetPath(
  dir: string,
  email: EmailContent,
  fetchDate: Date,
  existing: Map<string, ExistingFile>,
  forceRewrite: boolean,
): { path: string; alreadySynced: boolean } {
  const date = email.date ?? fetchDate;
  const subject = email.subject;
  const messageId = email.messageId;

  if (messageId === '') {
    // No message-id to dedupe on, so the filename itself is the identity:
    // deterministic hash of from/date/subject means existsSync === synced.
    const name = buildFilename(date, subject, fallbackHash(email.from, date.toISOString(), subject));
    const path = join(dir, name);
    return { path, alreadySynced: !forceRewrite && existsSync(path) };
  }

  // Force-rewrite overwrites the file this email already lives in, keeping
  // its name stable rather than minting a duplicate under a fresh suffix.
  if (forceRewrite) {
    const prior = existing.get(messageId);
    if (prior) return { path: join(dir, prior.name), alreadySynced: false };
  }

  // Message-id dedupe already ran against the listing, so an existing file
  // here is a different email that happens to share date + subject — pick a
  // free name. The counter goes in the suffix slot, after the slug: appending
  // it to the subject doesn't work because slugify truncates long subjects to
  // 80 chars, slicing the counter off and looping forever on the same name.
  let path = join(dir, buildFilename(date, subject));
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, buildFilename(date, subject, String(n)));
  }
  return { path, alreadySynced: false };
}

// Downloads the messages not already on disk and writes them out. One at a
// time rather than in bulk: the progress line can update before each download,
// and one bad message can't stall the rest.
async function downloadAll(
  source: MailSource,
  refs: MessageRef[],
  dir: string,
  existing: Map<string, ExistingFile>,
  forceRewrite: boolean,
  progress: ProgressLine,
  counts: SyncCounts,
): Promise<void> {
  for (const [i, ref] of refs.entries()) {
    progress.update(`${ref.mailbox}: downloading ${i + 1}/${refs.length}`);
    try {
      const email = await source.fetchContent(ref);
      const { path, alreadySynced } = chooseTargetPath(dir, email, new Date(), existing, forceRewrite);
      if (alreadySynced) {
        counts.skipped++;
        continue;
      }
      writeFileAtomic(path, renderEmail(email, new Date(), ref.mailbox));
      counts.written++;
    } catch (err) {
      counts.errors++;
      progress.clear(); // don't let the error line splice into the progress line
      console.error(red(`  error on ${ref.mailbox} ${ref.handle}: ${errorMessage(err)}`));
    }
  }
}

async function syncAccount(account: Account, since: Date, forceRewrite: boolean): Promise<SyncCounts> {
  const counts: SyncCounts = { written: 0, skipped: 0, deleted: 0, errors: 0 };
  const dir = account.syncPath;
  mkdirSync(dir, { recursive: true });
  const existing = collectExistingFiles(dir);

  const source = await openMailSource(account);
  const progress = new ProgressLine();
  try {
    const onProgress = (mailbox: string, checked: number, total: number): void => {
      progress.update(`${mailbox}: checking ${checked}/${total}`);
    };

    // Ask the backend for just the changes when it can supply them. A
    // force-rewrite deliberately re-downloads everything, so it always takes
    // the full path.
    let changes: ChangeResult | null = null;
    if (!forceRewrite && source.listChanges !== undefined) {
      changes = await source.listChanges(since, onProgress);
    }
    const listing: ListResult = changes !== null
      ? { refs: changes.added, complete: true, problems: [] }
      : await source.listWindow(since, onProgress);

    for (const problem of listing.problems) {
      counts.errors++;
      progress.clear();
      console.error(red(`  ${problem}`));
    }

    // Force-rewrite ignores what is on disk so everything is re-downloaded.
    // The listing has already reported each message once, however many
    // mailboxes it appears in.
    const known = forceRewrite ? new Set<string>() : new Set(existing.keys());
    const pending = listing.refs.filter((ref) => ref.messageId === '' || !known.has(ref.messageId));
    counts.skipped = listing.refs.length - pending.length;

    await downloadAll(source, pending, dir, existing, forceRewrite, progress, counts);

    if (changes !== null) {
      counts.deleted = pruneReportedDeletions(dir, existing, changes.removedMessageIds, since);
    } else if (listing.complete) {
      // Pruning against a full listing needs the whole picture: after a
      // partial one, a missing message-id proves nothing.
      const serverIds = new Set(listing.refs.map((ref) => ref.messageId).filter((id) => id !== ''));
      counts.deleted = pruneDeletedEmails(dir, existing, serverIds, since);
    }

    // Only a clean run may move the resume point: committing after a failure
    // would skip the messages that failed, permanently.
    if (counts.errors === 0 && source.commit !== undefined) await source.commit();
    return counts;
  } finally {
    progress.clear();
    await source.close();
  }
}

// Syncs every account, isolating failures: one broken account logs loudly and
// the rest still run. Returns true only when everything was fully clean.
export async function runSync(config: Config, since: Date = computeSinceDate(), forceRewrite = false): Promise<boolean> {
  if (config.accounts.length === 0) {
    console.error('No accounts configured. Run `inbox-to-md auth add` to add one.');
    return false;
  }

  console.log(dim(`Syncing all mail since ${since.toDateString()}${forceRewrite ? ' (force-rewrite: overwriting already-synced files)' : ''}`));

  let allOk = true;
  const totals: SyncCounts = { written: 0, skipped: 0, deleted: 0, errors: 0 };
  for (const account of config.accounts) {
    try {
      const counts = await syncAccount(account, since, forceRewrite);
      totals.written += counts.written;
      totals.skipped += counts.skipped;
      totals.deleted += counts.deleted;
      totals.errors += counts.errors;
      const errorPart = counts.errors > 0 ? red(`${counts.errors} errors`) : green('0 errors');
      console.log(`${bold(account.label)}: ${counts.written} new · ${counts.skipped} skipped · ${counts.deleted} deleted · ${errorPart} → ${account.syncPath}`);
      if (counts.errors > 0) allOk = false;
    } catch (err) {
      allOk = false;
      console.error(`${bold(account.label)}: ${red(`FAILED — ${errorMessage(err)}`)}`);
    }
  }
  console.log(dim(`Total: ${totals.written} new · ${totals.skipped} skipped · ${totals.deleted} deleted · ${totals.errors} errors`));
  return allOk;
}
