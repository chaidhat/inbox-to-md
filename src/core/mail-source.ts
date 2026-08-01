// The seam between the sync/archive engines and whatever actually talks to a
// mail provider. Everything above this interface — dedupe, filenames,
// frontmatter, pruning, progress reporting — is protocol-agnostic; everything
// below it (integration/imap, integration/gmail) knows exactly one protocol
// and nothing about markdown files.
//
// The engines never construct a backend themselves: integration/open.ts is the
// single place that decides which one an account gets.

import type { EmailContent } from './markdown.js';

// A message as seen during the cheap listing pass — enough to tell whether we
// already have it, and to fetch it if we don't.
export interface MessageRef {
  // Backend handle for fetching this message's content. Opaque above this
  // interface: an IMAP mailbox+uid, a Gmail message id, whatever the backend
  // needs. Never written to disk.
  handle: string;
  // RFC 5322 Message-ID, '' when the message has none. This is the identity
  // the engines dedupe on, because it is the one the markdown files record.
  messageId: string;
  // Recorded in the file's frontmatter, and what `archive` keys on. Backends
  // agree to report 'INBOX' for messages in the inbox so files stay portable
  // between them.
  mailbox: string;
}

export type ListProgress = (mailbox: string, checked: number, total: number) => void;

export interface ListResult {
  refs: MessageRef[];
  // False when any part of the listing failed. The engine must then treat its
  // view of the server as partial and skip pruning — deleting a file because
  // a mailbox happened to be unreachable would lose mail.
  complete: boolean;
  // Human-readable descriptions of whatever went wrong, for the engine to
  // print. Backends report; only the engine writes to the terminal.
  problems: string[];
}

// An incremental listing: what changed since the backend's saved resume
// point, rather than everything in the window.
export interface ChangeResult {
  added: MessageRef[];
  // Message-IDs the provider says are gone. Subject to the same date-window
  // guard as a full prune before anything is deleted. Unlike a full listing,
  // this is the *only* licence to delete: an incremental view cannot tell the
  // engine that some unmentioned message is missing.
  removedMessageIds: string[];
}

export interface ArchiveRequest {
  messageId: string;
  mailbox: string;
}

export type ArchiveOutcome =
  | { status: 'archived'; destination: string }
  | { status: 'not-found' }
  | { status: 'error'; detail: string };

export interface MailSource {
  // Human-readable name of the transport, for logs and `auth list`.
  readonly transport: Transport;

  // Every message the account can see within the window. Backends that span
  // multiple mailboxes report each message once, preferring INBOX.
  listWindow(since: Date, onProgress: ListProgress): Promise<ListResult>;

  fetchContent(ref: MessageRef): Promise<EmailContent>;

  // How many fetchContent calls this backend can have in flight at once.
  // Absent means one, which is the safe default: a backend built on a single
  // connection with a selected mailbox cannot serve two fetches concurrently,
  // because each would re-select underneath the other. A backend whose fetches
  // are independent (one HTTP request per message) raises it, and the engine
  // downloads that many at a time.
  readonly maxConcurrentFetches?: number;

  // Archives a batch, so a backend can group the work (one mailbox open per
  // mailbox for IMAP, one batch modify for Gmail). Outcomes are positional.
  archive(requests: ArchiveRequest[]): Promise<ArchiveOutcome[]>;

  close(): Promise<void>;

  // Incremental listing, when the backend supports one. Returns null when it
  // cannot be used — no saved resume point, or one the provider considers too
  // old — and the caller must fall back to listWindow. Where the resume point
  // is kept is the backend's business; only it knows what needs persisting.
  listChanges?(since: Date, onProgress: ListProgress): Promise<ChangeResult | null>;

  // Persist a resume point for the next run. The engine calls this only after
  // a clean sync: committing after a failed one would skip past the messages
  // that failed, permanently.
  commit?(): Promise<void>;
}

// How an account reaches its mail. Independent of how it authenticates: a
// Google account can use either, and a password account can only use imap.
export type Transport = 'imap' | 'gmail';
