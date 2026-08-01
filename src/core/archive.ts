// Archive engine — for every INBOX email markdown file in a directory, finds
// the email on the account (by the message-id in the file's frontmatter),
// archives it, and deletes the file. The file is only deleted after the
// provider confirms, so a failed or not-found archive keeps the file and
// nothing is lost silently.
//
// Like the sync engine, this knows no protocol: a MailSource does the work.

import { rmSync } from 'fs';
import { openMailSource } from '../integration/open.js';
import { bold, dim, green, red } from './ansi.js';
import type { Account, Config } from './config.js';
import { errorMessage } from './errors.js';
import { listSyncedFiles, readSyncedFrontmatter } from './markdown.js';

interface ArchiveTarget {
  path: string;
  name: string;
  messageId: string;
  mailbox: string;   // mailbox the email was synced from — where to look for it
  archived: boolean; // set once an account confirms and the file is deleted
}

interface ArchiveCounts {
  archived: number;
  skipped: number;
  errors: number;
}

// Files without a message-id (fallback-hash filenames) or without a mailbox
// can't be located on any account, so they are reported and left alone rather
// than guessed at. Only INBOX mail is archivable: archiving anything else
// (e.g. Sent) just strips its label server-side for no benefit, so non-INBOX
// files are rejected.
function collectTargets(dir: string, counts: ArchiveCounts): ArchiveTarget[] {
  const targets: ArchiveTarget[] = [];
  for (const file of listSyncedFiles(dir)) {
    const { messageId, mailbox } = readSyncedFrontmatter(file.path);
    if (messageId === null || mailbox === null) {
      counts.skipped++;
      console.error(dim(`skipping ${file.name}: no message-id/mailbox in frontmatter`));
      continue;
    }
    if (mailbox !== 'INBOX') {
      counts.skipped++;
      console.error(red(`skipping ${file.name}: mailbox is "${mailbox}" — only INBOX mail can be archived`));
      continue;
    }
    targets.push({ path: file.path, name: file.name, messageId, mailbox, archived: false });
  }
  return targets;
}

// Tries to archive each pending target on this account. A message-id that
// isn't found here is left for the other accounts (or reported as not found
// at the end) — looking in the wrong account just returns nothing.
async function archiveOnAccount(account: Account, targets: ArchiveTarget[], counts: ArchiveCounts): Promise<void> {
  const pending = targets.filter((t) => !t.archived);
  if (pending.length === 0) return;

  const source = await openMailSource(account);
  try {
    const outcomes = await source.archive(
      pending.map((target) => ({ messageId: target.messageId, mailbox: target.mailbox })),
    );
    outcomes.forEach((outcome, index) => {
      const target = pending[index];
      if (outcome.status === 'archived') {
        rmSync(target.path);
        target.archived = true;
        counts.archived++;
        console.log(`${green('archived')} ${target.name} ${dim(`(${account.label}: ${outcome.destination})`)}`);
      } else if (outcome.status === 'error') {
        counts.errors++;
        console.error(red(`error archiving ${target.name} on ${account.label}: ${outcome.detail}`));
      }
      // 'not-found' stays pending for the next account.
    });
  } finally {
    await source.close();
  }
}

// Archives across every account, isolating failures like the sync engine: one
// broken account logs loudly and the rest still run. Returns true only when
// every file was archived cleanly.
export async function runArchive(config: Config, dir: string): Promise<boolean> {
  if (config.accounts.length === 0) {
    console.error('No accounts configured. Run `inbox-to-md auth add` to add one.');
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
      console.error(`${bold(account.label)}: ${red(`FAILED — ${errorMessage(err)}`)}`);
    }
  }

  const notFound = targets.filter((t) => !t.archived);
  for (const target of notFound) {
    console.error(red(`not found on any account: ${target.name} (${target.messageId})`));
  }

  console.log(dim(`Total: ${counts.archived} archived · ${counts.skipped} skipped · ${notFound.length} not found · ${counts.errors} errors`));
  return allOk && counts.errors === 0 && notFound.length === 0;
}
