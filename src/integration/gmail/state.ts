// The Gmail backend's resume state, kept inside the account's sync directory.
//
// It lives there rather than next to config.json so it can never outlive the
// files it describes: delete the sync directory and the state goes with it, and
// the next run rebuilds from scratch. It is a cache, never a source of truth —
// every entry it holds is re-derivable from Gmail, and the markdown files on
// disk still decide what has actually been synced.
//
// Two things are cached:
//
//   * historyId — where the last clean sync finished, so the next one can ask
//     Gmail only for what changed.
//   * a Gmail-id → (Message-ID, mailbox) index, so a full sweep does not have
//     to re-fetch metadata for messages it has already seen. This is what makes
//     the fallback path cheap when a resume point expires.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { dim } from '../../core/ansi.js';
import { errorMessage } from '../../core/errors.js';

const STATE_FILE = '.inbox-to-md-gmail.json';
const STATE_VERSION = 1;

export interface KnownMessage {
  messageId: string; // RFC 5322 Message-ID, '' when the message has none
  mailbox: string;
}

interface StateFile {
  version: number;
  historyId: string | null;
  // Gmail message id → what we already know about it.
  messages: Record<string, KnownMessage>;
}

function emptyState(): StateFile {
  return { version: STATE_VERSION, historyId: null, messages: {} };
}

export class GmailState {
  private constructor(
    private readonly path: string,
    private state: StateFile,
  ) {}

  // A malformed or unreadable state file is discarded rather than repaired:
  // everything in it is a cache, so starting over costs one full sweep and
  // never costs correctness.
  static load(syncPath: string): GmailState {
    const path = join(syncPath, STATE_FILE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return new GmailState(path, emptyState());
    }
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    if (record.version !== STATE_VERSION || typeof record.messages !== 'object' || record.messages === null) {
      return new GmailState(path, emptyState());
    }
    return new GmailState(path, {
      version: STATE_VERSION,
      historyId: typeof record.historyId === 'string' ? record.historyId : null,
      messages: record.messages as Record<string, KnownMessage>,
    });
  }

  get historyId(): string | null {
    return this.state.historyId;
  }

  setHistoryId(historyId: string | null): void {
    this.state.historyId = historyId;
  }

  known(gmailId: string): KnownMessage | undefined {
    const entry = this.state.messages[gmailId];
    // Guard the shape: the file is user-writable and hand-editable.
    if (typeof entry?.messageId !== 'string' || typeof entry?.mailbox !== 'string') return undefined;
    return entry;
  }

  remember(gmailId: string, message: KnownMessage): void {
    this.state.messages[gmailId] = message;
  }

  forget(gmailId: string): void {
    delete this.state.messages[gmailId];
  }

  // Every Message-ID the index has ever recorded, so a caller can map Gmail's
  // deletion notices back to the files they refer to.
  messageIdFor(gmailId: string): string | null {
    return this.known(gmailId)?.messageId ?? null;
  }

  // Best effort: failing to save costs one extra sweep next run, so it must
  // never fail a sync — but it is reported rather than swallowed.
  save(): void {
    const tmp = this.path + '.tmp';
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(this.state) + '\n');
      renameSync(tmp, this.path);
    } catch (err) {
      process.stderr.write(dim(`Warning: could not save Gmail sync state: ${errorMessage(err)}`) + '\n');
    }
  }
}
