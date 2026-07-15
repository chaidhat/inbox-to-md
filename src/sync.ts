// `npm start` — sync engine. For each configured account, fetches mail from
// INBOX and the Sent mailbox (received this month or last month by default)
// and writes one markdown file per email into the account's sync path.
// Idempotent: emails already on disk (matched by message-id in the files'
// frontmatter) are skipped without re-downloading their bodies.

import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { bold, dim, green, red } from './ansi.js';
import type { Config, ImapAccount } from './config.js';
import { closeImapClient, createImapClient, describeImapError } from './imap.js';
import { buildFilename, extractMessageId, fallbackHash, renderEmail } from './markdown.js';

// How much of each existing file to scan for its frontmatter message-id.
// Frontmatter is a handful of single-line quoted scalars, but from/to lists
// with many recipients can get long — 8 KB leaves a wide margin.
const FRONTMATTER_SCAN_BYTES = 8192;

interface SyncCounts {
  written: number;
  skipped: number;
  errors: number;
}

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

export function computeSinceDate(now: Date = new Date()): Date {
  // Month -1 in January normalizes to December of the prior year.
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

// The files on disk are the only dedupe state — no sidecar index, which would
// drift the moment the user deletes or moves a file and then silently skip
// re-syncing it.
export function collectExistingMessageIds(dir: string): Set<string> {
  const seen = new Set<string>();
  const buffer = Buffer.alloc(FRONTMATTER_SCAN_BYTES);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    let fd: number;
    try {
      fd = openSync(join(dir, name), 'r');
    } catch {
      continue; // vanished between readdir and open; nothing to dedupe against
    }
    try {
      const bytes = readSync(fd, buffer, 0, FRONTMATTER_SCAN_BYTES, 0);
      const id = extractMessageId(buffer.toString('utf8', 0, bytes));
      if (id) seen.add(id);
    } finally {
      closeSync(fd);
    }
  }
  return seen;
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

function chooseTargetPath(dir: string, parsed: ParsedMail, fetchDate: Date): { path: string; alreadySynced: boolean } {
  const date = parsed.date ?? fetchDate;
  const subject = parsed.subject ?? '';
  const messageId = (parsed.messageId ?? '').trim();

  if (messageId === '') {
    // No message-id to dedupe on, so the filename itself is the identity:
    // deterministic hash of from/date/subject means existsSync === synced.
    const from = parsed.from?.text ?? '';
    const name = buildFilename(date, subject, fallbackHash(from, date.toISOString(), subject));
    const path = join(dir, name);
    return { path, alreadySynced: existsSync(path) };
  }

  // Message-id dedupe already ran (phase A), so an existing file here is a
  // different email that happens to share date + subject — pick a free name.
  // The counter goes in the suffix slot, after the slug: appending it to the
  // subject doesn't work because slugify truncates long subjects to 80 chars,
  // slicing the counter off and looping forever on the same name.
  let path = join(dir, buildFilename(date, subject));
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, buildFilename(date, subject, String(n)));
  }
  return { path, alreadySynced: false };
}

// Locates the account's Sent mailbox: the RFC 6154 special-use flag when the
// server provides it, else the usual names (Sent, Sent Mail, Sent Items, …).
// Returns null when nothing matches — some servers simply have no Sent box.
async function findSentMailbox(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const bySpecialUse = boxes.find((b) => b.specialUse === '\\Sent');
  if (bySpecialUse) return bySpecialUse.path;
  const byName = boxes.find((b) => /^sent( messages| items| mail)?$/i.test(b.name));
  return byName ? byName.path : null;
}

async function syncMailbox(
  client: ImapFlow,
  mailbox: string,
  since: Date,
  dir: string,
  seen: Set<string>,
  counts: SyncCounts,
): Promise<void> {
  const lock = await client.getMailboxLock(mailbox);
  const progress = new ProgressLine();
  try {
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) return;

    // Phase A: envelopes only. Filter out already-synced message-ids before
    // downloading anything heavy — on re-runs (the common case) this means
    // an unchanged mailbox costs envelopes, never full bodies.
    const newUids: number[] = [];
    let checked = 0;
    for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
      progress.update(`${mailbox}: checking ${++checked}/${uids.length}`);
      const messageId = (msg.envelope?.messageId ?? '').trim();
      if (messageId !== '' && seen.has(messageId)) {
        counts.skipped++;
        continue;
      }
      if (messageId !== '') seen.add(messageId); // dedupes duplicates within this run too
      newUids.push(msg.uid);
    }
    if (newUids.length === 0) return; // imapflow rejects an empty fetch range

    // Phase B: full source for new mail only. One fetch per message rather
    // than a single bulk FETCH: the progress line can update before each
    // download (a bulk fetch only yields when a body has fully arrived, so
    // a large email looks like a hang), and one bad message can't stall the
    // entire pipeline.
    for (const [i, uid] of newUids.entries()) {
      progress.update(`${mailbox}: downloading ${i + 1}/${newUids.length}`);
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error('server returned no message source');
        const parsed = await simpleParser(msg.source);
        const { path, alreadySynced } = chooseTargetPath(dir, parsed, new Date());
        if (alreadySynced) {
          counts.skipped++;
          continue;
        }
        writeFileAtomic(path, renderEmail(parsed, new Date(), mailbox));
        counts.written++;
      } catch (err) {
        counts.errors++;
        const detail = err instanceof Error ? err.message : String(err);
        progress.clear(); // don't let the error line splice into the progress line
        console.error(red(`  error on ${mailbox} uid ${uid}: ${detail}`));
      }
    }
  } finally {
    progress.clear();
    lock.release();
  }
}

async function syncAccount(account: ImapAccount, since: Date): Promise<SyncCounts> {
  const counts: SyncCounts = { written: 0, skipped: 0, errors: 0 };
  const dir = account.syncPath;
  mkdirSync(dir, { recursive: true });
  // Shared across mailboxes, so a message that lives in both INBOX and Sent
  // (e.g. mail to yourself) is written once. INBOX is synced first, so the
  // received copy wins.
  const seen = collectExistingMessageIds(dir);

  const client = createImapClient(account);
  await client.connect();
  try {
    const mailboxes = ['INBOX'];
    const sent = await findSentMailbox(client);
    if (sent) mailboxes.push(sent);
    else console.error(`${account.label}: no Sent mailbox found — syncing INBOX only`);
    for (const mailbox of mailboxes) {
      await syncMailbox(client, mailbox, since, dir, seen, counts);
    }
    return counts;
  } finally {
    await closeImapClient(client);
  }
}

// Syncs every account, isolating failures: one broken account logs loudly and
// the rest still run. Returns true only when everything was fully clean.
export async function runSync(config: Config, since: Date = computeSinceDate()): Promise<boolean> {
  if (config.accounts.length === 0) {
    console.error('No accounts configured. Run `npm run auth` to add one.');
    return false;
  }

  console.log(dim(`Syncing INBOX + Sent mail since ${since.toDateString()}`));

  let allOk = true;
  const totals: SyncCounts = { written: 0, skipped: 0, errors: 0 };
  for (const account of config.accounts) {
    try {
      const counts = await syncAccount(account, since);
      totals.written += counts.written;
      totals.skipped += counts.skipped;
      totals.errors += counts.errors;
      const errorPart = counts.errors > 0 ? red(`${counts.errors} errors`) : green('0 errors');
      console.log(`${bold(account.label)}: ${counts.written} new · ${counts.skipped} skipped · ${errorPart} → ${account.syncPath}`);
      if (counts.errors > 0) allOk = false;
    } catch (err) {
      allOk = false;
      console.error(`${bold(account.label)}: ${red(`FAILED — ${describeImapError(err, account.host, account.port)}`)}`);
    }
  }
  console.log(dim(`Total: ${totals.written} new · ${totals.skipped} skipped · ${totals.errors} errors`));
  return allOk;
}
