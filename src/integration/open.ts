// The one place that knows which backends exist. Everything else either
// implements MailSource or consumes one, so adding a transport means adding a
// folder under integration/ and a branch here.

import type { Account, AccountDraft } from '../core/config.js';
import type { MailSource, Transport } from '../core/mail-source.js';
import { GmailMailSource } from './gmail/source.js';
import { ImapMailSource } from './imap/source.js';

// Stored accounts and not-yet-stored drafts both open the same way, so
// `auth add` verifies a draft over the transport the account will really use.
export type MailTarget = Account | AccountDraft;

// Hosts whose mail is Gmail, and so reachable over the Gmail API with the
// grant an OAuth account already holds.
const GMAIL_HOSTS = new Set(['imap.gmail.com', 'imap.googlemail.com']);

// Which transport an account reaches its mail over. An explicit `transport`
// wins; otherwise it is derived, so existing accounts need neither a config
// migration nor re-consent — the stored https://mail.google.com/ scope is a
// superset that already grants Gmail API access.
export function resolveTransport(account: MailTarget): Transport {
  if (account.transport !== undefined) return account.transport;
  if (account.auth === 'oauth' && GMAIL_HOSTS.has(account.host.toLowerCase())) return 'gmail';
  return 'imap';
}

export async function openMailSource(account: MailTarget): Promise<MailSource> {
  if (resolveTransport(account) !== 'gmail') return ImapMailSource.open(account);
  if (account.auth !== 'oauth') {
    // Only reachable by hand-editing the config or forcing the flag: the
    // Gmail API has no password authentication to fall back on.
    throw new Error(
      'The gmail transport needs a Google OAuth account; this one authenticates with a password. ' +
      'Use --transport imap, or re-add the account with --auth oauth.',
    );
  }
  return GmailMailSource.open(account, account.syncPath);
}
