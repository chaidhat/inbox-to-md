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

import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { openMailSource } from '../integration/open.js';
import { bold, dim, green, red } from './ansi.js';
import type { Account, Config } from './config.js';
import { errorMessage } from './errors.js';
import type { ChangeResult, ListResult, MailSource, MessageRef } from './mail-source.js';
import { mapPool } from './pool.js';
import { ProgressGroup, type ProgressBar } from './progress.js';
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

// Accounts sync together, but not unboundedly: each one holds a connection and
// fans out its own downloads, so the real ceiling is what the machine and the
// providers tolerate rather than how many accounts happen to be configured.
const ACCOUNT_CONCURRENCY = 4;

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

// Takes the first free name in the date+subject series by *creating* it rather
// than testing for it. Within one run the search and the write are not
// separated by an await, so concurrent downloads cannot interleave between
// them — but two runs over the same sync path (a cron job overlapping a manual
// one) are a different matter, and there the loser of an existsSync race
// silently overwrites the winner's email. An exclusive create can only succeed
// for one of them. The claim is an empty file, replaced by the real content
// moments later.
function claimFreePath(dir: string, date: Date, subject: string): string {
  for (let n = 1; ; n++) {
    const path = join(dir, buildFilename(date, subject, n === 1 ? undefined : String(n)));
    try {
      closeSync(openSync(path, 'wx'));
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

function chooseTargetPath(
  dir: string,
  email: EmailContent,
  fetchDate: Date,
  existing: Map<string, ExistingFile>,
  forceRewrite: boolean,
): { path: string; alreadySynced: boolean; claimed: boolean } {
  const date = email.date ?? fetchDate;
  const subject = email.subject;
  const messageId = email.messageId;

  if (messageId === '') {
    // No message-id to dedupe on, so the filename itself is the identity:
    // deterministic hash of from/date/subject means existsSync === synced.
    const name = buildFilename(date, subject, fallbackHash(email.from, date.toISOString(), subject));
    const path = join(dir, name);
    return { path, alreadySynced: !forceRewrite && existsSync(path), claimed: false };
  }

  // Force-rewrite overwrites the file this email already lives in, keeping
  // its name stable rather than minting a duplicate under a fresh suffix.
  if (forceRewrite) {
    const prior = existing.get(messageId);
    if (prior) return { path: join(dir, prior.name), alreadySynced: false, claimed: false };
  }

  // Message-id dedupe already ran against the listing, so an existing file
  // here is a different email that happens to share date + subject — take the
  // next free name. The counter goes in the suffix slot, after the slug:
  // appending it to the subject doesn't work because slugify truncates long
  // subjects to 80 chars, slicing the counter off and looping forever on the
  // same name.
  return { path: claimFreePath(dir, date, subject), alreadySynced: false, claimed: true };
}

// Downloads the messages not already on disk and writes them out, as many at
// once as the backend says it can serve (one, for a backend on a single
// stateful connection). Per message rather than in bulk so one bad message
// can't stall the rest — every failure is counted and reported, never thrown,
// which also keeps it from aborting the other downloads in flight.
async function downloadAll(
  source: MailSource,
  refs: MessageRef[],
  dir: string,
  existing: Map<string, ExistingFile>,
  forceRewrite: boolean,
  progress: ProgressGroup,
  label: string,
  counts: SyncCounts,
): Promise<void> {
  const bar = progress.bar(`${label} download`, refs.length);
  let done = 0;

  await mapPool(refs, source.maxConcurrentFetches ?? 1, async (ref) => {
    try {
      const email = await source.fetchContent(ref);
      const { path, alreadySynced, claimed } = chooseTargetPath(dir, email, new Date(), existing, forceRewrite);
      if (alreadySynced) {
        counts.skipped++;
        return;
      }
      try {
        writeFileAtomic(path, renderEmail(email, new Date(), ref.mailbox));
      } catch (err) {
        // The name was claimed with an empty file; leaving that behind would
        // look like a synced email with no content on the next run.
        if (claimed) rmSync(path, { force: true });
        throw err;
      }
      counts.written++;
    } catch (err) {
      counts.errors++;
      progress.log(red(`  error on ${ref.mailbox} ${ref.handle}: ${errorMessage(err)}`));
    } finally {
      // Counted on completion, not by position: with several in flight the
      // index says nothing about how much is actually finished.
      bar.update(++done, ref.mailbox);
    }
  });
}

async function syncAccount(
  account: Account,
  since: Date,
  forceRewrite: boolean,
  progress: ProgressGroup,
): Promise<SyncCounts> {
  const counts: SyncCounts = { written: 0, skipped: 0, deleted: 0, errors: 0 };
  const dir = account.syncPath;
  mkdirSync(dir, { recursive: true });
  const existing = collectExistingFiles(dir);

  const source = await openMailSource(account);
  try {
    // Backends report the listing per mailbox, restarting the count for each
    // one, so a new mailbox starts a new bar instead of rewinding the current
    // one. Gmail reports a single synthetic mailbox, giving one bar.
    let scanned: string | null = null;
    let scanBar: ProgressBar | null = null;
    const onProgress = (mailbox: string, checked: number, total: number): void => {
      if (mailbox !== scanned) {
        scanned = mailbox;
        scanBar = progress.bar(`${account.label} scan`, total);
      }
      scanBar?.update(checked, mailbox);
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
      progress.log(red(`  ${problem}`));
    }

    // Force-rewrite ignores what is on disk so everything is re-downloaded.
    // The listing has already reported each message once, however many
    // mailboxes it appears in.
    const known = forceRewrite ? new Set<string>() : new Set(existing.keys());
    const pending = listing.refs.filter((ref) => ref.messageId === '' || !known.has(ref.messageId));
    counts.skipped = listing.refs.length - pending.length;

    await downloadAll(source, pending, dir, existing, forceRewrite, progress, account.label, counts);

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

  // Accounts share nothing — separate servers, separate connections, separate
  // sync paths — so they run together, each with its own bars in one group.
  // The one thing they do share is the config file, when an OAuth account
  // caches a refreshed access token; core/config.ts takes a lock for that.
  const progress = new ProgressGroup();
  const results = await mapPool(config.accounts, ACCOUNT_CONCURRENCY, async (account) => {
    try {
      return { account, counts: await syncAccount(account, since, forceRewrite, progress) };
    } catch (err) {
      // Caught rather than thrown: one unreachable server must not cancel the
      // accounts that are working.
      return { account, failure: errorMessage(err) };
    }
  });
  // Every bar is finished before a single summary line is written, so the
  // results land on a terminal nothing is still drawing on — and in config
  // order, however the runs interleaved.
  progress.stop();

  let allOk = true;
  const totals: SyncCounts = { written: 0, skipped: 0, deleted: 0, errors: 0 };
  for (const result of results) {
    if ('failure' in result) {
      allOk = false;
      console.error(`${bold(result.account.label)}: ${red(`FAILED — ${result.failure}`)}`);
      continue;
    }
    const { account, counts } = result;
    totals.written += counts.written;
    totals.skipped += counts.skipped;
    totals.deleted += counts.deleted;
    totals.errors += counts.errors;
    const errorPart = counts.errors > 0 ? red(`${counts.errors} errors`) : green('0 errors');
    console.log(`${bold(account.label)}: ${counts.written} new · ${counts.skipped} skipped · ${counts.deleted} deleted · ${errorPart} → ${account.syncPath}`);
    if (counts.errors > 0) allOk = false;
  }
  console.log(dim(`Total: ${totals.written} new · ${totals.skipped} skipped · ${totals.deleted} deleted · ${totals.errors} errors`));
  return allOk;
}
