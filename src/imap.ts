// Shared IMAP client construction and error phrasing, used by both the auth
// verify step and the sync engine so a given failure reads the same in both.

import { ImapFlow } from 'imapflow';
import type { ImapAccount } from './config.js';

type ImapConnection = Pick<ImapAccount, 'host' | 'port' | 'tls' | 'username' | 'password'>;

export function createImapClient(account: ImapConnection): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: { user: account.username, pass: account.password },
    // imapflow's default pino logger spews JSON to stdout; silence it so it
    // can't wreck the TUI or the sync summary.
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
}

// Closes a connected client, preferring a clean LOGOUT but never letting a
// failure during teardown mask the real result.
export async function closeImapClient(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

export function describeImapError(err: unknown, host: string, port: number): string {
  const e = err as { authenticationFailed?: boolean; code?: string; message?: string } | null;
  if (e?.authenticationFailed) return 'Login failed — check username/password';
  const message = e?.message ?? String(err);
  const code = e?.code ?? '';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code) || /timed?\s?out/i.test(message)) {
    return `Cannot reach ${host}:${port}: ${message}`;
  }
  return message;
}
