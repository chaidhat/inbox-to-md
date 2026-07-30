// Shared IMAP client construction and error phrasing, used by both the auth
// verify step and the sync engine so a given failure reads the same in both.
// This is the only place that knows an account's auth method turns into either
// an IMAP LOGIN or an AUTHENTICATE XOAUTH2 — everything downstream just gets a
// connected client.

import { ImapFlow } from 'imapflow';
import type { Account, AccountDraft, AuthMethod } from './config.js';
import { getAccessToken } from './oauth.js';

// Stored accounts and not-yet-stored drafts both connect the same way.
export type ImapTarget = Account | AccountDraft;

async function imapAuth(account: ImapTarget): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (account.auth === 'password') {
    return { user: account.username, pass: account.password };
  }
  // Minted (or read from cache) before the socket opens, so an expired token
  // never turns into a mid-handshake failure.
  return { user: account.username, accessToken: await getAccessToken(account) };
}

// Builds and connects in one step: imapflow authenticates during connect(), so
// a returned client is always an authenticated one. On failure the socket is
// closed before the error propagates, leaving no dangling connection.
export async function connectImap(account: ImapTarget): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: await imapAuth(account),
    // imapflow's default pino logger spews JSON to stdout; silence it so it
    // can't wreck the sync summary or the auth CLI's JSON output.
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
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

export function describeImapError(
  err: unknown,
  account: { host: string; port: number; auth: AuthMethod },
): string {
  const e = err as { authenticationFailed?: boolean; code?: string; message?: string } | null;
  if (e?.authenticationFailed) {
    return account.auth === 'oauth'
      ? `OAuth login rejected by ${account.host} — the grant may be revoked, or the OAuth client may be ` +
        'missing the https://mail.google.com/ scope. Re-authorize with `inbox-to-md auth reauth`.'
      : 'Login failed — check username/password';
  }
  const message = e?.message ?? String(err);
  const code = e?.code ?? '';
  // imapflow's phrasing for "the server advertises no mechanism I can use with
  // these credentials" — which for OAuth means the server is not Google.
  if (/unsupported authentication mechanism/i.test(message)) {
    return account.auth === 'oauth'
      ? `${account.host} does not advertise XOAUTH2/OAUTHBEARER, so it cannot accept a Google OAuth token — ` +
        'this provider needs --auth password.'
      : `${account.host} advertises no usable password authentication mechanism`;
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code) || /timed?\s?out/i.test(message)) {
    return `Cannot reach ${account.host}:${account.port}: ${message}`;
  }
  return message;
}
