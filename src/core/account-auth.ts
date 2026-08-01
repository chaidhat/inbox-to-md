// Shared account parsing and IMAP verification for the auth CLI. Keeping the
// policy here — what a valid account looks like, and what "working" means —
// means adding an auth method does not scatter validation across commands.
//
// Parsing is split from credential handling on purpose: the OAuth flow sends
// the user to a browser, and it would be rude to do that only to reject a
// malformed sync path afterwards.

import { mkdirSync } from 'fs';
import { isAbsolute } from 'path';
import { openMailSource } from '../integration/open.js';
import { expandTilde, type AccountDraft, type OAuthCredentials } from './config.js';
import { errorMessage } from './errors.js';
import type { Transport } from './mail-source.js';

// The connection fields, as strings, exactly as they arrive from CLI flags.
export interface AccountFieldValues {
  label: string;
  host: string;
  port: string;
  tls: string;
  username: string;
  syncPath: string;
  transport?: string; // absent means "derive it" — see integration/open.ts
}

export interface ParsedFields {
  label: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  syncPath: string;
  transport?: Transport;
}

// How the account will authenticate, already resolved: a password from the
// user, or credentials returned by a completed OAuth consent flow.
export type CredentialInput =
  | { auth: 'password'; password: string }
  | { auth: 'oauth'; oauth: OAuthCredentials };

export function parseFields(fields: AccountFieldValues): ParsedFields {
  const label = fields.label.trim();
  if (label === '') throw new Error('Label is required');

  const host = fields.host.trim();
  if (host === '') throw new Error('IMAP host is required');

  if (!/^\d+$/.test(fields.port)) throw new Error('Port must be between 1 and 65535');
  const port = Number(fields.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535');
  }

  if (fields.tls !== 'yes' && fields.tls !== 'no') {
    throw new Error('TLS must be "yes" or "no"');
  }

  const username = fields.username.trim();
  if (username === '') throw new Error('Username is required');

  const syncPath = expandTilde(fields.syncPath.trim());
  if (syncPath === '') throw new Error('Sync path is required');
  if (!isAbsolute(syncPath)) throw new Error('Sync path must be absolute (or start with ~)');

  const transport = fields.transport;
  if (transport !== undefined && transport !== 'imap' && transport !== 'gmail') {
    throw new Error('Transport must be "imap" or "gmail"');
  }

  return { label, host, port, tls: fields.tls === 'yes', username, syncPath, transport };
}

export function buildAccount(fields: ParsedFields, credential: CredentialInput): AccountDraft {
  if (credential.auth === 'password') {
    if (credential.password === '') throw new Error('Password is required');
    return { ...fields, auth: 'password', password: credential.password };
  }
  if (credential.oauth.refreshToken === '') throw new Error('OAuth authorization returned no refresh token');
  return { ...fields, auth: 'oauth', oauth: credential.oauth };
}

// Creating the destination is part of setup, not of sync: a path that cannot be
// created must fail while the user is still looking at the auth command.
export function ensureSyncDir(syncPath: string): void {
  try {
    mkdirSync(syncPath, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create ${syncPath}: ${errorMessage(err)}`);
  }
}

// Verify before saving: a real connection over the transport the account will
// actually use proves the host, the credential, and — for OAuth — that the
// grant carries the scope the transport needs.
export async function verifyAccount(account: AccountDraft): Promise<void> {
  ensureSyncDir(account.syncPath);
  const source = await openMailSource(account);
  await source.close();
}
