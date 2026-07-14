// Config load/save for ~/.config/inbox-to-md/config.json. The file holds IMAP
// passwords in plaintext (by explicit choice, over the macOS Keychain), so it
// is written 0600 inside a 0700 directory and never overwritten when
// unparseable — a typo while hand-editing must not destroy stored credentials.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { dim } from './ansi.js';

export const CONFIG_VERSION = 1;

export interface ImapAccount {
  id: string;        // randomUUID(); stable across edits
  label: string;
  host: string;
  port: number;
  tls: boolean;      // imapflow `secure` (implicit TLS)
  username: string;
  password: string;
  syncPath: string;  // absolute; '~' is expanded at save time
}

export interface Config {
  version: typeof CONFIG_VERSION;
  accounts: ImapAccount[];
}

export const CONFIG_PATH = join(homedir(), '.config', 'inbox-to-md', 'config.json');

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isImapAccount(v: unknown): v is ImapAccount {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.label === 'string' &&
    typeof a.host === 'string' &&
    typeof a.port === 'number' &&
    typeof a.tls === 'boolean' &&
    typeof a.username === 'string' &&
    typeof a.password === 'string' &&
    typeof a.syncPath === 'string'
  );
}

function invalidConfigError(reason: string): Error {
  return new Error(
    `Invalid config at ${CONFIG_PATH}: ${reason}\n` +
    `Fix the file by hand, or delete it and re-run \`npm run auth\` (stored accounts will be lost).`,
  );
}

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
  if (cfg.version !== CONFIG_VERSION) {
    throw invalidConfigError(`unsupported version ${JSON.stringify(cfg.version)} (expected ${CONFIG_VERSION})`);
  }
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.every(isImapAccount)) {
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
  // stored passwords.
  renameSync(tmp, CONFIG_PATH);
}
