// `npm start` — sync engine. For each configured account, fetches INBOX mail
// received this month or last month and writes one markdown file per email
// into the account's sync path. Idempotent: emails already on disk (matched
// by message-id in the files' frontmatter) are skipped without re-downloading
// their bodies.

import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
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
  let path = join(dir, buildFilename(date, subject));
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, buildFilename(date, `${subject} ${n}`));
  }
  return { path, alreadySynced: false };
}

async function syncAccount(account: ImapAccount, since: Date): Promise<SyncCounts> {
  const counts: SyncCounts = { written: 0, skipped: 0, errors: 0 };
  const dir = account.syncPath;
  mkdirSync(dir, { recursive: true });
  const seen = collectExistingMessageIds(dir);

  const client = createImapClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return counts;

      // Phase A: envelopes only. Filter out already-synced message-ids before
      // downloading anything heavy — on re-runs (the common case) this means
      // an unchanged inbox costs envelopes, never full bodies.
      const newUids: number[] = [];
      for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
        const messageId = (msg.envelope?.messageId ?? '').trim();
        if (messageId !== '' && seen.has(messageId)) {
          counts.skipped++;
          continue;
        }
        if (messageId !== '') seen.add(messageId); // dedupes duplicates within this run too
        newUids.push(msg.uid);
      }
      if (newUids.length === 0) return counts; // imapflow rejects an empty fetch range

      // Phase B: full source for new mail only.
      for await (const msg of client.fetch(newUids, { source: true }, { uid: true })) {
        try {
          if (!msg.source) throw new Error('server returned no message source');
          const parsed = await simpleParser(msg.source);
          const { path, alreadySynced } = chooseTargetPath(dir, parsed, new Date());
          if (alreadySynced) {
            counts.skipped++;
            continue;
          }
          writeFileAtomic(path, renderEmail(parsed, new Date()));
          counts.written++;
        } catch (err) {
          counts.errors++;
          const detail = err instanceof Error ? err.message : String(err);
          console.error(red(`  error on uid ${msg.uid}: ${detail}`));
        }
      }
      return counts;
    } finally {
      lock.release();
    }
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

  console.log(dim(`Syncing INBOX mail since ${since.toDateString()}`));

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
