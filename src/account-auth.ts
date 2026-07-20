// Shared account parsing and IMAP verification for both authentication
// surfaces. Keep policy here so the interactive TUI and non-interactive CLI
// cannot disagree about what constitutes a valid, working account.

import { mkdirSync } from 'fs';
import { isAbsolute } from 'path';
import { expandTilde, type ImapAccount } from './config.js';
import { closeImapClient, createImapClient, describeImapError } from './imap.js';

export type AccountWithoutId = Omit<ImapAccount, 'id'>;

export interface AccountValues {
  label: string;
  host: string;
  port: string;
  tls: string;
  username: string;
  password: string;
  syncPath: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseAccountValues(values: AccountValues): AccountWithoutId {
  const label = values.label.trim();
  if (label === '') throw new Error('Label is required');

  const host = values.host.trim();
  if (host === '') throw new Error('IMAP host is required');

  if (!/^\d+$/.test(values.port)) throw new Error('Port must be between 1 and 65535');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535');
  }

  if (values.tls !== 'yes' && values.tls !== 'no') {
    throw new Error('TLS must be "yes" or "no"');
  }

  const username = values.username.trim();
  if (username === '') throw new Error('Username is required');
  if (values.password === '') throw new Error('Password is required');

  const syncPath = expandTilde(values.syncPath.trim());
  if (syncPath === '') throw new Error('Sync path is required');
  if (!isAbsolute(syncPath)) throw new Error('Sync path must be absolute (or start with ~)');

  return {
    label,
    host,
    port,
    tls: values.tls === 'yes',
    username,
    password: values.password,
    syncPath,
  };
}

// Verify before saving. Directory creation remains part of verification so a
// bad destination fails immediately rather than during a later sync.
export async function verifyAccount(account: AccountWithoutId): Promise<void> {
  try {
    mkdirSync(account.syncPath, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create ${account.syncPath}: ${errorMessage(err)}`);
  }

  const client = createImapClient(account);
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw new Error(describeImapError(err, account.host, account.port));
  }
  await closeImapClient(client);
}

export async function parseAndVerifyAccount(values: AccountValues): Promise<AccountWithoutId> {
  const account = parseAccountValues(values);
  await verifyAccount(account);
  return account;
}
