// `npm start` — sync engine. For each configured account, fetches mail from
// INBOX and the Sent mailbox (received this month or last month by default)
// and writes one markdown file per email into the account's sync path.
// Idempotent: emails already on disk (matched by message-id in the files'
// frontmatter) are skipped without re-downloading their bodies — unless
// --force-rewrite, which re-downloads them and overwrites the files in place
// (e.g. to pick up frontmatter added by a newer version of renderEmail). Mirrors
// deletions too: a file whose email has vanished from the server (and whose
// date is safely inside the sync window) is deleted after a clean sync.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ImapFlow, MessageEnvelopeObject } from 'imapflow';
import { bold, dim, green, red } from './ansi.js';
import type { Config, ImapAccount } from './config.js';
import { closeImapClient, createImapClient, describeImapError } from './imap.js';
import { buildFilename, extractFrontmatterValue, extractMessageId, fallbackHash, readFrontmatterHead, renderEmail, type EmailContent } from './markdown.js';
import { collectAttachments, decodeTextPart, findTextPart } from './mime.js';

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
  mailbox: string | null;
}

// SEARCH SINCE works on the server's internal date at day granularity in the
// server's timezone, while our frontmatter stores the email's header date —
// the two can disagree around the boundary. Only prune files comfortably
// inside the window so a boundary mismatch can't delete a still-live email.
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

export function computeSinceDate(now: Date = new Date()): Date {
  // Month -1 in January normalizes to December of the prior year.
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

// The files on disk are the only dedupe state — no sidecar index, which would
// drift the moment the user deletes or moves a file and then silently skip
// re-syncing it.
export function collectExistingFiles(dir: string): Map<string, ExistingFile> {
  const existing = new Map<string, ExistingFile>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const head = readFrontmatterHead(join(dir, name));
    if (head === null) continue; // vanished between readdir and open; nothing to dedupe against
    const id = extractMessageId(head);
    if (!id) continue;
    const dateRaw = extractFrontmatterValue(head, 'date');
    const date = dateRaw === null ? null : new Date(dateRaw);
    existing.set(id, {
      name,
      date: date !== null && !Number.isNaN(date.getTime()) ? date : null,
      mailbox: extractFrontmatterValue(head, 'mailbox'),
    });
  }
  return existing;
}

// Deletes files whose email is no longer on the server. Only files we can
// positively rule dead are removed: the email's date must sit safely inside
// the sync window (older mail was never searched, so its absence from
// serverIds means nothing) and its mailbox must be one we actually synced
// this run. Everything else — including files with unparseable frontmatter —
// is left alone.
function pruneDeletedEmails(
  dir: string,
  existing: Map<string, ExistingFile>,
  serverIds: Set<string>,
  syncedMailboxes: string[],
  since: Date,
): number {
  const cutoff = since.getTime() + PRUNE_BOUNDARY_MARGIN_MS;
  let deleted = 0;
  for (const [id, file] of existing) {
    if (serverIds.has(id)) continue;
    if (!file.date || file.date.getTime() < cutoff) continue;
    if (!file.mailbox || !syncedMailboxes.includes(file.mailbox)) continue;
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

function formatAddressList(list: MessageEnvelopeObject['from']): string {
  return (list ?? [])
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');
}

// Downloads and assembles one email using body structure instead of full
// source: the envelope covers the headers, the structure describes the
// attachments, and only the single text part is actually fetched — so
// attachment bytes never leave the server.
async function downloadEmail(client: ImapFlow, uid: number): Promise<EmailContent> {
  const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
  if (!msg || !msg.envelope || !msg.bodyStructure) throw new Error('server returned no envelope/body structure');

  let text = '';
  let html = '';
  const textRef = findTextPart(msg.bodyStructure);
  if (textRef) {
    const partMsg = await client.fetchOne(uid, { bodyParts: [textRef.part] }, { uid: true });
    const raw = partMsg ? partMsg.bodyParts?.get(textRef.part) : undefined;
    if (!raw) throw new Error(`server returned no body part ${textRef.part}`);
    const decoded = decodeTextPart(raw, textRef.encoding, textRef.charset);
    if (textRef.isHtml) html = decoded;
    else text = decoded;
  }

  return {
    from: formatAddressList(msg.envelope.from),
    to: formatAddressList(msg.envelope.to),
    subject: msg.envelope.subject ?? '',
    date: msg.envelope.date ?? null,
    messageId: (msg.envelope.messageId ?? '').trim(),
    text,
    html,
    attachments: collectAttachments(msg.bodyStructure),
  };
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
  serverIds: Set<string>,
  existing: Map<string, ExistingFile>,
  forceRewrite: boolean,
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
      if (messageId !== '') serverIds.add(messageId); // still alive on the server — protect from pruning
      if (messageId !== '' && seen.has(messageId)) {
        counts.skipped++;
        continue;
      }
      if (messageId !== '') seen.add(messageId); // dedupes duplicates within this run too
      newUids.push(msg.uid);
    }
    if (newUids.length === 0) return; // imapflow rejects an empty fetch range

    // Phase B: body text for new mail only (attachments stay on the server —
    // see downloadEmail). One message at a time rather than a single bulk
    // FETCH: the progress line can update before each download, and one bad
    // message can't stall the entire pipeline.
    for (const [i, uid] of newUids.entries()) {
      progress.update(`${mailbox}: downloading ${i + 1}/${newUids.length}`);
      try {
        const email = await downloadEmail(client, uid);
        const { path, alreadySynced } = chooseTargetPath(dir, email, new Date(), existing, forceRewrite);
        if (alreadySynced) {
          counts.skipped++;
          continue;
        }
        writeFileAtomic(path, renderEmail(email, new Date(), mailbox));
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

async function syncAccount(account: ImapAccount, since: Date, forceRewrite: boolean): Promise<SyncCounts> {
  const counts: SyncCounts = { written: 0, skipped: 0, deleted: 0, errors: 0 };
  const dir = account.syncPath;
  mkdirSync(dir, { recursive: true });
  const existing = collectExistingFiles(dir);
  // Shared across mailboxes, so a message that lives in both INBOX and Sent
  // (e.g. mail to yourself) is written once. INBOX is synced first, so the
  // received copy wins. Force-rewrite starts empty so files on disk don't
  // suppress re-downloading, but still dedupes across mailboxes within the run.
  const seen = forceRewrite ? new Set<string>() : new Set(existing.keys());
  // Every message-id observed on the server this run, whether or not it was
  // already synced — the ground truth pruning compares against.
  const serverIds = new Set<string>();

  const client = createImapClient(account);
  await client.connect();
  try {
    const mailboxes = ['INBOX'];
    const sent = await findSentMailbox(client);
    if (sent) mailboxes.push(sent);
    else console.error(`${account.label}: no Sent mailbox found — syncing INBOX only`);
    for (const mailbox of mailboxes) {
      await syncMailbox(client, mailbox, since, dir, seen, serverIds, existing, forceRewrite, counts);
    }
    // Runs only after every mailbox listed its messages without throwing —
    // an aborted sync leaves serverIds incomplete and must not delete anything
    // (a mid-run failure propagates out of the loop above and skips this).
    counts.deleted = pruneDeletedEmails(dir, existing, serverIds, mailboxes, since);
    return counts;
  } finally {
    await closeImapClient(client);
  }
}

// Syncs every account, isolating failures: one broken account logs loudly and
// the rest still run. Returns true only when everything was fully clean.
export async function runSync(config: Config, since: Date = computeSinceDate(), forceRewrite = false): Promise<boolean> {
  if (config.accounts.length === 0) {
    console.error('No accounts configured. Run `npm run auth` to add one.');
    return false;
  }

  console.log(dim(`Syncing INBOX + Sent mail since ${since.toDateString()}${forceRewrite ? ' (force-rewrite: overwriting already-synced files)' : ''}`));

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
      console.error(`${bold(account.label)}: ${red(`FAILED — ${describeImapError(err, account.host, account.port)}`)}`);
    }
  }
  console.log(dim(`Total: ${totals.written} new · ${totals.skipped} skipped · ${totals.deleted} deleted · ${totals.errors} errors`));
  return allOk;
}
