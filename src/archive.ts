// `npm run archive <md dir>` — for every INBOX email markdown file in the
// given directory, finds the email on the server (by the message-id in the
// file's frontmatter, searched in the mailbox it was synced from), moves it to the
// account's Archive mailbox, and deletes the file. The file is only deleted
// after the server confirms the move — a failed or not-found archive keeps
// the file so nothing is lost silently.

import { readdirSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type { ImapFlow } from 'imapflow';
import { bold, dim, green, red } from './ansi.js';
import type { Config, ImapAccount } from './config.js';
import { loadConfig } from './config.js';
import { closeImapClient, createImapClient, describeImapError } from './imap.js';
import { extractFrontmatterValue, extractMessageId, readFrontmatterHead } from './markdown.js';

const USAGE = 'Usage: inbox-to-md archive <md dir>';

interface ArchiveTarget {
  path: string;
  name: string;
  messageId: string;
  mailbox: string;   // mailbox the email was synced from — where to search for it
  archived: boolean; // set once an account confirms the move and the file is deleted
}

interface ArchiveCounts {
  archived: number;
  skipped: number;
  errors: number;
}

// Files without a message-id (fallback-hash filenames) or without a mailbox
// can't be located on any server, so they are reported and left alone rather
// than guessed at. Only INBOX mail is archivable: archiving anything else
// (e.g. Sent) just strips its label server-side for no benefit, so non-INBOX
// files are rejected.
function collectTargets(dir: string, counts: ArchiveCounts): ArchiveTarget[] {
  const targets: ArchiveTarget[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const head = readFrontmatterHead(path);
    const messageId = head === null ? null : extractMessageId(head);
    const mailbox = head === null ? null : extractFrontmatterValue(head, 'mailbox');
    if (!messageId || !mailbox) {
      counts.skipped++;
      console.error(dim(`skipping ${name}: no message-id/mailbox in frontmatter`));
      continue;
    }
    if (mailbox !== 'INBOX') {
      counts.skipped++;
      console.error(red(`skipping ${name}: mailbox is "${mailbox}" — only INBOX mail can be archived`));
      continue;
    }
    targets.push({ path, name, messageId, mailbox, archived: false });
  }
  return targets;
}

// Locates the account's Archive mailbox: the RFC 6154 special-use flag when
// the server provides it, Gmail's All Mail (\All — moving there is how Gmail
// archives), or the usual names. Returns null when nothing matches; we never
// create a mailbox on the user's server on our own.
async function findArchiveMailbox(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const bySpecialUse = boxes.find((b) => b.specialUse === '\\Archive' || b.specialUse === '\\All');
  if (bySpecialUse) return bySpecialUse.path;
  const byName = boxes.find((b) => /^archives?$/i.test(b.name));
  return byName ? byName.path : null;
}

// Tries to archive each pending target on this account. A message-id that
// isn't found here is left for the other accounts (or reported as not found
// at the end) — searching the wrong account just returns nothing.
async function archiveOnAccount(account: ImapAccount, targets: ArchiveTarget[], counts: ArchiveCounts): Promise<void> {
  const pending = targets.filter((t) => !t.archived);
  if (pending.length === 0) return;

  // One mailbox open per distinct source mailbox, not per file.
  const byMailbox = new Map<string, ArchiveTarget[]>();
  for (const t of pending) {
    const group = byMailbox.get(t.mailbox);
    if (group) group.push(t);
    else byMailbox.set(t.mailbox, [t]);
  }

  const client = createImapClient(account);
  await client.connect();
  try {
    const archiveBox = await findArchiveMailbox(client);
    if (archiveBox === null) {
      console.error(`${bold(account.label)}: ${red('no Archive mailbox found — skipping this account')}`);
      return;
    }

    for (const [mailbox, files] of byMailbox) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch {
        continue; // this account has no such mailbox; another account may
      }
      try {
        for (const target of files) {
          try {
            const uids = await client.search({ header: { 'message-id': target.messageId } }, { uid: true });
            if (!uids || uids.length === 0) continue;
            // A source already inside the Archive mailbox needs no move —
            // the email is archived; just clean up the file.
            if (mailbox !== archiveBox) {
              await client.messageMove(uids, archiveBox, { uid: true });
            }
            rmSync(target.path);
            target.archived = true;
            counts.archived++;
            console.log(`${green('archived')} ${target.name} ${dim(`(${account.label}: ${mailbox} → ${archiveBox})`)}`);
          } catch (err) {
            counts.errors++;
            const detail = err instanceof Error ? err.message : String(err);
            console.error(red(`error archiving ${target.name} on ${account.label}: ${detail}`));
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await closeImapClient(client);
  }
}

// Archives across every account, isolating failures like the sync engine: one
// broken account logs loudly and the rest still run. Returns true only when
// every file was archived cleanly.
export async function runArchive(config: Config, dir: string): Promise<boolean> {
  if (config.accounts.length === 0) {
    console.error('No accounts configured. Run `npm run auth` to add one.');
    return false;
  }

  const counts: ArchiveCounts = { archived: 0, skipped: 0, errors: 0 };
  const targets = collectTargets(dir, counts);
  if (targets.length === 0 && counts.skipped === 0) {
    console.log('No email markdown files found — nothing to archive.');
    return true;
  }

  let allOk = counts.skipped === 0;
  for (const account of config.accounts) {
    try {
      await archiveOnAccount(account, targets, counts);
    } catch (err) {
      allOk = false;
      console.error(`${bold(account.label)}: ${red(`FAILED — ${describeImapError(err, account.host, account.port)}`)}`);
    }
  }

  const notFound = targets.filter((t) => !t.archived);
  for (const target of notFound) {
    console.error(red(`not found on any account: ${target.name} (${target.messageId})`));
  }

  console.log(dim(`Total: ${counts.archived} archived · ${counts.skipped} skipped · ${notFound.length} not found · ${counts.errors} errors`));
  return allOk && counts.errors === 0 && notFound.length === 0;
}

function parseDirArg(argv: string[]): string {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    throw new Error(USAGE);
  }
  const dir = resolve(argv[0]);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`No such directory: ${dir}\n${USAGE}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dir}\n${USAGE}`);
  return dir;
}

async function main(): Promise<void> {
  const dir = parseDirArg(process.argv.slice(2));
  const config = loadConfig();
  const ok = await runArchive(config, dir);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
