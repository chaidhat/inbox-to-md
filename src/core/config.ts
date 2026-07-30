// Config load/save for ~/.config/inbox-to-md/config.json. The file holds IMAP
// passwords and OAuth refresh tokens in plaintext (by explicit choice, over the
// macOS Keychain), so it is written 0600 inside a 0700 directory and never
// overwritten when unparseable — a typo while hand-editing must not destroy
// stored credentials.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { dim } from './ansi.js';
import type { Transport } from './mail-source.js';

export const CONFIG_VERSION = 2;

// How an account proves who it is. Both methods talk plain IMAP afterwards:
// 'password' does a LOGIN, 'oauth' does AUTHENTICATE XOAUTH2 with an access
// token minted from the stored refresh token.
export type AuthMethod = 'password' | 'oauth';

// Everything an account needs regardless of how it authenticates.
interface AccountBase {
  id: string;        // randomUUID(); stable across edits
  label: string;
  host: string;
  port: number;
  tls: boolean;      // imapflow `secure` (implicit TLS)
  username: string;
  syncPath: string;  // absolute; '~' is expanded at save time
  // How the account reaches its mail. Absent means "derive it" (see
  // integration/open.ts), which is why adding this needed no version bump:
  // configs written before it exist load unchanged, and an older build that
  // does not understand the field simply ignores it and uses IMAP.
  transport?: Transport;
}

export interface OAuthCredentials {
  // The OAuth client the grant belongs to. Kept per account so different
  // accounts can use different Google Cloud projects (and so a rotated client
  // does not silently invalidate a working account).
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  // Access tokens live about an hour. Cached here so back-to-back commands
  // (sync, then compact, then archive) don't re-hit Google's token endpoint
  // every time. Absent until the first refresh; always re-derivable from
  // refreshToken, so losing it costs one HTTP request.
  accessToken?: string;
  accessTokenExpiresAt?: number; // epoch ms
}

export interface PasswordAccount extends AccountBase {
  auth: 'password';
  password: string;
}

export interface OAuthAccount extends AccountBase {
  auth: 'oauth';
  oauth: OAuthCredentials;
}

export type Account = PasswordAccount | OAuthAccount;

// A plain `Omit<Account, 'id'>` would collapse the union to its shared fields
// and lose the `auth` discriminator, so the omission has to distribute.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// An account that has been parsed and verified but not yet stored, so it has no
// id: what `auth add` works with before it commits.
export type AccountDraft = DistributiveOmit<Account, 'id'>;

export interface Config {
  version: typeof CONFIG_VERSION;
  accounts: Account[];
}

export const CONFIG_PATH = join(homedir(), '.config', 'inbox-to-md', 'config.json');

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function hasAccountBaseFields(a: Record<string, unknown>): boolean {
  return (
    typeof a.id === 'string' &&
    typeof a.label === 'string' &&
    typeof a.host === 'string' &&
    typeof a.port === 'number' &&
    typeof a.tls === 'boolean' &&
    typeof a.username === 'string' &&
    typeof a.syncPath === 'string' &&
    (a.transport === undefined || a.transport === 'imap' || a.transport === 'gmail')
  );
}

function isOAuthCredentials(v: unknown): v is OAuthCredentials {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.clientId === 'string' &&
    typeof c.clientSecret === 'string' &&
    typeof c.refreshToken === 'string' &&
    (c.accessToken === undefined || typeof c.accessToken === 'string') &&
    (c.accessTokenExpiresAt === undefined || typeof c.accessTokenExpiresAt === 'number')
  );
}

function isAccount(v: unknown): v is Account {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (!hasAccountBaseFields(a)) return false;
  if (a.auth === 'password') return typeof a.password === 'string';
  if (a.auth === 'oauth') return isOAuthCredentials(a.oauth);
  return false;
}

// Version 1 had no `auth` discriminator: every account was a password account.
function isV1Account(v: unknown): v is Omit<PasswordAccount, 'auth'> {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return hasAccountBaseFields(a) && typeof a.password === 'string';
}

function invalidConfigError(reason: string): Error {
  return new Error(
    `Invalid config at ${CONFIG_PATH}: ${reason}\n` +
    `Fix the file by hand, or delete it and re-run \`inbox-to-md auth add\` (stored accounts will be lost).`,
  );
}

// Reads v1 or v2 and always returns v2 in memory. Nothing is written back
// here: a migration is only persisted the next time something legitimately
// saves, so a read-only command never rewrites the file that holds the user's
// only copy of their credentials.
export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: CONFIG_VERSION, accounts: [] }; // valid first-run state
    }
    throw err;
  }

  const mode = statSync(CONFIG_PATH).mode;
  if ((mode & 0o077) !== 0) {
    process.stderr.write(
      dim(`Warning: ${CONFIG_PATH} is readable by other users — run: chmod 600 ${CONFIG_PATH}`) + '\n',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw invalidConfigError(`not valid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidConfigError('not a JSON object');
  const cfg = parsed as Record<string, unknown>;

  if (cfg.version === 1) {
    if (!Array.isArray(cfg.accounts) || !cfg.accounts.every(isV1Account)) {
      throw invalidConfigError('malformed "accounts" entry');
    }
    const accounts: Account[] = cfg.accounts.map((a) => ({ ...a, auth: 'password' as const }));
    return { version: CONFIG_VERSION, accounts };
  }
  if (cfg.version !== CONFIG_VERSION) {
    throw invalidConfigError(`unsupported version ${JSON.stringify(cfg.version)} (expected ${CONFIG_VERSION})`);
  }
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.every(isAccount)) {
    throw invalidConfigError('malformed "accounts" entry');
  }
  return { version: CONFIG_VERSION, accounts: cfg.accounts };
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tmp = CONFIG_PATH + '.tmp';
  // Remove any stale tmp first: writeFileSync only applies `mode` when it
  // creates the file, so writing over a leftover tmp could keep loose perms.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // Atomic swap — a crash mid-write must never corrupt the only copy of the
  // stored credentials.
  renameSync(tmp, CONFIG_PATH);
}
